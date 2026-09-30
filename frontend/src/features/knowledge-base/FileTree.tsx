import { useState } from 'react'
import type { TreeNode } from './tree-data'

type FileTreeProps = {
  nodes: TreeNode[]
  onToggle: (path: string) => Promise<void>
  onSelect: (path: string) => void
}

type TreeBranchProps = {
  nodes: TreeNode[]
  depth: number
  openPaths: Set<string>
  onToggle: (path: string) => Promise<void>
  onSelect: (path: string) => void
  onOpenChange: (path: string, open: boolean) => void
}

function TreeBranch({ nodes, depth, openPaths, onToggle, onSelect, onOpenChange }: TreeBranchProps) {
  const openFolder = async (node: TreeNode) => {
    if (openPaths.has(node.path)) {
      onOpenChange(node.path, false)
      return
    }

    await onToggle(node.path)
    onOpenChange(node.path, true)
  }

  return (
    <ul className="kb-tree__branch" role={depth === 0 ? 'tree' : 'group'}>
      {nodes.map((node) => {
        const isFolder = node.kind === 'directory'
        const isOpen = openPaths.has(node.path)
        return (
          <li key={node.path} role="none">
            <button
              type="button"
              className="kb-tree__node"
              role="treeitem"
              aria-expanded={isFolder ? isOpen : undefined}
              style={{ paddingLeft: `${depth * 20 + 8}px` }}
              onClick={() => {
                if (isFolder) {
                  void openFolder(node)
                  return
                }
                onSelect(node.path)
              }}
            >
              <span aria-hidden="true">{isFolder ? (isOpen ? '▾' : '▸') : '·'}</span>
              <span>{node.name}</span>
            </button>
            {isFolder && isOpen && node.children && (
              <TreeBranch
                nodes={node.children}
                depth={depth + 1}
                openPaths={openPaths}
                onToggle={onToggle}
                onSelect={onSelect}
                onOpenChange={onOpenChange}
              />
            )}
          </li>
        )
      })}
    </ul>
  )
}

export default function FileTree({ nodes, onToggle, onSelect }: FileTreeProps) {
  const [openPaths, setOpenPaths] = useState<Set<string>>(() => new Set())

  const setFolderOpen = (path: string, open: boolean) => {
    setOpenPaths((current) => {
      const next = new Set(current)
      if (open) next.add(path)
      else next.delete(path)
      return next
    })
  }

  return (
    <nav className="kb-tree" aria-label="파일 트리">
      <TreeBranch
        nodes={nodes}
        depth={0}
        openPaths={openPaths}
        onToggle={onToggle}
        onSelect={onSelect}
        onOpenChange={setFolderOpen}
      />
    </nav>
  )
}
