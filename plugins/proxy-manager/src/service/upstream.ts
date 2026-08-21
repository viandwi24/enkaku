import type { BridgeSocket } from './socket'
import type { ProxyKind, ProxyRecord } from '../shared'
import { bindIsEffective } from './bind-probe'
import { createDirectUpstream } from './dial-direct'
import { createHttpUpstream } from './dial-http'
import { createSocks5Upstream } from './dial-socks5'
import { ProxyError } from './errors'
import { createGostRuntime, type GostRuntime, type GostRuntimeHost } from './gost-runtime'

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
 * One process for the whole plugin, created on the first `direct` record
 * that ever needs the `gost` workaround — never for a record whose bind
 * works natively. Module-level rather than threaded through every caller: it
 * is genuinely one shared resource (one `gost` process backing every such
 * `direct` record at once, `gost-runtime.ts`'s own header explains why), the
 * same shape `DEFAULT_DIAL_TIMEOUT_MS` above is a module constant rather
 * than a parameter everyone repeats.
 */
let gostRuntime: GostRuntime | null = null

/** Exposed for `supervisor.ts`'s `onStop` — the plugin's own teardown is the only caller with a reason to kill it. `null` when nothing on this host ever needed the `gost` workaround. */
export function currentGostRuntime(): GostRuntime | null {
  return gostRuntime
}

/**
 * Test-only seam (plan 123 step 123.2). Clears the module-level `gostRuntime`
 * singleton so the next `createUpstream()` call that needs it builds a fresh
 * one — the same "resettable cache" shape `bind-probe.ts`'s own
 * `resetBindProbeCacheForTests` already established, needed here because
 * `upstream.test.ts` swaps in a fake `buildGostRuntime` per test and must not
 * let one test's fake leak into the next through this shared variable.
 */
export function resetGostRuntimeForTests(): void {
  gostRuntime = null
}

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
 *
 * ## The bind gate (plan 123 §4.2) — measured, never guessed from `process.platform`
 *
 * `net.connect({ localAddress })` is silently a no-op on this Bun build on
 * every platform actually tested (plan 123 §0.2), not only Windows — the
 * assumption plan 117 §12 originally made and this rewrite corrects. The
 * choice between the plain socket (`dial-direct.ts`, untouched — correct on
 * every platform where the option IS honoured) and the local `gost` hop
 * (`gost-runtime.ts`, untouched — the workaround itself was always correct)
 * is made by `bindIsEffective()` (`./bind-probe.ts`), an actual probe of
 * THIS runtime, cached for the process — never by naming a platform:
 *
 * - empty `bindAddress`           → plain `dial-direct.ts`; nothing to bind, the probe is not even run (row 1)
 * - bind works                    → plain `dial-direct.ts`, now MEASURED rather than assumed (row 2)
 * - bind broken, `gost` reachable → the SAME `gost` hop plan 117 built, unchanged, on ANY platform (row 3)
 * - bind broken, no `gost`        → `E_PROXY_BIND_INEFFECTIVE` (row 4 — thrown HERE; converted into a
 *   `PROXY_PROBLEM_CODES` precondition by `service/supervisor.ts`'s `startLocked`, per plan 123 §4.3 —
 *   see that branch's own comment below and `startLocked`'s own for the two halves of the handoff)
 *
 * `gost` provisioning (`gost-provision.ts`) remains Windows-only BY
 * CONSTRUCTION — this file does not widen it (plan 123 §9 Q4 names that as
 * separate, undecided work). What changed is WHERE that constraint is
 * discovered: not guessed ahead of time here by naming `win32`, but hit for
 * real, on whichever platform actually attempts the workaround, the moment
 * it is attempted — `ensureGostBinary`'s own refusal
 * (`E_PROXY_GOST_UNSUPPORTED_PLATFORM`) is now the only place a platform name
 * still matters on this path.
 */
export async function createUpstream(
  record: ProxyRecord,
  password: string,
  opts: {
    timeoutMs?: number
    log?: GostRuntimeHost['log']
    /**
     * Test-only seam (plan 123 step 123.2). Real callers never set this —
     * production always measures with the real, process-cached
     * `bindIsEffective()` from `./bind-probe.ts`. A seam is needed here, on
     * top of what `bind-probe.ts` already offers, because that real probe
     * cannot be made to report "the bind works" on a runtime where it
     * genuinely does not — `bind-probe.test.ts`'s own header explains why:
     * forcing the "honoured" branch would need a runtime that actually calls
     * `bind()` for `localAddress`, which is precisely the thing under test.
     */
    checkBindEffective?: () => Promise<boolean>
    /**
     * Test-only seam (plan 123 step 123.2). Real callers never set this —
     * production always builds the real, Windows-only-by-construction `gost`
     * runtime (`./gost-runtime.ts`, untouched). Exists so a test can prove
     * the ROUTING decision in this function no longer consults
     * `process.platform` at all: with this swapped for a fake that succeeds,
     * the gost hop is reachable no matter what `process.platform` reads as,
     * because nothing here asks any more — see `upstream.test.ts`'s
     * criterion-2 test, the one this whole plan exists for.
     */
    buildGostRuntime?: (host: GostRuntimeHost) => GostRuntime
  } = {},
): Promise<Upstream> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_DIAL_TIMEOUT_MS
  const common = { host: record.upstream.host, port: record.upstream.port, username: record.upstream.username, password, timeoutMs }
  const proto: ProxyKind = record.upstream.proto
  if (proto === 'socks5') return createSocks5Upstream(common)
  if (proto === 'http') return createHttpUpstream(common)
  if (proto === 'direct') {
    const { bindAddress, resolveThroughEgress } = record.upstream
    if (bindAddress.length === 0) {
      // Row 1: nothing to bind, so the option this whole gate exists to
      // check is never even passed — the probe is skipped entirely, not
      // just answered trivially. Must not regress: this is the common case.
      return createDirectUpstream({ bindAddress, resolveThroughEgress, timeoutMs })
    }

    const checkBindEffective = opts.checkBindEffective ?? bindIsEffective
    const effective = await checkBindEffective()
    if (effective) {
      // Row 2: as today, but MEASURED rather than assumed from `process.platform`.
      return createDirectUpstream({ bindAddress, resolveThroughEgress, timeoutMs })
    }

    // The bind is silently ignored on this runtime. `gost` remains the ONLY
    // workaround this pack has — attempted here unconditionally, on any
    // platform, exactly as plan 117 built it (the four lines below are that
    // same branch, untouched in what they do; only the condition that reaches
    // them has changed).
    if (!opts.log) {
      throw new ProxyError('E_PROXY_GOST_UNAVAILABLE', 'a `direct` record with a bind address needs the local gost helper on Windows, and no logger was supplied to start it — this is a caller bug in this pack, not a record problem')
    }
    const buildGostRuntime = opts.buildGostRuntime ?? createGostRuntime
    try {
      if (!gostRuntime) gostRuntime = buildGostRuntime({ log: opts.log })
      const port = await gostRuntime.ensurePort(bindAddress)
      return createHttpUpstream({ host: '127.0.0.1', port, username: '', password: '', timeoutMs })
    } catch (err) {
      // Row 4, and ONLY row 4: `ensureGostBinary` (`gost-provision.ts`,
      // untouched) is the one thing left that still refuses by platform name
      // — reaching that refusal for real IS "no gost available" on this
      // host, honestly checked by attempting it rather than guessed ahead of
      // time. Anything else `gost` can throw (a genuine provisioning or
      // startup failure, e.g. on a Windows host that IS supported) is left
      // to propagate as its own code, unconverted — that is a real `gost`
      // failure, not the "no workaround here" case this branch exists for,
      // and turning it into `E_PROXY_BIND_INEFFECTIVE` would hide an
      // actionable Windows-specific message behind the wrong diagnosis.
      if (err instanceof ProxyError && err.code === 'E_PROXY_GOST_UNSUPPORTED_PLATFORM') {
        // Step 123.3 — this is where the two facts row 4 needs (bind broken,
        // no `gost` reachable) become available at once, so the code is
        // thrown here rather than guessed anywhere earlier. It is still a
        // plain thrown `ProxyError` at THIS call site — `createUpstream` has
        // no way to stop a record reaching `starting`, only `startLocked`
        // does — but `service/supervisor.ts`'s `startLocked` catches this
        // exact code specially and re-runs `validateProxyRecord` with
        // `bindWorkaroundUnavailable: true`, so the record is refused
        // through the SAME `PROXY_PROBLEM_CODES`/precondition path every
        // other `E_PROXY_*` problem in `shared.ts` uses (`start-refused`, not
        // `start-failed`) rather than the generic dial-failure catch. The
        // message here is only ever seen if some OTHER caller of
        // `createUpstream` reaches this branch without that conversion
        // (`probeEntry`'s sweep, a fallback slot's `buildUpstream`) — kept
        // accurate on its own rather than assuming it is always replaced.
        throw new ProxyError(
          'E_PROXY_BIND_INEFFECTIVE',
          `this host holds "${bindAddress}", but this runtime silently ignores the bind when dialling out, and no local gost workaround is available on ${process.platform} — run a local SOCKS5/HTTP binder that IS known to honour the bind (for example gost or 3proxy) and point this record's upstream at it instead of "direct" (see plan 123 §6), or wait for a runtime upgrade`,
        )
      }
      throw err
    }
  }
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
