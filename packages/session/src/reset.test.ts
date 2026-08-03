import { describe, expect, test } from 'bun:test'
import { parseForegroundPackages, resetDevice, type ResetPlan } from './reset'
import type { DeviceSession } from './session'

type ExecImpl = (cmd: string, opts?: { signal?: AbortSignal }) => Promise<string>

/** A fake `DeviceSession` that only needs `transport.exec` for `resetDevice`. */
function fakeSession(exec: ExecImpl): DeviceSession {
  return {
    transport: { exec, execOut: async () => new Uint8Array() },
  } as unknown as DeviceSession
}

/** Records every command issued, and answers from a prefix→output map. */
function recordingSession(responses: Record<string, string> = {}) {
  const calls: string[] = []
  const session = fakeSession(async (cmd) => {
    calls.push(cmd)
    for (const [prefix, out] of Object.entries(responses)) {
      if (cmd.startsWith(prefix)) return out
    }
    return ''
  })
  return { session, calls }
}

describe('resetDevice — command sequence per policy (plan 35 §4.2, §7)', () => {
  test('"none" issues no commands at all — reproduces today\'s behaviour exactly (acceptance #4)', async () => {
    const { session, calls } = recordingSession()
    const outcome = await resetDevice(session, { policy: 'none' }, { timeoutMs: 15_000 })
    expect(calls).toEqual([])
    expect(outcome).toEqual({ applied: [], warnings: [], durationMs: outcome.durationMs })
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0)
  })

  test('"home": two BACKs, the HOME intent, then a keyguard probe — no dismiss when there is no keyguard', async () => {
    const { session, calls } = recordingSession({ 'dumpsys window': 'isKeyguardShowing=false' })
    const outcome = await resetDevice(session, { policy: 'home' }, { timeoutMs: 15_000 })
    expect(calls).toEqual([
      'input keyevent KEYCODE_BACK',
      'input keyevent KEYCODE_BACK',
      'am start -a android.intent.action.MAIN -c android.intent.category.HOME',
      'dumpsys window | grep -m1 isKeyguardShowing',
    ])
    expect(outcome.warnings).toEqual([])
    expect(outcome.applied).toContain('home')
  })

  test('"home": dismisses a swipe-only keyguard when dumpsys reports one showing', async () => {
    const { session, calls } = recordingSession({ 'dumpsys window': 'isKeyguardShowing=true' })
    await resetDevice(session, { policy: 'home' }, { timeoutMs: 15_000 })
    expect(calls).toContain('wm dismiss-keyguard')
  })

  test('"declared" adds a force-stop per declared package, after the home sequence', async () => {
    const { session, calls } = recordingSession({ 'dumpsys window': 'isKeyguardShowing=false' })
    const plan: ResetPlan = { policy: 'declared', packages: ['com.example.app'] }
    await resetDevice(session, plan, { timeoutMs: 15_000 })
    expect(calls.slice(-1)).toEqual([`am force-stop 'com.example.app'`])
  })

  test('"declared" only calls `pm clear` when the script asked for it (acceptance #3)', async () => {
    const { session: withoutClear, calls: callsWithout } = recordingSession()
    await resetDevice(withoutClear, { policy: 'declared', packages: ['com.example.app'] }, { timeoutMs: 15_000 })
    expect(callsWithout.some((c) => c.startsWith('pm clear'))).toBe(false)

    const { session: withClear, calls: callsWith } = recordingSession()
    await resetDevice(withClear, { policy: 'declared', packages: ['com.example.app'], clearData: true }, { timeoutMs: 15_000 })
    expect(callsWith).toEqual(expect.arrayContaining([`am force-stop 'com.example.app'`, `pm clear 'com.example.app'`]))
  })

  test('a package name with a shell metacharacter cannot execute a second command (acceptance #9)', async () => {
    const { session, calls } = recordingSession()
    const evil = 'com.example.app; rm -rf /sdcard'
    await resetDevice(session, { policy: 'declared', packages: [evil] }, { timeoutMs: 15_000 })
    // The whole payload, semicolon included, sits inside a single pair of
    // quotes — never a bare command boundary.
    expect(calls).toContain(`am force-stop '${evil}'`)
    expect(calls.some((c) => c === 'rm -rf /sdcard' || c.includes('\nrm'))).toBe(false)
  })

  test('"aggressive" force-stops a non-system foreground package, but skips the launcher, the IME, and uiautomator', async () => {
    const dumpsys = [
      '  Process LRU list (sorted by adj):',
      '    * Proc #0: pers F /S  trm: 0 1000:system/1000 (fixed)',
      '    * Proc #1: fg   T /T  trm: 0 12345:com.launcher.pkg/u0a10 (top-activity)',
      '    * Proc #2: fg   T /T  trm: 0 12399:com.ime.pkg/u0a11 (top-activity)',
      '    * Proc #3: fg   T /T  trm: 0 12400:com.github.uiautomator/u0a12 (top-activity)',
      '    * Proc #4: fg   T /T  trm: 0 12401:com.example.realapp/u0a50 (top-activity)',
      '    * Proc #5: bg   B /B  trm: 0 12500:com.example.background/u0a60',
    ].join('\n')
    const { session, calls } = recordingSession({
      'dumpsys window': 'isKeyguardShowing=false',
      'cmd package resolve-activity': 'com.launcher.pkg/.MainActivity',
      'settings get secure default_input_method': 'com.ime.pkg/.Service',
      'dumpsys activity processes': dumpsys,
    })
    await resetDevice(session, { policy: 'aggressive' }, { timeoutMs: 15_000 })

    expect(calls).toContain(`am force-stop 'com.example.realapp'`)
    expect(calls).not.toContain(`am force-stop 'com.launcher.pkg'`)
    expect(calls).not.toContain(`am force-stop 'com.ime.pkg'`)
    expect(calls).not.toContain(`am force-stop 'com.github.uiautomator'`)
    // A background (non-foreground) package is never touched either.
    expect(calls).not.toContain(`am force-stop 'com.example.background'`)
  })

  test('"aggressive" still performs the "declared" step for the script\'s own packages first', async () => {
    const { session, calls } = recordingSession({ 'dumpsys activity processes': '' })
    await resetDevice(session, { policy: 'aggressive', packages: ['com.example.declared'] }, { timeoutMs: 15_000 })
    expect(calls).toContain(`am force-stop 'com.example.declared'`)
  })
})

