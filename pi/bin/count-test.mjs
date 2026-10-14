#!/usr/bin/env node
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { mcpClient, parseLedger, runCount } from '../lib/projectman-count.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const call = mcpClient('http://100.120.50.80:3001/mcp');
const file = path.join(os.homedir(), 'projectman-result.txt');
const [action, uid, date] = process.argv.slice(2);
const list = async (type, parentUid) => {
  const result = await call('phcms_list_contents', { channelSlug: 'ph-projectman', type, ...(parentUid ? { parentUid } : {}), limit: 100 });
  if (result.total > 100) throw new Error('Narrow the test setup scope');
  return result.items;
};
const ensure = async (type, slug, title, parentUid, attributes = {}) => {
  const items = await list(type, parentUid);
  const existing = items.find(item => item.slug === slug);
  if (existing) return existing;
  return call('phcms_create_content', { channelSlug: 'ph-projectman', type, slug, title, ...(parentUid ? { parentUid } : {}), attributes, status: 'published' });
};

if (action === 'run') {
  if (!uid) throw new Error('Project UID required');
  console.log(await runCount({ call, projectUid: uid, file }));
} else if (action === 'schedule') {
  const scheduledAt = new Date(date);
  if (!date || !/[Zz]|[+-]\d{2}:\d{2}$/.test(date) || !Number.isFinite(scheduledAt.getTime())) throw new Error('Use an ISO date/time with explicit timezone, e.g. 2026-10-14T09:00:00+09:00');
  const task = await call('phcms_get_content', { uid });
  const attributes = task.attributes ?? task.detail?.attributes;
  if (task.type !== 'task' || attributes?.test !== 'count-100' || !['ready', 'todo'].includes(attributes.state)) throw new Error('Only unstarted count-test tasks can be scheduled');
  await call('phcms_update_content', { uid, attributes: { state: attributes.state, scheduledAt: scheduledAt.toISOString() } });
  console.log(`${uid}: ${scheduledAt.toISOString()}`);
} else if (action === 'setup') {
  try { await writeFile(file, '100\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; parseLedger(await readFile(file, 'utf8')); }
  const workspace = await ensure('workspace', '854-workspace', '854-workspace');
  const project = await ensure('project', 'count-from-100', '100에서 출발해서 카운트하기', workspace.uid, { test: 'count-100' });
  const tasks = [];
  for (const amount of [1, 2, 3]) {
    tasks.push(await ensure('task', `count-subtract-${amount}`, `${amount}씩 줄이기`, project.uid,
      { test: 'count-100', state: 'ready', autorun: true, sequence: amount, subtract: amount, scheduledAt: null }));
  }
  const runtime = path.join(root, '.s8-runtime', 'scheduler');
  await mkdir(path.join(runtime, 'scripts'), { recursive: true, mode: 0o700 });
  const jobsFile = path.join(runtime, 'jobs.json');
  const lock = await open(`${jobsFile}.lock`, 'wx', 0o600);
  try {
    let data = { version: 1, jobs: [] };
    try { data = JSON.parse(await readFile(jobsFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (data.version !== 1 || !Array.isArray(data.jobs)) throw new Error('Invalid jobs file');
    if (!data.jobs.some(job => job.id === 'projectman-count')) {
      const script = '#!/usr/bin/env bash\nset -euo pipefail\nnode "$S8_PI_CONFIG_ROOT/bin/count-test.mjs" run ' + JSON.stringify(project.uid) + '\n';
      await writeFile(path.join(runtime, 'scripts/projectman-count.sh'), script, { flag: 'wx', mode: 0o700 });
      data.jobs.push({ id: 'projectman-count', intervalMinutes: 30, timezone: 'Asia/Seoul', enabled: true });
      const temp = `${jobsFile}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
      await rename(temp, jobsFile);
    }
  } finally { await lock.close(); await rm(`${jobsFile}.lock`, { force: true }); }
  console.log(JSON.stringify({ workspaceUid: workspace.uid, projectUid: project.uid, tasks: tasks.map(task => ({ uid: task.uid, title: task.title })), job: 'projectman-count', file }, null, 2));
} else {
  console.log('Usage: node pi/bin/count-test.mjs setup | run PROJECT_UID | schedule TASK_UID ISO_DATETIME');
}
