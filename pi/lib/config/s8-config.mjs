import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

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

/** Non-credential settings only. A present file is the sole authority, never merged with env IDs. */
export function loadS8Config(root = agentRoot, env = process.env) {
  const file = path.join(root, 's8-config.yml');
  let fd;
  try {
    if (!lstatSync(file).isFile()) throw new Error();
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  }
  catch (error) { if (error.code === 'ENOENT') return { telegram: telegramConfigFromEnv(env), workers: { count: 2 }, publicUrl: null }; throw new Error('Cannot open s8-config.yml as a regular file'); }
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
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !['telegram', 'workers', 'publicUrl'].includes(key))) throw new Error('Invalid s8-config.yml settings');
  const workers = data.workers ?? {};
  if (!workers || typeof workers !== 'object' || Array.isArray(workers) || Object.keys(workers).some(key => key !== 'count') || !Number.isSafeInteger(workers.count ?? 2) || (workers.count ?? 2) < 1) throw new Error('workers.count must be a positive safe integer');
  let publicUrl = null;
  if (data.publicUrl != null) {
    try {
      const url = new URL(data.publicUrl);
      if (typeof data.publicUrl !== 'string' || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
      publicUrl = url.href;
    } catch { throw new Error('publicUrl must be an HTTP(S) URL without credentials, query or fragment'); }
  }
  return { telegram: normalize(data.telegram ?? (data.workers ? {} : undefined), 'file'), workers: { count: workers.count ?? 2 }, publicUrl };
}

export function loadTelegramConfig(root = agentRoot, env = process.env) {
  return loadS8Config(root, env).telegram;
}
