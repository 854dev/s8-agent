import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { HubConfig } from "../src/config.js";
import { KbTaskPool } from "../src/kb.js";

function config(root: string): HubConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    defaultUserId: "ys",
    users: new Map([["ys", { id: "ys", displayName: "YS", kbPath: root }]]),
    providerFor() {
      throw new Error("not used by KB provider");
    }
  };
}

test("KB task tools query indexed tasks and return mtime for writes", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "multiplez-kb-task-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "프로젝트", "작업.md");
  const other = path.join(root, "프로젝트", "참고.md");
  mkdirSync(path.dirname(file), { recursive: true });
  const content = [
    "---",
    "title: 테스트 작업",
    "type: 할일",
    "project: demo",
    "status: 진행중",
    "목표일: 2099-01-01",
    "---",
    "- [ ] 하나",
    ""
  ].join("\n");
  writeFileSync(file, content, "utf8");
  writeFileSync(other, "---\ntype: 문서\n---\n", "utf8");

  const pool = new KbTaskPool(config(root));
  const listed = await pool.listTools("ys");
  assert.equal(listed.tools.length, 3);
  const queried = (await pool.callTool("ys", listed.tools[0]!._route, { range: "all" })) as {
    structuredContent: { total: number; items: Array<{ path: string; mtime: string }> };
  };
  assert.equal(queried.structuredContent.total, 1);
  assert.equal(queried.structuredContent.items[0]?.path, "프로젝트/작업.md");
  assert.match(queried.structuredContent.items[0]?.mtime ?? "", /T/);
});

test("KB task status write rejects a stale expectedMtime", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "multiplez-kb-task-conflict-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "작업.md");
  writeFileSync(file, "---\ntype: 할일\nstatus: 할일\n역할: 과제\n---\n", "utf8");
  const pool = new KbTaskPool(config(root));
  const tools = await pool.listTools("ys");
  const get = (await pool.callTool("ys", tools.tools[1]!._route, { path: "작업.md" })) as {
    structuredContent: { mtime: string };
  };
  utimesSync(file, new Date(Date.now() + 2000), new Date(Date.now() + 2000));
  const result = (await pool.callTool("ys", tools.tools[2]!._route, {
    path: "작업.md",
    toStatus: "완료",
    expectedMtime: get.structuredContent.mtime
  })) as { isError?: boolean };
  assert.equal(result.isError, true);
});
