import { describe, expect, test } from 'bun:test'
import { parseEvdevLine } from './evdev'
import type { TouchPanelProfile } from './probe'
import { createStrokeAssembler, type RawStroke } from './strokes'

const GLASS: TouchPanelProfile = {
  path: '/dev/input/event3',
  name: 'sec_touchscreen',
  protocol: 'mt-b',
  maxX: 1079,
  maxY: 2339,
  pressureMax: 255,
  synthetic: false,
}

const SINGLE_TOUCH: TouchPanelProfile = { ...GLASS, path: '/dev/input/event4', name: 'ft5x06_ts', protocol: 'st', pressureMax: null }

function assembler(profiles: TouchPanelProfile[] = [GLASS], maxSamples = 600) {
  const byPath = new Map(profiles.map((p) => [p.path, p]))
  return createStrokeAssembler({ profileFor: (path) => byPath.get(path) ?? null, maxSamples, now: () => 0 })
}

/** Feeds a `getevent -lt` transcript line by line and returns every stroke it completed. */
function feed(a: ReturnType<typeof assembler>, transcript: string): RawStroke[] {
  const out: RawStroke[] = []
  for (const line of transcript.trim().split('\n')) {
    const ev = parseEvdevLine(line.trim())
    if (ev) out.push(...a.push(ev))
  }
  return out
}

