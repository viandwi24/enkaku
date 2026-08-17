'use client'

import { Suspense, useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { PluginViewResponseSchema, type PluginViewResponse } from '@enkaku/protocol'
import { PageHeader } from '@/components/layout/PageHeader'
import { FrameView } from '@/components/plugin-view/FrameView'
import { ViewRenderer } from '@/components/plugin-view/ViewRenderer'
import { EmptyState, ErrorState, LoadingRows } from '@/components/states'
import { Badge } from '@/components/ui/badge'
import { api } from '@/lib/actions'

/**
 * Plan 108 §3.5, §5 step 108.7 — the ONE page every plugin screen renders
 * through.
 *
 * **Query parameters, not route segments.** Studio is `output: 'export'`, so
 * there is no server to resolve `/plugins/[name]/[view]`; the address is
 * `/plugins/view?name=<plugin>&view=<viewId>`, exactly as `/device?id=…`
 * established. The directory nests under the existing `app/plugins/`, so the
 * orphan check in `AppShell.test.tsx` (which reads only the TOP level of
 * `src/app/`) is satisfied without a nav entry of its own — the real entry is
 * the dynamic one the plugin declares, injected by `AppShell` in step 108.8.
 *
 * **A plugin that stops being active while its page is open** answers 404
 * `plugin_not_found` on the view fetch, and this page says so by NAME
 * (criterion 9): an empty table would tell an operator that their data had
 * been deleted, which is a different and much worse thing than a plugin
 * having been disabled in another tab.
 */

function describeFailure(plugin: string, viewId: string, err: unknown): string {
  const code = err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : null
  if (code === 'plugin_not_found') {
    return `The plugin “${plugin}” is no longer active, so this screen has nothing behind it. It was disabled, removed, or its dev slot expired — its sidebar entry disappears on the next reload.`
  }
  if (code === 'view_not_found') {
    return `The plugin “${plugin}” is active but no longer declares a screen called “${viewId}”. A newer version of the plugin may have renamed or dropped it.`
  }
  return err instanceof Error ? err.message : String(err)
}

function PluginView() {
  const params = useSearchParams()
  const plugin = params.get('name')
  const viewId = params.get('view')

  const [resolved, setResolved] = useState<PluginViewResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    if (!plugin || !viewId) return
    setError(null)
    setResolved(null)
    void api(`/api/plugins/${encodeURIComponent(plugin)}/view/${encodeURIComponent(viewId)}`, PluginViewResponseSchema)
      .then(setResolved)
      .catch((e) => setError(describeFailure(plugin, viewId, e)))
  }, [plugin, viewId])

  useEffect(load, [load])

  if (!plugin || !viewId) {
    return (
      <>
        <PageHeader title="Plugin screen" />
        <div className="px-5 py-4">
          <EmptyState
            title="The address is missing a plugin and a view"
            description="A plugin screen is opened from its own sidebar entry, which carries both — /plugins/view?name=…&view=…"
          />
        </div>
      </>
    )
  }

  if (error) {
    return (
      <>
        <PageHeader title={plugin} description="Plugin screen" />
        <div className="px-5 py-4">
          <ErrorState message={error} onRetry={load} />
        </div>
      </>
    )
  }

  if (!resolved) {
    return (
      <>
        <PageHeader title={plugin} description="Plugin screen" />
        <div className="px-5 py-4">
          <LoadingRows rows={4} />
        </div>
      </>
    )
  }

  const header = (
    <PageHeader
      title={resolved.view.title}
      description={resolved.view.description}
      meta={
        <span className="flex items-center gap-2">
          {resolved.origin === 'dev' && <Badge variant="outline">DEV</Badge>}
          <span className="readout text-[11.5px] text-fg-muted">
            {resolved.plugin} {resolved.version}
          </span>
        </span>
      }
    />
  )

  // Tier A or tier B, decided by which half the view declares (plan 108 §3.2,
  // §4.4, step 108.10). `ViewSpecSchema` already refuses a view that declares
  // both or neither — `validatePluginSurface` names the offending view id at
  // verify — so this page reads the answer rather than re-deriving it, and the
  // header, the DEV chip and every error state above are written once for both
  // tiers rather than forked per tier.
  //
  // The frame branch is a `h-full` flex COLUMN because a `height: 'fill'` frame
  // has to fill what is left below the header, and the only honest way to say
  // that is to make the header and the frame flex siblings (plan 73 §3.1 — the
  // alternative, a viewport `calc()`, is a guess at the header's height that
  // `design-rules.test.ts` refuses outright). A table scrolls inside `main` as
  // every other list screen does, so tier A keeps the plain fragment.
  if (resolved.view.frame) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {header}
        <FrameView plugin={resolved.plugin} viewId={resolved.viewId} view={resolved.view} actions={resolved.actions} />
      </div>
    )
  }

  return (
    <>
      {header}
      <ViewRenderer plugin={resolved.plugin} view={resolved.view} actions={resolved.actions} />
    </>
  )
}

export default function PluginViewPage() {
  return (
    <Suspense
      fallback={
        <div className="px-5 py-4">
          <LoadingRows rows={4} />
        </div>
      }
    >
      <PluginView />
    </Suspense>
  )
}
