// 공유 서비스(scheduler) 시작.
// 서비스는 체크아웃당 하나만 실행되며, 서비스 프로세스가 PID 잠금 파일로 이를 보장한다.
// 비정상 종료로 남은 잠금은 서비스가 시작할 때 스스로 정리한다(acquirePidLock).
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { lockOwner, processAlive, sleep, waitUntil } from './process.mjs';
import { ensureWindow, stopWindow, windows, windowTail, withTmuxLock, runTmux, quote, lockName } from './tmux-windows.mjs';

// 서비스별 PID 잠금 파일(저장소 루트 기준).
const lockFiles = {
  scheduler: '.s8-runtime/scheduler/owner.lock',
};

/** 서비스 창이 없는데 잠금 소유자가 살아 있으면 tmux 밖에서 실행 중인 것이므로 중복 실행을 거부한다. */
async function assertNoOutsideOwner(root, name) {
  const pid = await lockOwner(path.join(root, lockFiles[name]));
  if (processAlive(pid)) throw new Error(`${name}은 tmux 밖이나 이전 세션에서 실행 중입니다 (PID ${pid}). 기존 실행을 종료한 뒤 다시 실행하세요.`);
}

/** 서비스 창을 중지하고 프로세스가 잠금을 놓을 때까지 최대 5초 기다린다. */
async function stopService(run, root, session, name) {
  await stopWindow(run, root, session, name);
  const file = path.join(root, lockFiles[name]);
  let pid;
  const released = await waitUntil(async () => !processAlive(pid = await lockOwner(file)), { timeoutMs: 5000 });
  if (!released) throw new Error(`${name}의 기존 프로세스가 아직 실행 중입니다 (PID ${pid}).`);
}

/**
 * 공유 서비스를 (재)시작하고 서비스별 결과 목록을 돌려준다.
 * session은 startPiRuntime이 만들고 소유를 확인한 런타임 세션이다. 실행 중인 서비스는 새 프로세스로 교체한다. log는 진행 단계를 한 줄씩 받는다.
 */
export async function startPiServices(root, { session = 's8-main', scheduler = true, run = runTmux, log = () => {} } = {}) {
  root = await realpath(root);
  const results = [];
  for (const [name, enabled] of Object.entries({ scheduler })) {
    if (!enabled) continue;
    results.push(await withTmuxLock(run, lockName('s8-service-', root + name), async () => {
      const current = (await windows(run, session)).find(window => window.name === name);
      if (!current || current.dead) await assertNoOutsideOwner(root, name);
      else {
        log(`${name}: 기존 프로세스 중지`);
        await stopService(run, root, session, name);
      }
      log(`${name}: 시작`);
      const result = await ensureWindow(run, root, session, name, `exec bash ${quote(path.join(root, 's8.sh'))} service ${name}`);
      // 잘못된 설정 등으로 즉시 종료되는 경우를 잡는다. 창은 남아 있어 오류 출력을 확인할 수 있다.
      await sleep(200);
      if ((await windows(run, session)).find(window => window.id === result.id)?.dead !== false) {
        throw new Error(`${session}:${name}가 시작 직후 종료됐습니다. 창 출력:\n${await windowTail(run, result.id) || '(출력 없음)'}`);
      }
      log(`${name}: 실행 확인`);
      return { service: name, session, window: name };
    }));
  }
  return results;
}
