// Agent registry: { "agents": { "<id>": { "role": "manager|worker", "tokenSha256": "<hex>" } } }.
// The center keeps token hashes only. Errors never include file contents.
import { constants, open, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { AGENT_ID, ROLES, TOKEN } from './protocol.mjs';

const MAX_AGENTS = 50;
const HASH = /^[a-f0-9]{64}$/;
export const hashToken = token => createHash('sha256').update(token).digest('hex');

async function readPrivateJson(file, maxBytes) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes || (stat.mode & 0o077)) throw new Error();
    return JSON.parse(await handle.readFile('utf8'));
  } finally { await handle?.close(); }
}

/** Map of agent ID → { role, hash }. */
export async function readRegistry(file) {
  try {
    const value = await readPrivateJson(file, 64 * 1024);
    if (!value || Object.keys(value).some(key => key !== 'agents') || !value.agents || typeof value.agents !== 'object' || Array.isArray(value.agents)) throw new Error();
    const entries = Object.entries(value.agents);
    if (!entries.length || entries.length > MAX_AGENTS) throw new Error();
    return new Map(entries.map(([id, entry]) => {
      if (!AGENT_ID.test(id) || !entry || Object.keys(entry).some(key => !['role', 'tokenSha256'].includes(key))) throw new Error();
      if (!ROLES.includes(entry.role) || typeof entry.tokenSha256 !== 'string' || !HASH.test(entry.tokenSha256)) throw new Error();
      return [id, { role: entry.role, hash: Buffer.from(entry.tokenSha256, 'hex') }];
    }));
  } catch { throw new Error('comm-center: agents file must be a private regular JSON file of agent roles and token hashes'); }
}

/** The agent whose token hash matches, or null. Compares every entry in constant time. */
export function findAgent(registry, token) {
  if (typeof token !== 'string' || !TOKEN.test(token)) return null;
  const actual = Buffer.from(hashToken(token), 'hex');
  let found = null;
  for (const [id, entry] of registry) if (timingSafeEqual(actual, entry.hash)) found = { id, role: entry.role };
  return found;
}

/** Client token file: { "token": "<secret>" }. */
export async function readTokenFile(file) {
  try {
    const value = await readPrivateJson(file, 4096);
    if (!value || Object.keys(value).some(key => key !== 'token') || !TOKEN.test(value.token ?? '')) throw new Error();
    return value.token;
  } catch { throw new Error('comm-center: token file must be a private regular JSON file with one token'); }
}

/** Create a new token file (never overwrites) and register its hash. The token is never printed. */
export async function issueToken({ agentsFile, id, role, tokenFile }) {
  if (!AGENT_ID.test(id ?? '')) throw new Error('comm-center: agent ID must be lowercase letters, digits or -, starting with a letter (max 32)');
  if (!ROLES.includes(role)) throw new Error(`comm-center: role must be ${ROLES.join(' or ')}`);
  // One registration at a time: concurrent runs would otherwise drop each other's entries.
  const lock = `${agentsFile}.lock`;
  try { await writeFile(lock, `${process.pid}\n`, { mode: 0o600, flag: 'wx' }); }
  catch (error) { throw error.code === 'EEXIST' ? new Error(`comm-center: another registration holds ${lock}; remove it if none is running`) : error; }
  try { return await register({ agentsFile, id, role, tokenFile }); }
  finally { await rm(lock, { force: true }); }
}

async function register({ agentsFile, id, role, tokenFile }) {
  let agents = {};
  try { agents = (await readPrivateJson(agentsFile, 64 * 1024)).agents ?? {}; }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('comm-center: existing agents file is not a private regular JSON file'); }
  const token = randomBytes(32).toString('base64url');
  await writeFile(tokenFile, `${JSON.stringify({ token })}\n`, { mode: 0o600, flag: 'wx' });
  const temporary = path.join(path.dirname(agentsFile), `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify({ agents: { ...agents, [id]: { role, tokenSha256: hashToken(token) } } }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, agentsFile);
  } catch (error) { await rm(tokenFile, { force: true }); throw error; }
  finally { await rm(temporary, { force: true }); }
}
