import { lazy, Suspense } from 'react'
import { getAppBaseUrl, getAppView } from './app-route'
import KnowledgeBasePage from './features/knowledge-base/KnowledgeBasePage'
import UploadPage from './features/upload/UploadPage'
import ProjectmanPage from './features/projectman/ProjectmanPage'
import './App.css'
const TerminalPage = lazy(() => import('./features/terminal/TerminalPage'))

export default function App() {
  const base = getAppBaseUrl(import.meta.env.BASE_URL), view = getAppView(location.pathname, base)
  const links = [
    { label: 'Projectman', href: base, view: 'dashboard' },
    { label: '지식베이스', href: `${base}knowledge-base`, view: 'knowledge-base' },
    { label: '업로드', href: `${base}upload`, view: 'upload' },
    { label: '터미널', href: `${base}terminal`, view: 'terminal' },
  ]
  return <><nav aria-label="S8 메뉴" className="s8-nav"><a className="s8-brand" href={base} aria-label="S8 홈">S8<span>Workspace</span></a><div className="s8-nav-links">{links.map(link => <a key={link.view} href={link.href} aria-current={view === link.view ? 'page' : undefined}>{link.label}</a>)}</div></nav>{view === 'knowledge-base' ? <KnowledgeBasePage /> : view === 'upload' ? <UploadPage /> : view === 'terminal' ? <Suspense fallback={<p>터미널 불러오는 중…</p>}><TerminalPage onBack={() => location.assign(base)} /></Suspense> : <ProjectmanPage />}</>
}
