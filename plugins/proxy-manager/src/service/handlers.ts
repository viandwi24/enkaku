import type { PluginLogPage } from '@enkaku/protocol'
import type { PluginRequest, PluginResponse } from '@enkaku/sdk'
import { PROXY_LOGS_DEFAULT_LIMIT, proxyKeyFor, type ProxyProblem, type ProxyRecord } from '../shared'
import type { FailoverHistoryEntry } from './failover'
import { proxySubject, type LogSink } from './logbook'
import type { ProxyRuntime, ProxyState, Supervisor } from './supervisor'

/**
 * The five routes the screen drives a bridge through (plan 112 §4.6, step
 * 112.9).
 *
 * ## The routes are a door onto the supervisor, never a second lifecycle
 *
 * Every one of them ends in a call to `supervisor.start`/`stop`/`restart`/
 * `snapshot`, which is the file that owns a bridge's state: the five-state
 * machine, `enabled` honoured at boot, the named `EADDRINUSE`, the two-phase
 * stop with `drainMs`, force stop, and restart under one lock. Nothing here
 * binds a socket, keeps a state, or holds a timer of its own — a second owner
 * of the same fact is how a screen comes to say `running` about a port nothing
 * is listening on.
 *
 * ## The refusal order is inherited, not re-derived
 *
 * Plan 109 step 109.6 asks the six questions in one place
 * (`packages/core/src/plugins/service-routes.ts`) and **asks about the service's
 * status BEFORE it looks for a handler**, so a request to a stopped service is
 * refused as *not running* rather than 404ing as if the screen had never
 * existed. That order is already applied to everything below, before a byte of
 * this file runs; re-deriving any of it here is how the two come to disagree.
 *
 * What is left for this file is the layer under it: a proxy ID that names no
 * record. That answers `404` with its own code and an `ok: false` body — never
 * a throw, which the host would turn into a `502` naming this plugin as
 * faulty, and never a silent empty result.
 *
 * ## Why `plugin.runtime` on the three that act, and `script.view` on the two that read
 *
 * `script.view` is the permission an operator already had to hold to open this
 * screen at all, and it is `onRequest`'s own default. `plugin.runtime` is the
 * farm's existing answer to *may this person start and stop a plugin's
 * long-lived half* — the same permission `POST /api/plugins/:name/runtime/restart`
 * requires — and starting a bridge is exactly that act one bridge at a time. It
 * is deliberately not `plugin.data`: the operator is not editing a record here,
 * they are changing what is listening on the machine.
 *
 * Both are in the OPERATOR set today, so the split does not refuse anybody
 * anything yet. It is written down anyway, because a read gated on a write
 * permission is a fixture nobody notices until roles narrow, and by then the
 * screen is the thing that breaks.
 */

/**
 * The plan's own route table said `POST …/http/proxies/:id/start`, and step
 * 109.6 does not permit that shape — **recorded here rather than quietly
 * reshaped**, because plan 112 §4.6 was written before 109.6 existed.
 *
 * The core resolves a plugin's HTTP handler by taking the FIRST path segment
 * after `/http/` as the handler id and handing the rest to the handler as
 * `request.path` (`packages/core/src/api/plugins.ts`, the `/:name/http/:path{.+}`
 * route). A registration therefore owns a whole subtree, and `proxies` and
 * `proxies/:id/start` cannot be two registrations. One registration for all
 * four would mean ONE permission for the list and the three actions, which is
 * the split above collapsed — so the verbs are their own handler ids and the id
 * moves into the path:
 *
 * | method + path | handler id | permission |
 * |---|---|---|
 * | `GET  …/http/proxies` | `proxies` | `script.view` |
 * | `POST …/http/start/<id>` | `start` | `plugin.runtime` |
 * | `POST …/http/stop/<id>` | `stop` | `plugin.runtime` |
 * | `POST …/http/restart/<id>` | `restart` | `plugin.runtime` |
 * | `GET  …/http/logs` | `logs` | `script.view` |
 *
 * The second benefit is in the audit log, and it decided the shape between two
 * options that both worked: `plugin.http` records `target: '<plugin>/<handlerId>'`
 * and the method, and **never the sub-path or the body**. A single `proxies`
 * handler would leave every start, stop and force-stop as one indistinguishable
 * `POST proxy-manager/proxies` row. With a handler per verb the audit says
 * which verb; which proxy it was is in this plugin's own log, tagged with that
 * proxy's subject, which is where the per-proxy story already lives.
 */
