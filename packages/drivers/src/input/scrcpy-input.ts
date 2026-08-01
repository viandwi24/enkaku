import type { InputSink, Point } from '@enkaku/protocol'
import { ABSOLUTE_POINTER_DESCRIPTOR, buildPointerReport, type ScrcpySession } from '@enkaku/scrcpy'

const UHID_POINTER_ID = 1

export interface ScrcpyInputDeps {
  session: ScrcpySession
  /** Ukuran layar terkini — dipakai untuk koordinat absolut & normalisasi. */
  screenSize: () => { width: number; height: number }
  onLog?: (level: 'debug' | 'warn', msg: string) => void
}

/**
 * InputSink `scrcpy-sdk` (spec §9.1): inject lewat InputManager. Kompatibel
 * paling luas, tapi event membawa penanda injeksi — detektor app bisa
 * membedakannya dari sentuhan hardware.
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
 * InputSink `scrcpy-uhid` (spec §9.1, default baru): membuat virtual HID
 * device lewat kernel UHID, sehingga dari sisi Android event datang dari
 * *physical input device* — bukan API injeksi. Bekerja wireless.
 *
 * `text()` sengaja tetap lewat jalur inject-text: HID keyboard bersifat
 * layout-dependent sehingga teks non-ASCII tidak andal (trade-off jujur,
 * dicatat di plan 08 §3.8).
 */
export class ScrcpyUhidInput extends ScrcpySdkInput {
  override readonly id: string = 'scrcpy-uhid'
  override readonly mode: InputSink['mode'] = 'uhid'
  private ready = false

  async init(): Promise<void> {
    if (this.ready) return
    this.deps.session.control.uhidCreate(UHID_POINTER_ID, 'Enkaku Pointer', ABSOLUTE_POINTER_DESCRIPTOR)
    this.ready = true
    this.deps.onLog?.('debug', 'UHID pointer absolut terdaftar')
  }

  private norm(p: Point): { xNorm: number; yNorm: number } {
    const { width, height } = this.deps.screenSize()
    return { xNorm: width > 0 ? p.x / width : 0, yNorm: height > 0 ? p.y / height : 0 }
  }

  override async tap(p: Point): Promise<void> {
    await this.init()
    const pos = this.norm(p)
    this.deps.session.control.uhidInput(UHID_POINTER_ID, buildPointerReport({ touching: true, ...pos }))
    await Bun.sleep(40 + Math.random() * 80)
    this.deps.session.control.uhidInput(UHID_POINTER_ID, buildPointerReport({ touching: false, ...pos }))
  }

  override async swipe(from: Point, to: Point, ms: number): Promise<void> {
    await this.init()
    const steps = Math.max(2, Math.round(ms / 16))
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
