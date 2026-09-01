// Unsupported content types → 415 (M4; closes the m3 drill finding where
// `curl -d` form-encoding produced a 500). One test per surface body shape.
import { describe, it, expect } from 'vitest'
import { makeAdminServer, login } from './helpers.admin.ts'

const FORM = 'application/x-www-form-urlencoded'

describe('unsupported media type → 415', () => {
  it('OpenAI surface: form-urlencoded POST → 415 {error:{...}}', async () => {
    const { built } = makeAdminServer()
    const res = await built.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: 'a=1',
      headers: { 'content-type': FORM },
    })
    expect(res.statusCode).toBe(415)
    const body = res.json() as { error: { type: string; code: string; message: string } }
    expect(body.error.type).toBe('invalid_request_error')
    expect(body.error.code).toBe('unsupported_media_type')
    expect(body.error.message).toContain('application/x-www-form-urlencoded')
  })

  it('Anthropic surface: form-urlencoded POST → 415 {type:"error",...}', async () => {
    const { built } = makeAdminServer()
    const res = await built.app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: 'a=1',
      headers: { 'content-type': FORM, 'anthropic-version': '2023-06-01' },
    })
    expect(res.statusCode).toBe(415)
    const body = res.json() as { type: string; error: { type: string; message: string } }
    expect(body.type).toBe('error')
    expect(body.error.type).toBe('invalid_request_error')
    expect(body.error.message).toContain('application/x-www-form-urlencoded')
  })

  it('Admin surface: form-urlencoded POST → 415 {ok:false, error}', async () => {
    const { built } = makeAdminServer()
    const res = await built.app.inject({
      method: 'POST',
      url: '/admin/login',
      payload: 'a=1',
      headers: { 'content-type': FORM },
    })
    expect(res.statusCode).toBe(415)
    const body = res.json() as { ok: boolean; error: string }
    expect(body.ok).toBe(false)
    expect(body.error).toContain('application/x-www-form-urlencoded')
    expect((await login(built)).res.statusCode).toBe(200) // JSON body still fine afterwards
  })
})