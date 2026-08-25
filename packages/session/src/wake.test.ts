import { describe, expect, test } from 'bun:test'
import type { Transport } from '@enkaku/protocol'
import { wakeDevice } from './wake'
import { STAYON } from './power'
import type { Logger } from './logger'

const silentLog: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLog,
}

const GET_TIMEOUT = 'settings get system screen_off_timeout'
const GET_STAYON = 'settings get global stay_on_while_plugged_in'
const KEYGUARD = 'dumpsys window | grep -m1 isKeyguardShowing'

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
function fakeDevice(initial: { timeout?: string; stayOn?: string; refuse?: Array<'timeout' | 'stayOn'> } = {}) {
  const state = { timeout: initial.timeout ?? '60000', stayOn: initial.stayOn ?? '0' }
  const refuse = new Set(initial.refuse ?? [])
  const calls: string[] = []
  const transport = {
    exec: async (cmd: string) => {
      calls.push(cmd)
      if (cmd.startsWith(GET_TIMEOUT)) return { stdout: state.timeout, stderr: '', exitCode: 0 }
      if (cmd.startsWith(GET_STAYON)) return { stdout: state.stayOn, stderr: '', exitCode: 0 }
      if (cmd.startsWith('settings put system screen_off_timeout')) {
        // The value arrives `shellQuote`d — a real device shell strips the
        // quotes before `settings` ever sees them, so this fake does too.
        if (!refuse.has('timeout')) state.timeout = (cmd.split(' ').pop() ?? '').replace(/'/g, '') || state.timeout
        return { stdout: '', stderr: '', exitCode: 0 }
      }
      if (cmd.startsWith('svc power stayon')) {
        const token = cmd.split(' ').pop()
        if (!refuse.has('stayOn')) state.stayOn = token === 'true' ? '7' : token === 'usb' ? '2' : '0'
        return { stdout: '', stderr: '', exitCode: 0 }
      }
      if (cmd.startsWith('dumpsys window')) return { stdout: 'isKeyguardShowing=false', stderr: '', exitCode: 0 }
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
    expect(result).toEqual({ screenOffTimeout: 'unchanged', stayOn: 'unchanged', reason: 'this device is opted out of keeping the screen awake' })
  })

  test('"while-charging": read the current power state, stayon usb, wake, then a keyguard probe — no dismiss when unlocked', async () => {
    const { transport, calls } = fakeDevice({ stayOn: '0' })
    await wakeDevice(transport, { keepAwake: 'while-charging', log: silentLog })
    expect(calls).toEqual([
      GET_TIMEOUT,
      GET_STAYON,
      `svc power stayon ${STAYON['while-charging']}`,
      GET_STAYON,
      'input keyevent KEYCODE_WAKEUP',
      KEYGUARD,
    ])
  })

  test('"always" maps to `svc power stayon true`', async () => {
    const { transport, calls } = fakeDevice()
    const result = await wakeDevice(transport, { keepAwake: 'always', log: silentLog })
    expect(calls).toContain('svc power stayon true')
    expect(result.stayOn).toBe('applied')
  })

  test('a device that already holds the value skips `svc power stayon` entirely — plan 96 §22 measured it at 1422 ms', async () => {
    const { transport, calls } = fakeDevice({ stayOn: '7' })
    const result = await wakeDevice(transport, { keepAwake: 'always', log: silentLog })
    expect(calls.some((c) => c.startsWith('svc power stayon'))).toBe(false)
    expect(result.stayOn).toBe('unchanged')
    // The wake itself still happens — the screen may be dark regardless.
    expect(calls).toContain('input keyevent KEYCODE_WAKEUP')
  })

  test('a stayon write the device ignores is `refused`, never `applied` (acceptance criterion 4)', async () => {
    const { transport } = fakeDevice({ stayOn: '0', refuse: ['stayOn'] })
    const result = await wakeDevice(transport, { keepAwake: 'always', log: silentLog })
    expect(result.stayOn).toBe('refused')
    expect(result.reason).toContain('did not accept')
  })

  test('nudges a swipe-only keyguard when dumpsys reports one showing', async () => {
    const { transport, calls } = recordingTransport({ 'dumpsys window': 'isKeyguardShowing=true', [GET_STAYON]: '2' })
    await wakeDevice(transport, { keepAwake: 'while-charging', log: silentLog })
    expect(calls).toContain('input keyevent 82')
  })

  test('a failing command is swallowed (best-effort) and the sequence continues', async () => {
    const calls: string[] = []
    const transport = {
      exec: async (cmd: string) => {
        calls.push(cmd)
        if (cmd === 'input keyevent KEYCODE_WAKEUP') throw new Error('boom')
        if (cmd.startsWith(GET_STAYON)) return { stdout: '2', stderr: '', exitCode: 0 }
        if (cmd.startsWith('dumpsys window')) return { stdout: 'isKeyguardShowing=false', stderr: '', exitCode: 0 }
        return { stdout: '', stderr: '', exitCode: 0 }
      },
    } as unknown as Transport
    await wakeDevice(transport, { keepAwake: 'while-charging', log: silentLog })
    expect(calls).toEqual([GET_TIMEOUT, GET_STAYON, 'input keyevent KEYCODE_WAKEUP', KEYGUARD])
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
    expect(calls).toContain('input keyevent KEYCODE_WAKEUP')
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
    expect(calls).toContain('input keyevent KEYCODE_WAKEUP')
    expect(result.stayOn).toBe('applied')
  })
})
