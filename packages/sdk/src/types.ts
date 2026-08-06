import type { z } from 'zod'
import type { FindOutcome, JobStatus, JobSummary, KeyCode, Point, Selector, UiNode } from '@enkaku/protocol'

export interface WaitForOptions {
  /** Default 10_000 ms. */
  timeout?: number
  /** Defaults to 1_000 ms — realistic for uiautomator-dump; ui-server (Plan 06) can be far shorter. */
  intervalMs?: number
}

/** A cubic-Bézier gesture's easing (plan 40 §4.1): `easeOutQuad` ends fast (a
 * flick), `easeInOutCubic` (the default) ends slow (a deliberate drag). */
export type GestureEasing = 'linear' | 'easeOutQuad' | 'easeInOutCubic'

export interface DeviceApi {
  /** Selector → find → tap its centre point; { point } → tap directly. */
  tap(target: Selector): Promise<void>
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
   */
  type(text: string, opts?: { perCharMs?: [number, number]; instant?: boolean }): Promise<void>
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
    launch(pkg: string, opts?: { activity?: string }): Promise<void>
    forceStop(pkg: string): Promise<void>
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
  /** Push an artifact to a path on the device. `remotePath` must be absolute, with no `..` or shell metacharacters. */
  push(opts: { artifactId: string; remotePath: string }): Promise<void>
  /** Pull a file from the device into a new artifact, capped by the farm's `transfer.maxPullBytes`. */
  pull(opts: { remotePath: string }): Promise<{ artifactId: string; bytes: number }>
}

export interface ArtifactApi {
  /** The screenshot is taken IN THE CORE and stored as a job artifact. */
  screenshot(label: string): Promise<void>
  file(label: string, data: Uint8Array | string, opts?: { ext?: string }): Promise<void>
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

export interface ScriptContext<P = unknown> {
  device: DeviceApi
  /** Already through params.parse(). */
  params: P
  artifact: ArtifactApi
  log: ScriptLogger
  job: { id: string; attempt: number; deviceId: string }
  /** Only set when finish runs after a failure. */
  error?: ScriptError
  /** The durable key/value store (plan 79) — `device` for this job's device, `global` for the farm. */
  kv: { device: KvApi; global: KvApi }
  /** A running script's own view of the queue on its own device (plan 80). */
  jobs: JobsApi
}

export interface ScriptDefinition<S extends z.ZodTypeAny = z.ZodTypeAny> {
  id: string
  /** Semver. */
  version: string
  params: S
  /**
   * ms per attempt. Wins over the farm's own default whenever it is set
   * (plan 74 §3.1, §3.2) — when it is not, the farm's `job.defaultTimeoutMs`
   * setting applies instead (Settings → Jobs; 60 minutes out of the box).
   * An operator-set `job.maxTimeoutMs` ceiling, if any, can still clamp this
   * — always logged when it does, never silently.
   */
  timeout?: number
  /** Extra attempts after a failure; defaults to 0. */
  retries?: number
  prepare?(ctx: ScriptContext<z.infer<S>>): Promise<void>
  /** Return value → jobs.result. */
  run(ctx: ScriptContext<z.infer<S>>): Promise<unknown>
  /** ALWAYS runs — must be stateless and idempotent (see the README). */
  finish?(ctx: ScriptContext<z.infer<S>>): Promise<void>
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
}
