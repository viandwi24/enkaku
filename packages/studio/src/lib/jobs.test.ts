import { describe, expect, test } from 'bun:test'
import type { ArtifactInfo } from '@enkaku/protocol'
import { formatResult, isRunnerLog, outcomeLine, producedArtifacts } from './jobs'

/**
 * Plan 60 §3.5 and §3.4: each tab shows what it is for, and a job's outcome
 * is legible without opening a file.
 */

const artifact = (over: Partial<ArtifactInfo>): ArtifactInfo => ({
  id: crypto.randomUUID(),
  jobId: 'job-1',
  deviceId: null,
  kind: 'file',
  label: null,
  path: 'artifacts/job-1/1-file',
  sizeBytes: 10,
  createdAt: 0,
  ...over,
})

describe('the Artifacts list', () => {
  const screenshot = artifact({ kind: 'screenshot', label: 'page-loaded', path: 'artifacts/job-1/1-page-loaded.png' })
  const pulled = artifact({ kind: 'file', label: 'report', path: 'artifacts/job-1/2-report.json' })
  const runnerLog = artifact({ kind: 'log', label: 'job', path: 'artifacts/job-1/job.log' })
  const crashTrace = artifact({ kind: 'log', label: 'crash-com.android.chrome', path: 'artifacts/job-1/3-crash.log' })

  test('keeps what the script produced and drops the runner’s own log', () => {
    const listed = producedArtifacts([screenshot, runnerLog, pulled])
    expect(listed).toEqual([screenshot, pulled])
  })

  test('a crash trace is a log the RUN produced — it stays', () => {
    expect(producedArtifacts([runnerLog, crashTrace])).toEqual([crashTrace])
  })

  test('the Logs tab still finds the artefact it reads, by label and not merely by kind', () => {
    // The order matters: `find(a => a.kind === 'log')` would have picked the
    // crash trace and rendered a stack trace as the job's log.
    expect([crashTrace, runnerLog].find(isRunnerLog)).toBe(runnerLog)
  })
})

describe('outcomeLine', () => {
  test('a failure says where it failed', () => {
    expect(outcomeLine({ status: 'failed', errorPhase: 'run' })).toBe('Failed during run')
    expect(outcomeLine({ status: 'failed', errorPhase: 'prepare' })).toBe('Failed during prepare')
  })

  test('a job that failed before this plan existed still reads sensibly', () => {
    expect(outcomeLine({ status: 'failed', errorPhase: null })).toBe('Failed')
  })

  test('the other outcomes', () => {
    expect(outcomeLine({ status: 'success', errorPhase: null })).toBe('Succeeded')
    expect(outcomeLine({ status: 'cancelled', errorPhase: null })).toBe('Cancelled')
    expect(outcomeLine({ status: 'running', errorPhase: null, phase: 'run' })).toBe('Running (run)')
    expect(outcomeLine({ status: 'queued', errorPhase: null })).toBe('Queued')
    expect(outcomeLine({ status: 'expired', errorPhase: null })).toContain('Expired')
  })
})

describe('formatResult', () => {
  test('an object is pretty-printed', () => {
    // The very return value the script in plan 60 §0 produced, which until
    // now was visible only in SQLite.
    expect(formatResult({ ok: true, url: 'whoer.net' })).toBe('{\n  "ok": true,\n  "url": "whoer.net"\n}')
  })

  test('a plain string prints as itself', () => {
    expect(formatResult('103.186.169.250')).toBe('103.186.169.250')
  })

  test('a scalar still renders', () => {
    expect(formatResult(42)).toBe('42')
    expect(formatResult(false)).toBe('false')
  })
})
