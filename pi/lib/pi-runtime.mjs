import path from 'node:path';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { telegramOwner } from './telegram-status.mjs';
import { managerArgs } from './manager-launch.mjs';
import { moveTelegram, validSession } from './managed-sessions.mjs';
import { startPiServices } from './pi-services.mjs';
import { runTmux, withTmuxLock, ensureWindow, stopWindow, windows, quote } from './tmux-windows.mjs';

export async function startPiRuntime(root, { session = 's8-main', args = [], scheduler = true, supervisor = true, telegram, mode = 'project', cwd, run = runTmux } = {}) {
  if (!validSession(session)) throw new Error('잘못된 세션 이름입니다.');
  if (!['project', 'local'].includes(mode)) throw new Error('Invalid mode');
  if (mode === 'local') { scheduler = false; supervisor = false; }
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
      try { await run(['has-session', '-t', `=${session}`]); } catch { throw error; }
    }
  }
  // Serialize complete restarts and Telegram handoffs across this checkout.
  const lock = 's8-runtime-root-' + createHash('sha256').update(root).digest('hex');
  return withTmuxLock(run, lock, async () => {
    const owner = (await run(['show-option', '-qv', '-t', session, '@s8-runtime-root'])).stdout.trim();
    if (owner !== root) throw new Error(`${session}은 이 저장소의 런타임 세션이 아닙니다. 다른 --session 이름을 사용하세요.`);
    const previousOwner = await telegramOwner();
    const savedTelegram = (await run(['show-option', '-qv', '-t', session, '@s8-telegram'])).stdout.trim();
    if (telegram === 'keep') telegram = previousOwner === session;
    telegram ??= savedTelegram ? savedTelegram === 'take' : mode === 'project';
    const savedMode = (await run(['show-option', '-qv', '-t', session, '@s8-mode'])).stdout.trim() || 'project';
    const savedCwd = (await run(['show-option', '-qv', '-t', session, '@s8-cwd'])).stdout.trim();
    cwd = await realpath(cwd ?? (savedMode === mode && savedCwd ? savedCwd : root));
    const sameProfile = savedMode === mode && (!savedCwd || savedCwd === cwd);
    const pi = (await windows(run, session)).find(window => window.name === 'pi');
    // Validate ownership before stopping anything. Other manager sessions stay alive.
    for (const window of await windows(run, session)) {
      if (['pi', ...(scheduler ? ['scheduler'] : []), ...(supervisor ? ['supervisor'] : [])].includes(window.name) && window.root !== root) throw new Error(`${session}:${window.name}은 S8이 관리하는 창이 아닙니다.`);
    }
    let launchArgs = [...args];
    if (!launchArgs.length && pi && sameProfile) {
      const saved = (await run(['show-option', '-qv', '-t', session, '@s8-pi-args'])).stdout.trim();
      if (saved) launchArgs = JSON.parse(saved);
      if (!Array.isArray(launchArgs) || launchArgs.some(value => typeof value !== 'string')) throw new Error('저장된 Pi 실행 옵션이 올바르지 않습니다.');
      managerArgs(root, launchArgs);
    }
    if (pi && sameProfile && !launchArgs.includes('--continue') && !launchArgs.includes('--no-session')) launchArgs.push('--continue');
    await stopWindow(run, root, session, 'pi');
    if (mode === 'project') await startPiServices(root, { session, scheduler, supervisor, restart: true, run });
    const command = ['bash', path.join(root, 'start-pi.sh'), '--managed', '--mode', mode, '--cwd', cwd, telegram ? '--telegram' : '--no-telegram', ...launchArgs].map(quote).join(' ');
    await run(['set-option', '-t', session, '@s8-telegram', telegram ? 'take' : 'off']);
    await run(['set-option', '-t', session, '@s8-mode', mode]);
    await run(['set-option', '-t', session, '@s8-cwd', cwd]);
    await run(['set-option', '-t', session, '@s8-pi-args', JSON.stringify(launchArgs)]);
    await ensureWindow(run, root, session, 'pi', `exec ${command}`);
    await run(['select-window', '-t', `${session}:pi`]);
    await new Promise(resolve => setTimeout(resolve, 200));
    const active = await windows(run, session);
    if (active.find(window => window.name === 'pi')?.dead !== false) throw new Error(`${session}:pi가 시작 직후 종료됐습니다. 해당 창에서 오류를 확인하세요.`);
    if (telegram) await moveTelegram(path.join(root, '.pi-runtime', `${session}.sock`));
    const currentOwner = await telegramOwner();
    const telegramStatus = currentOwner === session
      ? `Telegram: ${previousOwner && previousOwner !== session ? previousOwner + ' → ' : ''}${session} 연결`
      : `Telegram: ${currentOwner ? currentOwner + ' 연결 유지' : '연결 없음'} (이 세션: ${telegram ? '연결 대기' : '꺼짐'})`;
    return { session, windows: active.map(window => window.name), telegramStatus };
  });
}
