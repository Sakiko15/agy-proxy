// Ported from dsh-agy-link test/parser.test.ts @ 46984db (converted:
// node:test/assert → vitest describe/it/expect).
import { describe, it, expect } from 'vitest'
import { StreamJsonParser } from '../src/host/parser.ts'
import type { AgyEvent } from '../src/common/types.ts'

const OK_NDJSON = [
  '{"event":"init","conversation_id":"c1","model":"gemini-3-6-flash"}',
  '{"event":"step_update","idx":1,"step_type":"thinking","text":"Think"}',
  '{"event":"step_update","idx":3,"step_type":"text","text":"Hi"}',
  '{"event":"result","result":{"conversation_id":"c1","status":"DONE","response":"Hi","usage":{"input_tokens":3,"output_tokens":2}}}',
].join('\n')

function asStep(e: AgyEvent | undefined) {
  expect(e !== undefined && e.kind === 'step').toBe(true)
  return e as Extract<AgyEvent, { kind: 'step' }>
}
function asResult(e: AgyEvent | undefined) {
  expect(e !== undefined && e.kind === 'result').toBe(true)
  return e as Extract<AgyEvent, { kind: 'result' }>
}

describe('parser', () => {
  it('parses a full ok run', () => {
    const p = new StreamJsonParser()
    const evs = p.feed(OK_NDJSON + '\n')
    expect(evs.length).toBe(4)
    expect(evs[0]?.kind).toBe('init')
    expect(asStep(evs[1]).stepKind).toBe('thinking')
    expect(asStep(evs[2]).stepKind).toBe('text')
    const res = asResult(evs[3])
    expect(res.ok).toBe(true)
    expect(res.usage.input_tokens).toBe(3)
    expect(p.stats.garbage).toBe(0)
  })

  it('buffers torn chunks across feeds', () => {
    const p = new StreamJsonParser()
    const out: AgyEvent[] = []
    for (let i = 0; i < OK_NDJSON.length; i += 7) {
      out.push(...p.feed(OK_NDJSON.slice(i, i + 7)))
    }
    out.push(...p.flush())
    expect(out.length).toBe(4)
    expect(out.filter((e) => e.kind === 'garbage').length).toBe(0)
  })

  it('counts garbage and captures auth failures', () => {
    const p = new StreamJsonParser()
    const evs = p.feed('⚠ noise line\n{"event":"result","result":{"status":"ERROR","error":"authentication failed or timed out"}}\n')
    expect(evs[0]?.kind).toBe('garbage')
    expect(asResult(evs[1]).ok).toBe(false)
    expect(p.stats.garbage).toBe(1)
    expect(p.stats.sawAuthFailure).toBe(true)
  })

  it('captures the OAuth URL from raw lines', () => {
    const p = new StreamJsonParser()
    p.feed('visit https://accounts.google.com/o/oauth2/auth?code=4/AbC now\n')
    expect(p.stats.authUrl?.startsWith('https://accounts.google.com/')).toBe(true)
  })

  it('flush emits a trailing line without newline', () => {
    const p = new StreamJsonParser()
    const evs = p.feed('{"event":"init","conversation_id":"c9"}')
    expect(evs.length).toBe(0)
    const tail = p.flush()
    expect(tail.length).toBe(1)
    expect(tail[0]?.kind).toBe('init')
  })

  it('infers shapes without an event discriminator', () => {
    const p = new StreamJsonParser()
    const evs = p.feed('{"step_type":"text","text":"hi"}\n{"status":"DONE","response":"done","usage":{"total_tokens":9}}\n')
    expect(asStep(evs[0]).stepKind).toBe('text')
    expect(asResult(evs[1]).ok).toBe(true)
  })

  it('agy 1.1.15 nested step_update envelopes classify correctly', () => {
    const p = new StreamJsonParser()
    const evs = p.feed([
      '{"event":"init","conversation_id":"c15","init":{"model":"gemini-3-7-flash","cwd":"/tmp"}}',
      '{"event":"step_update","step_update":{"conversation_id":"c15","step_index":0,"state":"DONE","step_type":"user_input"}}',
      '{"event":"step_update","step_update":{"conversation_id":"c15","step_index":2,"state":"DONE","step_type":"agent_response","usage":{"input_tokens":500,"thinking_tokens":80}}}',
      '{"event":"step_update","step_update":{"conversation_id":"c15","step_index":3,"state":"ACTIVE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"ls"}}}}',
      '{"event":"step_update","step_update":{"conversation_id":"c15","step_index":4,"state":"ERROR","step_type":"tool","tool_name":"find_by_name","tool_info":{"name":"find_by_name","parameters":{"Pattern":"x"},"error":{"type":"TOOL_ERROR","message":"timed out"}}}}',
      '{"event":"step_update","step_update":{"conversation_id":"c15","step_index":5,"state":"ACTIVE","step_type":"agent_response","text_delta":"There are "}}',
    ].join('\n') + '\n')
    expect(evs[0]?.kind).toBe('init')
    expect(evs[0] !== undefined && evs[0].kind === 'init' && evs[0].model).toBe('gemini-3-7-flash')
    const user = asStep(evs[1])
    expect(user.stepKind).toBe('user-input')
    const think = asStep(evs[2])
    expect(think.stepKind).toBe('text')
    expect(think.usage?.thinking_tokens).toBe(80)
    const tool = asStep(evs[3])
    expect(tool.stepKind).toBe('tool')
    expect(tool.tool?.name).toBe('run_command')
    expect(tool.tool?.args).toEqual({ CommandLine: 'ls' })
    expect(tool.state).toBe('ACTIVE')
    const toolErr = asStep(evs[4])
    expect(toolErr.tool?.error).toBe('timed out')
    const frag = asStep(evs[5])
    expect(frag.stepKind).toBe('text')
    expect(frag.fragment).toBe(true)
    expect(frag.text).toBe('There are ')
    expect(p.stats.garbage).toBe(0)
  })

  it('agy 1.1.15 result envelope keeps ERROR-with-response usable', () => {
    const p = new StreamJsonParser()
    const evs = p.feed('{"event":"result","result":{"conversation_id":"c15","status":"ERROR","response":"partial answer","error":"find timed out","usage":{"input_tokens":9,"output_tokens":8,"thinking_tokens":4}}}' + '\n')
    const res = asResult(evs[0])
    expect(res.ok).toBe(false)
    expect(res.response).toBe('partial answer')
    expect(res.error).toBe('find timed out')
    expect(res.usage.thinking_tokens).toBe(4)
  })

  it('numeric step_type map (14=thinking, 15=text, 5=tool)', () => {
    const p = new StreamJsonParser()
    const evs = p.feed('{"event":"step_update","idx":1,"step_type":14,"text":"deep"}\n{"event":"step_update","idx":2,"step_type":15,"text":"out"}\n{"event":"step_update","idx":3,"step_type":5,"tool_info":{"name":"bash","parameters":{"cmd":"ls"}}}\n')
    expect(asStep(evs[0]).stepKind).toBe('thinking')
    expect(asStep(evs[1]).stepKind).toBe('text')
    const tool = asStep(evs[2])
    expect(tool.stepKind).toBe('tool')
    expect(tool.tool?.name).toBe('bash')
  })
})

describe('parser S-M6 memory bounds', () => {
  it('discards a torn line past the pending cap; parsing stays tolerant', () => {
    const p = new StreamJsonParser()
    p.feed('x'.repeat(1_100_000)) // > 1 MiB with no newline
    expect(p.stats.overflowDrops).toBe(1)
    // A well-formed line after the drop still parses.
    const evs = p.feed('{"event":"result","result":{"conversation_id":"c1","status":"DONE","response":"done"}}' + '\n')
    expect(evs).toHaveLength(1)
    expect(asResult(evs[0]).ok).toBe(true)
    expect(p.stats.garbage).toBe(0)
  })

  it('truncates stored diagnostics lines and garbage payloads', () => {
    const p = new StreamJsonParser()
    const evs = p.feed('z'.repeat(5_000_000) + '\n')
    const g = evs[0]
    expect(g?.kind).toBe('garbage')
    if (g?.kind === 'garbage') expect(g.line.length).toBe(4000)
    expect(p.recentLines[0]?.length).toBe(4000)
    expect(p.stats.garbage).toBe(1)
  })
})
