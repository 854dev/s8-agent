import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { controlSchedules } from '../../pi/lib/scheduler/control.mjs';
import { loadS8Config, loadTelegramConfig } from '../../pi/lib/config/s8-config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const visible = text => String(text)
  .replace(/\b((?:[A-Z][A-Z0-9]*_)*(?:API_KEY|TOKEN|PASSWORD|SECRET|AUTHORIZATION|COOKIE|DATABASE_URL|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY))\s*[:=]\s*[^\s,]+/gi, '$1=[REDACTED]')
  .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
  .replace(/\b(?:postgres(?:ql)?|mysql):\/\/[^\s/@]+:[^\s/@]+@/gi, 'database://[REDACTED]@')
  .replace(/\b(?:sk-|ghp_|phcms_sk_)[A-Za-z0-9_-]{8,}/g, '[REDACTED]');
export const toolOutput = event => event.type === 'tool_execution_start'
  ? `🔧 ${String(event.toolName).replace(/[^\w-]/g, '').slice(0, 40) || 'tool'}`
  : event.type === 'tool_execution_end' && event.isError ? '❌ 도구 실행 실패 (상세 결과는 표시하지 않음)' : null;
export function tokenUsage(entries) {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const entry of entries) {
    const message = entry.type === 'message' ? entry.message : null;
    const usage = message?.role === 'assistant' || message?.role === 'toolResult'
      ? message.usage
      : entry.type === 'usage' || entry.type === 'compaction' || entry.type === 'branch_summary' ? entry.usage : null;
    if (!usage) continue;
    for (const key of Object.keys(totals)) if (Number.isFinite(usage[key])) totals[key] += usage[key];
  }
  return { ...totals, total: totals.input + totals.output + totals.cacheRead + totals.cacheWrite };
}

async function telegram(token, fetchImpl, method, body, signal) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(35000),
    });
    const data = await response.json();
    if (response.ok && data.ok) return data.result;
    if (response.status === 429 && attempt < 2) {
      await new Promise(resolve => setTimeout(resolve, Math.min(5000, (data.parameters?.retry_after ?? 1) * 1000)));
      continue;
    }
    throw new Error(`Telegram ${method} failed (${response.status})`);
  }
}

// Private chats require an allowed sender; group chats require an allowed group ID.
// An allowed sender in an unlisted group is NOT enough to authorize the group.
export function sessionKey(message, users, groups) {
  if (!message || (typeof message.text !== 'string' && !attachmentFile(message))) return null;
  const chat = message.chat;
  if (chat?.type === 'private') {
    if (!users.has(String(message.from?.id))) return null;
  } else if (chat?.type === 'group' || chat?.type === 'supergroup') {
    if (!groups.has(String(chat.id)) || message.from?.is_bot) return null;
  } else return null;
  if (!Number.isSafeInteger(chat.id)) return null;
  const thread = message.message_thread_id;
  if (thread !== undefined && (!Number.isSafeInteger(thread) || thread < 0)) return null;
  return `${chat.id}${thread === undefined ? '' : `-${thread}`}`;
}

// Bot API getFile download ceiling.
const MAX_ATTACHMENT = 20 * 1024 * 1024;

/** 텔레그램 메시지의 일반 텍스트 또는 미디어 캡션을 돌려준다. */
export const messageText = message =>
  typeof message?.text === 'string' ? message.text : typeof message?.caption === 'string' ? message.caption : '';

/** 텔레그램 메시지의 사진·문서를 원본 후보로 바꾼다. 그 밖의 형식은 받지 않는다. */
export function attachmentFile(message) {
  const photo = Array.isArray(message?.photo) ? message.photo.at(-1) : null;
  if (photo?.file_id) return { fileId: photo.file_id, name: '텔레그램 사진', ext: '.jpg', size: photo.file_size };
  const document = message?.document;
  if (document?.file_id) return { fileId: document.file_id, name: document.file_name ?? '텔레그램 파일', size: document.file_size };
  return null;
}

