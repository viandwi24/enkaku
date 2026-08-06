import { describe, expect, test } from 'bun:test'
import type { BatteryState, Viewer } from '@enkaku/protocol'
import { DeviceHeader, engineName, mmss, type DeviceDetailInfo } from './DeviceHeader'

/**
 * `DeviceHeader` (plan 57 §4.1, §7): the derived states the deleted right
 * column used to render as four panels — a fallback engine promoted to a
 * warning chip, the viewer count, and a missing battery producing no readout
 * rather than a placeholder.
 *
 * There is no DOM/rendering library in this workspace (see
 * `TileChips.test.tsx` for the established pattern this follows). The
 * component takes no hooks and no state of its own — every value is a prop —
 * so it can be called directly like any other function; the call returns a
 * plain React-element tree that the helpers below walk.
 *
 * The walk deliberately never *calls* a child component: `Popover`,
 * `Tooltip` and `DropdownMenu` are Radix components that use hooks, and
 * invoking one outside a renderer throws. It descends through element-valued
 * props instead (`children`, but also `PageHeader`'s `meta` and `actions`
 * slots), which is enough to reach everything this header renders itself.
 */

type NodeLike = unknown
interface ElementLike {
  type: unknown
  props: Record<string, unknown>
}

function isElement(node: unknown): node is ElementLike {
  return typeof node === 'object' && node !== null && 'type' in node && 'props' in node
}

/** Every element in the tree, in document order, without invoking a single component. */
function walk(node: NodeLike, visit: (el: ElementLike) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (!isElement(node)) return
  visit(node)
  for (const value of Object.values(node.props)) walk(value, visit)
}

/** The text a browser would paint, for the parts this component renders itself. */
function textOf(node: NodeLike): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (!isElement(node)) return ''
  const slots = ['children', 'meta', 'actions']
  return slots.map((slot) => textOf(node.props[slot])).join('')
}

function classesOf(node: NodeLike): string[] {
  const out: string[] = []
  walk(node, (el) => {
    if (typeof el.props.className === 'string') out.push(el.props.className)
  })
  return out
}

function ariaLabels(node: NodeLike): string[] {
  const out: string[] = []
  walk(node, (el) => {
    if (typeof el.props['aria-label'] === 'string') out.push(el.props['aria-label'])
  })
  return out
}

const battery: BatteryState = {
  level: 100,
  temperatureC: 29,
  status: 'discharging',
  health: 'good',
  updatedAt: 1,
}

const device: DeviceDetailInfo = {
  id: 'dev-1',
  stableId: 'ZP2222RMBS',
  serial: 'ZP2222RMBS',
  label: 'moto g06 — rack 1',
  androidVersion: '15',
  apiLevel: 35,
  screenW: 720,
  screenH: 1600,
  density: 280,
  status: 'idle',
  lastSeen: 1,
  battery,
  quarantineReason: null,
  tags: [],
  cluster: null,
  lastCrashAt: null,
  readiness: { desired: 'awake', actual: 'awake', blocked: null, since: 0 },
  transport: 'adb-usb',
  display: 'scrcpy',
  input: 'adb-input',
  inspection: 'ui-server',
  settings: null,
  nodeId: null,
}

function viewer(sessionId: string, holdsControl = false): Viewer {
  return { sessionId, userLabel: null, since: 1, holdsControl }
}

function render(overrides: Partial<Parameters<typeof DeviceHeader>[0]> = {}) {
  return DeviceHeader({
    device,
    status: 'idle',
    battery,
    registry: null,
    inspectorFallback: null,
    viewers: [],
    mySessionId: 's1',
    hoveredSessionId: null,
    onHoverSession: () => undefined,
    now: 1000,
    secondsLeft: null,
    holder: null,
    iHoldControl: false,
    // Who holds the device's manual lease (plan 71 §3.2) — replaces the old
    // `heldByOther: boolean`, which could not say WHO or whether the hold
    // was takeable.
    heldBy: null,
    acquiring: false,
    canRunScript: true,
    onRunScript: () => undefined,
    onTakeControl: () => undefined,
    onControlTaken: () => undefined,
    onReleaseControl: () => undefined,
    onRemove: () => undefined,
    // Lifted out of the component itself (plan 71 §3.6) — see the comment on
    // `DeviceHeader`'s own props for why: no hooks of its own, so this stays
    // callable directly, exactly like every test below does.
    takeOverOpen: false,
    onTakeOverOpenChange: () => undefined,
    // Plan 73 §3.5, §4.6 — same lifted-state pattern as `takeOverOpen` above.
    askAgentOpen: false,
    onAskAgentOpenChange: () => undefined,
    ...overrides,
  })
}

