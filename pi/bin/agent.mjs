// start-pi.sh의 진입점: 단일 에이전트를 이 터미널에서 실행한다.
import { fileURLToPath } from 'node:url';
import { runAgent, usageError } from '../lib/agent/launch.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const HELP = `사용법: ./start-pi.sh [--mode general|manager|worker] [--cwd 경로] [--uid UID] [--telegram] [Pi 옵션]
  --mode general   범용 에이전트: 파일·셸·코드 수정 (기본값, 실행 위치에서 작업)
  --mode manager   Projectman 매니저: 프로젝트·작업 생성·갱신, 워커 보고 수신 (KB 저장소에서 작업)
  --mode worker    Projectman 워커: UID 작업을 직접 claim·수행·보고 (실행 위치 저장소에서 작업)
  --cwd 경로       작업 디렉터리 (general·worker 모드, 기본: 실행 위치)
  --uid UID        worker 모드에서 수행할 task·subtask UID. 지정하면 바로 작업을 시작한다
  --telegram       Telegram 연결 (TELEGRAM_BOT_TOKEN, s8-config.yml 필요)
  --help, -h       이 도움말 표시
  Pi 옵션: --continue, --print, --no-session, --version, --model, --provider, --thinking
  Pi 패키지 명령: install, remove, uninstall, update, list, config
  tmux 런타임·서비스는 ./s8.sh를 사용한다.`;

/** 실행기 옵션은 소비하고 나머지는 Pi 옵션으로 넘긴다. --control·--session-dir은 s8 런타임이 쓰는 내부 옵션이다. */
function parseOptions(input) {
  const options = { args: [] };
  for (let i = 0; i < input.length; i++) {
    const arg = input[i];
    const value = () => {
      if (!input[i + 1]) throw usageError(`${arg} 값이 필요합니다.`);
      return input[++i];
    };
    if (arg === '--mode') options.mode = value();
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
  const options = parseOptions(process.argv.slice(2));
  if (options.help) console.log(HELP);
  else process.exitCode = await runAgent(root, options);
} catch (error) {
  console.error(`[S8] ${error.message}`);
  process.exitCode = error.exitCode ?? 1;
}
