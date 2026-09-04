'use client'

import { Suspense, useEffect, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import {
  PluginDevSlotsResponseSchema,
  PluginOkResponseSchema,
  PluginRestartResponseSchema,
  type DevSlotView,
} from '@enkaku/protocol'
import {
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Input,
  LoadingRows,
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
  ArrowsClockwiseIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  WarningIcon,
  XIcon,
} from '@enkaku/ui'
import { PageHeader } from '@/components/layout/PageHeader'
import { InstallPluginDialog } from '@/components/plugins/InstallPluginDialog'
import { PluginActions } from '@/components/plugins/PluginActions'
import { PluginStatusPill } from '@/components/plugins/PluginStatusPill'
import { KvPanel } from '@/components/kv/KvPanel'
import {
  PluginsListSchema,
  devSlotMatches,
  groupPlugins,
  searchPlugins,
  type PluginMatch,
  type PluginListRow,
} from './plugin-list'

/**
 * The Plugins page (design handoff, "Screen: Plugins"; plan 219). Its scope
 * is one thing narrower than the prototype's: lifecycle only. Running a
 * script is a Scripts & Workflows or Device Control action now (plan 217,
 * 216); this page lists what can run, activates and disables it, and holds
 * the farm-wide Key/Value store (MVP 12 §5).
 */

function isoTime(v: string | null): string {
  if (!v) return '—'
  const ms = Date.parse(v)
  return Number.isNaN(ms) ? v : relativeTime(Math.floor(ms / 1000))
}

type PluginsView = 'plugins' | 'storage'

export default function PluginsPage() {
  return (
    <Suspense fallback={<div className="px-5 py-4"><LoadingRows rows={4} /></div>}>
      <PluginsScreen />
    </Suspense>
  )
}

function PluginsScreen() {
  const [view, setView] = useState<PluginsView>('plugins')
  const [items, setItems] = useState<PluginListRow[] | null>(null)
  const [dev, setDev] = useState<DevSlotView[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const { run, isPending } = useAction()

  const load = () => {
    setError(null)
    api('/api/plugins', PluginsListSchema)
      .then((b) => setItems(b.items))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
    // plan 200 §8.11 — `GET /api/plugins/dev` had no Studio caller since plan
    // 215 deleted `app/device/` (the dev-slot list `GET /api/plugins`'s own
    // `dev` field duplicates is the same data, but the standalone route
    // itself was unreached). This is that call site: an unpublished dev
    // build of a plugin is now visible here, the way it always could be
    // dropped from here (`DELETE /api/plugins/dev/:name`, right below).
    api('/api/plugins/dev', PluginDevSlotsResponseSchema)
      .then((b) => setDev(b.items))
      .catch(() => setDev([]))
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

  return (
    <>
      <PageHeader
        title="Plugins"
        description="Everything this farm can run — the plugins installed on it, and the scripts they register"
        actions={
          <>
            <Button size="sm" variant="secondary" disabled={isPending('restart')} onClick={reloadAll}>
              <ArrowsClockwiseIcon className="size-3.5" aria-hidden />
              Reload all
            </Button>
            <InstallPluginDialog
              onInstalled={load}
              trigger={
                <Button size="sm">
                  <PlusIcon className="size-3.5" aria-hidden />
                  Install plugin
                </Button>
              }
            />
          </>
        }
      />

      {/* The two-way toggle standing in for tabs the handoff does not draw
          (plan 219 §3.3.6): the handoff's own "Choice" field visual —
          option buttons, selected = accent border + accent-soft fill. */}
      <div className="flex gap-1.5 px-5 pt-4" role="tablist" aria-label="Plugins view">
        {(['plugins', 'storage'] as const).map((v) => (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={view === v}
            onClick={() => setView(v)}
            className={cn(
              'rounded-input border px-3 py-[7px] text-body font-medium transition-colors',
              view === v ? 'border-accent bg-accent-soft text-accent' : 'border-border-2 bg-panel-2 text-text-2 hover:bg-muted-2',
            )}
          >
            {v === 'plugins' ? 'Plugins' : 'Key/Value store'}
          </button>
        ))}
      </div>

      {view === 'plugins' ? (
        <div className="px-5 py-4">
          {failedCount > 0 && (
            <div className="mb-4 flex items-start gap-2.5 rounded-inner border border-danger/40 bg-danger-soft px-3.5 py-2.5 text-body text-danger">
              <WarningIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>
                {failedCount} plugin{failedCount === 1 ? '' : 's'} failed to register — every other plugin, and every script it registered, is
                unaffected. See the error below each one.
              </span>
            </div>
          )}

          <div className="@container mb-4">
            <div className="relative min-w-0 max-w-md">
              <MagnifyingGlassIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-faint" aria-hidden />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search plugins…"
                aria-label="Search plugins"
                className="h-8 pr-8 pl-8"
              />
              {query && (
                <button
                  type="button"
                  aria-label="Clear the search"
                  onClick={() => setQuery('')}
                  className="absolute top-1/2 right-2 -translate-y-1/2 text-faint hover:text-text"
                >
                  <XIcon className="size-3.5" aria-hidden />
                </button>
              )}
            </div>
            {query && items !== null && (
              <p className="mt-1.5 text-meta text-faint">
                {matches.length + shownDev.length} of {groups.length + (dev?.length ?? 0)} match "{query}"
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
            <EmptyState
              title={`No plugin matches "${query}"`}
              description={`${groups.length + (dev?.length ?? 0)} plugin${groups.length + (dev?.length ?? 0) === 1 ? ' is' : 's are'} installed on this farm — none of them by that name, slug, version, or description.`}
              action={<Button size="sm" variant="outline" onClick={() => setQuery('')}>Show all plugins</Button>}
            />
          ) : (
            <>
              {shownDev.length > 0 && (
                <div className="mb-5">
                  <h3 className="mb-2 text-meta font-medium text-faint">Dev slots</h3>
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
                // The horizontal-scroll container the handoff's `min-width: 940px` implies: a
                // window narrower than the table scrolls the TABLE, matching every other page.
                <div className="overflow-x-auto rounded-card border border-line-2">
                  <Table className="min-w-[940px]">
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        {/* grid 1.7fr 100px 160px 88px 132px, expressed as column widths on TableHead. */}
                        <TableHead className="w-[38%]">Plugin</TableHead>
                        <TableHead className="w-[100px]">Status</TableHead>
                        <TableHead className="w-[160px]">Scripts</TableHead>
                        <TableHead className="w-[88px]">Verified</TableHead>
                        <TableHead className="w-[132px] text-right">Actions</TableHead>
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
        </div>
      ) : (
        <div className="px-5 py-4">
          <KvPanel scope={{ kind: 'global' }} />
        </div>
      )}
    </>
  )
}

function DevSlotCard({ slot: s, onChanged }: { slot: DevSlotView; onChanged: () => void }) {
  const { run, isPending } = useAction()
  const drop = () =>
    run('drop-' + s.pluginName, () => api(`/api/plugins/dev/${encodeURIComponent(s.pluginName)}`, PluginOkResponseSchema, { method: 'DELETE' }), {
      success: `Dev slot for ${s.pluginName} dropped`,
      failure: 'Could not drop this dev slot',
      onSuccess: onChanged,
    })

  return (
    <div className="rounded-card border border-line-2 bg-panel-2 px-3.5 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-pill bg-muted-2 px-1.5 py-0.5 text-meta text-faint">DEV</span>
        <span className="text-row font-semibold text-text">{s.pluginName}</span>
        <span className="font-mono text-meta text-faint">{s.buildVersion}</span>
        <span className="ml-auto text-meta text-faint">
          {s.lastBuildOk ? 'built' : 'build failed'} {relativeTime(s.lastBuildAt)}
        </span>
        <ConfirmDialog
          trigger={
            <Button size="sm" variant="ghost" className="h-7" disabled={isPending('drop-' + s.pluginName)}>
              Drop
            </Button>
          }
          title={`Drop the dev slot for ${s.pluginName}?`}
          description={
            <>
              <p>
                This dev build — owned by {s.owner.kind === 'workspace' ? 'workspace' : 'enkaku dev'}{' '}
                <span className="font-mono">{s.owner.label}</span> — stops resolving straight away. Its {s.scripts.length} script
                {s.scripts.length === 1 ? '' : 's'} go back to whichever published version of <span className="font-mono">{s.pluginName}</span>{' '}
                is active, and resolve to nothing if there is none.
              </p>
              <p className="mt-2">
                Nothing stored under the <span className="font-mono">{s.kvNamespace}</span> namespace is deleted, and no published version is
                touched. Rebuilding the slot puts it back.
              </p>
            </>
          }
          confirmLabel="Drop"
          onConfirm={drop}
        />
      </div>
      <p className="mt-1.5 text-body text-faint">
        owned by {s.owner.kind === 'workspace' ? 'workspace' : 'enkaku dev'} <span className="font-mono">{s.owner.label}</span> — shares the
        published plugin&apos;s KV namespace (<span className="font-mono">{s.kvNamespace}</span>).
      </p>
      {!s.lastBuildOk && s.lastError && <p className="mt-1.5 whitespace-pre-wrap wrap-anywhere text-body text-danger">{s.lastError}</p>}
    </div>
  )
}

/** One row per plugin NAME (plan 219 §3.3.1), pointed at its live version or the newest. */
function PluginRowView({ match, onChanged }: { match: PluginMatch; onChanged: () => void }) {
  const versions = match.group.versions
  const live = versions.find((v) => v.status === 'active')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const p = versions.find((v) => v.id === selectedId) ?? live ?? (versions[0] as PluginListRow)
  const isNewest = versions[0]?.id === p.id
  const declared = p.declaredScripts
  const registered = p.scriptCount ?? 0
  const detailHref = `/plugins/detail?name=${encodeURIComponent(p.name)}${selectedId ? `&version=${encodeURIComponent(p.version)}` : ''}`

  return (
    <TableRow>
      <TableCell>
        <Link href={detailHref} className="text-row font-semibold hover:text-accent">
          {p.title?.trim() || p.name}
        </Link>
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
          <span className="font-mono text-meta text-faint">{p.name}</span>
          {versions.length > 1 ? (
            <select
              className="rounded-[6px] border border-border-2 bg-muted px-1.5 py-0.5 font-mono text-meta text-text-2"
              value={p.id}
              onChange={(e) => setSelectedId(e.target.value)}
              aria-label={`Version of ${p.name}`}
            >
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.version} · {v.status}
                </option>
              ))}
            </select>
          ) : (
            <span className="rounded-[6px] bg-muted px-1.5 py-0.5 font-mono text-meta text-text-2">{p.version} · {p.status}</span>
          )}
          {isNewest && <span className="rounded-pill bg-muted-2 px-1.5 py-0.5 text-meta text-faint">latest</span>}
          {versions.length > 1 && <span className="rounded-pill bg-muted-2 px-1.5 py-0.5 text-meta text-faint">{versions.length} versions</span>}
          {p.hasService && <span className="rounded-pill bg-warn-soft px-1.5 py-0.5 text-meta text-warn">service</span>}
        </div>
        {p.description?.trim() && <p className="mt-1 max-w-[460px] text-meta leading-relaxed text-faint">{p.description}</p>}
        {p.status === 'failed' && (
          <div className="mt-1.5 max-w-[460px] rounded-inner border border-danger/30 bg-danger-soft px-2.5 py-1.5">
            <p className="font-mono text-meta text-danger">{p.verifyErrorCode ?? 'E_PLUGIN_VERIFY_FAILED'}</p>
            <p className="mt-0.5 text-meta text-danger">{p.verifyError}</p>
          </div>
        )}
      </TableCell>
      <TableCell><PluginStatusPill status={p.status} /></TableCell>
      <TableCell className="whitespace-nowrap text-body text-faint">
        {registered} registered{declared.length > 0 && declared.length !== registered ? ` / ${declared.length} declared` : ''}
      </TableCell>
      <TableCell className="whitespace-nowrap text-meta text-faint">{isoTime(p.verifiedAt)}</TableCell>
      <TableCell className="text-right">
        <PluginActions versions={versions} selected={p} onChanged={onChanged} />
      </TableCell>
    </TableRow>
  )
}
