'use client'

import { memo, useState } from 'react'
import { KEYCODES, chordLabel, DEVICE_CONTROL_HOTKEYS } from '@enkaku/protocol'
import {
  Button,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  CaretLeftIcon,
  CircleIcon,
  ClockCounterClockwiseIcon,
  PowerIcon,
  SpeakerHighIcon,
  SpeakerLowIcon,
  SpeakerSlashIcon,
  SquareIcon,
  SunIcon,
  type Icon,
} from '@enkaku/ui'
import { runOnDevice } from '@/lib/actions'
import { ClipboardPopover } from './ClipboardPopover'
import type { ClipboardEntry } from './use-cast'

/**
 * The handoff's shortcut rail (README.md:250-253): 52px, ten 34x34 buttons,
 * `var(--dim)` icons. Buttons 1-7 are `input.key`, fanned out by `sendKey`;
 * 8-10 act on the host device only (plan 215 §4.7). Every tooltip reads its
 * chord from `DEVICE_CONTROL_HOTKEYS` — never a hand-written string (G7).
 */
function ShortcutRailImpl({
  deviceId,
  sendKey,
  onRotate,
  clipboardHistory,
  onClearClipboardHistory,
  onReadClipboard,
}: {
  deviceId: string
  sendKey: (keycode: number) => void
  onRotate: () => void
  /** Everything the device has copied while this window has been open (`use-cast.ts`). */
  clipboardHistory: ClipboardEntry[]
  onClearClipboardHistory: () => void
  /** Resolves `false` when the device simply had nothing to send — see `use-cast.ts`'s `readDeviceClipboard`. */
  onReadClipboard: () => Promise<boolean>
}) {
  const [brightnessLabel, setBrightnessLabel] = useState<string | null>(null)

  async function cycleBrightness() {
    const cmd = [
      "b=$(settings get system screen_brightness 2>/dev/null); b=${b:-128};",
      'if [ "$b" -lt 96 ]; then n=128; elif [ "$b" -lt 200 ]; then n=255; else n=32; fi;',
      'settings put system screen_brightness_mode 0; settings put system screen_brightness $n; echo $n',
    ].join(' ')
    try {
      const res = await runOnDevice('adb', deviceId, { cmd })
      const stdout = (res.detail as { stdout?: string } | undefined)?.stdout?.trim()
      if (stdout) setBrightnessLabel(`Brightness ${stdout}`)
    } catch {
      // Best-effort: the rail button stays usable even if this one run fails.
    }
  }

  function hotkeyChordFor(id: string): string | undefined {
    const hk = DEVICE_CONTROL_HOTKEYS.find((h) => h.id === id)
    return hk ? chordLabel(hk) : undefined
  }

  const RailButton = ({ icon: Icon, label, hotkeyId, title, onClick }: { icon: Icon; label: string; hotkeyId?: string; title?: string; onClick: () => void }) => {
    const chord = hotkeyId ? hotkeyChordFor(hotkeyId) : undefined
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon-lg" className="rounded-[10px] text-dim" aria-label={label} onClick={onClick}>
            <Icon className="size-4" aria-hidden />
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
          {title ?? (chord ? `${label} · ${chord}` : label)}
        </TooltipContent>
      </Tooltip>
    )
  }

  return (
    <>
      <RailButton icon={PowerIcon} label="Power" hotkeyId="power" onClick={() => sendKey(KEYCODES.POWER)} />
      <RailButton icon={SpeakerHighIcon} label="Volume up" onClick={() => sendKey(KEYCODES.VOLUME_UP)} />
      <RailButton icon={SpeakerLowIcon} label="Volume down" onClick={() => sendKey(KEYCODES.VOLUME_DOWN)} />
      <RailButton icon={SpeakerSlashIcon} label="Mute" onClick={() => sendKey(KEYCODES.VOLUME_MUTE)} />
      <RailButton icon={CaretLeftIcon} label="Back" hotkeyId="back" onClick={() => sendKey(KEYCODES.BACK)} />
      <RailButton icon={CircleIcon} label="Home" hotkeyId="home" onClick={() => sendKey(KEYCODES.HOME)} />
      <RailButton icon={SquareIcon} label="Recents" hotkeyId="recents" onClick={() => sendKey(KEYCODES.APP_SWITCH)} />
      <RailButton icon={ClockCounterClockwiseIcon} label="Rotate" hotkeyId="rotate" onClick={onRotate} />
      <RailButton icon={SunIcon} label="Brightness" title={brightnessLabel ?? 'Brightness'} onClick={() => void cycleBrightness()} />
      <ClipboardPopover
        deviceId={deviceId}
        history={clipboardHistory}
        onClearHistory={onClearClipboardHistory}
        onRead={onReadClipboard}
      />
    </>
  )
}

/**
 * Memoised, and it actually hits: `DeviceControl` latches every callback it
 * passes here behind a ref, so the only props that ever change identity are
 * `deviceId` and `clipboardHistory` — and those change when they mean
 * something. Without this the rail rebuilt eleven Radix tooltip triggers and
 * a popover twice a second, for the lifetime of the window, because the cast
 * header beside it shows a live fps. See `DeviceControl.tsx`'s `railRef`.
 */
export const ShortcutRail = memo(ShortcutRailImpl)
