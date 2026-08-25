'use client'

import { Suspense, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { AlertTriangle, FileCode2, Play, Plus, RefreshCw, Search, X } from 'lucide-react'
import { toast } from 'sonner'
import {
  PluginRestartResponseSchema,
  PluginOkResponseSchema,
  ScriptGroupsPageResponseSchema,
  ScriptResponseSchema,
  ScriptToggleResponseSchema,
  type DevSlotView,
  type DeviceInfo,
} from '@enkaku/protocol'
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Input,
  LoadingRows,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  api,
  cn,
  relativeTime,
  useAction,
} from '@enkaku/ui'
import { EntityTabs } from '@/components/layout/EntityTabs'
import { PageHeader } from '@/components/layout/PageHeader'
import { PaginatedTable, type PaginatedTableHandle } from '@/components/PaginatedTable'
import { InstallPluginDialog } from '@/components/plugins/InstallPluginDialog'
import { PluginActions } from '@/components/plugins/PluginActions'
import { RunScriptDialog, type ScriptRow } from '@/components/RunScriptDialog'
import { PluginStatusBadge } from '@/components/StatusBadge'
import { fetchDevices } from '@/lib/api'
import { coreBase } from '@/lib/ws'
import {
  PluginsListSchema,
  devSlotMatches,
  groupPlugins,
  scriptMatches,
  searchPlugins,
  type PluginMatch,
  type PluginListRow,
} from './plugin-list'

/**
 * The Plugins & scripts page (plan 82 §4.6, criteria 29, 30). Its one job: a
 * plugin that fails must be findable without reading a log file.
 *
 * - Failed plugins sort first.
 * - A failed plugin's error renders VERBATIM, with its code — never summarised.
 * - "Which scripts registered" is `scriptCount` (a live count of `scripts`
 *   rows — 0 for a failed plugin, since registration is all-or-nothing per
 *   plugin, plan 82 §3.8); "which were declared" is `manifest.scripts` when the
 *   bundle got far enough to report one.
 * - Dev slots carry their own DEV badge, owner, and last-build result.
 *
 * ---------------------------------------------------------------------------
 * TWO TABS AND A SEARCH BOX (owner's own ask, 2026-08-18: *"di halaman plugins
 * dan scripts keknya dibuatkan tab aja jadi tab Plugins dan Script, ada search
 * inputnya juga"*), replacing the two stacked sections this screen shipped with.
 * ---------------------------------------------------------------------------
 *
 * The stacked version had three arguments behind it, all of them about the
 * first question this screen exists to answer — *is anything broken?* Each is
 * answered here rather than dropped:
 *
 *  1. *"A tab hides one list behind a click, and the sidebar's failed-plugin
 *     badge links HERE."* — The failed-plugin warning is rendered ABOVE THE TAB
 *     STRIP, so it is on screen on both tabs, and the Plugins tab additionally
 *     carries a danger marker. An operator following that badge sees the
 *     warning wherever they land, and the default tab is Plugins anyway.
 *  2. *"The two lists have INDEPENDENT loads, and a tab hides a failure as
 *     readily as it hides a list."* — **Both panels stay mounted and both
 *     fetch on mount**; the inactive one is `display: none`, not unmounted. A
 *     `/api/scripts` 500 therefore still happens, is still detected, and marks
 *     its own tab with a danger triangle instead of being silent behind a
 *     closed tab. This is the whole reason the panels are hidden rather than
 *     conditionally rendered — it costs one already-cheap request and buys back
 *     the only real objection to tabbing this screen.
 *  3. *"The warning must never be pushed below the fold by a long script
 *     list."* — It cannot be: it is above the tab strip, which is above every
 *     list.
 *
 * **URL parameters.** `?tab=plugins|scripts` and `?q=<search>`, both in the
 * query string because Studio is a static export (`output: 'export'`) — no
 * route segments, `next/link` for the tabs, never a plain `<a>`. `?device=`
 * and `?cluster=` still arrive here from a device card's Run button and from
 * `/scripts`'s redirect, are untouched, and now additionally select the
 * Scripts tab by default, since "run a script on this device" is what they
 * mean. One `q` serves both tabs and is carried across a tab switch: typing
 * `tiktok` on Plugins and switching to Scripts shows `tiktok/*`, which is the
 * useful behaviour rather than an accident.
 */

