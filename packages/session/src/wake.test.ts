import { describe, expect, test } from 'bun:test'
import type { Transport } from '@enkaku/protocol'
import { wakeDevice } from './wake'
import type { Logger } from './logger'

const silentLog: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLog,
}

const GET_TIMEOUT = 'settings get system screen_off_timeout'
/** `applyScreenOffTimeout`'s write, batched with its read-back into one shell command (plan 226). */
const PUT_TIMEOUT = (ms: string) => `settings put system screen_off_timeout '${ms}'; ${GET_TIMEOUT}`
const GET_STAYON = 'settings get global stay_on_while_plugged_in'
/** `readPowerState` asks for both values in ONE `adb shell`; the answers come back a line each. */
const READ_POWER = `${GET_TIMEOUT}; ${GET_STAYON}`
/** `applyStayOn`'s cheap rung: the write and its read-back in ONE shell command (plan 226). */
const PUT_STAYON = (mask: string) => `settings put global stay_on_while_plugged_in '${mask}'; ${GET_STAYON}`
/** The keycodes `wake.ts` presses, as the numbers both `INJECT_KEYCODE` and `input keyevent` take. */
const WAKEUP = 'input keyevent 224'
const MENU = 'input keyevent 82'
/** The cheap probe `wake.ts` tries first; the full `dumpsys window` is only reached when this prints nothing recognisable. */
const KEYGUARD = 'dumpsys window policy | grep -m1 isKeyguardShowing'
const KEYGUARD_FULL = 'dumpsys window | grep -m1 isKeyguardShowing'
/**
 * The dismiss rung `wake.ts` reaches for FIRST when a keyguard is up, batched
 * with its settle and its re-probe into one adb round trip. `KEYCODE_MENU` is
 * only the floor behind it — it has not dismissed a keyguard since Android 9.
 */
const DISMISS = `wm dismiss-keyguard; sleep 1; ${KEYGUARD}`
/**
 * The shell rung's ONE command (plan 228 §3.3): the wake nudge and the cheap
 * keyguard probe batched into a single adb round trip, because adb access is
 * serialised per device and both of these sit on the critical line between a
 * click and a picture. `injectKey` still splits them — see the tests below.
 */
const WAKE_AND_PROBE = `${WAKEUP}; ${KEYGUARD}`

/** Records every command issued, and answers from a prefix→output map — same shape `reset.test.ts` uses. */
function recordingTransport(responses: Record<string, string> = {}) {
  const calls: string[] = []
  const transport = {
    exec: async (cmd: string) => {
      calls.push(cmd)
      for (const [prefix, out] of Object.entries(responses)) {
        if (cmd.startsWith(prefix)) return { stdout: out, stderr: '', exitCode: 0 }
      }
      return { stdout: '', stderr: '', exitCode: 0 }
    },
  } as unknown as Transport
  return { transport, calls }
}

/**
 * A transport whose `stay_on_while_plugged_in` and `screen_off_timeout` behave
 * like a real device's: a write actually changes what the next read returns.
 * `refuse` names the keys the device silently ignores — the ROM behaviour plan
 * 125 acceptance criterion 4 exists for.
 */
