// 런타임 재시작 요청 큐.
// 호출자는 재시작으로 종료될 Pi 창 안에 있을 수 있으므로, 재시작은 분리된 제어 프로세스
// (pi/bin/pi-runtime-worker.mjs)가 수행한다. 요청·결과는 .s8-runtime/runtime-restarts/<id>/ 파일로 주고받는다.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { sleep } from './process.mjs';

/**
 * tmux 서버 전체를 종료하는 재시작을 디스크 잠금으로 직렬화한다.
 * tmux wait-for 잠금은 kill-server와 함께 사라지므로 쓸 수 없다. 잠금 파일에는 소유 PID를 기록하고,
 * 소유 프로세스가 사라진 잠금은 정리한 뒤 다시 시도한다.
 */
export async function withRuntimeResetLock(root, action) {
  const file = path.join(root, '.s8-runtime/runtime-reset.lock');
  const deadline = Date.now() + 120000;
  let handle;
  while (!handle) {
    try { handle = await open(file, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const pid = Number(await readFile(file, 'utf8'));
        if (Number.isInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); }
          catch (error) { if (error.code === 'ESRCH') await unlink(file); else throw error; }
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (Date.now() >= deadline) throw new Error('tmux 재시작 잠금 대기 시간이 지났습니다.');
      await sleep(100);
    }
  }
  try { await handle.writeFile(String(process.pid)); return await action(); }
  finally { await handle.close(); await unlink(file); }
}

/** 요청을 기록하고 분리된 제어 프로세스를 띄운다. 결과를 기다리지 않는다. */
export async function queuePiRuntimeRestart(root, options) {
  const id = randomUUID(), directory = path.join(root, '.s8-runtime/runtime-restarts', id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path.join(directory, 'request.json'), JSON.stringify(options), { mode: 0o600 });
  const log = await open(path.join(directory, 'controller.log'), 'a', 0o600);
  try {
    const child = spawn(process.execPath, [path.join(root, 'pi/bin/pi-runtime-worker.mjs'), id], { cwd: root, detached: true, stdio: ['ignore', log.fd, log.fd] });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
  } finally { await log.close(); }
  return { id, directory };
}

/** 재시작을 요청하고 result.json이 생길 때까지(최대 2분) 기다려 결과를 돌려준다. */
export async function restartPiRuntime(root, options) {
  const { directory } = await queuePiRuntimeRestart(root, options);
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    try {
      const result = JSON.parse(await readFile(path.join(directory, 'result.json'), 'utf8'));
      if (!result.ok) throw new Error(result.error);
      return result.value;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await sleep(100);
  }
  throw new Error(`재시작 완료 확인 시간이 지났습니다. 제어 프로세스 기록: ${directory}`);
}

/** 대기 중인 호출자가 쓰다 만 파일을 읽지 않도록 임시 파일에 쓴 뒤 이름을 바꾼다. */
export async function saveRestartResult(directory, result) {
  const file = path.join(directory, 'result.json');
  await writeFile(`${file}.tmp`, JSON.stringify(result), { mode: 0o600 });
  await rename(`${file}.tmp`, file);
}
