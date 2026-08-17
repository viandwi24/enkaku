'use client'

import { useEffect, useMemo, useState } from 'react'
import { BatchResponseSchema, type BatchOrder, type ClusterInfo, type DeviceInfo } from '@enkaku/protocol'
import { ArtifactPicker, uploadArtifactSource, type ArtifactSource } from '@/components/ArtifactPicker'
import { OutcomeSummary } from '@/components/bulk/OutcomeSummary'
import { SkippedGroups } from '@/components/bulk/SkippedGroups'
import { batchOutcomeCounts, batchOutcomeGroups, useBatchReport } from '@/components/bulk/use-batch-report'
import { ReattachBanner } from '@/components/operations/ReattachBanner'
import { TransferProgressBar } from '@/components/operations/TransferProgressBar'
import { TargetPicker } from '@/components/target/TargetPicker'
import { useTargetSelection, type Target } from '@/components/target/useTargetSelection'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  useAction,
} from '@enkaku/ui'
import { findReattach, resolveTargetDeviceIds, useOperations, type OperationAction } from '@/lib/operations'
import { coreBase } from '@/lib/ws'

const TARGET_ALLOW: Target[] = ['single', 'cluster', 'devices']

/**
 * Push and pull, over a selection (plan 93 §3.11, §3.13, §4.8, F15, step
 * 93.11) — one dialog, two modes, each posting a single batch
 * (`internal:push` / `internal:pull`, both step 93.9's, already registered
 * and gated identically to `internal:install`, §3.12). Same shape as
 * `InstallBatchDialog`, deliberately: concurrency/order controls, an
 * `ArtifactPicker` for push's source file, and it STAYS OPEN showing the
 * report instead of navigating away (F15, H3) — the whole point of this
 * plan's "no bulk surface invents a fourth style" rule (§3.15).
 *
 * Plan 104 (M69) §3.4 — `devices` is the DEFAULT target, pre-filled but
 * fully editable through `TargetPicker`; see `InstallBatchDialog`'s own doc
 * comment for the identical reasoning.
 *
 * Plan 107 (M72) §3.6, step 107.5 — re-attach, the identical shape
 * `InstallBatchDialog` uses (see that file's own doc comment): a running
 * push/pull on the whole (fully overlapping) target replaces the form with
 * that operation's own progress instead of offering a second start; a
 * partial overlap is named by `ReattachBanner`, never merged silently.
 */
