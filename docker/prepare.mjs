// Used by bootstrap.sh inside the n8n container: writes the import files for
// the n8n CLI from the environment, so no secret is stored in the repository.
//   node prepare.mjs <workflows dir> <output dir>
//
// Optional environment, mostly for the tests (seconds instead of minutes):
//   API_BASE                 replaces the fixture address in the three requests
//   WRITE_TIMEOUT_MS         timeout of the write requests
//   RECHECK_AFTER_SECONDS    for example 1,1,1
//   REVIEW_RECHECK_SECONDS, LEASE_SECONDS, ALERT_URL
//   SWEEP_INTERVAL_SECONDS   how often the Check workflow runs

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [source, out] = process.argv.slice(2);
const env = process.env;

const credentials = [
  {
    id: 'unknownWriteKey',
    name: 'Unknown Write Key',
    type: 'httpHeaderAuth',
    data: { name: 'X-Workflow-Key', value: env.WORKFLOW_KEY },
  },
];

const settings = [
  ['RECHECK_AFTER_SECONDS', (value) => `[${value.split(',').map(Number).join(', ')}]`],
  ['REVIEW_RECHECK_SECONDS', (value) => String(Number(value))],
  ['LEASE_SECONDS', (value) => String(Number(value))],
  ['ALERT_URL', (value) => JSON.stringify(value)],
];

mkdirSync(join(out, 'workflows'), { recursive: true });
writeFileSync(join(out, 'credentials.json'), JSON.stringify(credentials));

for (const file of readdirSync(source).filter((name) => name.endsWith('.json'))) {
  let text = readFileSync(join(source, file), 'utf8');
  if (env.API_BASE) text = text.replaceAll('http://fixture:8080', env.API_BASE.replace(/\/+$/, ''));
  const workflow = JSON.parse(text);
  for (const node of workflow.nodes) {
    if (node.type === 'n8n-nodes-base.scheduleTrigger' && Number(env.SWEEP_INTERVAL_SECONDS) > 0) {
      node.parameters.rule = { interval: [{ field: 'seconds', secondsInterval: Number(env.SWEEP_INTERVAL_SECONDS) }] };
    }
    if (node.name.startsWith('Send the write') && Number(env.WRITE_TIMEOUT_MS) > 0) {
      node.parameters.options.timeout = Number(env.WRITE_TIMEOUT_MS);
    }
    if (node.name === 'Settings') {
      for (const [name, format] of settings) {
        if (!env[name]) continue;
        const line = new RegExp(`^const ${name} = [^;]*;`, 'm');
        if (!line.test(node.parameters.jsCode)) throw new Error(`Settings has no ${name}`);
        node.parameters.jsCode = node.parameters.jsCode.replace(line, () => `const ${name} = ${format(env[name])};`);
      }
    }
  }
  writeFileSync(join(out, 'workflows', file), JSON.stringify(workflow));
}
