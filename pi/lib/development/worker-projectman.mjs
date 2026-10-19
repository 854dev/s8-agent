import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

/** A per-run MCP endpoint exposes only the assigned UID; upstream credentials stay in the runner. */
export async function startWorkerProjectman(request, { signal, readWorkflow } = {}) {
  let upstream;
  const sessions = new Set();
  const token = randomBytes(32).toString('base64url');
  let fetched = false, httpServer;
  async function close() {
    if (httpServer) await new Promise(resolve => { httpServer.close(resolve); httpServer.closeAllConnections(); });
    await Promise.allSettled([...sessions].map(server => server.close()));
    await upstream?.close();
  }
  try {
    signal?.throwIfAborted();
    if (!readWorkflow) {
      if (!process.env.PHCMS_MCP_URL || !process.env.PHCMS_ACCESS_TOKEN) throw new Error('Projectman MCP connection is not configured for this worker');
      upstream = new Client({ name: 's8-worker-runner', version: '1.0.0' });
      const transport = new StreamableHTTPClientTransport(new URL(process.env.PHCMS_MCP_URL), {
        requestInit: { headers: { authorization: `Bearer ${process.env.PHCMS_ACCESS_TOKEN}` } },
      });
      await upstream.connect(transport, { signal, timeout: 10000 });
      readWorkflow = async uid => {
        const result = await upstream.callTool({ name: 'projectman_get_workflow', arguments: { uid } }, undefined, { signal, timeout: 10000 });
        if (result.isError) throw new Error('Projectman assignment lookup failed');
        const text = result.content?.find(block => block.type === 'text')?.text;
        try { return JSON.parse(text); }
        catch { throw new Error('Projectman returned an invalid workflow'); }
      };
    }
    async function readAssignedWork() {
      signal?.throwIfAborted();
      const current = await readWorkflow(request.task.uid);
      if ((current.uid && current.uid !== request.task.uid) || current.state !== 'doing' || current.workflow?.run?.id !== request.run.runId || current.executionAllowed === false || (request.workerId && current.workflow.run.workerId && current.workflow.run.workerId !== request.workerId)) throw new Error('Assignment is no longer active');
      return { ...current, projectInstructions: request.projectInstructions, baseCommit: request.baseCommit };
    }
    await readAssignedWork();
    httpServer = createServer(async (req, res) => {
      const provided = Buffer.from(req.headers.authorization ?? ''), expected = Buffer.from(`Bearer ${token}`);
      if (req.url !== '/mcp' || provided.length !== expected.length || !timingSafeEqual(provided, expected)) { res.writeHead(401); res.end(); return; }
      const server = new Server({ name: 's8-assigned-projectman', version: '1.0.0' }, { capabilities: { tools: {} } });
      sessions.add(server);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.once('close', () => { sessions.delete(server); void server.close().catch(() => {}); });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{
        name: 'projectman_get_workflow', description: 'Read the current active assignment. Other UIDs and workflow changes are unavailable.',
        inputSchema: { type: 'object', properties: { uid: { type: 'string', const: request.task.uid } }, required: ['uid'], additionalProperties: false },
      }] }));
      server.setRequestHandler(CallToolRequestSchema, async message => {
        if (message.params.name !== 'projectman_get_workflow' || message.params.arguments?.uid !== request.task.uid || Object.keys(message.params.arguments).some(key => key !== 'uid')) return { isError: true, content: [{ type: 'text', text: 'Only the assigned UID may be read' }] };
        try {
          const current = await readAssignedWork();
          fetched = true;
          return { content: [{ type: 'text', text: JSON.stringify(current) }] };
        } catch { return { isError: true, content: [{ type: 'text', text: 'The assigned run could not be verified as active' }] }; }
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res);
      } catch {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      }
    });
    await new Promise((resolve, reject) => { httpServer.once('error', reject); httpServer.listen(0, '127.0.0.1', resolve); });
    return {
      config: { mcpServers: { projectman: { type: 'http', url: `http://127.0.0.1:${httpServer.address().port}/mcp`, headers: { Authorization: `Bearer ${token}` } } } },
      async verifyReport() {
        if (!fetched) throw new Error('Claude Code did not retrieve its assigned UID through Projectman');
        await readAssignedWork();
      },
      close,
    };
  } catch (error) { await close(); throw error; }
}
