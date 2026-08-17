import { describe, expect, test } from 'bun:test'
import { hasExhaustedRetryBudget, isWithinBackoffWindow, nextBoundedRetry } from './bounded-retry'

const BACKOFF = [5, 20, 60]

describe('nextBoundedRetry (plan 106 §3.3, extracted from agent-provisioner.ts)', () => {
  test('ready resets attempts and clears nextAttemptAt', () => {
    expect(nextBoundedRetry({ result: 'ready', priorAttempts: 2, checkedAt: 1000, retryBackoffS: BACKOFF, forced: false })).toEqual({
      attempts: 0,
      nextAttemptAt: null,
    })
  })

  test('outdated resets the bound too — a repaired-but-wrong build is not a transient install failure', () => {
    expect(nextBoundedRetry({ result: 'outdated', priorAttempts: 1, checkedAt: 1000, retryBackoffS: BACKOFF, forced: false })).toEqual({
      attempts: 0,
      nextAttemptAt: null,
    })
  })

  test('first failure schedules the first backoff entry', () => {
    expect(nextBoundedRetry({ result: 'failed', priorAttempts: 0, checkedAt: 1000, retryBackoffS: BACKOFF, forced: false })).toEqual({
      attempts: 1,
      nextAttemptAt: 1005,
    })
  })

  test('second and third failures climb the schedule', () => {
    expect(nextBoundedRetry({ result: 'failed', priorAttempts: 1, checkedAt: 1000, retryBackoffS: BACKOFF, forced: false })).toEqual({
      attempts: 2,
      nextAttemptAt: 1020,
    })
    expect(nextBoundedRetry({ result: 'failed', priorAttempts: 2, checkedAt: 1000, retryBackoffS: BACKOFF, forced: false })).toEqual({
      attempts: 3,
      nextAttemptAt: null, // the bound is reached — no more automatic attempts
    })
  })

  test('attempts never exceeds the backoff schedule length even if priorAttempts is already past it', () => {
    expect(nextBoundedRetry({ result: 'failed', priorAttempts: 9, checkedAt: 1000, retryBackoffS: BACKOFF, forced: false })).toEqual({
      attempts: 3,
      nextAttemptAt: null,
    })
  })

  test('a forced retry does not inherit an already-exhausted budget', () => {
    expect(nextBoundedRetry({ result: 'failed', priorAttempts: 3, checkedAt: 1000, retryBackoffS: BACKOFF, forced: true })).toEqual({
      attempts: 1,
      nextAttemptAt: 1005,
    })
  })

  test('a forced retry that succeeds resets cleanly regardless of prior attempts', () => {
    expect(nextBoundedRetry({ result: 'ready', priorAttempts: 3, checkedAt: 1000, retryBackoffS: BACKOFF, forced: true })).toEqual({
      attempts: 0,
      nextAttemptAt: null,
    })
  })
})

describe('hasExhaustedRetryBudget', () => {
  test('false below the bound', () => {
    expect(hasExhaustedRetryBudget({ state: 'failed', attempts: 2 }, BACKOFF)).toBe(false)
  })

  test('true at or past the bound', () => {
    expect(hasExhaustedRetryBudget({ state: 'failed', attempts: 3 }, BACKOFF)).toBe(true)
    expect(hasExhaustedRetryBudget({ state: 'failed', attempts: 5 }, BACKOFF)).toBe(true)
  })

  test('false for any state other than failed, regardless of attempts', () => {
    expect(hasExhaustedRetryBudget({ state: 'ready', attempts: 9 }, BACKOFF)).toBe(false)
    expect(hasExhaustedRetryBudget({ state: 'unsupported', attempts: 9 }, BACKOFF)).toBe(false)
  })
})

describe('isWithinBackoffWindow', () => {
  test('true before nextAttemptAt', () => {
    expect(isWithinBackoffWindow({ nextAttemptAt: 2000 }, 1500)).toBe(true)
  })

  test('false at or after nextAttemptAt', () => {
    expect(isWithinBackoffWindow({ nextAttemptAt: 2000 }, 2000)).toBe(false)
    expect(isWithinBackoffWindow({ nextAttemptAt: 2000 }, 2500)).toBe(false)
  })

  test('false when nextAttemptAt is null (nothing scheduled — e.g. budget already exhausted)', () => {
    expect(isWithinBackoffWindow({ nextAttemptAt: null }, 1500)).toBe(false)
  })
})
