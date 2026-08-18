import {
  PROXY_KEY_PREFIX,
  PROXY_PROBE_SKIP_REASON,
  proxyAuthKeyFor,
  proxyIdFromKey,
  proxyProbeKeyFor,
  proxySecretKeyFor,
  readProxyRecord,
  validateProxyRecord,
  type ProxyProblem,
  type ProxyProbeResult,
  type ProxyRecord,
} from '../shared'
import os from 'node:os'
import { ProxyError, listenerAuthSecrets, messageOf, scrubSecrets } from './errors'
import { createBridgeLogger, logServiceEvent, type BridgeLogger, type LogSink, type ProxyEvent } from './logbook'
import { createHttpListener } from './listen-http'
import { createSocks5Listener } from './listen-socks5'
import type { Listener } from './listener'
import { probeUrlFromEnv, runEgressProbe } from './probe'
import { DEFAULT_DIAL_TIMEOUT_MS, DEFAULT_IDLE_MS, createUpstream } from './upstream'
import type { ListenerCredential } from './auth'

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

// The state vocabulary lives in `shared.ts` (which imports nothing), because
// this module imports `node:net` and the browser half cannot follow it here.
// Re-exported so every existing `from './supervisor'` import keeps working.
import type { ProxyState } from '../shared'
export { PROXY_STATES, PROXY_STATE_LABELS, type ProxyState } from '../shared'

/**
 * One row of `snapshot()` — the stored record joined with what the supervisor
 * observes about it, and the problems that stop it running.
 *
 * The three are kept apart deliberately (plan 112 §3.5): `record.enabled` is
 * **intent**, `runtime.state` is **observation**, and a record that says
 * `enabled` while observing `failed` is the interesting row on the screen. A
 * shape that collapsed them into one word would have nothing to say about it.
 */
