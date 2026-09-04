'use client'

import { useEffect, useMemo, useState } from 'react'
import type { ActionResult, DeviceInfo, GroupInfo } from '@enkaku/protocol'
import { ArtifactPicker, uploadArtifactSource, type ArtifactSource } from '@/components/ArtifactPicker'
import { ActionResults } from '@/components/actions/ActionResults'
import { deviceLabelIn } from '@/components/bulk/SkippedGroups'
import { TransferProgressBar } from '@/components/operations/TransferProgressBar'
import { TargetPicker } from '@/components/target/TargetPicker'
import { useTargetSelection, type Target } from '@/components/target/useTargetSelection'
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Label, useAction } from '@enkaku/ui'
import { runAction, awaitOperation } from '@/lib/actions'
import { findReattach, resolveTargetDeviceIds, useOperations, type OperationAction } from '@/lib/operations'

const TARGET_ALLOW: Target[] = ['single', 'group', 'devices']

/**
 * Push and pull, over a selection (plan 93 §3.11, §3.13, §4.8, F15, step
 * 93.11) — one dialog, two modes. Plan 207 §4.2, §4.9 rewired both onto the
 * actions API's own `push`/`pull` verbs (`POST /api/actions/push|pull`),
 * replacing the old `internal:push`/`internal:pull` BATCH: each verb
 * dispatches to every device in the target at once (bounded server-side, no
 * client-picked concurrency or order any more), and `awaitOperation` polls
 * until every result settles. Same shape as `InstallBatchDialog`,
 * deliberately: an `ArtifactPicker` for push's source file, and it STAYS
 * OPEN showing the report (`ActionResults`) instead of navigating away
 * (F15, H3) — the whole point of this plan's "no bulk surface invents a
 * fourth style" rule (§3.15).
 *
 * Plan 104 (M69) §3.4 — `devices` is the DEFAULT target, pre-filled but
 * fully editable through `TargetPicker`; see `InstallBatchDialog`'s own doc
 * comment for the identical reasoning.
 *
 * Plan 107 (M72) §3.6, step 107.5 — re-attach: a batch-shaped match no
 * longer applies (see `InstallBatchDialog`'s own doc comment for why); the
 * remaining case is a single-device push/pull already running elsewhere as
 * an ephemeral `transfer:<id>` operation, rendered with `TransferProgressBar`.
 */
