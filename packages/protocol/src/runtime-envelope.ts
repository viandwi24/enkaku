import { z } from 'zod'
import type { JobSettings } from './job-settings'

/**
 * The current SDK contract major a bundle is built against (plan 98 §3.3
 * S1). Ships at 1 — every script published before this plan declared no
 * `runtime.sdk` at all, so it is treated as major 1 by omission, and every
 * one of them keeps passing `checkRuntimeMajor` unchanged.
 */
export const SCRIPT_RUNTIME_MAJOR = 1

/**
 * The oldest major this core still runs a bundle against (plan 98 §3.3 S1).
 * A bundle is a long-lived database row, so — unlike plan 90's guest agent,
 * which states no support window at all (F26) — this one needs to exist.
 * How wide it should be is an open owner decision (plan 98 §9 Q1); until
 * that is answered it is exactly one major wide, `[CURRENT, CURRENT]`.
 */
export const SCRIPT_RUNTIME_MIN_MAJOR = 1

/**
 * What a script declares about its own execution (plan 98 §3.2). EVERY
 * field is a restriction the script places on ITSELF — never a permission
 * it requests. That invariant is what makes `unknownRuntimeKeys` below safe
 * to silently ignore rather than refuse (§3.3 S3): the worst outcome of
 * ignoring a field this build does not know is that the script runs under
 * the farm's own (looser) numbers — visible, bounded, and logged — never
 * that it gains something it should not have. Any future field that GRANTS
 * rather than restricts may not ride this channel (§3.2's permanent rule).
 *
 * The identical shape is reused for a script's own declaration
 * (`scripts.runtime`, plan 98 step 98.4) and for a per-job override
 * (`jobs.runtime_override`, step 98.7) — `resolveRuntime` below is what
 * tells the two layers apart, not a second schema.
 */
export const RuntimeEnvelopeSchema = z.object({
  /** The SDK contract major this bundle was built against. Absent ⇒ 1 (`SCRIPT_RUNTIME_MAJOR`). */
  sdk: z.number().int().min(1).max(999).optional(),
  timeoutMs: z.number().int().min(1_000).max(86_400_000).optional(),
  /** A script's own retry budget on a SCRIPT failure — separate from `job.retry`'s infra budget (plan 36). Absent ⇒ 0. */
  retries: z.number().int().min(0).max(10).optional(),
  /** Enforced by sampling, not prevented (plan 98 §3.5) — see `job.memory.*` in `./settings.ts`. */
  maxRssBytes: z
    .number()
    .int()
    .min(64 * 1024 * 1024)
    .max(16 * 1024 * 1024 * 1024)
    .optional(),
  /** Farm-wide simultaneous running jobs of this script, keyed on script NAME so a limit survives a version bump (plan 98 §3.7, §4.6). 0 = unlimited. */
  maxConcurrent: z.number().int().min(0).max(1_000).optional(),
})
export type RuntimeEnvelope = z.infer<typeof RuntimeEnvelopeSchema>

/**
 * Every key `RuntimeEnvelopeSchema` actually parses, read off the schema's
 * own shape rather than hand-duplicated — so this set can never itself
 * drift from what the schema above accepts.
 */
const KNOWN_RUNTIME_KEYS = new Set(Object.keys(RuntimeEnvelopeSchema.shape))

/**
 * Field names present in `raw` that this build does not know how to parse
 * (plan 98 §3.3 S3) — reported so a drop produces one `warn` naming each
 * field, never silence. `raw` is whatever untrusted JSON travelled in (a
 * `scripts.runtime` DB column, a bundle's `ready` message, an enqueue
 * body), so this is deliberately as tolerant as `readHints` in
 * `./schema/vocabulary.ts`: anything that is not a plain object yields no
 * unknown keys rather than throwing — `unknownRuntimeKeys` never refuses,
 * it only reports.
 */
export function unknownRuntimeKeys(raw: unknown): string[] {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return []
  return Object.keys(raw as Record<string, unknown>).filter((key) => !KNOWN_RUNTIME_KEYS.has(key))
}

/** What `resolveRuntime` actually decided, after precedence and every clamp (plan 98 §3.8). */
export interface ResolvedRuntime {
  timeoutMs: number
  retries: number
  maxRssBytes: number | null
  maxConcurrent: number
  sdk: number
}

/**
 * One clamp `resolveRuntime` applied because a requested value exceeded a
 * farm ceiling (plan 98 §3.8) — logged by name, exactly `clampTimeoutMs`'s
 * existing precedent (F7): never a silent drop. Only the two fields that
 * HAVE a farm ceiling (`job.maxTimeoutMs`, `job.memory.maxRssBytes`) can
 * ever appear here; `retries`, `maxConcurrent` and `sdk` have no ceiling to
 * exceed (plan 98 §3.7, §4.1).
 *
 * `from` is always `'script'` or `'override'`, never `'farm'`: a farm
 * DEFAULT that happens to sit above the farm's OWN ceiling is still clamped
 * — the ceiling always wins — but that is an operator's two settings
 * disagreeing with each other, not a script or a job asking for too much,
 * so it produces no named clamp record. See `resolveRuntime`'s own comment
 * for why that case still cannot exceed the ceiling.
 */
export interface RuntimeClamp {
  field: 'timeoutMs' | 'maxRssBytes'
  requested: number
  ceiling: number
  from: 'script' | 'override'
}

type ClampSource = 'script' | 'override' | null

/**
 * `clamp(job override ?? script declaration ?? farm default, farm ceiling)`
 * (plan 98 §3.8) for `timeoutMs`, whose farm default (`job.defaultTimeoutMs`)
 * is always a real number — there is no "no timeout at all" state, unlike
 * `maxRssBytes` below.
 */
