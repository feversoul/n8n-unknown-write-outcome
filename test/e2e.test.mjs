// End-to-end tests: the real workflows on a real n8n (npm run test:e2e), with
// the lost-ack fixture as the API. Each test submits a write over the
// webhook, lets the Check workflow run on its schedule, and then reads two
// things: the job row in n8n, and the fixture's own report of how many write
// attempts and effects it saw. The fixture's count is the one that matters.
//
// Test timing (test/test.env): the write gives up after 400 ms, rechecks come
// 1 s apart, the cutoff is 3 rechecks, jobs in review are rechecked every 1 s.
// /lag2 hides a record for 2 lookups (inside the cutoff), /lag5 for 5 (past it).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { after, before, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = process.env.N8N_URL ?? 'http://localhost:55686';
const FIXTURE = process.env.FIXTURE_URL ?? 'http://localhost:58088';
const KEY = process.env.WORKFLOW_KEY ?? 'test-workflow-key';
const BACKEND = process.env.BACKEND ?? 'SQLite';
const RUN = Date.now().toString(36);
const CUTOFF = 3;

const headers = { 'x-workflow-key': KEY, 'content-type': 'application/json' };
const table = [];
const note = (name, job, counts) => table.push({ name, job: `${job.status}${job.resolution ? ` (${job.resolution})` : ''}`, counts: `${counts.writes} / ${counts.effects} / ${counts.lookups}` });

async function until(check, timeoutMs = 30_000, every = 250) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check().catch(() => null);
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await sleep(every);
  }
}

let counter = 0;
const ref = (name) => `demo-${RUN}-${name}-${++counter}`;

// n8n
async function submit(reference, target, payload = { amount: 5 }) {
  const response = await fetch(`${BASE}/webhook/unknown-write/submit`, { method: 'POST', headers, body: JSON.stringify({ reference, target, payload }) });
  assert.equal(response.status, 200, 'submit answers 200');
  return response.json();
}
async function rows(query) {
  const response = await fetch(`${BASE}/webhook/unknown-write/jobs?${query}`, { headers });
  assert.equal(response.status, 200);
  return (await response.json()).jobs;
}
const job = async (reference) => (await rows(`reference=${encodeURIComponent(reference)}`))[0];
const settled = (reference, status, timeoutMs) => until(async () => {
  const row = await job(reference);
  return row && row.status === status ? row : null;
}, timeoutMs);
const sweep = () => fetch(`${BASE}/webhook/unknown-write/sweep`, { method: 'POST', headers, body: '{}' }).then((response) => response.text());

// the fixture: what really happened on the far side
const counts = async (target, reference) => (await fetch(`${FIXTURE}/${target}/report?ref=${reference}`)).json();
const alertsFor = async (reference) => (await (await fetch(`${FIXTURE}/alerts`)).json()).alerts.filter((alert) => alert.reference === reference);
const steps = (row, step) => row.history.filter((entry) => entry.step === step);

before(async () => {
  // bootstrap.sh has finished when the setup webhook answers.
  await until(async () => (await fetch(`${BASE}/webhook/unknown-write/setup`, { method: 'POST', headers, body: '{}' })).status === 200, 240_000, 1000);
});

after(() => {
  const width = Math.max(...table.map((line) => line.name.length));
  const jobWidth = Math.max(...table.map((line) => line.job.length));
  console.log(`\nn8n 2.47.7, Data Tables on ${BACKEND}. Counts are the fixture's report: write attempts / effects / lookups.\n`);
  for (const line of table) console.log(`  ${line.name.padEnd(width)}  ${line.job.padEnd(jobWidth)}  ${line.counts}`);
  console.log('');
});

// --- the fixture itself ---------------------------------------------------------

