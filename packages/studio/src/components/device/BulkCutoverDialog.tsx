'use client'

import { useEffect, useState } from 'react'
import { CutoverResponseSchema, type ConnectionMedium, type DeviceInfo } from '@enkaku/protocol'
import { OutcomeSummary, type OutcomeCounts } from '@/components/bulk/OutcomeSummary'
import { SkippedGroups, type NamedOutcome } from '@/components/bulk/SkippedGroups'
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
  api,
  describeApiError,
} from '@enkaku/ui'

// No `cluster` mode — matching plan 104 §3.4's own table row for
// Reconnect/Disconnect ("single · devices"), the closest existing analogue:
// a connection action targets phones, not a saved selector.
const TARGET_ALLOW: Target[] = ['single', 'devices']

function isUsb(d: DeviceInfo): boolean {
  return (d.connection?.kind ?? 'usb') === 'usb'
}

/**
 * Bulk "Move to the network" (plan 88 §3.4, §5 step 88.5's own singular
 * wizard; this dialog is its multi-device sibling — owner request, this
 * pass: a device farm plausibly has many phones on USB hubs at once, and
 * `CutoverDialog.tsx` takes exactly one `device: DeviceInfo | null`, locked).
 *
 * Composed the same way every other bulk dialog in this repo is —
 * `useTargetSelection` + `TargetPicker` (plan 104), `reset()` on open only,
 * `OutcomeSummary`/`SkippedGroups` for the report — with three decisions
 * specific to this action, each stated here rather than left implicit:
 *
 * 1. **One port for every targeted device is correct, not a shortcut.**
 *    `adb tcpip <port>` (`AdbClient.tcpip`, `packages/core/src/registry/
 *    cutover.ts`'s `enableTcp`) sends `host:transport:<serial>` then
 *    `tcpip:<port>` as a DEVICE service over that one phone's own adb
 *    transport — it restarts THAT phone's adbd listener on that port. It is
 *    not a farm-wide allocation the way a host port bind would be, so 5555
 *    (or any other port) on twenty phones at once is twenty independent
 *    local listeners, never a conflict. `CutoverManager.start` is also
 *    independently keyed by `stableId` (`cutover.ts`'s own `sessions` map),
 *    so N concurrent single-device `POST .../connection/cutover` calls below
 *    is the correct shape, not a stand-in for a batch endpoint the core does
 *    not have.
 * 2. **Eligibility is checked HERE, client-side, before any call goes out.**
 *    Only a USB-connected, non-offline device can be moved to the network —
 *    the same `isUsb`/`device.status !== 'offline'` gates the singular
 *    `CutoverDialog`'s own Check screen renders, and the same
 *    `E_ALREADY_ON_NETWORK`/`device_offline` refusals the API would return
 *    anyway. Checking first means a device already on the network is never
 *    silently dropped from the target OR sent a doomed request — it is named
 *    in the report's Skipped section with the exact reason, every time,
 *    whether it was hand-picked or swept in by "every eligible USB device".
 *    A running job or any other server-side refusal still reaches the
 *    Failed section — this dialog does not try to predict those.
 * 3. **This dialog reports ARMING, not the whole journey.** Each
 *    `POST .../connection/cutover` already waits, server-side, for TCP mode
 *    to be enabled AND verified by read-back (`cutover.ts`'s own "refuses to
 *    arm on a failed read-back" rule) before it returns — so "armed" here is
 *    a real, confirmed state, not a guess. What happens next (the operator
 *    physically flipping each chassis port, then each phone answering on the
 *    network) is exactly what the singular wizard's own `armed`/`connecting`
 *    screens watch via `device.cutover` broadcasts — and that watching
 *    already happens per device, on that device's own tile/badge and its own
 *    popup, the moment this dialog closes. Duplicating a live N-way poll of
 *    `device.cutover` inside this dialog (or registering it with plan 107's
 *    operation tray, which is built for jobs/batches/command runs/transfers
 *    that already have a durable server-side record — an in-memory,
 *    non-persisted `CutoverManager` session is not that shape) would be a
 *    second, parallel progress surface disagreeing with the first the moment
 *    either one lagged. There is also, deliberately, no "cancel all pending"
 *    button here: once this dialog reports and closes, each device's own
 *    popup already carries a working, idempotent Cancel
 *    (`DELETE .../connection/cutover`) — building a second, farm-wide cancel
 *    path for a dialog that itself no longer holds any state past submit
 *    would be new surface for a case the existing one-at-a-time control
 *    already covers.
 */
