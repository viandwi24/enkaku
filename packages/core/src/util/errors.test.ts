import { describe, expect, test } from 'bun:test'
import { EnkakuError } from './errors'

/**
 * `EnkakuError.issues` (plan 95 §3.7, §4.3, §5 step 95.6, fixes F13) — the
 * field-level paths a validator already computes used to be joined into one
 * string and thrown away one line before the response. `toJSON()` now
 * echoes them, unchanged, so `POST /api/jobs` can answer
 * `{ error: { code, message, issues: [{ path, message }] } }`.
 */
describe('EnkakuError.issues (plan 95 §4.3)', () => {
  test('toJSON omits `issues` entirely when none were given — the pre-existing shape is unchanged', () => {
    const err = new EnkakuError('device_not_found', 'no such device')
    expect(err.toJSON()).toEqual({ error: { code: 'device_not_found', message: 'no such device' } })
    expect('issues' in err.toJSON().error).toBe(false)
  })

  test('toJSON carries `issues` through verbatim when present', () => {
    const issues = [{ path: 'videos', message: 'must be at most 2000' }]
    const err = new EnkakuError('invalid_job_params', 'videos: must be at most 2000', undefined, issues)
    expect(err.toJSON()).toEqual({
      error: { code: 'invalid_job_params', message: 'videos: must be at most 2000', issues },
    })
  })

  test('the `cause` positional argument still works with no `issues` supplied — existing 3-arg call sites are unaffected', () => {
    const cause = new Error('underlying')
    const err = new EnkakuError('E_DB', 'insert failed', cause)
    expect(err.cause).toBe(cause)
    expect(err.issues).toBeUndefined()
    expect(err.toJSON()).toEqual({ error: { code: 'E_DB', message: 'insert failed' } })
  })
})
