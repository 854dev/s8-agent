import { useEffect, useState } from 'react'
import { fetchRecent, searchDocuments } from './api'
import type { Entry, SearchResult } from './types'

type KnowledgeBaseSearchProps = {
  onSelect: (path: string) => void
}

type SearchItem = Entry | SearchResult

function itemExcerpt(item: SearchItem) {
  return 'excerpt' in item ? item.excerpt : item.path
}

function itemPath(item: SearchItem) {
  return item.path.split('/').slice(-2).join('/')
}

export default function KnowledgeBaseSearch({ onSelect }: KnowledgeBaseSearchProps) {
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<SearchItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [recentOpen, setRecentOpen] = useState(false)
  const isSearching = Boolean(query.trim())

  useEffect(() => {
    let active = true
    setLoading(true)
    setError(false)

    if (!query.trim()) {
      fetchRecent(20)
        .then((response) => {
          if (active) setItems(response.results)
        })
        .catch(() => {
          if (active) setError(true)
        })
        .finally(() => {
          if (active) setLoading(false)
        })
      return () => {
        active = false
      }
    }

    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      searchDocuments(query.trim(), 50, controller.signal)
        .then((response) => {
          if (active) setItems(response.results)
        })
        .catch(() => {
          if (active && !controller.signal.aborted) setError(true)
        })
        .finally(() => {
          if (active) setLoading(false)
        })
    }, 275)

    return () => {
      active = false
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [query])

  const shouldShowResults = isSearching || recentOpen
  const heading = isSearching ? '검색 결과' : '최근 문서'

  return (
    <section className="kb-search" aria-label="문서 검색">
      <label htmlFor="knowledge-base-search">문서 검색</label>
      <input
        id="knowledge-base-search"
        placeholder="문서 검색"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="kb-search__heading">
        <span>{heading}</span>
        {!isSearching && (
          <button
            type="button"
            className="kb-search__toggle"
            aria-expanded={recentOpen}
            aria-controls="knowledge-base-recent"
            onClick={() => setRecentOpen((open) => !open)}
          >
            {recentOpen ? '접기' : `펼치기${items.length ? ` (${items.length})` : ''}`}
          </button>
        )}
        {loading && <span aria-label="검색 중">불러오는 중...</span>}
      </div>
      {error && <p role="alert">문서 목록을 불러오지 못했습니다.</p>}
      {shouldShowResults && !loading && !error && items.length === 0 && <p>문서가 없습니다.</p>}
      {shouldShowResults && !loading && !error && items.length > 0 && (
        <ul id={isSearching ? undefined : 'knowledge-base-recent'} className="kb-search__results">
          {items.map((item) => (
            <li key={item.path}>
              <button type="button" onClick={() => onSelect(item.path)} aria-label={item.name} title={item.path}>
                <strong>{item.name}</strong>
                <span>{isSearching ? itemExcerpt(item) : itemPath(item)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
