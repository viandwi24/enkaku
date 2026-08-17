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
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useAction } from '@/lib/actions'
import { findReattach, resolveTargetDeviceIds, useOperations } from '@/lib/operations'
import { coreBase } from '@/lib/ws'

const TARGET_ALLOW: Target[] = ['single', 'cluster', 'devices']

/**
 * Devices list → multi-select → "Install on selected" (plan 39 §4.5, §4.7;
 * plan 93 §3.11, §3.12, §4.8, F15, F17, step 93.11): ONE batch
 * (`internal:install`), never N parallel requests — the batch machinery
 * already gives concurrency, ordering, a per-device report, and cancel with
 * no new orchestration. Three changes from the pre-plan-93 version, all
 * from F15/F17: concurrency and order are now real controls (F17 —
 * previously always "all at once, as listed"); the artifact comes from
 * `ArtifactPicker` so a previously uploaded APK can be reused; and,
 * F15's own headline defect, the dialog no longer navigates away before a
 * result exists — it STAYS OPEN and renders the same `OutcomeSummary` +
 * `SkippedGroups` report every other bulk surface in this plan uses (H3).
 *
 * Plan 104 (M69) §3.4 — `devices` is now a DEFAULT, not a lock: `TargetPicker`
 * lets the operator switch to a cluster or edit the device list before
 * installing, the same "fill default value nya ada, tapi user juga masih
 * bisa custom" the owner asked for everywhere else. `allDevices` is the
 * whole pool the picker can choose from — every caller that predates this
 * plan omits it, which reproduces its exact previous behaviour (a picker
 * that can only ever narrow the one set it was handed).
 *
 * Plan 107 (M72) §3.6, step 107.5 — opening this dialog while an install is
 * already running on the (fully overlapping) target re-attaches to THAT
 * operation instead of offering a fresh Install button: the form is
 * replaced outright by `useBatchReport`'s existing progress view (a
 * `batch:<id>` match) or by a lightweight byte-progress view
 * (`TransferProgressBar`, a `transfer:<id>` match — the ephemeral shape a
 * single-device install started elsewhere, e.g. the device popup's Files
 * tab, takes before any batch machinery is involved). A PARTIAL overlap (a
 * running install on only some of the currently-selected devices) is never
 * merged silently — `ReattachBanner` states it and the Install button is
 * disabled until the operator narrows the target or waits, because
 * guessing here is exactly what races two `pm install` runs on one phone.
 */
