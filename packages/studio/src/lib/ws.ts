'use client'

import { ServerMessageSchema, type ClientMessage, type ServerMessage } from '@enkaku/protocol'
import { coreBase } from '@enkaku/ui'

/**
 * `coreBase()` now lives in `@enkaku/ui` (plan 111 §3.3) and is re-exported
 * from here so that the ~23 `import { coreBase } from '@/lib/ws'` call sites
 * keep working unchanged — this is one definition, not a copy.
 *
 * It moved because a plugin needs the same answer and cannot reach Studio's
 * build configuration: it is a separate bundle. The resolution order is
 * unchanged from what shipped here (`NEXT_PUBLIC_ENKAKU_CORE_URL`, else the
 * page's origin, else :7700) — what changed is who can call it. `@enkaku/ui`
 * is external to a plugin's build, so a plugin gets THIS answer through the
 * import map rather than deriving its own, and `api()` now sends
 * `credentials: 'include'` so the `dev:studio` split origin still carries the
 * session. See `packages/ui/src/lib/core-base.ts`.
 */
export { coreBase }

type MessageHandler = (msg: ServerMessage) => void
type BinaryHandler = (buf: Uint8Array) => void

/**
 * A connectivity status update — `watchdogReconnects` is a running total for
 * the LIFE OF THIS TAB, so a caller can show "N silent-link reconnects" or
 * simply log it (plan 85 §3.6, §4.6, §5 85.7a, tests H2). Extra tuple/object
 * arguments are safe to add to a callback type: every existing
 * `ws.onStatus(setConnected)` call site keeps compiling unchanged, since a
 * function declared with fewer parameters than a type expects simply ignores
 * the rest when called with more.
 */
export interface WsStatusInfo {
  watchdogReconnects: number
}
type StatusHandler = (connected: boolean, info: WsStatusInfo) => void

/** Injectable scheduler (plan 85 §5 85.7a) — so the 45s silence watchdog is provable without an actual 45s wait; defaults to the real global timers. */
export interface WsClientScheduler {
  setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimeout: (id: ReturnType<typeof setTimeout>) => void
}

const REAL_SCHEDULER: WsClientScheduler = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
}

export interface WsClientDeps {
  /** Overridable so tests can drive the socket without a real `WebSocket`/server. Defaults to `(url) => new WebSocket(url)`. */
  createSocket?: (url: string) => WebSocket
  /** See `WsClientScheduler`'s doc comment. */
  scheduler?: WsClientScheduler
  /** How long the connection may go silent before the watchdog force-closes it. Defaults to 45_000 — the core's `heartbeat` broadcasts every 15s (plan 85 §4.2), so this is three missed beats, not a merely-idle link. */
  watchdogMs?: number
  /**
   * Fetches a fresh single-use WS ticket (plan 09 §4.3). Only ever called
   * when `setAuthMode('server')` has been used — local mode never needs one,
   * and the default (no `setAuthMode` call at all) keeps `connect()`
   * fully synchronous, exactly as it was before tickets existed. Defaults to
   * `POST /api/auth/ws-ticket` against the core.
   */
  fetchTicket?: () => Promise<string>
}

/**
 * `ws.request` rejects with this instead of a plain `Error` when the core
 * replies with a coded `error` message (plan 71 §3.4, criterion 8) — a
 * takeover's CAS failure (`lease_holder_changed`) needs to be told apart
 * from any other refusal so the dialog can re-ask rather than just failing.
 * Every existing `catch (err)`/`err instanceof Error` call site keeps
 * working unchanged; this only adds a `code` alongside `message`.
 */
export class WsRequestError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message)
    this.name = 'WsRequestError'
  }
}

/**
 * Thrown by the default `fetchTicket` when the core says the SESSION itself
 * is gone (401 from `POST /api/auth/ws-ticket`) — distinct from a network
 * hiccup, which should retry on the ordinary backoff schedule.
 * `WsClient.connect()`'s ticket branch treats this one specially: it does
 * NOT schedule a reconnect (that would just fail the same way forever) and
 * instead tells whoever called `onAuthExpired` (the auth gate), so the tab
 * can be sent back to `/login` instead of sitting quietly disconnected.
 */
