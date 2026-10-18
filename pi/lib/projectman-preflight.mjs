import { createHash } from 'node:crypto';

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export function preflightFingerprint(item, workflow) {
  return createHash('sha256').update(JSON.stringify(canonical({ title: item.title, text: item.detail?.text ?? null, parentUid: item.parent?.uid ?? null, specHash: workflow?.specHash, spec: workflow?.spec }))).digest('hex');
}

export function hasReviewedPreflight(item, workflow) {
  const review = item.detail?.attributes.s8Preflight;
  return Boolean(workflow?.specHash && review?.status === 'reviewed' && review.specHash === workflow.specHash && review.fingerprint === preflightFingerprint(item, workflow) && typeof review.summary === 'string' && review.summary.trim());
}

export async function requireReviewedPreflight(client, uid) {
  const [item, task] = await Promise.all([client.get(uid), client.getWorkflow(uid)]);
  if (!hasReviewedPreflight(item, task.workflow)) throw new Error('PH-CMS request failed (HTTP 409): Manager preflight review required');
  return { ...task, preflight: item.detail.attributes.s8Preflight };
}

export async function requireConfirmedPlan(client, uid) {
  const task = await client.getWorkflow(uid);
  const w = task.workflow;
  if (w?.version !== 2 || !w.planHash || w.confirmation?.planHash !== w.planHash || w.confirmation?.planVersion !== w.planVersion || w.grant?.specHash !== w.specHash) throw new Error('PH-CMS request failed (HTTP 409): Human plan confirmation required');
  return { ...task, preflight: { summary: w.spec.plan, confirmation: w.confirmation } };
}
