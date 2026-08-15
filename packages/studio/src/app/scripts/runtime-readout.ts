import { formatValue, resolveRuntime, type JobSettings, type ResolvedRuntime, type RuntimeClamp, type RuntimeEnvelope } from '@enkaku/protocol'
import { fileSize } from '@/lib/format'

/**
 * Plan 98 §3.9 item 3, §5 step 98.8 — the Script-detail Runtime card's own
 * "where did this number come from" answer. The SAME honesty requirement
 * the video settings step shipped for `VideoQualityReadout`/`profileRows`
 * (`packages/studio/src/components/video/video-quality.ts`): an operator who
 * sets a number and sees no effect must be able to see which layer won.
 *
 * `'clamped'` is reserved for a value `resolveRuntime` itself reports a
 * clamp for — this function never re-derives that decision, only reads
 * `resolveRuntime`'s own `clamps` array (this step's own brief: "`resolveRuntime`
 * already reports that; render it, do not recompute it"). `'script'`/`'farm'`/
 * `'default'` for the non-clamped fields are provenance labels only — which
 * layer's value was actually consulted — never a second resolution: a field
 * is `'script'` when the script's own declaration set it, `'farm'` when the
 * farm default filled a gap the script left, and `'default'` for the three
 * fields with no farm layer at all (`retries`/`maxConcurrent`/`sdk`, §4.1's
 * own doc comment) when the script declared nothing either.
 */
export type RuntimeOrigin = 'script' | 'farm' | 'default' | 'clamped'

export interface RuntimeReadoutRow {
  label: string
  value: string
  origin: RuntimeOrigin
  originLabel: string
  /** Plan 98 §3.5 — `'sampled'` draws a badge; every other field draws none. */
  enforcement?: 'sampled'
  /**
   * Present only for a `'clamped'` row — the ask the script made and the
   * ceiling that reduced it, named exactly like the job log's own clamp
   * line (§3.8's "never silent" rule), so the card and the log never
   * disagree about what happened.
   */
  detail?: string
}

/** A clamp is not a rejection (this step's brief, stated rather than implied) — this only ever fires for a SCRIPT's own declaration on this read-only card; an override's ceiling refusal (`E_RUNTIME_OVER_CEILING`) is a different outcome the Run form's Runtime section reports separately, never blurred into this label. */
export function runtimeOriginLabel(origin: RuntimeOrigin): string {
  switch (origin) {
    case 'script':
      return 'declared by the script'
    case 'farm':
      return 'farm default'
    case 'default':
      return 'built-in default'
    case 'clamped':
      return 'clamped to the farm ceiling'
  }
}

function clampFor(clamps: readonly RuntimeClamp[], field: RuntimeClamp['field']): RuntimeClamp | undefined {
  return clamps.find((c) => c.field === field)
}

function originFor(clamp: RuntimeClamp | undefined, declared: boolean, hasFarmLayer: boolean, resolvedIsSet: boolean): RuntimeOrigin {
  if (clamp) return 'clamped'
  if (declared) return 'script'
  if (hasFarmLayer && resolvedIsSet) return 'farm'
  return 'default'
}

/**
 * Pure: `farm` settings and a script's own (possibly `null`) declaration in,
 * a resolved runtime plus a row per field out. `override` is always `null`
 * here — this card renders a SCRIPT's declared envelope, never a per-job
 * override (that is the Run form's own Runtime section, a different value
 * entirely, computed by `RuntimeOverrideSection` from what an operator
 * types, not from this function).
 */
export function computeRuntimeReadout(
  farm: JobSettings,
  script: RuntimeEnvelope | null,
): { resolved: ResolvedRuntime; clamps: RuntimeClamp[]; rows: RuntimeReadoutRow[] } {
  const { resolved, clamps } = resolveRuntime({ farm, script, override: null })

  const timeoutClamp = clampFor(clamps, 'timeoutMs')
  const rssClamp = clampFor(clamps, 'maxRssBytes')

  const timeoutOrigin = originFor(timeoutClamp, script?.timeoutMs !== undefined, true, true)
  const rssOrigin = originFor(rssClamp, script?.maxRssBytes !== undefined, true, resolved.maxRssBytes !== null)
  const retriesOrigin: RuntimeOrigin = script?.retries !== undefined ? 'script' : 'default'
  const maxConcurrentOrigin: RuntimeOrigin = script?.maxConcurrent !== undefined ? 'script' : 'default'
  const sdkOrigin: RuntimeOrigin = script?.sdk !== undefined ? 'script' : 'default'

  const rows: RuntimeReadoutRow[] = [
    {
      label: 'Timeout',
      value: formatValue('duration', 'ms', resolved.timeoutMs),
      origin: timeoutOrigin,
      originLabel: runtimeOriginLabel(timeoutOrigin),
      detail: timeoutClamp
        ? `the script asked for ${formatValue('duration', 'ms', timeoutClamp.requested)}; the farm ceiling is ${formatValue('duration', 'ms', timeoutClamp.ceiling)}`
        : undefined,
    },
    {
      label: 'Memory limit',
      value: resolved.maxRssBytes === null ? 'No limit' : fileSize(resolved.maxRssBytes),
      origin: rssOrigin,
      originLabel: runtimeOriginLabel(rssOrigin),
      enforcement: resolved.maxRssBytes !== null ? 'sampled' : undefined,
      detail: rssClamp ? `the script asked for ${fileSize(rssClamp.requested)}; the farm ceiling is ${fileSize(rssClamp.ceiling)}` : undefined,
    },
    {
      label: 'Retries on a script failure',
      value: String(resolved.retries),
      origin: retriesOrigin,
      originLabel: runtimeOriginLabel(retriesOrigin),
    },
    {
      label: 'Max concurrent (farm-wide)',
      value: resolved.maxConcurrent === 0 ? 'Unlimited' : String(resolved.maxConcurrent),
      origin: maxConcurrentOrigin,
      originLabel: runtimeOriginLabel(maxConcurrentOrigin),
    },
    {
      label: 'SDK contract major',
      value: String(resolved.sdk),
      origin: sdkOrigin,
      originLabel: runtimeOriginLabel(sdkOrigin),
    },
  ]

  return { resolved, clamps, rows }
}