export class WsAuthExpiredError extends Error {
  constructor() {
    super('the session has expired')
    this.name = 'WsAuthExpiredError'
  }
}

/**
 * A single WS client: auto-reconnect with exponential backoff plus
 * resubscribe, request/reply correlated by `id`, every inbound message
 * safeParse'd. Exported (not just the `ws` singleton below) so
 * `ws.test.ts` can construct an isolated instance with injected deps.
 */
export class WsClient {
  private ws: WebSocket | null = null
  private handlers = new Set<MessageHandler>()
  private binaryHandlers = new Set<BinaryHandler>()
  private statusHandlers = new Set<StatusHandler>()
  private pending = new Map<string, { resolve: (m: ServerMessage) => void; reject: (e: unknown) => void }>()
  private queue: string[] = []
  private backoffMs = 500
  private onReconnect = new Set<() => void>()
  private connected = false
  /**
   * This tab's WS connection id, from the `hello` message the core sends
   * right after the socket opens (plan 31 §4.1) — cached here (not just
   * re-dispatched to handlers) so a component mounted after the handshake
   * already completed can still ask synchronously, instead of racing it.
   */
  private sessionId: string | null = null

  private readonly createSocket: (url: string) => WebSocket
  private readonly scheduler: WsClientScheduler
  private readonly watchdogMs: number
  /**
   * The silence watchdog (plan 85 §3.6, §4.6, §5 85.7a, fixes F16, tests
   * H2) — reset on ANY inbound message (`onmessage`'s very first line,
   * before parsing) and on `onopen`. The core broadcasts a `heartbeat` every
   * 15s, so 45s of total silence is three missed beats, not a merely-idle
   * link: `onclose` was the ONLY reconnect trigger before this, which left
   * an open-but-silent socket permanently invisible to the client.
   */
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null
  private watchdogReconnects = 0

  /** Set via `setAuthMode('server')` — false (the old, ticketless behaviour) until then. */
  private requiresTicket = false
  /** Guards the async ticket-fetch branch of `connect()` against re-entry — the sync branch never needs this, `this.ws`'s own readyState check already covers it. */
  private connecting = false
  /** Set by `disconnect()` (e.g. logout) so `openSocket`'s `onclose` does not schedule a reconnect for a socket that was closed on purpose. Cleared at the top of `connect()` so the next login reconnects normally. */
  private manualClose = false
  private authExpiredHandlers = new Set<() => void>()
  private readonly fetchTicket: () => Promise<string>

  constructor(deps: WsClientDeps = {}) {
    this.createSocket = deps.createSocket ?? ((url) => new WebSocket(url))
    this.scheduler = deps.scheduler ?? REAL_SCHEDULER
    this.watchdogMs = deps.watchdogMs ?? 45_000
    this.fetchTicket = deps.fetchTicket ?? defaultFetchTicket
  }

  private armWatchdog(): void {
    this.clearWatchdog()
    this.watchdogTimer = this.scheduler.setTimeout(() => {
      console.warn(`[enkaku] no message from the core in ${this.watchdogMs}ms — forcing a reconnect`)
      this.watchdogReconnects += 1
      this.ws?.close()
    }, this.watchdogMs)
  }

  private clearWatchdog(): void {
    if (this.watchdogTimer !== null) {
      this.scheduler.clearTimeout(this.watchdogTimer)
      this.watchdogTimer = null
    }
  }

