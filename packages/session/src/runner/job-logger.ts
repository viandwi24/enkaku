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
  /** Tutup file & kembalikan isi log untuk didaftarkan sebagai artifact. */
  close(): Promise<{ path: string; bytes: Uint8Array }>
}

/**
 * Log per job: JSON-lines ke `<app-data>/artifacts/<job-id>/job.log`
 * + fan-out WS realtime (plan 05 §4.8).
 */
export function createJobLogger(deps: {
  dataDir: string
  jobId: string
  onEntry: (entry: JobLogEntry) => void
}): JobLogger {
  const dir = join(deps.dataDir, 'artifacts', deps.jobId)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'job.log')
  const lines: string[] = []

  return {
    append(level, source, msg, fields) {
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
