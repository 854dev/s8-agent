#!/usr/bin/env node
// Explicit migration only; never resets tasks, ledger, expiry, or activation state.
import { open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { agentRoot } from '../lib/telegram-config.mjs';
import { scheduleRoot, validId, validateJob } from '../lib/scheduler-store.mjs';
import { projectmanFromEnv } from '../lib/projectman-client.ts';

try {
  const [id, projectUid] = process.argv.slice(2);
  if (!validId(id) || !/^cnt_[A-Za-z0-9]+$/.test(projectUid ?? '')) throw new Error('Usage: node pi/bin/projectman-job.mjs JOB_ID PROJECT_UID');
  const root = scheduleRoot(agentRoot);
  const owner = (await readFile(path.join(root, 'owner.lock'), 'utf8')).trim().split('\n');
  if (!owner.includes('projectman-v1')) throw new Error('Restart the scheduler before converting jobs');
  process.kill(Number(owner[0]), 0);
  if ((await projectmanFromEnv().get(projectUid)).type !== 'project') throw new Error('A project UID is required');
  const file = path.join(root, 'jobs.json');
  const lock = await open(`${file}.lock`, 'wx', 0o600);
  try {
    const data = JSON.parse(await readFile(file, 'utf8'));
    if (data.version !== 1 || !Array.isArray(data.jobs)) throw new Error('Invalid scheduler jobs');
    const index = data.jobs.findIndex(job => job.id === id);
    if (index < 0) throw new Error('Existing job required; use scheduler create for a new job');
    const current = data.jobs[index];
    const job = validateJob({ ...current, kind: 'projectman', projectUid, intervalMinutes: 5, time: undefined, script: undefined });
    const { script: _script, ...metadata } = job;
    data.jobs[index] = { ...current, ...metadata, script: undefined };
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    await rename(temp, file);
    console.log(JSON.stringify({ id, kind: job.kind, projectUid, intervalMinutes: 5, enabled: job.enabled, expiresAt: job.expiresAt ?? null, rollback: 'Switch kind to shell; the original script is retained.' }));
  } finally { await lock.close(); await rm(`${file}.lock`, { force: true }); }
} catch { console.error('Projectman job conversion failed; check arguments, scheduler capability, API availability and job lock.'); process.exitCode = 1; }
