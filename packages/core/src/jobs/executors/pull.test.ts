import { describe, expect, test } from 'bun:test'
import type { JobRow } from '../../db/schema'
import type { TransferService } from '../../device/transfer'
import type { Logger } from '../../util/logger'
import type { ExecutorContext } from '../executor'
import { createPullExecutor } from './pull'

/** Same shape as `install.test.ts`'s `silentLog()`. */
const silentLog = (): Logger => {
  const l = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => l }
  return l as unknown as Logger
}

function fakeCtx(signal: AbortSignal = new AbortController().signal): ExecutorContext {
  return { signal, heartbeat: () => {}, log: silentLog() }
}

describe('createPullExecutor', () => {
  test('declares the same files/transfer.enabled gate as internal:install (plan 93 §4.6, step 93.8, 93.9)', () => {
    const executor = createPullExecutor({ transfer: {} as TransferService, broadcast: { progress() {}, done() {} } })
    expect(executor.requires).toEqual({ gate: 'files', setting: 'transfer.enabled' })
  })

  test('validateParams rejects a body without remotePath', () => {
    const executor = createPullExecutor({ transfer: {} as TransferService, broadcast: { progress() {}, done() {} } })
    expect(() => executor.validateParams({}, 'internal:pull')).toThrow()
  })

  test('validateParams accepts { remotePath }', () => {
    const executor = createPullExecutor({ transfer: {} as TransferService, broadcast: { progress() {}, done() {} } })
    expect(executor.validateParams({ remotePath: '/sdcard/report.txt' }, 'internal:pull')).toEqual({ remotePath: '/sdcard/report.txt' })
  })

  test('run() delegates to TransferService.pull with the job device AND threads job.id as opts.jobId (plan 93 §3.13, §4.6, F12) — the whole point: without it, a bulk pull\'s artifacts cannot be traced back to the run that produced them', async () => {
    const progressCalls: unknown[] = []
    const doneCalls: unknown[] = []
    let pullCalledWith: unknown
    const transfer: TransferService = {
      async install() {
        return { package: null, durationMs: 0, output: '' }
      },
      async push() {
        return { mediaScan: { ran: false, method: null, ms: 0 } }
      },
      async pull(deviceId, remotePath, opts) {
        pullCalledWith = { deviceId, remotePath, jobId: opts.jobId }
        opts.onProgress?.(10, 10)
        return { artifactId: 'art-1', bytes: 10 }
      },
      cancel() {},
    }
    const executor = createPullExecutor({
      transfer,
      broadcast: {
        progress: (...args) => progressCalls.push(args),
        done: (...args) => doneCalls.push(args),
      },
    })
    const job = { id: 'job-xyz', deviceId: 'dev1', params: { remotePath: '/sdcard/report.txt' } } as unknown as JobRow
    const result = await executor.run(job, fakeCtx())
    expect(result).toEqual({ artifactId: 'art-1', bytes: 10 })
    expect(pullCalledWith).toEqual({ deviceId: 'dev1', remotePath: '/sdcard/report.txt', jobId: 'job-xyz' })
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
      async push() {
        return { mediaScan: { ran: false, method: null, ms: 0 } }
      },
      async pull() {
        controller.abort()
        await Bun.sleep(1)
        throw Object.assign(new Error('cancelled'), { code: 'E_TRANSFER_CANCELLED' })
      },
      cancel(transferId) {
        cancelledId = transferId
      },
    }
    const executor = createPullExecutor({ transfer, broadcast: { progress() {}, done() {} } })
    const job = { id: 'job1', deviceId: 'dev1', params: { remotePath: '/sdcard/report.txt' } } as unknown as JobRow
    await expect(executor.run(job, fakeCtx(controller.signal))).rejects.toBeDefined()
    expect(cancelledId).not.toBeNull()
  })
})
