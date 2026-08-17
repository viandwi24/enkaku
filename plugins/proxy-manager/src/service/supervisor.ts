import {
  PROXY_KEY_PREFIX,
  proxyIdFromKey,
  proxySecretKeyFor,
  readProxyRecord,
  validateProxyRecord,
  type ProxyProblem,
  type ProxyRecord,
} from '../shared'
import { ProxyError, messageOf } from './errors'
import { createBridgeLogger, type BridgeEvent, type LogSink } from './logbook'
import { createHttpListener } from './listen-http'
import { createSocks5Listener } from './listen-socks5'
import type { Listener } from './listener'
import { DEFAULT_IDLE_MS, createUpstream } from './upstream'

/**
 * The per-proxy state machine, and the only thing in this pack that owns a
 * socket (plan 112 §3.7 — this is the file the plan `Ships:`).
 *
 * ```
 * stopped ──start──> starting ──listening──> running
 *    ^                   │                      │
 *    │                   └──bind failed────> failed
 *    │                                          │
 *    └──── stopped <── stopping <──stop─────────┘
 * ```
 *
 * The five words are plan 109's own service vocabulary, with plan 109's own
 * rule: **`starting` is never worded as `running`.** A record that says
 * `enabled` and observes `failed` is the interesting row on the screen, and
 * that difference only exists because intent and observation are kept apart.
 *
 * ## Nothing here is persisted, and that is the load-bearing decision
 *
 * A running proxy's state, uptime, live count, total count, byte figures and
 * last error live in this map and are gone when the core restarts — which is
 * correct, because *the listener is gone when the core restarts too*. A
 * persisted `running` that survived a crash is a lie the moment it is read
 * (§3.5, and the same hazard plan 106 step 106.7 named and refused).
 *
 * What IS persisted is **intent**: `enabled` on the record. `startEnabled()`
 * is the whole of "survive a restart".
 *
 * ## Stop is two phases, and `ctx.onStop` is neither of them
 *
 * 1. **Drain** — `listener.close()`: stop accepting, the port is released
 *    immediately, live tunnels keep running, the row reads `stopping` with a
 *    live count.
 * 2. **Close** — after `drainMs`, destroy whatever is still open. The row
 *    reads `stopped`.
 *
 * A **force stop** skips phase 1, because a ten-second wait on a proxy
 * carrying a long download is something an operator sometimes does not want,
 * and burying that behind the same button would make Stop feel broken.
 *
 * `destroyAll()` — the `ctx.onStop` disposer — **does not drain**, and that is
 * forced by the code rather than chosen: `runtime-host.ts`'s
 * `DISPOSER_TIMEOUT_MS` is 5 000 ms for **every disposer combined**, after
 * which the host logs a warn naming the plugin and marks it `stopping` rather
 * than `stopped`. A 10 s drain inside a disposer cannot succeed; it would blow
 * the budget, earn the warn, and buy nothing. So it is synchronous, and there
 * is no `await` anywhere in it.
 */

export const PROXY_STATES = ['stopped', 'starting', 'running', 'stopping', 'failed'] as const
export type ProxyState = (typeof PROXY_STATES)[number]

/** How each state is written for a person. `starting` is its own word and is never rendered as `running`. */
export const PROXY_STATE_LABELS: Record<ProxyState, string> = {
  stopped: 'Stopped',
  starting: 'Starting',
  running: 'Running',
  stopping: 'Stopping',
  failed: 'Failed',
}

/** What the supervisor observes about one proxy. None of it is ever written to storage. */
export interface ProxyRuntime {
  id: string
  state: ProxyState
  /** Unix milliseconds the current state was entered. */
  since: number
  /** The port actually bound, or `null` when nothing is listening. */
  port: number | null
  liveConnections: number
  totalConnections: number
  refusedConnections: number
  bytesUp: number
  bytesDown: number
  lastError: { code: string; message: string } | null
}

