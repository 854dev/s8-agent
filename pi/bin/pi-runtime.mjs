// start-pi.sh 대화형 실행의 진입점. 옵션을 해석해 tmux 런타임 재시작을 요청하고 결과 창 목록을 출력한다.
//   node pi/bin/pi-runtime.mjs --sessions       실행 중인 S8 세션 목록만 출력
//   node pi/bin/pi-runtime.mjs [옵션] [Pi 옵션]  tmux 서버를 초기화하고 런타임 시작
import { fileURLToPath } from 'node:url';
import { restartPiRuntime } from '../lib/runtime/restart.mjs';
import { managerArgs } from '../lib/manager/launch.mjs';
import { validSession, listSessions } from '../lib/runtime/managed-sessions.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));

/** 런타임 옵션은 소비하고 나머지는 Pi 인자(args)로 넘긴다. */
function parseOptions(input) {
  const options = { mode: 'project', cwd: process.cwd(), scheduler: true, supervisor: true, args: [] };
  for (let i = 0; i < input.length; i++) {
    const arg = input[i];
    if (arg === '--mode') options.mode = input[++i];
    else if (arg === '--cwd') options.cwd = input[++i];
    else if (arg === '--session') options.session = `s8-${input[++i] ?? ''}`;
    else if (arg === '--telegram') {
      // --telegram take|off. 값 없는 --telegram은 take로 본다.
      const action = input[i + 1];
      if (action === 'take' || action === 'off') { options.telegram = action === 'take'; i++; }
      else if (action && !action.startsWith('--')) throw new Error('--telegram은 take 또는 off를 받습니다.');
      else options.telegram = true;
    }
    else if (arg === '--telegram-keep') options.telegram = 'keep';
    else if (arg === '--no-telegram') options.telegram = false;
    else if (arg === '--no-scheduler') options.scheduler = false;
    else if (arg === '--no-supervisor') options.supervisor = false;
    else if (['--model', '--provider', '--thinking'].includes(arg)) options.args.push(arg, input[++i]);
    else options.args.push(arg);
  }
  options.session ??= options.mode === 'local' ? 's8-local' : 's8-main';
  return options;
}

try {
  if (process.argv[2] === '--sessions') {
    console.log((await listSessions()).join('\n') || '실행 중인 S8 세션이 없습니다.');
  } else {
    const options = parseOptions(process.argv.slice(2));
    if (!validSession(options.session)) throw new Error('잘못된 세션 이름입니다.');
    managerArgs(root, options.args);
    // resetTmux: 기존 tmux 서버의 모든 세션을 종료한 뒤 새로 만든다.
    const result = await restartPiRuntime(root, { ...options, resetTmux: true });
    console.log(`tmux 세션: ${result.session}`);
    for (const window of result.windows) console.log(`  ${result.session}:${window}`);
    const { workers } = result;
    if (workers) {
      console.log(`개발 워커: ${workers.count}개 등록${workers.session ? ` · ${workers.session}` : ''}${workers.deferred ? ' (워커 종료·연결 확인 후 설정 적용)' : ''}`);
      for (const worker of workers.remoteWorkers ?? []) console.log(`  ${worker.workerId}: SSH ${worker.status}`);
    }
    console.log(result.telegramStatus);
    console.log(`접속: tmux attach-session -t ${result.session}`);
  }
} catch (error) { console.error(`[S8] ${error.message}`); process.exitCode = 1; }
