// 워커 모드의 Projectman 실행 기록. 워커가 UID 하나를 직접 claim하고 결과를 보고한다.
// claim·보고 요청은 보내기 전에 파일로 남겨(요청 ID 고정) 응답이 유실되거나 재시작해도 같은 요청으로 재시도한다.
//   .s8-runtime/worker-claims/<uid>.json   claim 요청·결과(runId, revision), 보고 여부
//   .s8-runtime/runs/<runId>/outbox.json   보고 요청. 전달(Projectman·매니저·Telegram)은 슈퍼바이저와 같은 outbox 경로를 쓴다.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { saveJson } from '../storage/json-file.mjs';
import { requireConfirmedPlan } from '../projectman/preflight.mjs';
import { reportForServer, flushDevelopmentOutbox } from '../development/outbox.mjs';
import { workspaceChanges } from '../development/workspace.mjs';

const WORK_TYPES = ['task', 'subtask'];
const readJson = async file => { try { return JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const claimFile = (root, uid) => path.join(root, '.s8-runtime/worker-claims', `${encodeURIComponent(uid)}.json`);

/** 이 실행이 소유한 진행 중 작업인지 확인한다. */
const activeRun = (task, runId) => task.state === 'doing' && task.workflow?.run?.id === runId && task.executionAllowed !== false;

/**
 * UID를 claim하고 작업 내용을 돌려준다. 이미 이 장비에서 claim한 작업이면 그대로 이어간다.
 * 반환: { claim, work } — claim은 보고에 필요한 기록, work는 에이전트에게 보여줄 작업 내용.
 */
export async function claimWork({ root, client, uid, workerId = 's8-developer' }) {
  const file = claimFile(root, uid);
  let saved = await readJson(file);
  if (saved?.reported) throw new Error('이미 보고한 작업입니다. 다시 실행하려면 새 작업으로 요청하세요.');
  const item = await client.get(uid);
  if (!WORK_TYPES.includes(item.type)) throw new Error(`task 또는 subtask만 수행할 수 있습니다: ${item.type}`);
  let task = await client.getWorkflow(uid);
  if (!saved?.revision) {
    if (!saved) {
      if (task.workflow?.run || task.executionAllowed === false || task.state !== 'ready' || !task.workflow?.grant || task.workflow.review?.pending) throw new Error(`실행 가능한 상태가 아닙니다(state: ${task.state}). 승인된 ready 작업만 claim합니다.`);
      await requireConfirmedPlan(client, uid);
      const runId = randomUUID();
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      saved = { uid, runId, operation: { action: 'claim', expectedRevision: task.workflow.revision, requestId: randomUUID(), runId, workerId } };
      await saveJson(file, saved);
    }
    // 저장된 요청을 그대로 보내므로 응답 유실 후 재시도도 한 번만 반영된다.
    const claimed = await client.workflow(uid, saved.operation);
    saved = { ...saved, revision: claimed.workflow.revision };
    await saveJson(file, saved);
    task = await client.getWorkflow(uid);
  }
  if (!activeRun(task, saved.runId)) throw new Error('이 워커의 실행이 더 이상 유효하지 않습니다(회수 또는 다른 워커 배정).');
  return { claim: saved, work: { ...task, title: item.title ?? task.title, text: item.detail?.text, runId: saved.runId } };
}

/** 실행이 아직 이 워커 소유인지 확인한다(회수되면 false). */
export async function stillActive(client, claim) {
  return activeRun(await client.getWorkflow(claim.uid), claim.runId);
}

/**
 * 결과를 보고한다. 변경 파일은 작업 디렉터리의 git 상태에서 구하고, 필수 검증이 빠지면 failed로 바꾼다.
 * 보고는 outbox에 먼저 남기고 전달하므로, 전달이 실패해도 슈퍼바이저나 다음 보고 시도가 같은 요청으로 다시 보낸다.
 */
export async function reportWork({ root, client, claim, result, cwd }) {
  let changedFiles = [];
  try { changedFiles = (await workspaceChanges(cwd)).changedFiles; } catch { /* git 저장소가 아니면 변경 목록 없이 보고한다. */ }
  const task = await client.getWorkflow(claim.uid);
  const required = (task.workflow?.spec?.commandNames ?? []).filter(name => name !== 'install');
  if (result.status === 'completed' && required.some(name => !result.verification?.some(check => check.name === name && check.ok))) {
    result = { ...result, status: 'failed', executionErrors: [...(result.executionErrors ?? []), 'Required verification is missing from the report'] };
  }
  const directory = path.join(root, '.s8-runtime/runs', claim.runId), outbox = path.join(directory, 'outbox.json');
  if (!await readJson(outbox)) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const report = reportForServer({ ...result, changedFiles });
    await saveJson(outbox, { version: 2, uid: claim.uid, title: task.title ?? claim.uid, runId: claim.runId, report, operation: { action: 'report', requestId: randomUUID(), expectedRevision: claim.revision, runId: claim.runId, report } });
  }
  await saveJson(claimFile(root, claim.uid), { ...claim, reported: true });
  await flushDevelopmentOutbox({ root, client });
  const pending = await readJson(outbox);
  return { status: pending.report.status, delivered: pending.delivered === true, conflict: pending.conflict === true, state: pending.state ?? null };
}
