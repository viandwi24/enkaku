'use client'

import { Suspense } from 'react'
import { LoadingRows } from '@enkaku/ui'
import AgentsPage from '@/components/agents/AgentsPage'

export default function Page() {
  return (
    <Suspense fallback={<div className="px-5 py-4"><LoadingRows rows={4} /></div>}>
      <AgentsPage />
    </Suspense>
  )
}
