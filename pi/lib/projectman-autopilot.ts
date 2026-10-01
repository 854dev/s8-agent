import { spawn } from 'node:child_process';
import type { ProjectmanContent } from './projectman-client.ts';

const approvalTags = new Set(['need:approval', 'need:review', 'risk:sensitive']);

export function needsConfirmation(item: ProjectmanContent): boolean {
  return Boolean(item.detail?.attributes.requiresApproval === true || item.tags?.some(tag => approvalTags.has(tag)));
}

export function eligibleForReadOnly(item: ProjectmanContent): boolean {
  const attrs = item.detail?.attributes;
  return item.type === 'task' && item.status === 'published' && attrs?.state === 'ready' &&
    attrs.autorun === true && attrs.autorunMode === 'safe' && attrs.risk === 'low' &&
    attrs.requiresApproval === false && Array.isArray(attrs.allowedActions) &&
    attrs.allowedActions.length === 1 && attrs.allowedActions[0] === 'read' &&
    typeof item.detail?.text === 'string' && item.detail.text.trim().length > 0 && !needsConfirmation(item);
}

export type RunResult = { status: 'completed' | 'stopped' | 'timeout' | 'failed'; output: string };

// GNU timeout remains the deadline owner even if the Pi parent exits unexpectedly.
export async function runBoundedProcess(binary: string, args: string[], cwd: string, maxMs: number, signal: AbortSignal, scope: string): Promise<RunResult> {
  if (process.platform !== 'linux' || !Number.isFinite(maxMs) || maxMs <= 0 || signal.aborted) {
    return { status: 'stopped', output: '' };
  }
  const env = { ...process.env };
  delete env.PHCMS_ACCESS_TOKEN;
  delete env.PHCMS_API_URL;
  env.S8_AUTOPILOT_SCOPE = scope;
  const child = spawn('/usr/bin/timeout', ['--signal=TERM', '--kill-after=2s', `${Math.max(1, Math.ceil(maxMs / 1000))}s`, binary, ...args],
    { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let status: RunResult['status'] | undefined;
  let forceKill: ReturnType<typeof setTimeout> | undefined;
  let output = '';
  const killGroup = (sig: NodeJS.Signals) => { if (child.pid) { try { process.kill(-child.pid, sig); } catch (error: any) { if (error?.code !== 'ESRCH') throw error; } } };
  const stop = (reason: 'timeout' | 'stopped') => {
    if (status) return;
    status = reason;
    killGroup('SIGTERM');
    forceKill = setTimeout(() => killGroup('SIGKILL'), 2000);
  };
  const timer = setTimeout(() => stop('timeout'), maxMs);
  const onAbort = () => stop('stopped');
  const onExit = () => { killGroup('SIGKILL'); };
  signal.addEventListener('abort', onAbort, { once: true });
  process.once('exit', onExit);
  child.stdout?.on('data', (chunk: Buffer) => { output = (output + chunk.toString('utf8')).slice(0, 10000); });
  child.stderr?.resume(); // Never persist diagnostics: they may contain credentials.
  try {
    return await new Promise<RunResult>(resolve => {
      child.once('error', () => resolve({ status: 'failed', output: '' }));
      child.once('close', code => resolve({
        status: status ?? (code === 0 ? 'completed' : code === 124 || code === 137 ? 'timeout' : 'failed'), output,
      }));
    });
  } finally {
    clearTimeout(timer);
    if (forceKill) clearTimeout(forceKill);
    signal.removeEventListener('abort', onAbort);
    process.removeListener('exit', onExit);
    // A child can outlive timeout if it ignores TERM; kill its process group.
    killGroup('SIGKILL');
  }
}
