// 런타임 모듈 공용 프로세스 유틸리티.

/** PID가 살아 있는지 확인한다. 권한 부족(EPERM)은 다른 사용자의 살아 있는 프로세스로 본다. */
export function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
