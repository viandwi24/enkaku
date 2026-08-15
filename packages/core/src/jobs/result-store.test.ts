import { describe, expect, test } from 'bun:test'
import type { ResultOutcome, SummaryField } from '@enkaku/protocol'
import { recordResult } from './result-store'

const NO_SUMMARY: SummaryField[] = []
const MAX = 65_536

/**
 * `result-store.ts`'s `recordResult` — plan 97 §4.5, "the one place the
 * parent turns a child's verdict into columns". Pure, unit-tested alone: no
 * DB, no IPC, no child process — every case here is a plain object in, a
 * plain object out.
 */
describe('recordResult — no outcome at all (plan 59: an older bundle/node meeting a newer core is a normal condition)', () => {
  test('a missing outcome is treated as undeclared, and bytes are measured fresh from the value', () => {
    const recorded = recordResult({ value: { videos: 3 }, outcome: undefined, summary: NO_SUMMARY, maxResultBytes: MAX })!
    expect(recorded.resultStatus).toBe('undeclared')
    expect(recorded.result).toEqual({ videos: 3 })
    expect(recorded.resultBytes).toBe(new TextEncoder().encode(JSON.stringify({ videos: 3 })).length)
    expect(recorded.resultIssues).toBeNull()
  })

  test('a missing outcome with an undefined value (no executor produced one) still returns a total, non-throwing result', () => {
    const recorded = recordResult({ value: undefined, outcome: undefined, summary: NO_SUMMARY, maxResultBytes: MAX })!
    expect(recorded.resultStatus).toBe('undeclared')
    expect(recorded.result).toBeNull()
    expect(recorded.resultBytes).toBe(0)
  })
})

describe('recordResult — the child kept its word (§3.3 valid/invalid/undeclared)', () => {
  test('valid: the value passes through verbatim, no issues', () => {
    const value = { videos: 312, watchSeconds: 2520 }
    const outcome: ResultOutcome = { status: 'valid', bytes: 40 }
    const recorded = recordResult({ value, outcome, summary: NO_SUMMARY, maxResultBytes: MAX })!
    expect(recorded.resultStatus).toBe('valid')
    expect(recorded.result).toBe(value) // same reference — never reshaped (§3.3)
    expect(recorded.resultIssues).toBeNull()
  })

  test('invalid: the value is STILL stored verbatim — never coerced, never stripped (§3.3, F25)', () => {
    const value = { videos: 'not-a-number', extra: 'kept' }
    const outcome: ResultOutcome = { status: 'invalid', bytes: 30, issues: [{ path: 'videos', message: 'expected number, received string' }] }
    const recorded = recordResult({ value, outcome, summary: NO_SUMMARY, maxResultBytes: MAX })!
    expect(recorded.resultStatus).toBe('invalid')
    expect(recorded.result).toEqual(value)
    expect(recorded.resultIssues).toEqual([{ path: 'videos', message: 'expected number, received string' }])
  })

  test('undeclared: no result schema, the child still measured and reported', () => {
    const value = 'ok'
    const outcome: ResultOutcome = { status: 'undeclared', bytes: 4 }
    const recorded = recordResult({ value, outcome, summary: NO_SUMMARY, maxResultBytes: MAX })!
    expect(recorded.resultStatus).toBe('undeclared')
    expect(recorded.result).toBe('ok')
  })

  test('issues present only when the status is invalid — a valid/undeclared outcome never carries them even if (incorrectly) sent', () => {
    const outcome: ResultOutcome = { status: 'valid', bytes: 4, issues: [{ path: 'x', message: 'should not appear' }] }
    const recorded = recordResult({ value: 'ok', outcome, summary: NO_SUMMARY, maxResultBytes: MAX })!
    expect(recorded.resultIssues).toBeNull()
  })
})

