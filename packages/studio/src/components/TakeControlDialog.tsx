'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import type { LeaseHolder } from '@enkaku/protocol'
import { DeviceDetailResponseSchema, RunResponseSchema, ThreadResponseSchema } from '@enkaku/protocol'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/actions'
import { newId, ws, WsRequestError } from '@/lib/ws'

/**
 * Take control from whoever holds it now (plan 71 §3.4, §3.6) — a
 * deliberate, two-step confirmation that states the CONSEQUENCE rather than
 * asking a bare question, never a bare `force: true`: `takeOverFrom` names
 * the holder this dialog was drawn against, so a stale confirmation cannot
 * displace a third party who acquired the device in the meantime — the
 * server refuses that with `lease_holder_changed` and this dialog re-asks
 * rather than failing (criterion 8).
 *
 * A job's hold never reaches this dialog with an enabled button — the
 * caller (`DeviceHeader`) disables it instead — but this still renders the
 * job case honestly if it is ever opened, naming the job and its script
 * with a link to it and to cancel it, exactly like the disabled button's
 * own tooltip.
 */
export function TakeControlDialog({
  deviceId,
  deviceLabel,
  holder,
  open,
  onOpenChange,
  onTaken,
}: {
  deviceId: string
  deviceLabel: string
  /** The holder this dialog believes is current — may go stale while the dialog is open. */
  holder: LeaseHolder
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called once the takeover actually succeeds, with the new lease's expiry. */
  onTaken: (expiresAt: number) => void
}) {
  const [current, setCurrent] = useState(holder)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [staleNotice, setStaleNotice] = useState<string | null>(null)
  const [runTitle, setRunTitle] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setCurrent(holder)
    setError(null)
    setStaleNotice(null)
    setBusy(false)
    setRunTitle(null)
    if (holder.kind === 'agent' && holder.runId) {
      // Best-effort — names WHAT the agent is running, not only who it is
      // (§3.6's own example text). A failure here is silent: the dialog
      // still works with the generic "is using this device now" phrasing.
      void api(`/api/v1/runs/${holder.runId}`, RunResponseSchema)
        .then((b) => api(`/api/v1/threads/${b.run.threadId}`, ThreadResponseSchema))
        .then((b) => setRunTitle(b.thread.title))
        .catch(() => undefined)
    }
  }, [open, holder])

  const takeOver = async () => {
    setBusy(true)
    setError(null)
    setStaleNotice(null)
    try {
      const res = await ws.request({ type: 'lease.acquire', id: newId(), payload: { deviceId, takeOverFrom: current.id } })
      if (res.type === 'lease.acquired') {
        onOpenChange(false)
        onTaken(res.payload.expiresAt)
      }
    } catch (err) {
      if (err instanceof WsRequestError && err.code === 'lease_holder_changed') {
        // The honest response to "someone else got there first" is to show
        // who (plan 71 §4.5) — re-read the device and re-ask, not fail.
        setStaleNotice('Someone else took control just now — here is who holds it now.')
        try {
          const b = await api(`/api/devices/${deviceId}`, DeviceDetailResponseSchema)
          if (b.device.heldBy) setCurrent(b.device.heldBy)
        } catch {
          // Keep the stale `current` rather than crash the dialog — the
          // re-ask still works, it just names slightly stale info.
        }
      } else {
        setError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      setBusy(false)
    }
  }

  const isJob = current.kind === 'job'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Take control of {deviceLabel} from {current.label}?
          </DialogTitle>
          <DialogDescription>
            {isJob ? (
              <>
                A job cannot be interrupted mid-script — the device is genuinely in use. Wait for it to finish, or cancel it.
              </>
            ) : current.kind === 'agent' ? (
              <>
                {runTitle ? (
                  <>
                    The agent is running <span className="font-medium text-fg">&ldquo;{runTitle}&rdquo;</span> and is using this
                    device now.
                  </>
                ) : (
                  <>The agent is using this device now.</>
                )}{' '}
                Taking control stops its work on this phone; the run continues and will report that it lost the device.
              </>
            ) : (
              <>
                {current.label} is controlling this device now. Taking control will interrupt what they are doing, and any
                gesture in progress may leave the app in an unexpected state.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        {staleNotice && (
          <div className="rounded-md border border-led-warn/40 bg-led-warn/5 p-3 text-[12.5px] text-led-warn">{staleNotice}</div>
        )}
        {error && <div className="rounded-md border border-led-danger/40 bg-led-danger/5 p-3 text-[12.5px] text-led-danger">{error}</div>}

        <DialogFooter>
          {isJob ? (
            <>
              <Button variant="outline" asChild>
                <Link href={`/jobs/detail?id=${encodeURIComponent(current.id)}`}>View job</Link>
              </Button>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Close
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
                Cancel
              </Button>
              {/* Enabled and visible either way (plan 71 §3.6) — the current
                  disabled button was the actual defect: it presented an
                  operator's own phone as unavailable to them. */}
              <Button className="bg-led-danger text-white hover:bg-led-danger/90" disabled={busy} onClick={() => void takeOver()}>
                {busy ? 'Taking control…' : `Take control from ${current.label}`}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
