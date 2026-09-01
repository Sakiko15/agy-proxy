// Static WebUI hosting (M4, charter §3: the same Node process serves
// /admin/* and the SPA). @fastify/static with wildcard:false registers a
// route PER FILE — it can never shadow the literal /v1, /admin and /healthz
// routes. The SPA fallback (dot-free GET paths that are not API) lives in
// the app's not-found handler (see app.ts), which keeps every protocol-shaped
// API 404 byte-identical. When no built frontend exists (dev without a web
// build, tests), registration is a no-op and the server behaves exactly as
// in M3.
import { existsSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import fastifyStatic from '@fastify/static'
import type { SetHeadersResponse } from '@fastify/static'
import type { GatewayConfig } from '../common/types.ts'

/** Directory candidates, in precedence order. The winner must contain
 *  index.html — a stale/empty dir must never take over. */
export function resolveWebDist(cfg: GatewayConfig, env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates: string[] = []
  if (cfg.webDist !== '') candidates.push(cfg.webDist)
  if (env.AGY_PROXY_WEB_DIST !== undefined && env.AGY_PROXY_WEB_DIST !== '') candidates.push(env.AGY_PROXY_WEB_DIST)
  // The bundled entry is dist/index.js (tsx dev runs from src/server/); the
  // repo layout keeps the SPA build at <repoRoot>/web/dist, which the docker
  // image copies next to dist/. Both resolve via the entry's parent dir,
  // with the cwd candidate as the last fallback for out-of-root installs.
  candidates.push(join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'dist'))
  candidates.push(join(process.cwd(), 'web', 'dist'))
  for (const candidate of candidates) {
    const dir = resolve(candidate)
    const html = join(dir, 'index.html')
    if (isAbsolute(dir) && existsSync(html) && statSync(html).isFile()) {
      return dir
    }
  }
  return null
}

/** Minimal structural surface — avoids importing FastifyInstance generics. */
interface StaticRegisterer {
  register: (plugin: unknown, opts: Record<string, unknown>) => Promise<unknown> | unknown
}

/** Register the static web root, or no-op (with a log) when there is none. */
export function registerStaticWeb(
  app: StaticRegisterer,
  opts: { log: { info: (o: object, m: string) => void }; webRoot: string | null },
): void {
  if (opts.webRoot === null) {
    opts.log.info(
      { hints: ['AGY_PROXY_WEB_DIST', 'npm run web:build'] },
      'webui: no built frontend found — JSON-only mode',
    )
    return
  }
  void app.register(fastifyStatic, {
    root: opts.webRoot,
    prefix: '/',
    wildcard: false, // per-file routes only — API routes always win
    index: 'index.html',
    // send() would stamp its own `public, max-age=0` over setHeaders — own
    // every cache-control decision here instead.
    cacheControl: false,
    setHeaders: (res: SetHeadersResponse, path: string) => {
      if (path.includes(`${sep}assets${sep}`)) {
        // Hashed vite assets are content-addressed.
        res.setHeader('cache-control', 'public, max-age=31536000, immutable')
      } else {
        // index.html (root route / SPA fallback) must refetch every time.
        res.setHeader('cache-control', 'no-cache')
      }
    },
  })
}