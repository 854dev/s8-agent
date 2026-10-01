import { randomUUID } from 'node:crypto';

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

type Page = { content: ProjectmanContent[]; last: boolean };
type State = 'todo' | 'ready' | 'doing' | 'blocked' | 'review' | 'done' | 'canceled';

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

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.fetcher(new URL(`${this.base.replace(/\/$/, '')}/${path}`, undefined), {
      ...init,
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      signal: this.signal ? AbortSignal.any([this.signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`PH-CMS request failed (HTTP ${response.status})`);
    return response.json() as Promise<T>;
  }

  async list(type: string, parentUid?: string, filters?: Record<string, string | boolean>): Promise<ProjectmanContent[]> {
    const items: ProjectmanContent[] = [];
    for (let page = 1; page <= 100; page++) {
      const query = new URLSearchParams({ channelSlug: 'ph-projectman', type, withDetail: 'true', page: String(page), limit: '100' });
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
    if (!item || !['task', 'subtask', 'project', 'workspace'].includes(item.type)) throw new Error('Projectman item not found');
    return item;
  }

  async create(parentUid: string, type: 'task' | 'subtask', title: string, text: string, tags: string[] = [], phase?: string) {
    if (phase && (type !== 'subtask' || !['inspect', 'plan', 'implement', 'verify', 'review_blockers', 'report'].includes(phase))) {
      throw new Error('Invalid subtask phase');
    }
    return this.request<ProjectmanContent>('contents', { method: 'POST', body: JSON.stringify({
      channelSlug: 'ph-projectman', parentUid, type, title, text, tags, status: 'published',
      attributes: { state: 'todo', autorun: false, ...(type === 'subtask' ? { timeBudgetMinutes: 20 } : {}), ...(phase ? { phase } : {}) },
    }) });
  }

  async ensurePhases(taskUid: string) {
    const task = await this.get(taskUid);
    if (task.type !== 'task') throw new Error('Phase template requires a task UID');
    const phases = [
      ['inspect', '관련 문서와 코드 흐름 확인'], ['plan', '구현 계획 작성'],
      ['implement', '20분 이내 구현 단위'], ['verify', '테스트와 diff 확인'],
      ['review_blockers', '출시 차단 결함 확인'], ['report', '변경·검증 결과 보고'],
    ] as const;
    const existing = await this.list('subtask', taskUid);
    const created = [];
    // ponytail: single runner only; add server-side idempotent create if parallel agents need templates.
    for (const [phase, title] of phases) {
      if (existing.some(item => item.detail?.attributes.phase === phase)) continue;
      const subtask = await this.create(taskUid, 'subtask', title, `최대 20분(재시도 포함). 완료 또는 중단 시 결과를 work_log에 기록한다. 20분을 초과할 작업은 더 나눈다.`, [], phase);
      created.push(subtask.uid);
    }
    return { taskUid, created, existing: existing.length };
  }

  async transition(uid: string, expectedState: State, nextState: State, message: string, event: string, requestId: string = randomUUID()) {
    return this.request<{ uid: string; fromState: State; toState: State; workLogUid: string; requestId: string }>(
      `projectman/items/${encodeURIComponent(uid)}/transitions`,
      { method: 'POST', body: JSON.stringify({ requestId, expectedState, nextState, event, message }) },
    );
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
