// Builds workflows/*.json.
//
// The workflows are plain n8n exports: import them and they run, no build
// needed. This script exists so the repeated parts (data table columns, the
// HTTP options, the IF nodes) are written once. After changing it, run:
//   node scripts/build.mjs

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// The API being written to. In the local stack this is the test fixture;
// docker/prepare.mjs replaces it when API_BASE is set.
const API = 'http://fixture:8080';

const TABLE = 'write_jobs';
const COLUMNS = [
  ['reference', 'string'], // your own id for this write; the API stores it and the lookup searches by it
  ['target', 'string'], // which part of the API the write goes to
  ['payload', 'string'], // JSON text of what was sent, for the reviewer
  ['status', 'string'], // sending | unknown | review | done | rejected
  ['attempt', 'number'], // how many times the write was sent
  ['checks', 'number'], // lookups made for the current attempt
  ['last_check_at', 'number'], // epoch ms of the last lookup (or of the write, before the first lookup)
  ['sent_at', 'string'], // when the first write went out
  ['first_seen_at', 'string'], // when a lookup first showed the record; with sent_at this is your settle time
  ['review_at', 'string'], // when the job was handed to a person
  ['remote_id', 'string'], // the id the API gave the record
  ['resolution', 'string'], // how the job ended, see README
  ['history', 'string'], // JSON list: every write, lookup and receipt with its time and what came back
  ['claimed_by', 'string'], // the run that owns the row while it is "sending"
];

const IDS = { setup: 'unknownWriteSetup1', write: 'unknownWriteSubmit', check: 'unknownWriteCheck1' };
const KEY = { httpHeaderAuth: { id: 'unknownWriteKey', name: 'Unknown Write Key' } };

const uuid = (seed) => {
  const hex = createHash('sha1').update(seed).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

const tableRef = { __rl: true, mode: 'name', value: TABLE };
const where = (...conditions) => ({
  matchType: 'allConditions',
  filters: { conditions: conditions.map(([keyName, keyValue]) => ({ keyName, condition: 'eq', keyValue })) },
});
const mapped = (values) => ({
  mappingMode: 'defineBelow',
  value: values,
  matchingColumns: [],
  schema: COLUMNS.filter(([column]) => column in values).map(([column, type]) => ({
    id: column,
    displayName: column,
    required: false,
    defaultMatch: false,
    display: true,
    type,
    canBeUsedToMatch: true,
  })),
  attemptToConvertTypes: false,
  convertFieldsToString: false,
});
// Column values taken from fields of the same name on the incoming item.
const fromItem = (...columns) => mapped(Object.fromEntries(columns.map((column) => [column, `={{ $json.${column} }}`])));

function workflow(id, name, build) {
  const nodes = [];
  const connections = {};
  const api = {
    node(nodeName, type, typeVersion, position, parameters, extra = {}) {
      nodes.push({ parameters, id: uuid(`${id}/${nodeName}`), name: nodeName, type: `n8n-nodes-base.${type}`, typeVersion, position, ...extra });
      return nodeName;
    },
    note(nodeName, lines, position, width, height, color = 4) {
      return api.node(nodeName, 'stickyNote', 1, position, { content: lines.join('\n'), width, height, color });
    },
    link(from, to, output = 0) {
      connections[from] ??= { main: [] };
      while (connections[from].main.length <= output) connections[from].main.push([]);
      connections[from].main[output].push({ node: to, type: 'main', index: 0 });
    },
    chain(...names) {
      for (let i = 1; i < names.length; i++) api.link(names[i - 1], names[i]);
    },
    hook(nodeName, method, path, position, parameters = {}) {
      return api.node(
        nodeName,
        'webhook',
        2,
        position,
        { httpMethod: method, path: `unknown-write/${path}`, authentication: 'headerAuth', responseMode: 'lastNode', options: {}, ...parameters },
        { webhookId: uuid(`${id}/webhook/${path}`), credentials: KEY },
      );
    },
    code(nodeName, position, lines) {
      return api.node(nodeName, 'code', 2, position, { jsCode: lines.join('\n') });
    },
    // An IF node on one JavaScript condition. Output 0 is true, 1 is false.
    when(nodeName, position, expression) {
      return api.node(nodeName, 'if', 2.2, position, {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
          conditions: [
            {
              id: uuid(`${id}/${nodeName}/condition`),
              leftValue: `={{ ${expression} }}`,
              rightValue: '',
              operator: { type: 'boolean', operation: 'true', singleValue: true },
            },
          ],
          combinator: 'and',
        },
        options: { looseTypeValidation: true },
      });
    },
    rows(nodeName, position, operation, parameters, extra = {}) {
      return api.node(nodeName, 'dataTable', 1.1, position, { resource: 'row', operation, dataTableId: tableRef, ...parameters }, extra);
    },
    // A request to the API. Any answer, 404 and 500 included, comes back as
    // { statusCode, body }; no answer at all comes back as { error }. Nothing
    // here retries by itself: Retry On Fail stays off.
    request(nodeName, position, method, url, timeout) {
      return api.node(
        nodeName,
        'httpRequest',
        4.2,
        position,
        { method, url, options: { response: { response: { fullResponse: true, neverError: true } }, timeout } },
        { onError: 'continueRegularOutput', retryOnFail: false },
      );
    },
  };
  build(api);
  return { name, nodes, pinData: {}, connections, active: false, settings: { executionOrder: 'v1' }, id };
}