function resolveTimeout(
  scriptValue: number | undefined,
  overrideValue: number | undefined,
  farmDefault: number,
  ceiling: number | null,
): { value: number; clamp: RuntimeClamp | null } {
  const source: ClampSource = overrideValue !== undefined ? 'override' : scriptValue !== undefined ? 'script' : null
  const requested = overrideValue ?? scriptValue ?? farmDefault
  if (ceiling === null || requested <= ceiling) return { value: requested, clamp: null }
  return { value: ceiling, clamp: source === null ? null : { field: 'timeoutMs', requested, ceiling, from: source } }
}

/**
 * The same precedence-then-clamp shape as `resolveTimeout` above, but for
 * `maxRssBytes`, whose farm default (`job.memory.defaultMaxRssBytes`) is
 * nullable: when every layer — override, script, AND the farm default — is
 * absent, the honest result is "no limit at all", not "clamped to the
 * ceiling". A ceiling only bounds a value that was actually requested; it
 * never manufactures one that was not (matching `job.maxTimeoutMs`'s own
 * "null means no ceiling" rule, applied the other direction).
 */
function resolveMaxRss(
  scriptValue: number | undefined,
  overrideValue: number | undefined,
  farmDefault: number | null,
  ceiling: number | null,
): { value: number | null; clamp: RuntimeClamp | null } {
  const source: ClampSource = overrideValue !== undefined ? 'override' : scriptValue !== undefined ? 'script' : null
  const requested = overrideValue ?? scriptValue ?? farmDefault
  if (requested === null) return { value: null, clamp: null }
  if (ceiling === null || requested <= ceiling) return { value: requested, clamp: null }
  return { value: ceiling, clamp: source === null ? null : { field: 'maxRssBytes', requested, ceiling, from: source } }
}

/**
 * The ONE place precedence between a farm default, a script's own
 * declaration, a per-job override, and a farm ceiling is expressed (plan 98
 * §3.8 rule 1). Pure — it takes live farm settings as a plain argument
 * rather than reading them itself, so there is no second resolution site to
 * drift from this one (the exact defect F24 records, not repeated here: the
 * runner already reads settings fresh per attempt through a getter, F25,
 * and this function is what that getter's result is meant to be fed into).
 *
 * `script`/`override` are `null` — never an empty object — for "this layer
 * declared nothing". `RuntimeEnvelopeSchema.parse({})` (every field absent)
 * and "no row at all" behave identically either way, which is what makes a
 * pre-plan-98 script (`scripts.runtime = NULL`) resolve to exactly today's
 * behaviour (plan 98 §3.1, acceptance criterion 2).
 *
 * `retries`, `maxConcurrent` and `sdk` have no farm default or ceiling
 * layer at all (plan 98 §3.7, §4.1) — they resolve purely from
 * `override ?? script ?? <builtin>` with no clamp possible, which is why
 * `RuntimeClamp.field` only ever names `timeoutMs`/`maxRssBytes`.
 */
export function resolveRuntime(input: {
  farm: JobSettings
  script: RuntimeEnvelope | null
  override: RuntimeEnvelope | null
}): { resolved: ResolvedRuntime; clamps: RuntimeClamp[] } {
  const { farm, script, override } = input
  const clamps: RuntimeClamp[] = []

  const timeout = resolveTimeout(script?.timeoutMs, override?.timeoutMs, farm.defaultTimeoutMs, farm.maxTimeoutMs)
  if (timeout.clamp) clamps.push(timeout.clamp)

  const rss = resolveMaxRss(script?.maxRssBytes, override?.maxRssBytes, farm.memory.defaultMaxRssBytes, farm.memory.maxRssBytes)
  if (rss.clamp) clamps.push(rss.clamp)

  const resolved: ResolvedRuntime = {
    timeoutMs: timeout.value,
    retries: override?.retries ?? script?.retries ?? 0,
    maxRssBytes: rss.value,
    maxConcurrent: override?.maxConcurrent ?? script?.maxConcurrent ?? 0,
    sdk: override?.sdk ?? script?.sdk ?? SCRIPT_RUNTIME_MAJOR,
  }
  return { resolved, clamps }
}

/**
 * S1's gate (plan 98 §3.3): a bundle declaring an SDK major outside
 * `[SCRIPT_RUNTIME_MIN_MAJOR, SCRIPT_RUNTIME_MAJOR]` is refused with
 * `E_RUNTIME_UNSUPPORTED` — the caller applies this at enqueue, before a
 * device is ever claimed (F4), which is the whole point: refusing at
 * `ready` would have already burnt a session acquisition.
 *
 * `undefined` (a script that declares no `runtime.sdk` at all — every
 * script published before this plan) is treated as major `SCRIPT_RUNTIME_
 * MAJOR`, which is always in range today, so this ships with zero
 * refusals for anything already published.
 */
export function checkRuntimeMajor(sdk: number | undefined): { code: 'E_RUNTIME_UNSUPPORTED'; message: string } | null {
  const major = sdk ?? SCRIPT_RUNTIME_MAJOR
  if (major >= SCRIPT_RUNTIME_MIN_MAJOR && major <= SCRIPT_RUNTIME_MAJOR) return null
  const range = SCRIPT_RUNTIME_MIN_MAJOR === SCRIPT_RUNTIME_MAJOR ? `${SCRIPT_RUNTIME_MAJOR}` : `${SCRIPT_RUNTIME_MIN_MAJOR}–${SCRIPT_RUNTIME_MAJOR}`
  return {
    code: 'E_RUNTIME_UNSUPPORTED',
    message: `this script declares runtime.sdk ${major}, which this core does not support (supported: ${range}) — publish a new version targeting a supported SDK major`,
  }
}
