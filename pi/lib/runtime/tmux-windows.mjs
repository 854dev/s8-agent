// S8이 관리하는 tmux 창 조작 도구.
// 관리 창은 창 옵션 @s8-window-root에 소유 저장소 경로를 기록해, 다른 체크아웃이나
// 사용자가 만든 같은 이름의 창을 건드리지 않도록 구분한다.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { sleep } from './process.mjs';

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

/** 관리 창으로 표시하는 tmux 명령 조각. 종료 후에도 창을 남겨 오류 출력을 확인할 수 있게 한다. */
const managedWindowOptions = (target, root) => [
  ';', 'set-option', '-w', '-t', target, '@s8-window-root', root,
  ';', 'set-option', '-w', '-t', target, 'remain-on-exit', 'on',
  ';', 'set-option', '-w', '-t', target, 'automatic-rename', 'off',
];

export async function windows(run, session) {
  const { stdout } = await run(['list-windows', '-t', `=${session}`, '-F', '#{window_id}\t#{window_name}\t#{@s8-window-root}\t#{pane_dead}\t#{@s8-worker-id}']);
  return stdout.trim().split('\n').filter(Boolean).map(line => {
    const [id, name, root, dead, workerId] = line.split('\t');
    return { id, name, root, dead: dead === '1', workerId: workerId || undefined };
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
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = (await windows(run, session)).find(item => item.id === window.id);
    if (!current || current.dead) return;
    await sleep(100);
  }
  throw new Error(`${session}:${name}가 정상 종료되지 않았습니다. 중복 실행을 막기 위해 재시작을 중단했습니다.`);
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
