import type { InputSink, Point } from '@enkaku/protocol'
import { ABSOLUTE_POINTER_DESCRIPTOR, buildPointerReport, type ScrcpySession } from '@enkaku/scrcpy'

const UHID_POINTER_ID = 1
/** How long the kernel and InputReader need before the pointer accepts reports. */
const UHID_SETTLE_MS = 1500

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

  async tap(p: Point): Promise<void> {
    const { width, height } = this.deps.screenSize()
    this.deps.session.control.injectTouch('down', p.x, p.y, width, height)
    await Bun.sleep(40 + Math.random() * 80)
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

  override async tap(p: Point): Promise<void> {
    await this.init()
    const pos = this.norm(p)
    // Move to the target before touching down. An absolute pointer whose first
    // ever report already has the touch bit set gives Android a down with no
    // prior position, and it is dropped — the tap is delivered and nothing
    // happens. Landing the position first makes the down unambiguous.
    this.deps.session.control.uhidInput(UHID_POINTER_ID, buildPointerReport({ touching: false, ...pos }))
    await Bun.sleep(100)
    this.deps.session.control.uhidInput(UHID_POINTER_ID, buildPointerReport({ touching: true, ...pos }))
    await Bun.sleep(40 + Math.random() * 80)
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
}
