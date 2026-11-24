import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { attachmentName, Bot, Gateway, sessionKey, visible, toolOutput, tokenUsage } from './gateway.mjs';

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

test('token usage totals current-branch model and tool usage', () => {
  assert.deepEqual(tokenUsage([
    { type: 'message', message: { role: 'assistant', usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 1 } } },
    { type: 'message', message: { role: 'toolResult', usage: { input: 3, output: 0, cacheRead: 0, cacheWrite: 0 } } },
    { type: 'usage', usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 } },
    { type: 'message', message: { role: 'user', usage: { input: 100 } } },
  ]), { input: 15, output: 5, cacheRead: 2, cacheWrite: 1, total: 23 });
});

test('Telegram keyboard buttons invoke the matching Pi actions and model selection', async t => {
  const { sent, fetchImpl } = transport();
  const calls = [];
  const pi = fake().pi;
  const models = [{ id: 'provider/model-id', name: 'Provider · Model' }];
  const session = await new Gateway({ token: 'fake', chat: 123, pi, fetchImpl,
    commandImpl: async (type, fields) => {
      calls.push({ type, ...fields });
      if (type === 'get_models') return models;
      if (type === 'set_model') return { ok: true, name: 'Model' };
      if (type === 'restart') return { ok: true };
      return { isStreaming: false, tokenUsage: { input: 15, output: 5, cacheRead: 2, cacheWrite: 1, total: 23 } };
    },
  }).start();
  t.after(() => session.stop());
  await session.showMenu();
  assert.deepEqual(sent.find(item => item.reply_markup)?.reply_markup.keyboard[0], ['상태', '중단']);
  await session.incoming(privateMessage(123, '/status'));
  assert.ok(sent.some(item => item.text.includes('토큰 23')));
  await session.incoming(privateMessage(123, '/help'));
  const help = sent.find(item => item.text.startsWith('명령어:'));
  assert.deepEqual(help.text.match(/^\/\w+/gm), ['/status', '/abort', '/new', '/model', '/restart', '/restart', '/jobs', '/help']);
  assert.equal(help.reply_markup.is_persistent, true);
  await session.incoming(privateMessage(123, '모델'));
  assert.deepEqual(sent.find(item => item.text === '모델을 선택하세요.').reply_markup.keyboard[0], ['Provider · Model']);
  await session.incoming(privateMessage(123, 'Provider · Model'));
  assert.deepEqual(calls.at(-1), { type: 'set_model', model: 'provider/model-id' });
  await session.incoming(privateMessage(123, '중단'));
  assert.deepEqual(calls.slice(-2).map(call => call.type), ['clear_queue', 'abort']);
  await session.incoming(privateMessage(123, '새 대화'));
  assert.equal(calls.at(-1).type, 'new_session');
  await session.incoming(privateMessage(123, '재시작'));
  assert.equal(calls.at(-1).type, 'restart');
});

test('jobs commands manage batches without prompting the model', async () => {
  const { sent, fetchImpl } = transport();
  const { pi } = fake();
  const calls = [];
  const session = new Gateway({ token: 'fake', chat: 123, pi, fetchImpl,
    schedulerImpl: async (action, id) => { calls.push([action, id]); return 'schedule result'; },
  });
  for (const text of ['/jobs', '배치', '/jobs pause morning', '/jobs resume morning', '/jobs stop morning']) {
    await session.incoming(privateMessage(123, text));
  }
  assert.deepEqual(calls, [['list', undefined], ['list', undefined], ['pause', 'morning'], ['resume', 'morning'], ['stop', 'morning']]);
  await session.incoming(privateMessage(123, '/jobs delete morning'));
  assert.equal(calls.length, 5);
  assert.ok(sent.at(-1).text.startsWith('사용법:'));
  await session.incoming(privateMessage(123, '/schedule'));
  assert.equal(calls.length, 5);
  assert.match(sent.at(-1).text, /알 수 없는 명령/);
  session.stop();
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
  assert.deepEqual(sent.filter(m => m.method !== 'sendChatAction').map(m => m.method), ['sendMessage', 'sendMessage', 'editMessageText']);
  assert.ok(sent.some(m => m.method === 'sendChatAction' && m.chat_id === 123 && m.action === 'typing'));
  assert.ok(sent.every(m => !JSON.stringify(m).includes('secret') && !JSON.stringify(m).includes('.env')));
  assert.equal(sent.at(-1).text, 'hello world');
  session.onRecord({ type: 'agent_settled' });
  await session.incoming(privateMessage(123, '/new'));
  assert.ok(commands.some(c => c.type === 'new_session'));
  session.stop();
});

