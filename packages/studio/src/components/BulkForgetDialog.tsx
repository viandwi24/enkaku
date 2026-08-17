'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { z } from 'zod'
import type { DeviceInfo } from '@enkaku/protocol'
import { TargetPicker } from '@/components/target/TargetPicker'
import { useTargetSelection, type Target } from '@/components/target/useTargetSelection'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Button, api } from '@enkaku/ui'

interface Outcome {
  ok: boolean
  message?: string
}

const TARGET_ALLOW: Target[] = ['single', 'devices']

/**
 * "Forget selected" (plan 47 §4.5, acceptance #9) — the operation this farm
 * needs today for its four permanently-offline rows (`Test Phone`,
 * `VERIFY123`, two `serial:127.0.0.1:…`). There is no bulk endpoint: each
 * device gets its own `DELETE /api/devices/:id`, exactly like a single
 * Forget, so a busy or connected device among the selection is refused on
 * its own terms and named here rather than silently skipped or blocking
 * the rest.
 *
 * Plan 104 (M69) §3.4 — `devices` is the pre-filled DEFAULT, still editable
 * through `TargetPicker` (single or an ad-hoc device list — no cluster mode,
 * per §3.4's own table). Forget keeps its fleet-wide typed confirmation
 * (irreversible), which `TargetPicker` already carries — no second one is
 * invented here.
 *
 * `nonModal` (plan 103 §5 step 103.10) — added so this dialog can be opened
 * from the device popup's/context menu's own Forget row on a multi-device
 * candidate set without dimming the screen behind it, matching
 * `InstallBatchDialog`'s identical `overlay={!nonModal}` / `modal={!nonModal}`
 * pair; `ActionsList.tsx`'s single-device `ForgetDeviceDialog` path is
 * already `nonModal` today, so leaving THIS path modal would have made the
 * same row behave inconsistently depending only on how many devices happened
 * to be selected when it was clicked.
 */
export function BulkForgetDialog({
  devices,
  allDevices,
  open,
  onOpenChange,
  onDone,
  nonModal = false,
}: {
  /** The pre-filled default target — still fully editable through the picker below. */
  devices: DeviceInfo[]
  /** The whole pool `TargetPicker`'s Multiple devices mode can choose from. Defaults to `devices` for a caller not yet updated to pass the whole fleet. */
  allDevices?: DeviceInfo[]
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called once at least one device was actually forgotten. */
  onDone: () => void
  nonModal?: boolean
}) {
  const pool = allDevices ?? devices
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<Record<string, Outcome> | null>(null)
  const targetSelection = useTargetSelection({
    // See `InstallBatchDialog`'s identical comment — `Infinity` for a
    // caller that has not been updated to pass `allDevices`.
    usableCount: allDevices ? allDevices.length : Number.POSITIVE_INFINITY,
  })
  const { target, deviceId, deviceIds, hasTarget, fleetConfirmed } = targetSelection

  useEffect(() => {
    if (!open) {
      setResults(null)
      return
    }
    targetSelection.reset({
      devices: pool,
      allow: TARGET_ALLOW,
      initialDeviceId: devices[0]?.id ?? null,
      initialSelectedIds: devices.length > 1 ? devices.map((d) => d.id) : undefined,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const targetDevices = target === 'single' ? pool.filter((d) => d.id === deviceId) : pool.filter((d) => deviceIds.includes(d.id))

  const run = async () => {
    setBusy(true)
    const entries = await Promise.all(
      targetDevices.map(async (d): Promise<[string, Outcome]> => {
        try {
          // `DELETE /:id` returns `{ forgotten: {...} }` (`packages/core/src/api/devices.ts`) — unread here,
          // same reasoning as the single-device `ForgetDeviceDialog.tsx`.
          await api(`/api/devices/${d.id}?deleteHistory=false`, z.object({}).passthrough(), { method: 'DELETE' })
          return [d.id, { ok: true }]
        } catch (err) {
          return [d.id, { ok: false, message: err instanceof Error ? err.message : String(err) }]
        }
      }),
    )
    setResults(Object.fromEntries(entries))
    setBusy(false)
    const okCount = entries.filter(([, r]) => r.ok).length
    const failCount = entries.length - okCount
    if (okCount > 0) {
      toast.success(`${okCount} device${okCount === 1 ? '' : 's'} forgotten`)
      onDone()
    }
    if (failCount > 0) toast.warning(`${failCount} skipped — still connected or busy, see the list below`)
    else onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} modal={!nonModal}>
      <DialogContent overlay={!nonModal}>
        <DialogHeader>
          <DialogTitle>
            Forget {targetDevices.length} device{targetDevices.length === 1 ? '' : 's'}?
          </DialogTitle>
          <DialogDescription>
            Removes each from the fleet — its row, tags, and cluster membership. Jobs, artifacts, and events are kept.
            A device that is busy, has an active manual lease, or is still connected and idle is refused and named
            below, exactly as a single Forget would be — block it instead from its own device page.
          </DialogDescription>
        </DialogHeader>

        {!results && <TargetPicker selection={targetSelection} devices={pool} allow={TARGET_ALLOW} />}

        {results && (
          <ul className="max-h-64 divide-y overflow-auto rounded-md border text-[12.5px]">
            {targetDevices.map((d) => {
              const r = results[d.id]
              return (
                <li key={d.id} className="flex items-center justify-between gap-3 px-3 py-1.5">
                  <span className="min-w-0 truncate">{d.label}</span>
                  {!r ? (
                    <span className="shrink-0 text-fg-subtle">{busy ? 'working…' : 'pending'}</span>
                  ) : r.ok ? (
                    <span className="shrink-0 text-led-ok">forgotten</span>
                  ) : (
                    <span className="shrink-0 text-led-danger" title={r.message}>
                      skipped — {r.message}
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {results ? 'Close' : 'Cancel'}
          </Button>
          {!results && (
            <Button disabled={busy || !hasTarget || !fleetConfirmed} onClick={() => void run()}>
              {busy ? 'Forgetting…' : 'Forget selected'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
