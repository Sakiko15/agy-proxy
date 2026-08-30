// pino logger factory: NDJSON to stdout (charter §8). Redaction is the last
// line of defense against secret leakage — request/headers payloads must
// already be metadata-only at every log site (development.md §8), and any
// free-form engine text is passed through redactLine() by the caller.
// New code, not a port; the redaction paths follow the G4 gate discipline.
import pino from 'pino'

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  '*.authorization',
  '*.apiKey',
  '*.api_key',
]

export function buildLogger(
  env: NodeJS.ProcessEnv = process.env,
  destination?: pino.DestinationStream,
): pino.Logger {
  const level = env.AGY_PROXY_LOG_LEVEL ?? 'info'
  const options: pino.LoggerOptions = {
    level,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
  }
  return destination !== undefined ? pino(options, destination) : pino(options)
}
