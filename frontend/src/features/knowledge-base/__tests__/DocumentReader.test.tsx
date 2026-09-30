import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import DocumentReader from '../DocumentReader'

function documentResponse(content = '# Guide\n\n| A | B |\n| - | - |\n| 1 | 2 |') {
  return {
    path: 'docs/guides/guide.md',
    content,
    size: content.length,
    mtime: '2026-08-11T10:00:00.000Z',
  }
}

describe('DocumentReader', () => {
  it('shows an empty state when no document is selected', () => {
    render(<DocumentReader path={null} />)

    expect(screen.getByText('문서를 선택하세요')).toBeInTheDocument()
  })

  it('renders markdown content and document metadata', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue(documentResponse()),
    }))

    render(<DocumentReader path="docs/guides/guide.md" />)

    expect(await screen.findByRole('heading', { name: 'Guide' })).toBeInTheDocument()
    expect(screen.getByText('1')).toBeInTheDocument()
    expect(screen.getByText('docs/guides/guide.md')).toBeInTheDocument()
  })

  it('shows a recoverable error when the document cannot be loaded', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: vi.fn().mockResolvedValue({ error: 'file is unavailable' }),
    }))

    render(<DocumentReader path="SECRET/hidden.md" />)

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('문서를 불러오지 못했습니다'))
  })
})
