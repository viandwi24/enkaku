import { z } from 'zod'
import { PointSchema, SelectorSchema } from '../ui-node'
import { MediaScanModeSchema } from '../messages/transfer'
import { NormGestureSampleSchema, NormPointSchema } from '../messages/input'

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
 * Each device operation is declared once; only the wrapper differs per
 * consumer, which is the part that genuinely differs (an IPC frame vs. a
 * capability input that must name its own device).
 *
 * Twenty-one operations are declared below as of plan 94 §4.4, step 94.2:
 * `gesture`, `longPress`, `tapNorm` and `swipeNorm` are the four the replay
 * needs (F6, F7) and are wired into `ipc.ts`'s `DeviceCallSchema` exactly
 * like every operation above them — but they are NOT (yet) wrapped as a
 * `device.*` capability the way `device-input.ts`'s existing six are: this
 * step's own checklist scopes the SDK/script path only, and exposing them to
 * an agent is a deliberate follow-on, not an oversight.
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

/**
 * Plan 94 §3.3, §4.4 — the recorder's coordinate-space rule, resolved in step
 * 94.2 (`define-recording.ts`'s "finding 1" is the pre-image of this
 * decision; read that file's header for the full argument). EVERY existing
 * `DeviceApi` verb (`tap`, `swipe`, `scroll`, `fling`, `longPress` below)
 * takes DEVICE-PIXEL coordinates — a `Selector`'s `point` case, or a plain
 * `Point` — because a script author writes literal coordinates against a
 * device whose size they already know. A recording is the opposite case: it
 * is captured on one device and replayed on a device of a DIFFERENT size, so
 * `RecordingDocSchema` stores every position NORMALISED 0..1 (`recording.ts`,
 * acceptance criterion 1) and that must survive all the way to the driver
 * call, where the core — not the script — maps it to THIS run's actual
 * device pixels, exactly how manual input already works (F2). `TapNormArgsSchema`
 * and `SwipeNormArgsSchema` exist for this reason ALONE; `GestureCallArgsSchema`
 * below follows the same rule for the same reason. `Point` and `NormPoint`
 * are structurally identical `{x, y}` shapes, so nothing catches a caller
 * that hands a normalised fraction to `tap`/`swipe` (or a device pixel to
 * `tapNorm`/`swipeNorm`/`gesture`) — it does not error, it taps near the
 * top-left corner in confident silence (§3.3's "confidently wrong" failure
 * mode, self-inflicted). `packages/sdk/src/types.ts`'s `DeviceApi` carries
 * this same warning next to the verbs themselves.
 */
export const TapNormArgsSchema = z.object({
  pos: NormPointSchema,
  /** Exact, not sampled from a range — a recorded step replays the duration it actually measured. */
  holdMs: z.number().int().min(0).max(60_000).optional(),
})

export const SwipeNormArgsSchema = z.object({
  from: NormPointSchema,
  to: NormPointSchema,
  ms: z.number().int().min(50).max(10_000),
})

/**
 * The replay's own verb (F6, F7, closes the gap `defineRecording` could not
 * reach until this step): plays a recorded pointer trace SAMPLE-FOR-SAMPLE
 * through `InputSink.gesture` — never collapsed to a start point, an end
 * point and a synthesised interpolation (F3, plan 94 §3.4's "curvature and
 * velocity are the human's, not a synthesised Bézier"). Normalised for the
 * same reason `TapNormArgsSchema` is, above.
 */
export const GestureCallArgsSchema = z.object({ samples: z.array(NormGestureSampleSchema).min(2).max(300) })

/**
 * A tap held for `ms` (plan 94 §3.4, §4.4, closes F4/F7). Device-pixel, like
 * `TapArgsSchema` above — this is for a PROMOTED selector candidate
 * (plan 94 §3.3), never a raw recorded point (`tapNorm` is that verb).
 */
export const LongPressArgsSchema = z.object({ target: SelectorSchema, ms: z.number().int().min(0).max(60_000) })

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
  /**
   * Hand the app a URL instead of just starting it — `am start -a VIEW -d <url>`.
   *
   * Exists because driving a browser through its own address bar is unreliable in a way no amount
   * of retrying fixes: focusing does not reliably select, autocomplete rewrites the field while
   * keystrokes are still arriving, and a clear-then-type races itself. Observed results included
   * `wwho.erwhoer.net`, `hoer.net`, and `bsssom/dnsom/dns` — each one a run that then measured the
   * wrong page or failed outright. An intent carries the address exactly, once.
   *
   * `http`/`https` only: this opens whatever the URL names, so the scheme is constrained here
   * rather than trusting the caller, and the value is shell-quoted at the executor.
   */
  url: z.string().regex(/^https?:\/\/[^\s'"`$;|&<>]+$/).optional(),
})

export const AppForceStopArgsSchema = z.object({
  pkg: PackageNameSchema,
  /**
   * Also drop the app's cards from the recents switcher.
   *
   * `am force-stop` kills the process and leaves the task behind, so a script that "closed" an app
   * still leaves it sitting in the Android task switcher — verified on hardware: process dead, nine
   * recents entries still listed. Scoped to this package's own tasks; clearing the whole switcher
   * would take an operator's other apps with it.
   */
  clearRecents: z.boolean().optional(),
})

export const ClipboardGetArgsSchema = z.object({})

export const ClipboardSetArgsSchema = z.object({ text: z.string(), paste: z.boolean().default(false) })

export const InstallArgsSchema = z.object({
  artifactId: z.string().min(1),
  reinstall: z.boolean().optional(),
  grantPermissions: z.boolean().optional(),
  allowDowngrade: z.boolean().optional(),
})

/** `mediaScan` defaults to `'auto'` (plan 90 §4.6) — a script pushing to
 * `/data/local/tmp` pays nothing; one under a media root gets MediaStore
 * told automatically, with no per-call opt-in required. */
export const PushArgsSchema = z.object({
  artifactId: z.string().min(1),
  remotePath: z.string().min(1),
  mediaScan: MediaScanModeSchema.default('auto'),
})

export const PullArgsSchema = z.object({ remotePath: z.string().min(1) })

/** Every device.call method's `args` shape, keyed by its IPC method name —
 * `ipc.ts` and the `device.*` capability files both iterate/reference this
 * so the twenty-one operations stay declared exactly once. */
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
  // plan 94 §4.4, step 94.2 (F6, F7) — the replay's own four verbs.
  gesture: GestureCallArgsSchema,
  longPress: LongPressArgsSchema,
  tapNorm: TapNormArgsSchema,
  swipeNorm: SwipeNormArgsSchema,
} as const

export type DeviceCallMethod = keyof typeof DEVICE_CALL_ARGS
