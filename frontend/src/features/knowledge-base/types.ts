export type EntryKind = 'file' | 'directory'

export type Entry = {
  name: string
  path: string
  kind: EntryKind
  size?: number
  mtime?: string
}

export type TreeResponse = {
  root: string
  entries: Entry[]
}

export type DocumentResponse = {
  path: string
  content: string
  size: number
  mtime: string
}

export type SearchResult = Entry & {
  matches: number
  excerpt: string
}

export type SearchResponse = {
  query: string
  results: SearchResult[]
}

export type RecentResponse = {
  results: Entry[]
}

export type HealthResponse = {
  status: string
  service: string
}

export class ApiError extends Error {
  readonly status: number

  constructor(status: number) {
    super(`Knowledge base API request failed with status ${status}`)
    this.name = 'ApiError'
    this.status = status
  }
}
