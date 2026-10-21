// 상주 워커. s8-config.yml의 workers 항목마다 s8-workers 세션의 worker-<id> 창에서 도는 가벼운 루프다(LLM 아님).
// 작업을 맡으면 기존 실행기(work.mjs startWork)로 UID 창에 워커 에이전트를 띄우고, 보고(또는 창 종료)를 확인하면 다음 작업으로 넘어간다.
// 보고 후에도 에이전트 창은 남겨 결과를 확인하거나 이어서 대화할 수 있게 한다. 정리는 사람이 한다.
// 한 워커는 한 번에 작업 하나만 맡는다.
//   active   지시가 없으면 ready 작업(배정 없음 또는 이 워커 배정)을 찾아 맡는다
//   passive  지시(콘솔·매니저)를 받아야 맡는다
//   paused   새 작업을 맡지 않는다. 진행 중인 작업은 끝까지 기다린다
// 상태는 쓰는 쪽이 하나인 파일로 나눈다(.s8-runtime/workers/<id>/).
//   mode.json      실행 중 바꾼 모드. 콘솔·매니저가 쓴다. 없으면 s8-config.yml의 mode
//   inbox/*.json   지시 하나당 파일 하나. 콘솔·매니저가 만들고 워커가 읽은 뒤 지운다
//   state.json     현재 작업·최근 오류·heartbeat. 워커만 쓴다
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { WORKER_MODES } from '../config/s8-config.mjs';
import { saveJson } from '../storage/json-file.mjs';
import { readClaim } from './worker-run.mjs';

