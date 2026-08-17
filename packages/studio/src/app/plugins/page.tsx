'use client'

import { Suspense, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { AlertTriangle, FileCode2, Play, Plus, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import {
  PluginActivateResponseSchema,
  PluginDataCountResponseSchema,
  PluginOkResponseSchema,
  PluginRemoveResponseSchema,
  PluginRestartResponseSchema,
  PluginVerifyResponseSchema,
  PluginsListResponseSchema,
  ScriptGroupsPageResponseSchema,
  ScriptResponseSchema,
  ScriptToggleResponseSchema,
  type DevSlotView,
  type DeviceInfo,
  type PluginDataCountResponse,
  type PluginRow,
} from '@enkaku/protocol'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { PageHeader } from '@/components/layout/PageHeader'
import { PaginatedTable, type PaginatedTableHandle } from '@/components/PaginatedTable'
import { InstallPluginDialog } from '@/components/plugins/InstallPluginDialog'
import { RunScriptDialog, type ScriptRow } from '@/components/RunScriptDialog'
import { PluginStatusBadge } from '@/components/StatusBadge'
import { EmptyState, ErrorState, LoadingRows } from '@/components/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { api, useAction } from '@/lib/actions'
import { fetchDevices } from '@/lib/api'
import { relativeTime } from '@/lib/format'
import { coreBase } from '@/lib/ws'

/**
 * The Plugins & scripts page (plan 82 §4.6, criteria 29, 30) — the screen the
 * previous pass shipped a whole backend for and never gave an operator a way
 * to reach. Its one job: a plugin that fails must be findable without reading
 * a log file.
 *
 * - Failed plugins sort first.
 * - A failed plugin's error renders VERBATIM, with its code — never
 *   summarised.
 * - "Which scripts registered" is `scriptCount` (a live count of `scripts`
 *   rows — 0 for a failed plugin, since registration is all-or-nothing per
 *   plugin, plan 82 §3.8); "which were declared" is `manifest.scripts` when
 *   the bundle got far enough to report one.
 * - Dev slots carry their own DEV badge, owner, and last-build result.
 *
 * ONE SCREEN, TWO STACKED SECTIONS — not a tab strip (owner's own ask,
 * 2026-08-17: *"halaman scripts menurut saya jadi satu aja dengan plugins"*).
 * `/scripts` used to be a second, separate answer to the same question — what
 * code can this farm run — and a plugin's scripts appeared on BOTH screens
 * anyway (a plugin member is an ordinary `scripts` row, plan 82 §4.2), so the
 * split cost a navigation choice and bought nothing.
 *
 * Stacked rather than tabbed, for three reasons, all of them about the first
 * question this screen exists to answer — *is anything broken?*:
 *
 *  1. A tab hides one list behind a click. The sidebar's failed-plugin badge
 *     links HERE (criterion 30); landing on the wrong tab and having to find
 *     the right one is the badge failing at the last step.
 *  2. The two lists have INDEPENDENT loads, and a tab hides a failure as
 *     readily as it hides a list — `/api/scripts` returning 500 inside a
 *     closed tab is a silent one.
 *  3. The failed-plugin warning renders ABOVE both sections and the Plugins
 *     table comes first, so no length of script list can push either below
 *     the fold. That is what the ordering here is for; it is not cosmetic.
 */

function isoTime(v: string | null): string {
  if (!v) return '—'
  const ms = Date.parse(v)
  return Number.isNaN(ms) ? v : relativeTime(Math.floor(ms / 1000))
}

export default function PluginsPage() {
  const [items, setItems] = useState<PluginRow[] | null>(null)
  const [dev, setDev] = useState<DevSlotView[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { run, isPending } = useAction()

  const load = () => {
    setError(null)
    api('/api/plugins', PluginsListResponseSchema)
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

  // P3 (plan 108 §0.2) — `DELETE /api/plugins/dev/:name` shipped with no way
  // to reach it, so a dev slot rendered here and could only be cleared by
  // waiting for it to expire or restarting the core.
  const dropDevSlot = (s: DevSlotView) =>
    run('drop-' + s.pluginName, () => api(`/api/plugins/dev/${encodeURIComponent(s.pluginName)}`, PluginOkResponseSchema, { method: 'DELETE' }), {
      success: `Dev slot for ${s.pluginName} dropped`,
      failure: 'Could not drop this dev slot',
      onSuccess: load,
    })

  /**
   * ONE ROW PER PLUGIN, not per version.
   *
   * This table used to list every published version as its own row, so a plugin iterated on during
   * a session filled the page with near-identical lines — eight `tiktok` rows differing only in a
   * version string. That is a changelog, not an index: the question an operator opens this page
   * with is "what is installed, and which version is live", and the answer was buried in repetition.
   *
   * Versions now live inside the row, in a picker, with the active one selected. Failed versions
   * still surface, because a plugin that will not register is exactly what this page exists to make
   * findable — a group is marked failed when its newest version failed.
   */
  const groups = [...(items ?? [])]
    .reduce<Map<string, PluginRow[]>>((acc, p) => {
      const list = acc.get(p.name) ?? []
      list.push(p)
      acc.set(p.name, list)
      return acc
    }, new Map())
  const sortedGroups = [...groups.entries()]
    .map(([name, versions]) => ({
      name,
      // Newest first, so `[0]` is what `@latest` resolves to.
      versions: [...versions].sort((a, b) => b.version.localeCompare(a.version)),
    }))
    .sort((a, b) => {
      const aFailed = a.versions[0]?.status === 'failed'
      const bFailed = b.versions[0]?.status === 'failed'
      if (aFailed !== bFailed) return aFailed ? -1 : 1
      return a.name.localeCompare(b.name)
    })
  const failedCount = (items ?? []).filter((p) => p.status === 'failed').length

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
      <div className="px-5 py-4">
        {/* Above BOTH sections, never inside the plugin one: this is the
            answer to the first question the screen is opened with, and the
            script list below must never be able to push it out of view. */}
        {failedCount > 0 && (
          <div className="mb-4 flex items-start gap-2.5 rounded-lg border border-led-danger/40 bg-led-danger/5 px-3.5 py-2.5 text-[12.5px] text-led-danger">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>
              {failedCount} plugin{failedCount === 1 ? '' : 's'} failed to register — every other plugin, and every
              script it registered, is unaffected. See the error below each one.
            </span>
          </div>
        )}

        <section aria-labelledby="plugins-section-heading">
          <h2 id="plugins-section-heading" className="mb-2.5 text-[13px] font-semibold tracking-tight">
            Plugins
          </h2>
          {error ? (
            <ErrorState message={error} onRetry={load} />
          ) : items === null || dev === null ? (
            <LoadingRows rows={4} />
          ) : items.length === 0 && dev.length === 0 ? (
            <EmptyState
              title="No plugins yet"
              description="Install one with the button above, or publish it from the SDK (definePlugin) — one bundle, many scripts sharing helpers and a KV namespace."
            />
          ) : (
            <>
              {dev.length > 0 && (
                <div className="mb-5">
                  <h3 className="mb-2 text-[12px] font-medium text-fg-muted">Dev slots</h3>
                  <div className="space-y-2">
                    {dev.map((s) => (
                      <div key={s.pluginName} className="rounded-lg border bg-surface px-3.5 py-3">
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
                                  <span className="readout">{s.owner.label}</span> — stops resolving straight away. Its{' '}
                                  {s.scripts.length} script{s.scripts.length === 1 ? '' : 's'} go back to whichever published version of{' '}
                                  <span className="readout">{s.pluginName}</span> is active, and resolve to nothing if there is none.
                                </p>
                                <p className="mt-2">
                                  Nothing stored under the <span className="readout">{s.kvNamespace}</span> namespace is deleted, and no published
                                  version is touched. Rebuilding the slot puts it back.
                                </p>
                              </>
                            }
                            confirmLabel="Drop"
                            onConfirm={() => dropDevSlot(s)}
                          />
                        </div>
                        <p className="mt-1.5 text-[12px] text-fg-muted">
                          owned by {s.owner.kind === 'workspace' ? 'workspace' : 'enkaku dev'}{' '}
                          <span className="readout">{s.owner.label}</span> — shares the published plugin&apos;s KV
                          namespace (<span className="readout">{s.kvNamespace}</span>).
                        </p>
                        {!s.lastBuildOk && s.lastError && (
                          <p className="mt-1.5 whitespace-pre-wrap break-words text-[12px] text-led-danger">{s.lastError}</p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {items.length === 0 ? (
                <EmptyState title="No published plugin versions" description="Dev slots above are runnable without publishing." />
              ) : (
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
                      {sortedGroups.map((g) => (
                        <PluginRowView key={g.name} versions={g.versions} onChanged={load} run={run} isPending={isPending} />
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </>
          )}
        </section>

        {/* The second section owns its OWN fetch and its own error state —
            deliberately not folded into `load()` above. A farm whose
            `/api/plugins` read fails must still be able to see and run its
            scripts, and vice versa; one blank list is a fault,
            two is a broken page. `ScriptsSection` reads `?device=`/`?cluster=`
            (`useSearchParams`), which a static export will only prerender
            inside a Suspense boundary — hence the one here, around the
            section that needs it rather than the whole page. */}
        <Suspense fallback={<div className="mt-6"><LoadingRows rows={3} /></div>}>
          <ScriptsSection />
        </Suspense>
      </div>
    </>
  )
}

function PluginRowView({
  versions,
  onChanged,
  run,
  isPending,
}: {
  /** Every published version of ONE plugin, newest first. */
  versions: PluginRow[]
  onChanged: () => void
  run: ReturnType<typeof useAction>['run']
  isPending: ReturnType<typeof useAction>['isPending']
}) {
  // The version the row is POINTED AT: the live one when there is one, otherwise the newest.
  // Everything below reads from `p`, so selecting a version in the picker re-points the whole row —
  // status, script counts, verified time, and which action button is offered.
  const live = versions.find((v) => v.status === 'active')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const p = versions.find((v) => v.id === selectedId) ?? live ?? (versions[0] as PluginRow)
  const isNewest = versions[0]?.id === p.id

  const declared = p.manifest?.scripts ?? []
  const registered = p.scriptCount ?? 0

  const activate = () =>
    run('activate-' + p.id, () => api(`/api/plugins/${p.id}/activate`, PluginActivateResponseSchema, { method: 'POST' }), {
      success: `${p.name}@${p.version} activated`,
      failure: 'Could not activate this version',
      onSuccess: onChanged,
    })
  const rollback = () =>
    run('rollback-' + p.id, () => api(`/api/plugins/${p.name}/rollback`, PluginActivateResponseSchema, { method: 'POST', json: { toVersion: p.version } }), {
      success: `Rolled back to ${p.name}@${p.version}`,
      failure: 'Could not roll back to this version',
      onSuccess: onChanged,
    })
  const reload = () =>
    run('reload-' + p.id, () => api(`/api/plugins/${p.name}/reload`, PluginVerifyResponseSchema, { method: 'POST' }), {
      failure: 'Could not reload this plugin',
      onSuccess: onChanged,
    })
  /**
   * P2 (plan 108 §0.2) — `POST /api/plugins/:name/disable` had no caller.
   *
   * It used to have no counterpart either: `activate` CASes on a `staged`
   * row and `rollback` needs a `superseded` one, so a `disabled` version was
   * reachable by no transition at all, and the confirm below said so in as
   * many words ("There is no Enable button"). `POST /:name/enable`
   * (`packages/core/src/api/plugins.ts`, permission `script.publish`, audited
   * `plugin.enable`) closes that hole, so that sentence is gone: it was true
   * when written and is not any more, which is the worse of the two failures
   * a piece of UI copy can have.
   */
  const disable = () =>
    run('disable-' + p.id, () => api(`/api/plugins/${encodeURIComponent(p.name)}/disable`, PluginOkResponseSchema, { method: 'POST' }), {
      success: `${p.name} disabled`,
      failure: 'Could not disable this plugin',
      onSuccess: onChanged,
    })
  /**
   * The way back. Keyed by NAME, not id — same two-segment shape as
   * `disable`/`rollback` — and answering `{ plugin }`, the same body
   * `activate`/`rollback` return, because it ends the same way they do: a row
   * that is now `active`. A 409 (`plugin_enable_conflict`: a DIFFERENT
   * version of this plugin is already active) is a normal outcome, not a bug,
   * and `useAction` surfaces the server's own wording for it rather than
   * inventing a second explanation here.
   */
  const enable = () =>
    run('enable-' + p.id, () => api(`/api/plugins/${encodeURIComponent(p.name)}/enable`, PluginActivateResponseSchema, { method: 'POST' }), {
      success: `${p.name} enabled`,
      failure: 'Could not enable this plugin',
      onSuccess: onChanged,
    })
  const remove = (deleteKv: boolean) =>
    run(
      'remove-' + p.id,
      () =>
        api(`/api/plugins/${encodeURIComponent(p.name)}/${encodeURIComponent(p.version)}?deleteKv=${deleteKv ? '1' : '0'}`, PluginRemoveResponseSchema, {
          method: 'DELETE',
        }),
      {
        failure: 'Could not remove this version',
        onSuccess: (r) => {
          toast.success(
            `${p.name}@${p.version} removed`,
            r.kvDeleted > 0 ? { description: `${r.kvDeleted} stored entr${r.kvDeleted === 1 ? 'y' : 'ies'} deleted` } : undefined,
          )
          onChanged()
        },
      },
    )

  /**
   * P4 (plan 108 §0.2) — this dialog used to hardcode `remove(false)` and
   * tell the operator to delete the plugin's KV values "from the Key/Value
   * store settings", advice nobody could follow: `KvPanel` deletes one key
   * at a time and needs the namespace typed from memory, because there is
   * no namespace listing anywhere. So `deleteKv=1` was unreachable and its
   * substitute was imaginary. It is a checkbox now, and the dialog states
   * the real entry count before asking.
   *
   * The count comes from `GET /api/plugins/:name/data/count` (plan 108
   * §4.5). It is OPTIONAL by construction: an older core answers 404, and
   * the checkbox still renders — saying plainly that the number could not
   * be read, rather than hiding the only way to delete the data.
   */
  const [removeOpen, setRemoveOpen] = useState(false)
  const [deleteKv, setDeleteKv] = useState(false)
  const [dataCount, setDataCount] = useState<PluginDataCountResponse | null>(null)
  const [countState, setCountState] = useState<'loading' | 'known' | 'unavailable'>('loading')

  const openRemove = () => {
    setDeleteKv(false)
    setDataCount(null)
    setCountState('loading')
    api(`/api/plugins/${encodeURIComponent(p.name)}/data/count`, PluginDataCountResponseSchema)
      .then((c) => {
        setDataCount(c)
        setCountState('known')
      })
      .catch(() => setCountState('unavailable'))
  }

  return (
    <TableRow>
      <TableCell>
        {/*
          A plugin has two names and they are not interchangeable: the human one it was published
          with (`title`, e.g. "TikTok automation pack") and the identifier everything else keys on
          (`name`, e.g. `tiktok` — the KV namespace, and half of every `plugin/script@version` ref).
          Only the identifier used to be shown, which reads fine to whoever published it and tells
          an operator nothing. Both are here now, and the identifier stays in the monospace readout
          so it is obvious which one you can paste into a script reference.
        */}
        <div className="font-medium">{p.title?.trim() || p.name}</div>
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
            <span className="rounded-full border border-line px-1.5 text-[10.5px] leading-[1.35] text-fg-subtle">
              latest
            </span>
          )}
          {versions.length > 1 && (
            <span className="text-[11px] text-fg-subtle">{versions.length} versions</span>
          )}
        </div>
        {p.description?.trim() && (
          <p className="mt-1 max-w-md text-[11.5px] leading-relaxed text-fg-muted">{p.description}</p>
        )}
        {p.status === 'failed' && (
          <div className="mt-1.5 max-w-md rounded-md border border-led-danger/30 bg-led-danger/5 px-2.5 py-1.5">
            <p className="readout text-[11px] text-led-danger">{p.verifyErrorCode ?? 'E_PLUGIN_VERIFY_FAILED'}</p>
            <p className="mt-0.5 whitespace-pre-wrap break-words text-[11.5px] text-led-danger">{p.verifyError}</p>
            {declared.length > 0 && (
              <p className="mt-1 text-[11px] text-fg-muted">
                {declared.length} script{declared.length === 1 ? '' : 's'} declared ({declared.map((s) => s.id).join(', ')}) — none registered.
              </p>
            )}
          </div>
        )}
      </TableCell>
      <TableCell>
        <PluginStatusBadge status={p.status} />
      </TableCell>
      <TableCell className="text-[12.5px] text-fg-muted">
        {registered} registered{declared.length > 0 && declared.length !== registered ? ` / ${declared.length} declared` : ''}
      </TableCell>
      <TableCell className="readout text-[11.5px] text-fg-muted">{isoTime(p.verifiedAt)}</TableCell>
      <TableCell>
        <div className="flex justify-end gap-1.5">
          {p.status === 'staged' && (
            <Button size="sm" variant="outline" className="h-7 text-[12px]" disabled={isPending('activate-' + p.id)} onClick={activate}>
              Activate
            </Button>
          )}
          {p.status === 'superseded' && (
            <Button size="sm" variant="outline" className="h-7 text-[12px]" disabled={isPending('rollback-' + p.id)} onClick={rollback}>
              Rollback to this
            </Button>
          )}
          {p.status === 'failed' && (
            <Button size="sm" variant="outline" className="h-7 text-[12px]" disabled={isPending('reload-' + p.id)} onClick={reload}>
              Reload
            </Button>
          )}
          {/* No confirm: enabling is the reversible half of the pair, and the
              irreversible-looking one (Disable) already carries the dialog. */}
          {p.status === 'disabled' && (
            <Button size="sm" variant="outline" className="h-7 text-[12px]" disabled={isPending('enable-' + p.id)} onClick={enable}>
              Enable
            </Button>
          )}
          {p.status === 'active' && (
            <ConfirmDialog
              trigger={
                <Button size="sm" variant="outline" className="h-7 text-[12px]" disabled={isPending('disable-' + p.id)}>
                  Disable
                </Button>
              }
              title={`Disable ${p.name}@${p.version}?`}
              description={
                <>
                  <p>
                    Its {registered} script{registered === 1 ? '' : 's'} stop resolving straight away
                    {declared.length > 0 ? ` (${declared.map((s) => `${p.name}/${s.id}`).join(', ')})` : ''}. A job already running is left alone;
                    the next one that names one of them fails to start.
                  </p>
                  <p className="mt-2">
                    Enable, on this same row, puts this exact version back — no republishing, and nothing stored under its{' '}
                    <span className="readout">{p.name}</span> namespace is deleted meanwhile. The one thing that can stand in the way is
                    activating a different version of {p.name} in between: only one version of a name is ever live, so Enable is refused
                    while another one holds the slot.
                  </p>
                </>
              }
              confirmLabel="Disable"
              onConfirm={disable}
            />
          )}
          <ConfirmDialog
            open={removeOpen}
            onOpenChange={(next) => {
              setRemoveOpen(next)
              if (!next) setDeleteKv(false)
            }}
            trigger={
              <Button size="sm" variant="ghost" className="h-7 text-[12px]" disabled={isPending('remove-' + p.id)} onClick={openRemove}>
                Remove
              </Button>
            }
            title={`Remove ${p.name}@${p.version}?`}
            description={
              <>
                <p>
                  Its scripts stop resolving, and this version is deleted from the list.
                  {versions.length > 1
                    ? ` The other ${versions.length - 1} version${versions.length === 2 ? '' : 's'} of ${p.name} stay as they are.`
                    : ''}
                </p>
                <label className="mt-2.5 flex items-start gap-2 rounded border border-line bg-surface-2 px-3 py-2 text-[12.5px] text-fg">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={deleteKv}
                    onChange={(e) => setDeleteKv(e.target.checked)}
                    aria-label={`Also delete data stored by ${p.name}`}
                  />
                  <span>
                    {countState === 'loading'
                      ? `Also delete the data ${p.name} has stored — counting it now…`
                      : countState === 'known' && dataCount
                        ? `Also delete the data ${p.name} has stored (${dataCount.global} global, ${dataCount.device} device ${
                            dataCount.global + dataCount.device === 1 ? 'entry' : 'entries'
                          }).`
                        : versions.some((v) => v.status === 'active')
                          ? `Also delete the data ${p.name} has stored (this farm could not report how many entries there are).`
                          : // `GET /:name/data/count` refuses a plugin that is neither active nor in a dev slot
                            // (`requireLivePlugin`, plan 108 §3.7) — which is exactly the case when the last
                            // version of a plugin is being removed. Say that, rather than implying a fault.
                            `Also delete the data ${p.name} has stored (counting it needs an active version of ${p.name}, so this farm cannot say how many entries there are).`}{' '}
                    Every version shares one key/value namespace, so this deletes what the other versions wrote too. Left in place unless you tick
                    this.
                  </span>
                </label>
              </>
            }
            confirmLabel={deleteKv ? 'Remove and delete data' : 'Remove'}
            onConfirm={() => remove(deleteKv)}
          />
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
 * The second half of this screen — what used to be the whole of `/scripts`,
 * absorbed here (the grouped list, the enable switch, Run, and the row link
 * into `/scripts/detail?id=…`, which stays exactly where it is: it owns the
 * version picker, the source preview and the param sets, and is linked from
 * seven other screens).
 *
 * There is no origin filter and no Plugin column, because there is nothing
 * left for either to distinguish: a script is a member of a plugin and
 * nothing else (plan 110 §3.2), so every name in this list is already
 * `<plugin>/<script>` and a Plugin column would only repeat the first half of
 * the Name beside it. A DEV script is never in this list at all (dev slots
 * are not `scripts` rows — that is the whole point of a dev slot not
 * surviving a restart); it is visible in the Plugins section above instead,
 * and in `RunScriptDialog` when opened from a device.
 *
 * `?device=`/`?cluster=` still arrive here — `DeviceCard`'s Run button and a
 * cluster's Run link point at `/plugins?device=…` now, and `/scripts` keeps
 * its query intact when it redirects — so the "open the run dialog straight
 * away" flow those links exist for is unbroken.
 */
function ScriptsSection() {
  const params = useSearchParams()
  const initialDevice = params.get('device')
  const initialCluster = params.get('cluster')
  const tableRef = useRef<PaginatedTableHandle<ScriptGroupRow>>(null)
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [firstScript, setFirstScript] = useState<ScriptRow | null>(null)
  const [runTarget, setRunTarget] = useState<ScriptRow | null>(null)
  const [autoOpened, setAutoOpened] = useState(false)
  const { run, isPending } = useAction()

  useEffect(() => {
    void fetchDevices()
      .then(setDevices)
      .catch(() => undefined)
  }, [])

  // Arriving from the "Run" button on a device card, or a cluster's "Run"
  // link: open the dialog as soon as the script list is ready, so the flow
  // is not interrupted.
  useEffect(() => {
    if ((initialDevice || initialCluster) && firstScript && !runTarget && !autoOpened) {
      setRunTarget(firstScript)
      setAutoOpened(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialDevice, initialCluster, firstScript])

  const toggleEnabled = (s: ScriptGroupRow) =>
    run(
      'toggle-' + s.id,
      () => api(`/api/scripts/${s.id}`, ScriptToggleResponseSchema, { method: 'PATCH', json: { enabled: !s.enabled } }),
      {
        success: s.enabled ? `${s.name}@${s.latestVersion} disabled` : `${s.name}@${s.latestVersion} enabled`,
        failure: 'Could not change the script status',
        onSuccess: () => tableRef.current?.reload(),
      },
    )

  // The list only ever shows the latest version's summary — opening the run
  // dialog needs its full row (params schema included), which the grouped
  // endpoint deliberately omits to keep the list payload small.
  const openRun = (s: ScriptGroupRow) =>
    run('run-' + s.id, () => api(`/api/scripts/${s.id}`, ScriptResponseSchema), {
      failure: 'Could not load this script',
      onSuccess: (b) => setRunTarget(b.script),
    })

  return (
    <section className="mt-6" aria-labelledby="scripts-section-heading">
      <div className="mb-2.5 flex flex-wrap items-center gap-3">
        <h2 id="scripts-section-heading" className="text-[13px] font-semibold tracking-tight">
          Scripts
        </h2>
        <p className="min-w-0 flex-1 text-[12px] text-fg-muted">
          Every script the plugins above registered, newest version first.
        </p>
      </div>

      <PaginatedTable<ScriptGroupRow>
        ref={tableRef}
        fetchPage={(cursor) =>
          // Grouped: one row per name (plan 62 §4.4). The number of
          // distinct script names is small, so the core returns every
          // group in one page — `cursor` stays unused, kept in the call
          // shape only because `PaginatedTable` always passes one.
          api(`/api/scripts?group=name${cursor ? `&cursor=${cursor}` : ''}`, ScriptGroupsPageResponseSchema).then((page) => {
            if (cursor === null && page.items[0]) {
              void api(`/api/scripts/${page.items[0].id}`, ScriptResponseSchema)
                .then((b) => setFirstScript(b.script))
                .catch(() => undefined)
            }
            return page
          })
        }
        rowKey={(s) => s.id}
        header={
          <>
            <TableHead className="w-[28%]">Name</TableHead>
            <TableHead>Latest</TableHead>
            <TableHead>Versions</TableHead>
            <TableHead>Published</TableHead>
            <TableHead>Enabled</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </>
        }
        renderRow={(s) => (
          <>
            <TableCell>
              <Link href={`/scripts/detail?id=${s.id}`} className="font-medium hover:text-accent">
                {s.name}
              </Link>
            </TableCell>
            <TableCell className="readout text-[12px] text-fg-muted">{s.latestVersion}</TableCell>
            <TableCell>
              <Link href={`/scripts/detail?id=${s.id}`} className="readout text-[12px] text-fg-muted hover:text-accent">
                {s.versionCount} version{s.versionCount === 1 ? '' : 's'}
              </Link>
            </TableCell>
            <TableCell className="readout text-[11.5px] text-fg-muted">{relativeTime(s.lastPublishedAt)}</TableCell>
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
              A script is a member of a plugin. Scaffold one with <code className="readout">@enkaku/sdk</code>, then
              publish it to this farm:
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
    </section>
  )
}
