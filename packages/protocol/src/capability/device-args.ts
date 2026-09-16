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

/**
 * `via: 'adb'` sends this one call through Android's own input injection (`adb shell input`) instead of
 * the session's input engine. Some app screens do not respond to the farm's engine — measured
 * 2026-09-11: YouTube's upload "details" screen never focused its title field for a scrcpy-UHID tap,
 * nor took text from the guest agent's keyboard, while `input tap`/`input text` did both. It is a
 * per-call escape hatch for such a screen, not a mode: slower (~100 ms a call), no hold duration, and
 * text is printable ASCII only.
 */
export const InputViaSchema = z.enum(['adb'])

/**
 * Opt-in "human" variation for a GESTURE (2026-09-17), the movement twin of `HumanTypingOptions`.
 *
 * Why it lives here rather than in each pack: a survey of the TikTok, Instagram and YouTube packs
 * found all three had re-derived the same kit — a seeded rng, a jittered aim point, a randomised
 * up-swipe — with slightly different numbers, and the differences had drifted into real gaps (only
 * TikTok ever scrolled back; YouTube's own `swipeDownRandomised` was written and never called). One
 * implementation under the API is what stops that happening again, and every plugin gets it by
 * passing a flag rather than by copying a helper.
 *
 * The farm's touch profile already supplies the FLOOR — a curved, eased, per-sample-jittered path
 * (`gestureCurvature`), a sampled hold, ±`coordJitterPx` on every tap. What that floor cannot give
 * is VARIETY: the same corridor, the same reach and the same duration on every repetition is a
 * pattern of its own. These options vary those three, around whatever the caller asked for.
 *
 * Deliberately never the default, exactly like `human` on `type()`: omit it and the call behaves
 * byte-for-byte as it did before this existed.
 */
export const HumanGestureOptionsSchema = z.object({
  /** How far each endpoint may wander, as a fraction of the gesture's own span. Default 0.06. */
  drift: z.number().min(0).max(0.5).optional(),
  /** The requested duration is multiplied by a factor drawn from this range. Default [0.75, 1.35]. */
  speed: z.tuple([z.number().positive(), z.number().positive()]).optional(),
  /** The requested distance is multiplied by a factor drawn from this range. Default [0.85, 1.2]. */
  reach: z.tuple([z.number().positive(), z.number().positive()]).optional(),
  /** Pick the easing at random from the three the engine supports, instead of keeping the caller's. Default true. */
  varyEasing: z.boolean().optional(),
  /** Deterministic variation: same seed, same call, same path. Omit for a run that does not need to replay. */
  seed: z.number().int().optional(),
})
export type HumanGestureOptions = z.infer<typeof HumanGestureOptionsSchema>

/**
 * Opt-in "human" aim for a TAP (2026-09-17): land somewhere inside the target's own box rather than
 * on its exact centre. A thumb does not hit the middle of a button 200 times running, and all three
 * packs had already written this helper for themselves (`jitteredPoint`, `jitterPoint`, `insetPoint`)
 * — each drawing from `Math.random`, so a seeded run never replayed its taps.
 *
 * Only meaningful for a SELECTOR target: a caller that passes a literal point has already decided
 * where to land, and a measured point is sometimes the only one that works (YouTube's upload details
 * screen is the standing example), so a point target is left exactly where it was put.
 */
export const HumanTapOptionsSchema = z.object({
  /** Fraction of the node kept clear at each edge. Default 0.15 — the middle 70% of the box. */
  inset: z.number().min(0).max(0.45).optional(),
  /** Deterministic aim: same seed, same box, same point. */
  seed: z.number().int().optional(),
})
export type HumanTapOptions = z.infer<typeof HumanTapOptionsSchema>

export const TapArgsSchema = z.object({
  target: SelectorSchema,
  via: InputViaSchema.optional(),
  /** See `HumanTapOptionsSchema`. `true` takes every default. Ignored for a `{ point }` target. */
  human: z.union([z.literal(true), HumanTapOptionsSchema]).optional(),
})

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
  /** See `HumanGestureOptionsSchema`. `true` takes every default; the endpoints given stay the anchor. */
  human: z.union([z.literal(true), HumanGestureOptionsSchema]).optional(),
})

export const ScrollArgsSchema = z.object({
  direction: ScrollDirectionSchema,
  /** Pixels; defaults to 60% of the relevant viewport axis. */
  distance: z.number().positive().optional(),
  from: PointSchema.optional(),
  /**
   * See `HumanGestureOptionsSchema`. This is the "just call it" form: with `human`, the corridor the
   * gesture runs down, its reach, its duration and its easing are all drawn per call, so a plugin
   * that wants a human-looking page turn writes `scroll({ direction: 'up', human: true })` and
   * computes no geometry of its own.
   */
  human: z.union([z.literal(true), HumanGestureOptionsSchema]).optional(),
})

