import path from "node:path";
import { lstatSync, realpathSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const protectedSegments = [".git", ".pi", ".pi-runtime", ".s8-runtime", "SECRET", "secret"];
const pathTools = new Set(["read", "write", "edit", "grep", "find", "ls"]);

function protectedPath(value: unknown, cwd: string): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  const absolute = path.resolve(cwd, value.replace(/^@/, ""));
  const devRoot = path.resolve(cwd, "..");
  const realDevRoot = realpathSync(devRoot);
  if (path.basename(absolute) === '.env.example') {
    try {
      const stat = lstatSync(absolute);
      if (!stat.isFile() || stat.nlink !== 1) return true; // No symlink or hardlink to a secret file.
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return true;
    }
  }
  const paths = [absolute];
  try { paths.push(realpathSync(absolute)); }
  catch {
    // For a new file, resolve its existing parent to catch links into protected directories.
    try { paths.push(path.join(realpathSync(path.dirname(absolute)), path.basename(absolute))); }
    catch { return true; }
  }
  return paths.some((candidate, index) => {
    const relative = path.relative(index === 0 ? devRoot : realDevRoot, candidate);
    return relative.startsWith('..') || path.isAbsolute(relative) ||
      relative.split(path.sep).some(segment => protectedSegments.includes(segment) || segment === '.env' ||
        (segment.startsWith('.env.') && !(segment === '.env.example' && path.basename(candidate) === segment)));
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
