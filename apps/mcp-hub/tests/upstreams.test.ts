import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { HubConfig } from "../src/config.js";
import { UpstreamPool } from "../src/upstreams.js";

test("loads Gmail and Calendar tools from the pinned upstream packages", async (t) => {
  const tokenDir = mkdtempSync(path.join(tmpdir(), "multiplez-mcp-hub-"));
  t.after(() => rmSync(tokenDir, { recursive: true, force: true }));
  const oauthPath = path.resolve("tests/fixtures/oauth.keys.json");
  const config: HubConfig = {
    host: "127.0.0.1",
    port: 0,
    defaultUserId: "ys",
    users: new Map([["ys", { id: "ys", displayName: "YS" }]]),
    providerFor(userId, provider) {
      return {
        enabled: true,
        oauthPath,
        tokenPath: path.join(tokenDir, `${provider}-${userId}.json`),
        accountId: userId
      };
    }
  };
  const pool = new UpstreamPool(config);
  t.after(() => pool.close());

  const listed = await pool.listTools("ys");
  assert.deepEqual(listed.errors, {});
  assert(listed.tools.some((tool) => tool.name === "gmail_search_emails"));
  assert(listed.tools.some((tool) => tool.name === "gcal_list_events"));
});