test('first tool starts immediately; later tools update one message live and reset next turn', async () => {
  const { pi } = fake();
  const { sent, fetchImpl } = transport();
  const session = await new Gateway({ token: 'fake', chat: 123, pi, fetchImpl, editInterval: 20 }).start();
  await session.incoming(privateMessage(123, 'go'));
  session.onRecord({ type: 'tool_execution_start', toolName: 'read', args: { path: '.env' } });
  await session.serial;
  assert.deepEqual(sent.filter(m => m.method === 'sendMessage').map(m => m.text), ['🔧 read']);
  session.onRecord({ type: 'tool_execution_start', toolName: 'bash' });
  session.onRecord({ type: 'tool_execution_end', isError: true, result: { content: 'secret' } });
  await new Promise(resolve => setTimeout(resolve, 50));
  await session.serial;
  assert.equal(sent.filter(m => m.method === 'sendMessage').length, 1);
  assert.equal(sent.filter(m => m.method === 'editMessageText').at(-1).text, '🔧 read\n🔧 bash\n❌ 도구 실행 실패 (상세 결과는 표시하지 않음)');
  assert.ok(sent.every(m => !JSON.stringify(m).includes('.env') && !JSON.stringify(m).includes('secret')));
  session.onRecord({ type: 'agent_settled' });
  await session.incoming(privateMessage(123, 'again'));
  session.onRecord({ type: 'tool_execution_start', toolName: 'grep' });
  await session.serial;
  assert.deepEqual(sent.filter(m => m.method === 'sendMessage').map(m => m.text), ['🔧 read', '🔧 grep']);
  session.onRecord({ type: 'tool_execution_start', toolName: 'find' });
  session.onRecord({ type: 'agent_settled' });
  await session.serial;
  await new Promise(resolve => setImmediate(resolve));
  await session.serial;
  assert.equal(sent.filter(m => m.method === 'editMessageText').at(-1).text, '🔧 grep\n🔧 find');
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


test('restart all uses a dedicated controller command and rejects invalid or busy requests', async t => {
  const { sent, fetchImpl } = transport();
  const calls = [];
  const session = new Gateway({ token: 'fake', chat: 123, pi: fake().pi, fetchImpl,
    commandImpl: async (type, fields) => { calls.push({ type, ...fields }); return { ok: true }; },
  });
  t.after(() => session.stop());
  for (const text of ['/restart all', '/restart@my_bot all', '전체 재시작']) await session.incoming(privateMessage(123, text));
  assert.deepEqual(calls.map(call => call.type), ['restart_all', 'restart_all', 'restart_all']);
  assert.ok(sent.some(item => item.text.includes('전체 재시작 요청을 접수')));
  await session.incoming(privateMessage(123, '/restart all extra'));
  assert.match(sent.at(-1).text, /사용법/);
  session.busy = true;
  await session.incoming(privateMessage(123, '/restart all'));
  assert.match(sent.at(-1).text, /먼저 중단/);
  assert.equal(calls.length, 3);
});

test('general Telegram hides schedules and blocks access to shared project schedules', async t => {
  const { pi } = fake();
  const { sent, fetchImpl } = transport();
  let calls = 0;
  const gateway = new Gateway({ mode: 'general', token: 'fake', pi, chat: 123, fetchImpl,
    schedulerImpl: async () => { calls++; return 'unexpected'; } });
  t.after(() => gateway.close());
  assert.ok(!gateway.menuMarkup().keyboard.flat().includes('배치'));
  await gateway.incoming(privateMessage(123, '/jobs pause example'));
  assert.equal(calls, 0);
  assert.match(sent.at(-1).text, /범용 모드/);
  await gateway.incoming(privateMessage(123, '/help'));
  assert.match(sent.at(-1).text, /범용 Pi 재시작/);
  assert.ok(!sent.at(-1).text.includes('/jobs'));
});

// Attachments: the bot saves photos and documents to the wiki inbox so the manager can ingest them.
function mediaTransport({ filePath = 'documents/file_1.jpg', bytes = 'photo-bytes', downloadFails = false } = {}) {
  const sent = [];
  const fetchImpl = async (url, options = {}) => {
    if (url.includes('/file/bot')) {
      return downloadFails ? { ok: false, status: 404 } : { ok: true, status: 200, arrayBuffer: async () => Buffer.from(bytes) };
    }
    const method = url.split('/').at(-1);
    const body = options.body ? JSON.parse(options.body) : {};
    sent.push({ method, ...body });
    const result = method === 'getFile' ? { file_path: filePath, file_size: Buffer.byteLength(bytes) } : { message_id: sent.length };
    return { ok: true, json: async () => ({ ok: true, result }) };
  };
  return { sent, fetchImpl };
}
const inbox = async () => path.join(await mkdtemp(path.join(os.tmpdir(), 's8-tg-')), 'raw');
const dayOf = seconds => {
  const date = new Date(seconds * 1000);
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};
const photoMessage = (user, seconds, extra = {}) => ({ ...privateMessage(user, undefined), date: seconds,
  photo: [{ file_id: 'small' }, { file_id: 'large' }], ...extra });

test('attachments are saved to the inbox with a dated name and need no Pi session', async t => {
  const dir = await inbox();
  const { sent, fetchImpl } = mediaTransport();
  const bot = new Bot({ token: 'fake', users: new Set(['123']), groups: new Set(), fetchImpl, inboxDir: dir,
    spawnPi: () => { throw new Error('Pi must not start for an attachment-only message'); } });
  t.after(() => bot.stop());
  const seconds = 1764000000;
  await bot.route({ message: photoMessage(123, seconds) });
  const files = await readdir(dir);
  assert.deepEqual(files, [`${dayOf(seconds)} 텔레그램 사진.jpg`]);
  assert.equal(await readFile(path.join(dir, files[0]), 'utf8'), 'photo-bytes');
  assert.equal(sent.find(item => item.method === 'getFile').file_id, 'large'); // largest size of the photo
  assert.equal(sent.find(item => item.method === 'getFile').method, 'getFile');
  assert.match(sent.at(-1).text, /첨부를 저장했습니다/);
  assert.match(sent.at(-1).text, /raw\//);
});

test('attachment senders are authorized like text senders', async t => {
  const dir = await inbox();
  const { sent, fetchImpl } = mediaTransport();
  const bot = new Bot({ token: 'fake', users: new Set(['123']), groups: new Set(['-1009']), fetchImpl, inboxDir: dir });
  t.after(() => bot.stop());
  await bot.route({ message: photoMessage(999, 1764000000) });
  await bot.route({ message: { ...photoMessage(-1009, 1764000000), chat: { id: -1010, type: 'supergroup' } } });
  assert.deepEqual(await readdir(dir).catch(() => []), []); // nothing saved, so the inbox may not exist yet
  assert.deepEqual(sent, []);
  assert.equal(sessionKey(photoMessage(123, 1764000000), new Set(['123']), new Set()), '123');
});

test('oversized, duplicate and failing attachments report a usable answer', async t => {
  const dir = await inbox();
  const { sent, fetchImpl } = mediaTransport();
  const bot = new Bot({ token: 'fake', users: new Set(['123']), groups: new Set(), fetchImpl, inboxDir: dir });
  t.after(() => bot.stop());
  await bot.route({ message: { ...privateMessage(123), date: 1764000000, document: { file_id: 'huge', file_name: 'big.zip', file_size: 25 * 1024 * 1024 } } });
  assert.match(sent.at(-1).text, /20MB/);
  assert.deepEqual(await readdir(dir).catch(() => []), []);
  await bot.route({ message: { ...privateMessage(123), date: 1764000000, document: { file_id: 'doc', file_name: 'notes/file:name?.md' } } });
  await bot.route({ message: { ...privateMessage(123), date: 1764000000, document: { file_id: 'doc', file_name: 'notes/file:name?.md' } } });
  const files = (await readdir(dir)).sort();
  assert.equal(files.length, 2);
  assert.ok(files.every(name => !/[/:?]/.test(name)), files.join(','));
  assert.ok(files.some(name => /-2\.md$/.test(name)), files.join(','));
});

test('an attachment with a caption is saved and the caption still reaches Pi', async t => {
  const dir = await inbox();
  const { sent, fetchImpl } = mediaTransport({ filePath: 'documents/report.pdf' });
  const { pi, commands } = fake();
  const bot = new Bot({ token: 'fake', users: new Set(['123']), groups: new Set(), fetchImpl, inboxDir: dir, spawnPi: () => pi });
  t.after(() => bot.stop());
  await bot.route({ message: photoMessage(123, 1764000000, { text: '정리해줘' }) });
  assert.match((await readdir(dir))[0], /텔레그램 사진\.jpg$/);
  assert.ok(sent.some(item => item.text === '정리해줘') === false); // caption is not echoed as a chat message
  const prompted = commands.find(command => command.type === 'prompt').message;
  assert.match(prompted, /^첨부 저장: raw\/.+\.jpg\n정리해줘$/); // Pi learns which file the caption is about
});

test('attachment names are dated and stripped of path separators', () => {
  const name = attachmentName({ name: '../../etc/pas:sw?ord.md' }, 1764000000, 'documents/x.md');
  assert.equal(name, `${dayOf(1764000000)} password.md`);
  assert.equal(attachmentName({ name: '텔레그램 파일' }, 1764000000, 'documents/file_1.JPG'), `${dayOf(1764000000)} 텔레그램 파일.JPG`);
});
