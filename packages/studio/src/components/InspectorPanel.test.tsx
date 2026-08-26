import { describe, expect, test } from 'bun:test'
import type { ServerMessage, UiNode } from '@enkaku/protocol'
import {
  applyFallbackMessage,
  engineDescription,
  InspectorNeedsControl,
  keepSelection,
  nodeAt,
  seedExpanded,
  serialiseTree,
  shouldPoll,
  unchangedSuffix,
} from './InspectorPanel'

/**
 * Plan 59 ships a test rather than a component, and that is the point: every
 * change in the plan is a change to how an existing panel *behaves* — when it
 * attaches, when it re-renders, and what it says — so the only artefact that
 * can prove it shipped is the one that pins those behaviours.
 *
 * There is no DOM renderer in this workspace (`bunfig.toml` is the whole test
 * config; see `TileChips.test.tsx` for the note on this). `InspectorPanel`
 * itself uses hooks and cannot be called outside a renderer, so the parts of
 * it this plan changed were written as exported functions and one hook-free
 * component, which can be — and the helpers below walk the React element tree
 * they return without needing a browser.
 *
 * What that leaves untested here, honestly: the effects. That the attach
 * effect is keyed on the lease (§3.2), that `ScreenCard` no longer unmounts
 * the panel (§4.2), and that releasing control detaches (acceptance #6) are
 * all `useEffect` behaviour, and they are verified by reading and by the
 * manual smoke in §7 — not by this file.
 */

type NodeLike = unknown
interface ElementLike {
  type: unknown
  props: Record<string, unknown>
}

function isElement(node: unknown): node is ElementLike {
  return typeof node === 'object' && node !== null && 'type' in node && 'props' in node
}

/** The text a browser would paint — calling down through function components (`EmptyState`, `Button`), which none of these use hooks. */
function textOf(node: NodeLike): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (!isElement(node)) return ''
  if (typeof node.type === 'function') {
    return textOf((node.type as (props: Record<string, unknown>) => NodeLike)(node.props))
  }
  return textOf(node.props.children)
}

/** Every `className` in the painted output, function components included. */
function classesOf(node: NodeLike): string[] {
  const out: string[] = []
  const walk = (n: NodeLike) => {
    if (Array.isArray(n)) {
      for (const child of n) walk(child)
      return
    }
    if (!isElement(n)) return
    if (typeof n.type === 'function') {
      walk((n.type as (props: Record<string, unknown>) => NodeLike)(n.props))
      return
    }
    if (typeof n.props.className === 'string') out.push(n.props.className)
    for (const value of Object.values(n.props)) walk(value)
  }
  walk(node)
  return out
}

/** Every host element in the painted output, in document order. */
function hostElements(node: NodeLike): ElementLike[] {
  const out: ElementLike[] = []
  const walk = (n: NodeLike) => {
    if (Array.isArray(n)) {
      for (const child of n) walk(child)
      return
    }
    if (!isElement(n)) return
    if (typeof n.type === 'function') {
      walk((n.type as (props: Record<string, unknown>) => NodeLike)(n.props))
      return
    }
    out.push(n)
    for (const value of Object.values(n.props)) walk(value)
  }
  walk(node)
  return out
}

// ---- tree fixtures ----

function node(overrides: Partial<UiNode> = {}): UiNode {
  return {
    resourceId: '',
    text: '',
    desc: '',
    className: 'android.widget.FrameLayout',
    packageName: 'com.example.app',
    bounds: { left: 0, top: 0, right: 100, bottom: 100 },
    clickable: false,
    enabled: true,
    focused: false,
    index: 0,
    children: [],
    ...overrides,
  }
}

/** root → [row0 → [label], row1] — deep enough to exercise paths and expansion depth. */
function tree(): UiNode {
  return node({
    className: 'android.widget.LinearLayout',
    children: [
      node({
        className: 'android.widget.LinearLayout',
        index: 0,
        children: [node({ className: 'android.widget.TextView', text: 'Sign in', index: 0 })],
      }),
      node({ className: 'android.widget.Button', text: 'Cancel', index: 1, clickable: true }),
    ],
  })
}

