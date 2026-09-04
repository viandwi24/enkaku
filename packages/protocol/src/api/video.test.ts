import { describe, expect, test } from 'bun:test'
import { VideoReprofileResponseSchema, VideoSessionsResponseSchema, type VideoSessionsResponse } from './video'

/**
 * `VideoReprofileResponseSchema` (plan 92 §3.8, §4.5, §5 step 92.2) —
 * `POST /api/video/reprofile`'s response shape, shared verbatim by the
 * manual "apply now" route and (through `SessionManager.reprofile` itself,
 * proven in `packages/session/src/manager.test.ts`) the automatic debounced
 * path in `daemon.ts`.
 */
describe('VideoReprofileResponseSchema', () => {
  test('parses a typical restart result', () => {
    const body = { restarted: ['dev-1', 'dev-2'], skippedBusy: ['dev-3'], unchanged: 5 }
    expect(VideoReprofileResponseSchema.parse(body)).toEqual(body)
  })

  test('parses the all-quiet result — nothing restarted, nothing skipped', () => {
    const body = { restarted: [], skippedBusy: [], unchanged: 0 }
    expect(VideoReprofileResponseSchema.parse(body)).toEqual(body)
  })

  test('rejects a non-integer unchanged count', () => {
    expect(() => VideoReprofileResponseSchema.parse({ restarted: [], skippedBusy: [], unchanged: 1.5 })).toThrow()
  })

  test('rejects a missing field', () => {
    expect(() => VideoReprofileResponseSchema.parse({ restarted: [], unchanged: 0 })).toThrow()
  })
})

/** `GET /api/video/sessions` (plan 206 §4.6). */
describe('VideoSessionsResponseSchema', () => {
  test('parses a sample response — one ready device with a wall entry, one still preparing', () => {
    const body: VideoSessionsResponse = {
      devices: [
        {
          deviceId: 'dev-1',
          number: 1,
          state: 'ready',
          step: null,
          attempt: 0,
          usbRoot: '3',
          wall: {
            engine: 'scrcpy',
            maxSize: 480,
            maxFps: 15,
            bitRate: 1_000_000,
            viewers: 2,
            bytesPerSec: 12_000,
            framesPerSec: 4,
            sinceSec: 120,
            lingerEndsAt: null,
          },
          control: null,
        },
        {
          deviceId: 'dev-2',
          number: 2,
          state: 'preparing',
          step: 3,
          attempt: 0,
          usbRoot: '3',
          wall: null,
          control: null,
        },
      ],
      builder: { running: 1, queued: 0, perRoot: { '3': { running: 1, queued: 0 } }, buildsPerUsbRoot: 4, farmCeiling: 16 },
      rssBytes: 123_456_789,
    }
    expect(VideoSessionsResponseSchema.parse(body)).toEqual(body)
  })

  test('rejects an out-of-range step', () => {
    const bad = {
      devices: [{ deviceId: 'dev-1', number: 1, state: 'preparing', step: 6, attempt: 0, usbRoot: null, wall: null, control: null }],
      builder: { running: 0, queued: 0, perRoot: {}, buildsPerUsbRoot: 4, farmCeiling: 16 },
      rssBytes: 0,
    }
    expect(() => VideoSessionsResponseSchema.parse(bad)).toThrow()
  })
})
