import { promises as fs } from 'node:fs';
import path from 'node:path';

const BLOCKED = new Set(['.git', '.pi', '.pi-runtime', '.s8-runtime', 'SECRET', 'secret', '_work-memo', 'node_modules']);
const MAX_FILE_BYTES = 2_000_000;

export type Entry = {
  name: string;
  path: string;
  kind: 'file' | 'directory';
  size?: number;
  mtime?: string;
};

export function createLibrary(root: string) {
  const absoluteRoot = path.resolve(root);

  function relativePath(value: string) {
    const normalized = value.replaceAll('\\', '/');
    const candidate = path.resolve(absoluteRoot, normalized);
    const relative = path.relative(absoluteRoot, candidate);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('invalid path');
    return { candidate, relative: relative.split(path.sep).join('/') };
  }

  function allowed(relative: string) {
    return relative.split('/').filter(Boolean).every((part) => !BLOCKED.has(part));
  }

  async function entries(relative = '', depth = 2): Promise<Entry[]> {
    const { candidate, relative: safe } = relativePath(relative);
    if (!allowed(safe) || depth < 0 || depth > 5) throw new Error('invalid path');
    const rows: Entry[] = [];
    const children = await fs.readdir(candidate, { withFileTypes: true });
    for (const child of children) {
      const childRelative = safe ? `${safe}/${child.name}` : child.name;
      if (!allowed(childRelative) || child.name.startsWith('.')) continue;
      const childPath = path.join(candidate, child.name);
      if (child.isDirectory()) {
        rows.push({ name: child.name, path: childRelative, kind: 'directory' });
        if (depth > 0) rows.push(...await entries(childRelative, depth - 1));
        continue;
      }
      if (!child.isFile() || path.extname(child.name).toLowerCase() !== '.md') continue;
      const stat = await fs.stat(childPath);
      rows.push({ name: child.name, path: childRelative, kind: 'file', size: stat.size, mtime: stat.mtime.toISOString() });
    }
    return rows.sort((a, b) => a.path.localeCompare(b.path, 'ko'));
  }

  async function readFile(relative: string) {
    const { candidate, relative: safe } = relativePath(relative);
    if (!allowed(safe) || path.extname(safe).toLowerCase() !== '.md') throw new Error('invalid path');
    const stat = await fs.stat(candidate);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('file unavailable');
    return { path: safe, content: await fs.readFile(candidate, 'utf8'), size: stat.size, mtime: stat.mtime.toISOString() };
  }

  async function search(query: string, limit = 50) {
    const term = query.trim().toLocaleLowerCase('ko-KR');
    if (!term) return [];
    const files = (await entries('', 5)).filter((entry) => entry.kind === 'file').slice(0, 5000);
    const results: Array<Entry & { matches: number; excerpt: string }> = [];
    for (const file of files) {
      const content = (await readFile(file.path)).content;
      const lower = content.toLocaleLowerCase('ko-KR');
      const index = lower.indexOf(term);
      if (index < 0 && !file.path.toLocaleLowerCase('ko-KR').includes(term)) continue;
      const matches = lower.split(term).length - 1;
      const start = Math.max(0, index - 80);
      results.push({ ...file, matches, excerpt: content.slice(start, start + 220).replaceAll('\n', ' ') });
      if (results.length >= Math.min(Math.max(limit, 1), 100)) break;
    }
    return results;
  }

  async function recent(limit = 20) {
    const files = (await entries('', 5)).filter((entry) => entry.kind === 'file');
    return files.sort((a, b) => Date.parse(b.mtime ?? '') - Date.parse(a.mtime ?? '')).slice(0, Math.min(Math.max(limit, 1), 100));
  }

  return { entries, readFile, search, recent, root: absoluteRoot };
}

export type Library = ReturnType<typeof createLibrary>;
