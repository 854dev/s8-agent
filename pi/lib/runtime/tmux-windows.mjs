// S8이 관리하는 tmux 창 조작 도구.
// 관리 창은 창 옵션 @s8-window-root에 소유 저장소 경로를 기록해, 다른 체크아웃이나
// 사용자가 만든 같은 이름의 창을 건드리지 않도록 구분한다.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { waitUntil } from './process.mjs';

const exec = promisify(execFile);
export const runTmux = args => exec('tmux', args, { timeout: 10000, maxBuffer: 65536 });

/** tmux 셸 명령에 넣을 값을 작은따옴표로 감싼다. */
export const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

/** 체크아웃별로 고유한 tmux wait-for 잠금 이름. */
export const lockName = (prefix, key) => prefix + createHash('sha256').update(key).digest('hex');

/** tmux wait-for 잠금으로 같은 이름의 작업을 직렬화한다. tmux 서버가 종료되면 잠금도 사라진다. */
export async function withTmuxLock(run, name, action) {
  await run(['wait-for', '-L', name]);
  try { return await action(); } finally { await run(['wait-for', '-U', name]); }
}

/** 세션 옵션(@s8-*) 값을 읽는다. 없으면 빈 문자열. */
export async function sessionOption(run, session, name) {
  return (await run(['show-option', '-qv', '-t', session, name])).stdout.trim();
}

export const hasSession = (run, session) => run(['has-session', '-t', `=${session}`]).then(() => true, () => false);

/**
 * 세션이 없으면 이 저장소 소유의 관리 세션(@s8-runtime-root, @s8-managed)으로 만들고, 소유 저장소를 확인한다.
 * options는 새로 만들 때 함께 설정할 세션 옵션. 동시에 다른 실행이 먼저 만들었다면 그 세션을 사용한다.
 */
export async function ensureSession(run, root, session, options = {}) {
  if (!await hasSession(run, session)) {
    const settings = Object.entries({ '@s8-runtime-root': root, '@s8-managed': '1', ...options });
    try { await run(['new-session', '-d', '-s', session, '-n', 'shell', '-c', root, ...settings.flatMap(([name, value]) => [';', 'set-option', '-t', session, name, value])]); }
    catch (error) { if (!await hasSession(run, session)) throw error; }
  }
  if (await sessionOption(run, session, '@s8-runtime-root') !== root) throw new Error(`${session}은 이 저장소의 세션이 아닙니다. 다른 --session 이름을 사용하세요.`);
}

/** 관리 창으로 표시하는 tmux 명령 조각. 종료 후에도 창을 남겨 오류 출력을 확인할 수 있게 한다. */
const managedWindowOptions = (target, root) => [
  ';', 'set-option', '-w', '-t', target, '@s8-window-root', root,
  ';', 'set-option', '-w', '-t', target, 'remain-on-exit', 'on',
  ';', 'set-option', '-w', '-t', target, 'automatic-rename', 'off',
];

/** 창의 마지막 출력 몇 줄. 시작 직후 종료된 창의 오류를 보여줄 때 쓴다. */
export async function windowTail(run, target, lines = 5) {
  try {
    const { stdout } = await run(['capture-pane', '-p', '-S', '-200', '-t', target]);
    return stdout.split('\n').filter(line => line.trim() && !line.startsWith('Pane is dead')).slice(-lines).join('\n');
  } catch { return ''; }
}

export async function windows(run, session) {
  const { stdout } = await run(['list-windows', '-t', `=${session}`, '-F', '#{window_id}\t#{window_name}\t#{@s8-window-root}\t#{pane_dead}']);
  return stdout.trim().split('\n').filter(Boolean).map(line => {
    const [id, name, root, dead] = line.split('\t');
    return { id, name, root, dead: dead === '1' };
  });
}

/** 이름이 name인 관리 창을 찾는다. 중복이거나 다른 소유자의 창이면 거부한다. */
async function ownedWindow(run, root, session, name) {
  const matches = (await windows(run, session)).filter(window => window.name === name);
  if (matches.length > 1 || (matches[0] && matches[0].root !== root)) throw new Error(`${session}:${name}은 S8이 관리하는 창이 아닙니다.`);
  return matches[0];
}

/** 창에 Ctrl-C를 보내고 프로세스가 끝날 때까지 기다린다. 시간 내 끝나지 않으면 중복 실행을 막기 위해 실패한다. */
export async function stopWindow(run, root, session, name, { timeoutMs = 20000 } = {}) {
  const window = await ownedWindow(run, root, session, name);
  if (!window || window.dead) return;
  await run(['send-keys', '-t', window.id, 'C-c']);
  const stopped = await waitUntil(async () => {
    const current = (await windows(run, session)).find(item => item.id === window.id);
    return !current || current.dead;
  }, { timeoutMs });
  if (!stopped) throw new Error(`${session}:${name}가 정상 종료되지 않았습니다. 중복 실행을 막기 위해 재시작을 중단했습니다.`);
}

/** 창이 살아 있으면 재사용하고, 죽어 있으면 같은 창에서 다시 실행하고, 없으면 새로 만든다. */
export async function ensureWindow(run, root, session, name, command) {
  const window = await ownedWindow(run, root, session, name);
  if (window && !window.dead) return { ...window, reused: true };
  if (window) {
    await run(['respawn-window', '-t', window.id, '-c', root, command]);
    return { ...window, dead: false, reused: false };
  }
  // 한 번의 명령 큐로 소유 표시까지 끝내야 즉시 종료된 명령의 출력도 창에 남는다.
  await run(['new-window', '-d', '-t', `${session}:`, '-n', name, '-c', root, command, ...managedWindowOptions(`${session}:${name}`, root)]);
  return { ...(await windows(run, session)).find(window => window.name === name), reused: false };
}
