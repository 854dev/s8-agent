import net from 'node:net';
import { writeFile } from 'node:fs/promises';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Bot, Gateway, sessionKey, tokenUsage } from '../../apps/telegram-gateway/gateway.mjs';
import { loadTelegramConfig } from '../lib/telegram-config.mjs';

// One local polling owner per bot. Older Pi instances retry only when the owner exits.
export function ownership({ port, key, onAcquire, onRelease, interval = 1000 }) {
  const started = process.hrtime.bigint();
  const signature = stamp => createHmac('sha256', key).update(stamp).digest('hex');
  let server, stopped = false, acquiring = false, retryAfter = 0;
  const release = () => { if (server) { server.close(); server = null; onRelease(); } };
  const attempt = async () => {
    if (stopped || server || acquiring || Date.now() < retryAfter) return;
    acquiring = true;
    const candidate = net.createServer(socket => {
      socket.setTimeout(2000, () => socket.destroy());
      socket.once('data', data => {
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

export function attach(pi, { port = 39485, config = process.env, fetchImpl = fetch, autoStart = true, settings } = {}) {
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
    stopOwner = ownership({ port, key: token, onRelease: stop, onAcquire: releaseOwner => {
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
          gateway = new Gateway({ token, chat: message.chat.id, thread: message.message_thread_id, pi: fake, fetchImpl,
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
  return () => {
    if (!context || !config.TELEGRAM_BOT_TOKEN) throw new Error('Telegram 설정 또는 실행 세션이 없습니다.');
    if (!start(context)) throw new Error('Telegram 허용 채팅 설정이 올바르지 않습니다.');
    enabled = true;
  };
}

export default attach;
