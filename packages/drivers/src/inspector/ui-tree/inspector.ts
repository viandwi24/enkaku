import {
  matchSelector,
  type FindOutcome,
  type Inspector,
  type InspectorWatch,
  type Selector,
  type Transport,
  type UiNode,
} from '@enkaku/protocol'
import type { GuestAgentClient } from '../../network/guest-agent/client'
import type { UiChangedEvent } from '@enkaku/protocol'
import { isImplausibleMatch } from '../ui-server/find-guard'

/**
 * A live `ui.watch` subscription, opened by the caller on the SAME forwarded
 * port and pairing token the agent's request/response client already owns
 * (plan 221 §3.2 decision 5, §4.11). `close()` is idempotent.
 */
export interface UiTreeWatchHandle {
  close(): Promise<void>
}

export interface UiTreeInspectorDeps {
  deviceId: string
  /**
   * The device's shell, used for exactly one thing: `screencap -p`. The agent
   * has no screenshot method (plan 221 §4.1 adds five `ui.*` methods and no
   * sixth), so this engine takes the same path `UiautomatorDumpInspector`
   * takes (`uiautomator-dump.ts`'s `screenshot()`), and the descriptor
   * advertises `screenshot` because the engine really does provide it.
   */
  transport: Transport
  /**
   * Runs `fn` against the device's ONE guest-agent client, through the shared
   * per-device session that owns the pairing token (`route-service.ts`'s
   * `DeviceSession`). Never a client this engine minted: a second token
   * invalidates the first (plan 44 §8b's "Bug 1").
   */
  withClient: <T>(fn: (client: GuestAgentClient) => Promise<T>) => Promise<T>
  /**
   * Opens ONE `ui.watch` subscription for this device and returns a handle.
   * Supplied by the host (`packages/core/src/api/guest-agent.ts`), because the
   * subscription needs the forwarded port and the token, which only the
   * device session knows. Absent means this engine has no push channel and
   * `watch()` is not implemented at all (§4.1's "absence is the honest
   * signal").
   */
  openWatch?: (hooks: {
    onEvent: (event: UiChangedEvent) => void
    onGap: (expected: number, received: number) => void
    onClose: (reason: string) => void
  }) => Promise<UiTreeWatchHandle>
  /**
   * The find guard's viewport (plan 60 §3.1), resolved at most ONCE per
   * inspector and then reused, including a failure. Identical contract to
   * `UiServerInspectorOptions.screenSize`, so the guard behaves the same on
   * both engines and swapping the default engine does not change what
   * `find()` returns for the same selector.
   */
  screenSize?: () => Promise<{ width: number; height: number } | null>
  onLog?: (level: 'debug' | 'info' | 'warn', msg: string) => void
}

/**
 * The first-party inspector (MVP 02 §4 phase 2). It reads the guest agent's
 * `AccessibilityService` over the control channel the agent already has:
 * no `am instrument`, no instrumentation lock, no per-session process, no
 * conflict with `uiautomator dump`, and a real change subscription so
 * `waitFor` can stop polling.
 *
 * It is a thin adapter and nothing more. Plan 221 §3.2 decision 2 makes the
 * device emit `UiNodeSchema`'s eleven keys and `parseUiDump`'s synthetic root
 * byte for byte, and `UiDumpResultSchema.shape.root` IS `UiNodeSchema`, so
 * there is no parsing here, no node construction, and no second selector
 * grammar. That is what makes this an engine swap rather than a rewrite.
 */
export class UiTreeInspector implements Inspector {
  readonly id = 'ui-tree'

  private last: { root: UiNode; at: number } | null = null
  private screen: Promise<{ width: number; height: number } | null> | null = null
  /** Selectors already reported as implausible, so a polling caller says it once, not twelve times a second. */
  private warned = new Set<string>()
  /** Every live `watch()` subscriber. One agent connection serves all of them (§3.6). */
  private subscribers = new Set<() => void>()
  private connection: UiTreeWatchHandle | null = null
  private opening: Promise<UiTreeWatchHandle> | null = null

  constructor(private deps: UiTreeInspectorDeps) {}

  async dump(): Promise<UiNode> {
    const result = await this.deps.withClient((c) => c.uiDump())
    if (result.truncated) {
      this.deps.onLog?.(
        'warn',
        `the UI tree on ${this.deps.deviceId} hit the device's node or depth cap (${result.nodeCount} nodes) — ` +
          'it is reported as truncated and must not be treated as a complete tree',
      )
    }
    this.last = { root: result.root, at: Date.now() }
    return result.root
  }

  /** Plan 208 §4.7's cheap cache, so a failing action's trace reuses the dump the script just paid for. */
  lastDump(): { root: UiNode; at: number } | null {
    return this.last
  }

