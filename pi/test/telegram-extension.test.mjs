import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
  pi.registerCommand = () => {};
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
  const activate = attach(pi, { port, autoStart: false, config: { TELEGRAM_BOT_TOKEN: 'test-token' }, settings: { allowedUserIds: ['123'], allowedGroupIds: [], scheduleChatId: null }, fetchImpl });
  t.after(() => pi.emit('session_shutdown'));
  pi.emit('session_start', null, { mode: 'tui', isIdle: () => true, abort() {}, sessionManager: { getBranch: () => [] } });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(updates, 0); // Managed sessions must not steal polling at startup.
  activate();
  await waitFor(() => prompts.length === 1);
  assert.equal(prompts[0].text, 'telegram prompt');
  pi.emit('input', { source: 'interactive', text: 'terminal prompt' });
  pi.emit('agent_start');
  pi.emit('message_end', { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'same conversation' }] } });
  await waitFor(() => sent.some(item => item.text === 'same conversation'));
  assert.ok(sent.some(item => item.text === '👤 terminal prompt'));
  pi.emit('agent_settled', { type: 'agent_settled' });
});

test('authorized restart all hands chat and topic to the detached controller after acknowledgment', async t => {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const { port } = socket.address();
  await new Promise(resolve => socket.close(resolve));
  const pi = new EventEmitter();
  pi.registerCommand = () => {};
  pi.sendUserMessage = () => assert.fail('Restart must not prompt a model');
  const sent = [], requests = [];
  let updates = 0;
  const fetchImpl = async (url, options) => {
    const method = url.split('/').at(-1), body = JSON.parse(options.body);
    if (method === 'getUpdates') {
      if (updates++ === 0) return { ok: true, json: async () => ({ ok: true, result: [] }) };
      if (updates === 2) return { ok: true, json: async () => ({ ok: true, result: [
        { update_id: 1, message: { text: '/restart all', chat: { type: 'private', id: 999 }, from: { id: 999 } } },
        { update_id: 2, message: { text: '/restart@my_bot all', message_thread_id: 7, chat: { type: 'supergroup', id: -100 }, from: { id: 123 } } },
      ] }) };
      return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true }));
    }
    sent.push(body);
    return { ok: true, json: async () => ({ ok: true, result: { message_id: sent.length } }) };
  };
  attach(pi, { port, config: { TELEGRAM_BOT_TOKEN: 'fixture' }, settings: { allowedUserIds: ['123'], allowedGroupIds: ['-100'] }, fetchImpl,
    restartAllImpl: async notification => {
      assert.ok(sent.some(message => message.text?.includes('전체 재시작 요청을 접수')));
      requests.push(notification); return { id: 'fixture-run' };
    },
  });
  t.after(() => pi.emit('session_shutdown'));
  pi.emit('session_start', null, { mode: 'tui', isIdle: () => true, sessionManager: { getBranch: () => [] } });
  await waitFor(() => requests.length === 1);
  assert.deepEqual(requests, [{ chat: -100, thread: 7 }]);
});

test('image attachment without text does not crash the polling owner', async t => {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const { port } = socket.address();
  await new Promise(resolve => socket.close(resolve));
  const pi = new EventEmitter();
  pi.registerCommand = () => {};
  pi.sendUserMessage = () => assert.fail('An image-only message must not prompt the model');
  const sent = [];
  let updates = 0;
  const fetchImpl = async (url, options) => {
    const method = url.split('/').at(-1);
    const body = JSON.parse(options.body);
    if (method === 'getUpdates') {
      if (updates++ === 0) return { ok: true, json: async () => ({ ok: true, result: [] }) };
      if (updates === 2) return { ok: true, json: async () => ({ ok: true, result: [
        { update_id: 1, message: { photo: [{ file_id: 'small' }, { file_id: 'large' }], chat: { type: 'private', id: 123 }, from: { id: 123 } } },
      ] }) };
      return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true }));
    }
    sent.push({ method, ...body });
    // getFile without file_path makes the download fail before touching the real inbox.
    if (method === 'getFile') return { ok: true, json: async () => ({ ok: true, result: { file_id: body.file_id } }) };
    return { ok: true, json: async () => ({ ok: true, result: { message_id: sent.length } }) };
  };
  attach(pi, { port, config: { TELEGRAM_BOT_TOKEN: 'test-token' }, settings: { allowedUserIds: ['123'], allowedGroupIds: [] }, fetchImpl });
  t.after(() => pi.emit('session_shutdown'));
  pi.emit('session_start', null, { mode: 'tui', isIdle: () => true, abort() {}, sessionManager: { getBranch: () => [] } });
  await waitFor(() => sent.some(item => item.text === '첨부를 저장하지 못했습니다.'));
  assert.ok(sent.some(item => item.text === 's8 메뉴'));
});

