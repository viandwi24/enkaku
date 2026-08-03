'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Devices and Topology merge into one page (plan 47 §3.6, §4.5, acceptance
 * #11): the fleet page's `view` × `group` controls now cover exactly what
 * this route used to render on its own — `view=wall&group=cluster` is
 * "every device belongs to at most one cluster", the whole of what Topology
 * showed. The route stays, as a redirect, so an old bookmark or link still
 * lands somewhere useful instead of a 404.
 */
export default function TopologyPage() {
  const router = useRouter()

  useEffect(() => {
    router.replace('/?view=wall&group=cluster')
  }, [router])

  return null
}
