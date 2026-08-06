'use client'

import { useEffect, useState } from 'react'
import { DeviceHistoryCountsResponseSchema, type DeviceInfo } from '@enkaku/protocol'
import { z } from 'zod'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { api, type ApiError } from '@/lib/actions'
import { toast } from 'sonner'

interface HistoryCounts {
  jobs: number
  artifacts: number
  events: number
}

function isApiError(err: unknown): err is Error & ApiError {
  return err instanceof Error && 'code' in err
}

/**
 * Forget a device (plan 47 §3.2, §4.5): states plainly what is removed (the
 * row, its tags, its cluster membership) and what is kept (jobs, artifacts,
 * events — unless "also delete history" is ticked, which shows the exact
 * counts before its own confirm enables, per §3.4).
 *
 * A refusal (§3.5 — busy, an active manual lease, still connected) shows the
 * server's own reason rather than a generic failure, and for the "still
 * connected" case offers Block instead in the same dialog, since that
 * refusal IS the intended next step, not a dead end.
 */
export function ForgetDeviceDialog({
  device,
  open,
  onOpenChange,
  onDone,
}: {
  device: DeviceInfo | null
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called after a successful Forget OR Block — either way the device just left the fleet. */
  onDone: () => void
}) {
  const [deleteHistory, setDeleteHistory] = useState(false)
  const [counts, setCounts] = useState<HistoryCounts | null>(null)
  const [countsLoading, setCountsLoading] = useState(false)
  const [refusal, setRefusal] = useState<{ code: string; message: string } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) {
      setDeleteHistory(false)
      setCounts(null)
      setRefusal(null)
    }
  }, [open])

  useEffect(() => {
    if (!open || !device || !deleteHistory) return
    setCountsLoading(true)
    setCounts(null)
    void api(`/api/devices/${device.id}/history-counts`, DeviceHistoryCountsResponseSchema)
      .then((b) => setCounts(b.counts))
      .catch(() => setCounts(null))
      .finally(() => setCountsLoading(false))
  }, [open, device, deleteHistory])

  if (!device) return null

  // The confirm button stays disabled until the promised counts are actually
  // on screen (plan 47 §3.4, §6.6) — nobody should discover that number
  // afterwards.
  const confirmDisabled = busy || (deleteHistory && (countsLoading || !counts))

  const forget = async () => {
    setRefusal(null)
    setBusy(true)
    try {
      // `DELETE /:id` returns `{ forgotten: {...} }` (`packages/core/src/api/devices.ts`) — no
      // envelope for that exists in `@enkaku/protocol` yet, and this call site never reads the
      // body (only success/failure matters here), so a permissive ad-hoc "some object came back"
      // schema rather than a new export for a value nothing reads.
      await api(`/api/devices/${device.id}?deleteHistory=${deleteHistory}`, z.object({}).passthrough(), { method: 'DELETE' })
      toast.success(`${device.label} forgotten`)
      onOpenChange(false)
      onDone()
    } catch (err) {
      if (isApiError(err)) {
        setRefusal({ code: err.code, message: err.message })
      } else {
        toast.error('Could not forget the device', { description: err instanceof Error ? err.message : String(err) })
      }
    } finally {
      setBusy(false)
    }
  }

  const blockInstead = async () => {
    setBusy(true)
    try {
      // Same reasoning as the DELETE above: `POST /:id/block` returns `{ blocked: {...} }`, unread here.
      await api(`/api/devices/${device.id}/block`, z.object({}).passthrough(), { method: 'POST', json: {} })
      toast.success(`${device.label} blocked`)
      onOpenChange(false)
      onDone()
    } catch (err) {
      toast.error('Could not block the device', { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Forget {device.label}?</DialogTitle>
          <DialogDescription>
            Removes it from the fleet: the device row, its tags, and its cluster membership. Its jobs, artifacts, and
            events are kept — they still show up wherever they already do, labelled as a deleted device.
          </DialogDescription>
        </DialogHeader>

        {refusal ? (
          <div className="rounded-md border border-led-danger/40 bg-led-danger/5 p-3 text-[12.5px]">
            <p className="text-led-danger">{refusal.message}</p>
            {refusal.code === 'device_online' && (
              <Button variant="outline" size="sm" className="mt-2.5" disabled={busy} onClick={() => void blockInstead()}>
                {busy ? 'Blocking…' : 'Block instead'}
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <label className="flex items-center justify-between gap-3 rounded-md border p-3 text-[12.5px]">
              <span>
                <span className="block font-medium">Also delete history</span>
                <span className="text-fg-muted">Permanently deletes its jobs, artifacts, and events too.</span>
              </span>
              <Switch checked={deleteHistory} onCheckedChange={setDeleteHistory} aria-label="Also delete history" />
            </label>

            {deleteHistory && (
              <div className="rounded-md border border-led-warn/40 bg-led-warn/5 p-3 text-[12.5px]">
                {countsLoading || !counts ? (
                  <p className="text-fg-muted">Counting what would be deleted…</p>
                ) : (
                  <p>
                    This deletes <span className="font-medium">{counts.jobs}</span> job{counts.jobs === 1 ? '' : 's'},{' '}
                    <span className="font-medium">{counts.artifacts}</span> artifact{counts.artifacts === 1 ? '' : 's'}, and{' '}
                    <span className="font-medium">{counts.events}</span> event{counts.events === 1 ? '' : 's'}. This cannot be
                    undone.
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          {!refusal && (
            <Button
              className={deleteHistory ? 'bg-led-danger text-white hover:bg-led-danger/90' : undefined}
              disabled={confirmDisabled}
              onClick={() => void forget()}
            >
              {busy ? 'Forgetting…' : deleteHistory ? 'Forget and delete history' : 'Forget'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
