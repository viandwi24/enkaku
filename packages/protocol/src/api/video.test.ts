import { describe, expect, test } from 'bun:test'
import { VideoReprofileResponseSchema } from './video'

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
