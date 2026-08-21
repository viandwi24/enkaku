import { proxyKeyFor } from '../shared'

/**
 * The log line vocabulary — what this pack records, what it deliberately does
 * not, and the tag that makes "logs all" and "logs per proxy" one stream
 * instead of two (plan 112 §3.8, step 112.8).
 *
 * ## One ring, tagged — and the filter is the farm's, server-side
 *
 * Plan 109 step 109.8 built the substrate this step needed and built it wider
 * than plan 112 §3.8 assumed: every retained line carries an optional
 * `subject`, lifted out of the ordinary `fields` bag by the core, there is ONE
 * ring per plugin rather than one per subject, and `ctx.logs.page({ subject })`
 * filters **server-side from day one**. So §3.8's *"filter client-side in v1,
 * widen 109.8's route later"* is already closed, and this pack must not build a
 * second filter: "all" is the unfiltered page, "per proxy" is the same page
 * with a subject.
 *
 * The cost of one ring is real and is stated where a reader will see it
 * (`LOGS_SHARED_RING_NOTE` in `shared.ts`): **a busy proxy evicts a quiet one's
 * lines.** `PluginLogPage.truncated` is what stops that reading as "this proxy
 * did nothing".
 *
 * ## What a line records
 *
 * | event | level | fields |
 * |---|---|---|
 * | `accepted` | debug | — |
 * | `upstream-connected` | debug | `destPort`, `egressAddress`, and `destHost` only when `logDestinations` is on |
 * | `closed` | debug | `durationMs`, `bytesUp`, `bytesDown` |
 * | `bind-mismatch` | warn | `bindAddress`, `egressAddress` — plan 123 §4.4, once per start per record, never per connection |
 * | `refused` | warn | `reason`, `code`, `destPort`, `destHost` only when `logDestinations` is on, and `clientAddress` for a listener-authentication refusal (plan 117 §4.4) |
 * | `start` | info | — |
 * | `listening` | info | `port`, `listen`, `upstreamProto`, `upstreamHost`, `upstreamPort` |
 * | `start-refused` | warn | `code`, `message` — a record that may not run, refused before a socket is opened |
 * | `start-failed` | error | `code`, `message`, `port` — including `E_PROXY_LISTEN_ADDR_IN_USE`, the failure everyone hits |
 * | `drain` | info | `live`, `drainMs` — phase 1 of a stop, the port already released |
 * | `stop` | info | `forced`, `port` |
 * | `restart` | info | — |
 * | `teardown` | info | `port` — the plugin itself is stopping, so there is no drain (§3.7's 5 s disposer budget) |
 *
 * Every one of those is tagged with the proxy's `subject`. Two more are
 * deliberately **untagged**, because they belong to the supervisor rather than
 * to any one proxy, and an untagged line appears in "all" and in no per-proxy
 * view: `service-started` and `service-stopped`.
 *
 * ## `egressAddress` and `bind-mismatch` are a deliberate exception, not an oversight (plan 123 §3.4, §4.4)
 *
 * Plan 123 found that `net.connect({ localAddress })` is silently ignored by
 * Bun on every platform tested — a `direct` record with a `bindAddress` could
 * egress from the host's default address while reporting `running` and
 * logging a clean `upstream-connected` line, with nothing anywhere to show it.
 * `socket.localAddress`, read at the moment `upstream-connected` already fires
 * (dial resolution, while the socket is live — plan 123 §0.3 measured that
 * this is the one moment the property is accurate), is an address of the
 * **host itself** — not a destination and not a credential — so it clears
 * every rule in the section below and is added to that line as
 * `egressAddress`. A second, new event, `bind-mismatch`, fires once per
 * **start**, not per connection, the first time a record's observed egress
 * disagrees with its own configured `bindAddress`: a farm doing steady traffic
 * must not have this line flood a ring shared with every other proxy, and
 * once is enough to be noticed. A record with no `bindAddress` has nothing to
 * compare against and never fires it.
 *
 * ## What a line NEVER records, at any setting
 *
 * A proxy carries other people's traffic. The operator is also the person who
 * owns it, so this is not a privacy problem in the usual sense — it is a
 * *default* problem: a log that quietly accumulates a browsing history of every
 * device on the farm, in a rotated file on disk, is not something an operator
 * should have to discover.
 *
 * - **The upstream password.** Never passed to a log call at all, by
 *   construction. The farm's own value-based redactor (plan 109 step 109.8 does
 *   wire one now) is defence in depth and not the defence: it can only see a
 *   secret that is in this plugin's KV namespace, and this pack stores none yet.
 *   Nothing from `socks` is ever logged either — a `SocksClientError` carries
 *   the whole `SocksClientOptions` on `err.options`, **password included**, so
 *   anything that logged an error OBJECT rather than a re-worded message would
 *   write the credential to a file (plan 112 §0.3.2).
 * - **The upstream username.** Not because it is a credential, but because plan
 *   112 §9 Q1 has not decided whether it is one — the owner's own example
 *   encodes an exit country and a sticky-session id. The catalogue shows it;
 *   the log does not need to, and the narrower default is the one that can be
 *   widened later without re-reading old files.
 * - **A request path, a query string, a header, or a byte of payload.** The
 *   event vocabulary has no field one could travel in, and `logbook.test.ts`
 *   asserts the field allowlist exactly so a later field cannot be added
 *   without a decision.
 * - **A destination host**, unless this record's own `logDestinations` switch
 *   is on. A destination **port** is always recorded: it distinguishes "TLS to
 *   something" from "plain HTTP to something", which is not a browsing record,
 *   and without it a refusal is nearly undebuggable.
 * - **A submitted listener credential, in any form.** A wrong username or
 *   password (plan 117 §4.4) fails the connection with a `reason` string and,
 *   for that one reason, the address it came from — never the username or
 *   password itself, plaintext or base64. `errors.ts`'s `listenerAuthSecrets`
 *   is the same defence-in-depth net the upstream password already gets.
 */