export const PROXY_ROUTES = {
  list: 'proxies',
  start: 'start',
  stop: 'stop',
  restart: 'restart',
  /**
   * Plan 121 §4.5, step 121.6 — the manual "Reset to primary" action's own
   * route, wrapping `Supervisor.resetFailover`. Gated the same way
   * start/stop/restart are: it is an action that changes what a bridge is
   * actually dialling, not a record edit, so `plugin.runtime` and not
   * `plugin.data`.
   */
  resetFailover: 'reset-failover',
  logs: 'logs',
} as const

/** The permission each route declares. Exported so a test asserts the table rather than the implementation's memory of it. */
export const PROXY_ROUTE_PERMISSIONS: Record<keyof typeof PROXY_ROUTES, string> = {
  list: 'script.view',
  start: 'plugin.runtime',
  stop: 'plugin.runtime',
  restart: 'plugin.runtime',
  resetFailover: 'plugin.runtime',
  logs: 'script.view',
}

/**
 * How long a stop handler may take.
 *
 * A stop DRAINS: phase 1 releases the port at once and live tunnels are given
 * up to the record's own `drainMs` — bounded by the schema at 120 000 ms — to
 * finish before phase 2 destroys them (plan 112 §3.7). This handler waits for
 * the supervisor's own promise rather than returning early and inventing a
 * second notion of "stopping", so its deadline has to be wider than the widest
 * drain a record can ask for. The host clamps a handler override at 300 000 ms,
 * so this fits with room to spare.
 *
 * A screen does not have to sit on that request to watch it happen: the row
 * reads `stopping` with a live count from `GET …/http/proxies` throughout, which
 * is the same fact from the same supervisor.
 */
export const STOP_TIMEOUT_MS = 135_000

/** What `GET …/http/proxies` answers with, per row. */
export interface ProxyRow {
  id: string
  /** The storage key, so the screen never has to rebuild one, and the value a log filter takes. */
  key: string
  /** The stored record — intent. It carries no credential: the password is the other key and is never read here. */
  record: ProxyRecord
  /** What the supervisor observes — never stored, gone when the core restarts, because the listener is gone too. */
  state: ProxyState
  since: number
  /** `null` unless something is listening right now. */
  port: number | null
  /** `null` unless the state is `running` — an uptime for something that is not up is a number that reads as a lie. */
  uptimeMs: number | null
  liveConnections: number
  totalConnections: number
  refusedConnections: number
  bytesUp: number
  bytesDown: number
  lastError: { code: string; message: string } | null
  /** Every refusal and precondition blocking this record, so the screen can disable Start and say why. */
  problems: ProxyProblem[]
  /** Convenience for the screen, decided here so two halves cannot disagree about what "startable" means. */
  startable: boolean
  /**
   * This record's failover state (plan 121 §4.5, step 121.6) — `null` when
   * nothing is running, since there is no live `FailoverController` for a
   * stopped record. Narrowed to what the screen actually draws (`activeIndex`,
   * `history`) rather than the controller's full internal state — the same
   * "narrow the wire to the fields a screen draws" rule `ProxyRow` itself
   * already follows for the record and the runtime.
   */
  failover: { activeIndex: number; history: FailoverHistoryEntry[] } | null
}

/** A refusal this file made itself. Always `200`-shaped `{ ok: false }` except for the one below, which is genuinely a 404. */
export interface ProxyActionRefusal {
  ok: false
  code: string
  message: string
}

export interface ProxyActionResult {
  ok: boolean
  id: string
  runtime: ProxyRuntime
}

/** The narrow slice of `PluginServiceContext` this file needs — so a test supplies three functions rather than a runtime. */
export interface HandlerHost {
  log: LogSink
  logs: { page(opts?: { cursor?: number | null; subject?: string | null; limit?: number }): Promise<PluginLogPage> }
  onRequest(
    id: string,
    handler: (request: PluginRequest, signal: AbortSignal) => PluginResponse | void | Promise<PluginResponse | void>,
    opts?: { permission?: string; methods?: readonly ('GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE')[]; timeoutMs?: number; description?: string },
  ): void
}

