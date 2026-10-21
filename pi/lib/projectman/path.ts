import { realpathSync } from 'node:fs';
import path from 'node:path';

export function permittedRepoPath(repoPath: unknown, cwd: string) {
  if (typeof repoPath !== 'string' || !path.isAbsolute(repoPath)) throw new Error('Task/project needs an absolute repoPath');
  return realpathSync(repoPath);
}
