import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import {
  isFarmEventOfType,
  isService,
  type FarmEventType,
  type PluginQueryHandler,
  type PluginRequestHandler,
  type PluginServiceContext,
  type PluginSocketHandler,
  type PluginWebhookHandler,
  type ServiceResetData,
} from '@enkaku/sdk'
import {
  ReportedListenerSchema,
  PluginResetReportSchema,
  type PluginHandlerKind,
  type PluginHandlerView,
  type PluginListenerProto,
  type PluginResetReport,
  type PluginServiceDeclaration,
  type PluginLogPage,
  type PluginServiceStatus,
  type PluginWebhookInfo,
  type ReportedListener,
  type ServerMessage,
} from '@enkaku/protocol'
import { isPortFree as bindTestPortFree } from '@enkaku/session'
import { materializeBundleText } from '../scripts/bundle-cache'
import type { KvStore } from '../kv/store'
import { EnkakuError } from '../util/errors'
import { createLogger, type Logger } from '../util/logger'
import { createPluginContext } from './plugin-context'
import { createPluginEventRouter, type PluginEventRouter } from './runtime-events'
import {
  createPluginHandlerRegistry,
  resolveHandlerMethods,
  resolveHandlerPermission,
  validateHandlerId,
  PLUGIN_QUERY_PERMISSION,
  type PluginHandlerRegistration,
  type PluginHandlerRegistry,
} from './service-handlers'
import type { PluginLifecycleEvent, PluginRuntime } from './runtime'
import { unconfiguredWebhookInfo } from './webhook-secrets'

/**
 * Plan 109 (M74 — the plugin runtime), step 109.2 — **the runtime host.**
 * Owns load, lifecycle, containment and accounting for a plugin's SERVICE:
 * the long-lived half declared with `defineService`, which runs for as long as
 * the plugin is enabled rather than only inside a job.
 *
 * ## This is not a sandbox, and the word is not used for it
 *
 * Plugin code is loaded into the CORE's own process (§3.2, owner-decided; spec
 * §11.3 keeps the same discipline for job isolation). What that buys is
 * immediacy. What it costs is written down here rather than discovered:
 *
 * | failure | outcome |
 * |---|---|
 * | a handler throws | caught, charged, the caller gets `E_PLUGIN_HANDLER_FAILED` |
 * | a handler rejects | the same |
 * | a handler overruns its deadline | `E_PLUGIN_HANDLER_TIMEOUT`, charged — **but the handler keeps running**, see `invoke` |
 * | a floating rejection | attributed where it can be, charged, and the core survives — see `attributeRejection` |
 * | a bad module at load | the service is `failed` and registers nothing |
 * | repeated failures | the error budget disables the service, verbatim, and never retries |
 * | **a synchronous infinite loop** | **the event loop stops. The whole farm freezes.** |
 * | **out of memory** | **the core process dies.** |
 * | **`process.exit()` in plugin code** | **the core process dies.** |
 * | **a native crash in an npm dependency** | **the core process dies.** |
 *
 * The bottom four are not mitigable by any amount of `try`/`catch`. They are
 * the price of the owner's chosen model and they are stated in `docs/spec.md`
 * §11.6 and `packages/sdk/README.md` too, because an author will read those and
 * not this.
 *
 * ## `starting` is not `running`
 *
 * A service is `running` only once its `setup()` has RESOLVED. Between the
 * module import and that resolution it is `starting`, it serves nothing, and
 * every call into it is refused with `E_PLUGIN_RUNTIME_STARTING` rather than
 * queued. An operator reading `running` will believe the port is bound and the
 * subscriptions are live; a status that says so early is not optimism, it is a
 * lie they will act on.
 */

/** §4.2 — "a deadline (default 30 s, per-handler override, clamped)". */
export const DEFAULT_INVOCATION_TIMEOUT_MS = 30_000
/**
 * The ceiling a per-handler override is clamped to.
 *
 * §4.2 calls for this to be a FARM SETTING, and it deliberately is not one
 * yet: `FarmSettingsSchema` is asserted key-for-key against Studio's own
 * section manifest (`packages/studio/src/components/settings/farmSections.test.ts`),
 * so adding a top-level key without the matching Studio section fails that
 * test. The two belong in one commit, and that commit is 109.12's (Studio).
 * Until then this is a constant, overridable per host by `maxTimeoutMs` —
 * which is what `daemon.ts` will pass once the setting exists.
 */
export const MAX_INVOCATION_TIMEOUT_MS = 300_000
/**
 * §3.3's "waits up to 5 s" and §4.2's Unload row "run every `onStop` disposer,
 * wait ≤ 5 s" are **one budget, not two** — the plan states it twice and step
 * 109.4 had to decide, so it is recorded here: five seconds is what the whole
 * teardown gets, shared by every disposer the plugin registered, measured from
 * the moment the first one is called.
 *
 * The alternative reading — 5 s each — was rejected because it makes the worst
 * case unbounded in the number of disposers, and the thing this budget exists
 * to bound is how long an operator waits for Disable to come back.
 *
 * What the budget does NOT cover, deliberately: the advisory bind test that
 * runs afterwards (`checkReportedPorts`). That is the CORE's own check, not
 * the plugin's work, and charging it to the plugin's budget would mean a slow
 * bind test could be reported as the plugin failing to let go.
 */
export const DISPOSER_TIMEOUT_MS = 5_000

/**
 * How long a Reset data pass may take.
 *
 * The ceiling rather than the default, and the arithmetic is why: a handler
 * that turns a route off does it one device at a time through
 * `device.network.clear`, whose own farm deadline is 120 s per device. Two
 * unreachable phones already outlast the 30 s default, and a reset that
 * *timed out halfway* is the exact state this feature exists to avoid — the
 * caller is freed, the handler keeps running (`invoke` cannot cancel it), and
 * nobody can say which devices were reached.
 *
 * It is not unbounded, because the operator is waiting on an HTTP response.
 * A pass that needs longer than this is a pass that should be reported as
 * partly done and pressed again — which the idempotence rule makes safe.
 */
export const RESET_TIMEOUT_MS = 300_000
/** §4.2's Error budget row — "20 handler failures in 60 s". */
export const ERROR_BUDGET_FAILURES = 20
export const ERROR_BUDGET_WINDOW_MS = 60_000
/** §4.2's Memory row — the honest substitute for a per-plugin ceiling that in-process cannot give. */
export const LISTENER_WARN_THRESHOLD = 8

export interface PluginServiceCounters {
  /** Every guarded entry into this plugin's code, `setup` included. */
  invocations: number
  /** Of those, the ones that threw, rejected, or ran out of deadline. Charged against the error budget. */
  failures: number
  /** Of those failures, the ones that were deadline overruns. */
  timeouts: number
  /**
   * A handler that settled AFTER its deadline had already failed the caller.
   * Counted because it is the visible trace of the one thing this design
   * genuinely cannot do: a JavaScript promise cannot be cancelled, so a hung
   * handler is still running after the call that waited on it gave up.
   */
  lateSettlements: number
  /** Deliveries of a farm event into this plugin's handlers (step 109.5 feeds this). */
  eventDeliveries: number
  /** Floating rejections attributed to this plugin (criterion 4). */
  unhandledRejections: number
  /** `ctx.onStop` disposers currently registered. */
  disposers: number
  /** Listeners the plugin has reported. Reporting is observability, never control (§3.3). */
  listeners: number
  /** Live `ctx.onEvent` subscriptions. */
  eventSubscriptions: number
  /** Live `ctx.onRequest`/`onSocket`/`onQuery` registrations (step 109.6). Zero for a service that is not running — they are registered, never declared. */
  handlers: number
  /** WebSocket connections currently open on this plugin's `ctx.onSocket` handlers. */
  openSockets: number
}

export interface PluginServiceError {
  code: string
  /** **Verbatim** (criterion 5). Never summarised, never re-worded. */
  message: string
  at: Date
}

export interface PluginServiceView {
  name: string
  version: string
  status: PluginServiceStatus
  /** When the current `status` was entered. */
  since: Date
  /** How many times this service has been loaded since the core started. */
  starts: number
  lastError: PluginServiceError | null
  /** True once the error budget tripped. Only an explicit operator load/reload clears it (§4.2 — "loud and finite, never a silent loop"). */
  disabledByBudget: boolean
  /**
   * How the most recent floating rejection was traced back to this plugin, and
   * when. Surfaced rather than kept internal because the tiers are not
   * equally strong: `tagged-reason` is exact, while `module-stack` is a
   * heuristic over a stack trace. An operator looking at a
   * charge should be able to see which one decided it.
   */
  lastRejection: { how: RejectionAttributionHow; at: Date } | null
  permissions: string[]
  /**
   * What the plugin has REPORTED it opened (§3.3), not what it declared and
   * not what the core allocated — the core allocates nothing. A listener whose
   * `port` is still bound after the disposers ran is what turns the status
   * below into `stopping`.
   */
  listeners: ReportedListener[]
  /** The farm event types the manifest declared. `ctx.onEvent` refuses anything absent from it. */
  events: string[]
  /**
   * The inbound webhook ids the manifest declared (step 109.7). Declared, not
   * registered — so unlike `handlers` this is non-empty for a stopped service,
   * which is exactly the state in which an operator most wants to rotate one.
   */
  webhooks: string[]
  /** The types the service has actually subscribed a handler to. A subset of `events`. */
  subscriptions: string[]
  /**
   * The http/socket/query handlers the service registered (step 109.6), in
   * registration order. **Empty for anything but `running`** — a handler is
   * registered by `setup`, not declared in the manifest, so a stopped service
   * genuinely has none. That is why a request to a stopped service is refused
   * as *not running* rather than *not found*.
   */
  handlers: PluginHandlerView[]
  counters: PluginServiceCounters
}