/** Where a line goes. Deliberately the smallest surface `ScriptLogger` satisfies, so a test can pass a recorder. */
export interface LogSink {
  debug(message: string, fields?: Record<string, unknown>): void
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
  error(message: string, fields?: Record<string, unknown>): void
}

/**
 * The longest tag the farm keeps.
 *
 * It is `PLUGIN_LOG_MAX_SUBJECT` in `packages/core/src/plugins/runtime-logs.ts`
 * and it is restated here rather than imported, because a plugin has no
 * dependency on the core and should not grow one for a number. **The two must
 * agree**, and the failure if they drift is silent in the worst way: the core
 * trims the tag it STORES, this pack sends an untrimmed tag to filter WITH, no
 * line matches, and a proxy whose key happens to be long has a log view that is
 * permanently and honestly empty.
 */
export const SUBJECT_MAX_LENGTH = 64

/**
 * The tag every line about one proxy carries — its own storage key.
 *
 * The key rather than the bare id, because that is what the rest of the pack
 * already passes around (`ASSIGNMENT` holds one) and because `proxy:office-uk`
 * cannot be mistaken for anything else in a shared stream.
 *
 * **The screen's `?proxy=` carries the BARE ID, not the key** — an earlier
 * draft of this comment said the opposite and it is worth being exact, because
 * getting it wrong fails silently rather than loudly. `handlers.ts`'s logs
 * route calls `proxySubject(request.query.proxy)`, i.e. it prefixes. Hand it a
 * key and the tag becomes `proxy:proxy:office-uk`, which matches no line ever
 * written — so the log view is not broken, it is **empty forever**, and empty
 * reads as "this proxy has done nothing".
 *
 * The 64-character clamp is the other half of the same hazard: the core trims
 * what it STORES, so an untrimmed filter value would miss every line belonging
 * to a long-keyed proxy, in exactly the same silent way.
 */
export function proxySubject(proxyId: string): string {
  return proxyKeyFor(proxyId).slice(0, SUBJECT_MAX_LENGTH)
}

