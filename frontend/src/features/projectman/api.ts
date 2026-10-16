export type Review = { id: string; pending: boolean; audience: string; question: string; reason: string; options?: string[]; impact?: string; recommendation?: string; draft?: string; decision?: string; answer?: string; actorUid?: string; resumedRunId?: string }
export type Workflow = { revision: number; spec?: { repoPath: string; allowedPaths: string[]; commandNames: string[]; completionCriteria: string[]; dependsOn: string[] }; grant?: { actorUid: string }; run?: { id: string; status: string; startedAt: string }; review?: Review; followup?: { reviewId: string; message: string }; result?: { summary: string; changedFiles: string[]; verification: { name: string; ok: boolean; summary: string }[] }; managerReview?: { message: string } }
export type Item = { uid: string; type: string; title: string; parent?: { uid: string }; detail?: { text?: string; attributes: { state?: string; workflow?: Workflow; result?: { workflow?: Workflow } } } }
export type Detail = { item: Item; execution: { state: string; workflow: Workflow | null }; logs: Item[] }
export class ConsoleError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status } }
export async function request<T>(endpoint: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/projectman${endpoint}`, { credentials: 'same-origin', ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } })
  const data = await response.json()
  if (!response.ok) throw new ConsoleError(response.status, data.error ?? '요청에 실패했습니다.')
  return data as T
}
export const list = (type: string, parentUid = '', signal?: AbortSignal) => request<{ items: Item[] }>(`/items?${new URLSearchParams({ type, ...(parentUid ? { parentUid } : {}) })}`, { signal })
