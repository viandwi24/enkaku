import type { z } from 'zod'
import type {
  FindOutcome,
  JobStatus,
  JobSummary,
  KeyCode,
  MediaScanMode,
  NormGestureSample,
  NormPoint,
  Point,
  PushResult,
  RuntimeEnvelope,
  Selector,
  TimingSettings,
  UiNode,
} from '@enkaku/protocol'
import type { PluginContext } from './runtime'

export interface WaitForOptions {
  /** Default 10_000 ms. */
  timeout?: number
  /** Defaults to 1_000 ms — realistic for uiautomator-dump; ui-server (Plan 06) can be far shorter. */
  intervalMs?: number
}

/** A cubic-Bézier gesture's easing (plan 40 §4.1): `easeOutQuad` ends fast (a
 * flick), `easeInOutCubic` (the default) ends slow (a deliberate drag). */
export type GestureEasing = 'linear' | 'easeOutQuad' | 'easeInOutCubic'

/**
 * `ctx.device.type()`'s return (plan 90 §3.3, §4.5, §5 step 90.5). `via` is the rung
 * `resolveTextRoute` (`@enkaku/session`) actually chose — the three text-ladder rungs plus
 * `'ui-server-set-text'`, a fourth mechanism outside the ladder: ui-server's element-scoped
 * `set_text` is already unicode-clean (F26) and is tried first whenever a selector-based tap
 * makes it applicable, before the ladder is ever consulted. Reporting it is what makes F26's class
 * of confusion debuggable — a shipped plugin once silently fell back to `input text` (which
 * appends instead of replacing) with no way to tell which path had actually run.
 *
 * The ladder originally had a fourth rung, `'clipboard'` — proven architecturally unreachable in
 * this codebase and removed (docs/plans/96-m61-hotfixes.md §96.7, §96.8), so it is no longer a
 * possible value of `via`.
 */
export interface ScriptTypeResult {
  via: 'agent-ime' | 'scrcpy-text' | 'adb-ascii' | 'ui-server-set-text'
  /** Code points actually committed, when the underlying rung reports a count (`agent-ime` only today). */
  committed?: number
  /**
   * Always false today — the `'clipboard'` rung that would have set this true was removed
   * (docs/plans/96-m61-hotfixes.md §96.7, §96.8). Kept as a boolean rather than deleted so no
   * existing script that reads it needs a breaking change.
   */
  clobberedClipboard: boolean
}

/**
 * **Coordinate-space rule for `DeviceApi`'s position-carrying verbs (plan 94
 * §3.3, §4.4 — resolved in step 94.2; see `define-recording.ts`'s header
 * comment for the finding that forced this decision).** `tap`, `swipe`,
 * `scroll`, `fling` and `longPress` all take DEVICE-PIXEL coordinates — a
 * `Selector`'s `point` case, or a plain `Point` — because an ordinary script
 * author writes literal coordinates against a device whose size they already
 * know. A RECORDING is the opposite case: it is captured on one device and
 * replayed on a device of a DIFFERENT size (plan 94 acceptance criterion 1),
 * so every position `RecordingDocSchema` stores is NORMALISED 0..1
 * (`@enkaku/protocol`'s `NormPoint`), and that has to survive all the way to
 * the driver call — the CORE maps it to that run's actual device pixels, not
 * the script, exactly how manual input already works (F2). `tapNorm`,
 * `swipeNorm` and `gesture` below exist for this reason ALONE: they are the
 * replay interpreter's own verbs, not something an ordinary script should
 * reach for. **`Point` and `NormPoint` are structurally identical `{x, y}`
 * shapes — nothing type-checks the difference.** Hand a normalised fraction
 * to `tap`/`swipe`, or a device pixel to `tapNorm`/`swipeNorm`/`gesture`, and
 * nothing throws: the tap simply lands near the top-left corner, every time,
 * on every device — the exact "confidently wrong" failure mode §3.3 warns a
 * stale anchor produces, self-inflicted here by a schema/verb mismatch.
 */
