// Puts the lost-ack fixture (third_party/lost-ack-fixture, unmodified) on the
// compose network, and collects the alerts the Check workflow posts.
//
// The fixture's own command binds to 127.0.0.1, which another container
// cannot reach. So this file imports its createFixture() and hands it the
// requests that arrive here. One instance per entry of FIXTURE_LAGS; the
// number is how many lookups keep a record hidden (the fixture's lagReads):
//   /lag2/<scenario>/write|lookup|receipt|report?ref=demo-...
//   /lag5/<scenario>/...
// Alerts (not part of the fixture):
//   POST /alerts   body: JSON          GET /alerts   -> { alerts: [...] }

import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const { createFixture } = await import(pathToFileURL(process.env.FIXTURE_MODULE ?? '/fixture/lost-ack-fixture.mjs').href);
const lags = (process.env.FIXTURE_LAGS ?? '2,5').split(',').map(Number);
const instances = new Map(lags.map((lagReads) => [`lag${lagReads}`, createFixture({ lagReads })]));
const alerts = [];

const reply = (res, status, data) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
};

createServer((req, res) => {
  const match = /^\/(lag\d+)(\/.*)$/.exec(req.url ?? '');
  const fixture = match && instances.get(match[1]);
  if (fixture) {
    req.url = match[2];
    fixture.emit('request', req, res);
    return;
  }
  if (req.url === '/alerts' && req.method === 'GET') return reply(res, 200, { alerts });
  if (req.url === '/alerts' && req.method === 'POST') {
    let text = '';
    req.on('data', (chunk) => (text += chunk));
    req.on('end', () => {
      try {
        alerts.push(JSON.parse(text));
        reply(res, 200, { ok: true });
      } catch {
        reply(res, 400, { error: 'not_json' });
      }
    });
    return;
  }
  reply(res, 404, { error: 'unknown_path' });
}).listen(8080, '0.0.0.0', () => console.log(`fixture host on :8080, instances: ${[...instances.keys()].join(', ')}`));
