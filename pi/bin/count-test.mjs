#!/usr/bin/env node
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { mcpClient, parseLedger, rejectCountTask, runCount } from '../lib/projectman-count.mjs';
import { sendTelegram } from '../lib/scheduler-daemon.mjs';
import { loadTelegramConfig } from '../lib/telegram-config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const call = mcpClient('http://100.120.50.80:3001/mcp');
const file = path.join(os.homedir(), 'projectman-result.txt');
const [action, uid, date, ...messageRest] = process.argv.slice(2);
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
} else if (action === 'reject') {
  if (!uid) throw new Error('Task UID required');
  console.log(await rejectCountTask({ call, uid, message: [date, ...messageRest].filter(Boolean).join(' '), file }));
} else if (action === 'schedule') {
  const scheduledAt = new Date(date);
  if (!date || !/[Zz]|[+-]\d{2}:\d{2}$/.test(date) || !Number.isFinite(scheduledAt.getTime())) throw new Error('Use an ISO date/time with explicit timezone, e.g. 2026-10-14T09:00:00+09:00');
  const task = await call('phcms_get_content', { uid });
  const attributes = task.attributes ?? task.detail?.attributes;
  if (task.type !== 'task' || attributes?.test !== 'count-100' || !['ready', 'todo'].includes(attributes.state)) throw new Error('Only unstarted count-test tasks can be scheduled');
  await call('phcms_update_content', { uid, attributes: { state: attributes.state, scheduledAt: scheduledAt.toISOString() } });
  console.log(`${uid}: ${scheduledAt.toISOString()}`);
} else if (action === 'away') {
  const minutes = Number(date ?? 60);
  if (!/^cnt_[A-Za-z0-9]+$/.test(uid ?? '') || !Number.isInteger(minutes) || minutes < 1 || minutes > 60) throw new Error('Use away PROJECT_UID MINUTES (1–60)');
  const runtime = path.join(root, '.s8-runtime', 'scheduler');
  const owner = (await readFile(path.join(runtime, 'owner.lock'), 'utf8')).trim().split('\n');
  if (owner[1] !== 'expiresAt-v1') throw new Error('Restart the scheduler to load operation-window limits first');
  process.kill(Number(owner[0]), 0);
  const project = await call('phcms_get_content', { uid });
  if (project.type !== 'project' || project.attributes?.test !== 'count-100' || project.attributes.minimumValue !== 0) throw new Error('Configure the count scenario and minimumValue=0 first');
  const tasks = (await list('task', uid)).filter(task => task.attributes?.test === 'count-100').sort((a, b) => a.attributes.sequence - b.attributes.sequence);
  if (tasks.length !== 3 || tasks.some((task, index) => task.attributes.sequence !== index + 1 || task.attributes.subtract !== [1, 2, 1000][index])) throw new Error('Expected the 1, 2, 1000 count scenario');
  if (!await sendTelegram(`부재중 운영 알림 연결 확인: ${project.title}. 준비 후 ${minutes}분 동안 5분마다 확인합니다. 규칙 위반 시 멈추고 질문을 보냅니다. "1000 빼기는 하지 마라"는 답변은 취소 결정으로 기록한 뒤 다음 검사에서 반영합니다.`, process.env, fetch, loadTelegramConfig(root))) throw new Error('No scheduled Telegram target is configured; operation was not started');
  const jobsFile = path.join(runtime, 'jobs.json');
  const lock = await open(`${jobsFile}.lock`, 'wx', 0o600);
  try {
    const data = JSON.parse(await readFile(jobsFile, 'utf8'));
    if (data.version !== 1 || !Array.isArray(data.jobs)) throw new Error('Invalid scheduler jobs');
    const job = data.jobs.find(job => job.id === 'projectman-count');
    if (!job) throw new Error('Run count-test setup first');
    if (job.kind === 'projectman') throw new Error('This job uses S8 prompt dispatch; update its operation window through scheduler instead of legacy count away');
    const startedAt = new Date();
    const expiresAt = new Date(startedAt.getTime() + minutes * 60_000).toISOString();
    const save = async () => {
      const temp = `${jobsFile}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
      await rename(temp, jobsFile);
    };
    job.enabled = false;
    await save();
    for (const task of tasks) {
      if (task.attributes.state !== 'ready') continue;
      if (!task.attributes.autorun) throw new Error('A ready task is not authorized for automatic execution');
      await call('phcms_update_content', { uid: task.uid, attributes: { state: 'ready', scheduledAt: startedAt.toISOString() } });
    }
    const scriptFile = path.join(runtime, 'scripts/projectman-count.sh');
    const tempScript = `${scriptFile}.${process.pid}.tmp`;
    await writeFile(tempScript, '#!/usr/bin/env bash\nset -euo pipefail\nnode "$S8_PI_CONFIG_ROOT/bin/count-test.mjs" run ' + JSON.stringify(uid) + '\n', { mode: 0o700 });
    await rename(tempScript, scriptFile);
    delete job.time;
    Object.assign(job, { intervalMinutes: 5, enabled: true, expiresAt });
    await save();
    console.log(JSON.stringify({ project: project.title, intervalMinutes: 5, startedAt: startedAt.toISOString(), expiresAt, notification: 'Telegram verified' }, null, 2));
  } finally { await lock.close(); await rm(`${jobsFile}.lock`, { force: true }); }
} else if (action === 'setup') {
  try { await writeFile(file, '100\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; parseLedger(await readFile(file, 'utf8')); }
  const workspace = await ensure('workspace', '854-workspace', '854-workspace');
  const project = await ensure('project', 'count-from-100', '100에서 출발해서 카운트하기', workspace.uid, { test: 'count-100' });
  await call('phcms_update_content', { uid: project.uid, text: '100에서 시작해 1 빼기, 2 빼기, 1000 빼기를 순서대로 검토한다. 최종 결과는 0 이상이어야 한다. 규칙을 위반하는 작업은 실행 전에 중단하고 사용자에게 확인을 요청한다. 사용자가 "1000 빼기는 하지 마라"라고 답하면 해당 작업을 취소하고 답변을 작업 로그에 남긴다. 다음 실행에서도 취소된 작업은 수행하지 않는다.', attributes: { ...project.attributes, test: 'count-100', minimumValue: 0 } });
  const tasks = [];
  const existingTasks = (await list('task', project.uid)).filter(task => task.attributes?.test === 'count-100');
  const ledger = parseLedger(await readFile(file, 'utf8'));
  for (const [index, amount] of [1, 2, 1000].entries()) {
    const existing = existingTasks.find(task => task.attributes.sequence === index + 1);
    if (existing) {
      if (existing.attributes.subtract !== amount) {
        if (!['todo', 'ready'].includes(existing.attributes.state) || ledger.ids.has(existing.uid)) throw new Error('Cannot replace an already-started subtraction; use a separate test project');
        await call('phcms_update_content', { uid: existing.uid, title: `${amount} 빼기`, slug: `count-subtract-${amount}`, attributes: { state: existing.attributes.state, subtract: amount } });
      } else if (existing.title !== `${amount} 빼기`) {
        await call('phcms_update_content', { uid: existing.uid, title: `${amount} 빼기` });
      }
      tasks.push({ ...existing, title: `${amount} 빼기` });
    } else {
      tasks.push(await ensure('task', `count-subtract-${amount}`, `${amount} 빼기`, project.uid,
        { test: 'count-100', state: 'ready', autorun: true, sequence: index + 1, subtract: amount, scheduledAt: null }));
    }
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
  console.log('Usage: node pi/bin/count-test.mjs setup | run PROJECT_UID | schedule TASK_UID ISO_DATETIME | reject TASK_UID USER_MESSAGE | away PROJECT_UID MINUTES');
}
