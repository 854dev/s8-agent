import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { managerArgs } from './manager-launch.mjs';
import { validSession } from './managed-sessions.mjs';
import { startPiServices } from './pi-services.mjs';
import { runTmux, withTmuxLock, ensureWindow, windows, quote } from './tmux-windows.mjs';

export async function startPiRuntime(root, { session = 's8-main', args = [], scheduler = true, supervisor = true, run = runTmux } = {}) {
  if (!validSession(session)) throw new Error('잘못된 세션 이름입니다.');
  managerArgs(root, args);
  root = await realpath(root);
  let exists = false;
  try { await run(['has-session', '-t', `=${session}`]); exists = true; } catch {}
  if (!exists) {
    try {
      await run(['new-session', '-d', '-s', session, '-n', 'shell', '-c', root,
        ';', 'set-option', '-t', session, '@s8-runtime-root', root,
        ';', 'set-option', '-t', session, '@s8-managed', '1']);
    } catch (error) {
      // Another launcher may have won the atomic session creation.
      try { await run(['has-session', '-t', `=${session}`]); } catch { throw error; }
    }
  }
  return withTmuxLock(run, `s8-runtime-${session}`, async () => {
    const owner = (await run(['show-option', '-qv', '-t', session, '@s8-runtime-root'])).stdout.trim();
    if (owner !== root) throw new Error(`${session}은 이 저장소의 런타임 세션이 아닙니다. 다른 --session 이름을 사용하세요.`);
    const pi = (await windows(run, session)).find(window => window.name === 'pi');
    if (pi && !pi.dead && args.length) throw new Error('기존 Pi 창의 실행 옵션은 변경할 수 없습니다. 해당 창을 종료한 뒤 다시 실행하세요.');
    await startPiServices(root, { session, scheduler, supervisor, run });
    const command = ['bash', path.join(root, 'start-pi.sh'), '--managed', ...args].map(quote).join(' ');
    await ensureWindow(run, root, session, 'pi', `exec ${command}`);
    await run(['select-window', '-t', `${session}:pi`]);
    await new Promise(resolve => setTimeout(resolve, 200));
    const active = await windows(run, session);
    if (active.find(window => window.name === 'pi')?.dead !== false) throw new Error(`${session}:pi가 시작 직후 종료됐습니다. 해당 창에서 오류를 확인하세요.`);
    return { session, windows: active.map(window => window.name) };
  });
}
