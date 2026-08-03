import { describe, expect, test } from 'bun:test'
import type { DeviceInfo } from '@enkaku/protocol'
import { TileChips } from './TileChips'

/**
 * `TileChips` (Plan 48 §4.2, §6.3): fixed order — battery, temperature,
 * readiness, status — dash for a missing value, and the existing
 * low-battery / hot colour rules.
 *
 * There is no DOM/rendering library in this workspace (bunfig.toml's
 * `[test] root = "packages"` is the only test config, and nothing else in
 * Studio renders a component tree today — see `src/lib/actions.test.ts` for
 * the existing style, which tests plain functions). `TileChips` is a
 * function component with no hooks, so it can be called directly like any
 * other function: doing so returns a plain React-element tree (an object
 * graph), which these two small helpers walk to read out text content and
 * `className`, without needing `react-dom` or a browser DOM.
 */

type ReactNodeLike = string | number | boolean | null | undefined | ReactElementLike | ReactNodeLike[]
interface ReactElementLike {
  type: unknown
  props: Record<string, unknown>
}

function isElement(node: unknown): node is ReactElementLike {
  return typeof node === 'object' && node !== null && 'type' in node && 'props' in node
}

/** Calls down through function components (badges included) to the text a browser would paint. */
function textOf(node: ReactNodeLike): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node.type === 'function') {
    return textOf((node.type as (props: Record<string, unknown>) => ReactNodeLike)(node.props))
  }
  return textOf(node.props.children as ReactNodeLike)
}

/** The `className` of the first host element reached, following through function components. */
function classNameOf(node: ReactNodeLike): string {
  if (!isElement(node)) return ''
  if (typeof node.type === 'function') {
    return classNameOf((node.type as (props: Record<string, unknown>) => ReactNodeLike)(node.props))
  }
  return typeof node.props.className === 'string' ? node.props.className : ''
}

const BASE_DEVICE: DeviceInfo = {
  id: 'd1',
  stableId: 'stable-1',
  serial: 'emulator-5554',
  label: 'moto g06 power',
  androidVersion: '14',
  apiLevel: 34,
  screenW: 1080,
  screenH: 2400,
  density: 420,
  status: 'idle',
  lastSeen: 1_700_000_000,
  battery: { level: 80, temperatureC: 30, status: 'discharging', health: 'good', updatedAt: 1_700_000_000 },
  quarantineReason: null,
  tags: [],
  cluster: null,
  lastCrashAt: null,
  readiness: { desired: 'awake', actual: 'awake', blocked: null, since: 1_700_000_000 },
}

function device(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return { ...BASE_DEVICE, ...overrides }
}

/** The row's four children, in the exact array order JSX renders them — `false` where a chip is filtered out by `chips`. */
function rowChildren(props: Parameters<typeof TileChips>[0]) {
  const el = TileChips(props)
  const children = el.props.children
  return Array.isArray(children) ? children : [children]
}

describe('TileChips', () => {
  test('renders battery, temperature, readiness, status — in that fixed order', () => {
    const [battery, temperature, readiness, status] = rowChildren({ device: device() })
    expect(textOf(battery)).toContain('80%')
    expect(textOf(temperature)).toContain('30.0°C')
    expect(textOf(readiness)).toContain('awake')
    expect(textOf(status)).toContain('ready')
  })

  test('a missing battery reading renders a dash in place of both chips, not a collapsed row', () => {
    const children = rowChildren({ device: device({ battery: null }) })
    expect(children).toHaveLength(4)
    expect(textOf(children[0])).toBe('—')
    expect(textOf(children[1])).toBe('—')
    // Readiness and status still follow immediately after, at their fixed positions.
    expect(textOf(children[2])).toContain('awake')
    expect(textOf(children[3])).toContain('ready')
  })

  test('low battery (< 20%) gets the warn colour, otherwise the muted one', () => {
    const [lowChip] = rowChildren({ device: device({ battery: { ...BASE_DEVICE.battery!, level: 15 } }) })
    expect(classNameOf(lowChip)).toContain('text-led-warn')

    const [okChip] = rowChildren({ device: device({ battery: { ...BASE_DEVICE.battery!, level: 50 } }) })
    expect(classNameOf(okChip)).toContain('text-fg-muted')
    expect(classNameOf(okChip)).not.toContain('text-led-warn')
  })

  test('temperature at/above the threshold gets the danger colour, otherwise the muted one', () => {
    const [, hotChip] = rowChildren({
      device: device({ battery: { ...BASE_DEVICE.battery!, temperatureC: 46 } }),
      tempThresholdC: 45,
    })
    expect(classNameOf(hotChip)).toContain('text-led-danger')

    const [, coolChip] = rowChildren({
      device: device({ battery: { ...BASE_DEVICE.battery!, temperatureC: 30 } }),
      tempThresholdC: 45,
    })
    expect(classNameOf(coolChip)).toContain('text-fg-muted')
    expect(classNameOf(coolChip)).not.toContain('text-led-danger')
  })

  test('a caller-supplied threshold (topology farm config) overrides the Wall default of 45°C', () => {
    const [, chip] = rowChildren({
      device: device({ battery: { ...BASE_DEVICE.battery!, temperatureC: 38 } }),
      tempThresholdC: 35,
    })
    expect(classNameOf(chip)).toContain('text-led-danger')
  })

  test('a `chips` subset (topology, which shows readiness/status next to the label instead) keeps the fixed order and omits the rest', () => {
    const children = rowChildren({ device: device(), chips: ['battery', 'temperature'] })
    expect(textOf(children[0])).toContain('80%')
    expect(textOf(children[1])).toContain('30.0°C')
    expect(children[2]).toBe(false)
    expect(children[3]).toBe(false)
  })

  test('`chips` in a different order still renders battery before temperature', () => {
    const children = rowChildren({ device: device(), chips: ['temperature', 'battery'] })
    expect(textOf(children[0])).toContain('80%')
    expect(textOf(children[1])).toContain('30.0°C')
  })
})
