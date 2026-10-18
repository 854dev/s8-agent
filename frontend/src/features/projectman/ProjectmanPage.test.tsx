import { render, screen, waitFor, cleanup, act, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, test, vi } from 'vitest'
import ProjectmanPage, { reviewLabel, responsibleRole } from './ProjectmanPage'
import type { Detail } from './api'

afterEach(() => { cleanup(); vi.unstubAllGlobals(); history.replaceState(null, '', '/') })
function fixture() {
  const workflow = { version: 2 as const, revision: 4, planVersion: 1, planHash: 'a'.repeat(64), specHash: 'a'.repeat(64), spec: { repoPath: '/tmp/repo', plan: 'Implement and verify the counter', decisionRefs: ['conversation:final-plan'], commandNames: ['test'], completionCriteria: ['counter works'], dependsOn: [] }, review: { id: 'review-1', pending: true, audience: 'human', question: '음수를 허용할까요?', reason: '요구사항이 없습니다.', options: ['허용', '금지'], draft: '' } }
  const item = { uid: 'task-1', title: '카운터 구현', type: 'task', detail: { text: 'React Vite 카운터', attributes: { state: 'blocked', workflow } } }
  const detail: Detail = { item, execution: { state: 'blocked', workflow }, logs: [] }
  const operations: Record<string, unknown>[] = []
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    let data: unknown = { authenticated: true }
    if (url.includes('/items?')) data = { items: url.includes('type=task') ? [item] : [] }
    else if (url.endsWith('/items/task-1')) data = detail
    else if (url.endsWith('/workflow')) {
      const operation = JSON.parse(String(init?.body)); operations.push(operation)
      if (operation.action === 'draft') { workflow.review.draft = operation.answer; workflow.revision++ }
      else { workflow.review.pending = false; Object.assign(workflow.review, { decision: 'resume', answer: operation.answer }); detail.execution.state = 'ready'; workflow.revision++ }
      data = detail.execution
    }
    return { ok: true, status: 200, json: async () => structuredClone(data) }
  })
  vi.stubGlobal('fetch', fetcher); history.replaceState(null, '', '/s8/?task=task-1')
  return { operations, detail, fetcher }
}

test.each([false, true])('event pagination supports legacy and cursor APIs (cursor=%s)', async useCursor => {
  const f = fixture(), urls: string[] = []
  f.detail.execution.workflow!.run = { id: '11111111-1111-4111-8111-111111111111', status: 'finished', startedAt: '2026-10-16' }
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/events?')) {
      urls.push(url)
      return Response.json({ events: [{ page: urls.length }], nextOffset: urls.length === 1 ? 1 : null, ...(useCursor ? { nextCursor: urls.length === 1 ? 77 : null } : {}) })
    }
    return f.fetcher(url, init)
  }))
  const user = userEvent.setup(); render(<ProjectmanPage />)
  await user.click(await screen.findByRole('button', { name: '실행 기록 보기' }))
  await user.click(await screen.findByRole('button', { name: '기록 더 보기' }))
  await waitFor(() => expect(urls).toHaveLength(2))
  const query = new URL(urls[1], location.origin).searchParams
  expect(query.get('offset')).toBe('1'); expect(query.get('cursor')).toBe(useCursor ? '77' : null)
  await waitFor(() => expect(screen.getByRole('button', { name: '기록 더 보기' })).toBeDisabled())
})

