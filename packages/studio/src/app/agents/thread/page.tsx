'use client'

import { Suspense, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { LoadingRows } from '@enkaku/ui'

/**
 * `/agents/thread` was Plan 66/67's minimal thread view. Plan 69 folds its
 * exact behaviour — the SAME `Transcript`/`ThreadList` components, not a
 * rebuild — into `/agents/detail?id=`'s "Workbench" tab (`CLAUDE.md`'s
 * "Replace, never version": this is a prototype with one client, so the
 * route moves rather than growing a permanent duplicate).
 *
 * This redirects rather than 404ing so a bookmark or an existing link
 * (`NotificationBell`, an old chat message, a `ChildRunCard`-style URL
 * built by hand) still lands somewhere useful. `router.replace`, not a
 * `<a href>` — this is client-side navigation, not the kind of internal
 * link criterion 12 is about.
 */
function ThreadRedirect() {
  const params = useSearchParams()
  const router = useRouter()
  const agentId = params.get('agentId')
  const threadId = params.get('id')

  useEffect(() => {
    if (!agentId) {
      router.replace('/agents')
      return
    }
    router.replace(`/agents/detail?id=${agentId}${threadId ? `&thread=${threadId}` : ''}`)
  }, [agentId, threadId, router])

  return (
    <div className="px-5 py-4">
      <LoadingRows rows={4} />
    </div>
  )
}

export default function ThreadPage() {
  return (
    <Suspense fallback={<LoadingRows rows={4} />}>
      <ThreadRedirect />
    </Suspense>
  )
}