export interface DeviceApi {
  /** Selector → find → tap its centre point; { point } → tap directly. */
  tap(target: Selector): Promise<void>
  /**
   * The replay interpreter's own verb (plan 94 §3.4, §4.4, F6, F7) — a
   * literal RECORDED point, normalised 0..1 (see the coordinate-space rule
   * above `DeviceApi` itself). `opts.holdMs`, when given, is the EXACT
   * duration a recorded tap/long-press measured — not a range to sample
   * from, unlike plain `tap()`'s device-configured `tapJitterMs`. Omitted
   * `opts.holdMs` falls back to the device's own `tapJitterMs` range, the
   * same as `tap()`.
   */
  tapNorm(pos: NormPoint, opts?: { holdMs?: number }): Promise<void>
  /**
   * The replay interpreter's own verb (plan 94 §3.4, §4.4, F6, F7) — the
   * two-point drag fallback `LiveView` already emits for a swipe too fast to
   * sample, normalised 0..1 (see the coordinate-space rule above `DeviceApi`
   * itself). A straight line over `ms`, never curved — the recording had no
   * intermediate samples to curve through.
   */
  swipeNorm(from: NormPoint, to: NormPoint, ms: number): Promise<void>
  /**
   * Play a recorded pointer trace SAMPLE-FOR-SAMPLE (plan 94 §3.4, §4.4, F3,
   * F6, F7) — never collapsed to a start point, an end point and a
   * synthesised interpolation: curvature and velocity are the human's who
   * recorded it, not a synthesised Bézier. Normalised 0..1, same rule as
   * `tapNorm`/`swipeNorm` above; the core maps to device pixels exactly as
   * manual input already does. Rejects with `E_GESTURE_UNSUPPORTED` on an
   * engine with no `gesture` method (`AdbInput` — the same engine `swipe()`
   * already degrades to a plain line on, §4.4).
   */
  gesture(samples: NormGestureSample[]): Promise<void>
  /**
   * A tap held for `ms` (plan 94 §3.4, §4.4, F4). Device-pixel, like `tap()`
   * — this is for a PROMOTED selector candidate (plan 94 §3.3), never a raw
   * recorded point (`tapNorm` is that verb). `tap()` keeps its
   * device-configured `tapJitterMs` range; this one NAMES the duration and
   * jitters around it — the jitter's width is the SAME `tapJitterMs` range's
   * own width, recentred on `ms` (so "Human-like touch" still means
   * something for a long-press, not a bit-for-bit identical hold on every
   * repetition of a scheduled recording).
   */
  longPress(target: Selector, ms: number): Promise<void>
  /**
   * A curved, eased swipe (plan 40 §4.4) — under the farm's `natural` timing
   * profile (the default) this rides the gesture engine, so a fast, short
   * swipe produces a real release velocity; `profile: 'instant'` (or an
   * engine that cannot curve) falls back to a straight line, exactly as
   * before plan 40. `curvature`/`easing` override the farm's Timing settings
   * for this call only.
   */
  swipe(from: Point, to: Point, ms?: number, opts?: { curvature?: number; easing?: GestureEasing }): Promise<void>
  /**
   * A controlled drag that ends at low velocity and stops where it is put
   * (plan 40 §3.4, §4.4) — the geometry is derived from the device's current
   * screen size; `distance` defaults to 60% of the relevant viewport axis.
   */
  scroll(opts: { direction: 'up' | 'down' | 'left' | 'right'; distance?: number; from?: Point }): Promise<void>
  /**
   * A short, fast gesture that ends at high velocity and lets the list coast
   * (plan 40 §3.4, §4.4) — `strength` maps to duration and distance.
   */
  fling(opts: { direction: 'up' | 'down' | 'left' | 'right'; strength?: 'soft' | 'normal' | 'hard' }): Promise<void>
  /**
   * M4: `input text` (ASCII-safe); set_text per-elemen = Plan 06. Under the
   * `natural` timing profile (plan 40 §3.2, §4.4) this types one character at
   * a time with a delay in `perCharMs`, so autocomplete, debounced
   * validation, and per-keystroke listeners actually run. `instant: true`
   * (or `profile: 'instant'`) restores the old one-shot delivery — for a
   * long token or a paste target, or when a suite depends on the old timing.
   *
   * Non-ASCII text (plan 90 §3.2, §3.3) routes through the text ladder automatically — the
   * guest agent's keyboard, then scrcpy's unicode-clean `INJECT_TEXT`, then plain ASCII — and
   * rejects (never silently drops a keystroke) when no rung can carry the string.
   * `ScriptTypeResult.via` says which rung actually ran.
   */
  type(text: string, opts?: { perCharMs?: [number, number]; instant?: boolean }): Promise<ScriptTypeResult>
  key(code: KeyCode): Promise<void>
  /**
   * `null` for both a genuine miss AND a selector refused as a viewport-sized
   * container (plan 60 §3.1) — unchanged since before plan 74, so a bundle
   * published earlier keeps running exactly as it did. Use `findDetailed()`
   * to learn WHICH of the two (or "ambiguous" — several matches) it was.
   */
  find(sel: Selector): Promise<UiNode | null>
  /**
   * `find`, but honest about why nothing usable came back (plan 74 §3.4,
   * §4.3): `not-found`, `rejected-oversized` (the selector matched a
   * container filling the screen — retrying will never help), or
   * `ambiguous` (several matches — narrow the selector). For an agent this
   * is the difference between retrying and giving up on the same selector;
   * for a script author it is a better error message.
   */
  findDetailed(sel: Selector): Promise<FindOutcome>
  /**
   * The whole accessibility tree — the same one the Inspect panel renders
   * (plan 60 §3.2). This is how a script reads something the four-shape
   * selector grammar cannot reach: a node carrying a resource id and no text,
   * a value that only makes sense relative to its neighbours, a count of
   * matching rows. Ordinary TypeScript over `node.children` does all of it.
   *
   * **It costs a full dump: 334–584 ms measured on a moto g06 power** (a
   * `find` is ~80 ms by comparison). Fetch it once and walk the result; do
   * not call it per assertion. Nothing stops you paying repeatedly if you
   * mean to — the cost is stated here rather than enforced.
   */
  dump(): Promise<UiNode>
  /** Polls the inspector — rejects with ScriptError('WAITFOR_TIMEOUT') when time runs out. */
  waitFor(sel: Selector, opts?: WaitForOptions): Promise<UiNode>
  /** Raw PNG (without saving an artifact). */
  screenshot(): Promise<Uint8Array>
  app: {
    /**
     * Start the app — bare, at a named activity, or pointed at a URL.
     *
     * `url` is how a browser should be driven: typing an address into the omnibox races Chrome's
     * own autocomplete and produced garbled addresses (`bsssom/dnsom/dns`) that sent whole runs to
     * the wrong page. An intent delivers it exactly, in one call, with nothing to clear first.
     */
    launch(pkg: string, opts?: { activity?: string; url?: string }): Promise<void>
    /**
     * Kill the app. `clearRecents` also removes its cards from the task switcher — `am force-stop`
     * on its own leaves them, so an app a script "closed" still shows up in Android's recents.
     */
    forceStop(pkg: string, opts?: { clearRecents?: boolean }): Promise<void>
  }
  /** Device clipboard get/set over the scrcpy control socket (plan 38 §4.6). */
  clipboard: {
    get(): Promise<string>
    /** `paste` defaults to false — it immediately pastes into the focused field. */
    set(text: string, opts?: { paste?: boolean }): Promise<void>
  }
  /**
   * Install an APK from a server-side artifact (plan 39 §4.6) — never a URL
   * or a filesystem path (§3.5): a script that built its own APK saves it as
   * an artifact first with `ctx.artifact.file()`, then installs that.
   */
  install(opts: { artifactId: string; reinstall?: boolean; grantPermissions?: boolean; allowDowngrade?: boolean }): Promise<{
    package: string | null
    durationMs: number
    output: string
  }>
  /**
   * Push an artifact to a path on the device. `remotePath` must be absolute, with no `..` or shell metacharacters.
   *
   * `mediaScan` (plan 90 §4.6) defaults to `'auto'`: MediaStore is told about the file — `content call
   * --method scan_file`, falling back to `scan_volume` — only when `remotePath` sits under a known media
   * root (`/sdcard/{DCIM,Pictures,Movies,Music,Download}` and their `/storage/emulated/0` spellings). A
   * failed scan never fails the push; the result names which method, if any, actually ran.
   */
  push(opts: { artifactId: string; remotePath: string; mediaScan?: MediaScanMode }): Promise<PushResult>
  /** Pull a file from the device into a new artifact, capped by the farm's `transfer.maxPullBytes`. */
  pull(opts: { remotePath: string }): Promise<{ artifactId: string; bytes: number }>
}