function fakeDevice(initial: { timeout?: string; stayOn?: string; refuse?: Array<'timeout' | 'stayOn'>; refuseDirectStayOn?: boolean } = {}) {
  const state = { timeout: initial.timeout ?? '60000', stayOn: initial.stayOn ?? '0' }
  const refuse = new Set(initial.refuse ?? [])
  // The ROM that `applyStayOn`'s two rungs exist for: a direct write to the
  // key does nothing, and only `svc power stayon` reaches the power service.
  const refuseDirectStayOn = initial.refuseDirectStayOn ?? false
  const calls: string[] = []
  const transport = {
    exec: async (cmd: string) => {
      calls.push(cmd)
      // Checked before the single-key reads: the combined command STARTS WITH
      // `GET_TIMEOUT`, so testing that prefix first would answer one line to a
      // two-line question and silently exercise the fallback path instead of
      // the one the code actually takes on a device.
      if (cmd === READ_POWER) return { stdout: `${state.timeout}\n${state.stayOn}`, stderr: '', exitCode: 0 }
      if (cmd.startsWith(GET_TIMEOUT)) return { stdout: state.timeout, stderr: '', exitCode: 0 }
      if (cmd.startsWith(GET_STAYON)) return { stdout: state.stayOn, stderr: '', exitCode: 0 }
      if (cmd.startsWith('settings put system screen_off_timeout')) {
        // The combined put+get (plan 226). The value arrives `shellQuote`d — a
        // real device shell strips the quotes before `settings` ever sees
        // them, so this fake does too — and the answer is the read-back.
        if (!refuse.has('timeout')) state.timeout = (cmd.split(';')[0]?.split(' ').pop() ?? '').replace(/'/g, '') || state.timeout
        return { stdout: state.timeout, stderr: '', exitCode: 0 }
      }
      if (cmd.startsWith('settings put global stay_on_while_plugged_in')) {
        // The combined put+get: apply the write (unless this ROM refuses the
        // key) and answer with what a read would now return, which is the
        // read-back `applyStayOn` verifies before it decides to skip `svc`.
        if (!refuse.has('stayOn') && !refuseDirectStayOn) state.stayOn = (cmd.split(';')[0]?.split(' ').pop() ?? '').replace(/'/g, '') || state.stayOn
        return { stdout: state.stayOn, stderr: '', exitCode: 0 }
      }
      if (cmd.startsWith('svc power stayon')) {
        const token = cmd.split(' ').pop()
        if (!refuse.has('stayOn')) state.stayOn = token === 'true' ? '7' : token === 'usb' ? '2' : '0'
        return { stdout: '', stderr: '', exitCode: 0 }
      }
      // The batched wake+probe answers exactly like the probe alone would.
      if (cmd.includes('dumpsys window')) return { stdout: 'isKeyguardShowing=false', stderr: '', exitCode: 0 }
      return { stdout: '', stderr: '', exitCode: 0 }
    },
  } as unknown as Transport
  return { transport, calls, state }
}

describe('wakeDevice — the sequence extracted from session.ts (plan 43 §5 step 43.2, §7), extended by plan 125 §3.3', () => {
  test('"off" issues no commands at all — a device opted out is not written to, timeout included', async () => {
    const { transport, calls } = recordingTransport()
    const result = await wakeDevice(transport, { keepAwake: 'off', log: silentLog })
    expect(calls).toEqual([])
    expect(result).toEqual({ screenOffTimeout: 'unchanged', stayOn: 'unchanged', keyguard: null, reason: 'this device is opted out of keeping the screen awake' })
  })

  test('"while-charging": read the current power state, stayon usb, wake, then a keyguard probe — no dismiss when unlocked', async () => {
    const { transport, calls } = fakeDevice({ stayOn: '0' })
    await wakeDevice(transport, { keepAwake: 'while-charging', log: silentLog })
    expect(calls).toEqual([
      READ_POWER,
      PUT_STAYON('2'),
      WAKE_AND_PROBE,
    ])
  })

  test('"always" writes the AC|USB|WIRELESS bitmask, and never reaches `svc`', async () => {
    const { transport, calls } = fakeDevice()
    const result = await wakeDevice(transport, { keepAwake: 'always', log: silentLog })
    expect(calls).toContain(PUT_STAYON('7'))
    expect(calls.some((c) => c.startsWith('svc power stayon'))).toBe(false)
    expect(result.stayOn).toBe('applied')
  })

  test('a device that already holds the value writes nothing at all — neither rung of `applyStayOn` runs', async () => {
    const { transport, calls } = fakeDevice({ stayOn: '7' })
    const result = await wakeDevice(transport, { keepAwake: 'always', log: silentLog })
    expect(calls.some((c) => c.startsWith('svc power stayon'))).toBe(false)
    expect(calls.some((c) => c.startsWith('settings put global stay_on_while_plugged_in'))).toBe(false)
    expect(result.stayOn).toBe('unchanged')
    // The wake itself still happens — the screen may be dark regardless.
    expect(calls).toContain(WAKE_AND_PROBE)
  })

  test('a stayon write the device ignores is `refused`, never `applied` (acceptance criterion 4)', async () => {
    const { transport } = fakeDevice({ stayOn: '0', refuse: ['stayOn'] })
    const result = await wakeDevice(transport, { keepAwake: 'always', log: silentLog })
    expect(result.stayOn).toBe('refused')
    expect(result.reason).toContain('did not accept')
  })

  test('a ROM that ignores the direct write still gets `svc power stayon` — the cheap rung is a shortcut, not a replacement', async () => {
    const { transport, calls } = fakeDevice({ stayOn: '0', refuseDirectStayOn: true })
    const result = await wakeDevice(transport, { keepAwake: 'always', log: silentLog })
    expect(calls).toContain(PUT_STAYON('7'))
    expect(calls).toContain('svc power stayon true')
    expect(result.stayOn).toBe('applied')
  })

  test('an injector takes the key presses, and the shell never sees them', async () => {
    const { transport, calls } = fakeDevice({ stayOn: '7' })
    const injected: number[] = []
    await wakeDevice(transport, {
      keepAwake: 'always',
      injectKey: async (code) => {
        injected.push(code)
        return true
      },
      log: silentLog,
    })
    expect(injected).toEqual([224])
    expect(calls.some((c) => c.startsWith('input keyevent'))).toBe(false)
  })

  test('an injector that cannot send falls back to the shell — a session is an optimisation, never a dependency', async () => {
    const { transport, calls } = fakeDevice({ stayOn: '7' })
    await wakeDevice(transport, { keepAwake: 'always', injectKey: async () => false, log: silentLog })
    // `injectKey` was supplied, so the nudge and the probe stay two commands:
    // there is no adb round trip to batch the keycode with.
    expect(calls).toContain(WAKEUP)
    expect(calls).toContain(KEYGUARD)
  })

  test('an injector that throws is tolerated the same way — the wake still lands over the shell', async () => {
    const { transport, calls } = fakeDevice({ stayOn: '7' })
    await wakeDevice(transport, {
      keepAwake: 'always',
      injectKey: async () => {
        throw new Error('the control socket went away mid-press')
      },
      log: silentLog,
    })
    expect(calls).toContain(WAKEUP)
  })

  test('dismisses a swipe-only keyguard when dumpsys reports one showing, and says so', async () => {
    const { transport, calls } = recordingTransport({
      [WAKE_AND_PROBE]: 'isKeyguardShowing=true',
      [DISMISS]: 'isKeyguardShowing=false',
      [GET_STAYON]: '2',
    })
    const result = await wakeDevice(transport, { keepAwake: 'while-charging', log: silentLog })
    expect(calls).toContain(DISMISS)
    // The floor is not paid on a phone the supported command already unlocked.
    expect(calls).not.toContain(MENU)
    expect(result.keyguard).toBe('dismissed')
    // A dismissed keyguard is not a reason — only one still up is.
    expect(result.reason).not.toContain('lock screen')
  })

  test('an unlocked device is never touched — no dismiss, no KEYCODE_MENU into the launcher', async () => {
    const { transport, calls } = recordingTransport({ [WAKE_AND_PROBE]: 'isKeyguardShowing=false', [GET_STAYON]: '2' })
    const result = await wakeDevice(transport, { keepAwake: 'while-charging', log: silentLog })
    expect(calls).not.toContain(DISMISS)
    expect(calls).not.toContain(MENU)
    expect(result.keyguard).toBe('absent')
  })

  test('a failing command is swallowed (best-effort) and the sequence continues', async () => {
    const calls: string[] = []
    const transport = {
      exec: async (cmd: string) => {
        calls.push(cmd)
        if (cmd === WAKE_AND_PROBE) throw new Error('boom')
        if (cmd === READ_POWER) return { stdout: '60000\n2', stderr: '', exitCode: 0 }
        if (cmd.startsWith(GET_STAYON)) return { stdout: '2', stderr: '', exitCode: 0 }
        if (cmd.startsWith('dumpsys window')) return { stdout: 'isKeyguardShowing=false', stderr: '', exitCode: 0 }
        return { stdout: '', stderr: '', exitCode: 0 }
      },
    } as unknown as Transport
    await wakeDevice(transport, { keepAwake: 'while-charging', log: silentLog })
    // The batched command failed outright, so the probe is retried on its own
    // rather than the keyguard being guessed at.
    expect(calls).toEqual([READ_POWER, WAKE_AND_PROBE, KEYGUARD])
  })
})

describe('wakeDevice — the persisted screen timeout (plan 125 §3.3, step 125.2)', () => {
  test('writes and verifies the timeout when a capture sink is wired', async () => {
    const { transport, calls, state } = fakeDevice({ timeout: '60000' })
    const captured: Array<{ screenOffTimeoutMs: number | null; stayOnWhilePluggedIn: string | null }> = []
    const result = await wakeDevice(transport, {
      keepAwake: 'always',
      screenOffTimeoutMs: 1800000,
      capture: (s) => void captured.push(s),
      log: silentLog,
    })
    expect(result.screenOffTimeout).toBe('applied')
    expect(state.timeout).toBe('1800000')
    expect(calls.some((c) => c.startsWith('settings put system screen_off_timeout'))).toBe(true)
    // Captured BEFORE the write, and it captured what the device HAD.
    expect(captured).toEqual([{ screenOffTimeoutMs: 60000, stayOnWhilePluggedIn: '0' }])
  })

  test('a timeout the device ignores is `refused`, never `applied` (acceptance criterion 4)', async () => {
    const { transport } = fakeDevice({ timeout: '60000', refuse: ['timeout'] })
    const result = await wakeDevice(transport, { keepAwake: 'always', screenOffTimeoutMs: 1800000, capture: () => {}, log: silentLog })
    expect(result.screenOffTimeout).toBe('refused')
    expect(result.reason).toContain('did not accept')
  })

  test('null means "leave the device’s own timeout alone" — no write is issued', async () => {
    const { transport, calls } = fakeDevice({ timeout: '60000' })
    const result = await wakeDevice(transport, { keepAwake: 'always', screenOffTimeoutMs: null, capture: () => {}, log: silentLog })
    expect(calls.some((c) => c.startsWith('settings put system screen_off_timeout'))).toBe(false)
    expect(result.screenOffTimeout).toBe('unchanged')
  })

  test('a device already on the wanted timeout is `unchanged`, with no write', async () => {
    const { transport, calls } = fakeDevice({ timeout: '1800000' })
    const result = await wakeDevice(transport, { keepAwake: 'always', screenOffTimeoutMs: 1800000, capture: () => {}, log: silentLog })
    expect(calls.some((c) => c.startsWith('settings put system screen_off_timeout'))).toBe(false)
    expect(result.screenOffTimeout).toBe('unchanged')
  })

  test('NO capture sink means NO persisted write — plan 125 §0.2 forbids overwriting a boxed phone’s value with no record of it', async () => {
    const { transport, calls, state } = fakeDevice({ timeout: '60000' })
    const result = await wakeDevice(transport, { keepAwake: 'always', screenOffTimeoutMs: 1800000, log: silentLog })
    expect(calls.some((c) => c.startsWith('settings put system screen_off_timeout'))).toBe(false)
    expect(state.timeout).toBe('60000')
    expect(result.screenOffTimeout).toBe('refused')
    expect(result.reason).toContain('no capture sink')
    // And the rest of the wake still happened — a dark phone is the worse outcome.
    expect(result.stayOn).toBe('applied')
    expect(calls).toContain(WAKE_AND_PROBE)
  })

  test('a capture sink that throws is tolerated and does not stop the wake', async () => {
    const { transport, calls } = fakeDevice()
    const result = await wakeDevice(transport, {
      keepAwake: 'always',
      screenOffTimeoutMs: 1800000,
      capture: () => {
        throw new Error('db is gone')
      },
      log: silentLog,
    })
    expect(calls).toContain(WAKE_AND_PROBE)
    expect(result.stayOn).toBe('applied')
  })
})

/**
 * The keyguard probe is the most expensive command on the wake path and it
 * runs per device, so it asks `dumpsys window policy` first. What has to hold
 * is that the saving never costs correctness: a device whose policy section
 * says nothing recognisable must reach the full dump, not default to
 * "unlocked" and leave a lock screen up over the session.
 */
describe('wakeDevice — the keyguard probe tries the cheap dump first (owner, 2026-09-06)', () => {
  function keyguardTransport(answers: Record<string, string>) {
    const calls: string[] = []
    const transport = {
      exec: async (cmd: string) => {
        calls.push(cmd)
        if (cmd === READ_POWER) return { stdout: '60000\n2', stderr: '', exitCode: 0 }
        if (cmd.startsWith(GET_STAYON)) return { stdout: '2', stderr: '', exitCode: 0 }
        for (const [prefix, out] of Object.entries(answers)) {
          if (cmd === prefix) return { stdout: out, stderr: '', exitCode: 0 }
        }
        return { stdout: '', stderr: '', exitCode: 0 }
      },
    } as unknown as Transport
    return { transport, calls }
  }

  test('the policy section answering is enough — neither the standalone probe nor the full dump is issued', async () => {
    const { transport, calls } = keyguardTransport({ [WAKE_AND_PROBE]: 'isKeyguardShowing=false' })
    await wakeDevice(transport, { keepAwake: 'while-charging', log: silentLog })
    expect(calls).toContain(WAKE_AND_PROBE)
    expect(calls).not.toContain(KEYGUARD)
    expect(calls).not.toContain(KEYGUARD_FULL)
    expect(calls).not.toContain(MENU)
  })

  test('a locked device found through the policy section is dismissed without ever reaching the full dump', async () => {
    const { transport, calls } = keyguardTransport({ [WAKE_AND_PROBE]: 'isKeyguardShowing=true', [DISMISS]: 'isKeyguardShowing=false' })
    const result = await wakeDevice(transport, { keepAwake: 'while-charging', log: silentLog })
    expect(calls).not.toContain(KEYGUARD_FULL)
    expect(calls).toContain(DISMISS)
    expect(result.keyguard).toBe('dismissed')
  })

  test('a policy section that prints nothing recognisable falls back through the standalone probe to the full dump, and the fallback decides', async () => {
    const { transport, calls } = keyguardTransport({ [WAKE_AND_PROBE]: '', [KEYGUARD]: '', [KEYGUARD_FULL]: 'isKeyguardShowing=true' })
    await wakeDevice(transport, { keepAwake: 'while-charging', log: silentLog })
    expect(calls).toContain(WAKE_AND_PROBE)
    expect(calls).toContain(KEYGUARD)
    expect(calls).toContain(KEYGUARD_FULL)
    // The dismiss rung reads the same way: its own probe prints nothing
    // recognisable either, so it falls through to the floor and the full dump.
    expect(calls).toContain(DISMISS)
    expect(calls).toContain(MENU)
  })

  test('both probes failing leaves the keyguard alone — never a blind dismiss or KEYCODE_MENU into an unlocked launcher', async () => {
    const calls: string[] = []
    const transport = {
      exec: async (cmd: string) => {
        calls.push(cmd)
        if (cmd === READ_POWER) return { stdout: '60000\n2', stderr: '', exitCode: 0 }
        if (cmd.includes('dumpsys window')) throw new Error('dumpsys unavailable')
        return { stdout: '2', stderr: '', exitCode: 0 }
      },
    } as unknown as Transport
    const result = await wakeDevice(transport, { keepAwake: 'while-charging', log: silentLog })
    expect(calls).not.toContain(DISMISS)
    expect(calls).not.toContain(MENU)
    expect(result.keyguard).toBe('absent')
  })
})

/**
 * The regression this rung exists for (owner, 2026-09-18): a phone reconnects,
 * the screen lights up, and it sits on its lock screen until somebody opens
 * Device Control and swipes it by hand. `KEYCODE_MENU` was the entire dismiss
 * step and it has not moved a keyguard since Android 9 — the nudge was sent,
 * swallowed, and the wake reported nothing at all about it.
 */
describe('wakeDevice — dismissing the lock screen (owner, 2026-09-18)', () => {
  function lockedTransport(answers: Record<string, string> = {}) {
    const calls: string[] = []
    const transport = {
      exec: async (cmd: string) => {
        calls.push(cmd)
        if (cmd === READ_POWER) return { stdout: '60000\n2', stderr: '', exitCode: 0 }
        if (cmd.startsWith(GET_STAYON)) return { stdout: '2', stderr: '', exitCode: 0 }
        if (cmd in answers) return { stdout: answers[cmd] as string, stderr: '', exitCode: 0 }
        // Everything keyguard-shaped that is not answered above says "locked".
        if (cmd.includes('isKeyguardShowing')) return { stdout: 'isKeyguardShowing=true', stderr: '', exitCode: 0 }
        return { stdout: '', stderr: '', exitCode: 0 }
      },
    } as unknown as Transport
    return { transport, calls }
  }

  test('`wm dismiss-keyguard` is tried BEFORE KEYCODE_MENU, not after', async () => {
    const { transport, calls } = lockedTransport({ [DISMISS]: 'isKeyguardShowing=false' })
    await wakeDevice(transport, { keepAwake: 'while-charging', log: silentLog })
    expect(calls.indexOf(DISMISS)).toBeGreaterThan(-1)
    expect(calls.indexOf(MENU)).toBe(-1)
  })

  test('the dismiss and its re-probe are ONE adb round trip — the settle runs device-side', async () => {
    const { transport, calls } = lockedTransport({ [DISMISS]: 'isKeyguardShowing=false' })
    await wakeDevice(transport, { keepAwake: 'while-charging', log: silentLog })
    // Not `wm dismiss-keyguard` on its own, and not a standalone probe after it.
    expect(calls).not.toContain('wm dismiss-keyguard')
    expect(calls.filter((c) => c === KEYGUARD)).toEqual([])
  })

  test('a ROM with no `wm dismiss-keyguard` still gets the old KEYCODE_MENU floor', async () => {
    // An Android 7 shell prints its complaint and the probe still says locked,
    // then the legacy nudge works and the re-probe comes back clean.
    let menuPressed = false
    const calls: string[] = []
    const transport = {
      exec: async (cmd: string) => {
        calls.push(cmd)
        if (cmd === READ_POWER) return { stdout: '60000\n2', stderr: '', exitCode: 0 }
        if (cmd.startsWith(GET_STAYON)) return { stdout: '2', stderr: '', exitCode: 0 }
        if (cmd === MENU) {
          menuPressed = true
          return { stdout: '', stderr: '', exitCode: 0 }
        }
        if (cmd === DISMISS) return { stdout: 'Unknown command: dismiss-keyguard\nisKeyguardShowing=true', stderr: '', exitCode: 0 }
        if (cmd.includes('isKeyguardShowing')) {
          return { stdout: `isKeyguardShowing=${menuPressed ? 'false' : 'true'}`, stderr: '', exitCode: 0 }
        }
        return { stdout: '', stderr: '', exitCode: 0 }
      },
    } as unknown as Transport
    const result = await wakeDevice(transport, { keepAwake: 'while-charging', log: silentLog })
    expect(calls).toContain(DISMISS)
    expect(calls).toContain(MENU)
    expect(result.keyguard).toBe('dismissed')
  })

  test('a secured device reports `showing` with a reason, instead of a silent dark tile', async () => {
    const { transport, calls } = lockedTransport()
    const result = await wakeDevice(transport, { keepAwake: 'while-charging', log: silentLog })
    expect(calls).toContain(DISMISS)
    expect(calls).toContain(MENU)
    expect(result.keyguard).toBe('showing')
    expect(result.reason).toContain('PIN')
  })

  test('a power write that was refused keeps its own reason — the keyguard never overwrites it', async () => {
    const { transport } = lockedTransport()
    const result = await wakeDevice(transport, { keepAwake: 'always', screenOffTimeoutMs: 1800000, log: silentLog })
    expect(result.keyguard).toBe('showing')
    expect(result.reason).toContain('no capture sink')
  })

  test('a dismiss that cannot be issued at all still falls through to the floor', async () => {
    const calls: string[] = []
    const transport = {
      exec: async (cmd: string) => {
        calls.push(cmd)
        if (cmd === READ_POWER) return { stdout: '60000\n2', stderr: '', exitCode: 0 }
        if (cmd.startsWith(GET_STAYON)) return { stdout: '2', stderr: '', exitCode: 0 }
        if (cmd === DISMISS) throw new Error('the shell went away')
        if (cmd.includes('isKeyguardShowing')) return { stdout: 'isKeyguardShowing=true', stderr: '', exitCode: 0 }
        return { stdout: '', stderr: '', exitCode: 0 }
      },
    } as unknown as Transport
    const result = await wakeDevice(transport, { keepAwake: 'while-charging', log: silentLog })
    expect(calls).toContain(MENU)
    expect(result.keyguard).toBe('showing')
  })
})
