'use client'

import { Lock, RotateCcw, RotateCw, Smartphone, TabletSmartphone } from 'lucide-react'
import { toast } from 'sonner'
import { DeviceResponseSchema, type RotationApplyResult, type RotationMode } from '@enkaku/protocol'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  api,
  useAction,
} from '@enkaku/ui'

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
 * What the server said it did to the LIVE screen, in one line each. The four
 * states are genuinely different outcomes and the toast has to say which —
 * before `rotation` existed on this response, every one of them produced the
 * same "Rotation set to …" success message, which is how an operator came to
 * report a working feature as broken: they were being told a database write
 * had succeeded, and reading it as "the screen locked".
 */
function describeOutcome(result: RotationApplyResult | undefined, mode: RotationMode): { ok: boolean; message: string; description?: string } {
  if (mode === 'device') {
    return {
      ok: true,
      message: 'Rotation handed back to the device',
      description: result?.state === 'applied' ? 'The live screen is back on the device’s own auto-rotate setting.' : undefined,
    }
  }
  switch (result?.state) {
    case 'applied':
      return { ok: true, message: `${SHORT_LABEL[mode]} — applied to the live screen` }
    case 'busy':
      return { ok: true, message: `${SHORT_LABEL[mode]} — saved`, description: result.reason ?? 'A job is running; it applies to the next session.' }
    case 'failed':
      return { ok: false, message: `${SHORT_LABEL[mode]} — the device did not accept it`, description: result.reason }
    default:
      // `no-session`, and any core too old to send this field at all.
      return { ok: true, message: `${SHORT_LABEL[mode]} — saved`, description: 'Applies the next time this device streams.' }
  }
}

/**
 * A fast way to change `DeviceSettings.prep.rotation` from the Control tab
 * (plan 85 §3.7, §4.1, step 85.8) without a trip to the Settings tab. This is
 * a SHORTCUT to that one setting, not a second source of truth for it — it
 * reads and writes the exact same `settings.prep.rotation` field the
 * Settings tab's schema-driven form does, so a change from either place
 * shows up in the other.
 *
 * Takes effect on the session that is running RIGHT NOW, as well as on every
 * session afterwards: `PATCH /api/devices/:id` calls
 * `SessionManager.setRotation` when this value changes, and reports back in
 * `rotation` whether the live screen actually re-locked. It used to be
 * apply-once at session creation — a wall tile that had been up for hours had
 * no "next session" to wait for, so changing this did nothing and the toast
 * said it had worked anyway.
 */
export function RotationQuickAction({
  deviceId,
  settings,
  onSaved,
  iconOnly = false,
}: {
  deviceId: string
  /** `DeviceDetailInfo.settings` — `unknown` at this layer, same as every other reader of it on this page. */
  settings: unknown
  onSaved: (settings: unknown) => void
  /**
   * Drops `SHORT_LABEL` from the trigger and keeps only the icon (plan 103's
   * layout restructure, owner-reported: a text-bearing button was the one
   * child in `HardwareRail`'s icon-only column with no explicit width, so it
   * stretched the whole rail to its own width). `false` by default — the
   * device page's Control tab and every other existing caller renders
   * exactly as it always has and needs no edit. The label survives as the
   * `aria-label` (already present either way) and, in icon-only mode, as a
   * `Tooltip` — the same convention `HardwareRail`'s own icon buttons use,
   * so this control does not invent a second one on the same strip.
   */
  iconOnly?: boolean
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
        // No `success` string: this action has four different outcomes and
        // `useAction` can only carry one fixed message. The failure branch
        // below still covers the request itself failing.
        failure: 'Could not change the rotation setting',
        onSuccess: (result) => {
          const outcome = describeOutcome(result.rotation, next)
          const opts = outcome.description ? { description: outcome.description } : undefined
          if (outcome.ok) toast.success(outcome.message, opts)
          else toast.warning(outcome.message, opts)
          onSaved(nextSettings)
        },
      },
    )
  }

  const TriggerIcon = current === 'device' ? RotateCcw : Lock

  const trigger = (
    <DropdownMenuTrigger asChild>
      <Button
        variant="outline"
        size="sm"
        disabled={busy}
        className={iconOnly ? 'h-8 w-10' : 'gap-1.5'}
        aria-label="Screen rotation"
      >
        <TriggerIcon className="size-3.5" aria-hidden />
        {!iconOnly && SHORT_LABEL[current]}
      </Button>
    </DropdownMenuTrigger>
  )

  return (
    <DropdownMenu>
      {iconOnly ? (
        <Tooltip>
          <TooltipTrigger asChild>{trigger}</TooltipTrigger>
          <TooltipContent side="right">Screen rotation — {SHORT_LABEL[current]}</TooltipContent>
        </Tooltip>
      ) : (
        trigger
      )}
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
          Applies to this device only, immediately if it is streaming now. The phone’s own setting is put back when its last
          session closes.
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
