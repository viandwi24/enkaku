import type { InputSink, Point, Transport } from '@enkaku/protocol'
import { escapeInputText } from './escape'

/**
 * InputSink `adb-input` — mode 'sdk' (spec §9.1: inject via InputManager,
 * detectable as non-hardware; the crude fallback of spec §7.1). Slow
 * (~50–200ms per command), rigid timing, no multi-touch. The default input
 * moves to scrcpy-uhid in Plan 08.
 */
export class AdbInput implements InputSink {
  readonly id = 'adb-input'
  readonly mode = 'sdk' as const

  constructor(private transport: Transport) {}

  /**
   * `opts.holdMs` (spec §9.3, §17 — tap-hold jitter for test realism) cannot
   * be honoured here: `input tap` sends its DOWN and UP back-to-back with no
   * duration argument at all, which is exactly the "rigid timing" already
   * called out in this class's docstring above. Unlike `gesture()`, `tap()`
   * is not optional on `InputSink`, so it cannot simply be left absent the
   * way this engine already leaves `gesture()` absent (§3.6) to signal
   * "unsupported" rather than fake it — accepting the option and silently
   * not applying it is the closest honest equivalent for a required method.
   */
  async tap(p: Point, _opts?: { holdMs?: [number, number]; rng?: () => number }): Promise<void> {
    await this.transport.exec(`input tap ${Math.round(p.x)} ${Math.round(p.y)}`, { profile: 'input' })
  }

  async swipe(from: Point, to: Point, ms: number): Promise<void> {
    const dur = Math.min(10_000, Math.max(50, Math.round(ms)))
    await this.transport.exec(
      `input swipe ${Math.round(from.x)} ${Math.round(from.y)} ${Math.round(to.x)} ${Math.round(to.y)} ${dur}`,
      { profile: 'input' },
    )
  }

  async key(code: number): Promise<void> {
    if (!Number.isInteger(code) || code < 0 || code > 320) {
      throw new Error(`keycode invalid: ${code}`)
    }
    await this.transport.exec(`input keyevent ${code}`, { profile: 'input' })
  }

  async text(s: string): Promise<void> {
    await this.transport.exec(`input text ${escapeInputText(s)}`, { profile: 'input' })
  }

  /**
   * Per-character typing (plan 40 §3.6, §4.2): `input text` per character
   * works, just slowly — unlike a curved gesture, there is no protocol
   * limitation here, so `AdbInput` implements this one.
   */
  async typeText(text: string, opts: { perCharMs: [number, number]; rng?: () => number }): Promise<void> {
    const rng = opts.rng ?? Math.random
    const [lo, hi] = opts.perCharMs
    for (const ch of text) {
      await this.transport.exec(`input text ${escapeInputText(ch)}`, { profile: 'input' })
      const delay = lo + rng() * Math.max(0, hi - lo)
      if (delay > 0) await Bun.sleep(delay)
    }
  }

  // Deliberately no `gesture()` here (plan 40 §3.6, §4.2): `input swipe`
  // accepts only two points, so a curved path cannot be honoured. Leaving
  // the method absent — rather than defining it and quietly running a
  // straight line — is what lets a caller detect the degradation instead of
  // being lied to. The fallback (a plain `swipe()`) and its one-per-session
  // report both live in `@enkaku/session`'s `createSession`, which is where
  // the input engine is chosen and therefore the only place that knows
  // whether this is a genuine degrade or the `instant` profile asking for a
  // straight line on purpose.
}
