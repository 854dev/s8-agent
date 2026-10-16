import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { loadEnv } from 'vite'
import { fileURLToPath } from 'node:url'

export default defineConfig(({ command, mode }) => {
  // Compose uses the repository root configuration, not frontend/.env.
  // Keep router settings server-side; never expose them through VITE_* variables.
  const env = command === 'serve' && mode !== 'test'
    ? loadEnv(mode, fileURLToPath(new URL('..', import.meta.url)), 'NGINX_')
    : {}
  const host = process.env.NGINX_BIND_IP || env.NGINX_BIND_IP || '127.0.0.1'
  const port = process.env.NGINX_HTTP_PORT || env.NGINX_HTTP_PORT || '80'
  const proxy = {
    '/api/projectman': { target: 'http://127.0.0.1:8791', changeOrigin: false },
    '/api/terminal': { target: 'http://127.0.0.1:8790', ws: true, changeOrigin: false },
    '/api': { target: `http://${host}:${port}`, changeOrigin: false },
  }
  return {
    base: '/s8/',
    plugins: [react()],
    server: {
      proxy,
      host: '127.0.0.1',
    },
    preview: {
      proxy,
      host: '127.0.0.1',
    },
    test: {
      environment: 'jsdom',
      setupFiles: './src/test-setup.ts',
      globals: true,
    },
  }
})
