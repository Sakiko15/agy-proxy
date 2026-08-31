// Fake agy CLI for offline tests. Ported from dsh-agy-link
// test/fake-agy.mjs @ 46984db (modified: the M0 header note about verbatim
// modes no longer applies — the 'ok'/'noise'/'auth' exit semantics were
// realigned to upstream in M1 when the engine test suite landed; a
// FAKE_AGY_EVENTS_FILE replay mode was added for the golden-case runner).
//
// Modes via FAKE_AGY_MODE env:
//   ok | auth | noise | exit12 | exit-error | real | real-error | real-fail
//   ok            — legacy flat event shapes (kept for compat coverage)
//   real          — real agy 1.1.15 stream-json shapes (nested step_update
//                   envelopes, agent_response text_delta fragments,
//                   thinking-only turns, tool ACTIVE/DONE/ERROR)
//   real-error    — same as real, but the result envelope carries
//                   status=ERROR together with a usable response
//   real-fail     — real shapes, "model overloaded" error envelope
//   exit-error    — stdout error envelope + exit 1 + empty stderr (the real
//                   silent-failure shape that hid causes behind "exited 1")
//   exit12        — exit code 12, no output
//   noise         — non-JSON stdout noise + an ok-shaped run (parser
//                   robustness: garbage lines must not kill the turn)
//   auth          — stderr sign-in notice + auth URL
//   hang          — emits nothing, keeps running until killed (watchdog /
//                   process-tree kill verification)
//   slow          — init, then FAKE_AGY_SILENCE_MS of pure silence, then a
//                   short text + result (SSE heartbeat verification)
//
// FAKE_AGY_EVENTS_FILE (any mode): when set, every line of that file is
// written to stdout verbatim and the process exits 0 — the golden-case
// runner replays recorded event sequences through this hook.
//
// Records its argv (JSON, one per line) to FAKE_AGY_ARGS_FILE when set;
// records cwd to FAKE_AGY_CWD_FILE when set.

