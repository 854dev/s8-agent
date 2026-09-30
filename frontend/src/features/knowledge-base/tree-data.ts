import type { Entry } from './types'

export type TreeNode = Entry & {
  id: string
  children?: TreeNode[]
}

export type TreeCache = Map<string, Entry[]>

export function createTreeCache(): TreeCache {
  return new Map()
}

export function mergeTreeEntries(cache: TreeCache, parentPath: string, entries: Entry[]): TreeCache {
  const next = new Map(cache)
  const unique = new Map(entries.map((entry) => [entry.path, entry]))
  next.set(parentPath, [...unique.values()])
  return next
}

export function isTreePathLoaded(cache: TreeCache, parentPath: string) {
  return cache.has(parentPath)
}

function compareEntries(left: Entry, right: Entry) {
  if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1
  return left.name.localeCompare(right.name, 'ko')
}

export function treeNodesFor(cache: TreeCache, parentPath = ''): TreeNode[] {
  return (cache.get(parentPath) ?? []).slice().sort(compareEntries).map((entry) => ({
    ...entry,
    id: entry.path,
    children: entry.kind === 'directory' ? treeNodesFor(cache, entry.path) : undefined,
  }))
}
