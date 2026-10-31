import { describe, expect, test } from 'bun:test'
import { parseTouchPanels } from './probe'

/** A real-shaped `getevent -pl` dump: a key device, the glass, and the farm's own UHID pointer. */
const DUMP = `add device 1: /dev/input/event0
  name:     "gpio-keys"
  events:
    KEY (0001): KEY_VOLUMEDOWN        KEY_VOLUMEUP
  input props:
    <none>
add device 2: /dev/input/event2
  name:     "accelerometer"
  events:
    ABS (0003): ABS_X                 : value 0, min -32768, max 32767, fuzz 0, flat 0, resolution 0
                ABS_Y                 : value 0, min -32768, max 32767, fuzz 0, flat 0, resolution 0
add device 3: /dev/input/event3
  name:     "sec_touchscreen"
  events:
    KEY (0001): BTN_TOUCH             BTN_TOOL_FINGER
    ABS (0003): ABS_MT_SLOT           : value 0, min 0, max 9, fuzz 0, flat 0, resolution 0
                ABS_MT_POSITION_X     : value 0, min 0, max 1079, fuzz 0, flat 0, resolution 0
                ABS_MT_POSITION_Y     : value 0, min 0, max 2339, fuzz 0, flat 0, resolution 0
                ABS_MT_PRESSURE       : value 0, min 0, max 255, fuzz 0, flat 0, resolution 0
                ABS_MT_TRACKING_ID    : value 0, min 0, max 65535, fuzz 0, flat 0, resolution 0
  input props:
    INPUT_PROP_DIRECT
add device 4: /dev/input/event7
  name:     "Enkaku Pointer"
  events:
    KEY (0001): BTN_TOUCH
    ABS (0003): ABS_MT_SLOT           : value 0, min 0, max 1, fuzz 0, flat 0, resolution 0
                ABS_MT_POSITION_X     : value 0, min 0, max 32767, fuzz 0, flat 0, resolution 0
                ABS_MT_POSITION_Y     : value 0, min 0, max 32767, fuzz 0, flat 0, resolution 0
                ABS_MT_TRACKING_ID    : value 0, min 0, max 65535, fuzz 0, flat 0, resolution 0
`

describe('parseTouchPanels (plan 1000 §4.2)', () => {
  test('finds the glass with its axis maxima — the divisor behind every normalised coordinate', () => {
    const panels = parseTouchPanels(DUMP)
    const glass = panels.find((p) => p.path === '/dev/input/event3')
    expect(glass).toEqual({
      path: '/dev/input/event3',
      name: 'sec_touchscreen',
      protocol: 'mt-b',
      maxX: 1079,
      maxY: 2339,
      pressureMax: 255,
      synthetic: false,
    })
  })

  test("the farm's own UHID pointer is reported, not hidden, and marked synthetic", () => {
    const pointer = parseTouchPanels(DUMP).find((p) => p.path === '/dev/input/event7')
    expect(pointer?.synthetic).toBe(true)
    expect(pointer?.maxX).toBe(32767)
    expect(pointer?.pressureMax).toBeNull()
  })

  test('a key pad and an accelerometer are not touch panels — ABS_X/ABS_Y alone never qualifies', () => {
    const paths = parseTouchPanels(DUMP).map((p) => p.path)
    expect(paths).toEqual(['/dev/input/event3', '/dev/input/event7'])
  })

  test('a single-touch panel needs BTN_TOUCH, and is protocol `st`', () => {
    const panels = parseTouchPanels(`add device 1: /dev/input/event1
  name:     "ft5x06_ts"
  events:
    KEY (0001): BTN_TOUCH
    ABS (0003): ABS_X                 : value 0, min 0, max 479, fuzz 0, flat 0, resolution 0
                ABS_Y                 : value 0, min 0, max 799, fuzz 0, flat 0, resolution 0
`)
    expect(panels).toHaveLength(1)
    expect(panels[0]?.protocol).toBe('st')
    expect(panels[0]?.maxY).toBe(799)
  })

  test('multi-touch with no slot axis is protocol A, not B', () => {
    const panels = parseTouchPanels(`add device 1: /dev/input/event1
  name:     "old_ts"
  events:
    ABS (0003): ABS_MT_POSITION_X     : value 0, min 0, max 599, fuzz 0, flat 0, resolution 0
                ABS_MT_POSITION_Y     : value 0, min 0, max 1023, fuzz 0, flat 0, resolution 0
`)
    expect(panels[0]?.protocol).toBe('mt-a')
  })

  test('unlabelled axes (a build whose -l did not resolve them) are read through their hex codes', () => {
    const panels = parseTouchPanels(`add device 1: /dev/input/event1
  name:     "raw_ts"
  events:
    ABS (0003): 002f  : value 0, min 0, max 9, fuzz 0, flat 0, resolution 0
                0035  : value 0, min 0, max 1079, fuzz 0, flat 0, resolution 0
                0036  : value 0, min 0, max 2339, fuzz 0, flat 0, resolution 0
`)
    expect(panels[0]).toMatchObject({ protocol: 'mt-b', maxX: 1079, maxY: 2339 })
  })

  test('a dump with no touch device at all yields nothing, rather than a panel with a zero axis', () => {
    expect(parseTouchPanels('add device 1: /dev/input/event0\n  name:     "gpio-keys"\n')).toEqual([])
  })
})
