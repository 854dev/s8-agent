import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { workerStates } from './worker-pool.mjs';

// Fixed diagnostics only: upstream errors can contain credentials or response bodies.
function refuse(message) {
  throw Object.assign(new Error(message), { stoppedRunDiagnostic: message });
}

/** Explicit operator recovery for an interrupted run with no local recovery lock. */
export async function finishStoppedRun({ root, client, uid, runId, confirmed = false, states = workerStates }) {
  if (!confirmed) refuse('Confirm that this run has stopped on all hosts with --confirm-stopped.');
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(uid ?? '') || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(runId ?? '')) refuse('A task UID and UUID --run-id are required.');
  try {
    await lstat(path.join(root, '.s8-runtime/development-locks', `${uid}.json`));
    refuse('A local recovery lock exists; inspect the supervisor recovery before proceeding.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const workers = await states(root);
  if (workers.some(worker => worker.runId === runId && (worker.alive || ['busy', 'accepting', 'unknown'].includes(worker.status)))) refuse('A worker still owns this run or its execution state is unknown.');

  const current = await client.getWorkflow(uid);
  if (current.workflow?.run?.id !== runId) refuse('The server run changed; no report was submitted.');
  if (current.workflow.run.status === 'finished') return { uid, runId, status: 'already-finished', state: current.state };
  if (current.state !== 'doing' || current.workflow.run.status !== 'running') refuse('Only a doing/running orphan can be finished by this command.');

  // The server checks the revision AND the claiming actor. Never impersonate another
  // actor, bypass deletion checks, or claim that interrupted work completed.
  const result = await client.workflow(uid, {
    action: 'report', requestId: randomUUID(), expectedRevision: current.workflow.revision, runId,
    report: {
      status: 'failed',
      summary: 'Operator confirmed execution stopped on all hosts; the local recovery lock is missing.',
      changedFiles: [], verification: [],
      executionErrors: ['Execution was interrupted; changes and verification could not be recovered.'],
      remainingItems: ['Inspect any saved workspace and artifacts before creating follow-up work.'],
    },
  });
  if (result.workflow?.run?.id !== runId || result.workflow.run.status !== 'finished') refuse('The server did not confirm the run finished; reload the work before retrying.');
  return { uid, runId, status: 'finished', state: result.state };
}

export async function finishStoppedRunCommand(root, client, args) {
  if (args.length !== 5 || args[0] !== '--finish-stopped-run' || args[2] !== '--run-id' || args[4] !== '--confirm-stopped') refuse('Usage: --finish-stopped-run UID --run-id UUID --confirm-stopped');
  return finishStoppedRun({ root, client, uid: args[1], runId: args[3], confirmed: true });
}
