import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

export const agentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

// s8-config.yml: 비밀이 아닌 장비별 설정. 비밀값(서비스 키·봇 토큰)은 .env에만 둔다.
// 파일이 없거나 항목을 생략하면 아래 기본값을 쓴다.
const DEFAULTS = { kbRoot: '../854_md', projectman: { apiUrl: null, startCommand: null }, network: { bindIp: '127.0.0.1', httpPort: 80 } };

const plainObject = value => value && typeof value === 'object' && !Array.isArray(value);
function fields(value, allowed, name) {
  if (value === undefined || value === null) return {};
  if (!plainObject(value)) throw new Error(`s8-config.yml: ${name} must be a mapping`);
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length) throw new Error(`s8-config.yml: unknown ${name} keys: ${unknown.join(', ')}`);
  return value;
}
// 값은 오류 메시지에 넣지 않는다(키 이름만 보여 준다).
const text = (value, name, pattern = /^[^\0\r\n]{1,1000}$/) => {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`s8-config.yml: ${name} must be a single-line string`);
  return value;
};

function normalizeTelegram(telegram) {
  telegram = fields(telegram, ['allowedUserIds', 'allowedGroupIds', 'scheduleChatId'], 'telegram');
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
  return { allowedUserIds, allowedGroupIds, scheduleChatId };
}

// 상주 워커 모드. active: ready 작업을 찾아 수행, passive: 지시를 받아야 수행, paused: 새 작업을 받지 않음.
export const WORKER_MODES = ['active', 'passive', 'paused'];
export const WORKER_ID = /^[a-z][a-z0-9-]{0,31}$/;

function normalizeWorkers(workers) {
  if (workers == null) return [];
  if (!Array.isArray(workers) || workers.length > 20) throw new Error('s8-config.yml: workers must be a list of at most 20 entries');
  const ids = new Set();
  return workers.map(entry => {
    const worker = fields(entry, ['id', 'mode'], 'workers[]');
    if (typeof worker.id !== 'string' || !WORKER_ID.test(worker.id)) throw new Error('s8-config.yml: workers[].id must be lowercase letters, digits or -, starting with a letter (max 32)');
    if (ids.has(worker.id)) throw new Error(`s8-config.yml: duplicate worker id: ${worker.id}`);
    ids.add(worker.id);
    const mode = worker.mode ?? 'passive';
    if (!WORKER_MODES.includes(mode)) throw new Error(`s8-config.yml: workers[].mode must be ${WORKER_MODES.join(', ')}`);
    return { id: worker.id, mode };
  });
}

