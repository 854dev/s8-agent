// 워커 모드의 Projectman 실행 기록. 워커가 UID 하나를 직접 claim하고 결과를 보고한다.
// claim·보고 요청은 보내기 전에 파일로 남겨(요청 ID 고정) 응답이 유실되거나 재시작해도 같은 요청으로 재시도한다.
//   .s8-runtime/worker-claims/<uid>.json   claim 요청·결과(runId, revision), 보고 여부. ./s8.sh work로 실행하면
//                                          보낼 claim 요청과 입력 트리(inputTree)를 미리 써 두고 워커가 그 요청을 보낸다.
//   .s8-runtime/runs/<runId>/outbox.json   보고 요청. 전달(Projectman·매니저·Telegram)은 outbox.mjs가 맡는다.
//   .s8-runtime/runs/<runId>/task.patch    입력 트리 대비 변경. 이 작업에 의존하는 작업이 가져다 쓴다.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { saveJson } from '../storage/json-file.mjs';
import { requireConfirmedPlan } from '../projectman/preflight.mjs';
import { reportForServer, flushDevelopmentOutbox } from '../development/outbox.mjs';
import { workspaceChanges, workspacePatch } from '../development/workspace.mjs';
import { git } from '../development/git.mjs';

const WORK_TYPES = ['task', 'subtask'];
const readJson = async file => { try { return JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const claimFile = (root, uid) => path.join(root, '.s8-runtime/worker-claims', `${encodeURIComponent(uid)}.json`);

/** UID의 claim 기록(없으면 null). */
export const readClaim = (root, uid) => readJson(claimFile(root, uid));

/** claim 기록을 보고 완료로 표시한다. 이후 같은 claim으로 다시 작업하지 않는다. */
export const markReported = (root, claim) => saveJson(claimFile(root, claim.uid), { ...claim, reported: true });

/** 실행기(work.mjs)가 준비한 claim 요청을 워커에게 넘긴다. 같은 UID의 이전 기록은 대체한다. */
export async function dispatchClaim(root, { uid, operation, inputTree, baseCommit }) {
  const file = claimFile(root, uid);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await saveJson(file, { uid, runId: operation.runId, operation, inputTree, baseCommit });
}

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
    // 콘솔의 패치 다운로드는 실행 디렉터리의 request.json으로 작업 UID를 찾는다.
    const runDirectory = path.join(root, '.s8-runtime/runs', saved.runId);
    await mkdir(runDirectory, { recursive: true, mode: 0o700 });
    await saveJson(path.join(runDirectory, 'request.json'), { task: { uid }, run: { runId: saved.runId } });
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
 * 보고는 outbox에 먼저 남기고 전달하므로, 전달이 실패해도 다음 전달 시도가 같은 요청으로 다시 보낸다.
 */
export async function reportWork({ root, client, claim, result, cwd }) {
  const directory = path.join(root, '.s8-runtime/runs', claim.runId), outbox = path.join(directory, 'outbox.json');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // git 저장소가 아니면 변경 목록·패치 없이 보고한다. 보호 경로 변경은 패치에서 빼고 남은 일로 알린다.
  let changedFiles = [];
  if (await git(cwd, ['rev-parse', '--is-inside-work-tree']).then(() => true, () => false)) {
    const changes = await workspaceChanges(cwd);
    changedFiles = changes.changedFiles;
    if (changes.skippedFiles.length) {
      const shown = changes.skippedFiles.slice(0, 10).join(', ');
      const more = changes.skippedFiles.length > 10 ? ` 외 ${changes.skippedFiles.length - 10}개` : '';
      result = { ...result, remainingItems: [...(result.remainingItems ?? []), `보호 경로 변경은 패치에서 뺐습니다: ${shown}${more}. .gitignore 처리나 수동 반영이 필요한지 확인하세요.`] };
    }
    await writeFile(path.join(directory, 'task.patch'), await workspacePatch(cwd, claim.inputTree), { mode: 0o600 });
    await writeFile(path.join(directory, 'changes.patch'), await workspacePatch(cwd), { mode: 0o600 });
  }
  const task = await client.getWorkflow(claim.uid);
  const required = (task.workflow?.spec?.commandNames ?? []).filter(name => name !== 'install');
  if (result.status === 'completed' && required.some(name => !result.verification?.some(check => check.name === name && check.ok))) {
    result = { ...result, status: 'failed', executionErrors: [...(result.executionErrors ?? []), 'Required verification is missing from the report'] };
  }
  if (!await readJson(outbox)) {
    const report = reportForServer({ ...result, changedFiles, ...(claim.baseCommit ? { baseCommit: claim.baseCommit } : {}) });
    await saveJson(outbox, { version: 2, uid: claim.uid, title: task.title ?? claim.uid, runId: claim.runId, report, operation: { action: 'report', requestId: randomUUID(), expectedRevision: claim.revision, runId: claim.runId, report } });
  }
  await markReported(root, claim);
  await flushDevelopmentOutbox({ root, client });
  const pending = await readJson(outbox);
  return { status: pending.report.status, delivered: pending.delivered === true, conflict: pending.conflict === true, state: pending.state ?? null };
}
