/**
 * The log line vocabulary — what a bridge records, and the deliberate list of
 * what it does not (plan 112 §3.8).
 *
 * **A proxy that logs every request URL is a surveillance record of whatever
 * it carries.** The operator is also the person who owns the traffic, so this
 * is not a privacy problem in the usual sense; it is a *default* problem. A
 * log that quietly accumulates a browsing history of every device on the farm,
 * in a rotated file on disk, is not something an operator should have to
 * discover.
 *
 * So at the default level a line records:
 *
 * - the proxy id and a monotonic connection number
 * - the event: `accepted`, `upstream-connected`, `closed`, `refused`
 * - for `closed`: duration, bytes up, bytes down
 * - for `refused`: the reason, and the **destination port**
 * - **never** a host, a path, a query string, a header, a byte of payload, or
 *   the upstream password
 *
 * A destination **port** is not a browsing record — it distinguishes "TLS to
 * something" from "plain HTTP to something", and without it a refusal is
 * nearly undebuggable. A destination **host** is a browsing record, and it is
 * recorded only when the record's own `logDestinations` switch is on.
 *
 * ## What this file is NOT, yet
 *
 * It is the vocabulary, not the stream. Plan 112 step 112.8 — gated on plan
 * 109 step 109.8, which does not exist — is what adds the bounded ring, the
 * rotated file, the `plugin.log` broadcast, the honest `truncated` flag and
 * the per-proxy filter. Until then a line goes to `ctx.log` and no further,
 * and **`ctx.log` has no redaction wired** (plan 112 F15): `runtime-logs.ts`
 * does not exist and `plugin-context.ts` defaults `emitLog` to the plain core
 * logger. That is exactly why the password is kept out of a line **by
 * construction** here — it is never passed to a log call at all — rather than
 * by relying on a redactor that is not running.
 */

/** Where a line goes. Deliberately the smallest surface `ScriptLogger` satisfies, so a test can pass a recorder. */
export interface LogSink {
  debug(message: string, fields?: Record<string, unknown>): void
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
  error(message: string, fields?: Record<string, unknown>): void
}

/** The four things that can happen to one connection, and the only four. */
export type BridgeEvent =
  | { event: 'accepted'; conn: number }
  | { event: 'upstream-connected'; conn: number; destPort: number; destHost: string }
  | { event: 'closed'; conn: number; durationMs: number; bytesUp: number; bytesDown: number }
  | { event: 'refused'; conn: number; reason: string; code?: string; destPort?: number; destHost?: string }

/** A bridge's own logger: one call per event, with the filtering already decided. */
export type BridgeLogger = (event: BridgeEvent) => void

/**
 * The fields a line may carry, given this record's `logDestinations` setting.
 *
 * Exported and pure so the negative tests can assert on the OBJECT rather than
 * on a formatted string — a test that greps a rendered line proves the
 * formatter, and a formatter is not what decides what is recorded.
 */
export function bridgeLogFields(event: BridgeEvent, opts: { proxyId: string; logDestinations: boolean }): Record<string, unknown> {
  const base: Record<string, unknown> = { proxy: opts.proxyId, conn: event.conn }
  switch (event.event) {
    case 'accepted':
      return base
    case 'upstream-connected':
      // The port always; the host only when the operator asked for it.
      return { ...base, destPort: event.destPort, ...(opts.logDestinations ? { destHost: event.destHost } : {}) }
    case 'closed':
      return { ...base, durationMs: event.durationMs, bytesUp: event.bytesUp, bytesDown: event.bytesDown }
    case 'refused':
      return {
        ...base,
        reason: event.reason,
        ...(event.code ? { code: event.code } : {}),
        ...(event.destPort === undefined ? {} : { destPort: event.destPort }),
        ...(opts.logDestinations && event.destHost !== undefined ? { destHost: event.destHost } : {}),
      }
  }
}

/** The one-line message for an event. Deliberately free of any value — every value is a field. */
export function bridgeLogMessage(event: BridgeEvent): string {
  switch (event.event) {
    case 'accepted':
      return 'proxy accepted a connection'
    case 'upstream-connected':
      return 'proxy connected to its upstream'
    case 'closed':
      return 'proxy connection closed'
    case 'refused':
      return 'proxy refused a connection'
  }
}

/**
 * A `BridgeLogger` that writes to a sink.
 *
 * `refused` is a `warn` and everything else is `debug`, with one exception:
 * `closed` is `debug` too. A proxy carrying real traffic produces two lines
 * per connection, and an `info` default would drown the plugin's own runtime
 * log in a farm that is doing its job. A refusal is the line somebody is
 * actually looking for.
 */
export function createBridgeLogger(sink: LogSink, opts: { proxyId: string; logDestinations: boolean }): BridgeLogger {
  return (event) => {
    const fields = bridgeLogFields(event, opts)
    const message = bridgeLogMessage(event)
    if (event.event === 'refused') sink.warn(message, fields)
    else sink.debug(message, fields)
  }
}
