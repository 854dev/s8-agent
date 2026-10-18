#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { startDeveloperWorker } from '../lib/development/worker-daemon.mjs';
const worker = await startDeveloperWorker(fileURLToPath(new URL('../..', import.meta.url)), process.argv[2]);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void worker.close(); });
