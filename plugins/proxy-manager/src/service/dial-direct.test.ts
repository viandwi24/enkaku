import { describe, expect, test } from 'bun:test'
import net from 'node:net'
import { lookup } from 'node:dns/promises'
import { createDirectUpstream } from './dial-direct'
import { describeDirectUpstream } from '../shared'

/**
 * Plan 117 step 117.11 — the `direct` upstream (§3.1, §3.4, §4.3): the
 * literal short-circuit, the connect timeout, the family plumbing, and
 * criterion 4's no-fallback assertion.
 *
 * **Why `192.0.2.1` (not loopback) proves the no-fallback rule without any
 * special host configuration.** An earlier version of this file bound the
 * resolver to `127.0.0.1`, on the assumption that a socket bound to loopback
 * "cannot reach anything off this machine". That held on the machine it was
 * written on and **failed on CI** (a Linux runner whose own DNS resolution
 * terminates on loopback — `systemd-resolved`'s stub listener — so a
 * resolver bound to `127.0.0.1` asking `127.0.0.53` for `example.com` is a
 * loopback-to-loopback query that genuinely succeeds there). `192.0.2.1` is
 * `TEST-NET-1` (RFC 5737) — an address block reserved for documentation and
 * therefore never assigned to any real interface, on any machine. Binding a
 * socket's LOCAL source to an address the host does not own fails at the
 * kernel's own `bind()`, unconditionally (`EADDRNOTAVAIL`/`ECONNREFUSED`
 * depending on platform, never a timeout, never a route decision that could
 * vary with what else happens to be listening on loopback) — measured
 * originally in plan 117 §0.3, and it is what this file now relies on: if
 * `dial-direct.ts` ever fell back to the host's own unbound resolver,
 * resolving a real hostname like `example.com` would very likely SUCCEED on
 * a machine with ordinary internet access, and this test would then observe
 * a connected socket instead of a thrown `E_PROXY_DNS_EGRESS_FAILED`. It
 * does not.
 */

function listen(server: net.Server, host: string): Promise<number> {
  return new Promise<number>((resolve) => {
    server.listen(0, host, () => {
      const address = server.address()
      resolve(typeof address === 'object' && address !== null ? address.port : 0)
    })
  })
}

describe('the literal short-circuit (§4.3 detail 2) — net.isIP() decides, not the resolver', () => {
  test('IPv4: a literal destination connects even though the SAME bindAddress cannot resolve anything', async () => {
    const server = net.createServer((sock) => sock.end())
    const port = await listen(server, '127.0.0.1')
    try {
      const upstream = createDirectUpstream({ bindAddress: '127.0.0.1', resolveThroughEgress: true, timeoutMs: 3_000 })
      const socket = await upstream.connect({ host: '127.0.0.1', port })
      expect(socket.localAddress).toBe('127.0.0.1')
      socket.destroy()
    } finally {
      server.close()
    }
  })

  test('IPv6: the same short-circuit, and the same family, over ::1', async () => {
    const server = net.createServer((sock) => sock.end())
    const port = await listen(server, '::1')
    try {
      const upstream = createDirectUpstream({ bindAddress: '::1', resolveThroughEgress: true, timeoutMs: 3_000 })
      const socket = await upstream.connect({ host: '::1', port })
      expect(socket.localAddress).toBe('::1')
      socket.destroy()
    } finally {
      server.close()
    }
  })

  test('the control: the SAME bindAddress genuinely cannot resolve a hostname — a literal is not "resolution that happens to work"', async () => {
    // If this test failed to reject, the "literal" test above would prove
    // nothing: it would be indistinguishable from a resolver that just
    // happens to work. `192.0.2.1` (not loopback — see this file's own
    // header) is what makes the failure genuinely unconditional rather than
    // dependent on what else is listening on this machine.
    const upstream = createDirectUpstream({ bindAddress: '192.0.2.1', resolveThroughEgress: true, timeoutMs: 3_000 })
    await expect(upstream.connect({ host: 'example.com', port: 80 })).rejects.toMatchObject({ code: 'E_PROXY_DNS_EGRESS_FAILED' })
  })
})

