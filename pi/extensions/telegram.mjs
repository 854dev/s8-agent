import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Bot, Gateway, sessionKey, tokenUsage } from '../../apps/telegram-gateway/gateway.mjs';
import { agentRoot, loadTelegramConfig } from '../lib/config/s8-config.mjs';
import { queuePiRuntimeRestart } from '../lib/runtime/restart.mjs';
import { telegramOwner } from '../lib/telegram/status.mjs';
import { validSession } from '../lib/runtime/managed-sessions.mjs';
import { waitUntil } from '../lib/runtime/process.mjs';

async function requestFullRestart(notification) {
  if (!process.env.TMUX) throw new Error('전체 재시작은 start-pi 관리 세션에서 사용할 수 있습니다.');
  const session = execFileSync('tmux', ['display-message', '-p', '#S'], { encoding: 'utf8' }).trim();
  if (!validSession(session)) throw new Error('잘못된 관리 세션입니다.');
  return queuePiRuntimeRestart(agentRoot, { all: true, session, notification });
}

// One local polling owner per bot. Older Pi instances retry only when the owner exits.
export function ownership({ port, key, onAcquire, onRelease, interval = 1000, started = process.hrtime.bigint(), session = 'Pi' }) {
  const signature = stamp => createHmac('sha256', key).update(stamp).digest('hex');
  let server, stopped = false, acquiring = false, retryAfter = 0;
  const release = () => { if (server) { server.close(); server = null; onRelease(); } };
  const attempt = async () => {
    if (stopped || server || acquiring || Date.now() < retryAfter) return;
    acquiring = true;
    const candidate = net.createServer(socket => {
      socket.setTimeout(2000, () => socket.destroy());
      socket.once('data', data => {
        if (data.toString() === 'status') { socket.end(JSON.stringify({ session })); return; }
        const [stamp, mac] = data.toString().split(':');
        const expected = /^\d+$/.test(stamp) ? signature(stamp) : '';
        if (expected && /^[0-9a-f]{64}$/.test(mac ?? '') && timingSafeEqual(Buffer.from(mac), Buffer.from(expected)) && BigInt(stamp) > started) {
          retryAfter = Date.now() + interval * 3;
          release();
          socket.end('released');
        } else socket.end('older');
      });
    });
    try {
      await new Promise((resolve, reject) => {
        candidate.once('error', reject);
        candidate.listen(port, '127.0.0.1', resolve);
      });
      candidate.removeAllListeners('error');
      candidate.on('error', error => console.error('Telegram ownership:', error.message));
      if (stopped) candidate.close();
      else { server = candidate; onAcquire(release); }
    } catch (error) {
      if (error.code !== 'EADDRINUSE') console.error('Telegram ownership:', error.message);
      else {
        const socket = net.connect(port, '127.0.0.1');
        socket.on('connect', () => socket.write(`${started}:${signature(String(started))}`));
        socket.on('data', () => socket.end());
        socket.on('error', () => {});
        socket.setTimeout(2000, () => socket.destroy());
      }
    } finally { acquiring = false; }
  };
  const timer = setInterval(attempt, interval);
  void attempt();
  return () => { stopped = true; clearInterval(timer); release(); };
}

