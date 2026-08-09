import { matchSelector, type FindOutcome, type Inspector, type Selector, type UiNode } from '@enkaku/protocol'
import { parseUiDump } from '../xml-parser'
import { UiServerClient, UiServerClientError } from './client'
import { isImplausibleMatch } from './find-guard'
import type { UiServerLauncher } from './launcher'
import { toUiSelector } from './selector'
import { createWatchdog, type UiServerStatus, type Watchdog } from './watchdog'

/** Direct element actions — an optional capability layered on Inspector (spec §7.4). */
export interface InspectorElementActions {
  setText(sel: Selector, text: string): Promise<void>
  longClick(sel: Selector): Promise<void>
  doubleClick(sel: Selector): Promise<void>
}

export function supportsElementActions(i: Inspector): i is Inspector & InspectorElementActions {
  return 'setText' in i && 'longClick' in i && 'doubleClick' in i
}

export interface UiServerInspectorOptions {
  serial: string
  localPort: number
  launcher: UiServerLauncher
  findTimeoutMs?: number
  /**
   * The device's own screen size, for the plan 60 §3.1 find guard — read at
   * most ONCE per inspector and cached, so the guard costs one `wm size`
   * (~50 ms, `profile: 'probe'`) for the life of the session rather than
   * anything per find. `null` (or an omitted provider) leaves the guard
   * disabled: with no viewport to compare against there is nothing to
   * measure, and guessing would be worse than not checking.
   */
  screenSize?: () => Promise<{ width: number; height: number } | null>
  onStatus?: (s: UiServerStatus) => void
  onLog?: (level: 'debug' | 'info' | 'warn', msg: string) => void
}

/**
 * Inspector persistent on-device (spec §7.4, pola openatx/uiautomator2):
 * the server starts once and selector queries run ON THE DEVICE → far faster
 * and far more tolerant of a changing UI than `uiautomator dump` (0.5–2s).
 *
 * The `Inspector` interface is identical to the dump engine, so swapping
 * engines is transparent to scripts (proof the §7 abstraction holds).
 */
export class UiServerInspector implements Inspector, InspectorElementActions {
  readonly id = 'ui-server'
  /** Queries are cheap → the runner may poll tightly during waitFor. */
  readonly recommendedPollIntervalMs = 80

  private client: UiServerClient
  private watchdog: Watchdog
  /** The find guard's viewport — resolved at most once (see `screenSize`). */
  private screen: Promise<{ width: number; height: number } | null> | null = null
  /** Selectors already reported as implausible, so a polling `waitFor` says it once and not twelve times a second. */
  private warned = new Set<string>()

  constructor(private opts: UiServerInspectorOptions) {
    this.client = new UiServerClient({
      localPort: opts.localPort,
      ...(opts.findTimeoutMs !== undefined ? { timeoutMs: opts.findTimeoutMs } : {}),
      // Plan 85 §3.5 (F18) — `adb forward` is torn down and re-created on every
      // ui-server restart, so a pooled keep-alive connection can outlive its
      // forward and fail as "socket connection was closed unexpectedly". The
      // client retries that case once; this is what lets the retry actually
      // repair the forward rather than just hoping the pool evicted the dead
      // connection first.
      reassertForward: () => opts.launcher.reassertForward(opts.localPort),
    })
    this.watchdog = createWatchdog({
      client: this.client,
      launcher: opts.launcher,
      localPort: opts.localPort,
      ...(opts.onStatus ? { onStatus: opts.onStatus } : {}),
      ...(opts.onLog ? { onLog: opts.onLog } : {}),
    })
  }

  start(): Promise<void> {
    return this.watchdog.start()
  }

  stop(): Promise<void> {
    return this.watchdog.stop()
  }

  /** The watchdog gave up → the session manager moves to uiautomator-dump. */
  isDead(): boolean {
    return this.watchdog.isDead()
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (err) {
      if (err instanceof UiServerClientError && err.code === 'UI_SERVER_UNREACHABLE') {
        this.watchdog.reportFailure(err.message)
      }
      throw err
    }
  }

  async dump(): Promise<UiNode> {
    try {
      return parseUiDump(await this.call(() => this.client.dumpWindowHierarchy(false)))
    } catch (err) {
      // uiautomator's own `dumpWindowHierarchy` throws — in practice a
      // NullPointerException — when the window it is asked about is
      // mid-transition: straight after a wake, during an animation, on the
      // keyguard. Observed on a moto g06 power (Android 15): the first dump
      // after waking failed, the very next one returned 103 nodes in 584 ms.
      //
      // So the failure is retried once, and once only. A device that cannot
      // dump twice in a row has a real problem, and looping would just hide
      // it behind a spinner. `UI_SERVER_UNREACHABLE` is rethrown immediately
      // instead — the watchdog is already restarting the server, and a retry
      // 300 ms later would land in the same hole.
      if (err instanceof UiServerClientError && err.code === 'UI_SERVER_UNREACHABLE') throw err
      await new Promise((resolve) => setTimeout(resolve, 300))
      return parseUiDump(await this.call(() => this.client.dumpWindowHierarchy(false)))
    }
  }

