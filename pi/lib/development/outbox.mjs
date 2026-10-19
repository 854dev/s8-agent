// 개발 결과 보고와 전달. 보고는 outbox.json에 먼저 기록하고(요청 ID 고정) Projectman·매니저·Telegram에 차례로 전달한다.
// 전달이 실패하면 다음 flush가 같은 요청 ID로 재시도하므로 보고가 중복 반영되지 않는다. 워커 보고(worker-run.mjs)와 매니저 polling이 함께 쓴다.
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { enqueueManagerMessage } from '../manager/inbox.mjs';
import { saveJson } from '../storage/json-file.mjs';
import { loadS8Config } from '../config/s8-config.mjs';
import { sendTelegram } from '../telegram/notify.mjs';

const readJson = async file => JSON.parse(await readFile(file, 'utf8'));

export function reportForServer(value) {
  const strings = values => (Array.isArray(values) ? values : []).slice(0, 100).map(item => String(item).trim().slice(0, 3000)).filter(Boolean);
  const checks = Array.isArray(value?.verification) ? value.verification : [];
  const failedChecks = checks.filter(check => check?.ok !== true);
  const retained = [...failedChecks, ...checks.filter(check => check?.ok === true)].slice(0, 20);
  const report = { status: value?.status === 'completed' ? 'completed' : 'failed', summary: String(value?.summary ?? '').trim().slice(0, 8000) || 'No valid development summary was returned.', changedFiles: value?.changedFiles ?? [], verification: retained.map(item => ({ name: String(item?.name ?? 'unnamed check').slice(0, 100) || 'unnamed check', ok: item?.ok === true, summary: String(item?.summary ?? '').slice(0, 1000) })), remainingItems: strings(value?.remainingItems), decisions: strings(value?.decisions), executionErrors: strings(value?.executionErrors), checkpoint: String(value?.checkpoint ?? '').slice(0, 16000), ...(value?.baseCommit ? { baseCommit: value.baseCommit } : {}) };
  // 실패한 검증이 있으면 completed로 두지 않는다. executionErrors는 워커가 판단한 상태를 바꾸지 않는다(해결한 문제를 적을 수 있다).
  if (failedChecks.length) report.status = 'failed';
  if (report.status === 'failed' && !report.executionErrors.length) report.executionErrors = [failedChecks.length ? 'One or more verification checks failed' : report.summary.slice(0, 3000)];
  return report;
}

export function workLink(publicUrl, uid, runId) {
  if (!publicUrl) return null;
  const url = new URL(publicUrl);
  url.searchParams.set('task', uid);
  url.searchParams.set('run', runId);
  return url.href;
}

const flushing = new Map();
export function flushDevelopmentOutbox(options) {
  const previous = flushing.get(options.root) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => flushOutbox(options));
  flushing.set(options.root, next);
  return next.finally(() => { if (flushing.get(options.root) === next) flushing.delete(options.root); });
}

async function flushOutbox({ root, client, notify = sendTelegram, settings = loadS8Config(root) }) {
  const runs = path.join(root, '.s8-runtime/runs');
  let directories;
  try { directories = await readdir(runs); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const outcomes = [];
  for (const runId of directories) {
    if (!/^[a-f0-9-]{36}$/.test(runId)) continue;
    const directory = path.join(runs, runId), file = path.join(directory, 'outbox.json');
    let pending;
    try { pending = await readJson(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (pending.conflict || (pending.delivered && pending.managerDelivered && pending.telegramDelivered)) continue;
    // Legacy delivered records have already been processed; do not notify every historical run.
    if (pending.delivered && !pending.version) continue;
    try {
      if (!pending.delivered) {
        const delivered = await client.workflow(pending.uid, pending.operation);
        await saveJson(path.join(directory, 'result.json'), { ...pending.report, projectman: delivered, runId });
        pending = { ...pending, delivered: true, state: delivered.state };
        await saveJson(file, pending);
        outcomes.push({ runId, delivered: true });
      }
      if (!pending.managerDelivered) {
        await enqueueManagerMessage(root, runId, { uid: pending.uid, runId, state: pending.state, summary: pending.report.summary });
        pending.managerDelivered = true;
        await saveJson(file, pending);
      }
      if (pending.version && !pending.telegramDelivered) {
        const link = workLink(settings.publicUrl, pending.uid, runId);
        if (!link || !settings.telegram.scheduleChatId) {
          pending.notificationStatus = 'not_configured';
        } else {
          const checks = (pending.report.verification ?? []).map(check => `${check.ok ? '통과' : '실패'}: ${check.name}`).join(', ');
          const message = `${pending.report.status === 'completed' ? '✅ 개발 완료 · 최종 확인 대기' : '⚠️ 작업 실패'}: ${pending.title ?? pending.uid}\n${pending.report.summary.slice(0, 1800)}\n검증: ${checks.slice(0, 500) || '기록 없음'}\n${link}`;
          pending.telegramDelivered = await notify(message, process.env, fetch, settings.telegram);
          pending.notificationStatus = pending.telegramDelivered ? 'sent' : 'not_configured';
        }
        await saveJson(file, pending);
      }
      if (pending.version && !pending.telegramDelivered) outcomes.push({ runId, notificationStatus: pending.notificationStatus });
    } catch (error) {
      if (!pending.delivered && /HTTP (409|404)/.test(error.message)) pending.conflict = true;
      else if (pending.delivered) pending.notificationStatus = 'pending';
      await saveJson(file, pending);
      outcomes.push({ runId, delivered: pending.delivered === true, conflict: pending.conflict === true });
    }
  }
  return outcomes;
}