export interface ProxyView {
  id: string
  record: ProxyRecord
  runtime: ProxyRuntime
  /** Every refusal and precondition `validateProxyRecord` finds for this record, against the rest of the catalogue. */
  problems: ProxyProblem[]
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
      /**
       * Optional, the same way `reportListener` below is: a pre-117.9 test
       * fixture supplies only `getRaw`/`list`, and `probeEntry` treats a
       * missing `set` exactly like a `set` that threw — the probe still ran,
       * only the write is skipped (see `probeEntry`'s own comment). Only
       * `secret: false` is ever passed — `proxy-probe:<id>` (plan 117 §4.5) is
       * a public address and a latency, not a credential.
       */
      set?(key: string, value: unknown, opts?: { secret?: boolean }): Promise<{ version: number }>
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
  /** Overridable so a test does not have to wait `PROBE_INTERVAL_MS` for the probe sweep to prove it runs at all. */
  probeIntervalMs?: number
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
  /** The same list, with each proxy's stored record and its blocking problems — what `GET …/http/proxies` answers with. */
  snapshot(): ProxyView[]
  runtimeOf(id: string): ProxyRuntime | null
  /** Whether the supervisor has an entry for `id` at all, so a route can answer "no such proxy" itself rather than throwing. */
  has(id: string): boolean
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

/**
 * The base interval between one record's probes (plan 117 §3.7, step 117.9).
 *
 * A public address changes rarely — this is not a liveness heartbeat like
 * `packages/core`'s own `NETWORK_HEARTBEAT_INTERVAL_MS` (20 s, checking a
 * device route that can drop at any moment). Five minutes is often enough
 * that a row's `checked-at` never looks abandoned, and rare enough that
 * twenty records probing on the same schedule cost twenty outbound
 * connections every five minutes, not twenty every twenty seconds.
 */
const PROBE_INTERVAL_MS = 300_000

/**
 * How much the interval is spread, either side of `PROBE_INTERVAL_MS` — full
 * jitter over a fraction of the base, the same shape `packages/node/src/
 * tunnel.ts`'s own reconnect backoff uses, and for the same reason: twenty
 * records created together (the range generator, §3.9) must not all probe on
 * the same tick forever.
 */
const PROBE_JITTER_FRACTION = 0.2

function jitteredProbeDelay(baseMs: number): number {
  const spread = baseMs * PROBE_JITTER_FRACTION
  return baseMs - spread + Math.random() * spread * 2
}

export function createSupervisor(host: SupervisorHost, opts: SupervisorOptions = {}): Supervisor {
  const entries = new Map<string, Entry>()
  const locks = new Map<string, Promise<unknown>>()
  let torndown = false
  let probeTimer: ReturnType<typeof setTimeout> | null = null

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

  /**
   * This proxy's logger, built from the CURRENT record each time (plan 112 step
   * 112.8).
   *
   * Not cached on the entry, because `logDestinations` is a field of the record
   * and a record is re-read on every `refresh()`: a cached logger would keep
   * writing destination hosts for as long as the process lived after an
   * operator turned the switch off, which is exactly the setting nobody would
   * think to re-check.
   */
  function loggerFor(entry: Entry): BridgeLogger {
    return createBridgeLogger(host.log, { proxyId: entry.id, logDestinations: entry.record.logDestinations })
  }

  /** One lifecycle line, tagged with this proxy's subject. */
  function say(entry: Entry, event: ProxyEvent): void {
    loggerFor(entry)(event)
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

  /**
 * Every address this host currently holds, for `validateProxyRecord`'s
 * `E_PROXY_BIND_ADDRESS_UNAVAILABLE` precondition (plan 117 §4.2).
 *
 * It is read HERE rather than in `shared.ts` because that file imports
 * nothing — deliberately, so the browser half can run the same validation the
 * service does — and `os.networkInterfaces()` is a Node call the browser
 * structurally cannot make. The parameter is three-valued for that reason:
 * `undefined` means *nobody looked*, which is the browser's honest answer and
 * must never be turned into a refusal it cannot justify.
 *
 * Read fresh on every start rather than cached: an alias can be added or
 * removed under a stored record, and a cached list would refuse a record whose
 * address had since appeared — or, worse, admit one whose address had gone.
 *
 * This is a PRECONDITION, never the enforcement. The address can still vanish
 * between this call and the bind, and the bind's own error is classified and
 * reported either way (§8).
 */
function hostAddresses(): string[] {
  return Object.values(os.networkInterfaces())
    .flatMap((addrs) => addrs ?? [])
    .map((addr) => addr.address)
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

  /**
   * `proxy-auth:<id>` — the INBOUND credential (plan 117 §4.5), read beside
   * `readPassword`'s outbound one but never confused with it: this is who is
   * allowed to dial IN, not who this bridge dials out as.
   *
   * `proxyAuthKeyFor` now lives in `shared.ts` beside `proxySecretKeyFor`, the
   * pack's own one-key-builder-per-credential-kind pattern — it was built
   * locally here only because `shared.ts` was out of scope for the step that
   * first needed it (117.6); step 117.7's reconciliation moved it.
   */
  async function readAuth(id: string): Promise<ListenerCredential | undefined> {
    // Same discipline as `readPassword`: an unparseable or absent row means
    // "this listener authenticates nobody", not a thrown storage error out of
    // `start`. Whether that is actually SAFE for a non-loopback bind is the
    // bind gate's question (117.7), not this function's.
    try {
      const raw = await host.storage.global.getRaw(proxyAuthKeyFor(id))
      if (typeof raw !== 'object' || raw === null) return undefined
      const username = (raw as { username?: unknown }).username
      const password = (raw as { password?: unknown }).password
      if (typeof username !== 'string' || typeof password !== 'string') return undefined
      return { username, password }
    } catch {
      return undefined
    }
  }

  /**
   * One record's probe (plan 117 §3.7, §4.5, step 117.9) — dial the same
   * `Upstream` the listener would use, through the SAME credentials, and
   * write `proxy-probe:<id>`. Never throws: `runEgressProbe` itself already
   * resolves to `{ ok: false, error }` on any failure, and the KV write below
   * is its own defensive `catch` so a storage fault does not take the sweep
   * down with it — the same discipline `readPassword`/`readAuth` already
   * apply to a read on this same path.
   *
   * With `ENKAKU_NETWORK_PROBE_URL` unset, no dial is attempted at all — the
   * row is written straight to the `skip` shape (`ok: false`, `error:
   * PROXY_PROBE_SKIP_REASON`), because §3.7's rule is that an unmeasurable
   * record says so rather than reading as either a pass or a plain failure.
   */
  async function probeEntry(entry: Entry): Promise<void> {
    const probeUrl = probeUrlFromEnv()
    let result: ProxyProbeResult
    if (probeUrl === null) {
      result = { at: Math.floor(Date.now() / 1000), ok: false, error: PROXY_PROBE_SKIP_REASON }
    } else {
      const password = await readPassword(entry.id)
      const auth = await readAuth(entry.id)
      const secrets = [password, ...(auth ? listenerAuthSecrets(auth) : [])]
      const upstream = createUpstream(entry.record, password, { timeoutMs: opts.dialTimeoutMs ?? DEFAULT_DIAL_TIMEOUT_MS })
      result = await runEgressProbe({ upstream, probeUrl, timeoutMs: opts.dialTimeoutMs ?? DEFAULT_DIAL_TIMEOUT_MS, secrets })
    }
    try {
      // Absent on a pre-117.9 test `SupervisorHost` (see that interface's own
      // comment) — the probe still ran, it is only the write that is skipped.
      await host.storage.global.set?.(proxyProbeKeyFor(entry.id), result, { secret: false })
    } catch {
      // Diagnostic, not control: a probe result that could not be stored
      // must not stop the next one, or a single bad write would silence
      // every record's row behind it.
    }
  }

  /** Every RUNNING record, probed once, one after another — never a stopped or failed one (§3.7: "skipped for a stopped record"), because there is no bound socket for such a record to say anything true about. */
  async function runProbeSweep(): Promise<void> {
    for (const entry of [...entries.values()]) {
      if (entry.runtime.state !== 'running') continue
      await probeEntry(entry).catch(() => {
        // `probeEntry` already resolves every failure into a stored `error`;
        // this catch exists only so a truly unexpected throw (a bug, not a
        // dial failure) cannot stop the rest of the sweep either.
      })
    }
  }

  /**
   * The recurring sweep, on an interval with jitter (§3.7, step 117.9). A
   * plain `setInterval` is not used: it would queue a second sweep while the
   * first is still probing twenty records, and the two would interleave
   * writes to the same rows. Each tick reschedules itself only once the
   * PREVIOUS sweep has actually finished.
   */
  function scheduleProbe(): void {
    if (torndown) return
    const base = opts.probeIntervalMs ?? PROBE_INTERVAL_MS
    probeTimer = setTimeout(() => {
      // `.catch` before `.finally`: `runProbeSweep` already swallows every
      // per-record failure, but a bug reaching this far must still not turn
      // into an unhandled rejection that leaves the sweep unscheduled forever.
      runProbeSweep()
        .catch(() => {})
        .finally(scheduleProbe)
    }, jitteredProbeDelay(base))
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
    say(entry, { event: 'start' })

    // Read BEFORE validating, not after: `E_PROXY_LISTENER_AUTH_MISSING` is a
    // precondition about whether a credential row EXISTS, and a validation that
    // ran before the read could only answer `undefined` — "nobody looked" — and
    // would let a record whose credential had been deleted bind off-host
    // anyway. The read is fail-open to `undefined` (see `readAuth`), so a
    // storage fault reads as "no credential", which refuses rather than admits.
    // It is also the ONLY read: the value is carried down to `listenerOptions`
    // below rather than fetched a second time, so the credential the gate was
    // decided on is the credential the listener is actually given.
    const listenerAuth = await readAuth(id)
    const problems = validateProxyRecord(entry.record, {
      id,
      catalogue: catalogueForValidation(),
      hostAddresses: hostAddresses(),
      hasListenerAuth: listenerAuth !== undefined,
    })
    if (problems.length > 0) {
      const err = problemError(problems)
      const code = problems[0]?.code ?? err.code
      const message = problems[0]?.message ?? err.message
      setState(entry, 'failed', { code, message })
      say(entry, { event: 'start-refused', code, message })
      return snapshot(entry)
    }
    const port = entry.record.listen.port
    if (port === null) {
      // Unreachable: `E_PROXY_PORT_UNASSIGNED` already fired above. Kept so the
      // narrowing is the compiler's rather than a comment's.
      setState(entry, 'failed', { code: 'E_PROXY_PORT_UNASSIGNED', message: 'this record has no local port' })
      return snapshot(entry)
    }

    let password = ''
    let auth: ListenerCredential | undefined
    try {
      password = await readPassword(id)
      auth = listenerAuth
      const upstream = createUpstream(entry.record, password, opts.dialTimeoutMs === undefined ? {} : { timeoutMs: opts.dialTimeoutMs })
      const emit = loggerFor(entry)
      const log = (event: ProxyEvent): void => {
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
        // Absent rather than `undefined` on the object: `ListenerOptions.auth`
        // being present-but-undefined and being absent read the same to every
        // caller here, but the record's own intent (`listenerAuth`) is not
        // consulted at all — a `direct` record with a stored row still gets a
        // credential, since nothing in this plan makes reading it conditional
        // on the intent flag. The bind gate (117.7) is what makes the RECORD
        // refuse to start; this only decides what the LISTENER, once started,
        // requires of a client.
        ...(auth ? { auth } : {}),
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
      say(entry, {
        event: 'listening',
        port: listener.port,
        listen: entry.record.listen.proto,
        upstreamProto: entry.record.upstream.proto,
        upstreamHost: entry.record.upstream.host,
        upstreamPort: entry.record.upstream.port,
      })

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
      // `scrubSecrets` over the password even though no path here interpolates
      // one: this is the last place a message from somebody else's library
      // becomes a stored log line and a row an operator reads, and the cost of
      // the net is one string scan on a path that has already failed. The
      // listener credential's plaintext and base64 forms (plan 117 §4.4) get
      // the same net — `net.createServer`'s own bind failure has nothing to do
      // with it, but a start failure this early has not distinguished which
      // library's message it is looking at either.
      const message = scrubSecrets(messageOf(err), [password, ...(auth ? listenerAuthSecrets(auth) : [])])
      setState(entry, 'failed', { code, message })
      entry.listener = null
      entry.runtime.port = null
      say(entry, { event: 'start-failed', code, message, port })
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
      // Deliberately silent: stopping something that is not running is a
      // no-op, and a line for it would be one more thing between an operator
      // and the line they are looking for.
      return Promise.resolve(snapshot(entry))
    }
    const boundPort = entry.runtime.port

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
      say(entry, { event: 'stop', forced: force, port: boundPort })
      return snapshot(entry)
    }

    if (force || entry.record.drainMs <= 0 || listener.live.size === 0) return Promise.resolve(finish())

    setState(entry, 'stopping')
    say(entry, { event: 'drain', live: listener.live.size, drainMs: entry.record.drainMs })
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

  // Started once, here, rather than from a method a caller has to remember to
  // invoke: the probe sweep is part of what a supervisor IS (§3.7), the same
  // way `refresh`/`startEnabled` are called once from `index.ts`'s `setup`
  // and nothing else ever starts a second one. `destroyAll()` below is what
  // stops it.
  scheduleProbe()

  return {
    list() {
      return [...entries.values()].map(snapshot)
    },

    snapshot() {
      const catalogue = catalogueForValidation()
      const addresses = hostAddresses()
      return [...entries.values()].map((entry) => ({
        id: entry.id,
        record: entry.record,
        runtime: snapshot(entry),
        // `hasListenerAuth` is deliberately absent here and present in
        // `startLocked`: this method is synchronous and reading a secret row is
        // not, so the honest answer is `undefined` — "nobody looked" — exactly
        // as it is for the browser half. The refusal that actually guards a
        // bind runs at start, where the read can be awaited.
        problems: validateProxyRecord(entry.record, { id: entry.id, catalogue, hostAddresses: addresses }),
      }))
    },

    runtimeOf(id) {
      const entry = entries.get(id)
      return entry ? snapshot(entry) : null
    },

    has(id) {
      return entries.has(id)
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
        const entry = entries.get(id)
        if (entry) say(entry, { event: 'restart' })
        await stopLocked(id, false)
        return await startLocked(id)
      })
    },

    async startEnabled() {
      await refresh()
      let started = 0
      for (const entry of [...entries.values()]) {
        if (!entry.record.enabled) continue
        // Never throws for one bad record: a catalogue of ten with one broken
        // row must start the other nine, and the broken one must say why on
        // its own row rather than taking the service down with it.
        try {
          const runtime = await withLock(entry.id, () => startLocked(entry.id))
          // Counted only when it is actually listening. `enabled` is intent and
          // this line is observation; reporting the intent count as the started
          // count is exactly the conflation §3.5 refuses.
          if (runtime.state === 'running') started += 1
        } catch (err: unknown) {
          // `startLocked` reports its own failures on the row and logs them; a
          // throw out of it is the unexpected path, so it keeps its own line
          // — tagged, so it lands in that proxy's own view.
          say(entry, { event: 'start-failed', code: 'E_PROXY_LISTEN_FAILED', message: messageOf(err), port: entry.record.listen.port })
        }
      }
      logServiceEvent(host.log, { event: 'service-started', catalogue: entries.size, started })
    },

    destroyAll() {
      torndown = true
      if (probeTimer) clearTimeout(probeTimer)
      probeTimer = null
      let destroyed = 0
      for (const entry of entries.values()) {
        clearDrain(entry)
        if (!entry.listener) continue
        const boundPort = entry.runtime.port
        entry.listener.close()
        entry.listener.destroyLive()
        entry.listener = null
        entry.runtime.port = null
        setState(entry, 'stopped')
        destroyed += 1
        say(entry, { event: 'teardown', port: boundPort })
      }
      logServiceEvent(host.log, { event: 'service-stopped', destroyed })
    },
  }
}