describe('resetDevice — the timeout budget (plan 35 §4.2, acceptance #6)', () => {
  test('exceeding resetTimeoutMs returns a partial outcome, and no later step is even attempted', async () => {
    const calls: string[] = []
    // Models a real adb queue that honours the abort signal: the in-flight
    // call rejects the moment the deadline fires, rather than running to
    // completion — "does not leave a command in flight".
    const session = fakeSession(
      (cmd, opts) =>
        new Promise<string>((resolve, reject) => {
          calls.push(cmd)
          const t = setTimeout(() => resolve(''), 200)
          opts?.signal?.addEventListener('abort', () => {
            clearTimeout(t)
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          })
        }),
    )

    const outcome = await resetDevice(session, { policy: 'declared', packages: ['a.one', 'a.two'] }, { timeoutMs: 5 })

    // Only the very first step was ever issued — everything after the
    // deadline is a "skipped" warning, never a fresh command.
    expect(calls).toEqual(['input keyevent KEYCODE_BACK'])
    expect(outcome.applied).toEqual([])
    expect(outcome.warnings[0]).toContain('timed out')
    expect(outcome.warnings.some((w) => w.includes('skipped'))).toBe(true)
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0)
  })
})

describe('parseForegroundPackages', () => {
  test('keeps only packages on a top-activity line running under an app uid', () => {
    const dumpsys = [
      '    * Proc #0: pers F /S  trm: 0 1000:system/1000 (fixed)',
      '    * Proc #1: fg   T /T  trm: 0 12345:com.one.app/u0a10 (top-activity)',
      '    * Proc #2: bg   B /B  trm: 0 12500:com.two.app/u0a11',
    ].join('\n')
    expect(parseForegroundPackages(dumpsys)).toEqual(['com.one.app'])
  })

  test('an empty or unrecognised dump yields no packages', () => {
    expect(parseForegroundPackages('')).toEqual([])
    expect(parseForegroundPackages('garbage\nmore garbage')).toEqual([])
  })
})
