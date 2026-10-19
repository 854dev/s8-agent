import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { parseWorkerHost } from './worker-identity.mjs';

const run = promisify(execFile);
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
export const remoteWorkerSession = workerId => `s8-worker-${createHash('sha256').update(workerId).digest('hex').slice(0, 12)}`;

function targetOf(host) {
  let parsed;
  try { parsed = parseWorkerHost(host); }
  catch { throw new Error('Invalid SSH worker address'); }
  if (parsed.kind !== 'ssh') throw new Error('Invalid SSH worker address');
  const url = new URL(parsed.value);
  return `${decodeURIComponent(url.username)}@${url.hostname}`;
}

export async function sshCommand(host, remoteCommand, { timeoutMs = 15000, exec = run } = {}) {
  const target = targetOf(host);
  try {
    return await exec('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', target, `bash -lc ${quote(remoteCommand)}`], { timeout: timeoutMs, maxBuffer: 1024 * 1024 });
  } catch {
    throw new Error('SSH worker is unreachable or rejected the lifecycle request');
  }
}

export async function ensureRemoteWorker(workerId, entry, options = {}) {
  if (!entry.host?.startsWith('ssh://')) return { workerId, status: 'unsupported_host' };
  if (!entry.root) return { workerId, status: 'needs_remote_root' };
  const session = remoteWorkerSession(workerId), root = entry.root;
  const script = [
    'set -eu',
    `root=${quote(root)}`,
    `worker_id=${quote(workerId)}`,
    `session=${quote(session)}`,
    'test -f "$root/start-pi.sh"',
    'command -v tmux >/dev/null',
    'command -v node >/dev/null',
    'command -v git >/dev/null',
    ...(entry.agent === 'claude-code' ? ['command -v claude >/dev/null'] : []),
    'if tmux has-session -t "=$session" 2>/dev/null; then printf existing; else',
    '  worker_command=$(printf "%q " bash "$root/start-pi.sh" --service worker "$worker_id")',
    '  tmux new-session -d -s "$session" -c "$root" "exec ${worker_command% }"',
    '  printf started',
    'fi',
  ].join('\n');
  try {
    const result = await sshCommand(entry.host, script, options);
    return { workerId, status: result.stdout.trim() === 'started' ? 'starting' : 'present', session };
  } catch {
    return { workerId, status: 'unreachable', session };
  }
}

export async function stopRemoteWorkerIfExited(workerId, entry, options = {}) {
  if (!entry.host?.startsWith('ssh://') || !entry.root) return { workerId, status: 'needs_remote_root' };
  const session = remoteWorkerSession(workerId);
  const script = `set -eu; if ! tmux has-session -t ${quote(session)} 2>/dev/null; then printf absent; elif [ "$(tmux list-panes -t ${quote(session)} -F '#{pane_dead}' | sort -u)" = 1 ]; then tmux kill-session -t ${quote(session)}; printf stopped; else printf active; fi`;
  try {
    const result = await sshCommand(entry.host, script, options);
    return { workerId, status: result.stdout.trim() };
  } catch { return { workerId, status: 'unreachable' }; }
}
