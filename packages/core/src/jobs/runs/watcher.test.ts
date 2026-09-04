import { describe, expect, test } from 'bun:test'
import { createRunWatcher } from './watcher'
import type { JobRunRow } from '../../db/schema'

function run(overrides: Partial<JobRunRow> = {}): JobRunRow {
  return {
    id: 'run-1',
    jobId: 'job-1',
    seq: 1,
    trigger: 'manual',
    status: 'running',
    deviceId: 'dev-1',
    scriptName: 'x',
    priority: 0,
    createdAt: new Date(),
    startedAt: null,
    finishedAt: null,
    heartbeatExpiresAt: null,
    expiresAt: null,
    notBefore: null,
    batchRepeat: null,
    pacedDelayMs: null,
    result: null,
    error: null,
    failureClass: null,
    errorPhase: null,
    infraAttempts: 0,
    peakRssBytes: null,
    maxConcurrent: null,
    runtimeOverride: null,
    resultStatus: null,
    resultBytes: null,
    resultSummary: null,
    resultIssues: null,
    resumedFromRunId: null,
    resumedFromStep: null,
    ...overrides,
  }
}

describe('RunWatcher (plan 211 §3.2 decision 14)', () => {
  test('a run that is already terminal resolves immediately', async () => {
    const settled = run({ status: 'success' })
    const watcher = createRunWatcher({ getRun: () => settled })
    const controller = new AbortController()
    const resolved = await watcher.waitForTerminal('run-1', controller.signal)
    expect(resolved.status).toBe('success')
  })

  test('a later notify resolves a waiter', async () => {
    const watcher = createRunWatcher({ getRun: () => run({ status: 'running' }) })
    const controller = new AbortController()
    const promise = watcher.waitForTerminal('run-1', controller.signal)
    watcher.notify(run({ status: 'failed' }))
    const resolved = await promise
    expect(resolved.status).toBe('failed')
  })

  test('an aborted signal rejects with job_cancelled', async () => {
    const watcher = createRunWatcher({ getRun: () => run({ status: 'running' }) })
    const controller = new AbortController()
    const promise = watcher.waitForTerminal('run-1', controller.signal)
    controller.abort()
    await expect(promise).rejects.toThrow('job_cancelled')
  })

  test('a notify for an unknown id is ignored', () => {
    const watcher = createRunWatcher({ getRun: () => run({ status: 'running' }) })
    expect(() => watcher.notify(run({ id: 'unknown', status: 'success' }))).not.toThrow()
  })
})
