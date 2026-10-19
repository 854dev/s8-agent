import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startWorkerProjectman } from '../lib/development/worker-projectman.mjs';

test('worker MCP exposes only its active UID and requires a real lookup before reporting', async t => {
  const request = { task: { uid: 'task-1' }, run: { runId: randomUUID() }, workerId: 'worker-1' };
  let current = { uid: 'task-1', state: 'doing', workflow: { run: { id: request.run.runId, workerId: 'worker-1' } } }, reads = 0;
  const facade = await startWorkerProjectman(request, { readWorkflow: async uid => { reads++; assert.equal(uid, 'task-1'); return structuredClone(current); } });
  const config = facade.config.mcpServers.projectman;
  const client = new Client({ name: 'worker-fixture', version: '1.0.0' });
  t.after(async () => { await client.close(); await facade.close(); });
  assert.equal((await fetch(config.url, { method: 'POST' })).status, 401);
  await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } }));
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['projectman_get_workflow']);
  await assert.rejects(facade.verifyReport(), /did not retrieve/);
  assert.equal((await client.callTool({ name: 'projectman_workflow', arguments: { uid: 'task-1', action: 'report' } })).isError, true);
  assert.equal((await client.callTool({ name: 'projectman_get_workflow', arguments: { uid: 'other-task' } })).isError, true);
  assert.equal(reads, 1, 'Rejected tools never reach upstream Projectman');
  assert.notEqual((await client.callTool({ name: 'projectman_get_workflow', arguments: { uid: 'task-1' } })).isError, true);
  await facade.verifyReport();
  current.state = 'blocked';
  assert.equal((await client.callTool({ name: 'projectman_get_workflow', arguments: { uid: 'task-1' } })).isError, true);
  await assert.rejects(facade.verifyReport(), /no longer active/);
});

test('worker MCP refuses a stale, revoked or differently assigned run before exposing tools', async () => {
  const request = { task: { uid: 'task-1' }, run: { runId: randomUUID() }, workerId: 'worker-1' };
  for (const changes of [{ state: 'blocked' }, { executionAllowed: false }, { workflow: { run: { id: randomUUID() } } }, { workflow: { run: { id: request.run.runId, workerId: 'worker-2' } } }]) {
    await assert.rejects(startWorkerProjectman(request, { readWorkflow: async () => ({ uid: 'task-1', state: 'doing', workflow: { run: { id: request.run.runId } }, ...changes }) }), /no longer active/);
  }
});

test('runner authenticates to upstream MCP while exposing a different per-run credential', async t => {
  const request = { task: { uid: 'task-upstream' }, run: { runId: randomUUID() } };
  const upstream = await startWorkerProjectman(request, { readWorkflow: async () => ({ uid: request.task.uid, state: 'doing', workflow: { run: { id: request.run.runId } } }) });
  const previousUrl = process.env.PHCMS_MCP_URL, previousToken = process.env.PHCMS_ACCESS_TOKEN;
  const config = upstream.config.mcpServers.projectman;
  process.env.PHCMS_MCP_URL = config.url;
  process.env.PHCMS_ACCESS_TOKEN = config.headers.Authorization.slice('Bearer '.length);
  let scoped, client;
  t.after(async () => {
    await client?.close(); await scoped?.close(); await upstream.close();
    if (previousUrl === undefined) delete process.env.PHCMS_MCP_URL; else process.env.PHCMS_MCP_URL = previousUrl;
    if (previousToken === undefined) delete process.env.PHCMS_ACCESS_TOKEN; else process.env.PHCMS_ACCESS_TOKEN = previousToken;
  });
  scoped = await startWorkerProjectman(request);
  const endpoint = scoped.config.mcpServers.projectman;
  assert.notEqual(endpoint.headers.Authorization, config.headers.Authorization);
  client = new Client({ name: 'scoped-upstream-fixture', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url), { requestInit: { headers: endpoint.headers } }));
  const result = await client.callTool({ name: 'projectman_get_workflow', arguments: { uid: request.task.uid } });
  assert.equal(JSON.parse(result.content[0].text).workflow.run.id, request.run.runId);
  await scoped.verifyReport();
});
