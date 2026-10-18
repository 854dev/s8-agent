import { chmodSync, closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import { parseWorkerHost, validWorkerId } from '../development/worker-identity.mjs';

export const agentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function normalize(telegram, source) {
  if (!telegram || typeof telegram !== 'object' || Array.isArray(telegram) || Object.keys(telegram).some(key => !['allowedUserIds', 'allowedGroupIds', 'scheduleChatId'].includes(key))) throw new Error('Invalid Telegram config fields; credentials must stay in environment variables');
  const id = value => {
    if (!['string', 'number'].includes(typeof value) || !/^-?[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw new Error('Telegram IDs must be nonzero, safe numeric IDs (quote IDs in YAML)');
    return String(value);
  };
  const ids = value => {
    if (!Array.isArray(value)) throw new Error('Telegram allowed IDs must be lists');
    return [...new Set(value.map(id))];
  };
  const allowedUserIds = ids(telegram.allowedUserIds ?? []);
  const allowedGroupIds = ids(telegram.allowedGroupIds ?? []);
  if (allowedUserIds.some(value => value.startsWith('-')) || allowedGroupIds.some(value => !value.startsWith('-'))) throw new Error('Telegram user IDs must be positive; group IDs must be negative');
  const scheduleChatId = telegram.scheduleChatId == null ? null : id(telegram.scheduleChatId);
  if (scheduleChatId && ![...allowedUserIds, ...allowedGroupIds].includes(scheduleChatId)) throw new Error('Scheduled Telegram target must be in an allowed user or group list');
  return { allowedUserIds, allowedGroupIds, scheduleChatId, source };
}

export function telegramConfigFromEnv(env = process.env) {
  const list = name => (env[name] ?? '').split(',').map(value => value.trim()).filter(Boolean);
  return normalize({ allowedUserIds: list('TELEGRAM_ALLOWED_USER_IDS'), allowedGroupIds: list('TELEGRAM_ALLOWED_GROUP_IDS'), scheduleChatId: env.S8_SCHEDULE_TELEGRAM_CHAT_ID?.trim() || null }, 'environment');
}

function normalizeWorkerEntries(value) {
  if (value == null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('worker-entries must be a mapping of worker IDs to settings');
  const entries = {};
  for (const [workerId, config] of Object.entries(value)) {
    if (!validWorkerId(workerId)) throw new Error('Worker IDs must contain 1–100 letters, digits, underscores or hyphens and cannot be shell');
    if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).some(key => !['agent', 'host', 'launch', 'root'].includes(key))) throw new Error(`Invalid settings for worker ${workerId}`);
    if (!['pi', 'claude-code'].includes(config.agent)) throw new Error(`Worker ${workerId} agent must be pi or claude-code`);
    if (!['managed', 'external'].includes(config.launch)) throw new Error(`Worker ${workerId} launch must be managed or external`);
    const host = parseWorkerHost(config.host, { required: config.launch === 'managed' });
    if (config.launch === 'external' && host?.kind === 'local') throw new Error(`External worker ${workerId} must not use the managed local host`);
    if (config.root != null && (typeof config.root !== 'string' || !path.isAbsolute(config.root) || config.root.includes('\0'))) throw new Error(`Worker ${workerId} root must be an absolute path`);
    if (config.launch === 'managed' && host?.kind === 'ssh' && !config.root) throw new Error(`Managed SSH worker ${workerId} requires an absolute root path`);
    entries[workerId] = { agent: config.agent, ...(host ? { host: host.value } : {}), launch: config.launch, ...(config.root ? { root: path.normalize(config.root) } : {}) };
  }
  return entries;
}

function normalizeWorkerCommunicator(value) {
  const defaults = { bindAddress: '127.0.0.1', port: 38771, url: 'http://127.0.0.1:38771' };
  if (value == null) return defaults;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['bindAddress', 'port', 'url'].includes(key))) throw new Error('worker-communicator must contain bindAddress, port and url only');
  const { bindAddress, port, url: rawUrl } = { ...defaults, ...value };
  if (typeof bindAddress !== 'string' || net.isIP(bindAddress) !== 4 || !Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('worker-communicator bindAddress must be an IPv4 address and port must be between 1024 and 65535');
  const parts = bindAddress.split('.').map(Number);
  const inTailscaleRange = parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
  if (bindAddress !== '127.0.0.1' && !inTailscaleRange) throw new Error('worker-communicator may bind only to loopback or a Tailscale IPv4 address');
  try {
    const parsed = new URL(rawUrl);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.hostname !== bindAddress || Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80)) !== port || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') throw new Error();
    return { bindAddress, port, url: parsed.origin };
  } catch { throw new Error('worker-communicator url must use the configured bindAddress and port'); }
}

function normalizeRepositoryMappings(value) {
  if (value == null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 200) throw new Error('repository-mappings must be a mapping of central repository paths to local repository paths');
  const mappings = {};
  for (const [source, destination] of Object.entries(value)) {
    if (!path.isAbsolute(source) || source.includes('\0') || typeof destination !== 'string' || !path.isAbsolute(destination) || destination.includes('\0')) throw new Error('Repository mappings must use absolute paths');
    mappings[path.resolve(source)] = path.resolve(destination);
  }
  return mappings;
}

