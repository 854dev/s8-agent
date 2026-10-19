import { reportForServer, workLink, flushDevelopmentOutbox } from './outbox.mjs';
import { saveJson } from '../storage/json-file.mjs';
import { requireConfirmedPlan } from '../projectman/preflight.mjs';
import { workerRequest, workerStates } from './worker-pool.mjs';
import { getWorkerState, readWorkerResult, withdrawWorkerAssignment } from './worker-store.mjs';
import { processAlive } from '../runtime/process.mjs';
import { usesRemoteWorkspace } from './worker-identity.mjs';
import { workerStateIsFresh } from './worker-protocol.mjs';
import { loadS8Config } from '../config/s8-config.mjs';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, open, rm, lstat } from 'node:fs/promises';
import path from 'node:path';

import { prepareWorktree, workspaceChanges, workspacePatch, applyWorkspacePatch, importDevelopmentResults } from './workspace.mjs';
import { writeWorkerInputPatch } from './worker-workspace.mjs';

async function projectGuidelines(worktree) {
  const instructions = []; let visited = 0;
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
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') await visit(relative);
    }
  }
  await visit(''); return instructions;
}

export async function loadDevelopmentPolicy(root) {
  return { workerEntries: loadS8Config(root).workerEntries };
}
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
export { reportForServer, workLink, flushDevelopmentOutbox };
/** Complete live runs and recovered runs through the same artifact and verification checks. */
async function collectDevelopmentResult(request, result) {
  const { run } = request;
  let changedFiles;
  if (request.transport?.kind === 'remote') {
    let patch;
    try { patch = await readFile(path.join(run.directory, 'task.patch'), 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT' || result.status === 'completed') throw error; }
    if (patch !== undefined) await applyWorkspacePatch(run.workspace, patch, { expectedBaseTree: request.inputTree, allowAlreadyApplied: true });
    // Uploaded artifacts are immutable: recovery must never replace them with a local export.
    changedFiles = patch === undefined ? result.changedFiles ?? [] : (await workspaceChanges(run.workspace)).changedFiles;
  } else {
    changedFiles = (await workspaceChanges(run.workspace)).changedFiles;
    await writeFile(path.join(run.directory, 'task.patch'), await workspacePatch(run.workspace, request.inputTree), { mode: 0o600 });
    await writeFile(path.join(run.directory, 'changes.patch'), await workspacePatch(run.workspace), { mode: 0o600 });
  }
  if (result.status === 'completed' && (request.task.workflow.spec.commandNames ?? []).some(name => name !== 'install' && !result.verification?.some(check => check.name === name && check.ok))) {
    result = { ...result, status: 'failed', executionErrors: ['Required verification is missing from the report'] };
  }
  return reportForServer({ ...result, baseCommit: request.baseCommit, changedFiles });
}

export async function runDeveloper(request, { signal } = {}) {
  const { root, workerId, run } = request;
  const assign = { action: 'assign', uid: request.task.uid, runId: run.runId, request };
  try { await workerRequest(root, workerId, assign); }
  catch {
    // A lost acknowledgement must not result in another assignment or a second execution.
    const state = await getWorkerState(root, workerId);
    if (state?.runId !== run.runId) throw new Error('Worker assignment was not accepted');
  }
  let cancelSent = false;
  while (true) {
    let state;
    try {
      if (signal?.aborted && !cancelSent) {
        await workerRequest(root, workerId, { action: 'cancel', runId: run.runId }); cancelSent = true;
      }
      state = await getWorkerState(root, workerId);
      if (!state) throw new Error('Worker state unavailable');
    } catch {
      const saved = (await workerStates(root)).find(item => item.workerId === workerId);
      if (saved?.runId !== run.runId) throw new Error('Assigned worker state unavailable');
      // Preserve ownership during a communication outage; only a fresh connected state can finish the run.
      await new Promise(resolve => setTimeout(resolve, 1000)); continue;
    }
    if (state?.runId !== run.runId) throw new Error('Worker assignment changed');
    if (state.status === 'reported') {
      const report = await readWorkerResult(run.directory);
      return { report, workerPid: state.pid };
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

export async function runDevelopmentTask({ root, client, candidate, policy, signal, worker = runDeveloper, workerId }) {
  const remote = usesRemoteWorkspace(policy.workerEntries?.[workerId]);
  const locks = path.join(root, '.s8-runtime/development-locks');
  await mkdir(locks, { recursive: true, mode: 0o700 });
  const lockPath = path.join(locks, `${candidate.uid}.json`);
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); } catch (error) { if (error.code === 'EEXIST') return { status: 'locked', uid: candidate.uid }; throw error; }
  const runId = randomUUID();
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
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
    let transport;
    if (remote) {
      const input = await writeWorkerInputPatch(directory, workspace.worktree);
      transport = { kind: 'remote', repoPath: task.workflow.spec.repoPath, baseCommit: workspace.baseCommit, inputPatchSha256: input.sha256 };
    }
    const request = { root, run, workerId, inputTree, ...(transport ? { transport } : {}), task: { ...task, workflow: { ...claimed.workflow, runs: undefined, result: undefined } }, preflight: preflight.preflight, baseCommit: workspace.baseCommit, projectInstructions };
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
    stage = 'artifact export';
    let report = await collectDevelopmentResult(request, outcome.report);
    if (controller.signal.aborted) report = reportForServer({ ...report, status: 'failed', checkpoint: report.checkpoint || 'Resume saved workspace and execution events.', summary: `Execution stopped; inspect the checkpoint before resuming. ${report.summary}`.slice(0, 8000), verification: report.verification });
    await saveJson(path.join(directory, 'outbox.json'), { version: 2, uid: candidate.uid, title: taskTitle, runId, report, operation: { action: 'report', requestId: randomUUID(), expectedRevision: claimed.workflow.revision, runId, report } });
    await flushDevelopmentOutbox({ root, client });
    return { status: report.status, uid: candidate.uid, runId, worktree: run.workspace };
  } catch (error) {
    if (claimed && directory) {
      let changes = { changedFiles: [] };
      if (workspace) {
        try {
          changes = await workspaceChanges(workspace.worktree);
          if (!remote) await writeFile(path.join(directory, 'changes.patch'), await workspacePatch(workspace.worktree), { mode: 0o600 });
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

export async function developmentTick({ root, client, policy, signal, worker, projectUid }) {
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
  const workerIds = Object.keys(policy.workerEntries ?? {});
  const slots = worker
    ? workerIds.map(workerId => ({ workerId, alive: true, status: 'idle', registered: true }))
    : await workerStates(root, policy.workerEntries ?? {});
  const results = worker ? [] : finishedRuns.splice(0);
  for (const slot of slots.filter(slot => slot.registered && slot.alive && slot.status === 'idle')) {
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
        const result = await runDevelopmentTask({ root, client, candidate, policy, signal, worker, workerId: slot.workerId });
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

export function transientProjectmanError(error) {
  const status = error.status ?? Number(/HTTP (\d+)/.exec(error.message ?? '')?.[1]);
  return status === 408 || status === 429 || status >= 500 || (error.name === 'TypeError' && error.message === 'fetch failed') || ['TimeoutError', 'AbortError'].includes(error.name) || ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'].includes(error.code);
}

export async function runDevelopmentLoop({ root, client, policy, signal, once = false, intervalMs = 5000, onResult = result => console.log(JSON.stringify(result)), onRetry = () => console.error('Projectman polling temporarily unavailable; retrying without releasing active runs.') }) {
  do {
    try {
      await recoverDevelopmentRuns({ root, client });
      for (const result of await developmentTick({ root, client, policy, signal })) onResult(result);
    } catch (error) {
      if (once || !transientProjectmanError(error)) throw error;
      onRetry();
    }
    if (once || signal?.aborted) break;
    await new Promise(resolve => {
      const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
      const timer = setTimeout(done, intervalMs);
      signal?.addEventListener('abort', done, { once: true });
      if (signal?.aborted) done();
    });
  } while (!signal?.aborted);
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
    if (lock.workerId) state = await withdrawWorkerAssignment(root, lock.workerId, lock.runId) ?? await getWorkerState(root, lock.workerId);
    if (state?.runId === lock.runId && ['busy', 'accepting', 'unknown'].includes(state.status)) {
      const fresh = workerStateIsFresh(state);
      outcomes.push({ runId: lock.runId, status: fresh ? 'worker-running' : 'worker-state-unknown' }); continue;
    }
    if (!pending && processAlive(lock.supervisorPid) && (!lock.workerId || activeSlots.has(`${root}:${lock.workerId}`))) continue;
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
        try { report = await collectDevelopmentResult(request, await readWorkerResult(directory)); }
        catch { report = reportForServer({ status: 'failed', summary: 'Artifact recovery failed; workspace and received artifacts preserved.', executionErrors: ['Artifact export failed; workspace preserved'] }); }
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