describe('recordResult — oversize (§3.4)', () => {
  test('the child already refused to send a value — result is null, bytes come from the child\'s own report', () => {
    const outcome: ResultOutcome = { status: 'oversize', bytes: 52_428_800 }
    const recorded = recordResult({ value: undefined, outcome, summary: NO_SUMMARY, maxResultBytes: MAX })!
    expect(recorded.resultStatus).toBe('oversize')
    expect(recorded.result).toBeNull()
    expect(recorded.resultBytes).toBe(52_428_800)
    expect(recorded.resultSummary).toBeNull()
  })

  test('the child\'s own byte count is trusted for oversize even when the caller passes a non-undefined value — `executors/script.ts` normalises an absent value to `null` before this function ever sees it, so `null` cannot mean "received" when the outcome itself says oversize', () => {
    const outcome: ResultOutcome = { status: 'oversize', bytes: 52_428_800 }
    const recorded = recordResult({ value: null, outcome, summary: NO_SUMMARY, maxResultBytes: MAX })!
    expect(recorded.resultStatus).toBe('oversize')
    expect(recorded.result).toBeNull()
    expect(recorded.resultBytes).toBe(52_428_800)
  })
})

describe('recordResult — the parent re-checks what it can cheaply and independently know (§3.8)', () => {
  test('a child claiming "valid" for a value that is, independently, over the cap is overridden to oversize, and the value is dropped', () => {
    const bigValue = { blob: 'x'.repeat(200) }
    const outcome: ResultOutcome = { status: 'valid', bytes: 5 } // the child's own claim is wrong/stale
    const recorded = recordResult({ value: bigValue, outcome, summary: NO_SUMMARY, maxResultBytes: 50 })!
    expect(recorded.resultStatus).toBe('oversize')
    expect(recorded.result).toBeNull()
    // The PARENT's own measurement wins, not the child's stale claim.
    expect(recorded.resultBytes).toBeGreaterThan(50)
  })

  test('a value under the cap is never touched, even when the outcome claims a wildly different byte count', () => {
    const value = { ok: true }
    const outcome: ResultOutcome = { status: 'valid', bytes: 999_999 } // deliberately wrong
    const recorded = recordResult({ value, outcome, summary: NO_SUMMARY, maxResultBytes: MAX })!
    expect(recorded.resultStatus).toBe('valid')
    expect(recorded.resultBytes).toBe(new TextEncoder().encode(JSON.stringify(value)).length)
  })

  test('a malformed/unrecognised status string falls back to undeclared rather than propagating garbage', () => {
    const outcome = { status: 'weird-future-status', bytes: 4 } as unknown as ResultOutcome
    const recorded = recordResult({ value: 'ok', outcome, summary: NO_SUMMARY, maxResultBytes: MAX })!
    expect(recorded.resultStatus).toBe('undeclared')
  })
})

describe('recordResult — issue truncation (defensive re-application of the IPC-layer cap)', () => {
  test('issues beyond RESULT_LIMITS.maxIssues are truncated, and an overlong message is truncated with an ellipsis', () => {
    const issues = Array.from({ length: 25 }, (_, i) => ({ path: `f${i}`, message: 'x'.repeat(250) }))
    const outcome: ResultOutcome = { status: 'invalid', bytes: 4, issues }
    const recorded = recordResult({ value: 'ok', outcome, summary: NO_SUMMARY, maxResultBytes: MAX })!
    expect(recorded.resultIssues).not.toBeNull()
    expect(recorded.resultIssues?.length).toBe(20)
    for (const issue of recorded.resultIssues ?? []) {
      expect(issue.message.length).toBeLessThanOrEqual(200)
      expect(issue.message.endsWith('…')).toBe(true)
    }
  })
})

