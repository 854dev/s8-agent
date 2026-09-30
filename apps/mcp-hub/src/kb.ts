import { promises as fs } from "node:fs";
import path from "node:path";
import type { HubConfig } from "./config.js";
import type { RoutedTool, ToolPool } from "./upstreams.js";

const KB_PROVIDER = "kb" as const;
const MAX_FILES = 10_000;
const CACHE_TTL_MS = 5_000;
const TASK_STATUSES = new Set(["백로그", "할일", "진행중", "완료"]);
const DONE_STATUSES = new Set(["완료", "종료", "제출완료"]);
const BLOCKED_DIRS = new Set([".git", ".obsidian", ".hermes-runtime", "node_modules", "_meta", "__pycache__"]);

type Task = {
  path: string;
  title: string;
  project?: string;
  status?: string;
  statusGroup: "백로그" | "할일" | "진행중" | "완료" | "기타";
  assignee?: string;
  priority?: string;
  targetDate?: string;
  openChecks: number;
  mtime: string;
  mtimeMs: number;
};

type Index = { tasks: Task[]; warnings: { projectMissing: number; unknownStatus: number; invalidDate: number } };

const tool = (name: string, description: string, properties: Record<string, object>, required: string[] = []): RoutedTool => ({
  name,
  description,
  inputSchema: { type: "object", properties, required, additionalProperties: false },
  _route: { provider: KB_PROVIDER, upstreamName: name }
});

export const KB_TOOLS: RoutedTool[] = [
  tool(
    "kb_tasks_query",
    "사용자 KB의 할일을 날짜, 프로젝트, 상태로 빠르게 조회합니다.",
    {
      range: { type: "string", enum: ["today", "this_week", "overdue", "all"] },
      timezone: { type: "string", description: "IANA 시간대. 예: Asia/Seoul" },
      project: { type: "string" },
      statuses: { type: "array", items: { type: "string" } },
      limit: { type: "integer", minimum: 1, maximum: 100 }
    }
  ),
  tool(
    "kb_task_get",
    "할일 한 건의 메타데이터와 현재 파일 수정 시각을 조회합니다.",
    { path: { type: "string", description: "KB 루트 기준 상대 경로" } },
    ["path"]
  ),
  tool(
    "kb_task_set_status",
    "expectedMtime이 현재 파일과 같을 때만 할일 상태를 변경합니다.",
    {
      path: { type: "string", description: "KB 루트 기준 상대 경로" },
      toStatus: { type: "string", enum: ["백로그", "할일", "진행중", "완료"] },
      expectedMtime: { type: "string", description: "직전 조회 응답의 mtime" }
    },
    ["path", "toStatus", "expectedMtime"]
  )
];

function textValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseFrontmatter(text: string) {
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|$)/.exec(text);
  const values: Record<string, string> = {};
  if (!match) return { values, body: text };
  for (const line of match[1]!.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator < 1 || /^\s/.test(line)) continue;
    const key = line.slice(0, separator).trim();
    const raw = line.slice(separator + 1).replace(/\s+#.*$/, "").trim();
    if (key && raw) values[key] = raw.replace(/^['"]|['"]$/g, "");
  }
  return { values, body: text.slice(match[0].length) };
}

function isTask(values: Record<string, string>) {
  return values.type === "할일" || values.역할 === "과제";
}

function statusGroup(status: string | undefined): Task["statusGroup"] {
  if (!status) return "기타";
  if (["백로그", "초안", "아이디어"].includes(status)) return "백로그";
  if (["할일", "예정", "대기"].includes(status)) return "할일";
  if (["진행중", "활성", "검토중", "확인필요", "영업중"].includes(status)) return "진행중";
  if (DONE_STATUSES.has(status)) return "완료";
  return "기타";
}

function targetDate(values: Record<string, string>) {
  const value = values.목표일 ?? values.마감일;
  if (!value) return undefined;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  if (!match) return undefined;
  const date = new Date(`${match[1]}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== match[1] ? undefined : match[1];
}

function relativePath(root: string, file: string) {
  return path.relative(root, file).split(path.sep).join("/");
}

function safeFile(root: string, relative: string) {
  const candidate = path.resolve(root, relative);
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (candidate !== root && !candidate.startsWith(prefix)) throw new Error("path is outside the KB");
  if (!/\.(md|markdown)$/i.test(candidate)) throw new Error("path must be a Markdown file");
  return candidate;
}

async function assertInsideRoot(root: string, candidate: string) {
  const [realRoot, realCandidate] = await Promise.all([fs.realpath(root), fs.realpath(candidate)]);
  const relative = path.relative(realRoot, realCandidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("path is outside the KB");
}

async function markdownFiles(root: string) {
  const result: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    if (result.length >= MAX_FILES) return;
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (result.length >= MAX_FILES || entry.name.startsWith(".")) continue;
      if (entry.isDirectory()) {
        if (!BLOCKED_DIRS.has(entry.name)) await visit(path.join(directory, entry.name));
      } else if (entry.isFile() && /\.(md|markdown)$/i.test(entry.name)) {
        result.push(path.join(directory, entry.name));
      }
    }
  };
  await visit(root);
  return result;
}

function localDate(timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function rangeDates(range: string, timezone: string) {
  const today = localDate(timezone);
  const start = new Date(`${today}T00:00:00Z`);
  const day = start.getUTCDay() || 7;
  if (range === "today") return { from: today, to: today };
  if (range === "overdue") return { from: "0000-01-01", to: new Date(start.getTime() - 86_400_000).toISOString().slice(0, 10) };
  if (range === "this_week") {
    const monday = new Date(start.getTime() - (day - 1) * 86_400_000);
    return { from: monday.toISOString().slice(0, 10), to: new Date(monday.getTime() + 6 * 86_400_000).toISOString().slice(0, 10) };
  }
  return { from: "0000-01-01", to: "9999-12-31" };
}

function errorResult(message: string, code = "tool_error") {
  return { isError: true, content: [{ type: "text" as const, text: message }], structuredContent: { error: code, message } };
}

function jsonResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value };
}

export class KbTaskPool implements ToolPool {
  private readonly cache = new Map<string, { at: number; index: Index }>();

  constructor(private readonly config: HubConfig) {}

  async listTools(userId: string): Promise<{ tools: RoutedTool[]; errors: Record<string, string> }> {
    const enabled = Boolean(this.config.users.get(userId)?.kbPath);
    return {
      tools: enabled ? KB_TOOLS : [],
      errors: enabled ? {} : { kb: "KB path is not configured" }
    };
  }

  private async indexFor(userId: string) {
    const user = this.config.users.get(userId);
    if (!user?.kbPath) throw new Error("KB path is not configured");
    const cached = this.cache.get(userId);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.index;
    const index: Index = { tasks: [], warnings: { projectMissing: 0, unknownStatus: 0, invalidDate: 0 } };
    for (const file of await markdownFiles(user.kbPath)) {
      const [raw, info] = await Promise.all([fs.readFile(file, "utf8"), fs.stat(file)]);
      const { values, body } = parseFrontmatter(raw);
      if (!isTask(values)) continue;
      const project = textValue(values.project);
      const status = textValue(values.status);
      const date = targetDate(values);
      if (!project) index.warnings.projectMissing += 1;
      if (status && !TASK_STATUSES.has(status) && !DONE_STATUSES.has(status)) index.warnings.unknownStatus += 1;
      if ((values.목표일 || values.마감일) && !date) index.warnings.invalidDate += 1;
      index.tasks.push({
        path: relativePath(user.kbPath, file),
        title: textValue(values.title) ?? path.basename(file).replace(/\.(md|markdown)$/i, ""),
        project,
        status,
        statusGroup: statusGroup(status),
        assignee: textValue(values.담당),
        priority: textValue(values.우선순위),
        targetDate: date,
        openChecks: (body.match(/^[ \t]*[-*+] \[ \]/gm) ?? []).length,
        mtime: info.mtime.toISOString(),
        mtimeMs: info.mtimeMs
      });
    }
    this.cache.set(userId, { at: Date.now(), index });
    return index;
  }

  async callTool(userId: string, route: RoutedTool["_route"], args: Record<string, unknown>) {
    try {
      const user = this.config.users.get(userId);
      if (!user?.kbPath || route.provider !== KB_PROVIDER) return errorResult("KB tool is unavailable");
      if (route.upstreamName === "kb_tasks_query") {
        const range = textValue(args.range) ?? "all";
        const timezone = textValue(args.timezone) ?? "Asia/Seoul";
        const dates = rangeDates(range, timezone);
        const index = await this.indexFor(userId);
        const statuses = Array.isArray(args.statuses) ? new Set(args.statuses.filter((v): v is string => typeof v === "string")) : null;
        const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 100);
        const filtered = index.tasks
          .filter((task) => !statuses || statuses.has(task.status ?? ""))
          .filter((task) => !textValue(args.project) || task.project === textValue(args.project))
          .filter((task) => range === "all" || (task.targetDate && task.targetDate >= dates.from && task.targetDate <= dates.to))
          .sort((a, b) => (a.targetDate ?? "9999").localeCompare(b.targetDate ?? "9999"));
        const items = filtered
          .slice(0, limit)
          .map(({ mtimeMs: _mtimeMs, ...task }) => task);
        return jsonResult({ query: { range, timezone }, generatedAt: new Date().toISOString(), total: filtered.length, truncated: Math.max(0, filtered.length - items.length), items, warnings: index.warnings });
      }

      const relative = textValue(args.path);
      if (!relative) return errorResult("path is required");
      const file = safeFile(user.kbPath, relative);
      await assertInsideRoot(user.kbPath, file);
      const raw = await fs.readFile(file, "utf8");
      const info = await fs.stat(file);
      const parsed = parseFrontmatter(raw);
      if (!isTask(parsed.values)) return errorResult("file is not a task");
      if (route.upstreamName === "kb_task_get") {
        return jsonResult({
          path: relativePath(user.kbPath, file),
          title: textValue(parsed.values.title) ?? path.basename(file).replace(/\.(md|markdown)$/i, ""),
          project: textValue(parsed.values.project),
          status: textValue(parsed.values.status),
          statusGroup: statusGroup(textValue(parsed.values.status)),
          assignee: textValue(parsed.values.담당),
          priority: textValue(parsed.values.우선순위),
          targetDate: targetDate(parsed.values),
          openChecks: (parsed.body.match(/^[ \t]*[-*+] \[ \]/gm) ?? []).length,
          mtime: info.mtime.toISOString()
        });
      }

      const expectedMtime = textValue(args.expectedMtime);
      const toStatus = textValue(args.toStatus);
      if (!expectedMtime || !toStatus || !TASK_STATUSES.has(toStatus)) return errorResult("toStatus와 expectedMtime이 필요합니다");
      const expectedMs = Date.parse(expectedMtime);
      if (!Number.isFinite(expectedMs) || Math.abs(info.mtimeMs - expectedMs) > 1) {
        return errorResult("conflict: file changed after it was read", "conflict");
      }
      const changed = updateFrontmatter(raw, "status", toStatus);
      const role = toStatus === "완료" ? "기록" : "과제";
      const withRole = updateFrontmatter(changed, "역할", role);
      await fs.writeFile(file, withRole, "utf8");
      this.cache.delete(userId);
      const next = await fs.stat(file);
      return jsonResult({ path: relativePath(user.kbPath, file), status: toStatus, role, mtime: next.mtime.toISOString() });
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  }

  async status(userId: string) {
    const user = this.config.users.get(userId);
    return { ok: Boolean(user?.kbPath), cached: this.cache.has(userId), tools: user?.kbPath ? KB_TOOLS.length : 0 };
  }

  async close() {}
}

function updateFrontmatter(text: string, key: string, value: string) {
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---(?=\s*\r?\n|$)/.exec(text);
  if (!match) throw new Error("task requires a frontmatter block");
  const lines = match[1]!.split(/\r?\n/);
  const index = lines.findIndex((line) => new RegExp(`^${key}:`).test(line));
  if (index >= 0) lines[index] = `${key}: ${value}`;
  else lines.push(`${key}: ${value}`);
  return `${text.slice(0, match.index)}---\n${lines.join("\n")}---${text.slice(match.index + match[0].length)}`;
}
