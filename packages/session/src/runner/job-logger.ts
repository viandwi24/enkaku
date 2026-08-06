import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

export type LogSource = 'script' | 'stdout' | 'stderr' | 'runner'
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface JobLogEntry {
  jobId: string
  ts: number
  level: LogLevel
  source: LogSource
  msg: string
  fields?: Record<string, unknown>
}

export interface JobLogger {
  append(level: LogLevel, source: LogSource, msg: string, fields?: Record<string, unknown>): void
  /** Close the file and return the log contents to register as an artifact. */
  close(): Promise<{ path: string; bytes: Uint8Array }>
}

/**
 * Per-job log: JSON-lines written to `<app-data>/artifacts/<job-id>/job.log`
 * plus a realtime WS fan-out (plan 05 §4.8).
 */
export function createJobLogger(deps: {
  dataDir: string
  jobId: string
  onEntry: (entry: JobLogEntry) => void
  /**
   * Best-effort secret redaction (plan 79 §4.7) — applied to `msg` and to every string value
   * inside `fields` BEFORE a line is written to disk or broadcast, so a script that does
   * `ctx.log.info('token', { token })` does not put the plaintext the encryption was protecting
   * it from into the exact place that encryption cannot reach. Undefined on a host with no kv
   * store wired (matches every other optional dependency in this package).
   */
  redact?: (text: string) => string
}): JobLogger {
  const dir = join(deps.dataDir, 'artifacts', deps.jobId)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'job.log')
  const lines: string[] = []

  /** Applies `deps.redact` to `fields`' string values via a JSON round-trip — simple, and it
   * covers the common case (`ctx.log.info('token', { token })`) without walking every nested
   * shape by hand. If the round-trip somehow fails to parse back (a redaction landed on a JSON
   * structural character), `fields` is dropped rather than risk emitting the ORIGINAL, unredacted
   * object — correctness of the redaction matters more than keeping the extra fields. */
  function redactFields(fields: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    if (!fields || !deps.redact) return fields
    try {
      return JSON.parse(deps.redact!(JSON.stringify(fields))) as Record<string, unknown>
    } catch {
      return { redacted: true }
    }
  }

  return {
    append(level, source, rawMsg, rawFields) {
      const msg = deps.redact ? deps.redact(rawMsg) : rawMsg
      const fields = redactFields(rawFields)
      const entry: JobLogEntry = {
        jobId: deps.jobId,
        ts: Date.now(),
        level,
        source,
        msg,
        ...(fields ? { fields } : {}),
      }
      lines.push(JSON.stringify({ ts: entry.ts, level, source, msg, ...(fields ? { fields } : {}) }))
      deps.onEntry(entry)
    },

    async close() {
      const text = lines.join('\n') + (lines.length > 0 ? '\n' : '')
      const bytes = new TextEncoder().encode(text)
      await Bun.write(path, bytes)
      return { path, bytes }
    },
  }
}
