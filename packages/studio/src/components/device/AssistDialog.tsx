'use client'

import { useEffect, useState } from 'react'
import type { LeaseHolder } from '@enkaku/protocol'
import { humanTtl } from '@/components/device-popup/ControlState'
import { SingleDeviceNotice } from '@/components/target/TargetPicker'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Button } from '@enkaku/ui'
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
  nonModal = false,
}: {
  deviceId: string
  /**
   * The device's ALREADY-COMPOSED operator-facing name — `#7 Galaxy A15`, or
   * the bare label for a device with no number.
   *
   * Plan 124 §4.4, step 124.3 — this prop is deliberately NOT widened into a
   * `{ number, label }` object or a `DeviceInfo`. Every caller
   * (`DeviceHeader`, `DevicePopup`, `ActionsList`, `DeviceContextMenu`) holds
   * the whole device already and passes `formatDeviceName(...)`, so widening
   * would move the same composition into four call sites instead of removing
   * it from any. The rule that matters here is the other half: **nothing in
   * this file may re-compose or decorate the value** — every mention below
   * renders it verbatim, or the number arrives twice.
   */
  deviceLabel: string
  /** Whoever currently holds the device — named so the operator knows exactly what they are reaching into (§3.12). Almost always `kind: 'job'` (Assist is offered from the busy/job banner, `ScreenCard`'s own gate) but the copy still reads honestly for a manually-held device, since `assist.start` itself never requires a job specifically (`co-control.ts`'s `grant()`). */
  primary: LeaseHolder
  /** `coControl.grantTtlSec` (the farm setting) — named in the copy per §3.12 ("Assisting stops on its own after N minutes without input"). */
  grantTtlSec: number
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called once the grant actually exists, with its expiry (ms epoch, matching every other lease-adjacent countdown on this page) and the primary holder the server resolved it against. */
  onAssisted: (expiresAtMs: number, primary: LeaseHolder) => void
  /**
   * The device popup's own path (plan 103 §3.2, §5 step 103.1) — opened over
   * a live phone the operator is watching, so the ordinary modal backdrop
   * (`ui/dialog.tsx`) is wrong here: it would dim and freeze the exact
   * screen Assist exists to keep working on. `false` everywhere else
   * (the device page), which is a real navigation and where a backdrop is
   * correct.
   */
  nonModal?: boolean
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
    <Dialog open={open} onOpenChange={onOpenChange} modal={!nonModal}>
      <DialogContent overlay={!nonModal}>
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

        {/* Plan 104 (M69) §3.4 — a lease is one device by definition (plan
            91 §3.2): stated explicitly rather than omitting a target picker
            and leaving the operator to guess whether a live multi-selection
            on the Wall behind this dialog applied here. */}
        <SingleDeviceNotice deviceLabel={deviceLabel} />

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

// `humanTtl` now lives in `../device-popup/ControlState.tsx` (plan 105 §5
// step 105.1) — re-exported below so `AssistDialog.test.tsx`'s existing
// import (`./AssistDialog`) keeps working unchanged. Moved rather than
// duplicated because `ControlState.tsx`'s `assistEndCopy` needs the exact
// same wording for the `ttl` ending reason (§3.4) — "no component invents
// its own definition" applies to this phrase too, not only to the
// activity/authorization split.
export { humanTtl }