export interface ArtifactApi {
  /** The screenshot is taken IN THE CORE and stored as a job artifact. */
  screenshot(label: string): Promise<void>
  /**
   * Saves bytes (or text) as a job artifact and returns the id it was saved
   * under (plan 115 §3.6, W5) — the bridge between a script that has bytes
   * (say, read out of the workspace) and `ctx.device.push({ artifactId })`,
   * which had no way to reach a freshly-minted artifact before this.
   * Additive: every existing caller ignores the return value already, so
   * nothing published before this plan needs to change.
   */
  file(label: string, data: Uint8Array | string, opts?: { ext?: string }): Promise<{ artifactId: string }>
}

/** One entry as `kv.list` returns it (plan 79 §4.1, §4.4) — a secret's `value` is always `null`
 * here; use `kv.get` for the decrypted plaintext. */
export interface KvListItem {
  key: string
  value: unknown
  secret: boolean
  hint: string | null
  version: number
  expiresAt: number | null
  updatedAt: number
}

export interface KvListResult {
  items: KvListItem[]
  /** Pass back as `cursor` for the next page. `null` when this is the last one. */
  nextCursor: string | null
}

export interface KvSetOptions {
  /** Encrypted at rest and never returned by the HTTP API or a job log — see the SDK README. */
  secret?: boolean
  /**
   * Whether a `secret` write also stores a short display hint — `${first 7}…${last 4}` of the
   * plaintext — on the row (plan 112 step 112.2). Defaults to `true`, which is what you want for
   * an API key with a public prefix: it is how an operator tells two keys apart on the Data
   * screen. Pass `false` for a **credential**: the hint is kept in the clear and returned by every
   * read path, so eleven characters of a password would be visible to anyone holding
   * `plugin.data`.
   *
   * Per write, not per key: pass it on every write of that key, exactly as with `secret`.
   */
  hint?: boolean
  /** Seconds until this value stops being readable — swept lazily, but never returned once past. */
  ttlSec?: number
}

