import { describe, expect, test } from 'bun:test'
import type { TouchStroke } from '@enkaku/protocol'
import type { ShellPort } from '../shell-port'
import { createTouchCaptureService, type TouchCaptureStatus } from './service'

const PROBE = `add device 3: /dev/input/event3
  name:     "sec_touchscreen"
  events:
    KEY (0001): BTN_TOUCH
    ABS (0003): ABS_MT_SLOT           : value 0, min 0, max 9, fuzz 0, flat 0, resolution 0
                ABS_MT_POSITION_X     : value 0, min 0, max 999, fuzz 0, flat 0, resolution 0
                ABS_MT_POSITION_Y     : value 0, min 0, max 1999, fuzz 0, flat 0, resolution 0
add device 4: /dev/input/event7
  name:     "Enkaku Pointer"
  events:
    ABS (0003): ABS_MT_SLOT           : value 0, min 0, max 1, fuzz 0, flat 0, resolution 0
                ABS_MT_POSITION_X     : value 0, min 0, max 32767, fuzz 0, flat 0, resolution 0
                ABS_MT_POSITION_Y     : value 0, min 0, max 32767, fuzz 0, flat 0, resolution 0
`

/** One contact at (x, y) in panel units, down at `atSec` and lifted `holdMs` later. */
function contact(path: string, x: number, y: number, atSec: number, holdMs: number, moveTo?: { x: number; y: number }): string {
  const hex = (v: number) => v.toString(16).padStart(8, '0')
  const stamp = (sec: number) => `[ ${sec.toFixed(6)}]`
  const lines = [
    `${stamp(atSec)} ${path}: EV_ABS       ABS_MT_TRACKING_ID   ${hex(1)}`,
    `${stamp(atSec)} ${path}: EV_ABS       ABS_MT_POSITION_X    ${hex(x)}`,
    `${stamp(atSec)} ${path}: EV_ABS       ABS_MT_POSITION_Y    ${hex(y)}`,
    `${stamp(atSec)} ${path}: EV_SYN       SYN_REPORT           00000000`,
  ]
  if (moveTo) {
    const mid = atSec + holdMs / 2000
    lines.push(
      `${stamp(mid)} ${path}: EV_ABS       ABS_MT_POSITION_X    ${hex(moveTo.x)}`,
      `${stamp(mid)} ${path}: EV_ABS       ABS_MT_POSITION_Y    ${hex(moveTo.y)}`,
      `${stamp(mid)} ${path}: EV_SYN       SYN_REPORT           00000000`,
    )
  }
  const up = atSec + holdMs / 1000
  lines.push(
    `${stamp(up)} ${path}: EV_ABS       ABS_MT_TRACKING_ID   ffffffff`,
    `${stamp(up)} ${path}: EV_SYN       SYN_REPORT           00000000`,
  )
  return lines.join('\n') + '\n'
}

function harness(opts: { probe?: string } = {}) {
  const strokes: TouchStroke[] = []
  const statuses: TouchCaptureStatus[] = []
  const calls: string[] = []
  let feed: ((text: string) => void) | null = null
  let end: ((reason: string) => void) | null = null
  let stopped = 0

  const port: ShellPort = {
    async exec(cmd) {
      calls.push(`exec:${cmd}`)
      return { stdout: opts.probe ?? PROBE, stderr: '', exitCode: 0, truncated: false }
    },
    async stream(cmd, streamOpts) {
      calls.push(`stream:${cmd}`)
      feed = (text) => streamOpts.onData(new TextEncoder().encode(text))
      end = (reason) => streamOpts.onEnd(reason)
      return {
        streamId: 'test',
        async stop() {
          stopped += 1
        },
      }
    },
  }

  const service = createTouchCaptureService({
    shellPort: () => port,
    log: { debug() {}, info() {}, warn() {}, error() {}, child: () => ({}) } as never,
    onStroke: (_deviceId, stroke) => strokes.push(stroke),
    onStatus: (status) => statuses.push(status),
    rotationFor: () => 0,
  })

  return {
    service,
    strokes,
    statuses,
    calls,
    stopCount: () => stopped,
    feed: (text: string) => feed?.(text),
    end: (reason: string) => end?.(reason),
  }
}

