import { useCallback, useEffect, useRef, useState } from 'react'
import { ConsoleError, createRequestId, list, request, type Detail, type Item } from './api'
import ResourceForm, { type ResourceEditor } from './ResourceForm'
import './projectman.css'

const labels: Record<string, string> = { todo: '일 시작 전', ready: '실행 대기', doing: '실행 중', blocked: '대기', review: '결과 검토', done: '완료', canceled: '취소' }
export function responsibleRole(item: Item) {
  const workflow = item.detail?.attributes.workflow, state = item.detail?.attributes.state
  if (workflow?.review?.pending) return workflow.review.audience === 'manager' ? 'manager' : 'human'
  if (state === 'blocked') return 'manager'
  if (state === 'review') return workflow?.managerReview ? 'human' : 'manager'
  if (state === 'todo') return item.detail?.attributes.s8Preflight?.status === 'reviewed' && item.detail.attributes.s8Preflight.specHash === workflow?.specHash ? 'human' : 'manager'
  return workflow?.spec ? 'developer' : 'manager'
}
export function reviewLabel(detail: Detail) {
  const workflow = detail.execution?.workflow, review = workflow?.review
  if (detail.execution?.state === 'canceled') return '취소됨'
  if (detail.execution?.state === 'done') return '완료'
  if (review?.pending) return review.draft ? '답변 작성 중' : review.audience === 'manager' ? '매니저 확인 대기' : '인간 결정 대기'
  if (review?.resumedRunId) return '재개됨'
  if (review?.decision === 'resume') return detail.execution.state === 'ready' ? '결정 확정 · 재개 대기' : '재개 불가 · 작업 상태 확인'
  if (review?.decision === 'reject') return '거절됨'
  if (review?.decision === 'cancel') return '취소됨'
  return labels[detail.execution?.state] ?? '위임 전'
}

