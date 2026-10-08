import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const visible = text => String(text)
  .replace(/\b(API_KEY|TOKEN|PASSWORD|SECRET|AUTHORIZATION|COOKIE|DATABASE_URL|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY)\s*[:=]\s*[^\s,]+/gi, '$1=[REDACTED]')
  .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
  .replace(/\b(?:postgres(?:ql)?|mysql):\/\/[^\s/@]+:[^\s/@]+@/gi, 'database://[REDACTED]@')
  .replace(/\b(?:sk-|ghp_)[A-Za-z0-9_-]{8,}/g, '[REDACTED]');
export const toolOutput = event => event.type === 'tool_execution_start'
  ? `🔧 ${String(event.toolName).replace(/[^\w-]/g, '').slice(0, 40) || 'tool'}`
  : event.type === 'tool_execution_end' && event.isError ? '❌ 도구 실행 실패 (상세 결과는 표시하지 않음)' : null;

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
  if (!message || typeof message.text !== 'string') return null;
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

export class Gateway {
  constructor({ token, pi, chat, thread, fetchImpl = fetch, editInterval = 1000, onClose = () => {}, commandImpl }) {
    this.token = token;
    this.pi = pi;
    this.chat = chat;
    this.thread = thread;
    this.fetch = fetchImpl;
    this.editInterval = editInterval;
    this.onClose = onClose;
    this.commandImpl = commandImpl;
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
  send(text) {
    return this.queue(() => this.telegram('sendMessage', {
      chat_id: this.chat, ...(this.thread === undefined ? {} : { message_thread_id: this.thread }), text: visible(text),
    }));
  }
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
    try {
      if (text === '/help') return await this.send('/status /abort /new /help');
      if (text === '/status') {
        const state = await this.command('get_state');
        return await this.send(`Pi: ${state.isStreaming ? 'running' : 'idle'} · 이 채팅 전용 세션`);
      }
      if (text === '/abort') {
        await this.command('clear_queue');
        await this.command('abort');
        return await this.send('중단 요청을 전달했습니다.');
      }
      if (text === '/new') {
        if (this.busy) return await this.send('진행 중입니다. /abort 후 다시 시도하세요.');
        const result = await this.command('new_session');
        return await this.send(result?.cancelled ? '새 세션 요청이 거부되었습니다.' : '새 대화를 시작합니다.');
      }
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
  constructor({ token, users, groups, fetchImpl = fetch, spawnPi = (key) => spawn(path.join(root, 'start-pi.sh'), [
    '--mode', 'rpc', '--continue', '--session-dir', path.join(root, '.pi-runtime', 'telegram-sessions', key),
  ], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] }) }) {
    if (!token || (!users.size && !groups.size)) throw new Error('Set TELEGRAM_BOT_TOKEN and TELEGRAM_ALLOWED_USER_IDS or TELEGRAM_ALLOWED_GROUP_IDS');
    this.token = token;
    this.users = users;
    this.groups = groups;
    this.fetch = fetchImpl;
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
    if (key === null || !message.text.trim()) return;
    try {
      const session = await this.getSession(key, message);
      session.inbound = session.inbound.then(() => session.incoming(message));
      await session.inbound;
    } catch (error) {
      console.error('Telegram session failed:', error.message);
      await telegram(this.token, this.fetch, 'sendMessage', {
        chat_id: message.chat.id,
        ...(message.message_thread_id === undefined ? {} : { message_thread_id: message.message_thread_id }),
        text: 'Pi 세션을 시작하지 못했습니다. 작업 디렉터리와 Pi 설치 상태를 확인하세요.',
      }).catch(() => {});
    }
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
  const parseIds = name => {
    const entries = (process.env[name] ?? '').split(',').map(id => id.trim()).filter(Boolean);
    if (entries.some(id => !/^-?\d+$/.test(id))) throw new Error(`Invalid ${name}: comma-separated numeric IDs required`);
    return new Set(entries);
  };
  try {
    const bot = new Bot({ token: process.env.TELEGRAM_BOT_TOKEN, users: parseIds('TELEGRAM_ALLOWED_USER_IDS'), groups: parseIds('TELEGRAM_ALLOWED_GROUP_IDS') });
    process.on('SIGINT', () => bot.stop());
    process.on('SIGTERM', () => bot.stop());
    bot.run().catch(error => { console.error('Gateway stopped:', error.message); bot.stop(); process.exitCode = 1; });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
