// 런타임 재시작 제어 프로세스. queuePiRuntimeRestart가 분리 실행하며, 인자는 재시작 ID 하나다.
// .s8-runtime/runtime-restarts/<id>/request.json을 읽어 재시작하고 result.json에 결과를 남긴다.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { appendFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { startPiRuntime } from '../lib/runtime/runtime.mjs';
import { progressLog, resetTmuxSessions, saveRestartResult, withRuntimeResetLock } from '../lib/runtime/restart.mjs';
import { runFullRestart, notifyFullRestart } from '../lib/runtime/full-restart.mjs';
import { runTmux } from '../lib/runtime/tmux-windows.mjs';
import { telegramOwner } from '../lib/telegram/status.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const id = process.argv[2];
if (!/^[a-f0-9-]{36}$/.test(id ?? '')) throw new Error('Invalid restart ID');
const directory = path.join(root, '.s8-runtime/runtime-restarts', id);
const options = JSON.parse(await readFile(path.join(directory, 'request.json'), 'utf8'));
// 진행 단계는 파일에 남기고, 요청한 터미널(restartPiRuntime)이 읽어 출력한다.
const log = line => appendFileSync(progressLog(directory), `${line}\n`, { mode: 0o600 });

async function restart() {
  // Telegram을 가진 세션이 사라지기 전에 'keep'(현재 소유 세션이면 유지)을 true/false로 확정한다.
  if (options.telegram === 'keep') options.telegram = (await telegramOwner()) === options.session;
  if (options.resetTmux) {
    // 이 프로세스는 분리돼 있어 호출자의 창이 종료돼도 계속 실행된다.
    log('s8-infra를 뺀 기존 tmux 세션 종료');
    await resetTmuxSessions(runTmux);
  }
  return options.all ? runFullRestart(root, { session: options.session, directory }) : startPiRuntime(root, { ...options, log });
}

try {
  const value = options.resetTmux ? await withRuntimeResetLock(root, restart) : await restart();
  await saveRestartResult(directory, { ok: true, value });
  if (options.all) await notifyFullRestart(options.notification, '선택한 모드로 재시작을 완료하고 Telegram 연결을 복구했습니다.');
} catch (error) {
  await saveRestartResult(directory, { ok: false, error: String(error.message) });
  if (options.all) await notifyFullRestart(options.notification, `전체 재시작을 완료하지 못했습니다. ${error.message}\n실행 ID: ${id}\n문제를 확인한 뒤 /restart all로 다시 요청할 수 있습니다.`);
  process.exitCode = 1;
}