const E_PROXY_UNKNOWN = 'E_PROXY_UNKNOWN'

/** `/office-uk` → `office-uk`; `/` → `''`. A trailing slash is tolerated because a browser will send one eventually. */
export function proxyIdFromPath(path: string): string {
  const trimmed = path.replace(/^\/+/, '').replace(/\/+$/, '')
  return trimmed.split('/')[0] ?? ''
}

export function toRow(
  view: { id: string; record: ProxyRecord; runtime: ProxyRuntime; problems: ProxyProblem[]; failover?: Readonly<{ activeIndex: number; history: FailoverHistoryEntry[] }> | null },
  now: number,
): ProxyRow {
  const { runtime } = view
  return {
    id: view.id,
    key: proxyKeyFor(view.id),
    record: view.record,
    state: runtime.state,
    since: runtime.since,
    port: runtime.port,
    uptimeMs: runtime.state === 'running' ? Math.max(0, now - runtime.since) : null,
    liveConnections: runtime.liveConnections,
    totalConnections: runtime.totalConnections,
    refusedConnections: runtime.refusedConnections,
    bytesUp: runtime.bytesUp,
    bytesDown: runtime.bytesDown,
    lastError: runtime.lastError,
    problems: view.problems,
    startable: view.problems.length === 0,
    failover: view.failover ? { activeIndex: view.failover.activeIndex, history: view.failover.history } : null,
  }
}

function unknownProxy(id: string): PluginResponse {
  const body: ProxyActionRefusal = {
    ok: false,
    code: E_PROXY_UNKNOWN,
    message: id
      ? `There is no proxy record “${id}” in this plugin's catalogue. It was probably deleted between this screen loading and the button being pressed — reload the tab.`
      : 'This route needs a proxy id in the path, as in /start/office-uk.',
  }
  // A 404 about a RECORD, not about a route: the route resolved, the service is
  // running, and the handler was found — plan 109 step 109.6's own order has
  // already answered all three. What is missing is the row.
  return { status: 404, body }
}

/**
 * Register every route on a live service context.
 *
 * Called from `setup`, so a registration is dropped when the service stops —
 * which is what makes a request to a stopped service refuse as *not running*
 * rather than as *no such screen*.
 */