export const FlingArgsSchema = z.object({
  direction: ScrollDirectionSchema,
  strength: z.enum(['soft', 'normal', 'hard']).optional(),
  /** See `HumanGestureOptionsSchema`. Varies the corridor, reach and duration around the chosen strength. */
  human: z.union([z.literal(true), HumanGestureOptionsSchema]).optional(),
})

/**
 * Opt-in "human" typing (client request, 2026-09-15): a human cadence, occasional typos that get
 * backspaced and retyped, more delay at the end of a word than mid-word, and every few words a
 * chance of a longer "thinking" pause. Planned purely by `@enkaku/drivers`'
 * `planHumanTyping`/`resolveHumanTypingOptions` — this schema only validates the shape; every
 * field mirrors `HumanTypingOptions` there and stays in lockstep with its own defaults, which live
 * only in that one place so they are never declared twice.
 *
 * Deliberately never the default: `type()`'s `instant`/plain-natural behaviour must stay
 * byte-for-byte unchanged when this is omitted (CLAUDE.md's ban on a changed default), and the
 * executor skips it entirely on any rung that cannot send a delete or commits a string as one
 * indivisible call (`agent-ime` — see `device-executor.ts`'s `type` case) — falling back to no
 * typos there and saying so in `ScriptTypeResult.human`.
 */
export const HumanTypingOptionsSchema = z.object({
  perCharMs: z.tuple([z.number().int().min(0), z.number().int().min(0)]).optional(),
  extraPerWordMs: z.tuple([z.number().int().min(0), z.number().int().min(0)]).optional(),
  thinkingPause: z
    .object({
      probability: z.number().min(0).max(1).optional(),
      everyWords: z.number().int().positive().optional(),
      ms: z.tuple([z.number().int().min(0), z.number().int().min(0)]).optional(),
    })
    .optional(),
  typo: z
    .object({
      probability: z.number().min(0).max(1).optional(),
      noticeAfterChars: z.tuple([z.number().int().min(0), z.number().int().min(0)]).optional(),
    })
    .optional(),
  maxTotalMs: z.number().int().positive().optional(),
  seed: z.number().int().optional(),
})
export type HumanTypingOptions = z.infer<typeof HumanTypingOptionsSchema>

