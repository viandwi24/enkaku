import { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '@enkaku/ui'

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
 * The two below stayed on purpose. Neither has a canonical Studio version to
 * share: `useLoader` is this pack's own load/reload shape (Studio's screens
 * each roll their own), and `StatusDot` is a deliberately plainer thing than
 * Studio's `StatusBadge`, which knows the farm's own job and device
 * vocabularies. Extracting either would have meant inventing an API rather
 * than sharing one.
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
