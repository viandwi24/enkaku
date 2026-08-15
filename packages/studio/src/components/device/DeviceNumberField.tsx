'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { z } from 'zod'
import { DeviceResponseSchema } from '@enkaku/protocol'
import type { DeviceDetailInfo } from '@/components/device/DeviceHeader'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api, describeApiError } from '@/lib/actions'

/**
 * The device's short operator-facing number (plan 89 §3.1-§3.3, step 89.3).
 *
 * Deliberately hand-authored, not schema-driven: `number` lives in its own
 * `device_numbers` table keyed by `stableId` (§4.1), not on
 * `DeviceSettingsSchema`, so it can never appear in `deviceSections`'s
 * derived key list — there is no schema node for `narrowSchema` to find.
 *
 * A manual set is refused, never resolved, on a collision: `PATCH
 * /api/devices/:id` with `{ number }` throws 409 `E_NUMBER_TAKEN` naming the
 * device that already holds it (§4.2). That message is shown INLINE, next
 * to the field — a toast that disappears is not enough for a number an
 * operator is trying to match to a physical sticker.
 *
 * Release (`DELETE /api/devices/numbers/:stableId`) is the only thing that
 * frees a number (§3.2) — Forget and Block do not. It is idempotent, so a
 * second click after a dropped response is harmless.
 */
export function DeviceNumberField({
  device,
  onSaved,
}: {
  device: DeviceDetailInfo
  /** The number changed — patched into the caller's own `device` state, mirroring `reloadDevice`'s existing shape. */
  onSaved: (patch: { number: number | null }) => void
}) {
  // `?? null` guards a hand-built test fixture that omits the field
  // (undefined) — a real `DeviceDetailResponseSchema` parse always fills it.
  const currentNumber = device.number ?? null
  const savedValue = currentNumber !== null ? String(currentNumber) : ''
  const [draft, setDraft] = useState(savedValue)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'save' | 'release' | null>(null)

  const dirty = draft !== savedValue
  const trimmed = draft.trim()
  const parsedValue = trimmed === '' ? null : Number(trimmed)
  const invalid = trimmed !== '' && (!Number.isInteger(parsedValue) || (parsedValue as number) <= 0)

  const save = async () => {
    if (invalid || parsedValue === null || !dirty) return
    setBusy('save')
    setError(null)
    try {
      const res = await api(`/api/devices/${device.id}`, DeviceResponseSchema, {
        method: 'PATCH',
        json: { number: parsedValue },
      })
      onSaved({ number: res.device.number })
      toast.success(`Set to #${parsedValue}`)
    } catch (err) {
      setError(describeApiError(err))
    } finally {
      setBusy(null)
    }
  }

  const release = async () => {
    setBusy('release')
    setError(null)
    try {
      await api(`/api/devices/numbers/${encodeURIComponent(device.stableId)}`, z.object({ ok: z.boolean() }), {
        method: 'DELETE',
      })
      onSaved({ number: null })
      setDraft('')
      toast.success('Number released')
    } catch (err) {
      setError(describeApiError(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-1.5 rounded-lg border p-3">
      <Label htmlFor="device-number" className="text-[13px] font-normal">
        Number
      </Label>
      <p className="text-[11.5px] text-fg-subtle">
        The short number this device shows on a rack. It survives Forget and re-admission — it is a reservation on
        the hardware, not on this row — and is released only by the action below.
      </p>
      <div className="flex items-center gap-2">
        <span className="readout text-[13px] text-fg-subtle" aria-hidden="true">
          #
        </span>
        <Input
          id="device-number"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value)
            setError(null)
          }}
          placeholder="none"
          inputMode="numeric"
          aria-label="Device number"
          className="readout h-8 w-24 text-[12.5px]"
        />
        <Button size="sm" disabled={!dirty || invalid || busy !== null} onClick={() => void save()}>
          {busy === 'save' ? 'Saving…' : 'Save'}
        </Button>
        {currentNumber !== null && (
          <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void release()}>
            {busy === 'release' ? 'Releasing…' : 'Release number'}
          </Button>
        )}
      </div>
      {invalid && <p className="text-[10.5px] text-led-danger">Must be a positive whole number.</p>}
      {error && <p className="text-[10.5px] text-led-danger">{error}</p>}
    </div>
  )
}