  connect(): void {
    if (typeof window === 'undefined') return
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return
    if (this.connecting) return
    this.manualClose = false

    if (!this.requiresTicket) {
      this.openSocket(null)
      return
    }

    // Server auth mode (plan 09 §4.3): a fresh single-use ticket per attempt
    // rather than trusting the cookie alone — the same client code also runs
    // cross-origin (Studio dev against a core in server mode, a future
    // hosted Studio), where the browser will not attach it to the upgrade.
    this.connecting = true
    this.fetchTicket()
      .then((ticket) => {
        this.connecting = false
        // A `disconnect()` (logout) may have landed while this was in flight —
        // do not open a socket for a session that was just deliberately closed.
        if (this.manualClose) return
        this.openSocket(ticket)
      })
      .catch((err: unknown) => {
        this.connecting = false
        if (err instanceof WsAuthExpiredError) {
          // The session is gone — the ordinary backoff loop would just fail
          // the same way forever. Tell whoever is listening (the auth gate)
          // instead, so the tab can be sent back to `/login` rather than
          // sitting quietly disconnected.
          for (const cb of this.authExpiredHandlers) cb()
          return
        }
        // A transient failure (network blip, core briefly unreachable) —
        // retry on the same backoff schedule `openSocket`'s `onclose` uses.
        this.scheduler.setTimeout(() => this.connect(), this.backoffMs)
        this.backoffMs = Math.min(this.backoffMs * 2, 10_000)
      })
  }

  /** Immediate disconnect (e.g. logout) — unlike a network drop, this must NOT trigger a reconnect. The next `connect()` (a fresh login) clears the flag again. */
  disconnect(): void {
    this.manualClose = true
    this.ws?.close()
    this.ws = null
  }

  /** Server auth mode requires a ticket per connection attempt; local mode never does (the default, unchanged from before tickets existed). Called once the auth gate knows which mode the core is in. */
  setAuthMode(mode: 'local' | 'server'): void {
    this.requiresTicket = mode === 'server'
  }

  /** Fires when a ticket fetch discovers the session is gone (plan 09 §4.3) — see `WsAuthExpiredError`. */
  onAuthExpired(cb: () => void): () => void {
    this.authExpiredHandlers.add(cb)
    return () => this.authExpiredHandlers.delete(cb)
  }

  private openSocket(ticket: string | null): void {
    const url = `${coreBase().replace(/^http/, 'ws')}/ws${ticket ? `?ticket=${encodeURIComponent(ticket)}` : ''}`
    const ws = this.createSocket(url)
    ws.binaryType = 'arraybuffer'
    this.ws = ws

    ws.onopen = () => {
      this.backoffMs = 500
      this.setConnected(true)
      this.armWatchdog()
      for (const raw of this.queue.splice(0)) ws.send(raw)
      for (const cb of this.onReconnect) cb()
    }
    ws.onclose = () => {
      this.clearWatchdog()
      this.setConnected(false)
      this.ws = null
      if (this.manualClose) return
      // Routed through the same injectable scheduler as the watchdog (not
      // the bare global `setTimeout`) so a test that injects a fake clock
      // never leaks a real, uncontrolled timer past the end of the test.
      this.scheduler.setTimeout(() => this.connect(), this.backoffMs)
      this.backoffMs = Math.min(this.backoffMs * 2, 10_000)
    }
    ws.onerror = () => ws.close()
    ws.onmessage = (ev) => {
      // Any inbound message proves the link is alive — reset BEFORE parsing,
      // so even a message this build cannot understand (an older/newer core)
      // still counts as traffic.
      this.armWatchdog()
      if (ev.data instanceof ArrayBuffer) {
        const buf = new Uint8Array(ev.data)
        for (const cb of this.binaryHandlers) cb(buf)
        return
      }
      let json: unknown
      try {
        json = JSON.parse(String(ev.data))
      } catch {
        return
      }
      const parsed = ServerMessageSchema.safeParse(json)
      if (!parsed.success) {
        // Dropping the message is right — an unvalidated payload must never
        // reach a component. Dropping it *silently* is not: a core running
        // older code than this build sends a shape Studio no longer accepts,
        // and the only symptom is a UI that waits forever for a reply that
        // was already thrown away. Say so, so the next person does not spend
        // an afternoon on it.
        if (process.env.NODE_ENV !== 'production') {
          const type = typeof json === 'object' && json !== null && 'type' in json ? String(json.type) : '<unknown>'
          console.warn(`[enkaku] dropped a "${type}" message the schema rejected — is the core running older code?`, parsed.error.issues)
        }
        return
      }
      const msg = parsed.data
      if (msg.type === 'hello') this.sessionId = msg.payload.sessionId
      // A pure liveness beat (plan 85 §4.6) — already did its job by
      // resetting the watchdog above; no component needs to see it.
      if (msg.type === 'heartbeat') return
      const id = 'id' in msg ? msg.id : undefined
      if (id) {
        const waiter = this.pending.get(id)
        if (waiter) {
          this.pending.delete(id)
          if (msg.type === 'error') waiter.reject(new WsRequestError(msg.payload.code, msg.payload.message))
          else waiter.resolve(msg)
          return
        }
      }
      for (const cb of this.handlers) cb(msg)
    }
  }

