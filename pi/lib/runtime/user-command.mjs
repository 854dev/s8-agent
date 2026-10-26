// s8.sh 런타임 시작(pi/bin/s8.mjs가 호출). 옵션을 해석하고, 필요하면 모드·Telegram을 터미널에서 선택받은 뒤
// tmux 런타임을 (재)시작하고 창 목록을 출력한다. 에이전트 단독 실행(--print 등)은 start-*-agent.sh가 맡는다.
import { realpath } from 'node:fs/promises';
import readline from 'node:readline';
import { restartPiRuntime, stoppedInfrastructure } from './restart.mjs';
import { runTmux } from './tmux-windows.mjs';
import { loadS8Config } from '../config/s8-config.mjs';
import { validSession, listSessions } from './managed-sessions.mjs';
import { telegramOwner } from '../telegram/status.mjs';
import { isPackageCommand, validatePiOptions, usageError } from '../agent/launch.mjs';

const HELP = `사용법: ./s8.sh [--mode project|general] [--cwd 경로] [Pi 옵션]
  --mode project  Projectman 관리·개발 위임 (기존 실행)
  --mode general  범용 에이전트 (프로젝트 서비스 없음)
  --cwd 경로      작업 디렉터리 (모든 모드, 기본: 실행 위치)
  모드 생략 시 터미널에서 선택, 자동화에서는 명시 필수
  --session 생략 시 터미널에서 세션 이름 입력 (빈 입력: 모드 기본 세션)
  --reset 생략 시 터미널에서 기존 세션 유지 / 모두 종료를 선택 (자동화 기본: 유지)
  (인자 없음)      프로젝트 / 범용 모드 선택
  --no-scheduler   스케줄러 자동 시작 제외
  work UID         승인된 작업의 워커를 s8-workers 세션에 실행 (start-worker-agent.sh)
  finish UID --run-id UUID --confirm-stopped  멈춘 실행을 실패로 보고해 마무리
  service scheduler  예약 데몬 전경 실행
  service worker ID  상주 워커 루프 전경 실행 (config.yml의 workers)
  workers          매니저 없이 설정된 상주 워커를 s8-workers tmux에 실행
  --telegram take  이 세션으로 Telegram 연결 이전 (단독 --telegram도 호환)
  --telegram off   이 세션의 Telegram 연결 비활성 (--no-telegram도 호환)
  --no-telegram    Telegram 없이 단독 실행
  --manager        기본 매니저의 별칭 (일반 대화·파일·Bash·Projectman·KB·예약)
  --sessions       실행 중인 S8 tmux 세션 목록
  --session 이름   s8-이름 세션 생성·재시작, 다른 tmux 세션은 유지 (자동 접속 없음)
  --reset          s8-infra를 뺀 기존 tmux 세션을 모두 종료한 뒤 시작
  project 모드는 인프라(./start-infra.sh)가 떠 있어야 시작한다
  --help, -h       이 도움말 표시
  Pi 옵션: --continue, --no-session, --model, --provider, --thinking
  에이전트 하나만 이 터미널에서 실행하려면 ./start-general-agent.sh, ./start-manager-agent.sh, ./start-worker-agent.sh를 사용한다.
  비밀값(.env): PHCMS_ACCESS_TOKEN, TELEGRAM_BOT_TOKEN, CLINE_API_KEY
  설정(config.yml): KB 경로(kbRoot, 기본값 ../854_md), Projectman 주소, 바인딩 IP·포트, Telegram ID·알림 대상`;

/** 런타임 옵션은 소비하고 나머지는 Pi 인자(args)로 넘긴다. 옵션 위치는 자유롭다. */
function parseOptions(input) {
  const options = { cwd: process.cwd(), scheduler: true, args: [] };
  for (let i = 0; i < input.length; i++) {
    const arg = input[i];
    const value = () => {
      if (!input[i + 1]) throw usageError(`${arg} 값이 필요합니다.`);
      return input[++i];
    };
    if (arg === '--mode') options.mode = value();
    else if (arg === '--cwd') options.cwd = value();
    else if (arg === '--manager') options.mode = 'project';
    else if (arg === '--session') options.session = `s8-${input[++i] ?? ''}`;
    else if (arg === '--telegram') {
      // --telegram take|off. 값 없는 --telegram은 take로 본다.
      const action = input[i + 1];
      if (action === 'take' || action === 'off') { options.telegram = action === 'take'; i++; }
      else if (action && !action.startsWith('--')) throw usageError('--telegram은 take 또는 off를 받습니다.');
      else options.telegram = true;
    }
    else if (arg === '--no-telegram') options.telegram = false;
    else if (arg === '--no-scheduler') options.scheduler = false;
    else if (arg === '--reset') options.reset = true;
    else if (['--model', '--provider', '--thinking'].includes(arg)) options.args.push(arg, input[++i]);
    else options.args.push(arg);
  }
  return options;
}

/** 터미널 선택 메뉴. 입력이 미리 들어와 있어도 줄 단위로 순서대로 읽도록 async iterator를 쓴다. */
function createPrompt() {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  const lines = rl[Symbol.asyncIterator]();
  return {
    async ask(text) { process.stdout.write(text); return ((await lines.next()).value ?? '').trim(); },
    close: () => rl.close(),
  };
}