describe('criterion 4 — a resolver failure never falls back to the host’s default resolver', () => {
  test('E_PROXY_DNS_EGRESS_FAILED, and the connection is never attempted at all', async () => {
    const upstream = createDirectUpstream({ bindAddress: '192.0.2.1', resolveThroughEgress: true, timeoutMs: 3_000 })
    let rejected: unknown
    try {
      await upstream.connect({ host: 'example.com', port: 80 })
    } catch (err) {
      rejected = err
    }
    expect(rejected).toMatchObject({ code: 'E_PROXY_DNS_EGRESS_FAILED' })
    // THE CLAIM: had this silently fallen back to the host's own unbound
    // resolver, resolving a real, always-registered domain would very likely
    // have succeeded and produced a connected socket instead of a rejection —
    // there would be nothing here to catch. The rejection itself is the
    // proof no fallback happened.
    expect((rejected as Error).message).toContain('example.com')
    expect((rejected as Error).message).toMatch(/not retried through the host's default resolver/)
  })

  test('exactly one failure path — the message names the resolver it used, not a second attempt', async () => {
    const upstream = createDirectUpstream({ bindAddress: '192.0.2.1', resolveThroughEgress: true, timeoutMs: 3_000 })
    await expect(upstream.connect({ host: 'another-real-hostname.example', port: 443 })).rejects.toMatchObject({
      code: 'E_PROXY_DNS_EGRESS_FAILED',
    })
  })
})

describe('resolveThroughEgress: false — the host’s own default resolution is used, unaffected by bindAddress', () => {
  test('a hostname the host resolves itself (via /etc/hosts) still connects, bound to bindAddress', async () => {
    // `localhost`'s own resolved family varies by platform/config (`::1` on
    // some, `127.0.0.1` on others) — looked up first rather than assumed, so
    // the loopback server this test binds actually matches what `getaddrinfo`
    // will hand back.
    const { address: localhostAddress } = await lookup('localhost')
    const server = net.createServer((sock) => sock.end())
    const port = await listen(server, localhostAddress)
    try {
      const upstream = createDirectUpstream({ bindAddress: localhostAddress, resolveThroughEgress: false, timeoutMs: 3_000 })
      // `localhost` resolves via the host's own hosts file/getaddrinfo — never
      // through our bound Resolver, which is the whole point of this switch
      // being off. It reaches the SAME loopback server the tests above use.
      const socket = await upstream.connect({ host: 'localhost', port })
      expect(socket.localAddress).toBe(localhostAddress)
      socket.destroy()
    } finally {
      server.close()
    }
  })
})

describe('the family===0 defensive branch — an invalid bindAddress is refused rather than silently guessed at', () => {
  test('a bindAddress that is not a literal at all fails loudly, with no network involved', async () => {
    // Unreachable through `validateProxyRecord` in practice (`shared.ts`
    // refuses this at write and at start) — this calls `dial-direct.ts`
    // directly, the way a defensive "belt to that braces" throw deserves to
    // be tested.
    const upstream = createDirectUpstream({ bindAddress: 'not-an-ip-at-all', resolveThroughEgress: true, timeoutMs: 3_000 })
    await expect(upstream.connect({ host: 'some-hostname.example', port: 80 })).rejects.toMatchObject({ code: 'E_PROXY_DNS_EGRESS_FAILED' })
  })
})

describe('the connect timeout', () => {
  test('a target that never completes the TCP handshake times out, classified as E_PROXY_UPSTREAM_TIMEOUT', async () => {
    // 203.0.113.0/24 is RFC 5737's documentation range — guaranteed to have
    // nothing listening, and observed (writing this test) to be silently
    // dropped rather than promptly refused, which is what makes it a genuine
    // connect-timeout fixture rather than an immediate ECONNREFUSED. A
    // literal destination, so no DNS is involved — this test is about the
    // TCP connect deadline alone.
    const upstream = createDirectUpstream({ bindAddress: '', resolveThroughEgress: true, timeoutMs: 500 })
    const started = Date.now()
    await expect(upstream.connect({ host: '203.0.113.1', port: 81 })).rejects.toMatchObject({ code: 'E_PROXY_UPSTREAM_TIMEOUT' })
    expect(Date.now() - started).toBeLessThan(3_000)
  }, 10_000)
})

describe('an empty bindAddress — "dial out however this host normally would" (§3.1 point 1)', () => {
  test('no bind at all, and resolution is never routed through a custom resolver even with resolveThroughEgress on', async () => {
    const server = net.createServer((sock) => sock.end())
    const port = await listen(server, '127.0.0.1')
    try {
      const upstream = createDirectUpstream({ bindAddress: '', resolveThroughEgress: true, timeoutMs: 3_000 })
      const socket = await upstream.connect({ host: '127.0.0.1', port })
      expect(socket.destroyed).toBe(false)
      socket.destroy()
    } finally {
      server.close()
    }
  })
})

describe('the description — never a credential, because a `direct` upstream has none to omit', () => {
  test('matches shared.ts’s describeDirectUpstream exactly, for both DNS modes', () => {
    const bound = createDirectUpstream({ bindAddress: '192.168.100.11', resolveThroughEgress: true, timeoutMs: 1_000 })
    expect(bound.description).toBe(describeDirectUpstream('192.168.100.11', true))
    expect(bound.description).toContain('192.168.100.11')

    const unbound = createDirectUpstream({ bindAddress: '', resolveThroughEgress: true, timeoutMs: 1_000 })
    expect(unbound.description).toBe(describeDirectUpstream('', true))
    expect(unbound.description).not.toContain('192.168.100.11')
  })
})
