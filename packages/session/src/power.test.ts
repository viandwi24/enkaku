import { describe, expect, test } from 'bun:test'
import type { Transport } from '@enkaku/protocol'
import { observeScreen, readPowerState, satisfiesStayOn } from './power'
import type { Logger } from './logger'

const silentLog: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLog,
}

function probing(answer: string | Error): Transport {
  return {
    exec: async () => {
      if (answer instanceof Error) throw answer
      return { stdout: answer, stderr: '', exitCode: 0 }
    },
  } as unknown as Transport
}

/**
 * `stay_on_while_plugged_in` is a `BatteryManager` plug-type bitmask, and the
 * set of bits `svc power stayon true` writes GREW across Android versions
 * (`AC|USB|WIRELESS` = 7, then 15 once `BATTERY_PLUGGED_DOCK` joined). These
 * assertions pin the one decision that follows from that: `true` is verified
 * as "AC, USB and wireless are all set", not as an exact number, because a
 * false `refused` on a boxed phone invites an unnecessary second write.
 */
describe('satisfiesStayOn — the read-back verification for `svc power stayon` (plan 125 §3.3)', () => {
  test('`always` accepts both the pre-dock and post-dock bitmask', () => {
    expect(satisfiesStayOn('7', 'always')).toBe(true)
    expect(satisfiesStayOn('15', 'always')).toBe(true)
  })

  test('`always` REFUSES a partial hold — a device left on USB-only did not accept the write', () => {
    expect(satisfiesStayOn('2', 'always')).toBe(false)
    expect(satisfiesStayOn('3', 'always')).toBe(false)
    expect(satisfiesStayOn('0', 'always')).toBe(false)
  })

  test('`while-charging` is exactly USB, so asking for it on a fully-held device still writes', () => {
    expect(satisfiesStayOn('2', 'while-charging')).toBe(true)
    expect(satisfiesStayOn('7', 'while-charging')).toBe(false)
  })

  test('`off` is exactly zero', () => {
    expect(satisfiesStayOn('0', 'off')).toBe(true)
    expect(satisfiesStayOn('1', 'off')).toBe(false)
  })

  test('an unreadable value satisfies nothing — "we could not check" is never "it took"', () => {
    expect(satisfiesStayOn(null, 'off')).toBe(false)
    expect(satisfiesStayOn(null, 'always')).toBe(false)
    expect(satisfiesStayOn('what', 'always')).toBe(false)
  })
})

describe('observeScreen — the mWakefulness probe (plan 125 §3.6, acceptance criterion 5)', () => {
  test('Awake is `on`', async () => {
    expect((await observeScreen(probing('  mWakefulness=Awake'), silentLog)).state).toBe('on')
  })

  test('Dreaming is `on` — a screensaver is a lit panel', async () => {
    expect((await observeScreen(probing('mWakefulness=Dreaming'), silentLog)).state).toBe('on')
  })

  test('Asleep and Dozing are `off`', async () => {
    expect((await observeScreen(probing('mWakefulness=Asleep'), silentLog)).state).toBe('off')
    expect((await observeScreen(probing('mWakefulness=Dozing'), silentLog)).state).toBe('off')
  })

  test('a probe that throws is `unknown`, never `off`', async () => {
    const observed = await observeScreen(probing(new Error('device offline')), silentLog)
    expect(observed.state).toBe('unknown')
    expect(observed.reason).toContain('could not run')
  })

  test('an empty or unrecognised dump is `unknown`, never `off`', async () => {
    expect((await observeScreen(probing(''), silentLog)).state).toBe('unknown')
    expect((await observeScreen(probing('mWakefulness=Sideways'), silentLog)).state).toBe('unknown')
  })

  test('mWakefulnessChanging cannot be mistaken for the state line', async () => {
    expect((await observeScreen(probing('mWakefulnessChanging=false'), silentLog)).state).toBe('unknown')
  })
})

/**
 * `readPowerState` asks a real device shell for both keys in one command. The
 * fallback matters more than the fast path: this module's contract is that it
 * never reports a value it did not observe, so an answer it cannot line up
 * with the keys it asked for must cost an extra round trip, not a guess.
 */
describe('readPowerState — one round trip, with a fallback that never guesses', () => {
  function shell(handler: (cmd: string) => string | Error) {
    const calls: string[] = []
    const transport = {
      exec: async (cmd: string) => {
        calls.push(cmd)
        const out = handler(cmd)
        if (out instanceof Error) throw out
        return { stdout: out, stderr: '', exitCode: 0 }
      },
    } as unknown as Transport
    return { transport, calls }
  }

  test('reads both keys in a single exec and maps the lines in the order they were asked for', async () => {
    const { transport, calls } = shell(() => '1800000\n7')
    expect(await readPowerState(transport)).toEqual({ screenOffTimeoutMs: 1800000, stayOnWhilePluggedIn: '7' })
    expect(calls).toEqual(['settings get system screen_off_timeout; settings get global stay_on_while_plugged_in'])
  })

  test('a one-line answer is not split between the two keys — it falls back to a call each', async () => {
    const { transport, calls } = shell((cmd) => {
      if (cmd.includes(';')) return '1800000'
      return cmd.includes('screen_off_timeout') ? '1800000' : '2'
    })
    expect(await readPowerState(transport)).toEqual({ screenOffTimeoutMs: 1800000, stayOnWhilePluggedIn: '2' })
    expect(calls).toHaveLength(3)
  })

  test('a combined read that throws falls back rather than reporting both keys unreadable', async () => {
    const { transport, calls } = shell((cmd) => {
      if (cmd.includes(';')) return new Error('shell refused the compound command')
      return cmd.includes('screen_off_timeout') ? '60000' : '0'
    })
    expect(await readPowerState(transport)).toEqual({ screenOffTimeoutMs: 60000, stayOnWhilePluggedIn: '0' })
    expect(calls).toHaveLength(3)
  })

  test('an unset key still reads as null through the combined path', async () => {
    const { transport } = shell(() => 'null\n')
    expect(await readPowerState(transport)).toEqual({ screenOffTimeoutMs: null, stayOnWhilePluggedIn: null })
  })
})
