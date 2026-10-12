import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

const apiProxy = {
  target: 'http://127.0.0.1',
  changeOrigin: false,
}

export default defineConfig({
  base: '/s8/',
  plugins: [react()],
  server: {
    proxy: {
      '/api/terminal': { target: 'http://127.0.0.1:8790', ws: true, changeOrigin: false },
      '/api': apiProxy,
    },
    host: '127.0.0.1',
  },
  preview: {
    proxy: {
      '/api/terminal': { target: 'http://127.0.0.1:8790', ws: true, changeOrigin: false },
      '/api': apiProxy,
    },
    host: '127.0.0.1',
  },
  test: {
    environment: 'jsdom',
    setupFiles: './src/test-setup.ts',
    globals: true,
  },
})