  /**
   * The first depth-first match, whatever the match count says — a SEPARATE
   * implementation from `findDetailed()` below, not a narrowing of it, for the
   * reason `uiautomator-dump.ts` states for its own pair: a bundle published
   * before this engine existed must keep getting exactly the first match
   * (criterion 10, plan 62 §3.1). The oversized-container guard is applied
   * here too, because that is what `find()` does on every other engine and a
   * change of default engine must not change what a selector returns.
   */
  async find(sel: Selector): Promise<UiNode | null> {
    if ('point' in sel) return matchSelector({} as UiNode, sel)
    const result = await this.deps.withClient((c) => c.uiFind(sel))
    if (!result.node) return null
    return (await this.rejectedAsContainer(sel, result.node)) ? null : result.node
  }

  /**
   * `find`, honest about why (plan 74 §3.4). This engine can report all three
   * reasons: the device counts matches for free while it walks the tree, which
   * `ui-server` cannot do at all and `uiautomator-dump` can only do by paying
   * for a whole tree. Order is not-found, then the container guard, then
   * ambiguity: "this selector matches only a full-screen container" says
   * retrying will never help, which is stronger than "narrow it".
   */
  async findDetailed(sel: Selector): Promise<FindOutcome> {
    if ('point' in sel) {
      const synthetic = matchSelector({} as UiNode, sel)
      return synthetic ? { ok: true, node: synthetic } : { ok: false, reason: 'not-found', matches: 0 }
    }
    const result = await this.deps.withClient((c) => c.uiFind(sel))
    if (!result.node || result.matches === 0) return { ok: false, reason: 'not-found', matches: 0 }
    if (await this.rejectedAsContainer(sel, result.node)) return { ok: false, reason: 'rejected-oversized', matches: result.matches }
    if (result.matches > 1) return { ok: false, reason: 'ambiguous', matches: result.matches }
    return { ok: true, node: result.node }
  }

  /** The agent has no screenshot method (§3.4) — the same `screencap -p` the dump engine uses. */
  screenshot(): Promise<Uint8Array> {
    return this.deps.transport.execOut('screencap -p', { profile: 'screencap' })
  }

  /**
   * One agent connection, many subscribers (§3.6): the agent allows exactly
   * one `ui.watch` per device (plan 221 §3.2 decision 4), so two concurrent
   * `waitFor` calls must NOT each open one — the second would close the first.
   * The first subscriber opens it, the last one out closes it, and the open is
   * coalesced so two simultaneous first subscribers still open exactly one.
   */
  async watch(onChange: () => void): Promise<InspectorWatch> {
    if (!this.deps.openWatch) throw new Error(`the ui-tree engine on ${this.deps.deviceId} has no watch channel`)
    this.subscribers.add(onChange)
    try {
      this.opening ??= this.deps
        .openWatch({
          onEvent: () => this.fanOut(),
          // A gap means frames were lost, so the only safe reading is "something
          // changed" — never an attempt to reconstruct what was missed.
          onGap: (expected, received) => {
            this.deps.onLog?.('debug', `ui.watch on ${this.deps.deviceId} skipped ${received - expected} event(s)`)
            this.fanOut()
          },
          // The subscription is gone. Every waiter is woken once so it
          // re-evaluates and then falls to its own safety-net timer, rather
          // than waiting silently on a channel that will never speak again.
          onClose: (reason) => {
            this.connection = null
            this.opening = null
            this.deps.onLog?.('debug', `ui.watch on ${this.deps.deviceId} closed: ${reason}`)
            this.fanOut()
          },
        })
        .then((handle) => {
          this.connection = handle
          return handle
        })
      await this.opening
    } catch (err) {
      this.subscribers.delete(onChange)
      this.opening = null
      throw err
    }
    let closed = false
    return {
      close: async () => {
        if (closed) return
        closed = true
        this.subscribers.delete(onChange)
        if (this.subscribers.size > 0) return
        const handle = this.connection
        this.connection = null
        this.opening = null
        await handle?.close().catch(() => undefined)
      },
    }
  }

  private fanOut(): void {
    for (const cb of [...this.subscribers]) {
      try {
        cb()
      } catch {
        // A subscriber that throws must not stop the others being told.
      }
    }
  }

  private async rejectedAsContainer(sel: Selector, node: UiNode): Promise<boolean> {
    const screen = await this.screenSize()
    if (!screen || !isImplausibleMatch(node, screen)) return false
    const key = JSON.stringify(sel)
    if (!this.warned.has(key)) {
      this.warned.add(key)
      const { left, top, right, bottom } = node.bounds
      this.deps.onLog?.(
        'warn',
        `${key} matched a ${node.className || 'node'} covering ${left},${top} → ${right},${bottom} of a ` +
          `${screen.width}×${screen.height} screen — that is a container, not this selector's element; ` +
          'answering null (plan 60 §3.1). Use dump() to walk the tree if you meant the root.',
      )
    }
    return true
  }

  private screenSize(): Promise<{ width: number; height: number } | null> {
    if (!this.deps.screenSize) return Promise.resolve(null)
    this.screen ??= this.deps.screenSize().catch((err: unknown) => {
      this.deps.onLog?.(
        'warn',
        `could not read the screen size of ${this.deps.deviceId} (${String(err)}) — the find guard is off for this session`,
      )
      return null
    })
    return this.screen
  }
}
