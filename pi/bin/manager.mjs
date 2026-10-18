import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { managerArgs } from '../lib/manager/launch.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
try {
  const args = managerArgs(root, process.argv.slice(2));
  const child = spawn(path.join(root, 'pi/node_modules/.bin/pi'), args, { stdio: 'inherit' });
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
  child.on('error', () => { console.error('Manager process could not start.'); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} catch (error) { console.error(error.message); process.exitCode = 2; }
