'use client'

import { Suspense } from 'react'
import { LoadingRows } from '@enkaku/ui'
import { DevicesScreen } from '@/components/devices/DevicesScreen'

/**
 * The landing page (MVP 03 §1.2: "the landing page stays Devices"). Every
 * piece of state, every fetch and every gesture lives in
 * `components/devices/`; this file exists only to satisfy Next's route
 * convention and to supply the `<Suspense>` boundary a static export needs
 * before it will prerender a `useSearchParams()` caller (the same boundary
 * the 1929 line version it replaces used at its own `:1923-1928`).
 */
export default function DevicesPage() {
  return (
    <Suspense fallback={<div className="p-[14px]"><LoadingRows rows={6} /></div>}>
      <DevicesScreen />
    </Suspense>
  )
}