describe('serialiseTree — the unchanged-dump comparison (§3.4)', () => {
  test('two structurally identical trees serialise identically', () => {
    expect(serialiseTree(tree())).toBe(serialiseTree(tree()))
  })

  /**
   * The comparison has to be TOTAL (§8 risk table). A false "unchanged" hides
   * a real change on a screen someone is reading conclusions off, which is far
   * worse than one unnecessary re-render — so every field of `UiNode` is
   * checked here one at a time, not a representative sample.
   */
  const mutations: Array<[string, (n: UiNode) => UiNode]> = [
    ['resourceId', (n) => ({ ...n, resourceId: 'com.example:id/ok' })],
    ['text', (n) => ({ ...n, text: 'Sign out' })],
    ['desc', (n) => ({ ...n, desc: 'Close' })],
    ['className', (n) => ({ ...n, className: 'android.widget.ImageView' })],
    ['packageName', (n) => ({ ...n, packageName: 'com.other.app' })],
    ['index', (n) => ({ ...n, index: 7 })],
    ['bounds.left', (n) => ({ ...n, bounds: { ...n.bounds, left: 1 } })],
    ['bounds.top', (n) => ({ ...n, bounds: { ...n.bounds, top: 1 } })],
    ['bounds.right', (n) => ({ ...n, bounds: { ...n.bounds, right: 101 } })],
    ['bounds.bottom', (n) => ({ ...n, bounds: { ...n.bounds, bottom: 101 } })],
    ['clickable', (n) => ({ ...n, clickable: !n.clickable })],
    ['enabled', (n) => ({ ...n, enabled: !n.enabled })],
    ['focused', (n) => ({ ...n, focused: !n.focused })],
    ['children', (n) => ({ ...n, children: [...n.children, node({ className: 'android.view.View' })] })],
  ]

  for (const [field, mutate] of mutations) {
    test(`a change to ${field} is never reported as unchanged`, () => {
      const before = tree()
      const after = tree()
      // Mutate a node buried in the tree, not the root — the walk has to reach it.
      const target = after.children[0]!.children[0]!
      after.children[0]!.children[0] = mutate(target)
      expect(serialiseTree(after)).not.toBe(serialiseTree(before))
    })
  }

  test('a field whose text contains a separator cannot forge a match', () => {
    // Naive delimiter-joined serialisation would read these two as the same
    // node with different field boundaries.
    const a = tree()
    const b = tree()
    a.children[0]!.children[0] = node({ className: 'x', text: 'a","b', index: 0 })
    b.children[0]!.children[0] = node({ className: 'x', text: 'a', desc: 'b', index: 0 })
    expect(serialiseTree(a)).not.toBe(serialiseTree(b))
  })

  test('a subtree moved to a different parent is a change', () => {
    const before = tree()
    const after = tree()
    const moved = after.children[0]!.children[0]!
    after.children[0]!.children = []
    after.children[1]!.children = [moved]
    expect(serialiseTree(after)).not.toBe(serialiseTree(before))
  })
})

describe('keepSelection — the operator keeps their node (§3.4)', () => {
  test('a path that still resolves survives a changed dump', () => {
    const next = tree()
    // The label's text changed, but the node at [0, 0] is still there.
    next.children[0]!.children[0] = node({ className: 'android.widget.TextView', text: 'Signed in', index: 0 })
    expect(keepSelection(next, [0, 0])).toEqual([0, 0])
    expect(nodeAt(next, [0, 0])?.text).toBe('Signed in')
  })

  test('a path whose node genuinely went away is cleared', () => {
    const next = tree()
    next.children[0]!.children = []
    expect(keepSelection(next, [0, 0])).toBeNull()
  })

  test('no selection stays no selection', () => {
    expect(keepSelection(tree(), null)).toBeNull()
  })
})

