import { readdir, realpath, lstat, readFile, open, mkdir, rename, unlink, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const blocked = value => value.split(path.sep).some(part => part.startsWith('.') || /secret/i.test(part) || ['node_modules', 'AGENTS.md', 'CLAUDE.md'].includes(part));
const hash = content => createHash('sha256').update(content).digest('hex');
export function managerKb(root) {
  let policyRead = false;
  async function guidelines() {
    const file = path.join(await realpath(root), 'AGENTS.md');
    let instructions = '';
    try { const stat = await lstat(file); if (!stat.isFile() || stat.nlink !== 1 || stat.size > 50000) throw new Error('KB policy unavailable'); instructions = await readFile(file, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    policyRead = true;
    return { instructions, note: 'Project guidelines do not grant additional tools or permissions.' };
  }
  async function document(relative) {
    if (typeof relative !== 'string' || path.isAbsolute(relative) || blocked(relative) || !/\.md$/i.test(relative)) throw new Error('KB Markdown path required');
    const base = await realpath(root);
    const candidate = path.resolve(base, relative);
    const actual = await realpath(candidate);
    const inside = path.relative(base, actual);
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside) || blocked(inside) || !(await lstat(candidate)).isFile()) throw new Error('KB path unavailable');
    // Reject symlink ancestors as well as files; no aliases into code/runtime.
    let cursor = base;
    for (const part of path.relative(base, candidate).split(path.sep)) {
      cursor = path.join(cursor, part);
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1)) throw new Error('KB links unavailable');
    }
    if ((await lstat(actual)).size > 200_000) throw new Error('KB document too large');
    const content = await readFile(actual, 'utf8');
    return { path: inside, content, version: hash(content) };
  }
  async function search(query) {
    if (typeof query !== 'string' || !query.trim() || query.length > 200) throw new Error('KB query required (1-200 characters)');
    const matches = []; let scanned = 0; let truncated = false;
    async function visit(dir, depth = 0) {
      if (depth > 12 || scanned >= 5000 || matches.length >= 30) { truncated = true; return; }
      for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
        if (scanned >= 5000 || matches.length >= 30) { truncated = true; break; }
        const relative = path.join(dir, entry.name);
        if (blocked(relative) || entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) await visit(relative, depth + 1);
        else if (entry.isFile() && /\.md$/i.test(entry.name)) {
          scanned++;
          let doc;
          try { doc = await document(relative); }
          catch (error) { if (error.message === 'KB document too large' || error.message === 'KB links unavailable') continue; throw error; }
          const at = doc.content.toLocaleLowerCase().indexOf(query.trim().toLocaleLowerCase());
          if (at >= 0 || relative.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) matches.push({ path: relative, excerpt: doc.content.slice(Math.max(0, at - 60), Math.max(0, at - 60) + 300) });
        }
      }
    }
    await visit('');
    return { status: matches.length ? 'SUCCESS' : 'NO_MATCH', source: 'local_markdown', matches, scanned, truncated };
  }
  async function mutate(relative, content, expectedVersion, deleting = false) {
    if (!policyRead) throw new Error('Read KB policy before editing documents');
    if (typeof relative !== 'string' || path.isAbsolute(relative) || blocked(relative) || !/\.md$/i.test(relative) || relative.split('/').includes('..')) throw new Error('KB Markdown path required');
    if (!deleting && (typeof content !== 'string' || Buffer.byteLength(content) > 200000)) throw new Error('KB content limit is 200KB');
    const base = await realpath(root), candidate = path.resolve(base, relative);
    const parent = path.dirname(candidate);
    const inside = path.relative(base, await realpath(parent));
    if (inside.startsWith('..') || path.isAbsolute(inside) || blocked(inside)) throw new Error('KB parent directory unavailable');
    let cursor = base;
    for (const part of path.relative(base, parent).split(path.sep).filter(Boolean)) { cursor = path.join(cursor, part); if ((await lstat(cursor)).isSymbolicLink()) throw new Error('KB links unavailable'); }
    const locks = path.join(os.tmpdir(), 's8-kb-document-locks');
    await mkdir(locks, { recursive: true, mode: 0o700 });
    const lockPath = path.join(locks, hash(candidate));
    let lock;
    try { lock = await open(lockPath, 'wx', 0o600); } catch (error) { if (error.code === 'EEXIST') throw new Error('KB document is locked; retry after the current write finishes'); throw error; }
    const temp = path.join(parent, `.s8-kb-${randomUUID()}.tmp`);
    try {
      let current;
      try { current = await document(relative); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if ((current?.version ?? null) !== expectedVersion) throw new Error('KB version conflict; read the document again');
      if (deleting) { if (!current) throw new Error('KB document not found'); await unlink(candidate); return { path: relative, deleted: true }; }
      await writeFileSafe(temp, content);
      await rename(temp, candidate);
      return { path: relative, version: hash(content), bytes: Buffer.byteLength(content) };
    } finally { await rm(temp, { force: true }); await lock.close(); await rm(lockPath, { force: true }); }
  }
  return { document, search, guidelines, write: (relative, content, expectedVersion) => mutate(relative, content, expectedVersion), delete: (relative, expectedVersion) => mutate(relative, undefined, expectedVersion, true) };
}

async function writeFileSafe(file, content) {
  const fd = await open(file, 'wx', 0o600);
  try { await fd.writeFile(content); await fd.sync(); } finally { await fd.close(); }
}
