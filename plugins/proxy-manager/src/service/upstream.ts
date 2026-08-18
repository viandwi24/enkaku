import type { BridgeSocket } from './socket'
import type { ProxyKind, ProxyRecord } from '../shared'
import { createDirectUpstream } from './dial-direct'
import { createHttpUpstream } from './dial-http'
import { createSocks5Upstream } from './dial-socks5'
import { ProxyError } from './errors'

/**
 * What the listeners see of "the thing on the other side" (plan 112 §4.4).
 *
 * One interface, three implementations as of plan 117, and the split is where
 * the plugin's own behaviour actually lives (§3.2): the fiddly part worth a
 * dependency is the SOCKS5 handshake — greeting, method negotiation, RFC 1929
 * username/password sub-negotiation, three address types, reply codes — which
 * `socks` does. The HTTP upstream is `CONNECT host:port` plus one status
 * line, and a second dependency for that would be worse than the twenty lines
 * it costs. The `direct` upstream (plan 117 §3.1) needs no dependency at all
 * — it is `net.connect({ localAddress })` and, optionally, a bound
 * `node:dns/promises` resolver — because it dials no remote proxy and has no
 * handshake of its own to speak.
 */

export interface UpstreamTarget {
  host: string
  port: number
}

export interface Upstream {
  /**
   * How this upstream is described to a person — **never a credential**. The
   * username is included because the catalogue already shows it (§3.6, §9 Q1);
   * the password is not, anywhere, ever.
   */
  readonly description: string
  /**
   * Resolves to a connected socket already tunnelled to `dest`. Rejects with a
   * `ProxyError`.
   *
   * **The socket may come back PAUSED, with bytes already buffered on it**, and
   * a caller has to know that. An upstream can pack the tunnel's first bytes
   * into the same TCP segment as its handshake reply; those bytes are pushed
   * back with `unshift`, which requires the stream to be paused first or they
   * are re-emitted to nobody and lost. `pipe()` resumes a paused stream, so
   * `createRelay` — the only caller in this pack — is unaffected. Attaching a
   * bare `on('data')` is **not** enough: after an explicit `pause()`, adding a
   * listener does not resume. *(measured; the test that proves it calls
   * `resume()` and says why.)*
   */
  connect(dest: UpstreamTarget): Promise<BridgeSocket>
}

/**
 * The default per-connection deadline for reaching an upstream.
 *
 * `socks`'s own `DEFAULT_TIMEOUT` is 30 000 ms, which is a very long time to
 * hold a browser tab or an app on a phone. Plan 112 H3 measured what each
 * failure actually costs — the numbers are in plan 112 §0.3 — and 10 s is the
 * value chosen from them: long enough for a real residential upstream on a bad
 * link, short enough that a dead one is reported rather than endured.
 */
export const DEFAULT_DIAL_TIMEOUT_MS = 10_000

/**
 * How long a tunnel may carry no bytes at all before it is torn down.
 *
 * **This is the timer H3 exists to decide, and the answer was yes** (plan 112
 * §0.3): `socks`'s timeout covers the handshake only, so an upstream that
 * completes the handshake and then black-holes everything leaves the client
 * hanging until its own timeout — which for a bare TCP client is never. The
 * relay's idle timer is the only thing between that upstream and a socket that
 * lives forever.
 *
 * Ten minutes, not ten seconds: this is a **stuck** detector, not an activity
 * one. A CONNECT tunnel carrying a long-poll or an idle SSH session is
 * legitimately silent for minutes, and killing it would be a bug that only
 * appears in production.
 */
export const DEFAULT_IDLE_MS = 600_000

/**
 * Build the upstream a record names.
 *
 * `https` never reaches here: `validateProxyRecord` refuses it at write and
 * again at start, by name, before a socket is opened (§3.4). The throw below
 * is the belt to that braces — a record that arrived through some path neither
 * check covers fails loudly rather than dialling something unexpected.
 *
 * `direct` (plan 117 §3.1) is handed `bindAddress` and `resolveThroughEgress`
 * instead of `common` — it names no remote host, port, username or password,
 * so building it from the same object the other two share would carry three
 * fields it ignores and hide the one it actually needs.
 */
export function createUpstream(record: ProxyRecord, password: string, opts: { timeoutMs?: number } = {}): Upstream {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_DIAL_TIMEOUT_MS
  const common = { host: record.upstream.host, port: record.upstream.port, username: record.upstream.username, password, timeoutMs }
  const proto: ProxyKind = record.upstream.proto
  if (proto === 'socks5') return createSocks5Upstream(common)
  if (proto === 'http') return createHttpUpstream(common)
  if (proto === 'direct') return createDirectUpstream({ bindAddress: record.upstream.bindAddress, resolveThroughEgress: record.upstream.resolveThroughEgress, timeoutMs })
  throw new ProxyError(
    'E_PROXY_UPSTREAM_PROTOCOL',
    `upstream protocol "${proto}" is not implemented — validateProxyRecord refuses it at write and at start, so reaching this line means a record got past both`,
  )
}

/** The one place an upstream is described for a person, so no caller can invent a variant that includes the password. */
export function describeUpstream(scheme: string, host: string, port: number, username: string): string {
  return `${scheme}://${username ? `${username}@` : ''}${host}:${port}`
}

/**
 * The `direct` upstream's own description (plan 117 §4.3 point 3, moved to
 * `shared.ts` at step 117.9 so the browser half can read the same words —
 * see that file's own comment on `describeDirectUpstream`). Re-exported here
 * so `service/dial-direct.ts`'s existing `from './upstream'` import keeps
 * working unchanged.
 */
export { describeDirectUpstream } from '../shared'
