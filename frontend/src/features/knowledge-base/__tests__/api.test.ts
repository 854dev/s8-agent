import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fetchDocument,
  fetchHealth,
  fetchRecent,
  fetchTree,
  searchDocuments,
} from '../api'

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  }
}

describe('knowledge base api', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  it('fetches a tree with encoded path and depth', async () => {
    const body = { root: 'docs/guides', entries: [] }
    fetchMock.mockResolvedValue(jsonResponse(body))

    await expect(fetchTree('docs/guides', 0)).resolves.toEqual(body)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/docs/tree?path=docs%2Fguides&depth=0',
      undefined,
    )
  })

  it('fetches a document with an encoded relative path', async () => {
    const body = { path: 'docs/notes/README.md', content: '# Notes' }
    fetchMock.mockResolvedValue(jsonResponse(body))

    await expect(fetchDocument('docs/notes/README.md')).resolves.toEqual(body)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/docs/file?path=docs%2Fnotes%2FREADME.md',
      undefined,
    )
  })

  it('fetches search, recent, and health responses', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ query: 'Pi', results: [] }))
      .mockResolvedValueOnce(jsonResponse({ results: [] }))
      .mockResolvedValueOnce(jsonResponse({ status: 'ok', service: '854md-kb-browser' }))

    await expect(searchDocuments('Pi', 10)).resolves.toEqual({ query: 'Pi', results: [] })
    await expect(fetchRecent(20)).resolves.toEqual({ results: [] })
    await expect(fetchHealth()).resolves.toEqual({ status: 'ok', service: '854md-kb-browser' })

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/docs/search?q=Pi&limit=10',
      '/api/docs/recent?limit=20',
      '/api/docs/health',
    ])
  })

  it('throws an api error for non-success responses', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'file is unavailable' }, 403))

    await expect(fetchDocument('SECRET/hidden.md')).rejects.toMatchObject({ status: 403 })
  })
})