export interface InvocationSpec {
  /** What is being invoked — `setup`, `event:device.connected`, `http:GET /status`. Appears verbatim in the coded error and the log. */
  what: string
  /** Per-handler override, clamped to `[1, maxTimeoutMs]`. */
  timeoutMs?: number
  /** Which statuses this invocation is legal in. Defaults to `running` alone. `setup` is the only caller that passes `starting`. */
  allow?: readonly PluginServiceStatus[]
  /** Counts against `eventDeliveries` instead of only `invocations`. */
  kind?: 'call' | 'event'
}

/**
 * What `ctx.webhooks` reaches (step 109.7) — three functions, never the store
 * and never the `Db` under it.
 *
 * The implementation `daemon.ts` supplies is the one that AUDITS: a plugin
 * reading or rotating its own webhook secret writes a `plugin.webhook` row
 * under `plugin:<name>`. That is the whole of what a plugin gains by using
 * this door rather than opening `enkaku.db` itself, which it can (§3.2 — it is
 * not a sandbox) — and it is not nothing: the read becomes a fact somebody can
 * find later instead of an inference nobody can.
 */
export interface PluginWebhookPort {
  list(pluginId: string): Promise<PluginWebhookInfo[]>
  reveal(pluginId: string, webhookId: string): Promise<string>
  rotate(pluginId: string, webhookId: string, opts?: { graceSec?: number }): Promise<{ secret: string; previousValidUntil: number | null }>
}

export interface RuntimeHostDeps {
  /** The plugin registry — read-only from here: the host asks which plugin is active and what it declared, and never writes a row. */
  plugins: PluginRuntime
  dataDir: string
  store: KvStore
  /** `devices.id` → `stableId`, or `null`. A function, never a `Db` — see `plugin-context.ts` on why the context can never hold a database handle. */
  resolveStableId(deviceId: string): string | null
  /**
   * The capability broker (step 109.3, `farm-broker.ts`) — `daemon.ts` wires
   * `createFarmBroker(...).call`, the SAME instance a plugin member script
   * reaches through `createFarmRunnerPort`, so one manifest and one principal
   * govern both halves of a plugin. Absent ⇒ every `ctx.farm` call refuses
   * `E_FARM_UNAVAILABLE`, fail-closed.
   */
  farm?: (
    pluginId: string,
    id: string,
    input: unknown,
    /**
     * **The reset pass's borrowed authority, and the only thing that widens a
     * plugin's capability list anywhere in this codebase.**
     *
     * `{ reset: true }` tells the broker to check this one call against
     * `permissions ∪ resetData.permissions` instead of `permissions` alone.
     * It is set by the HOST, never by plugin code and never by a request body:
     * `buildContext` passes it only for the context object it builds for a
     * reset pass, and only while that pass's own token is still open — so a
     * plugin that squirrels the reset `ctx` away and calls it a minute later is
     * back to its ordinary list.
     *
     * Every other check is untouched. The broker still resolves the real
     * capability, `invoke()` still applies the real ACL under
     * `plugin:<name>`, the lease admission still runs, and the call is still
     * audited — a borrowed permission is permission to be CHECKED for
     * something, never permission to skip the checking.
     */
    opts?: { reset?: boolean },
  ) => Promise<unknown>
  /**
   * One log line from plugin code. `daemon.ts` wires
   * `plugins/runtime-logs.ts` here (step 109.8) — the per-plugin ring, the
   * rotated file and the redactor. Absent ⇒ the
   * core logger under `plugin.<id>`, unredacted, which is what every test that
   * does not care about logging gets.
   */
  emitLog?: (pluginId: string, level: 'debug' | 'info' | 'warn' | 'error', msg: string, fields?: Record<string, unknown>) => void
  /**
   * `ctx.webhooks` (step 109.7). `daemon.ts` wires the auditing wrapper around
   * `plugins/webhook-secrets.ts`; the host never touches the store or the
   * `Db` behind it, for the same reason `farm` is one function and not the
   * broker (criterion 11 — nothing the context can reach may be a handle to
   * something wider).
   *
   * Absent ⇒ every call refuses `E_PLUGIN_WEBHOOK_UNAVAILABLE`, fail-closed.
   */
  webhooks?: PluginWebhookPort
  /**
   * `ctx.logs` (step 109.8) — the read half of the ring `emitLog` writes into.
   * One function, already scoped by the caller to the asking plugin's own
   * lines: a plugin can never page another plugin's log through this, because
   * the id is not its to supply.
   *
   * Absent ⇒ `E_PLUGIN_LOGS_UNAVAILABLE`, fail-closed.
   */
  readLogs?: (pluginId: string, opts: { cursor?: number | null; subject?: string | null; limit?: number }) => PluginLogPage
  log?: Logger
  /**
   * The bind test behind `ctx.isPortFree` and behind the unload backstop
   * (§3.3, R5). Defaults to `@enkaku/session`'s `isPortFree` — the same
   * primitive `PortAllocator` uses, lent rather than reimplemented.
   *
   * Injectable so a test can prove the backstop's behaviour without racing a
   * real socket, and so the negative control (would the harness SEE a
   * force-close if the core did one?) can be built.
   */
  isPortFree?: (port: number, proto: PluginListenerProto) => Promise<boolean>
  /**
   * How a farm event's dispatch is detached from the broadcast's own frame
   * (step 109.5). Defaults to a macrotask — see `runtime-events.ts` on why
   * that and not a microtask. Injectable for the test that proves the
   * broadcast is not delayed, in both directions.
   */
  scheduleEvent?: (fn: () => void) => void
  /** Overrides for tests. */
  defaultTimeoutMs?: number
  maxTimeoutMs?: number
  startTimeoutMs?: number
  disposerTimeoutMs?: number
  eventTimeoutMs?: number
  resetTimeoutMs?: number
  errorBudget?: { failures: number; windowMs: number }
  /**
   * What to do with a floating rejection this host could NOT attribute to any
   * plugin (see `attributeRejection`).
   *
   * `'rethrow'` — the default, and the only honest production value.
   * Installing a `process.on('unhandledRejection')` handler at all changes the
   * runtime's global behaviour: without one, Bun prints the rejection and
   * **exits 1** (measured on Bun 1.3.14, 2026-08-17). A handler that swallowed
   * everything would silently convert every CORE bug into a shrug. Rethrowing
   * an unattributed rejection restores exactly the behaviour the core had
   * before any plugin was loaded.
   *
   * `'report'` — log it and continue. For tests, which must not take the test
   * runner down to prove a code path.
   */
  unattributedRejection?: 'rethrow' | 'report'
}

