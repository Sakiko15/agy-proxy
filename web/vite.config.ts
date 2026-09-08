/// <reference types="vitest/config" />
// WebUI dev/build config. The dev server proxies /v1 and /admin to a local
// gateway (AGY_PROXY_DEV_PROXY or the default 127.0.0.1:8080) so the SPA can
// ride the real session cookie during development. Production serves the
// built dist/ from the gateway itself (src/server/static.ts).
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { brotliCompressSync, gzipSync } from 'node:zlib'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const proxyEnv = process.env.AGY_PROXY_DEV_PROXY ?? 'http://127.0.0.1:8080'

// P3-svc: build-time precompression. The gateway serves dist/ with
// @fastify/static preCompressed:true, which picks a .gz/.br sibling by
// Accept-Encoding and falls back to the plain file when none matches —
// so the siblings must exist next to the built assets. Node's zlib does
// both formats; no new dependency. Files ≤1KB stay uncompressed (framing
// overhead beats the win), as do formats brotli cannot shrink.
const PRECOMPRESS_MIN_BYTES = 1024
const PRECOMPRESS_SKIP = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico',
  '.woff', '.woff2', '.gz', '.br',
])

function precompressAssets(): Plugin {
  let outDir = ''
  return {
    name: 'agy-web-precompress',
    apply: 'build',
    configResolved(resolved) {
      outDir = resolve(resolved.root, resolved.build.outDir)
    },
    closeBundle() {
      let compressed = 0
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name)
          if (entry.isDirectory()) {
            walk(path)
          } else if (
            entry.isFile() &&
            statSync(path).size > PRECOMPRESS_MIN_BYTES &&
            !PRECOMPRESS_SKIP.has(extname(entry.name))
          ) {
            const body = readFileSync(path)
            writeFileSync(path + '.gz', gzipSync(body, { level: 9 }))
            writeFileSync(path + '.br', brotliCompressSync(body))
            compressed++
          }
        }
      }
      try {
        walk(outDir)
      } catch {
        return // no dist output — nothing to precompress
      }
      if (compressed > 0) this.info(`precompressed ${compressed} asset(s) → .gz/.br siblings`)
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), precompressAssets()],
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