/** The five things that can happen to one connection, and the only five. */
export type BridgeEvent =
  | { event: 'accepted'; conn: number }
  | { event: 'upstream-connected'; conn: number; destPort: number; destHost: string; egressAddress: string }
  | { event: 'closed'; conn: number; durationMs: number; bytesUp: number; bytesDown: number }
  | {
      event: 'refused'
      conn: number
      reason: string
      code?: string
      destPort?: number
      destHost?: string
      /** Plan 117 §4.4: which address a refused authentication attempt came from — never the credential it offered. */
      clientAddress?: string
    }
  /**
   * Plan 123 §3.4, §4.4: once per START, per record, not per connection — the
   * first connection after start whose observed `egressAddress` disagrees
   * with the record's own configured `bindAddress`. `conn` names which
   * connection first revealed it; the fact itself is about the record, not
   * about that one connection, which is why it fires only once regardless of
   * how many more connections follow.
   */
  | { event: 'bind-mismatch'; conn: number; bindAddress: string; egressAddress: string }

/** What can happen to one proxy, as opposed to one connection through it. */
export type LifecycleEvent =
  | { event: 'start' }
  | { event: 'listening'; port: number; listen: string; upstreamProto: string; upstreamHost: string; upstreamPort: number }
  /** The record may not run at all: a refusal or a precondition from `validateProxyRecord`, before a socket is opened. */
  | { event: 'start-refused'; code: string; message: string }
  /** The bind, or the upstream construction, threw. `E_PROXY_LISTEN_ADDR_IN_USE` is the one everybody hits. */
  | { event: 'start-failed'; code: string; message: string; port: number | null }
  | { event: 'drain'; live: number; drainMs: number }
  | { event: 'stop'; forced: boolean; port: number | null }
  | { event: 'restart' }
  | { event: 'teardown'; port: number | null }

/** Everything that is about ONE proxy, and is therefore tagged with its subject. */
export type ProxyEvent = BridgeEvent | LifecycleEvent

/** Everything that is about the supervisor as a whole, and is therefore deliberately untagged. */
export type ServiceEvent = { event: 'service-started'; catalogue: number; started: number } | { event: 'service-stopped'; destroyed: number }

/** A proxy's own logger: one call per event, with the filtering already decided. */
export type BridgeLogger = (event: ProxyEvent) => void

/**
 * What a LISTENER is given — the connection half only.
 *
 * Narrower than `BridgeLogger` on purpose: a listener has no lifecycle to
 * report (it does not know it is being restarted, and the supervisor is the one
 * that does), and a type that let it emit `stop` would be an invitation to a
 * second place that decides a proxy's state. A `BridgeLogger` still satisfies
 * it, which is how the supervisor hands its own logger down.
 */
export type ConnectionLogger = (event: BridgeEvent) => void

/**
 * The fields a line may carry, given this record's `logDestinations` setting.
 *
 * Exported and pure so the negative tests can assert on the OBJECT rather than
 * on a formatted string — a test that greps a rendered line proves the
 * formatter, and a formatter is not what decides what is recorded.
 *
 * `subject` is in the bag rather than beside it because that is the farm's own
 * interface: the core lifts `fields.subject` onto the line and removes it from
 * the bag, so a line is tagged by writing an ordinary field (plan 109 step
 * 109.8). It is **not** duplicated as a separate `proxy` field — the core's own
 * comment for lifting it is that leaving it in both places renders it twice.
 */
export function bridgeLogFields(event: ProxyEvent, opts: { proxyId: string; logDestinations: boolean }): Record<string, unknown> {
  const base: Record<string, unknown> = { subject: proxySubject(opts.proxyId) }
  switch (event.event) {
    case 'accepted':
      return { ...base, conn: event.conn }
    case 'upstream-connected':
      // The port always; the host only when the operator asked for it. The
      // egress address always — it is this HOST's own address, not a
      // destination (plan 123 §3.4, §4.4).
      return {
        ...base,
        conn: event.conn,
        destPort: event.destPort,
        egressAddress: event.egressAddress,
        ...(opts.logDestinations ? { destHost: event.destHost } : {}),
      }
    case 'closed':
      return { ...base, conn: event.conn, durationMs: event.durationMs, bytesUp: event.bytesUp, bytesDown: event.bytesDown }
    case 'refused':
      return {
        ...base,
        conn: event.conn,
        reason: event.reason,
        ...(event.code ? { code: event.code } : {}),
        ...(event.destPort === undefined ? {} : { destPort: event.destPort }),
        ...(opts.logDestinations && event.destHost !== undefined ? { destHost: event.destHost } : {}),
        ...(event.clientAddress === undefined ? {} : { clientAddress: event.clientAddress }),
      }
    case 'bind-mismatch':
      return { ...base, conn: event.conn, bindAddress: event.bindAddress, egressAddress: event.egressAddress }
    case 'start':
    case 'restart':
      return base
    case 'listening':
      // The upstream's own address, which the catalogue already shows. Never
      // its username (§9 Q1 is undecided) and never its password.
      return { ...base, port: event.port, listen: event.listen, upstreamProto: event.upstreamProto, upstreamHost: event.upstreamHost, upstreamPort: event.upstreamPort }
    case 'start-refused':
      return { ...base, code: event.code, message: event.message }
    case 'start-failed':
      return { ...base, code: event.code, message: event.message, ...(event.port === null ? {} : { port: event.port }) }
    case 'drain':
      return { ...base, live: event.live, drainMs: event.drainMs }
    case 'stop':
      return { ...base, forced: event.forced, ...(event.port === null ? {} : { port: event.port }) }
    case 'teardown':
      return { ...base, ...(event.port === null ? {} : { port: event.port }) }
  }
}