export interface RuntimeHost {
  list(): PluginServiceView[]
  get(name: string): PluginServiceView | null
  /**
   * Load one plugin's service. Idempotent in the sense that matters: whatever
   * is currently loaded under this name is unloaded first, so this is also
   * "restart". Resets `disabledByBudget` — an operator asking for a start is
   * the finite, explicit retry the budget's "never retries forever" leaves
   * room for.
   */
  load(name: string): Promise<PluginServiceView>
  unload(name: string, reason: string): Promise<void>
  /** `unload` then `load`, under one lock so nothing interleaves. */
  reload(name: string): Promise<PluginServiceView>
  /**
   * **Run one plugin's Reset data cleanup handler — and nothing else.**
   *
   * This host deletes no data and never will: it runs plugin code, contains it,
   * and reports what came back. `api/plugins.ts` is what decides, from this
   * report, whether the namespace is deleted — see `PluginResetOutcome`.
   *
   * Held under the same per-name lock `load`/`unload`/`reload` use, so a reload
   * arriving mid-pass cannot tear the record down while the handler is halfway
   * through un-routing forty phones.
   *
   * Never throws for a plugin-level problem. A service that is not running, a
   * manifest that promises a handler the bundle does not export, a handler that
   * throws, and a report the farm cannot parse are all *reported* — because
   * each one has to reach the operator as a reason nothing was deleted, and a
   * throw at this layer would flatten four different next actions into one 500.
   */
  resetData(name: string): Promise<PluginResetOutcome>
  /** Every ACTIVE plugin that declares a service (§4.2's Load row). Called after the HTTP server is listening, never before. */
  loadActive(): Promise<{ loaded: number; failed: number }>
  unloadAll(reason: string): Promise<void>
  /**
   * **The containment funnel.** Every entry into plugin code goes through
   * this — `setup` today, and every handler kind 109.4–109.7 adds. There is
   * deliberately no second door: containment that some call sites remember to
   * apply is containment that one call site forgets.
   */
  invoke<T>(name: string, spec: InvocationSpec, fn: (signal: AbortSignal) => T | Promise<T>): Promise<T>
  /**
   * One registered `ctx.onRequest`/`onSocket`/`onQuery` handler (step 109.6).
   *
   * `null` means *nothing is registered under that id* — which is a different
   * answer from *the service is not running*, and a caller must establish the
   * second before asking the first. `service-routes.ts` is the one place that
   * ordering is written; nothing else should call this directly.
   */
  lookupHandler(name: string, kind: PluginHandlerKind, id: string): PluginHandlerRegistration | null
  /** A socket handler opened or closed a connection — the `openSockets` counter, which is the only per-plugin signal an in-process design can honestly give. */
  noteSocket(name: string, delta: 1 | -1): void
  /** Wired into `createPluginRuntime`'s `onLifecycle` — activate loads, disable/remove unload (§4.2). */
  handleLifecycle(event: PluginLifecycleEvent): void
  /**
   * **The farm-event tap** (step 109.5). `daemon.ts` registers this on
   * `WsHub.addObserver`, so it is called once per broadcast, after the message
   * has already reached every client.
   *
   * Synchronous, `void`, and it never awaits a handler — see
   * `runtime-events.ts` for why "cannot delay" is the clause that decides the
   * implementation, and criterion 12 for what has to stay true.
   */
  observeEvent(event: ServerMessage): void
  /**
   * Process-wide RSS. Named `process`-wide because that is what it is: **there
   * is no per-plugin memory ceiling in an in-process design** (§4.2), and a
   * number presented per plugin would be an invention. The per-plugin honesty
   * is `counters`, above.
   */
  processRssBytes(): number
  /** Tears down the global rejection handler. Called from `stop()` after `unloadAll`. */
  dispose(): void
}

/**
 * What one Reset data pass produced, as the host saw it. The route turns this
 * into `PluginResetResponse`; nothing here knows about HTTP or about KV.
 *
 * `ran: false` always carries a `skipped` OR an `error`. There is deliberately
 * no fourth state where the handler quietly did not run: "nothing happened and
 * nobody said why" is the shape that lets an operator believe a cleanup
 * occurred.
 */
export interface PluginResetOutcome {
  /** Whether the ACTIVE version's manifest declares a handler at all. */
  declared: boolean
  /** Whether plugin code was actually entered. */
  ran: boolean
  /** Why it was not entered. */
  skipped: { code: string; message: string } | null
  /** It was entered, and it threw, overran, or answered a shape the farm could not parse. */
  error: { code: string; message: string } | null
  /** Whatever it reported. Empty on every path where it did not run. */
  report: PluginResetReport
}

interface ServiceRecord {
  name: string
  version: string
  declaration: PluginServiceDeclaration
  status: PluginServiceStatus
  since: Date
  starts: number
  lastError: PluginServiceError | null
  disabledByBudget: boolean
  lastRejection: { how: RejectionAttributionHow; at: Date } | null
  counters: PluginServiceCounters
  /** Failure timestamps inside the budget window. Pruned on every push. */
  failures: number[]
  disposers: Array<() => void | Promise<void>>
  /**
   * What the plugin reported it opened, keyed on the plugin's own listener id.
   *
   * **There is no socket in here, and that is the mechanism behind criterion
   * 9's "the core never force-closes a socket it does not own"** — the core
   * cannot close what it was never handed. `ReportedListener` is four scalar
   * fields; `ctx.reportListener` parses its input through
   * `ReportedListenerSchema`, so even a plugin that passed its `TCPSocketListener`
   * along by mistake would have it stripped before it reached this map.
   */
  listeners: Map<string, ReportedListener>
  /** Undo functions for this instance's `ctx.onEvent` registrations, run first at teardown. */
  eventUnsubscribes: Array<() => void>
  /**
   * Bumped on every unload. A context handed to a PREVIOUS load carries the
   * generation it was built under, so a disposer registered by code that is
   * still running after its service was torn down is refused instead of being
   * attached to the next instance.
   */
  generation: number
  /** The materialised bundle path, for stack-based rejection attribution. */
  modulePath: string | null
  /**
   * The loaded instance's Reset data handler, or `null`.
   *
   * Held on the record rather than re-imported on demand, and the reason is
   * module state: `loadImpl` cache-busts its `import()` per start, so importing
   * again would produce a SECOND live instance of the plugin's module with its
   * own copy of everything `setup` built — and the reset handler would then
   * clean up after a supervisor that owns none of the sockets. It has to be the
   * function belonging to the instance that is actually running.
   */
  onResetData: ServiceResetData | null
}

// ---------------------------------------------------------------------------
// Criterion 4 — attributing a floating rejection
// ---------------------------------------------------------------------------

/**
 * **Read this before trusting the attribution, and before changing it.**
 *
 * §4.2 specifies the mechanism as "`process.on('unhandledRejection')` with an
 * `AsyncLocalStorage` plugin tag". **That does not work on this runtime, and
 * was measured, not assumed** (Bun 1.3.14, macOS arm64, 2026-08-17):
 *
 * - `AsyncLocalStorage.getStore()` inside an `unhandledRejection` handler
 *   returns `undefined` in **every** case tried — a rejection created
 *   synchronously inside `als.run`, one created after an `await` inside it,
 *   one created in a `setTimeout` scheduled from inside it, and one whose
 *   promise was created inside it and rejected outside. Five for five.
 * - `async_hooks.createHook({ init })` — the other way to associate a promise
 *   with the context that created it — is a **no-op** in Bun: zero `init`
 *   callbacks fire, for promises or anything else.
 *
 * So the plan's stated mechanism is unavailable, and guessing is worse than
 * admitting (the criterion exists precisely so a floating rejection is not
 * written off as "some plugin"). What is built instead is two tiers, each
 * reporting HOW it decided, plus a third outcome that is a real answer:
 *
 * | tier | mechanism | confidence |
 * |---|---|---|
 * | `tagged-reason` | the host built this exact Error and stamped it with the plugin's id; the stamp rides the reason through any `.then()` chain, so a derived promise is still attributable | exact |
 * | `module-stack` | the reason is an `Error` whose stack names exactly ONE loaded plugin's bundle file | high, but a heuristic |
 * | *(none)* | reported as **unattributed**, with the reason verbatim and the loaded plugins listed | — |
 *
 * The deliberate refusal: when exactly one plugin service is loaded it is
 * tempting to blame it. That is a guess dressed as a finding, and it is not
 * made — a core bug on a farm running one plugin would be attributed to the
 * plugin forever.
 *
 * **The known gap, stated:** a rejection whose reason is not an `Error` (a
 * string, a number, a bare object) created inside plugin code has no stack and
 * no stamp, and tier 2 cannot see it. Verified — `Promise.reject('a string')`
 * from inside a plugin module is unattributable. It is reported as such.
 */
export type RejectionAttributionHow = 'tagged-reason' | 'module-stack'

/** The stamp tier 1 reads. `Symbol.for` rather than a private symbol so it survives two copies of this module. */
const PLUGIN_OWNER = Symbol.for('enkaku.plugin.owner')

/** Tier 2's registry: bundle path → the plugin names loaded from it. A path claimed by two names attributes to neither. */
const modulePaths = new Map<string, Set<string>>()

/** Every live host. A module-level set, because `process.on` is global and registering it twice would charge every rejection twice. */
const liveHosts = new Set<HostInternals>()
let handlerInstalled = false

interface HostInternals {
  hasService(name: string): boolean
  chargeRejection(name: string, reason: unknown, how: RejectionAttributionHow): void
  loadedNames(): string[]
  unattributedPolicy(): 'rethrow' | 'report'
  logger(): Logger
}

/**
 * Stamp an error the host is about to reject a plugin's own port with, so a
 * floating promise derived from it is still attributable however many `.then()`
 * hops later it surfaces. Non-enumerable: it must not show up in a JSON body,
 * a log line's field dump, or an equality check on the error.
 */
export function tagPluginError(err: unknown, pluginId: string): unknown {
  if (typeof err === 'object' && err !== null) {
    try {
      Object.defineProperty(err, PLUGIN_OWNER, { value: pluginId, enumerable: false, configurable: true, writable: true })
    } catch {
      // A frozen error object. Tier 2 may still reach it; nothing else breaks.
    }
  }
  return err
}