async function chooseMode(prompt) {
  console.log('실행 모드: 1) Projectman 프로젝트 관리·개발  2) 범용 에이전트');
  const selected = await prompt.ask('선택 [1/2]: ');
  if (selected === '1' || selected === 'project') return 'project';
  if (selected === '2' || selected === 'general') return 'general';
  throw usageError('잘못된 모드 선택입니다.');
}

/** 현재 Telegram 연결을 보여주고 유지('keep') 또는 가져오기(true)를 선택받는다. */
async function chooseTelegram(prompt) {
  console.log(`Telegram 현재 연결: ${await telegramOwner() ?? '연결 없음'}`);
  console.log('1) 현재 연결 유지  2) 여기로 가져오기');
  const selected = await prompt.ask('선택 [1]: ');
  if (selected === '' || selected === '1') return 'keep';
  if (selected === '2' || selected === 'take') return true;
  throw usageError('잘못된 Telegram 선택입니다.');
}

/** 세션 이름을 입력받는다. 빈 입력은 모드 기본 세션, s8- 접두어는 생략할 수 있다. */
async function chooseSession(prompt, mode) {
  const fallback = defaultSession(mode);
  const name = await prompt.ask(`세션 이름 (s8- 생략 가능) [${fallback.slice(3)}]: `);
  if (!name) return fallback;
  const session = name.startsWith('s8-') ? name : `s8-${name}`;
  if (!validSession(session)) throw usageError('잘못된 세션 이름입니다.');
  return session;
}

/** 다른 tmux 세션을 유지(false)할지, s8-infra를 뺀 모든 세션을 종료(true)할지 선택받는다. */
async function chooseReset(prompt) {
  console.log('기존 tmux 세션: 1) 유지하고 이 세션만 (재)시작  2) s8-infra를 뺀 모든 세션 종료 후 시작');
  const selected = await prompt.ask('선택 [1]: ');
  if (selected === '' || selected === '1' || selected === 'keep') return false;
  if (selected === '2' || selected === 'reset') return true;
  throw usageError('잘못된 세션 선택입니다.');
}

const defaultSession = mode => mode === 'general' ? 's8-general' : 's8-main';

async function startRuntime(root, options) {
  options.session ??= defaultSession(options.mode);
  // tmux 서버를 종료하기 전에 검증해야 잘못된 입력으로 기존 세션을 잃지 않는다.
  if (!validSession(options.session)) throw new Error('잘못된 세션 이름입니다.');
  validatePiOptions(options.args);
  // project 모드는 웹 콘솔·Projectman이 필요하다. 인프라가 없으면 아무것도 바꾸지 않고 멈춘다.
  if (options.mode === 'project') {
    const down = await stoppedInfrastructure(runTmux, { phcms: Boolean(loadS8Config(root).projectman.startCommand) });
    if (down.length) {
      const error = new Error(`인프라가 실행 중이 아닙니다(s8-infra에서 꺼진 창: ${down.join(', ')}).\n  ./start-infra.sh로 인프라를 먼저 시작한 뒤 다시 실행하세요. 기존 세션은 그대로 두었습니다.`);
      error.exitCode = 1;
      throw error;
    }
  }
  console.log(`S8 런타임 시작: ${options.session} (${options.mode} 모드)`);
  // 기본은 대상 세션만 (재)시작하고 다른 세션은 유지한다. --reset일 때만 s8-infra를 뺀 세션을 모두 종료한다.
  const { reset, ...runtimeOptions } = options;
  const result = await restartPiRuntime(root, { ...runtimeOptions, resetTmux: Boolean(reset) }, { onProgress: line => console.log(`  - ${line}`) });
  console.log(`tmux 세션: ${result.session}`);
  for (const window of result.windows) console.log(`  ${result.session}:${window}`);
  console.log(result.telegramStatus);
  console.log(`접속: tmux attach-session -t ${result.session}`);
}

/** s8.sh 런타임 시작. input은 사용자가 준 인자 그대로다. */
export async function runUserCommand(root, input) {
  const options = parseOptions(input);
  const [first] = options.args;
  if (options.args.includes('--help') || options.args.includes('-h')) return console.log(HELP);
  if (first === '--sessions') return console.log((await listSessions()).join('\n') || '실행 중인 S8 세션이 없습니다.');

  // 이 터미널에서 끝나는 명령은 tmux 런타임이 아니라 에이전트 실행기의 몫이다.
  if (isPackageCommand(first) || options.args.includes('--version') || options.args.includes('--print')) {
    throw usageError('패키지 명령·--version·--print는 ./start-general-agent.sh 등 에이전트 실행 스크립트로 실행하세요.');
  }
  const prompt = process.stdin.isTTY ? createPrompt() : null;
  try {
    // 모드 미지정이면 터미널에서 선택받는다.
    if (!options.mode) {
      if (!prompt) throw usageError('--mode project 또는 --mode general을 지정하세요.');
      options.mode = await chooseMode(prompt);
    }
    if (!['project', 'general'].includes(options.mode)) throw usageError('모드는 project 또는 general이어야 합니다.');
    if (options.session === undefined && prompt) options.session = await chooseSession(prompt, options.mode);
    if (options.telegram === undefined && prompt) options.telegram = await chooseTelegram(prompt);
    if (options.reset === undefined && prompt) options.reset = await chooseReset(prompt);
  } finally { prompt?.close(); }
  options.cwd = await realpath(options.cwd);
  await startRuntime(root, options);
}