// Shared by the Code nodes that read an answer to a write.
const READ_WRITE_ANSWER = [
  '// What the answer to a write means. Adapt it to your API.',
  'function readWrite(answer) {',
  '  const code = answer.statusCode;',
  "  if (code === undefined) return { status: 'unknown', saw: 'no answer: ' + String(answer.error?.message ?? answer.error ?? 'connection lost').slice(0, 160) };",
  "  if (code >= 200 && code < 300) return { status: 'done', saw: String(code), remote_id: String(answer.body?.id ?? '') };",
  '  // The API answered and refused. 408 is a timeout said out loud, so it stays unknown.',
  "  if (code >= 400 && code < 500 && code !== 408) return { status: 'rejected', saw: String(code) };",
  "  return { status: 'unknown', saw: String(code) };",
  '}',
];

// --- 0. Setup ----------------------------------------------------------------

const setup = workflow(IDS.setup, 'Unknown Write · 0 Setup', (w) => {
  w.note(
    'About',
    [
      '## Unknown Write · Setup',
      `Run this once: open it and press **Execute workflow**. It creates the data table \`${TABLE}\`, one row per write. Running it again changes nothing.`,
      '',
      'The webhook does the same for scripted installs (`POST unknown-write/setup`). You can delete it.',
    ],
    [-40, -240],
    560,
    180,
  );
  w.node('Run once', 'manualTrigger', 1, [0, 0], {});
  w.hook('Or call', 'POST', 'setup', [0, 180]);
  w.node('Create the table', 'dataTable', 1.1, [240, 0], {
    resource: 'table',
    operation: 'create',
    tableName: TABLE,
    columns: { column: COLUMNS.map(([name, type]) => ({ name, type })) },
    options: { createIfNotExists: true },
  });
  w.link('Run once', 'Create the table');
  w.link('Or call', 'Create the table');
});

// --- 1. Write ------------------------------------------------------------------