const day = seconds => {
  const date = new Date((Number.isFinite(seconds) ? seconds : Math.floor(Date.now() / 1000)) * 1000);
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

/** 파일 이름을 저장해도 안전한 한 줄로 줄인다. 원본 이름은 날짜 뒤에 남긴다. */
export function attachmentName(file, seconds, remotePath = '') {
  const raw = path.basename(String(file.name ?? '').replace(/\\/g, '/'));
  const ext = path.extname(raw) || file.ext || path.extname(remotePath) || '';
  const stem = path.basename(raw, ext)
    .replace(/[\u0000-\u001f/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+/, '')
    .trim()
    .slice(0, 60) || '텔레그램 첨부';
  return `${day(seconds)} ${stem}${ext}`;
}

/** 첨부를 받아 원본 폴더에 저장한다. 저장한 파일 이름과 크기를 돌려준다. */
export async function saveAttachment({ token, fetchImpl = fetch, message, inboxDir }) {
  const file = attachmentFile(message);
  if (!file) return null;
  if (Number.isFinite(file.size) && file.size > MAX_ATTACHMENT) throw new Error('too-big');
  const info = await telegram(token, fetchImpl, 'getFile', { file_id: file.fileId });
  if (!info?.file_path) throw new Error('파일 경로를 받지 못했습니다');
  if (Number.isFinite(info.file_size) && info.file_size > MAX_ATTACHMENT) throw new Error('too-big');
  const response = await fetchImpl(`https://api.telegram.org/file/bot${token}/${info.file_path}`, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`파일 내려받기 실패 (${response.status})`);
  const body = Buffer.from(await response.arrayBuffer());
  await mkdir(inboxDir, { recursive: true });
  const base = attachmentName(file, message.date, info.file_path);
  let target;
  for (let attempt = 1; attempt < 100; attempt++) {
    const candidate = path.join(inboxDir, attempt === 1 ? base : base.replace(/(\.[^.]*)?$/, `-${attempt}$1`));
    try {
      await writeFile(candidate, body, { flag: 'wx' }); // 동시 첨부가 같은 이름을 덮어쓰지 않도록 원자적으로 만든다.
      target = candidate;
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  if (!target) throw new Error('첨부 파일 이름을 정하지 못했습니다');
  return { name: path.basename(target), bytes: body.length };
}

export class Gateway {
  constructor({ mode = 'project', token, pi, chat, thread, fetchImpl = fetch, editInterval = 1000, onClose = () => {}, commandImpl, schedulerImpl = (action, id) => controlSchedules(path.join(root, '.s8-runtime', 'scheduler'), action, id) }) {
    this.mode = mode;
    this.token = token;
    this.pi = pi;
    this.chat = chat;
    this.thread = thread;
    this.fetch = fetchImpl;
    this.editInterval = editInterval;
    this.onClose = onClose;
    this.commandImpl = commandImpl;
    this.schedulerImpl = schedulerImpl;
    this.pending = new Map();
    this.serial = Promise.resolve();
    this.inbound = Promise.resolve();
    this.busy = false;
    this.typingState = null;
    this.stream = null;
    this.tools = null;
    this.nextId = 0;
    this.buffer = '';
    this.decoder = new StringDecoder('utf8');
    this.closed = false;
  }
  telegram(method, body, signal) { return telegram(this.token, this.fetch, method, body, signal); }
  startTyping() {
    if (this.typingState) return;
    const state = { controller: new AbortController(), pending: false, timer: null };
    this.typingState = state;
    const pulse = () => {
      if (!this.busy || this.closed || this.typingState !== state || state.pending) return;
      state.pending = true;
      void this.telegram('sendChatAction', {
        chat_id: this.chat, ...(this.thread === undefined ? {} : { message_thread_id: this.thread }), action: 'typing',
      }, AbortSignal.any([state.controller.signal, AbortSignal.timeout(5000)]))
        .catch(() => {}) // Telegram availability must not block Pi.
        .finally(() => { state.pending = false; });
    };
    pulse();
    state.timer = setInterval(pulse, 4000);
  }
  stopTyping() {
    if (!this.typingState) return;
    clearInterval(this.typingState.timer);
    this.typingState.controller.abort();
    this.typingState = null;
  }
  queue(fn) {
    const job = this.serial.then(fn);
    this.serial = job.catch(error => console.error('Telegram send failed:', error.message));
    return job;
  }
  send(text, reply_markup) {
    return this.queue(() => this.telegram('sendMessage', {
      chat_id: this.chat, ...(this.thread === undefined ? {} : { message_thread_id: this.thread }), text: visible(text),
      ...(reply_markup ? { reply_markup } : {}),
    }));
  }
  menuMarkup() {
    return { keyboard: [['상태', '중단'], ...(this.mode === 'general' ? [] : [['배치']]), ['새 대화', '모델'], ['재시작', '전체 재시작'], ['메뉴', '도움말']], resize_keyboard: true, is_persistent: true };
  }
  showMenu() { return this.send('s8 메뉴', this.menuMarkup()); }
  command(type, fields = {}) {
    if (this.closed) return Promise.reject(new Error('Pi process stopped'));
    if (this.commandImpl) return this.commandImpl(type, fields);
    const id = String(++this.nextId);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Pi RPC timeout')); }, type === 'abort' ? 120000 : 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.pi.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`, error => {
        if (error && this.pending.has(id)) { clearTimeout(timer); this.pending.delete(id); reject(error); }
      });
    });
  }
  onData(chunk) {
    this.buffer += this.decoder.write(chunk);
    let pos;
    while ((pos = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, pos).replace(/\r$/, '');
      this.buffer = this.buffer.slice(pos + 1);
      if (!line) continue;
      try { this.onRecord(JSON.parse(line)); }
      catch (error) { console.error('Invalid Pi RPC record:', error.message); }
    }
  }
  onRecord(event) {
    if (event.type === 'response') {
      const request = this.pending.get(event.id);
      if (request) {
        clearTimeout(request.timer); this.pending.delete(event.id);
        if (event.success) request.resolve(event.data);
        else request.reject(new Error('Pi RPC command rejected'));
      }
      return;
    }
    if (event.type === 'extension_ui_request' && ['select', 'confirm', 'input', 'editor'].includes(event.method)) {
      this.pi.stdin.write(`${JSON.stringify({ type: 'extension_ui_response', id: event.id, cancelled: true })}\n`);
      this.send('Pi 확인 요청은 Telegram에서 지원하지 않아 취소했습니다.').catch(() => {});
      return;
    }
    if (!this.busy) return;
    if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
      if (!this.stream) this.stream = { text: '', sent: '', ids: [], flushing: false };
      this.stream.text += event.assistantMessageEvent.delta;
    } else if (event.type === 'message_end' && event.message?.role === 'assistant') {
      const text = event.message.content?.filter(part => part.type === 'text').map(part => part.text).join('') ?? '';
      if (text) {
        if (!this.stream) this.stream = { text: '', sent: '', ids: [], flushing: false };
        const stream = this.stream;
        stream.text = text;
        this.flush(stream);
        this.stream = null;
      }
      if (event.message.stopReason === 'error') this.send('Pi 응답 오류가 발생했습니다.').catch(() => {});
    } else if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') {
      const text = toolOutput(event);
      if (text) {
        if (!this.tools) this.tools = { text: '', sent: '', ids: [], flushing: false };
        this.tools.text += `${this.tools.text ? '\n' : ''}${text}`;
        if (!this.tools.ids.length) this.flush(this.tools);
      }
    } else if (event.type === 'agent_settled') {
      if (this.tools) this.flush(this.tools);
      this.tools = null;
      this.busy = false;
      this.stopTyping();
    }
  }
  flush(stream) {
    if (stream.flushing || stream.text === stream.sent || !stream.text) return;
    stream.flushing = true;
    let sentSuccessfully = false;
    this.queue(async () => {
      const snapshot = stream.text;
      const chars = Array.from(visible(snapshot));
      const chunks = [];
      for (let i = 0; i < chars.length; i += 3500) chunks.push(chars.slice(i, i + 3500).join(''));
      const previous = stream.chunks ?? [];
      for (let i = 0; i < chunks.length; i++) {
        if (!stream.ids[i]) {
          stream.ids[i] = (await this.telegram('sendMessage', {
            chat_id: this.chat, ...(this.thread === undefined ? {} : { message_thread_id: this.thread }), text: chunks[i],
          })).message_id;
        } else if (previous[i] !== chunks[i]) {
          await this.telegram('editMessageText', { chat_id: this.chat, message_id: stream.ids[i], text: chunks[i] });
        }
      }
      stream.chunks = chunks;
      stream.sent = snapshot;
      sentSuccessfully = true;
    }).catch(() => {}).finally(() => {
      stream.flushing = false;
      if (sentSuccessfully && stream.text !== stream.sent) this.flush(stream);
    });
  }
  async incoming(message) {
    const text = message.text.trim();
    if (!text) return;
    const action = ({ '상태': '/status', '중단': '/abort', '새 대화': '/new', '재시작': '/restart', '전체 재시작': '/restart all', '도움말': '/help', '모델': '/model', '배치': '/jobs' })[text]
      ?? (this.models?.find(model => model.name === text) ? `model:${this.models.find(model => model.name === text).id}` : text);
    try {
      const scheduleCommand = /^\/jobs(?:@[A-Za-z0-9_]+)?(?:\s+(.*))?$/.exec(action);
      if (scheduleCommand && this.mode === 'general') return await this.send('범용 모드에서는 예약 기능을 사용하지 않습니다.');
      if (scheduleCommand) {
        const [operation = 'list', id, ...extra] = (scheduleCommand[1] ?? '').trim().split(/\s+/).filter(Boolean);
        if (extra.length || !['list', 'pause', 'resume', 'stop'].includes(operation) || (operation !== 'list' && !id)) {
          return await this.send('사용법: /jobs\n/jobs pause ID — 예약 정지\n/jobs resume ID — 예약 재개\n/jobs stop ID — 실행 중인 배치 중단');
        }
        try { return await this.send(await this.schedulerImpl(operation, id)); }
        catch (error) { return await this.send(`예약 관리 실패: ${error.message}`); }
      }
      if (action === '/help') return await this.send([
        '명령어:',
        '/status - 현재 상태',
        '/abort - 작업 중단',
        '/new - 새 대화',
        '/model - 모델 선택',
        '/restart - Pi 재시작',
        this.mode === 'general' ? '/restart all - 범용 Pi 재시작' : '/restart all - 인프라·Pi·스케줄러 전체 재시작',
        ...(this.mode === 'general' ? [] : ['/jobs - 배치 상태·중단 (stop ID)']),
        '/help - 이 도움말',
      ].join('\n'), this.menuMarkup());
      if (action === '/status') {
        const state = await this.command('get_state');
        const usage = state.tokenUsage;
        const tokens = usage ? ` · 토큰 ${usage.total.toLocaleString()} (입력 ${usage.input.toLocaleString()} · 출력 ${usage.output.toLocaleString()} · 캐시 ${ (usage.cacheRead + usage.cacheWrite).toLocaleString()})` : '';
        return await this.send(`Pi: ${state.isStreaming ? 'running' : 'idle'} · 이 채팅 전용 세션${tokens}`);
      }
      if (action === '/abort') {
        await this.command('clear_queue');
        await this.command('abort');
        return await this.send('중단 요청을 전달했습니다.');
      }
      if (action === '/new') {
        if (this.busy) return await this.send('진행 중입니다. 먼저 중단한 뒤 다시 시도하세요.');
        const result = await this.command('new_session');
        return await this.send(result?.cancelled ? '새 대화 요청이 취소되었습니다.' : '새 대화를 시작했습니다.');
      }
      if (action === '/model') {
        this.models = await this.command('get_models');
        if (!this.models?.length) return await this.send('사용 가능한 모델을 찾지 못했습니다.');
        return await this.send('모델을 선택하세요.', { keyboard: [...this.models.map(model => [model.name]), ['메뉴']], resize_keyboard: true, is_persistent: true });
      }
      if (action.startsWith('model:')) {
        const result = await this.command('set_model', { model: action.slice(6) });
        return await this.send(result?.ok ? `모델을 ${result.name}(으)로 변경했습니다.` : '모델을 변경하지 못했습니다.');
      }
      const restart = /^\/restart(?:@[A-Za-z0-9_]+)?(?:\s+(.*))?$/.exec(action);
      if (restart) {
        const scope = (restart[1] ?? '').trim();
        if (scope && scope !== 'all') return await this.send('사용법: /restart 또는 /restart all');
        if (this.busy) return await this.send('진행 중입니다. 먼저 중단한 뒤 재시작하세요.');
        await this.send(scope === 'all' && this.mode !== 'general' ? '전체 재시작 요청을 접수했습니다. 인프라와 Pi·스케줄러를 순서대로 재시작합니다. 웹 연결이 잠시 끊길 수 있으며 완료 결과는 Telegram으로 알려드립니다.' : 'Pi를 재시작합니다.');
        const result = await this.command(scope === 'all' ? 'restart_all' : 'restart');
        if (result?.reason === 'busy') return await this.send('진행 중입니다. 먼저 중단한 뒤 재시작하세요.');
        if (!result?.ok) return await this.send('자동 재시작이 설정되지 않았습니다.');
        return;
      }
      if (action === '메뉴') return await this.showMenu();
      if (text.startsWith('/')) return await this.send('알 수 없는 명령입니다. /help');
      const running = this.busy;
      if (!running) { this.busy = true; this.startTyping(); }
      try {
        await this.command('prompt', { message: text, ...(running ? { streamingBehavior: 'steer' } : {}) });
      } catch (error) {
        if (!running) { this.busy = false; this.stopTyping(); }
        throw error;
      }
    } catch (error) {
      console.error('Pi command failed:', error.message);
      await this.send('요청을 처리하지 못했습니다. 잠시 후 다시 시도하세요.').catch(() => {});
    }
  }
  async start() {
    this.pi.stdout.on('data', chunk => this.onData(chunk));
    this.pi.stderr.on('data', () => { /* Pi diagnostics may contain secrets. */ });
    this.pi.on('error', error => { console.error('Pi process failed:', error.message); this.close(); });
    this.pi.on('exit', () => this.close());
    this.timer = setInterval(() => {
      if (this.stream) this.flush(this.stream);
      if (this.tools) this.flush(this.tools);
    }, this.editInterval);
    try { await this.command('get_state'); }
    catch (error) { this.stop(); throw error; }
    return this;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.stopTyping();
    clearInterval(this.timer);
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error('Pi process stopped')); }
    this.pending.clear();
    if (this.busy) this.send('Pi 프로세스가 종료되었습니다. 다시 메시지를 보내세요.').catch(() => {});
    this.onClose();
  }
  stop() { if (!this.pi.stdin.writableEnded) this.pi.stdin.end(); this.close(); }
}