/** The one-line message for an event. Deliberately free of any value — every value is a field. */
export function bridgeLogMessage(event: ProxyEvent): string {
  switch (event.event) {
    case 'accepted':
      return 'proxy accepted a connection'
    case 'upstream-connected':
      return 'proxy connected to its upstream'
    case 'closed':
      return 'proxy connection closed'
    case 'refused':
      return 'proxy refused a connection'
    case 'bind-mismatch':
      // Names the fact once, per start, per record — the sentence a person
      // greps for instead of a packet capture (plan 123 §0.4, §3.4).
      return 'proxy egress address does not match its configured bind address'
    case 'start':
      return 'proxy is starting'
    case 'listening':
      return 'proxy is listening'
    case 'start-refused':
      return 'proxy cannot start with this record'
    case 'start-failed':
      // The one failure that deserves its own sentence, because the fix is
      // specific and an operator reading a generic line would go looking for a
      // bug in the proxy instead of for whatever holds the port.
      return event.code === 'E_PROXY_LISTEN_ADDR_IN_USE' ? 'proxy could not bind: that port is already in use' : 'proxy failed to start'
    case 'drain':
      return 'proxy stopped accepting and is draining its live connections'
    case 'stop':
      return event.forced ? 'proxy force-stopped, without draining' : 'proxy stopped'
    case 'restart':
      return 'proxy is restarting'
    case 'teardown':
      return 'proxy destroyed because the plugin is stopping — no drain, the disposer budget is 5 s in total'
  }
}

/** The level for an event, in one place, so the rule below can be read rather than reconstructed. */
export function bridgeLogLevel(event: ProxyEvent): 'debug' | 'info' | 'warn' | 'error' {
  switch (event.event) {
    // A proxy carrying real traffic produces two lines per connection, and an
    // `info` default would drown the plugin's own runtime log — and the ring is
    // shared with every other proxy — in a farm that is doing its job.
    case 'accepted':
    case 'upstream-connected':
    case 'closed':
      return 'debug'
    case 'refused':
    case 'start-refused':
    case 'bind-mismatch':
      return 'warn'
    case 'start-failed':
      return 'error'
    default:
      // Lifecycle. One line per operator action, which is what somebody
      // reading "why did this stop" is actually looking for.
      return 'info'
  }
}

/** A `BridgeLogger` that writes to a sink. */
export function createBridgeLogger(sink: LogSink, opts: { proxyId: string; logDestinations: boolean }): BridgeLogger {
  return (event) => {
    sink[bridgeLogLevel(event)](bridgeLogMessage(event), bridgeLogFields(event, opts))
  }
}

/**
 * The supervisor's own two lines, deliberately **untagged**.
 *
 * They belong to no single proxy, so they carry no `subject` — which means they
 * appear in the unfiltered "all" view and in none of the per-proxy ones. That
 * is the correct answer rather than a gap: a line saying "eleven records, three
 * started" is not a fact about any one of the eleven.
 */
export function logServiceEvent(sink: LogSink, event: ServiceEvent): void {
  if (event.event === 'service-started') {
    sink.info('proxy supervisor started the records that asked to be running', { catalogue: event.catalogue, started: event.started })
    return
  }
  sink.info('proxy supervisor destroyed every bridge it held', { destroyed: event.destroyed })
}
