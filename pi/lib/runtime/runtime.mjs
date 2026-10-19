// 매니저 런타임 시작: tmux 세션 <session>에 pi 창(매니저 Pi)과 공유 서비스 창을 띄운다.
// 실행 설정은 세션 옵션에 기록해 /restart all(savedRuntimeOptions)과 Pi 창 내부(start-pi.sh --managed)가 읽는다.
//   @s8-runtime-root 소유 저장소  @s8-managed 관리 세션 표시  @s8-mode project|local
//   @s8-cwd 작업 디렉터리  @s8-telegram take|off  @s8-pi-args Pi 실행 인자(JSON)
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { telegramOwner } from '../telegram/status.mjs';
import { managerArgs } from '../manager/launch.mjs';
import { moveTelegram, validSession } from './managed-sessions.mjs';
import { startPiServices } from './services.mjs';
import { sleep } from './process.mjs';
import { runTmux, withTmuxLock, ensureSession, ensureWindow, stopWindow, windows, quote, lockName, sessionOption } from './tmux-windows.mjs';

/** 실행 중인 세션에 기록된 설정을 읽어, 같은 대화를 이어가는(--continue) startPiRuntime 옵션으로 돌려준다. 인자 검증은 startPiRuntime이 한다. */
export async function savedRuntimeOptions(session, { run = runTmux } = {}) {
  const option = name => sessionOption(run, session, name);
  const mode = await option('@s8-mode') || 'project';
  const cwd = await option('@s8-cwd') || undefined;
  const telegram = await option('@s8-telegram') === 'take';
  const saved = await option('@s8-pi-args');
  const args = saved ? JSON.parse(saved) : [];
  if (!Array.isArray(args) || args.some(value => typeof value !== 'string')) throw new Error('저장된 Pi 실행 옵션이 올바르지 않습니다.');
  if (!args.includes('--continue') && !args.includes('--no-session')) args.push('--continue');
  return { session, mode, cwd, telegram, args };
}

/**
 * Pi 런타임을 (재)시작하고 { session, windows, telegramStatus, workers }를 돌려준다.
 * telegram: true면 이 세션으로 Telegram을 가져오고, false면 끈다. 생략하면 project 모드만 켠다.
 * local 모드는 공유 서비스를 시작하지 않는다.
 */
export async function startPiRuntime(root, { session = 's8-main', mode = 'project', cwd, args = [], telegram, scheduler = true, supervisor = true, run = runTmux } = {}) {
  if (!validSession(session)) throw new Error('잘못된 세션 이름입니다.');
  if (!['project', 'local'].includes(mode)) throw new Error('Invalid mode');
  managerArgs(root, args);
  root = await realpath(root);
  cwd = await realpath(cwd ?? root);
  telegram ??= mode === 'project';
  await ensureSession(run, root, session);

  // 같은 체크아웃의 재시작과 Telegram 이전을 직렬화한다.
  return withTmuxLock(run, lockName('s8-runtime-root-', root), async () => {
    // 무엇이든 중지하기 전에 다시 띄울 창이 모두 이 저장소 소유인지 확인한다.
    const managed = mode === 'project' ? ['pi', ...(scheduler ? ['scheduler'] : []), ...(supervisor ? ['supervisor'] : [])] : ['pi'];
    for (const window of await windows(run, session)) {
      if (managed.includes(window.name) && window.root !== root) throw new Error(`${session}:${window.name}은 S8이 관리하는 창이 아닙니다.`);
    }
    const previousOwner = await telegramOwner();

    await stopWindow(run, root, session, 'pi');
    const services = mode === 'project' ? await startPiServices(root, { session, scheduler, supervisor, run }) : [];
    const workers = services.find(service => service.service === 'workers');

    const settings = { '@s8-telegram': telegram ? 'take' : 'off', '@s8-mode': mode, '@s8-cwd': cwd, '@s8-pi-args': JSON.stringify(args) };
    for (const [name, value] of Object.entries(settings)) await run(['set-option', '-t', session, name, value]);
    const command = ['bash', path.join(root, 'start-pi.sh'), '--managed', '--mode', mode, '--cwd', cwd, telegram ? '--telegram' : '--no-telegram', ...args].map(quote).join(' ');
    await ensureWindow(run, root, session, 'pi', `exec ${command}`);
    await run(['select-window', '-t', `${session}:pi`]);

    // 잘못된 인자 등으로 즉시 종료되는 경우를 잡기 위해 잠시 뒤 상태를 확인한다.
    await sleep(200);
    const active = await windows(run, session);
    if (active.find(window => window.name === 'pi')?.dead !== false) throw new Error(`${session}:pi가 시작 직후 종료됐습니다. 해당 창에서 오류를 확인하세요.`);

    if (telegram) await moveTelegram(path.join(root, '.pi-runtime', `${session}.sock`));
    const currentOwner = await telegramOwner();
    const telegramStatus = currentOwner === session
      ? `Telegram: ${previousOwner && previousOwner !== session ? previousOwner + ' → ' : ''}${session} 연결`
      : `Telegram: ${currentOwner ? currentOwner + ' 연결 유지' : '연결 없음'} (이 세션: ${telegram ? '연결 대기' : '꺼짐'})`;
    return { session, windows: active.map(window => window.name), telegramStatus, workers };
  });
}
