import { createHash, randomUUID } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import path from 'node:path';
import { constants, realpathSync } from 'node:fs';
import { open, lstat } from 'node:fs/promises';
import { protectedPath } from '../extensions/s8-guard.ts';
import { permittedRepoPath } from './projectman-path.ts';
import { Type, type Static } from 'typebox';
import type { ProjectmanClient } from './projectman-client.ts';
import { visible } from '../../apps/telegram-gateway/gateway.mjs';

const spec = { title: Type.String({ minLength: 1, maxLength: 200 }), text: Type.String({ minLength: 1, maxLength: 6000 }) };
const selection = Type.Union([
  Type.Object({ uid: Type.String(), version: Type.Optional(Type.String({ pattern: '^[a-f0-9]{64}$', description: 'Omit on input; server binds the current parent fingerprint during preview' })) }, { additionalProperties: false }),
  Type.Object({ ...spec, repoPath: Type.String({ minLength: 1, maxLength: 1000 }) }, { additionalProperties: false }),
]);
const work = {
  key: Type.String({ pattern: '^[a-z][a-z0-9_-]{0,39}$' }), ...spec,
  acceptance: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { minItems: 1, maxItems: 10 }),
  dependsOn: Type.Optional(Type.Array(Type.String(), { maxItems: 30 })),
};
const draftFields = {
  workspace: Type.Object({ uid: Type.String(), version: Type.Optional(Type.String({ pattern: '^[a-f0-9]{64}$' })) }, { additionalProperties: false }), project: selection,
  works: Type.Array(Type.Object({ ...work, subtasks: Type.Optional(Type.Array(Type.Object(work, { additionalProperties: false }), { maxItems: 20 })) }, { additionalProperties: false }), { minItems: 1, maxItems: 30 }),
};
export const IntakeDraftSchema = Type.Object(draftFields, { additionalProperties: false });
export const IntakeInputSchema = Type.Object({ ...draftFields,
  source: Type.Object({ label: Type.String({ minLength: 1, maxLength: 300 }), text: Type.String({ minLength: 1, maxLength: 64000 }) }, { additionalProperties: false }),
}, { additionalProperties: false });
export type IntakeSource = { sourceId: string; source: { label: string; text: string }; hash: string };
export type IntakePlan = Static<typeof IntakeInputSchema> & { requestId: string };
export type IntakePreview = {
  plan: IntakePlan; hash: string; sourceHash: string;
  containers: { workspace: string; project: string };
  related: Array<{ uid: string; title: string; requestId: string; sourceHash: string; sameSource: boolean }>;
  relatedMayBeTruncated: boolean;
  relatedSearchIsExhaustive?: boolean;
};
export type IntakeResult = { requestId: string; hash: string; sourceHash: string; items: Array<{ key: string; uid: string; type: string; parentUid: string | null; existing: boolean }> };
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

