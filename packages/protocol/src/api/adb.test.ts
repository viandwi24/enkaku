import { describe, expect, test } from 'bun:test'
import { AdbStatsResponseSchema } from './adb'

/** A minimal, otherwise-valid `/api/adb/stats` body — every field this schema required before plan 92. */
function baseBody() {
  return {
    global: { maxConcurrent: 4, auto: true, inFlight: 0, waiting: 0 },
    streams: { maxStreams: 4, maxStreamsPerDevice: 1, active: 0, pinned: 0, perDevice: {} },
    devices: [],
    transport: {
      connections: 0,
      bufferedBytesMax: 0,
      bufferedBytesP95: 0,
      videoBytesPerSec: 0,
      controlReplyMsP50: 0,
      controlReplyMsP95: 0,
      watchdogReconnects: 0,
    },
    hostAdb: { running: 0, maxConcurrent: 0, installsRunning: 0, longLived: 0 },
    adbHealth: {
      status: 'ok' as const,
      versionRttMs: null,
      lastCheckedAt: 0,
      window: { seconds: 0, execs: 0, timeouts: 0, timeoutRate: 0 },
      wedged: [],
      stuckOffline: [],
      symptoms: [],
      restartAdvised: false,
    },
  }
}

/**
 * `AdbStatsResponseSchema.video` (plan 92 §3.3, §4.5, §5 step 92.3) — the
 * build lane's own occupancy plus live streams by quality. `.optional()`
 * for the SAME reason `input` is (`adb.ts`'s own comment on the field):
 * Studio's `AdbServerCard.test.tsx` fixture predates this field and this
 * step's file ownership excludes `packages/studio/**`, so the WIRE schema
 * must still validate a body with no `video` block at all — the real
 * running core always sends one regardless (`adb-stats.ts`'s `ZERO_VIDEO`).
 */
describe('AdbStatsResponseSchema.video (plan 92 §3.3, §4.5)', () => {
  test('parses a fully-populated video block', () => {
    const body = {
      ...baseBody(),
      video: {
        controlStreams: 3,
        wallStreams: 12,
        buildsRunning: 2,
        buildQueueDepth: 5,
        buildsPerUsbRoot: 4,
        farmCeiling: 16,
        maxTiles: 25,
        maxTilesAuto: true,
        transport: 'loopback' as const,
      },
    }
    const parsed = AdbStatsResponseSchema.parse(body)
    expect(parsed.video).toEqual(body.video)
  })

  test('is optional — a body with no video block at all still parses (Studio fixture compatibility, matching `input` above it)', () => {
    const body = baseBody()
    const parsed = AdbStatsResponseSchema.parse(body)
    expect(parsed.video).toBeUndefined()
  })

  test('rejects a video block with a non-integer field', () => {
    const body = {
      ...baseBody(),
      video: {
        controlStreams: 1.5,
        wallStreams: 0,
        buildsRunning: 0,
        buildQueueDepth: 0,
        buildsPerUsbRoot: 4,
        farmCeiling: 16,
        maxTiles: 8,
        maxTilesAuto: false,
      },
    }
    expect(() => AdbStatsResponseSchema.parse(body)).toThrow()
  })
})

/**
 * Plan 223 §4.5, §5 step 223.4 — the forward ledger, per-USB-root install
 * occupancy, and the cumulative dropped-frame counter. All three follow the
 * SAME `.optional()` convention `input`/`video` above already established:
 * a consumer built before this field lands must keep parsing.
 */
describe('AdbStatsResponseSchema — plan 223 additions', () => {
  test('accepts a sample forwards array', () => {
    const body = {
      ...baseBody(),
      forwards: [{ deviceId: 'dev-1', quality: 'wall' as const, port: 27500, scid: '7f00aabb', openedAt: 12345 }],
    }
    const parsed = AdbStatsResponseSchema.parse(body)
    expect(parsed.forwards).toEqual(body.forwards)
  })

  test('accepts hostAdb.installsByRoot', () => {
    const body = {
      ...baseBody(),
      hostAdb: { ...baseBody().hostAdb, installsByRoot: { 'usb-1': { running: 1, queued: 2 } } },
    }
    const parsed = AdbStatsResponseSchema.parse(body)
    expect(parsed.hostAdb.installsByRoot).toEqual({ 'usb-1': { running: 1, queued: 2 } })
  })

  test('accepts transport.framesDroppedTotal', () => {
    const body = {
      ...baseBody(),
      transport: { ...baseBody().transport, framesDroppedTotal: 7 },
    }
    const parsed = AdbStatsResponseSchema.parse(body)
    expect(parsed.transport.framesDroppedTotal).toBe(7)
  })

  test('still parses a response with none of the three fields present', () => {
    const parsed = AdbStatsResponseSchema.parse(baseBody())
    expect(parsed.forwards).toBeUndefined()
    expect(parsed.hostAdb.installsByRoot).toBeUndefined()
    expect(parsed.transport.framesDroppedTotal).toBeUndefined()
  })
})