const write = workflow(IDS.write, 'Unknown Write · 1 Write', (w) => {
  w.note(
    'About',
    [
      '## Unknown Write · Write',
      'Sends one write to an API that has no idempotency key, **once**, and writes down what is known about it.',
      '',
      'Call it with `{ reference, target, payload }` from an **Execute Sub-workflow** node or over the webhook (`POST unknown-write/submit`). `reference` is your own id for this write. It must reach the API in a field the lookup can search by.',
      '',
      '- The row is written **before** the write goes out. A reference that already has a row is answered from the row and nothing is sent.',
      '- A 2xx answer: `done`. A 4xx answer: `rejected`. No answer, a timeout or a 5xx: `unknown`.',
      '- `unknown` is where this workflow stops. It never sends again. **Unknown Write · 2 Check** takes over from the table.',
      '',
      'Replace **Send the write** with your own request. Keep **Retry On Fail** off and **On Error** on *Continue*. Adapt `readWrite` in **Read the answer** if your API answers differently.',
      '',
      '`GET unknown-write/jobs?reference=...` or `?status=review` shows the rows.',
    ],
    [-40, -640],
    700,
    500,
  );
  w.node('When called', 'executeWorkflowTrigger', 1.1, [0, -80], { inputSource: 'passthrough' });
  w.hook('Submit', 'POST', 'submit', [0, 100]);
  w.code('Entry', [220, 0], [
    'const input = $input.first().json;',
    '// Over the webhook the job is the request body; from a sub-workflow call it is the item.',
    'const job = input.webhookUrl && input.body ? input.body : input;',
    "const reference = String(job.reference ?? '').trim();",
    "if (!reference) throw new Error('A write needs a reference: your own id for it, stored by the API and searchable there');",
    "const hex = () => Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0');",
    'return [{ json: {',
    '  reference,',
    "  target: String(job.target ?? ''),",
    '  payload: JSON.stringify(job.payload ?? {}),',
    '  // token: this run. It tells my row from the row of a run that started at the same moment.',
    '  token: `${$execution.id}-${hex()}${hex()}`,',
    '} }];',
  ]);
  const entry = "$('Entry').first().json";
  const first = { returnAll: false, limit: 1, orderBy: true, orderByColumn: 'id', orderByDirection: 'ASC' };
  const answer = (name, position, row, duplicate) =>
    w.code(name, position, [
      `const row = ${row};`,
      `return [{ json: { reference: row.reference, status: row.status, attempt: row.attempt, remote_id: row.remote_id ?? '', resolution: row.resolution ?? '', duplicate_submit: ${duplicate} } }];`,
    ]);

  w.rows('Known reference', [440, 0], 'get', { ...where(['reference', '={{ $json.reference }}']), ...first }, { alwaysOutputData: true });
  w.when('New?', [660, 0], '$json.id === undefined');
  answer('Already known', [900, 200], '$input.first().json', true);

  // The row goes in before the write. Two runs that start at the same moment
  // both insert; the one with the lowest row id goes on, the other removes
  // its row and answers from the winner's.
  w.rows('Claim', [900, -100], 'insert', {
    columns: mapped({
      reference: `={{ ${entry}.reference }}`,
      target: `={{ ${entry}.target }}`,
      payload: `={{ ${entry}.payload }}`,
      status: 'sending',
      attempt: 1,
      checks: 0,
      last_check_at: 0,
      sent_at: '={{ $now.toUTC().toISO() }}',
      history: '[]',
      claimed_by: `={{ ${entry}.token }}`,
    }),
    options: {},
  });
  w.rows('First row', [1120, -100], 'get', { ...where(['reference', `={{ ${entry}.reference }}`]), ...first }, { alwaysOutputData: true });
  w.when('Mine?', [1340, -100], "$json.id === $('Claim').first().json.id");
  w.rows('Remove my row', [1560, 80], 'deleteRows', { ...where(['id', "={{ $('Claim').first().json.id }}"]), options: {} }, { alwaysOutputData: true });
  answer('Lost the race', [1780, 80], "$('First row').first().json", true);

  w.request('Send the write', [1560, -200], 'POST', `={{ '${API}/' + $json.target + '/write?ref=' + encodeURIComponent($json.reference) }}`, 10000);
  w.code('Read the answer', [1780, -200], [
    ...READ_WRITE_ANSWER,
    '',
    'const result = readWrite($input.first().json);',
    'const now = new Date();',
    'return [{ json: {',
    '  status: result.status,',
    "  remote_id: result.remote_id ?? '',",
    "  resolution: result.status === 'done' ? 'acknowledged' : result.status === 'rejected' ? 'refused_' + result.saw : '',",
    "  first_seen_at: result.status === 'done' ? now.toISOString() : '',",
    '  // The recheck clock starts now.',
    '  last_check_at: now.getTime(),',
    "  history: JSON.stringify([{ at: now.toISOString(), step: 'write', attempt: 1, saw: result.saw }]),",
    '} }];',
  ]);
  w.rows('Save the outcome', [2000, -200], 'update', {
    ...where(['id', "={{ $('Claim').first().json.id }}"]),
    columns: fromItem('status', 'remote_id', 'resolution', 'first_seen_at', 'last_check_at', 'history'),
    options: {},
  });
  answer('Result', [2220, -200], '$input.first().json', false);

  w.chain('When called', 'Entry');
  w.chain('Submit', 'Entry', 'Known reference', 'New?');
  w.link('New?', 'Claim', 0);
  w.link('New?', 'Already known', 1);
  w.chain('Claim', 'First row', 'Mine?');
  w.link('Mine?', 'Send the write', 0);
  w.link('Mine?', 'Remove my row', 1);
  w.chain('Remove my row', 'Lost the race');
  w.chain('Send the write', 'Read the answer', 'Save the outcome', 'Result');

  // The rows, for a person or a dashboard.
  w.hook('Jobs', 'GET', 'jobs', [0, 480]);
  w.rows(
    'Rows',
    [220, 480],
    'get',
    {
      matchType: 'anyCondition',
      filters: {
        conditions: [
          { keyName: 'reference', condition: 'eq', keyValue: "={{ $json.query.reference ?? '-' }}" },
          { keyName: 'status', condition: 'eq', keyValue: "={{ $json.query.status ?? '-' }}" },
        ],
      },
      returnAll: true,
    },
    { alwaysOutputData: true },
  );
  w.code('As a list', [440, 480], [
    'const parse = (text, fallback) => { try { return JSON.parse(text); } catch { return fallback; } };',
    'const jobs = $input.all().map((item) => item.json).filter((row) => row.id !== undefined)',
    '  .map((row) => ({ ...row, payload: parse(row.payload, {}), history: parse(row.history, []) }));',
    'return [{ json: { jobs } }];',
  ]);
  w.chain('Jobs', 'Rows', 'As a list');
});

