import type { InputSink, Point, Transport } from '@enkaku/protocol'
import { escapeInputText } from './escape'

/**
 * InputSink `adb-input` — mode 'sdk' (spec §9.1: inject via InputManager,
 * terdeteksi sebagai non-hardware; fallback kasar spec §7.1). Lambat
 * (~50–200ms per perintah), timing kaku, tanpa multi-touch. Default input
 * berpindah ke scrcpy-uhid di Plan 08.
 */
export class AdbInput implements InputSink {
  readonly id = 'adb-input'
  readonly mode = 'sdk' as const

  constructor(private transport: Transport) {}

  async tap(p: Point): Promise<void> {
    await this.transport.exec(`input tap ${Math.round(p.x)} ${Math.round(p.y)}`)
  }

  async swipe(from: Point, to: Point, ms: number): Promise<void> {
    const dur = Math.min(10_000, Math.max(50, Math.round(ms)))
    await this.transport.exec(
      `input swipe ${Math.round(from.x)} ${Math.round(from.y)} ${Math.round(to.x)} ${Math.round(to.y)} ${dur}`,
    )
  }

  async key(code: number): Promise<void> {
    if (!Number.isInteger(code) || code < 0 || code > 320) {
      throw new Error(`keycode invalid: ${code}`)
    }
    await this.transport.exec(`input keyevent ${code}`)
  }

  async text(s: string): Promise<void> {
    await this.transport.exec(`input text ${escapeInputText(s)}`)
  }
}
