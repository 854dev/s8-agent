import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export const runTmux = args => exec('tmux', args, { timeout: 10000, maxBuffer: 65536 });
export const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
export async function withTmuxLock(run, name, action) {
  await run(['wait-for', '-L', name]);
  try { return await action(); } finally { await run(['wait-for', '-U', name]); }
}
export async function windows(run, session) {
  const { stdout } = await run(['list-windows', '-t', `=${session}`, '-F', '#{window_id}\t#{window_name}\t#{@s8-window-root}\t#{pane_dead}']);
  return stdout.trim().split('\n').filter(Boolean).map(line => {
    const [id, name, root, dead] = line.split('\t');
    return { id, name, root, dead: dead === '1' };
  });
}
export async function ensureWindow(run, root, session, name, command) {
  const current = (await windows(run, session)).filter(window => window.name === name);
  if (current.length > 1 || (current[0] && current[0].root !== root)) throw new Error(`${session}:${name}은 S8이 관리하는 창이 아닙니다.`);
  const window = current[0];
  if (window && !window.dead) return { ...window, reused: true };
  if (window) {
    await run(['respawn-window', '-t', window.id, '-c', root, command]);
    return { ...window, dead: false, reused: false };
  }
  // The command queue sets ownership and preserves failure output before returning.
  await run(['new-window', '-d', '-t', `${session}:`, '-n', name, '-c', root, command,
    ';', 'set-option', '-w', '-t', `${session}:${name}`, '@s8-window-root', root,
    ';', 'set-option', '-w', '-t', `${session}:${name}`, 'remain-on-exit', 'on',
    ';', 'set-option', '-w', '-t', `${session}:${name}`, 'automatic-rename', 'off']);
  return { ...(await windows(run, session)).find(window => window.name === name), reused: false };
}
