// Content-addressed files, separate from messages. No arbitrary URLs or paths cross the network.
import { createHash, randomUUID } from 'node:crypto';
import { constants, open, mkdir, readdir, lstat, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { readCredentials } from './credentials.mjs';

export const MAX_BLOB_BYTES = 8 * 1024 * 1024;
const MAX_STORE_BYTES = 256 * 1024 * 1024;
export const checksum = bytes => createHash('sha256').update(bytes).digest('hex');

async function boundedBody(body) {
  const chunks = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.length;
    if (size > MAX_BLOB_BYTES) throw new Error('Artifact exceeds 8 MiB');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export function blobHandler(directory, authorize) {
  let active = 0, saving = Promise.resolve();
  return async (req, res) => {
    const match = /^\/artifacts\/([a-f0-9]{64})$/.exec(req.url ?? '');
    const end = status => { res.writeHead(status, { 'cache-control': 'no-store' }); res.end(); };
    if (!match || !['GET', 'PUT'].includes(req.method)) return end(404);
    if (!authorize(req) || req.headers.origin) return end(401);
    if (active >= 4) return end(429);
    req.setTimeout(15_000, () => req.destroy());
    active++;
    try {
      const sha = match[1], file = path.join(directory, sha);
      if (req.method === 'GET') {
        const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const info = await handle.stat();
          if (!info.isFile() || info.nlink !== 1 || info.size > MAX_BLOB_BYTES) throw new Error();
          const bytes = await handle.readFile();
          if (checksum(bytes) !== sha) throw new Error();
          res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.length, 'cache-control': 'no-store' });
          res.end(bytes);
        } finally { await handle.close(); }
      } else {
        const bytes = await boundedBody(req);
        if (checksum(bytes) !== sha) return end(422);
        const store = async () => {
          await mkdir(directory, { recursive: true, mode: 0o700 });
          const files = (await readdir(directory)).filter(name => /^[a-f0-9]{64}$/.test(name));
          if (files.includes(sha)) {
            const existing = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
            try {
              const info = await existing.stat();
              if (!info.isFile() || info.nlink !== 1 || info.size > MAX_BLOB_BYTES || checksum(await existing.readFile()) !== sha) throw new Error();
            } finally { await existing.close(); }
            return;
          }
          const sizes = await Promise.all((await readdir(directory)).map(name => lstat(path.join(directory, name)).then(value => { if (!value.isFile() || value.nlink !== 1) throw new Error(); return value.size; })));
          if (files.length >= 4096 || sizes.reduce((a, b) => a + b, bytes.length) > MAX_STORE_BYTES) throw new Error();
          const temporary = `${file}.${randomUUID()}.tmp`;
          try { await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' }); await rename(temporary, file); }
          finally { await rm(temporary, { force: true }); }
        };
        const result = saving.catch(() => {}).then(store);
        saving = result;
        await result;
        end(201);
      }
    } catch (error) { if (!res.headersSent) end(error.code === 'ENOENT' ? 404 : 413); else res.destroy(); }
    finally { active--; }
  };
}

export async function transferBlob(config, workerId, sha, { bytes, fetchImpl = fetch } = {}) {
  if (!/^[a-f0-9]{64}$/.test(sha)) throw new Error('Invalid artifact checksum');
  const credentials = await readCredentials(config.credentialsFile);
  if (!Object.hasOwn(credentials, workerId)) throw new Error('Artifact credential is missing');
  const url = new URL(config.managerUrl);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = `/artifacts/${sha}`;
  try {
    if (bytes && (bytes.length > MAX_BLOB_BYTES || checksum(bytes) !== sha)) throw new Error();
    const response = await fetchImpl(url, { method: bytes ? 'PUT' : 'GET', headers: { authorization: `Bearer ${credentials[workerId]}`, 'x-s8-worker': workerId }, ...(bytes ? { body: bytes } : {}), redirect: 'error', signal: AbortSignal.timeout(15_000) });
    if (!response.ok) { await response.body?.cancel(); throw new Error(); }
    if (bytes) { await response.body?.cancel(); return; }
    const result = await boundedBody(response.body);
    if (checksum(result) !== sha) throw new Error();
    return result;
  } catch { throw new Error('Artifact transfer failed; check connectivity, checksum, credential and storage limits'); }
}
