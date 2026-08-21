import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * What this pack needs beyond `@enkaku/ui`'s own components and behaviour
 * layer — one hook, copied from `plugins/proxy-manager/src/ui/parts/
 * bits.tsx`'s own `useLoader` (that file's header explains why this has no
 * canonical Studio version to share: every screen in this product rolls its
 * own load/reload shape).
 */

/**
 * Load once, reload on demand, and never write state into a component that
 * has already unmounted (switching tabs mid-fetch is the ordinary way to hit
 * that).
 *
 * A hook, in a plugin, using the HOST's React (plan 111 §3.2/T4) — if a
 * second React copy had been bundled, this line is where the screen would
 * die with `Invalid hook call`.
 */
export function useLoader<T>(load: () => Promise<T>, deps: unknown[]): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
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
