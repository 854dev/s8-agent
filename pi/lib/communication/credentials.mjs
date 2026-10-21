import { constants, open } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';

// Only explicitly configured credential files are read. Errors never include contents.
export async function readCredentials(file) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16_384 || (stat.mode & 0o077)) throw new Error();
    const value = JSON.parse(await handle.readFile('utf8'));
    if (!value || Object.keys(value).some(key => key !== 'workers') || !value.workers || Array.isArray(value.workers) || typeof value.workers !== 'object') throw new Error();
    const entries = Object.entries(value.workers);
    if (!entries.length || entries.length > 20 || entries.some(([id, token]) => id === 'manager' || !/^[a-z][a-z0-9-]{0,31}$/.test(id) || typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(token))) throw new Error();
    return value.workers;
  } catch { throw new Error('Communication credentials must be a private regular JSON file with Worker tokens (32–256 URL-safe characters)'); }
  finally { await handle?.close(); }
}

export function tokenMatches(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
