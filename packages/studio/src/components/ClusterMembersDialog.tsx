'use client'

import { useEffect, useState } from 'react'
import { z } from 'zod'
import { ClusterMoveResponseSchema, type DeviceInfo } from '@enkaku/protocol'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { DevicePicker } from '@/components/DevicePicker'
import { DeviceStatusBadge } from '@/components/StatusBadge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { api, useAction } from '@/lib/actions'
import { fetchAllPages } from '@/lib/api'

interface PendingMove {
  ids: string[]
  fromNames: string[]
}

/**
 * A cluster's members panel (plan 22.0 §4.5): add and remove devices.
 * Adding a device that already belongs to another cluster warns "this will
 * move it out of X" before confirming — a move is never a surprise, since an
 * `UPDATE` to `devices.cluster_id` necessarily clears the previous value.
 */
export function ClusterMembersDialog({
  cluster,
  allDevices,
  onClose,
  onChanged,
}: {
  cluster: { id: string; name: string } | null
  allDevices: DeviceInfo[]
  onClose: () => void
  onChanged: () => void
}) {
  const [members, setMembers] = useState<DeviceInfo[] | null>(null)
  const [adding, setAdding] = useState<string[]>([])
  const [pendingMove, setPendingMove] = useState<PendingMove | null>(null)
  const { run, isPending } = useAction()

  const open = cluster !== null

  const load = (id: string) => {
    void fetchAllPages<DeviceInfo>(`/api/clusters/${id}/devices`)
      .then(setMembers)
      .catch(() => setMembers([]))
  }

  useEffect(() => {
    setAdding([])
    setMembers(null)
    setPendingMove(null)
    if (cluster) load(cluster.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cluster?.id])

  if (!open || !cluster) return null
  const activeCluster = cluster

  const memberIds = new Set((members ?? []).map((d) => d.id))
  const candidates = allDevices.filter((d) => !memberIds.has(d.id))

  const doAssign = (ids: string[]) =>
    run(
      'assign',
      () =>
        api(`/api/clusters/${activeCluster.id}/devices`, ClusterMoveResponseSchema, {
          method: 'POST',
          json: { deviceIds: ids },
        }),
      {
        success: `${ids.length} device${ids.length === 1 ? '' : 's'} added to ${activeCluster.name}`,
        failure: 'Could not add those devices',
        onSuccess: () => {
          setAdding([])
          load(activeCluster.id)
          onChanged()
        },
      },
    )

  const addSelected = () => {
    if (adding.length === 0) return
    const movers = adding
      .map((id) => allDevices.find((d) => d.id === id))
      .filter((d): d is DeviceInfo & { cluster: { id: string; name: string } } => Boolean(d?.cluster) && d!.cluster!.id !== activeCluster.id)
    if (movers.length > 0) {
      setPendingMove({ ids: adding, fromNames: [...new Set(movers.map((d) => d.cluster.name))] })
      return
    }
    void doAssign(adding)
  }

  const remove = (device: DeviceInfo) =>
    run('remove-' + device.id, () => api(`/api/clusters/${activeCluster.id}/devices/${device.id}`, z.void(), { method: 'DELETE' }), {
      success: `${device.label} removed from ${activeCluster.name}`,
      failure: 'Could not remove that device',
      onSuccess: () => {
        load(activeCluster.id)
        onChanged()
      },
    })

  return (
    <>
      <Dialog open onOpenChange={(v) => !v && onClose()}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{activeCluster.name} — members</DialogTitle>
            <DialogDescription>Add and remove devices. A device belongs to at most one cluster at a time.</DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <h3 className="rack-label">current members</h3>
              {members === null ? (
                <p className="px-2 py-3 text-center text-[12px] text-fg-muted">Loading…</p>
              ) : members.length === 0 ? (
                <p className="rounded-lg border border-dashed px-3 py-4 text-center text-[12px] text-fg-muted">
                  No devices yet — add some from the right.
                </p>
              ) : (
                <div className="max-h-72 space-y-1 overflow-y-auto rounded-lg border p-1">
                  {members.map((d) => (
                    <div key={d.id} className="flex items-center justify-between gap-2 rounded-md px-2.5 py-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-[13px] font-medium">{d.label}</span>
                          <DeviceStatusBadge status={d.status} />
                        </div>
                        <span className="readout text-[11px] text-fg-subtle">{d.stableId}</span>
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 shrink-0 text-[11.5px]"
                        disabled={isPending('remove-' + d.id)}
                        onClick={() => void remove(d)}
                      >
                        Remove
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-1.5">
              <h3 className="rack-label">add devices</h3>
              <DevicePicker devices={candidates} value={adding} onChange={setAdding} multiple />
              <Button size="sm" className="w-full" disabled={adding.length === 0 || isPending('assign')} onClick={addSelected}>
                {isPending('assign')
                  ? 'Adding…'
                  : adding.length === 0
                    ? 'Add devices'
                    : `Add ${adding.length} device${adding.length === 1 ? '' : 's'}`}
              </Button>
            </div>
          </div>

          <div className="flex justify-end border-t pt-3">
            <Button variant="ghost" onClick={onClose}>
              Done
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={pendingMove !== null} onOpenChange={(v) => !v && setPendingMove(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Move {pendingMove?.ids.length ?? 0} device{(pendingMove?.ids.length ?? 0) === 1 ? '' : 's'}?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="text-[13px] leading-relaxed text-fg-muted">
                This will move {(pendingMove?.ids.length ?? 0) === 1 ? 'it' : 'them'} out of{' '}
                {pendingMove?.fromNames.join(', ')} and into {activeCluster.name}.
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault()
                const ids = pendingMove?.ids ?? []
                setPendingMove(null)
                void doAssign(ids)
              }}
            >
              Move
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
