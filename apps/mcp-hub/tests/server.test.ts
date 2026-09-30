import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { HubConfig } from "../src/config.js";
import { createHub } from "../src/server.js";
import type { RoutedTool, ToolPool } from "../src/upstreams.js";

const echoTool: RoutedTool = {
  name: "gmail_echo",
  description: "test tool",
  inputSchema: { type: "object", properties: { value: { type: "string" } } },
  _route: { provider: "gmail", upstreamName: "echo" }
};

class MockPool implements ToolPool {
  calls: Array<{ userId: string; args: Record<string, unknown> }> = [];

  async listTools() {
    return { tools: [echoTool], errors: {} };
  }

  async callTool(userId: string, _route: RoutedTool["_route"], args: Record<string, unknown>) {
    this.calls.push({ userId, args });
    return { content: [{ type: "text", text: `${userId}:${String(args.value)}` }] };
  }

  async status() {
    return { tools: 1, providers: { gmail: { ok: true }, googleCalendar: { ok: true } } };
  }

  async close() {}
}

function testConfig(): HubConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    defaultUserId: "ys",
    users: new Map([
      ["ys", { id: "ys", displayName: "YS" }],
      ["jet", { id: "jet", displayName: "Jet" }]
    ]),
    providerFor() {
      throw new Error("mock pool does not use provider config");
    }
  };
}

test("serves namespaced tools without requiring a user URL", async (t) => {
  const pool = new MockPool();
  const hub = createHub(testConfig(), pool);
  hub.server.listen(0, "127.0.0.1");
  await once(hub.server, "listening");
  t.after(() => hub.close());

  const address = hub.server.address();
  assert(address && typeof address === "object");
  const client = new Client({ name: "hub-test", version: "1.0.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`));
  await client.connect(transport);
  t.after(() => client.close());

  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name), ["gmail_echo"]);

  const result = await client.callTool({ name: "gmail_echo", arguments: { value: "hello" } });
  const content = result.content as Array<{ type: string; text?: string }>;
  assert.equal(content[0]?.type, "text");
  assert.equal(content[0]?.text, "ys:hello");
  assert.deepEqual(pool.calls, [{ userId: "ys", args: { value: "hello" } }]);

  assert(transport.sessionId);
  const crossUser = await fetch(`http://127.0.0.1:${address.port}/mcp/jet`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mcp-session-id": transport.sessionId
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "ping" })
  });
  assert.equal(crossUser.status, 403);
});

test("rejects unknown users before opening an MCP session", async (t) => {
  const hub = createHub(testConfig(), new MockPool());
  hub.server.listen(0, "127.0.0.1");
  await once(hub.server, "listening");
  t.after(() => hub.close());

  const address = hub.server.address();
  assert(address && typeof address === "object");
  const response = await fetch(`http://127.0.0.1:${address.port}/mcp/unknown`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } }
    })
  });
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "unknown_user" });
});
