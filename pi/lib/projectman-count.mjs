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
    if (!uid || ids.has(uid) || !['1', '2', '3', '1000'].includes(amount) || Number(next) < 0 || Number(next) !== value - Number(amount) || !Number.isFinite(Date.parse(at))) throw new Error('Invalid count ledger');
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
    const project = await call('phcms_get_content', { uid: projectUid });
    const minimumValue = project.attributes?.minimumValue ?? 0;
    if (project.type !== 'project' || project.attributes?.test !== 'count-100' || !Number.isSafeInteger(minimumValue) || minimumValue < 0) throw new Error('Invalid count project or minimumValue');
    const page = await call('phcms_list_contents', { channelSlug: 'ph-projectman', parentUid: projectUid, type: 'task', limit: 100 });
    if (page.total > 100 || !Array.isArray(page.items)) throw new Error('Unexpected task list');
    const tasks = page.items.filter(task => task.attributes?.test === 'count-100').sort((a, b) => a.attributes.sequence - b.attributes.sequence);
    if (tasks.length !== 3 || tasks.some((task, index) => task.attributes.sequence !== index + 1 || ![index + 1, ...(index === 2 ? [1000] : [])].includes(task.attributes.subtract))) throw new Error('Expected three ordered count-test tasks (1, 2, then 3 or 1000)');
    const task = tasks.find(task => !['done', 'canceled'].includes(task.attributes.state));
    if (!task) return 'All three tasks are finished (done or canceled).';
    const attr = task.attributes;
    if (attr.state === 'blocked') return `사용자 응답 대기: ${task.title} (${task.uid}). 실행하지 않았습니다. 이 작업을 건너뛸까요? "${attr.subtract} 빼기는 하지 마라"라고 답하면 Projectman에 취소 결정을 기록한 뒤 다음 검사에서 반영합니다. 응답 없이는 실행하지 않습니다.`;
    if (!attr.autorun || !['ready', 'doing'].includes(attr.state) || !Number.isFinite(Date.parse(attr.scheduledAt)) || Date.parse(attr.scheduledAt) > now.getTime()) return `Waiting: ${task.title} (${attr.scheduledAt ?? '예정 시각 미등록'})`;
    const text = await readFile(file, 'utf8');
    const ledger = parseLedger(text);
    const before = tasks.slice(0, attr.sequence - 1);
    if (before.some(item => item.attributes.state !== 'canceled' && !ledger.ids.has(item.uid)) || tasks.some(item => item.attributes.state === 'canceled' && ledger.ids.has(item.uid)) || [...ledger.ids].some(uid => !tasks.some(item => item.uid === uid))) throw new Error('Ledger does not match this project');
    const transition = async (expectedState, nextState, event, message) => call('projectman_transition_item', { uid: task.uid, expectedState, nextState, event, message, requestId: randomUUID() });
    if (!ledger.ids.has(task.uid) && ledger.value - attr.subtract < minimumValue) {
      const question = `${ledger.value} - ${attr.subtract} = ${ledger.value - attr.subtract}으로 프로젝트 규칙(결과 ${minimumValue} 이상)을 위반합니다. 실행하지 않았습니다. 이 작업을 건너뛸까요? "${attr.subtract} 빼기는 하지 마라"는 답변은 이 작업을 canceled로 전환하고 사용자 답변을 작업 로그에 기록합니다. 실행을 허용하려면 먼저 프로젝트 규칙을 명시적으로 변경해야 합니다.`;
      await transition(attr.state, 'blocked', 'blocked', question);
      return `사용자 확인 요청: ${task.title} (${task.uid})\n${question}`;
    }
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

export async function rejectCountTask({ call, uid, message, file }) {
  if (typeof message !== 'string' || !message.trim() || message.length > 10000) throw new Error('A user rejection message (1–10000 characters) is required');
  if (typeof file !== 'string' || !file) throw new Error('Count ledger file is required');
  const lockFile = `${file}.lock`;
  const lock = await open(lockFile, 'wx', 0o600);
  try {
    if (parseLedger(await readFile(file, 'utf8')).ids.has(uid)) throw new Error('Subtraction already persisted; recover completion instead of canceling');
    const task = await call('phcms_get_content', { uid });
    if (task.type !== 'task' || task.attributes?.test !== 'count-100') throw new Error('Not a count-test task');
    if (task.attributes.state === 'canceled') return `${task.title}: already canceled`;
    if (task.attributes.state !== 'blocked') throw new Error('Only a blocked count-test task can be rejected');
    await call('projectman_transition_item', { uid, expectedState: 'blocked', nextState: 'canceled', event: 'updated', message: message.trim(), requestId: randomUUID() });
    return `${task.title}: canceled; user decision persisted in Projectman`;
  } finally { await lock.close(); await rm(lockFile, { force: true }); }
}