export function BulkTransferDialog({
  mode,
  open,
  onOpenChange,
  devices,
  allDevices,
  groups = [],
}: {
  mode: 'push' | 'pull'
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The pre-filled default target — still fully editable through the picker below. */
  devices: DeviceInfo[]
  /** The whole pool `TargetPicker`'s Group/Multiple devices modes can choose from. Defaults to `devices` for a caller not yet updated to pass the whole fleet. */
  allDevices?: DeviceInfo[]
  groups?: GroupInfo[]
}) {
  const pool = allDevices ?? devices
  const { run, isPending } = useAction()
  const [source, setSource] = useState<ArtifactSource | null>(null)
  const [remotePath, setRemotePath] = useState('')
  const [results, setResults] = useState<ActionResult[] | null>(null)
  // Plan 107 §3.6, step 107.5 — the same re-attach shape `InstallBatchDialog`
  // uses: a `transfer:<id>` match (an ephemeral single-device push/pull
  // started elsewhere) is rendered with `TransferProgressBar`.
  const { operations } = useOperations()
  const [attachedKey, setAttachedKey] = useState<string | null>(null)
  const attachedTransfer = attachedKey ? (operations.find((o) => o.key === attachedKey) ?? null) : null
  const action: OperationAction = mode
  // See `InstallBatchDialog`'s identical comment: `Infinity` for a caller
  // that has not been updated to pass `allDevices`, so an un-updated caller
  // never sees a fleet-wide gate comparing the picked set to itself.
  const targetSelection = useTargetSelection({ usableCount: allDevices ? allDevices.length : Number.POSITIVE_INFINITY, groups })
  const { target, deviceId, deviceIds, groupId, resolvedCount, hasTarget, fleetConfirmed } = targetSelection

  // Plan 124 §4.4, step 124.3 — `deviceLabel` is the composed `#7 Galaxy A15`
  // string `ActionResults` and the prose sentences below need.
  const deviceLabel = (id: string) => deviceLabelIn(pool, id)

  // Plan 107 §3.6 — resolved against the CURRENT picker state so editing
  // the target while the dialog is open re-checks for an overlap.
  const targetDeviceIds = useMemo(
    () => resolveTargetDeviceIds({ target, deviceId, deviceIds, groupId }, pool),
    [target, deviceId, deviceIds, groupId, pool],
  )
  const reattach = useMemo(() => findReattach(operations, action, targetDeviceIds), [operations, action, targetDeviceIds])

  // A fresh mode swap (Push → Pull or back) starts clean rather than
  // carrying a stale artifact/path/report across — the two are unrelated
  // operations sharing one dialog shell, not one form with two states.
  useEffect(() => {
    setSource(null)
    setRemotePath('')
    setResults(null)
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
  // whole target is covered by exactly one running/queued transfer. Runs
  // once per fresh open/mode (guarded by `!results && !attachedKey`), never
  // yanking an operator mid-edit into a report view.
  useEffect(() => {
    if (!open || results || attachedKey) return
    if (reattach.overlap !== 'full' || !reattach.operation) return
    if (reattach.operation.kind === 'transfer') {
      setAttachedKey(reattach.operation.key)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, reattach, results, attachedKey])

  function reset(): void {
    setSource(null)
    setRemotePath('')
    setResults(null)
    setAttachedKey(null)
  }

  const canSubmit =
    hasTarget &&
    fleetConfirmed &&
    reattach.overlap === 'none' &&
    (mode === 'push' ? source !== null && remotePath.trim().length > 0 : remotePath.trim().length > 0)

  async function submitTransfer(): Promise<void> {
    if (!canSubmit) return
    await run(
      'bulk-transfer',
      async () => {
        const targetBody = target === 'group' ? { groupId } : { deviceIds: target === 'single' ? [deviceId] : deviceIds }
        const response =
          mode === 'push' && source
            ? await runAction('push', targetBody, { artifactId: await uploadArtifactSource(source), remotePath: remotePath.trim(), mediaScan: 'auto' })
            : await runAction('pull', targetBody, { remotePath: remotePath.trim() })
        const operation = await awaitOperation(response.operationId)
        setResults(operation.results)
      },
      { failure: `Bulk ${mode} failed to start` },
    )
  }

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
              ? 'Uploads (or reuses) the file once, then writes it to the same path on every selected device.'
              : 'Reads the same path off every selected device into its own new artifact.'}
            {' '}Each device reports its own result — this dialog stays open to show it.
          </DialogDescription>
        </DialogHeader>

        {!results && !attachedTransfer ? (
          <div className="space-y-3">
            {reattach.overlap !== 'none' && (
              <p className="rounded border border-led-warn/30 bg-led-warn/5 px-2.5 py-2 text-[12px] text-led-warn">
                {reattach.overlap === 'partial' ? 'Some of' : 'All of'} this target is already {mode === 'push' ? 'pushing to' : 'pulling from'} —
                {reattach.overlapping.map((op) => op.deviceIds.map(deviceLabel).join(', ')).join('; ')}. Narrow the
                target or wait for it to finish.
              </p>
            )}
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
            <TargetPicker selection={targetSelection} devices={pool} groups={groups} allow={TARGET_ALLOW} />
          </div>
        ) : results ? (
          <div className="space-y-3">
            <ActionResults results={results} nameOf={deviceLabel} />
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
          {!results && !attachedTransfer ? (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={() => void submitTransfer()} disabled={!canSubmit || isPending('bulk-transfer')}>
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