export const TypeArgsSchema = z.object({
  text: z.string(),
  /** Overrides `TimingSettings.perCharMs` for this call (plan 40 §4.4). */
  perCharMs: z.tuple([z.number().int().min(0), z.number().int().min(0)]).optional(),
  /** Forces the pre-plan-40 bulk delivery for this call regardless of the timing profile. */
  instant: z.boolean().optional(),
  /** See `InputViaSchema`. With `'adb'` the text must be printable ASCII. */
  via: InputViaSchema.optional(),
  /** See `HumanTypingOptionsSchema` above. `true` takes every default. */
  human: z.union([z.literal(true), HumanTypingOptionsSchema]).optional(),
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

/**
 * Runtime permissions a script may grant to an app it drives — these and no others.
 *
 * Why a script needs this at all: on Android 14+ the system permission dialog is an
 * "accessibility data sensitive" window, hidden from the farm's UI reader, and it takes the app
 * window behind it down with it. A run that meets one reads a screen with nothing on it but the
 * status bar and cannot answer what it cannot see — measured on the owner's production SM-A075F
 * fleet (2026-09-14): every TikTok upload stopped at "the dump reads unknown" with Samsung's
 * "Izinkan TikTok mengambil gambar dan merekam video?" on screen. Granting through the package
 * manager BEFORE the app opens means the dialog is never shown.
 *
 * Why a closed list: `pm grant` from a script is a real change to a real phone. These are the
 * permissions an upload or a warm-up needs — camera and microphone (TikTok and YouTube ask for
 * both on their create screens), media (the gallery), and notifications (asked at launch on
 * Android 13+). Contacts, location, SMS, phone, calendar and body sensors are deliberately absent:
 * nothing this farm automates needs them, and a script must not be able to hand them out.
 * Names are the bare constant after `android.permission.`.
 */
export const GRANTABLE_APP_PERMISSIONS = [
  'CAMERA',
  'RECORD_AUDIO',
  'READ_MEDIA_VIDEO',
  'READ_MEDIA_IMAGES',
  'READ_MEDIA_VISUAL_USER_SELECTED',
  'READ_MEDIA_AUDIO',
  'READ_EXTERNAL_STORAGE',
  'POST_NOTIFICATIONS',
] as const
export type GrantableAppPermission = (typeof GRANTABLE_APP_PERMISSIONS)[number]

export const AppGrantPermissionsArgsSchema = z.object({
  pkg: PackageNameSchema,
  permissions: z.array(z.enum(GRANTABLE_APP_PERMISSIONS)).min(1).max(GRANTABLE_APP_PERMISSIONS.length),
})

/**
 * What happened to one requested permission, read back from the device rather than assumed from
 * `pm grant`'s exit code.
 *
 * - `granted` — it was not granted, `pm grant` ran, and the package now reports it granted.
 * - `already` — it was granted before this call; nothing was written.
 * - `not-requested` — the app does not declare it (or this Android version has no such
 *   permission, e.g. `READ_MEDIA_VIDEO` before Android 13). Not an error: a script asks for the
 *   union its apps need across Android versions.
 * - `failed` — it was requested, not granted, and still is not after `pm grant`; `detail` carries
 *   the platform's own words.
 */
export interface AppPermissionGrant {
  permission: GrantableAppPermission
  outcome: 'granted' | 'already' | 'not-requested' | 'failed'
  detail?: string
}

/**
 * The same allowlist, the other way: refuse a permission and tell Android not to ask again
 * (`pm revoke` + `pm set-permission-flags … user-set user-fixed` — the state "Jangan izinkan"
 * pressed twice leaves behind).
 *
 * Exists because granting is not always the answer that keeps a flow on its walked path. YouTube's
 * upload was walked with the CAMERA refused: a phone that granted it shows a different Create
 * screen and the flow's anchors are not there. Its owner's moto held exactly the refused-and-fixed
 * state (`granted=false, flags=[USER_SET|USER_FIXED]`), and the dialog never appeared. A fresh
 * phone has never been asked, so the dialog appears — hidden — the first time. Refusing it before
 * launch gives that phone the same state the walk was done in.
 */
/**
 * What a script may REFUSE: every grantable permission, plus ones it may only ever refuse. A
 * refusal hands nothing out, so this list may be wider than the grant list. Contacts is the first
 * such (production SM-A075F, 2026-09-15): TikTok raised Android's own "Izinkan TikTok mengakses
 * kontak?" during a warm-up — hidden from the farm's reader like every system permission dialog —
 * and the run sat under it. Refused and fixed before launch, the dialog never shows.
 */
export const DENIABLE_APP_PERMISSIONS = [...GRANTABLE_APP_PERMISSIONS, 'READ_CONTACTS'] as const
export type DeniableAppPermission = (typeof DENIABLE_APP_PERMISSIONS)[number]

export const AppDenyPermissionsArgsSchema = z.object({
  pkg: PackageNameSchema,
  permissions: z.array(z.enum(DENIABLE_APP_PERMISSIONS)).min(1).max(DENIABLE_APP_PERMISSIONS.length),
})

/** `denied` — was granted or never answered, and now reads refused AND user-fixed. The rest as `AppPermissionGrant`. */
export interface AppPermissionDenial {
  permission: DeniableAppPermission
  outcome: 'denied' | 'already' | 'not-requested' | 'failed'
  detail?: string
}

/**
 * Stop an app opening as a picture-in-picture window: `appops set <pkg> PICTURE_IN_PICTURE ignore`, read back.
 * Production phone #10 (2026-09-15): YouTube came up as a Shorts player in a small window over the launcher after a
 * clean launch, and launching it again, even after a force-stop, brought the small window back. With the op ignored,
 * Android never gives the app that window.
 */
export const AppDenyPictureInPictureArgsSchema = z.object({ pkg: PackageNameSchema })

/** `denied` — now reads `ignore`; `already` — it did before; `failed` — it still does not, with what `appops` said. */
export interface AppPictureInPictureDenial {
  outcome: 'denied' | 'already' | 'failed'
  /** The mode read back last, e.g. `ignore`, `allow`, `default`; `unreadable` when appops printed none. */
  mode: string
  detail?: string
}

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
import {
  DeviceFsDeleteArgsSchema,
  DeviceFsListArgsSchema,
  DeviceFsMkdirArgsSchema,
  DeviceFsMoveArgsSchema,
  DeviceFsStatArgsSchema,
} from '../device-fs'
import { DeviceMediaListArgsSchema } from '../device-media'

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
  'app.grantPermissions': AppGrantPermissionsArgsSchema,
  'app.denyPermissions': AppDenyPermissionsArgsSchema,
  'app.denyPictureInPicture': AppDenyPictureInPictureArgsSchema,
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
  // Plan 700 — reading the phone's MediaStore, and managing its files. Both
  // families read state a script previously had to guess at: what the gallery
  // holds, and what is actually on disk beside the file it just pushed.
  'media.list': DeviceMediaListArgsSchema,
  'fs.list': DeviceFsListArgsSchema,
  'fs.stat': DeviceFsStatArgsSchema,
  'fs.move': DeviceFsMoveArgsSchema,
  'fs.delete': DeviceFsDeleteArgsSchema,
  'fs.mkdir': DeviceFsMkdirArgsSchema,
} as const

export type DeviceCallMethod = keyof typeof DEVICE_CALL_ARGS
