import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import WorkersPanel from './WorkersPanel'
import type { ResidentWorker } from './api'

afterEach(cleanup)

test('shows remote connection and temporary research without calling it idle', () => {
  const worker: ResidentWorker = { id: 'a', nodeId: 'host-a', connected: true, running: true, mode: 'passive', configMode: 'passive', overridden: false, current: null, queue: [], lastError: null, research: { requestId: 'research-1' } }
  const { rerender } = render(<WorkersPanel workers={[worker]} busy={false} onMode={vi.fn()} onOpenTask={vi.fn()} />)
  expect(screen.getByText(/장비 host-a.*통신 연결됨/)).toBeInTheDocument()
  expect(screen.queryByText('쉬는 중')).not.toBeInTheDocument()
  expect(screen.getByText(/research-1/)).toBeInTheDocument()
  rerender(<WorkersPanel workers={[{ ...worker, running: false, connected: false }]} busy={false} onMode={vi.fn()} onOpenTask={vi.fn()} />)
  expect(screen.getByText(/장비 host-a.*통신 끊김/)).toBeInTheDocument()
  expect(screen.getByText(/해당 장비의.*workers/)).toBeInTheDocument()
})

test('allocated run identity is not presented as a confirmed claim', () => {
  const worker: ResidentWorker = { id: 'a', mode: 'passive', configMode: 'passive', running: true, overridden: false, current: { uid: 'task-1', source: 'manager', startedAt: '2026-10-21T00:00:00Z', runId: 'run-1', claimed: false }, queue: [], lastError: null, metrics: { pending: 1, failures: 0, lastLatencyMs: 5, lastError: null } }
  render(<WorkersPanel workers={[worker]} busy={false} onMode={vi.fn()} onOpenTask={vi.fn()} />)
  expect(screen.getByText(/run-1.*claim 확인 대기/)).toBeInTheDocument()
  expect(screen.getByText(/통신 응답 대기 1/)).toBeInTheDocument()
})
