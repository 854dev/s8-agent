import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, link, rm } from 'node:fs/promises';
import { saveJson } from '../storage/json-file.mjs';
import { enqueueManagerMessage } from '../manager/inbox.mjs';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const directory = root => path.join(root, '.s8-runtime/completion-reviews');
const invalid = () => Object.assign(new Error('Invalid completion review'), { status: 400 });

async function deliver(root, record, file) {
  await enqueueManagerMessage(root, `completion-${record.requestId}`, {
    type: 'completion_review', uid: record.uid, runId: record.runId, state: 'done',
    requestId: record.requestId, sourceRef: `completion-review:${record.uid}:${record.requestId}`,
    summary: record.summary, reviewComment: record.reviewComment, submittedAt: record.submittedAt,
  });
  await saveJson(file, { ...record, delivered: true });
}

/** Persist intent before the human-authorized write; the server's immutable log proves completion. */
export async function submitCompletionReview({ root, client, uid, input }) {
  if (!uuid.test(input.requestId ?? '') || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 ||
      (input.reviewComment !== undefined && typeof input.reviewComment !== 'string') ||
      (input.message !== undefined && (typeof input.message !== 'string' || !input.message.trim() || input.message.length > 8000)) ||
      Object.keys(input).some(key => !['action', 'requestId', 'expectedRevision', 'reviewComment', 'message'].includes(key))) throw invalid();
  const reviewComment = (input.reviewComment ?? '').trim();
  if (reviewComment.length > 6000) throw invalid();
  const operation = { action: 'complete', expectedRevision: input.expectedRevision, requestId: input.requestId,
    message: input.reviewComment === undefined && input.message ? input.message.trim() : reviewComment ? `사용자 검토의견:\n${reviewComment}` : '사용자가 결과를 확인하고 작업을 완료했습니다. 검토의견 없음.' };
  const serverFingerprint = createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.keys(operation).sort().map(key => [key, operation[key]])))).digest('hex');
  const fingerprint = createHash('sha256').update(JSON.stringify({ uid, operation })).digest('hex');
  const current = await client.getWorkflow(uid); // Retain normal read authorization on every request/replay.
  const folder = directory(root), file = path.join(folder, `${input.requestId}.json`);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const proposed = { uid, requestId: input.requestId, fingerprint, serverFingerprint, reviewComment, runId: current.workflow?.run?.id,
    summary: current.workflow?.result?.summary ?? '', submittedAt: new Date().toISOString(), delivered: false };
  const temporary = path.join(folder, `.${randomUUID()}.tmp`);
  try {
    await saveJson(temporary, proposed);
    try { await link(temporary, file); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  } finally { await rm(temporary, { force: true }); }
  const record = await readJson(file);
  if (record.uid !== uid || record.fingerprint !== fingerprint) throw Object.assign(new Error('Completion request changed'), { status: 409 });
  const result = await client.workflow(uid, operation); // Human JWT and manager review are checked by PH-CMS.
  if (result.state !== 'done') throw new Error('Completion was not confirmed');
  await deliver(root, record, file);
  return result;
}

/** Recover a lost response or inbox write without replaying a human action as the manager. */
export async function recoverCompletionReviews(root, client) {
  const folder = directory(root);
  let files;
  try { files = await readdir(folder); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const name of files) {
    if (!name.endsWith('.json') || !uuid.test(name.slice(0, -5))) continue;
    try {
      const file = path.join(folder, name), record = await readJson(file);
      if (record.delivered) continue;
      const logs = await client.list('work_log', record.uid);
      const completed = logs.some(log => log.detail?.attributes?.event === 'complete' &&
        log.detail.attributes.requestId === record.requestId && log.detail.attributes.fingerprint === record.serverFingerprint && log.detail.attributes.result?.state === 'done');
      if (completed) await deliver(root, record, file);
    } catch { /* An unconfirmed or inaccessible completion stays pending; continue other deliveries. */ }
  }
}