const HEARTBEAT_STALE_MS = 60_000;
const directory = (root, id) => path.join(root, '.s8-runtime/workers', id);
const readJson = async file => { try { return JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const UID = /^[a-zA-Z0-9_-]{1,120}$/;

/** 실행 중 바꾼 모드(없으면 null). */
export async function modeOverride(root, id) {
  const saved = await readJson(path.join(directory(root, id), 'mode.json'));
  return WORKER_MODES.includes(saved?.mode) ? saved.mode : null;
}

/** 모드를 바꾼다. null이면 설정 파일 값으로 되돌린다. */
export async function setWorkerMode(root, id, mode) {
  if (mode !== null && !WORKER_MODES.includes(mode)) throw new Error(`모드는 ${WORKER_MODES.join(', ')} 중 하나입니다.`);
  const file = path.join(directory(root, id), 'mode.json');
  if (mode === null) return rm(file, { force: true });
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await saveJson(file, { mode, changedAt: new Date().toISOString() });
}

/** 워커에게 작업 지시를 남긴다. from은 지시한 쪽(console·manager). */
export async function queueInstruction(root, id, uid, from) {
  if (!UID.test(uid ?? '')) throw new Error(`잘못된 UID입니다: ${uid}`);
  const inbox = path.join(directory(root, id), 'inbox');
  await mkdir(inbox, { recursive: true, mode: 0o700 });
  // 파일 이름 순서가 지시 순서다. 임시 파일로 쓴 뒤 이름을 바꿔 반쯤 쓴 지시를 읽지 않게 한다.
  // 단조 시계(장비 안의 모든 프로세스가 공유)라 같은 밀리초에 남긴 지시도 순서가 유지된다.
  const name = `${process.hrtime.bigint().toString().padStart(20, '0')}-${randomUUID()}.json`;
  await saveJson(path.join(inbox, name), { uid, from, at: new Date().toISOString() });
}

async function instructions(root, id) {
  const inbox = path.join(directory(root, id), 'inbox');
  let names;
  try { names = (await readdir(inbox)).filter(name => name.endsWith('.json')).sort(); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const list = [];
  for (const name of names) {
    const file = path.join(inbox, name), value = await readJson(file).catch(() => null);
    if (UID.test(value?.uid ?? '')) list.push({ ...value, file });
    else await rm(file, { force: true });
  }
  return list;
}

/** 설정된 워커들의 상태: 설정 모드, 실제 모드, 현재 작업, 대기 지시, 루프 동작 여부. */
export async function workerStatuses(root, workers, { now = Date.now() } = {}) {
  return Promise.all(workers.map(async worker => {
    const override = await modeOverride(root, worker.id);
    const state = await readJson(path.join(directory(root, worker.id), 'state.json'));
    return {
      id: worker.id, configMode: worker.mode, mode: override ?? worker.mode, overridden: override !== null,
      current: state?.current ?? null, lastError: state?.lastError ?? null, lastFinished: state?.lastFinished ?? null,
      queue: (await instructions(root, worker.id)).map(item => item.uid),
      running: Boolean(state?.heartbeatAt) && now - Date.parse(state.heartbeatAt) < HEARTBEAT_STALE_MS,
    };
  }));
}

/** 이 워커가 맡을 수 있는 ready 작업 UID(없으면 null). 선행 작업이 모두 끝난 작업만 고른다. */
export function pickReadyTask(items, workerId, skip = new Set()) {
  const state = new Map(items.map(item => [item.uid, item.detail?.attributes.state]));
  for (const item of items) {
    const workflow = item.detail?.attributes.workflow;
    if (state.get(item.uid) !== 'ready' || !workflow?.grant || workflow.run?.status === 'running' || workflow.review?.pending) continue;
    const assignee = workflow.assignment?.assignee ?? workflow.spec?.assignee;
    if (assignee && assignee !== workerId) continue;
    if ((workflow.spec?.dependsOn ?? []).some(uid => state.get(uid) !== 'done')) continue;
    if (skip.has(`${item.uid}:${workflow.revision}`)) continue;
    return { uid: item.uid, revision: workflow.revision };
  }
  return null;
}

/**
 * 한 번 확인한다. 진행 중인 작업이 끝났는지 보고, 모드에 따라 지시 또는 ready 작업을 하나 맡는다.
 * deps: client(Projectman), start(uid) → startWork 결과, taskAlive(uid) → UID 창이 살아 있는지, log(문장).
 * skip은 시작에 실패한 ready 작업(uid:revision)을 기억해 같은 오류를 반복하지 않는다.
 */
export async function residentTick(root, worker, { client, start, taskAlive, nextInstruction = () => null, externalBusy = () => false, log = () => {}, skip = new Set(), now = () => new Date() }) {
  const file = path.join(directory(root, worker.id), 'state.json');
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const state = await readJson(file) ?? {};
  const save = () => saveJson(file, { ...state, heartbeatAt: now().toISOString() });

  if (state.current) {
    const { uid } = state.current;
    const reported = (await readClaim(root, uid))?.reported === true;
    if (!reported && await taskAlive(uid)) return save();
    log(reported ? `${uid} 보고 완료` : `${uid} 창이 보고 없이 종료됨. 작업 상태를 확인하세요.`);
    state.lastFinished = { uid, reported, at: now().toISOString() };
    state.current = null;
  }

  const mode = await modeOverride(root, worker.id) ?? worker.mode;
  if (mode === 'paused' || externalBusy()) return save();

  const begin = async (uid, source) => {
    try {
      const result = await start(uid);
      if (result.running) { log(`${uid}는 이미 다른 창에서 실행 중이라 맡지 않습니다.`); return false; }
      state.current = { uid, source, startedAt: now().toISOString(), target: result.target };
      state.lastError = null;
      log(`${uid} ${result.resumed ? '재개' : '시작'} (${source})`);
      return true;
    } catch (error) {
      state.lastError = { uid, message: error.message, at: now().toISOString() };
      log(`${uid} 시작 실패: ${error.message}`);
      return false;
    }
  };

  // Connected requests wait only in the resident's bounded memory queue.
  const connected = nextInstruction();
  if (connected) {
    await begin(connected.uid, 'manager');
    return save();
  }

  // 지시는 active·passive 모두 받는다. 맡지 못한 지시도 다시 시도하지 않고 지운다(오류는 state에 남는다).
  for (const instruction of await instructions(root, worker.id)) {
    await rm(instruction.file, { force: true });
    if (await begin(instruction.uid, instruction.from ?? 'instruction')) return save();
  }

  if (mode === 'active' && client) {
    const items = [...await client.list('task'), ...await client.list('subtask')];
    const picked = pickReadyTask(items, worker.id, skip);
    if (picked && !await begin(picked.uid, 'poll')) {
      skip.add(`${picked.uid}:${picked.revision}`);
      if (skip.size > 500) skip.delete(skip.values().next().value);
    }
  }
  return save();
}

/** 이 워커의 루프 잠금 파일. 같은 워커 루프가 둘 뜨지 않게 한다. */
export const residentLockFile = (root, id) => path.join(directory(root, id), 'owner.lock');

/** 루프를 돈다. signal이 중단되면 끝난다. 확인 중 오류(PH-CMS 연결 등)는 기록하고 다음 주기에 다시 시도한다. */
export async function runResidentWorker(root, worker, deps, { intervalMs = 15_000, signal } = {}) {
  const skip = new Set();
  const log = deps.log ?? (line => console.log(`[${new Date().toLocaleTimeString()}] ${line}`));
  log(`상주 워커 ${worker.id} 시작 (설정 모드 ${worker.mode})`);
  while (!signal?.aborted) {
    try { await deps.flushReports?.(); await residentTick(root, worker, { ...deps, log, skip }); }
    catch (error) { log(`확인 실패: ${error.message}`); }
    await new Promise(resolve => {
      const timer = setTimeout(resolve, intervalMs);
      signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }
  log(`상주 워커 ${worker.id} 종료. 진행 중인 작업 창은 그대로 둡니다.`);
}
