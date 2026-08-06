import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createJobLogger, type JobLogEntry } from './job-logger'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'enkaku-job-logger-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('createJobLogger — secret redaction (plan 79 §4.7)', () => {
  test('without a redact dep, msg and fields pass through unchanged', () => {
    const entries: JobLogEntry[] = []
    const logger = createJobLogger({ dataDir: dir, jobId: 'j1', onEntry: (e) => entries.push(e) })
    logger.append('info', 'script', 'token=sk-secret-value', { token: 'sk-secret-value' })
    expect(entries[0]?.msg).toBe('token=sk-secret-value')
    expect(entries[0]?.fields).toEqual({ token: 'sk-secret-value' })
  })

  test('redacts the secret out of msg before it reaches onEntry (the broadcast) or the file', async () => {
    const entries: JobLogEntry[] = []
    const redact = (text: string) => text.split('sk-secret-value').join('«redacted:token»')
    const logger = createJobLogger({ dataDir: dir, jobId: 'j2', onEntry: (e) => entries.push(e), redact })
    logger.append('info', 'script', 'the token is sk-secret-value, use it')
    expect(entries[0]?.msg).toBe('the token is «redacted:token», use it')
    expect(entries[0]?.msg).not.toContain('sk-secret-value')

    const { bytes } = await logger.close()
    const text = new TextDecoder().decode(bytes)
    expect(text).not.toContain('sk-secret-value')
    expect(text).toContain('«redacted:token»')
  })

  test('redacts a secret carried inside `fields`, not just `msg`', async () => {
    const entries: JobLogEntry[] = []
    const redact = (text: string) => text.split('sk-secret-value').join('«redacted:token»')
    const logger = createJobLogger({ dataDir: dir, jobId: 'j3', onEntry: (e) => entries.push(e), redact })
    logger.append('info', 'script', 'token', { token: 'sk-secret-value' })
    expect(entries[0]?.fields).toEqual({ token: '«redacted:token»' })

    const { bytes } = await logger.close()
    expect(new TextDecoder().decode(bytes)).not.toContain('sk-secret-value')
  })
})
