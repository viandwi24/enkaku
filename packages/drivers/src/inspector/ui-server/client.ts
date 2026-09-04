import { z } from 'zod'
import type { UiSelector } from './selector'

/**
 * Client JSONRPC ke server on-device (pola openatx/uiautomator2).
 *
 * The usable method SUBSET is deliberately narrow (plan 06 §4.4) so that
 * moving to our own APK stays a small surface. The method names below were
 * verified against the pinned APK's own source (plan 208 §5 step 208.4,
 * `android-uiautomator-server` tag 2.3.3): `AutomatorService`/
 * `AutomatorServiceImpl` (`app/src/androidTest/.../stub/`) declare
 * `dumpWindowHierarchy`, `objInfo`, `setText`, `longClick`, `click`,
 * `setConfigurator(ConfiguratorInfo)`/`getConfigurator()` exactly as used
 * below, served by `com.googlecode.jsonrpc4j.JsonRpcServer` (plain
 * `nanohttpd` + `jsonrpc4j` 1.5.0, no `@JsonRpcParam` annotations), which
 * maps a JSON array of params positionally — the single-element
 * `params: [info]` shape below is correct, not a guess.
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
    options?: { cause?: unknown },
  ) {
    super(message, options)
  }
}

/**
 * Per-operation timeouts (plan 85 §3.5, fixes F18): one 3000ms number for
 * every call — including `dumpWindowHierarchy`, which legitimately takes
 * longer on a content-heavy screen — is why the field log's `did not
 * respond within 3000ms` fired on an operation that was never actually
 * stuck. Named constants, not literals, so each budget is visible at its
 * call site instead of buried in a default parameter.
 */
export const PING_TIMEOUT_MS = 1000
export const RPC_TIMEOUT_MS = 5000
/** Matches the `inspectorDump` exec profile — a deep hierarchy legitimately takes longer than 3s on a loaded phone. */
export const DUMP_WINDOW_HIERARCHY_TIMEOUT_MS = 20_000
export const SCREENSHOT_TIMEOUT_MS = 15_000

/**
 * Bun's `fetch` throws exactly this message (see the field log's `did not
 * respond within 3000ms: ... socket connection was closed unexpectedly`)
 * when a pooled keep-alive connection outlives the `adb forward` it was
 * reaching through — `adb forward` is torn down and re-created on every
 * ui-server restart (plan 85 §3.5, F18's real cause), which the connection
 * pool has no way to know about. Matched case-insensitively: Bun's own
 * wording has already changed once across versions (a "pass `verbose:
 * true`..." suffix was added later).
 */
const STALE_FORWARD_PATTERN = /socket connection was closed unexpectedly/i

function isStaleForwardError(err: unknown): err is UiServerClientError {
  return (
    err instanceof UiServerClientError &&
    err.code === 'UI_SERVER_UNREACHABLE' &&
    err.cause instanceof Error &&
    STALE_FORWARD_PATTERN.test(err.cause.message)
  )
}

export interface UiServerClientOptions {
  localPort: number
  /** Overrides the default for ordinary RPC calls (`RPC_TIMEOUT_MS`) — `dumpWindowHierarchy` and `screenshot` keep their own fixed budgets regardless. */
  timeoutMs?: number
  /**
   * Re-issues `adb forward` for this port, without touching install state or
   * the instrumentation stream (plan 85 §3.5, fixes F18's real cause) —
   * supplied by the caller because the client itself has no adb access.
   * Called at most once per failed request, right before that request's one
   * retry; a stale-forward failure with no `reassertForward` supplied (or
   * one that itself throws) still gets the retry, just without the repair
   * step first — a forward that was never actually the problem needs no
   * repair, and a second attempt through a keep-alive pool that has already
   * dropped the dead connection commonly succeeds on its own.
   */
  reassertForward?: () => Promise<void>
}

export class UiServerClient {
  private nextId = 1

  constructor(private opts: UiServerClientOptions) {}

  private get base(): string {
    return `http://127.0.0.1:${this.opts.localPort}`
  }

