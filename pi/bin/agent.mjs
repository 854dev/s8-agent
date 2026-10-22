// start-{general,manager,worker}-agent.sh의 진입점: 첫 인자로 받은 모드의 에이전트 하나를 이 터미널에서 실행한다.
import { fileURLToPath } from 'node:url';
import { runAgent, usageError } from '../lib/agent/launch.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const COMMON = `  --telegram       Telegram 연결 (TELEGRAM_BOT_TOKEN, s8-config.yml 필요)
  --help, -h       이 도움말 표시
  Pi 옵션: --continue, --print, --no-session, --version, --model, --provider, --thinking
  Pi 패키지 명령: install, remove, uninstall, update, list, config (모든 에이전트가 공유)
  다른 에이전트: start-general-agent.sh, start-manager-agent.sh, start-worker-agent.sh · tmux 런타임: ./s8.sh`;
const HELP = {
  general: `사용법: ./start-general-agent.sh [--cwd 경로] [옵션]
범용 에이전트: Projectman 없이 실행 위치에서 파일·셸·코드를 수정한다.
  --cwd 경로       작업 디렉터리 (기본: 실행 위치)
${COMMON}`,
  manager: `사용법: ./start-manager-agent.sh [옵션]
Projectman 매니저: KB 저장소에서 프로젝트·작업을 만들고 갱신하며 워커 보고를 받는다.
${COMMON}`,
  worker: `사용법: ./start-worker-agent.sh [--uid UID] [--cwd 경로] [옵션]
Projectman 워커: 실행 위치 저장소에서 UID 작업을 직접 claim·수행·보고한다.
Projectman의 작업 디렉터리에서 tmux로 실행하려면 ./s8.sh work UID를 사용한다.
  --uid UID        수행할 task·subtask UID. 지정하면 바로 작업을 시작한다
  --cwd 경로       작업 디렉터리 (기본: 실행 위치)
${COMMON}`,
};

/** 실행기 옵션은 소비하고 나머지는 Pi 옵션으로 넘긴다. --control·--session-dir은 s8 런타임이 쓰는 내부 옵션이다. */
function parseOptions(input) {
  const options = { args: [] };
  for (let i = 0; i < input.length; i++) {
    const arg = input[i];
    const value = () => {
      if (!input[i + 1]) throw usageError(`${arg} 값이 필요합니다.`);
      return input[++i];
    };
    if (arg === '--mode') throw usageError('모드는 실행 스크립트로 고릅니다: start-general-agent.sh, start-manager-agent.sh, start-worker-agent.sh');
    else if (arg === '--cwd') options.cwd = value();
    else if (arg === '--uid') options.uid = value();
    else if (arg === '--session-dir') options.sessionDir = value();
    else if (arg === '--telegram') options.telegram = true;
    else if (arg === '--control') options.control = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (['--model', '--provider', '--thinking'].includes(arg)) options.args.push(arg, input[++i]);
    else options.args.push(arg);
  }
  return options;
}

try {
  const [mode, ...input] = process.argv.slice(2);
  if (!HELP[mode]) throw usageError('start-general-agent.sh, start-manager-agent.sh, start-worker-agent.sh로 실행하세요.');
  const options = parseOptions(input);
  if (options.help) console.log(HELP[mode]);
  else process.exitCode = await runAgent(root, { ...options, mode });
} catch (error) {
  console.error(`[S8] ${error.message}`);
  process.exitCode = error.exitCode ?? 1;
}
