// 공유 서비스(scheduler, supervisor)와 개발 워커 풀 시작.
// 서비스는 체크아웃당 하나만 실행되며, 각 서비스 프로세스가 PID 잠금 파일로 이를 보장한다.
import { readFile, mkdir, open, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import { processAlive, sleep } from './process.mjs';
import { ensureWindow, stopWindow, windows, withTmuxLock, runTmux, quote, lockName, sessionOption } from './tmux-windows.mjs';
import { ensureWorkerPool, workersBusy } from '../development/worker-pool.mjs';
import { validSession } from './managed-sessions.mjs';

// 서비스별 PID 잠금 파일(저장소 루트 기준).
const lockFiles = {
  scheduler: '.s8-runtime/scheduler/owner.lock',
  supervisor: '.s8-runtime/services/supervisor.lock',
};

/** 잠금 파일 첫 줄의 PID. 파일이 없으면 null, 형식이 잘못되면 오류. */
async function ownerPid(file) {
  try {
    const value = (await readFile(file, 'utf8')).split('\n')[0];
    if (!/^[1-9]\d*$/.test(value)) throw new Error('잘못된 서비스 잠금 파일입니다.');
    return Number(value);
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/** 창 없이 남은 잠금을 정리한다. 소유 프로세스가 살아 있으면 tmux 밖에서 실행 중인 것이므로 거부한다. */
async function clearOrphanLock(root, name) {
  const file = path.join(root, lockFiles[name]);
  const pid = await ownerPid(file);
  if (!pid) return;
  if (processAlive(pid)) throw new Error(`${name}은 tmux 밖이나 이전 세션에서 실행 중입니다 (PID ${pid}). 기존 실행을 종료한 뒤 다시 실행하세요.`);
  await rm(file, { force: true });
}

/** 서비스 창을 중지하고 프로세스가 잠금을 놓을 때까지 최대 5초 기다린다. */
async function stopService(run, root, session, name) {
  await stopWindow(run, root, session, name);
  const file = path.join(root, lockFiles[name]);
  const deadline = Date.now() + 5000;
  let pid;
  while ((pid = await ownerPid(file)) && processAlive(pid) && Date.now() < deadline) await sleep(100);
  if (pid && processAlive(pid)) throw new Error(`${name}의 기존 프로세스가 아직 실행 중입니다 (PID ${pid}).`);
  if (pid) await rm(file, { force: true });
}

/**
 * 공유 서비스를 (재)시작하고 서비스별 결과 목록을 돌려준다. supervisor를 켜면 워커 풀 결과({ service: 'workers' })도 포함한다.
 * 실행 중인 서비스는 새 프로세스로 교체한다. 단, 워커가 작업 중이거나 워커 설정 적용이 보류되면
 * 실행 중인 supervisor는 그대로 둔다({ kept: true }).
 */
export async function startPiServices(root, { session = 's8-main', scheduler = true, supervisor = true, run = runTmux } = {}) {
  root = await realpath(root);
  if (!scheduler && !supervisor) return [];
  if (!validSession(session)) throw new Error('잘못된 세션 이름입니다.');
  if (await sessionOption(run, session, '@s8-runtime-root') !== root) throw new Error(`${session}은 이 저장소의 런타임 세션이 아닙니다.`);

  const results = [];
  let workerPool;
  if (supervisor) { workerPool = await ensureWorkerPool(root, { run }); results.push({ service: 'workers', ...workerPool }); }
  for (const [name, enabled] of Object.entries({ scheduler, supervisor })) {
    if (!enabled) continue;
    results.push(await withTmuxLock(run, lockName('s8-service-', root + name), async () => {
      const current = (await windows(run, session)).find(window => window.name === name);
      if (!current || current.dead) await clearOrphanLock(root, name);
      else {
        if (name === 'supervisor' && (workerPool.deferred || await workersBusy(root))) return { service: name, session, window: name, kept: true };
        await stopService(run, root, session, name);
      }
      const result = await ensureWindow(run, root, session, name, `exec bash ${quote(path.join(root, 'start-pi.sh'))} --service ${name}`);
      // 잘못된 설정 등으로 즉시 종료되는 경우를 잡는다. 창은 남아 있어 오류 출력을 확인할 수 있다.
      await sleep(200);
      if ((await windows(run, session)).find(window => window.id === result.id)?.dead !== false) throw new Error(`${session}:${name}가 시작 직후 종료됐습니다. 해당 창에서 오류를 확인하세요.`);
      return { service: name, session, window: name };
    }));
  }
  return results;
}

/** 별도로 실행한 슈퍼바이저와 통합 실행의 중복도 같은 PID 잠금으로 차단한다. 반환값은 잠금 해제 함수. */
export async function supervisorOwner(root) {
  const directory = path.join(root, '.s8-runtime/services');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'supervisor.lock');
  const handle = await open(file, 'wx', 0o600);
  try { await handle.writeFile(`${process.pid}\n`); }
  catch (error) { await handle.close(); await rm(file, { force: true }); throw error; }
  return async () => { await handle.close(); await rm(file, { force: true }); };
}
