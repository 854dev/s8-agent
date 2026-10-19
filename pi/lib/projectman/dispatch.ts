import { projectmanFromEnv } from './client.ts';

/** A scheduler tick only reports ready work; workers are started by the manager (run_worker) or ./s8.sh work. */
export async function runProjectmanTurn({ projectUid, client = projectmanFromEnv() }: any) {
  const candidates = await client.list('task', projectUid, { state: 'ready' });
  return { status: candidates.length ? 'waiting' : 'idle', results: [] };
}
