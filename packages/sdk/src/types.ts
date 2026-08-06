import type { z } from 'zod'
import type { FindOutcome, KeyCode, Point, Selector, UiNode } from '@enkaku/protocol'

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