/**
 * The durable key/value store (plan 79) — `ctx.kv.device` is this job's device (keyed on its
 * stableId, not the row that could change on a re-enrol); `ctx.kv.global` is the whole farm. The
 * key is namespaced to this script automatically: a script never types its own namespace, so two
 * scripts choosing the same key cannot collide.
 */
export interface KvApi {
  /** Validates the stored JSON against `schema` before returning it — throws, naming the key, when
   * an older version of this script wrote a shape that no longer matches. `null` when the key (or
   * an unexpired TTL) does not exist. */
  get<T>(key: string, schema: z.ZodType<T>): Promise<T | null>
  /** `get`, without validating the shape — for a caller that genuinely wants `unknown`. */
  getRaw(key: string): Promise<unknown>
  set(key: string, value: unknown, opts?: KvSetOptions): Promise<{ version: number }>
  /** Compare-and-swap: fails (returns `null`, leaves the stored value unchanged) when `expectedVersion`
   * no longer matches — the caller learns it lost a race instead of silently overwriting another
   * writer's value. */
  setIfVersion(key: string, value: unknown, expectedVersion: number, opts?: KvSetOptions): Promise<{ version: number } | null>
  /** Atomic; two overlapping calls never drop one. Defaults `by` to 1. */
  increment(key: string, by?: number): Promise<number>
  /** `false` when the key does not exist, or when `ifVersion` was given and did not match. */
  delete(key: string, opts?: { ifVersion?: number }): Promise<boolean>
  list(opts?: { prefix?: string; limit?: number; cursor?: string }): Promise<KvListResult>
}

