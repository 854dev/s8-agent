import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export function mcpClient(url, serviceKey = process.env.PHCMS_ACCESS_TOKEN) {
  return async (name, args) => {
    if (typeof serviceKey !== 'string' || !/^phcms_sk_[A-Za-z0-9_-]{43}$/.test(serviceKey)) throw new Error('S8 requires its agent service key to call PH-CMS MCP');
    const response = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${serviceKey}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name, arguments: args } }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`MCP HTTP ${response.status}`);
    const data = await response.json();
    if (data.error || data.result?.isError) {
      const errorText = data.result?.content?.find(part => part.type === 'text')?.text ?? '';
      const status = errorText.match(/(?:HTTP|API Error|status)[^\d]{0,8}(\d{3})/i)?.[1];
      throw new Error(`Projectman tool failed${status ? ` (HTTP ${status})` : ''}; no automatic retry of writes`);
    }
    const text = data.result?.content?.find(part => part.type === 'text')?.text;
    return JSON.parse(text);
  };
}

export function parseLedger(text) {
  const lines = text.trimEnd().split('\n');
  if (lines.shift() !== '100') throw new Error('Initial count must be 100; refusing to overwrite');
  let value = 100;
  const ids = new Set();
  for (const line of lines) {
    const [next, uid, amount, at] = line.split('\t');
    if (!uid || ids.has(uid) || !['1', '2', '3'].includes(amount) || Number(next) !== value - Number(amount) || !Number.isFinite(Date.parse(at))) throw new Error('Invalid count ledger');
    ids.add(uid);
    value = Number(next);
  }
  return { value, ids };
}

export async function runCount({ call, projectUid, file, now = new Date() }) {
  await mkdir(path.dirname(file), { recursive: true });
  const lockFile = `${file}.lock`;
  const lock = await open(lockFile, 'wx', 0o600);
  try {
    const page = await call('phcms_list_contents', { channelSlug: 'ph-projectman', parentUid: projectUid, type: 'task', limit: 100 });
    if (page.total > 100 || !Array.isArray(page.items)) throw new Error('Unexpected task list');
    const tasks = page.items.filter(task => task.attributes?.test === 'count-100').sort((a, b) => a.attributes.sequence - b.attributes.sequence);
    if (tasks.length !== 3 || tasks.some((task, index) => task.attributes.sequence !== index + 1 || task.attributes.subtract !== index + 1)) throw new Error('Expected exactly three ordered count-test tasks');
    const task = tasks.find(task => task.attributes.state !== 'done');
    if (!task) return 'All three tasks are complete.';
    const attr = task.attributes;
    if (!attr.autorun || !['ready', 'doing'].includes(attr.state) || !Number.isFinite(Date.parse(attr.scheduledAt)) || Date.parse(attr.scheduledAt) > now.getTime()) return `Waiting: ${task.title} (${attr.scheduledAt ?? '예정 시각 미등록'})`;
    const text = await readFile(file, 'utf8');
    const ledger = parseLedger(text);
    const before = tasks.slice(0, attr.sequence - 1);
    if (before.some(item => !ledger.ids.has(item.uid)) || [...ledger.ids].some(uid => !tasks.some(item => item.uid === uid))) throw new Error('Ledger does not match this project');
    const transition = async (expectedState, nextState, event, message) => call('projectman_transition_item', { uid: task.uid, expectedState, nextState, event, message, requestId: randomUUID() });
    if (attr.state === 'ready') await transition('ready', 'doing', 'started', 'Starting bounded count test');
    if (!ledger.ids.has(task.uid)) {
      const temp = `${file}.${process.pid}.tmp`;
      await writeFile(temp, `${text.trimEnd()}\n${ledger.value - attr.subtract}\t${task.uid}\t${attr.subtract}\t${now.toISOString()}\n`, { mode: 0o600 });
      await rename(temp, file);
    }
    await transition('doing', 'done', 'completed', `Count result persisted for ${task.uid}; subtract ${attr.subtract}. Duplicate subtraction prevented by ledger UID.`);
    return `${task.title}: complete (value ${ledger.ids.has(task.uid) ? ledger.value : ledger.value - attr.subtract})`;
  } finally { await lock.close(); await rm(lockFile, { force: true }); }
}
