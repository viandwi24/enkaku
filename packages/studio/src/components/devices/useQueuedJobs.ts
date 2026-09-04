'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { JobInfoSchema } from '@enkaku/protocol'
import { api, z } from '@enkaku/ui'
import { ws } from '@/lib/ws'

/**
 * Queued jobs per device (plan 214 §3.8) — the Task pill's fourth variant,
 * "queued", has no source in plan 205's activity registry: an entry there
 * exists only for the LIFE OF A RUN (`docs/mvp/04` §1.1), never for a job
 * still waiting to start. This hook seeds once from `GET /api/jobs?status=
 * queued` and follows `job.status` afterward — the same seed-plus-push shape
 * plan 213 §4.3 rule 5 uses for the status bar's own queued counter,
 * including the same bounded drift (a job queued before mount that is
 * cancelled without ever running is only forgotten on the next reconnect)
 * and the same repair (reseed on `ws.onReconnected`).
 */
export function useQueuedJobs(): { queuedFor: (deviceId: string) => number } {
  const [byDevice, setByDevice] = useState<Map<string, number>>(new Map())
  // jobId -> deviceId, so a job leaving 'queued' can be removed without a refetch.
  const jobDeviceRef = useRef<Map<string, string>>(new Map())

  const recompute = useCallback(() => {
    const counts = new Map<string, number>()
    for (const deviceId of jobDeviceRef.current.values()) {
      counts.set(deviceId, (counts.get(deviceId) ?? 0) + 1)
    }
    setByDevice(counts)
  }, [])

  const seed = useCallback(() => {
    api('/api/jobs?status=queued&limit=500', z.object({ items: z.array(JobInfoSchema) }))
      .then((body) => {
        const map = new Map<string, string>()
        for (const job of body.items) map.set(job.jobId, job.deviceId)
        jobDeviceRef.current = map
        recompute()
      })
      .catch(() => {
        // Leave whatever the previous seed/pushes computed — the same
        // "a failed read leaves that slice where it was" rule §4.14 states
        // for `useDevices`.
      })
  }, [recompute])

  useEffect(() => {
    seed()
    const offReconnect = ws.onReconnected(seed)
    const off = ws.on((msg) => {
      if (msg.type !== 'job.status') return
      if (msg.payload.status === 'queued') {
        jobDeviceRef.current.set(msg.payload.jobId, msg.payload.deviceId)
      } else {
        jobDeviceRef.current.delete(msg.payload.jobId)
      }
      recompute()
    })
    return () => {
      offReconnect()
      off()
    }
  }, [seed, recompute])

  const queuedFor = useCallback((deviceId: string) => byDevice.get(deviceId) ?? 0, [byDevice])

  return { queuedFor }
}
