import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

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
