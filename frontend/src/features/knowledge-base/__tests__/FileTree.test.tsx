import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import FileTree from '../FileTree'
import type { TreeNode } from '../tree-data'

const nodes: TreeNode[] = [
  { id: 'guides', name: 'guides', path: 'docs/guides', kind: 'directory', children: [] },
  { id: 'readme', name: 'README.md', path: 'README.md', kind: 'file' },
]

describe('FileTree', () => {
  it('renders folders and markdown files as a read-only tree', async () => {
    render(<FileTree nodes={nodes} onToggle={vi.fn()} onSelect={vi.fn()} />)

    expect(await screen.findByText('guides')).toBeInTheDocument()
    expect(screen.getByText('README.md')).toBeInTheDocument()
    expect(screen.queryByText(/rename|delete|upload/i)).not.toBeInTheDocument()
  })

  it('opens a folder on the first row click', async () => {
    const onToggle = vi.fn().mockResolvedValue(undefined)
    render(<FileTree nodes={nodes} onToggle={onToggle} onSelect={vi.fn()} />)

    fireEvent.click(await screen.findByText('guides'))

    await waitFor(() => expect(onToggle).toHaveBeenCalledTimes(1))
    expect(onToggle).toHaveBeenCalledWith('docs/guides')
  })
})
