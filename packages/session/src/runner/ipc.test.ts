import { describe, expect, test } from 'bun:test'
import { DeviceCallSchema } from './ipc'

/**
 * `app.launch`/`app.forceStop` package and activity validation (plan 34 §3.4,
 * §4.3): a package name is not a free string. The regex is belt — it rejects
 * nonsense early with a clear error — the actual injection-safety guarantee
 * is `shellQuote` at the `device-executor.ts` call site (see
 * `device-executor.test.ts`).
 */
describe('DeviceCallSchema — app.launch/app.forceStop package and activity regexes (plan 34 §3.4, §4.3)', () => {
  test('a real package name is accepted', () => {
    const result = DeviceCallSchema.safeParse({ method: 'app.launch', args: { pkg: 'com.example.app' } })
    expect(result.success).toBe(true)
  })

  test('a real package plus a real activity is accepted', () => {
    const result = DeviceCallSchema.safeParse({
      method: 'app.launch',
      args: { pkg: 'com.example.app', activity: '.MainActivity' },
    })
    expect(result.success).toBe(true)
  })

  test('a fully-qualified activity (package.Class) is accepted', () => {
    const result = DeviceCallSchema.safeParse({
      method: 'app.launch',
      args: { pkg: 'com.example.app', activity: 'com.example.app.ui.MainActivity' },
    })
    expect(result.success).toBe(true)
  })

  test('a package with a semicolon is rejected', () => {
    const result = DeviceCallSchema.safeParse({
      method: 'app.launch',
      args: { pkg: 'com.x; touch /data/local/tmp/pwned' },
    })
    expect(result.success).toBe(false)
  })

  test('a package with $(...) command substitution is rejected', () => {
    const result = DeviceCallSchema.safeParse({
      method: 'app.launch',
      args: { pkg: 'com.x$(id)' },
    })
    expect(result.success).toBe(false)
  })

  test('a package with backticks is rejected', () => {
    const result = DeviceCallSchema.safeParse({
      method: 'app.forceStop',
      args: { pkg: 'com.x`id`' },
    })
    expect(result.success).toBe(false)
  })

  test('a package with no dot (not a valid Android package) is rejected', () => {
    const result = DeviceCallSchema.safeParse({ method: 'app.launch', args: { pkg: 'com' } })
    expect(result.success).toBe(false)
  })

  test('an activity with a shell metacharacter is rejected even when pkg is valid', () => {
    const result = DeviceCallSchema.safeParse({
      method: 'app.launch',
      args: { pkg: 'com.example.app', activity: '.Main; rm -rf /' },
    })
    expect(result.success).toBe(false)
  })

  test('app.forceStop rejects the same way app.launch does', () => {
    const result = DeviceCallSchema.safeParse({ method: 'app.forceStop', args: { pkg: 'com.x; id' } })
    expect(result.success).toBe(false)
  })

  test('a missing pkg is rejected', () => {
    const result = DeviceCallSchema.safeParse({ method: 'app.launch', args: {} })
    expect(result.success).toBe(false)
  })
})

/** Plan 40 §4.4: `scroll`/`fling`, plus the new options on `swipe`/`type`. */
describe('DeviceCallSchema — scroll, fling, and swipe/type options (plan 40 §4.4)', () => {
  test('swipe accepts an optional curvature and easing', () => {
    const result = DeviceCallSchema.safeParse({
      method: 'swipe',
      args: { from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, curvature: 0.2, easing: 'easeOutQuad' },
    })
    expect(result.success).toBe(true)
  })

  test('swipe still defaults ms to 300 and works with no options at all (pre-plan-40 shape)', () => {
    const result = DeviceCallSchema.safeParse({ method: 'swipe', args: { from: { x: 0, y: 0 }, to: { x: 1, y: 1 } } })
    expect(result.success).toBe(true)
    if (result.success && result.data.method === 'swipe') expect(result.data.args.ms).toBe(300)
  })

  test('an unknown easing is rejected', () => {
    const result = DeviceCallSchema.safeParse({
      method: 'swipe',
      args: { from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, easing: 'easeInBounce' },
    })
    expect(result.success).toBe(false)
  })

  test('a curvature outside [0, 0.5] is rejected', () => {
    const result = DeviceCallSchema.safeParse({
      method: 'swipe',
      args: { from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, curvature: 0.9 },
    })
    expect(result.success).toBe(false)
  })

  test('type accepts an optional perCharMs and instant', () => {
    const result = DeviceCallSchema.safeParse({ method: 'type', args: { text: 'hi', perCharMs: [10, 20], instant: true } })
    expect(result.success).toBe(true)
  })

  test('type still works with just text (pre-plan-40 shape)', () => {
    const result = DeviceCallSchema.safeParse({ method: 'type', args: { text: 'hi' } })
    expect(result.success).toBe(true)
  })

  test('scroll requires a direction and accepts optional distance/from', () => {
    expect(DeviceCallSchema.safeParse({ method: 'scroll', args: { direction: 'down' } }).success).toBe(true)
    expect(
      DeviceCallSchema.safeParse({ method: 'scroll', args: { direction: 'down', distance: 800, from: { x: 0.5, y: 0.5 } } })
        .success,
    ).toBe(true)
    expect(DeviceCallSchema.safeParse({ method: 'scroll', args: {} }).success).toBe(false)
    expect(DeviceCallSchema.safeParse({ method: 'scroll', args: { direction: 'sideways' } }).success).toBe(false)
  })

  test('fling requires a direction and accepts an optional strength', () => {
    expect(DeviceCallSchema.safeParse({ method: 'fling', args: { direction: 'up' } }).success).toBe(true)
    expect(DeviceCallSchema.safeParse({ method: 'fling', args: { direction: 'up', strength: 'hard' } }).success).toBe(true)
    expect(DeviceCallSchema.safeParse({ method: 'fling', args: { direction: 'up', strength: 'extreme' } }).success).toBe(false)
    expect(DeviceCallSchema.safeParse({ method: 'fling', args: {} }).success).toBe(false)
  })
})
