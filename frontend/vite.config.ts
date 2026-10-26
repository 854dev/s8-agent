import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig(() => {
  // Router settings come from config.yml; start-infra.sh exports them (node pi/bin/s8-config.mjs shell-env).
  // Keep them server-side; never expose them through VITE_* variables.
  const host = process.env.S8_BIND_IP || '127.0.0.1'
  const port = process.env.S8_HTTP_PORT || '80'
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