export function BulkCutoverDialog({
  open,
  onOpenChange,
  devices,
  allDevices,
  onDone,
  nonModal = false,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The pre-filled default target — still fully editable through the picker below. */
  devices: DeviceInfo[]
  /** The whole pool `TargetPicker`'s Multiple devices mode can choose from. Defaults to `devices` for a caller not yet updated to pass the whole fleet. */
  allDevices?: DeviceInfo[]
  /** Called once at least one device armed successfully — the caller reloads the fleet (badges are about to start changing). */
  onDone?: () => void
  nonModal?: boolean
}) {
  const pool = allDevices ?? devices
  const [medium, setMedium] = useState<ConnectionMedium>('wired')
  const [port, setPort] = useState('')
  const [busy, setBusy] = useState(false)
  const [report, setReport] = useState<{ counts: OutcomeCounts; failed: NamedOutcome[]; skipped: NamedOutcome[] } | null>(null)
  const targetSelection = useTargetSelection({
    // See `InstallBatchDialog`'s identical comment — `Infinity` for a caller
    // that has not been updated to pass `allDevices`.
    usableCount: allDevices ? allDevices.length : Number.POSITIVE_INFINITY,
  })
  const { target, deviceId, deviceIds, resolvedCount, hasTarget, fleetConfirmed } = targetSelection

  useEffect(() => {
    if (!open) {
      setReport(null)
      return
    }
    setMedium('wired')
    setPort('')
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

    const eligible = targetDevices.filter((d) => isUsb(d) && d.status !== 'offline')
    const skipped: NamedOutcome[] = targetDevices
      .filter((d) => !isUsb(d))
      .map((d) => ({ deviceId: d.id, label: d.label, reason: 'Already on the network — this wizard is for the USB→network move itself.' }))
    skipped.push(
      ...targetDevices
        .filter((d) => isUsb(d) && d.status === 'offline')
        .map((d) => ({ deviceId: d.id, label: d.label, reason: 'Offline — connect it over USB before moving it to the network.' })),
    )

    const parsedPort = Number(port)
    const body: { medium: ConnectionMedium; port?: number } = { medium }
    if (port.trim() && Number.isFinite(parsedPort) && parsedPort > 0) body.port = Math.round(parsedPort)

    const failed: NamedOutcome[] = []
    let ok = 0
    await Promise.all(
      eligible.map(async (d) => {
        try {
          const res = await api(`/api/devices/${d.id}/connection/cutover`, CutoverResponseSchema, { method: 'POST', json: body })
          if (res.cutover.step === 'failed') failed.push({ deviceId: d.id, label: d.label, reason: res.cutover.detail })
          else ok += 1
        } catch (err) {
          failed.push({ deviceId: d.id, label: d.label, reason: describeApiError(err) })
        }
      }),
    )

    setBusy(false)
    setReport({ counts: { ok, failed: failed.length, skipped: skipped.length, total: targetDevices.length }, failed, skipped })
    if (ok > 0) onDone?.()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} modal={!nonModal}>
      <DialogContent overlay={!nonModal}>
        <DialogHeader>
          <DialogTitle>
            Move {resolvedCount} device{resolvedCount === 1 ? '' : 's'} to the network
          </DialogTitle>
          <DialogDescription>
            Enables TCP mode on every targeted USB device, verified by read-back, then arms each one to watch for it on
            the network once you flip its chassis port. A device already on the network is skipped and named below,
            never sent a request.
          </DialogDescription>
        </DialogHeader>

        {!report ? (
          <div className="space-y-3.5">
            <TargetPicker selection={targetSelection} devices={pool} allow={TARGET_ALLOW} />

            <div className="grid grid-cols-2 gap-2.5">
              <div className="space-y-1.5">
                <Label htmlFor="bulk-cutover-port" className="text-[12px] font-normal">
                  Port
                </Label>
                <Input
                  id="bulk-cutover-port"
                  value={port}
                  onChange={(e) => setPort(e.target.value)}
                  placeholder="5555 (default)"
                  className="readout h-8"
                  inputMode="numeric"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-[12px] font-normal">Medium</Label>
                <Select value={medium} onValueChange={(v) => setMedium(v as ConnectionMedium)}>
                  <SelectTrigger className="h-8 text-[12.5px]" aria-label="Medium">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="wired">Wired (OTG)</SelectItem>
                    <SelectItem value="wireless">Wi-Fi</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <p className="text-[11px] leading-relaxed text-fg-subtle">
              One port applies to every device — each phone listens for adb on its own local network stack, so many
              phones can share the same port with no conflict. There is no address field here: unlike the single-device
              wizard, each phone would need a different address, so this only finds them through a configured farm
              network scan (Settings → Discovery &amp; monitoring).
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            <OutcomeSummary counts={report.counts} label="Arming progress" />
            <SkippedGroups failed={report.failed} skipped={report.skipped} />
            {report.counts.ok > 0 && (
              <p className="text-[11.5px] text-fg-subtle">
                {report.counts.ok} device{report.counts.ok === 1 ? '' : 's'} armed — flip each one's chassis port from
                USB to OTG now. Watch each device's own badge or popup for when it connects; there is nothing further
                to do here.
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          {!report ? (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
                Cancel
              </Button>
              <Button onClick={() => void run()} disabled={busy || !hasTarget || !fleetConfirmed}>
                {busy ? 'Arming…' : `Arm ${resolvedCount} device${resolvedCount === 1 ? '' : 's'}`}
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