describe('seedExpanded — a changed tree does not collapse itself (§3.4)', () => {
  test('seeds the default depth of the fresh tree', () => {
    const expanded = seedExpanded(tree(), 2)
    expect(expanded.has('root')).toBe(true)
    expect(expanded.has('0')).toBe(true)
    // Depth 2 and below is not opened by default.
    expect(expanded.has('0.0')).toBe(false)
  })

  test('a branch the operator opened by hand stays open when it still exists', () => {
    const deep = node({
      children: [node({ children: [node({ children: [node({ text: 'leaf' })] })] })],
    })
    const expanded = seedExpanded(deep, 1, new Set(['0.0']))
    expect(expanded.has('0.0')).toBe(true)
  })

  test('a branch that no longer exists is not carried over', () => {
    const expanded = seedExpanded(tree(), 1, new Set(['0.0.0.0']))
    expect(expanded.has('0.0.0.0')).toBe(false)
  })
})

describe('shouldPoll — follow is on by default, and stays honest (§3.5)', () => {
  const on = { follow: true, visible: true, canUse: true, ready: true, pageVisible: true }

  test('polls when the panel is on screen, ready, and holds the lease', () => {
    expect(shouldPoll(on)).toBe(true)
  })

  test('does not tick while the panel is not visible — Live showing, or another tab open', () => {
    expect(shouldPoll({ ...on, visible: false })).toBe(false)
  })

  test('does not tick without the lease — the server would refuse the dump anyway', () => {
    expect(shouldPoll({ ...on, canUse: false })).toBe(false)
  })

  test('does not tick before the engine is ready', () => {
    expect(shouldPoll({ ...on, ready: false })).toBe(false)
  })

  test('does not tick while the browser tab is in the background (§9 Q1)', () => {
    expect(shouldPoll({ ...on, pageVisible: false })).toBe(false)
  })

  test('does not tick when it is switched off', () => {
    expect(shouldPoll({ ...on, follow: false })).toBe(false)
  })
})

describe('unchangedSuffix — "checked 1s ago, unchanged" (§3.4)', () => {
  const now = 1_700_000_010_000
  const nowSec = now / 1000

  test('says so when the last check found nothing changed', () => {
    expect(unchangedSuffix({ at: nowSec - 1, unchanged: true }, nowSec - 30, now)).toBe(' · checked 1s ago, unchanged')
  })

  test('says nothing when the last check brought a new tree — the age line already reports it', () => {
    expect(unchangedSuffix({ at: nowSec - 1, unchanged: false }, nowSec - 1, now)).toBe('')
  })

  test('says nothing before any second dump has come back', () => {
    expect(unchangedSuffix(null, nowSec - 1, now)).toBe('')
    // A check no newer than the tree itself IS the dump that produced it.
    expect(unchangedSuffix({ at: nowSec - 30, unchanged: true }, nowSec - 30, now)).toBe('')
  })
})

describe('engineDescription — names the engine actually in use (plan 129 §4.3)', () => {
  test('ui-server, no fallback: a plain sentence naming the engine', () => {
    expect(engineDescription('ui-server', null)).toBe('Reading through ui-server.')
  })

  test('uiautomator-dump with no recorded reason still says it is the fallback engine', () => {
    // This is the "attached to an already-degraded session" case: the
    // `device.inspector.fallback` broadcast fired before this tab attached,
    // so the reason was never seen — but the engine id alone is enough to
    // say the session did not get the fast engine.
    expect(engineDescription('uiautomator-dump', null)).toBe('Reading through uiautomator-dump — the slower fallback engine.')
  })

  test('uiautomator-dump with a fallback reason names why, not just that', () => {
    const text = engineDescription('uiautomator-dump', 'ui-server was not ready within the start timeout')
    expect(text).toContain('ui-server could not start')
    expect(text).toContain('ui-server was not ready within the start timeout')
    expect(text).toContain('fell back to the slower engine')
  })

  test('an unrecognised engine id still gets a sentence, not a blank', () => {
    expect(engineDescription('some-future-engine', null)).toBe('Reading through some-future-engine.')
  })

  test('empty engine id (not yet attached) is silent', () => {
    expect(engineDescription('', null)).toBe('')
  })

  test('never words the fallback as the nominal state (docs/design.md, "Writing the words")', () => {
    // The fallback engine genuinely works — this must read as a fact, not an
    // error, so it must never claim the fast engine is what is running.
    const text = engineDescription('uiautomator-dump', 'connection refused')
    expect(text).not.toContain('Reading through ui-server.')
  })
})

