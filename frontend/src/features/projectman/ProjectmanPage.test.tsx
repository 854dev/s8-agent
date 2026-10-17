import { render, screen, waitFor, cleanup, act, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, test, vi } from 'vitest'
import ProjectmanPage, { reviewLabel, responsibleRole } from './ProjectmanPage'
import type { Detail } from './api'

afterEach(() => { cleanup(); vi.unstubAllGlobals(); history.replaceState(null, '', '/') })
function fixture() {
  const workflow = { revision: 4, spec: { repoPath: '/tmp/repo', allowedPaths: ['src'], commandNames: ['test'], completionCriteria: ['counter works'], dependsOn: [] }, review: { id: 'review-1', pending: true, audience: 'human', question: '음수를 허용할까요?', reason: '요구사항이 없습니다.', options: ['허용', '금지'], draft: '' } }
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
  expect(screen.getByRole('button', { name: '답변 확정 · 재개 요청' })).toBeDisabled()
  expect(screen.getByText('/tmp/repo')).toBeInTheDocument()
})

test('draft does not resume; explicit confirmation records a separate resume request', async () => {
  const f = fixture(); const user = userEvent.setup(); render(<ProjectmanPage />)
  const answer = await screen.findByRole('textbox', { name: '내 답변' })
  await user.type(answer, '음수를 허용합니다.')
  await user.click(screen.getByRole('button', { name: '답변 저장' }))
  await waitFor(() => expect(f.operations).toHaveLength(1))
  expect(f.operations[0].action).toBe('draft'); expect(f.detail.execution.state).toBe('blocked')
  await user.click(screen.getByRole('checkbox', { name: '답변과 승인 범위를 확인했습니다.' }))
  await user.click(screen.getByRole('button', { name: '답변 확정 · 재개 요청' }))
  await waitFor(() => expect(f.operations).toHaveLength(2))
  expect(f.operations[1].action).toBe('decide'); expect(f.operations[1].expectedRevision).toBe(5)
  expect(await screen.findByText('결정 확정 · 재개 대기')).toBeInTheDocument()
  expect(screen.queryByText('재개됨')).not.toBeInTheDocument()
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
  f.detail.logs = [{ uid: 'log-old', type: 'work_log', title: 'Previous execution', detail: { attributes: { result: { workflow: { revision: 2, run: { id: 'old-run', status: 'finished', startedAt: '2026-10-15' } } } } } }]
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


test('pre-start work belongs to manager and cannot be authorized before review', async () => {
  const { detail } = fixture()
  detail.execution.state = 'todo'
  detail.item.detail!.attributes.state = 'todo'
  delete detail.execution.workflow!.review
  expect(responsibleRole(detail.item)).toBe('manager')
  render(<ProjectmanPage />)
  expect(await screen.findByRole('heading', { name: '일 시작 전 · 매니저 검토' })).toBeInTheDocument()
  expect(screen.getByText('매니저 사전 검토가 끝나야 최종 승인할 수 있습니다.')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '이 범위의 개발 실행 승인' })).not.toBeInTheDocument()
})

test('reviewed work displays resolved decisions and allows explicit final approval', async () => {
  const { detail, operations } = fixture()
  detail.execution.state = 'todo'
  detail.execution.preflightReviewed = true
  detail.item.detail!.attributes.state = 'todo'
  delete detail.execution.workflow!.review
  detail.execution.workflow!.specHash = 'scope-1'
  detail.item.detail!.attributes.s8Preflight = { status: 'reviewed', specHash: 'scope-1', summary: '사용자 확정: 최솟값 0. 구현 방식은 개발자가 결정.' }
  expect(responsibleRole(detail.item)).toBe('human')
  render(<ProjectmanPage />)
  const button = await screen.findByRole('button', { name: '이 범위의 개발 실행 승인' })
  expect(button).toBeDisabled()
  expect(screen.getByText('사용자 확정: 최솟값 0. 구현 방식은 개발자가 결정.')).toBeInTheDocument()
  const user = userEvent.setup()
  await user.click(screen.getByRole('checkbox', { name: '위 저장소·파일·명령의 실행 범위를 확인했습니다.' }))
  await user.click(button)
  await waitFor(() => expect(operations[0]?.action).toBe('authorize'))
})
