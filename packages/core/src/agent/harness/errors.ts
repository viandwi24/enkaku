import type { AgentErrorClass } from '@enkaku/protocol'

/**
 * §3.8's `cause`-chain walk and classification. Provider errors arrive
 * wrapped several `cause` layers deep — the useful signal (a 401, a rate
 * limit, an overloaded model) is rarely the one at the top.
 *
 * Moved from `agent/loop/errors.ts` (plan 76 §3.7). Widened for the harness
 * move: `agent/provider/anthropic.ts`'s old `.stream()` used to translate
 * `@ai-sdk/anthropic`'s own `AI_APICallError` (`.statusCode`/
 * `.data.error.{type,message}`) into the `{status,type,message}` shape this
 * file duck-types, BEFORE the error ever reached here. Now that `.stream()`
 * is gone (criterion 13) and `harness/run.ts` catches whatever
 * `runAgentLoop`/`streamText` throw directly, nothing does that translation
 * any more — so this file does both shapes itself instead of assuming a
 * translator ran first. Still deliberately generic: it duck-types, never
 * imports a provider SDK's error class.
 */

export interface ClassifiedError {
  errorClass: AgentErrorClass
  message: string
}

interface ApiErrorShape {
  status?: number
  type?: string
  message?: string
  headers?: { get?(name: string): string | null | undefined }
}

/** `@ai-sdk/anthropic`/`@openrouter/ai-sdk-provider`'s own `AI_APICallError` shape, verified
 * empirically (plan 75's own status header): `.statusCode`, `.data.error.{type,message}`. */
interface AiSdkApiErrorShape {
  statusCode?: number
  data?: { error?: { type?: string; message?: string } }
  message?: string
  responseHeaders?: Record<string, string | undefined>
}

function isApiErrorShaped(x: unknown): x is ApiErrorShape {
  return typeof x === 'object' && x !== null && ('status' in x || 'type' in x)
}

function isAiSdkErrorShaped(x: unknown): x is AiSdkApiErrorShape {
  return typeof x === 'object' && x !== null && 'statusCode' in x
}

/** Normalises either shape to the plain `{status,type,message}` this file classifies against. */
function normalise(x: unknown): ApiErrorShape | undefined {
  if (isApiErrorShaped(x)) return x
  if (isAiSdkErrorShaped(x)) {
    return {
      status: x.statusCode,
      type: x.data?.error?.type,
      message: x.data?.error?.message ?? x.message,
      headers: x.responseHeaders ? { get: (name) => x.responseHeaders?.[name.toLowerCase()] ?? null } : undefined,
    }
  }
  return undefined
}

/** Returns `null` for a value with no meaningful message of its own, so a caller-supplied fallback can win. */
function messageOf(err: unknown): string | null {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  if (err === undefined || err === null) return null
  return String(err)
}

/**
 * Walks `err.cause` up to `maxDepth` (6, per §3.8) looking for the first
 * API-error-shaped link. If none is found, returns whatever the walk
 * bottomed out on — still the most specific thing available.
 */
export function findInformativeError(err: unknown, maxDepth = 6): unknown {
  let current = err
  for (let depth = 0; depth <= maxDepth; depth++) {
    if (isApiErrorShaped(current) || isAiSdkErrorShaped(current)) return current
    if (current instanceof Error && current.cause !== undefined && current.cause !== null) {
      current = current.cause
      continue
    }
    break
  }
  return current
}

const CONTEXT_OVERFLOW_PATTERN = /prompt is too long|context length|maximum context|context window|exceeds the model|too many tokens/i

/** Extracts `retry-after` (seconds) from an API-error-shaped value's headers, when present. */
export function retryAfterMs(err: unknown): number | null {
  const informative = normalise(findInformativeError(err))
  if (!informative) return null
  const raw = informative.headers?.get?.('retry-after')
  if (!raw) return null
  const seconds = Number(raw)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null
}

/**
 * Classifies a raw thrown/received error into one of §3.8's six classes.
 * `fallbackMessage` covers a hand-built test event's own `message` when
 * `raw` is absent — classification degrades to the loud default
 * ('invalid-request') rather than guessing.
 */
export function classifyError(raw: unknown, fallbackMessage?: string): ClassifiedError {
  const informativeRaw = findInformativeError(raw)
  const shaped = normalise(informativeRaw)
  const message = shaped?.message ?? fallbackMessage ?? messageOf(informativeRaw) ?? 'unknown error'
  const status = shaped?.status
  const type = shaped?.type

  if (type === 'authentication_error' || type === 'permission_error' || status === 401 || status === 403) {
    return { errorClass: 'auth', message }
  }
  if (type === 'rate_limit_error' || status === 429) {
    return { errorClass: 'rate-limit', message }
  }
  if (type === 'overloaded_error' || status === 529 || status === 503) {
    return { errorClass: 'overloaded', message }
  }
  if (type === 'invalid_request_error' || status === 400) {
    if (CONTEXT_OVERFLOW_PATTERN.test(message)) return { errorClass: 'context-overflow', message }
    return { errorClass: 'invalid-request', message }
  }
  // Unrecognised shape: loud by default (§3.8 — "this is our bug and it must be loud").
  return { errorClass: 'invalid-request', message }
}
