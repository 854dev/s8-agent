import { afterEach, expect, test, vi } from 'vitest'
import { ConsoleError, createRequestId, request } from './api'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

test('proxy HTML and empty failures retain HTTP status and show a useful error', async () => {
  for (const status of [401, 502, 503]) {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Bad Gateway</html>', { status })))
    await expect(request('/session')).rejects.toMatchObject({ status, message: expect.stringContaining('콘솔 서버와 PH-CMS') })
  }
})

test('unexpected successful HTML and null JSON cannot establish a session', async () => {
  for (const body of ['<html>frontend fallback</html>', 'null']) {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)))
    await expect(request('/session')).rejects.toBeInstanceOf(ConsoleError)
  }
})

test('backend error messages and successful responses are preserved', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: '다시 로그인하세요.', code: 'SESSION_RENEWED' }, { status: 401 })))
  await expect(request('/session')).rejects.toMatchObject({ status: 401, message: '다시 로그인하세요.', code: 'SESSION_RENEWED' })
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ authenticated: true })))
  await expect(request('/session')).resolves.toEqual({ authenticated: true })
})

test('HTTP origins without randomUUID still produce unique UUID v4 request IDs', () => {
  const getRandomValues = crypto.getRandomValues.bind(crypto)
  vi.stubGlobal('crypto', { getRandomValues })
  const ids = new Set(Array.from({ length: 50 }, createRequestId))
  expect(ids.size).toBe(50)
  for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
})