// --- 2. Check ------------------------------------------------------------------

const check = workflow(IDS.check, 'Unknown Write · 2 Check', (w) => {
  w.note(
    'About',
    [
      '## Unknown Write · Check',
      'Runs every minute and works through the rows that are still open. All state is in the data table, so nothing is lost when n8n restarts, and no execution sits in a Wait node.',
      '',
      'For each open job that is due:',
      '1. **Look it up** by the reference. Exactly one record with an id: `done`. Anything else (404, an empty or odd 200, an error) is **no evidence** and changes nothing.',
      '2. No evidence, job not yet with a person: **ask for a receipt**. Only a receipt that names this reference and this attempt, is terminal and says `not_applied` allows one more write. The resend is claimed in the row first.',
      '3. Otherwise count the check. After the last entry of `RECHECK_AFTER_SECONDS` the job goes to `review` and an alert is sent.',
      '4. Jobs in `review` are still looked up, every `REVIEW_RECHECK_SECONDS`. If the record shows up late, the job is closed and a second alert says so. A job in `review` is never written again by this workflow.',
      '',
      'Settings are at the top of **Settings**. Replace **Look it up** and **Ask for a receipt** with your own requests and adapt the two **Judge** nodes to what your API returns. No receipt endpoint: set `USE_RECEIPT` to false and nothing is ever sent twice.',
    ],
    [-40, -680],
    760,
    500,
  );
  w.node('Every minute', 'scheduleTrigger', 1.2, [0, -80], { rule: { interval: [{ field: 'minutes', minutesInterval: 1 }] } });
  w.hook('Or call', 'POST', 'sweep', [0, 100], { responseMode: 'onReceived' });
  w.code('Settings', [220, 0], [
    '// Settings.',
    'const RECHECK_AFTER_SECONDS = [60, 300, 900]; // wait before lookup 1, 2, 3. Still nothing after the last one: review. Set the total above the slowest settle time you measured.',
    'const REVIEW_RECHECK_SECONDS = 1800; // how often a job in review is looked up again',
    'const USE_RECEIPT = true; // false if your API has no authoritative "this write was not applied" answer',
    'const LEASE_SECONDS = 300; // a row still "sending" after this long belongs to a run that died; it is treated as unknown',
    'const MAX_PER_SWEEP = 50; // jobs handled per run',
    "const ALERT_URL = ''; // where the two alerts are posted as JSON (Slack workflow, another webhook). Empty: no alert, the rows still say it.",
    '',
    'return [{ json: {',
    '  recheck_after_seconds: RECHECK_AFTER_SECONDS,',
    '  review_recheck_seconds: REVIEW_RECHECK_SECONDS,',
    '  use_receipt: USE_RECEIPT,',
    '  lease_seconds: LEASE_SECONDS,',
    '  max_per_sweep: MAX_PER_SWEEP,',
    '  alert_url: ALERT_URL,',
    '} }];',
  ]);
  w.rows(
    'Open jobs',
    [440, 0],
    'get',
    {
      matchType: 'anyCondition',
      filters: { conditions: ['unknown', 'review', 'sending'].map((status) => ({ keyName: 'status', condition: 'eq', keyValue: status })) },
      returnAll: true,
    },
    { alwaysOutputData: true },
  );
  w.code('Due now', [660, 0], [
    "const settings = $('Settings').first().json;",
    'const now = Date.now();',
    'const due = [];',
    'for (const { json: row } of $input.all()) {',
    '  if (row.id === undefined) continue;',
    '  let status = row.status;',
    "  if (status === 'sending') {",
    '    // A run is in the middle of the write. If it has been that way for too',
    '    // long the run died, and whether the write went out is unknown.',
    '    if (now - new Date(row.updatedAt).getTime() < settings.lease_seconds * 1000) continue;',
    "    status = 'unknown';",
    '  }',
    '  const checks = row.checks ?? 0;',
    '  const waits = settings.recheck_after_seconds;',
    "  const wait = status === 'review' ? settings.review_recheck_seconds : waits[Math.min(checks, waits.length - 1)];",
    '  if (now < (row.last_check_at ?? 0) + wait * 1000) continue;',
    '  // status_was: what the row said when it was read. Later updates only apply if it still says so.',
    '  due.push({ json: { ...row, status, status_was: row.status } });',
    '}',
    'due.sort((a, b) => (a.json.last_check_at ?? 0) - (b.json.last_check_at ?? 0));',
    'return due.slice(0, settings.max_per_sweep);',
  ]);
  w.request('Look it up', [880, 0], 'GET', `={{ '${API}/' + $json.target + '/lookup?ref=' + encodeURIComponent($json.reference) }}`, 10000);
  w.code('Judge the lookup', [1100, 0], [
    '// Pairs every answer with its job and says what the answer proves.',
    '// Only a positive match is evidence. Adapt `records` to your API.',
    "const jobs = $('Due now').all();",
    'const short = (value) => { try { return JSON.stringify(value).slice(0, 120); } catch { return String(value).slice(0, 120); } };',
    'return $input.all().map((item, index) => {',
    '  const job = jobs[index].json;',
    '  const answer = item.json;',
    '  const body = answer.body;',
    '  // A record counts when the answer is a 200, carries a list, does not say exists: false (or anything odd in that field), and the record has an id.',
    '  const ok = answer.statusCode === 200 && body && typeof body === "object" && (body.exists === undefined || body.exists === true) && Array.isArray(body.records);',
    '  const records = ok ? body.records.filter((record) => record && typeof record.id === "string" && record.id !== "") : [];',
    "  const verdict = records.length === 1 ? 'found' : records.length > 1 ? 'several' : 'no_evidence';",
    "  const saw = answer.statusCode === undefined ? 'no answer' : `${answer.statusCode} ${short(body)}`;",
    '  const now = new Date();',
    '  const parse = (text) => { try { return JSON.parse(text); } catch { return []; } };',
    "  const history = [...parse(job.history), { at: now.toISOString(), step: 'lookup', attempt: job.attempt, saw, verdict }].slice(-40);",
    '  return { json: {',
    '    job,',
    '    verdict,',
    '    id: job.id,',
    '    status_was: job.status_was,',
    '    checks: (job.checks ?? 0) + 1,',
    '    last_check_at: now.getTime(),',
    '    now: now.toISOString(),',
    '    entries: history,',
    '    history: JSON.stringify(history),',
    '    // for "Close as done"',
    "    status: 'done',",
    "    remote_id: records[0]?.id ?? '',",
    "    first_seen_at: job.first_seen_at || now.toISOString(),",
    "    resolution: job.status === 'review' ? 'arrived_after_cutoff' : job.attempt > 1 ? 'resent_after_receipt' : 'confirmed_by_lookup',",
    '  } };',
    '});',
  ]);
  w.when('Found?', [1320, 0], "$json.verdict === 'found'");
  w.rows('Close as done', [1560, -160], 'update', {
    ...where(['id', '={{ $json.id }}']),
    columns: fromItem('status', 'remote_id', 'first_seen_at', 'resolution', 'checks', 'last_check_at', 'history'),
    options: {},
  }, { alwaysOutputData: true });

  // Absence proves nothing. The one thing that does allow another write is an
  // authoritative receipt, and only while the job is not with a person.
  w.when('Receipt worth asking?', [1560, 120], "$json.verdict === 'no_evidence' && $json.job.status === 'unknown' && $('Settings').first().json.use_receipt");
  w.request('Ask for a receipt', [1800, 20], 'GET', `={{ '${API}/' + $json.job.target + '/receipt?ref=' + encodeURIComponent($json.job.reference) }}`, 10000);
  w.code('Judge the receipt', [2020, 20], [
    '// A receipt allows one more write only if all of this holds: it is for',
    '// this reference, for the attempt the row is on, terminal, and says the',
    '// write was not applied. A receipt for an earlier attempt allows nothing.',
    "const asked = $('Receipt worth asking?').all(0);",
    'return $input.all().map((item, index) => {',
    '  const state = asked[index].json;',
    '  const job = state.job;',
    '  const answer = item.json;',
    '  const body = answer.body;',
    '  const proof = answer.statusCode === 200 && body && typeof body === "object"',
    '    && body.ref === job.reference && body.attempt === job.attempt && body.terminal === true && body.outcome === "not_applied";',
    "  const saw = answer.statusCode === undefined ? 'no answer' : `${answer.statusCode} ${JSON.stringify(body ?? null).slice(0, 120)}`;",
    "  const entries = [...state.entries, { at: state.now, step: 'receipt', attempt: job.attempt, saw, verdict: proof ? 'not_applied' : 'no_evidence' }];",
    "  if (proof) entries.push({ at: state.now, step: 'write', attempt: job.attempt + 1, saw: 'claimed' });",
    '  return { json: {',
    '    ...state,',
    '    proof,',
    '    entries,',
    '    history: JSON.stringify(entries.slice(-40)),',
    '    // for "Claim the resend"',
    '    attempt: job.attempt,',
    '    next_attempt: job.attempt + 1,',
    '    claimed_by: `${$execution.id}-${job.id}`,',
    '  } };',
    '});',
  ]);
  w.when('Proof it was not applied?', [2240, 20], '$json.proof === true');
  // One conditional update: it only changes the row while it still says what
  // this run read. Two runs at the same moment cannot both win it; the winner
  // is the one whose claimed_by is in the row that comes back.
  w.rows('Claim the resend', [2480, -80], 'update', {
    ...where(['id', '={{ $json.id }}'], ['status', '={{ $json.status_was }}'], ['attempt', '={{ $json.attempt }}']),
    columns: mapped({
      status: 'sending',
      attempt: '={{ $json.next_attempt }}',
      claimed_by: '={{ $json.claimed_by }}',
      checks: '={{ $json.checks }}',
      last_check_at: '={{ $json.last_check_at }}',
      history: '={{ $json.history }}',
    }),
    options: {},
  }, { alwaysOutputData: true });
  w.when('Resend mine?', [2700, -80], "$json.id !== undefined && $json.status === 'sending' && $json.claimed_by === $execution.id + '-' + $json.id");
  w.request('Send the write again', [2920, -160], 'POST', `={{ '${API}/' + $json.target + '/write?ref=' + encodeURIComponent($json.reference) }}`, 10000);
  w.code('Read the resend answer', [3140, -160], [
    ...READ_WRITE_ANSWER,
    '',
    "const rows = $('Resend mine?').all(0);",
    'return $input.all().map((item, index) => {',
    '  const row = rows[index].json;',
    '  const result = readWrite(item.json);',
    '  const now = new Date();',
    '  const parse = (text) => { try { return JSON.parse(text); } catch { return []; } };',
    '  const history = parse(row.history);',
    '  const last = history[history.length - 1];',
    "  if (last && last.step === 'write' && last.saw === 'claimed') last.saw = result.saw;",
    '  return { json: {',
    '    id: row.id,',
    '    status: result.status,',
    "    remote_id: result.remote_id ?? '',",
    "    resolution: result.status === 'done' ? 'resent_after_receipt' : result.status === 'rejected' ? 'refused_' + result.saw : '',",
    "    first_seen_at: result.status === 'done' ? now.toISOString() : '',",
    '    // A new attempt gets the full recheck window again.',
    '    checks: 0,',
    '    last_check_at: now.getTime(),',
    '    history: JSON.stringify(history),',
    '  } };',
    '});',
  ]);
  w.rows('Save the resend outcome', [3360, -160], 'update', {
    ...where(['id', '={{ $json.id }}']),
    columns: fromItem('status', 'remote_id', 'resolution', 'first_seen_at', 'checks', 'last_check_at', 'history'),
    options: {},
  });

  // No evidence either way: count the check, and hand over at the cutoff.
  w.code('Count the check', [2480, 240], [
    "const waits = $('Settings').first().json.recheck_after_seconds;",
    'return $input.all().map((item) => {',
    '  const state = item.json;',
    '  const job = state.job;',
    '  // Several records under one reference: someone or something wrote twice. A person has to look.',
    "  const several = state.verdict === 'several';",
    "  const handover = job.status === 'unknown' && (several || state.checks >= waits.length);",
    '  return { json: {',
    '    id: state.id,',
    '    status_was: state.status_was,',
    '    handover,',
    "    status: handover ? 'review' : job.status,",
    "    review_at: handover ? state.now : job.review_at ?? '',",
    "    resolution: several ? 'several_records' : job.resolution ?? '',",
    '    checks: state.checks,',
    '    last_check_at: state.last_check_at,',
    '    history: state.history,',
    '  } };',
    '});',
  ]);
  w.when('Past the cutoff?', [2700, 240], '$json.handover === true');
  const counted = fromItem('status', 'review_at', 'resolution', 'checks', 'last_check_at', 'history');
  const stillAsRead = where(['id', '={{ $json.id }}'], ['status', '={{ $json.status_was }}']);
  w.rows('Hand to review', [2920, 140], 'update', { ...stillAsRead, columns: counted, options: {} }, { alwaysOutputData: true });
  w.rows('Keep waiting', [2920, 340], 'update', { ...stillAsRead, columns: counted, options: {} }, { alwaysOutputData: true });

  // Two alerts: "needs review" with everything the reviewer needs, and
  // "resolved itself" when a record shows up after the cutoff.
  w.code('Alert', [3360, 60], [
    "const url = $('Settings').first().json.alert_url;",
    'const parse = (text, fallback) => { try { return JSON.parse(text); } catch { return fallback; } };',
    'const alerts = [];',
    'for (const { json: row } of $input.all()) {',
    '  if (row.id === undefined) continue;',
    '  let event;',
    "  if (row.status === 'review') event = 'needs_review';",
    "  else if (row.status === 'done' && row.resolution === 'arrived_after_cutoff') event = 'resolved_itself';",
    '  else continue;',
    '  alerts.push({ json: {',
    '    alert_url: url,',
    '    event,',
    "    text: event === 'needs_review'",
    '      ? `Write ${row.reference}: outcome still unknown after ${row.checks} lookups. Search the target system for this reference before creating anything by hand.`',
    '      : `Write ${row.reference}: the record showed up (${row.remote_id}). No action needed, do not enter it again.`,',
    '    reference: row.reference,',
    '    target: row.target,',
    '    payload: parse(row.payload, {}),',
    '    attempt: row.attempt,',
    '    sent_at: row.sent_at,',
    '    review_at: row.review_at,',
    '    remote_id: row.remote_id ?? "",',
    '    resolution: row.resolution ?? "",',
    '    history: parse(row.history, []),',
    '  } });',
    '}',
    'return alerts;',
  ]);
  w.when('Alert address set?', [3580, 60], "typeof $json.alert_url === 'string' && $json.alert_url !== ''");
  w.node(
    'Send the alert',
    'httpRequest',
    4.2,
    [3800, 60],
    {
      method: 'POST',
      url: '={{ $json.alert_url }}',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify($json) }}',
      options: { timeout: 10000 },
    },
    { onError: 'continueRegularOutput' },
  );

  w.chain('Every minute', 'Settings');
  w.chain('Or call', 'Settings', 'Open jobs', 'Due now', 'Look it up', 'Judge the lookup', 'Found?');
  w.link('Found?', 'Close as done', 0);
  w.link('Found?', 'Receipt worth asking?', 1);
  w.link('Receipt worth asking?', 'Ask for a receipt', 0);
  w.link('Receipt worth asking?', 'Count the check', 1);
  w.chain('Ask for a receipt', 'Judge the receipt', 'Proof it was not applied?');
  w.link('Proof it was not applied?', 'Claim the resend', 0);
  w.link('Proof it was not applied?', 'Count the check', 1);
  w.chain('Claim the resend', 'Resend mine?', 'Send the write again', 'Read the resend answer', 'Save the resend outcome');
  w.chain('Count the check', 'Past the cutoff?');
  w.link('Past the cutoff?', 'Hand to review', 0);
  w.link('Past the cutoff?', 'Keep waiting', 1);
  w.link('Close as done', 'Alert');
  w.link('Hand to review', 'Alert');
  w.chain('Alert', 'Alert address set?', 'Send the alert');
});

mkdirSync(join(root, 'workflows'), { recursive: true });
const files = { '0-setup.json': setup, '1-write.json': write, '2-check.json': check };
for (const [file, content] of Object.entries(files)) {
  writeFileSync(join(root, 'workflows', file), `${JSON.stringify(content, null, 2)}\n`);
  console.log(`workflows/${file}  ${content.nodes.length} nodes`);
}