describe('createStrokeAssembler (plan 1000 §4.4)', () => {
  test('a protocol-B tap is one stroke, with the down and the lift as its two clocks', () => {
    const strokes = feed(
      assembler(),
      `
[    1000.000000] /dev/input/event3: EV_ABS       ABS_MT_TRACKING_ID   0000024a
[    1000.000000] /dev/input/event3: EV_ABS       ABS_MT_POSITION_X    00000216
[    1000.000000] /dev/input/event3: EV_ABS       ABS_MT_POSITION_Y    00000456
[    1000.000000] /dev/input/event3: EV_KEY       BTN_TOUCH            DOWN
[    1000.000000] /dev/input/event3: EV_SYN       SYN_REPORT           00000000
[    1000.084000] /dev/input/event3: EV_ABS       ABS_MT_TRACKING_ID   ffffffff
[    1000.084000] /dev/input/event3: EV_KEY       BTN_TOUCH            UP
[    1000.084000] /dev/input/event3: EV_SYN       SYN_REPORT           00000000
`,
    )
    expect(strokes).toHaveLength(1)
    const stroke = strokes[0]!
    expect(stroke.pointerId).toBe(0)
    expect(stroke.samples).toHaveLength(1)
    expect(stroke.samples[0]).toMatchObject({ x: 0x216, y: 0x456 })
    expect(stroke.endTsMs - stroke.startTsMs).toBeCloseTo(84, 6)
    expect(stroke.concurrent).toBe(false)
  })

  test('one sample per SYN_REPORT, never one per axis line — an X and a Y are ONE position', () => {
    const strokes = feed(
      assembler(),
      `
[    2000.000000] /dev/input/event3: EV_ABS       ABS_MT_TRACKING_ID   00000001
[    2000.000000] /dev/input/event3: EV_ABS       ABS_MT_POSITION_X    00000064
[    2000.000000] /dev/input/event3: EV_ABS       ABS_MT_POSITION_Y    00000064
[    2000.000000] /dev/input/event3: EV_SYN       SYN_REPORT           00000000
[    2000.016000] /dev/input/event3: EV_ABS       ABS_MT_POSITION_X    000000c8
[    2000.016000] /dev/input/event3: EV_ABS       ABS_MT_POSITION_Y    000000c8
[    2000.016000] /dev/input/event3: EV_SYN       SYN_REPORT           00000000
[    2000.032000] /dev/input/event3: EV_ABS       ABS_MT_POSITION_Y    0000012c
[    2000.032000] /dev/input/event3: EV_SYN       SYN_REPORT           00000000
[    2000.048000] /dev/input/event3: EV_ABS       ABS_MT_TRACKING_ID   ffffffff
[    2000.048000] /dev/input/event3: EV_SYN       SYN_REPORT           00000000
`,
    )
    expect(strokes[0]?.samples.map((s) => [s.x, s.y])).toEqual([
      [100, 100],
      [200, 200],
      [200, 300],
    ])
  })

  test('the current slot is sticky across frames: a second finger is its own stroke, and both know they overlapped', () => {
    const strokes = feed(
      assembler(),
      `
[    3000.000000] /dev/input/event3: EV_ABS       ABS_MT_TRACKING_ID   00000010
[    3000.000000] /dev/input/event3: EV_ABS       ABS_MT_POSITION_X    00000064
[    3000.000000] /dev/input/event3: EV_ABS       ABS_MT_POSITION_Y    00000064
[    3000.000000] /dev/input/event3: EV_SYN       SYN_REPORT           00000000
[    3000.020000] /dev/input/event3: EV_ABS       ABS_MT_SLOT          00000001
[    3000.020000] /dev/input/event3: EV_ABS       ABS_MT_TRACKING_ID   00000011
[    3000.020000] /dev/input/event3: EV_ABS       ABS_MT_POSITION_X    000001f4
[    3000.020000] /dev/input/event3: EV_ABS       ABS_MT_POSITION_Y    000001f4
[    3000.020000] /dev/input/event3: EV_SYN       SYN_REPORT           00000000
[    3000.040000] /dev/input/event3: EV_ABS       ABS_MT_POSITION_X    00000258
[    3000.040000] /dev/input/event3: EV_SYN       SYN_REPORT           00000000
[    3000.060000] /dev/input/event3: EV_ABS       ABS_MT_TRACKING_ID   ffffffff
[    3000.060000] /dev/input/event3: EV_SYN       SYN_REPORT           00000000
[    3000.080000] /dev/input/event3: EV_ABS       ABS_MT_SLOT          00000000
[    3000.080000] /dev/input/event3: EV_ABS       ABS_MT_TRACKING_ID   ffffffff
[    3000.080000] /dev/input/event3: EV_SYN       SYN_REPORT           00000000
`,
    )
    expect(strokes).toHaveLength(2)
    // The second finger lifted first — the frame at 3000.040 belongs to slot
    // 1, which is the whole point of the sticky slot.
    expect(strokes[0]?.pointerId).toBe(1)
    expect(strokes[0]?.samples.map((s) => s.x)).toEqual([500, 600])
    expect(strokes[1]?.pointerId).toBe(0)
    expect(strokes.every((s) => s.concurrent)).toBe(true)
  })

  test('BTN_TOUCH on a protocol-B panel opens no phantom contact beside the slot that owns the finger', () => {
    const strokes = feed(
      assembler(),
      `
[    4000.000000] /dev/input/event3: EV_KEY       BTN_TOUCH            DOWN
[    4000.000000] /dev/input/event3: EV_SYN       SYN_REPORT           00000000
[    4000.050000] /dev/input/event3: EV_KEY       BTN_TOUCH            UP
[    4000.050000] /dev/input/event3: EV_SYN       SYN_REPORT           00000000
`,
    )
    expect(strokes).toEqual([])
  })

  test('a single-touch panel is delimited by BTN_TOUCH and positioned by ABS_X/ABS_Y', () => {
    const strokes = feed(
      assembler([SINGLE_TOUCH]),
      `
[    5000.000000] /dev/input/event4: EV_KEY       BTN_TOUCH            DOWN
[    5000.000000] /dev/input/event4: EV_ABS       ABS_X                00000032
[    5000.000000] /dev/input/event4: EV_ABS       ABS_Y                00000064
[    5000.000000] /dev/input/event4: EV_SYN       SYN_REPORT           00000000
[    5000.120000] /dev/input/event4: EV_KEY       BTN_TOUCH            UP
[    5000.120000] /dev/input/event4: EV_SYN       SYN_REPORT           00000000
`,
    )
    expect(strokes).toHaveLength(1)
    expect(strokes[0]?.samples[0]).toMatchObject({ x: 50, y: 100 })
    expect(strokes[0]!.endTsMs - strokes[0]!.startTsMs).toBeCloseTo(120, 6)
  })

  test('a lift for a finger that was already down when the capture opened emits nothing', () => {
    const strokes = feed(
      assembler(),
      `
[    6000.000000] /dev/input/event3: EV_ABS       ABS_MT_TRACKING_ID   ffffffff
[    6000.000000] /dev/input/event3: EV_SYN       SYN_REPORT           00000000
`,
    )
    expect(strokes).toEqual([])
  })

  test('an event from a path with no profile is ignored, not guessed at', () => {
    const a = assembler()
    const ev = parseEvdevLine('[ 7000.000000] /dev/input/event9: EV_ABS       ABS_MT_TRACKING_ID   00000001')
    expect(a.push(ev!)).toEqual([])
    expect(a.openCount()).toBe(0)
  })

  test('past the cap the MIDDLE of the path is thinned — both endpoints survive, and the loss is counted', () => {
    const a = assembler([GLASS], 4)
    const lines = ['[ 8000.000000] /dev/input/event3: EV_ABS       ABS_MT_TRACKING_ID   00000001']
    for (let i = 0; i < 10; i++) {
      const ts = (8000 + i * 0.016).toFixed(6)
      lines.push(`[ ${ts}] /dev/input/event3: EV_ABS       ABS_MT_POSITION_X    ${(i * 10).toString(16).padStart(8, '0')}`)
      lines.push(`[ ${ts}] /dev/input/event3: EV_ABS       ABS_MT_POSITION_Y    00000010`)
      lines.push(`[ ${ts}] /dev/input/event3: EV_SYN       SYN_REPORT           00000000`)
    }
    lines.push('[ 8000.200000] /dev/input/event3: EV_ABS       ABS_MT_TRACKING_ID   ffffffff')
    lines.push('[ 8000.200000] /dev/input/event3: EV_SYN       SYN_REPORT           00000000')
    const stroke = feed(a, lines.join('\n'))[0]!
    expect(stroke.samples).toHaveLength(4)
    expect(stroke.samples[0]?.x).toBe(0)
    expect(stroke.samples[3]?.x).toBe(90)
    expect(stroke.droppedSamples).toBe(6)
  })

  test('openCount reports fingers still down, so a status can say so', () => {
    const a = assembler()
    feed(
      a,
      `
[    9000.000000] /dev/input/event3: EV_ABS       ABS_MT_TRACKING_ID   00000001
[    9000.000000] /dev/input/event3: EV_ABS       ABS_MT_POSITION_X    00000064
[    9000.000000] /dev/input/event3: EV_ABS       ABS_MT_POSITION_Y    00000064
[    9000.000000] /dev/input/event3: EV_SYN       SYN_REPORT           00000000
`,
    )
    expect(a.openCount()).toBe(1)
  })
})
