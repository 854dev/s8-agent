import { randomBytes, randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { mkdir, writeFile, chmod, rename, lstat } from 'node:fs/promises';
import path from 'node:path';
import { validWorkerId } from './worker-identity.mjs';

const tokenFile = (root, workerId) => path.join(root, '.s8-runtime/worker-auth', `${workerId}.token`);

async function ensureAuthDirectory(root) {
  const directory = path.join(root, '.s8-runtime/worker-auth');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Worker authentication directory must be a real directory');
  await chmod(directory, 0o700);
  return directory;
}

export async function ensureWorkerTokens(root, workerIds) {
  await ensureAuthDirectory(root);
  for (const workerId of workerIds) {
    if (!validWorkerId(workerId)) throw new Error('Invalid worker ID');
    const file = tokenFile(root, workerId);
    try { await writeFile(file, `${randomBytes(32).toString('base64url')}\n`, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    await readWorkerToken(root, workerId);
  }
}

export async function readWorkerToken(root, workerId) {
  if (!validWorkerId(workerId)) throw new Error('Invalid worker ID');
  const file = tokenFile(root, workerId);
  let fd;
  try { fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); }
  catch { throw new Error(`Worker authentication is not provisioned for ${workerId}`); }
  let token;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 128 || (stat.mode & 0o077) !== 0) throw new Error(`Worker authentication file permissions are invalid for ${workerId}`);
    token = readFileSync(fd, 'utf8').trim();
  } finally { closeSync(fd); }
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) throw new Error(`Worker authentication is not provisioned for ${workerId}`);
  return token;
}

export async function workerTokenForProvisioning(root, workerId) {
  await ensureWorkerTokens(root, [workerId]);
  return tokenFile(root, workerId);
}

export async function rotateWorkerToken(root, workerId) {
  if (!validWorkerId(workerId)) throw new Error('Invalid worker ID');
  await ensureAuthDirectory(root);
  const file = tokenFile(root, workerId), temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${randomBytes(32).toString('base64url')}\n`, { flag: 'wx', mode: 0o600 });
  await rename(temporary, file);
  return file;
}