describe('recordResult — resultSummary (§3.6)', () => {
  test('null when no fields are marked summary, even for a valid result', () => {
    const outcome: ResultOutcome = { status: 'valid', bytes: 10 }
    const recorded = recordResult({ value: { videos: 312 }, outcome, summary: NO_SUMMARY, maxResultBytes: MAX })!
    expect(recorded.resultSummary).toBeNull()
  })

  test('built from the marked fields via buildResultSummary when present', () => {
    const summary: SummaryField[] = [{ path: 'videos', title: 'Videos watched', kind: 'count', unit: undefined }]
    const outcome: ResultOutcome = { status: 'valid', bytes: 10 }
    const recorded = recordResult({ value: { videos: 312 }, outcome, summary, maxResultBytes: MAX })!
    expect(recorded.resultSummary).toBe('312 videos')
  })

  test('never computed for oversize — there is no value to summarise', () => {
    const summary: SummaryField[] = [{ path: 'videos', title: 'Videos watched', kind: 'count', unit: undefined }]
    const outcome: ResultOutcome = { status: 'oversize', bytes: 999_999_999 }
    const recorded = recordResult({ value: undefined, outcome, summary, maxResultBytes: MAX })!
    expect(recorded.resultSummary).toBeNull()
  })
})

/**
 * Plan 97 §3.5, §4.5, step 97.4 — "a failed run can still say something".
 * `partial` is a `finish()` salvage: no schema check ran against it, so it
 * never sets `resultIssues`, and it must never downgrade an already-recorded
 * `valid` — the ordering `finish()` running after `run()`, and a fresh
 * process re-running `finish()` after a timeout kill (spec §11.2), makes a
 * late `partial` arriving after a good `valid` a real possibility to guard
 * against, driven here explicitly rather than assumed unreachable.
 */
describe('recordResult — partial (plan 97 §3.5, step 97.4)', () => {
  test('a partial outcome records verbatim, with no existing status to conflict with', () => {
    const value = { videosBeforeFailure: 280 }
    const outcome: ResultOutcome = { status: 'partial', bytes: 30 }
    const recorded = recordResult({ value, outcome, summary: NO_SUMMARY, maxResultBytes: MAX })!
    expect(recorded.resultStatus).toBe('partial')
    expect(recorded.result).toEqual(value)
    expect(recorded.resultIssues).toBeNull()
  })

  test('partial never sets resultIssues, even if the outcome somehow carried some', () => {
    const outcome = { status: 'partial', bytes: 4, issues: [{ path: 'x', message: 'should never appear on a partial' }] } as unknown as ResultOutcome
    const recorded = recordResult({ value: 'salvage', outcome, summary: NO_SUMMARY, maxResultBytes: MAX })!
    expect(recorded.resultStatus).toBe('partial')
    expect(recorded.resultIssues).toBeNull()
  })

  test('partial never overwrites an already-recorded valid — the store refuses the downgrade and returns null', () => {
    const outcome: ResultOutcome = { status: 'partial', bytes: 30 }
    const recorded = recordResult({
      value: { videosBeforeFailure: 280 },
      outcome,
      summary: NO_SUMMARY,
      maxResultBytes: MAX,
      existingStatus: 'valid',
    })
    expect(recorded).toBeNull()
  })

  test('partial DOES record when the existing status is anything other than valid (undeclared, invalid, oversize, partial, or none at all)', () => {
    for (const existingStatus of ['undeclared', 'invalid', 'oversize', 'partial', null, undefined] as const) {
      const outcome: ResultOutcome = { status: 'partial', bytes: 10 }
      const recorded = recordResult({ value: { x: 1 }, outcome, summary: NO_SUMMARY, maxResultBytes: MAX, existingStatus })
      expect(recorded).not.toBeNull()
      expect(recorded?.resultStatus).toBe('partial')
    }
  })

  test('a partial value that is independently oversize still overrides to oversize (the parent re-check, §3.8) — existingStatus never blocks a re-check that lands on a DIFFERENT status', () => {
    const bigValue = { blob: 'x'.repeat(200) }
    const outcome: ResultOutcome = { status: 'partial', bytes: 5 }
    const recorded = recordResult({ value: bigValue, outcome, summary: NO_SUMMARY, maxResultBytes: 50, existingStatus: 'valid' })
    expect(recorded).not.toBeNull()
    expect(recorded?.resultStatus).toBe('oversize')
    expect(recorded?.result).toBeNull()
  })
})
