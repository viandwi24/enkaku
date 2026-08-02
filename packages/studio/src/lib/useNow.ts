'use client'

import { useEffect, useState } from 'react'

/**
 * A timestamp that advances, for anything showing elapsed or relative time.
 *
 * Formatters stay pure (`duration`, `relativeTime` in `format.ts`); this is the
 * only thing that makes them re-run. One interval per component beats a timer
 * inside every row (Plan 17 §4.6).
 *
 * Stops ticking while the tab is hidden — a backgrounded tab has no reason to
 * burn a per-second timer — and resyncs to the real clock on `visibilitychange`,
 * so the value is never stale the moment the tab is focused again.
 */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    let id: ReturnType<typeof setInterval> | null = null

    const start = () => {
      setNow(Date.now())
      if (id === null) id = setInterval(() => setNow(Date.now()), intervalMs)
    }
    const stop = () => {
      if (id !== null) {
        clearInterval(id)
        id = null
      }
    }

    if (document.hidden) {
      // Start paused — `onVisibility` resyncs and starts the interval the
      // moment the tab is actually looked at.
    } else {
      start()
    }

    const onVisibility = () => {
      if (document.hidden) stop()
      else start()
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      stop()
    }
  }, [intervalMs])

  return now
}
