import { describe, expect, test } from 'bun:test'
import type { Transport } from '@enkaku/protocol'
import { wakeDevice, STAYON } from './wake'
import type { Logger } from './logger'

const silentLog: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLog,
}

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

describe('wakeDevice — the sequence extracted from session.ts (plan 43 §5 step 43.2, §7)', () => {
  test('"off" issues no commands at all', async () => {
    const { transport, calls } = recordingTransport()
    await wakeDevice(transport, { keepAwake: 'off', log: silentLog })
    expect(calls).toEqual([])
  })

  test('"while-charging": wakeup, stayon usb, then a keyguard probe — no dismiss when unlocked', async () => {
    const { transport, calls } = recordingTransport({ 'dumpsys window': 'isKeyguardShowing=false' })
    await wakeDevice(transport, { keepAwake: 'while-charging', log: silentLog })
    expect(calls).toEqual([
      'input keyevent KEYCODE_WAKEUP',
      `svc power stayon ${STAYON['while-charging']}`,
      'dumpsys window | grep -m1 isKeyguardShowing',
    ])
  })

  test('"always" maps to `svc power stayon true`', async () => {
    const { transport, calls } = recordingTransport({ 'dumpsys window': 'isKeyguardShowing=false' })
    await wakeDevice(transport, { keepAwake: 'always', log: silentLog })
    expect(calls).toContain('svc power stayon true')
  })

  test('nudges a swipe-only keyguard when dumpsys reports one showing', async () => {
    const { transport, calls } = recordingTransport({ 'dumpsys window': 'isKeyguardShowing=true' })
    await wakeDevice(transport, { keepAwake: 'while-charging', log: silentLog })
    expect(calls).toContain('input keyevent 82')
  })

  test('a failing command is swallowed (best-effort) and the sequence continues', async () => {
    const calls: string[] = []
    const transport = {
      exec: async (cmd: string) => {
        calls.push(cmd)
        if (cmd === 'input keyevent KEYCODE_WAKEUP') throw new Error('boom')
        if (cmd.startsWith('dumpsys window')) return { stdout: 'isKeyguardShowing=false', stderr: '', exitCode: 0 }
        return { stdout: '', stderr: '', exitCode: 0 }
      },
    } as unknown as Transport
    await wakeDevice(transport, { keepAwake: 'while-charging', log: silentLog })
    expect(calls).toEqual([
      'input keyevent KEYCODE_WAKEUP',
      `svc power stayon ${STAYON['while-charging']}`,
      'dumpsys window | grep -m1 isKeyguardShowing',
    ])
  })
})
