import { MantineProvider } from '@mantine/core'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import TerminalPage from './TerminalPage'

const mock = vi.hoisted(() => ({ input: null as null | ((data: string) => void), sent: [] as string[], url: '', options: { fontSize: 12 }, instances: 0, fits: 0 }))
vi.mock('@xterm/xterm', () => ({ Terminal: class {
  cols = 80; rows = 24
  options: { fontSize: number }
  constructor(options: { fontSize: number }) { this.options = options; mock.options = options; mock.instances++ }
  loadAddon() {} open() {} write() {} focus() {} dispose() {}
  onData(handler: (data: string) => void) { mock.input = handler; return { dispose() {} } }
} }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() { mock.fits++ } } }))
afterEach(() => { vi.unstubAllGlobals(); Reflect.deleteProperty(document, 'fullscreenElement'); mock.sent = []; mock.input = null; mock.instances = 0; mock.fits = 0 })
it('defaults to host shell and sends mobile keys, Ctrl chords, and paste without an appended Enter', async () => {
  class Socket {
    static OPEN = 1
    readyState = 1
    onopen: null | (() => void) = null
    onclose = null; onmessage = null; onerror = null
    constructor(url: URL) { mock.url = url.toString(); queueMicrotask(() => this.onopen?.()) }
    send(data: string) { mock.sent.push(data) }
    close() {}
  }
  vi.stubGlobal('WebSocket', Socket)
  const viewport = Object.assign(new EventTarget(), { height: 844, offsetTop: 0 })
  vi.stubGlobal('visualViewport', viewport)
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ sessions: ['s8-host-shell', 's8-main'] }) })))
  const view = render(<MantineProvider><TerminalPage onBack={() => {}} /></MantineProvider>)
  await screen.findByText('연결됨')
  expect(mock.url).toContain('session=s8-host-shell')
  const fits = mock.fits
  fireEvent.click(screen.getByRole('button', { name: '글자 축소' }))
  expect(mock.options.fontSize).toBe(11)
  await waitFor(() => expect(mock.fits).toBeGreaterThan(fits))
  for (let i = 0; i < 10; i++) fireEvent.click(screen.getByRole('button', { name: '글자 축소' }))
  expect(mock.options.fontSize).toBe(8)
  expect(screen.getByRole('button', { name: '글자 축소' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: '글자 확대' }))
  expect(mock.options.fontSize).toBe(9)
  fireEvent.click(screen.getByRole('button', { name: '전체화면' }))
  expect(view.container.querySelector('.terminal-page--fullscreen')).not.toBeNull()
  expect(document.body.style.overflow).toBe('hidden')
  viewport.height = 390
  act(() => viewport.dispatchEvent(new Event('resize')))
  expect((view.container.querySelector('.terminal-page') as HTMLElement).style.getPropertyValue('--terminal-viewport-height')).toBe('390px')
  expect(mock.instances).toBe(1) // Resizing and full screen must not reconnect the shell.
  fireEvent.click(screen.getByRole('button', { name: 'Ctrl+C' }))
  expect(JSON.parse(mock.sent.at(-1)!)).toEqual({ type: 'input', data: '\x03' })
  fireEvent.click(screen.getByRole('button', { name: 'Ctrl' }))
  act(() => mock.input?.('b'))
  expect(JSON.parse(mock.sent.at(-1)!)).toEqual({ type: 'input', data: '\x02' })
  expect(screen.getByRole('button', { name: 'Ctrl' })).toHaveAttribute('aria-pressed', 'false')
  fireEvent.click(screen.getByRole('button', { name: '↑' }))
  expect(JSON.parse(mock.sent.at(-1)!)).toEqual({ type: 'input', data: '\x1b[A' })
  fireEvent.click(screen.getByRole('button', { name: '붙여넣기' }))
  fireEvent.change(screen.getByLabelText('붙여넣을 텍스트'), { target: { value: 'echo hello' } })
  fireEvent.click(screen.getByRole('button', { name: '입력 보내기' }))
  expect(JSON.parse(mock.sent.at(-1)!)).toEqual({ type: 'input', data: 'echo hello' })
  fireEvent.click(screen.getByRole('button', { name: '전체화면 해제' }))
  expect(view.container.querySelector('.terminal-page--fullscreen')).toBeNull()
  expect(document.body.style.overflow).not.toBe('hidden')
  const page = view.container.querySelector('.terminal-page')!
  const request = vi.fn(async () => {
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: page })
    document.dispatchEvent(new Event('fullscreenchange'))
  })
  Object.defineProperty(page, 'requestFullscreen', { value: request })
  fireEvent.click(screen.getByRole('button', { name: '전체화면' }))
  await waitFor(() => expect(request).toHaveBeenCalledOnce())
  expect(screen.getByRole('button', { name: 'Ctrl+C' })).toBeVisible()
  expect(mock.instances).toBe(1)
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null })
  fireEvent(document, new Event('fullscreenchange')) // Browser Escape must restore the normal layout.
  expect(view.container.querySelector('.terminal-page--fullscreen')).toBeNull()
  expect(document.body.style.overflow).not.toBe('hidden')
  view.unmount()
})
