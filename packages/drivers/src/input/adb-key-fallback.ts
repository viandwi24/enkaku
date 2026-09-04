import type { GestureSample, InputSink, KeyDescriptor, KeyMeta, Point, Transport } from '@enkaku/protocol'
import { AdbInput } from './adb-input'

/**
 * Keycodes scrcpy's injection does not deliver, measured on a moto g06 power
 * (Android 15): the control message arrives, the server accepts it, and the
 * volume never moves. `adb shell input keyevent` on the same device and the
 * same keycode works every time, so the difference is in how Android's window
 * policy treats an injected key rather than in anything we send.
 *
 * Navigation and text keys are unaffected — Back, Home and Recents all arrive
 * through scrcpy — so only these take the slower path.
 */
const VOLUME_KEYS = new Set([
  24, // VOLUME_UP
  25, // VOLUME_DOWN
  164, // VOLUME_MUTE
])

/**
 * Wrap an InputSink so the keys scrcpy cannot deliver go over adb instead.
 *
 * Everything else keeps the fast path. The alternative was a volume button in
 * the UI that quietly does nothing, which is worse than no button at all.
 */
export function withAdbKeyFallback(primary: InputSink, transport: Transport): InputSink {
  const adb = new AdbInput(transport)
  return {
    id: primary.id,
    mode: primary.mode,
    tap: (p: Point, opts?: { holdMs?: [number, number]; rng?: () => number }) => primary.tap(p, opts),
    swipe: (from: Point, to: Point, ms: number) => primary.swipe(from, to, ms),
    text: (s: string) => primary.text(s),
    key: (code: number) => (VOLUME_KEYS.has(code) ? adb.key(code) : primary.key(code)),
    // Plan 40 §4.2: `gesture`/`typeText` are OPTIONAL on `InputSink`, so they
    // are attached here only when the primary engine actually has them —
    // wrapping an absent method in a function would turn "unsupported" (a
    // missing key) into "supported, does nothing" (a present key that always
    // no-ops), which is exactly the silent-lie shape plan 40 §3.6 rejects.
    ...(primary.gesture ? { gesture: (samples: GestureSample[]) => primary.gesture!(samples) } : {}),
    ...(primary.typeText
      ? { typeText: (text: string, opts: { perCharMs: [number, number]; rng?: () => number }) => primary.typeText!(text, opts) }
      : {}),
    // Plan 209 §4.7: same rule as `gesture`/`typeText` — attach only when the
    // primary actually has the verb, so an `AdbInput` primary yields a façade
    // without any of these rather than a silent no-op.
    ...(primary.touch ? { touch: (action: 'down' | 'move' | 'up', p: Point, pointerId: number) => primary.touch!(action, p, pointerId) } : {}),
    ...(primary.scroll ? { scroll: (p: Point, h: number, v: number) => primary.scroll!(p, h, v) } : {}),
    ...(primary.pinch
      ? { pinch: (opts: { center: Point; radiusFromPx: number; radiusToPx: number; durationMs: number }) => primary.pinch!(opts) }
      : {}),
    ...(primary.keyDown ? { keyDown: (key: KeyDescriptor, meta: KeyMeta) => primary.keyDown!(key, meta) } : {}),
    ...(primary.keyUp ? { keyUp: (key: KeyDescriptor, meta: KeyMeta) => primary.keyUp!(key, meta) } : {}),
    ...(primary.releaseKeys ? { releaseKeys: () => primary.releaseKeys!() } : {}),
    ...(primary.prepareKeyboard ? { prepareKeyboard: () => primary.prepareKeyboard!() } : {}),
  }
}
