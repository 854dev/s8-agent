import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  isInitializeRequest,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { loadHubConfig, type HubConfig } from "./config.js";
import { KbTaskPool } from "./kb.js";
import { UpstreamPool, type RoutedTool, type ToolPool } from "./upstreams.js";

type Session = {
  userId: string;
  server: Server;
  transport: StreamableHTTPServerTransport;
};

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 10 * 1024 * 1024) throw new Error("request body exceeds 10 MiB");
    chunks.push(buffer);
  }
  if (!chunks.length) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function userFromPath(url: URL, defaultUserId: string) {
  if (/^\/mcp\/?$/.test(url.pathname)) return defaultUserId;
  const match = /^\/mcp\/([^/]+)\/?$/.exec(url.pathname);
  if (!match) return null;
  const userId = decodeURIComponent(match[1]!);
  return /^[A-Za-z0-9_-]{1,64}$/.test(userId) ? userId : null;
}

function publicTool(tool: RoutedTool) {
  const { _route: _ignored, ...definition } = tool;
  return definition;
}

class CombinedToolPool implements ToolPool {
  private readonly upstream: UpstreamPool;
  private readonly kb: KbTaskPool;

  constructor(config: HubConfig) {
    this.upstream = new UpstreamPool(config);
    this.kb = new KbTaskPool(config);
  }

  async listTools(userId: string): Promise<{ tools: RoutedTool[]; errors: Record<string, string> }> {
    const [upstream, kb] = await Promise.all([this.upstream.listTools(userId), this.kb.listTools(userId)]);
    return { tools: [...upstream.tools, ...kb.tools], errors: { ...upstream.errors, ...kb.errors } };
  }

  callTool(userId: string, route: RoutedTool["_route"], args: Record<string, unknown>) {
    return route.provider === "kb"
      ? this.kb.callTool(userId, route, args)
      : this.upstream.callTool(userId, route, args);
  }

  async status(userId: string) {
    const [upstream, kb] = await Promise.all([this.upstream.status(userId), this.kb.status(userId)]);
    const status = upstream as { tools: number; providers: Record<string, unknown> };
    return { tools: status.tools + kb.tools, providers: { ...status.providers, kb } };
  }

  async close() {
    await Promise.all([this.upstream.close(), this.kb.close()]);
  }
}

function createProtocolServer(userId: string, pool: ToolPool) {
  const server = new Server(
    { name: "s8-mcp-hub", version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions: "Unified Gmail, Google Calendar, and s8 knowledge-base tools."
    }
  );
  let routes = new Map<string, RoutedTool["_route"]>();

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const listed = await pool.listTools(userId);
    routes = new Map(listed.tools.map((tool) => [tool.name, tool._route]));
    return { tools: listed.tools.map(publicTool) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    let route = routes.get(request.params.name);
    if (!route) {
      const listed = await pool.listTools(userId);
      routes = new Map(listed.tools.map((tool) => [tool.name, tool._route]));
      route = routes.get(request.params.name);
    }
    if (!route) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Unknown or disabled tool: ${request.params.name}` }]
      };
    }
    return (await pool.callTool(
      userId,
      route,
      (request.params.arguments ?? {}) as Record<string, unknown>
    )) as never;
  });
  return server;
}

export function createHub(config: HubConfig = loadHubConfig(), toolPool?: ToolPool) {
  const sessions = new Map<string, Session>();
  const pool = toolPool ?? new CombinedToolPool(config);

  const httpServer = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
      const origin = req.headers.origin;
      if (origin) {
        let allowedOrigin = false;
        try {
          const parsedOrigin = new URL(origin);
          allowedOrigin = parsedOrigin.hostname === "localhost" || parsedOrigin.hostname === "127.0.0.1";
        } catch {
          allowedOrigin = false;
        }
        if (!allowedOrigin) return json(res, 403, { error: "invalid_origin" });
        res.setHeader("access-control-allow-origin", origin);
        res.setHeader("vary", "Origin");
      }
      res.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
      res.setHeader(
        "access-control-allow-headers",
        "Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID"
      );
      res.setHeader("access-control-expose-headers", "Mcp-Session-Id");
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        return res.end();
      }

      if (req.method === "GET" && url.pathname === "/health") {
        return json(res, 200, {
          status: "ok",
          service: "s8-mcp-hub",
          transport: "streamable-http",
          users: [...config.users.values()].map(({ id, displayName }) => ({ id, displayName }))
        });
      }

      const statusMatch = /^\/status(?:\/([^/]+))?\/?$/.exec(url.pathname);
      if (req.method === "GET" && statusMatch) {
        const userId = statusMatch[1] ? decodeURIComponent(statusMatch[1]) : config.defaultUserId;
        if (!config.users.has(userId)) return json(res, 404, { error: "unknown_user" });
        return json(res, 200, { userId, ...(await pool.status(userId) as object) });
      }

      const userId = userFromPath(url, config.defaultUserId);
      if (!userId) return json(res, 404, { error: "not_found" });
      if (!config.users.has(userId)) return json(res, 404, { error: "unknown_user" });

      const sessionId = req.headers["mcp-session-id"];
      if (typeof sessionId === "string") {
        const session = sessions.get(sessionId);
        if (!session) return json(res, 404, { error: "unknown_mcp_session" });
        if (session.userId !== userId) return json(res, 403, { error: "session_user_mismatch" });
        const parsedBody = req.method === "POST" ? await readJson(req) : undefined;
        return await session.transport.handleRequest(req, res, parsedBody);
      }

      if (req.method !== "POST") return json(res, 400, { error: "mcp_session_id_required" });
      const body = await readJson(req);
      if (!isInitializeRequest(body)) return json(res, 400, { error: "initialize_request_required" });

      const protocolServer = createProtocolServer(userId, pool);
      let session: Session;
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        enableJsonResponse: true,
        allowedHosts: ["127.0.0.1", "localhost", `127.0.0.1:${config.port}`, `localhost:${config.port}`],
        enableDnsRebindingProtection: config.port !== 0,
        onsessioninitialized(id) {
          sessions.set(id, session);
        },
        onsessionclosed(id) {
          sessions.delete(id);
        }
      });
      session = { userId, server: protocolServer, transport };
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      await protocolServer.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      if (!res.headersSent) json(res, 500, { error: error instanceof Error ? error.message : String(error) });
      else res.end();
    }
  });

  return {
    config,
    server: httpServer,
    async close() {
      await Promise.allSettled([...sessions.values()].map((session) => session.server.close()));
      sessions.clear();
      await pool.close();
      if (httpServer.listening) {
        await new Promise<void>((resolve, reject) =>
          httpServer.close((error) => (error ? reject(error) : resolve()))
        );
      }
    }
  };
}

async function main() {
  const hub = createHub();
  hub.server.listen(hub.config.port, hub.config.host, () => {
    process.stdout.write(`s8-mcp-hub listening on http://${hub.config.host}:${hub.config.port}/mcp\n`);
  });

  const shutdown = async () => {
    await hub.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

const entrypoint = process.argv[1]
  ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
  : false;
if (entrypoint) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