function attributeRejection(reason: unknown): { name: string; how: RejectionAttributionHow } | null {
  if (typeof reason === 'object' && reason !== null) {
    const tagged = (reason as Record<PropertyKey, unknown>)[PLUGIN_OWNER]
    if (typeof tagged === 'string') return { name: tagged, how: 'tagged-reason' }
  }
  const stack = reason instanceof Error ? (reason.stack ?? '') : ''
  if (stack.length > 0) {
    const hits = new Set<string>()
    for (const [path, names] of modulePaths) {
      if (!stack.includes(path)) continue
      for (const n of names) hits.add(n)
    }
    // Exactly one, or nothing. Two candidate plugins in one stack is an
    // ambiguity, and an ambiguity resolved by picking the first is a guess.
    if (hits.size === 1) return { name: [...hits][0]!, how: 'module-stack' }
  }
  return null
}

function onUnhandledRejection(reason: unknown): void {
  const attributed = attributeRejection(reason)
  if (attributed) {
    for (const host of liveHosts) {
      if (!host.hasService(attributed.name)) continue
      host.chargeRejection(attributed.name, reason, attributed.how)
      return
    }
  }
  // Unattributed. Every live host gets to say so, and the FIRST one's policy
  // decides — in production there is exactly one host, and in a test there is
  // exactly one that asked for `'report'`.
  const hosts = [...liveHosts]
  const loaded = [...new Set(hosts.flatMap((h) => h.loadedNames()))]
  const message = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
  const policy = hosts.find((h) => h.unattributedPolicy() === 'report') ? 'report' : 'rethrow'
  const log = hosts[0]?.logger() ?? createLogger('plugin.host')
  log.error(
    `an unhandled promise rejection could not be attributed to any plugin — it is NOT charged to one, because guessing would be worse than saying so. ` +
      `Loaded plugin services: ${loaded.length > 0 ? loaded.join(', ') : '(none)'}. Rejection: ${message}`,
  )
  if (policy === 'rethrow') {
    // Restores exactly what the runtime does with no handler installed (Bun
    // prints and exits 1). A core bug must not become quieter because a plugin
    // feature installed a handler.
    throw reason
  }
}

function installRejectionHandler(): void {
  if (handlerInstalled) return
  process.on('unhandledRejection', onUnhandledRejection)
  handlerInstalled = true
}

function uninstallRejectionHandler(): void {
  if (!handlerInstalled) return
  if (liveHosts.size > 0) return
  process.off('unhandledRejection', onUnhandledRejection)
  handlerInstalled = false
}

// ---------------------------------------------------------------------------

const RUNNING_ONLY: readonly PluginServiceStatus[] = ['running']

function emptyCounters(): PluginServiceCounters {
  return {
    invocations: 0,
    failures: 0,
    timeouts: 0,
    lateSettlements: 0,
    eventDeliveries: 0,
    unhandledRejections: 0,
    disposers: 0,
    listeners: 0,
    eventSubscriptions: 0,
    handlers: 0,
    openSockets: 0,
  }
}

/** `ctx.isPortFree(port)` — a plugin's own argument is external input like any other. */
const PortSchema = z.number().int().min(1).max(65_535)

function describe(err: unknown): { code: string; message: string } {
  if (err instanceof EnkakuError) return { code: err.code, message: err.message }
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code
    return { code: typeof code === 'string' ? code : 'E_PLUGIN_HANDLER_FAILED', message: err.stack ?? err.message }
  }
  return { code: 'E_PLUGIN_HANDLER_FAILED', message: String(err) }
}