test('a renewed approval session preserves the same request ID for an explicit retry', async () => {
  const f = fixture(), operations: Record<string, unknown>[] = []
  f.detail.execution.state = 'todo'; f.detail.execution.preflightReviewed = true
  delete f.detail.execution.workflow!.review
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/workflow')) {
      operations.push(JSON.parse(String(init?.body)))
      if (operations.length === 1) return Response.json({ code: 'SESSION_RENEWED', error: '세션 갱신 · 같은 요청으로 다시 시도하세요.' }, { status: 401 })
      return Response.json({ state: 'ready' })
    }
    return f.fetcher(url, init)
  }))
  const user = userEvent.setup(); render(<ProjectmanPage />)
  await user.click(await screen.findByRole('checkbox', { name: '매니저와 논의한 최종 계획을 확인하고 이 버전으로 실행을 요청합니다.' }))
  await user.click(screen.getByRole('button', { name: '최종 계획 확정 · 실행' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('세션 갱신')
  expect(operations).toHaveLength(1)
  await user.click(screen.getByRole('button', { name: '같은 요청 확인·재시도' }))
  await waitFor(() => expect(operations).toHaveLength(2))
  expect(operations[1].requestId).toBe(operations[0].requestId)
})

test('a console startup failure can be retried without losing a valid session', async () => {
  const fetcher = vi.fn(async () => new Response('<html>Bad Gateway</html>', { status: 502 }))
  vi.stubGlobal('fetch', fetcher)
  render(<ProjectmanPage />)
  expect(await screen.findByRole('heading', { name: '콘솔에 연결할 수 없습니다.' })).toBeInTheDocument()
  expect(screen.queryByLabelText('비밀번호')).not.toBeInTheDocument()
  fetcher.mockImplementation(async () => Response.json({ items: [], authenticated: true }))
  await userEvent.click(screen.getByRole('button', { name: '연결 다시 시도' }))
  expect(await screen.findByRole('button', { name: '로그아웃' })).toBeInTheDocument()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

test('shows the original request, question, reason, choices and scope before a human decision', async () => {
  fixture(); render(<ProjectmanPage />)
  expect(await screen.findByRole('heading', { name: '음수를 허용할까요?' })).toBeInTheDocument()
  expect(screen.getByText('React Vite 카운터')).toBeInTheDocument()
  expect(screen.getByText('요구사항이 없습니다.')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '답변 확정 · 재개 요청' })).not.toBeInTheDocument()
  expect(screen.getByText('/tmp/repo')).toBeInTheDocument()
})

test('legacy review results remain readable without resume controls', async () => {
  const f = fixture(); f.detail.execution.workflow!.run = { id: 'old-run', status: 'finished', startedAt: '2026-10-19' }; render(<ProjectmanPage />)
  expect(await screen.findByText('이전 검토 요청입니다. 필요한 변경은 새 work로 등록하세요.')).toBeInTheDocument()
  expect(screen.queryByRole('textbox', { name: '내 답변' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '답변 저장' })).not.toBeInTheDocument()
  expect(f.operations).toHaveLength(0)
})

test('labels resumed only after a run is bound to the decision, and cancellation takes precedence', () => {
  const { detail } = fixture(); detail.execution.workflow!.review!.pending = false; detail.execution.workflow!.review!.decision = 'resume'; detail.execution.state = 'ready'
  expect(reviewLabel(detail)).toBe('결정 확정 · 재개 대기')
  detail.execution.workflow!.review!.resumedRunId = 'run-2'; detail.execution.state = 'doing'; expect(reviewLabel(detail)).toBe('재개됨')
  detail.execution.state = 'canceled'; expect(reviewLabel(detail)).toBe('취소됨')
})

test('manager fact questions do not count as human decisions or expose human answer controls', async () => {
  const { detail } = fixture()
  detail.execution.workflow!.review!.audience = 'manager'
  render(<ProjectmanPage />)
  expect(await screen.findByRole('heading', { name: '매니저가 확인할 내용' })).toBeInTheDocument()
  expect(screen.queryByRole('textbox', { name: '내 답변' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '답변 확정 · 재개 요청' })).not.toBeInTheDocument()
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: /인간 결정 대기/ }))
  expect(screen.getByText('인간 결정 대기 중인 작업이 없습니다.')).toBeInTheDocument()
})


