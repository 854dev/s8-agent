import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { listSessions } from '../../pi/lib/managed-sessions.mjs';
const exec = promisify(execFile);
export const SHELL_SESSION = 's8-host-shell';
const root = fileURLToPath(new URL('../../', import.meta.url));
const options = { timeout: 3000, maxBuffer: 65536 };
let creating;
async function isShell() {
  try {
    await exec('tmux', ['has-session', '-t', `=${SHELL_SESSION}`], options);
    const { stdout } = await exec('tmux', ['show-option', '-t', SHELL_SESSION, '-v', '@s8-shell'], options);
    return stdout.trim() === '1';
  } catch { return false; }
}
export async function listTerminalSessions() {
  const sessions = await listSessions();
  return await isShell() ? [SHELL_SESSION, ...sessions.filter(name => name !== SHELL_SESSION)] : sessions.filter(name => name !== SHELL_SESSION);
}
export function ensureShell() {
  if (creating) return creating;
  creating = (async () => {
    if (await isShell()) return SHELL_SESSION;
    // Never replace an existing session with the reserved name.
    await exec('tmux', ['new-session', '-d', '-s', SHELL_SESSION, '-c', root], options);
    await exec('tmux', ['set-option', '-t', SHELL_SESSION, '@s8-shell', '1'], options);
    return SHELL_SESSION;
  })().finally(() => { creating = undefined; });
  return creating;
}
