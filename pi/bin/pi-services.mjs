import { fileURLToPath } from 'node:url';
import { startPiServices } from '../lib/pi-services.mjs';
const root = fileURLToPath(new URL('../..', import.meta.url));
try {
  const results = await startPiServices(root, { scheduler: !process.argv.includes('--no-scheduler'), supervisor: !process.argv.includes('--no-supervisor') });
  for (const item of results) console.error(`[S8] ${item.service}: ${item.reused ? '기존 실행 사용' : '시작'} (${item.session ?? `PID ${item.pid}`})`);
} catch (error) { console.error(`[S8] ${error.message}`); process.exitCode = 1; }
