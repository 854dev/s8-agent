import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { startPiRuntime } from '../lib/pi-runtime.mjs';
import { saveRestartResult } from '../lib/pi-runtime-restart.mjs';
import { runFullRestart, notifyFullRestart } from '../lib/full-restart.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const id = process.argv[2];
if (!/^[a-f0-9-]{36}$/.test(id ?? '')) throw new Error('Invalid restart ID');
const directory = path.join(root, '.s8-runtime/runtime-restarts', id);
const options = JSON.parse(await readFile(path.join(directory, 'request.json'), 'utf8'));
try {
  const value = options.all ? await runFullRestart(root, options, directory) : await startPiRuntime(root, options);
  await saveRestartResult(directory, { ok: true, value });
  if (options.all) await notifyFullRestart(options.notification, '선택한 모드로 재시작을 완료하고 Telegram 연결을 복구했습니다.');
} catch (error) {
  await saveRestartResult(directory, { ok: false, error: String(error.message) });
  if (options.all) await notifyFullRestart(options.notification, `전체 재시작을 완료하지 못했습니다. ${error.message}\n실행 ID: ${id}\n문제를 확인한 뒤 /restart all로 다시 요청할 수 있습니다.`);
  process.exitCode = 1;
}
