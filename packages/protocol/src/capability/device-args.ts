import { z } from 'zod'
import { PointSchema, SelectorSchema } from '../ui-node'

/**
 * The per-operation argument shapes shared by TWO consumers that cannot
 * import from each other (plan 63 §3.7):
 *
 * - `@enkaku/session`'s `DeviceCallSchema` (`runner/ipc.ts`) — the script
 *   IPC union, `{ method, args }`.
 * - `@enkaku/core`'s `device.*` capabilities (`capability/device-*.ts`) —
 *   `{ deviceId, ...args }`.
 *
 * `@enkaku/session` cannot depend on `@enkaku/core` (core already depends on
 * session — see `session/src/types.ts`'s own comment on `TransferPort`), so
 * the registry entries that live in core cannot be the single source
 * `DeviceCallSchema` derives from directly. Putting the ARGUMENT shapes here
 * instead — one level below both — means neither package re-declares them:
 * `ipc.ts` wraps each schema in `{ method: literal, args }`, and each
 * `device.*` capability wraps the same schema in `.extend({ deviceId })`.
 * The eighteen device operations are declared once; only the wrapper differs
 * per consumer, which is the part that genuinely differs (an IPC frame vs. a
 * capability input that must name its own device).
 */

/** Mirrors `@enkaku/drivers`' gesture engine options (plan 40 §4.1) — kept
 * here rather than imported from drivers, since drivers sits ABOVE protocol
 * in the dependency graph. */
export const GestureEasingSchema = z.enum(['linear', 'easeOutQuad', 'easeInOutCubic'])
export const ScrollDirectionSchema = z.enum(['up', 'down', 'left', 'right'])

/** Android package names (plan 34 §3.4, §4.3) — the regex mirrors Android's
 * own package-name rules; `shellQuote` at the call site is what actually
 * guarantees injection safety, this is belt only. */
export const PackageNameSchema = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/)

export const TapArgsSchema = z.object({ target: SelectorSchema })

export const SwipeArgsSchema = z.object({
  from: PointSchema,
  to: PointSchema,
  ms: z.number().int().positive().default(300),
  /** Overrides `TimingSettings.gestureCurvature` for this call (plan 40 §4.4). */
  curvature: z.number().min(0).max(0.5).optional(),
  easing: GestureEasingSchema.optional(),
})

export const ScrollArgsSchema = z.object({
  direction: ScrollDirectionSchema,
  /** Pixels; defaults to 60% of the relevant viewport axis. */
  distance: z.number().positive().optional(),
  from: PointSchema.optional(),
})

export const FlingArgsSchema = z.object({
  direction: ScrollDirectionSchema,
  strength: z.enum(['soft', 'normal', 'hard']).optional(),
})

export const TypeArgsSchema = z.object({
  text: z.string(),
  /** Overrides `TimingSettings.perCharMs` for this call (plan 40 §4.4). */
  perCharMs: z.tuple([z.number().int().min(0), z.number().int().min(0)]).optional(),
  /** Forces the pre-plan-40 bulk delivery for this call regardless of the timing profile. */
  instant: z.boolean().optional(),
})

export const KeyArgsSchema = z.object({ code: z.union([z.number().int(), z.string()]) })

export const FindArgsSchema = z.object({ sel: SelectorSchema })

export const DumpArgsSchema = z.object({})

export const WaitForArgsSchema = z.object({
  sel: SelectorSchema,
  timeout: z.number().int().positive(),
  intervalMs: z.number().int().positive(),
})

export const ScreenshotArgsSchema = z.object({})

export const AppLaunchArgsSchema = z.object({
  pkg: PackageNameSchema,
  activity: z.string().regex(/^[a-zA-Z0-9_.$/]+$/).optional(),
})

export const AppForceStopArgsSchema = z.object({ pkg: PackageNameSchema })

export const ClipboardGetArgsSchema = z.object({})

export const ClipboardSetArgsSchema = z.object({ text: z.string(), paste: z.boolean().default(false) })

export const InstallArgsSchema = z.object({
  artifactId: z.string().min(1),
  reinstall: z.boolean().optional(),
  grantPermissions: z.boolean().optional(),
  allowDowngrade: z.boolean().optional(),
})

export const PushArgsSchema = z.object({ artifactId: z.string().min(1), remotePath: z.string().min(1) })

export const PullArgsSchema = z.object({ remotePath: z.string().min(1) })

/** Every device.call method's `args` shape, keyed by its IPC method name —
 * `ipc.ts` and the `device.*` capability files both iterate/reference this
 * so the seventeen operations stay declared exactly once. */
export const DEVICE_CALL_ARGS = {
  tap: TapArgsSchema,
  swipe: SwipeArgsSchema,
  scroll: ScrollArgsSchema,
  fling: FlingArgsSchema,
  type: TypeArgsSchema,
  key: KeyArgsSchema,
  find: FindArgsSchema,
  dump: DumpArgsSchema,
  waitFor: WaitForArgsSchema,
  screenshot: ScreenshotArgsSchema,
  'app.launch': AppLaunchArgsSchema,
  'app.forceStop': AppForceStopArgsSchema,
  'clipboard.get': ClipboardGetArgsSchema,
  'clipboard.set': ClipboardSetArgsSchema,
  install: InstallArgsSchema,
  push: PushArgsSchema,
  pull: PullArgsSchema,
} as const

export type DeviceCallMethod = keyof typeof DEVICE_CALL_ARGS