/** The narrow slice of `PluginServiceContext` this file needs — so a test can supply one without a farm. */
export interface SupervisorHost {
  storage: {
    global: {
      getRaw(key: string): Promise<unknown>
      list(opts?: { prefix?: string; limit?: number; cursor?: string }): Promise<{ items: { key: string; value: unknown }[]; nextCursor: string | null }>
    }
  }
  log: LogSink
  /** Optional: present on a real `PluginServiceContext` (plan 109 step 109.4), absent in a unit test. */
  reportListener?: (listener: { id: string; port: number; proto?: 'tcp' | 'udp'; deviceReachable?: boolean; description?: string }) => unknown
}

export interface SupervisorOptions {
  /** Overridable so a test does not have to wait ten real minutes to prove the idle timer exists. */
  idleMs?: number
  /** Overridable so a test does not have to wait ten real seconds to prove the drain does. */
  dialTimeoutMs?: number
}

interface Entry {
  id: string
  record: ProxyRecord
  runtime: ProxyRuntime
  listener: Listener | null
  drainTimer: ReturnType<typeof setTimeout> | null
}

export interface Supervisor {
  /** Every proxy the supervisor knows about, catalogue order. Reading this never touches storage. */
  list(): ProxyRuntime[]
  runtimeOf(id: string): ProxyRuntime | null
  /** Re-read the catalogue from storage. Called at setup and before any operation that needs a record. */
  refresh(): Promise<void>
  start(id: string): Promise<ProxyRuntime>
  stop(id: string, opts?: { force?: boolean }): Promise<ProxyRuntime>
  restart(id: string): Promise<ProxyRuntime>
  /** Start every record whose stored intent says it should be listening. Never throws for one bad record. */
  startEnabled(): Promise<void>
  /** The `ctx.onStop` disposer. Synchronous, no drain — see this file's header. */
  destroyAll(): void
}

const CATALOGUE_PAGE = 200