describe('applyFallbackMessage — a fallback broadcast is surfaced, never dropped (plan 129 §4.3)', () => {
  const deviceId = 'dev-1'
  const fallback = (id: string, reason: string): ServerMessage =>
    ({ type: 'device.inspector.fallback', payload: { deviceId: id, from: 'ui-server', to: 'uiautomator-dump', reason } }) as ServerMessage
  const starting = (id: string): ServerMessage =>
    ({ type: 'inspect.status', payload: { deviceId: id, state: 'starting', engineId: '', capabilities: [] } }) as ServerMessage
  const ready = (id: string): ServerMessage =>
    ({ type: 'inspect.status', payload: { deviceId: id, state: 'ready', engineId: 'uiautomator-dump', capabilities: ['dump'] } }) as ServerMessage

  test('a fallback broadcast for this device sets the reason', () => {
    expect(applyFallbackMessage(null, deviceId, fallback(deviceId, 'connection refused'))).toBe('connection refused')
  })

  test('a fallback broadcast for a DIFFERENT device is ignored', () => {
    expect(applyFallbackMessage(null, deviceId, fallback('dev-2', 'connection refused'))).toBeNull()
  })

  test('a new attach starting fresh clears a stale reason from a previous session', () => {
    expect(applyFallbackMessage('an old reason', deviceId, starting(deviceId))).toBeNull()
  })

  test('"starting" for a different device does not clear this one', () => {
    expect(applyFallbackMessage('an old reason', deviceId, starting('dev-2'))).toBe('an old reason')
  })

  test('an unrelated message (e.g. the ready reply itself) leaves the reason untouched', () => {
    expect(applyFallbackMessage('an old reason', deviceId, ready(deviceId))).toBe('an old reason')
  })
})

describe('InspectorNeedsControl — a precondition, not a failure (§3.1)', () => {
  const render = (overrides: Partial<Parameters<typeof InspectorNeedsControl>[0]> = {}) =>
    InspectorNeedsControl({ onTakeControl: () => undefined, ...overrides })

  test('carries no error styling at all', () => {
    const classes = classesOf(render()).join(' ')
    // `ErrorState`'s signature: a danger border and a danger wash. Nothing
    // here paints in the colour reserved for something having gone wrong.
    // (`aria-invalid:*-destructive` is in every shadcn button's base class and
    // is a form-validation state, not a colour this component ever shows.)
    expect(classes).not.toContain('led-danger')
    expect(classes).not.toContain('bg-destructive')
    expect(classes).not.toContain('text-destructive')
  })

  test('never says something failed, and never leaks a message name at the operator', () => {
    const text = textOf(render())
    expect(text).not.toContain('Could not load')
    expect(text).not.toContain('lease.acquire')
    expect(text).not.toContain('Error')
  })

  test('names what is needed and why reading the screen needs it', () => {
    const text = textOf(render())
    expect(text).toContain('Take control to inspect this screen')
    // The reason the lease requirement stays (plan 56 §3.7) is said in the
    // operator's own terms, not as a rule handed down.
    expect(text).toContain('typed into a field')
    expect(text).toContain('instrumentation lock')
  })

  test('offers the fix where the problem was found', () => {
    let taken = 0
    const buttons = hostElements(render({ onTakeControl: () => (taken += 1) })).filter((el) => el.type === 'button')
    expect(buttons).toHaveLength(1)
    const button = buttons[0]!
    expect(button.props.disabled).toBe(false)
    expect(textOf(button)).toContain('Take control')
    ;(button.props.onClick as () => void)()
    expect(taken).toBe(1)
  })

  test('when control cannot be taken at all, the button is genuinely disabled and the state it needs is on screen', () => {
    const reason = 'The device is not connected to this farm'
    const tree = render({ disabledReason: reason })
    const button = hostElements(tree).find((el) => el.type === 'button')!
    expect(button.props.disabled).toBe(true)
    expect(button.props.title).toBe(reason)
    // Not only in a tooltip: a reason nobody hovers over is a reason nobody reads.
    expect(textOf(tree)).toContain(reason)
    // Still calm — a device being offline is not an error either.
    expect(classesOf(tree).join(' ')).not.toContain('led-danger')
  })
})