export function registerProxyRoutes(host: HandlerHost, supervisor: Supervisor): void {
  /** Every route re-reads the catalogue first: the screen writes a record through `PUT …/data/entry` and presses Start a moment later, and a supervisor that had not looked since boot would answer about a row that no longer exists. */
  async function fresh(): Promise<void> {
    await supervisor.refresh()
  }

  host.onRequest(
    PROXY_ROUTES.list,
    async () => {
      await fresh()
      const now = Date.now()
      return { body: { items: supervisor.snapshot().map((view) => toRow(view, now)) } }
    },
    {
      methods: ['GET'],
      permission: PROXY_ROUTE_PERMISSIONS.list,
      description: 'Every proxy record, joined with what the supervisor observes about it right now: state, live and total connections, bytes, uptime and last error.',
    },
  )

  function action(route: 'start' | 'stop' | 'restart', run: (id: string, request: PluginRequest) => Promise<ProxyRuntime>, description: string): void {
    host.onRequest(
      PROXY_ROUTES[route],
      async (request) => {
        await fresh()
        const id = proxyIdFromPath(request.path)
        if (!id || !supervisor.has(id)) return unknownProxy(id)
        // Who pressed it, on this proxy's own line. The farm audits the request
        // itself (`plugin.http`, naming the human and the verb); this is the
        // half that says WHICH proxy, which the audit row cannot carry.
        host.log.info(`proxy ${route} requested`, { subject: proxySubject(id), by: request.caller.id })
        const runtime = await run(id, request)
        const result: ProxyActionResult = { ok: route === 'stop' ? runtime.state === 'stopped' : runtime.state === 'running', id, runtime }
        return { body: result }
      },
      {
        methods: ['POST'],
        permission: PROXY_ROUTE_PERMISSIONS[route],
        ...(route === 'stop' ? { timeoutMs: STOP_TIMEOUT_MS } : {}),
        description,
      },
    )
  }

  action('start', (id) => supervisor.start(id), 'Bind this record’s listener. Answers once it is listening, or with the row’s own named failure — a taken port is E_PROXY_LISTEN_ADDR_IN_USE, not a stack trace.')
  action(
    'stop',
    (id, request) => {
      const body = request.body
      const force = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as { force?: unknown }).force === true : false
      return supervisor.stop(id, { force })
    },
    'Stop this bridge. The port is released at once; live tunnels are given the record’s own drain window unless `{ "force": true }` skips it.',
  )
  action('restart', (id) => supervisor.restart(id), 'Stop then start, under one lock, so nothing interleaves. Live tunnels get the drain.')

  /**
   * Plan 121 §4.5, step 121.6 — the manual "Reset to primary" action. Unlike
   * start/stop/restart, `ok` here is not "the state that was reached": a
   * record already on primary, or a record that is not running at all, both
   * answer `ok: true` with nothing changed — `Supervisor.resetFailover` is
   * explicitly a no-op rather than a refusal in both cases (its own doc
   * comment), so there is no failure shape for this route to report either.
   */
  host.onRequest(
    PROXY_ROUTES.resetFailover,
    async (request) => {
      await fresh()
      const id = proxyIdFromPath(request.path)
      if (!id || !supervisor.has(id)) return unknownProxy(id)
      host.log.info('proxy failover reset to primary requested', { subject: proxySubject(id), by: request.caller.id })
      const runtime = await supervisor.resetFailover(id)
      const result: ProxyActionResult = { ok: true, id, runtime }
      return { body: result }
    },
    {
      methods: ['POST'],
      permission: PROXY_ROUTE_PERMISSIONS.resetFailover,
      description: 'Force this record’s active upstream back to primary right now, regardless of auto failback. A no-op when the record is already on primary or is not running.',
    },
  )

  host.onRequest(
    PROXY_ROUTES.logs,
    async (request) => {
      // ONE stream, filtered server-side by the farm (plan 109 step 109.8).
      // "All" is this page with no subject; "per proxy" is the same page with
      // one. There is deliberately no second filter in this pack and no ring of
      // its own: `ctx.logs.page({ subject })` is the whole mechanism.
      const proxy = request.query.proxy ?? ''
      const cursorRaw = Number.parseInt(request.query.cursor ?? '', 10)
      const limitRaw = Number.parseInt(request.query.limit ?? '', 10)
      const opts = {
        cursor: Number.isFinite(cursorRaw) ? cursorRaw : null,
        subject: proxy ? proxySubject(proxy) : null,
        limit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : PROXY_LOGS_DEFAULT_LIMIT,
      }
      try {
        const page = await host.logs.page(opts)
        // `proxy` is echoed beside the farm's own `subject` so the screen can
        // tell a filtered page from an empty plugin without re-deriving the tag.
        return { body: { ...page, proxy: proxy || null } }
      } catch (err: unknown) {
        // A host with no log store wired refuses `E_PLUGIN_LOGS_UNAVAILABLE`
        // rather than answering an empty page — and this route must not undo
        // that by inventing one. No `lines` key at all: a screen that got
        // `lines: []` would render "this proxy has logged nothing", which is a
        // different and false claim.
        // The envelope is `{ error: { code, message } }`, NOT `{ ok, code,
        // message }`. That is the farm's own error shape and the only one
        // `api()` unwraps — step 112.10 found the flat form on the screen,
        // where the operator got a bare "Request failed (HTTP 503)" and both
        // the code and the sentence below were dropped on the floor. A coded
        // refusal nobody can read is the same as an uncoded one.
        const code = (err as { code?: unknown } | null)?.code
        return {
          status: 503,
          body: {
            error: {
              code: typeof code === 'string' ? code : 'E_PROXY_LOGS_UNAVAILABLE',
              message: err instanceof Error ? err.message : 'this farm kept no log for this plugin, so there is nothing to page through',
            },
          },
        }
      }
    },
    {
      methods: ['GET'],
      permission: PROXY_ROUTE_PERMISSIONS.logs,
      description: 'One log stream for every bridge this plugin runs. `?proxy=<id>` filters it to one, server-side; `?cursor=` continues from a page you already have.',
    },
  )
}