describe('DeviceHeader', () => {
  test('battery and temperature are readouts, visible without opening anything', () => {
    const text = textOf(render())
    expect(text).toContain('100%')
    expect(text).toContain('29.0°C')
    // `.readout` is the monospace, tabular-nums class every measurement uses.
    expect(classesOf(render()).some((c) => c.includes('readout'))).toBe(true)
  })

  test('a missing battery renders no readout rather than a placeholder', () => {
    const text = textOf(render({ battery: null }))
    expect(text).not.toContain('%')
    expect(text).not.toContain('°C')
    expect(text).not.toContain('—')
  })

  // A readout, not the destructive menu item, which also carries a danger colour.
  const readoutClasses = (node: NodeLike): string[] => classesOf(node).filter((c) => c.includes('readout'))

  test('a hot device paints its temperature in the danger colour', () => {
    const hot = render({ battery: { ...battery, temperatureC: 49.8 } })
    expect(readoutClasses(hot).some((c) => c.includes('text-led-danger'))).toBe(true)
    expect(readoutClasses(render()).some((c) => c.includes('text-led-danger'))).toBe(false)
  })

  test('a low battery paints its level in the warning colour', () => {
    const low = render({ battery: { ...battery, level: 12 } })
    expect(readoutClasses(low).some((c) => c.includes('text-led-warn'))).toBe(true)
    expect(readoutClasses(render()).some((c) => c.includes('text-led-warn'))).toBe(false)
  })

  test('the viewer count matches the list it opens', () => {
    const viewers = [viewer('s1'), viewer('s2', true), viewer('s3')]
    const tree = render({ viewers })
    expect(textOf(tree)).toContain('3')
    expect(ariaLabels(tree)).toContain('Viewers (3)')
    // The popover's body is handed the same array the count came from.
    let listViewers: Viewer[] | null = null
    walk(tree, (el) => {
      if (Array.isArray(el.props.viewers)) listViewers = el.props.viewers as Viewer[]
    })
    expect(listViewers).toBe(viewers)
  })

  test('a fallback engine is promoted to a visible warning chip', () => {
    const tree = render({ inspectorFallback: { to: 'uiautomator-dump', reason: 'ui-server did not start' } })
    expect(textOf(tree)).toContain('inspection fell back')
    expect(classesOf(tree).some((c) => c.includes('border-led-warn'))).toBe(true)
  })

  test('a nominal session shows no engine chip at all', () => {
    const tree = render()
    expect(textOf(tree)).not.toContain('fell back')
    expect(classesOf(tree).some((c) => c.includes('border-led-warn'))).toBe(false)
  })

  test('the idle countdown appears only while we hold control', () => {
    expect(textOf(render({ iHoldControl: true, secondsLeft: 221 }))).toContain('3:41')
    expect(textOf(render({ secondsLeft: 221 }))).not.toContain('3:41')
  })

  test('remove is a menu item, never a button in the action row', () => {
    const onRemove = () => undefined
    const tree = render({ onRemove })
    let asMenuItem = 0
    let asButton = 0
    walk(tree, (el) => {
      if (el.props.onSelect === onRemove) asMenuItem++
      if (el.props.onClick === onRemove) asButton++
    })
    expect(asMenuItem).toBe(1)
    expect(asButton).toBe(0)
    expect(ariaLabels(tree).some((l) => l.startsWith('More actions for'))).toBe(true)
  })
})

describe('engineName', () => {
  test('falls back to the raw id when the registry has no display name', () => {
    expect(engineName(null, 'inspectors', 'ui-server')).toBe('ui-server')
  })
})

describe('mmss', () => {
  test('pads the seconds', () => {
    expect(mmss(221)).toBe('3:41')
    expect(mmss(5)).toBe('0:05')
  })
})