export function attach(pi, { port = 39485, config = process.env, fetchImpl = fetch, autoStart = true, mode = 'project', settings, session = 'Pi', persist = () => {}, restartAllImpl = requestFullRestart } = {}) {
  let started = process.hrtime.bigint();
  let stopOwner, gateway, telegramPrompt = false, context, enabled = autoStart;
  pi.registerCommand('telegram-new', { description: 'Telegram에서 새 대화를 시작합니다', handler: async (_args, ctx) => { await ctx.newSession(); } });
  const start = ctx => {
    stopOwner?.();
    stopOwner = null;
    telegramPrompt = false;
    if (ctx.mode !== 'tui') return;
    const token = config.TELEGRAM_BOT_TOKEN;
    let current;
    try { current = settings ?? loadTelegramConfig(undefined, config); }
    catch (error) { console.error(error.message); return; }
    let users = new Set(current.allowedUserIds);
    let groups = new Set(current.allowedGroupIds);
    if (!token || (!users.size && !groups.size)) return;
    let bot, selected;
    const stop = () => { bot?.stop(); bot = null; gateway?.stop(); gateway = null; selected = null; telegramPrompt = false; };
    stopOwner = ownership({ port, key: token, started, session, onRelease: stop, onAcquire: releaseOwner => {
      // A prior Pi owner must re-read the shared policy before resuming polling.
      try {
        current = settings ?? loadTelegramConfig(undefined, config);
        users = new Set(current.allowedUserIds); groups = new Set(current.allowedGroupIds);
        if (!users.size && !groups.size) { releaseOwner(); return; }
      } catch (error) { console.error(error.message); releaseOwner(); return; }
      const currentBot = new Bot({ token, users, groups, fetchImpl, spawnPi: () => { throw new Error('not used'); } });
      bot = currentBot;
      currentBot.route = async update => {
        const message = update.message;
        const key = sessionKey(message, users, groups);
        if (currentBot.closed || key === null || !message.text.trim()) return;
        if (selected && selected !== key) return; // Do not leak one chat's shared CLI conversation to another.
        if (!selected) {
          selected = key;
          const fake = new EventEmitter();
          fake.stdout = new EventEmitter();
          fake.stderr = new EventEmitter();
          fake.stdin = { writableEnded: false, end() { this.writableEnded = true; fake.emit('exit'); } };
          gateway = new Gateway({ mode, token, chat: message.chat.id, thread: message.message_thread_id, pi: fake, fetchImpl,
            commandImpl: async (type, fields) => {
              if (type === 'get_state') return {
                isStreaming: !ctx.isIdle(),
                tokenUsage: tokenUsage(ctx.sessionManager.getBranch()),
              };
              if (type === 'prompt') {
                telegramPrompt = true;
                try { pi.sendUserMessage(fields.message, ctx.isIdle() ? {} : { deliverAs: 'steer' }); }
                catch (error) { telegramPrompt = false; throw error; }
                return;
              }
              if (type === 'abort') { ctx.abort(); return; }
              if (type === 'clear_queue') return;
              if (type === 'new_session') {
                pi.sendUserMessage('/telegram-new', { expandPromptTemplates: true });
                return { cancelled: false };
              }
              if (type === 'get_models') return ctx.modelRegistry.getAvailable().map(model => ({ id: `${model.provider}/${model.id}`, name: `${ctx.modelRegistry.getProviderDisplayName(model.provider)} · ${model.name}` }));
              if (type === 'set_model') {
                const [provider, ...parts] = String(fields.model ?? '').split('/');
                const model = ctx.modelRegistry.find(provider, parts.join('/'));
                if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) return { ok: false };
                const ok = await pi.setModel(model);
                return { ok, name: model.name };
              }
              if (type === 'restart_all') {
                if (!ctx.isIdle()) return { ok: false, reason: 'busy' };
                const result = await restartAllImpl({ chat: message.chat.id, ...(message.message_thread_id === undefined ? {} : { thread: message.message_thread_id }) });
                return { ok: true, runId: result.id };
              }
              if (type === 'restart') {
                if (!config.S8_PI_RESTART_DIR) return { ok: false };
                await writeFile(`${config.S8_PI_RESTART_DIR}/restart-${process.ppid}`, 'restart\n', { mode: 0o600 });
                ctx.shutdown();
                return { ok: true };
              }
            },
          });
          await gateway.start();
          await gateway.showMenu();
        }
        if (currentBot.closed || !gateway) return;
        const active = gateway;
        active.inbound = active.inbound.then(() => active.incoming(message));
        await active.inbound;
      };
      void currentBot.run().catch(error => {
        console.error('Telegram polling:', error.message);
        if (bot === currentBot) releaseOwner();
      });
    } });
    return true;
  };
  pi.on('session_start', (_event, ctx) => { context = ctx; if (enabled) start(ctx); });
  // Keep event delivery in the same Pi process so terminal and Telegram see one conversation.
  pi.on('input', event => {
    if (event.source === 'interactive' && event.text && !event.text.startsWith('/'))
      gateway?.send(`👤 ${event.text}`).catch(() => {});
  });
  pi.on('agent_start', () => { if (gateway) { gateway.busy = true; gateway.startTyping(); } });
  pi.on('message_update', event => gateway?.onRecord(event));
  pi.on('message_end', event => gateway?.onRecord(event));
  pi.on('tool_execution_start', event => gateway?.onRecord(event));
  pi.on('tool_execution_end', event => gateway?.onRecord(event));
  pi.on('ui_prompt_start', (_event, ctx) => { if (telegramPrompt) ctx.abort(); });
  pi.on('agent_settled', event => { gateway?.onRecord(event); telegramPrompt = false; });
  pi.on('session_shutdown', () => { stopOwner?.(); stopOwner = null; context = undefined; });
  const activate = ({ force = true } = {}) => {
    if (!context || !config.TELEGRAM_BOT_TOKEN) throw new Error('Telegram 설정 또는 실행 세션이 없습니다.');
    if (force) started = process.hrtime.bigint();
    if ((force || !stopOwner) && !start(context)) throw new Error('Telegram 허용 채팅 설정이 올바르지 않습니다.');
    enabled = true;
  };
  // 폴링 소유 세션이 predicate를 만족할 때까지 최대 6.5초 기다리고 마지막 소유자를 돌려준다.
  const waitOwner = async predicate => {
    let owner;
    await waitUntil(async () => predicate(owner = await telegramOwner({ port })), { timeoutMs: 6500 });
    return owner;
  };
  const describe = owner => `Telegram: ${owner ? owner + ' 연결' : '연결 없음'} · 이 세션 ${enabled ? owner === session ? '수신 중' : '연결 대기' : '꺼짐'}`;
  activate.control = async action => {
    const before = await telegramOwner({ port });
    if (action === 'status') return describe(before);
    if (action === 'take') {
      if (before !== session || !stopOwner) activate();
      const owner = await waitOwner(value => value === session);
      if (owner !== session) {
        stopOwner?.(); stopOwner = null; enabled = false; persist(false);
        throw new Error('Telegram 연결을 가져오지 못했습니다. 설정과 현재 연결 상태를 확인하세요.');
      }
      persist(true);
      return `Telegram: ${before && before !== session ? before + ' → ' : ''}${session} 연결 이전 완료`;
    }
    if (action === 'off') {
      persist(false);
      enabled = false;
      stopOwner?.(); stopOwner = null;
      const owner = before === session ? await waitOwner(value => value !== null && value !== session) : before;
      return `이 세션 Telegram 연결 해제. ${describe(owner)}`;
    }
    throw new Error('사용법: /telegram [take|off]');
  };
  pi.registerCommand('telegram', {
    description: 'Telegram 연결 상태·가져오기·해제 (/telegram take|off)',
    handler: async (args, ctx) => {
      try {
        let action = args.trim();
        if (!action) {
          ctx.ui.notify(await activate.control('status'), 'info');
          const selected = await ctx.ui.select('Telegram 연결', ['현재 연결 유지', '여기로 가져오기', '이 세션 연결 해제']);
          action = selected === '여기로 가져오기' ? 'take' : selected === '이 세션 연결 해제' ? 'off' : 'status';
        }
        ctx.ui.notify(await activate.control(action), 'info');
      } catch (error) { ctx.ui.notify(error.message, 'error'); }
    },
  });
  return activate;
}

export default attach;
