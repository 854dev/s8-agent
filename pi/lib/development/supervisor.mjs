import { enqueueManagerMessage } from '../manager/inbox.mjs';
import { saveJson } from '../storage/json-file.mjs';
import { requireConfirmedPlan } from '../projectman/preflight.mjs';
import { workerRequest, workerStates, processAlive } from './worker-pool.mjs';
import { loadS8Config } from '../config/s8-config.mjs';
import { sendTelegram } from '../telegram/notify.mjs';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, open, rm, lstat } from 'node:fs/promises';
import path from 'node:path';

import { prepareWorktree, workspaceChanges, workspacePatch, importDevelopmentResults } from './workspace.mjs';

async function projectGuidelines(worktree) {
  const instructions = []; let visited = 0;
  const relevant = () => true;
  async function visit(dir) {
    if (++visited > 1000) throw new Error('Project instruction scope too large');
    for (const filename of ['AGENTS.md', 'CLAUDE.md']) {
      try {
        const relative = path.join(dir, filename), file = path.join(worktree, relative), stat = await lstat(file);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 50000) throw new Error('Project instruction path is not safe');
        instructions.push({ path: relative, text: await readFile(file, 'utf8') });
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    for (const entry of await readdir(path.join(worktree, dir), { withFileTypes: true })) {
      const relative = path.join(dir, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules' && relevant(relative)) await visit(relative);
    }
  }
  await visit(''); return instructions;
}

export async function loadDevelopmentPolicy(root) {
  return { maxConcurrency: loadS8Config(root).workers.count, commands: {} };
}
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
export function reportForServer(value) {
  const strings = values => (Array.isArray(values) ? values : []).slice(0, 100).map(item => String(item).trim().slice(0, 3000)).filter(Boolean);
  const report = { status: value?.status === 'completed' ? 'completed' : 'failed', summary: String(value?.summary ?? '').trim().slice(0, 8000) || 'No valid development summary was returned.', changedFiles: value?.changedFiles ?? [], verification: (value?.verification ?? []).slice(-20).map(item => ({ name: String(item.name).slice(0, 100), ok: item.ok === true, summary: String(item.summary ?? '').slice(0, 1000) })), remainingItems: strings(value?.remainingItems), decisions: strings(value?.decisions), executionErrors: strings(value?.executionErrors), checkpoint: String(value?.checkpoint ?? '').slice(0, 16000), ...(value?.baseCommit ? { baseCommit: value.baseCommit } : {}) };
  if (['failed', 'blocked'].includes(report.status) && !report.executionErrors.length) report.executionErrors = [report.summary.slice(0, 3000)];
  if (report.status === 'completed' && (report.remainingItems.length || report.executionErrors.length || report.verification.some(check => !check.ok))) report.status = 'failed';
  return report;
}

export async function runDeveloper(request, { signal } = {}) {
  const { root, workerId, run } = request;
  const assign = { action: 'assign', uid: request.task.uid, runId: run.runId };
  try { await workerRequest(root, workerId, assign); }
  catch {
    // A lost acknowledgement must not result in another assignment or a second execution.
    const state = await workerRequest(root, workerId, { action: 'status' });
    if (state.runId !== run.runId) throw new Error('Worker assignment was not accepted');
  }
  let cancelSent = false;
  while (true) {
    let state;
    try {
      if (signal?.aborted && !cancelSent) {
        await workerRequest(root, workerId, { action: 'cancel', runId: run.runId }); cancelSent = true;
      }
      state = await workerRequest(root, workerId, { action: 'status' });
    } catch {
      const saved = (await workerStates(root)).find(item => item.workerId === workerId);
      if (!saved?.alive || saved.runId !== run.runId) throw new Error('Assigned worker exited');
      // Keep ownership while a live worker is temporarily unreachable.
      await new Promise(resolve => setTimeout(resolve, 1000)); continue;
    }
    if (state.runId !== run.runId) throw new Error('Worker assignment changed');
    if (state.status === 'reported') return { report: await readJson(path.join(run.directory, 'worker-result.json')), workerPid: state.pid };
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

export function workLink(publicUrl, uid, runId) {
  if (!publicUrl) return null;
  const url = new URL(publicUrl);
  url.searchParams.set('task', uid);
  url.searchParams.set('run', runId);
  return url.href;
}

const flushing = new Map();
export function flushDevelopmentOutbox(options) {
  const previous = flushing.get(options.root) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => flushOutbox(options));
  flushing.set(options.root, next);
  return next.finally(() => { if (flushing.get(options.root) === next) flushing.delete(options.root); });
}

async function flushOutbox({ root, client, notify = sendTelegram, settings = loadS8Config(root) }) {
  const runs = path.join(root, '.s8-runtime/runs');
  let directories;
  try { directories = await readdir(runs); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const outcomes = [];
  for (const runId of directories) {
    if (!/^[a-f0-9-]{36}$/.test(runId)) continue;
    const directory = path.join(runs, runId), file = path.join(directory, 'outbox.json');
    let pending;
    try { pending = await readJson(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (pending.conflict || (pending.delivered && pending.managerDelivered && pending.telegramDelivered)) continue;
    // Legacy delivered records have already been processed; do not notify every historical run.
    if (pending.delivered && !pending.version) continue;
    try {
      if (!pending.delivered) {
        const delivered = await client.workflow(pending.uid, pending.operation);
        await saveJson(path.join(directory, 'result.json'), { ...pending.report, projectman: delivered, runId });
        pending = { ...pending, delivered: true, state: delivered.state };
        await saveJson(file, pending);
        outcomes.push({ runId, delivered: true });
      }
      if (!pending.managerDelivered) {
        await enqueueManagerMessage(root, runId, { uid: pending.uid, runId, state: pending.state, summary: pending.report.summary });
        pending.managerDelivered = true;
        await saveJson(file, pending);
      }
      if (pending.version && !pending.telegramDelivered) {
        const link = workLink(settings.publicUrl, pending.uid, runId);
        if (!link || !settings.telegram.scheduleChatId) {
          pending.notificationStatus = 'not_configured';
        } else {
          const checks = (pending.report.verification ?? []).map(check => `${check.ok ? '통과' : '실패'}: ${check.name}`).join(', ');
          const message = `${pending.report.status === 'completed' ? '✅ 개발 완료 · 최종 확인 대기' : '⚠️ 작업 실패'}: ${pending.title ?? pending.uid}\n${pending.report.summary.slice(0, 1800)}\n검증: ${checks.slice(0, 500) || '기록 없음'}\n${link}`;
          pending.telegramDelivered = await notify(message, process.env, fetch, settings.telegram);
          pending.notificationStatus = pending.telegramDelivered ? 'sent' : 'not_configured';
        }
        await saveJson(file, pending);
      }
      if (pending.version && !pending.telegramDelivered) outcomes.push({ runId, notificationStatus: pending.notificationStatus });
    } catch (error) {
      if (!pending.delivered && /HTTP (409|404)/.test(error.message)) pending.conflict = true;
      else if (pending.delivered) pending.notificationStatus = 'pending';
      await saveJson(file, pending);
      outcomes.push({ runId, delivered: pending.delivered === true, conflict: pending.conflict === true });
    }
  }
  return outcomes;
}

export async function runDevelopmentTask({ root, client, candidate, policy, signal, worker = runDeveloper, allowedRoot, workerId }) {
  const locks = path.join(root, '.s8-runtime/development-locks');
  await mkdir(locks, { recursive: true, mode: 0o700 });
  const lockPath = path.join(locks, `${candidate.uid}.json`);
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); } catch (error) { if (error.code === 'EEXIST') return { status: 'locked', uid: candidate.uid }; throw error; }
  const runId = randomUUID();
  const controller = new AbortController();
  const abort = () => controller.abort();
  let poll, directory, claimed, workspace, inputTree, taskTitle = candidate.uid, stage = 'prepare';
  try {
    await lock.writeFile(JSON.stringify({ runId, workerId, supervisorPid: process.pid }));
    const task = await client.getWorkflow(candidate.uid);
    taskTitle = task.title ?? candidate.uid;
    const assignee = task.workflow?.assignment?.assignee ?? task.workflow?.spec?.assignee;
    if (assignee && workerId && assignee !== workerId) return { status: 'idle', uid: candidate.uid };
    if (task.workflow?.run || task.executionAllowed === false || task.state !== 'ready' || !task.workflow?.grant || task.workflow.review?.pending || (task.workflow.review && task.workflow.followup?.reviewId !== task.workflow.review.id)) return { status: 'idle', uid: candidate.uid };
    let preflight;
    try { preflight = await requireConfirmedPlan(client, candidate.uid); } catch (error) { if (/HTTP 409/.test(error.message)) return { status: 'preflight_required', uid: candidate.uid }; throw error; }
    if (signal?.aborted) return { status: 'stopped', uid: candidate.uid };
    directory = path.join(root, '.s8-runtime/runs', runId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const claim = { action: 'claim', expectedRevision: task.workflow.revision, requestId: randomUUID(), runId, workerId: workerId ?? 's8-developer' };
    await saveJson(path.join(directory, 'claim.json'), { uid: candidate.uid, operation: claim });
    claimed = await client.workflow(candidate.uid, claim);
    await saveJson(path.join(directory, 'request.json'), { task: { ...task, workflow: claimed.workflow }, run: { runId, directory } });
    stage = 'workspace';
    workspace = await prepareWorktree({ root, uid: candidate.uid, repoPath: task.workflow.spec.repoPath });
    stage = 'dependency artifacts';
    const children = claimed.workflow.integration ? await client.list('subtask', candidate.uid) : [];
    const requested = [...(task.workflow.spec.dependsOn ?? []), ...children.filter(child => child.detail?.attributes.state === 'done').map(child => child.uid)];
    const ordered = [], visited = new Set();
    async function visit(uid) {
      if (visited.has(uid)) return;
      visited.add(uid);
      if (visited.size > 200) throw new Error('Dependency context too large');
      const dependency = await client.getWorkflow(uid);
      for (const prior of dependency.workflow?.spec?.dependsOn ?? []) await visit(prior);
      if (dependency.workflow?.spec?.repoPath === task.workflow.spec.repoPath) ordered.push(dependency);
    }
    for (const uid of requested) await visit(uid);
    inputTree = await importDevelopmentResults({ root, worktree: workspace.worktree, tasks: ordered });
    const run = { runId, directory, workspace: workspace.worktree };
    const projectInstructions = await projectGuidelines(workspace.worktree);
    let executionNotes = '';
    const previousId = task.workflow.run?.id;
    if (previousId && /^[a-f0-9-]{36}$/.test(previousId)) {
      try {
        const events = (await readFile(path.join(root, '.s8-runtime/runs', previousId, 'developer.events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
        executionNotes = events.filter(event => event.type === 'assistant' && event.text).map(event => event.text).join('\n').slice(-8000);
      } catch { /* Durable result remains available if the previous transcript is missing. */ }
    }
    const request = { root, run, workerId, inputTree, task: { ...task, workflow: { ...claimed.workflow, runs: undefined, result: undefined } }, preflight: preflight.preflight, policy, previous: { ...task.workflow.result, executionNotes }, baseCommit: workspace.baseCommit, projectInstructions };
    await saveJson(path.join(directory, 'request.json'), request);
    let polling = false;
    poll = setInterval(async () => {
      if (polling) return; polling = true;
      try {
        const fresh = await client.getWorkflow(candidate.uid);
        if (fresh.state !== 'doing' || fresh.workflow.run?.id !== runId || fresh.executionAllowed === false) { controller.stopReason = 'revoked'; abort(); }
      } catch { /* A transient API outage is not a work execution deadline. */ }
      finally { polling = false; }
    }, 1500);
    stage = 'developer execution';
    const outcome = await worker(request, { signal: controller.signal });
    const changes = await workspaceChanges(run.workspace);
    stage = 'artifact export';
    await writeFile(path.join(directory, 'task.patch'), await workspacePatch(run.workspace, inputTree), { mode: 0o600 });
    await writeFile(path.join(directory, 'changes.patch'), await workspacePatch(run.workspace), { mode: 0o600 });
    if (outcome.report.status === 'completed' && (task.workflow.spec.commandNames ?? []).some(name => name !== 'install' && !outcome.report.verification?.some(check => check.name === name && check.ok))) {
      outcome.report = { ...outcome.report, status: 'failed', executionErrors: ['Required verification is missing from the report'] };
    }
    let report = reportForServer({ ...outcome.report, baseCommit: workspace.baseCommit, changedFiles: changes.changedFiles });
    if (controller.signal.aborted) report = reportForServer({ ...report, status: 'failed', checkpoint: report.checkpoint || 'Resume saved workspace and execution events.', summary: `Execution stopped; inspect the checkpoint before resuming. ${report.summary}`.slice(0, 8000), changedFiles: changes.changedFiles, verification: report.verification });
    await saveJson(path.join(directory, 'outbox.json'), { version: 2, uid: candidate.uid, title: taskTitle, runId, report, operation: { action: 'report', requestId: randomUUID(), expectedRevision: claimed.workflow.revision, runId, report } });
    await flushDevelopmentOutbox({ root, client });
    return { status: report.status, uid: candidate.uid, runId, worktree: run.workspace };
  } catch (error) {
    if (claimed && directory) {
      let changes = { changedFiles: [] };
      if (workspace) {
        try {
          changes = await workspaceChanges(workspace.worktree);
          await writeFile(path.join(directory, 'changes.patch'), await workspacePatch(workspace.worktree), { mode: 0o600 });
        } catch { /* Preserve the workspace for inspection when export itself failed. */ }
      }
      const report = reportForServer({ status: 'failed', summary: `Supervisor stopped during ${stage}; saved workspace and events remain available.`, executionErrors: [`Execution failed during ${stage}`], remainingItems: ['Inspect saved artifacts and finish the confirmed plan'], changedFiles: changes.changedFiles, verification: [] });
      await saveJson(path.join(directory, 'outbox.json'), { version: 2, uid: candidate.uid, title: taskTitle, runId, report, operation: { action: 'report', requestId: randomUUID(), expectedRevision: claimed.workflow.revision, runId, report } });
      await flushDevelopmentOutbox({ root, client });
    }

    return { status: /HTTP 409/.test(error.message) ? 'conflict' : 'blocked', uid: candidate.uid };
  } finally {
    clearInterval(poll);
    signal?.removeEventListener('abort', abort);
    await lock.close();
    if (!claimed) {
      // A claim may have committed despite a lost response. Keep its durable request for recovery.
      let uncertain = false;
      if (directory) { try { await readJson(path.join(directory, 'claim.json')); uncertain = true; } catch {} }
      if (!uncertain) await rm(lockPath, { force: true });
    } else {
      let pending;
      try { pending = await readJson(path.join(directory, 'outbox.json')); } catch {}
      if (pending?.delivered || pending?.conflict) {
        let released = true;
        if (workerId && worker === runDeveloper) released = await workerRequest(root, workerId, { action: 'release', runId }).then(() => true, () => false);
        if (released) await rm(lockPath, { force: true });
      }
    }
  }
}

const activeSlots = new Map();
const finishedRuns = [];

export async function developmentTick({ root, client, policy, signal, worker, allowedRoot, projectUid }) {
  root = path.resolve(root);
  await flushDevelopmentOutbox({ root, client });
  let candidates = [...await client.list('task', undefined, { state: 'ready' }), ...await client.list('subtask', undefined, { state: 'ready' })]
    .filter(item => item.detail?.attributes.workflow?.version === 2 && item.detail.attributes.workflow.grant)
    .sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')) || a.uid.localeCompare(b.uid));
  if (projectUid) {
    const selected = [];
    for (const candidate of candidates) {
      const content = await client.get(candidate.uid);
      const project = content.type === 'task' ? content.parent?.uid : content.parent?.uid ? (await client.get(content.parent.uid)).parent?.uid : undefined;
      if (project === projectUid) selected.push(candidate);
    }
    candidates = selected;
  }
  const slots = worker ? Array.from({ length: policy.maxConcurrency }, (_, i) => ({ workerId: `worker-${i + 1}`, alive: true, status: 'idle' })) : await workerStates(root, policy.maxConcurrency);
  const results = worker ? [] : finishedRuns.splice(0);
  for (const slot of slots.filter(slot => slot.alive && slot.status === 'idle' && Number(slot.workerId.slice(7)) <= policy.maxConcurrency)) {
    const key = `${root}:${slot.workerId}`;
    if (!worker && activeSlots.has(key)) continue;
    const execute = async () => {
      while (candidates.length && !signal?.aborted) {
        const index = candidates.findIndex(item => {
          const assigned = item.detail?.attributes.workflow?.assignment?.assignee ?? item.detail?.attributes.workflow?.spec?.assignee;
          return !assigned || assigned === slot.workerId;
        });
        if (index < 0) break;
        const [candidate] = candidates.splice(index, 1);
        const result = await runDevelopmentTask({ root, client, candidate, policy, signal, worker, workerId: slot.workerId, allowedRoot });
        (worker ? results : finishedRuns).push(result);
        if (!worker && !['idle', 'locked', 'conflict', 'preflight_required'].includes(result.status)) break;
      }
    };
    if (worker) results.push(execute());
    else {
      const task = execute().catch(() => finishedRuns.push({ status: 'failed', workerId: slot.workerId })).finally(() => activeSlots.delete(key));
      activeSlots.set(key, task);
    }
  }
  if (worker) {
    const running = results.filter(item => item instanceof Promise);
    await Promise.all(running);
    for (const promise of running) results.splice(results.indexOf(promise), 1);
  }
  return results;
}

export async function waitForDevelopmentRuns(root) {
  root = path.resolve(root);
  await Promise.all([...activeSlots].filter(([key]) => key.startsWith(`${root}:`)).map(([, task]) => task));
}

export async function recoverDevelopmentRuns({ root, client }) {
  root = path.resolve(root);
  const locks = path.join(root, '.s8-runtime/development-locks');
  let files;
  try { files = await readdir(locks); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const outcomes = [];
  for (const file of files) {
    if (!/^[a-zA-Z0-9_-]+\.json$/.test(file)) continue;
    const lockFile = path.join(locks, file);
    let lock;
    try { lock = await readJson(lockFile); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (lock.workerId && activeSlots.has(`${root}:${lock.workerId}`)) continue;
    const uid = file.slice(0, -5), directory = path.join(root, '.s8-runtime/runs', lock.runId);
    let pending;
    try { pending = await readJson(path.join(directory, 'outbox.json')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    let state;
    if (lock.workerId) state = await workerRequest(root, lock.workerId, { action: 'status' }).catch(() => null);
    if (state?.runId === lock.runId && ['busy', 'accepting'].includes(state.status)) {
      outcomes.push({ runId: lock.runId, status: 'worker-running' }); continue;
    }
    if (!pending && alive(lock.supervisorPid) && (!lock.workerId || activeSlots.has(`${root}:${lock.workerId}`))) continue;
    if (!pending) {
      let task = await client.getWorkflow(uid);
      if (task.state === 'ready') {
        // Replay the exact claim after a lost response instead of creating another run.
        let claim;
        try { claim = await readJson(path.join(directory, 'claim.json')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (claim) {
          try { task = await client.workflow(uid, claim.operation); }
          catch { continue; }
        }
      }
      if (task.state !== 'doing' || task.workflow?.run?.id !== lock.runId) {
        await rm(lockFile, { force: true }); continue;
      }
      let report = { status: 'failed', summary: 'Execution was interrupted; inspect saved workspace and logs. Create a new work for any remaining changes.', executionErrors: ['Worker or supervisor stopped before reporting'], changedFiles: [], verification: [] };
      if (state?.runId === lock.runId && state.status === 'reported') {
        const request = await readJson(path.join(directory, 'request.json'));
        report = reportForServer(await readJson(path.join(directory, 'worker-result.json')));
        try {
          const changes = await workspaceChanges(request.run.workspace);
          await writeFile(path.join(directory, 'task.patch'), await workspacePatch(request.run.workspace, request.inputTree), { mode: 0o600 });
          await writeFile(path.join(directory, 'changes.patch'), await workspacePatch(request.run.workspace), { mode: 0o600 });
          report = reportForServer({ ...report, baseCommit: request.baseCommit, changedFiles: changes.changedFiles });
        } catch { report = reportForServer({ ...report, status: 'failed', executionErrors: ['Artifact export failed; workspace preserved'] }); }
      } else if (!lock.workerId) {
        // Never kill an old developer process or container just because its supervisor disappeared.
        let oldProcess;
        try { oldProcess = await readJson(path.join(directory, 'process.json')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (processAlive(oldProcess?.workerPid)) { outcomes.push({ runId: lock.runId, status: 'worker-running' }); continue; }
      }
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await saveJson(path.join(directory, 'outbox.json'), { version: 2, uid, runId: lock.runId, title: task.title ?? uid, report, operation: { action: 'report', requestId: randomUUID(), expectedRevision: task.workflow.revision, runId: lock.runId, report } });
    }
    await flushDevelopmentOutbox({ root, client });
    pending = await readJson(path.join(directory, 'outbox.json'));
    if (pending.delivered || pending.conflict) {
      if (state?.runId === lock.runId && state.status === 'reported') await workerRequest(root, lock.workerId, { action: 'release', runId: lock.runId });
      await rm(lockFile, { force: true });
      outcomes.push({ runId: lock.runId, status: 'reconciled' });
    }
  }
  return outcomes;
}
