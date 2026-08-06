import { describe, expect, test } from 'bun:test'
import { classifyError, findInformativeError, retryAfterMs } from './errors'

/**
 * Moved from `agent/loop/errors.test.ts` (plan 76 §3.7 — the module moved, and was widened to
 * duck-type the AI SDK's own `AI_APICallError` shape in addition to the original `{status,type}`
 * shape, since nothing translates one into the other any more now that `stream()` is gone). New
 * tests written against the moved+widened implementation — see the plan 76 report for why the
 * original test file could not be recovered.
 */

describe('classifyError — the old {status,type} shape (still duck-typed directly, e.g. a hand-built fake turn)', () => {
  test('401/403 or authentication_error/permission_error → auth', () => {
    expect(classifyError({ status: 401, type: 'authentication_error', message: 'no' }).errorClass).toBe('auth')
    expect(classifyError({ status: 403, type: 'permission_error', message: 'no' }).errorClass).toBe('auth')
  })

  test('429 or rate_limit_error → rate-limit', () => {
    expect(classifyError({ status: 429, message: 'slow down' }).errorClass).toBe('rate-limit')
    expect(classifyError({ type: 'rate_limit_error', message: 'slow down' }).errorClass).toBe('rate-limit')
  })

  test('503/529 or overloaded_error → overloaded', () => {
    expect(classifyError({ status: 529, message: 'busy' }).errorClass).toBe('overloaded')
    expect(classifyError({ status: 503, message: 'busy' }).errorClass).toBe('overloaded')
  })

  test('400/invalid_request_error with context-window wording → context-overflow', () => {
    const result = classifyError({ status: 400, type: 'invalid_request_error', message: 'prompt is too long for this model' })
    expect(result.errorClass).toBe('context-overflow')
  })

  test('400/invalid_request_error WITHOUT context-window wording → invalid-request', () => {
    const result = classifyError({ status: 400, type: 'invalid_request_error', message: 'bad json' })
    expect(result.errorClass).toBe('invalid-request')
  })

  test('an unrecognised shape defaults to invalid-request, loudly, never silently swallowed', () => {
    expect(classifyError(new Error('totally opaque')).errorClass).toBe('invalid-request')
  })
})

describe('classifyError — the AI SDK\'s own AI_APICallError shape (plan 76 §3.7 — no translator runs first any more)', () => {
  test('.statusCode/.data.error.type classify exactly like the old .status/.type shape', () => {
    const aiSdkError = { statusCode: 401, data: { error: { type: 'authentication_error', message: 'invalid x-api-key' } } }
    const result = classifyError(aiSdkError)
    expect(result.errorClass).toBe('auth')
    expect(result.message).toBe('invalid x-api-key')
  })

  test('a rate-limited AI SDK error classifies as rate-limit', () => {
    const aiSdkError = { statusCode: 429, data: { error: { type: 'rate_limit_error', message: 'too many requests' } } }
    expect(classifyError(aiSdkError).errorClass).toBe('rate-limit')
  })

  test('falls back to .message when .data.error.message is absent', () => {
    const aiSdkError = { statusCode: 500, message: 'internal error' }
    expect(classifyError(aiSdkError).message).toBe('internal error')
  })
})

describe('findInformativeError — walks a cause chain looking for either shaped error', () => {
  test('finds an API-error-shaped cause several layers deep', () => {
    const inner = { status: 429, type: 'rate_limit_error', message: 'slow down' }
    const wrapped = new Error('outer', { cause: new Error('middle', { cause: inner }) })
    expect(findInformativeError(wrapped)).toBe(inner)
  })

  test('finds an AI-SDK-shaped cause too', () => {
    const inner = { statusCode: 401, data: { error: { type: 'authentication_error' } } }
    const wrapped = new Error('outer', { cause: inner })
    expect(findInformativeError(wrapped)).toBe(inner)
  })
})

describe('retryAfterMs', () => {
  test('reads retry-after from a header-carrying error, in ms', () => {
    const err = { status: 429, headers: { get: (name: string) => (name === 'retry-after' ? '2' : null) } }
    expect(retryAfterMs(err)).toBe(2000)
  })

  test('returns null when there is no header', () => {
    expect(retryAfterMs({ status: 429 })).toBeNull()
  })
})
