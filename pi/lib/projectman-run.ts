import { realpathSync } from 'node:fs';
import path from 'node:path';

export type Paths = { cwd: string; binary: string; guard: string; scopeExtension: string; systemPrompt: string };

export function permittedRepoPath(repoPath: unknown, cwd: string) {
  if (typeof repoPath !== 'string' || !path.isAbsolute(repoPath)) throw new Error('Task/project needs an absolute repoPath');
  const repo = realpathSync(repoPath);
  const relative = path.relative(realpathSync(path.resolve(cwd, '..')), repo);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.split(path.sep).some(part => /secret/i.test(part) || /^\.env/i.test(part) || ['.git', '.pi', '.pi-runtime', '.s8-runtime'].includes(part))) throw new Error('Repository outside permitted dev_854 scope');
  return repo;
}

/** Legacy read-only execution used transitions and cannot confirm v2 plans. */
export async function runProjectmanResearch(_projectUid: string, _minutes: number, _signal: AbortSignal, _paths: Paths) {
  return { status: 'retired', message: 'Use a human-confirmed work/task plan and the development supervisor. Schedule the item with scheduledAt.' };
}
