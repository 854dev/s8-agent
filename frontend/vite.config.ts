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
      '/api': apiProxy,
    },
    host: '0.0.0.0',
  },
  preview: {
    proxy: {
      '/api': apiProxy,
    },
    host: '0.0.0.0',
  },
  test: {
    environment: 'jsdom',
    setupFiles: './src/test-setup.ts',
    globals: true,
  },
})
