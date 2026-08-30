// Ported from dsh-agy-link test/fake-agy.mjs @ 46984db (verbatim for the
// modes used by M0/M1 tests; new modes are appended, not modified, so the
// upstream diff stays clean).
// Fake agy CLI for offline tests. Modes via FAKE_AGY_MODE env:
//   ok | auth | noise | exit12 | exit-error | real | real-error | real-fail
//   ok            — legacy flat event shapes (kept for compat coverage)
//   real          — real agy 1.1.15 stream-json shapes (nested step_update)
//   real-error    — real shapes, ERROR result envelope
//   real-fail     — real shapes, "model overloaded" error envelope
//   exit-error    — stdout error envelope + exit 1 + empty stderr (the real
//                   observed v0.4.21 failure: error is on stdout, not stderr)
//   exit12        — exit code 12, no output
//   noise         — non-JSON stdout noise (parser robustness)
//   auth          — stderr sign-in notice + auth URL
// Records argv to FAKE_AGY_ARGS_FILE when set.

import { appendFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const mode = process.env.FAKE_AGY_MODE ?? 'ok'

if (process.env.FAKE_AGY_ARGS_FILE) {
  try {
    appendFileSync(process.env.FAKE_AGY_ARGS_FILE, JSON.stringify(argv) + '\n')
  } catch {
    // ignore
  }
}

// Version probe (matches real `agy --version` output shape).
if (argv[0] === '--version') {
  process.stdout.write('agy version 1.1.13-fake\n')
  process.exit(0)
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

// Model discovery: `agy models` — support FAKE_AGY_MODELS=text (table) | fail.
if (argv[0] === 'models') {
  if (process.env.FAKE_AGY_MODELS === 'text') {
    process.stdout.write('gemini-3.7-flash          Gemini 3.7 Flash\nclaude-sonnet-4-6         Claude Sonnet 4.6\n')
    process.exit(0)
  } else if (process.env.FAKE_AGY_MODELS === 'fail') {
    process.stderr.write('Error: Please sign in\n')
    process.exit(1)
  }
  process.stdout.write(
    JSON.stringify([
      { id: 'gemini-3.7-flash', display_name: 'Gemini 3.7 Flash' },
      { id: 'gemini-3.7-flash-high', display_name: 'Gemini 3.7 Flash High' },
      { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6' },
    ]),
  )
  process.exit(0)
}

if (mode === 'exit12') {
  process.exit(12)
}

if (mode === 'exit-error') {
  emit({ event: 'result', result: { conversation_id: '', status: 'ERROR', response: '', error: 'upstream request failed while generating (request id 8f3ac2)', duration_seconds: 8.2, num_turns: 0, usage: { input_tokens: 0, output_tokens: 0 } } })
  process.exit(1)
}

if (mode === 'auth') {
  process.stderr.write('Please sign in. Visit https://accounts.google.com/o/oauth2/auth?access_type=offline&code=4/AbCdEf123 to authenticate, then paste the authorization code.\n')
  emit({ event: 'result', result: { conversation_id: '', status: 'ERROR', error: 'authentication failed or timed out' } })
  process.exit(1)
}

if (mode === 'noise') {
  process.stdout.write('this is not json\n')
  emit({ event: 'result', result: { conversation_id: '', status: 'ERROR', error: 'bad turn' } })
  process.exit(1)
}

// `real` modes: shapes matching agy 1.1.15 stream-json (nested step_update).
if (mode === 'real' || mode === 'real-error' || mode === 'real-fail') {
  const conv = 'conv-real-1234'
  emit({ event: 'init', init: { cwd: '/tmp', tools: ['read_file', 'write_file'], permission_mode: 'always-proceed', model: 'gemini-3.7-flash' } })
  emit({ event: 'step_update', step_update: { conversation_id: conv, step_index: 0, state: 'DONE', step_type: 'user_input', duration_seconds: 0.1, usage: { input_tokens: 100, output_tokens: 0, total_tokens: 100 } } })
  emit({ event: 'step_update', step_update: { conversation_id: conv, step_index: 1, state: 'ACTIVE', step_type: 'agent_response', step_payload: { step_type: 15, content: 'There are' } } })
  emit({ event: 'step_update', step_update: { conversation_id: conv, step_index: 2, state: 'DONE', step_type: 'agent_response', duration_seconds: 1.2, usage: { input_tokens: 500, output_tokens: 40, thinking_tokens: 80, total_tokens: 540 } } })
  emit({ event: 'step_update', step_update: { conversation_id: conv, step_index: 3, state: 'ACTIVE', step_type: 'agent_response', text_delta: ' 2 files.' } })
  emit({ event: 'step_update', step_update: { conversation_id: conv, step_index: 4, state: 'DONE', step_type: 'agent_response', text_delta: ' 2 files.', duration_seconds: 0.5 } })
  emit({ event: 'step_update', step_update: { conversation_id: conv, step_index: 5, state: 'DONE', step_type: 'agent_response', text_delta: '6 words total.', duration_seconds: 2, usage: { input_tokens: 900, output_tokens: 60, thinking_tokens: 15, cache_read_tokens: 200, total_tokens: 960 } } })
  if (mode === 'real-fail') {
    emit({ event: 'result', result: { conversation_id: conv, status: 'ERROR', response: '', error: 'model overloaded', duration_seconds: 5, num_turns: 1, usage: { input_tokens: 100, output_tokens: 0 } } })
  } else if (mode === 'real-error') {
    emit({ event: 'result', result: { conversation_id: conv, status: 'ERROR', response: '', error: 'Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 143h57m55s.', duration_seconds: 5, num_turns: 1, usage: { input_tokens: 100, output_tokens: 0 } } })
  } else {
    emit({ event: 'result', result: { conversation_id: conv, status: 'DONE', response: 'There are 2 files, 6 words total.', duration_seconds: 5, num_turns: 1, usage: { input_tokens: 900, output_tokens: 100, thinking_tokens: 95, cache_read_tokens: 200, total_tokens: 1000 } } })
  }
  process.exit(0)
}

// `ok`: legacy flat event shapes.
const conv = 'conv-ok-1'
emit({ event: 'init', conversation_id: conv, model: 'gemini-3.7-flash' })
emit({ event: 'step_update', step_index: 0, step_key: 'turn-0', state: 'DONE', text: 'Hello', usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } })
emit({ event: 'step_update', step_index: 1, step_key: 'turn-1', state: 'DONE', text: ' world', fragment: true, usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } })
emit({ event: 'result', conversation_id: conv, ok: true, response: 'Hello world', usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } })
process.exit(0)