  /**
   * (plan 129 §4.2, M94) A refused connection and a genuine timeout are
   * different failures and must say so: stamping every failure with "did not
   * respond within Nms" reported a 5ms connection refusal as a 20s timeout,
   * which is the exact wrong lead that sent the farm's first investigation
   * hunting a timeout budget that was never the problem (plan 129 §0.3).
   * Only an abort actually raised by `AbortSignal.timeout` gets the timeout
   * wording; everything else reports the elapsed time really measured.
   */
  private async fetchWithTimeout(url: string, init: RequestInit | undefined, timeoutMs: number): Promise<Response> {
    const startedAt = Date.now()
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
      const detail = timedOut ? `did not respond within ${timeoutMs}ms` : `failed after ${Date.now() - startedAt}ms`
      throw new UiServerClientError('UI_SERVER_UNREACHABLE', `${url} ${detail}: ${String(err)}`, { cause: err })
    }
  }

  /**
   * `fetchWithTimeout` plus the plan 85 §3.5 stale-forward retry: a known,
   * benign, self-correcting condition (F18), so reporting it as a device
   * fault on the first failure would be a lie. Retried EXACTLY once — a
   * second stale-forward failure right after re-asserting the forward is a
   * real problem, not this one.
   */
  private async request(url: string, init: RequestInit | undefined, timeoutMs: number): Promise<Response> {
    try {
      return await this.fetchWithTimeout(url, init, timeoutMs)
    } catch (err) {
      if (!isStaleForwardError(err)) throw err
      await this.opts.reassertForward?.().catch(() => undefined)
      return this.fetchWithTimeout(url, init, timeoutMs)
    }
  }

  /**
   * Health check — short timeout so the watchdog stays responsive, and NOT
   * routed through the stale-forward retry: a ping already tolerates a
   * failure (the watchdog's own consecutive-failure count is the retry),
   * and doubling its latency would make the watchdog slower to notice a
   * server that is genuinely down.
   */
  async ping(): Promise<boolean> {
    try {
      const res = await this.fetchWithTimeout(`${this.base}/ping`, undefined, PING_TIMEOUT_MS)
      return res.ok && (await res.text()).includes('pong')
    } catch {
      return false
    }
  }

  async rpc<T = unknown>(method: string, params: unknown[], timeoutMs = this.opts.timeoutMs ?? RPC_TIMEOUT_MS): Promise<T> {
    const res = await this.request(
      `${this.base}/jsonrpc/0`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params }),
      },
      timeoutMs,
    )
    const parsed = JsonRpcResponse.safeParse(await res.json())
    if (!parsed.success) {
      throw new UiServerClientError('UI_SERVER_RPC_ERROR', `the ${method} response does not match the JSONRPC schema`)
    }
    if (parsed.data.error) {
      throw new UiServerClientError('UI_SERVER_RPC_ERROR', `${method}: ${parsed.data.error.message ?? 'error'}`)
    }
    return parsed.data.result as T
  }

  /** XML hierarchy — the caller parses it into UiNode. A deep tree is the one call that legitimately needs longer than the ordinary RPC budget (plan 85 §3.5). */
  dumpWindowHierarchy(compressed = false): Promise<string> {
    return this.rpc<string>('dumpWindowHierarchy', [compressed], DUMP_WINDOW_HIERARCHY_TIMEOUT_MS)
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
    const res = await this.request(`${this.base}/screenshot/0`, undefined, SCREENSHOT_TIMEOUT_MS)
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

  /** Positional, as every other method on this surface: `params: [info]`. */
  setConfigurator(info: ConfiguratorInfo): Promise<void> {
    return this.rpc<void>('setConfigurator', [ConfiguratorInfoSchema.parse(info)])
  }

  /** Read back for the one `info` log line after every apply; the shape is the server's, validated loosely. */
  async getConfigurator(): Promise<Record<string, unknown>> {
    const raw = await this.rpc<unknown>('getConfigurator', [])
    return z.record(z.string(), z.unknown()).parse(raw)
  }
}

/**
 * The openatx `ConfiguratorInfo` (R5): the JSON-RPC mirror of UiAutomator's
 * `Configurator`. Field names verified against the pinned tag's source in
 * plan 208 §5 step 208.4 (`ConfiguratorInfo.java`'s public getters/setters,
 * serialised by jsonrpc4j's default Jackson mapping — camelCase, no
 * underscore prefix despite the private field names carrying one);
 * `uiAutomationFlags` exists from 2.3.11 only and is not sent on 2.3.3 (§9 Q4).
 */
export const ConfiguratorInfoSchema = z.object({
  waitForIdleTimeout: z.number().int().min(0),
  waitForSelectorTimeout: z.number().int().min(0),
  actionAcknowledgmentTimeout: z.number().int().min(0),
  scrollAcknowledgmentTimeout: z.number().int().min(0),
  keyInjectionDelay: z.number().int().min(0),
  uiAutomationFlags: z.number().int().min(0).optional(),
})
export type ConfiguratorInfo = z.infer<typeof ConfiguratorInfoSchema>

/** MVP 02 §4 phase 1: the caller polls; the server must never wait for idle on its behalf. */
export const DEFAULT_CONFIGURATOR: ConfiguratorInfo = {
  waitForIdleTimeout: 0,
  waitForSelectorTimeout: 0,
  actionAcknowledgmentTimeout: 0,
  scrollAcknowledgmentTimeout: 0,
  keyInjectionDelay: 0,
}
