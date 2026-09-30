import { describe, expect, it } from 'vitest'
import {
  createTreeCache,
  isTreePathLoaded,
  mergeTreeEntries,
  treeNodesFor,
} from '../tree-data'
import type { Entry } from '../types'

const file = (path: string, name = path.split('/').at(-1) ?? path): Entry => ({
  name,
  path,
  kind: 'file',
})

const directory = (path: string, name = path.split('/').at(-1) ?? path): Entry => ({
  name,
  path,
  kind: 'directory',
})

describe('tree data', () => {
  it('creates an empty cache with the root marked as unloaded', () => {
    const cache = createTreeCache()

    expect(isTreePathLoaded(cache, '')).toBe(false)
    expect(treeNodesFor(cache)).toEqual([])
  })

  it('merges entries and sorts directories before files', () => {
    let cache = createTreeCache()
    cache = mergeTreeEntries(cache, '', [file('z.md'), directory('notes'), file('a.md')])

    expect(treeNodesFor(cache).map((node) => node.path)).toEqual(['notes', 'a.md', 'z.md'])
    expect(isTreePathLoaded(cache, '')).toBe(true)
  })

  it('keeps nested folder entries and does not duplicate a repeated merge', () => {
    let cache = createTreeCache()
    cache = mergeTreeEntries(cache, '', [directory('notes')])
    cache = mergeTreeEntries(cache, 'notes', [file('notes/readme.md')])
    cache = mergeTreeEntries(cache, 'notes', [file('notes/readme.md')])

    expect(treeNodesFor(cache)[0]?.children?.map((node) => node.path)).toEqual(['notes/readme.md'])
    expect(isTreePathLoaded(cache, 'notes')).toBe(true)
  })

  it('preserves other folder caches when one folder is refreshed', () => {
    let cache = createTreeCache()
    cache = mergeTreeEntries(cache, 'guides', [file('guides/one.md')])
    cache = mergeTreeEntries(cache, 'notes', [file('notes/one.md')])
    cache = mergeTreeEntries(cache, 'guides', [file('guides/two.md')])

    expect(treeNodesFor(cache, 'notes').map((node) => node.path)).toEqual(['notes/one.md'])
    expect(treeNodesFor(cache, 'guides').map((node) => node.path)).toEqual(['guides/two.md'])
  })
})
