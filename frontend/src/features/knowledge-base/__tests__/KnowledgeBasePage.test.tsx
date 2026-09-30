import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import KnowledgeBasePage from '../KnowledgeBasePage'

function response(body: unknown) {
  return { ok: true, status: 200, json: vi.fn().mockResolvedValue(body) }
}

afterEach(() => {
  window.history.replaceState({}, '', '/')
})

describe('KnowledgeBasePage', () => {
  it('loads the tree and restores a document from the URL', async () => {
    window.history.replaceState({}, '', '/s8/knowledge-base?path=docs%2Fguides%2Fguide.md')
    const fetchMock = vi.fn((url: string) => {
      if (url.includes('/health')) return Promise.resolve(response({ status: 'ok', service: '854md-kb-browser' }))
      if (url.includes('/tree')) {
        return Promise.resolve(response({
          root: '',
          entries: [
            { name: 'guides', path: 'docs/guides', kind: 'directory' },
            { name: 'README.md', path: 'README.md', kind: 'file' },
          ],
        }))
      }
      if (url.includes('/recent')) return Promise.resolve(response({ results: [] }))
      return Promise.resolve(response({
        path: 'docs/guides/guide.md',
        content: '# Guide',
        size: 6,
        mtime: '2026-08-11T10:00:00.000Z',
      }))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<KnowledgeBasePage />)

    expect(await screen.findByRole('heading', { name: 'guide.md' })).toBeInTheDocument()
    expect(screen.getByText('guides')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Guide' })).toBeInTheDocument()
  })

  it('loads folder entries before showing them on the first click', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.includes('/health')) return Promise.resolve(response({ status: 'ok', service: '854md-kb-browser' }))
      if (url.includes('path=docs%2Fguides')) {
        return Promise.resolve(response({
          root: 'docs/guides',
          entries: [{ name: 'first-guide.md', path: 'docs/guides/first-guide.md', kind: 'file' }],
        }))
      }
      if (url.includes('/tree')) {
        return Promise.resolve(response({
          root: '',
          entries: [{ name: 'guides', path: 'docs/guides', kind: 'directory' }],
        }))
      }
      if (url.includes('/recent')) return Promise.resolve(response({ results: [] }))
      return Promise.resolve(response({ path: 'README.md', content: '# Readme', size: 8, mtime: '2026-08-11T10:00:00.000Z' }))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<KnowledgeBasePage />)
    fireEvent.click(await screen.findByRole('treeitem', { name: /guides/ }))

    expect(await screen.findByText('first-guide.md')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('path=docs%2Fguides'), undefined)
  })
})
