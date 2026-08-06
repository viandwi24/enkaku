/** Shared formatting so "2 minutes ago" always looks the same everywhere. */

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
