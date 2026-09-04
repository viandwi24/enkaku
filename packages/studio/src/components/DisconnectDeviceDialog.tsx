'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { DisconnectOutcomeSchema, E_DEVICE_CONFLICT, type DeviceInfo } from '@enkaku/protocol'
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, formatDeviceName } from '@enkaku/ui'
import { ActionRefusedError, runOnDevice } from '@/lib/actions'

/**
 * Disconnect a device from the network (plan 88 §3.7, §3.8, §4.6, §5 step
 * 88.4) — drops its adb link; the phone keeps running and stays in the
 * farm. `DeviceHeader`/`DeviceCard` only ever open this for a `tcp` device
 * (the Connection menu's Disconnect item is disabled-with-a-reason on USB,
 * §4.6's `E_TRANSPORT_NOT_DETACHABLE`), so there is no USB branch here.
 *
 * The copy states both halves plainly (§3.8's own confirm text, near-
 * verbatim) because "Disconnect" and "Remove" sound alike and mean very
 * different things: Remove is Forget/Block, which un-enrols the device.
 * This is not that — its record, tags, group, settings, job history and
 * artifacts are untouched.
 *
 * A running-job refusal (`E_DEVICE_CONFLICT`, plan 207 §4.2/§4.4) shows the server's own
 * message — which already names the job(s) — and offers a `force` checkbox
 * to disconnect anyway, the same refusal-then-offer-the-override shape
 * `AdbRestartDialog` already uses for its own busy-farm guard.
 */
export function DisconnectDeviceDialog({
  device,
  open,
  onOpenChange,
  onDone,
  nonModal = false,
}: {
  device: DeviceInfo | null
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called after a disconnect actually goes through (any of its outcomes) — the caller reloads the list. */
  onDone: () => void
  /** Plan 103 §3.2, §5 step 103.1 — the device popup's non-modal path: when true, renders without its own overlay so it can sit inside the popup's own layer instead of fighting it for focus. */
  nonModal?: boolean
}) {
  const [refusal, setRefusal] = useState<{ code: string; message: string } | null>(null)
  const [force, setForce] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) {
      setRefusal(null)
      setForce(false)
    }
  }, [open])

  if (!device) return null

  // Plan 124 §4.4, step 124.3 — one composed name for the title and all three
  // outcome toasts. Disconnect is the action an operator fires at one phone
  // out of a rack of identical ones, so `Disconnect SM-F721U1 from the
  // network?` was precisely the wrong question to be asked.
  const name = formatDeviceName(device.number, device.label)

  const address = device.connection.address
    ? device.connection.port
      ? `${device.connection.address}:${device.connection.port}`
      : device.connection.address
    : null

  const disconnect = async () => {
    setBusy(true)
    setRefusal(null)
    try {
      const r = await runOnDevice('disconnect', device.id, {}, { force })
      const outcome = DisconnectOutcomeSchema.parse(r.detail)
      if (outcome.result === 'disconnected') {
        toast.success(`${name} disconnected from the network`)
      } else if (outcome.result === 'not-connected') {
        toast.success(`${name} was already offline`)
      } else {
        toast.error(`Could not disconnect ${name}`, { description: outcome.detail })
      }
      onOpenChange(false)
      onDone()
    } catch (err) {
      if (err instanceof ActionRefusedError) {
        // `disconnect`'s own job-running conflict answers `forbidden` with
        // `E_DEVICE_CONFLICT` (`run.ts`'s `dispatchSyncVerb`), not the old
        // route's `job_running` — this is the same warn-then-force shape,
        // named differently.
        setRefusal({ code: err.code, message: err.message })
      } else {
        toast.error('Could not disconnect the device', { description: err instanceof Error ? err.message : String(err) })
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} modal={!nonModal}>
      <DialogContent overlay={!nonModal}>
        <DialogHeader>
          <DialogTitle>Disconnect {name} from the network?</DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-2 text-[13px] leading-relaxed text-fg-muted">
              <p>Enkaku drops its adb connection. The phone keeps running.</p>
              <p>
                <strong className="text-fg">Unchanged:</strong> its record, tags, group, settings, job history and
                artifacts. This is not Remove.
              </p>
              <p>
                <strong className="text-fg">Until you reconnect it:</strong> it shows as Offline, and it cannot be
                controlled or scheduled.
              </p>
              {address && (
                <p>
                  It reconnects from <code className="readout">{address}</code>, its last known address.
                </p>
              )}
            </div>
          </DialogDescription>
        </DialogHeader>

        {refusal && (
          <div className="rounded-md border border-led-danger/40 bg-led-danger/5 p-3 text-[12.5px]">
            <p className="text-led-danger">{refusal.message}</p>
            {refusal.code === E_DEVICE_CONFLICT && (
              <label className="mt-2.5 flex items-start gap-2 text-[12.5px] text-fg">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={force}
                  onChange={(e) => setForce(e.target.checked)}
                  aria-label="Disconnect anyway, despite the running job"
                />
                <span>Disconnect anyway — this fails the running job.</span>
              </label>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button disabled={busy || (refusal?.code === 'job_running' && !force)} onClick={() => void disconnect()}>
            {busy ? 'Disconnecting…' : 'Disconnect'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
