// Proxy-aware fetch for Google endpoints.
//
// Node's built-in fetch ignores HTTP_PROXY/HTTPS_PROXY env vars, which
// silently broke every quota/OAuth call behind a proxy ("fetch failed"
// while curl worked). We use undici's OWN fetch with EnvHttpProxyAgent:
// mixing an external undici dispatcher into Node's built-in fetch throws
// UND_ERR_INVALID_ARG (bundled-undici version skew), so the dispatcher and
// the fetch must come from the same undici copy. An explicit per-account
// proxyUrl wins over the environment. Everything is per-request — the host
// process's global dispatcher stays untouched.
// Ported from dsh-agy-link src/host/net.ts @ 46984db
// (modified: per-request 10s abort timeout — audit M4).
import { EnvHttpProxyAgent, ProxyAgent, fetch as undiciFetch } from 'undici'

const envAgent = new EnvHttpProxyAgent()
const perProxyAgents = new Map<string, ProxyAgent>()

/** Hard ceiling for every outbound Google call. Undici's own defaults
 *  (headersTimeout 300s) let one hung endpoint stall a quota-poll cycle
 *  ~20x past its 15 min interval, stacking cycles on the same accounts;
 *  these OAuth/quota JSON endpoints answer in well under a second.
 *  agyFetch applies it unless the caller supplies its own `signal`. */
export const AGY_FETCH_TIMEOUT_MS = 10_000

function agentFor(proxyUrl?: string): EnvHttpProxyAgent | ProxyAgent {
  if (proxyUrl) {
    let agent = perProxyAgents.get(proxyUrl)
    if (!agent) {
      agent = new ProxyAgent(proxyUrl)
      perProxyAgents.set(proxyUrl, agent)
    }
    return agent
  }
  return envAgent
}

/** fetch() honoring env proxies, or an explicit per-account proxy URL.
 *  Aborts after AGY_FETCH_TIMEOUT_MS (overridable per call for tests). */
export function agyFetch(
  url: string,
  init: RequestInit = {},
  proxyUrl?: string,
  timeoutMs: number = AGY_FETCH_TIMEOUT_MS,
): Promise<Response> {
  return undiciFetch(url, {
    ...(init as object),
    dispatcher: agentFor(proxyUrl),
    signal: init.signal ?? AbortSignal.timeout(timeoutMs),
  }) as unknown as Promise<Response>
}
