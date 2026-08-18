import { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '@enkaku/ui'
import { PROXY_STATE_MEANING, type ProxyState } from './api'

/**
 * What is left of this pack's own UI helpers after the plan 111 §3.3
 * extraction.
 *
 * This file used to hold three panels as well — a loading skeleton, an empty
 * panel and an error panel, about forty lines — written because `@enkaku/ui`
 * shipped the 28 components and `cn` and nothing else. `LoadingRows`,
 * `EmptyState` and `ErrorState` are now Studio's own, imported from
 * `@enkaku/ui` at the point of use, so this screen's empty and failed states
 * are the SAME ones the jobs list and the device page draw rather than a
 * near-copy that worded the same failure slightly differently.
 *
 * What is left stayed on purpose. None of it has a canonical Studio version to
 * share: `useLoader` and `usePoll` are this pack's own load/reload shape
 * (Studio's screens each roll their own), `StatusDot` is a deliberately plainer
 * thing than Studio's `StatusBadge` — which knows the farm's own job and device
 * vocabularies — and `ProxyStateBadge` knows a vocabulary that exists nowhere
 * but this pack's supervisor. Extracting any of them would have meant inventing
 * an API rather than sharing one.
 */

/**
 * Load once, reload on demand, and never write state into a component that
 * has already unmounted (switching tabs mid-fetch is the ordinary way to hit
 * that, and React logs it loudly).
 *
 * A hook, in a plugin, using the HOST's React — which is the whole point of
 * the import map (plan 111 T4/§3.2). If a second React copy had been bundled,
 * this line is where the screen would die with `Invalid hook call`.
 */
export function useLoader<T>(load: () => Promise<T>, deps: unknown[]): {
  data: T | null
  error: string | null
  loading: boolean
  reload: () => void
} {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [nonce, setNonce] = useState(0)
  const alive = useRef(true)
  const run = useRef(load)
  run.current = load

  useEffect(() => {
    alive.current = true
    setLoading(true)
    setError(null)
    run
      .current()
      .then((value) => {
        if (alive.current) setData(value)
      })
      .catch((e: unknown) => {
        if (alive.current) setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (alive.current) setLoading(false)
      })
    return () => {
      alive.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce])

  const reload = useCallback(() => setNonce((n) => n + 1), [])
  return { data, error, loading, reload }
}

/**
 * Re-run something on a timer, or not at all when `ms` is null.
 *
 * Used by the catalogue while a bridge is `starting` or `stopping` and by the
 * Logs tab when following: both are states that END on their own, and a screen
 * that showed `stopping` until somebody pressed refresh would look stuck at
 * exactly the moment an operator is watching to see whether it was.
 */
export function usePoll(fn: () => void, ms: number | null): void {
  const run = useRef(fn)
  run.current = fn
  useEffect(() => {
    if (ms === null) return
    const timer = setInterval(() => run.current(), ms)
    return () => clearInterval(timer)
  }, [ms])
}

/**
 * One bridge's state, as a dot, its own word, and — for the two that need it —
 * what it is doing.
 *
 * The rule this exists to keep: **`starting` is never rendered as `running`**
 * and `stopping` is never rendered as `stopped` (plan 112 §3.7, criterion 9).
 * A row mid-drain has released its port and is still carrying tunnels, and an
 * operator who reads that as "stopped" will act on it. The word is always
 * present — the colour is never the only carrier — for the same reason
 * `StatusDot` above spells its status out.
 */
export function ProxyStateBadge({ state, label, detail }: { state: ProxyState; label: string; detail?: string }) {
  const tone =
    state === 'running'
      ? 'bg-led-ok'
      : state === 'failed'
        ? 'bg-led-danger'
        : state === 'starting'
          ? 'bg-led-active'
          : state === 'stopping'
            ? 'bg-led-warn'
            : 'bg-led-off'
  return (
    /**
     * `whitespace-nowrap` is on the WORD and not on the row. A table sizes a
     * column from its min-content width, and a `nowrap` (or `truncate`) span
     * makes that the whole string — which is how a state cell with a detail
     * beside it silently forces a table wider than its container and puts a
     * horizontal scrollbar under a screen that fits. The word never breaks; the
     * detail wraps under it when the box is narrow.
     */
    <span className="inline-flex min-w-0 flex-wrap items-center gap-x-1.5" title={PROXY_STATE_MEANING[state]}>
      <span className={cn('size-1.5 shrink-0 rounded-full', tone, state === 'starting' || state === 'stopping' ? 'animate-pulse' : '')} aria-hidden />
      <span className={cn('whitespace-nowrap', state === 'unknown' ? 'text-fg-muted' : '')}>{label}</span>
      {detail ? <span className="min-w-0 text-[11px] text-fg-muted">{detail}</span> : null}
    </span>
  )
}

/** A status word as a coloured dot plus its own name — never a colour alone. */
export function StatusDot({ status }: { status: string }) {
  const tone =
    status === 'success' || status === 'online' || status === 'ready'
      ? 'bg-led-ok'
      : status === 'failed' || status === 'error'
        ? 'bg-led-danger'
        : status === 'running' || status === 'queued'
          ? 'bg-led-active'
          : 'bg-led-off'
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span className={cn('size-1.5 rounded-full', tone)} aria-hidden />
      {status}
    </span>
  )
}
