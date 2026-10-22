// 매니저 장비에서 Projectman의 끝난 실행을 매니저 inbox로 옮긴다.
// 원격 워커의 보고 전달(outbox.mjs)은 워커 장비의 inbox에만 남기 때문에, 매니저는 Projectman을 원본으로 본다.
// 같은 장비 워커가 먼저 넣은 보고는 같은 runId 키라 다시 넣지 않는다. inbox에 먼저 넣은 쪽이 Telegram을 보낸다.
//   .s8-runtime/manager-runs-since.json   처음 실행한 시각. 그 전에 끝난 실행은 이미 처리된 기록으로 본다
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { saveJson } from '../storage/json-file.mjs';
import { loadS8Config } from '../config/s8-config.mjs';
import { sendTelegram } from '../telegram/notify.mjs';
import { enqueueManagerMessage } from './inbox.mjs';
import { runNotice } from '../development/outbox.mjs';

const RUN_ID = /^[a-f0-9-]{36}$/;
const readJson = async file => { try { return JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };

/** items: Projectman task·subtask 목록. 새로 넣은 runId 목록을 돌려준다. Telegram 실패는 다시 시도하지 않는다. */
export async function recordFinishedRuns({ root, items, settings = loadS8Config(root), notify = sendTelegram, now = () => new Date() }) {
  const sinceFile = path.join(root, '.s8-runtime/manager-runs-since.json');
  const since = (await readJson(sinceFile))?.since;
  if (!since) {
    await mkdir(path.dirname(sinceFile), { recursive: true, mode: 0o700 });
    await saveJson(sinceFile, { since: now().toISOString() });
    return [];
  }
  const recorded = [];
  for (const item of items) {
    const workflow = item.detail?.attributes.workflow, run = workflow?.run;
    if (run?.status !== 'finished' || !workflow.result || !RUN_ID.test(run.id ?? '') || !(Date.parse(run.finishedAt) >= Date.parse(since))) continue;
    const report = workflow.result;
    if (!await enqueueManagerMessage(root, run.id, { uid: item.uid, runId: run.id, state: item.detail.attributes.state, summary: report.summary ?? '', source: 'projectman' })) continue;
    recorded.push(run.id);
    const message = runNotice({ title: item.title, uid: item.uid, runId: run.id, report }, settings.publicUrl);
    if (message && settings.telegram.scheduleChatId) await notify(message, process.env, fetch, settings.telegram).catch(() => false);
  }
  return recorded;
}
