import http from 'node:http';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const ME = 1;
const COLLEAGUE = 2;

const SCENARIOS = [
  { rule: 'OwnedAtRetryPatch', args: { subject: 'New' }, reassignAfterGet: 1, expect: 'refused' },
  { rule: 'OwnedAtAddonWrite', args: { points: 5 }, reassignAfterGet: 1, expect: 'refused' },
  { rule: 'OwnedAtAddonWrite', args: { points: 5 }, reassignAfterGet: 2, expect: 'reproduced' },
];

let task;
let events;
let gets;
let reassignAfterGet;

function reset(scenario) {
  task = { id: 301, ref: 7, project: 5, subject: 'Old', owner: COLLEAGUE, assigned_to: ME, version: 1 };
  events = [];
  gets = 0;
  reassignAfterGet = scenario.reassignAfterGet;
}

const holder = () => (task.assigned_to === ME ? 'me' : 'colleague');

const server = http.createServer(async (req, res) => {
  let body = '';

  for await (const chunk of req) body += chunk;
  const send = (code, data) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(data));
  };
  const { pathname } = new URL(req.url, 'http://fake');

  if (pathname === '/api/v1/auth') return send(200, { auth_token: 'fake', id: ME });

  if (pathname === '/api/v1/users/me') return send(200, { id: ME, username: 'me' });

  if (pathname === '/api/v1/tasks/301' && req.method === 'GET') {
    const snapshot = task;
    gets += 1;
    events.push('agent reads');

    if (gets === reassignAfterGet) {
      task = { ...task, assigned_to: COLLEAGUE, version: task.version + 1 };
      events.push('colleague reassigns');
    }

    return send(200, snapshot);
  }

  if (pathname === '/api/v1/tasks/301' && req.method === 'PATCH') {
    const patch = JSON.parse(body);

    if (patch.version !== task.version) {
      events.push(`PATCH v${patch.version} rejected`);

      return send(400, { version: "The version doesn't match" });
    }

    task = { ...task, ...patch, version: task.version + 1 };
    events.push(`PATCH saved, assigned_to=${holder()}`);

    return send(200, task);
  }

  if (pathname === '/api/v1/task-points' && req.method === 'POST') {
    events.push(`task-points saved, assigned_to=${holder()}`);

    return send(200, {});
  }

  return send(404, {});
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const client = new Client({ name: 'ownership-replay', version: '1' }, { versionNegotiation: { mode: 'auto' } });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: ['dist/src/index.js'],
  env: {
    ...process.env,
    TAIGA_API_URL: `http://127.0.0.1:${server.address().port}/api/v1`,
    TAIGA_USERNAME: 'me',
    TAIGA_PASSWORD: 'fake',
    TAIGA_READONLY: '',
    TAIGA_TOOLS: '',
  },
  stderr: 'pipe',
}));

let mismatches = 0;

for (const scenario of SCENARIOS) {
  reset(scenario);
  const result = await client.callTool({ name: 'work', arguments: { op: 'update', type: 'task', item: '301', ...scenario.args } });
  const wroteForeign = events.some((e) => e.endsWith('assigned_to=colleague'));
  const outcome = wroteForeign ? 'reproduced' : result.isError ? 'refused' : 'clean';
  const ok = outcome === scenario.expect;

  if (!ok) mismatches += 1;
  console.log(`${ok ? 'ok' : 'UNEXPECTED'}  ${scenario.rule}, colleague after GET ${scenario.reassignAfterGet}: ${outcome} (expected ${scenario.expect}) | ${events.join(' -> ')}`);
}

await client.close();
server.close();
process.exit(mismatches ? 1 : 0);
