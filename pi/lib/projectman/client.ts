import { randomUUID } from 'node:crypto';
import { preflightFingerprint, hasReviewedPreflight } from './preflight.mjs';
import type { IntakePlan, IntakePreview, IntakeResult } from './intake.ts';

export type ProjectmanContent = {
  uid: string;
  type: string;
  title: string;
  status: string;
  created_at: string;
  updated_at: string | null;
  tags?: string[];
  parent?: { uid: string } | null;
  detail: { text: string | null; attributes: Record<string, unknown> } | null;
};

// Keep large original requests out of ordinary lists / execution prompts; intake_get pages the authoritative manifest.
export const projectmanJson = (value: unknown) => JSON.stringify(value, (key, data) =>
  key === 'intake' && data?.manifest ? { ...data, manifest: { stored: true, readWith: 'projectman intake_get using requestId' } } : data);

type Page = { content: ProjectmanContent[]; last: boolean };

// Translate only exact known messages to fixed codes. Never propagate upstream text or payloads.
const rejectionCodes = new Map([
  ['Delegated work is frozen; use workflow delegation to revise execution scope', 'WORKFLOW_FROZEN'],
  ['Delete child resources first', 'CHILD_RESOURCES_EXIST'],
  ['Finish or stop workflow execution before deleting', 'EXECUTION_NOT_FINISHED'],
  ['Projectman parent was deleted', 'PARENT_CHANGED'],
  ['Active or unsettled execution prevents tree deletion', 'TREE_EXECUTION_ACTIVE'],
  ['Projectman resources are referenced by unfinished work outside the deletion tree', 'TREE_HAS_DEPENDENTS'],
  ['Projectman deletion tree exceeds 5000 records; delete smaller subtrees', 'TREE_TOO_LARGE'],
  ['Projectman dependency is missing or deleted', 'DEPENDENCY_CHANGED'],
  ['Project for this codebase already exists in this workspace; select its UID', 'PROJECT_ALREADY_EXISTS'],
  ['Project for this codebase already exists in this workspace', 'PROJECT_ALREADY_EXISTS'],
  ["Body cannot be empty when content-type is set to 'application/json'", 'JSON_BODY_REQUIRED'],
]);

export class ProjectmanError extends Error {
  status: number;
  code?: string;
  constructor(status: number, code?: string) {
    super(`PH-CMS request failed (HTTP ${status})`);
    this.status = status; this.code = code;
  }
}

export class ProjectmanClient {
  private base: string;
  private token: string;
  private fetcher: typeof fetch;
  private signal?: AbortSignal;

