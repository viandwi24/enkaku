import { describe, expect, test } from 'bun:test'
import type { JobRow } from '../../db/schema'
import type { TransferService } from '../../device/transfer'
import type { Logger } from '../../util/logger'
import type { ExecutorContext } from '../executor'
import { createPushExecutor } from './push'

/** Same shape as `install.test.ts`'s `silentLog()`. */
const silentLog = (): Logger => {
  const l = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => l }
  return l as unknown as Logger
}

const FAKE_RUN: import('../../db/schema').JobRunRow = {
  id: 'run-1',
  jobId: 'job-1',
  seq: 1,
  trigger: 'manual',
  status: 'running',
  deviceId: 'dev-1',
  scriptName: null,
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
}

function fakeCtx(signal: AbortSignal = new AbortController().signal): ExecutorContext {
  return { signal, runId: FAKE_RUN.id, run: FAKE_RUN, heartbeat: () => {}, log: silentLog() }
}

describe('createPushExecutor', () => {
  test('declares the same files/transfer.enabled gate as internal:install (plan 93 §4.6, step 93.8, 93.9)', () => {
    const executor = createPushExecutor({ transfer: {} as TransferService, broadcast: { progress() {}, done() {} } })
    expect(executor.requires).toEqual({ gate: 'files', setting: 'transfer.enabled' })
  })

  test('validateParams rejects a body missing artifactId or remotePath', () => {
    const executor = createPushExecutor({ transfer: {} as TransferService, broadcast: { progress() {}, done() {} } })
    expect(() => executor.validateParams({}, 'internal:push')).toThrow()
    expect(() => executor.validateParams({ artifactId: 'a1' }, 'internal:push')).toThrow()
    expect(() => executor.validateParams({ remotePath: '/sdcard/x' }, 'internal:push')).toThrow()
  })

  test('validateParams accepts { artifactId, remotePath }', () => {
    const executor = createPushExecutor({ transfer: {} as TransferService, broadcast: { progress() {}, done() {} } })
    expect(executor.validateParams({ artifactId: 'a1', remotePath: '/sdcard/x' }, 'internal:push')).toEqual({ artifactId: 'a1', remotePath: '/sdcard/x' })
  })

  test('run() delegates to TransferService.push with the job device and broadcasts progress/done', async () => {
    const progressCalls: unknown[] = []
    const doneCalls: unknown[] = []
    let pushCalledWith: unknown
    const transfer: TransferService = {
      async install() {
        return { package: null, durationMs: 0, output: '' }
      },
      async installFromLocalApk() {
        throw new Error('not exercised by this test')
      },
      async push(deviceId, artifactId, remotePath, opts) {
        pushCalledWith = { deviceId, artifactId, remotePath }
        opts.onProgress?.(10, 10)
        return { mediaScan: { ran: false, method: null, ms: 0 } }
      },
      async pull() {
        return { artifactId: 'x', bytes: 0 }
      },
      cancel() {},
    }
    const executor = createPushExecutor({
      transfer,
      broadcast: {
        progress: (...args) => progressCalls.push(args),
        done: (...args) => doneCalls.push(args),
      },
    })
    const job = { id: 'job1', deviceId: 'dev1', params: { artifactId: 'a1', remotePath: '/sdcard/x' } } as unknown as JobRow
    const result = await executor.run(job, fakeCtx())
    expect(result).toEqual({ mediaScan: { ran: false, method: null, ms: 0 } })
    expect(pushCalledWith).toEqual({ deviceId: 'dev1', artifactId: 'a1', remotePath: '/sdcard/x' })
    expect(progressCalls.length).toBe(1)
    expect(doneCalls.length).toBe(1)
  })

  test('run() cancels the transfer when ctx.signal aborts', async () => {
    const controller = new AbortController()
    let cancelledId: string | null = null
    const transfer: TransferService = {
      async install() {
        return { package: null, durationMs: 0, output: '' }
      },
      async installFromLocalApk() {
        throw new Error('not exercised by this test')
      },
      async push() {
        controller.abort()
        await Bun.sleep(1)
        throw Object.assign(new Error('cancelled'), { code: 'E_TRANSFER_CANCELLED' })
      },
      async pull() {
        return { artifactId: 'x', bytes: 0 }
      },
      cancel(transferId) {
        cancelledId = transferId
      },
    }
    const executor = createPushExecutor({ transfer, broadcast: { progress() {}, done() {} } })
    const job = { id: 'job1', deviceId: 'dev1', params: { artifactId: 'a1', remotePath: '/sdcard/x' } } as unknown as JobRow
    await expect(executor.run(job, fakeCtx(controller.signal))).rejects.toBeDefined()
    expect(cancelledId).not.toBeNull()
  })
})
