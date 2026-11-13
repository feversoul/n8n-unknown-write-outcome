import assert from 'node:assert/strict';
import {once} from 'node:events';
import test from 'node:test';
import {createFixture} from './lost-ack-fixture.mjs';

test('same lost write response and negative reads, different effects', async t => {
  const server = createFixture({dropAfterMs: 35});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = (scenario, path, ref = 'demo-test', extra) => fetch(`${origin}/${scenario}/${path}?ref=${ref}`, {
    method: path === 'write' ? 'POST' : 'GET', signal: AbortSignal.timeout(2000), ...extra,
  });
  const report = async (scenario, ref) => (await call(scenario, 'report', ref)).json();

  for (const scenario of ['committed', 'uncommitted']) {
    await assert.rejects(call(scenario, 'write'));
    for (let read = 0; read < 2; read += 1) {
      const reply = await call(scenario, 'lookup');
      assert.equal(reply.status, 404);
      assert.deepEqual(await reply.json(), {error: 'not_found'});
    }
  }
  const found = await call('committed', 'lookup');
  assert.equal(found.status, 200);
  assert.deepEqual(await found.json(), {records: [{id: 'fixture-1'}]});
  assert.equal((await call('uncommitted', 'lookup')).status, 404);
  assert.deepEqual(await report('committed'), {writes: 1, lookups: 3, effects: 1});
  assert.deepEqual(await report('uncommitted'), {writes: 1, lookups: 3, effects: 0});

  // Negative control: retrying after an early 404 duplicates the committed case.
  await assert.rejects(call('committed', 'write', 'demo-blind-retry'));
  assert.equal((await call('committed', 'lookup', 'demo-blind-retry')).status, 404);
  const duplicate = await call('committed', 'write', 'demo-blind-retry');
  assert.equal(duplicate.status, 201);
  assert.deepEqual(await duplicate.json(), {id: 'fixture-2'});
  assert.deepEqual(await report('committed', 'demo-blind-retry'), {writes: 2, lookups: 1, effects: 2});

  assert.equal((await call('committed', 'report', 'not-a-synthetic-reference')).status, 400);
  assert.equal((await call('committed', 'write', 'demo-body', {body: 'blocked'})).status, 400);
  assert.deepEqual(await report('committed', 'demo-body'), {writes: 0, lookups: 0, effects: 0});
});

test('stale and malformed 200 responses hide a committed write', async t => {
  const server = createFixture({lagReads: 5, dropAfterMs: 25});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = (scenario, route, ref = 'demo-waiting') => fetch(`${origin}/${scenario}/${route}?ref=${ref}`, {
    method: route === 'write' ? 'POST' : 'GET', signal: AbortSignal.timeout(2000),
  });
  for (const scenario of ['stale-json', 'malformed-json']) {
    await assert.rejects(call(scenario, 'write'));
    for (let read = 1; read <= 5; read += 1) {
      const result = await call(scenario, 'lookup');
      assert.equal(result.status, 200);
      assert.deepEqual(await result.json(), scenario === 'stale-json' ? {exists: false}
        : read % 2 ? {} : {exists: 'false'});
    }
    assert.deepEqual(await (await call(scenario, 'report')).json(), {writes: 1, lookups: 5, effects: 1});
    assert.deepEqual(await (await call(scenario, 'lookup')).json(), {exists: true, records: [{id: 'fixture-1'}]});
    assert.equal((await call(scenario, 'receipt')).status, 400);
  }
  await assert.rejects(call('stale-json', 'write', 'demo-unsafe'));
  assert.deepEqual(await (await call('stale-json', 'lookup', 'demo-unsafe')).json(), {exists: false});
  assert.equal((await call('stale-json', 'write', 'demo-unsafe')).status, 201);
  assert.deepEqual(await (await call('stale-json', 'report', 'demo-unsafe')).json(), {writes: 2, lookups: 1, effects: 2});
});

test('terminal no-write receipt binds the original reference and attempt', async t => {
  const server = createFixture({dropAfterMs: 25});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}/confirmed-no-write`;
  const call = (route, ref = 'demo-retry', method = route === 'write' ? 'POST' : 'GET') =>
    fetch(`${origin}/${route}?ref=${ref}`, {method, signal: AbortSignal.timeout(2000)});
  assert.equal((await call('receipt')).status, 404);
  assert.equal((await call('receipt', 'demo-retry', 'POST')).status, 405);
  await assert.rejects(call('write'));
  assert.equal((await call('lookup')).status, 404);
  const receipt = await call('receipt');
  assert.equal(receipt.status, 200);
  assert.deepEqual(await receipt.json(), {ref: 'demo-retry', attempt: 1, terminal: true, outcome: 'not_applied'});
  assert.equal((await call('receipt', 'demo-other')).status, 404);
  assert.deepEqual(await (await call('report')).json(), {writes: 1, lookups: 1, effects: 0});
  assert.equal((await call('write')).status, 201);
  assert.deepEqual(await (await call('report')).json(), {writes: 2, lookups: 1, effects: 1});
  assert.equal((await (await call('receipt')).json()).attempt, 1);
});
