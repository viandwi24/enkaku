'use client'

import { Suspense, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { FileCode2, Play } from 'lucide-react'
import type { DeviceInfo } from '@enkaku/protocol'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { PageHeader } from '@/components/layout/PageHeader'
import { PaginatedTable, type Page, type PaginatedTableHandle } from '@/components/PaginatedTable'
import { RunScriptDialog, type ScriptRow } from '@/components/RunScriptDialog'
import { LoadingRows } from '@/components/states'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { TableCell, TableHead } from '@/components/ui/table'
import { api, useAction } from '@/lib/actions'
import { fetchDevices } from '@/lib/api'
import { relativeTime } from '@/lib/format'
import { coreBase } from '@/lib/ws'

function ScriptsView() {
  const params = useSearchParams()
  const initialDevice = params.get('device')
  const initialCluster = params.get('cluster')
  const tableRef = useRef<PaginatedTableHandle<ScriptRow>>(null)
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

  const toggleEnabled = (s: ScriptRow) =>
    run(
      'toggle-' + s.id,
      () => api(`/api/scripts/${s.id}`, { method: 'PATCH', json: { enabled: !s.enabled } }),
      {
        success: s.enabled ? `${s.name} disabled` : `${s.name} enabled`,
        failure: 'Could not change the script status',
        onSuccess: () => tableRef.current?.reload(),
      },
    )

  const remove = (s: ScriptRow) =>
    run('del-' + s.id, () => api(`/api/scripts/${s.id}`, { method: 'DELETE' }), {
      success: `${s.name}@${s.version} deleted`,
      failure: 'Could not delete the script',
      onSuccess: () => tableRef.current?.reload(),
    })

  return (
    <>
      <PageHeader title="Scripts" description="Automation scripts published to this farm" />

      <div className="space-y-4 px-5 py-4">
        <PaginatedTable<ScriptRow>
          ref={tableRef}
          fetchPage={(cursor) =>
            api<Page<ScriptRow>>(`/api/scripts?limit=50${cursor ? `&cursor=${cursor}` : ''}`).then((page) => {
              if (cursor === null) setFirstScript(page.items[0] ?? null)
              return page
            })
          }
          rowKey={(s) => s.id}
          header={
            <>
              <TableHead className="w-[40%]">Name</TableHead>
              <TableHead>Version</TableHead>
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
              <TableCell className="readout text-[12px] text-fg-muted">{s.version}</TableCell>
              <TableCell className="readout text-[11.5px] text-fg-muted">{relativeTime(s.createdAt)}</TableCell>
              <TableCell>
                <Switch
                  checked={s.enabled}
                  disabled={isPending('toggle-' + s.id)}
                  onCheckedChange={() => void toggleEnabled(s)}
                  aria-label={`Enable ${s.name}`}
                />
              </TableCell>
              <TableCell className="text-right">
                <div className="flex justify-end gap-1">
                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-7 text-[12px]"
                    disabled={!s.enabled}
                    onClick={() => setRunTarget(s)}
                  >
                    <Play className="size-3.5" aria-hidden />
                    Run
                  </Button>
                  <ConfirmDialog
                    trigger={
                      <Button size="sm" variant="ghost" className="h-7 text-[12px]">
                        Delete
                      </Button>
                    }
                    title={`Delete ${s.name}@${s.version}?`}
                    description={
                      <>
                        The script disappears from this farm and can no longer be run. Jobs that already ran keep
                        their history.
                      </>
                    }
                    onConfirm={() => remove(s)}
                  />
                </div>
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