  constructor(base: string, token: string, fetcher: typeof fetch = fetch, signal?: AbortSignal) {
    this.base = base;
    this.token = token;
    this.fetcher = fetcher;
    this.signal = signal;
    if (!base || !token) throw new Error('PHCMS_API_URL and PHCMS_ACCESS_TOKEN are required');
    const url = new URL(base);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
      throw new Error('PHCMS_API_URL must use HTTPS or loopback HTTP');
    }
  }

  private async request<T>(path: string, init?: RequestInit, timeoutMs = 10000): Promise<T> {
    const response = await this.fetcher(new URL(`${this.base.replace(/\/$/, '')}/${path}`, undefined), {
      ...init,
      headers: { authorization: `Bearer ${this.token}`, ...(init?.body != null ? { 'content-type': 'application/json' } : {}) },
      signal: this.signal ? AbortSignal.any([this.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      let code: string | undefined;
      try { code = rejectionCodes.get((await response.json())?.message); } catch { /* Non-JSON errors remain status-only. */ }
      throw new ProjectmanError(response.status, code);
    }
    return response.status === 204 ? undefined as T : response.json() as Promise<T>;
  }

  async list(type: string, parentUid?: string, filters?: Record<string, string | boolean>): Promise<ProjectmanContent[]> {
    const items: ProjectmanContent[] = [];
    for (let page = 1; page <= 100; page++) {
      const query = new URLSearchParams({ channelSlug: 'ph-projectman', type, withDetail: 'true', withParent: 'true', page: String(page), limit: '100' });
      if (parentUid) query.set('parentUid', parentUid);
      if (filters) query.set('attributeFilters', JSON.stringify(filters));
      const result = await this.request<Page>(`contents?${query}`);
      if (!Array.isArray(result.content) || typeof result.last !== 'boolean') throw new Error('Invalid PH-CMS page response');
      items.push(...result.content);
      if (result.last) return items;
    }
    throw new Error('Projectman result exceeds 100 pages; narrow the query');
  }

  async get(uid: string): Promise<ProjectmanContent> {
    const query = new URLSearchParams({ channelSlug: 'ph-projectman', uids: uid, withDetail: 'true', withParent: 'true' });
    const result = await this.request<Page>(`contents?${query}`);
    const item = result.content.find(content => content.uid === uid);
    if (!item || !['task', 'subtask', 'project', 'workspace'].includes(item.type)) throw new Error('Projectman item not found (HTTP 404)');
    return item;
  }

  async previewIntake(plan: IntakePlan): Promise<IntakePreview> {
    return this.request('projectman/intakes/preview', { method: 'POST', body: JSON.stringify(plan) }, 60000);
  }

  async getWorkflow(uid: string) {
    return this.request<any>(`projectman/items/${encodeURIComponent(uid)}/workflow`);
  }

  async reviewPreflight(uid: string, expectedRevision: number, summary: string) {
    if (!summary?.trim() || summary.length > 8000) throw new Error('Preflight review summary required (1–8000 characters)');
    const [item, task] = await Promise.all([this.get(uid), this.getWorkflow(uid)]);
    const state = item.detail?.attributes.state;
    if (state !== 'todo' || task.state !== state || task.workflow?.grant || task.workflow?.review?.pending || !task.workflow?.specHash || task.workflow.revision !== expectedRevision) throw new Error('PH-CMS request failed (HTTP 409): Unapproved delegation required');
    const s8Preflight = { status: 'reviewed', specHash: task.workflow.specHash, fingerprint: preflightFingerprint(item, task.workflow), summary: summary.trim() };
    // Generic content updates require the observed state; the server checks it again under the workflow row lock.
    await this.request(`contents/${encodeURIComponent(uid)}`, { method: 'PUT', body: JSON.stringify({ attributes: { state, s8Preflight } }) });
    const [saved, fresh] = await Promise.all([this.get(uid), this.getWorkflow(uid)]);
    const savedPreflight = saved.detail?.attributes.s8Preflight as typeof s8Preflight | undefined;
    if (saved.detail?.attributes.state !== state || fresh.state !== state || fresh.workflow?.grant || fresh.workflow?.review?.pending || fresh.workflow?.revision !== expectedRevision || !hasReviewedPreflight(saved, fresh.workflow) || savedPreflight?.fingerprint !== s8Preflight.fingerprint || savedPreflight?.summary !== s8Preflight.summary) throw new Error('PH-CMS request failed (HTTP 409): Preflight changed while saving');
    return { uid, state: 'todo', preflight: s8Preflight };
  }

  async capabilities() {
    return this.request<{ workflowVersion: 2; safeResourceDelete?: boolean; cascadeResourceDelete?: boolean; humanDecisions: boolean; atomicClaims: boolean; idempotentReports: boolean; actorType?: string }>('projectman/capabilities');
  }

  async workflow(uid: string, operation: Record<string, unknown>) {
    return this.request<any>(`projectman/items/${encodeURIComponent(uid)}/workflow`, { method: 'POST', body: JSON.stringify(operation) });
  }

  async registerIntake(plan: IntakePlan, hash: string): Promise<IntakeResult> {
    return this.request('projectman/intakes', { method: 'POST', body: JSON.stringify({ plan, hash }) }, 60000);
  }

  async getIntake(requestId: string, rootUid?: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) throw new Error('UUID requestId required');
    if (rootUid) {
      const item = await this.get(rootUid); // Normal channel/read policy applies, including other authorized request authors.
      const intake = item.detail?.attributes.intake as Record<string, unknown> | undefined;
      if (intake?.requestId !== requestId || intake.root !== true) throw new Error('Intake root does not match requestId');
      return { uid: rootUid, ...intake };
    }
    return this.request(`projectman/intakes/${requestId}`);
  }

  async create(parentUid: string | undefined, type: 'workspace' | 'project' | 'task' | 'subtask', title: string, text: string, tags: string[] = [], repoPath?: string) {
    if (type === 'workspace') throw new Error('Agents cannot create workspaces; select an existing workspace UID');
    if (!parentUid) throw new Error('Workspace is a root; other content requires a parent UID');
    if (type === 'project' && (!repoPath || !repoPath.startsWith('/'))) throw new Error('New projects require an absolute repoPath');
    return this.request<ProjectmanContent>('contents', { method: 'POST', body: JSON.stringify({
      channelSlug: 'ph-projectman', parentUid, type, title, text, tags, status: 'published',
      attributes: ['task', 'subtask'].includes(type) ? { state: 'todo', autorun: false } : type === 'project' ? { repoPath } : {},
    }) });
  }

  // Human console entry point; the agent-facing create() keeps its workspace restriction.
  async createWorkspace(title: string, text: string) {
    return this.request<ProjectmanContent>('contents', { method: 'POST', body: JSON.stringify({ channelSlug: 'ph-projectman', type: 'workspace', title, text, status: 'published', attributes: {} }) });
  }

  async editResource(uid: string, title: string, text: string) {
    await this.get(uid); // Resolve in the Projectman channel, never an arbitrary content UID.
    return this.request<ProjectmanContent>(`contents/${encodeURIComponent(uid)}`, { method: 'PUT', body: JSON.stringify({ title, text }) });
  }

  async deleteResource(uid: string) {
    // The dedicated endpoint enforces channel scope and atomically deletes the resource tree.
    return this.request<{ uid: string; deletedUids: string[]; deletedCount: number; retainedLogCount: number }>(`projectman/items/${encodeURIComponent(uid)}/tree`, { method: 'DELETE' }, 60000);
  }

  async bindProject(uid: string, repoPath: string) {
    const item = await this.get(uid);
    if (item.type !== 'project' || !repoPath.startsWith('/')) throw new Error('Project UID and absolute repoPath required');
    return this.request<ProjectmanContent>(`contents/${encodeURIComponent(uid)}`, { method: 'PUT', body: JSON.stringify({ attributes: { repoPath } }) });
  }

  async schedule(uid: string, scheduledAt: string | null) {
    if (scheduledAt !== null && (!/(Z|[+-]\d{2}:\d{2})$/i.test(scheduledAt) || !Number.isFinite(Date.parse(scheduledAt)))) throw new Error('scheduledAt requires ISO date/time with explicit timezone');
    const item = await this.get(uid);
    const state = item.detail?.attributes.state;
    if (!['task', 'subtask'].includes(item.type) || !['todo', 'ready'].includes(String(state))) throw new Error('Only unstarted tasks can be scheduled');
    return this.request<ProjectmanContent>(`contents/${encodeURIComponent(uid)}`, { method: 'PUT', body: JSON.stringify({ attributes: { state, scheduledAt: scheduledAt === null ? null : new Date(scheduledAt).toISOString() } }) });
  }

  async resume(uid: string) {
    const item = await this.get(uid);
    if (item.type !== 'task') throw new Error('Resume requires a task UID');
    const subtasks = await this.list('subtask', uid);
    return { item, subtasks, logs: await this.list('work_log', uid),
      subtaskLogs: await Promise.all(subtasks.map(async subtask => ({ uid: subtask.uid, logs: await this.list('work_log', subtask.uid) }))) };
  }
}

export function projectmanFromEnv(signal?: AbortSignal) {
  return new ProjectmanClient(process.env.PHCMS_API_URL ?? '', process.env.PHCMS_ACCESS_TOKEN ?? '', fetch, signal);
}
