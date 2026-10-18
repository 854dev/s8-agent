import { requireConfirmedPlan } from './projectman-preflight.mjs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, open, rm, lstat } from 'node:fs/promises';
import path from 'node:path';
import { saveJson, boundedCommand } from './development-smoke.mjs';
import { prepareWorktree, workspaceChanges, workspacePatch, developmentCommand, importDevelopmentResults } from './development-workspace.mjs';

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
  const policy = JSON.parse(await readFile(path.join(root, 'agents/developer/policy.json'), 'utf8'));
  policy.workerId ??= 's8-developer';
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(policy.workerId)) throw new Error('Invalid worker ID');
  policy.maxRuns ??= 6; policy.maxModelTokens ??= 100000;
  if (!Number.isInteger(policy.maxRuns) || policy.maxRuns < 1 || policy.maxRuns > 6 || !Number.isInteger(policy.maxModelTokens) || policy.maxModelTokens < 1000 || policy.maxModelTokens > 200000) throw new Error('Invalid execution/model budget');
  if (![policy.maxConcurrency, policy.perRepoConcurrency].every(value => Number.isInteger(value) && value >= 1 && value <= 8) || !Number.isInteger(policy.maxTimeMinutes) || policy.maxTimeMinutes < 1 || policy.maxTimeMinutes > 20 || !Number.isInteger(policy.maxCommandSeconds) || policy.maxCommandSeconds < 1 || policy.maxCommandSeconds > 300) throw new Error('Invalid trusted development policy');
  for (const [name, command] of Object.entries(policy.commands ?? {})) if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name) || !['none', 'bridge'].includes(command.network) || !Array.isArray(command.argv) || !command.argv.length || command.argv.some(arg => typeof arg !== 'string' || !arg || arg.includes('\0'))) throw new Error('Invalid trusted command policy');
  for (const image of [policy.image, ...Object.values(policy.commands).map(command => command.image)].filter(Boolean)) if (!/^[a-z0-9][a-zA-Z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(image)) throw new Error('Trusted image must be pinned by digest');
  return policy;
}
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
export function reportForServer(value) {
  const strings = values => (Array.isArray(values) ? values : []).slice(0, 100).map(item => String(item).trim().slice(0, 3000)).filter(Boolean);
  const report = { status: ['completed', 'continue', 'blocked', 'failed'].includes(value?.status) ? value.status : 'failed', summary: String(value?.summary ?? '').trim().slice(0, 8000) || 'No valid development summary was returned.', changedFiles: value?.changedFiles ?? [], verification: (value?.verification ?? []).slice(-20).map(item => ({ name: String(item.name).slice(0, 100), ok: item.ok === true, summary: String(item.summary ?? '').slice(0, 1000) })), remainingItems: strings(value?.remainingItems), decisions: strings(value?.decisions), executionErrors: strings(value?.executionErrors), checkpoint: String(value?.checkpoint ?? '').slice(0, 16000), ...(value?.baseCommit ? { baseCommit: value.baseCommit } : {}) };
  if (['failed', 'blocked'].includes(report.status) && !report.executionErrors.length) report.executionErrors = [report.summary.slice(0, 3000)];
  if (report.status === 'completed' && (report.remainingItems.length || report.executionErrors.length || report.verification.some(check => !check.ok))) report.status = 'continue';
  return report;
}