  /**
   * The viewport the find guard measures against, resolved once per inspector
   * and then reused — including a failure, which disables the guard for this
   * session rather than paying a failing `wm size` on every find.
   */
  private screenSize(): Promise<{ width: number; height: number } | null> {
    if (!this.opts.screenSize) return Promise.resolve(null)
    this.screen ??= this.opts.screenSize().catch((err: unknown) => {
      this.opts.onLog?.(
        'warn',
        `could not read the screen size of ${this.opts.serial} (${String(err)}) — the find guard is off for this session`,
      )
      return null
    })
    return this.screen
  }

  /**
   * `null` for a selector that only matches a viewport-sized container (plan
   * 60 §3.1) — the same answer `find` already gives for a genuine miss, so
   * callers need no new branch. A thin narrowing over `findDetailed` (plan 74
   * §3.5, §4.3): the guard logic lives in exactly one place, so `find()`'s
   * behaviour cannot drift from what `findDetailed()`/`device.find` report.
   */
  async find(sel: Selector): Promise<UiNode | null> {
    const outcome = await this.findDetailed(sel)
    return outcome.ok ? outcome.node : null
  }

  /**
   * `find`, honest about why (plan 74 §3.4, §4.3): `not-found` for a genuine
   * miss, `rejected-oversized` for the plan 60 §3.1 container guard. `objInfo`
   * only ever reports the first match a selector resolves to — there is no
   * on-device query for "how many nodes match" without paying for a full
   * `dump()` — so this engine can never honestly report `ambiguous`; that
   * reason is left to an engine that already has the whole tree
   * (`uiautomator-dump.ts`). Rejections are logged at `warn`, once per
   * selector, exactly as `find()` always has.
   */
  async findDetailed(sel: Selector): Promise<FindOutcome> {
    if ('point' in sel) {
      const synthetic = matchSelector({} as UiNode, sel)
      return synthetic ? { ok: true, node: synthetic } : { ok: false, reason: 'not-found', matches: 0 }
    }
    const info = await this.call(() => this.client.objInfo(toUiSelector(sel)))
    if (!info) return { ok: false, reason: 'not-found', matches: 0 }
    const node = infoToUiNode(info)
    const screen = await this.screenSize()
    if (screen && isImplausibleMatch(node, screen)) {
      const key = JSON.stringify(sel)
      if (!this.warned.has(key)) {
        this.warned.add(key)
        const { left, top, right, bottom } = node.bounds
        this.opts.onLog?.(
          'warn',
          `${key} matched a ${node.className || 'node'} covering ${left},${top} → ${right},${bottom} of a ` +
            `${screen.width}×${screen.height} screen — that is a container, not this selector's element; ` +
            'answering null (plan 60 §3.1). Use dump() to walk the tree if you meant the root.',
        )
      }
      return { ok: false, reason: 'rejected-oversized', matches: 1 }
    }
    return { ok: true, node }
  }

  screenshot(): Promise<Uint8Array> {
    return this.call(() => this.client.screenshot())
  }

  async setText(sel: Selector, text: string): Promise<void> {
    await this.call(() => this.client.setText(toUiSelector(sel), text))
  }

  async longClick(sel: Selector): Promise<void> {
    await this.call(() => this.client.longClick(toUiSelector(sel)))
  }

  async doubleClick(sel: Selector): Promise<void> {
    await this.call(() => this.client.doubleClick(toUiSelector(sel)))
  }
}

/** objInfo → UiNode (response shape verified against the pinned APK). */
function infoToUiNode(info: unknown): UiNode {
  const o = info as {
    resourceName?: string
    text?: string
    contentDescription?: string
    className?: string
    packageName?: string
    bounds?: { left?: number; top?: number; right?: number; bottom?: number }
    clickable?: boolean
    enabled?: boolean
    focused?: boolean
  }
  return {
    resourceId: o.resourceName ?? '',
    text: o.text ?? '',
    desc: o.contentDescription ?? '',
    className: o.className ?? '',
    packageName: o.packageName ?? '',
    bounds: {
      left: o.bounds?.left ?? 0,
      top: o.bounds?.top ?? 0,
      right: o.bounds?.right ?? 0,
      bottom: o.bounds?.bottom ?? 0,
    },
    clickable: o.clickable ?? false,
    enabled: o.enabled ?? true,
    focused: o.focused ?? false,
    index: 0,
    children: [],
  }
}

export { UiServerClient, UiServerClientError } from './client'
export {
  createUiServerLauncher,
  UI_SERVER_PACKAGE,
  UI_SERVER_DEVICE_PORT,
  UI_SERVER_STUB_CLASS,
  type UiServerLauncher,
  type UiServerLauncherDeps,
  type UiServerExpectedArtifact,
  type UiServerArtifactMismatch,
} from './launcher'
export { isImplausibleMatch, IMPLAUSIBLE_AREA_RATIO } from './find-guard'
export { toUiSelector, SelectorUnsupportedError, type UiSelector } from './selector'
export { createWatchdog, type UiServerStatus, type Watchdog } from './watchdog'
export { verifyDeviceArtifact, type DeviceArtifactExpectation, type VerifyResult } from './verify'