export function createRuntimeHost(deps: RuntimeHostDeps): RuntimeHost {
  const log = deps.log ?? createLogger('plugin.host')
  const defaultTimeoutMs = deps.defaultTimeoutMs ?? DEFAULT_INVOCATION_TIMEOUT_MS
  const maxTimeoutMs = deps.maxTimeoutMs ?? MAX_INVOCATION_TIMEOUT_MS
  const startTimeoutMs = deps.startTimeoutMs ?? defaultTimeoutMs
  const disposerTimeoutMs = deps.disposerTimeoutMs ?? DISPOSER_TIMEOUT_MS
  const eventTimeoutMs = deps.eventTimeoutMs ?? defaultTimeoutMs
  const resetTimeoutMs = deps.resetTimeoutMs ?? RESET_TIMEOUT_MS
  const portFree = deps.isPortFree ?? bindTestPortFree
  const budget = deps.errorBudget ?? { failures: ERROR_BUDGET_FAILURES, windowMs: ERROR_BUDGET_WINDOW_MS }
  const unattributed = deps.unattributedRejection ?? 'rethrow'

  const records = new Map<string, ServiceRecord>()
  /**
   * The http/socket/query registry (step 109.6). Routing and permission live in
   * `service-handlers.ts`; containment stays here, which is why the routes get
   * a REGISTRATION out of it and still come back through `invoke` to run it.
   */
  const handlers: PluginHandlerRegistry = createPluginHandlerRegistry()
  /**
   * One promise chain per plugin name. Load, unload and reload all append to
   * it, so a disable arriving while an activate is still importing cannot
   * interleave — which would otherwise leave the disabled plugin's `setup`
   * finishing INTO a record the unload had already torn down.
   */
  const locks = new Map<string, Promise<unknown>>()

  function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const previous = locks.get(name) ?? Promise.resolve()
    const next = previous.then(fn, fn)
    // Swallowed on the CHAIN only — the caller still sees the real rejection
    // through `next`. Without this, one failed load poisons every later
    // operation on that name.
    locks.set(
      name,
      next.then(
        () => undefined,
        () => undefined,
      ),
    )
    return next
  }

  /**
   * The farm-event tap (step 109.5). Routing and detachment live in
   * `runtime-events.ts`; containment stays here, which is why `deliver` goes
   * through `invoke` and not around it.
   */
  const events: PluginEventRouter = createPluginEventRouter({
    log,
    ...(deps.scheduleEvent ? { schedule: deps.scheduleEvent } : {}),
    deliver(sub, event) {
      const rec = records.get(sub.pluginId)
      // Pre-checked rather than left to `invoke`'s own refusal: a service that
      // is disabled or still starting would otherwise construct one
      // `EnkakuError` per broadcast, forever, for nobody to read.
      if (!rec || rec.status !== 'running' || rec.disabledByBudget) return
      void invoke(
        sub.pluginId,
        {
          what: `event:${event.type}`,
          kind: 'event',
          timeoutMs: sub.timeoutMs ?? eventTimeoutMs,
        },
        (signal) => sub.handler(event, signal),
      ).catch((err: unknown) => {
        // There is no caller to hand this to — an event has no reply — so a
        // failed delivery would otherwise be invisible outside the counters.
        // Bounded by the error budget: a handler that always throws is
        // disabled long before this becomes a flood.
        log.warn(`plugin "${sub.pluginId}": its ${event.type} handler failed — ${describe(err).message}`)
      })
    },
  })

  function toView(rec: ServiceRecord): PluginServiceView {
    return {
      name: rec.name,
      version: rec.version,
      status: rec.status,
      since: rec.since,
      starts: rec.starts,
      lastError: rec.lastError,
      disabledByBudget: rec.disabledByBudget,
      lastRejection: rec.lastRejection,
      permissions: [...rec.declaration.permissions],
      listeners: [...rec.listeners.values()],
      events: [...rec.declaration.events],
      webhooks: rec.declaration.webhooks.map((w) => w.id),
      subscriptions: events.subscriptionsOf(rec.name),
      handlers: handlers.viewsOf(rec.name),
      counters: { ...rec.counters },
    }
  }

  function setStatus(rec: ServiceRecord, status: PluginServiceStatus): void {
    if (rec.status === status) return
    rec.status = status
    rec.since = new Date()
  }

  function recordFailure(rec: ServiceRecord, err: unknown): void {
    const { code, message } = describe(err)
    rec.counters.failures++
    rec.lastError = { code, message, at: new Date() }
    const now = Date.now()
    rec.failures.push(now)
    while (rec.failures.length > 0 && now - rec.failures[0]! > budget.windowMs) rec.failures.shift()
    if (rec.failures.length < budget.failures || rec.disabledByBudget) return
    // §4.2's Error budget row. Loud, verbatim, and FINITE: nothing here
    // schedules a retry. The only way back is an operator's explicit
    // start/restart, which is what `load` resetting `disabledByBudget` means.
    rec.disabledByBudget = true
    log.error(
      `plugin "${rec.name}" service disabled — ${rec.failures.length} handler failures in ${Math.round(budget.windowMs / 1000)}s. ` +
        `It will not be retried automatically; start it again from the Plugins page once the cause is fixed. Last error (verbatim): ${message}`,
    )
    void withLock(rec.name, () => unloadRecord(rec, 'the error budget tripped', 'failed'))
  }

  // -- the containment funnel ------------------------------------------------

  async function invoke<T>(name: string, spec: InvocationSpec, fn: (signal: AbortSignal) => T | Promise<T>): Promise<T> {
    const rec = records.get(name)
    if (!rec) {
      throw new EnkakuError('E_PLUGIN_RUNTIME_NOT_LOADED', `plugin "${name}" has no loaded service`)
    }
    if (rec.disabledByBudget) {
      throw new EnkakuError(
        'E_PLUGIN_RUNTIME_DISABLED',
        `plugin "${name}"'s service was disabled by the error budget and is not being retried — last error: ${rec.lastError?.message ?? 'unknown'}`,
      )
    }
    const allow = spec.allow ?? RUNNING_ONLY
    if (!allow.includes(rec.status)) {
      // `starting` gets its own code precisely because it is NOT `running`:
      // "try again shortly" and "this thing is broken" are different answers
      // and a caller should be able to tell them apart.
      const code = rec.status === 'starting' ? 'E_PLUGIN_RUNTIME_STARTING' : 'E_PLUGIN_RUNTIME_NOT_RUNNING'
      throw new EnkakuError(code, `plugin "${name}"'s service is "${rec.status}", so ${spec.what} was refused`)
    }

    rec.counters.invocations++
    if (spec.kind === 'event') rec.counters.eventDeliveries++

    const timeoutMs = Math.max(1, Math.min(spec.timeoutMs ?? defaultTimeoutMs, maxTimeoutMs))
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let timedOut = false

    // Wrapped in an async IIFE so a handler that throws SYNCHRONOUSLY becomes a
    // rejected promise here rather than an exception thrown past the race — the
    // deadline and the charge must apply to both shapes identically.
    const work = (async () => fn(controller.signal))()

    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true
        // Cooperative only. A handler that ignores its signal — or that never
        // yields at all — is not stopped by this or by anything else in an
        // in-process design; the CALLER is freed, the handler is not.
        controller.abort(new EnkakuError('E_PLUGIN_HANDLER_TIMEOUT', `${spec.what} exceeded its ${timeoutMs}ms deadline`))
        reject(new EnkakuError('E_PLUGIN_HANDLER_TIMEOUT', `plugin "${name}": ${spec.what} exceeded its ${timeoutMs}ms deadline`))
      }, timeoutMs)
    })

    try {
      const value = await Promise.race([work, deadline])
      return value
    } catch (err) {
      recordFailure(rec, err)
      if (timedOut) {
        rec.counters.timeouts++
        throw err instanceof EnkakuError ? err : new EnkakuError('E_PLUGIN_HANDLER_TIMEOUT', String(err))
      }
      const { message } = describe(err)
      throw new EnkakuError('E_PLUGIN_HANDLER_FAILED', `plugin "${name}": ${spec.what} failed — ${message}`, err)
    } finally {
      // Always. A timer left armed after a fast handler is exactly the handle
      // leak H2 exists to catch, and 10 000 of them would be 10 000 live
      // timers holding 10 000 closures.
      if (timer !== undefined) clearTimeout(timer)
      if (timedOut) {
        // `Promise.race` already attached reactions to `work`, so a late
        // rejection is NOT a floating one — it is silently dropped. Observing
        // it here is what turns "the handler is still running somewhere" from
        // an invisible fact into a counter and a log line.
        void work.then(
          () => {
            rec.counters.lateSettlements++
            log.warn(`plugin "${name}": ${spec.what} finished after its deadline had already failed the caller — it was never cancelled, only abandoned`)
          },
          (err: unknown) => {
            rec.counters.lateSettlements++
            log.warn(`plugin "${name}": ${spec.what} rejected after its deadline had already failed the caller — ${describe(err).message}`)
          },
        )
      }
    }
  }

  // -- load / unload ---------------------------------------------------------

  function registerModulePath(path: string, name: string): void {
    const set = modulePaths.get(path) ?? new Set<string>()
    set.add(name)
    modulePaths.set(path, set)
  }

  function unregisterModulePath(path: string | null, name: string): void {
    if (!path) return
    const set = modulePaths.get(path)
    if (!set) return
    set.delete(name)
    if (set.size === 0) modulePaths.delete(path)
  }

  /**
   * The token a reset pass's borrowed authority hangs on. One object per pass,
   * flipped shut in a `finally` — see `resetDataImpl`.
   */
  interface ResetPass {
    open: boolean
  }

  function buildContext(rec: ServiceRecord, opts?: { resetPass?: ResetPass }): PluginServiceContext {
    const generation = rec.generation
    const base = createPluginContext({
      pluginId: rec.name,
      store: deps.store,
      resolveStableId: deps.resolveStableId,
      emitLog: (level, msg, fields) =>
        deps.emitLog ? deps.emitLog(rec.name, level, msg, fields) : log.child(rec.name)[level](msg, fields),
      /**
       * `resetPass` is read HERE, at call time, rather than baked into the
       * closure as a boolean — which is what makes the grant expire.
       *
       * A reset handler that stores its `ctx` in module scope and calls
       * `ctx.farm.call('device.network.clear', …)` ten minutes later goes
       * through this same function with `open: false`, so the broker checks it
       * against the ordinary declared list and refuses it. The authority is
       * scoped to the pass, not to the object — the object is only how the
       * pass is reached.
       */
      ...(deps.farm
        ? { farm: (id: string, input: unknown) => deps.farm!(rec.name, id, input, opts?.resetPass?.open === true ? { reset: true } : undefined) }
        : {}),
      // Tier 1 of the rejection attribution: every error the core rejects one
      // of this plugin's ports with carries the plugin's id, so a floating
      // `void ctx.storage.global.set(...)` is attributable however far down a
      // `.then()` chain it surfaces.
      tagError: (err) => tagPluginError(err, rec.name),
    })
    /**
     * Shared by every registration member below. Code from a PREVIOUS load
     * that is still running must not attach anything to the current instance:
     * a stale disposer would have the new service tear down the old one's
     * resources, a stale listener report would attribute an abandoned socket
     * to the wrong instance, and a stale event handler would keep firing into
     * state its own disposers already released.
     */
    const stale = (what: string): boolean => {
      if (rec.generation === generation) return false
      log.warn(`plugin "${rec.name}": ${what} was called by a context from an earlier load and was ignored`)
      return true
    }

    return {
      ...base,
      onStop(fn: () => void | Promise<void>) {
        if (typeof fn !== 'function') {
          throw new EnkakuError('E_BAD_REQUEST', `ctx.onStop(fn): \`fn\` must be a function (plugin "${rec.name}")`)
        }
        if (stale('ctx.onStop')) return
        rec.disposers.push(fn)
        rec.counters.disposers = rec.disposers.length
      },

      async isPortFree(port: number, proto: PluginListenerProto = 'tcp') {
        const parsed = PortSchema.safeParse(port)
        if (!parsed.success) {
          throw new EnkakuError('E_BAD_REQUEST', `ctx.isPortFree(port): \`port\` must be an integer in 1–65535 (plugin "${rec.name}")`)
        }
        // The bind test, lent (R5). It reserves nothing: §3.3 is the owner's
        // ruling that the plugin owns its listener and its collisions.
        return portFree(parsed.data, proto === 'udp' ? 'udp' : 'tcp')
      },

      reportListener(listener) {
        // Zod at the boundary like any other external input — and the one
        // refusal that matters is inside the schema: `{ proto: 'udp',
        // deviceReachable: true }` is a promise `adb reverse` cannot keep
        // (criterion 17). It refuses the CLAIM, never the socket.
        const parsed = ReportedListenerSchema.safeParse(listener)
        if (!parsed.success) {
          throw new EnkakuError(
            'E_PLUGIN_LISTENER_INVALID',
            `ctx.reportListener (plugin "${rec.name}"): ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`,
          )
        }
        if (stale('ctx.reportListener')) return parsed.data
        rec.listeners.set(parsed.data.id, parsed.data)
        noteListenerCount(rec)
        return parsed.data
      },

      onEvent<T extends FarmEventType>(
        type: T,
        handler: (event: Extract<ServerMessage, { type: T }>, signal: AbortSignal) => void | Promise<void>,
        opts?: { timeoutMs?: number },
      ) {
        if (typeof handler !== 'function') {
          throw new EnkakuError('E_BAD_REQUEST', `ctx.onEvent(type, fn): \`fn\` must be a function (plugin "${rec.name}")`)
        }
        // Exhaustive, exactly as `ctx.farm` treats `permissions` — the list is
        // what the operator was shown at install, so a handler for something
        // outside it is a manifest the farm would be quietly ignoring.
        if (!rec.declaration.events.includes(type)) {
          throw new EnkakuError(
            'E_PLUGIN_EVENT_UNDECLARED',
            `ctx.onEvent("${type}"): plugin "${rec.name}" did not declare that event — add it to defineService({ events: [...] }), ` +
              `which is the list the operator consented to at install. Declared: ${rec.declaration.events.length > 0 ? rec.declaration.events.join(', ') : '(none)'}`,
          )
        }
        if (stale('ctx.onEvent')) return
        rec.eventUnsubscribes.push(
          events.subscribe({
            pluginId: rec.name,
            type,
            // The router only ever delivers a message whose `type` matches the
            // subscription; the guard is what lets the compiler agree without
            // an assertion — see `isFarmEventOfType`. It is also a real check:
            // a routing bug delivers nothing rather than the wrong shape.
            handler: (event, signal) => {
              if (!isFarmEventOfType(event, type)) return
              return handler(event, signal)
            },
            ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
          }),
        )
        rec.counters.eventSubscriptions = rec.eventUnsubscribes.length
      },

      // -- step 109.6, the three handler families ----------------------------
      //
      // All three share one shape, and every part of it is deliberate:
      // validate the id, resolve the permission (refusing an unknown name
      // rather than defaulting past a typo), refuse a stale context, register.
      // None of them CALLS anything — a handler is run by `service-routes.ts`
      // through `invoke`, so containment has one door.

      onRequest(id, handler: PluginRequestHandler, opts) {
        if (typeof handler !== 'function') {
          throw new EnkakuError('E_BAD_REQUEST', `ctx.onRequest(id, fn): \`fn\` must be a function (plugin "${rec.name}")`)
        }
        const handlerId = validateHandlerId(rec.name, 'http', id)
        const permission = resolveHandlerPermission(rec.name, 'http', opts?.permission)
        const methods = resolveHandlerMethods(rec.name, opts?.methods as readonly string[] | undefined)
        if (stale('ctx.onRequest')) return
        handlers.register({
          kind: 'http',
          pluginId: rec.name,
          id: handlerId,
          permission,
          methods,
          handler,
          ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
          ...(opts?.description !== undefined ? { description: opts.description } : {}),
        })
        rec.counters.handlers = handlers.countOf(rec.name)
      },

      onSocket(id, handler: PluginSocketHandler, opts) {
        if (typeof handler !== 'function') {
          throw new EnkakuError('E_BAD_REQUEST', `ctx.onSocket(id, fn): \`fn\` must be a function (plugin "${rec.name}")`)
        }
        const handlerId = validateHandlerId(rec.name, 'socket', id)
        const permission = resolveHandlerPermission(rec.name, 'socket', opts?.permission)
        if (stale('ctx.onSocket')) return
        handlers.register({
          kind: 'socket',
          pluginId: rec.name,
          id: handlerId,
          permission,
          handler,
          ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
          ...(opts?.description !== undefined ? { description: opts.description } : {}),
        })
        rec.counters.handlers = handlers.countOf(rec.name)
      },

      onQuery(id, handler: PluginQueryHandler, opts) {
        if (typeof handler !== 'function') {
          throw new EnkakuError('E_BAD_REQUEST', `ctx.onQuery(id, fn): \`fn\` must be a function (plugin "${rec.name}")`)
        }
        const handlerId = validateHandlerId(rec.name, 'query', id)
        if (stale('ctx.onQuery')) return
        handlers.register({
          kind: 'query',
          pluginId: rec.name,
          id: handlerId,
          // Fixed, not the plugin's to choose — see `PluginQueryRegistration`.
          permission: PLUGIN_QUERY_PERMISSION,
          handler,
          ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
          ...(opts?.description !== undefined ? { description: opts.description } : {}),
        })
        rec.counters.handlers = handlers.countOf(rec.name)
      },

      // -- step 109.7, inbound webhooks --------------------------------------

      onWebhook(id, handler: PluginWebhookHandler, opts) {
        if (typeof handler !== 'function') {
          throw new EnkakuError('E_BAD_REQUEST', `ctx.onWebhook(id, fn): \`fn\` must be a function (plugin "${rec.name}")`)
        }
        const handlerId = validateHandlerId(rec.name, 'webhook', id)
        // Exhaustive against the MANIFEST, exactly as `ctx.onEvent` is against
        // `events` and `ctx.farm` is against `permissions` — and here the list
        // is load-bearing for more than consent: the declaration is what owns
        // the body schema, the size cap, the rate limit and the freshness
        // window, and it is what causes a secret to exist at all. A handler for
        // an id nobody declared would be a door with no lock rather than a door
        // with no sign.
        const declared = rec.declaration.webhooks.find((w) => w.id === handlerId)
        if (!declared) {
          throw new EnkakuError(
            'E_PLUGIN_WEBHOOK_UNDECLARED',
            `ctx.onWebhook("${handlerId}"): plugin "${rec.name}" did not declare that webhook — add it to defineService({ webhooks: [...] }), ` +
              `which is the list the operator consented to at install and the only thing that makes a secret exist for it. ` +
              `Declared: ${rec.declaration.webhooks.length > 0 ? rec.declaration.webhooks.map((w) => w.id).join(', ') : '(none)'}`,
          )
        }
        if (stale('ctx.onWebhook')) return
        handlers.register({
          kind: 'webhook',
          pluginId: rec.name,
          id: handlerId,
          // Not a permission. See `PluginWebhookRegistration`.
          permission: null,
          handler,
          declared,
          ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
          ...(opts?.description !== undefined ? { description: opts.description ?? declared.description } : declared.description !== undefined ? { description: declared.description } : {}),
        })
        rec.counters.handlers = handlers.countOf(rec.name)
      },

      webhooks: {
        async list() {
          const port = requireWebhookPort(rec.name)
          const rows = new Map((await port.list(rec.name)).map((info) => [info.id, info]))
          // **The MANIFEST is the list**, and the rows only fill it in. Two
          // things fall out of that, both deliberate:
          //
          // - a declared webhook with no secret yet is reported
          //   `configured: false` rather than omitted — an author who has not
          //   called `secret()` still sees their own address, and listing does
          //   not mint anything (a read that writes is a surprise nobody wants
          //   from a list);
          // - a ROW that outlives its declaration is not reported at all. A
          //   plugin can publish a version that drops a webhook, and showing
          //   the leftover would show an address that answers
          //   `E_PLUGIN_WEBHOOK_UNDECLARED`. The row is deliberately kept on
          //   disk, though: rolling back to the version that declared it brings
          //   the same secret back, which is the difference between a rollback
          //   and an outage at the far end.
          return rec.declaration.webhooks.map((w) => rows.get(w.id) ?? unconfiguredWebhookInfo(rec.name, w.id))
        },
        async secret(id: string) {
          const port = requireWebhookPort(rec.name)
          return port.reveal(rec.name, requireDeclaredWebhook(rec, id))
        },
        async rotate(id: string, opts?: { graceSec?: number }) {
          const port = requireWebhookPort(rec.name)
          return port.rotate(rec.name, requireDeclaredWebhook(rec, id), opts)
        },
      },

      logs: {
        async page(opts) {
          if (!deps.readLogs) {
            throw new EnkakuError(
              'E_PLUGIN_LOGS_UNAVAILABLE',
              `ctx.logs (plugin "${rec.name}"): this host has no log store wired. Refused rather than answered with an empty page, ` +
                `which would read as "your service has logged nothing".`,
            )
          }
          // The plugin id comes from the RECORD, never from the caller — a
          // plugin cannot page a neighbour's log by naming it, for the same
          // reason `ctx.storage`'s namespace is not an argument.
          return deps.readLogs(rec.name, opts ?? {})
        },
      },
    }
  }

  function requireWebhookPort(name: string): PluginWebhookPort {
    if (!deps.webhooks) {
      throw new EnkakuError(
        'E_PLUGIN_WEBHOOK_UNAVAILABLE',
        `ctx.webhooks (plugin "${name}"): this host has no webhook store wired, so there is nothing to read or rotate. ` +
          `Refused rather than answered with an empty list, which would read as "you have no webhooks".`,
      )
    }
    return deps.webhooks
  }

  function requireDeclaredWebhook(rec: ServiceRecord, id: unknown): string {
    const parsed = typeof id === 'string' ? id : ''
    if (!rec.declaration.webhooks.some((w) => w.id === parsed)) {
      throw new EnkakuError(
        'E_PLUGIN_WEBHOOK_UNDECLARED',
        `ctx.webhooks: plugin "${rec.name}" declares no webhook "${String(id)}". ` +
          `Declared: ${rec.declaration.webhooks.length > 0 ? rec.declaration.webhooks.map((w) => w.id).join(', ') : '(none)'}`,
      )
    }
    return parsed
  }

  /**
   * §4.2's Memory row, and the honest substitute it is: there is no per-plugin
   * RSS ceiling in an in-process design, so what the host CAN see — how much a
   * plugin has opened — is what it warns about, once per crossing rather than
   * on every report.
   */
  function noteListenerCount(rec: ServiceRecord): void {
    const previous = rec.counters.listeners
    const count = rec.listeners.size
    rec.counters.listeners = count
    if (count > LISTENER_WARN_THRESHOLD && previous <= LISTENER_WARN_THRESHOLD) {
      log.warn(
        `plugin "${rec.name}" reports ${count} open listeners, past the ${LISTENER_WARN_THRESHOLD} this farm expects. ` +
          `There is no per-plugin memory ceiling in an in-process design — this count is the only signal there is.`,
      )
    }
  }

  /**
   * **The advisory backstop** (§3.3), and criterion 9.
   *
   * After the disposers have had their say, bind-test every port the plugin
   * reported. Still bound ⇒ one `warn` naming the plugin and the port, and the
   * service is reported `stopping` rather than `stopped`.
   *
   * **What deliberately does not happen here: closing it.** The core was never
   * handed the socket (see `ServiceRecord.listeners`) and could not close it if
   * it wanted to; more to the point it must not want to, because a listener is
   * the plugin's own object and force-closing one behind the plugin's back is
   * how you get a half-torn-down plugin that thinks it is still serving. The
   * honest report is "this port is still bound and I do not know why", and
   * `stopping` is what that reads as in the product.
   *
   * A UDP listener is bind-tested too, with the same caveat the test itself
   * carries: it is a loopback bind, so it can be fooled by a socket on another
   * interface. Advisory means advisory.
   */
  async function checkReportedPorts(rec: ServiceRecord, reason: string): Promise<boolean> {
    if (rec.listeners.size === 0) return true
    let allReleased = true
    for (const listener of rec.listeners.values()) {
      const free = await portFree(listener.port, listener.proto)
      if (free) continue
      allReleased = false
      log.warn(
        `plugin "${rec.name}" reported listener "${listener.id}" on ${listener.proto} port ${listener.port}, ` +
          `and that port is STILL BOUND after its onStop disposers ran during ${reason}. ` +
          `The core does not force-close a socket it does not own, so the service is reported "stopping", not "stopped". ` +
          `Fix the plugin's disposer, or restart the core to reclaim the port.`,
      )
    }
    return allReleased
  }

  /** Drop every `ctx.onEvent` registration this instance made. Runs FIRST at teardown, so nothing new arrives mid-disposal. */
  function clearEventSubscriptions(rec: ServiceRecord): void {
    for (const off of rec.eventUnsubscribes.splice(0)) {
      try {
        off()
      } catch {
        // An unsubscribe cannot fail today; if one ever can, it must not
        // strand the rest of the teardown.
      }
    }
    // Belt and braces: `clear` also catches anything registered under this
    // plugin's name that the array somehow missed.
    events.clear(rec.name)
    rec.counters.eventSubscriptions = 0
  }

  async function runDisposers(rec: ServiceRecord, reason: string): Promise<boolean> {
    // Reverse order, so a teardown mirrors its setup.
    const disposers = rec.disposers.splice(0).reverse()
    rec.counters.disposers = 0
    if (disposers.length === 0) return true

    const settled = Promise.allSettled(
      disposers.map(async (d, index) => {
        try {
          await d()
        } catch (err) {
          // Caught per disposer: one broken teardown must not strand the rest.
          log.warn(`plugin "${rec.name}": onStop disposer #${index} threw during ${reason} — ${describe(err).message}`)
        }
      }),
    )
    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<'expired'>((resolve) => {
      timer = setTimeout(() => resolve('expired'), disposerTimeoutMs)
    })
    try {
      const outcome = await Promise.race([settled.then(() => 'done' as const), expired])
      if (outcome === 'expired') {
        log.warn(
          `plugin "${rec.name}": ${disposers.length} onStop disposer(s) did not finish within ${disposerTimeoutMs}ms during ${reason} — ` +
            `the service is reported "stopping", not "stopped". The core never force-closes what a plugin owns.`,
        )
        return false
      }
      return true
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /**
   * Everything an instance registered, released in the order it has to be:
   * event subscriptions first (so nothing new arrives while state is being
   * torn down), then the plugin's own disposers, then the advisory bind test
   * over whatever it reported.
   *
   * Returns whether the release was clean — false leaves the service
   * `stopping`, which is the honest reading of "the host does not know whether
   * the plugin let go".
   */
  async function releaseInstance(rec: ServiceRecord, reason: string): Promise<boolean> {
    clearEventSubscriptions(rec)
    // Handlers go with the subscriptions and for the same reason: nothing new
    // must arrive while the plugin's own state is being torn down. From here
    // the routes answer "the service is not running", which is the truth, and
    // never "no such handler", which would blame the manifest.
    handlers.clear(rec.name)
    rec.counters.handlers = 0
    rec.counters.openSockets = 0
    // The Reset data handler belongs to the instance being torn down, so it
    // goes with it. Leaving it behind would let a reset run a stopped
    // instance's cleanup against sockets and timers its own disposers have
    // already released.
    rec.onResetData = null
    const disposed = await runDisposers(rec, reason)
    const released = await checkReportedPorts(rec, reason)
    // Cleared AFTER the bind test, which is the only thing that needs them:
    // the next load's `setup` reports its own listeners, and carrying the old
    // instance's over would show the operator a port nobody is serving.
    rec.listeners.clear()
    rec.counters.listeners = 0
    return disposed && released
  }

  async function unloadRecord(rec: ServiceRecord, reason: string, finalStatus: 'stopped' | 'failed'): Promise<void> {
    if (rec.status === 'stopped' && rec.disposers.length === 0 && rec.listeners.size === 0 && rec.eventUnsubscribes.length === 0) {
      unregisterModulePath(rec.modulePath, rec.name)
      rec.modulePath = null
      return
    }
    // Bumped FIRST: from here on, a context handed out by the instance being
    // torn down is stale and its `onStop` is refused.
    rec.generation++
    setStatus(rec, 'stopping')
    const clean = await releaseInstance(rec, reason)
    unregisterModulePath(rec.modulePath, rec.name)
    rec.modulePath = null
    // A disposer that never finished leaves `stopping` even when the caller
    // asked for `stopped` — §3.3's shape, and the honest one: the host does not
    // know whether the plugin let go.
    setStatus(rec, finalStatus === 'failed' ? 'failed' : clean ? 'stopped' : 'stopping')
  }

  async function loadImpl(name: string): Promise<PluginServiceView> {
    const existing = records.get(name)
    if (existing) await unloadRecord(existing, 'a load was requested', 'stopped')

    const row = deps.plugins.active(name)
    if (!row) throw new EnkakuError('plugin_not_found', `no active plugin named "${name}"`)
    const declaration = deps.plugins.service(name)
    if (!declaration) {
      throw new EnkakuError('E_PLUGIN_NO_SERVICE', `plugin "${name}@${row.version}" declares no service — there is nothing to run`)
    }

    const rec: ServiceRecord = existing ?? {
      name,
      version: row.version,
      declaration,
      status: 'stopped',
      since: new Date(),
      starts: 0,
      lastError: null,
      disabledByBudget: false,
      lastRejection: null,
      counters: emptyCounters(),
      failures: [],
      disposers: [],
      listeners: new Map(),
      eventUnsubscribes: [],
      generation: 0,
      modulePath: null,
      onResetData: null,
    }
    rec.version = row.version
    rec.declaration = declaration
    // An explicit start IS the finite retry the budget leaves room for.
    rec.disabledByBudget = false
    rec.failures = []
    rec.starts++
    setStatus(rec, 'starting')
    records.set(name, rec)
    liveHosts.add(internals)
    installRejectionHandler()

    try {
      const bundlePath = await materializeBundleText(deps.dataDir, row.bundle)
      rec.modulePath = bundlePath
      registerModulePath(bundlePath, name)

      // The query string busts Bun's ESM cache so a reload re-runs module
      // scope — which is what an author pressing Reload after an edit means.
      // The cost, stated: the previous module instance stays in the registry
      // for the life of the process, because there is no way to evict one.
      // Bounded by operator reloads, not by traffic.
      const url = `${pathToFileURL(bundlePath).href}?service=${rec.starts}`
      const mod: unknown = await import(url)
      const def = (mod as { default?: unknown }).default
      const service = def && typeof def === 'object' ? (def as { service?: unknown }).service : undefined
      if (!isService(service)) {
        throw new EnkakuError(
          'E_PLUGIN_SERVICE_MISSING',
          `plugin "${name}@${row.version}"'s manifest declares a service, but its bundle's default export has no defineService() result on \`service\` — ` +
            `the manifest and the bundle disagree, which means the row was written by a different build`,
        )
      }

      // Captured off the instance being started, BEFORE `setup` runs: a setup
      // that throws leaves `releaseInstance` to clear it again, and a reset
      // asked of a failed service must find no handler rather than one
      // belonging to a `setup` that never finished.
      rec.onResetData = typeof service.onResetData === 'function' ? service.onResetData : null

      const ctx = buildContext(rec)
      // `starting` is the ONLY status `setup` may run in, and it is the only
      // invocation allowed to run in it. Everything else is refused until
      // `setup` RESOLVES.
      await invoke(name, { what: 'setup', allow: ['starting'], timeoutMs: startTimeoutMs }, () => service.setup(ctx))
      // …and only now.
      setStatus(rec, 'running')
      log.info(`plugin "${name}@${row.version}" service running`, { permissions: declaration.permissions.length })
      return toView(rec)
    } catch (err) {
      const { code, message } = describe(err)
      rec.lastError = { code, message, at: new Date() }
      // Whatever the failed `setup` managed to register still gets torn down —
      // a plugin that bound a port, subscribed to an event and then threw must
      // leave neither behind.
      await releaseInstance(rec, 'the service failed to start')
      unregisterModulePath(rec.modulePath, name)
      rec.modulePath = null
      setStatus(rec, 'failed')
      log.error(`plugin "${name}@${row.version}" service failed to start — ${message}`)
      throw err instanceof EnkakuError ? err : new EnkakuError(code, message, err)
    }
  }

  /**
   * **Reset data, the host's half.** Runs the plugin's cleanup handler under
   * the containment funnel, with one pass's borrowed authority open, and
   * reports what happened. It deletes nothing — see `RuntimeHost.resetData`.
   *
   * The ordering below is the feature: the handler is entered while the
   * plugin's data is still entirely intact, because the data is the only record
   * of what the plugin did to the outside world. Anything that reads
   * "notify, then delete" here has it backwards.
   */
  async function resetDataImpl(name: string): Promise<PluginResetOutcome> {
    const empty: PluginResetReport = { items: [] }
    const declaration = deps.plugins.service(name)
    const declared = declaration?.resetData != null
    const skip = (code: string, message: string): PluginResetOutcome => ({ declared, ran: false, skipped: { code, message }, error: null, report: empty })

    // A plugin with no declared handler is not a failure and is not this
    // function's business: the caller deletes its data and says there was
    // nothing to undo. Answering `ran: false` with no fault is the one legal
    // way to reach that state.
    if (!declared) return { declared: false, ran: false, skipped: null, error: null, report: empty }

    const rec = records.get(name)
    if (!rec || rec.status !== 'running') {
      return skip(
        rec?.status === 'starting' ? 'E_PLUGIN_RUNTIME_STARTING' : 'E_PLUGIN_RUNTIME_NOT_RUNNING',
        `plugin "${name}" declares a Reset data cleanup handler, and its service is "${rec?.status ?? 'not loaded'}" — so the cleanup ` +
          `cannot run and nothing was deleted. Start the service (Plugins → Restart) and reset again: the handler is the only thing that ` +
          `knows what this plugin left on your devices, and deleting its data without running it would strand exactly that.`,
      )
    }
    const handler = rec.onResetData
    if (!handler) {
      // The manifest promised a handler the loaded bundle does not export.
      // Treated as a fault rather than as "nothing to undo": honouring the
      // absent half of a manifest that claims a cleanup exists is how a lie
      // becomes a deletion.
      return skip(
        'E_PLUGIN_RESET_MISSING',
        `plugin "${name}@${rec.version}"'s manifest declares a Reset data handler, but the running bundle exports none — the manifest and ` +
          `the bundle disagree, which means the row was written by a different build. Nothing was deleted. Reload the plugin.`,
      )
    }

    /**
     * The pass. Open for exactly as long as the handler is being awaited, and
     * shut in a `finally` whether it returned, threw, or blew its deadline —
     * including the case `invoke` cannot cancel, where the handler is still
     * running after the caller has been freed. That last one is why the token
     * is an object read at call time rather than a boolean captured in a
     * closure: an abandoned handler that keeps going must lose the borrowed
     * authority at the same instant the operator's request ends.
     */
    const pass: ResetPass = { open: true }
    const ctx = buildContext(rec, { resetPass: pass })
    const borrowed = declaration?.resetData?.permissions ?? []
    if (borrowed.length > 0) {
      log.info(`plugin "${name}": Reset data pass open — borrowing ${borrowed.join(', ')} for the length of this pass only`)
    }
    try {
      const returned = await invoke(name, { what: 'reset', timeoutMs: resetTimeoutMs }, () => handler(ctx))
      // Plugin output crossing into the core, so it is parsed and not trusted
      // — the same rule every other boundary in this workspace follows. A
      // handler that returned nothing at all is a valid empty report: it had
      // nothing to undo, and saying so is not the same as failing.
      const parsed = PluginResetReportSchema.safeParse(returned ?? {})
      if (!parsed.success) {
        return {
          declared,
          ran: true,
          skipped: null,
          error: {
            code: 'E_PLUGIN_RESET_REPORT_INVALID',
            message:
              `plugin "${name}"'s Reset data handler ran, but answered a report this farm cannot read — ` +
              `${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}. ` +
              `Nothing was deleted: a cleanup whose own account of itself is unreadable cannot be treated as a cleanup that succeeded.`,
          },
          report: empty,
        }
      }
      return { declared, ran: true, skipped: null, error: null, report: parsed.data }
    } catch (err) {
      const { code, message } = describe(err)
      return { declared, ran: true, skipped: null, error: { code, message }, report: empty }
    } finally {
      pass.open = false
    }
  }

  const internals: HostInternals = {
    hasService: (name) => records.has(name),
    chargeRejection(name, reason, how) {
      const rec = records.get(name)
      if (!rec) return
      rec.counters.unhandledRejections++
      rec.lastRejection = { how, at: new Date() }
      const { message } = describe(reason)
      log.error(
        `plugin "${name}": an unhandled promise rejection was attributed to it (${how}) and charged — the core survived it. ${message}`,
      )
      recordFailure(rec, reason)
    },
    loadedNames: () => [...records.keys()].filter((n) => records.get(n)?.status !== 'stopped'),
    unattributedPolicy: () => unattributed,
    logger: () => log,
  }

  const host: RuntimeHost = {
    list: () => [...records.values()].map(toView),
    get: (name) => {
      const rec = records.get(name)
      return rec ? toView(rec) : null
    },
    load: (name) => withLock(name, () => loadImpl(name)),
    unload: (name, reason) =>
      withLock(name, async () => {
        const rec = records.get(name)
        if (!rec) return
        await unloadRecord(rec, reason, 'stopped')
      }),
    reload: (name) => withLock(name, () => loadImpl(name)),
    // Under the SAME lock as load/unload/reload: a reload arriving while a
    // handler is halfway through un-routing forty phones would tear the record
    // down under it, and the borrowed authority would be attached to a
    // generation that no longer exists.
    resetData: (name) => withLock(name, () => resetDataImpl(name)),

    async loadActive() {
      let loaded = 0
      let failed = 0
      // Sequential, deliberately: two plugins binding ports at once is a race
      // with no upside, and a boot that loads plugins one at a time is a boot
      // whose log reads in order.
      for (const row of deps.plugins.list()) {
        if (row.status !== 'active') continue
        if (!deps.plugins.service(row.name)) continue
        try {
          await withLock(row.name, () => loadImpl(row.name))
          loaded++
        } catch {
          // Already recorded on the row's own record and logged by `loadImpl`.
          // Swallowed HERE because this runs at boot: one broken plugin must
          // not stop the others from loading, and must not reach the caller,
          // which is `daemon.ts` after the HTTP server is already listening.
          failed++
        }
      }
      if (loaded > 0 || failed > 0) log.info(`plugin services loaded: ${loaded} running, ${failed} failed`)
      return { loaded, failed }
    },

    async unloadAll(reason) {
      for (const name of [...records.keys()]) {
        await withLock(name, async () => {
          const rec = records.get(name)
          if (rec) await unloadRecord(rec, reason, 'stopped')
        })
      }
    },

    invoke,

    lookupHandler: (name, kind, id) => handlers.lookup(name, kind, id),

    noteSocket(name, delta) {
      const rec = records.get(name)
      if (!rec) return
      rec.counters.openSockets = Math.max(0, rec.counters.openSockets + delta)
    },

    handleLifecycle(event) {
      // Fire-and-forget by contract (`PluginRuntimeDeps.onLifecycle`): an
      // operator pressing Disable must not wait on a plugin's disposers, and
      // must not have their request fail because of one.
      if (event.kind === 'deactivated') {
        void withLock(event.name, async () => {
          const rec = records.get(event.name)
          if (rec) await unloadRecord(rec, `the plugin was ${event.kind}`, 'stopped')
        }).catch((err: unknown) => log.warn(`plugin "${event.name}": unload after ${event.kind} failed — ${describe(err).message}`))
        return
      }
      if (!deps.plugins.service(event.name)) {
        // Activated, but declares no service — including the case where it USED
        // to declare one and this version does not, which is why the unload
        // below is not conditional on there being a record to keep.
        void withLock(event.name, async () => {
          const rec = records.get(event.name)
          if (rec) await unloadRecord(rec, 'the newly active version declares no service', 'stopped')
        }).catch(() => undefined)
        return
      }
      void withLock(event.name, () => loadImpl(event.name)).catch((err: unknown) =>
        log.warn(`plugin "${event.name}": service failed to load after ${event.kind} — ${describe(err).message}`),
      )
    },

    observeEvent(event) {
      events.observe(event)
    },

    processRssBytes: () => process.memoryUsage.rss(),

    dispose() {
      liveHosts.delete(internals)
      for (const rec of records.values()) {
        clearEventSubscriptions(rec)
        handlers.clear(rec.name)
        unregisterModulePath(rec.modulePath, rec.name)
      }
      uninstallRejectionHandler()
    },
  }

  return host
}
