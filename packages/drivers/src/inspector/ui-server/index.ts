import type { Inspector, Selector, UiNode } from '@enkaku/protocol'
import { matchSelector } from '../selector'
import { parseUiDump } from '../xml-parser'
import { UiServerClient, UiServerClientError } from './client'
import type { UiServerLauncher } from './launcher'
import { toUiSelector } from './selector'
import { createWatchdog, type UiServerStatus, type Watchdog } from './watchdog'

/** Aksi elemen langsung — capability opsional di atas Inspector (spec §7.4). */
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
 * server hidup sekali, query selector dieksekusi DI DEVICE → jauh lebih
 * cepat & tahan UI berubah dibanding `uiautomator dump` (0,5–2 detik).
 *
 * Interface `Inspector` identik dengan engine dump → swap engine
 * transparan untuk script (bukti abstraksi §7 benar).
 */
export class UiServerInspector implements Inspector, InspectorElementActions {
  readonly id = 'ui-server'
  /** Query murah → runner boleh poll rapat saat waitFor. */
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

  /** Watchdog menyerah → session manager memindahkan ke uiautomator-dump. */
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
    const xml = await this.call(() => this.client.dumpWindowHierarchy(false))
    return parseUiDump(xml)
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

/** objInfo → UiNode (bentuk respons diverifikasi terhadap APK yang di-pin). */
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
export { createUiServerLauncher, UI_SERVER_PACKAGE, UI_SERVER_DEVICE_PORT, type UiServerLauncher } from './launcher'
export { toUiSelector, SelectorUnsupportedError, type UiSelector } from './selector'
export { createWatchdog, type UiServerStatus, type Watchdog } from './watchdog'