export function InstallBatchDialog({
  open,
  onOpenChange,
  devices,
  allDevices,
  clusters = [],
  nonModal = false,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The pre-filled default target — still fully editable through the picker below. */
  devices: DeviceInfo[]
  /** The whole pool `TargetPicker`'s Cluster/Multiple devices modes can choose from. Defaults to `devices` for a caller not yet updated to pass the whole fleet. */
  allDevices?: DeviceInfo[]
  clusters?: ClusterInfo[]
  /** Plan 103 §3.2, §5 step 103.1 — the device popup's non-modal path (its "Install apk" row, one device); see `AssistDialog`'s own doc comment on the same prop for why. */
  nonModal?: boolean
}) {
  const pool = allDevices ?? devices
  const { run, isPending } = useAction()
  const [source, setSource] = useState<ArtifactSource | null>(null)
  const [concurrency, setConcurrency] = useState(0)
  const [order, setOrder] = useState<BatchOrder>('as-listed')
  const [batchId, setBatchId] = useState<string | null>(null)
  const report = useBatchReport(batchId)
  // Plan 107 §3.6, step 107.5 — re-attach, not restart: opening this dialog
  // while an install is already running on the (fully overlapping) target
  // shows THAT operation instead of a fresh Install button. `attachedKey`
  // is a `transfer:<id>` key only — a `batch:<id>` match instead sets
  // `batchId` directly (below), reusing `useBatchReport`'s own report
  // unchanged rather than building a second progress renderer.
  const { operations } = useOperations()
  const [attachedKey, setAttachedKey] = useState<string | null>(null)
  const attachedTransfer = attachedKey ? (operations.find((o) => o.key === attachedKey) ?? null) : null
  // The fleet-wide gate (plan 94 §9 Q4) needs the WHOLE fleet's size to mean
  // anything — a caller that has not been updated to pass `allDevices` gets
  // `Infinity` here, which can never look "every usable device", rather
  // than the picked set's own size (comparing a set to itself would flag
  // EVERY pick as fleet-wide, which is worse than no gate at all).
  const targetSelection = useTargetSelection({ usableCount: allDevices ? allDevices.length : Number.POSITIVE_INFINITY, clusters })
  const { target, deviceId, deviceIds, clusterId, resolvedCount, hasTarget, fleetConfirmed } = targetSelection

  // Re-default every time the dialog OPENS (not on every render) — a single
  // device handed in still lands on `single` (no concurrency/order — one
  // device has nothing to order), and more than one lands on `devices`,
  // pre-filled, exactly like before this plan's own extraction.
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

  const deviceLabel = (id: string) => pool.find((d) => d.id === id)?.label ?? id

  // Plan 107 §3.6 — resolved against the CURRENT picker state, not just the
  // caller's own pre-fill, so editing the target while the dialog stays
  // open (e.g. adding a device) re-checks for an overlap immediately.
  const targetDeviceIds = useMemo(
    () => resolveTargetDeviceIds({ target, deviceId, deviceIds, clusterId }, pool),
    [target, deviceId, deviceIds, clusterId, pool],
  )
  const reattach = useMemo(() => findReattach(operations, 'install', targetDeviceIds), [operations, targetDeviceIds])

  // Silent re-attach — ONLY the clean case (§3.6): the whole target is
  // covered by exactly one running/queued operation. Runs once per fresh
  // open (guarded by `!batchId && !attachedKey`) rather than on every
  // `reattach` change, so an operator who is mid-edit on the target is
  // never yanked into a report view they did not ask for.
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
    setBatchId(null)
    setAttachedKey(null)
  }

  async function submitBatch(): Promise<void> {
    if (!source || !hasTarget) return
    await run(
      'install-batch',
      async () => {
        const artifactId = await uploadArtifactSource(source)
        const res = await fetch(`${coreBase()}/api/batches`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            scriptId: 'internal:install',
            params: { artifactId },
            target: target === 'cluster' ? { clusterId } : { deviceIds: target === 'single' ? [deviceId] : deviceIds },
            concurrency,
            order,
          }),
        })
        const parsed = BatchResponseSchema.safeParse(await res.json().catch(() => null))
        if (!res.ok || !parsed.success) {
          throw new Error('Could not create the batch')
        }
        setBatchId(parsed.data.batch.id)
      },
      { failure: 'Install batch failed to start' },
    )
  }

  const counts = report.batch ? batchOutcomeCounts(report.batch) : null
  const groups = report.batch ? batchOutcomeGroups(report.batch, report.jobs, deviceLabel) : null

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o)
        if (!o) reset()
      }}
      modal={!nonModal}
    >
      <DialogContent overlay={!nonModal}>
        <DialogHeader>
          <DialogTitle>Install on {resolvedCount} device{resolvedCount === 1 ? '' : 's'}</DialogTitle>
          <DialogDescription>
            Uploads (or reuses) the APK once, then installs it across every selected device as one batch. Each
            device reports its own result — this dialog stays open to show it.
          </DialogDescription>
        </DialogHeader>

        {!batchId && !attachedTransfer ? (
          <>
            <ReattachBanner reattach={reattach} deviceLabel={deviceLabel} verb="installing" />
            <ArtifactPicker accept=".apk" value={source} onChange={setSource} disabled={isPending('install-batch')} />
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
          </>
        ) : batchId ? (
          <div className="space-y-3">
            {counts && <OutcomeSummary counts={counts} label="Install progress" />}
            {groups && <SkippedGroups failed={groups.failed} skipped={groups.skipped} />}
            {!report.done && <p className="text-[11.5px] text-fg-subtle">Installing…</p>}
          </div>
        ) : (
          attachedTransfer && (
            <div className="space-y-3">
              <p className="text-[11.5px] text-fg-muted">
                Already installing on {deviceLabel(attachedTransfer.deviceIds[0] ?? '')} — re-attached to the operation already running (plan 107 §3.6).
                Closing this dialog does not stop it; find it again in the operations tray.
              </p>
              {attachedTransfer.transfer && (
                <TransferProgressBar
                  transfer={attachedTransfer.transfer}
                  label={attachedTransfer.status === 'running' ? 'Installing' : attachedTransfer.status === 'success' ? 'Installed' : 'Failed'}
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
              <Button
                onClick={() => void submitBatch()}
                disabled={!source || !hasTarget || !fleetConfirmed || reattach.overlap !== 'none' || isPending('install-batch')}
              >
                {isPending('install-batch') ? 'Starting…' : 'Install'}
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
