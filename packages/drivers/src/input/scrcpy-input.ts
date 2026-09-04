import { androidMetaState, type GestureSample, type InputSink, type KeyDescriptor, type KeyMeta, type Point } from '@enkaku/protocol'
import {
  ABSOLUTE_POINTER_DESCRIPTOR,
  buildPointerReport,
  KEYBOARD_REPORT_DESCRIPTOR,
  KeyboardState,
  UHID_KEYBOARD_ID,
  type ScrcpySession,
} from '@enkaku/scrcpy'

const UHID_POINTER_ID = 1
/** How long the kernel and InputReader need before the pointer accepts reports. */
const UHID_SETTLE_MS = 1500
/** The pointer's measured settle value, reused for the keyboard (unmeasured, plan 209 §9 Q2). */
const UHID_KEYBOARD_SETTLE_MS = 1500
/** Same landing quirk as `tap()`: position first, then the touch bit. */
const UHID_LAND_MS = 100

/**
 * The smallest hold that registers on the UHID engine (one 60 Hz input
 * frame) — the default when a caller supplies no `holdMs` at all (plan 209
 * §3.2 D6, MVP 13 A.8). Scripts keep humanised taps by always passing
 * `timing.tapJitterMs` explicitly (`device-executor.ts`); this default is
 * for a caller that omits `holdMs` entirely, which after this plan means a
 * live `input.touch down`/`up` pair, not a synthesised hold.
 */
export const MIN_TAP_HOLD_MS = 16

/**
 * Sample a tap's hold duration from a `[min, max]` range (spec §9.3, §17 —
 * test realism, not evasion: a real finger never holds a tap for exactly the
 * same duration twice) when the caller supplies one; otherwise the smallest
 * hold that registers (`MIN_TAP_HOLD_MS`). `rng` is injectable so callers get
 * deterministic output under test instead of this reaching for
 * `Math.random()` itself. Exported (like `buildGesturePath`'s own `rng`) so
 * the sampling itself can be asserted directly, without paying for a real
 * `Bun.sleep` in a test.
 */
export function sampleHoldMs(opts?: { holdMs?: [number, number]; rng?: () => number }): number {
  if (!opts?.holdMs) return MIN_TAP_HOLD_MS
  const [lo, hi] = opts.holdMs
  const rng = opts.rng ?? Math.random
  return lo + rng() * Math.max(0, hi - lo)
}

export interface ScrcpyInputDeps {
  session: ScrcpySession
  /** Current screen size — used for absolute coordinates and normalisation. */
  screenSize: () => { width: number; height: number }
  onLog?: (level: 'debug' | 'warn', msg: string) => void
}

/**
 * The `scrcpy-sdk` InputSink (spec §9.1): injects via InputManager. Its compatibility is
 * the broadest, but the events carry an injection marker — an app's detector
 * can tell them apart from a hardware touch.
 */
export class ScrcpySdkInput implements InputSink {
  readonly id: string = 'scrcpy-sdk'
  readonly mode: InputSink['mode'] = 'sdk'

  constructor(protected deps: ScrcpyInputDeps) {}

  async tap(p: Point, opts?: { holdMs?: [number, number]; rng?: () => number }): Promise<void> {
    const { width, height } = this.deps.screenSize()
    this.deps.session.control.injectTouch('down', p.x, p.y, width, height)
    await Bun.sleep(sampleHoldMs(opts))
    this.deps.session.control.injectTouch('up', p.x, p.y, width, height)
  }

  async swipe(from: Point, to: Point, ms: number): Promise<void> {
    const { width, height } = this.deps.screenSize()
    const steps = Math.max(2, Math.round(ms / 16))
    this.deps.session.control.injectTouch('down', from.x, from.y, width, height)
    for (let i = 1; i <= steps; i++) {
      const t = i / steps
      this.deps.session.control.injectTouch(
        'move',
        from.x + (to.x - from.x) * t,
        from.y + (to.y - from.y) * t,
        width,
        height,
      )
      await Bun.sleep(ms / steps)
    }
    this.deps.session.control.injectTouch('up', to.x, to.y, width, height)
  }

  async key(code: number): Promise<void> {
    this.deps.session.control.injectKeycode('down', code)
    await Bun.sleep(30)
    this.deps.session.control.injectKeycode('up', code)
  }

