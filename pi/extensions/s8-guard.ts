import path from "node:path";
import { lstatSync, realpathSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const pathTools = new Set(["read", "write", "edit", "grep", "find", "ls"]);

function sensitive(value: string): boolean {
  return value.split(path.sep).some(segment => /secret/i.test(segment) ||
    (segment.startsWith('.env') && !(segment === '.env.example' && path.basename(value) === segment)));
}

function protectedPath(value: unknown, cwd: string): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  const absolute = path.resolve(cwd, value.replace(/^@/, ""));
  if (path.basename(absolute) === '.env.example') {
    try {
      const stat = lstatSync(absolute);
      if (!stat.isFile() || stat.nlink !== 1) return true; // No symlink or hardlink to a secret file.
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return true;
    }
  }
  if (sensitive(absolute)) return true;
  let ancestor = absolute;
  while (true) {
    try { return sensitive(path.join(realpathSync(ancestor), path.relative(ancestor, absolute))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return true;
      try { if (lstatSync(ancestor).isSymbolicLink()) return true; }
      catch { /* Parent does not exist yet. */ }
      ancestor = path.dirname(ancestor);
    }
  }
}

function protectedShellCommand(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return /(^|[\s/'"=])(?:\.env(?!\.example(?:[\s/'";]|$))[^\s/'";]*|[^\s/'";]*secret[^\s/'";]*)(?=[\s/'";]|$)/i.test(value);
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
