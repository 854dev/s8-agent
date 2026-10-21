export type Review = { id: string; pending: boolean; audience: string; question: string; reason: string; options?: string[]; impact?: string; recommendation?: string; draft?: string; decision?: string; answer?: string; actorUid?: string; resumedRunId?: string }
export type Workflow = { version: 2; revision: number; planHash: string; planVersion: number; confirmation?: { actorUid: string; planHash: string; planVersion: number; message: string }; assignment?: { assignee: string | null }; specHash: string; spec?: { repoPath: string; plan: string; decisionRefs: string[]; commandNames: string[]; completionCriteria: string[]; dependsOn: string[] }; grant?: { actorUid: string }; run?: { id: string; status: string; startedAt: string; workerId?: string }; review?: Review; followup?: { reviewId: string; message: string }; result?: { remainingItems?: string[]; decisions?: string[]; executionErrors?: string[]; checkpoint?: string; summary: string; changedFiles: string[]; verification: { name: string; ok: boolean; summary: string }[] }; managerReview?: { message: string } }
export type Item = { uid: string; type: string; title: string; parent?: { uid: string }; detail?: { text?: string; attributes: { state?: string; s8Preflight?: { status: string; specHash: string; summary: string }; workflow?: Workflow; result?: { workflow?: Workflow } } } }
export type WorkerMode = 'active' | 'passive' | 'paused'
export type ResidentWorker = { id: string; mode: WorkerMode; configMode: WorkerMode; overridden: boolean; running: boolean; connected?: boolean; nodeId?: string; heartbeatAt?: string; metrics?: { pending: number; failures: number; lastLatencyMs: number | null; lastError: string | null } | null; research?: { requestId: string; target?: string; recovering?: boolean; timedOut?: boolean } | null; current: { uid: string; source: string; startedAt: string; runId?: string; claimed?: boolean } | null; queue: string[]; lastError: { uid: string; message: string; at: string } | null }
export type Detail = { item: Item; execution: { state: string; preflightReviewed?: boolean; workflow: Workflow | null }; logs: Item[] }
export class ConsoleError extends Error { status: number; code?: string; constructor(status: number, message: string, code?: string) { super(message); this.status = status; this.code = code } }
// Tailscale HTTP origins do not provide crypto.randomUUID (secure contexts only).
export function createRequestId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
export async function request<T>(endpoint: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/projectman${endpoint}`, { credentials: 'same-origin', ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } })
  let data: unknown
  try { data = await response.json() } catch {
    throw new ConsoleError(response.ok ? 502 : response.status, 'Projectman API 응답을 확인할 수 없습니다. 콘솔 서버와 PH-CMS 실행 상태를 확인하고 다시 시도하세요.')
  }
  if (!response.ok) {
    const message = data && typeof data === 'object' && 'error' in data && typeof data.error === 'string' ? data.error : `Projectman 요청에 실패했습니다. (HTTP ${response.status})`
    const code = data && typeof data === 'object' && 'code' in data && typeof data.code === 'string' ? data.code : undefined
    throw new ConsoleError(response.status, message, code)
  }
  if (!data || typeof data !== 'object') throw new ConsoleError(502, 'Projectman API 응답 형식이 올바르지 않습니다.')
  return data as T
}
export const list = (type: string, parentUid = '', signal?: AbortSignal) => request<{ items: Item[] }>(`/items?${new URLSearchParams({ type, ...(parentUid ? { parentUid } : {}) })}`, { signal })
