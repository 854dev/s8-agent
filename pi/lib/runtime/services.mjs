import { createHash } from 'node:crypto';
import { ensureWindow, stopWindow, windows, withTmuxLock, runTmux, quote } from './tmux-windows.mjs';
import { ensureWorkerPool, workerStates } from '../development/worker-pool.mjs';
import { validSession } from './managed-sessions.mjs';
import { readFile, mkdir, open, rm, realpath } from 'node:fs/promises';
import path from 'node:path';

const definitions = {
  scheduler: { session: 's8-scheduler', lock: '.s8-runtime/scheduler/owner.lock' },
  supervisor: { session: 's8-development-supervisor', lock: '.s8-runtime/services/supervisor.lock' },
};
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
async function ownerPid(file) {
  try { const value = (await readFile(file, 'utf8')).split('\n')[0]; if (!/^[1-9]\d*$/.test(value)) throw new Error('잘못된 서비스 잠금 파일입니다.'); return Number(value); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/** 공유 서비스는 런타임 세션의 창에서 유지한다. 여러 런타임에는 같은 창을 링크한다. */
export async function startPiServices(root, { session = 's8-main', scheduler = true, supervisor = true, restart = false, run = runTmux } = {}) {
  root = await realpath(root);
  if (scheduler || supervisor) {
    if (!validSession(session)) throw new Error('잘못된 세션 이름입니다.');
    const owner = (await run(['show-option', '-qv', '-t', session, '@s8-runtime-root'])).stdout.trim();
    if (owner !== root) throw new Error(`${session}은 이 저장소의 런타임 세션이 아닙니다.`);
  }
  const results = [];
  let workerPool;
  if (supervisor) { workerPool = await ensureWorkerPool(root, { run }); results.push({ service: 'workers', ...workerPool }); }
  for (const [name, enabled] of Object.entries({ scheduler, supervisor })) {
    if (!enabled) continue;
    const service = definitions[name];
    const lock = 's8-service-' + createHash('sha256').update(root + name).digest('hex');
    results.push(await withTmuxLock(run, lock, async () => {
      const current = (await windows(run, session)).find(window => window.name === name);
      if (current?.dead && !restart) {
        const pid = await ownerPid(path.join(root, service.lock));
        if (pid) throw new Error(`${name}의 프로세스 잠금이 남아 있습니다 (PID ${pid}). 실행 여부와 ${service.lock}를 확인하세요.`);
      }
      if (!current) {
        // Adopt a live window from another runtime or an older standalone service session.
        const { stdout } = await run(['list-windows', '-a', '-F', '#{window_id}\t#{window_name}\t#{@s8-window-root}\t#{session_name}\t#{@s8-service-root}\t#{pane_dead}']);
        const candidate = stdout.trim().split('\n').map(line => line.split('\t')).find(([, windowName, owner, oldSession, legacyRoot, dead]) =>
          dead !== '1' && ((windowName === name && owner === root) || (oldSession === service.session && legacyRoot === root)));
        if (candidate) {
          const [id] = candidate;
          await run(['link-window', '-s', id, '-t', `${session}:`,
            ';', 'rename-window', '-t', id, name,
            ';', 'set-option', '-w', '-t', id, '@s8-window-root', root,
            ';', 'set-option', '-w', '-t', id, 'remain-on-exit', 'on',
            ';', 'set-option', '-w', '-t', id, 'automatic-rename', 'off']);
        } else {
          const pid = await ownerPid(path.join(root, service.lock));
          if (pid) {
            if (restart && !alive(pid)) await rm(path.join(root, service.lock), { force: true });
            else throw new Error(alive(pid)
              ? `${name}은 tmux 밖이나 이전 세션에서 실행 중입니다 (PID ${pid}). 기존 실행을 종료한 뒤 다시 실행하세요.`
              : `${name}의 종료된 프로세스 잠금이 남아 있습니다. 실행 여부를 확인한 뒤 ${service.lock}를 정리하세요.`);
          }
        }
      }
      if (restart && name === 'supervisor' && workerPool?.deferred) return { service: name, session, window: name, reused: true, deferred: true };
      if (restart && !(name === 'supervisor' && (await workerStates(root)).some(worker => worker.status !== 'idle' && worker.status !== 'offline' && !(worker.status === 'stopping' && !worker.alive)))) {
        await stopWindow(run, root, session, name);
        const file = path.join(root, service.lock);
        const deadline = Date.now() + 5000;
        let pid;
        while ((pid = await ownerPid(file)) && alive(pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
        if (pid && alive(pid)) throw new Error(`${name}의 기존 프로세스가 아직 실행 중입니다 (PID ${pid}).`);
        if (pid) await rm(file, { force: true });
      }
      const result = await ensureWindow(run, root, session, name, `exec bash ${quote(path.join(root, 'start-pi.sh'))} --service ${name}`);
      await new Promise(resolve => setTimeout(resolve, 200));
      if ((await windows(run, session)).find(window => window.id === result.id)?.dead !== false) throw new Error(`${session}:${name}가 시작 직후 종료됐습니다. 해당 창에서 오류를 확인하세요.`);
      return { service: name, session, window: name, reused: result.reused };
    }));
  }
  return results;
}

/** 별도로 실행한 슈퍼바이저와 통합 실행의 중복도 같은 PID 잠금으로 차단한다. */
export async function supervisorOwner(root) {
  const directory = path.join(root, '.s8-runtime/services');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'supervisor.lock');
  const handle = await open(file, 'wx', 0o600);
  try { await handle.writeFile(`${process.pid}\n`); }
  catch (error) { await handle.close(); await rm(file, { force: true }); throw error; }
  return async () => { await handle.close(); await rm(file, { force: true }); };
}
