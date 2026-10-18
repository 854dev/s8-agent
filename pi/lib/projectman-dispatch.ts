import { projectmanFromEnv } from './projectman-client.ts';

/** The shared supervisor owns assignment; a scheduler tick never starts or cancels workers. */
export async function runProjectmanTurn({ projectUid, client = projectmanFromEnv() }: any) {
  const candidates = await client.list('task', projectUid, { state: 'ready' });
  return { status: candidates.length ? 'waiting' : 'idle', results: [] };
}
