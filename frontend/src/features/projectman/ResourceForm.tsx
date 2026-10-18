import { useState } from 'react'
import { ConsoleError, request, type Item } from './api'

export type ResourceEditor = { mode: 'create' | 'edit' | 'delete'; item: Item }
const names: Record<string, string> = { workspace: '워크스페이스', project: '프로젝트', task: '작업', subtask: '하위 작업' }
export default function ResourceForm({ editor, onSaved, onClose, onError }: { editor: ResourceEditor; onSaved: (deleted: boolean, deletedUids?: string[]) => Promise<void>; onClose: () => void; onError: (cause: unknown) => void }) {
  const { mode, item } = editor
  const [title, setTitle] = useState(item.title)
  const [text, setText] = useState(item.detail?.text ?? '')
  const [repoPath, setRepoPath] = useState('')
  const [busy, setBusy] = useState(false)
  const label = `${names[item.type]} ${mode === 'create' ? '만들기' : mode === 'edit' ? '수정' : '삭제'}`
  return <form className="pm-resource-form" aria-label={label} onSubmit={event => {
    event.preventDefault(); if (busy) return; setBusy(true)
    const endpoint = mode === 'create' ? '/items' : `/items/${encodeURIComponent(item.uid)}${mode === 'delete' ? '?cascade=true' : ''}`
    const payload = mode === 'delete' ? undefined : mode === 'edit' ? { title, text } : { type: item.type, title, text, ...(item.parent ? { parentUid: item.parent.uid } : {}), ...(item.type === 'project' ? { repoPath } : {}) }
    void request<{ deletedUids?: string[] }>(endpoint, { method: mode === 'create' ? 'POST' : mode === 'edit' ? 'PATCH' : 'DELETE', ...(payload ? { body: JSON.stringify(payload) } : {}) }).then(result => onSaved(mode === 'delete', result.deletedUids)).catch(cause => onError(cause instanceof ConsoleError && (cause.status < 500 || cause.code) ? cause : new Error('저장 결과를 확인하지 못했습니다. 목록을 새로고침해 반영 여부를 확인한 뒤 재시도하세요. 중복 생성에 주의하세요.'))).finally(() => setBusy(false))
  }}>
    <h2>{label}</h2>
    {mode === 'delete' ? <><p>「{item.title}」과 모든 하위 자원을 목록에서 삭제합니다. 실행 중·종료 미확인 작업이나 범위 밖 미완료 작업의 선행 참조가 있으면 전체 삭제를 차단합니다. 원본 데이터와 작업 로그는 보존하며 화면에서 복원하는 기능은 없습니다.</p></> : <><label>제목<input autoFocus required maxLength={200} value={title} onChange={event => setTitle(event.target.value)} /></label><label>본문<textarea rows={4} maxLength={50000} value={text} onChange={event => setText(event.target.value)} /></label>{mode === 'create' && item.type === 'project' && <label>저장소 절대 경로<input required placeholder="/Users/…/project" value={repoPath} onChange={event => setRepoPath(event.target.value)} /></label>}{['task', 'subtask'].includes(item.type) && <p className="pm-hint">새 작업은 실행되지 않는 일 시작 전 상태로 등록합니다. 위임된 작업의 제목·본문 수정은 서버에서 제한됩니다.</p>}</>}
    <div className="pm-actions"><button className={mode === 'delete' ? 'pm-danger' : 'pm-primary'} disabled={busy || (mode !== 'delete' && !title.trim())}>{busy ? '저장 중…' : mode === 'delete' ? '삭제 확정' : '저장'}</button><button type="button" disabled={busy} onClick={onClose}>닫기</button></div>
  </form>
}
