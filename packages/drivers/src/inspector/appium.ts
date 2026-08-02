import type { Inspector, Selector, UiNode } from '@enkaku/protocol'
import { matchSelector } from './selector'
import { parseUiDump } from './xml-parser'

/**
 * Inspector `appium` — OPT-IN (spec §6.3, §7.1).
 *
 * Why it is opt-in rather than default: Appium uses roughly 500 MB per session
 * runs a JVM; on a small box (the spec §16 NFR target: Intel N100 4 GB, SBCs at
 * 1–2 GB) that does not add up for everyday use.
 *
 * When it earns its keep: hybrid/WebView apps that need NATIVE ⇄ WEBVIEW
 * context switching and DOM inspection — things that cannot be done
 * accessibility tree (`ui-server`).
 *
 * The `instrumentation` and `input-injection` locks stop it running alongside
 * ui-server or scrcpy input (spec §9.5).
 */
export interface AppiumInspectorOptions {
  /** Base URL server Appium (mis. http://127.0.0.1:4723). */
  serverUrl: string
  /** W3C capabilities used to create the session. */
  capabilities: Record<string, unknown>
  onLog?: (level: 'debug' | 'warn', msg: string) => void
}

export class AppiumInspector implements Inspector {
  readonly id = 'appium'
  /** An Appium query is relatively expensive (HTTP plus JVM) — do not poll as tightly as ui-server. */
  readonly recommendedPollIntervalMs = 300
  private sessionId: string | null = null

  constructor(private opts: AppiumInspectorOptions) {}

  private get base(): string {
    return this.opts.serverUrl.replace(/\/$/, '')
  }

  async start(): Promise<void> {
    if (this.sessionId) return
    const res = await fetch(`${this.base}/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ capabilities: { alwaysMatch: this.opts.capabilities, firstMatch: [{}] } }),
    })
    const body = (await res.json()) as { value?: { sessionId?: string; error?: string; message?: string } }
    if (!res.ok || !body.value?.sessionId) {
      throw new Error(`failed to create the Appium session: ${body.value?.message ?? `HTTP ${res.status}`}`)
    }
    this.sessionId = body.value.sessionId
    this.opts.onLog?.('debug', `Appium session created: ${this.sessionId}`)
  }

  async stop(): Promise<void> {
    if (!this.sessionId) return
    await fetch(`${this.base}/session/${this.sessionId}`, { method: 'DELETE' }).catch(() => undefined)
    this.sessionId = null
  }

  private async request<T>(path: string): Promise<T> {
    if (!this.sessionId) await this.start()
    const res = await fetch(`${this.base}/session/${this.sessionId}${path}`)
    const body = (await res.json()) as { value?: T }
    if (!res.ok) throw new Error(`Appium ${path} failed: HTTP ${res.status}`)
    return body.value as T
  }

  async dump(): Promise<UiNode> {
    // Appium returns an XML hierarchy in the same format as uiautomator dump,
    // so the Plan 05 parser is reused.
    const xml = await this.request<string>('/source')
    return parseUiDump(xml)
  }

  async find(sel: Selector): Promise<UiNode | null> {
    if ('point' in sel) return matchSelector({} as UiNode, sel)
    const root = await this.dump()
    return matchSelector(root, sel)
  }

  async screenshot(): Promise<Uint8Array> {
    const base64 = await this.request<string>('/screenshot')
    return Uint8Array.from(Buffer.from(base64, 'base64'))
  }
}
