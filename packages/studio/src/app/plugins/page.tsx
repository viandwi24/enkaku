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

  // Failed first (§4.6), then by name, then newest version first.
  const sorted = [...(items ?? [])].sort((a, b) => {
    if ((a.status === 'failed') !== (b.status === 'failed')) return a.status === 'failed' ? -1 : 1
    if (a.name !== b.name) return a.name.localeCompare(b.name)
    return b.version.localeCompare(a.version)
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
                    {sorted.map((p) => (
                      <PluginRowView key={p.id} plugin={p} onChanged={load} run={run} isPending={isPending} />
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
  plugin: p,
  onChanged,
  run,
  isPending,
}: {
  plugin: PluginRow
  onChanged: () => void
  run: ReturnType<typeof useAction>['run']
  isPending: ReturnType<typeof useAction>['isPending']
}) {
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
        <div className="font-medium">
          {p.name}
          <span className="readout ml-1.5 text-[11.5px] text-fg-muted">{p.version}</span>
        </div>
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