test('a delayed response from the previous task cannot replace the current task detail', async () => {
  const f = fixture()
  let release: (() => void) | undefined
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/items/task-1')) await new Promise<void>(resolve => { release = resolve })
    if (url.endsWith('/items/task-2')) {
      const next = structuredClone(f.detail); next.item.uid = 'task-2'; next.item.title = '두 번째 작업'
      return { ok: true, status: 200, json: async () => next }
    }
    return f.fetcher(url, init)
  }))
  render(<ProjectmanPage />)
  await waitFor(() => expect(release).toBeDefined())
  act(() => { history.pushState(null, '', '/s8/?task=task-2'); window.dispatchEvent(new PopStateEvent('popstate')) })
  expect(await screen.findByRole('heading', { name: '두 번째 작업' })).toBeInTheDocument()
  await act(async () => { release!(); await new Promise(resolve => setTimeout(resolve, 0)) })
  expect(screen.getByRole('heading', { name: '두 번째 작업' })).toBeInTheDocument()
  expect(screen.queryByRole('heading', { name: '카운터 구현' })).not.toBeInTheDocument()
})

test('run links survive refresh and browser navigation restores the selected historical run', async () => {
  const f = fixture()
  f.detail.execution.workflow!.run = { id: 'new-run', status: 'finished', startedAt: '2026-10-16' }
  f.detail.logs = [{ uid: 'log-old', type: 'work_log', title: 'Previous execution', detail: { attributes: { result: { workflow: { version: 2, revision: 2, planHash: 'old-plan', planVersion: 1, specHash: 'old-spec', run: { id: 'old-run', status: 'finished', startedAt: '2026-10-15' } } } } } }]
  history.replaceState(null, '', '/s8/?task=task-1&run=old-run')
  render(<ProjectmanPage />)
  const selector = await screen.findByRole('combobox', { name: '실행 선택' })
  expect(selector).toHaveValue('old-run')
  await userEvent.setup().selectOptions(selector, 'new-run')
  expect(new URLSearchParams(location.search).get('run')).toBe('new-run')
  act(() => { history.replaceState(null, '', '/s8/?task=task-1&run=old-run'); window.dispatchEvent(new PopStateEvent('popstate')) })
  await waitFor(() => expect(screen.getByRole('combobox', { name: '실행 선택' })).toHaveValue('old-run'))
})

function boardFixture() {
  const f = fixture()
  history.replaceState(null, '', '/s8/')
  const workspaces = [{ uid: 'ws-a', title: '팀 A', type: 'workspace' }, { uid: 'ws-b', title: '팀 B', type: 'workspace' }]
  const projects = [{ uid: 'pa', title: '웹 앱', type: 'project', parent: { uid: 'ws-a' } }, { uid: 'pb', title: '문서', type: 'project', parent: { uid: 'ws-a' } }, { uid: 'pc', title: '다른 팀 프로젝트', type: 'project', parent: { uid: 'ws-b' } }]
  const tasks = [
    { uid: 'ta', title: '카운터 화면', type: 'task', parent: { uid: 'pa' }, detail: { attributes: { state: 'doing' } } },
    { uid: 'tb', title: '음수 정책 결정', type: 'task', parent: { uid: 'pa' }, detail: { attributes: { state: 'blocked', workflow: f.detail.execution.workflow } } },
    { uid: 'tc', title: '다른 팀 작업', type: 'task', parent: { uid: 'pc' }, detail: { attributes: { state: 'done' } } },
  ]
  const children = [{ uid: 'sub-a', title: '접근성 보완', type: 'subtask', parent: { uid: 'ta' }, detail: { attributes: { state: 'ready' } } }]
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/items?')) {
      const type = new URL(url, location.origin).searchParams.get('type')
      return { ok: true, status: 200, json: async () => ({ items: (type === 'workspace' ? workspaces : type === 'project' ? projects : type === 'task' ? tasks : type === 'subtask' ? children : []) }) }
    }
    return f.fetcher(url, init)
  }))
  return f
}

