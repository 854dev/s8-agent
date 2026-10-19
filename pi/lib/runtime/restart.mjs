import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

// A tmux wait-for lock disappears with kill-server; serialize destructive
// restarts on disk for the lifetime of the detached controller instead.
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
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  try { await handle.writeFile(String(process.pid)); return await action(); }
  finally { await handle.close(); await unlink(file); }
}

// The caller may be inside the Pi pane being stopped. A detached controller owns
// the entire restart so closing the caller's terminal cannot interrupt it.
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

export async function restartPiRuntime(root, options) {
  const { directory } = await queuePiRuntimeRestart(root, options);
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    try {
      const result = JSON.parse(await readFile(path.join(directory, 'result.json'), 'utf8'));
      if (!result.ok) throw new Error(result.error);
      return result.value;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`재시작 완료 확인 시간이 지났습니다. 제어 프로세스 기록: ${directory}`);
}

export async function saveRestartResult(directory, result) {
  const file = path.join(directory, 'result.json');
  await writeFile(`${file}.tmp`, JSON.stringify(result), { mode: 0o600 });
  await rename(`${file}.tmp`, file);
}