describe('createTouchCaptureService (plan 1000 §4.5)', () => {
  test('a tap arrives normalised against the panel it landed on, with the panel named', async () => {
    const h = harness()
    const status = await h.service.start('client-1', 'dev-1')
    expect(status.state).toBe('active')
    expect(h.calls).toEqual(['exec:getevent -pl', 'stream:getevent -lt'])

    h.feed(contact('/dev/input/event3', 500, 1000, 1000, 80))
    expect(h.strokes).toHaveLength(1)
    const stroke = h.strokes[0]!
    expect(stroke.kind).toBe('tap')
    expect(stroke.from.x).toBeCloseTo(500 / 999, 6)
    expect(stroke.from.y).toBeCloseTo(1000 / 1999, 6)
    expect(stroke.fromRaw).toEqual({ x: 500, y: 1000 })
    expect(stroke.durationMs).toBeCloseTo(80, 6)
    expect(stroke.sourceName).toBe('sec_touchscreen')
    expect(stroke.synthetic).toBe(false)
    expect(stroke.gapMs).toBeNull()
    expect(stroke.seq).toBe(1)
  })

  test('the interval is the gap since the previous down ON THE SAME input device, in device milliseconds', async () => {
    const h = harness()
    await h.service.start('client-1', 'dev-1')
    h.feed(contact('/dev/input/event3', 100, 100, 2000, 50))
    // The farm's own injected tap in between must not become part of a human interval.
    h.feed(contact('/dev/input/event7', 16000, 16000, 2000.2, 20))
    h.feed(contact('/dev/input/event3', 120, 120, 2000.9, 50))

    const human = h.strokes.filter((s) => !s.synthetic)
    expect(human).toHaveLength(2)
    expect(human[1]?.gapMs).toBeCloseTo(900, 3)
    const injected = h.strokes.find((s) => s.synthetic)
    expect(injected?.gapMs).toBeNull()
    expect(injected?.sourceName).toBe('Enkaku Pointer')
  })

  test('travel decides swipe, hold decides long press', async () => {
    const h = harness()
    await h.service.start('client-1', 'dev-1')
    h.feed(contact('/dev/input/event3', 100, 100, 3000, 300, { x: 900, y: 100 }))
    h.feed(contact('/dev/input/event3', 100, 100, 3001, 900))
    expect(h.strokes.map((s) => s.kind)).toEqual(['swipe', 'longPress'])
    expect(h.strokes[0]?.travel).toBeCloseTo(800 / 999, 6)
  })

  test('a phone with no touch panel is `unavailable`, and no stream is opened for it', async () => {
    const h = harness({ probe: 'add device 1: /dev/input/event0\n  name:     "gpio-keys"\n' })
    const status = await h.service.start('client-1', 'dev-1')
    expect(status.state).toBe('unavailable')
    expect(status.reason).toContain('no touch panel')
    expect(h.calls).toEqual(['exec:getevent -pl'])
  })

  test('a second viewer joins the running capture and sees its buffer; the stream stops only when the last one leaves', async () => {
    const h = harness()
    await h.service.start('client-1', 'dev-1')
    h.feed(contact('/dev/input/event3', 100, 100, 4000, 40))

    const joined = await h.service.start('client-2', 'dev-1')
    expect(joined.viewers).toBe(2)
    expect(joined.strokes).toHaveLength(1)
    expect(h.calls.filter((c) => c.startsWith('stream:'))).toHaveLength(1)

    h.service.stop('client-1', 'dev-1')
    expect(h.stopCount()).toBe(0)
    h.service.stop('client-2', 'dev-1')
    expect(h.stopCount()).toBe(1)
    expect(h.service.status('dev-1').state).toBe('stopped')
  })

  test('clear empties the buffer and leaves the capture running', async () => {
    const h = harness()
    await h.service.start('client-1', 'dev-1')
    h.feed(contact('/dev/input/event3', 100, 100, 5000, 40))
    const cleared = h.service.clear('dev-1')
    expect(cleared.strokes).toEqual([])
    expect(cleared.state).toBe('active')
    h.feed(contact('/dev/input/event3', 200, 200, 5001, 40))
    expect(h.service.status('dev-1').strokes).toHaveLength(1)
  })

  test('a dropped connection releases its captures; a dead stream reports itself once', async () => {
    const h = harness()
    await h.service.start('client-1', 'dev-1')
    h.service.releaseClient('client-1')
    expect(h.stopCount()).toBe(1)

    const h2 = harness()
    await h2.service.start('client-1', 'dev-2')
    h2.end('bytes')
    expect(h2.statuses.at(-1)).toMatchObject({ state: 'stopped', deviceId: 'dev-2' })
    expect(h2.statuses.at(-1)?.reason).toContain('bytes')
    // A PUSHED status carries no buffer — resending every stroke to say the
    // stream died would be a megabyte to carry one word.
    expect(h2.statuses.at(-1)?.strokes).toBeUndefined()
    expect(h2.service.status('dev-2').state).toBe('stopped')
  })

  test('the device going away stops the capture and says so', async () => {
    const h = harness()
    await h.service.start('client-1', 'dev-1')
    h.service.stopForDevice('dev-1')
    expect(h.stopCount()).toBe(1)
    expect(h.statuses.at(-1)).toMatchObject({ state: 'stopped' })
    expect(h.statuses.at(-1)?.reason).toBe('the device went away')
  })

  test('a chunk split mid-line is reassembled, never dropped', async () => {
    const h = harness()
    await h.service.start('client-1', 'dev-1')
    const text = contact('/dev/input/event3', 300, 300, 6000, 40)
    const cut = Math.floor(text.length / 2)
    h.feed(text.slice(0, cut))
    h.feed(text.slice(cut))
    expect(h.strokes).toHaveLength(1)
    expect(h.strokes[0]?.fromRaw).toEqual({ x: 300, y: 300 })
  })
})
