'use client'

import { Suspense } from 'react'
import { LoadingRows } from '@enkaku/ui'
import { JobsScreen } from '@/components/jobs/JobsScreen'

/**
 * Jobs (design handoff, "Screen: Jobs"). One page, two tabs, two columns; the
 * detail is not a second route (plan 218 §3.3). `Suspense` is what a static
 * export needs before it will prerender a `useSearchParams()` caller at all.
 */
export default function JobsPage() {
  return (
    <Suspense
      fallback={
        <div className="p-[14px]">
          <LoadingRows rows={6} />
        </div>
      }
    >
      <JobsScreen />
    </Suspense>
  )
}