for (const caption of [undefined, '정리해줘']) test(`attachment saves and reaches the model with caption: ${caption}`, async t => {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const { port } = socket.address();
  await new Promise(resolve => socket.close(resolve));
  const dir = path.join(await mkdtemp(path.join(os.tmpdir(), 's8-tg-')), 'raw');
  const pi = new EventEmitter();
  pi.registerCommand = () => {};
  const prompts = [];
  pi.sendUserMessage = text => prompts.push(text);
  let updates = 0;
  const fetchImpl = async (url, options) => {
    if (url.includes('/file/bot')) return { ok: true, status: 200, arrayBuffer: async () => Buffer.from('photo-bytes') };
    const method = url.split('/').at(-1);
    const body = JSON.parse(options.body);
    if (method === 'getUpdates') {
      if (updates++ === 0) return { ok: true, json: async () => ({ ok: true, result: [] }) };
      if (updates === 2) return { ok: true, json: async () => ({ ok: true, result: [
        { update_id: 1, message: { photo: [{ file_id: 'small' }, { file_id: 'large' }], caption, document: { file_id: 'doc', file_name: 'report.md' }, photo: undefined, chat: { type: 'private', id: 123 }, from: { id: 123 } } },
      ] }) };
      return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true }));
    }
    const result = method === 'getFile' ? { file_path: 'documents/file_1.jpg', file_size: 11 } : { message_id: 1 };
    return { ok: true, json: async () => ({ ok: true, result }) };
  };
  attach(pi, { port, config: { TELEGRAM_BOT_TOKEN: 'test-token' }, settings: { allowedUserIds: ['123'], allowedGroupIds: [] }, fetchImpl, inboxDir: dir });
  t.after(() => pi.emit('session_shutdown'));
  pi.emit('session_start', null, { mode: 'tui', isIdle: () => true, abort() {}, sessionManager: { getBranch: () => [] } });
  await waitFor(() => prompts.length === 1);
  const files = await readdir(dir);
  assert.equal(await readFile(path.join(dir, files[0]), 'utf8'), 'photo-bytes');
  assert.ok(prompts[0].includes(JSON.stringify(path.join(dir, files[0]))));
  assert.match(prompts[0], /위키.*갱신/);
  assert.match(prompts[0], /원본 파일은 수정하거나 삭제하지/);
  if (caption) assert.ok(prompts[0].endsWith(caption));
});

test('older session can take ownership; off restores the waiting session and persists', async t => {
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const { port } = listener.address();
  await new Promise(resolve => listener.close(resolve));
  const { telegramOwner } = await import('../lib/telegram/status.mjs');
  const controls = [], changes = [];
  const ctx = { mode: 'tui', isIdle: () => true, sessionManager: { getBranch: () => [] } };
  const fetchImpl = async (_url, options) => new Promise((_, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true });
  });
  for (const session of ['s8-first', 's8-second']) {
    const pi = new EventEmitter();
    const commands = new Map();
    pi.registerCommand = (name, command) => commands.set(name, command);
    const control = attach(pi, { port, autoStart: false, session, config: { TELEGRAM_BOT_TOKEN: 'test-token' },
      settings: { allowedUserIds: ['123'], allowedGroupIds: [] }, fetchImpl,
      persist: enabled => changes.push([session, enabled]),
    });
    pi.emit('session_start', null, ctx);
    t.after(() => pi.emit('session_shutdown'));
    controls.push({ pi, control, commands });
  }
  assert.equal(await telegramOwner({ port }), null);
  assert.match(await controls[0].control.control('take'), /s8-first 연결 이전 완료/);
  assert.match(await controls[1].control.control('take'), /s8-first → s8-second/);
  const notices = [];
  await controls[0].commands.get('telegram').handler('take', { ui: { notify: message => notices.push(message) } });
  assert.equal(await telegramOwner({ port }), 's8-first');
  assert.match(notices.at(-1), /s8-second → s8-first/);
  assert.match(await controls[0].control.control('off'), /s8-second 연결/);
  assert.equal(await telegramOwner({ port }), 's8-second');
  controls[0].pi.emit('session_start', null, ctx);
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(await telegramOwner({ port }), 's8-second');
  assert.deepEqual(changes.at(-1), ['s8-first', false]);
  let menu;
  await controls[0].commands.get('telegram').handler('', { ui: {
    notify: () => {}, select: async (_title, options) => { menu = options; return '현재 연결 유지'; },
  } });
  assert.deepEqual(menu, ['현재 연결 유지', '여기로 가져오기', '이 세션 연결 해제']);
});
