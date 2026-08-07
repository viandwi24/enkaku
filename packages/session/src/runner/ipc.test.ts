import { describe, expect, test } from 'bun:test'
import { ChildToParentSchema, DeviceCallSchema, JobsCallSchema, ParentToChildSchema } from './ipc'

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

/** Plan 60 §4.2: `dump` crosses the same IPC boundary as every other device call. */
describe('DeviceCallSchema — dump (plan 60 §4.2)', () => {
  test('a dump call takes no arguments', () => {
    const result = DeviceCallSchema.safeParse({ method: 'dump', args: {} })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.method).toBe('dump')
  })

  test('the tree comes back through the parent’s reply, not through a schema of its own', () => {
    // `dump` is answered by `device.result`, whose `value` is `z.unknown()` —
    // the same channel `find` already uses. A UiNode is JSON, so a tree with
    // children round-trips unchanged.
    const tree = {
      resourceId: '',
      text: '',
      desc: '',
      className: 'android.widget.FrameLayout',
      packageName: 'com.android.chrome',
      bounds: { left: 0, top: 0, right: 720, bottom: 1640 },
      clickable: false,
      enabled: true,
      focused: false,
      index: 0,
      children: [
        {
          resourceId: 'lite-your-ip-value',
          text: '',
          desc: '',
          className: 'android.view.View',
          packageName: 'com.android.chrome',
          bounds: { left: 48, top: 620, right: 672, bottom: 700 },
          clickable: false,
          enabled: true,
          focused: false,
          index: 0,
          children: [],
        },
      ],
    }
    const parsed = ParentToChildSchema.safeParse({ t: 'device.result', callId: 'c1', ok: true, value: tree })
    expect(parsed.success).toBe(true)
    if (parsed.success && parsed.data.t === 'device.result') expect(parsed.data.value).toEqual(tree)
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

/** `ctx.jobs`'s `jobs.call`/`jobs.result` (plan 80 §4.2) — the same `{ t, callId }` framing `kv.call`/`kv.result` already use. */
describe('JobsCallSchema and its framing on ChildToParentSchema/ParentToChildSchema (plan 80 §4.2)', () => {
  test('list accepts no arguments, or status/limit/cursor', () => {
    expect(JobsCallSchema.safeParse({ method: 'list' }).success).toBe(true)
    expect(JobsCallSchema.safeParse({ method: 'list', status: 'queued', limit: 10, cursor: 'abc' }).success).toBe(true)
    expect(JobsCallSchema.safeParse({ method: 'list', status: 'bogus' }).success).toBe(false)
  })

  test('previous takes no arguments', () => {
    expect(JobsCallSchema.safeParse({ method: 'previous' }).success).toBe(true)
  })

  test('queuedAfter accepts an optional limit', () => {
    expect(JobsCallSchema.safeParse({ method: 'queuedAfter' }).success).toBe(true)
    expect(JobsCallSchema.safeParse({ method: 'queuedAfter', limit: 5 }).success).toBe(true)
    expect(JobsCallSchema.safeParse({ method: 'queuedAfter', limit: -1 }).success).toBe(false)
  })

  test('resultOf requires a jobId', () => {
    expect(JobsCallSchema.safeParse({ method: 'resultOf', jobId: 'j1' }).success).toBe(true)
    expect(JobsCallSchema.safeParse({ method: 'resultOf' }).success).toBe(false)
  })

  /** `trigger` (plan 81 §4.2) — `script` must be a real ref shape, `key` is REQUIRED at this wire boundary (§3.3: `jobs-client.ts` always resolves one before sending). */
  describe('trigger', () => {
    test('requires script and key; params/deviceId/priority/expiresAt are optional', () => {
      expect(JobsCallSchema.safeParse({ method: 'trigger', script: 'checkout@1.0.0', key: 'k1' }).success).toBe(true)
      expect(
        JobsCallSchema.safeParse({
          method: 'trigger',
          script: 'checkout@1.0.0',
          key: 'k1',
          params: { a: 1 },
          deviceId: 'd2',
          priority: 3,
          expiresAt: 500,
        }).success,
      ).toBe(true)
      expect(JobsCallSchema.safeParse({ method: 'trigger', script: 'checkout@1.0.0' }).success).toBe(false) // no key
      expect(JobsCallSchema.safeParse({ method: 'trigger', key: 'k1' }).success).toBe(false) // no script
    })

    test('script must match the ScriptRef shape (name@version or name@latest, plan 62)', () => {
      expect(JobsCallSchema.safeParse({ method: 'trigger', script: 'checkout@latest', key: 'k1' }).success).toBe(true)
      expect(JobsCallSchema.safeParse({ method: 'trigger', script: 'tiktok/warmup@1.2.0', key: 'k1' }).success).toBe(true)
      expect(JobsCallSchema.safeParse({ method: 'trigger', script: 'not-a-ref', key: 'k1' }).success).toBe(false)
    })

    test('expiresAt accepts null explicitly (no expiry) as well as a number', () => {
      expect(JobsCallSchema.safeParse({ method: 'trigger', script: 'checkout@1.0.0', key: 'k1', expiresAt: null }).success).toBe(true)
    })

    test('a jobs.call { method: trigger } frames onto ChildToParentSchema like every other jobs.call', () => {
      const parsed = ChildToParentSchema.safeParse({ t: 'jobs.call', callId: 'c1', method: 'trigger', script: 'checkout@1.0.0', key: 'k1' })
      expect(parsed.success).toBe(true)
      if (parsed.success && parsed.data.t === 'jobs.call' && parsed.data.method === 'trigger') {
        expect(parsed.data.script).toBe('checkout@1.0.0')
      }
    })
  })

  test('a jobs.call frames onto ChildToParentSchema exactly like kv.call/device.call do', () => {
    const parsed = ChildToParentSchema.safeParse({ t: 'jobs.call', callId: 'c1', method: 'previous' })
    expect(parsed.success).toBe(true)
    if (parsed.success && parsed.data.t === 'jobs.call') expect(parsed.data.method).toBe('previous')
  })

  test('a jobs.result reply round-trips an arbitrary JobSummary-shaped value', () => {
    const value = { jobId: 'j1', status: 'success' }
    const parsed = ParentToChildSchema.safeParse({ t: 'jobs.result', callId: 'c1', ok: true, value })
    expect(parsed.success).toBe(true)
    if (parsed.success && parsed.data.t === 'jobs.result') expect(parsed.data.value).toEqual(value)
  })

  test('a jobs.result refusal carries a code and message, never the value key', () => {
    const parsed = ParentToChildSchema.safeParse({
      t: 'jobs.result',
      callId: 'c1',
      ok: false,
      error: { code: 'E_JOBS_UNAVAILABLE', message: 'not available' },
    })
    expect(parsed.success).toBe(true)
    if (parsed.success && parsed.data.t === 'jobs.result') {
      expect(parsed.data.error?.code).toBe('E_JOBS_UNAVAILABLE')
      expect(parsed.data.value).toBeUndefined()
    }
  })
})

describe('app.launch carries a url across the IPC boundary (regression)', () => {
  // The url was added to the wire schema and to `DeviceApi`, but the child's own marshalling still
  // forwarded only `activity` — so it typechecked, published, and dropped the address in transit.
  // The executor received a bare launch, Chrome sat on the new-tab page, and the run failed
  // complaining about the page rather than about the field that never arrived.
  test('the wire schema accepts a url', () => {
    const parsed = DeviceCallSchema.parse({
      method: 'app.launch',
      args: { pkg: 'com.android.chrome', url: 'https://whoer.net' },
    })
    expect(parsed).toEqual({ method: 'app.launch', args: { pkg: 'com.android.chrome', url: 'https://whoer.net' } })
  })

  test('a non-http scheme is refused rather than shelled out', () => {
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'https://x.test/a;rm -rf /']) {
      expect(() => DeviceCallSchema.parse({ method: 'app.launch', args: { pkg: 'com.android.chrome', url } })).toThrow()
    }
  })
})

describe('app.forceStop can clear the recents card (regression)', () => {
  // `am force-stop` kills the process and leaves the task behind — verified on hardware: process
  // dead, nine recents entries still listed. The flag has to survive the IPC hop to matter, which
  // is exactly the layer `app.launch`'s `url` was dropped at.
  test('clearRecents is carried on the wire', () => {
    expect(
      DeviceCallSchema.parse({ method: 'app.forceStop', args: { pkg: 'com.x.y', clearRecents: true } }),
    ).toEqual({ method: 'app.forceStop', args: { pkg: 'com.x.y', clearRecents: true } })
  })

  test('it stays optional, so every existing call site is unchanged', () => {
    expect(DeviceCallSchema.parse({ method: 'app.forceStop', args: { pkg: 'com.x.y' } })).toEqual({
      method: 'app.forceStop',
      args: { pkg: 'com.x.y' },
    })
  })
})