export function createSupervisor(host: SupervisorHost, opts: SupervisorOptions = {}): Supervisor {
  const entries = new Map<string, Entry>()
  const locks = new Map<string, Promise<unknown>>()
  let torndown = false

  /**
   * One operation per proxy at a time, so `restart` is genuinely stop-then-start
   * and nothing interleaves with it — the same shape `RuntimeHost.reload` uses.
   * The chain swallows the previous result deliberately: a failed start must
   * not prevent the next stop from running.
   */
  function withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = locks.get(id) ?? Promise.resolve()
    const next = previous.then(fn, fn)
    locks.set(
      id,
      next.then(
        () => undefined,
        () => undefined,
      ),
    )
    return next
  }

  function blankRuntime(id: string): ProxyRuntime {
    return {
      id,
      state: 'stopped',
      since: Date.now(),
      port: null,
      liveConnections: 0,
      totalConnections: 0,
      refusedConnections: 0,
      bytesUp: 0,
      bytesDown: 0,
      lastError: null,
    }
  }

  function setState(entry: Entry, state: ProxyState, error?: { code: string; message: string } | null): void {
    entry.runtime.state = state
    entry.runtime.since = Date.now()
    if (error !== undefined) entry.runtime.lastError = error
  }

  function snapshot(entry: Entry): ProxyRuntime {
    return { ...entry.runtime, liveConnections: entry.listener ? entry.listener.live.size : 0 }
  }

  async function refresh(): Promise<void> {
    const seen = new Set<string>()
    let cursor: string | undefined
    do {
      const page = await host.storage.global.list({ prefix: PROXY_KEY_PREFIX, limit: CATALOGUE_PAGE, ...(cursor ? { cursor } : {}) })
      for (const item of page.items) {
        const id = proxyIdFromKey(item.key)
        if (!id) continue
        seen.add(id)
        const record = readProxyRecord(item.value)
        const existing = entries.get(id)
        if (existing) existing.record = record
        else entries.set(id, { id, record, runtime: blankRuntime(id), listener: null, drainTimer: null })
      }
      cursor = page.nextCursor ?? undefined
    } while (cursor)

    // A record deleted from the catalogue keeps its entry for as long as its
    // listener is up: forgetting it here would strand a bound port with no
    // handle left to close it, which is exactly the failure `ctx.onStop`
    // exists to prevent. It is dropped once nothing is listening.
    for (const [id, entry] of [...entries]) {
      if (!seen.has(id) && entry.listener === null) entries.delete(id)
    }
  }

  function catalogueForValidation(): { id: string; record: ProxyRecord }[] {
    return [...entries.values()].map((entry) => ({ id: entry.id, record: entry.record }))
  }

  async function readPassword(id: string): Promise<string> {
    // `getRaw` rather than `get(key, schema)`: an unparseable secret must leave
    // the proxy dialling without a password (and failing honestly on the
    // upstream's own refusal), not throw out of `start` with a storage error
    // that reads like a bug in the farm.
    try {
      const raw = await host.storage.global.getRaw(proxySecretKeyFor(id))
      const value = typeof raw === 'object' && raw !== null ? (raw as { password?: unknown }).password : undefined
      return typeof value === 'string' ? value : ''
    } catch {
      return ''
    }
  }

  function problemError(problems: readonly ProxyProblem[]): ProxyError {
    const first = problems[0]
    return new ProxyError('E_PROXY_LISTEN_FAILED', `${first?.code ?? 'E_PROXY_INVALID'}: ${first?.message ?? 'this record cannot start'}`)
  }

  async function startLocked(id: string): Promise<ProxyRuntime> {
    const entry = entries.get(id)
    if (!entry) throw new ProxyError('E_PROXY_LISTEN_FAILED', `no proxy record "${id}" in this plugin's catalogue`)
    if (entry.runtime.state === 'running' || entry.runtime.state === 'starting') return snapshot(entry)

    setState(entry, 'starting', null)

    const problems = validateProxyRecord(entry.record, { id, catalogue: catalogueForValidation() })
    if (problems.length > 0) {
      const err = problemError(problems)
      setState(entry, 'failed', { code: problems[0]?.code ?? err.code, message: problems[0]?.message ?? err.message })
      return snapshot(entry)
    }
    const port = entry.record.listen.port
    if (port === null) {
      // Unreachable: `E_PROXY_PORT_UNASSIGNED` already fired above. Kept so the
      // narrowing is the compiler's rather than a comment's.
      setState(entry, 'failed', { code: 'E_PROXY_PORT_UNASSIGNED', message: 'this record has no local port' })
      return snapshot(entry)
    }

    try {
      const password = await readPassword(id)
      const upstream = createUpstream(entry.record, password, opts.dialTimeoutMs === undefined ? {} : { timeoutMs: opts.dialTimeoutMs })
      const emit = createBridgeLogger(host.log, { proxyId: id, logDestinations: entry.record.logDestinations })
      const log = (event: BridgeEvent): void => {
        if (event.event === 'accepted') entry.runtime.totalConnections += 1
        if (event.event === 'refused') entry.runtime.refusedConnections += 1
        emit(event)
      }

      const listenerOptions = {
        bindHost: entry.record.listen.bindHost,
        port,
        upstream,
        maxConnections: entry.record.maxConnections,
        log,
        idleMs: opts.idleMs ?? DEFAULT_IDLE_MS,
        onConnectionClosed: (counters: { bytesUp: number; bytesDown: number }) => {
          entry.runtime.bytesUp += counters.bytesUp
          entry.runtime.bytesDown += counters.bytesDown
        },
      }

      const listener = entry.record.listen.proto === 'socks5' ? await createSocks5Listener(listenerOptions) : await createHttpListener(listenerOptions)

      // A stop that arrived while the bind was in flight wins: the listener is
      // closed rather than left bound with nothing tracking it.
      if (torndown) {
        listener.close()
        listener.destroyLive()
        setState(entry, 'stopped')
        return snapshot(entry)
      }

      entry.listener = listener
      entry.runtime.port = listener.port
      setState(entry, 'running', null)

      // Pure observability (plan 109 §3.3): reporting is not control, and not
      // reporting does not stop the socket working. What it buys is that a
      // port open on the operator's machine is visible in the product instead
      // of only in `lsof`, and that the core's unload backstop has something
      // to bind-test.
      //
      // `deviceReachable: false` deliberately: the chain that would make it
      // true is plan 109 steps 109.9–109.11 and plan 112 step 112.11, and
      // claiming it before then would be a manifest whose central claim is
      // false.
      host.reportListener?.({
        id: `proxy-${id}`,
        port: listener.port,
        proto: 'tcp',
        deviceReachable: false,
        description: `${entry.record.listen.proto.toUpperCase()} bridge for “${entry.record.label || id}” through ${upstream.description}`,
      })

      return snapshot(entry)
    } catch (err: unknown) {
      const code = err instanceof ProxyError ? err.code : 'E_PROXY_LISTEN_FAILED'
      setState(entry, 'failed', { code, message: messageOf(err) })
      entry.listener = null
      entry.runtime.port = null
      return snapshot(entry)
    }
  }

  function clearDrain(entry: Entry): void {
    if (entry.drainTimer) clearTimeout(entry.drainTimer)
    entry.drainTimer = null
  }

  function stopLocked(id: string, force: boolean): Promise<ProxyRuntime> {
    const entry = entries.get(id)
    if (!entry) throw new ProxyError('E_PROXY_LISTEN_FAILED', `no proxy record "${id}" in this plugin's catalogue`)
    const listener = entry.listener
    if (!listener) {
      clearDrain(entry)
      setState(entry, 'stopped')
      entry.runtime.port = null
      return Promise.resolve(snapshot(entry))
    }

    // Phase 1, always: the port is released here, whether or not the drain
    // runs. That is the half an operator is waiting for — the reason they
    // stopped it is usually that they want the port.
    listener.close()

    const finish = (): ProxyRuntime => {
      clearDrain(entry)
      listener.destroyLive()
      entry.listener = null
      entry.runtime.port = null
      setState(entry, 'stopped')
      return snapshot(entry)
    }

    if (force || entry.record.drainMs <= 0 || listener.live.size === 0) return Promise.resolve(finish())

    setState(entry, 'stopping')
    return new Promise<ProxyRuntime>((resolve) => {
      const deadline = Date.now() + entry.record.drainMs
      const tick = (): void => {
        if (listener.live.size === 0 || Date.now() >= deadline) {
          resolve(finish())
          return
        }
        // Poll rather than subscribe: the drain is bounded, a tick is a
        // `Set.size` read, and a subscription would be a second lifetime to
        // get wrong for a window that is at most `drainMs` long.
        entry.drainTimer = setTimeout(tick, 50)
      }
      entry.drainTimer = setTimeout(tick, 50)
    })
  }

  return {
    list() {
      return [...entries.values()].map(snapshot)
    },

    runtimeOf(id) {
      const entry = entries.get(id)
      return entry ? snapshot(entry) : null
    },

    refresh,

    start(id) {
      return withLock(id, () => startLocked(id))
    },

    stop(id, stopOpts) {
      return withLock(id, () => stopLocked(id, stopOpts?.force === true))
    },

    restart(id) {
      // Under ONE lock, so nothing interleaves between the stop and the start.
      return withLock(id, async () => {
        await stopLocked(id, false)
        return await startLocked(id)
      })
    },

    async startEnabled() {
      await refresh()
      for (const entry of [...entries.values()]) {
        if (!entry.record.enabled) continue
        // Never throws for one bad record: a catalogue of ten with one broken
        // row must start the other nine, and the broken one must say why on
        // its own row rather than taking the service down with it.
        try {
          await withLock(entry.id, () => startLocked(entry.id))
        } catch (err: unknown) {
          host.log.error('proxy failed to start', { proxy: entry.id, error: messageOf(err) })
        }
      }
    },

    destroyAll() {
      torndown = true
      for (const entry of entries.values()) {
        clearDrain(entry)
        if (!entry.listener) continue
        entry.listener.close()
        entry.listener.destroyLive()
        entry.listener = null
        entry.runtime.port = null
        setState(entry, 'stopped')
      }
    },
  }
}
