import { z } from 'zod'

/** UI inspection types (spec §7, §11.2) — used by the SDK, drivers, and runner. */

export const PointSchema = z.object({ x: z.number(), y: z.number() })

/**
 * Layered selectors (stable → fragile): { id } → { desc } → { text } → { point }.
 * Exactly one key per selector (strict) — multi-criteria combinations are not
 * supported in M4.
 */
export const SelectorSchema = z.union([
  z.object({ id: z.string() }).strict(),
  z.object({ desc: z.string() }).strict(),
  z.object({ text: z.string() }).strict(),
  z.object({ point: PointSchema }).strict(),
])
export type Selector = z.infer<typeof SelectorSchema>

export const BoundsSchema = z.object({
  left: z.number(),
  top: z.number(),
  right: z.number(),
  bottom: z.number(),
})
export type Bounds = z.infer<typeof BoundsSchema>

/**
 * A node of the on-device UI tree (plan 56 §4.1). Was a bare TypeScript
 * interface before this plan — which cannot validate a tree arriving over
 * the wire, and the rule is Zod at every boundary. `z.ZodType<UiNode>` makes
 * the type annotation explicit because the schema is recursive (`children`
 * references `UiNodeSchema` itself) and `z.lazy` alone cannot infer it.
 */
export type UiNode = {
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

export const UiNodeSchema: z.ZodType<UiNode> = z.lazy(() =>
  z.object({
    resourceId: z.string(),
    text: z.string(),
    desc: z.string(),
    className: z.string(),
    packageName: z.string(),
    bounds: BoundsSchema,
    clickable: z.boolean(),
    enabled: z.boolean(),
    focused: z.boolean(),
    index: z.number().int(),
    children: z.array(UiNodeSchema),
  }),
)

/** Common Android keycodes (name → number) so scripts never memorise numbers. */
export const KEYCODES = {
  HOME: 3,
  BACK: 4,
  DPAD_UP: 19,
  DPAD_DOWN: 20,
  DPAD_LEFT: 21,
  DPAD_RIGHT: 22,
  DPAD_CENTER: 23,
  VOLUME_UP: 24,
  VOLUME_DOWN: 25,
  POWER: 26,
  TAB: 61,
  ENTER: 66,
  DEL: 67,
  ESCAPE: 111,
  MENU: 82,
  VOLUME_MUTE: 164,
  APP_SWITCH: 187,
  SLEEP: 223,
  WAKEUP: 224,
} as const

export type KeyName = keyof typeof KEYCODES
export type KeyCode = number | KeyName

export const KeyCodeSchema = z.union([z.number().int().min(0).max(320), z.enum(Object.keys(KEYCODES) as [KeyName])])

export function resolveKeyCode(code: KeyCode): number {
  return typeof code === 'number' ? code : KEYCODES[code]
}
