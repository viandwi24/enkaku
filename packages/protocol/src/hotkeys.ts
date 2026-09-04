import { z } from 'zod'
import { DomCodeSchema, isDomCode, type DomCode } from './keys'

/**
 * The Device Control hotkey table (MVP 08 §1.2), in the protocol package so
 * the window's tooltips, the docs and any future script helper read one list
 * (MVP 08 §1.2: "the map is one table in `@enkaku/protocol` so scripts and
 * docs read the same list").
 *
 * The modifier is Alt on every platform (plan 215 §3.2 D5). Cmd on macOS is
 * §9 Q1: it would swallow Cmd+A, Cmd+C and Cmd+V, three of the four
 * behaviours MVP 08 §4 lists as acceptance for the passthrough layer.
 *
 * `Escape` is the one row with no modifier, and the one row that only fires
 * while the cast has focus: it is Back on the device, which is why the
 * window's own Escape (close) is left to the shell's tiered listener and
 * never fires while the canvas has the key (plan 215 §3.2 D2, D4).
 */
export const HOTKEY_IDS = [
  'back',
  'home',
  'recents',
  'power',
  'rotate',
  'notifications',
  'settings-panel',
  'collapse-panels',
  'fullscreen',
  'clipboard-copy',
  'clipboard-paste',
  'release-focus',
] as const
export const HotkeyIdSchema = z.enum(HOTKEY_IDS)
export type HotkeyId = (typeof HOTKEY_IDS)[number]

export interface Hotkey {
  id: HotkeyId
  /** `KeyboardEvent.code`; the same vocabulary `KEY_TABLE` uses (plan 209 §4.4). */
  code: DomCode
  alt: boolean
  shift: boolean
  /** What the operator is told this does. Used verbatim in the tooltip. */
  label: string
}

export const DEVICE_CONTROL_HOTKEYS: readonly Hotkey[] = [
  { id: 'back', code: 'Escape', alt: false, shift: false, label: 'Back' },
  { id: 'home', code: 'KeyH', alt: true, shift: false, label: 'Home' },
  { id: 'recents', code: 'KeyS', alt: true, shift: false, label: 'Recent apps' },
  { id: 'power', code: 'KeyP', alt: true, shift: false, label: 'Power' },
  { id: 'rotate', code: 'KeyR', alt: true, shift: false, label: 'Rotate' },
  { id: 'notifications', code: 'KeyN', alt: true, shift: false, label: 'Notifications' },
  { id: 'settings-panel', code: 'KeyM', alt: true, shift: false, label: 'Quick settings' },
  { id: 'collapse-panels', code: 'KeyO', alt: true, shift: false, label: 'Collapse panels' },
  { id: 'fullscreen', code: 'KeyF', alt: true, shift: false, label: 'Fullscreen' },
  { id: 'clipboard-copy', code: 'KeyC', alt: true, shift: false, label: 'Copy the device clipboard' },
  { id: 'clipboard-paste', code: 'KeyV', alt: true, shift: false, label: 'Paste to the device' },
  { id: 'release-focus', code: 'KeyK', alt: true, shift: true, label: 'Release the keyboard' },
]

const CODE_LABEL: Partial<Record<DomCode, string>> = { Escape: 'Esc' }

/** `Alt+Shift+K`, `Esc`. One renderer, so a tooltip can never disagree with the table. */
export function chordLabel(h: Hotkey): string {
  const parts: string[] = []
  if (h.alt) parts.push('Alt')
  if (h.shift) parts.push('Shift')
  parts.push(CODE_LABEL[h.code] ?? h.code.replace(/^Key/, ''))
  return parts.join('+')
}

export function hotkeyFor(e: { code: string; altKey: boolean; shiftKey: boolean }): Hotkey | null {
  return DEVICE_CONTROL_HOTKEYS.find((h) => h.code === e.code && h.alt === e.altKey && h.shift === e.shiftKey) ?? null
}

export { DomCodeSchema, isDomCode }
