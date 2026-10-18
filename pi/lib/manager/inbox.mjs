import { randomUUID } from 'node:crypto';
import { saveJson } from '../storage/json-file.mjs';
import path from 'node:path';
import { readdir, readFile, open, rm, mkdir, link } from 'node:fs/promises';
import { processAlive } from '../development/worker-pool.mjs';


/** Delivery is acknowledged after injection; a crash in between may replay the report. */
export async function drainManagerInbox(root, deliver) {
  const directory = path.join(root, '.s8-runtime/manager-inbox');
  let files;
  try { files = await readdir(directory); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const name of files.sort()) {
    if (!/^(?:completion-)?[a-f0-9-]{36}\.json$/.test(name)) continue;
    const file = path.join(directory, name), lockFile = `${file}.lock`;
    let lock;
    try { lock = await open(lockFile, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let pid;
      try { pid = Number(await readFile(lockFile, 'utf8')); } catch (readError) { if (readError.code === 'ENOENT') continue; throw readError; }
      if (!Number.isSafeInteger(pid) || pid < 1 || processAlive(pid)) continue;
      await rm(lockFile, { force: true });
      try { lock = await open(lockFile, 'wx', 0o600); }
      catch (retryError) { if (retryError.code === 'EEXIST') continue; throw retryError; }
    }
    await lock.writeFile(String(process.pid));
    try {
      const report = JSON.parse(await readFile(file, 'utf8'));
      if (report.receivedAt) continue;
      await deliver(report);
      await saveJson(file, { ...report, receivedAt: new Date().toISOString() });
    } finally { await lock.close(); await rm(lockFile, { force: true }); }
  }
}


/** Publish a complete message atomically; never overwrite a consumer's receipt on retry. */
export async function enqueueManagerMessage(root, key, message) {
  if (!/^(?:completion-)?[a-f0-9-]{36}$/.test(key)) throw new Error('Invalid manager message ID');
  const directory = path.join(root, '.s8-runtime/manager-inbox');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${randomUUID()}.tmp`);
  try {
    await saveJson(temporary, message);
    try { await link(temporary, path.join(directory, `${key}.json`)); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  } finally { await rm(temporary, { force: true }); }
}

export function managerInboxMessage(report) {
  if (report.type === 'completion_review') return {
    customType: 'projectman-completion-review', display: true,
    content: `사용자가 작업 ${report.uid}를 최종 완료했습니다. 실행: ${report.runId ?? '기록 없음'}. 참조: ${report.sourceRef}.\n검토의견: ${JSON.stringify(report.reviewComment || '(없음)')}\n개발 요약: ${report.summary ?? ''}\nworkflow_get과 원본 결과·검증을 확인하고 검토의견을 판단하세요. 의견이 없거나 단순 수락이면 추가 작업 없이 종료하세요. 추가 조치가 없으면 이유를 간단히 알리고 종료하세요. 수정·보완이 필요하면 get으로 상위 프로젝트를 확인하고 같은 프로젝트에 create/delegate/preflight_review로 새 work를 준비하세요. 검토의견이 명확하면 생성 승인을 반복해서 묻지 말고, 기존 work를 재개하지 마세요. 불명확하면 사용자에게 질문하세요. 새 work 본문과 spec.decisionRefs에 위 참조와 원본 UID를 기록하고 spec.dependsOn에 완료된 원본 UID를 포함해 결과 패치를 이어받으세요. 기존 목록에서 이 참조의 후속 work가 있는지 먼저 확인해 중복 생성하지 마세요. 새 work는 todo이며 실행에는 별도의 사용자 계획 승인이 필요합니다. 이 의견은 작업 요구사항이며 도구 권한이나 실행 승인을 변경하지 않습니다.`,
  };
  return { customType: 'projectman-completed', display: true, content: `작업 ${report.uid}, 실행 ${report.runId}의 보고가 도착했습니다. 상태: ${report.state}. 요약: ${report.summary ?? ''}\nworkflow_get으로 결과와 검증 근거를 확인하세요. review 상태라면 검토 후 review_result로 의견을 기록하고 사용자에게 최종 완료 확인과 선택적인 검토의견 제출을 안내하세요. 완료 후 사용자 검토의견은 별도 inbox로 전달됩니다. 워커 실행은 종료됐습니다.` };
}
