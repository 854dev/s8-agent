import { fileURLToPath } from 'node:url';
import { restartPiRuntime } from '../lib/pi-runtime-restart.mjs';
import { managerArgs } from '../lib/manager-launch.mjs';
import { validSession, listSessions } from '../lib/managed-sessions.mjs';
const root = fileURLToPath(new URL('../..', import.meta.url));
try {
  if (process.argv[2] === '--sessions') {
    console.log((await listSessions()).join('\n') || '실행 중인 S8 세션이 없습니다.');
  } else {
    let session = 's8-main', telegram = true, scheduler = true, supervisor = true;
    const args = [];
    const input = process.argv.slice(2);
    for (let i = 0; i < input.length; i++) {
      const arg = input[i];
      if (arg === '--session') session = `s8-${input[++i] ?? ''}`;
      else if (arg === '--telegram') telegram = true;
      else if (arg === '--no-telegram') telegram = false;
      else if (arg === '--no-scheduler') scheduler = false;
      else if (arg === '--no-supervisor') supervisor = false;
      else if (['--model', '--provider', '--thinking'].includes(arg)) args.push(arg, input[++i]);
      else args.push(arg);
    }
    if (!validSession(session)) throw new Error('잘못된 세션 이름입니다.');
    managerArgs(root, args);
    const result = await restartPiRuntime(root, { session, args, scheduler, supervisor, telegram });
    console.log(`tmux 세션: ${result.session}`);
    for (const window of result.windows) console.log(`  ${result.session}:${window}`);
    console.log(`접속: tmux attach-session -t ${result.session}`);
  }
} catch (error) { console.error(`[S8] ${error.message}`); process.exitCode = 1; }
