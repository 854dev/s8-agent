import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { loadHubConfig, type ProviderId } from "./config.js";

const provider = process.argv[2] as ProviderId | undefined;

if (!provider || !["gmail", "google-calendar"].includes(provider)) {
  process.stderr.write("Usage: npm run auth -- <gmail|google-calendar>\n");
  process.exit(2);
}

const config = loadHubConfig();
const userId = config.defaultUserId;

const runtime = config.providerFor(userId, provider);
mkdirSync(path.dirname(runtime.tokenPath), { recursive: true });
const require = createRequire(import.meta.url);
const entry = provider === "gmail"
  ? require.resolve("@gongrzhe/server-gmail-autoauth-mcp")
  : require.resolve("@cocal/google-calendar-mcp");
const args = provider === "gmail" ? [entry, "auth"] : [entry, "auth", runtime.accountId];
const childEnv = {
  ...process.env,
  ...(provider === "gmail"
    ? { GMAIL_OAUTH_PATH: runtime.oauthPath, GMAIL_CREDENTIALS_PATH: runtime.tokenPath }
    : {
        GOOGLE_OAUTH_CREDENTIALS: runtime.oauthPath,
        GOOGLE_CALENDAR_MCP_TOKEN_PATH: runtime.tokenPath,
        GOOGLE_ACCOUNT_MODE: runtime.accountId
      })
};

const child = spawn(process.execPath, args, {
  env: childEnv,
  stdio: "inherit",
  cwd: path.dirname(runtime.oauthPath)
});
child.once("exit", (code) => process.exit(code ?? 1));
child.once("error", (error) => {
  console.error(error);
  process.exit(1);
});