export interface JobsListResult {
  items: JobSummary[]
  /** Pass back as `cursor` for the next page. `null` when this is the last one. */
  nextCursor: string | null
  total: number
}

/**
 * `ctx.jobs.trigger()`'s input (plan 81 §3.6, §4.2). `script` is a reference
 * (`name`, `name@version`, or `name@latest`) resolved and pinned the instant
 * `trigger()` runs — publishing a newer version afterward never changes what
 * the queued job runs (§3.4).
 */
export interface TriggerInput {
  script: string
  params?: unknown
  /** Defaults to this job's own device. */
  deviceId?: string
  /** Defaults to 0 — a triggered job never jumps the queue. */
  priority?: number
  /**
   * Omitted, the runtime derives one from this job's own id, attempt, and
   * how many `trigger()` calls have happened so far this attempt — which
   * makes a re-run `finish()` (or a retried `run()` that calls `trigger()`
   * the same number of times) reproduce the SAME key, so the second call
   * dedupes instead of enqueueing a duplicate (§3.3). Set this explicitly
   * only for "enqueue this at most once, ever, across every attempt and
   * every device" — something only the script itself can know.
   */
  key?: string
  /** Defaults to this job's own `expiresAt` — a chain cannot outlive its root's expiry window unless a caller opts out explicitly. Explicit `null` means no expiry. */
  expiresAt?: number | null
}

/** `ctx.jobs.trigger()`'s return. `deduped` is required, never optional, so destructuring it is unavoidable — a script cannot mistake "already queued" for "queued". */
export interface TriggerResult {
  jobId: string
  deduped: boolean
}

/**
 * A running script's own view of the queue on its own device (plan 80,
 * extended by plan 81 §3.6 with `trigger`) — `ctx.jobs.list()` is fixed to
 * `ctx.job.deviceId`; there is no parameter that widens it (§3.2).
 * `params`/`result` are never on a listed `JobSummary` — both are
 * script-authored JSON a neighbouring script must never read directly
 * (§3.3); `resultOf` is the separate, narrow door to a result, and only for
 * a job whose script shares this one's namespace.
 */
export interface JobsApi {
  list(opts?: { status?: JobStatus; limit?: number; cursor?: string }): Promise<JobsListResult>
  /** The most recent job on this device that finished before this one started — not a happens-before guarantee (another device, or a manual run, can interleave). Null on a device's first-ever job. */
  previous(): Promise<JobSummary | null>
  /** Jobs still queued on this device, in claim order. */
  queuedAfter(opts?: { limit?: number }): Promise<JobSummary[]>
  /**
   * `null` for every refusal — not found, a different script's namespace, or
   * not finished yet — never four separate error codes: a script cannot act
   * differently on "foreign namespace" than on "not found", and telling it
   * which would itself disclose that a job exists. The refusal reason is
   * logged parent-side, where an operator can see it.
   */
  resultOf(jobId: string): Promise<unknown | null>
  /**
   * Same door, validated (plan 97 §4.6, §5 step 97.5) — child-side, exactly
   * as `ctx.kv.device.get`/`ctx.kv.global.get` validate against a caller-
   * supplied schema: the server does not know what shape a READING script
   * expects, and should not have to. `null` still covers every refusal
   * (not-found, foreign-namespace, not-finished) alike — those three are
   * unchanged from the unvalidated overload above. Throws, naming the job
   * id and the mismatched path, when the stored result does not match
   * `schema` — the same failure mode `kv.get` already gives a script for a
   * stale shape written by an older version of a neighbouring script.
   */
  resultOf<T>(jobId: string, schema: z.ZodType<T>): Promise<T | null>
  /**
   * Fire-and-forget (plan 81 §3.6): resolves with the new job's id the
   * instant it is QUEUED — never once it runs, never with its result.
   * Rejects (a real throw the script sees, never a null) when the chain is
   * too deep, the chain or this job's own fan-out is at its farm-configured
   * limit, or the target device is missing/blocked/quarantined — a runaway
   * chain is stopped by the system, not by remembering to check a return
   * value.
   */
  trigger(input: TriggerInput): Promise<TriggerResult>
}

