// s8.sh 런타임 시작(pi/bin/s8.mjs가 호출). 옵션을 해석하고, 필요하면 모드·Telegram을 터미널에서 선택받은 뒤
// tmux 런타임을 (재)시작하고 창 목록을 출력한다. 에이전트 단독 실행(--print 등)은 start-pi.sh가 맡는다.
import { realpath } from 'node:fs/promises';
import readline from 'node:readline';
import { restartPiRuntime } from './restart.mjs';
import { validSession, listSessions } from './managed-sessions.mjs';
import { telegramOwner } from '../telegram/status.mjs';
import { isPackageCommand, validatePiOptions, usageError } from '../agent/launch.mjs';

const HELP = `사용법: ./s8.sh [--mode project|local] [--cwd 경로] [Pi 옵션]
  --mode project  Projectman 관리·개발 위임 (기존 실행)
  --mode local    로컬 범용 에이전트 (프로젝트 서비스 없음)
  --cwd 경로      로컬 작업 디렉터리 (기본: 실행 위치)
  모드 생략 시 터미널에서 선택, 자동화에서는 명시 필수
  (인자 없음)      프로젝트 / 로컬 모드 선택
  --no-scheduler   스케줄러 자동 시작 제외
  work UID         승인된 작업의 워커를 s8-workers 세션에 실행 (start-pi.sh --mode worker)
  finish UID --run-id UUID --confirm-stopped  멈춘 실행을 실패로 보고해 마무리
  service scheduler  예약 데몬 전경 실행
  --telegram take  이 세션으로 Telegram 연결 이전 (단독 --telegram도 호환)
  --telegram off   이 세션의 Telegram 연결 비활성 (--no-telegram도 호환)
  --no-telegram    Telegram 없이 단독 실행
  --manager        기본 매니저의 별칭 (일반 대화·파일·Bash·Projectman·KB·예약)
  --sessions       실행 중인 S8 tmux 세션 목록
  --session 이름   모든 tmux 세션 종료 후 s8-이름 생성 (자동 접속 없음)
  --help, -h       이 도움말 표시
  Pi 옵션: --continue, --no-session, --model, --provider, --thinking
  에이전트 하나만 이 터미널에서 실행하려면 ./start-pi.sh를 사용한다.
  Telegram 인증: TELEGRAM_BOT_TOKEN (환경변수)
  Telegram ID·알림 대상: s8-config.yml (파일이 없으면 기존 ID 환경변수)
  작업 디렉터리: S8_KB_ROOT (기본값: ../854_md)`;

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
  console.log('실행 모드: 1) Projectman 프로젝트 관리·개발  2) 로컬 범용 에이전트');
  const selected = await prompt.ask('선택 [1/2]: ');
  if (selected === '1' || selected === 'project') return 'project';
  if (selected === '2' || selected === 'local') return 'local';
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

async function startRuntime(root, options) {
  options.session ??= options.mode === 'local' ? 's8-local' : 's8-main';
  // tmux 서버를 종료하기 전에 검증해야 잘못된 입력으로 기존 세션을 잃지 않는다.
  if (!validSession(options.session)) throw new Error('잘못된 세션 이름입니다.');
  validatePiOptions(options.args);
  console.log(`S8 런타임 시작: ${options.session} (${options.mode} 모드)`);
  const result = await restartPiRuntime(root, { ...options, resetTmux: true }, { onProgress: line => console.log(`  - ${line}`) });
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
    throw usageError('패키지 명령·--version·--print는 ./start-pi.sh로 실행하세요.');
  }
  const prompt = process.stdin.isTTY ? createPrompt() : null;
  try {
    // 모드 미지정이면 터미널에서 선택받는다.
    if (!options.mode) {
      if (!prompt) throw usageError('--mode project 또는 --mode local을 지정하세요.');
      options.mode = await chooseMode(prompt);
    }
    if (!['project', 'local'].includes(options.mode)) throw usageError('모드는 project 또는 local이어야 합니다.');
    if (options.telegram === undefined && prompt) options.telegram = await chooseTelegram(prompt);
  } finally { prompt?.close(); }
  options.cwd = await realpath(options.cwd);
  await startRuntime(root, options);
}
