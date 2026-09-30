import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import KnowledgeBaseSearch from '../KnowledgeBaseSearch'

function response(body: unknown) {
  return { ok: true, status: 200, json: vi.fn().mockResolvedValue(body) }
}

describe('KnowledgeBaseSearch', () => {
  it('loads recent documents into a collapsed panel', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({
      results: [{ name: 'README.md', path: 'docs/notes/README.md', kind: 'file' }],
    }))
    vi.stubGlobal('fetch', fetchMock)

    render(<KnowledgeBaseSearch onSelect={vi.fn()} />)

    expect(await screen.findByRole('button', { name: '펼치기 (1)' })).toBeInTheDocument()
    expect(screen.queryByText('README.md')).not.toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith('/api/docs/recent?limit=20', undefined)

    fireEvent.click(screen.getByRole('button', { name: '펼치기 (1)' }))

    expect(await screen.findByText('README.md')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '접기' })).toHaveAttribute('aria-expanded', 'true')
  })

  it('searches after typing and selects a result', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ results: [] }))
      .mockResolvedValueOnce(response({
        query: 'guide',
        results: [{ name: 'guide.md', path: 'docs/guides/guide.md', kind: 'file', excerpt: 'Guide', matches: 1 }],
      }))
    vi.stubGlobal('fetch', fetchMock)
    const onSelect = vi.fn()

    render(<KnowledgeBaseSearch onSelect={onSelect} />)
    const input = screen.getByPlaceholderText('문서 검색')
    fireEvent.change(input, { target: { value: 'guide' } })

    expect(await screen.findByText('guide.md', {}, { timeout: 1000 })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /guide\.md/ }))

    await waitFor(() => expect(onSelect).toHaveBeenCalledWith('docs/guides/guide.md'))
    expect(fetchMock).toHaveBeenCalledWith('/api/docs/search?q=guide&limit=50', expect.anything())
  })
})
