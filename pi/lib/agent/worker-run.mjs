// 워커 모드의 Projectman 실행 기록. 워커가 UID 하나를 직접 claim하고 결과를 보고한다.
// claim·보고 요청은 보내기 전에 파일로 남겨(요청 ID 고정) 응답이 유실되거나 재시작해도 같은 요청으로 재시도한다.
//   .s8-runtime/worker-claims/<uid>.json   claim 요청·결과(runId, revision), 보고 여부. ./s8.sh work로 실행하면
//                                          보낼 claim 요청을 미리 써 두고 워커가 그 요청을 보낸다.
//   .s8-runtime/runs/<runId>/outbox.json   보고 요청. 전달(Projectman·매니저·Telegram)은 outbox.mjs가 맡는다.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { saveJson } from '../storage/json-file.mjs';
import { reportForServer, flushDevelopmentOutbox } from '../development/outbox.mjs';

const WORK_TYPES = ['task', 'subtask'];
const readJson = async file => { try { return JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const claimFile = (root, uid) => path.join(root, '.s8-runtime/worker-claims', `${encodeURIComponent(uid)}.json`);

/** UID의 claim 기록(없으면 null). */
export const readClaim = (root, uid) => readJson(claimFile(root, uid));

/** 상주 루프가 다음 배정을 받을 수 있도록 보고 완료를 기록한다. */
export async function markReported(root, claim) {
  const file = claimFile(root, claim.uid);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await saveJson(file, { ...claim, reported: true });
}

/** 실행기(work.mjs)가 준비한 claim 요청을 워커에게 넘긴다. 같은 UID의 이전 기록은 대체한다. */
export async function dispatchClaim(root, { uid, operation }) {
  const file = claimFile(root, uid);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await saveJson(file, { uid, runId: operation.runId, operation });
}

/**
 * UID를 claim하고 작업 내용을 돌려준다. 이미 이 장비에서 claim한 작업이면 그대로 이어간다.
 * 반환: { claim, work } — claim은 보고에 필요한 기록, work는 에이전트에게 보여줄 작업 내용.
 */
export async function claimWork({ root, client, uid, workerId = 's8-developer' }) {
  const file = claimFile(root, uid);
  let saved = await readJson(file);
  const item = await client.get(uid);
  if (!WORK_TYPES.includes(item.type)) throw new Error(`task 또는 subtask만 수행할 수 있습니다: ${item.type}`);
  let task = await client.getWorkflow(uid);
  if (saved?.reported && task.state === 'ready') saved = null;
  if (!saved?.revision) {
    if (!saved) {
      const runId = randomUUID();
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      saved = { uid, runId, operation: { action: 'claim', expectedRevision: task.workflow.revision, requestId: randomUUID(), runId, workerId } };
      await saveJson(file, saved);
    }
    // 저장된 요청을 그대로 보내므로 응답 유실 후 재시도도 한 번만 반영된다.
    const claimed = await client.workflow(uid, saved.operation);
    saved = { ...saved, revision: claimed.workflow.revision };
    await saveJson(file, saved);
    // 콘솔의 패치 다운로드는 실행 디렉터리의 request.json으로 작업 UID를 찾는다.
    const runDirectory = path.join(root, '.s8-runtime/runs', saved.runId);
    await mkdir(runDirectory, { recursive: true, mode: 0o700 });
    await saveJson(path.join(runDirectory, 'request.json'), { task: { uid }, run: { runId: saved.runId } });
    task = await client.getWorkflow(uid);
  }
  return { claim: saved, work: { ...task, title: item.title ?? task.title, text: item.detail?.text, runId: saved.runId } };
}

/**
 * 에이전트가 판단한 결과를 보고한다. Git 작업과 필수 검증명 검사는 하지 않는다.
 * 보고는 outbox에 먼저 남기고 전달하므로, 전달이 실패해도 다음 전달 시도가 같은 요청으로 다시 보낸다.
 */
export async function reportWork({ root, client, claim, result }) {
  const directory = path.join(root, '.s8-runtime/runs', claim.runId), outbox = path.join(directory, 'outbox.json');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const task = { ...await client.getWorkflow(claim.uid), uid: claim.uid };
  const changedFiles = result.changedFiles ?? [];
  if (!await readJson(outbox)) {
    const report = reportForServer({ ...result, changedFiles });
    await saveJson(outbox, { version: 2, uid: claim.uid, title: task.title ?? claim.uid, runId: claim.runId, report, operation: { action: 'report', requestId: randomUUID(), expectedRevision: claim.revision, runId: claim.runId, report } });
  }
  await markReported(root, claim);
  await flushDevelopmentOutbox({ root, client });
  const pending = await readJson(outbox);
  return { status: pending.report.status, delivered: pending.delivered === true, conflict: pending.conflict === true, state: pending.state ?? null };
}
