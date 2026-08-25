import { describe, expect, test } from 'bun:test'
import type { BatteryState, LeaseHolder, Viewer } from '@enkaku/protocol'
import { AgentAlertChip } from '@/components/guest-agent/AgentAlertChip'
import { HolderBadge } from '@/components/HolderBadge'
import { PageHeader } from '@/components/layout/PageHeader'
import { LabelStateBadge } from '@/components/device/LabelStateBadge'
import { DeviceHeader, Row, engineName, mmss, type DeviceDetailInfo } from './DeviceHeader'

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

/** `PageHeader`'s `title` prop is a plain string (`textOf`'s slot walk does not include it) — this reads it directly off the element the component itself rendered. */
function pageHeaderTitle(node: NodeLike): string | null {
  let found: string | null = null
  walk(node, (el) => {
    if (el.type === PageHeader && typeof el.props.title === 'string') found = el.props.title
  })
  return found
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
  connection: { kind: 'usb', medium: null, mediumSource: 'unknown', address: null, port: null, networkLabel: null },
  transport: 'adb-usb',
  display: 'scrcpy',
  input: 'adb-input',
  inspection: 'ui-server',
  settings: null,
  liveDisplay: null,
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
    onDisconnect: () => undefined,
    onReconnect: () => undefined,
    onOpenCutover: () => undefined,
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

  /**
   * The guest-agent chip and version (plan 90 §5 step 90.6, fixes F10, F11).
   * `AgentAlertChip` and `Row` are both custom components DeviceHeader never
   * invokes (this file's own testing rule, top of file) — so what these
   * tests check is that DeviceHeader WIRES the right value to each, exactly
   * the same "props matched by element type" pattern the viewer-count test
   * above already uses. `AgentAlertChip`'s OWN suppression logic (quiet for
   * `ready`/`absent`, a real chip for `failed`/`outdated`) is rendered and
   * asserted for real in `DeviceCard.test.tsx`/`WallTile.test.tsx`.
   */
  describe('the guest-agent chip and version (plan 90 §5 step 90.6, fixes F10, F11)', () => {
    function agentChipProp(tree: NodeLike): unknown {
      let found: unknown
      walk(tree, (el) => {
        if (el.type === AgentAlertChip) found = el.props.agent
      })
      return found
    }

    function rowValue(tree: NodeLike, label: string): unknown {
      let found: unknown
      walk(tree, (el) => {
        if (el.type === Row && el.props.label === label) found = el.props.value
      })
      return found
    }

    test('a device that predates `agent` is wired as absent, never undefined', () => {
      expect(agentChipProp(render())).toBe('absent')
    })

    test('the device\'s real agent state is wired through unchanged', () => {
      expect(agentChipProp(render({ device: { ...device, agent: 'failed' } }))).toBe('failed')
      expect(agentChipProp(render({ device: { ...device, agent: 'outdated' } }))).toBe('outdated')
      expect(agentChipProp(render({ device: { ...device, agent: 'ready' } }))).toBe('ready')
    })

    test('appVersion, when known, renders in the ⓘ popover as its own row — a looked-up fact, not inline', () => {
      expect(rowValue(render({ agentVersion: '1.2.0' }), 'guest agent')).toBe('1.2.0')
      // Never inlined in the always-visible meta row above the popover.
      expect(textOf(render({ agentVersion: '1.2.0' }))).not.toContain('1.2.0')
    })

    test('an unknown appVersion renders the same "—" every other looked-up fact uses, never a placeholder string', () => {
      expect(rowValue(render({ agentVersion: null }), 'guest agent')).toBe('—')
      expect(rowValue(render({}), 'guest agent')).toBe('—')
    })
  })

  /**
   * Physical labelling's own badge (plan 89 §3.5, §5 step 89.8) — the SAME
   * "props matched by element type" pattern as the guest-agent chip above:
   * `LabelStateBadge`'s own suppression/tone logic is rendered and asserted
   * for real in `LabelStateBadge.test.tsx`; this only checks DeviceHeader
   * wires the right prop through, undefaulted, so a caller that never
   * fetched a label state renders no badge rather than a false one.
   */
  describe('labelState (plan 89 §3.5, §5 step 89.8)', () => {
    function badgeStateProp(tree: NodeLike): unknown {
      let found: unknown
      walk(tree, (el) => {
        if (el.type === LabelStateBadge) found = el.props.state
      })
      return found
    }

    test('a caller that has not fetched a label state yet renders the badge with null, never a guess', () => {
      expect(badgeStateProp(render())).toBe(null)
    })

    test('the device\'s real label state is wired through unchanged', () => {
      const state = { mode: 'wallpaper' as const, state: 'partial' as const, reason: 'only home took' }
      expect(badgeStateProp(render({ labelState: state as never }))).toBe(state as never)
    })
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

  /**
   * The Connection menu group (plan 88 §3.7, §3.8, §4.6, §5 step 88.4):
   * Disconnect and Reconnect, above their own separator, apart from the
   * destructive Remove item. §3.8's own rule — "a verb keeps its name
   * through the whole flow" — is what `DeviceCard.test.tsx` checks the SAME
   * words land on the card's menu too.
   */
  describe('the Connection menu group', () => {
    test('a tcp device: Disconnect is enabled and wired to onDisconnect', () => {
      const onDisconnect = () => undefined
      const tree = render({
        device: { ...device, connection: { kind: 'tcp', medium: 'wired', mediumSource: 'network', address: '10.0.0.5', port: 5555, networkLabel: 'Chassis A' } },
        onDisconnect,
      })
      let wired = 0
      walk(tree, (el) => {
        if (el.props.onSelect === onDisconnect) wired++
      })
      expect(wired).toBe(1)
      expect(textOf(tree)).toContain('Disconnect from the network')
    })

    test('a usb device: Disconnect is present but never wired to onDisconnect — it is disabled with a reason, not silent', () => {
      const onDisconnect = () => undefined
      const tree = render({ device: { ...device, connection: { kind: 'usb', medium: null, mediumSource: 'unknown', address: null, port: null, networkLabel: null } }, onDisconnect })
      let wired = 0
      walk(tree, (el) => {
        if (el.props.onSelect === onDisconnect) wired++
      })
      expect(wired).toBe(0)
      expect(textOf(tree)).toContain('Disconnect from the network')
      // The explanation is present somewhere in the tree (the tooltip content), not just implied.
      expect(textOf(tree)).toContain('Unplug the cable')
    })

    test('an undefined connection (a caller that predates plan 88) is treated as usb — the safe default, never a crash', () => {
      const { connection: _omitted, ...deviceWithoutConnection } = device
      expect(() => render({ device: deviceWithoutConnection as typeof device })).not.toThrow()
    })

    test('Reconnect is always a menu item wired to onReconnect, on both usb and tcp', () => {
      const onReconnect = () => undefined
      const tcp = render({
        device: { ...device, connection: { kind: 'tcp', medium: null, mediumSource: 'unknown', address: '10.0.0.5', port: 5555, networkLabel: null } },
        onReconnect,
      })
      const usb = render({ onReconnect })
      for (const tree of [tcp, usb]) {
        let wired = 0
        walk(tree, (el) => {
          if (el.props.onSelect === onReconnect) wired++
        })
        expect(wired).toBe(1)
      }
      expect(textOf(tcp)).toContain('Reconnect')
    })

    test('"Move to the network (Wi-Fi/OTG)…" appears and is wired to onOpenCutover on a usb device (plan 88 §5 step 88.5)', () => {
      const onOpenCutover = () => undefined
      const tree = render({ onOpenCutover })
      let wired = 0
      walk(tree, (el) => {
        if (el.props.onSelect === onOpenCutover) wired++
      })
      expect(wired).toBe(1)
      expect(textOf(tree)).toContain('Move to the network (Wi-Fi/OTG)…')
    })

    test('"Move to the network" is absent for a device already on tcp — nowhere left for this wizard to move it to', () => {
      const onOpenCutover = () => undefined
      const tree = render({
        device: { ...device, connection: { kind: 'tcp', medium: 'wired', mediumSource: 'network', address: '10.0.0.5', port: 5555, networkLabel: 'Chassis A' } },
        onOpenCutover,
      })
      let wired = 0
      walk(tree, (el) => {
        if (el.props.onSelect === onOpenCutover) wired++
      })
      expect(wired).toBe(0)
      expect(textOf(tree)).not.toContain('Move to the network')
    })
  })
})

/**
 * `assistedBy` (plan 91 §3.4 item 4, §4.4, F25) — orthogonal to `heldBy`,
 * rendered via the SAME `HolderBadge` this file's own testing rule never
 * invokes directly (top of file) — so what these tests check is that
 * `DeviceHeader` wires each entry through with `variant="assists"`, the
 * "props matched by element type" pattern the viewer-count test already
 * establishes above.
 */
describe('assistedBy (plan 91 §3.4 item 4, §4.4, F25)', () => {
  function assistBadgeCount(tree: NodeLike): number {
    let count = 0
    walk(tree, (el) => {
      if (el.type === HolderBadge && el.props.variant === 'assists') count++
    })
    return count
  }

  test('a device that predates the field (no assistedBy at all) renders no assist badge', () => {
    expect(assistBadgeCount(render())).toBe(0)
  })

  test('an empty assistedBy renders no assist badge', () => {
    expect(assistBadgeCount(render({ device: { ...device, assistedBy: [] } }))).toBe(0)
  })

  test('each assistedBy entry becomes its own badge, wired with variant="assists"', () => {
    const assistedBy: LeaseHolder[] = [
      { kind: 'user', id: 'u1', label: 'Alice', runId: null, takeable: false, acquiredAt: 0, expiresAt: null },
      { kind: 'user', id: 'u2', label: 'Carol', runId: null, takeable: false, acquiredAt: 0, expiresAt: null },
    ]
    expect(assistBadgeCount(render({ device: { ...device, assistedBy } }))).toBe(2)
  })

  test('shown regardless of iHoldControl — an assist grant never moves the lease', () => {
    const assistedBy: LeaseHolder[] = [{ kind: 'user', id: 'u1', label: 'Alice', runId: null, takeable: false, acquiredAt: 0, expiresAt: null }]
    expect(assistBadgeCount(render({ device: { ...device, assistedBy }, iHoldControl: true }))).toBe(1)
    expect(assistBadgeCount(render({ device: { ...device, assistedBy }, iHoldControl: false }))).toBe(1)
  })
})

describe('the device number in the title (plan 89 §3.3, §5 step 89.3)', () => {
  test('a device with no number (an explicitly released reservation) shows the label alone', () => {
    expect(pageHeaderTitle(render())).toBe(device.label)
  })

  test('a device with a number shows `#7 <label>` — composed, never baked into `label` itself', () => {
    expect(pageHeaderTitle(render({ device: { ...device, number: 7 } }))).toBe(`#7 ${device.label}`)
    // The underlying field is untouched — only the title string composes them.
    expect(device.label).not.toContain('#7')
  })

  /**
   * Plan 124 §4.4 Group B, step 124.2 — the title above was one of the four
   * render sites in the whole web UI that had this right; everything else on
   * this same header named the device by its bare `label`. The composition is
   * now hoisted into one `deviceName` const the header reads everywhere, so
   * these two assertions are what stop a second spelling reappearing.
   */
  test('the "More actions" menu is labelled with the number too, not the bare label', () => {
    const labels = ariaLabels(render({ device: { ...device, number: 7 }, onRemove: () => undefined }))
    expect(labels).toContain(`More actions for #7 ${device.label}`)
  })

  test('a device with no number labels that menu with the bare label — no `#`, no `#null` (criterion 7)', () => {
    const labels = ariaLabels(render({ onRemove: () => undefined })).filter((l) => l.startsWith('More actions for'))
    expect(labels).toEqual([`More actions for ${device.label}`])
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

describe('Run a script — only `quarantined` blocks it, never `offline`', () => {
  /**
   * The core rejects exactly one status at enqueue (`createJobStore.enqueue`
   * throws only for `quarantined`), and `claimNext` holds every other job
   * until its device reaches `idle` — which an offline phone does by itself
   * on reconnect. This header used to disable the button for `offline` too,
   * so a job the core would have queued and run could not be started from
   * the page an operator is most likely to start it from.
   */
  function runButton(node: NodeLike): ElementLike | null {
    let found: ElementLike | null = null
    walk(node, (el) => {
      if (found) return
      if (textOf(el).trim() === 'Run a script' && typeof el.props.disabled === 'boolean') found = el
    })
    return found
  }

  test('an offline device can be given a job — the button is live and wired', () => {
    const btn = runButton(render({ status: 'offline' }))
    expect(btn).not.toBeNull()
    expect(btn?.props.disabled).toBe(false)
    expect(typeof btn?.props.onClick).toBe('function')
  })

  test('a quarantined device is still refused — the one status the core rejects', () => {
    const btn = runButton(render({ status: 'quarantined' }))
    expect(btn?.props.disabled).toBe(true)
  })

  test('`canRunScript: false` (a farm with no scripts) still disables it, offline or not', () => {
    expect(runButton(render({ status: 'offline', canRunScript: false }))?.props.disabled).toBe(true)
  })
})