export class Bot {
  constructor({ token, users, groups, fetchImpl = fetch, inboxDir = path.join(loadS8Config(root).kbRoot, 'raw'), spawnPi = (key) => spawn(path.join(root, 'start-manager-agent.sh'), [
    '--mode', 'rpc', '--continue', '--session-dir', path.join(root, '.pi-runtime', 'telegram-sessions', key),
  ], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] }) }) {
    if (!token || (!users.size && !groups.size)) throw new Error('Telegram requires an environment bot token and allowed IDs in config.yml');
    this.token = token;
    this.users = users;
    this.groups = groups;
    this.fetch = fetchImpl;
    this.inboxDir = inboxDir;
    this.spawnPi = spawnPi;
    this.sessions = new Map();
    this.closed = false;
    this.pollController = null;
  }
  getSession(key, message) {
    if (!this.sessions.has(key)) {
      const pi = this.spawnPi(key);
      const gateway = new Gateway({ token: this.token, pi, chat: message.chat.id, thread: message.message_thread_id,
        fetchImpl: this.fetch, onClose: () => { if (this.sessions.get(key) === ready) this.sessions.delete(key); },
      });
      const ready = gateway.start();
      this.sessions.set(key, ready);
      ready.catch(() => { if (this.sessions.get(key) === ready) this.sessions.delete(key); });
    }
    return this.sessions.get(key);
  }
  async route(update) {
    const message = update.message;
    const key = sessionKey(message, this.users, this.groups);
    if (key === null) return;
    const text = messageText(message);
    let prompt = text;
    if (attachmentFile(message)) {
      try {
        const saved = await saveAttachment({ token: this.token, fetchImpl: this.fetch, message, inboxDir: this.inboxDir });
        const shown = `${path.basename(this.inboxDir)}/${saved.name}`;
        await this.reply(message, `첨부를 저장했습니다: ${shown} (${Math.max(1, Math.round(saved.bytes / 1024))}KB)\n필요하면 이 파일을 가리켜 정리를 부탁하세요.`);
        prompt = `첨부 저장: ${shown}\n${text}`;
      } catch (error) {
        console.error('Telegram attachment failed:', error.message);
        await this.reply(message, error.message === 'too-big' ? '첨부가 20MB를 넘어 저장하지 못했습니다.' : '첨부를 저장하지 못했습니다.');
      }
      if (!text.trim()) return;
    }
    if (!prompt.trim()) return;
    try {
      const session = await this.getSession(key, message);
      session.inbound = session.inbound.then(() => session.incoming({ ...message, text: prompt }));
      await session.inbound;
    } catch (error) {
      console.error('Telegram session failed:', error.message);
      await this.reply(message, 'Pi 세션을 시작하지 못했습니다. 작업 디렉터리와 Pi 설치 상태를 확인하세요.');
    }
  }
  reply(message, text) {
    return telegram(this.token, this.fetch, 'sendMessage', {
      chat_id: message.chat.id,
      ...(message.message_thread_id === undefined ? {} : { message_thread_id: message.message_thread_id }),
      text,
    }).catch(() => {});
  }
  async run() {
    const latest = await telegram(this.token, this.fetch, 'getUpdates', { offset: -1, timeout: 0, allowed_updates: ['message'] });
    let offset = latest.length ? latest.at(-1).update_id + 1 : 0;
    while (!this.closed) {
      this.pollController = new AbortController();
      try {
        const updates = await telegram(this.token, this.fetch, 'getUpdates', { offset, timeout: 25, allowed_updates: ['message'] },
          AbortSignal.any([this.pollController.signal, AbortSignal.timeout(35000)]));
        for (const update of updates) {
          offset = update.update_id + 1;
          // Dispatch without waiting for a slow Pi session; each chat serializes its own input.
          void this.route(update);
        }
      } catch (error) {
        if (this.closed) break;
        console.error('Telegram polling failed:', error.message);
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }
  }
  stop() {
    this.closed = true;
    this.pollController?.abort();
    for (const session of this.sessions.values()) void session.then(gateway => gateway.stop()).catch(() => {});
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const settings = loadTelegramConfig(root);
    const bot = new Bot({ token: process.env.TELEGRAM_BOT_TOKEN, users: new Set(settings.allowedUserIds), groups: new Set(settings.allowedGroupIds) });
    process.on('SIGINT', () => bot.stop());
    process.on('SIGTERM', () => bot.stop());
    bot.run().catch(error => { console.error('Gateway stopped:', error.message); bot.stop(); process.exitCode = 1; });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
