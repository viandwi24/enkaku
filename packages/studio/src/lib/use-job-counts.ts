'use client'

import { useEffect, useRef, useState } from 'react'
import { BatchesPageResponseSchema, JobsPageResponseSchema } from '@enkaku/protocol'
import { api } from '@enkaku/ui'
import { ws } from './ws'

/** The five chips the handoff draws, in its order. `all` is a filter, not a status. */
export type JobFilter = 'all' | 'running' | 'queued' | 'success' | 'failed'
export const JOB_FILTERS: readonly JobFilter[] = ['all', 'running', 'queued', 'success', 'failed']

export interface JobCounts {
  /** The tab strip's two numbers. */
  jobs: number | null
  batches: number | null
  /** The five filter chips, keyed by filter. Null until the first read settles. */
  byFilter: Record<JobFilter, number | null>
}

const EMPTY_BY_FILTER: Record<JobFilter, number | null> = { all: null, running: null, queued: null, success: null, failed: null }

/**
 * Six `limit=1` reads, seeded at mount and recomputed on a COALESCED push
 * (plan 218 §3.5). `GET /api/jobs` and `GET /api/batches` both answer with a
 * `total`, so a count costs one row, not a page.
 *
 * The 5000 ms timer is trailing-edge and armed only by a `job.status` or
 * `batch.status` message: an idle farm makes no request at all, and a farm
 * running forty batches makes one refresh every five seconds rather than one
 * per push. This is deliberately NOT a poll, and it is the only timer on the
 * Jobs screen (plan 218 G13 exempts this file by name).
 */
export function useJobCounts(): JobCounts & { refresh: () => void } {
  const [jobs, setJobs] = useState<number | null>(null)
  const [batches, setBatches] = useState<number | null>(null)
  const [byFilter, setByFilter] = useState<Record<JobFilter, number | null>>(EMPTY_BY_FILTER)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  function load(): void {
    void api('/api/jobs?limit=1', JobsPageResponseSchema)
      .then((p) => setJobs(p.total))
      .catch(() => undefined)
    void api('/api/batches?limit=1', BatchesPageResponseSchema)
      .then((p) => setBatches(p.total))
      .catch(() => undefined)
    for (const f of JOB_FILTERS) {
      const qs = f === 'all' ? '/api/jobs?limit=1' : `/api/jobs?limit=1&status=${f}`
      void api(qs, JobsPageResponseSchema)
        .then((p) => setByFilter((prev) => ({ ...prev, [f]: p.total })))
        .catch(() => undefined)
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const off = ws.on((m) => {
      if (m.type !== 'job.status' && m.type !== 'batch.status') return
      if (timer.current !== null) return
      timer.current = setTimeout(() => {
        timer.current = null
        load()
      }, 5000)
    })
    return () => {
      off()
      if (timer.current !== null) {
        clearTimeout(timer.current)
        timer.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return { jobs, batches, byFilter, refresh: load }
}
