'use client'

import { useRef } from 'react'
import { ChevronLeft, Circle, MoonStar, Power, Square, Sun, Volume2, VolumeOff, VolumeX } from 'lucide-react'
import { KEYCODES } from '@enkaku/protocol'
import { ClipboardButton } from '@/components/device/ClipboardButton'
import { RotationQuickAction } from '@/components/device/RotationQuickAction'
import { Button, Tooltip, TooltipContent, TooltipTrigger } from '@enkaku/ui'
import { ws } from '@/lib/ws'

const AKEYCODE = KEYCODES

/**
 * The device popup's own left-hand panel (plan 103 §4.1, §5 step 103.2;
 * restructured into its own independent, bordered panel by the layout
 * restructure that landed alongside 103.4–103.7 — see that step's own note
 * in this plan's status line): power · vol+ · vol- · mute · back · home ·
 * recents · sleep · wake, then a divider, rotate, then a divider, then the
 * clipboard button — the owner's own reference list plus the two items
 * (power, rotate) this rail already had and the owner's list did not
 * explicitly repeat. Every keycode button sends the SAME scrcpy keycode
 * `LiveView`'s own (now-suppressed, `rail={false}`) rail sent — this
 * component does not invent a transport, it duplicates `LiveView.tsx`'s own
 * small `sendKey` (a few lines: `ws.send({ type: 'input.key', ... })`, or
 * `input.mirror` when a Mirror group is active) rather than reaching into
 * that component's internals, so both stay independently readable. Rotate
 * is `RotationQuickAction`, reused unchanged (it is a settings write, not a
 * keycode). Clipboard is `ClipboardButton`, reused unchanged — `LiveView`'s
 * own footer suppresses ITS copy whenever `rail={false}` (the same file's
 * doc comment), so it renders exactly once.
 *
 * **Wake is now a separate button from Sleep**, matching the owner's own
 * list exactly (`docs/plans/103-m68-device-popup-system.md`'s layout note):
 * the popup's own `useEffect` (in `DevicePopup`) already claims and wakes an
 * idle device on open (plan 91 §3.11's "quick control, not a takeover"), so
 * this button is for waking a device that went back to sleep mid-session
 * without re-opening the popup — the same reasoning `LiveView`'s own
 * (suppressed) `power` row already applied to its Wake/Sleep pair.
 */
