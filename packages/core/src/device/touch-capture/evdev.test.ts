import { describe, expect, test } from 'bun:test'
import { ABS_MT_POSITION_X, ABS_MT_TRACKING_ID, BTN_TOUCH, EV_ABS, EV_KEY, EV_SYN, parseEvdevLine, SYN_REPORT } from './evdev'

describe('parseEvdevLine (plan 1000 §4.3)', () => {
  test('a labelled, timestamped ABS line', () => {
    const ev = parseEvdevLine('[   28065.685745] /dev/input/event3: EV_ABS       ABS_MT_POSITION_X    000002a5')
    expect(ev).toEqual({ path: '/dev/input/event3', tsMs: 28065685.745, type: EV_ABS, code: ABS_MT_POSITION_X, value: 0x2a5 })
  })

  test('a lift is -1, not 4294967295 — the whole contact model depends on it', () => {
    const ev = parseEvdevLine('[   28066.101002] /dev/input/event3: EV_ABS       ABS_MT_TRACKING_ID   ffffffff')
    expect(ev?.code).toBe(ABS_MT_TRACKING_ID)
    expect(ev?.value).toBe(-1)
  })

  test('a KEY value is the WORD DOWN/UP, which is what a single-touch panel is delimited by', () => {
    expect(parseEvdevLine('[ 28065.685745] /dev/input/event3: EV_KEY       BTN_TOUCH            DOWN')).toEqual({
      path: '/dev/input/event3',
      tsMs: 28065685.745,
      type: EV_KEY,
      code: BTN_TOUCH,
      value: 1,
    })
    expect(parseEvdevLine('[ 28066.101002] /dev/input/event3: EV_KEY       BTN_TOUCH            UP')?.value).toBe(0)
  })

  test('an unlabelled line (a code `-l` did not know) resolves through its hex', () => {
    const ev = parseEvdevLine('[   28065.685745] /dev/input/event3: 0003 0035 000002a5')
    expect(ev).toEqual({ path: '/dev/input/event3', tsMs: 28065685.745, type: EV_ABS, code: ABS_MT_POSITION_X, value: 0x2a5 })
  })

  test('SYN_REPORT, the only place a sample may be taken', () => {
    const ev = parseEvdevLine('[   28065.685745] /dev/input/event3: EV_SYN       SYN_REPORT           00000000')
    expect(ev?.type).toBe(EV_SYN)
    expect(ev?.code).toBe(SYN_REPORT)
  })

  test('no timestamp (a stream opened without -t) parses, with a null clock', () => {
    expect(parseEvdevLine('/dev/input/event3: EV_ABS       ABS_MT_POSITION_X    000002a5')?.tsMs).toBeNull()
  })

  test('a line that is not an event returns null instead of throwing — this parser is fed a live stream', () => {
    expect(parseEvdevLine('add device 3: /dev/input/event3')).toBeNull()
    expect(parseEvdevLine('  name:     "sec_touchscreen"')).toBeNull()
    expect(parseEvdevLine('')).toBeNull()
    expect(parseEvdevLine('could not get driver version for /dev/input/mice, Not a typewriter')).toBeNull()
  })

  test('a label outside the assembler’s vocabulary is dropped, not guessed at', () => {
    expect(parseEvdevLine('[ 28065.685745] /dev/input/event3: EV_ABS       ABS_MT_TOUCH_MAJOR   00000005')).toBeNull()
  })
})
