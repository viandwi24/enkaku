import { useCallback } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger, type PluginViewProps } from '@enkaku/ui'
import { BANNER_NOT_BUILT } from '../shared'
import { AssignmentsTab } from './parts/assignments'
import { CatalogueTab } from './parts/catalogue'
import { RunsTab } from './parts/runs'

/**
 * Proxy manager, on tier C (plan 111 step 111.7).
 *
 * This is the pack the owner's own goal named — *"kalau mau bikin tabs, bikin
 * apapun itu"* — rebuilt from a declared table into ordinary React, to see
 * whether the tier actually delivers that. Four things it leans on, each of
 * which is the point of a different half of plan 111:
 *
 * 1. **Hooks, in a plugin.** `useState`/`useCallback` here and in every part
 *    below run on **Studio's own React instance**, handed over by the import
 *    map (§3.2, T4). A second copy would throw `Invalid hook call` at the
 *    first one of these.
 * 2. **`@enkaku/ui` is the host's live components — and more.** `Tabs` below
 *    is not a lookalike of Studio's `Tabs`; it is the same one, so this screen
 *    picks up Studio's next change to it on the day Studio does (§3.3). Since
 *    the §3.3 extraction it also carries the behaviour layer this pack used to
 *    hand-write: `api()`, `coreBase()`, `EmptyState`/`ErrorState`/
 *    `LoadingRows`, `relativeTime`, and `PluginViewProps` (the type of this
 *    component's own props, below, which used to be copied into
 *    `enkaku-host.d.ts` and checked by nothing).
 * 3. **The tab lives in the URL** (§9 Q2). `params`/`setParams` are the
 *    unclaimed half of the query, handed over uninterpreted, so a reload lands
 *    where the operator was. This screen keeps TWO independent keys there —
 *    `tab` and `q` — which is exactly the case the patch semantics exist for:
 *    writing one never has to know about the other.
 * 4. **Its own stylesheet** (§9 Q1, step 111.9). `index.css` beside this file
 *    compiles to `ui/index.css` in the package, and Studio links it before
 *    this module. Two classes below — the banner's hazard stripes and the
 *    dialog's `grid-cols-[max-content_1fr]` — are ones Studio has never
 *    compiled, and they are visibly absent if that link does not happen.
 *
 * ## The banner is not decoration
 *
 * `BANNER_NOT_BUILT` sits above the tabs, on every tab, for as long as it is
 * true (plan 111 criterion 12; `docs/design.md`: *a degraded or partial state
 * is never worded as the full one*). A React rewrite is precisely the moment a
 * screen starts LOOKING finished, and this pack still stores rows and contacts
 * nothing. The sentence is declared in `../shared.ts` and used by the manifest
 * too, so the plugin list and the screen cannot drift into disagreeing.
 */

const TABS = [
  { id: 'catalogue', label: 'Catalogue' },
  { id: 'assignments', label: 'Assignments' },
  { id: 'runs', label: 'Runs' },
] as const

type TabId = (typeof TABS)[number]['id']

const DEFAULT_TAB: TabId = 'catalogue'

function isTab(value: string | undefined): value is TabId {
  return TABS.some((tab) => tab.id === value)
}

function ProxyManagerView({ params, setParams }: PluginViewProps) {
  /**
   * The URL is the state, not a copy of it. There is no `useState` for the
   * tab: `params.tab` is read straight from the query and `setParams` writes
   * it back, so a reload, a Back, and a link somebody pasted all land on the
   * same tab with no synchronisation to get wrong.
   *
   * An unknown `?tab=` falls back to the catalogue rather than rendering
   * nothing — a URL is something a person can type.
   */
  const tab: TabId = isTab(params.tab) ? params.tab : DEFAULT_TAB
  const query = params.q ?? ''

  // Two independent writers over one query string. Neither passes the other's
  // key, and neither has to: a key absent from the patch is left exactly as it
  // was (§9 Q2). Clearing the filter passes `null` rather than `''`, so the
  // URL loses the parameter instead of carrying `&q=`.
  const setTab = useCallback((next: string) => setParams({ tab: next === DEFAULT_TAB ? null : next }), [setParams])
  const setQuery = useCallback((next: string) => setParams({ q: next === '' ? null : next }), [setParams])

  return (
    <div className="space-y-4">
      {/*
        The plugin's own Tailwind, class one of two: diagonal hazard stripes
        behind the honesty banner. `repeating-linear-gradient` appears nowhere
        in Studio's compiled CSS, so this renders as a flat panel — visibly
        wrong, rather than invisibly wrong — if `ui/index.css` never arrives.
      */}
      <div className="rounded-lg border border-led-warn/35 bg-[repeating-linear-gradient(135deg,transparent_0_9px,rgb(255_255_255/0.035)_9px_18px)] px-4 py-3">
        <p className="text-[12.5px] font-medium">Nothing on this screen contacts a proxy</p>
        <p className="mt-1 max-w-prose text-[12px] leading-relaxed text-fg-muted">{BANNER_NOT_BUILT}</p>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList variant="line">
          {TABS.map((entry) => (
            <TabsTrigger key={entry.id} value={entry.id}>
              {entry.label}
            </TabsTrigger>
          ))}
        </TabsList>

        {/*
          `forceMount` is deliberately NOT used: an unmounted tab stops
          fetching, and the Runs tab reads the farm's whole jobs list. The cost
          is a refetch on return, which is the right trade for a screen an
          operator leaves open.
        */}
        <TabsContent value="catalogue" className="pt-2">
          <CatalogueTab query={query} onQueryChange={setQuery} />
        </TabsContent>
        <TabsContent value="assignments" className="pt-2">
          <AssignmentsTab />
        </TabsContent>
        <TabsContent value="runs" className="pt-2">
          <RunsTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}

/**
 * A module served to Studio does not EXPORT its component — it REGISTERS it. A
 * `<script type="module">` has no return value, so the host waits on a promise
 * keyed by (plugin, version, view) that this call resolves. The id must match
 * the key under `surface.views` in `../index.ts`.
 */
window.__enkaku__.register('proxies', ProxyManagerView)