export interface ScriptLogger {
  debug(msg: string, fields?: Record<string, unknown>): void
  info(msg: string, fields?: Record<string, unknown>): void
  warn(msg: string, fields?: Record<string, unknown>): void
  error(msg: string, fields?: Record<string, unknown>): void
}

export interface ScriptError {
  code: string
  message: string
  phase: 'prepare' | 'run' | 'finish' | 'timeout'
}

/**
 * What a script handler receives. Since plan 109 step 109.1 this **extends
 * `PluginContext`** rather than re-declaring its own `log`/`kv`: `storage`,
 * `log` and `farm` are the very same members, built by the very same function
 * (`@enkaku/session`'s `buildPluginContext`), so a plugin helper typed
 * `(ctx: PluginContext) => …` accepts a script's context by construction and
 * not by anyone remembering to keep two interfaces in step (plan 109 §3.1,
 * criterion 2).
 *
 * Everything declared below is the honest asymmetry §3.1 names: it needs a
 * claimed device and a job, and therefore exists in a script handler only.
 */
export interface ScriptContext<P = unknown> extends PluginContext {
  device: DeviceApi
  /** Already through params.parse(). */
  params: P
  artifact: ArtifactApi
  job: { id: string; attempt: number; deviceId: string }
  /** Only set when finish runs after a failure. */
  error?: ScriptError
  /**
   * The durable key/value store (plan 79) — `device` for this job's device,
   * `global` for the farm.
   *
   * **This is `ctx.storage` under plan 79's name, and it is literally the
   * same object** (plan 109 §3.1, step 109.1) — never a second store, never a
   * copy. Both names are kept because a bundle already published to a farm
   * compiled `ctx.kv` into its code and there is no publish step that could
   * rewrite it; the overview's §4.3 "replace, never version" exception for
   * data already written to disk is exactly this case.
   */
  kv: { device: KvApi; global: KvApi }
  /** A running script's own view of the queue on its own device (plan 80). */
  jobs: JobsApi
  /**
   * A live, unpersisted snapshot of how the run is going (plan 97 §3.7).
   * Coalesced to at most one push per `job.progressIntervalMs`
   * (default 1000ms, min 250, max 10000), last value wins — calling this in a
   * tight loop costs one assignment, never one IPC message per call. Over
   * `RESULT_LIMITS.maxProgressBytes` (4 KiB) the push is dropped with one
   * `warn` log line per job, never truncated into malformed JSON.
   *
   * It is NOT the result: never stored, never validated against `result`'s
   * schema, and never readable by `ctx.jobs.resultOf` or any other job. A
   * result is a commitment; a progress is an observation.
   */
  progress(value: unknown): void
}

/**
 * `unknown` when no result schema is declared — today's behaviour,
 * unchanged (plan 97 §3.2, §4.2, fixes F1/F2). A script that never writes
 * `result: someZodSchema` never sees this type change shape: `R` defaults to
 * `undefined`, and `undefined extends z.ZodTypeAny` is false, so this
 * resolves to the `unknown` branch — exactly what `run` returned before this
 * plan. Declaring `result: someZodSchema` narrows it to `z.infer` of that
 * schema, which is what makes a wrong `run` return value a compile error in
 * the author's own editor (H1).
 */
export type ResultValue<R> = R extends z.ZodTypeAny ? z.infer<R> : unknown

