'use client'

import { Lock, RotateCcw, RotateCw, Smartphone, TabletSmartphone } from 'lucide-react'
import { DeviceResponseSchema, type RotationMode } from '@enkaku/protocol'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { api, useAction } from '@/lib/actions'

const OPTIONS: readonly { value: RotationMode; label: string; icon: typeof Lock }[] = [
  { value: 'device', label: 'Auto-rotate (device default)', icon: RotateCcw },
  { value: 'lock-portrait', label: 'Lock portrait', icon: Smartphone },
  { value: 'lock-landscape', label: 'Lock landscape', icon: TabletSmartphone },
  { value: 'lock-current', label: 'Lock current orientation', icon: RotateCw },
]

const SHORT_LABEL: Record<RotationMode, string> = {
  device: 'Auto-rotate',
  'lock-portrait': 'Locked: portrait',
  'lock-landscape': 'Locked: landscape',
  'lock-current': 'Locked: current',
}

/**
 * A fast way to change `DeviceSettings.prep.rotation` from the Control tab
 * (plan 85 §3.7, §4.1, step 85.8) without a trip to the Settings tab. This is
 * a SHORTCUT to that one setting, not a second source of truth for it — it
 * reads and writes the exact same `settings.prep.rotation` field the
 * Settings tab's schema-driven form does, so a change from either place
 * shows up in the other.
 *
 * Takes effect at the START of the next session, the same as `keepAwake` and
 * `standbyScreenOff` already do: `applyRotation` (`@enkaku/session`) reads
 * this value once, when `createSession` runs, and reverts it when the
 * session closes. Changing it while a session is already live does not
 * re-lock the screen that is currently showing — the footnote below the menu
 * says so, rather than implying an effect that has not actually happened.
 */
export function RotationQuickAction({
  deviceId,
  settings,
  onSaved,
}: {
  deviceId: string
  /** `DeviceDetailInfo.settings` — `unknown` at this layer, same as every other reader of it on this page. */
  settings: unknown
  onSaved: (settings: unknown) => void
}) {
  const { run, isPending } = useAction()
  const current = ((settings as { prep?: { rotation?: RotationMode } } | null)?.prep?.rotation ?? 'device') as RotationMode
  const busy = isPending('rotation')

  const choose = (next: RotationMode) => {
    if (next === current || busy) return
    // A shallow merge, not a rewrite: `settings` is always the FULL,
    // schema-defaulted object (`GET /api/devices/:id` parses it through
    // `DeviceSettingsSchema` before Studio ever sees it), so spreading it and
    // only touching `prep.rotation` leaves every other field — engines,
    // timing, identity, tags-adjacent config — exactly as it was. `PATCH`
    // replaces the whole `settings` column, so sending anything narrower
    // would silently reset the rest to their schema defaults.
    const base = (settings ?? {}) as { prep?: Record<string, unknown> }
    const nextSettings = { ...base, prep: { ...base.prep, rotation: next } }
    void run(
      'rotation',
      () => api(`/api/devices/${deviceId}`, DeviceResponseSchema, { method: 'PATCH', json: { settings: nextSettings } }),
      {
        success: `Rotation set to "${SHORT_LABEL[next]}"`,
        failure: 'Could not change the rotation setting',
        onSuccess: () => onSaved(nextSettings),
      },
    )
  }

  const TriggerIcon = current === 'device' ? RotateCcw : Lock

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" disabled={busy} className="gap-1.5" aria-label="Screen rotation">
          <TriggerIcon className="size-3.5" aria-hidden />
          {SHORT_LABEL[current]}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuRadioGroup value={current} onValueChange={(v) => choose(v as RotationMode)}>
          {OPTIONS.map(({ value, label, icon: Icon }) => (
            <DropdownMenuRadioItem key={value} value={value}>
              <Icon className="size-3.5" aria-hidden />
              {label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <p className="mt-1 border-t px-2 pt-2 text-[11px] leading-relaxed text-fg-muted">
          Applies the next time a session starts on this device — it will not re-lock a screen that is already live.
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
