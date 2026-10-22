import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import WorkersPanel from './WorkersPanel'
import type { ResidentWorker } from './api'

afterEach(cleanup)

test('lists local worker tasks and retains local mode controls', () => {
  const worker: ResidentWorker = { id: 'a', mode: 'passive', configMode: 'passive', running: true, overridden: false, current: { uid: 'task-1', source: 'manager', startedAt: '2026-10-21T00:00:00Z' }, queue: [], lastError: null }
  const onMode = vi.fn(), onOpenTask = vi.fn()
  render(<WorkersPanel workers={[worker]} busy={false} onMode={onMode} onOpenTask={onOpenTask} />)
  fireEvent.click(screen.getByRole('button', { name: 'task-1' }))
  expect(onOpenTask).toHaveBeenCalledWith('task-1')
  fireEvent.click(screen.getByRole('button', { name: '자동' }))
  expect(onMode).toHaveBeenCalledWith('a', 'active')
})

test('empty worker list explains local configuration', () => {
  render(<WorkersPanel workers={[]} busy={false} onMode={vi.fn()} onOpenTask={vi.fn()} />)
  expect(screen.getByText(/이 장비의 workers 설정/)).toBeInTheDocument()
})