export async function captureIntakeSource(cwd: string, entries: any[], sourcePath?: string, entryIds?: string[], label?: string): Promise<IntakeSource> {
  let text: string;
  let sourceLabel: string;
  if (sourcePath) {
    if (entryIds?.length) throw new Error('Choose a Markdown path or user messages, not both');
    const candidate = path.resolve(cwd, sourcePath);
    if (candidate.split(path.sep).some(part => ['.git', '.pi', '.pi-runtime', '.s8-runtime'].includes(part)) || path.extname(candidate).toLowerCase() !== '.md' || protectedPath(candidate, cwd)) throw new Error('Only permitted Markdown source paths are allowed');
    const file = permittedRepoPath(candidate, cwd);
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.nlink !== 1 || before.size > 256000) throw new Error('Source must be a regular single-link Markdown file of at most 256KB');
      if (permittedRepoPath(candidate, cwd) !== file) throw new Error('Source path changed');
      const buffer = Buffer.alloc(256001);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const after = await handle.stat();
      const current = await lstat(file);
      if (current.ino !== before.ino || current.dev !== before.dev || after.nlink !== 1 || bytesRead !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error('Source changed while reading; capture again');
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, bytesRead));
      sourceLabel = path.relative(realpathSync(path.resolve(cwd, '..')), file);
    } finally { await handle.close(); }
  } else {
    const users = entries.filter(entry => entry.type === 'message' && entry.message?.role === 'user');
    const ids = entryIds?.length ? entryIds : [users.at(-1)?.id];
    if (ids.length > 20 || new Set(ids).size !== ids.length || ids.some(id => !id || !users.some(entry => entry.id === id))) throw new Error('Select 1–20 actual user message entry IDs');
    const selected = users.filter(entry => ids.includes(entry.id)).map(entry => ({ entryId: entry.id, text: typeof entry.message.content === 'string' ? entry.message.content : entry.message.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n') }));
    if (selected.some(entry => !entry.text.trim() || visible(entry.text) !== entry.text)) throw new Error('User messages must contain text without credentials');
    text = selected.length === 1 ? selected[0].text : JSON.stringify(selected, null, 2);
    sourceLabel = label || `user-messages:${selected.map(entry => entry.entryId).join(',')}`;
  }
  if (!text.trim() || text.length > 64000 || sourceLabel.length > 300) throw new Error('Source exceeds label/text limits or is empty; split the request');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw new Error('Remove control characters from source before capture');
  if (visible(text) !== text || visible(sourceLabel) !== sourceLabel) throw new Error('Possible credentials in source; remove them before capture');
  return { sourceId: randomUUID(), source: { label: sourceLabel, text }, hash: hash(text) };
}

export function checkIntakeSource(source: IntakeSource) {
  if (!source?.sourceId || !source.source?.text || source.hash !== hash(source.source.text) || visible(source.source.text) !== source.source.text || visible(source.source.label) !== source.source.label) throw new Error('Invalid captured intake source');
  return source;
}

export function checkPreview(preview: IntakePreview) {
  if (!preview?.plan || preview.hash !== hash(JSON.stringify(preview.plan)) || preview.sourceHash !== hash(preview.plan.source.text)) throw new Error('Invalid intake preview');
  if (visible(JSON.stringify(preview.plan)) !== JSON.stringify(preview.plan)) throw new Error('Possible credentials in request; remove them before registration');
  return preview;
}

export async function previewIntake(client: ProjectmanClient, input: Static<typeof IntakeInputSchema>, requestId: string = randomUUID()) {
  if (!input.workspace?.uid) throw new Error('Select an existing workspace; agents cannot create workspaces');
  const serialized = JSON.stringify(input);
  if (Buffer.byteLength(serialized) > 200000) throw new Error('Split request into smaller intakes (maximum 200KB)');
  if (visible(serialized) !== serialized) throw new Error('Possible credentials in request; remove them before preview');
  return checkPreview(await client.previewIntake({ ...input, requestId }));
}

export function describeIntake(preview: IntakePreview) {
  checkPreview(preview);
  const plan = preview.plan;
  const container = (name: string, value: IntakePlan['project'], title: string) => `${name}: ${title} · ${'uid' in value ? `기존 ${value.uid} (${value.version ?? '미수정'})` : `신규\n${value.text}`}`;
  const lines = [
    `등록 요청: ${plan.requestId}`, `출처: ${plan.source.label}`, `원문 SHA-256: ${preview.sourceHash}`, `등록안 SHA-256: ${preview.hash}`,
    container('워크스페이스', plan.workspace, preview.containers.workspace), container('프로젝트', plan.project, preview.containers.project),
    '등록만 수행합니다. 신규 항목은 todo · autorun=false · requiresApproval=true입니다. 코드 수정·작업 실행을 승인하지 않습니다.',
  ];
  if (preview.related.length) lines.push(`기존 등록 후보 (동일 원문 또는 출처; 자동 병합하지 않음):\n${JSON.stringify(preview.related, null, 2)}`);
  if (preview.relatedMayBeTruncated || preview.relatedSearchIsExhaustive === false) lines.push('출처 후보는 제한된 검색입니다. 후보가 없다고 기존 등록이 없다고 단정하지 말고 필요한 범위를 추가 조회하세요.');
  for (const item of plan.works) {
    lines.push(`워크 [${item.key}]: ${item.title}\n${item.text}\n완료 조건:\n${item.acceptance.map(text => `- ${text}`).join('\n')}\n선행 워크: ${(item.dependsOn ?? []).join(', ') || '없음'}`);
    for (const child of item.subtasks ?? []) lines.push(`  서브워크 [${child.key}]: ${child.title}\n${child.text}\n완료 조건:\n${child.acceptance.map(text => `- ${text}`).join('\n')}\n선행 서브워크: ${(child.dependsOn ?? []).join(', ') || '없음'}`);
  }
  return stripVTControlCharacters(lines.join('\n\n')).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

export async function registerIntake(client: ProjectmanClient, preview: IntakePreview) {
  checkPreview(preview);
  const result = await client.registerIntake(preview.plan, preview.hash);
  if (result.requestId !== preview.plan.requestId || result.hash !== preview.hash || result.sourceHash !== preview.sourceHash || !Array.isArray(result.items)) throw new Error('Invalid intake registration response; inspect Projectman before retry');
  const expected: Array<{ type: string; parent: number | null; selection: IntakePlan['project'] }> = [
    { type: 'workspace', parent: null, selection: preview.plan.workspace }, { type: 'project', parent: 0, selection: preview.plan.project },
  ];
  for (const work of preview.plan.works) {
    const parent = expected.length;
    expected.push({ type: 'task', parent: 1, selection: work });
    for (const child of work.subtasks ?? []) expected.push({ type: 'subtask', parent, selection: child });
  }
  if (result.items.length !== expected.length || new Set(result.items.map(row => row.uid)).size !== expected.length) throw new Error('Incomplete intake response; inspect Projectman before retry');
  // Re-read committed items; a lost response or failed verification must never create a new request ID.
  for (const [index, row] of result.items.entries()) {
    const wanted = expected[index];
    const existing = 'uid' in wanted.selection;
    if (row.type !== wanted.type || row.existing !== existing || row.parentUid !== (wanted.parent === null ? null : result.items[wanted.parent].uid) || (existing && 'uid' in wanted.selection && row.uid !== wanted.selection.uid)) throw new Error('Unexpected intake hierarchy');
    const fresh = await client.get(row.uid);
    const attrs = fresh.detail?.attributes;
    const meta = attrs?.intake as { hash?: string } | undefined;
    if (fresh.type !== row.type || (fresh.parent?.uid ?? null) !== row.parentUid || (!existing && (attrs?.state !== 'todo' || attrs?.autorun !== false || attrs?.requiresApproval !== true || !Array.isArray(attrs?.allowedActions) || attrs.allowedActions.length !== 0 || meta?.hash !== preview.hash))) {
      throw new Error('Intake changed or verification failed; inspect Projectman before retry');
    }
  }
  return result;
}
