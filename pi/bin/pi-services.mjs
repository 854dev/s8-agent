import { fileURLToPath } from 'node:url';
import { startPiServices } from '../lib/pi-services.mjs';
const root = fileURLToPath(new URL('../..', import.meta.url));
try {
  const index = process.argv.indexOf('--session');
  const session = index < 0 ? 's8-main' : process.argv[index + 1];
  const results = await startPiServices(root, { session, scheduler: !process.argv.includes('--no-scheduler'), supervisor: !process.argv.includes('--no-supervisor') });
  for (const item of results) console.error(`[S8] ${item.service}: ${item.reused ? '기존 실행 사용' : '시작'} (${item.session}:${item.window})`);
} catch (error) { console.error(`[S8] ${error.message}`); process.exitCode = 1; }
