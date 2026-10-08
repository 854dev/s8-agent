import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { attach } from '../extensions/telegram.mjs';

const waitFor = async predicate => {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('Telegram event not delivered');
};

test('Telegram and TUI send messages through the same Pi session', async t => {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const { port } = socket.address();
  await new Promise(resolve => socket.close(resolve));
  const pi = new EventEmitter();
  const prompts = [], sent = [];
  pi.sendUserMessage = (text, options) => prompts.push({ text, options });
  let updates = 0;
  const fetchImpl = async (url, options) => {
    const method = url.split('/').at(-1);
    const body = JSON.parse(options.body);
    if (method === 'getUpdates') {
      if (updates++ === 0) return { ok: true, json: async () => ({ ok: true, result: [] }) };
      if (updates === 2) return { ok: true, json: async () => ({ ok: true, result: [
        { update_id: 1, message: { text: 'telegram prompt', chat: { type: 'private', id: 123 }, from: { id: 123 } } },
      ] }) };
      return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true }));
    }
    sent.push({ method, ...body });
    return { ok: true, json: async () => ({ ok: true, result: { message_id: sent.length } }) };
  };
  attach(pi, { port, config: { TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_ALLOWED_USER_IDS: '123' }, fetchImpl });
  t.after(() => pi.emit('session_shutdown'));
  pi.emit('session_start', null, { mode: 'tui', isIdle: () => true, abort() {} });
  await waitFor(() => prompts.length === 1);
  assert.equal(prompts[0].text, 'telegram prompt');
  pi.emit('input', { source: 'interactive', text: 'terminal prompt' });
  pi.emit('agent_start');
  pi.emit('message_end', { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'same conversation' }] } });
  await waitFor(() => sent.some(item => item.text === 'same conversation'));
  assert.ok(sent.some(item => item.text === '👤 terminal prompt'));
  pi.emit('agent_settled', { type: 'agent_settled' });
});
