'use client'

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { PluginViewResponseSchema, type PluginViewResponse } from '@enkaku/protocol'
import { PageHeader } from '@/components/layout/PageHeader'
import { ReactView } from '@/components/plugin-view/ReactView'
import { ViewRenderer } from '@/components/plugin-view/ViewRenderer'
import { EmptyState, ErrorState, LoadingRows, Badge, api } from '@enkaku/ui'
import type { PluginViewParams, SetPluginViewParams } from '@/lib/plugin-host'

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

/**
 * The two query keys Studio owns (plan 111 §9 Q2). Everything else in the
 * query belongs to the plugin and is passed through untouched — the host takes
 * no position on what it means, which is exactly the decision: a tabbed tier-C
 * screen wants its tab in the URL so a reload lands where the operator was,
 * and inventing a vocabulary for that here would put a ceiling back on the
 * tier this plan exists to remove.
 */
const CLAIMED_PARAMS = new Set(['name', 'view'])

function unclaimed(search: string): PluginViewParams {
  const out: Record<string, string> = {}
  for (const [key, value] of new URLSearchParams(search)) {
    if (CLAIMED_PARAMS.has(key)) continue
    out[key] = value
  }
  return out
}

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

  // §9 Q2 — the passthrough. Derived from the router's own view of the query
  // so that back/forward and a reload all land on the same object.
  const search = params.toString()
  const passthrough = useMemo(() => unclaimed(search), [search])

  /**
   * The write-back, and why it is `history.replaceState` rather than
   * `router.replace`.
   *
   * Both update the URL without a document load, but `router.replace` is a
   * NAVIGATION: under `output: 'export'` the App Router resolves the route
   * again, and a plugin whose tab state lives in its own `useState` would be
   * at the mercy of whether its subtree survives that. `replaceState` is a
   * pure URL edit — Next patches both native history methods and feeds them
   * into `useSearchParams` (which is what re-renders this page), so the
   * plugin's component is re-rendered with new props and never remounted, and
   * a reload still lands on the tab it wrote. A plain `<a>` is of course out
   * entirely (`CLAUDE.md`): it would remount the whole app.
   *
   * Read through a ref rather than closing over `search`, so the identity is
   * stable for the life of the page — a plugin is going to put this in a
   * `useEffect` dependency array or a `useCallback`, and a setter that changed
   * on every URL edit would re-run it every time.
   */
  const searchRef = useRef(search)
  searchRef.current = search
  const setParams = useCallback<SetPluginViewParams>((patch) => {
    // The live URL first, the router's last render second. `replaceState`
    // updates `window.location` synchronously but the router only re-renders
    // afterwards, so two calls in the same tick would otherwise build the
    // second from a base that has already been superseded and drop the first.
    const live = typeof window === 'undefined' ? '' : window.location.search.replace(/^\?/, '')
    const next = new URLSearchParams(live || searchRef.current)
    for (const [key, value] of Object.entries(patch)) {
      // Silently ignored rather than obeyed: these two address the screen, and
      // a plugin rewriting them would send itself somewhere else mid-render.
      if (CLAIMED_PARAMS.has(key)) continue
      if (value === null) next.delete(key)
      else next.set(key, value)
    }
    const query = next.toString()
    window.history.replaceState(null, '', query ? `${window.location.pathname}?${query}` : window.location.pathname)
  }, [])

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

  // The renderer choice, and the ONLY place it is made. `ViewRenderer` draws
  // tier A (a declared `data` + `table`, plan 108 §3.2/§4.4); `ReactView`
  // draws tier C (a `react` module out of the package's `ui/`, plan 111 §3.1).
  // The two are mutually exclusive and exactly one is required — enforced at
  // verify by `validatePluginSurface`, so the `react` test below is a
  // discriminator, not a guess.
  //
  // The header, the DEV chip and every error state above are written once
  // here rather than per tier.
  //
  // Plan 108's tier B (a sandboxed iframe, `FrameView`) was REMOVED by plan
  // 111 §3.6 rather than deprecated: once a plugin can ship real React with
  // full page access, nobody would choose an iframe that cannot even `fetch`,
  // and 00-overview §4.3 forbids keeping a weaker parallel path around.
  const react = resolved.view.react
  return (
    <>
      {header}
      {react ? (
        // `resolved.version` and not the manifest's declared version: for a
        // dev slot the core answers `1.2.0+dev.<n>`, and that `<n>` increments
        // on every `enkaku dev` push. It is both half of the registry key and
        // the `?v=` on the script URL, which is what makes a rebuild serve the
        // NEW component instead of the module map's copy of the old one (plan
        // 111 criterion 8).
        <ReactView
          plugin={resolved.plugin}
          version={resolved.version}
          viewId={resolved.viewId}
          entry={react.entry}
          params={passthrough}
          setParams={setParams}
        />
      ) : (
        <ViewRenderer plugin={resolved.plugin} view={resolved.view} actions={resolved.actions} />
      )}
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