function httpUrl(value, name) {
  try {
    const url = new URL(value);
    if (typeof value !== 'string' || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    return url.href;
  } catch { throw new Error(`s8-config.yml: ${name} must be an HTTP(S) URL without credentials, query or fragment`); }
}

function normalizeCommunication(value, root) {
  const config = fields(value, ['enabled', 'nodeId', 'server', 'managerUrl', 'credentialsFile', 'repositories'], 'communication');
  const enabled = config.enabled ?? false;
  if (typeof enabled !== 'boolean') throw new Error('s8-config.yml: communication.enabled must be boolean');
  const nodeId = config.nodeId == null ? null : text(config.nodeId, 'communication.nodeId', WORKER_ID);
  const credentialsFile = config.credentialsFile == null ? null : path.resolve(root, expandHome(text(config.credentialsFile, 'communication.credentialsFile')));
  let server = null, managerUrl = null;
  if (config.server != null) {
    const input = fields(config.server, ['bindIp', 'port'], 'communication.server');
    const bindIp = input.bindIp ?? '127.0.0.1', port = input.port ?? 8090;
    if (typeof bindIp !== 'string' || !isIP(bindIp) || ['0.0.0.0', '::'].includes(bindIp)) throw new Error('s8-config.yml: communication.server.bindIp must be a specific IP address');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('s8-config.yml: communication.server.port must be a port number');
    server = { bindIp, port };
  }
  if (config.managerUrl != null) {
    try {
      const url = new URL(config.managerUrl);
      if (typeof config.managerUrl !== 'string' || !['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error();
      managerUrl = url.href;
    } catch { throw new Error('s8-config.yml: communication.managerUrl must be a WS(S) origin without credentials, query or fragment'); }
  }
  if (enabled && (!nodeId || !credentialsFile || !managerUrl)) throw new Error('s8-config.yml: enabled communication requires nodeId, credentialsFile and managerUrl');
  const repositories = {};
  if (config.repositories != null) {
    if (!plainObject(config.repositories) || Object.keys(config.repositories).length > 100) throw new Error('s8-config.yml: communication.repositories must be a mapping of at most 100 repositories');
    for (const [source, entry] of Object.entries(config.repositories)) {
      if (!path.isAbsolute(source) || /[\0\r\n]/.test(source) || source.length > 1000) throw new Error('s8-config.yml: repository keys must be approved absolute repoPath values');
      const repo = fields(entry, ['path', 'remote', 'kind'], 'communication.repositories[]');
      const kind = repo.kind ?? 'git';
      if (!['git', 'files'].includes(kind)) throw new Error('s8-config.yml: repository kind must be git or files');
      const local = path.resolve(root, expandHome(text(repo.path, 'communication.repositories[].path')));
      const remote = kind === 'git' && repo.remote != null ? text(repo.remote, 'communication.repositories[].remote', /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/) : null;
      if (kind === 'files' && repo.remote != null) throw new Error('s8-config.yml: files repositories cannot specify a Git remote');
      repositories[source] = { path: local, kind, remote };
    }
  }
  return { enabled, nodeId, server, managerUrl, credentialsFile, repositories };
}

function readConfigFile(file) {
  let fd;
  try {
    if (!lstatSync(file).isFile()) throw new Error();
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  }
  catch (error) { if (error.code === 'ENOENT') return {}; throw new Error('Cannot open s8-config.yml as a regular file'); }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024) throw new Error('s8-config.yml must be a regular, unlinked file of at most 64 KB');
    let data;
    try {
      const source = readFileSync(fd, 'utf8');
      if (Buffer.byteLength(source) > 64 * 1024) throw new Error();
      const document = parseDocument(source, { uniqueKeys: true });
      if (document.errors.length) throw new Error();
      data = document.toJS({ maxAliasCount: 0 });
    } catch { throw new Error('Invalid s8-config.yml YAML; values are not displayed'); }
    return data ?? {};
  } finally { closeSync(fd); }
}

// 경로 앞의 ~는 홈 디렉터리로 바꾼다(~user 형식은 지원하지 않는다).
const expandHome = value => value === '~' || value.startsWith('~/') ? path.join(os.homedir(), value.slice(1)) : value;

/** s8-config.yml을 읽어 검증하고 기본값을 채운다. 상대 kbRoot는 저장소 루트 기준 절대 경로로 바꾼다. */
export function loadS8Config(root = agentRoot) {
  const data = fields(readConfigFile(path.join(root, 's8-config.yml')), ['kbRoot', 'projectman', 'network', 'workers', 'telegram', 'publicUrl', 'communication'], 'top-level');
  const projectman = fields(data.projectman, ['apiUrl', 'startCommand'], 'projectman');
  const network = fields(data.network, ['bindIp', 'httpPort'], 'network');
  const bindIp = network.bindIp == null ? DEFAULTS.network.bindIp : text(network.bindIp, 'network.bindIp');
  if (!isIP(bindIp) || bindIp === '0.0.0.0' || bindIp === '::') throw new Error('s8-config.yml: network.bindIp must be a specific IP address');
  const httpPort = network.httpPort ?? DEFAULTS.network.httpPort;
  if (!Number.isInteger(httpPort) || httpPort < 1 || httpPort > 65535) throw new Error('s8-config.yml: network.httpPort must be a port number');
  const communication = normalizeCommunication(data.communication, root);
  const workers = normalizeWorkers(data.workers);
  if (communication.enabled && workers.some(worker => worker.id === 'manager')) throw new Error('s8-config.yml: manager is reserved and cannot be a communication Worker ID');
  return {
    kbRoot: path.resolve(root, data.kbRoot == null ? DEFAULTS.kbRoot : expandHome(text(data.kbRoot, 'kbRoot'))),
    projectman: {
      apiUrl: projectman.apiUrl == null ? DEFAULTS.projectman.apiUrl : httpUrl(projectman.apiUrl, 'projectman.apiUrl').replace(/\/$/, ''),
      startCommand: projectman.startCommand == null ? DEFAULTS.projectman.startCommand : text(projectman.startCommand, 'projectman.startCommand'),
    },
    network: { bindIp, httpPort },
    workers,
    communication,
    telegram: normalizeTelegram(data.telegram),
    publicUrl: data.publicUrl == null ? null : httpUrl(data.publicUrl, 'publicUrl'),
  };
}

/**
 * 설정을 하위 프로세스(Pi 확장·라우터·frontend·스케줄러)가 읽는 내부 환경변수로 넘긴다. 이 이름들은 사용자가 .env에 쓰는 값이 아니다.
 * 설정에 없는 항목은 지워서 설정 파일만 기준이 되게 한다.
 */
export function settingsEnv(config) {
  return {
    S8_KB_ROOT: config.kbRoot,
    PHCMS_API_URL: config.projectman.apiUrl,
    PHCMS_START_COMMAND: config.projectman.startCommand,
    S8_BIND_IP: config.network.bindIp,
    S8_HTTP_PORT: String(config.network.httpPort),
  };
}

export function applyS8Config(root = agentRoot, env = process.env) {
  const config = loadS8Config(root);
  for (const [name, value] of Object.entries(settingsEnv(config))) {
    if (value == null) delete env[name];
    else env[name] = value;
  }
  return config;
}

export function loadTelegramConfig(root = agentRoot) {
  return loadS8Config(root).telegram;
}
