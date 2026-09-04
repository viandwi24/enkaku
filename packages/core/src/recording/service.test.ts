import { describe, expect, test } from 'bun:test'
import type { RecordingSettings } from '@enkaku/protocol'
import { createBlobStore } from '../agent/blob/store'
import { openDb, runMigrations, type Db } from '../db'
import { createLogger } from '../util/logger'
import { EnkakuError } from '../util/errors'
import { createRecordingService } from './service'

/**
 * `RecordingService` (plan 94 §4.6, step 94.3) — the per-farm registry: one
 * open recording per device, `E_RECORDING_ACTIVE` on a double-start,
 * `E_NO_RECORDING` on a stop with nothing open, the `onStep`/`onBoundStopped`
 * push registration, and `stopForDisconnect`.
 */

function db(): Db {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

const SETTINGS: RecordingSettings = {
  anchorQuietMs: 400,
  anchorMinIntervalMs: 1_500,
  longPressMs: 400,
  maxSteps: 500,
  maxDurationSec: 900,
  captureScreenshots: false,
}

function service(overrides: Partial<RecordingSettings> = {}) {
  return createRecordingService({
    settings: () => ({ ...SETTINGS, ...overrides }),
    blobs: createBlobStore(db()),
    log: createLogger('test'),
  })
}

function ctx() {
  return {
    recordedOn: { stableId: 's1', model: 'Pixel Test', width: 1080, height: 2400 },
    captureAnchor: async () => null,
    captureScreenshot: async () => null,
  }
}

describe('RecordingService.start', () => {
  test('opens a session with the given device id', () => {
    const svc = service()
    const rec = svc.start('dev-1', 'user-1', ctx())
    expect(rec.deviceId).toBe('dev-1')
    expect(rec.stepCount).toBe(0)
    expect(svc.get('dev-1')).toBe(rec)
  })

  test('E_RECORDING_ACTIVE on a device that already has one open', () => {
    const svc = service()
    svc.start('dev-1', 'user-1', ctx())
    expect(() => svc.start('dev-1', 'user-2', ctx())).toThrow(EnkakuError)
    try {
      svc.start('dev-1', 'user-2', ctx())
    } catch (err) {
      expect(err).toBeInstanceOf(EnkakuError)
      expect((err as EnkakuError).code).toBe('E_RECORDING_ACTIVE')
    }
  })

  test('a different device is unaffected by an active recording elsewhere', () => {
    const svc = service()
    svc.start('dev-1', 'user-1', ctx())
    expect(() => svc.start('dev-2', 'user-1', ctx())).not.toThrow()
  })

  test('get() returns null for a device with nothing open', () => {
    const svc = service()
    expect(svc.get('dev-1')).toBeNull()
  })
})

describe('RecordingService.stop / cancel', () => {
  test('stop() resolves the session into a document and frees the device for a new recording', async () => {
    const svc = service()
    const rec = svc.start('dev-1', 'user-1', ctx())
    rec.observe({ kind: 'key', keycode: 4 })
    const doc = await svc.stop('dev-1')
    expect(doc.steps).toHaveLength(1)
    expect(svc.get('dev-1')).toBeNull()
    expect(() => svc.start('dev-1', 'user-1', ctx())).not.toThrow()
  })

  test('E_NO_RECORDING when stopping a device with nothing open', async () => {
    const svc = service()
    await expect(svc.stop('dev-1')).rejects.toThrow(EnkakuError)
    await svc.stop('dev-1').catch((err) => {
      expect((err as EnkakuError).code).toBe('E_NO_RECORDING')
    })
  })

  test('cancel() on a device with nothing open is a harmless no-op', () => {
    const svc = service()
    expect(() => svc.cancel('dev-1')).not.toThrow()
  })

  test('cancel() discards — the device is free again with no document produced', () => {
    const svc = service()
    const rec = svc.start('dev-1', 'user-1', ctx())
    rec.observe({ kind: 'key', keycode: 4 })
    svc.cancel('dev-1')
    expect(svc.get('dev-1')).toBeNull()
    expect(svc.lastFinished('dev-1')).toBeNull()
  })
})

describe('RecordingService — onStep / onBoundStopped pushes', () => {
  test('onStep fires once per finished step, with the device id folded in', () => {
    const svc = service()
    const pushes: unknown[] = []
    svc.onStep((deviceId, index, kind, hasCandidate) => pushes.push({ deviceId, index, kind, hasCandidate }))
    const rec = svc.start('dev-1', 'user-1', ctx())
    rec.observe({ kind: 'key', keycode: 4 })
    rec.observe({ kind: 'key', keycode: 5 })
    expect(pushes).toEqual([
      { deviceId: 'dev-1', index: 0, kind: 'key', hasCandidate: false },
      { deviceId: 'dev-1', index: 1, kind: 'key', hasCandidate: false },
    ])
  })

  test('onBoundStopped fires when a bound ends a recording on its own, never on an explicit stop/cancel', async () => {
    const svc = service({ maxSteps: 1 })
    const calls: { deviceId: string; reason: string; steps: number }[] = []
    svc.onBoundStopped((deviceId, reason, doc) => calls.push({ deviceId, reason, steps: doc.steps.length }))
    const rec = svc.start('dev-1', 'user-1', ctx())
    rec.observe({ kind: 'key', keycode: 4 }) // hits maxSteps: 1
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toEqual([{ deviceId: 'dev-1', reason: 'max-steps', steps: 1 }])
    expect(svc.get('dev-1')).toBeNull() // the device is free again — no explicit stop() needed
    expect(svc.lastFinished('dev-1')?.steps).toHaveLength(1)
  })

  test('an explicit stop() never pushes through onBoundStopped — only a bound does', async () => {
    const svc = service() // default maxSteps: 500, well clear of one step
    const calls: string[] = []
    svc.onBoundStopped((_deviceId, reason) => calls.push(reason))
    const rec = svc.start('dev-1', 'user-1', ctx())
    rec.observe({ kind: 'key', keycode: 4 })
    await svc.stop('dev-1')
    expect(calls).toHaveLength(0)
  })
})

describe('RecordingService.stopForDisconnect', () => {
  test('ends an open recording with stoppedReason disconnected, via onBoundStopped', async () => {
    const svc = service()
    const calls: string[] = []
    svc.onBoundStopped((_deviceId, reason) => calls.push(reason))
    const rec = svc.start('dev-1', 'user-1', ctx())
    rec.observe({ kind: 'key', keycode: 4 })
    svc.stopForDisconnect('dev-1')
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toEqual(['disconnected'])
    expect(svc.get('dev-1')).toBeNull()
    expect(svc.lastFinished('dev-1')?.steps).toHaveLength(1)
  })

  test('a harmless no-op when nothing is open on that device', () => {
    const svc = service()
    expect(() => svc.stopForDisconnect('dev-1')).not.toThrow()
  })
})
