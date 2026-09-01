/// <reference types="vitest/config" />
// WebUI dev/build config. The dev server proxies /v1 and /admin to a local
// gateway (AGY_PROXY_DEV_PROXY or the default 127.0.0.1:8080) so the SPA can
// ride the real session cookie during development. Production serves the
// built dist/ from the gateway itself (src/server/static.ts).
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const proxyEnv = process.env.AGY_PROXY_DEV_PROXY ?? 'http://127.0.0.1:8080'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
  server: {
    port: Number(process.env.AGY_PROXY_WEB_PORT ?? '5173'),
    proxy: {
      '/admin': { target: proxyEnv, changeOrigin: false },
      '/v1': { target: proxyEnv, changeOrigin: false },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})