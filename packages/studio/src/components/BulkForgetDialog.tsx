'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { z } from 'zod'
import type { DeviceInfo } from '@enkaku/protocol'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/actions'

interface Outcome {
  ok: boolean
  message?: string
}

/**
 * "Forget selected" (plan 47 §4.5, acceptance #9) — the operation this farm
 * needs today for its four permanently-offline rows (`Test Phone`,
 * `VERIFY123`, two `serial:127.0.0.1:…`). There is no bulk endpoint: each
 * device gets its own `DELETE /api/devices/:id`, exactly like a single
 * Forget, so a busy or connected device among the selection is refused on
 * its own terms and named here rather than silently skipped or blocking
 * the rest.
 */
export function BulkForgetDialog({
  devices,
  open,
  onOpenChange,
  onDone,
}: {
  devices: DeviceInfo[]
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called once at least one device was actually forgotten. */
  onDone: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<Record<string, Outcome> | null>(null)

  useEffect(() => {
    if (!open) setResults(null)
  }, [open])

  const run = async () => {
    setBusy(true)
    const entries = await Promise.all(
      devices.map(async (d): Promise<[string, Outcome]> => {
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Forget {devices.length} device{devices.length === 1 ? '' : 's'}?
          </DialogTitle>
          <DialogDescription>
            Removes each from the fleet — its row, tags, and cluster membership. Jobs, artifacts, and events are kept.
            A device that is busy, has an active manual lease, or is still connected and idle is refused and named
            below, exactly as a single Forget would be — block it instead from its own device page.
          </DialogDescription>
        </DialogHeader>

        <ul className="max-h-64 divide-y overflow-auto rounded-md border text-[12.5px]">
          {devices.map((d) => {
            const r = results?.[d.id]
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

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {results ? 'Close' : 'Cancel'}
          </Button>
          {!results && (
            <Button disabled={busy || devices.length === 0} onClick={() => void run()}>
              {busy ? 'Forgetting…' : 'Forget selected'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
