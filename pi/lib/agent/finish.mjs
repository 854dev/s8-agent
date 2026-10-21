// 멈춘 실행의 수동 마무리(./s8.sh finish). claim 기록이 없는 장비에서도 서버의 현재 run을 실패로 보고해 끝낸다.
// 운영자가 모든 장비에서 워커가 멈췄음을 확인(--confirm-stopped)하고 run ID를 지정해야 하며, 이 장비에 워커 창이 살아 있으면 거부한다.
// 보고는 워커와 같은 outbox 경로로 보내므로 매니저·Telegram에도 전달되고, 응답이 유실돼도 같은 요청으로 재시도된다.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { saveJson } from '../storage/json-file.mjs';
import { flushDevelopmentOutbox, reportForServer } from '../development/outbox.mjs';
import { hasSession, runTmux, windows } from '../runtime/tmux-windows.mjs';
import { readClaim, markReported } from './worker-run.mjs';
import { WORK_SESSION } from './work.mjs';
import { loadS8Config } from '../config/s8-config.mjs';

// 거부 사유는 고정 문구만 쓴다(콘솔 화면에 그대로 보여 준다). 상위 오류에는 응답 본문이 섞일 수 있다.
const refuse = message => { throw Object.assign(new Error(message), { code: 'FINISH_REFUSED' }); };
const readJson = async file => { try { return JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };

export async function finishStoppedRun({ root, client, uid, runId, confirmed = false, run = runTmux }) {
  if (!confirmed) refuse('모든 장비에서 실행이 멈췄는지 확인한 뒤 --confirm-stopped를 붙이세요.');
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(uid ?? '') || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(runId ?? '')) refuse('작업 UID와 UUID 형식의 --run-id가 필요합니다.');
  const communication = loadS8Config(root).communication;
  let central;
  if (communication.enabled) {
    const local = await readClaim(root, uid);
    if (local?.runId !== runId || local.nodeId !== communication.nodeId) refuse('원격 실행은 매니저의 tmux 상태로 마무리할 수 없습니다. 실행 소유 장비에서 워커 종료와 claim을 확인하세요.');
    central = await client.getWorkflow(uid);
    if (central.workflow?.run?.id !== runId || central.workflow.run.workerId !== local.operation?.workerId) refuse('Projectman의 현재 실행 소유 워커와 로컬 claim이 다릅니다. 마무리하지 않았습니다.');
  }
  if (await hasSession(run, WORK_SESSION) && (await windows(run, WORK_SESSION)).some(window => window.name === uid && !window.dead)) {
    refuse(`워커 창이 아직 실행 중입니다. 먼저 종료하세요: tmux kill-window -t ${WORK_SESSION}:${uid}`);
  }
  const directory = path.join(root, '.s8-runtime/runs', runId), outbox = path.join(directory, 'outbox.json');
  // 워커가 보고했지만 전달되지 않은 경우는 그 보고를 그대로 보낸다.
  if (!await readJson(outbox)) {
    const current = central ?? await client.getWorkflow(uid);
    if (current.workflow?.run?.id !== runId) refuse('서버의 현재 run이 지정한 run ID와 다릅니다. 보고하지 않았습니다.');
    if (current.workflow.run.status === 'finished') return { uid, runId, status: 'already-finished', state: current.state };
    if (current.state !== 'doing') refuse(`doing 상태의 실행만 마무리할 수 있습니다(state: ${current.state}).`);
    // 서버는 revision과 claim한 에이전트를 확인한다. 중단된 작업을 완료로 보고하지 않는다.
    const report = reportForServer({
      status: 'failed', summary: 'Operator confirmed execution stopped on all hosts and finished the run manually.',
      executionErrors: ['Execution was interrupted; changes and verification could not be recovered.'],
      remainingItems: ['Inspect any saved workspace and artifacts before creating follow-up work.'],
    });
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await saveJson(outbox, { version: 2, uid, title: current.title ?? uid, runId, report, operation: { action: 'report', requestId: randomUUID(), expectedRevision: current.workflow.revision, runId, report } });
  }
  const claim = await readClaim(root, uid);
  if (claim?.runId === runId) await markReported(root, claim);
  await flushDevelopmentOutbox({ root, client });
  const pending = await readJson(outbox);
  if (pending.conflict) refuse('서버가 보고를 거부했습니다(revision 또는 claim 에이전트 불일치). 작업 상태를 다시 확인하세요.');
  if (!pending.delivered) refuse('보고를 아직 전달하지 못했습니다. 연결을 확인하고 같은 명령으로 다시 시도하세요.');
  return { uid, runId, status: 'finished', state: pending.state };
}