  async text(s: string): Promise<void> {
    this.deps.session.control.injectText(s)
  }

  /**
   * Play a sampled gesture (plan 40 §4.1, §4.2): one touch-move control
   * message per sample, paced by each sample's own `atMs` — the control
   * socket handles this easily (§8: at most 60 samples per gesture, well
   * under video-adjacent traffic).
   */
  async gesture(samples: GestureSample[]): Promise<void> {
    const { width, height } = this.deps.screenSize()
    const first = samples[0]
    if (!first) return
    this.deps.session.control.injectTouch('down', first.x, first.y, width, height)
    let prevAtMs = first.atMs
    for (let i = 1; i < samples.length - 1; i++) {
      const s = samples[i]
      if (!s) continue
      const wait = s.atMs - prevAtMs
      if (wait > 0) await Bun.sleep(wait)
      this.deps.session.control.injectTouch('move', s.x, s.y, width, height)
      prevAtMs = s.atMs
    }
    const last = samples[samples.length - 1]!
    const wait = last.atMs - prevAtMs
    if (samples.length > 1 && wait > 0) await Bun.sleep(wait)
    this.deps.session.control.injectTouch('up', last.x, last.y, width, height)
  }

  /**
   * Per-character typing (plan 40 §4.1, §4.2), so autocomplete, debounced
   * validation, and per-keystroke listeners actually run. Iterates by
   * Unicode code point (`for...of`), not index, so a surrogate pair is sent
   * as one character rather than being split.
   */
  async typeText(text: string, opts: { perCharMs: [number, number]; rng?: () => number }): Promise<void> {
    const rng = opts.rng ?? Math.random
    const [lo, hi] = opts.perCharMs
    for (const ch of text) {
      this.deps.session.control.injectText(ch)
      const delay = lo + rng() * Math.max(0, hi - lo)
      if (delay > 0) await Bun.sleep(delay)
    }
  }

  async touch(action: 'down' | 'move' | 'up', p: Point, pointerId: number): Promise<void> {
    const { width, height } = this.deps.screenSize()
    this.deps.session.control.injectTouch(action, p.x, p.y, width, height, BigInt(pointerId))
  }

  async scroll(p: Point, hDelta: number, vDelta: number): Promise<void> {
    const { width, height } = this.deps.screenSize()
    this.deps.session.control.injectScroll(p.x, p.y, width, height, hDelta, vDelta)
  }

  async pinch(opts: { center: Point; radiusFromPx: number; radiusToPx: number; durationMs: number }): Promise<void> {
    const { width, height } = this.deps.screenSize()
    const steps = Math.max(2, Math.round(opts.durationMs / 16))
    const at = (r: number) => [{ x: opts.center.x, y: opts.center.y - r }, { x: opts.center.x, y: opts.center.y + r }] as const
    const [a0, b0] = at(opts.radiusFromPx)
    this.deps.session.control.injectTouch('down', a0.x, a0.y, width, height, 0n)
    this.deps.session.control.injectTouch('down', b0.x, b0.y, width, height, 1n)
    for (let i = 1; i <= steps; i++) {
      const r = opts.radiusFromPx + (opts.radiusToPx - opts.radiusFromPx) * (i / steps)
      const [a, b] = at(r)
      this.deps.session.control.injectTouch('move', a.x, a.y, width, height, 0n)
      this.deps.session.control.injectTouch('move', b.x, b.y, width, height, 1n)
      await Bun.sleep(opts.durationMs / steps)
    }
    const [a1, b1] = at(opts.radiusToPx)
    this.deps.session.control.injectTouch('up', a1.x, a1.y, width, height, 0n)
    this.deps.session.control.injectTouch('up', b1.x, b1.y, width, height, 1n)
  }

  async keyDown(key: KeyDescriptor, meta: KeyMeta): Promise<void> {
    this.deps.session.control.injectKeycode('down', key.androidKeycode, androidMetaState(meta))
  }

  async keyUp(key: KeyDescriptor, meta: KeyMeta): Promise<void> {
    this.deps.session.control.injectKeycode('up', key.androidKeycode, androidMetaState(meta))
  }

  async releaseKeys(): Promise<void> {}
}

