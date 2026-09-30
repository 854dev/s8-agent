import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { HubConfig, ProviderId, ProviderRuntimeConfig, ToolProviderId } from "./config.js";

type UpstreamConnection = {
  client: Client;
  tools: Tool[];
};

export type RoutedTool = Tool & {
  name: string;
  _route: { provider: ToolProviderId; upstreamName: string };
};

export interface ToolPool {
  listTools(userId: string): Promise<{ tools: RoutedTool[]; errors: Record<string, string> }>;
  callTool(userId: string, route: RoutedTool["_route"], args: Record<string, unknown>): Promise<unknown>;
  status(userId: string): Promise<unknown>;
  close(): Promise<void>;
}

const require = createRequire(import.meta.url);

function packageEntry(provider: ProviderId) {
  return provider === "gmail"
    ? require.resolve("@gongrzhe/server-gmail-autoauth-mcp")
    : require.resolve("@cocal/google-calendar-mcp");
}

function exposedName(provider: ProviderId, upstreamName: string) {
  const prefix = provider === "gmail" ? "gmail" : "gcal";
  return `${prefix}_${upstreamName.replace(/-/g, "_")}`;
}

function upstreamEnvironment(provider: ProviderId, config: ProviderRuntimeConfig): Record<string, string> {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
  if (provider === "gmail") {
    return {
      ...inherited,
      GMAIL_OAUTH_PATH: config.oauthPath,
      GMAIL_CREDENTIALS_PATH: config.tokenPath
    };
  }
  return {
    ...inherited,
    GOOGLE_OAUTH_CREDENTIALS: config.oauthPath,
    GOOGLE_CALENDAR_MCP_TOKEN_PATH: config.tokenPath,
    GOOGLE_ACCOUNT_MODE: config.accountId,
    ...(config.enabledTools?.length ? { ENABLED_TOOLS: config.enabledTools.join(",") } : {})
  };
}

export class UpstreamPool implements ToolPool {
  private readonly connections = new Map<string, Promise<UpstreamConnection>>();

  constructor(private readonly config: HubConfig) {}

  private key(userId: string, provider: ProviderId) {
    return `${userId}:${provider}`;
  }

  private async connect(userId: string, provider: ProviderId): Promise<UpstreamConnection> {
    const runtime = this.config.providerFor(userId, provider);
    if (!runtime.enabled) throw new Error(`${provider} provider is disabled`);
    mkdirSync(path.dirname(runtime.tokenPath), { recursive: true });

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [packageEntry(provider)],
      env: upstreamEnvironment(provider, runtime),
      cwd: path.dirname(runtime.oauthPath),
      stderr: "pipe"
    });
    const client = new Client(
      { name: `s8-hub-${provider}`, version: "0.1.0" },
      { capabilities: {} }
    );
    let stderr = "";
    transport.stderr?.on("data", (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-4000);
    });

    try {
      await client.connect(transport);
      const listed = await client.listTools();
      const allowed = runtime.enabledTools ? new Set(runtime.enabledTools) : null;
      return {
        client,
        tools: listed.tools.filter((tool) => !allowed || allowed.has(tool.name))
      };
    } catch (error) {
      await transport.close().catch(() => undefined);
      const detail = stderr.trim() ? `: ${stderr.trim()}` : "";
      const cause = error instanceof Error ? ` (${error.message})` : ` (${String(error)})`;
      throw new Error(`${provider} failed to start${cause}${detail}`, { cause: error });
    }
  }

  private get(userId: string, provider: ProviderId) {
    const key = this.key(userId, provider);
    let connection = this.connections.get(key);
    if (!connection) {
      connection = this.connect(userId, provider).catch((error) => {
        this.connections.delete(key);
        throw error;
      });
      this.connections.set(key, connection);
    }
    return connection;
  }

  async listTools(userId: string): Promise<{ tools: RoutedTool[]; errors: Record<string, string> }> {
    const providers: ProviderId[] = ["gmail", "google-calendar"];
    const settled = await Promise.allSettled(providers.map((provider) => this.get(userId, provider)));
    const tools: RoutedTool[] = [];
    const errors: Record<string, string> = {};

    settled.forEach((result, index) => {
      const provider = providers[index]!;
      if (result.status === "rejected") {
        errors[provider] = result.reason instanceof Error ? result.reason.message : String(result.reason);
        return;
      }
      for (const tool of result.value.tools) {
        tools.push({
          ...tool,
          name: exposedName(provider, tool.name),
          description: `[${provider}] ${tool.description ?? tool.name}`,
          _route: { provider, upstreamName: tool.name }
        });
      }
    });
    return { tools, errors };
  }

  async callTool(userId: string, route: RoutedTool["_route"], args: Record<string, unknown>) {
    if (route.provider === "kb") throw new Error("KB routes are handled by the KB pool");
    const connection = await this.get(userId, route.provider);
    return connection.client.callTool({ name: route.upstreamName, arguments: args });
  }

  async status(userId: string) {
    const { tools, errors } = await this.listTools(userId);
    return {
      tools: tools.length,
      providers: {
        gmail: errors.gmail ? { ok: false, error: errors.gmail } : { ok: true },
        googleCalendar: errors["google-calendar"]
          ? { ok: false, error: errors["google-calendar"] }
          : { ok: true }
      }
    };
  }

  async close() {
    const settled = await Promise.allSettled(this.connections.values());
    await Promise.allSettled(
      settled
        .filter((item): item is PromiseFulfilledResult<UpstreamConnection> => item.status === "fulfilled")
        .map((item) => item.value.client.close())
    );
    this.connections.clear();
  }
}
