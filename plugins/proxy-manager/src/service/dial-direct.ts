import net from 'node:net'
import { Resolver } from 'node:dns/promises'
import type { BridgeSocket } from './socket'
import { ProxyError, classifyDialError, messageOf } from './errors'
import { describeDirectUpstream, type Upstream, type UpstreamTarget } from './upstream'

/**
 * The `direct` upstream dial — plan 117 §3.1, §3.4, §4.3. Not a proxy at all:
 * `connect()` opens a TCP socket straight to `dest`, optionally bound to one
 * of this host's own addresses (`net.connect`'s own `localAddress`, and
 * nothing more — what that address means physically is the operator's
 * business, never this pack's).
 *
 * ## Why the resolver is here too, and not left to `net.connect`
 *
 * `net.connect({ host, localAddress })` resolves `host` **before** binding
 * the socket, through whatever resolver Node's own `dns.lookup` reaches for —
 * the host's default one, unconditionally. On a dual-homed machine that means
 * the LOOKUP leaves through one link while the CONNECTION it is for leaves
 * through another, and nothing about that mismatch is visible anywhere (plan
 * 117 §3.4, and the operational evidence in plan 117 §0.4 finding #6). So
 * when `resolveThroughEgress` is on and a `bindAddress` is set, this file
 * resolves the destination itself, with a `node:dns/promises` `Resolver`
 * bound to the same address the connection will use, and only THEN calls
 * `net.connect` with the literal address that came back.
 *
 * **The callback-style `node:dns` `Resolver` is not used, on purpose.**
 * Measured while writing this file (plan 117 §0.3): it refuses a
 * promise-less call outright (`The "callback" argument must be of type
 * function`). `node:dns/promises`'s `Resolver` is the one that actually
 * works here, and the same section measured that `setLocalAddress` is a real
 * bind under Bun rather than a stub — an address this host does not own
 * fails the query with `ECONNREFUSED` rather than silently succeeding.
 */

export interface DirectUpstreamOptions {
  /** Empty means "dial out however this host normally would" — no bind, no bound resolver, whatever `net.connect` and Node's own resolver would otherwise do. */
  bindAddress: string
  /** Meaningless with an empty `bindAddress`; `createUpstream` never turns this off on its own. */
  resolveThroughEgress: boolean
  timeoutMs: number
}

/**
 * A destination hostname → the literal address to dial, resolved through a
 * `Resolver` bound to `bindAddress` (plan 117 §3.4, §4.3).
 *
 * **Family matching (§4.3 detail 1).** An IPv4 `bindAddress` asked to resolve
 * a name that only has AAAA records — or the reverse — fails at `net.connect`
 * with a confusing "address family mismatch" rather than a DNS error, because
 * the literal it would be handed does not match the family it is bound in.
 * So the family of `bindAddress` decides `resolve4` versus `resolve6` here,
 * rather than asking for whichever record type happens to exist.
 *
 * **No fallback lookup, ever (§3.4 rule 1, criterion 4).** A failure here
 * throws `E_PROXY_DNS_EGRESS_FAILED` and stops — it does not then try
 * `dns.lookup` or any other path through the host's default resolver. A
 * silent fallback is the precise defect `resolveThroughEgress` exists to
 * remove: a name that quietly resolves through the wrong link is worse than
 * one that visibly fails to resolve at all. There is exactly one `return` in
 * this function's success path and exactly one `throw` in its failure path,
 * so a future edit that wants to "just try the normal resolver too" has to
 * add a whole new branch rather than slot one more line into an existing one.
 */
async function resolveThroughBind(hostname: string, bindAddress: string, timeoutMs: number): Promise<string> {
  const family = net.isIP(bindAddress)
  if (family === 0) {
    // Unreachable in practice: `validateProxyRecord` refuses a `bindAddress`
    // that is not an IPv4/IPv6 literal (`E_PROXY_BIND_ADDRESS_INVALID`) at
    // write and at start, before a record can ever be started. Kept as a
    // loud failure rather than a silent choice of family, on the same
    // "belt to that braces" reasoning `createUpstream`'s own throw uses.
    throw new ProxyError('E_PROXY_DNS_EGRESS_FAILED', `"${bindAddress}" is not an IPv4 or IPv6 literal, so DNS cannot be resolved through it`)
  }

  const resolver = new Resolver({ timeout: timeoutMs, tries: 1 })
  resolver.setLocalAddress(bindAddress)

  try {
    const addresses = family === 4 ? await resolver.resolve4(hostname) : await resolver.resolve6(hostname)
    const first = addresses[0]
    if (first === undefined) throw new Error('the resolver returned no addresses')
    return first
  } catch (err) {
    throw new ProxyError(
      'E_PROXY_DNS_EGRESS_FAILED',
      `resolving "${hostname}" through the resolver bound to ${bindAddress} failed: ${messageOf(err)} — this is not retried through the host's default resolver`,
    )
  }
}

export function createDirectUpstream(opts: DirectUpstreamOptions): Upstream {
  return {
    // Never a credential: a `direct` upstream has none to omit in the first
    // place. `describeDirectUpstream` also says which of the two DNS modes
    // the record is in (plan 117 §3.4, step 117.3), the same way this
    // string already says which host/port/username an upstream proxy uses.
    description: describeDirectUpstream(opts.bindAddress, opts.resolveThroughEgress),

    async connect(dest: UpstreamTarget): Promise<BridgeSocket> {
      // §4.3 detail 2: a destination that is already a literal is not
      // resolved at all — `net.isIP()` short-circuits it, whether or not
      // `resolveThroughEgress` is on. Resolving a literal would be a no-op
      // at best; asking a `Resolver` to "resolve" something that is not a
      // name is not a case any of the three record types here need.
      const shouldResolve = opts.resolveThroughEgress && opts.bindAddress.length > 0 && net.isIP(dest.host) === 0
      const host = shouldResolve ? await resolveThroughBind(dest.host, opts.bindAddress, opts.timeoutMs) : dest.host

      return new Promise<BridgeSocket>((resolve, reject) => {
        let settled = false
        const socket = net.connect({ host, port: dest.port, localAddress: opts.bindAddress || undefined })

        const timer = setTimeout(() => {
          fail(new ProxyError('E_PROXY_UPSTREAM_TIMEOUT', `dialling ${dest.host}:${dest.port} directly did not connect within ${opts.timeoutMs} ms`))
        }, opts.timeoutMs)

        function cleanup(): void {
          clearTimeout(timer)
          socket.removeListener('connect', onConnect)
          socket.removeListener('error', onError)
        }

        function fail(err: unknown): void {
          if (settled) return
          settled = true
          cleanup()
          socket.destroy()
          // A `direct` upstream carries no password to scrub — the empty
          // list is deliberate, not an oversight, and matches `errors.ts`'s
          // own rule that a secret shorter than eight characters (here:
          // none at all) is never substring-replaced.
          reject(err instanceof ProxyError ? err : classifyDialError(err, []))
        }

        function onConnect(): void {
          if (settled) return
          settled = true
          cleanup()
          resolve(socket)
        }

        function onError(err: unknown): void {
          fail(err)
        }

        socket.on('connect', onConnect)
        socket.on('error', onError)
      })
    },
  }
}
