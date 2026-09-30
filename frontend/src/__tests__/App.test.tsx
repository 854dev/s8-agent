import { MantineProvider } from '@mantine/core'
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from '../App'

afterEach(() => {
  window.history.replaceState({}, '', '/')
})

describe('App routes', () => {
  it('renders the knowledge base page at the knowledge base path', async () => {
    window.history.replaceState({}, '', '/s8/knowledge-base')
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/health')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ status: 'ok', service: 'kb' }) })
      if (url.includes('/tree')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ root: '', entries: [] }) })
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ results: [] }) })
    }))

    render(
      <MantineProvider>
        <App />
      </MantineProvider>,
    )

    expect(await screen.findByRole('heading', { name: '지식베이스 브라우저' })).toBeInTheDocument()
  })
})
