import { describe, expect, test } from 'bun:test'
import { WarmupRowSchema as BrowserRowSchema } from './ui/shared'
import { WarmupRowSchema, runsFromPlan, type WarmupRow } from './warmup-rows'

/**
 * The browser mirrors schemas this plugin's service owns, and since 0.59.0 it
 * WRITES those rows too — Stop, Start again and Retry all run there, because
 * none of them needs a phone.
 *
 * That makes the mirror load-bearing in a way it was not before. A strict
 * mirror drops every field it does not model, so a browser write silently
 * destroyed `params` and `sequence`: the next dispatch of a retried activity
 * was refused by the farm with `query: required`, the step stayed pending, and
 * the phone's whole warm-up stalled with nothing on screen to explain it
 * (owner's farm, 2026-09-21).
 *
 * These tests exist so the next field the service gains cannot repeat it. They
 * are deliberately about the ROUND TRIP rather than about a list of fields: a
 * test that named `params` and `sequence` would pass while the field after
 * them went missing.
 */
const row = (): WarmupRow =>
  runsFromPlan({
    groupId: 'g1',
    runId: 'r1',
    startedAt: 1_800_000_000,
    phase: 0,
    sequence: 'workflow',
    assignments: [
      {
        deviceId: 'd1',
        platform: 'youtube',
        styleId: 'yt-c',
        styleTitle: 'Watch, home, a channel and the profile',
        note: null,
        steps: [{ activityId: 'a1', title: 'Open a channel', script: 'youtube/search-channel@latest', params: { query: 'trading' }, atSec: 0 }],
      },
    ],
  })[0] as WarmupRow

describe('the browser mirror of a warm-up row', () => {
  test('a row survives the browser round trip with every field intact', () => {
    const original = row()
    const asBrowserSawIt = BrowserRowSchema.parse(original)
    /*
      What the browser would write back. If the mirror drops anything, this is
      where the farm stops being able to dispatch the activity — and nothing
      anywhere says so.
    */
    expect(WarmupRowSchema.parse(asBrowserSawIt)).toEqual(original)
  })

  test("a step's params reach the other side, because the farm refuses a job without them", () => {
    const parsed = BrowserRowSchema.parse(row()) as unknown as WarmupRow
    expect(parsed.steps[0]?.params).toEqual({ query: 'trading' })
  })

  test('and so does the row\'s dispatch mode, which decides how the whole sequence goes out', () => {
    const parsed = BrowserRowSchema.parse(row()) as unknown as WarmupRow
    expect(parsed.sequence).toBe('workflow')
  })

  test('a field the service gains tomorrow survives too', () => {
    // The point of the loose mirror, stated as a test: this passes without
    // anybody adding the field to `ui/shared.ts`.
    const withFuture = { ...row(), somethingAddedLater: { deep: ['value'] } }
    const back = BrowserRowSchema.parse(withFuture) as Record<string, unknown>
    expect(back.somethingAddedLater).toEqual({ deep: ['value'] })
  })
})
