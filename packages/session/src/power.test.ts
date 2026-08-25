import { describe, expect, test } from 'bun:test'
import type { Transport } from '@enkaku/protocol'
import { observeScreen, satisfiesStayOn } from './power'
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
