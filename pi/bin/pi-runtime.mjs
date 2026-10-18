import { fileURLToPath } from 'node:url';
import { restartPiRuntime } from '../lib/pi-runtime-restart.mjs';
import { managerArgs } from '../lib/manager-launch.mjs';
import { validSession, listSessions } from '../lib/managed-sessions.mjs';
const root = fileURLToPath(new URL('../..', import.meta.url));
try {
  if (process.argv[2] === '--sessions') {
    console.log((await listSessions()).join('\n') || '실행 중인 S8 세션이 없습니다.');
  } else {
    let session, mode = 'project', cwd = process.cwd(), telegram, scheduler = true, supervisor = true;
    const args = [];
    const input = process.argv.slice(2);
    for (let i = 0; i < input.length; i++) {
      const arg = input[i];
      if (arg === '--mode') mode = input[++i];
      else if (arg === '--cwd') cwd = input[++i];
      else if (arg === '--session') session = `s8-${input[++i] ?? ''}`;
      else if (arg === '--telegram') {
        const action = input[i + 1];
        if (action === 'take' || action === 'off') { telegram = action === 'take'; i++; }
        else if (action && !action.startsWith('--')) throw new Error('--telegram은 take 또는 off를 받습니다.');
        else telegram = true;
      }
      else if (arg === '--telegram-keep') telegram = 'keep';
      else if (arg === '--no-telegram') telegram = false;
      else if (arg === '--no-scheduler') scheduler = false;
      else if (arg === '--no-supervisor') supervisor = false;
      else if (['--model', '--provider', '--thinking'].includes(arg)) args.push(arg, input[++i]);
      else args.push(arg);
    }
    session ??= mode === 'local' ? 's8-local' : 's8-main';
    if (!validSession(session)) throw new Error('잘못된 세션 이름입니다.');
    managerArgs(root, args);
    const result = await restartPiRuntime(root, { session, mode, cwd, args, scheduler, supervisor, telegram });
    console.log(`tmux 세션: ${result.session}`);
    for (const window of result.windows) console.log(`  ${result.session}:${window}`);
    if (result.workers) console.log(`개발 워커: ${result.workers.session} · ${result.workers.count}개${result.workers.deferred ? ' (진행 중 작업 또는 연결 상태 확인 필요: 수 변경 보류)' : ''}`);
    console.log(result.telegramStatus);
    console.log(`접속: tmux attach-session -t ${result.session}`);
  }
} catch (error) { console.error(`[S8] ${error.message}`); process.exitCode = 1; }