test('control, no workflow: a second write after the first 404 leaves two records', async () => {
  const reference = ref('blind');
  await assert.rejects(fetch(`${FIXTURE}/lag2/committed/write?ref=${reference}`, { method: 'POST', signal: AbortSignal.timeout(400) }));
  assert.equal((await fetch(`${FIXTURE}/lag2/committed/lookup?ref=${reference}`)).status, 404);
  assert.equal((await fetch(`${FIXTURE}/lag2/committed/write?ref=${reference}`, { method: 'POST' })).status, 201);
  const report = await counts('lag2/committed', reference);
  assert.deepEqual(report, { writes: 2, lookups: 1, effects: 2 });
  note('control: resend after the first 404 (no workflow)', { status: 'duplicate' }, report);
});

// --- the five scenarios, record visible inside the cutoff -------------------------

test('committed: the write timed out but landed. Two 404s, then found. One write, one effect', async () => {
  const reference = ref('committed');
  const first = await submit(reference, 'lag2/committed');
  assert.equal(first.status, 'unknown', 'a timeout is unknown, not failed');
  const row = await settled(reference, 'done');
  assert.equal(row.resolution, 'confirmed_by_lookup');
  assert.equal(row.remote_id, 'fixture-1');
  assert.equal(row.attempt, 1);
  assert.match(steps(row, 'write')[0].saw, /no answer/);
  assert.ok(row.first_seen_at > row.sent_at, 'sent_at and first_seen_at give the settle time');
  const report = await counts('lag2/committed', reference);
  assert.equal(report.writes, 1);
  assert.equal(report.effects, 1);
  assert.ok(report.lookups >= 3);
  assert.equal((await alertsFor(reference)).length, 0, 'nobody is alerted');
  note('committed', row, report);
});

test('uncommitted: the write never landed. Three 404s, then review. One write, no effect, and it stays that way', async () => {
  const reference = ref('uncommitted');
  const payload = { amount: 12, customer: 'c-77' };
  assert.equal((await submit(reference, 'lag2/uncommitted', payload)).status, 'unknown');
  const row = await settled(reference, 'review');
  assert.equal(row.attempt, 1);
  assert.ok(row.review_at);
  assert.ok(steps(row, 'lookup').length >= CUTOFF);
  assert.ok(steps(row, 'lookup').every((entry) => entry.verdict === 'no_evidence'));
  // The job is still looked up while it waits for a person, and still not written again.
  await until(async () => (await counts('lag2/uncommitted', reference)).lookups >= CUTOFF + 3);
  const report = await counts('lag2/uncommitted', reference);
  assert.equal(report.writes, 1, 'absence and an elapsed cutoff never cause a second write');
  assert.equal(report.effects, 0);
  assert.equal((await job(reference)).status, 'review');
  // The alert carries what the reviewer needs.
  const alerts = await alertsFor(reference);
  assert.deepEqual(alerts.map((alert) => alert.event), ['needs_review']);
  assert.deepEqual(alerts[0].payload, payload);
  assert.equal(alerts[0].sent_at, row.sent_at);
  assert.ok(alerts[0].history.filter((entry) => entry.step === 'lookup').length >= CUTOFF);
  assert.deepEqual((await rows('status=review')).filter((entry) => entry.reference === reference).length, 1, 'and it is in the review list');
  note('uncommitted', row, report);
});

test('stale-json: 200 {"exists":false} twice, then the record. Not taken as absent, one write, one effect', async () => {
  const reference = ref('stale');
  assert.equal((await submit(reference, 'lag2/stale-json')).status, 'unknown');
  const row = await settled(reference, 'done');
  assert.equal(row.remote_id, 'fixture-1');
  const lookups = steps(row, 'lookup');
  assert.ok(lookups.some((entry) => entry.saw.includes('"exists":false') && entry.verdict === 'no_evidence'));
  const report = await counts('lag2/stale-json', reference);
  assert.equal(report.writes, 1);
  assert.equal(report.effects, 1);
  note('stale-json', row, report);
});

test('malformed-json: 200 {} and 200 {"exists":"false"}, then the record. Both read as unknown, one write, one effect', async () => {
  const reference = ref('malformed');
  assert.equal((await submit(reference, 'lag2/malformed-json')).status, 'unknown');
  const row = await settled(reference, 'done');
  assert.equal(row.remote_id, 'fixture-1');
  const seen = steps(row, 'lookup').filter((entry) => entry.verdict === 'no_evidence').map((entry) => entry.saw);
  assert.ok(seen.some((saw) => saw === '200 {}') || seen.some((saw) => saw.includes('"exists":"false"')), `the odd bodies were seen: ${seen}`);
  const report = await counts('lag2/malformed-json', reference);
  assert.equal(report.writes, 1);
  assert.equal(report.effects, 1);
  note('malformed-json', row, report);
});

