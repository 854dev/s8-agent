import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);
export const SHELL_SESSION = 's8-host-shell';
const root = fileURLToPath(new URL('../../', import.meta.url));
const options = { timeout: 3000, maxBuffer: 65536 };
let creating;
// Web terminals expose the host's tmux server, independently of Pi ownership.
// ':' and '.' address windows/panes in tmux; control characters cannot be listed safely.
export const validTerminalSession = name => typeof name === 'string' && name.length > 0 && !/[\x00-\x1f\x7f:.]/u.test(name);
async function shellExists() {
  try {
    await exec('tmux', ['has-session', '-t', `=${SHELL_SESSION}`], options);
    return true;
  } catch { return false; }
}
export async function listTerminalSessions() {
  let stdout;
  try { ({ stdout } = await exec('tmux', ['list-sessions', '-F', '#{session_name}'], options)); }
  catch (error) {
    if (/no server running|no sessions|error connecting/.test(error.stderr ?? '')) return [];
    throw error;
  }
  const sessions = stdout.split('\n').filter(validTerminalSession);
  return sessions.includes(SHELL_SESSION)
    ? [SHELL_SESSION, ...sessions.filter(name => name !== SHELL_SESSION)] : sessions;
}
export function ensureShell() {
  if (creating) return creating;
  creating = (async () => {
    if (await shellExists()) return SHELL_SESSION;
    try { await exec('tmux', ['new-session', '-d', '-s', SHELL_SESSION, '-c', root], options); }
    catch (error) {
      // A different gateway may have created the same session concurrently.
      if (await shellExists()) return SHELL_SESSION;
      throw error;
    }
    await exec('tmux', ['set-option', '-t', SHELL_SESSION, '@s8-shell', '1'], options);
    return SHELL_SESSION;
  })().finally(() => { creating = undefined; });
  return creating;
}
