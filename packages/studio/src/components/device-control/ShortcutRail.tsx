'use client'

import { memo, useMemo, useState } from 'react'
import { chordLabel, DEVICE_CONTROL_HOTKEYS } from '@enkaku/protocol'
import type { RotationMode } from '@enkaku/protocol'
import { Button, Tooltip, TooltipContent, TooltipTrigger, cn } from '@enkaku/ui'
import { cycleBrightnessOn, findDeviceAction, type DeviceActionContext } from '@/lib/device-actions'
import { ClipboardPopover } from './ClipboardPopover'
import type { ClipboardEntry } from './use-cast'

/**
 * The handoff's shortcut rail (README.md:250-253): 52px, 34x34 buttons,
 * `var(--dim)` icons. Every tooltip reads its chord from
 * `DEVICE_CONTROL_HOTKEYS` — never a hand-written string (G7).
 *
 * Every button is a row of `lib/device-actions.ts`, run on EVERY device under
 * control — the host and each mirrored device (owner, 2026-09-15). It used
 * to be split: the keys fanned out, but Sleep, Wake, rotation, brightness and
 * the clipboard's Send reached the host alone, silently, while the window
 * said it was mirroring. The one thing still the host's is the clipboard
 * HISTORY, and its popover says so.
 */
function ShortcutRailImpl({
  deviceId,
  targets,
  rotationMode,
  onSetRotation,
  clipboardHistory,
  onClearClipboardHistory,
  onReadClipboard,
}: {
  deviceId: string
  /** The host first, then every mirrored device. Stable while the set is unchanged, so the memo below still hits. */
  targets: readonly string[]
  /** The HOST's mode, lit on its button; asking for one applies it to every target. */
  rotationMode: RotationMode
  onSetRotation: (mode: RotationMode) => void
  /** Everything the host has copied while this window has been open (`use-cast.ts`). */
  clipboardHistory: ClipboardEntry[]
  onClearClipboardHistory: () => void
  /** Resolves `false` when the device simply had nothing to send — see `use-cast.ts`'s `readDeviceClipboard`. */
  onReadClipboard: () => Promise<boolean>
}) {
  const [brightnessLabel, setBrightnessLabel] = useState<string | null>(null)
  const ctx = useMemo<DeviceActionContext>(() => ({ deviceIds: targets, subjectId: deviceId, surface: 'control' }), [targets, deviceId])
  const reach = targets.length > 1 ? ` · all ${targets.length} devices` : ''

  async function cycleBrightness() {
    const results = await cycleBrightnessOn(targets)
    const host = results?.find((r) => r.deviceId === deviceId)
    const stdout = (host?.detail as { stdout?: string } | undefined)?.stdout?.trim()
    if (stdout) setBrightnessLabel(`Brightness ${stdout} on the host`)
  }

  const RailButton = ({ actionId, hotkeyId, title, onClick, active }: { actionId: string; hotkeyId?: string; title?: string; onClick?: () => void; active?: boolean }) => {
    const action = findDeviceAction(actionId)
    const Icon = action.icon
    const hk = hotkeyId ? DEVICE_CONTROL_HOTKEYS.find((h) => h.id === hotkeyId) : undefined
    const chord = hk ? chordLabel(hk) : undefined
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          {/* `active` is what makes a state button honest: three rotation
              buttons that all look identical cannot tell you which one the
              device is actually in. */}
          <Button
            variant="ghost"
            size="icon-lg"
            className="rounded-[10px] text-dim"
            // `data-active` is the Button's own convention — its base class
            // already carries `data-[active=true]:bg-accent-soft` and
            // `data-[active=true]:text-accent`, so the lit state belongs to
            // the design system rather than to a className written here.
            {...(active ? { 'data-active': 'true' } : {})}
            aria-label={action.label}
            aria-pressed={active}
            onClick={onClick ?? (() => action.run(ctx))}
          >
            <Icon className={cn('size-4', action.iconClassName)} aria-hidden />
          </Button>
        </TooltipTrigger>
        {/*
          The rail is a narrow vertical column pinned to the window's left
          edge, so a tooltip above a button covers the button above it and
          reads as if it belongs to the wrong control. `left` puts it beside
          the rail, in free space, where it never overlaps another button
          (owner, 2026-09-04). `sideOffset` keeps it clear of the icon.
        */}
        <TooltipContent side="left" sideOffset={6}>
          {(title ?? (chord ? `${action.label} · ${chord}` : action.label)) + reach}
        </TooltipContent>
      </Tooltip>
    )
  }

  return (
    <>
      <RailButton actionId="power" hotkeyId="power" />
      {/*
        Explicit, not a toggle. Power flips whatever the screen currently is;
        Sleep and Wake say which state you want and are the pair an operator
        actually reaches for (CEO, 2026-09-05). They are the readiness-aware
        ACTIONS, not raw keyevents — see `lib/device-actions.ts`.
      */}
      <RailButton actionId="sleep" />
      <RailButton actionId="wake" />
      <RailButton actionId="volume-up" />
      <RailButton actionId="volume-down" />
      <RailButton actionId="mute" />
      <RailButton actionId="back" hotkeyId="back" />
      <RailButton actionId="home" hotkeyId="home" />
      <RailButton actionId="recents" hotkeyId="recents" />
      {/*
        Three buttons, not one that cycles — the same argument that split
        Sleep and Wake: a cycle makes an operator press an unknown number of
        times to reach the state they want. These name the state, and the
        HOST's is lit; pressing one sets it on every device under control.
      */}
      <RailButton actionId="rotate-portrait" hotkeyId="rotate" active={rotationMode === 'lock-portrait'} onClick={() => onSetRotation('lock-portrait')} />
      <RailButton actionId="rotate-landscape" active={rotationMode === 'lock-landscape'} onClick={() => onSetRotation('lock-landscape')} />
      <RailButton actionId="rotate-auto" title="Auto-rotate (follow the device)" active={rotationMode === 'device'} onClick={() => onSetRotation('device')} />
      <RailButton actionId="brightness" title={brightnessLabel ?? 'Brightness'} onClick={() => void cycleBrightness()} />
      <ClipboardPopover targets={targets} history={clipboardHistory} onClearHistory={onClearClipboardHistory} onRead={onReadClipboard} />
    </>
  )
}

/**
 * Memoised, and it actually hits: `DeviceControl` latches every callback it
 * passes here behind a ref and keeps `targets` stable while the set is
 * unchanged, so the only props that change identity are `deviceId`,
 * `targets`, `rotationMode` and `clipboardHistory` — and those change when
 * they mean something. Without this the rail rebuilt its Radix tooltip
 * triggers and a popover twice a second, because the cast header beside it
 * shows a live fps. See `DeviceControl.tsx`'s `railRef`.
 */
export const ShortcutRail = memo(ShortcutRailImpl)