  private setConnected(v: boolean): void {
    this.connected = v
    const info: WsStatusInfo = { watchdogReconnects: this.watchdogReconnects }
    for (const cb of this.statusHandlers) cb(v, info)
  }

  /** Forced reconnects for the life of this tab (plan 85 §3.6, §4.6, tests H2) — also readable through `onStatus`'s second argument. */
  getWatchdogReconnects(): number {
    return this.watchdogReconnects
  }

  isConnected(): boolean {
    return this.connected
  }

  /** This tab's current session id, or null before the first `hello` arrives. */
  getSessionId(): string | null {
    return this.sessionId
  }

  send(msg: ClientMessage): void {
    const raw = JSON.stringify(msg)
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(raw)
    else {
      this.queue.push(raw)
      this.connect()
    }
  }

  request(msg: ClientMessage & { id: string }, timeoutMs = 25_000): Promise<ServerMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(msg.id)
        reject(new Error('timeout menunggu balasan core'))
      }, timeoutMs)
      this.pending.set(msg.id, {
        resolve: (m) => {
          clearTimeout(timer)
          resolve(m)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      })
      this.send(msg)
    })
  }

  on(cb: MessageHandler): () => void {
    this.handlers.add(cb)
    this.connect()
    return () => this.handlers.delete(cb)
  }

  onBinary(cb: BinaryHandler): () => void {
    this.binaryHandlers.add(cb)
    this.connect()
    return () => this.binaryHandlers.delete(cb)
  }

  onStatus(cb: StatusHandler): () => void {
    this.statusHandlers.add(cb)
    cb(this.connected, { watchdogReconnects: this.watchdogReconnects })
    return () => this.statusHandlers.delete(cb)
  }

  /** Fires whenever the connection is (re)established — used to resubscribe streams. */
  onReconnected(cb: () => void): () => void {
    this.onReconnect.add(cb)
    return () => this.onReconnect.delete(cb)
  }
}

/**
 * `POST /api/auth/ws-ticket` (plan 09 §4.3) — a single-use, 60s-TTL ticket
 * for the `/ws` upgrade. Only reached in server auth mode
 * (`ws.setAuthMode('server')`, set once by the auth gate); local mode never
 * calls this at all.
 */
async function defaultFetchTicket(): Promise<string> {
  const res = await fetch(`${coreBase()}/api/auth/ws-ticket`, { method: 'POST', credentials: 'include' })
  if (res.status === 401) throw new WsAuthExpiredError()
  if (!res.ok) throw new Error(`POST /api/auth/ws-ticket → ${res.status}`)
  const body = (await res.json()) as { ticket: string }
  return body.ticket
}

export const ws = new WsClient()

/**
 * `crypto.randomUUID()` is only exposed in a secure context (HTTPS or
 * `localhost`) — a farm reached over plain `http://<lan-ip>:port` (the
 * default for a self-hosted install with no reverse proxy) leaves it
 * `undefined`, throwing `TypeError: crypto.randomUUID is not a function` on
 * every WS request this ID feeds. `crypto.getRandomValues` carries no such
 * restriction, so it is the fallback rather than `Math.random()` — this ID
 * only needs to be unique per WS envelope, not cryptographically unguessable,
 * but there is no reason to hand-roll weaker randomness when the browser
 * already offers a real one.
 */
function fallbackUuidV4(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0'))
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`
}

export const newId = (): string => (typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : fallbackUuidV4())
