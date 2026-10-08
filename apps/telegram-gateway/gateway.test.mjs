import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Bot, Gateway, sessionKey, visible, toolOutput } from './gateway.mjs';

function fake() {
  const commands = [];
  const pi = new EventEmitter();
  pi.stdout = new EventEmitter();
  pi.stderr = new EventEmitter();
  pi.stdin = { writableEnded: false, end() { this.writableEnded = true; pi.emit('exit'); },
    write(line, callback) {
      const request = JSON.parse(line);
      commands.push(request);
      if (request.type !== 'extension_ui_response') queueMicrotask(() => pi.stdout.emit('data', Buffer.from(JSON.stringify({
        type: 'response', id: request.id, success: true, data: { isStreaming: false },
      }) + '\n')));
      callback?.();
    },
  };
  return { pi, commands };
}
function transport() {
  const sent = [];
  const fetchImpl = async (url, options) => {
    const method = url.split('/').at(-1);
    const body = JSON.parse(options.body);
    sent.push({ method, ...body });
    return { ok: true, json: async () => ({ ok: true, result: method === 'getUpdates' ? [] : { message_id: sent.length } }) };
  };
  return { sent, fetchImpl };
}
const privateMessage = (user, text) => ({ chat: { id: user, type: 'private' }, from: { id: user }, text });
const groupMessage = (chat, user, text, thread) => ({ chat: { id: chat, type: 'supergroup' }, from: { id: user }, text,
  ...(thread === undefined ? {} : { message_thread_id: thread }) });

test('private sender and group ID authorize independently, including topic separation', () => {
  const users = new Set(['123']);
  const groups = new Set(['-1009']);
  assert.equal(sessionKey(privateMessage(123, 'hello'), users, groups), '123');
  assert.equal(sessionKey(privateMessage(999, 'hello'), users, groups), null);
  assert.equal(sessionKey(groupMessage(-1009, 999, 'hello', 5), users, groups), '-1009-5');
  assert.equal(sessionKey(groupMessage(-1009, 999, 'hello', 6), users, groups), '-1009-6');
  assert.equal(sessionKey(groupMessage(-1010, 123, 'hello'), users, groups), null); // allowed user does not open an unlisted group
  assert.equal(sessionKey({ ...groupMessage(-1009, 999, 'hello'), from: { id: 999, is_bot: true } }, users, groups), null);
  assert.equal(sessionKey({ ...privateMessage(123, 'hello'), from: undefined }, users, groups), null);
});

test('independent sessions can run concurrently and commands stay in their chat', async t => {
  const { sent, fetchImpl } = transport();
  const processes = new Map();
  const bot = new Bot({ token: 'fake', users: new Set(['123', '456']), groups: new Set(['-1009']), fetchImpl,
    spawnPi: key => { const process = fake(); processes.set(key, process); return process.pi; },
  });
  t.after(() => bot.stop());
  await bot.route({ message: privateMessage(999, 'unauthorized') });
  assert.equal(processes.size, 0);
  await Promise.all([
    bot.route({ message: privateMessage(123, 'first') }),
    bot.route({ message: privateMessage(456, 'second') }),
    bot.route({ message: groupMessage(-1009, 999, 'third', 5) }),
    bot.route({ message: groupMessage(-1009, 888, 'fourth', 6) }),
  ]);
  assert.equal(processes.size, 4);
  assert.ok([...processes.values()].every(p => p.commands.some(c => c.type === 'prompt')));
  await bot.route({ message: privateMessage(123, 'change course') });
  await bot.route({ message: groupMessage(-1009, 999, '/new', 5) });
  await bot.route({ message: privateMessage(456, '/abort') });
  assert.equal(processes.get('123').commands.at(-1).streamingBehavior, 'steer');
  assert.ok(processes.get('-1009-5').commands.some(c => c.type === 'new_session') === false); // busy until settled
  assert.deepEqual(processes.get('456').commands.slice(-2).map(c => c.type), ['clear_queue', 'abort']);
  assert.ok(sent.some(m => m.chat_id === -1009 && m.message_thread_id === 5 && m.text?.includes('진행 중')));
  const old = processes.get('123');
  old.pi.emit('exit');
  await bot.route({ message: privateMessage(123, 'after restart') });
  assert.notEqual(processes.get('123'), old);
  assert.ok(processes.get('123').commands.some(c => c.message === 'after restart'));
  bot.stop();
});

