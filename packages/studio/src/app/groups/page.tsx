'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Layers, Plus } from 'lucide-react'
import { z } from 'zod'
import { GroupInfoSchema, pageSchema, type GroupInfo, type DeviceInfo } from '@enkaku/protocol'
import { GroupEditorDialog, type GroupRow } from '@/components/GroupEditorDialog'
import { GroupMembersDialog } from '@/components/GroupMembersDialog'
import { ConfirmDialog, Button, TableCell, TableHead, api, useAction, relativeTime } from '@enkaku/ui'
import { PageHeader } from '@/components/layout/PageHeader'
import { PaginatedTable, type PaginatedTableHandle } from '@/components/PaginatedTable'
import { fetchDevices } from '@/lib/api'

/**
 * `GET /api/groups` (`packages/core/src/api/groups.ts`) replies with the
 * usual keyset envelope over `GroupInfo` — no dedicated
 * `GroupsPageResponseSchema` export exists in protocol (plan 72 §3.4's
 * report flags this as a gap, still open under the new name), so it is
 * composed here from the exported `pageSchema` helper and `GroupInfoSchema`,
 * both already in protocol.
 */
const GroupsPageResponseSchema = pageSchema(GroupInfoSchema)

export default function GroupsPage() {
  const tableRef = useRef<PaginatedTableHandle<GroupInfo>>(null)
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [editing, setEditing] = useState<GroupRow | 'new' | null>(null)
  const [membersOf, setMembersOf] = useState<{ id: string; name: string } | null>(null)
  const { run } = useAction()

  const loadDevices = () =>
    void fetchDevices()
      .then(setDevices)
      .catch(() => undefined)

  useEffect(loadDevices, [])

  const remove = (g: GroupInfo) =>
    run('del-' + g.id, () => api(`/api/groups/${g.id}`, z.void(), { method: 'DELETE' }), {
      success: `${g.name} deleted — its devices are ungrouped, not deleted`,
      failure: 'Could not delete the group',
      onSuccess: () => tableRef.current?.reload(),
    })

  const refreshAll = () => {
    tableRef.current?.reload()
    loadDevices()
  }

  return (
    <>
      <PageHeader
        title="Groups"
        description="Containers devices are put into and taken out of — a region, a rack, a customer"
        actions={
          <Button onClick={() => setEditing('new')}>
            <Plus className="size-3.5" aria-hidden />
            New group
          </Button>
        }
      />

      <div className="space-y-4 px-5 py-4">
        <PaginatedTable<GroupInfo>
          ref={tableRef}
          fetchPage={(cursor) => api(`/api/groups?limit=50${cursor ? `&cursor=${cursor}` : ''}`, GroupsPageResponseSchema)}
          rowKey={(g) => g.id}
          header={
            <>
              <TableHead className="w-[35%]">Name</TableHead>
              <TableHead>Devices</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </>
          }
          renderRow={(g) => (
            <>
              <TableCell>
                <button className="font-medium hover:text-accent" onClick={() => setEditing(g)}>
                  {g.name}
                </button>
                {g.description && <p className="mt-0.5 line-clamp-1 text-[11.5px] text-fg-muted">{g.description}</p>}
              </TableCell>
              <TableCell className="readout text-[12.5px]">
                {g.deviceCount}
                {g.deviceCount !== g.usableCount && (
                  <span className="ml-1 text-fg-subtle">({g.usableCount} usable)</span>
                )}
              </TableCell>
              <TableCell className="readout text-[11.5px] text-fg-muted">{relativeTime(g.createdAt)}</TableCell>
              <TableCell className="text-right">
                <div className="flex justify-end gap-1">
                  <Button asChild size="sm" variant="secondary" className="h-7 text-[12px]">
                    {/* The script list moved into `/plugins` (the merged
                        Plugins & scripts screen, 2026-08-17) — `?group=`
                        still opens the run dialog on arrival. */}
                    <Link href={`/plugins?group=${g.id}`}>Run</Link>
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-[12px]"
                    onClick={() => setMembersOf({ id: g.id, name: g.name })}
                  >
                    Members
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 text-[12px]" onClick={() => setEditing(g)}>
                    Edit
                  </Button>
                  <ConfirmDialog
                    trigger={
                      <Button size="sm" variant="ghost" className="h-7 text-[12px]">
                        Delete
                      </Button>
                    }
                    title={`Delete ${g.name}?`}
                    description="Its devices become ungrouped, not deleted, and past batch reports that named this group stay intact and readable."
                    onConfirm={() => remove(g)}
                  />
                </div>
              </TableCell>
            </>
          )}
          empty={{
            icon: <Layers className="size-4" aria-hidden />,
            title: 'No groups yet',
            description: 'A group is a container — a region, a rack, a customer. Create one, then add devices to it.',
            action: <Button onClick={() => setEditing('new')}>New group</Button>,
          }}
        />
      </div>

      <GroupEditorDialog group={editing} onClose={() => setEditing(null)} onSaved={refreshAll} />

      <GroupMembersDialog
        group={membersOf}
        allDevices={devices}
        onClose={() => setMembersOf(null)}
        onChanged={refreshAll}
      />
    </>
  )
}