function isoTime(v: string | null): string {
  if (!v) return '—'
  const ms = Date.parse(v)
  return Number.isNaN(ms) ? v : relativeTime(Math.floor(ms / 1000))
}

/** What the search box covers, per tab, said on the screen rather than left to be guessed. */
const SEARCH_HINT = {
  plugins: 'Matches a plugin’s name, title, description, any of its version strings, and the scripts it registers.',
  scripts: 'Matches a script’s full name — always plugin/script, so the plugin half is searchable too — and its latest version.',
} as const

type TabKey = 'plugins' | 'scripts'

export default function PluginsPage() {
  return (
    <Suspense
      fallback={
        <div className="px-5 py-4">
          <LoadingRows rows={4} />
        </div>
      }
    >
      <PluginsScreen />
    </Suspense>
  )
}

function PluginsScreen() {
  const params = useSearchParams()
  const [items, setItems] = useState<PluginListRow[] | null>(null)
  const [dev, setDev] = useState<DevSlotView[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { run, isPending } = useAction()

  // The Scripts panel owns its own fetch; it reports its outcome up so the tab
  // strip can carry a count and — the point of keeping it mounted — a marker
  // when it failed while the operator was looking at the other tab.
  const [scriptCount, setScriptCount] = useState<number | null>(null)
  const [scriptError, setScriptError] = useState<string | null>(null)

  const tabParam = params.get('tab')
  const hasRunTarget = Boolean(params.get('device') || params.get('cluster'))
  const tab: TabKey = tabParam === 'scripts' || tabParam === 'plugins' ? tabParam : hasRunTarget ? 'scripts' : 'plugins'

  // Typed into local state so the field never lags a keystroke, mirrored into
  // `?q=` with `replaceState` (not `router.replace`) so a reload and a shared
  // link both land on the same filtered screen without the App Router
  // re-resolving the route under a live list.
  const [query, setQuery] = useState(params.get('q') ?? '')
  useEffect(() => {
    if (typeof window === 'undefined') return
    const next = new URLSearchParams(window.location.search)
    if (query) next.set('q', query)
    else next.delete('q')
    const search = next.toString()
    const url = search ? `${window.location.pathname}?${search}` : window.location.pathname
    if (url !== window.location.pathname + window.location.search) window.history.replaceState(null, '', url)
  }, [query])

  const load = () => {
    setError(null)
    api('/api/plugins', PluginsListSchema)
      .then((b) => {
        setItems(b.items)
        setDev(b.dev)
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }
  useEffect(load, [])

  const reloadAll = () =>
    run('restart', () => api('/api/plugins/restart', PluginRestartResponseSchema, { method: 'POST' }), {
      failure: 'Could not restart the plugin registry',
      onSuccess: (b) => {
        toast.success(`Reloaded: ${b.ok} ok, ${b.failed} failed`)
        load()
      },
    })

  const groups = groupPlugins(items ?? [])
  const matches = searchPlugins(groups, query)
  const shownDev = (dev ?? []).filter((s) => devSlotMatches(s, query))
  const failedCount = (items ?? []).filter((p) => p.status === 'failed').length
  const hiddenFailed = query
    ? groups.filter((g) => g.failed).length - matches.filter((m) => m.group.failed).length
    : 0

  const hrefFor = (key: string) => {
    const next = new URLSearchParams(params.toString())
    next.set('tab', key)
    if (query) next.set('q', query)
    else next.delete('q')
    return `/plugins?${next.toString()}`
  }

  return (
    <>
      <PageHeader
        title="Plugins & scripts"
        description="Everything this farm can run — the plugins installed on it, and the scripts they register"
        actions={
          <>
            <Button size="sm" variant="outline" disabled={isPending('restart')} onClick={reloadAll}>
              <RefreshCw className="size-3.5" aria-hidden />
              Reload all
            </Button>
            <InstallPluginDialog
              onInstalled={load}
              trigger={
                <Button size="sm">
                  <Plus className="size-3.5" aria-hidden />
                  Install plugin
                </Button>
              }
            />
          </>
        }
      />

      {/* ABOVE THE TAB STRIP, never inside a tab: this is the answer to the
          first question the screen is opened with, and an operator sitting on
          the Scripts tab must not be the one person on the farm who cannot see
          it. The repo's convention is failed-first, and a tab is exactly the
          kind of container that would make "first" mean "first once you find
          the right tab". */}
      {failedCount > 0 && (
        <div className="px-5 pt-4">
          <div className="flex items-start gap-2.5 rounded-lg border border-led-danger/40 bg-led-danger/5 px-3.5 py-2.5 text-[12.5px] text-led-danger">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span className="min-w-0">
              {failedCount} plugin{failedCount === 1 ? '' : 's'} failed to register — every other plugin, and every script it registered, is
              unaffected. See the error below each one.
              {hiddenFailed > 0 && (
                <>
                  {' '}
                  <button type="button" className="underline underline-offset-2" onClick={() => setQuery('')}>
                    {hiddenFailed} of {hiddenFailed === 1 ? 'them is' : 'them are'} hidden by the current search — clear it.
                  </button>
                </>
              )}
            </span>
          </div>
        </div>
      )}

      <EntityTabs
        active={tab}
        tabs={[
          { key: 'plugins', label: 'Plugins', count: items === null ? null : groups.length, alert: error ?? (failedCount > 0 ? `${failedCount} failed to register` : undefined) },
          { key: 'scripts', label: 'Scripts', count: scriptCount, alert: scriptError ?? undefined },
        ]}
        hrefFor={hrefFor}
      />

      <div className="px-5 py-4">
        <div className="@container mb-4">
          <div className="flex flex-col gap-1.5">
            <div className="relative min-w-0 max-w-md">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-subtle" aria-hidden />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={tab === 'plugins' ? 'Search plugins…' : 'Search scripts…'}
                aria-label={tab === 'plugins' ? 'Search plugins' : 'Search scripts'}
                aria-describedby="plugins-search-hint"
                className="h-8 pr-8 pl-8 text-[12.5px]"
              />
              {query && (
                <button
                  type="button"
                  aria-label="Clear the search"
                  onClick={() => setQuery('')}
                  className="absolute top-1/2 right-2 -translate-y-1/2 text-fg-subtle hover:text-fg"
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              )}
            </div>
            <p id="plugins-search-hint" className="text-[11.5px] leading-relaxed text-fg-subtle">
              {SEARCH_HINT[tab]}
              {tab === 'plugins' && (
                <>
                  {' '}
                  A plugin whose bundle failed before it could report a manifest has no script list to match on, so it is findable by its own
                  name only.
                </>
              )}
            </p>
          </div>
        </div>

        {/* BOTH PANELS STAY MOUNTED — `hidden` is `display: none`, not an
            unmount. See this file's header: it is what keeps the two loads
            genuinely independent and keeps a failure in the inactive tab from
            being a silent one. */}
        <section aria-labelledby="plugins-section-heading" className={cn(tab === 'plugins' ? '' : 'hidden')}>
          <div className="mb-2.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 id="plugins-section-heading" className="text-[13px] font-semibold tracking-tight">
              Plugins
            </h2>
            {query && items !== null && (
              <p className="readout text-[11.5px] text-fg-muted">
                {matches.length + shownDev.length} of {groups.length + (dev?.length ?? 0)} match “{query}”
              </p>
            )}
          </div>

          {error ? (
            <ErrorState message={error} onRetry={load} />
          ) : items === null || dev === null ? (
            <LoadingRows rows={4} />
          ) : items.length === 0 && dev.length === 0 ? (
            <EmptyState
              title="No plugins yet"
              description="Install one with the button above, or publish it from the SDK (definePlugin) — one bundle, many scripts sharing helpers and a KV namespace."
            />
          ) : matches.length === 0 && shownDev.length === 0 ? (
            // A DIFFERENT fact from "there are none at all", and the operator
            // needs to know which one they are looking at.
            <EmptyState
              icon={<Search className="size-4" aria-hidden />}
              title={`No plugin matches “${query}”`}
              description={`${groups.length + dev.length} ${groups.length + dev.length === 1 ? 'plugin is' : 'plugins are'} installed on this farm — none of them by that name, title, description, version, or registered script.`}
              action={
                <Button size="sm" variant="outline" onClick={() => setQuery('')}>
                  Show all plugins
                </Button>
              }
            />
          ) : (
            <>
              {shownDev.length > 0 && (
                <div className="mb-5">
                  <h3 className="mb-2 text-[12px] font-medium text-fg-muted">Dev slots</h3>
                  <div className="space-y-2">
                    {shownDev.map((s) => (
                      <DevSlotCard key={s.pluginName} slot={s} onChanged={load} />
                    ))}
                  </div>
                </div>
              )}

              {matches.length === 0 ? (
                <EmptyState title="No published plugin versions" description="Dev slots above are runnable without publishing." />
              ) : (
                // `overflow-hidden` here and the horizontal scroll one level
                // in: `@enkaku/ui`'s own `Table` already wraps itself in a
                // `w-full overflow-x-auto` div, so a narrow window scrolls the
                // TABLE, never the page (measured at 360 px), and the rounded
                // corners still clip. Same shape `PaginatedTable` uses.
                <div className="overflow-hidden rounded-lg border">
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead>Plugin</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Scripts</TableHead>
                        <TableHead>Verified</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {matches.map((m) => (
                        <PluginRowView key={m.group.name} match={m} onChanged={load} />
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </>
          )}
        </section>

        <section aria-labelledby="scripts-section-heading" className={cn(tab === 'scripts' ? '' : 'hidden')}>
          <ScriptsSection
            query={query}
            onLoaded={(s) => {
              setScriptCount(s.count)
              setScriptError(s.error)
            }}
          />
        </section>
      </div>
    </>
  )
}

function DevSlotCard({ slot: s, onChanged }: { slot: DevSlotView; onChanged: () => void }) {
  const { run, isPending } = useAction()
  // P3 (plan 108 §0.2) — `DELETE /api/plugins/dev/:name` shipped with no way to
  // reach it, so a dev slot rendered here and could only be cleared by waiting
  // for it to expire or restarting the core.
  const drop = () =>
    run('drop-' + s.pluginName, () => api(`/api/plugins/dev/${encodeURIComponent(s.pluginName)}`, PluginOkResponseSchema, { method: 'DELETE' }), {
      success: `Dev slot for ${s.pluginName} dropped`,
      failure: 'Could not drop this dev slot',
      onSuccess: onChanged,
    })

  return (
    <div className="rounded-lg border bg-surface px-3.5 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary">DEV</Badge>
        <span className="font-medium">{s.pluginName}</span>
        <span className="readout text-[11.5px] text-fg-muted">{s.buildVersion}</span>
        <span className="ml-auto text-[11.5px] text-fg-muted">
          {s.lastBuildOk ? 'built' : 'build failed'} {relativeTime(s.lastBuildAt)}
        </span>
        <ConfirmDialog
          trigger={
            <Button size="sm" variant="ghost" className="h-7 text-[12px]" disabled={isPending('drop-' + s.pluginName)}>
              Drop
            </Button>
          }
          title={`Drop the dev slot for ${s.pluginName}?`}
          description={
            <>
              <p>
                This dev build — owned by {s.owner.kind === 'workspace' ? 'workspace' : 'enkaku dev'}{' '}
                <span className="readout">{s.owner.label}</span> — stops resolving straight away. Its {s.scripts.length} script
                {s.scripts.length === 1 ? '' : 's'} go back to whichever published version of <span className="readout">{s.pluginName}</span>{' '}
                is active, and resolve to nothing if there is none.
              </p>
              <p className="mt-2">
                Nothing stored under the <span className="readout">{s.kvNamespace}</span> namespace is deleted, and no published version is
                touched. Rebuilding the slot puts it back.
              </p>
            </>
          }
          confirmLabel="Drop"
          onConfirm={drop}
        />
      </div>
      <p className="mt-1.5 text-[12px] text-fg-muted">
        owned by {s.owner.kind === 'workspace' ? 'workspace' : 'enkaku dev'} <span className="readout">{s.owner.label}</span> — shares the
        published plugin&apos;s KV namespace (<span className="readout">{s.kvNamespace}</span>).
      </p>
      {!s.lastBuildOk && s.lastError && <p className="mt-1.5 whitespace-pre-wrap wrap-anywhere text-[12px] text-led-danger">{s.lastError}</p>}
    </div>
  )
}

/**
 * ONE ROW PER PLUGIN, not per version.
 *
 * This table used to list every published version as its own row, so a plugin
 * iterated on during a session filled the page with near-identical lines —
 * eight `tiktok` rows differing only in a version string. That is a changelog,
 * not an index. Versions live inside the row, in a picker, with the active one
 * selected; the plugin's name links into its own detail page, where the rest of
 * what it carries lives.
 */
function PluginRowView({ match, onChanged }: { match: PluginMatch; onChanged: () => void }) {
  const versions = match.group.versions
  // The version the row is POINTED AT: the live one when there is one,
  // otherwise the newest. Everything below reads from `p`, so selecting a
  // version re-points the whole row — status, counts, verified time, actions.
  const live = versions.find((v) => v.status === 'active')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const p = versions.find((v) => v.id === selectedId) ?? live ?? (versions[0] as PluginListRow)
  const isNewest = versions[0]?.id === p.id

  // Plan 126 §3.2 — `manifest.scripts` projected to id + title by the list
  // route, so this row no longer carries a JSON Schema per member per version.
  const declared = p.declaredScripts
  const registered = p.scriptCount ?? 0
  const detailHref = `/plugins/detail?name=${encodeURIComponent(p.name)}${selectedId ? `&version=${encodeURIComponent(p.version)}` : ''}`

  return (
    <TableRow>
      <TableCell>
        {/*
          A plugin has two names and they are not interchangeable: the human one it was published
          with (`title`, e.g. "TikTok automation pack") and the identifier everything else keys on
          (`name`, e.g. `tiktok` — the KV namespace, and half of every `plugin/script@version` ref).
          Both are here, and the identifier stays in the monospace readout so it is obvious which one
          you can paste into a script reference.
        */}
        <Link href={detailHref} className="font-medium hover:text-accent">
          {p.title?.trim() || p.name}
        </Link>
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
          <span className="readout text-[11.5px] text-fg-muted">{p.name}</span>
          {versions.length > 1 ? (
            <select
              className="readout rounded border bg-surface-2 px-1 py-0.5 text-[11.5px] text-fg-muted"
              value={p.id}
              onChange={(e) => setSelectedId(e.target.value)}
              aria-label={`Version of ${p.name}`}
            >
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.version}
                  {v.status === 'active' ? ' · active' : v.status === 'failed' ? ' · failed' : ''}
                </option>
              ))}
            </select>
          ) : (
            <span className="readout text-[11.5px] text-fg-subtle">{p.version}</span>
          )}
          {isNewest && (
            <span className="rounded-full border border-line px-1.5 text-[10.5px] leading-[1.35] text-fg-subtle">latest</span>
          )}
          {versions.length > 1 && <span className="text-[11px] text-fg-subtle">{versions.length} versions</span>}
          {/* Plan 126 §3.2 — the one bit of `manifest.service` this screen reads. */}
          {p.hasService && (
            <span
              className="rounded-full border border-line px-1.5 text-[10.5px] leading-[1.35] text-fg-subtle"
              title="This plugin declares a long-lived service — see its detail page for the permissions and listeners it asked for."
            >
              service
            </span>
          )}
        </div>
        {p.description?.trim() && <p className="mt-1 max-w-md text-[11.5px] leading-relaxed text-fg-muted">{p.description}</p>}
        {/* Why this row is on screen, when the plugin's own identity is not what
            matched. Without it the search looks broken: you typed `auto-scroll`
            and got a row that says `tiktok`. */}
        {match.viaScripts.length > 0 && (
          <p className="mt-1 text-[11px] text-fg-subtle">
            matched {match.viaScripts.length === 1 ? 'script' : 'scripts'}{' '}
            <span className="readout">{match.viaScripts.map((id) => `${p.name}/${id}`).join(', ')}</span>
          </p>
        )}
        {p.status === 'failed' && (
          <div className="mt-1.5 max-w-md rounded-md border border-led-danger/30 bg-led-danger/5 px-2.5 py-1.5">
            <p className="readout text-[11px] text-led-danger">{p.verifyErrorCode ?? 'E_PLUGIN_VERIFY_FAILED'}</p>
            <p className="mt-0.5 whitespace-pre-wrap wrap-anywhere text-[11.5px] text-led-danger">{p.verifyError}</p>
            {declared.length > 0 && (
              <p className="mt-1 text-[11px] text-fg-muted">
                {declared.length} script{declared.length === 1 ? '' : 's'} declared ({declared.map((s) => s.id).join(', ')}) — none
                registered.
              </p>
            )}
          </div>
        )}
      </TableCell>
      <TableCell>
        <PluginStatusBadge status={p.status} />
      </TableCell>
      {/* `whitespace-nowrap` on the short cells: `TableCell` carries
          `wrap-anywhere` for the long unbroken strings a wide cell can hold,
          and at 360 px that turns "1 registered" into "1 registe / red". These
          three are all short — the honest narrow-window behaviour is for the
          table to scroll inside its own container, which it already does. */}
      <TableCell className="whitespace-nowrap text-[12.5px] text-fg-muted">
        {registered} registered{declared.length > 0 && declared.length !== registered ? ` / ${declared.length} declared` : ''}
      </TableCell>
      <TableCell className="readout whitespace-nowrap text-[11.5px] text-fg-muted">{isoTime(p.verifiedAt)}</TableCell>
      <TableCell>
        <div className="flex justify-end gap-1.5">
          <PluginActions versions={versions} selected={p} onChanged={onChanged} />
        </div>
      </TableCell>
    </TableRow>
  )
}

/** One row per script NAME (plan 62 §3.5, §4.4) — the version count is a link into the detail, where every version lives. */
interface ScriptGroupRow {
  id: string
  name: string
  latestVersion: string
  versionCount: number
  lastPublishedAt: number | null
  enabled: boolean
}

/**
 * The Scripts tab — what used to be the whole of `/scripts`, absorbed here (the
 * grouped list, the enable switch, Run, and the row link into
 * `/scripts/detail?id=…`, which stays exactly where it is: it owns the version
 * picker, the source preview and the param sets, and is linked from seven other
 * screens).
 *
 * There is no origin filter and no Plugin column, because there is nothing left
 * for either to distinguish: a script is a member of a plugin and nothing else
 * (plan 110 §3.2), so every name in this list is already `<plugin>/<script>`.
 * A DEV script is never in this list at all (dev slots are not `scripts` rows);
 * it is visible in the Plugins tab instead, and in `RunScriptDialog`.
 *
 * `?device=`/`?cluster=` still arrive here — a device card's Run button and a
 * cluster's Run link point at `/plugins?device=…`, and `/scripts` keeps its
 * query intact when it redirects — so the "open the run dialog straight away"
 * flow those links exist for is unbroken, and now lands on this tab.
 */
function ScriptsSection({ query, onLoaded }: { query: string; onLoaded: (s: { count: number | null; error: string | null }) => void }) {
  const params = useSearchParams()
  const initialDevice = params.get('device')
  const initialCluster = params.get('cluster')
  const tableRef = useRef<PaginatedTableHandle<ScriptGroupRow>>(null)
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [firstScript, setFirstScript] = useState<ScriptRow | null>(null)
  const [runTarget, setRunTarget] = useState<ScriptRow | null>(null)
  const [autoOpened, setAutoOpened] = useState(false)
  const { run, isPending } = useAction()

  /**
   * The farm's device list, fetched LAZILY — plan 126 §0.4, step 126.3.
   *
   * It exists for one consumer, `RunScriptDialog`'s target picker, and it is
   * not cheap: `fetchDevices()` is `fetchAllPages('/api/devices')`, which
   * walks pages SEQUENTIALLY at `limit=200`, up to 25 round trips
   * (`lib/api.ts`). It used to run on mount — and because this section stays
   * MOUNTED behind the tab strip (see the `hidden` comment above, which is
   * load-bearing: unmounting it would make a failure in the inactive tab
   * silent), every operator who opened the Plugins tab paid for it, including
   * the ones who never opened the run dialog at all.
   *
   * `requested` is a ref, not state: this must fire exactly once per mount and
   * a re-render is not wanted — the arriving devices already re-render through
   * `setDevices`. `RunScriptDialog` re-resolves its default target when
   * `devices.length` changes (its own `targetSelection.reset` effect), which is
   * what makes a list that lands slightly after the dialog opened correct
   * rather than a flash: the picker fills in and re-defaults, exactly as it
   * already does for `/api/clusters`, which the dialog has always fetched on
   * open rather than on mount.
   */
  const devicesRequested = useRef(false)
  const ensureDevices = () => {
    if (devicesRequested.current) return
    devicesRequested.current = true
    void fetchDevices()
      .then(setDevices)
      .catch(() => undefined)
  }

  // The deep-link flow (`?device=`/`?cluster=`) opens the dialog by itself as
  // soon as the script list resolves, so the fetch starts HERE rather than
  // waiting for that: it runs in parallel with the script list instead of
  // after it, which is what keeps the "Run on this device" arrival as fast as
  // it was before this became lazy.
  useEffect(() => {
    if (initialDevice || initialCluster) ensureDevices()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialDevice, initialCluster])

  // Arriving from the "Run" button on a device card, or a cluster's "Run" link:
  // open the dialog as soon as the script list is ready, so the flow is not
  // interrupted.
  useEffect(() => {
    if ((initialDevice || initialCluster) && firstScript && !runTarget && !autoOpened) {
      setRunTarget(firstScript)
      setAutoOpened(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialDevice, initialCluster, firstScript])

  const toggleEnabled = (s: ScriptGroupRow) =>
    run('toggle-' + s.id, () => api(`/api/scripts/${s.id}`, ScriptToggleResponseSchema, { method: 'PATCH', json: { enabled: !s.enabled } }), {
      success: s.enabled ? `${s.name}@${s.latestVersion} disabled` : `${s.name}@${s.latestVersion} enabled`,
      failure: 'Could not change the script status',
      onSuccess: () => tableRef.current?.reload(),
    })

  // The list only ever shows the latest version's summary — opening the run
  // dialog needs its full row (params schema included), which the grouped
  // endpoint deliberately omits to keep the list payload small.
  const openRun = (s: ScriptGroupRow) => {
    // Started BEFORE the script fetch is awaited, so the two run in parallel
    // and the device list is usually already in state by the time the dialog
    // mounts (plan 126 step 126.3).
    ensureDevices()
    return run('run-' + s.id, () => api(`/api/scripts/${s.id}`, ScriptResponseSchema), {
      failure: 'Could not load this script',
      onSuccess: (b) => setRunTarget(b.script),
    })
  }

  return (
    <>
      <div className="mb-2.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id="scripts-section-heading" className="text-[13px] font-semibold tracking-tight">
          Scripts
        </h2>
        <p className="min-w-0 flex-1 text-[12px] text-fg-muted">Every script the plugins registered, newest version first.</p>
      </div>

      <PaginatedTable<ScriptGroupRow>
        ref={tableRef}
        fetchPage={(cursor) =>
          // Grouped: one row per name (plan 62 §4.4). The number of distinct
          // script names is small, so the core returns every group in one page
          // — `cursor` stays unused, kept in the call shape only because
          // `PaginatedTable` always passes one.
          api(`/api/scripts?group=name${cursor ? `&cursor=${cursor}` : ''}`, ScriptGroupsPageResponseSchema)
            .then((page) => {
              if (cursor === null && page.items[0]) {
                void api(`/api/scripts/${page.items[0].id}`, ScriptResponseSchema)
                  .then((b) => setFirstScript(b.script))
                  .catch(() => undefined)
              }
              onLoaded({ count: page.total ?? page.items.length, error: null })
              return page
            })
            .catch((e) => {
              // Reported UP, not only rendered here: the whole reason this
              // panel stays mounted behind a tab is that its failure must
              // still reach the tab strip.
              onLoaded({ count: null, error: e instanceof Error ? e.message : String(e) })
              throw e
            })
        }
        rowKey={(s) => s.id}
        sort={(rows) => rows.filter((r) => scriptMatches(r, query))}
        emptyFiltered={{
          icon: <Search className="size-4" aria-hidden />,
          title: `No script matches “${query}”`,
          description: 'Every script this farm can run is a member of a plugin, so its name always starts with the plugin’s own.',
        }}
        header={
          <>
            <TableHead>Name</TableHead>
            <TableHead>Latest</TableHead>
            <TableHead>Versions</TableHead>
            <TableHead>Published</TableHead>
            <TableHead>Enabled</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </>
        }
        renderRow={(s) => (
          <>
            {/* A script name is one token (`plugin/script`) and must never be
                broken across lines to fit — at 360 px `wrap-anywhere` turned
                `networking/leak-test` into four fragments. The table scrolls
                inside its own container instead. */}
            <TableCell className="whitespace-nowrap">
              <Link href={`/scripts/detail?id=${s.id}`} className="font-medium hover:text-accent">
                {s.name}
              </Link>
            </TableCell>
            <TableCell className="readout whitespace-nowrap text-[12px] text-fg-muted">{s.latestVersion}</TableCell>
            <TableCell className="whitespace-nowrap">
              <Link href={`/scripts/detail?id=${s.id}`} className="readout text-[12px] text-fg-muted hover:text-accent">
                {s.versionCount} version{s.versionCount === 1 ? '' : 's'}
              </Link>
            </TableCell>
            <TableCell className="readout whitespace-nowrap text-[11.5px] text-fg-muted">{relativeTime(s.lastPublishedAt)}</TableCell>
            <TableCell>
              <Switch
                checked={s.enabled}
                disabled={isPending('toggle-' + s.id)}
                onCheckedChange={() => void toggleEnabled(s)}
                aria-label={`Enable ${s.name}@${s.latestVersion}`}
                title={`Affects ${s.latestVersion} — the version @latest resolves to`}
              />
            </TableCell>
            <TableCell className="text-right">
              <Button
                size="sm"
                variant="secondary"
                className="h-7 text-[12px]"
                disabled={!s.enabled || isPending('run-' + s.id)}
                onClick={() => void openRun(s)}
              >
                <Play className="size-3.5" aria-hidden />
                Run
              </Button>
            </TableCell>
          </>
        )}
        empty={{
          icon: <FileCode2 className="size-4" aria-hidden />,
          title: 'No scripts yet',
          description: (
            <>
              A script is a member of a plugin. Scaffold one with <code className="readout">@enkaku/sdk</code>, then publish it to this
              farm:
              <code className="readout mt-2 block rounded bg-surface-2 px-2 py-1.5 text-[11.5px]">
                bunx enkaku init my-pack
                <br />
                bunx enkaku publish ./my-pack --farm {coreBase()}
              </code>
            </>
          ),
        }}
      />

      <RunScriptDialog
        script={runTarget}
        devices={devices}
        initialDevice={initialDevice}
        initialCluster={initialCluster}
        onClose={() => setRunTarget(null)}
      />
    </>
  )
}