test('one workspace click shows all its projects and tasks in status columns, including subtasks and empty projects', async () => {
  boardFixture(); const user = userEvent.setup(); render(<ProjectmanPage />)
  await user.click(await screen.findByRole('button', { name: /팀 A/ }))
  const board = screen.getByLabelText('프로젝트별 작업 보드')
  expect(within(board).getByRole('heading', { name: '웹 앱' })).toBeInTheDocument()
  expect(within(board).getByRole('heading', { name: '문서' })).toBeInTheDocument()
  expect(within(board).queryByText('다른 팀 프로젝트')).not.toBeInTheDocument()
  expect(within(board).queryByText('다른 팀 작업')).not.toBeInTheDocument()
  expect(within(screen.getByRole('region', { name: '웹 앱 · 실행 중' })).getByRole('button', { name: /카운터 화면/ })).toBeInTheDocument()
  expect(within(screen.getByRole('region', { name: '웹 앱 · 대기' })).getByRole('button', { name: /음수 정책 결정/ })).toBeInTheDocument()
  expect(within(screen.getByRole('region', { name: '웹 앱 · 실행 대기' })).getByRole('button', { name: /접근성 보완/ })).toBeInTheDocument()
  expect(screen.getByText('2개 프로젝트 · 3개 작업')).toBeInTheDocument()
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  expect(new URLSearchParams(location.search).get('workspace')).toBe('ws-a')
  await user.click(screen.getByRole('button', { name: /인간 결정 대기/ }))
  expect(within(board).getByRole('button', { name: /음수 정책 결정/ })).toBeInTheDocument()
  expect(within(board).queryByRole('button', { name: /카운터 화면/ })).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: /팀 B/ }))
  expect(within(board).getByRole('button', { name: /다른 팀 작업/ })).toBeInTheDocument()
  expect(within(board).queryByRole('button', { name: /음수 정책 결정/ })).not.toBeInTheDocument()
})

test('workspace links restore scope after refresh and browser navigation', async () => {
  boardFixture(); history.replaceState(null, '', '/s8/?workspace=ws-a'); render(<ProjectmanPage />)
  expect(await screen.findByRole('heading', { name: '팀 A' })).toBeInTheDocument()
  await waitFor(() => expect(screen.getByRole('button', { name: /팀 A/ })).toHaveAttribute('aria-pressed', 'true'))
  act(() => { history.pushState(null, '', '/s8/?workspace=ws-b'); window.dispatchEvent(new PopStateEvent('popstate')) })
  expect(await screen.findByRole('heading', { name: '팀 B' })).toBeInTheDocument()
  expect(within(screen.getByLabelText('프로젝트별 작업 보드')).queryByText('카운터 화면')).not.toBeInTheDocument()
})


test('creates a workspace and edits a selected workspace without sending managed attributes', async () => {
  const f = boardFixture(); const user = userEvent.setup(); render(<ProjectmanPage />)
  await user.click(await screen.findByRole('button', { name: '워크스페이스 만들기' }))
  let form = screen.getByRole('form', { name: '워크스페이스 만들기' })
  await user.type(within(form).getByLabelText('제목'), '새 팀')
  await user.type(within(form).getByLabelText('본문'), '팀 설명')
  await user.click(within(form).getByRole('button', { name: '저장' }))
  await waitFor(() => expect(screen.queryByRole('form')).not.toBeInTheDocument())
  const create = f.fetcher.mock.calls.find(([, init]) => init?.method === 'POST')!
  expect(JSON.parse(String(create[1]?.body))).toEqual({ type: 'workspace', title: '새 팀', text: '팀 설명' })
  await user.click(screen.getByRole('button', { name: /팀 A/ }))
  await user.click(screen.getByRole('button', { name: '워크스페이스 수정' }))
  form = screen.getByRole('form', { name: '워크스페이스 수정' })
  await user.clear(within(form).getByLabelText('제목')); await user.type(within(form).getByLabelText('제목'), '팀 A 수정')
  await user.click(within(form).getByRole('button', { name: '저장' }))
  await waitFor(() => expect(f.fetcher.mock.calls.some(([url, init]) => url.endsWith('/items/ws-a') && init?.method === 'PATCH')).toBe(true))
})

