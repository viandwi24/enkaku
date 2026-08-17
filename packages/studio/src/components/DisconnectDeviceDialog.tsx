'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { DisconnectOutcomeSchema, type DeviceInfo } from '@enkaku/protocol'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { api, type ApiError } from '@/lib/actions'

function isApiError(err: unknown): err is Error & ApiError {
  return err instanceof Error && 'code' in err
}

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
 * This is not that — its record, tags, cluster, settings, job history and
 * artifacts are untouched.
 *
 * A running-job refusal (`job_running`, §4.6) shows the server's own
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
  /** Plan 103 §3.2, §5 step 103.1 — the device popup's non-modal path; see `AssistDialog`'s own doc comment on the same prop for why. */
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

  const address = device.connection.address
    ? device.connection.port
      ? `${device.connection.address}:${device.connection.port}`
      : device.connection.address
    : null

  const disconnect = async () => {
    setBusy(true)
    setRefusal(null)
    try {
      const outcome = await api(`/api/devices/${device.id}/connection/disconnect`, DisconnectOutcomeSchema, {
        method: 'POST',
        json: { force },
      })
      if (outcome.result === 'disconnected') {
        toast.success(`${device.label} disconnected from the network`)
      } else if (outcome.result === 'not-connected') {
        toast.success(`${device.label} was already offline`)
      } else {
        toast.error(`Could not disconnect ${device.label}`, { description: outcome.detail })
      }
      onOpenChange(false)
      onDone()
    } catch (err) {
      if (isApiError(err)) {
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
          <DialogTitle>Disconnect {device.label} from the network?</DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-2 text-[13px] leading-relaxed text-fg-muted">
              <p>Enkaku drops its adb connection. The phone keeps running.</p>
              <p>
                <strong className="text-fg">Unchanged:</strong> its record, tags, cluster, settings, job history and
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
            {refusal.code === 'job_running' && (
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