export function BulkTransferDialog({
  mode,
  open,
  onOpenChange,
  devices,
  allDevices,
  clusters = [],
}: {
  mode: 'push' | 'pull'
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The pre-filled default target — still fully editable through the picker below. */
  devices: DeviceInfo[]
  /** The whole pool `TargetPicker`'s Cluster/Multiple devices modes can choose from. Defaults to `devices` for a caller not yet updated to pass the whole fleet. */
  allDevices?: DeviceInfo[]
  clusters?: ClusterInfo[]
}) {
  const pool = allDevices ?? devices
  const { run, isPending } = useAction()
  const [source, setSource] = useState<ArtifactSource | null>(null)
  const [remotePath, setRemotePath] = useState('')
  const [concurrency, setConcurrency] = useState(0)
  const [order, setOrder] = useState<BatchOrder>('as-listed')
  const [batchId, setBatchId] = useState<string | null>(null)
  const report = useBatchReport(batchId)
  // Plan 107 §3.6, step 107.5 — the same re-attach shape `InstallBatchDialog`
  // uses: a `batch:<id>` match sets `batchId` directly (reusing
  // `useBatchReport` unchanged); a `transfer:<id>` match (an ephemeral
  // single-device push/pull started elsewhere) is rendered with
  // `TransferProgressBar` instead.
  const { operations } = useOperations()
  const [attachedKey, setAttachedKey] = useState<string | null>(null)
  const attachedTransfer = attachedKey ? (operations.find((o) => o.key === attachedKey) ?? null) : null
  const action: OperationAction = mode
  // See `InstallBatchDialog`'s identical comment: `Infinity` for a caller
  // that has not been updated to pass `allDevices`, so an un-updated caller
  // never sees a fleet-wide gate comparing the picked set to itself.
  const targetSelection = useTargetSelection({ usableCount: allDevices ? allDevices.length : Number.POSITIVE_INFINITY, clusters })
  const { target, deviceId, deviceIds, clusterId, resolvedCount, hasTarget, fleetConfirmed } = targetSelection

  const deviceLabel = (id: string) => pool.find((d) => d.id === id)?.label ?? id

  // Plan 107 §3.6 — resolved against the CURRENT picker state so editing
  // the target while the dialog is open re-checks for an overlap.
  const targetDeviceIds = useMemo(
    () => resolveTargetDeviceIds({ target, deviceId, deviceIds, clusterId }, pool),
    [target, deviceId, deviceIds, clusterId, pool],
  )
  const reattach = useMemo(() => findReattach(operations, action, targetDeviceIds), [operations, action, targetDeviceIds])

  // A fresh mode swap (Push → Pull or back) starts clean rather than
  // carrying a stale artifact/path/report across — the two are unrelated
  // operations sharing one dialog shell, not one form with two states.
  useEffect(() => {
    setSource(null)
    setRemotePath('')
    setBatchId(null)
    setAttachedKey(null)
  }, [mode])

  // Re-default whenever the dialog OPENS (plan 104 §3.2) — one device lands
  // on `single`, more than one on `devices`, pre-filled; still editable.
  useEffect(() => {
    if (!open) return
    targetSelection.reset({
      devices: pool,
      allow: TARGET_ALLOW,
      initialDeviceId: devices[0]?.id ?? null,
      initialSelectedIds: devices.length > 1 ? devices.map((d) => d.id) : undefined,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Plan 107 §3.6, step 107.5 — silent re-attach, ONLY the clean case: the
  // whole target is covered by exactly one running/queued push/pull. Runs
  // once per fresh open/mode (guarded by `!batchId && !attachedKey`), never
  // yanking an operator mid-edit into a report view.
  useEffect(() => {
    if (!open || batchId || attachedKey) return
    if (reattach.overlap !== 'full' || !reattach.operation) return
    if (reattach.operation.kind === 'batch') {
      setBatchId(reattach.operation.key.slice('batch:'.length))
    } else if (reattach.operation.kind === 'transfer') {
      setAttachedKey(reattach.operation.key)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, reattach, batchId, attachedKey])

  function reset(): void {
    setSource(null)
    setRemotePath('')
    setBatchId(null)
    setAttachedKey(null)
  }

  const canSubmit =
    hasTarget &&
    fleetConfirmed &&
    reattach.overlap === 'none' &&
    (mode === 'push' ? source !== null && remotePath.trim().length > 0 : remotePath.trim().length > 0)

  async function submitBatch(): Promise<void> {
    if (!canSubmit) return
    await run(
      'bulk-transfer',
      async () => {
        const params =
          mode === 'push' && source
            ? { artifactId: await uploadArtifactSource(source), remotePath: remotePath.trim() }
            : { remotePath: remotePath.trim() }
        const res = await fetch(`${coreBase()}/api/batches`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            scriptId: mode === 'push' ? 'internal:push' : 'internal:pull',
            params,
            target: target === 'cluster' ? { clusterId } : { deviceIds: target === 'single' ? [deviceId] : deviceIds },
            concurrency,
            order,
          }),
        })
        const parsed = BatchResponseSchema.safeParse(await res.json().catch(() => null))
        if (!res.ok || !parsed.success) {
          throw new Error(`Could not create the ${mode} batch`)
        }
        setBatchId(parsed.data.batch.id)
      },
      { failure: `Bulk ${mode} failed to start` },
    )
  }

  const counts = report.batch ? batchOutcomeCounts(report.batch) : null
  const groups = report.batch ? batchOutcomeGroups(report.batch, report.jobs, deviceLabel) : null
  const title = mode === 'push' ? 'Push file to' : 'Pull file from'

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o)
        if (!o) reset()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {title} {resolvedCount} device{resolvedCount === 1 ? '' : 's'}
          </DialogTitle>
          <DialogDescription>
            {mode === 'push'
              ? 'Uploads (or reuses) the file once, then writes it to the same path on every selected device as one batch.'
              : 'Reads the same path off every selected device into its own new artifact, as one batch.'}
            {' '}Each device reports its own result — this dialog stays open to show it.
          </DialogDescription>
        </DialogHeader>

        {!batchId && !attachedTransfer ? (
          <div className="space-y-3">
            <ReattachBanner reattach={reattach} deviceLabel={deviceLabel} verb={mode === 'push' ? 'pushing to' : 'pulling from'} />
            {mode === 'push' && (
              <ArtifactPicker value={source} onChange={setSource} disabled={isPending('bulk-transfer')} />
            )}
            <div className="space-y-1.5">
              <Label className="text-[12.5px] font-normal">Remote path</Label>
              <Input
                value={remotePath}
                onChange={(e) => setRemotePath(e.target.value)}
                placeholder={mode === 'push' ? '/sdcard/Download/file.bin' : '/sdcard/report.txt'}
                disabled={isPending('bulk-transfer')}
              />
            </div>
            <TargetPicker selection={targetSelection} devices={pool} clusters={clusters} allow={TARGET_ALLOW} />
            {(target === 'cluster' || target === 'devices') && (
              <div className="grid grid-cols-2 gap-3 rounded-lg border bg-surface-2/40 p-3">
                <div className="space-y-1.5">
                  <Label className="text-[12.5px] font-normal">Concurrency</Label>
                  <Select value={String(concurrency)} onValueChange={(v) => setConcurrency(Number.parseInt(v, 10))}>
                    <SelectTrigger className="h-8 w-full text-[12.5px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="0">All at once</SelectItem>
                      <SelectItem value="1">One at a time</SelectItem>
                      <SelectItem value="2">2 at a time</SelectItem>
                      <SelectItem value="3">3 at a time</SelectItem>
                      <SelectItem value="5">5 at a time</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-[12.5px] font-normal">Order</Label>
                  <Select value={order} onValueChange={(v) => setOrder(v as BatchOrder)}>
                    <SelectTrigger className="h-8 w-full text-[12.5px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="as-listed">As listed</SelectItem>
                      <SelectItem value="random">Random</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}
          </div>
        ) : batchId ? (
          <div className="space-y-3">
            {counts && <OutcomeSummary counts={counts} label={`${mode === 'push' ? 'Push' : 'Pull'} progress`} />}
            {groups && <SkippedGroups failed={groups.failed} skipped={groups.skipped} />}
            {!report.done && <p className="text-[11.5px] text-fg-subtle">{mode === 'push' ? 'Pushing…' : 'Pulling…'}</p>}
          </div>
        ) : (
          attachedTransfer && (
            <div className="space-y-3">
              <p className="text-[11.5px] text-fg-muted">
                Already {mode === 'push' ? 'pushing to' : 'pulling from'} {deviceLabel(attachedTransfer.deviceIds[0] ?? '')} — re-attached to the
                operation already running (plan 107 §3.6). Closing this dialog does not stop it; find it again in the operations tray.
              </p>
              {attachedTransfer.transfer && (
                <TransferProgressBar
                  transfer={attachedTransfer.transfer}
                  label={attachedTransfer.status === 'running' ? (mode === 'push' ? 'Pushing' : 'Pulling') : attachedTransfer.status === 'success' ? 'Done' : 'Failed'}
                />
              )}
            </div>
          )
        )}

        <DialogFooter>
          {!batchId && !attachedTransfer ? (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={() => void submitBatch()} disabled={!canSubmit || isPending('bulk-transfer')}>
                {isPending('bulk-transfer') ? 'Starting…' : mode === 'push' ? 'Push' : 'Pull'}
              </Button>
            </>
          ) : (
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
