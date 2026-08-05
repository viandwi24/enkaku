import { matchSelector, type Inspector, type Selector, type UiNode } from '@enkaku/protocol'
import { parseUiDump } from '../xml-parser'
import { UiServerClient, UiServerClientError } from './client'
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

  constructor(private opts: UiServerInspectorOptions) {
    this.client = new UiServerClient({
      localPort: opts.localPort,
      ...(opts.findTimeoutMs !== undefined ? { timeoutMs: opts.findTimeoutMs } : {}),
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

  async find(sel: Selector): Promise<UiNode | null> {
    if ('point' in sel) return matchSelector({} as UiNode, sel)
    const info = await this.call(() => this.client.objInfo(toUiSelector(sel)))
    if (!info) return null
    return infoToUiNode(info)
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
export { toUiSelector, SelectorUnsupportedError, type UiSelector } from './selector'
export { createWatchdog, type UiServerStatus, type Watchdog } from './watchdog'
export { verifyDeviceArtifact, type DeviceArtifactExpectation, type VerifyResult } from './verify'
