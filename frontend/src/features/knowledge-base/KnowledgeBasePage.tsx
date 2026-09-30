import { useEffect, useState } from 'react'
import { fetchHealth, fetchTree } from './api'
import { buildKnowledgeBaseUrl, getAppBaseUrl, getSelectedDocumentPath } from '../../app-route'
import DocumentReader from './DocumentReader'
import FileTree from './FileTree'
import KnowledgeBaseSearch from './KnowledgeBaseSearch'
import { createTreeCache, isTreePathLoaded, mergeTreeEntries, treeNodesFor, type TreeCache } from './tree-data'
import './knowledge-base.css'

type KnowledgeBasePageProps = {
  onNavigateDashboard?: () => void
  onNavigateUpload?: () => void
}

type MobileView = 'list' | 'reader'

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(false)

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const media = window.matchMedia('(max-width: 768px)')
    const update = () => setIsMobile(media.matches)
    update()
    media.addEventListener?.('change', update)
    return () => media.removeEventListener?.('change', update)
  }, [])

  return isMobile
}

export default function KnowledgeBasePage({ onNavigateDashboard, onNavigateUpload }: KnowledgeBasePageProps) {
  const [cache, setCache] = useState<TreeCache>(() => createTreeCache())
  const [treeLoading, setTreeLoading] = useState(true)
  const [treeError, setTreeError] = useState(false)
  const [health, setHealth] = useState<'loading' | 'ready' | 'error'>('loading')
  const [selectedPath, setSelectedPath] = useState(() => getSelectedDocumentPath(window.location.search))
  const [mobileView, setMobileView] = useState<MobileView>(() => (
    getSelectedDocumentPath(window.location.search) ? 'reader' : 'list'
  ))
  const isMobile = useIsMobile()

  useEffect(() => {
    let active = true
    fetchHealth()
      .then(() => {
        if (active) setHealth('ready')
      })
      .catch(() => {
        if (active) setHealth('error')
      })

    fetchTree('', 0)
      .then((response) => {
        if (active) setCache((current) => mergeTreeEntries(current, '', response.entries))
      })
      .catch(() => {
        if (active) setTreeError(true)
      })
      .finally(() => {
        if (active) setTreeLoading(false)
      })

    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    const handlePopState = () => {
      const path = getSelectedDocumentPath(window.location.search)
      setSelectedPath(path)
      if (isMobile) setMobileView(path ? 'reader' : 'list')
    }
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [isMobile])

  const selectDocument = (path: string) => {
    const baseUrl = getAppBaseUrl(import.meta.env.BASE_URL)
    window.history.replaceState({}, '', buildKnowledgeBaseUrl(baseUrl, path))
    setSelectedPath(path)
    if (isMobile) setMobileView('reader')
  }

  const goToList = () => {
    const baseUrl = getAppBaseUrl(import.meta.env.BASE_URL)
    window.history.replaceState({}, '', buildKnowledgeBaseUrl(baseUrl))
    setSelectedPath(null)
    setMobileView('list')
  }

  const loadFolder = async (path: string) => {
    if (isTreePathLoaded(cache, path)) return
    try {
      const response = await fetchTree(path, 0)
      setCache((current) => mergeTreeEntries(current, path, response.entries))
    } catch {
      setTreeError(true)
    }
  }

  const showSidebar = !isMobile || mobileView === 'list'
  const showReader = !isMobile || mobileView === 'reader'

  return (
    <main className="kb-page">
      <header className="kb-page__header">
        <div>
          <p className="kb-page__eyebrow">854_md / knowledge base</p>
          <h1>지식베이스 브라우저</h1>
        </div>
        <div className="kb-page__actions">
          <span className={`kb-status kb-status--${health}`}>
            {health === 'ready' ? 'API 연결됨' : health === 'error' ? 'API 연결 실패' : '연결 확인 중'}
          </span>
          {onNavigateDashboard && (
            <button type="button" onClick={onNavigateDashboard}>대시보드</button>
          )}
          {onNavigateUpload && (
            <button type="button" onClick={onNavigateUpload} className="kb-upload-btn">파일 업로드</button>
          )}
        </div>
      </header>
      <div className="kb-page__body">
        {showSidebar && (
          <aside className="kb-page__sidebar">
            <KnowledgeBaseSearch onSelect={selectDocument} />
            <section className="kb-tree-panel" aria-label="파일 탐색">
              <div className="kb-tree-panel__heading">
                <h2>파일</h2>
                {treeLoading && <span>불러오는 중...</span>}
              </div>
              {treeError && <p role="alert">파일 목록을 불러오지 못했습니다.</p>}
              {!treeLoading && !treeError && (
                <FileTree
                  nodes={treeNodesFor(cache)}
                  onToggle={loadFolder}
                  onSelect={selectDocument}
                />
              )}
            </section>
          </aside>
        )}
        {showReader && (
          <div className="kb-page__reader">
            <DocumentReader path={selectedPath} onBack={isMobile ? goToList : undefined} />
          </div>
        )}
      </div>
    </main>
  )
}
