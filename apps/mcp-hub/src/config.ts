import path from "node:path";
import { fileURLToPath } from "node:url";

export type ProviderId = "gmail" | "google-calendar";
export type ToolProviderId = ProviderId | "kb";

export type HubUser = {
  id: string;
  displayName: string;
  kbPath?: string;
};

export type ProviderRuntimeConfig = {
  enabled: boolean;
  oauthPath: string;
  tokenPath: string;
  accountId: string;
  enabledTools?: string[];
};

export type HubConfig = {
  host: string;
  port: number;
  defaultUserId: string;
  users: Map<string, HubUser>;
  providerFor(userId: string, provider: ProviderId): ProviderRuntimeConfig;
};

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(MODULE_DIR, "..", "..", "..");
const USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function env(name: string, fallback = "") {
  const value = process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function resolveLocalPath(value: string) {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(REPO_ROOT, value);
}

function envList(name: string) {
  const value = env(name);
  return value ? value.split(",").map((item) => item.trim()).filter(Boolean) : undefined;
}

export function loadHubConfig(): HubConfig {
  const defaultUserId = env("MCP_HUB_USER", "local");
  if (!USER_ID_PATTERN.test(defaultUserId)) throw new Error(`Invalid MCP_HUB_USER: ${defaultUserId}`);

  const host = env("MCP_HUB_HOST", "127.0.0.1");
  if (!new Set(["127.0.0.1", "localhost", "::1"]).has(host)) {
    throw new Error("MCP hub has no authentication yet; MCP_HUB_HOST must be a loopback address");
  }

  const port = Number(env("MCP_HUB_PORT", "8790"));
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid MCP_HUB_PORT: ${port}`);

  const kbPath = resolveLocalPath(env("S8_KB_ROOT", "../854_md"));
  const users = new Map([[defaultUserId, { id: defaultUserId, displayName: defaultUserId, kbPath }]]);

  return {
    host,
    port,
    defaultUserId,
    users,
    providerFor(userId, provider) {
      if (!users.has(userId)) throw new Error(`Unknown MCP user: ${userId}`);
      if (provider === "gmail") {
        return {
          enabled: env("MCP_GMAIL_ENABLED", "1") !== "0",
          oauthPath: resolveLocalPath(env(
            "MCP_GMAIL_OAUTH_PATH",
            ".s8-runtime/mcp-hub/gmail/gcp-oauth.keys.json"
          )),
          tokenPath: path.join(
            resolveLocalPath(env("MCP_GMAIL_TOKEN_DIR", ".s8-runtime/mcp-hub/gmail/tokens")),
            `${userId}.json`
          ),
          accountId: userId,
          enabledTools: envList("MCP_GMAIL_ENABLED_TOOLS")
        };
      }

      return {
        enabled: env("MCP_GOOGLE_CALENDAR_ENABLED", "1") !== "0",
        oauthPath: resolveLocalPath(env(
          "MCP_GOOGLE_CALENDAR_OAUTH_PATH",
          ".s8-runtime/mcp-hub/google-calendar/gcp-oauth.keys.json"
        )),
        tokenPath: path.join(
          resolveLocalPath(env(
            "MCP_GOOGLE_CALENDAR_TOKEN_DIR",
            ".s8-runtime/mcp-hub/google-calendar/tokens"
          )),
          `${userId}.json`
        ),
        accountId: userId,
        enabledTools: envList("MCP_GOOGLE_CALENDAR_ENABLED_TOOLS")
      };
    }
  };
}
