// agy_tool — the mirror tool (v1).
//
// The engine cuts each completed agy tool step into a finish:tool-calls span
// addressed to THIS tool. The gateway's protocol layer surfaces the call to
// the API client; the continuation request carries the callId
// (`agytc-<runId>-<eventIndex>`) back, and the next span resumes from the
// recording — the output was already captured by the agy child process, so
// the tool executes instantly by replaying the recorded output.
//
// Shrunk from dsh-agy-link's mirror-tool.ts: the dsh-tools view system
// (presentCall/presentResult cards) and the run_code wrapper have no host in
// a standalone gateway; what survives is the mirror tool name, its parameter
// shape, and the arg-projection helpers the protocol layer uses to render
// agy tool activity.
// Ported from dsh-agy-link src/host/mirror-tool.ts @ 46984db (modified:
// dsh-tools views, getGitHeadContent, buildMirrorRunCode/parseMirrorInvocation
// and defineAgyMirrorTool dropped; toolInput/pick preserved verbatim).
import type { RunRegistry } from './recording.ts'

export const MIRROR_TOOL_NAME = 'agy_tool'

/** JSON Schema for the mirrored tool call, as surfaced on /v1 endpoints. */
export const MIRROR_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    run: { type: 'string', description: 'Recording run id.' },
    step: { type: 'number', description: 'Recorded event index of the tool step.' },
    tool: { type: 'string', description: 'agy tool name that ran.' },
    input: { type: 'object', description: 'agy tool arguments as recorded.' },
  },
  required: ['run', 'step'],
} as const

/**
 * Replay one recorded agy tool step. The protocol layer executes this when a
 * client posts back the tool result round-trip so subsequent engine spans see
 * a coherent message history; the actual output text was already recorded by
 * the agy child process.
 */
export function executeMirrorTool(deps: { runs: RunRegistry }, args: unknown): string {
  const a = (args ?? {}) as { run?: unknown; step?: unknown }
  const runId = typeof a.run === 'string' ? a.run : ''
  const step = typeof a.step === 'number' ? a.step : -1
  const rec = deps.runs.get(runId)
  if (rec === undefined) {
    throw new Error('agy_tool: no recorded agy run "' + runId + '" — this tool only replays bridge-recorded activity')
  }
  const t = rec.toolEventAt(step)
  if (t === null) {
    throw new Error('agy_tool: event ' + step + ' of run ' + runId + ' is not a completed tool step')
  }
  if (t.error !== undefined) {
    throw new Error('agy tool ' + t.name + ' failed: ' + t.error)
  }
  const out = t.output
  if (out === undefined || out === null) return ''
  if (typeof out === 'string') return out
  try {
    return JSON.stringify(out, null, 2)
  } catch {
    return String(out)
  }
}

/** agy serializes some tool args as a JSON string; consumers get an object. */
export function toolInput(args: { input?: unknown }): Record<string, unknown> {
  const raw = args.input
  if (raw === undefined || raw === null) return {}
  if (typeof raw === 'object') return raw as Record<string, unknown>
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : { value: parsed }
    } catch {
      return { value: raw }
    }
  }
  return { value: raw }
}

/**
 * agy serializes tool args with PascalCase keys (CommandLine, AbsolutePath,
 * SearchDirectory, TargetFile, TargetContent, ReplacementContent, CodeContent…);
 * pick() accepts all casing spellings so consumers always read the real field
 * instead of falling back to raw JSON.
 */
export function pick(input: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = input[k]
    if (typeof v === 'string') return v
  }
  return undefined
}
