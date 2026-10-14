#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScheduler } from '../lib/scheduler-daemon.mjs';

const agentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const root = path.join(agentRoot, '.s8-runtime', 'scheduler');
const kbRoot = process.env.S8_KB_ROOT ? path.resolve(process.env.S8_KB_ROOT) : path.resolve(agentRoot, '../854_md');
await runScheduler({ root, cwd: kbRoot, bash: process.env.S8_SCHEDULER_BASH });
console.log(`S8 scheduler running (${root})`);