export function runDeveloper(request, { signal } = {}) {
  return new Promise(resolve => {
    const env = { ...process.env };
    for (const key of ['PHCMS_ACCESS_TOKEN', 'PHCMS_API_URL', 'TELEGRAM_BOT_TOKEN']) delete env[key];
    const child = spawn(process.execPath, [path.join(request.root, 'pi/bin/developer.mjs')], { cwd: request.run.workspace, env, stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '', killTimer;
    const abort = () => { child.kill('SIGTERM'); killTimer = setTimeout(() => child.kill('SIGKILL'), 2500); };
    child.stdout.on('data', chunk => { output = (output + chunk.toString()).slice(-100000); });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(request));
    const done = async code => {
      signal?.removeEventListener('abort', abort); clearTimeout(killTimer);
      try { resolve({ report: await readJson(path.join(request.run.directory, 'worker-result.json')), exitCode: code, workerPid: child.pid }); }
      catch { resolve({ report: { status: 'failed', summary: 'Worker exited without a durable result; explicit review required.', changedFiles: [], verification: [] }, exitCode: code, workerPid: child.pid }); }
    };
    child.once('error', () => { void done(null); });
    child.once('close', code => { void done(code); });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    void saveJson(path.join(request.run.directory, 'process.json'), { supervisorPid: process.pid, workerPid: child.pid, runId: request.run.runId }).catch(abort);
  });
}

export async function flushDevelopmentOutbox({ root, client }) {
  const runs = path.join(root, '.s8-runtime/runs');
  let directories;
  try { directories = await readdir(runs); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const outcomes = [];
  for (const runId of directories) {
    if (!/^[a-f0-9-]{36}$/.test(runId)) continue;
    const directory = path.join(runs, runId);
    let pending;
    try { pending = await readJson(path.join(directory, 'outbox.json')); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (pending.delivered || pending.conflict) continue;
    try {
      const delivered = await client.workflow(pending.uid, pending.operation);
      await saveJson(path.join(directory, 'result.json'), { ...pending.report, projectman: delivered, runId });
      const inbox = path.join(root, '.s8-runtime/manager-inbox');
      await mkdir(inbox, { recursive: true, mode: 0o700 });
      await saveJson(path.join(inbox, `${runId}.json`), { uid: pending.uid, runId, state: delivered.state });
      await saveJson(path.join(directory, 'outbox.json'), { ...pending, delivered: true });
      outcomes.push({ runId, delivered: true });
    } catch (error) {
      if (/HTTP (409|404)/.test(error.message)) {
        await saveJson(path.join(directory, 'outbox.json'), { ...pending, conflict: true });
        outcomes.push({ runId, conflict: true });
      } else outcomes.push({ runId, delivered: false });
    }
  }
  return outcomes;
}

export async function runDevelopmentTask({ root, client, candidate, policy, signal, worker = runDeveloper, command = developmentCommand, allowedRoot }) {
  const locks = path.join(root, '.s8-runtime/development-locks');
  await mkdir(locks, { recursive: true, mode: 0o700 });
  const lockPath = path.join(locks, `${candidate.uid}.json`);
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); } catch (error) { if (error.code === 'EEXIST') return { status: 'locked', uid: candidate.uid }; throw error; }
  const runId = randomUUID();
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  let poll, timeout, directory, claimed, workspace, inputTree, stage = 'prepare';
  try {
    await lock.writeFile(JSON.stringify({ runId, supervisorPid: process.pid }));
    const task = await client.getWorkflow(candidate.uid);
    if (task.executionAllowed === false || task.state !== 'ready' || !task.workflow?.grant || task.workflow.review?.pending || (task.workflow.review && task.workflow.followup?.reviewId !== task.workflow.review.id)) return { status: 'idle', uid: candidate.uid };
    let preflight;
    try { preflight = await requireConfirmedPlan(client, candidate.uid); } catch (error) { if (/HTTP 409/.test(error.message)) return { status: 'preflight_required', uid: candidate.uid }; throw error; }
    if ((task.workflow.runCount ?? 0) >= (task.workflow.spec.maxRuns ?? policy.maxRuns ?? 6)) return { status: 'budget_exhausted', uid: candidate.uid };
    if (signal?.aborted) return { status: 'stopped', uid: candidate.uid };
    directory = path.join(root, '.s8-runtime/runs', runId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    claimed = await client.workflow(candidate.uid, { action: 'claim', expectedRevision: task.workflow.revision, requestId: randomUUID(), runId, workerId: policy.workerId ?? 's8-developer' });
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
    const request = { root, run, task: { ...task, workflow: { ...claimed.workflow, runs: undefined, result: undefined } }, preflight: preflight.preflight, policy, previous: { ...task.workflow.result, executionNotes }, baseCommit: workspace.baseCommit, projectInstructions };
    await saveJson(path.join(directory, 'request.json'), request);
    timeout = setTimeout(abort, Math.min(policy.maxTimeMinutes, task.workflow.spec.timeBudgetMinutes) * 60000);
    let failures = 0, polling = false;
    poll = setInterval(async () => {
      if (polling) return; polling = true;
      try {
        const fresh = await client.getWorkflow(candidate.uid);
        if (fresh.state !== 'doing' || fresh.workflow.run?.id !== runId || fresh.executionAllowed === false) { controller.stopReason = 'revoked'; abort(); }
        failures = 0;
      } catch { if (++failures >= 3) { controller.stopReason = 'connection'; abort(); } }
      finally { polling = false; }
    }, 1500);
    stage = 'developer execution';
    const outcome = await worker(request, { signal: controller.signal });
    if (outcome.report.status === 'completed' && !controller.signal.aborted) {
      stage = 'independent verification';
      const results = []; let baseline = await workspaceChanges(run.workspace);
      for (const name of task.workflow.spec.commandNames) {
        const checked = await command({ root, worktree: run.workspace, name, policy, runId, signal: controller.signal });
        results.push({ name, ...checked });
        if (!checked.ok) break;
        if (name === 'install') baseline = await workspaceChanges(run.workspace);
      }
      const afterChecks = await workspaceChanges(run.workspace);
      const stable = !baseline || JSON.stringify(baseline) === JSON.stringify(afterChecks);
      await saveJson(path.join(directory, 'verification.json'), { stable, results, finalFingerprints: afterChecks.fingerprints });
      outcome.report.verification = [...new Map([...(outcome.report.verification ?? []), ...results.map(item => ({ name: item.name, ok: item.ok, summary: item.output.slice(-1000) }))].map(check => [check.name, check])).values()];
      if (!stable || results.length !== task.workflow.spec.commandNames.length || results.some(item => !item.ok)) { outcome.report.status = 'continue'; outcome.report.summary = 'Independent supervisor verification failed or final source changed during checks. Repair the saved workspace and rerun the planned checks in the next execution.'; }
    }
    const changes = await workspaceChanges(run.workspace);
    stage = 'artifact export';
    await writeFile(path.join(directory, 'task.patch'), await workspacePatch(run.workspace, inputTree), { mode: 0o600 });
    await writeFile(path.join(directory, 'changes.patch'), await workspacePatch(run.workspace), { mode: 0o600 });
    let report = reportForServer({ ...outcome.report, baseCommit: workspace.baseCommit, changedFiles: changes.changedFiles });
    if (controller.signal.aborted) report = reportForServer({ ...report, status: controller.stopReason ? 'failed' : 'continue', checkpoint: report.checkpoint || 'Resume saved workspace and execution events.', summary: `Execution stopped; inspect the checkpoint before resuming. ${report.summary}`.slice(0, 8000), changedFiles: changes.changedFiles, verification: report.verification });
    await saveJson(path.join(directory, 'outbox.json'), { uid: candidate.uid, runId, report, operation: { action: 'report', requestId: randomUUID(), expectedRevision: claimed.workflow.revision, runId, report } });
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
      await saveJson(path.join(directory, 'outbox.json'), { uid: candidate.uid, runId, report, operation: { action: 'report', requestId: randomUUID(), expectedRevision: claimed.workflow.revision, runId, report } });
      await flushDevelopmentOutbox({ root, client });
    }

    return { status: /HTTP 409/.test(error.message) ? 'conflict' : 'blocked', uid: candidate.uid };
  } finally {
    clearInterval(poll); clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
    await lock.close(); await rm(lockPath, { force: true });
  }
}

export async function developmentTick({ root, client, policy, signal, worker, allowedRoot, projectUid }) {
  await flushDevelopmentOutbox({ root, client });
  let candidates = [...await client.list('task', undefined, { state: 'ready' }), ...await client.list('subtask', undefined, { state: 'ready' })].filter(item => item.detail?.attributes.workflow?.version === 2 && item.detail.attributes.workflow.grant);
  if (projectUid) {
    const selected = [];
    for (const candidate of candidates) {
      const content = await client.get(candidate.uid);
      const project = content.type === 'task' ? content.parent?.uid : content.parent?.uid ? (await client.get(content.parent.uid)).parent?.uid : undefined;
      if (project === projectUid) selected.push(candidate);
    }
    candidates = selected;
  }
  const pending = [...candidates], active = new Set(), counts = new Map(), results = [];
  while ((pending.length || active.size) && !signal?.aborted) {
    for (let index = 0; index < pending.length && active.size < policy.maxConcurrency;) {
      const item = pending[index], repo = item.detail.attributes.workflow.spec.repoPath;
      if ((counts.get(repo) ?? 0) >= policy.perRepoConcurrency) { index++; continue; }
      pending.splice(index, 1); counts.set(repo, (counts.get(repo) ?? 0) + 1);
      const promise = runDevelopmentTask({ root, client, candidate: item, policy, signal, worker, allowedRoot }).then(result => results.push(result)).finally(() => { counts.set(repo, counts.get(repo) - 1); active.delete(promise); });
      active.add(promise);
    }
    if (active.size) await Promise.race(active);
    else break;
  }
  await Promise.all(active);
  return results;
}

export async function recoverDevelopmentRuns({ root, client, cleanup = async runId => {
  const name = `s8-dev-${runId}`;
  const inspected = await boundedCommand('docker', ['ps', '-q', '--filter', `name=^/${name}$`], { timeoutMs: 10000 });
  if (!inspected.ok) throw new Error('Cannot verify orphan container state');
  if (inspected.output.trim() && !(await boundedCommand('docker', ['rm', '-f', name], { timeoutMs: 10000 })).ok) throw new Error('Cannot stop orphan container');
} }) {
  const locks = path.join(root, '.s8-runtime/development-locks');
  let files; try { files = await readdir(locks); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const outcomes = [];
  for (const file of files) {
    if (!/^[a-zA-Z0-9_-]+\.json$/.test(file)) continue;
    const lockFile = path.join(locks, file), lock = await readJson(lockFile);
    if (alive(lock.supervisorPid)) continue;
    const directory = path.join(root, '.s8-runtime/runs', lock.runId);
    let processInfo;
    try { processInfo = await readJson(path.join(directory, 'process.json')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (processInfo?.workerPid && alive(processInfo.workerPid)) { outcomes.push({ runId: lock.runId, status: 'worker-running' }); continue; }
    await cleanup(lock.runId);
    const uid = file.slice(0, -5), task = await client.getWorkflow(uid);
    if (task.state === 'doing' && task.workflow.run?.id === lock.runId) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      let report;
      try { report = await readJson(path.join(directory, 'worker-result.json')); if (report.status === 'completed') report = { ...report, status: 'blocked', summary: 'Supervisor was interrupted before independent final verification. Review the saved changes before resuming.' }; report = reportForServer(report); }
      catch (error) { if (error.code !== 'ENOENT') throw error; report = { status: 'failed', summary: 'Orphaned execution; no durable result. Explicit review required.', changedFiles: [], verification: [] }; }
      report = reportForServer(report);
      try { await lstat(path.join(directory, 'outbox.json')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; await saveJson(path.join(directory, 'outbox.json'), { uid, runId: lock.runId, report, operation: { action: 'report', requestId: randomUUID(), expectedRevision: task.workflow.revision, runId: lock.runId, report } }); }
      await flushDevelopmentOutbox({ root, client });
    }
    await rm(lockFile); outcomes.push({ runId: lock.runId, status: 'reconciled' });
  }
  return outcomes;
}
