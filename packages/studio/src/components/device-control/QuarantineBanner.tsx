'use client'

import { useState } from 'react'
import type { DeviceDetail } from '@enkaku/protocol'
import { Button, WarningIcon } from '@enkaku/ui'
import { toast } from 'sonner'
import { runOnDevice } from '@/lib/actions'
import { explainQuarantine } from '@/lib/quarantine'

/**
 * Why this device is out of the pool, and the button that puts it back.
 *
 * The same `unquarantine` verb as the Actions tab's row, but called here
 * rather than through the dialog host: Device Control reads the device ONCE
 * when it opens, so a release that did not refetch would leave this banner
 * standing over a phone that is already back at work.
 *
 * Not gated on role in the browser — local mode has no user object to read,
 * and the server refuses a viewer without `device.quarantine` anyway, which
 * the toast then says.
 */
export function QuarantineBanner({ device, onReleased }: { device: DeviceDetail; onReleased: () => void }) {
  const [busy, setBusy] = useState(false)
  if (device.status !== 'quarantined') return null

  const reason = device.quarantineReason ? explainQuarantine(device.quarantineReason, device.battery?.temperatureC ?? null) : 'no reason recorded'

  const release = () => {
    setBusy(true)
    void runOnDevice('unquarantine', device.id, {})
      .then(() => {
        toast.success(`${device.label} is back from quarantine`)
        onReleased()
      })
      .catch((e: unknown) => toast.error(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false))
  }

  return (
    <div className="mx-3 mt-2 flex flex-col gap-2 rounded-button bg-warn-soft px-2.5 py-2 text-meta text-warn">
      <div className="flex items-start gap-2">
        <WarningIcon className="mt-px size-4 shrink-0" aria-hidden />
        <span>
          <b>Quarantined</b> · {reason}
        </span>
      </div>
      <Button size="sm" variant="outline" disabled={busy} onClick={release}>
        {busy ? 'Returning…' : 'Return from quarantine'}
      </Button>
    </div>
  )
}
