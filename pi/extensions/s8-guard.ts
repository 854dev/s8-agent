import path from "node:path";
import { realpathSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const protectedSegments = [".git", ".pi", ".pi-runtime", ".s8-runtime", "SECRET", "secret"];
const pathTools = new Set(["read", "write", "edit", "grep", "find", "ls"]);

function protectedPath(value: unknown, cwd: string): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  const absolute = path.resolve(cwd, value.replace(/^@/, ""));
  const devRoot = path.resolve(cwd, "..");
  const paths = [absolute];
  try { paths.push(realpathSync(absolute)); } catch { /* Nonexistent paths are checked by their resolved names. */ }
  return paths.some(candidate => {
    const relative = path.relative(devRoot, candidate);
    return relative.startsWith('..') || path.isAbsolute(relative) ||
      relative.split(path.sep).some(segment => protectedSegments.includes(segment) || segment === '.env' || segment.startsWith('.env.'));
  });
}

function protectedShellCommand(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return /(^|[\s/'"=])\.(?:pi|pi-runtime)(?:[\s/'";]|$)|PI_CODING_AGENT_DIR|S8_RUNTIME_ROOT/.test(value);
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    const blocked = pathTools.has(event.toolName)
      ? protectedPath('path' in event.input ? event.input.path : undefined, ctx.cwd)
      : event.toolName === "bash" && protectedShellCommand(event.input.command);

    if (!blocked) return undefined;

    const reason = `보호 경로 접근을 차단했습니다: ${event.toolName}`;
    if (ctx.hasUI) ctx.ui.notify(reason, "warning");
    return { block: true, reason };
  });
}
