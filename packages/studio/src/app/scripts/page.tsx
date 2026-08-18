'use client'

import { Suspense, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'

/**
 * Scripts and Plugins merge into one page (owner's own ask, 2026-08-17:
 * *"halaman scripts menurut saya jadi satu aja dengan plugins"*) — one screen
 * for "what code can this farm run" instead of two, since a plugin's scripts
 * were listed on both anyway. The route stays, as a redirect, so an old
 * bookmark or link still lands somewhere useful instead of a 404; the
 * `scripts/detail` pages underneath it are untouched and still the only place
 * a script's versions, source and param sets live.
 *
 * The query is carried over rather than dropped: `?device=`/`?cluster=` are
 * what make the Run flow open its dialog on arrival, so a bookmarked or
 * in-flight `/scripts?device=…` must reach `/plugins` still carrying it.
 *
 * `/plugins` is two tabs now (`?tab=plugins|scripts`), and nothing here has to
 * say so: either of those parameters arriving with no explicit `?tab=` selects
 * the Scripts tab on the other side, which is what "run a script on this
 * device" meant in the first place. A bare `/scripts` still lands on Plugins,
 * the same first thing the screen has always shown.
 */
function ScriptsRedirect() {
  const router = useRouter()
  const params = useSearchParams()
  const query = params.toString()

  useEffect(() => {
    router.replace(query ? `/plugins?${query}` : '/plugins')
  }, [router, query])

  return null
}

export default function ScriptsPage() {
  return (
    <Suspense fallback={null}>
      <ScriptsRedirect />
    </Suspense>
  )
}