test('deletion needs no name input and clears the deleted workspace URL after success', async () => {
  const f = boardFixture(); const user = userEvent.setup(); render(<ProjectmanPage />)
  await user.click(await screen.findByRole('button', { name: /팀 B/ }))
  await user.click(screen.getByRole('button', { name: '워크스페이스 삭제' }))
  const form = screen.getByRole('form', { name: '워크스페이스 삭제' }), confirm = within(form).getByRole('button', { name: '삭제 확정' })
  expect(confirm).toBeEnabled()
  expect(within(form).queryByRole('textbox')).not.toBeInTheDocument()
  await user.click(confirm)
  await waitFor(() => expect(new URLSearchParams(location.search).has('workspace')).toBe(false))
  const call = f.fetcher.mock.calls.find(([, init]) => init?.method === 'DELETE')!
  expect(call[0]).toBe('/api/projectman/items/ws-b?cascade=true')
  expect(call[1]?.body).toBeUndefined()
})

test('a blocked task deletion keeps its detail and confirmation for inspection', async () => {
  const f = fixture(); const original = f.fetcher; const user = userEvent.setup()
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => init?.method === 'DELETE' ? Response.json({ error: '실행을 종료하세요.' }, { status: 409 }) : original(url, init)))
  render(<ProjectmanPage />)
  await user.click(await screen.findByRole('button', { name: '작업 삭제' }))
  const form = screen.getByRole('form', { name: '작업 삭제' })
  await user.click(within(form).getByRole('button', { name: '삭제 확정' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('실행을 종료하세요.')
  expect(screen.getByRole('heading', { name: '카운터 구현' })).toBeInTheDocument()
  expect(form).toBeInTheDocument()
})

test('deleting a project closes a selected descendant detail', async () => {
  const f = boardFixture(); history.replaceState(null, '', '/s8/?task=task-1')
  const original = globalThis.fetch
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => init?.method === 'DELETE' ? Response.json({ deleted: true, deletedUids: ['pa', f.detail.item.uid] }) : original(url, init)))
  const user = userEvent.setup(); render(<ProjectmanPage />)
  await screen.findByRole('heading', { name: '카운터 구현' })
  await user.click(within(screen.getByRole('region', { name: '웹 앱' })).getByRole('button', { name: '프로젝트 삭제' }))
  await user.click(within(screen.getByRole('form', { name: '프로젝트 삭제' })).getByRole('button', { name: '삭제 확정' }))
  await waitFor(() => expect(new URLSearchParams(location.search).has('task')).toBe(false))
  expect(screen.queryByRole('article', { name: '작업 상세' })).not.toBeInTheDocument()
})

test('an older server shows the cascade capability error without hiding it as an unknown write result', async () => {
  const f = fixture(), user = userEvent.setup()
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => init?.method === 'DELETE' ? Response.json({ code: 'CASCADE_DELETE_UNAVAILABLE', error: 'PH-CMS 하위 삭제 지원을 먼저 적용하세요.' }, { status: 503 }) : f.fetcher(url, init)))
  render(<ProjectmanPage />); await user.click(await screen.findByRole('button', { name: '작업 삭제' }))
  await user.click(within(screen.getByRole('form', { name: '작업 삭제' })).getByRole('button', { name: '삭제 확정' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('PH-CMS 하위 삭제 지원을 먼저 적용하세요.')
})

test('pre-start work belongs to manager and cannot be authorized before review', async () => {
  const { detail } = fixture()
  detail.execution.state = 'todo'
  detail.item.detail!.attributes.state = 'todo'
  delete detail.execution.workflow!.review
  expect(responsibleRole(detail.item)).toBe('manager')
  render(<ProjectmanPage />)
  expect(await screen.findByRole('heading', { name: '일 시작 전 · 매니저 검토' })).toBeInTheDocument()
  expect(screen.getByText('매니저 사전 검토가 끝나야 최종 승인할 수 있습니다.')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '최종 계획 확정 · 실행' })).not.toBeInTheDocument()
})

