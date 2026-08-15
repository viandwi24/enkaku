'use client'

import { useEffect, useState } from 'react'
import type { LeaseHolder } from '@enkaku/protocol'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { newId, ws, WsRequestError } from '@/lib/ws'

/**
 * Assist (plan 91 §3.2, §3.6, §3.12) — the confirmation the owner asked for
 * in their own words: *"ketika mau control kasih alert atau warning aja —
 * kalau client bilang yes, berarti control-nya tetap di yang saat ini
 * control, tapi user tetap bisa touch."* This is a WARNING the operator
 * acknowledges, never a permission request, a takeover, or a request to
 * queue for the lease — confirming here does not move `heldBy`, does not
 * touch `DeviceStatus`, and does not pause or cancel anything (§3.2's own
 * table). It is modelled on `TakeControlDialog` (same dialog primitives,
 * same busy/error/footer shape), but the copy is deliberately different in
 * kind: `TakeControlDialog` interrupts; this one explicitly does not.
 *
 * §3.12 requires naming BOTH the thing at stake (the running script) and how
 * long the operator's own grant lasts — an operator must know what they are
 * interrupting and for how long their own grant lasts, so both `primary`
 * and `grantTtlSec` are required props, not optional niceties.
 */
export function AssistDialog({
  deviceId,
  deviceLabel,
  primary,
  grantTtlSec,
  open,
  onOpenChange,
  onAssisted,
}: {
  deviceId: string
  deviceLabel: string
  /** Whoever currently holds the device — named so the operator knows exactly what they are reaching into (§3.12). Almost always `kind: 'job'` (Assist is offered from the busy/job banner, `ScreenCard`'s own gate) but the copy still reads honestly for a manually-held device, since `assist.start` itself never requires a job specifically (`co-control.ts`'s `grant()`). */
  primary: LeaseHolder
  /** `coControl.grantTtlSec` (the farm setting) — named in the copy per §3.12 ("Assisting stops on its own after N minutes without input"). */
  grantTtlSec: number
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called once the grant actually exists, with its expiry (ms epoch, matching every other lease-adjacent countdown on this page) and the primary holder the server resolved it against. */
  onAssisted: (expiresAtMs: number, primary: LeaseHolder) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setBusy(false)
    setError(null)
  }, [open, deviceId])

  const confirm = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await ws.request({ type: 'assist.start', id: newId(), payload: { deviceId } })
      if (res.type === 'assist.started') {
        onOpenChange(false)
        onAssisted(res.payload.expiresAt * 1000, res.payload.primary)
      }
    } catch (err) {
      // `assist.start`'s own refusal codes (`assist_not_allowed` /
      // `assist_taken` / `assist_denied_by_script` / `device_not_held`,
      // §4.2) all arrive as a `WsRequestError` with a human `.message` —
      // shown verbatim, the same as `TakeControlDialog`'s own catch branch.
      setError(err instanceof WsRequestError ? err.message : err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const isJob = primary.kind === 'job'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Assist {deviceLabel} while {isJob ? 'its job' : primary.label} keeps control?</DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-2.5">
              <p>
                <span className="readout font-medium text-fg">{primary.label}</span>{' '}
                {isJob ? 'is running on this device and keeps control of it.' : 'is using this device now and keeps control of it.'}{' '}
                Assisting lets you tap, swipe, type and press keys on the same screen at the same time
                {isJob ? ' as the job' : ''}.
              </p>
              <p>
                {isJob
                  ? "The job is not paused and is not cancelled. Everything you do is recorded on the job's record, so its result can be read honestly afterwards."
                  : `${primary.label} keeps control the whole time — assisting never takes it from them.`}
              </p>
              <p>Assisting stops on its own after {humanTtl(grantTtlSec)} without input.</p>
            </div>
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div className="rounded-md border border-led-danger/40 bg-led-danger/5 p-3 text-[12.5px] text-led-danger">{error}</div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={() => void confirm()}>
            {busy ? 'Assisting…' : 'Assist'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * "5 minutes" for a round number of minutes — matches §3.12's own copy
 * example verbatim for the shipped default (`grantTtlSec: 300`) — else
 * `Xm Ys` / `Ns` for a farm that changed the setting to something that does
 * not divide evenly. Exported for its own unit test.
 */
export function humanTtl(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`
  if (seconds % 60 === 0) {
    const m = seconds / 60
    return `${m} minute${m === 1 ? '' : 's'}`
  }
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}