import { appendFileSync, readFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const mode = process.env.FAKE_AGY_MODE ?? 'ok'
if (process.env.FAKE_AGY_ARGS_FILE) {
  try { appendFileSync(process.env.FAKE_AGY_ARGS_FILE, JSON.stringify(argv) + '\n') } catch {}
}
if (process.env.FAKE_AGY_CWD_FILE) {
  try { appendFileSync(process.env.FAKE_AGY_CWD_FILE, process.cwd() + '\n') } catch {}
}

if (argv[0] === '--version') {
  process.stdout.write('agy version 1.1.13-fake\n')
  process.exit(0)
}
if (argv[0] === 'models') {
  if (process.env.FAKE_AGY_MODELS === 'text') {
    process.stdout.write('gemini-3-6-flash    Gemini 3.6 Flash\ngemini-3-6-flash-high    Gemini 3.6 Flash High\nclaude-sonnet-4-6    Claude Sonnet 4.6\n')
  } else if (process.env.FAKE_AGY_MODELS === 'fail') {
    process.stderr.write('Error: Please sign in\n')
    process.exit(1)
  } else {
    process.stdout.write(JSON.stringify([
      { id: 'gemini-3-6-flash', display_name: 'Gemini 3.6 Flash' },
      { id: 'gemini-3-6-flash-high', display_name: 'Gemini 3.6 Flash High' },
      { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6' },
    ]))
  }
  process.exit(0)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')

const conv = argv.includes('--conversation')
  ? argv[argv.indexOf('--conversation') + 1]
  : 'conv-fresh-1'

if (mode === 'hang') {
  // Never prints, never exits: exercised by the watchdog and abort-kill
  // tests (process-tree kill must end this process).
  setInterval(() => {}, 1000)
  await new Promise(() => {})
}

if (mode === 'slow') {
  // SSE heartbeat drill (acceptance M2 DoD): a long silent stretch after
  // init, then a normal short run so the stream still completes.
  emit({ event: 'init', conversation_id: conv, model: 'gemini-3-6-flash' })
  await sleep(Number(process.env.FAKE_AGY_SILENCE_MS ?? 1000))
  emit({ event: 'step_update', step_update: { conversation_id: conv, step_index: 0, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'slow' } })
  emit({ event: 'step_update', step_update: { conversation_id: conv, step_index: 0, state: 'DONE', step_type: 'agent_response', text_delta: ' done', duration_seconds: 1, usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } } })
  emit({ event: 'result', result: { conversation_id: conv, status: 'DONE', response: 'slow done', duration_seconds: 1, num_turns: 1, usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } } })
  process.exit(0)
}

if (mode === 'exit12') {
  process.stderr.write('boom: fake crash\n')
  process.exit(12)
}

// Real failure shape seen in the wild (silent server-side errors): agy
// writes ONLY a result envelope with a human-readable error to stdout and
// exits 1 with empty stderr. Used to regress the bare "exited with code 1"
// message that hid the actual cause.
if (mode === 'exit-error') {
  emit({ event: 'result', result: { conversation_id: '', status: 'ERROR', response: '', error: 'upstream request failed while generating (request id 8f3ac2)', duration_seconds: 8.2, num_turns: 0, usage: { input_tokens: 0, output_tokens: 0 } } })
  process.exit(1)
}

await sleep(Number(process.env.FAKE_AGY_DELAY_MS ?? 0))

// Golden-case replay: dump the recorded event file verbatim.
if (process.env.FAKE_AGY_EVENTS_FILE) {
  try {
    const lines = readFileSync(process.env.FAKE_AGY_EVENTS_FILE, 'utf8').split('\n').filter((l) => l.trim() !== '')
    for (const line of lines) process.stdout.write(line + '\n')
  } catch {}
  process.exit(0)
}

if (mode === 'auth') {
  process.stderr.write('Please sign in. Visit https://accounts.google.com/o/oauth2/auth?access_type=offline&code=4/AbCdEf123 to authenticate, then paste the authorization code.\n')
  emit({ event: 'result', result: { conversation_id: '', status: 'ERROR', error: 'authentication failed or timed out' } })
  process.exit(0)
}

if (mode === 'noise') {
  process.stdout.write('⚠ fetching model catalog\n')
  emit({ event: 'init', conversation_id: conv, model: 'gemini-3-6-flash' })
  process.stdout.write('some progress noise\n')
} else if (mode === 'real' || mode === 'real-error' || mode === 'real-fail') {
  // Shapes captured from a live agy 1.1.15 binary
  // (`--output-format stream-json --mode plan --model ... --effort ...`).
  emit({ event: 'init', conversation_id: conv, init: { model: 'gemini-3-7-flash', cwd: '/tmp', tools: ['run_command', 'read_file'] } })
  emit({ event: 'step_update', step_update: { conversation_id: conv, step_index: 0, state: 'DONE', step_type: 'user_input' } })
  emit({ event: 'step_update', step_update: { conversation_id: conv, step_index: 1, state: 'DONE', step_type: 'checkpoint', duration_seconds: 0.1 } })
  // thinking-only turn: usage with thinking tokens, no text_delta
  emit({ event: 'step_update', step_update: { conversation_id: conv, step_index: 2, state: 'DONE', step_type: 'agent_response', duration_seconds: 1.2, usage: { input_tokens: 500, output_tokens: 40, thinking_tokens: 80, total_tokens: 540 } } })
  // tool call: ACTIVE announces parameters, DONE carries output
  emit({ event: 'step_update', step_update: { conversation_id: conv, step_index: 3, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'ls' } } } })
  emit({ event: 'step_update', step_update: { conversation_id: conv, step_index: 3, state: 'DONE', step_type: 'tool', duration_seconds: 0.3, tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'ls' }, output: 'note1.txt\nnote2.txt\n' } } })
  // failed tool call: state ERROR with tool_info.error
  emit({ event: 'step_update', step_update: { conversation_id: conv, step_index: 4, state: 'ACTIVE', step_type: 'tool', tool_name: 'find_by_name', tool_info: { name: 'find_by_name', parameters: { Pattern: 'note*.txt' } } } })
  emit({ event: 'step_update', step_update: { conversation_id: conv, step_index: 4, state: 'ERROR', step_type: 'tool', duration_seconds: 30, tool_name: 'find_by_name', tool_info: { name: 'find_by_name', parameters: { Pattern: 'note*.txt' }, error: { type: 'TOOL_ERROR', message: 'Find command timed out.' } } } })
  // streamed answer: sequential text_delta fragments across ACTIVE -> DONE
  emit({ event: 'step_update', step_update: { conversation_id: conv, step_index: 5, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'There are ' } })
  emit({ event: 'step_update', step_update: { conversation_id: conv, step_index: 5, state: 'ACTIVE', step_type: 'agent_response', text_delta: '2 files, ' } })
  emit({ event: 'step_update', step_update: { conversation_id: conv, step_index: 5, state: 'DONE', step_type: 'agent_response', text_delta: '6 words total.', duration_seconds: 2, usage: { input_tokens: 900, output_tokens: 60, thinking_tokens: 15, cache_read_tokens: 200, total_tokens: 960 } } })
  if (mode === 'real-fail') {
    emit({ event: 'result', result: { conversation_id: conv, status: 'ERROR', response: '', error: 'model overloaded', duration_seconds: 5, num_turns: 1, usage: { input_tokens: 100, output_tokens: 0 } } })
  } else if (mode === 'real') {
    emit({ event: 'result', result: { conversation_id: conv, status: 'DONE', response: 'There are 2 files, 6 words total.', duration_seconds: 5, num_turns: 1, usage: { input_tokens: 900, output_tokens: 100, thinking_tokens: 95, cache_read_tokens: 200, total_tokens: 1000 } } })
  } else {
    emit({ event: 'result', result: { conversation_id: conv, status: 'ERROR', response: 'There are 2 files, 6 words total.', error: 'Find command timed out. Use a more targeted search directory or pattern.: context deadline exceeded', duration_seconds: 5, num_turns: 1, usage: { input_tokens: 900, output_tokens: 100, thinking_tokens: 95, cache_read_tokens: 200, total_tokens: 1000 } } })
  }
  process.exit(0)
} else {
  emit({ event: 'init', conversation_id: conv, model: 'gemini-3-6-flash' })
}

emit({ event: 'step_update', idx: 1, step_type: 'thinking', text: 'Thinking...' })
emit({ event: 'step_update', idx: 1, step_type: 'thinking', text: 'Thinking... carefully' })
emit({ event: 'step_update', idx: 2, step_type: 'tool', tool_info: { name: 'read_file', parameters: { path: '/tmp/x' } } })
emit({ event: 'step_update', idx: 2, step_type: 'tool', tool_info: { name: 'read_file', parameters: { path: '/tmp/x' }, output: 'file contents here' } })
emit({ event: 'step_update', idx: 3, step_type: 'text', text: 'Hello' })
emit({ event: 'step_update', idx: 3, step_type: 'text', text: 'Hello from fake agy' })
emit({
  event: 'result',
  result: {
    conversation_id: conv,
    status: 'DONE',
    response: 'Hello from fake agy',
    usage: { input_tokens: 10, output_tokens: 5, thinking_tokens: 2, cache_read_tokens: 3 },
  },
})
process.exit(0)
