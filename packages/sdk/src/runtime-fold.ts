import { RuntimeEnvelopeSchema, type RuntimeEnvelope } from '@enkaku/protocol'

/**
 * The `timeout`/`retries` ⇒ `runtime` fold (plan 98 §4.2), applied by
 * `definePlugin` to every member. It used to be shared with `defineScript`
 * too; plan 110 §4.2 removed that function, so `definePlugin` is now the only
 * caller — the fold itself is unchanged. Both deprecated,
 * top-level fields keep working forever (§4.3 "replace, never version" does
 * not apply to an author-facing field that a published script already used
 * — this one folds instead of breaking), but a script that sets BOTH
 * `timeout` and `runtime.timeoutMs` to two DIFFERENT numbers has written
 * something unverifiable: which one did the author actually mean? Thrown at
 * import time, on the author's own machine — the same reasoning
 * `definePlugin` already applies to a member's `version` disagreeing with
 * the plugin's own.
 *
 * `undefined` in, `undefined` out: a script that declares neither `runtime`
 * nor `timeout`/`retries` gets no envelope at all, which is what makes a
 * pre-plan-98 script behave identically to today (plan 98 §3.1, acceptance
 * criterion 2) — `resolveRuntime` already treats "no script layer" and "an
 * empty declared layer" the same way, so this function does not need to
 * invent one either.
 */
export function foldRuntimeEnvelope(
  def: { runtime?: RuntimeEnvelope; timeout?: number; retries?: number },
  label: string,
): RuntimeEnvelope | undefined {
  if (def.runtime === undefined && def.timeout === undefined && def.retries === undefined) return undefined

  // Validating the envelope's SHAPE is validation (plan 98 §4.2's own
  // "no orchestration" contract) — a bound violation (say `timeoutMs: 500`,
  // below the 1s floor) fails loudly here, on the author's machine, rather
  // than as a confusing 400 from the farm weeks later.
  const runtime = def.runtime === undefined ? undefined : RuntimeEnvelopeSchema.parse(def.runtime)

  if (runtime?.timeoutMs !== undefined && def.timeout !== undefined && runtime.timeoutMs !== def.timeout) {
    throw new Error(
      `${label}: \`timeout\` (${def.timeout}) and \`runtime.timeoutMs\` (${runtime.timeoutMs}) disagree — declare only one`,
    )
  }
  if (runtime?.retries !== undefined && def.retries !== undefined && runtime.retries !== def.retries) {
    throw new Error(
      `${label}: \`retries\` (${def.retries}) and \`runtime.retries\` (${runtime.retries}) disagree — declare only one`,
    )
  }

  const timeoutMs = runtime?.timeoutMs ?? def.timeout
  const retries = runtime?.retries ?? def.retries
  const folded: RuntimeEnvelope = {
    ...runtime,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(retries !== undefined ? { retries } : {}),
  }
  return RuntimeEnvelopeSchema.parse(folded)
}
