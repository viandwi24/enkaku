import { z } from 'zod'
import type { UiSelector } from './selector'

/**
 * Client JSONRPC ke server on-device (pola openatx/uiautomator2).
 *
 * The usable method SUBSET is deliberately narrow (plan 06 §4.4) so that
 * moving to our own APK stays a small surface. The method names below MUST be
 * verified against the pinned APK version (TODO-verify on a real device).
 */

const JsonRpcResponse = z.object({
  jsonrpc: z.literal('2.0').optional(),
  id: z.union([z.string(), z.number()]).optional(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number().optional(), message: z.string().optional() }).nullable().optional(),
})

export class UiServerClientError extends Error {
  constructor(
    public code: 'UI_SERVER_UNREACHABLE' | 'UI_SERVER_RPC_ERROR',
    message: string,
  ) {
    super(message)
  }
}

export interface UiServerClientOptions {
  localPort: number
  /** Per-call timeout in ms — defaults to 3000. */
  timeoutMs?: number
}

export class UiServerClient {
  private nextId = 1

  constructor(private opts: UiServerClientOptions) {}

  private get base(): string {
    return `http://127.0.0.1:${this.opts.localPort}`
  }

  private async fetchWithTimeout(url: string, init?: RequestInit, timeoutMs?: number): Promise<Response> {
    const ms = timeoutMs ?? this.opts.timeoutMs ?? 3000
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(ms) })
    } catch (err) {
      throw new UiServerClientError('UI_SERVER_UNREACHABLE', `${url} did not respond within ${ms}ms: ${String(err)}`)
    }
  }

  /** Health check — short timeout so the watchdog stays responsive. */
  async ping(): Promise<boolean> {
    try {
      const res = await this.fetchWithTimeout(`${this.base}/ping`, undefined, 1000)
      return res.ok && (await res.text()).includes('pong')
    } catch {
      return false
    }
  }

  async rpc<T = unknown>(method: string, params: unknown[]): Promise<T> {
    const res = await this.fetchWithTimeout(`${this.base}/jsonrpc/0`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params }),
    })
    const parsed = JsonRpcResponse.safeParse(await res.json())
    if (!parsed.success) {
      throw new UiServerClientError('UI_SERVER_RPC_ERROR', `the ${method} response does not match the JSONRPC schema`)
    }
    if (parsed.data.error) {
      throw new UiServerClientError('UI_SERVER_RPC_ERROR', `${method}: ${parsed.data.error.message ?? 'error'}`)
    }
    return parsed.data.result as T
  }

  /** XML hierarchy — the caller parses it into UiNode. */
  dumpWindowHierarchy(compressed = false): Promise<string> {
    return this.rpc<string>('dumpWindowHierarchy', [compressed])
  }

  /** Element info; null or an error means not found. The query runs ON THE DEVICE. */
  async objInfo(selector: UiSelector): Promise<unknown | null> {
    try {
      return await this.rpc('objInfo', [selector])
    } catch (err) {
      if (err instanceof UiServerClientError && err.code === 'UI_SERVER_RPC_ERROR') return null
      throw err
    }
  }

  async screenshot(): Promise<Uint8Array> {
    const res = await this.fetchWithTimeout(`${this.base}/screenshot/0`, undefined, 10_000)
    if (!res.ok) throw new UiServerClientError('UI_SERVER_RPC_ERROR', `screenshot HTTP ${res.status}`)
    return new Uint8Array(await res.arrayBuffer())
  }

  setText(selector: UiSelector, text: string): Promise<void> {
    return this.rpc<void>('setText', [selector, text])
  }

  longClick(selector: UiSelector): Promise<void> {
    return this.rpc<void>('longClick', [selector])
  }

  /** There is no native double-click method → two quick clicks. */
  async doubleClick(selector: UiSelector): Promise<void> {
    await this.rpc('click', [selector])
    await Bun.sleep(80)
    await this.rpc('click', [selector])
  }
}
