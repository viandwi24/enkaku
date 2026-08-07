'use client'

import { Suspense, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { FileCode2, Play } from 'lucide-react'
import { ScriptGroupsPageResponseSchema, ScriptResponseSchema, ScriptToggleResponseSchema, type DeviceInfo } from '@enkaku/protocol'
import { PageHeader } from '@/components/layout/PageHeader'
import { PaginatedTable, type PaginatedTableHandle } from '@/components/PaginatedTable'
import { RunScriptDialog, type ScriptRow } from '@/components/RunScriptDialog'
import { LoadingRows } from '@/components/states'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { TableCell, TableHead } from '@/components/ui/table'
import { api, useAction } from '@/lib/actions'
import { fetchDevices } from '@/lib/api'
import { relativeTime } from '@/lib/format'
import { coreBase } from '@/lib/ws'

/** One row per script NAME (plan 62 §3.5, §4.4) — the version count is a link into the detail, where every version lives. */
interface ScriptGroupRow {
  id: string
  name: string
  latestVersion: string
  versionCount: number
  lastPublishedAt: number | null
  enabled: boolean
}

type OriginFilter = 'all' | 'standalone' | 'plugin'

/**
 * A plugin member's name is always `<plugin>/<script>` (plan 82 §4.2's own
 * naming rule, enforced at publish — `plugins/runtime.ts`'s
 * `writeScriptRows`). `?group=name` (`scripts/routes.ts`) was deliberately
 * left untouched by plan 82 — plugin rows already appear there correctly,
 * being ordinary `scripts` rows — so the Plugin column and origin filter
 * (step 13) are derived from that naming rule client-side rather than
 * needing a new field on the wire. A DEV-origin script is never in this
 * list at all (dev slots are not `scripts` rows — that is the whole point
 * of a dev slot not surviving a restart); it is visible on the Plugins page
 * instead, and in `RunScriptDialog` when opened from a device.
 */
function pluginNameOf(name: string): string | null {
  const i = name.indexOf('/')
  return i > 0 ? name.slice(0, i) : null
}

function ScriptsView() {
  const params = useSearchParams()
  const initialDevice = params.get('device')
  const initialCluster = params.get('cluster')
  const tableRef = useRef<PaginatedTableHandle<ScriptGroupRow>>(null)
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [firstScript, setFirstScript] = useState<ScriptRow | null>(null)
  const [runTarget, setRunTarget] = useState<ScriptRow | null>(null)
  const [autoOpened, setAutoOpened] = useState(false)
  const [originFilter, setOriginFilter] = useState<OriginFilter>('all')
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
    <>
      <PageHeader
        title="Scripts"
        description="Automation scripts published to this farm"
        meta={
          <Select value={originFilter} onValueChange={(v) => setOriginFilter(v as OriginFilter)}>
            <SelectTrigger className="h-8 w-40 text-[12.5px]" aria-label="Filter by origin">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All origins</SelectItem>
              <SelectItem value="standalone">Standalone</SelectItem>
              <SelectItem value="plugin">Plugin</SelectItem>
            </SelectContent>
          </Select>
        }
      />

      <div className="space-y-4 px-5 py-4">
        <PaginatedTable<ScriptGroupRow>
          ref={tableRef}
          resetKey={originFilter}
          fetchPage={(cursor) =>
            // Grouped: one row per name (plan 62 §4.4). The number of
            // distinct script names is small, so the core returns every
            // group in one page — `cursor` stays unused, kept in the call
            // shape only because `PaginatedTable` always passes one. The
            // origin filter is applied client-side, on that same one page
            // (step 13) — `?group=name` carries no origin field of its own.
            api(`/api/scripts?group=name${cursor ? `&cursor=${cursor}` : ''}`, ScriptGroupsPageResponseSchema).then((page) => {
              if (cursor === null && page.items[0]) {
                void api(`/api/scripts/${page.items[0].id}`, ScriptResponseSchema)
                  .then((b) => setFirstScript(b.script))
                  .catch(() => undefined)
              }
              const items = page.items.filter((s) => {
                if (originFilter === 'all') return true
                const isPlugin = pluginNameOf(s.name) !== null
                return originFilter === 'plugin' ? isPlugin : !isPlugin
              })
              return { ...page, items, total: items.length }
            })
          }
          rowKey={(s) => s.id}
          header={
            <>
              <TableHead className="w-[28%]">Name</TableHead>
              <TableHead>Plugin</TableHead>
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
              <TableCell className="text-[12px] text-fg-muted">
                {pluginNameOf(s.name) ?? <span className="text-fg-subtle">—</span>}
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
                Write a script in your own editor using <code className="readout">@enkaku/sdk</code>, then publish it
                to this farm:
                <code className="readout mt-2 block rounded bg-surface-2 px-2 py-1.5 text-[11.5px]">
                  bunx enkaku publish ./script.ts --farm {coreBase()}
                </code>
              </>
            ),
          }}
        />
      </div>

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

export default function ScriptsPage() {
  return (
    <Suspense fallback={<div className="px-5 py-4"><LoadingRows rows={3} /></div>}>
      <ScriptsView />
    </Suspense>
  )
}
