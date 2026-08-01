import { z } from 'zod'

/** Tipe inspeksi UI (spec §7, §11.2) — dipakai SDK, drivers, dan runner. */

export const PointSchema = z.object({ x: z.number(), y: z.number() })

/**
 * Selector berlapis (stabil → rapuh): { id } → { desc } → { text } → { point }.
 * Tepat satu kunci per selector (strict) — kombinasi multi-kriteria belum
 * didukung di M4.
 */
export const SelectorSchema = z.union([
  z.object({ id: z.string() }).strict(),
  z.object({ desc: z.string() }).strict(),
  z.object({ text: z.string() }).strict(),
  z.object({ point: PointSchema }).strict(),
])
export type Selector = z.infer<typeof SelectorSchema>

export interface Bounds {
  left: number
  top: number
  right: number
  bottom: number
}

export interface UiNode {
  resourceId: string
  text: string
  desc: string
  className: string
  packageName: string
  bounds: Bounds
  clickable: boolean
  enabled: boolean
  focused: boolean
  index: number
  children: UiNode[]
}

/** Keycode Android umum (nama → angka) supaya script tidak hafal angka. */
export const KEYCODES = {
  HOME: 3,
  BACK: 4,
  DPAD_UP: 19,
  DPAD_DOWN: 20,
  DPAD_LEFT: 21,
  DPAD_RIGHT: 22,
  DPAD_CENTER: 23,
  POWER: 26,
  TAB: 61,
  ENTER: 66,
  DEL: 67,
  ESCAPE: 111,
  APP_SWITCH: 187,
  WAKEUP: 224,
} as const

export type KeyName = keyof typeof KEYCODES
export type KeyCode = number | KeyName

export const KeyCodeSchema = z.union([z.number().int().min(0).max(320), z.enum(Object.keys(KEYCODES) as [KeyName])])

export function resolveKeyCode(code: KeyCode): number {
  return typeof code === 'number' ? code : KEYCODES[code]
}
