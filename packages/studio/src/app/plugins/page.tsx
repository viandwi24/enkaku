'use client'

import { useEffect, useState } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import {
  PluginActivateResponseSchema,
  PluginRemoveResponseSchema,
  PluginRestartResponseSchema,
  PluginVerifyResponseSchema,
  PluginsListResponseSchema,
  type DevSlotView,
  type PluginRow,
} from '@enkaku/protocol'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { PageHeader } from '@/components/layout/PageHeader'
import { PluginStatusBadge } from '@/components/StatusBadge'
import { EmptyState, ErrorState, LoadingRows } from '@/components/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { api, useAction } from '@/lib/actions'
import { relativeTime } from '@/lib/format'

/**
 * The Plugins page (plan 82 §4.6, criteria 29, 30) — the screen the previous
 * pass shipped a whole backend for and never gave an operator a way to
 * reach. Its one job: a plugin that fails must be findable without reading
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
        title="Plugins"
        description="Published script packs — one bundle, many scripts, staged and verified before anything runs"
        actions={
          <Button size="sm" variant="outline" disabled={isPending('restart')} onClick={reloadAll}>
            <RefreshCw className="size-3.5" aria-hidden />
            Reload all
          </Button>
        }
      />
      <div className="px-5 py-4">
        {failedCount > 0 && (
          <div className="mb-4 flex items-start gap-2.5 rounded-lg border border-led-danger/40 bg-led-danger/5 px-3.5 py-2.5 text-[12.5px] text-led-danger">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>
              {failedCount} plugin{failedCount === 1 ? '' : 's'} failed to register — standalone scripts and every
              other plugin are unaffected. See the error below each one.
            </span>
          </div>
        )}

        {error ? (
          <ErrorState message={error} onRetry={load} />
        ) : items === null || dev === null ? (
          <LoadingRows rows={4} />
        ) : items.length === 0 && dev.length === 0 ? (
          <EmptyState
            title="No plugins yet"
            description="Publish a plugin with the SDK (definePlugin) or POST /api/plugins — one bundle, many scripts sharing helpers and a KV namespace."
          />
        ) : (
          <>
            {dev.length > 0 && (
              <section className="mb-5">
                <h2 className="mb-2 text-[12px] font-medium text-fg-muted">Dev slots</h2>
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
              </section>
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
  const remove = (deleteKv: boolean) =>
    run('remove-' + p.id, () => api(`/api/plugins/${p.name}/${p.version}?deleteKv=${deleteKv ? '1' : '0'}`, PluginRemoveResponseSchema, { method: 'DELETE' }), {
      success: `${p.name}@${p.version} removed`,
      failure: 'Could not remove this version',
      onSuccess: onChanged,
    })

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
          <ConfirmDialog
            trigger={
              <Button size="sm" variant="ghost" className="h-7 text-[12px]" disabled={isPending('remove-' + p.id)}>
                Remove
              </Button>
            }
            title={`Remove ${p.name}@${p.version}?`}
            description="Its scripts stop resolving. KV values under this plugin's namespace are kept — remove those separately from the Key/Value store settings if wanted."
            confirmLabel="Remove"
            onConfirm={() => remove(false)}
          />
        </div>
      </TableCell>
    </TableRow>
  )
}
