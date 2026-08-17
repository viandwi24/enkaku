import type { BridgeSocket } from './socket'
import { SocksClient } from 'socks'
import { ProxyError, classifyDialError } from './errors'
import { describeUpstream, type Upstream, type UpstreamTarget } from './upstream'

/**
 * The SOCKS5 upstream dial — the one part of this feature worth a dependency
 * (plan 112 §3.2).
 *
 * `socks` is MIT, pure JavaScript, and pulls in two small pure-JS packages
 * (`ip-address`, `smart-buffer`). It is bundled into the pack by
 * `enkaku publish`, which passes no `external` at all, and Bun leaves the
 * `node:*` builtins it imports as live imports resolved by whichever runtime
 * loads the bundle — the core's own process, for a service (F1, F4, F6). Step
 * 112.1 published one and watched it verify and activate rather than trusting
 * that reading; the measured bundle size is in plan 112 §0.2.
 *
 * ## Two things about `socks` that matter here
 *
 * 1. **Its timeout covers the handshake only.** `DEFAULT_TIMEOUT` is 30 000 ms
 *    and it is armed until the SOCKS reply arrives. An upstream that completes
 *    the handshake and then black-holes everything is invisible to it — see
 *    `DEFAULT_IDLE_MS` in `upstream.ts` and plan 112 H3.
 * 2. **A `SocksClientError` carries the whole proxy configuration on
 *    `.options`, password included.** So the error is never re-thrown and
 *    never serialised; `classifyDialError` reads `.message` and nothing else,
 *    and scrubs it. `index.test.ts` and `dial-socks5.test.ts` assert the
 *    literal password is absent from every thrown message, with the two
 *    controls plan 109 step 109.5 requires of an absence claim.
 */

export interface Socks5UpstreamOptions {
  host: string
  port: number
  /** Empty means "this upstream needs no account" — no RFC 1929 sub-negotiation is offered. */
  username: string
  password: string
  timeoutMs: number
}

export function createSocks5Upstream(opts: Socks5UpstreamOptions): Upstream {
  // Read once, here, and never again from a mutable source: the value the
  // scrubber is given must be the value that was actually sent.
  const secrets = [opts.password].filter((s) => s.length > 0)

  return {
    description: describeUpstream('socks5', opts.host, opts.port, opts.username),

    async connect(dest: UpstreamTarget): Promise<BridgeSocket> {
      if (!opts.host || opts.port < 1) {
        throw new ProxyError('E_PROXY_UPSTREAM_DIAL', 'this record names no upstream host and port')
      }
      try {
        const info = await SocksClient.createConnection({
          proxy: {
            host: opts.host,
            port: opts.port,
            type: 5,
            // Both or neither. `socks` offers RFC 1929 only when `userId` is
            // present, and an upstream that wants no auth is refused by one
            // that is offered it under some implementations — so an empty
            // username means an empty method list, not an empty password.
            ...(opts.username ? { userId: opts.username, password: opts.password } : {}),
          },
          command: 'connect',
          destination: { host: dest.host, port: dest.port },
          timeout: opts.timeoutMs,
        })
        return info.socket
      } catch (err) {
        throw classifyDialError(err, secrets)
      }
    },
  }
}