test('one chat streams edits and hides successful tool end, args and raw results', async () => {
  const { sent, fetchImpl } = transport();
  const { pi, commands } = fake();
  const session = await new Gateway({ token: 'fake', chat: 123, pi, fetchImpl }).start();
  await session.incoming(privateMessage(123, 'hello'));
  session.onRecord({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hello' } });
  session.flush(session.stream);
  await session.serial;
  session.onRecord({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: ' world' } });
  session.onRecord({ type: 'tool_execution_start', toolName: 'read', args: { path: '.env' } });
  session.onRecord({ type: 'tool_execution_end', toolName: 'read', isError: false, result: { content: 'secret' } });
  session.onRecord({ type: 'tool_execution_end', toolName: 'bash', isError: true, result: { content: 'secret' } });
  session.onRecord({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'hello world' }] } });
  await session.serial;
  await new Promise(resolve => setImmediate(resolve));
  await session.serial;
  assert.deepEqual(sent.filter(m => m.method !== 'sendChatAction').map(m => m.method), ['sendMessage', 'sendMessage', 'sendMessage', 'editMessageText']);
  assert.ok(sent.some(m => m.method === 'sendChatAction' && m.chat_id === 123 && m.action === 'typing'));
  assert.ok(sent.every(m => !JSON.stringify(m).includes('secret') && !JSON.stringify(m).includes('.env')));
  assert.equal(sent.at(-1).text, 'hello world');
  session.onRecord({ type: 'agent_settled' });
  await session.incoming(privateMessage(123, '/new'));
  assert.ok(commands.some(c => c.type === 'new_session'));
  session.stop();
});

test('typing repeats while busy, stops on settlement and does not block Pi on Telegram failure', async () => {
  const { pi, commands } = fake();
  const { sent, fetchImpl } = transport();
  const session = await new Gateway({ token: 'fake', chat: -1009, thread: 5, pi,
    fetchImpl: (url, options) => url.endsWith('/sendChatAction') ? Promise.reject(new Error('offline')) : fetchImpl(url, options),
  }).start();
  await session.incoming(groupMessage(-1009, 999, 'hello', 5));
  assert.ok(commands.some(c => c.type === 'prompt'));
  assert.ok(session.typingState);
  session.onRecord({ type: 'agent_settled' });
  assert.equal(session.typingState, null);
  session.stop();

  const other = fake();
  const active = await new Gateway({ token: 'fake', chat: -1009, thread: 6, pi: other.pi, fetchImpl }).start();
  await active.incoming(groupMessage(-1009, 999, 'hello', 6));
  await new Promise(resolve => setTimeout(resolve, 4100));
  assert.ok(sent.filter(m => m.method === 'sendChatAction' && m.message_thread_id === 6).length >= 2);
  active.onRecord({ type: 'agent_settled' });
  assert.equal(active.typingState, null);
  active.stop();
});

test('RPC unicode framing survives split bytes; approval dialog is cancelled', async () => {
  const { pi, commands } = fake();
  const { fetchImpl } = transport();
  const session = await new Gateway({ token: 'fake', chat: 123, pi, fetchImpl }).start();
  const record = Buffer.from(JSON.stringify({ type: 'extension_ui_request', id: 'ui-1', method: 'confirm', message: '안녕' }) + '\n');
  const split = record.indexOf(Buffer.from('안')) + 1;
  session.onData(record.subarray(0, split));
  session.onData(record.subarray(split));
  assert.deepEqual(commands.at(-1), { type: 'extension_ui_response', id: 'ui-1', cancelled: true });
  session.stop();
});

test('outbound secrets are redacted and long unicode replies split safely', async () => {
  assert.equal(visible('TOKEN=abc Bearer xyz postgres://u:p@host/db ghp_abcdefghijk'), 'TOKEN=[REDACTED] Bearer [REDACTED] database://[REDACTED]@host/db [REDACTED]');
  assert.equal(toolOutput({ type: 'tool_execution_end', isError: false }), null);
  const { pi } = fake();
  const { sent, fetchImpl } = transport();
  const session = await new Gateway({ token: 'fake', chat: -1009, thread: 5, pi, fetchImpl }).start();
  const stream = { text: '😀'.repeat(4000), sent: '', ids: [], flushing: false };
  session.flush(stream);
  await session.serial;
  assert.equal(sent.length, 2);
  assert.equal([...sent[0].text].length, 3500);
  assert.equal([...sent[1].text].length, 500);
  assert.equal(sent[0].message_thread_id, 5);
  session.stop();
});
