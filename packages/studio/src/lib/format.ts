/** Shared formatting so "2 minutes ago" always looks the same everywhere. */

import { formatValue, type DurationUnit, type NumberKind } from '@enkaku/protocol'

/**
 * `now` (epoch milliseconds) defaults to `Date.now()` so every existing call
 * site keeps working unchanged. A live view passes `useNow()` instead, so the
 * value ticks with a shared per-page interval rather than each caller freezing
 * at render time (Plan 17 §4.6).
 */
export function relativeTime(epochSeconds: number | null, now: number = Date.now()): string {
  if (!epochSeconds) return '—'
  const delta = Math.floor(now / 1000) - epochSeconds
  if (delta < 5) return 'just now'
  if (delta < 60) return `${delta}s ago`
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`
  return `${Math.floor(delta / 86400)}d ago`
}

/**
 * `formatValue`, plus the one thing a browser can do that `@enkaku/protocol`
 * deliberately cannot: read the clock (plan 108 §5 step 108.7, item A).
 *
 * `kind: 'timestamp'` is an INSTANT in unix seconds. Rendered server-side it
 * has to be absolute — `buildResultSummary` writes its output into
 * `jobs.result_summary` once and it is read forever afterward, so a frozen
 * `"2m ago"` there would be a lie (see `formatValue`'s own note). Rendered in
 * front of an operator it should read the way every other time in Studio
 * reads: `relativeTime`, the same function the jobs list, the KV panel and
 * the device cards already use, so "last synced" in a plugin's table and
 * "updated" in the KV panel are the same words for the same fact.
 *
 * Every other kind is `formatValue` verbatim — this is a thin layer over the
 * one formatter, never a second one. `now` is threaded through for the same
 * reason `relativeTime` takes it: a live view passes `useNow()` so a whole
 * page ticks together instead of each cell freezing at its own render.
 */
export function formatFieldValue(kind: NumberKind, unit: DurationUnit | undefined, value: unknown, now: number = Date.now()): string {
  if (kind === 'timestamp') {
    // A pair of timestamps (`prefixItems` of two) still formats through the
    // protocol's own `" ~ "` join — recursing here keeps both halves relative.
    if (Array.isArray(value)) {
      if (value.length !== 2) return '—'
      return `${formatFieldValue(kind, unit, value[0], now)} ~ ${formatFieldValue(kind, unit, value[1], now)}`
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
    // `relativeTime(0)` is `'—'` by its own falsy guard, which is right for a
    // null column and wrong for the unix epoch itself — a real 0 is a stored
    // instant, so it falls back to the absolute readout rather than vanishing.
    return value === 0 ? formatValue(kind, unit, value) : relativeTime(value, now)
  }
  return formatValue(kind, unit, value)
}

export function duration(startedAt: number | null, finishedAt: number | null, now: number = Date.now()): string {
  if (!startedAt) return '—'
  const end = finishedAt ?? Math.floor(now / 1000)
  const total = end - startedAt
  if (total < 60) return `${total}s`
  return `${Math.floor(total / 60)}m ${total % 60}s`
}

export function fileSize(bytes: number | null): string {
  if (bytes === null) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** A token count from an `AgentUsage` figure (plan 66 §4.1) — `1.2k`/`3.4M`, exact below 1000. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

/** `costUsd` (plan 66 §4.1) — null means the provider adapter did not report a cost for this model. */
export function formatUsd(costUsd: number | null): string {
  if (costUsd === null) return '—'
  if (costUsd < 0.01 && costUsd > 0) return `<$0.01`
  return `$${costUsd.toFixed(2)}`
}
