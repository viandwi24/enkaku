import type { Inspector, Selector, UiNode } from '@enkaku/protocol'
import { matchSelector } from './selector'
import { parseUiDump } from './xml-parser'

/**
 * Inspector `appium` — OPT-IN (spec §6.3, §7.1).
 *
 * Kenapa opt-in, bukan default: Appium memakai ~500 MB per sesi dan
 * menjalankan JVM; di box kecil (target NFR spec §16: Intel N100 4 GB, SBC
 * 1–2 GB) itu tidak masuk akal untuk pemakaian sehari-hari.
 *
 * Kapan berguna: aplikasi hybrid/WebView yang butuh context switching
 * NATIVE ⇄ WEBVIEW dan inspeksi DOM — hal yang tidak bisa dilakukan
 * accessibility tree (`ui-server`).
 *
 * Lock `instrumentation` + `input-injection` membuatnya tidak bisa aktif
 * bersamaan dengan ui-server maupun input scrcpy (spec §9.5).
 */
export interface AppiumInspectorOptions {
  /** Base URL server Appium (mis. http://127.0.0.1:4723). */
  serverUrl: string
  /** Kapabilitas W3C untuk membuat sesi. */
  capabilities: Record<string, unknown>
  onLog?: (level: 'debug' | 'warn', msg: string) => void
}

export class AppiumInspector implements Inspector {
  readonly id = 'appium'
  /** Query Appium relatif mahal (HTTP + JVM) — jangan poll serapat ui-server. */
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
      throw new Error(`gagal membuat sesi Appium: ${body.value?.message ?? `HTTP ${res.status}`}`)
    }
    this.sessionId = body.value.sessionId
    this.opts.onLog?.('debug', `sesi Appium dibuat: ${this.sessionId}`)
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
    if (!res.ok) throw new Error(`Appium ${path} gagal: HTTP ${res.status}`)
    return body.value as T
  }

  async dump(): Promise<UiNode> {
    // Appium mengembalikan XML hierarchy dengan format yang sama dengan
    // uiautomator dump → parser Plan 05 dipakai ulang.
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
