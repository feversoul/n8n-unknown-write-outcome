// A loopback-only synthetic destination for testing an existing workflow.
import {createServer} from 'node:http';
import {pathToFileURL} from 'node:url';

const CASES = new Set(['committed', 'uncommitted', 'stale-json', 'malformed-json', 'confirmed-no-write']);
const COMMITS_FIRST = new Set(['committed', 'stale-json', 'malformed-json']);
const REF = /^demo-[a-z0-9-]{1,40}$/;

export function createFixture({lagReads = 2, dropAfterMs = 750} = {}) {
  if (!Number.isSafeInteger(lagReads) || lagReads < 1 || lagReads > 20 ||
      !Number.isSafeInteger(dropAfterMs) || dropAfterMs < 0 || dropAfterMs > 5000) {
    throw new Error('Invalid synthetic fixture parameters');
  }
  const cases = new Map();
  return createServer((req, res) => {
    const reply = (status, data) => {
      res.writeHead(status, {'content-type': 'application/json', 'cache-control': 'no-store'});
      res.end(JSON.stringify(data));
    };
    let url;
    try {url = new URL(req.url, 'http://127.0.0.1');}
    catch {return reply(400, {error: 'invalid_fixture_input'});}
    const [, scenario, route, extra] = url.pathname.split('/');
    const references = url.searchParams.getAll('ref');
    if (extra !== undefined || !CASES.has(scenario) || references.length !== 1 ||
        !REF.test(references[0]) || [...url.searchParams.keys()].length !== 1 ||
        !['write', 'lookup', 'report', 'receipt'].includes(route) ||
        (route === 'receipt' && scenario !== 'confirmed-no-write')) {
      return reply(400, {error: 'invalid_fixture_input'});
    }
    const method = route === 'write' ? 'POST' : 'GET';
    if (req.method !== method) return reply(405, {error: 'wrong_method'});
    if (req.headers['transfer-encoding'] || Number(req.headers['content-length'] ?? 0) !== 0) {
      return reply(400, {error: 'body_not_allowed'});
    }

    const key = `${scenario}/${references[0]}`;
    let state = cases.get(key);
    if (route === 'receipt') {
      if (!state?.writes) return reply(404, {error: 'no_terminal_receipt'});
      // Fixture-only authority: this scenario deterministically never applies its first write.
      return reply(200, {ref: references[0], attempt: 1, terminal: true, outcome: 'not_applied'});
    }
    if (!state) {
      if (cases.size >= 64) return reply(503, {error: 'restart_fixture'});
      state = {writes: 0, lookups: 0, records: []};
      cases.set(key, state);
    }
    if (route === 'report') {
      return reply(200, {writes: state.writes, lookups: state.lookups, effects: state.records.length});
    }
    if (route === 'lookup') {
      state.lookups += 1;
      if (scenario === 'stale-json' || scenario === 'malformed-json') {
        if (state.lookups <= lagReads) {
          return reply(200, scenario === 'stale-json' ? {exists: false}
            : state.lookups % 2 ? {} : {exists: 'false'});
        }
        return reply(200, {exists: state.records.length > 0, records: state.records});
      }
      if (state.lookups <= lagReads || state.records.length === 0) {
        return reply(404, {error: 'not_found'});
      }
      return reply(200, {records: state.records});
    }
    state.writes += 1;
    if (state.writes === 1) {
      if (COMMITS_FIRST.has(scenario)) state.records.push({id: 'fixture-1'});
      const timer = setTimeout(() => req.socket.destroy(), dropAfterMs);
      timer.unref();
      res.once('close', () => clearTimeout(timer));
      return;
    }
    // Deliberately not idempotent: a later write creates another effect.
    const record = {id: `fixture-${state.records.length + 1}`};
    state.records.push(record);
    return reply(201, record);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.argv[2] ?? '8788');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Expected a TCP port');
  const lagReads = Number(process.argv[3] ?? '2');
  createFixture({lagReads}).listen(port, '127.0.0.1', () => {
    console.log(`Synthetic fixture: http://127.0.0.1:${port}`);
  });
}