/**
 * The `scrcpy-uhid` InputSink (spec §9.1, the new default): creates a virtual HID
 * device through the kernel's UHID, so from Android's side the events arrive
 * *physical input device* — bukan API injeksi. Bekerja wireless.
 *
 * `text()` deliberately stays on the inject-text path: an HID keyboard is
 * layout-dependent, so non-ASCII text is unreliable (an honest trade-off,
 * dicatat di plan 08 §3.8).
 */
export class ScrcpyUhidInput extends ScrcpySdkInput {
  override readonly id: string = 'scrcpy-uhid'
  override readonly mode: InputSink['mode'] = 'uhid'
  private ready: Promise<void> | null = null
  private keyboardReady: Promise<void> | null = null
  private readonly keyboard = new KeyboardState()

  /**
   * Register the virtual pointer, then give the device a moment to bring it up.
   *
   * UHID_CREATE is fire-and-forget: the kernel creates the input device and
   * Android's InputReader has to notice it. A report sent in the same
   * millisecond arrives before anything is listening and is dropped in
   * silence, so the first tap of a session went missing — intermittently,
   * which is worse than never working.
   *
   * The promise is cached rather than a boolean: a tap that lands while the
   * pointer is still settling has to wait for it, not sail past a flag that
   * was set before the wait even started.
   */
  init(): Promise<void> {
    this.ready ??= (async () => {
      this.deps.session.control.uhidCreate(UHID_POINTER_ID, 'Enkaku Pointer', ABSOLUTE_POINTER_DESCRIPTOR)
      await Bun.sleep(UHID_SETTLE_MS)
      this.deps.onLog?.('debug', 'absolute UHID pointer registered')
    })()
    return this.ready
  }

  private norm(p: Point): { xNorm: number; yNorm: number } {
    const { width, height } = this.deps.screenSize()
    return { xNorm: width > 0 ? p.x / width : 0, yNorm: height > 0 ? p.y / height : 0 }
  }

  override async tap(p: Point, opts?: { holdMs?: [number, number]; rng?: () => number }): Promise<void> {
    await this.init()
    const pos = this.norm(p)
    // Move to the target before touching down. An absolute pointer whose first
    // ever report already has the touch bit set gives Android a down with no
    // prior position, and it is dropped — the tap is delivered and nothing
    // happens. Landing the position first makes the down unambiguous.
    this.deps.session.control.uhidInput(UHID_POINTER_ID, buildPointerReport({ touching: false, ...pos }))
    await Bun.sleep(100)
    this.deps.session.control.uhidInput(UHID_POINTER_ID, buildPointerReport({ touching: true, ...pos }))
    await Bun.sleep(sampleHoldMs(opts))
    this.deps.session.control.uhidInput(UHID_POINTER_ID, buildPointerReport({ touching: false, ...pos }))
  }

