import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { loadHubConfig, REPO_ROOT } from "../src/config.js";

test("creates a local user and KB path without a user config file", () => {
  const previous = process.env.MCP_HUB_USER;
  const previousKbRoot = process.env.S8_KB_ROOT;
  delete process.env.MCP_HUB_USER;
  delete process.env.S8_KB_ROOT;
  try {
    const config = loadHubConfig();
    assert.equal(config.defaultUserId, "local");
    assert.equal(config.users.get("local")?.kbPath, path.resolve(REPO_ROOT, "../854_md"));
  } finally {
    if (previous === undefined) delete process.env.MCP_HUB_USER;
    else process.env.MCP_HUB_USER = previous;
    if (previousKbRoot === undefined) delete process.env.S8_KB_ROOT;
    else process.env.S8_KB_ROOT = previousKbRoot;
  }
});
