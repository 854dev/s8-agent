import { projectmanFromEnv } from './projectman-client.ts';
import { developmentTick, loadDevelopmentPolicy } from './development-supervisor.mjs';

/** Scheduled jobs use the same claims, confirmations and worker as interactive work. */
export async function runProjectmanTurn({ root, projectUid, signal, notify, client = projectmanFromEnv(), policy, worker }: any) {
  const trusted = policy ?? await loadDevelopmentPolicy(root);
  const results = await developmentTick({ root, client, policy: trusted, signal, worker, projectUid });
  for (const result of results) {
    if (['idle', 'locked', 'conflict'].includes(result.status)) continue;
    await notify?.({ stage: 'finish', uid: result.uid, message: `Projectman ${result.uid}: ${result.status}` });
  }
  return { status: results.length ? 'dispatched' : 'idle', results };
}