export interface ScriptDefinition<S extends z.ZodTypeAny = z.ZodTypeAny, R extends z.ZodTypeAny | undefined = undefined> {
  id: string
  /** Semver. */
  version: string
  params: S
  /**
   * What a successful run produces (plan 97 §3.2, §4.2, fixes F1/F5).
   * OPTIONAL and always optional — a script that declares nothing keeps
   * `run` returning `Promise<unknown>` and stores its return value exactly
   * as before. There is no deprecation and no plan to make this required: a
   * script that force-stops an app genuinely has nothing to return.
   *
   * Declaring it buys three things: `tsc` checks `run`'s return value
   * against this schema in the author's own editor, before publish, before
   * the farm ever sees it; the farm records whether the value kept the
   * promise (`jobs.result_status`); and the job screen renders values
   * instead of raw JSON. H1 tests that the inference behaves in both
   * directions — declaring nothing costs nothing, declaring something buys
   * the check.
   */
  result?: R
  /**
   * What this script declares about its own execution — memory ceiling,
   * farm-wide concurrency, the SDK contract major (plan 98 §3.2, §4.1).
   * EVERY field is a restriction the script places on ITSELF, never a
   * permission it requests (§3.2 — permanent). `timeout`/`retries` below
   * are folded into this by `definePlugin`
   * (`runtime.timeoutMs ?? timeout`) — declaring both with two different
   * values throws at import time, on the author's own machine, rather than
   * silently picking one (plan 98 §4.2).
   */
  runtime?: RuntimeEnvelope
  /**
   * @deprecated use `runtime.timeoutMs` instead — kept forever (§4.3 of the
   * overview: an author-facing field a published script already used is
   * folded, not broken), never removed.
   *
   * ms per attempt. Wins over the farm's own default whenever it is set
   * (plan 74 §3.1, §3.2) — when it is not, the farm's `job.defaultTimeoutMs`
   * setting applies instead (Settings → Jobs; 60 minutes out of the box).
   * An operator-set `job.maxTimeoutMs` ceiling, if any, can still clamp this
   * — always logged when it does, never silently.
   */
  timeout?: number
  /** @deprecated use `runtime.retries` instead — kept forever, same reasoning as `timeout` above. Extra attempts after a failure; defaults to 0. */
  retries?: number
  prepare?(ctx: ScriptContext<z.infer<S>>): Promise<void>
  /**
   * Return value → `jobs.result`. `Promise<unknown>` when `result` is not
   * declared (today's behaviour, unchanged); checked against `result`'s
   * schema, in the author's own editor, when it is (plan 97 §3.2, §4.2,
   * `ResultValue<R>` above).
   */
  run(ctx: ScriptContext<z.infer<S>>): Promise<ResultValue<R>>
  /**
   * ALWAYS runs — must be stateless and idempotent (see the README): after a
   * timeout kill the core runs it again in a fresh process.
   *
   * Its return value is used ONLY when `run()` did not produce one — i.e.
   * only on the failure path (plan 97 §3.5, §4.2, fixes F7/F8). It is stored
   * as the job's result with `resultStatus: 'partial'` and is NOT validated
   * against `result`'s schema at all: there is no honest lenient schema to
   * check it against, and a consumer that needs a guarantee reads `valid`
   * instead. `Promise<unknown | void>` is additive — every existing `finish`
   * returning nothing (or nothing at all) is unchanged, and `undefined`
   * means what it means today.
   */
  finish?(ctx: ScriptContext<z.infer<S>>): Promise<unknown | void>
  /**
   * Packages this script touches, so a `declared` (or `aggressive`) pre-job
   * reset knows what to stop (plan 35 §4.3). The child reports this in its
   * `ready` message, so the parent learns it without importing the bundle.
   */
  reset?: {
    packages: string[]
    /** `pm clear` as well as force-stop. Destructive — opt in per script. */
    clearData?: boolean
  }
  /**
   * Overrides the DEVICE's input-realism settings for this script's OWN
   * calls (plan 94 §3.6, §4.5, F10). Merged over `DeviceSettings.timing`
   * (falling back to the farm default), field by field — never replacing it
   * wholesale: a compiled recording sets `{ betweenActionMs: [0, 0] }`
   * because it supplies its own recorded gaps (§3.6's composition table),
   * and inherits tap jitter, coordinate jitter and typing cadence from
   * whichever device happens to run it. Reported in the child's `ready`
   * message beside `reset` above, and merged fresh per attempt — never
   * captured once and reused, the same freshness discipline `reset` and
   * `runtime` already get.
   */
  timing?: Partial<TimingSettings>
}
