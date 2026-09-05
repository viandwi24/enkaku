'use client'

import { useEffect, useState } from 'react'
import type { VmRecord, VmState } from '@enkaku/protocol'
import { Button, ConfirmDialog, EmptyState, ErrorState, LoadingRows, PlayIcon, PlusIcon, SquareIcon, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TrashIcon, cn, relativeTime, useAction } from '@enkaku/ui'
import { deleteVm, fetchVms, startVm, stopVm } from '@/lib/api'
import { CreateVirtualDeviceDialog } from '@/components/devices/CreateVirtualDeviceDialog'

const POLL_MS = 3000

const STATE_LABEL: Record<VmState, string> = {
  creating: 'Creating',
  starting: 'Starting',
  running: 'Running',
  stopping: 'Stopping',
  stopped: 'Stopped',
  failed: 'Failed',
}

const STATE_CLASS: Record<VmState, string> = {
  creating: 'text-faint',
  starting: 'text-led-warn',
  running: 'text-led-ok',
  stopping: 'text-led-warn',
  stopped: 'text-faint',
  failed: 'text-led-danger',
}

/**
 * Settings → Virtual devices (plan 403 §4.2) — a bespoke section, spliced
 * into `farmSections()` exactly as `access` already is (plan 403 §3.2): VM
 * rows live behind `/api/vms`, not inside `FarmSettingsSchema`, so there is
 * no schema key for `SchemaForm` to render.
 *
 * A VM row owns a process, not a device (plan 400 D6) — this section never
 * reads or writes `/api/devices`. Once a VM reaches `running` the emulator
 * it started is discovered by the existing reconciler on its own interval,
 * and shows up on the Devices screen as an ordinary device; this section
 * only says that it will.
 */
export function VirtualDevicesSection() {
  const [vms, setVms] = useState<VmRecord[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const { run, isPending } = useAction()

  const load = () => {
    fetchVms()
      .then((rows) => {
        setVms(rows)
        setError(null)
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }

  useEffect(() => {
    load()
    // 3 s while this section is mounted, cleared on teardown (plan 403 G3) —
    // a Settings page left open on another section must not keep polling.
    const id = setInterval(load, POLL_MS)
    return () => clearInterval(id)
  }, [])

  const hasRunning = (vms ?? []).some((v) => v.state === 'running' || v.state === 'starting')

  return (
    <div className="space-y-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="border-b border-line pb-3 text-section font-semibold text-text">Virtual devices</h2>
          <p className="max-w-xl pt-3.5 text-body leading-relaxed text-faint">
            An Android Emulator instance the farm starts and boots, cold, headless — for testing, one or two at a time,
            never the main use (plan 400). It needs an Android SDK installed on this machine; Enkaku never downloads
            one.
          </p>
        </div>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <PlusIcon className="size-3.5" aria-hidden /> Create virtual device
        </Button>
      </div>

      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : vms === null ? (
        <LoadingRows rows={2} />
      ) : vms.length === 0 ? (
        <EmptyState
          title="No virtual devices yet"
          description="Create one to test scripts and jobs without a phone plugged in. It behaves like an ordinary device once it boots — no real sensors, and its identifiers are not hardware, so simple automation detection flags it immediately."
          action={
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <PlusIcon className="size-3.5" aria-hidden /> Create virtual device
            </Button>
          }
        />
      ) : (
        <div className="overflow-hidden rounded-card border border-line-2">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-[30%]">Name</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Serial</TableHead>
                <TableHead>API level</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {vms.map((vm) => (
                <VmRow key={vm.id} vm={vm} run={run} isPending={isPending} onChanged={load} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {hasRunning && (
        <p className="text-meta text-faint">
          A running virtual device appears on the Devices screen on its own — Enkaku discovers it the same way it
          discovers a USB phone, on the next reconcile pass. It will not appear instantly.
        </p>
      )}

      <CreateVirtualDeviceDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={load} />
    </div>
  )
}

function VmRow({
  vm,
  run,
  isPending,
  onChanged,
}: {
  vm: VmRecord
  run: ReturnType<typeof useAction>['run']
  isPending: ReturnType<typeof useAction>['isPending']
  onChanged: () => void
}) {
  const canStart = vm.state === 'stopped' || vm.state === 'failed'
  const canStop = vm.state === 'running' || vm.state === 'starting'
  const canDelete = vm.state !== 'running' && vm.state !== 'starting' && vm.state !== 'stopping'
  const elapsed = vm.startedAt ? relativeTime(vm.startedAt) : relativeTime(vm.createdAt)

  return (
    <TableRow>
      <TableCell className="font-medium text-text">{vm.name}</TableCell>
      <TableCell>
        <div className={cn('text-body', STATE_CLASS[vm.state])}>
          {STATE_LABEL[vm.state]}
          {(vm.state === 'starting' || vm.state === 'stopping') && <span className="ml-1.5 text-meta text-faint">{elapsed}</span>}
        </div>
        {vm.state === 'failed' && vm.message && (
          <p className="mt-1 max-w-md text-meta text-led-danger">{vm.message}</p>
        )}
      </TableCell>
      <TableCell className="font-mono text-meta text-faint">{vm.serial}</TableCell>
      <TableCell className="text-body text-faint">{vm.spec.apiLevel}</TableCell>
      <TableCell>
        <div className="flex justify-end gap-1.5">
          {canStart && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7"
              disabled={isPending('start-' + vm.id)}
              onClick={() => run('start-' + vm.id, () => startVm(vm.id), { failure: 'Could not start the virtual device', onSuccess: onChanged })}
            >
              <PlayIcon className="size-3.5" aria-hidden /> Start
            </Button>
          )}
          {canStop && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7"
              disabled={isPending('stop-' + vm.id)}
              onClick={() => run('stop-' + vm.id, () => stopVm(vm.id), { failure: 'Could not stop the virtual device', onSuccess: onChanged })}
            >
              <SquareIcon className="size-3.5" aria-hidden /> Stop
            </Button>
          )}
          <ConfirmDialog
            trigger={
              <Button variant="ghost" size="sm" className="h-7" disabled={!canDelete || isPending('del-' + vm.id)}>
                <TrashIcon className="size-3.5" aria-hidden /> Delete
              </Button>
            }
            title={`Delete ${vm.name}?`}
            description="The AVD is deleted from disk. This never touches the device row Enkaku created for it — a device row for a stopped or deleted emulator just goes offline, like a phone that was unplugged."
            onConfirm={() =>
              run('del-' + vm.id, () => deleteVm(vm.id), { success: `${vm.name} deleted`, failure: 'Could not delete the virtual device', onSuccess: onChanged })
            }
          />
        </div>
      </TableCell>
    </TableRow>
  )
}
