'use client'

import { useEffect, useState } from 'react'
import { z } from 'zod'
import { AdbStatsResponseSchema } from '@enkaku/protocol'
import { api } from '@enkaku/ui'

/** No `AdbStatsResponse` type is exported from `@enkaku/protocol` (every existing caller — `AdbServerCard.tsx`, `Wall.tsx`, `settings/page.tsx` — reads straight off the schema too), so this is inferred locally rather than added to that contested barrel. */
export type AdbStatsResponse = z.infer<typeof AdbStatsResponseSchema>

/**
 * `GET /api/adb/stats`, polled every `intervalMs` while — and only while —
 * this hook is both mounted AND the browser tab is visible (plan 92 §3.9,
 * §5 step 92.8's own third warning: "every 2s forever, in every open tab,
 * against a farm of 100 devices, is a real cost"). Mirrors `useNow.ts`'s
 * established start/stop shape (`document.hidden`/`visibilitychange`)
 * rather than inventing a second one.
 *
 * Mounting is itself the other half of "while visible" here: the caller
 * (`FarmVideoFields`, `DeviceVideoFields`) only renders while its own
 * settings section is the active `SectionNav` tab (`SectionNav.tsx`'s
 * `resolved?.render()` calls the render function of the ACTIVE section
 * only), so switching to a different tab already unmounts this hook before
 * `document.visibilityState` ever needs to be consulted for that case.
 *
 * `useAdbVideoStatsPoll.test.ts` proves the interval is cleared on unmount
 * AND on `visibilitychange` to hidden, which is the exact defect this
 * hook's own doc comment exists to keep from happening again — a leaked
 * `setInterval` in a static-export SPA outlives the component that started
 * it.
 */
export function useAdbVideoStatsPoll(intervalMs: number): { stats: AdbStatsResponse | null; error: string | null } {
  const [stats, setStats] = useState<AdbStatsResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let id: ReturnType<typeof setInterval> | null = null

    const load = () => {
      api('/api/adb/stats', AdbStatsResponseSchema)
        .then((b) => {
          if (cancelled) return
          setStats(b)
          setError(null)
        })
        .catch((e) => {
          if (cancelled) return
          setError(e instanceof Error ? e.message : String(e))
        })
    }
    const start = () => {
      if (id !== null) return
      load()
      id = setInterval(load, intervalMs)
    }
    const stop = () => {
      if (id === null) return
      clearInterval(id)
      id = null
    }

    if (document.hidden) {
      // Start paused — `onVisibility` starts the interval (and refreshes
      // immediately) the moment the tab is actually looked at.
    } else {
      start()
    }

    const onVisibility = () => {
      if (document.hidden) stop()
      else start()
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisibility)
      stop()
    }
  }, [intervalMs])

  return { stats, error }
}
