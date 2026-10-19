import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { startPiRuntime } from '../lib/runtime/runtime.mjs';
import { saveRestartResult, withRuntimeResetLock } from '../lib/runtime/restart.mjs';
import { runFullRestart, notifyFullRestart } from '../lib/runtime/full-restart.mjs';
import { runTmux } from '../lib/runtime/tmux-windows.mjs';
import { telegramOwner } from '../lib/telegram/status.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const id = process.argv[2];
if (!/^[a-f0-9-]{36}$/.test(id ?? '')) throw new Error('Invalid restart ID');
const directory = path.join(root, '.s8-runtime/runtime-restarts', id);
const options = JSON.parse(await readFile(path.join(directory, 'request.json'), 'utf8'));
async function restart() {
  if (options.resetTmux) {
    // Resolve “keep” before destroying the session that owns Telegram.
    if (options.telegram === 'keep') options.telegram = (await telegramOwner()) === options.session;
    // This controller is detached, so killing the caller's pane cannot stop it.
    try { await runTmux(['kill-server']); }
    catch (error) {
      if (!/no server running|no sessions|No such file or directory/i.test(error.stderr ?? '')) throw error;
    }
  }
  return options.all ? runFullRestart(root, options, directory) : startPiRuntime(root, options);
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