test('reviewed work displays resolved decisions and allows explicit final approval', async () => {
  const { detail, operations } = fixture()
  detail.execution.state = 'todo'
  detail.execution.preflightReviewed = true
  detail.item.detail!.attributes.state = 'todo'
  delete detail.execution.workflow!.review
  detail.execution.workflow!.version = 2
  detail.execution.workflow!.planHash = 'a'.repeat(64)
  detail.execution.workflow!.planVersion = 1
  detail.execution.workflow!.specHash = 'scope-1'
  detail.item.detail!.attributes.s8Preflight = { status: 'reviewed', specHash: 'scope-1', summary: '사용자 확정: 최솟값 0. 구현 방식은 개발자가 결정.' }
  expect(responsibleRole(detail.item)).toBe('human')
  render(<ProjectmanPage />)
  const button = await screen.findByRole('button', { name: '최종 계획 확정 · 실행' })
  expect(button).toBeDisabled()
  expect(screen.getByText('사용자 확정: 최솟값 0. 구현 방식은 개발자가 결정.')).toBeInTheDocument()
  const user = userEvent.setup()
  await user.click(screen.getByRole('checkbox', { name: '매니저와 논의한 최종 계획을 확인하고 이 버전으로 실행을 요청합니다.' }))
  await user.click(button)
  await waitFor(() => expect(operations[0]?.action).toBe('authorize'))
})

test('completion shows results and worker identity without approval or retry buttons', async () => {
  const f = fixture()
  f.detail.execution.state = 'done'; delete f.detail.execution.workflow!.review
  f.detail.execution.workflow!.run = { id: 'run-done', workerId: 'worker-2', status: 'finished', startedAt: '2026-10-19' }
  f.detail.execution.workflow!.result = { summary: '개발과 검증 완료', changedFiles: ['src/App.tsx'], verification: [{ name: 'test', ok: true, summary: 'passed' }] }
  render(<ProjectmanPage />)
  expect(await screen.findByText('개발과 검증 완료')).toBeInTheDocument()
  expect(screen.getByText('finished · 워커 worker-2')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '결과 확인 · 작업 완료' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '같은 계획으로 재개' })).not.toBeInTheDocument()
})

test('planning answers are saved before execution without reopening a completed work', async () => {
  const f = fixture(), user = userEvent.setup(); render(<ProjectmanPage />)
  await user.type(await screen.findByRole('textbox', { name: '내 답변' }), '최솟값은 0입니다.')
  await user.click(screen.getByRole('button', { name: '답변 저장' }))
  await waitFor(() => expect(f.operations).toHaveLength(1))
  expect(f.operations[0].action).toBe('draft')
  await user.click(screen.getByRole('checkbox', { name: '답변과 승인 범위를 확인했습니다.' }))
  await user.click(screen.getByRole('button', { name: '답변 확정 · 계획 반영' }))
  await waitFor(() => expect(f.operations).toHaveLength(2))
  expect(f.operations[1].action).toBe('decide')
})


test.each([false, true])('human completion requires a manager review (reviewed=%s)', async reviewed => {
  const f = fixture()
  f.detail.execution.state = 'review'; delete f.detail.execution.workflow!.review
  f.detail.execution.workflow!.result = { summary: '개발 보고 완료', changedFiles: [], verification: [] }
  if (reviewed) f.detail.execution.workflow!.managerReview = { message: '검증 근거를 확인했습니다.' }
  render(<ProjectmanPage />)
  await screen.findByText('개발 보고 완료')
  if (reviewed) {
    await userEvent.click(screen.getByRole('button', { name: '결과 확인 · 작업 완료' }))
    await waitFor(() => expect(f.operations[0]?.action).toBe('complete'))
  } else {
    expect(screen.getByText('매니저의 결과 검토를 기다리고 있습니다.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '결과 확인 · 작업 완료' })).not.toBeInTheDocument()
  }
})
