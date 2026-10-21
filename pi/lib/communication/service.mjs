import { startCommunicationServer } from './server.mjs';
import { startWorkerConnection } from './client.mjs';
import { listenLocal, localRequest } from './local.mjs';
import { workerStatuses, setWorkerMode } from '../agent/resident.mjs';
import { MAX_PENDING, requestLedger } from './protocol.mjs';
import { startResearch, researchAlive, sendResearch, existingResearch } from './research.mjs';
import { readClaim } from '../agent/worker-run.mjs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export async function runCommunicator(root, config, { log = () => {} } = {}) {
  const server = await startCommunicationServer(config, { onMessage: input => localRequest(root, 'pi:manager', input), artifactDirectory: path.join(root, '.s8-runtime/artifacts'), onEvent: log });
  let closeLocal;
  try {
    closeLocal = await listenLocal(root, 'communicator', async input => {
      if (input.action === 'workers') return { state: 'finished', workers: server.workers() };
      if (input.action !== 'send') return { state: 'rejected' };
      return server.request(input.workerId, input.type, input.payload, input.context);
    });
  } catch (error) { await server.close(); throw error; }
  return async () => { await closeLocal(); await server.close(); };
}

export async function connectResident(root, config, worker, { launchResearch = startResearch, isResearchAlive = researchAlive, recoverResearch = existingResearch, intervalMs = 5000 } = {}) {
  const queue = [], requests = requestLedger();
  const researchSessions = new Map();
  const uncertain = new Set();
  for (const session of await recoverResearch(root, worker.id)) { researchSessions.set(session.requestId, session); uncertain.add(session.requestId); }
  const receiptOf = entry => ({ state: entry.state, uid: entry.uid, requestId: entry.requestId });
  let connection, lastFinished, research, updating = false;
  const receive = async input => {
    if (input.type === 'request.status') {
      const prior = requests.get(input.payload.requestId);
      if (prior) {
        const receipt = receiptOf(prior);
        const [status] = await workerStatuses(root, [worker]);
        if (prior.startedAt != null && status.lastError?.uid === prior.uid && Date.parse(status.lastError.at) >= prior.startedAt) return { ...receipt, state: 'rejected', reason: status.lastError.message };
        const claim = await readClaim(root, prior.uid);
        if (prior.startedAt != null && claim?.revision && (claim.runId !== prior.previousRunId || !prior.previousReported)) {
          const outbox = await readFile(path.join(root, '.s8-runtime/runs', claim.runId, 'outbox.json'), 'utf8').then(JSON.parse).catch(() => null);
          return { ...receipt, state: outbox?.delivered ? 'finished' : 'claimed', runId: claim.runId };
        }
        return receipt;
      }
    }
    if (input.type === 'worker.mode.set') {
      await setWorkerMode(root, worker.id, input.payload.mode === 'default' ? null : input.payload.mode);
      const [status] = await workerStatuses(root, [worker]);
      await connection.request('worker.status', status);
      return { state: 'finished' };
    }
    if (input.type === 'task.run') {
      const prior = requests.get(input.requestId);
      if (prior) return receiptOf(prior);
      const [status] = await workerStatuses(root, [worker]);
      if (status.mode === 'paused') return { state: 'rejected', reason: 'Worker is paused' };
      if (queue.length >= MAX_PENDING) return { state: 'rejected', reason: 'Worker queue is full' };
      const receipt = { state: 'pending', uid: input.taskUid, requestId: input.requestId };
      const previous = await readClaim(root, input.taskUid);
      requests.set(input.requestId, { ...receipt, previousRunId: previous?.runId, previousReported: previous?.reported === true }, Date.parse(input.expiresAt));
      queue.push(input);
      return receipt;
    }
    const [status] = await workerStatuses(root, [worker]);
    if (input.taskUid) return localRequest(root, `pi:${worker.id}:${input.taskUid}`, input);
    if (researchSessions.has(input.requestId)) return sendResearch(root, worker.id, researchSessions.get(input.requestId), input);
    if (input.type !== 'agent.request') return { state: 'unavailable', reason: 'Specify taskUid or the original research requestId' };
    if (status.current || research || uncertain.size || queue.length || status.mode === 'paused') return { state: 'rejected', reason: 'Worker is busy, paused or has research sessions to reconcile; specify an existing requestId/taskUid for follow-up' };
    research = { requestId: input.requestId, starting: true };
    try {
      if (researchSessions.size >= 20) {
        for (const [id, session] of researchSessions) if (!await isResearchAlive(session)) researchSessions.delete(id);
        if (researchSessions.size >= 20) { research = null; return { state: 'rejected', reason: 'Close finished research windows before creating more sessions (limit 20)' }; }
      }
      const launched = await launchResearch(root, worker.id, input);
      research = { ...launched, deadlineAt: input.payload.deadlineAt ?? new Date(Date.now() + 300_000).toISOString() };
      researchSessions.set(input.requestId, launched);
      const deadline = Math.min(Date.parse(input.expiresAt), Date.now() + 10_000);
      while (Date.now() < deadline) {
        const result = await sendResearch(root, worker.id, launched, input);
        if (result.state !== 'unavailable') return result;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return { state: 'unknown', reason: 'Research session started but injection was not confirmed' };
    } catch { research = null; return { state: 'rejected', reason: 'Research session could not start' }; }
  };
  connection = await startWorkerConnection(config, worker.id, { onMessage: receive, onConnection: (connected, code) => {
    if (!connected) { requests.disconnect(); console.log(JSON.stringify({ type: 'worker.connection', workerId: worker.id, nodeId: config.nodeId, state: 'disconnected', code })); }
  } });
  let closeLocal;
  try {
    closeLocal = await listenLocal(root, `worker:${worker.id}`, async input => {
      if (input.action !== 'send') return { state: 'rejected' };
      const result = await connection.request(input.type, input.payload, input.context);
      if (input.type === 'agent.result') {
        uncertain.delete(input.context?.requestId);
        if (research?.requestId === input.context?.requestId) research = null;
      }
      return result;
    });
  } catch (error) { await connection.close(); throw error; }
  const update = async () => {
    if (updating || !connection.connected) return;
    updating = true;
    try {
      if (research && !research.starting && !await isResearchAlive(research)) research = null;
      for (const id of uncertain) if (!await isResearchAlive(researchSessions.get(id))) uncertain.delete(id);
      const active = research;
      if (active?.deadlineAt && !active.timedOut && Date.parse(active.deadlineAt) <= Date.now()) {
        active.timedOut = true;
        await connection.request('agent.notice', { text: 'Research response deadline elapsed. Execution was not cancelled; inspect partial results before retrying.' }, { requestId: active.requestId });
      }
      const [status] = await workerStatuses(root, [worker]);
      if (status.current) {
        const claim = await readClaim(root, status.current.uid);
        status.current = { ...status.current, runId: claim?.runId, claimed: Boolean(claim?.revision) };
      }
      const recovering = uncertain.size ? { ...researchSessions.get(uncertain.values().next().value), recovering: true } : null;
      await connection.request('worker.status', { ...status, research: research ?? recovering, queue: queue.map(item => item.taskUid) });
      if (status.lastFinished && status.lastFinished.at !== lastFinished) {
        const claim = await readClaim(root, status.lastFinished.uid);
        const outbox = claim && await readFile(path.join(root, '.s8-runtime/runs', claim.runId, 'outbox.json'), 'utf8').then(JSON.parse).catch(() => null);
        if (status.lastFinished.reported && !outbox?.delivered) return;
        lastFinished = status.lastFinished.at;
        await connection.request(status.lastFinished.reported ? 'task.completed' : 'task.failed', { uid: status.lastFinished.uid, reported: status.lastFinished.reported }, { taskUid: status.lastFinished.uid, ...(claim ? { runId: claim.runId } : {}) });
      }
    } finally { updating = false; }
  };
  const timer = setInterval(() => { void update().catch(() => {}); }, intervalMs);
  timer.unref();
  return {
    get busy() { return Boolean(research) || uncertain.size > 0; },
    nextInstruction() {
      while (queue.length) {
        const input = queue.shift();
        if (Date.parse(input.expiresAt) > Date.now()) {
          requests.set(input.requestId, { ...requests.get(input.requestId), state: 'accepted', uid: input.taskUid, requestId: input.requestId, startedAt: Date.now() }, Date.parse(input.expiresAt));
          return { uid: input.taskUid };
        }
      }
      return null;
    },
    async close() { clearInterval(timer); await closeLocal(); await connection.close(); },
  };
}
