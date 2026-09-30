import { ApiError, type DocumentResponse, type HealthResponse, type RecentResponse, type SearchResponse, type TreeResponse } from './types'

const API_BASE = '/api/docs'

type RequestSignal = AbortSignal | undefined

async function requestJson<T>(path: string, signal?: RequestSignal): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, signal ? { signal } : undefined)
  if (!response.ok) throw new ApiError(response.status)
  return response.json() as Promise<T>
}

export function fetchTree(path = '', depth = 0, signal?: RequestSignal) {
  const query = new URLSearchParams({ path, depth: String(depth) })
  return requestJson<TreeResponse>(`/tree?${query.toString()}`, signal)
}

export function fetchDocument(path: string, signal?: RequestSignal) {
  const query = new URLSearchParams({ path })
  return requestJson<DocumentResponse>(`/file?${query.toString()}`, signal)
}

export function searchDocuments(query: string, limit = 50, signal?: RequestSignal) {
  const params = new URLSearchParams({ q: query, limit: String(limit) })
  return requestJson<SearchResponse>(`/search?${params.toString()}`, signal)
}

export function fetchRecent(limit = 20, signal?: RequestSignal) {
  const params = new URLSearchParams({ limit: String(limit) })
  return requestJson<RecentResponse>(`/recent?${params.toString()}`, signal)
}

export function fetchHealth(signal?: RequestSignal) {
  return requestJson<HealthResponse>('/health', signal)
}
