// L5 regression: the loopback OAuth callback reflects the ?error= query
// param into an HTML page. The value is attacker-controlled text on a port
// any local page can reach, so it must be HTML-escaped — a crafted redirect
// like ?error=<img src=x onerror=...> used to run script in the operator's
// browser.
import { describe, it, expect } from 'vitest'
import { get } from 'node:http'
import { OAUTH_CALLBACK_PORT, OAUTH_CALLBACK_PATH, startCallbackListener } from '../src/host/oauth.ts'

function getBody(path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    get('http://127.0.0.1:' + OAUTH_CALLBACK_PORT + path, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => {
        body += c
      })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    }).on('error', reject)
  })
}

describe('oauth callback page (L5)', () => {
  it('escapes the reflected ?error= payload', async () => {
    const handle = startCallbackListener(10_000)
    // Attach before injecting so the expected rejection never surfaces as
    // an unhandled rejection between the request and this assertion.
    const rejection = expect(handle.result).rejects.toThrow(/oauth error/)
    const payload = '<img src=x onerror=alert(1)>'
    const res = await getBody(OAUTH_CALLBACK_PATH + '?error=' + encodeURIComponent(payload))
    expect(res.status).toBe(400)
    expect(res.body).not.toContain(payload)
    expect(res.body).toContain('&lt;img src=x onerror=alert(1)&gt;')
    await rejection
    await handle.close()
  })

  it('still completes a well-formed code+state callback', async () => {
    const handle = startCallbackListener(10_000)
    const res = await getBody(OAUTH_CALLBACK_PATH + '?code=4/abc&state=s1')
    expect(res.status).toBe(200)
    await expect(handle.result).resolves.toEqual({ code: '4/abc', state: 's1' })
    await handle.close()
  })
})