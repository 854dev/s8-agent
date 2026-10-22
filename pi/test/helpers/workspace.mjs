import { mkdir, readFile, writeFile, lstat, readdir, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';

export const safePath = value => typeof value === 'string' && value.length > 0 && !path.isAbsolute(value) && !value.includes('\\') && value.split('/').every(part => part && part !== '..' && part !== '.' && !/secret/i.test(part) && !['.git', '.env', '.pi-runtime', '.s8-runtime', 'auth.json', 'firebase.json', 'node_modules'].includes(part) && (!part.startsWith('.env.') || part === '.env.example')) && !/\.(pem|key)$/i.test(value);

export function developmentWorkspace(root) {
  async function resolve(relative, writing) {
    if (!safePath(relative)) throw new Error('Protected or invalid workspace path');
    let cursor = await realpath(root);
    const parts = relative.split('/');
    for (let i = 0; i < parts.length; i++) {
      cursor = path.join(cursor, parts[i]);
      try {
        const stat = await lstat(cursor);
        if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1)) throw new Error('Workspace links are not allowed');
        if (i < parts.length - 1 ? !stat.isDirectory() : writing && !stat.isFile()) throw new Error('Workspace requires regular files and directories');
      } catch (error) {
        if (error.code !== 'ENOENT' || !writing) throw error;
        if (i < parts.length - 1) await mkdir(cursor);
      }
    }
    return cursor;
  }
  return {
    async read(relative) {
      const file = await resolve(relative, false);
      const stat = await lstat(file);
      if (!stat.isFile() || stat.size > 150_000) throw new Error('Read a regular, smaller file');
      return { path: relative, content: await readFile(file, 'utf8') };
    },
    async list(relative = '') {
      const dir = relative ? await resolve(relative, false) : root;
      return (await readdir(dir, { withFileTypes: true })).filter(entry => !entry.isSymbolicLink() && safePath(relative ? `${relative}/${entry.name}` : entry.name)).slice(0, 200).map(entry => ({ name: entry.name, directory: entry.isDirectory() }));
    },
    async write(relative, content) {
      if (typeof content !== 'string' || Buffer.byteLength(content) > 150_000) throw new Error('Write limit is 150KB');
      await writeFile(await resolve(relative, true), content, { mode: 0o600 });
      return { path: relative, bytes: Buffer.byteLength(content) };
    },
    async remove(relative) {
      if (!safePath(relative)) throw new Error('Protected or invalid workspace path');
      const file = await resolve(relative, false);
      if (!(await lstat(file)).isFile()) throw new Error('Only regular files may be removed');
      await unlink(file);
      return { path: relative, deleted: true };
    },
  };
}
