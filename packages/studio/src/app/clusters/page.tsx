'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Layers, Plus } from 'lucide-react'
import { z } from 'zod'
import { ClusterInfoSchema, pageSchema, type ClusterInfo, type DeviceInfo } from '@enkaku/protocol'
import { ClusterEditorDialog, type ClusterRow } from '@/components/ClusterEditorDialog'
import { ClusterMembersDialog } from '@/components/ClusterMembersDialog'
import { ConfirmDialog, Button, TableCell, TableHead, api, useAction, relativeTime } from '@enkaku/ui'
import { PageHeader } from '@/components/layout/PageHeader'
import { PaginatedTable, type PaginatedTableHandle } from '@/components/PaginatedTable'
import { fetchDevices } from '@/lib/api'

/**
 * `GET /api/clusters` (`packages/core/src/api/clusters.ts`) replies with the
 * usual keyset envelope over `ClusterInfo` — no dedicated
 * `ClustersPageResponseSchema` export exists in protocol (plan 72 §3.4's
 * report flags this as a gap), so it is composed here from the exported
 * `pageSchema` helper and `ClusterInfoSchema`, both already in protocol.
 */
const ClustersPageResponseSchema = pageSchema(ClusterInfoSchema)

export default function ClustersPage() {
  const tableRef = useRef<PaginatedTableHandle<ClusterInfo>>(null)
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [editing, setEditing] = useState<ClusterRow | 'new' | null>(null)
  const [membersOf, setMembersOf] = useState<{ id: string; name: string } | null>(null)
  const { run } = useAction()

  const loadDevices = () =>
    void fetchDevices()
      .then(setDevices)
      .catch(() => undefined)

  useEffect(loadDevices, [])

  const remove = (cl: ClusterInfo) =>
    run('del-' + cl.id, () => api(`/api/clusters/${cl.id}`, z.void(), { method: 'DELETE' }), {
      success: `${cl.name} deleted — its devices are unclustered, not deleted`,
      failure: 'Could not delete the cluster',
      onSuccess: () => tableRef.current?.reload(),
    })

  const refreshAll = () => {
    tableRef.current?.reload()
    loadDevices()
  }

  return (
    <>
      <PageHeader
        title="Clusters"
        description="Containers devices are put into and taken out of — a region, a rack, a customer"
        actions={
          <Button onClick={() => setEditing('new')}>
            <Plus className="size-3.5" aria-hidden />
            New cluster
          </Button>
        }
      />

      <div className="space-y-4 px-5 py-4">
        <PaginatedTable<ClusterInfo>
          ref={tableRef}
          fetchPage={(cursor) => api(`/api/clusters?limit=50${cursor ? `&cursor=${cursor}` : ''}`, ClustersPageResponseSchema)}
          rowKey={(cl) => cl.id}
          header={
            <>
              <TableHead className="w-[35%]">Name</TableHead>
              <TableHead>Devices</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </>
          }
          renderRow={(cl) => (
            <>
              <TableCell>
                <button className="font-medium hover:text-accent" onClick={() => setEditing(cl)}>
                  {cl.name}
                </button>
                {cl.description && <p className="mt-0.5 line-clamp-1 text-[11.5px] text-fg-muted">{cl.description}</p>}
              </TableCell>
              <TableCell className="readout text-[12.5px]">
                {cl.deviceCount}
                {cl.deviceCount !== cl.usableCount && (
                  <span className="ml-1 text-fg-subtle">({cl.usableCount} usable)</span>
                )}
              </TableCell>
              <TableCell className="readout text-[11.5px] text-fg-muted">{relativeTime(cl.createdAt)}</TableCell>
              <TableCell className="text-right">
                <div className="flex justify-end gap-1">
                  <Button asChild size="sm" variant="secondary" className="h-7 text-[12px]">
                    {/* The script list moved into `/plugins` (the merged
                        Plugins & scripts screen, 2026-08-17) — `?cluster=`
                        still opens the run dialog on arrival. */}
                    <Link href={`/plugins?cluster=${cl.id}`}>Run</Link>
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-[12px]"
                    onClick={() => setMembersOf({ id: cl.id, name: cl.name })}
                  >
                    Members
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 text-[12px]" onClick={() => setEditing(cl)}>
                    Edit
                  </Button>
                  <ConfirmDialog
                    trigger={
                      <Button size="sm" variant="ghost" className="h-7 text-[12px]">
                        Delete
                      </Button>
                    }
                    title={`Delete ${cl.name}?`}
                    description="Its devices become unclustered, not deleted, and past batch reports that named this cluster stay intact and readable."
                    onConfirm={() => remove(cl)}
                  />
                </div>
              </TableCell>
            </>
          )}
          empty={{
            icon: <Layers className="size-4" aria-hidden />,
            title: 'No clusters yet',
            description: 'A cluster is a container — a region, a rack, a customer. Create one, then add devices to it.',
            action: <Button onClick={() => setEditing('new')}>New cluster</Button>,
          }}
        />
      </div>

      <ClusterEditorDialog cluster={editing} onClose={() => setEditing(null)} onSaved={refreshAll} />

      <ClusterMembersDialog
        cluster={membersOf}
        allDevices={devices}
        onClose={() => setMembersOf(null)}
        onChanged={refreshAll}
      />
    </>
  )
}