/** Non-credential settings only. A present file is the sole authority, never merged with env IDs. */
export function loadS8Config(root = agentRoot, env = process.env) {
  const file = path.join(root, 's8-config.yml');
  let fd;
  try {
    if (!lstatSync(file).isFile()) throw new Error();
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  }
  catch (error) { if (error.code === 'ENOENT') return { telegram: telegramConfigFromEnv(env), workerEntries: {}, workerCommunicator: normalizeWorkerCommunicator(null), publicUrl: null }; throw new Error('Cannot open s8-config.yml as a regular file'); }
  let data;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024) throw new Error('s8-config.yml must be a regular, unlinked file of at most 64 KB');
    try {
      const text = readFileSync(fd, 'utf8');
      if (Buffer.byteLength(text) > 64 * 1024) throw new Error();
      const document = parseDocument(text, { uniqueKeys: true });
      if (document.errors.length) throw new Error();
      data = document.toJS({ maxAliasCount: 0 });
    } catch { throw new Error('Invalid s8-config.yml YAML; values are not displayed'); }
  } finally { closeSync(fd); }
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !['telegram', 'worker-entries', 'worker-communicator', 'repository-mappings', 'publicUrl'].includes(key))) throw new Error('Invalid s8-config.yml settings; run node pi/bin/s8-config.mjs migrate-workers for a legacy workers.count file');
  const workerEntries = normalizeWorkerEntries(data['worker-entries']);
  const workerCommunicator = normalizeWorkerCommunicator(data['worker-communicator']);
  const repositoryMappings = normalizeRepositoryMappings(data['repository-mappings']);
  let publicUrl = null;
  if (data.publicUrl != null) {
    try {
      const url = new URL(data.publicUrl);
      if (typeof data.publicUrl !== 'string' || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
      publicUrl = url.href;
    } catch { throw new Error('publicUrl must be an HTTP(S) URL without credentials, query or fragment'); }
  }
  return { telegram: normalize(data.telegram ?? (Object.hasOwn(data, 'worker-entries') ? {} : undefined), 'file'), workerEntries, workerCommunicator, repositoryMappings, publicUrl };
}

/** Explicit one-time upgrade preserving the historical worker-1..N assignee IDs. */
export function migrateLegacyWorkerCount(root = agentRoot) {
  const file = path.join(root, 's8-config.yml');
  let fd;
  try {
    if (!lstatSync(file).isFile()) throw new Error();
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch { throw new Error('Cannot open s8-config.yml as a regular file'); }
  let text, stat;
  try {
    stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024) throw new Error('s8-config.yml must be a regular, unlinked file of at most 64 KB');
    text = readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
  let document, data;
  try {
    document = parseDocument(text, { uniqueKeys: true });
    if (document.errors.length) throw new Error();
    data = document.toJS({ maxAliasCount: 0 });
  } catch { throw new Error('Invalid s8-config.yml YAML; values are not displayed'); }
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !['telegram', 'workers', 'publicUrl'].includes(key)) || Object.hasOwn(data, 'worker-entries')) throw new Error('Only a legacy workers.count setting can be migrated');
  const workers = data.workers ?? {};
  if (!workers || typeof workers !== 'object' || Array.isArray(workers) || Object.keys(workers).some(key => key !== 'count')) throw new Error('Invalid legacy worker settings');
  const count = workers.count ?? 2;
  if (!Number.isSafeInteger(count) || count < 1 || count > 100) throw new Error('Legacy workers.count must be between 1 and 100');
  normalize(data.telegram ?? {}, 'file');
  if (data.publicUrl != null) {
    try {
      const url = new URL(data.publicUrl);
      if (typeof data.publicUrl !== 'string' || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    } catch { throw new Error('publicUrl must be an HTTP(S) URL without credentials, query or fragment'); }
  }
  const entries = Object.fromEntries(Array.from({ length: count }, (_, index) => [`worker-${index + 1}`, { agent: 'pi', host: 'local', launch: 'managed' }]));
  document.delete('workers');
  document.set('worker-entries', entries);
  const temp = path.join(path.dirname(file), `.s8-config.yml.${process.pid}.${randomUUID()}.tmp`);
  let writeFd, tempCreated = false;
  try {
    writeFd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), stat.mode & 0o777);
    tempCreated = true;
    writeFileSync(writeFd, String(document));
    fsyncSync(writeFd);
    closeSync(writeFd); writeFd = undefined;
    chmodSync(temp, stat.mode & 0o777);
    const current = lstatSync(file);
    if (current.dev !== stat.dev || current.ino !== stat.ino || !current.isFile() || current.nlink !== 1) throw new Error('s8-config.yml changed during migration');
    renameSync(temp, file);
  } catch (error) {
    if (writeFd !== undefined) closeSync(writeFd);
    if (tempCreated) { try { unlinkSync(temp); } catch {} }
    throw error;
  }
  return { workerIds: Object.keys(entries) };
}

export function loadTelegramConfig(root = agentRoot, env = process.env) {
  return loadS8Config(root, env).telegram;
}