test('confirmed-no-write: a terminal not_applied receipt for this reference and attempt allows one resend. Two writes, one effect', async () => {
  const reference = ref('receipt');
  assert.equal((await submit(reference, 'lag2/confirmed-no-write')).status, 'unknown');
  const row = await settled(reference, 'done');
  assert.equal(row.resolution, 'resent_after_receipt');
  assert.equal(row.attempt, 2);
  assert.equal(row.remote_id, 'fixture-1');
  assert.equal(steps(row, 'receipt').at(-1).verdict, 'not_applied');
  assert.deepEqual(steps(row, 'write').map((entry) => [entry.attempt, entry.saw]), [[1, steps(row, 'write')[0].saw], [2, '201']]);
  // Nothing more happens to it.
  await sleep(3000);
  const report = await counts('lag2/confirmed-no-write', reference);
  assert.equal(report.writes, 2);
  assert.equal(report.effects, 1);
  assert.equal((await alertsFor(reference)).length, 0);
  note('confirmed-no-write', row, report);
});

// --- the record shows up after the cutoff -------------------------------------------

for (const scenario of ['committed', 'stale-json', 'malformed-json']) {
  test(`${scenario}, record hidden for 5 lookups: review at the cutoff, found later, review closed. One write, one effect`, async () => {
    const reference = ref(`late-${scenario.split('-')[0]}`);
    assert.equal((await submit(reference, `lag5/${scenario}`)).status, 'unknown');
    const inReview = await settled(reference, 'review');
    assert.equal((await counts(`lag5/${scenario}`, reference)).writes, 1);
    assert.ok(steps(inReview, 'lookup').length >= CUTOFF);
    const row = await settled(reference, 'done');
    assert.equal(row.resolution, 'arrived_after_cutoff');
    assert.equal(row.remote_id, 'fixture-1');
    assert.equal(row.attempt, 1);
    assert.ok(row.first_seen_at > row.review_at, 'it was seen after the hand-over');
    const report = await counts(`lag5/${scenario}`, reference);
    assert.equal(report.writes, 1, 'the cutoff did not cause a second write');
    assert.equal(report.effects, 1);
    assert.ok(report.lookups >= 6);
    // The reviewer got two messages: look at it, then: it resolved itself.
    const alerts = await until(async () => {
      const list = await alertsFor(reference);
      return list.length >= 2 ? list : null;
    });
    assert.deepEqual(alerts.map((alert) => alert.event), ['needs_review', 'resolved_itself']);
    assert.equal(alerts[1].remote_id, 'fixture-1');
    assert.equal((await rows('status=review')).filter((entry) => entry.reference === reference).length, 0, 'it left the review list');
    note(`${scenario}, visible only after the cutoff`, row, report);
  });
}

// --- things that happen twice ---------------------------------------------------------

test('the same reference submitted 4 times at the same instant, 8 rounds: one write each', async () => {
  const rounds = 8;
  const total = { writes: 0, effects: 0, lookups: 0 };
  for (let round = 0; round < rounds; round++) {
    const reference = ref('twins');
    const answers = await Promise.all([1, 2, 3, 4].map(() => submit(reference, 'lag2/committed')));
    assert.equal(answers.filter((answer) => answer.duplicate_submit === false).length, 1, `round ${round + 1}: one run sent the write`);
    const row = await settled(reference, 'done');
    assert.equal((await rows(`reference=${reference}`)).length, 1, 'one row is left');
    // Submitting it again later sends nothing.
    assert.deepEqual(await submit(reference, 'lag2/committed'), { reference, status: 'done', attempt: 1, remote_id: 'fixture-1', resolution: row.resolution, duplicate_submit: true });
    const report = await counts('lag2/committed', reference);
    assert.equal(report.writes, 1, `round ${round + 1}`);
    assert.equal(report.effects, 1, `round ${round + 1}`);
    for (const key of Object.keys(total)) total[key] += report[key];
  }
  note(`4 submits of one reference at once, ${rounds} rounds (totals)`, { status: 'done' }, total);
});