  override async swipe(from: Point, to: Point, ms: number): Promise<void> {
    await this.init()
    const steps = Math.max(2, Math.round(ms / 16))
    // Same as tap(): land the position before the touch bit goes up.
    this.deps.session.control.uhidInput(UHID_POINTER_ID, buildPointerReport({ touching: false, ...this.norm(from) }))
    await Bun.sleep(100)
    this.deps.session.control.uhidInput(UHID_POINTER_ID, buildPointerReport({ touching: true, ...this.norm(from) }))
    for (let i = 1; i <= steps; i++) {
      const t = i / steps
      const point = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }
      this.deps.session.control.uhidInput(UHID_POINTER_ID, buildPointerReport({ touching: true, ...this.norm(point) }))
      await Bun.sleep(ms / steps)
    }
    this.deps.session.control.uhidInput(UHID_POINTER_ID, buildPointerReport({ touching: false, ...this.norm(to) }))
  }

  /**
   * Play a sampled gesture over the UHID pointer (plan 40 §4.1, §4.2) — one
   * touch-move report per sample, paced by each sample's own `atMs`. Same
   * "land the position before the touch bit goes up" quirk as `tap`/`swipe`
   * above: an absolute pointer's first-ever report already carrying the
   * touch bit gives Android a down with no prior position, and it is dropped.
   */
  override async gesture(samples: GestureSample[]): Promise<void> {
    await this.init()
    const first = samples[0]
    if (!first) return
    this.deps.session.control.uhidInput(UHID_POINTER_ID, buildPointerReport({ touching: false, ...this.norm(first) }))
    await Bun.sleep(100)
    this.deps.session.control.uhidInput(UHID_POINTER_ID, buildPointerReport({ touching: true, ...this.norm(first) }))
    let prevAtMs = first.atMs
    for (let i = 1; i < samples.length - 1; i++) {
      const s = samples[i]
      if (!s) continue
      const wait = s.atMs - prevAtMs
      if (wait > 0) await Bun.sleep(wait)
      this.deps.session.control.uhidInput(UHID_POINTER_ID, buildPointerReport({ touching: true, ...this.norm(s) }))
      prevAtMs = s.atMs
    }
    const last = samples[samples.length - 1]!
    const wait = last.atMs - prevAtMs
    if (samples.length > 1 && wait > 0) await Bun.sleep(wait)
    this.deps.session.control.uhidInput(UHID_POINTER_ID, buildPointerReport({ touching: false, ...this.norm(last) }))
  }

  /** Registers the virtual keyboard once (MVP 08 §1.2: lazily on the first key, destroyed with the session). */
  prepareKeyboard(): Promise<void> {
    this.keyboardReady ??= (async () => {
      this.deps.session.control.uhidCreate(UHID_KEYBOARD_ID, 'Enkaku Keyboard', KEYBOARD_REPORT_DESCRIPTOR)
      await Bun.sleep(UHID_KEYBOARD_SETTLE_MS)
      this.deps.onLog?.('debug', 'UHID keyboard registered')
    })()
    return this.keyboardReady
  }

  override async keyDown(key: KeyDescriptor, meta: KeyMeta): Promise<void> {
    await this.prepareKeyboard()
    this.repairModifiers(meta)
    const report = this.keyboard.press(key.hidUsage)
    if (report) this.deps.session.control.uhidInput(UHID_KEYBOARD_ID, report)
  }

  override async keyUp(key: KeyDescriptor, _meta: KeyMeta): Promise<void> {
    await this.prepareKeyboard()
    const report = this.keyboard.release(key.hidUsage)
    if (report) this.deps.session.control.uhidInput(UHID_KEYBOARD_ID, report)
  }

  override async releaseKeys(): Promise<void> {
    if (!this.keyboardReady) return
    await this.keyboardReady
    this.deps.session.control.uhidInput(UHID_KEYBOARD_ID, this.keyboard.releaseAll())
  }

  /** D4: a modifier the browser says is up but this state still holds is a key-up that never arrived. */
  private repairModifiers(meta: KeyMeta): void {
    const pairs: Array<[boolean, number, number]> = [
      [meta.shift, 0xe1, 0xe5],
      [meta.ctrl, 0xe0, 0xe4],
      [meta.alt, 0xe2, 0xe6],
      [meta.meta, 0xe3, 0xe7],
    ]
    for (const [held, left, right] of pairs) {
      if (held) continue
      for (const usage of [left, right]) {
        if (!this.keyboard.isDown(usage)) continue
        const report = this.keyboard.release(usage)
        if (report) this.deps.session.control.uhidInput(UHID_KEYBOARD_ID, report)
      }
    }
  }

  override async touch(action: 'down' | 'move' | 'up', p: Point, pointerId: number): Promise<void> {
    if (pointerId !== 0) return super.touch(action, p, pointerId)
    await this.init()
    const pos = this.norm(p)
    if (action === 'down') {
      // Same landing quirk as tap(): position first, then the touch bit.
      this.deps.session.control.uhidInput(UHID_POINTER_ID, buildPointerReport({ touching: false, ...pos }))
      await Bun.sleep(UHID_LAND_MS)
      this.deps.session.control.uhidInput(UHID_POINTER_ID, buildPointerReport({ touching: true, ...pos }))
      return
    }
    this.deps.session.control.uhidInput(UHID_POINTER_ID, buildPointerReport({ touching: action === 'move', ...pos }))
  }

  /** Session close: UHID_DESTROY both virtual devices, best-effort (the server's death would remove them anyway). */
  async destroy(): Promise<void> {
    if (this.keyboardReady) this.deps.session.control.uhidDestroy(UHID_KEYBOARD_ID)
    if (this.ready) this.deps.session.control.uhidDestroy(UHID_POINTER_ID)
  }
}
