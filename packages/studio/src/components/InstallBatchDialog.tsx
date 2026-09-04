'use client'

import { useEffect, useMemo, useState } from 'react'
import type { DeviceInfo, GroupInfo } from '@enkaku/protocol'
import { ArtifactPicker, uploadArtifactSource, type ArtifactSource } from '@/components/ArtifactPicker'
import { deviceLabelIn, deviceNameIn } from '@/components/bulk/SkippedGroups'
import { ActionResults } from '@/components/actions/ActionResults'
import { TransferProgressBar } from '@/components/operations/TransferProgressBar'
import { TargetPicker } from '@/components/target/TargetPicker'
import { useTargetSelection, type Target } from '@/components/target/useTargetSelection'
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, useAction } from '@enkaku/ui'
import { runAction, awaitOperation } from '@/lib/actions'
import { findReattach, resolveTargetDeviceIds, useOperations } from '@/lib/operations'
import type { ActionResult } from '@enkaku/protocol'

const TARGET_ALLOW: Target[] = ['single', 'group', 'devices']

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
 * result exists — it STAYS OPEN and renders per-device outcomes through
 * `ActionResults` (plan 207 §4.9).
 *
 * Plan 104 (M69) §3.4 — `devices` is now a DEFAULT, not a lock: `TargetPicker`
 * lets the operator switch to a group or edit the device list before
 * installing, the same "fill default value nya ada, tapi user juga masih
 * bisa custom" the owner asked for everywhere else. `allDevices` is the
 * whole pool the picker can choose from — every caller that predates this
 * plan omits it, which reproduces its exact previous behaviour (a picker
 * that can only ever narrow the one set it was handed).
 *
 * Plan 207 §4.2, §4.9 — `install` is now the actions API's own async verb:
 * `POST /api/actions/install` dispatches to every device in the target at
 * once (bounded server-side, `ACTION_FANOUT_CONCURRENCY` — no client-picked
 * concurrency or order any more, since the verb takes none), and
 * `awaitOperation` polls until every result settles. This replaced the old
 * `internal:install` BATCH (`POST /api/batches`) entirely, so a batch-shaped
 * re-attach (plan 107 §3.6's `batch:<id>` match) no longer applies here — an
 * install this dialog itself started is polled to completion inline, never
 * left as a re-openable batch. The one re-attach case that still can happen
 * — a single-device install already running from elsewhere (the device
 * popup's Files tab, or device preparation's own `ui-server` install), an
 * ephemeral `transfer:<id>` operation from `lib/operations.ts`'s farm-wide
 * poller — is kept, via `TransferProgressBar`.
 */
export function InstallBatchDialog({
  open,
  onOpenChange,
  devices,
  allDevices,
  groups = [],
  nonModal = false,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The pre-filled default target — still fully editable through the picker below. */
  devices: DeviceInfo[]
  /** The whole pool `TargetPicker`'s Group/Multiple devices modes can choose from. Defaults to `devices` for a caller not yet updated to pass the whole fleet. */
  allDevices?: DeviceInfo[]
  groups?: GroupInfo[]
  /** Plan 103 §3.2, §5 step 103.1 — the device popup's non-modal path (its "Install apk" row, one device): when true, renders without its own overlay so it can sit inside the popup's own layer instead of fighting it for focus. */
  nonModal?: boolean
}) {
  const pool = allDevices ?? devices
  const { run, isPending } = useAction()
  const [source, setSource] = useState<ArtifactSource | null>(null)
  const [results, setResults] = useState<ActionResult[] | null>(null)
  // Plan 107 §3.6, step 107.5 — re-attach, not restart: opening this dialog
  // while an install is already running elsewhere on the (fully overlapping)
  // target shows THAT ephemeral transfer instead of a fresh Install button.
  const { operations } = useOperations()
  const [attachedKey, setAttachedKey] = useState<string | null>(null)
  const attachedTransfer = attachedKey ? (operations.find((o) => o.key === attachedKey) ?? null) : null
  // The fleet-wide gate (plan 94 §9 Q4) needs the WHOLE fleet's size to mean
  // anything — a caller that has not been updated to pass `allDevices` gets
  // `Infinity` here, which can never look "every usable device", rather
  // than the picked set's own size (comparing a set to itself would flag
  // EVERY pick as fleet-wide, which is worse than no gate at all).
  const targetSelection = useTargetSelection({ usableCount: allDevices ? allDevices.length : Number.POSITIVE_INFINITY, groups })
  const { target, deviceId, deviceIds, groupId, resolvedCount, hasTarget, fleetConfirmed } = targetSelection

  // Re-default every time the dialog OPENS (not on every render) — a single
  // device handed in still lands on `single`, and more than one lands on
  // `devices`, pre-filled, exactly like before this plan's own extraction.
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

  // Plan 124 §4.4, step 124.3 — `deviceLabel` is the composed `#7 Galaxy A15`
  // string `ActionResults` and the prose sentences below need.
  const deviceLabel = (id: string) => deviceLabelIn(pool, id)

  // Plan 107 §3.6 — resolved against the CURRENT picker state, not just the
  // caller's own pre-fill, so editing the target while the dialog stays
  // open (e.g. adding a device) re-checks for an overlap immediately.
  const targetDeviceIds = useMemo(
    () => resolveTargetDeviceIds({ target, deviceId, deviceIds, groupId }, pool),
    [target, deviceId, deviceIds, groupId, pool],
  )
  const reattach = useMemo(() => findReattach(operations, 'install', targetDeviceIds), [operations, targetDeviceIds])

  // Silent re-attach — ONLY the clean case (§3.6), and only ever to an
  // ephemeral transfer now (see the file's own doc comment for why a batch
  // match can no longer occur). Runs once per fresh open (guarded by
  // `!results && !attachedKey`) rather than on every `reattach` change, so an
  // operator who is mid-edit on the target is never yanked into a report
  // view they did not ask for.
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
    setResults(null)
    setAttachedKey(null)
  }

  async function submitInstall(): Promise<void> {
    if (!source || !hasTarget) return
    await run(
      'install-batch',
      async () => {
        const artifactId = await uploadArtifactSource(source)
        const targetBody = target === 'group' ? { groupId } : { deviceIds: target === 'single' ? [deviceId] : deviceIds }
        const response = await runAction('install', targetBody, { artifactId })
        const operation = await awaitOperation(response.operationId)
        setResults(operation.results)
      },
      { failure: 'Install failed to start' },
    )
  }

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
            Uploads (or reuses) the APK once, then installs it across every selected device. Each device reports its
            own result — this dialog stays open to show it.
          </DialogDescription>
        </DialogHeader>

        {!results && !attachedTransfer ? (
          <>
            {reattach.overlap !== 'none' && (
              <p className="rounded border border-led-warn/30 bg-led-warn/5 px-2.5 py-2 text-[12px] text-led-warn">
                {reattach.overlap === 'partial' ? 'Some of' : 'All of'} this target is already installing —
                {reattach.overlapping.map((op) => op.deviceIds.map(deviceLabel).join(', ')).join('; ')}. Narrow the
                target or wait for it to finish.
              </p>
            )}
            <ArtifactPicker accept=".apk" value={source} onChange={setSource} disabled={isPending('install-batch')} />
            <TargetPicker selection={targetSelection} devices={pool} groups={groups} allow={TARGET_ALLOW} />
          </>
        ) : results ? (
          <div className="space-y-3">
            <ActionResults results={results} nameOf={deviceLabel} />
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
          {!results && !attachedTransfer ? (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                onClick={() => void submitInstall()}
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