test('Check runs piling up (6 at once, again and again) while a receipt allows a resend, 8 rounds: two writes, one effect each', async () => {
  const rounds = 8;
  const total = { writes: 0, effects: 0, lookups: 0 };
  for (let round = 0; round < rounds; round++) {
    const reference = ref('pile');
    await submit(reference, 'lag2/confirmed-no-write');
    let done = false;
    const hammer = (async () => {
      while (!done) {
        await Promise.all(Array.from({ length: 6 }, sweep));
        await sleep(50);
      }
    })();
    const row = await settled(reference, 'done').finally(() => (done = true));
    await hammer;
    await sleep(500);
    assert.equal(row.attempt, 2);
    const report = await counts('lag2/confirmed-no-write', reference);
    assert.equal(report.writes, 2, `round ${round + 1}: the resend went out once`);
    assert.equal(report.effects, 1, `round ${round + 1}`);
    for (const key of Object.keys(total)) total[key] += report[key];
  }
  note(`6 Check runs at once during the resend, ${rounds} rounds (totals)`, { status: 'done', resolution: 'resent_after_receipt' }, total);
});

test('a write the API refuses with a 4xx is rejected, not rechecked', async () => {
  // The fixture answers 400 to a reference it does not accept and records nothing.
  const reference = `not-a-fixture-reference-${RUN}`;
  assert.equal((await submit(reference, 'lag2/committed')).status, 'rejected');
  await sleep(2500);
  const row = await job(reference);
  assert.equal(row.status, 'rejected');
  assert.equal(row.resolution, 'refused_400');
  assert.equal(steps(row, 'lookup').length, 0);
});

// --- n8n restarts in the middle -------------------------------------------------------

test('n8n restarted while four jobs are open: all four end as in the tests above', async (t) => {
  if (!process.env.RESTART_N8N) return t.skip('RESTART_N8N not set (npm run test:e2e sets it)');
  const [command, ...args] = JSON.parse(process.env.RESTART_N8N);
  const jobs = [
    ['lag2/committed', ref('restart-committed'), 'done', { writes: 1, effects: 1 }],
    ['lag2/uncommitted', ref('restart-uncommitted'), 'review', { writes: 1, effects: 0 }],
    ['lag2/confirmed-no-write', ref('restart-receipt'), 'done', { writes: 2, effects: 1 }],
    ['lag5/committed', ref('restart-late'), 'done', { writes: 1, effects: 1 }],
  ];
  for (const [target, reference] of jobs) assert.equal((await submit(reference, target)).status, 'unknown');
  const open = (await Promise.all(jobs.map(([, reference]) => job(reference)))).filter((row) => row.status === 'unknown').length;
  assert.equal(spawnSync(command, args, { stdio: 'ignore' }).status, 0, 'restart n8n');
  await until(async () => (await fetch(`${BASE}/webhook/unknown-write/jobs?status=review`, { headers })).status === 200, 180_000, 1000);
  for (const [target, reference, status, expected] of jobs) {
    const row = await settled(reference, status, 60_000);
    const report = await counts(target, reference);
    assert.equal(report.writes, expected.writes, `${target} writes`);
    assert.equal(report.effects, expected.effects, `${target} effects`);
    note(`restart: ${target}`, row, report);
  }
  t.diagnostic(`${open} of 4 jobs were still unknown when the restart began`);
  // After a restart n8n starts several Check runs at the same moment (seen
  // here with the 1 s test schedule), so the lookups come in a burst and the
  // hidden record can show up before three checks were counted. Either way it
  // must be found, not written again.
  const late = await job(jobs[3][1]);
  assert.ok(['arrived_after_cutoff', 'confirmed_by_lookup'].includes(late.resolution), late.resolution);
});
