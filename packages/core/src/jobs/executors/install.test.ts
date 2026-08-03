import { describe, expect, test } from 'bun:test'
import type { JobRow } from '../../db/schema'
import type { TransferService } from '../../device/transfer'
import type { Logger } from '../../util/logger'
import type { ExecutorContext } from '../executor'
import { createInstallExecutor } from './install'

/** Same shape as `executor-host.test.ts`'s `silentLog()` — a `Logger` that discards everything. */
const silentLog = (): Logger => {
  const l = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => l }
  return l as unknown as Logger
}

function fakeCtx(signal: AbortSignal = new AbortController().signal): ExecutorContext {
  return { signal, heartbeat: () => {}, log: silentLog() }
}

describe('createInstallExecutor', () => {
  test('validateParams rejects a body without artifactId', () => {
    const executor = createInstallExecutor({
      transfer: {} as TransferService,
      broadcast: { progress() {}, done() {} },
    })
    expect(() => executor.validateParams({})).toThrow()
  })

  test('validateParams accepts { artifactId }', () => {
    const executor = createInstallExecutor({
      transfer: {} as TransferService,
      broadcast: { progress() {}, done() {} },
    })
    expect(executor.validateParams({ artifactId: 'a1' })).toEqual({ artifactId: 'a1' })
  })

  test('run() delegates to TransferService.install with the job device and broadcasts progress/done', async () => {
    const progressCalls: unknown[] = []
    const doneCalls: unknown[] = []
    let installCalledWith: unknown
    const transfer: TransferService = {
      async install(deviceId, artifactId, opts) {
        installCalledWith = { deviceId, artifactId }
        opts.onProgress?.(10, 10)
        return { package: 'com.example', durationMs: 5, output: 'Success' }
      },
      async push() {},
      async pull() {
        return { artifactId: 'x', bytes: 0 }
      },
      cancel() {},
    }
    const executor = createInstallExecutor({
      transfer,
      broadcast: {
        progress: (...args) => progressCalls.push(args),
        done: (...args) => doneCalls.push(args),
      },
    })
    const job = { id: 'job1', deviceId: 'dev1', params: { artifactId: 'apk1' } } as unknown as JobRow
    const result = await executor.run(job, fakeCtx())
    expect(result).toEqual({ package: 'com.example', durationMs: 5, output: 'Success' })
    expect(installCalledWith).toEqual({ deviceId: 'dev1', artifactId: 'apk1' })
    expect(progressCalls.length).toBe(1)
    expect(doneCalls.length).toBe(1)
  })

  test('run() cancels the transfer when ctx.signal aborts', async () => {
    const controller = new AbortController()
    let cancelledId: string | null = null
    const transfer: TransferService = {
      async install(_deviceId, _artifactId, opts) {
        controller.abort()
        await Bun.sleep(1)
        throw Object.assign(new Error('cancelled'), { code: 'E_TRANSFER_CANCELLED' })
      },
      async push() {},
      async pull() {
        return { artifactId: 'x', bytes: 0 }
      },
      cancel(transferId) {
        cancelledId = transferId
      },
    }
    const executor = createInstallExecutor({ transfer, broadcast: { progress() {}, done() {} } })
    const job = { id: 'job1', deviceId: 'dev1', params: { artifactId: 'apk1' } } as unknown as JobRow
    await expect(executor.run(job, fakeCtx(controller.signal))).rejects.toBeDefined()
    expect(cancelledId).not.toBeNull()
  })
})