export function HardwareRail({
  deviceId,
  inputEnabled,
  onActivity,
  mirror,
  settings,
  onSettingsSaved,
}: {
  deviceId: string
  inputEnabled: boolean
  /** Called on every key sent — the caller uses it to refresh the lease/assist countdown, same as `LiveView`'s own prop. */
  onActivity?: () => void
  /** Plan 91 §3.8, §3.9 — the SAME shape `LiveView`'s own `mirror` prop takes, so a rail press fans out to the group exactly like a canvas tap does. `onResult` is deliberately not threaded here: `LiveView`'s own listener already receives every `input.mirror.result` for this `groupId` regardless of which component sent the request (server broadcasts by group, not by sender), so the popup's one result strip stays the only place results are shown. */
  mirror?: { groupId: string; solo: boolean }
  /** `DeviceDetailInfo.settings`, passed straight through to `RotationQuickAction`. */
  settings: unknown
  onSettingsSaved: (settings: unknown) => void
}) {
  const mirrorSeqRef = useRef(0)

  function sendKey(keycode: number) {
    if (!inputEnabled) return
    if (mirror) {
      const seq = ++mirrorSeqRef.current
      ws.send({
        type: 'input.mirror',
        payload: { groupId: mirror.groupId, seq, action: { verb: 'key', keycode }, ...(mirror.solo ? { soloDeviceId: deviceId } : {}) },
      })
    } else {
      ws.send({ type: 'input.key', payload: { deviceId, keycode } })
    }
    onActivity?.()
  }

  const buttons = [
    { key: AKEYCODE.POWER, icon: Power, label: 'Power', hint: 'Power — toggles the screen, same as the side button' },
    { key: AKEYCODE.VOLUME_UP, icon: Volume2, label: 'Volume up', hint: 'Volume up' },
    { key: AKEYCODE.VOLUME_DOWN, icon: VolumeOff, label: 'Volume down', hint: 'Volume down' },
    { key: AKEYCODE.VOLUME_MUTE, icon: VolumeX, label: 'Mute', hint: 'Mute — silences the phone’s own speaker' },
    { key: AKEYCODE.BACK, icon: ChevronLeft, label: 'Back', hint: 'Back — also sent by Esc when the screen has focus' },
    { key: AKEYCODE.HOME, icon: Circle, label: 'Home', hint: 'Home' },
    { key: AKEYCODE.APP_SWITCH, icon: Square, label: 'Recents', hint: 'Recent apps' },
    { key: AKEYCODE.SLEEP, icon: MoonStar, label: 'Sleep', hint: 'Put the screen to sleep' },
    { key: AKEYCODE.WAKEUP, icon: Sun, label: 'Wake', hint: 'Wake the screen' },
  ]

  return (
    <div
      role="toolbar"
      aria-label="Hardware controls"
      // An explicit width, not left to "widest child wins" (the owner-found
      // defect this fixed: `RotationQuickAction`'s text label stretched the
      // whole column before it gained `iconOnly`). Every child here is now
      // icon-only and `w-10` (matching `ClipboardButton`'s own trigger), so
      // this is a defensive fixed width rather than a guess — a future
      // child that is not icon-only will visibly overflow/clip instead of
      // silently widening the whole rail again.
      //
      // `self-start`: opts this panel OUT of `DevicePopup`'s own
      // `items-stretch` (owner-reported — the rail was stretching tall to
      // match the centre/right panels, when it should hug its own buttons'
      // height and nothing more).
      //
      // `@max-[600px]:*`: below a 600 px band `DevicePopup` stacks its three
      // panels into a column (see its own comment for the arithmetic), and a
      // 56 px-wide vertical rail of ten buttons would eat the whole popup
      // height there. It becomes a wrapping horizontal strip across the top
      // instead — the same buttons, laid the other way. A CONTAINER query
      // against the popup's own band, never a viewport breakpoint
      // (`docs/design.md`); the `@container` context is the band element in
      // `DevicePopup.tsx`, which is this component's only caller.
      className="flex w-14 shrink-0 self-start flex-col items-center gap-1 rounded-lg border border-line-strong bg-surface p-1.5 shadow-2xl @max-[600px]:w-full @max-[600px]:flex-row @max-[600px]:flex-wrap @max-[600px]:justify-center @max-[600px]:self-stretch"
    >
      {buttons.map((b) => (
        <Tooltip key={b.label}>
          <TooltipTrigger asChild>
            <Button
              size="sm"
              variant="ghost"
              className="h-8 w-10"
              disabled={!inputEnabled}
              onClick={() => sendKey(b.key)}
              aria-label={b.label}
            >
              <b.icon className="size-4" aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">{b.hint}</TooltipContent>
        </Tooltip>
      ))}
      {/* A horizontal hairline in the column layout, a vertical one once the
          rail turns into a row (see the root's own `@max-[600px]` note). */}
      <span className="my-1 h-px w-8 bg-line @max-[600px]:mx-1 @max-[600px]:my-0 @max-[600px]:h-8 @max-[600px]:w-px" aria-hidden />
      <RotationQuickAction deviceId={deviceId} settings={settings} onSaved={onSettingsSaved} iconOnly />
      {/* A horizontal hairline in the column layout, a vertical one once the
          rail turns into a row (see the root's own `@max-[600px]` note). */}
      <span className="my-1 h-px w-8 bg-line @max-[600px]:mx-1 @max-[600px]:my-0 @max-[600px]:h-8 @max-[600px]:w-px" aria-hidden />
      <ClipboardButton deviceId={deviceId} canSend={inputEnabled} />
    </div>
  )
}