export default function ProjectmanPage() {
  const [authenticated, setAuthenticated] = useState(false), [checking, setChecking] = useState(true)
  const [sessionUnavailable, setSessionUnavailable] = useState(false), [sessionAttempt, setSessionAttempt] = useState(0)
  const [email, setEmail] = useState(''), [password, setPassword] = useState('')
  const [items, setItems] = useState<Item[]>([]), [projects, setProjects] = useState<Item[]>([]), [workspaces, setWorkspaces] = useState<Item[]>([])
  const [workspace, setWorkspace] = useState(new URLSearchParams(location.search).get('workspace') ?? ''), [humanOnly, setHumanOnly] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [editor, setEditor] = useState<ResourceEditor | null>(null)
  const resourceForm = useRef<HTMLDivElement>(null)
  useEffect(() => { if (editor) resourceForm.current?.scrollIntoView?.({ block: 'start' }) }, [editor])
  const createResource = (type: string, parentUid?: string) => { setError(''); setNotice(''); setEditor({ mode: 'create', item: { uid: '', type, title: '', ...(parentUid ? { parent: { uid: parentUid } } : {}) } }) }
  const editResource = (item: Item, mode: 'edit' | 'delete') => { setError(''); setNotice(''); setEditor({ mode, item }) }
  const detailPanel = useRef<HTMLElement>(null)
  const lastTaskButton = useRef<HTMLButtonElement | null>(null)
  const [uid, setUid] = useState(new URLSearchParams(location.search).get('task') ?? '')
  const [selectedRun, setSelectedRun] = useState(new URLSearchParams(location.search).get('run') ?? '')
  const [detail, setDetail] = useState<Detail | null>(null), [answer, setAnswer] = useState(''), [confirmedRevision, setConfirmedRevision] = useState<number | null>(null), [answerRevision, setAnswerRevision] = useState<number | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [events, setEvents] = useState<unknown[]>([]), [offset, setOffset] = useState<number | null>(0)
  const pending = useRef<{ uid: string; operation: Record<string, unknown> } | null>(null)
  const selectedTask = useRef(uid)
  selectedTask.current = uid
  const eventCursor = useRef<number | undefined>(undefined)
  const eventSelection = useRef('')
  eventSelection.current = `${uid}:${selectedRun || detail?.execution?.workflow?.run?.id || ''}`
  const fail = useCallback((cause: unknown) => { if (cause instanceof ConsoleError && cause.status === 401 && cause.code !== 'SESSION_RENEWED') { setAuthenticated(false); setEditor(null) } setError(cause instanceof Error ? cause.message : '연결에 실패했습니다.') }, [])
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const [tasks, children, ws, ps] = await Promise.all([list('task', '', signal), list('subtask', '', signal), list('workspace', '', signal), list('project', '', signal)])
    if (!signal?.aborted) { setItems([...tasks.items, ...children.items]); setWorkspaces(ws.items); setProjects(ps.items); setLoaded(true) }
  }, [])
  const refreshDetail = useCallback(async (signal?: AbortSignal) => {
    if (!uid) return
    const data = await request<Detail>(`/items/${encodeURIComponent(uid)}`, { signal })
    if (!signal?.aborted && selectedTask.current === uid) setDetail(data)
  }, [uid])
  useEffect(() => {
    const controller = new AbortController()
    setChecking(true); setSessionUnavailable(false); setError('')
    request('/session', { signal: controller.signal })
      .then(() => { if (!controller.signal.aborted) setAuthenticated(true) })
      .catch(cause => {
        if (controller.signal.aborted) return
        if (cause instanceof ConsoleError && cause.status === 401) setAuthenticated(false)
        else { setSessionUnavailable(true); fail(cause) }
      })
      .finally(() => { if (!controller.signal.aborted) setChecking(false) })
    return () => controller.abort()
  }, [fail, sessionAttempt])
  useEffect(() => {
    if (!authenticated) return
    const controller = new AbortController()
    const load = () => Promise.all([refresh(controller.signal), refreshDetail(controller.signal)]).catch(cause => { if (!controller.signal.aborted) fail(cause) })
    void load(); const timer = setInterval(() => { void load() }, 5000)
    return () => { controller.abort(); clearInterval(timer) }
  }, [authenticated, refresh, refreshDetail, fail])
  useEffect(() => { setAnswer(detail?.execution?.workflow?.review?.draft ?? ''); setConfirmedRevision(null); setAnswerRevision(null) }, [detail?.item.uid, detail?.execution?.workflow?.review?.id])
  useEffect(() => { setEvents([]); setOffset(0); eventCursor.current = undefined }, [uid, selectedRun, detail?.execution?.workflow?.run?.id])
  useEffect(() => { const update = () => { const query = new URLSearchParams(location.search), nextUid = query.get('task') ?? ''; if (selectedTask.current !== nextUid) { setDetail(null); pending.current = null } setUid(nextUid); setSelectedRun(query.get('run') ?? ''); setWorkspace(query.get('workspace') ?? ''); setHumanOnly(false) }; window.addEventListener('popstate', update); return () => window.removeEventListener('popstate', update) }, [])
  useEffect(() => { if (detail?.item.uid === uid) detailPanel.current?.scrollIntoView?.({ behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ? 'auto' : 'smooth', block: 'start' }) }, [detail?.item.uid, uid])
  const select = (next: string, button?: HTMLButtonElement) => { if (button) lastTaskButton.current = button; setUid(next); setSelectedRun(''); setDetail(null); setEvents([]); setOffset(0); setError(''); setNotice(''); pending.current = null; const url = new URL(location.href); url.searchParams.set('task', next); url.searchParams.delete('run'); history.pushState(null, '', url) }
  const closeDetail = () => { selectedTask.current = ''; setUid(''); setDetail(null); pending.current = null; const url = new URL(location.href); url.searchParams.delete('task'); url.searchParams.delete('run'); history.pushState(null, '', url); lastTaskButton.current?.focus() }
  const selectWorkspace = (next: string) => { closeDetail(); setWorkspace(next); setHumanOnly(false); const url = new URL(location.href); if (next) url.searchParams.set('workspace', next); else url.searchParams.delete('workspace'); history.replaceState(null, '', url) }
  async function mutate(operation: Record<string, unknown>) {
    if (!detail?.execution.workflow) return
    setBusy(true); setError(''); setNotice('')
    const revision = ['draft', 'decide'].includes(String(operation.action)) ? answerRevision ?? detail.execution.workflow.revision : confirmedRevision ?? detail.execution.workflow.revision
    const saved = pending.current ?? { uid, operation: { ...operation, expectedRevision: revision, requestId: createRequestId() } }
    pending.current = saved
    try {
      await request(`/items/${encodeURIComponent(saved.uid)}/workflow`, { method: 'POST', body: JSON.stringify(saved.operation) })
      pending.current = null; setAnswerRevision(null); setConfirmedRevision(null); setNotice('Projectman에 저장했습니다. 실제 실행 시작 여부는 상태에서 확인하세요.'); await refreshDetail(); await refresh()
    } catch (cause) { if (cause instanceof ConsoleError && cause.status === 409) pending.current = null; fail(cause) }
    finally { setBusy(false) }
  }
  async function loadEvents(runId: string) {
    setBusy(true)
    const selection = eventSelection.current
    const query = new URLSearchParams({ offset: String(offset ?? 0), ...(eventCursor.current === undefined ? {} : { cursor: String(eventCursor.current) }) })
    try { const page = await request<{ events: unknown[]; nextOffset: number | null; nextCursor?: number | null }>(`/runs/${runId}/events?${query}`); if (eventSelection.current === selection) { setEvents(previous => [...previous, ...page.events]); setOffset(page.nextOffset); eventCursor.current = page.nextCursor ?? undefined } } catch (cause) { fail(cause) } finally { setBusy(false) }
  }
  const itemById = new Map(items.map(item => [item.uid, item]))
  const projectOf = (item: Item): string | undefined => item.type === 'subtask' ? itemById.get(item.parent?.uid ?? '')?.parent?.uid : item.parent?.uid
  const scopedProjects = projects.filter(item => !workspace || item.parent?.uid === workspace)
  const projectIds = new Set(scopedProjects.map(item => item.uid))
  const scopedItems = items.filter(item => !workspace || projectIds.has(projectOf(item) ?? ''))
  const needsHuman = (item: Item) => item.detail?.attributes.workflow?.review?.pending && item.detail.attributes.workflow.review.audience === 'human'
  const waiting = scopedItems.filter(needsHuman).length
  const shown = scopedItems.filter(item => !humanOnly || needsHuman(item))
  const groups = scopedProjects.map(item => ({ uid: item.uid, title: item.title, items: shown.filter(task => projectOf(task) === item.uid) }))
  const unassigned = shown.filter(item => !projectIds.has(projectOf(item) ?? ''))
  if (unassigned.length) groups.push({ uid: 'unassigned', title: '미분류 작업', items: unassigned })
  const workspaceTitle = workspaces.find(item => item.uid === workspace)?.title ?? (workspace ? '워크스페이스를 찾을 수 없습니다.' : '전체 워크스페이스')
  const workflow = detail?.execution?.workflow, review = workflow?.review
  const confirmed = confirmedRevision !== null && confirmedRevision === workflow?.revision
  const runId = selectedRun || workflow?.run?.id
  const runs = [...new Set([...(detail?.logs ?? []).map(log => log.detail?.attributes.result?.workflow?.run?.id).filter((id): id is string => Boolean(id)), ...(workflow?.run?.id ? [workflow.run.id] : [])])]
  return <main className={`pm-page ${authenticated ? 'pm-page--console' : ''}`}>
    <header className="pm-header"><div><h1>작업과 결정</h1><p>프로젝트 진행 상황과 검토가 필요한 작업을 확인하세요.</p></div>{authenticated && <button onClick={() => { void request('/logout', { method: 'POST' }).then(() => { setAuthenticated(false); setItems([]); setDetail(null); setEditor(null) }).catch(fail) }}>로그아웃</button>}</header>
    {error && <div role="alert" className="pm-error">{error}{pending.current && <button disabled={busy} onClick={() => { void mutate(pending.current!.operation) }}>같은 요청 확인·재시도</button>}</div>}
    {notice && <p role="status" className="pm-notice">{notice}</p>}
    {checking ? <p>사용자 세션 확인 중…</p> : sessionUnavailable ? <section className="pm-login"><h2>콘솔에 연결할 수 없습니다.</h2><p>Projectman 콘솔 서버와 PH-CMS가 실행 중인지 확인하세요.</p><button onClick={() => setSessionAttempt(value => value + 1)}>연결 다시 시도</button></section> : !authenticated ? <form className="pm-login" onSubmit={event => { event.preventDefault(); setBusy(true); setError(''); void request('/login', { method: 'POST', body: JSON.stringify({ email, password }) }).then(() => { setPassword(''); setAuthenticated(true) }).catch(fail).finally(() => setBusy(false)) }}><h2>PH-CMS 사용자 로그인</h2><p>사람의 결정은 사용자 계정으로 기록합니다.</p><label>이메일<input autoComplete="username" type="email" required value={email} onChange={event => setEmail(event.target.value)} /></label><label>비밀번호<input autoComplete="current-password" type="password" required value={password} onChange={event => setPassword(event.target.value)} /></label><button className="pm-primary" disabled={busy}>로그인</button></form> : <>
      <div className="pm-actions pm-resource-actions"><button disabled={busy} onClick={() => createResource('workspace')}>워크스페이스 만들기</button></div>
      {editor && <div ref={resourceForm}><ResourceForm key={`${editor.mode}:${editor.item.type}:${editor.item.uid}:${editor.item.parent?.uid}`} editor={editor} onClose={() => setEditor(null)} onError={fail} onSaved={async (deleted, deletedUids = []) => {
        setEditor(null); setError(''); setNotice(deleted ? '목록에서 삭제했습니다. 데이터와 작업 로그는 보존됩니다.' : '저장했습니다.')
        if (deleted && (selectedTask.current === editor.item.uid || deletedUids.includes(selectedTask.current))) closeDetail()
        if (deleted && editor.item.type === 'workspace' && workspace === editor.item.uid) selectWorkspace('')
        await refresh(); if (!deleted && selectedTask.current === editor.item.uid) await refreshDetail()
      }} /></div>}
      <div className="pm-workspace-layout">
        <nav className="pm-workspaces" aria-label="워크스페이스">
          <h2>워크스페이스</h2>
          <button aria-pressed={!workspace} onClick={() => selectWorkspace('')}>전체 보기<span>{projects.length}개 프로젝트</span></button>
          {workspaces.map(item => <button key={item.uid} aria-pressed={workspace === item.uid} onClick={() => selectWorkspace(item.uid)}>{item.title}<span>{projects.filter(project => project.parent?.uid === item.uid).length}개 프로젝트</span></button>)}
          {loaded && !workspaces.length && <p className="pm-hint">등록된 워크스페이스가 없습니다.</p>}
        </nav>
        <div className="pm-workspace-content">
          <div className="pm-board-heading"><div><h2>{workspaceTitle}</h2><p>{scopedProjects.length}개 프로젝트 · {scopedItems.length}개 작업</p></div><button onClick={() => { setError(''); void Promise.all([refresh(), refreshDetail()]).catch(fail) }}>새로고침</button></div>
          {workspace && workspaces.find(item => item.uid === workspace) && <section aria-label="워크스페이스 관리"><p className="pm-text">{workspaces.find(item => item.uid === workspace)?.detail?.text}</p><div className="pm-actions pm-resource-actions"><button disabled={busy} onClick={() => createResource('project', workspace)}>프로젝트 만들기</button><button disabled={busy} onClick={() => editResource(workspaces.find(item => item.uid === workspace)!, 'edit')}>워크스페이스 수정</button><button disabled={busy} className="pm-danger" onClick={() => editResource(workspaces.find(item => item.uid === workspace)!, 'delete')}>워크스페이스 삭제</button></div></section>}
          <div className="pm-stats"><button className="pm-human-filter" aria-pressed={humanOnly} onClick={() => setHumanOnly(value => !value)}><strong>{waiting}</strong><span>인간 결정 대기</span><small>{humanOnly ? '전체 작업 보기' : '대기 요청만 보기'}</small></button><div><strong>{scopedItems.filter(item => item.detail?.attributes.state === 'doing').length}</strong><span>실행 중</span></div><div><strong>{scopedItems.filter(item => item.detail?.attributes.state === 'review').length}</strong><span>결과 검토</span></div></div>
          {groups.length > 1 && <nav className="pm-project-jumps" aria-label="프로젝트 바로가기">{groups.map(group => <a key={group.uid} href={`#project-${group.uid}`}>{group.title}<span>{group.items.length}</span></a>)}</nav>}
          <div className="pm-projects" aria-label="프로젝트별 작업 보드">
            {!loaded ? <p className="pm-empty">워크스페이스를 불러오는 중…</p> : !groups.length ? <p className="pm-empty">{humanOnly ? '인간 결정 대기 중인 작업이 없습니다.' : '표시할 프로젝트나 작업이 없습니다.'}</p> : groups.map(group => <section key={group.uid} className="pm-project" id={`project-${group.uid}`} aria-label={group.title}>
              <header><h3>{group.title}</h3><span>{group.items.length}개 작업</span>{projects.find(item => item.uid === group.uid) && <div className="pm-actions"><button disabled={busy} onClick={() => createResource('task', group.uid)}>작업 만들기</button><button disabled={busy} onClick={() => editResource(projects.find(item => item.uid === group.uid)!, 'edit')}>프로젝트 수정</button><button disabled={busy} className="pm-danger" onClick={() => editResource(projects.find(item => item.uid === group.uid)!, 'delete')}>프로젝트 삭제</button></div>}</header>
              {projects.find(item => item.uid === group.uid)?.detail?.text && <p className="pm-project-text pm-text">{projects.find(item => item.uid === group.uid)?.detail?.text}</p>}
              <div className="pm-status-board">{Object.entries(labels).map(([state, label]) => {
                const tasks = group.items.filter(item => (item.detail?.attributes.state ?? 'todo') === state)
                return <section className={`pm-lane pm-lane--${state}`} aria-label={`${group.title} · ${label}`} key={state}><h4>{label}<span>{tasks.length}</span></h4><div className="pm-lane-tasks">{tasks.length ? tasks.map(item => <button className={`pm-task ${uid === item.uid ? 'selected' : ''}`} key={item.uid} onClick={event => select(item.uid, event.currentTarget)}><strong>{item.title}</strong>{item.detail?.attributes.workflow?.review?.pending && <span className="pm-question-badge">{needsHuman(item) ? '인간 결정 필요' : '매니저 확인 필요'}</span>}<small>{item.type === 'subtask' ? `하위 작업 · ${itemById.get(item.parent?.uid ?? '')?.title ?? ''}` : ({ manager: '매니저', developer: '개발 에이전트', human: '사람' }[responsibleRole(item)])}</small></button>) : <p className="pm-lane-empty">—</p>}</div></section>
              })}</div>
            </section>)}
          </div>
        </div>
      </div>
      {uid && <div className="pm-layout"><article aria-label="작업 상세" ref={detailPanel}><div className="pm-detail-toolbar"><h2>작업 상세</h2><button onClick={closeDetail}>보드로 돌아가기</button></div>{!detail ? <p className="pm-empty">작업을 불러오는 중…</p> : <>
        <div className="pm-detail-head"><span className="pm-status">{reviewLabel(detail)}</span><h2>{detail.item.title}</h2><small>{detail.item.uid} · 버전 {workflow?.revision ?? 0}</small></div>
        <div className="pm-actions pm-resource-actions">{detail.item.type === 'task' && <button disabled={busy} onClick={() => createResource('subtask', detail.item.uid)}>하위 작업 만들기</button>}<button disabled={busy || Boolean(workflow)} onClick={() => editResource(detail.item, 'edit')}>작업 수정</button><button disabled={busy} className="pm-danger" onClick={() => editResource(detail.item, 'delete')}>작업 삭제</button></div>
        <section><h3>원래 요청</h3><p className="pm-text">{detail.item.detail?.text || '등록된 요청 본문이 없습니다.'}</p></section>
        {detail.execution.state === 'todo' && <section><h3>일 시작 전 · 매니저 검토</h3><p>요구사항의 누락·충돌·의문은 매니저가 먼저 확인하고 사용자 답변을 작업에 반영합니다. 최종 승인 후에는 개발 에이전트가 범위 안에서 스스로 결정하며 진행합니다.</p>{detail.execution.preflightReviewed ? <><p>매니저 사전 검토 완료 · 최종 승인 대기</p><p className="pm-text">{detail.item.detail?.attributes.s8Preflight?.summary}</p></> : <p>매니저 사전 검토가 끝나야 최종 승인할 수 있습니다.</p>}</section>}
        {workflow?.spec && <section><h3>실행 계획과 완료 조건</h3><ul>{workflow.spec.completionCriteria.map((value, i) => <li key={i}>{value}</li>)}</ul><dl><dt>저장소</dt><dd>{workflow.spec.repoPath}</dd><dt>실행 계획</dt><dd className="pm-text">{workflow.spec.plan}</dd><dt>계획 버전</dt><dd>{workflow.planVersion} · {workflow.planHash}</dd><dt>대화·결정 근거</dt><dd>{workflow.spec.decisionRefs.join(', ')}</dd><dt>명령</dt><dd>{workflow.spec.commandNames.join(', ') || '없음'}</dd><dt>선행 작업</dt><dd>{workflow.spec.dependsOn.join(', ') || '없음'}</dd></dl>{!workflow.grant && detail.execution.state === 'todo' && detail.execution.preflightReviewed && <><label className="pm-check"><input type="checkbox" checked={confirmed} onChange={event => setConfirmedRevision(event.target.checked ? workflow.revision : null)} />매니저와 논의한 최종 계획을 확인하고 이 버전으로 실행을 요청합니다.</label><button disabled={busy || !confirmed} className="pm-primary" onClick={() => { void mutate({ action: 'authorize', planHash: workflow.planHash, message: '사람과 매니저의 논의를 반영한 최종 계획을 확인하고 실행을 요청합니다.' }) }}>최종 계획 확정 · 실행</button></>}</section>}
        {review && <section className="pm-review" id={`review-${review.id}`}><h3>{review.pending ? review.audience === 'manager' ? '매니저가 확인할 내용' : '사람이 결정할 내용' : '기록된 결정'}</h3><small><a href={`?task=${detail.item.uid}#review-${review.id}`}>검토 {review.id}</a> · {review.audience === 'manager' ? '매니저 사실 확인' : '인간 결정'}</small><h4>{review.question}</h4><p>{review.reason}</p>{review.options?.length ? <ul>{review.options.map((option, i) => <li key={i}>{option}</li>)}</ul> : null}{review.impact && <p><b>영향</b> {review.impact}</p>}{review.recommendation && <p><b>권고안</b> {review.recommendation}</p>}{review.pending && review.audience === 'manager' ? <p>매니저가 근거를 확인해 답변하거나 인간 검토로 전달합니다.</p> : review.pending ? <><label htmlFor="pm-human-answer">내 답변</label><textarea id="pm-human-answer" rows={4} value={answer} onChange={event => { setAnswer(event.target.value); setAnswerRevision(previous => previous ?? workflow?.revision ?? null) }} /><p className="pm-hint">저장은 실행하지 않습니다. 확정한 답변은 매니저의 후속 지시를 거쳐 재개됩니다.</p><label className="pm-check"><input type="checkbox" checked={confirmed} onChange={event => setConfirmedRevision(event.target.checked ? workflow.revision : null)} />답변과 승인 범위를 확인했습니다.</label><div className="pm-actions"><button disabled={busy} onClick={() => { void mutate({ action: 'draft', reviewId: review.id, answer }) }}>답변 저장</button><button className="pm-primary" disabled={busy || !answer.trim() || !confirmed} onClick={() => { void mutate({ action: 'decide', reviewId: review.id, decision: 'resume', answer }) }}>답변 확정 · 재개 요청</button><button disabled={busy || !answer.trim() || !confirmed} onClick={() => { void mutate({ action: 'decide', reviewId: review.id, decision: 'reject', answer }) }}>거절</button><button disabled={busy || !answer.trim() || !confirmed} onClick={() => { void mutate({ action: 'decide', reviewId: review.id, decision: 'cancel', answer }) }}>취소</button></div></> : <><p className="pm-text">{review.answer}</p><small>결정자 {review.actorUid}</small>{review.resumedRunId && <p>재개 실행: {review.resumedRunId}</p>}</>}</section>}
        {workflow?.result && <section><h3>개발 결과와 검증</h3><p className="pm-text">{workflow.result.summary}</p><p>변경: {workflow.result.changedFiles.join(', ') || '없음'}</p>{(['remainingItems', 'decisions', 'executionErrors'] as const).map(key => workflow.result?.[key]?.length ? <div key={key}><h4>{({ remainingItems: '미완료 항목', decisions: '개발자의 판단과 근거', executionErrors: '실행 장애' })[key]}</h4><ul>{workflow.result[key]!.map((text, i) => <li key={i}>{text}</li>)}</ul></div> : null)}{workflow.result.checkpoint && <p className="pm-text">체크포인트: {workflow.result.checkpoint}</p>}{workflow.result.budgetExhausted && <p>실행 예산 소진 · 미완료 결과를 보존했습니다.</p>}{workflow.confirmation && workflow.grant && detail.execution.state === 'blocked' && !workflow.review?.pending && !workflow.result.budgetExhausted && <button disabled={busy} onClick={() => { void mutate({ action: 'retry', message: '실행 장애를 확인했습니다. 확정된 계획으로 이어서 실행합니다.' }) }}>같은 계획으로 재개</button>}<ul>{workflow.result.verification.map((check, i) => <li key={i}><b>{check.ok ? '통과' : '실패'} · {check.name}</b><pre>{check.summary}</pre></li>)}</ul>{workflow.managerReview && <p><b>매니저 검토</b> {workflow.managerReview.message}</p>}{detail.execution.state === 'review' && workflow.managerReview && <button disabled={busy} onClick={() => { void mutate({ action: 'complete', message: '사용자가 결과·검증과 매니저 검토를 확인하고 완료했습니다.' }) }}>결과 확인 · 작업 완료</button>}</section>}
        {workflow?.run && <section><h3>실행 기록</h3><p>{workflow.run.status}</p><label>실행 선택<select value={runId} onChange={event => { setSelectedRun(event.target.value); const url = new URL(location.href); url.searchParams.set('run', event.target.value); history.pushState(null, '', url) }}>{runs.map(id => <option key={id} value={id}>{id}</option>)}</select></label><a href={`/api/projectman/runs/${runId}/patch`}>검토용 변경 패치 다운로드</a><p className="pm-hint">전달 프롬프트·공개 응답·도구 실행을 페이지 단위로 확인합니다.</p><button disabled={busy || offset === null} onClick={() => { void loadEvents(runId!) }}>{events.length ? '기록 더 보기' : '실행 기록 보기'}</button>{events.map((event, i) => <details key={i}><summary>기록 {i + 1}</summary><pre>{JSON.stringify(event, null, 2)}</pre></details>)}</section>}
        <section><h3>작업 이력</h3>{detail.logs.length ? detail.logs.map(log => <details key={log.uid}><summary>{log.title}</summary><p className="pm-text">{log.detail?.text}</p>{log.detail?.attributes.result?.workflow?.review && <dl><dt>질문</dt><dd>{log.detail.attributes.result.workflow.review.question}</dd><dt>이유</dt><dd>{log.detail.attributes.result.workflow.review.reason}</dd><dt>결정</dt><dd>{log.detail.attributes.result.workflow.review.answer || '미확정'}</dd><dt>검토 ID</dt><dd>{log.detail.attributes.result.workflow.review.id}</dd></dl>}</details>) : <p>기록된 이력이 없습니다.</p>}</section>
      </>}</article></div>}
    </>}
  </main>
}
