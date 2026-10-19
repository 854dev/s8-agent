// s8.sh의 진입점: tmux 런타임과 공유 서비스 운영. 에이전트 실행 자체는 start-pi.sh(pi/bin/agent.mjs)가 맡는다.
//   service 종류 [인자]   scheduler·supervisor·worker 서비스를 이 프로세스에서 실행(tmux 서비스 창, 원격 워커, 수동 진단)
//   그 밖                 런타임 시작: 옵션 해석·선택 메뉴·tmux 런타임 (재)시작(user-command.mjs)
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadEnv, kbRoot, preparePiEnvironment, usageError } from '../lib/agent/launch.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));

async function runService([service, ...args]) {
  if (!['scheduler', 'supervisor', 'worker'].includes(service)) throw usageError('서비스는 scheduler, supervisor 또는 worker여야 합니다.');
  if (service === 'scheduler' && args.length) throw usageError('스케줄러는 추가 인자를 받지 않습니다.');
  if (!(service === 'supervisor' && args[0] === '--help')) {
    loadEnv(root);
    if (service === 'scheduler') {
      // 예약 작업은 KB 저장소에서 Pi를 실행하므로 Pi 경로와 작업 디렉터리를 준비한다.
      process.env.S8_KB_ROOT = await kbRoot(root);
      await preparePiEnvironment(root);
      process.chdir(process.env.S8_KB_ROOT);
    }
  }
  const script = path.join(root, 'pi/bin', service === 'worker' ? 'developer.mjs' : `${service}.mjs`);
  // 서비스 스크립트는 process.argv[2..]를 자기 인자로 읽는다. 그 형태로 바꾼 뒤 같은 프로세스에서 실행한다.
  process.argv.splice(1, Infinity, script, ...args);
  await import(pathToFileURL(script).href);
}

const [command, ...args] = process.argv.slice(2);
try {
  // --service는 이전 start-pi.sh --service 호환(원격 워커 체크아웃이 갱신되기 전까지).
  if (command === 'service' || command === '--service') await runService(args);
  else {
    // 런타임 제어 모듈은 사용자 실행에서만 불러온다(서비스·원격 워커 시작을 가볍게 유지).
    const { runUserCommand } = await import('../lib/runtime/user-command.mjs');
    await runUserCommand(root, process.argv.slice(2));
  }
} catch (error) {
  console.error(`[S8] ${error.message}`);
  process.exitCode = error.exitCode ?? 1;
}
