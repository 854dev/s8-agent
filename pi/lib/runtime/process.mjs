// 프로세스·대기·PID 잠금 공용 유틸리티.
import { open, readFile, rm } from 'node:fs/promises';

/** PID가 살아 있는지 확인한다. 권한 부족(EPERM)은 다른 사용자의 살아 있는 프로세스로 본다. */
export function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** check()가 참 값을 돌려줄 때까지 intervalMs 간격으로 다시 확인한다. 시간이 지나면 마지막 결과를 그대로 돌려준다. */
export async function waitUntil(check, { timeoutMs, intervalMs = 100 }) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const value = await check();
    if (value || Date.now() >= deadline) return value;
    await sleep(intervalMs);
  }
}

/** 잠금 파일 첫 줄의 PID. 파일이 없으면 null, 형식이 잘못됐으면(쓰는 중 포함) NaN. */
export async function lockOwner(file) {
  try {
    const line = (await readFile(file, 'utf8')).split('\n')[0];
    return /^[1-9]\d*$/.test(line) ? Number(line) : NaN;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/**
 * PID 잠금 파일을 원자적으로 만들고 해제 함수를 돌려준다. 파일 첫 줄은 이 프로세스의 PID다.
 * 이미 있으면 소유 프로세스가 죽은 경우에만 지우고 다시 시도한다. 형식이 잘못된 파일은 잡힌 것으로 본다.
 * waitMs 안에 얻지 못하면 code 'ELOCKED'(pid: 소유 PID) 오류를 던진다.
 * extra는 둘째 줄부터 기록할 진단 정보다.
 */
export async function acquirePidLock(file, { waitMs = 0, extra = '' } = {}) {
  let owner;
  const attempt = async () => {
    try {
      const handle = await open(file, 'wx', 0o600);
      try { await handle.writeFile(`${process.pid}\n${extra}`); }
      catch (error) { await handle.close(); await rm(file, { force: true }); throw error; }
      return async () => { await handle.close(); await rm(file, { force: true }); };
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
    owner = await lockOwner(file);
    // 소유자가 비정상 종료한 잠금. 지운 뒤 다음 시도에서 다시 만든다.
    if (owner !== null && !Number.isNaN(owner) && !processAlive(owner)) await rm(file, { force: true });
    return null;
  };
  const release = await waitUntil(attempt, { timeoutMs: waitMs }) ?? await attempt();
  if (release) return release;
  throw Object.assign(new Error(`잠금이 사용 중입니다${owner ? ` (PID ${owner})` : ''}: ${file}`), { code: 'ELOCKED', pid: owner });
}
