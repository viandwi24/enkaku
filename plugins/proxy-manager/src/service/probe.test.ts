import { describe, expect, test } from 'bun:test'
import net from 'node:net'
import { probeUrlFromEnv, runEgressProbe } from './probe'
import { startSilentUpstream } from './fixtures'
import { PROXY_PROBE_SKIP_REASON, proxyProbeState, readProxyProbe } from '../shared'
import type { BridgeSocket } from './socket'
import type { Upstream, UpstreamTarget } from './upstream'

/**
 * Plan 117 step 117.11 — the egress probe (§3.7, §4.2, §4.5): `skip` when
 * `ENKAKU_NETWORK_PROBE_URL` is unset, `unverified` before a pass, a
 * successful parse, and a failure that records an error carrying no
 * credential.
 *
 * `skip` and `unverified` are `proxyProbeState`'s own vocabulary
 * (`shared.ts`) rather than something `runEgressProbe` decides itself — the
 * supervisor writes the `skip` shape straight into storage without ever
 * dialling (`service/supervisor.ts`'s `probeEntry`) — so this file tests both
 * halves of that boundary: the env read `service/supervisor.ts` gates on, and
 * the state word the screen actually renders.
 */

function listen(server: net.Server): Promise<number> {
  return new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(typeof address === 'object' && address !== null ? address.port : 0)
    })
  })
}

/** A minimal HTTP responder — `runEgressProbe` only ever GETs one path and reads a status line, headers and a body. */
function startProbeResponder(respond: (req: string) => string): Promise<{ port: number; close: () => void }> {
  const server = net.createServer((sock) => {
    let head = ''
    sock.on('data', (chunk: Buffer) => {
      head += chunk.toString('latin1')
      if (head.includes('\r\n\r\n')) sock.end(respond(head))
    })
    sock.on('error', () => {})
  })
  return listen(server).then((port) => ({ port, close: () => server.close() }))
}

/** A fake `Upstream` that always connects to the SAME real local server, regardless of `dest` — `runEgressProbe`'s own contract is "dial through the record's own Upstream", and this fixture stands in for one. */
function upstreamTo(port: number): Upstream & { connectCount: number } {
  const state = { connectCount: 0 }
  return {
    description: 'test upstream',
    get connectCount() {
      return state.connectCount
    },
    async connect(_dest: UpstreamTarget): Promise<BridgeSocket> {
      state.connectCount += 1
      return net.connect(port, '127.0.0.1') as unknown as BridgeSocket
    },
  }
}

function jsonResponse(body: string, status = '200 OK'): string {
  return `HTTP/1.1 ${status}\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`
}

describe('probeUrlFromEnv — trimmed, and `null` (never empty-string) when unset', () => {
  async function withEnv(value: string | undefined, fn: () => void): Promise<void> {
    const original = process.env.ENKAKU_NETWORK_PROBE_URL
    try {
      if (value === undefined) delete process.env.ENKAKU_NETWORK_PROBE_URL
      else process.env.ENKAKU_NETWORK_PROBE_URL = value
      fn()
    } finally {
      if (original === undefined) delete process.env.ENKAKU_NETWORK_PROBE_URL
      else process.env.ENKAKU_NETWORK_PROBE_URL = original
    }
  }

  test('unset is null', async () => {
    await withEnv(undefined, () => expect(probeUrlFromEnv()).toBeNull())
  })

  test('blank/whitespace-only is also null, not an empty string a caller would have to check for separately', async () => {
    await withEnv('   ', () => expect(probeUrlFromEnv()).toBeNull())
    await withEnv('', () => expect(probeUrlFromEnv()).toBeNull())
  })

  test('set, and trimmed', async () => {
    await withEnv('  http://127.0.0.1:9999/probe  ', () => expect(probeUrlFromEnv()).toBe('http://127.0.0.1:9999/probe'))
  })
})

describe('the state vocabulary — `unverified` before a pass, `skip` for the unmeasurable case, `confirmed` only for a real pass', () => {
  test('never probed at all → unverified', () => {
    expect(proxyProbeState(null)).toBe('unverified')
  })

  test('the LAST probe failed → still unverified, never worded as anything weaker or stronger', () => {
    expect(proxyProbeState({ at: 0, ok: false, error: 'dial refused' })).toBe('unverified')
  })

  test('the recorded skip shape → skip, and only that exact shape', () => {
    expect(proxyProbeState({ at: 0, ok: false, error: PROXY_PROBE_SKIP_REASON })).toBe('skip')
    // Control: an ordinary failure that merely LOOKS similar is not read as
    // skip — the state is keyed on the fixed sentence, not on `ok: false`
    // alone (which is also true of every failed probe).
    expect(proxyProbeState({ at: 0, ok: false, error: 'no probe endpoint is configured (somewhere else)' })).toBe('unverified')
  })

  test('a real pass → confirmed, the one state that may sit beside an address', () => {
    expect(proxyProbeState({ at: 0, ok: true, publicAddress: '203.0.113.9' })).toBe('confirmed')
  })

  test('readProxyProbe is defensive against a junk KV value, the same discipline readProxyRecord uses', () => {
    expect(readProxyProbe(null)).toBeNull()
    expect(readProxyProbe({ nonsense: true })).toBeNull()
    expect(readProxyProbe({ at: 100, ok: true, publicAddress: '203.0.113.9', latencyMs: 42 })).toEqual({ at: 100, ok: true, publicAddress: '203.0.113.9', latencyMs: 42 })
  })
})

describe('runEgressProbe — a real dial, through the record’s own Upstream', () => {
  test('a successful parse: the probe-server shape `{ address, nonce, at }`', async () => {
    const responder = await startProbeResponder(() => jsonResponse(JSON.stringify({ address: '203.0.113.9', nonce: 'x', at: 123 })))
    try {
      const upstream = upstreamTo(responder.port)
      const result = await runEgressProbe({ upstream, probeUrl: `http://127.0.0.1:${responder.port}/probe`, timeoutMs: 3_000, secrets: [] })
      expect(result.ok).toBe(true)
      expect(result.publicAddress).toBe('203.0.113.9')
      expect(typeof result.latencyMs).toBe('number')
      expect(upstream.connectCount).toBe(1)
    } finally {
      responder.close()
    }
  })

  test('the `ip`/`origin` fallback spellings, and the bare-literal body fallback, all parse the same way route-checks.ts already does', async () => {
    for (const body of [JSON.stringify({ ip: '203.0.113.10' }), JSON.stringify({ origin: '203.0.113.11' }), '203.0.113.12']) {
      const responder = await startProbeResponder(() => jsonResponse(body))
      try {
        const result = await runEgressProbe({ upstream: upstreamTo(responder.port), probeUrl: `http://127.0.0.1:${responder.port}/`, timeoutMs: 3_000, secrets: [] })
        expect(result.ok).toBe(true)
        expect(result.publicAddress).toMatch(/^203\.0\.113\.1[012]$/)
      } finally {
        responder.close()
      }
    }
  })

  test('a body that names no address is a failure, not a pass with an empty address', async () => {
    const responder = await startProbeResponder(() => jsonResponse('{}'))
    try {
      const result = await runEgressProbe({ upstream: upstreamTo(responder.port), probeUrl: `http://127.0.0.1:${responder.port}/`, timeoutMs: 3_000, secrets: [] })
      expect(result.ok).toBe(false)
      expect(result.error).toBeDefined()
    } finally {
      responder.close()
    }
  })

  test('a non-2xx status is a failure that names the status', async () => {
    const responder = await startProbeResponder(() => jsonResponse('nope', '500 Internal Server Error'))
    try {
      const result = await runEgressProbe({ upstream: upstreamTo(responder.port), probeUrl: `http://127.0.0.1:${responder.port}/`, timeoutMs: 3_000, secrets: [] })
      expect(result.ok).toBe(false)
      expect(result.error).toContain('500')
    } finally {
      responder.close()
    }
  })

  test('an `https:` probe URL is refused BY NAME — plain HTTP only — and the upstream is never dialled at all', async () => {
    const upstream = upstreamTo(0)
    const result = await runEgressProbe({ upstream, probeUrl: 'https://example.com/probe', timeoutMs: 3_000, secrets: [] })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/plain http/)
    // THE CLAIM: refused before ever touching the record's own upstream — not
    // sent in the clear, and not a TLS handshake this file does not speak.
    expect(upstream.connectCount).toBe(0)
  })

  test('a target that never answers times out rather than hanging the sweep forever', async () => {
    const silent = await startSilentUpstream()
    try {
      const result = await runEgressProbe({ upstream: upstreamTo(silent.port), probeUrl: `http://127.0.0.1:${silent.port}/`, timeoutMs: 300, secrets: [] })
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/did not answer within/)
    } finally {
      await silent.close()
    }
  })

  test('a failure that records an error carries NO credential — the two controls', async () => {
    const password = 'Sup3rSecretUpstreamPassword'
    const failing: Upstream = {
      description: 'test upstream',
      connect: async () => {
        throw new Error(`dial refused while authenticating with password ${password}`)
      },
    }
    const secrets = [password]
    const result = await runEgressProbe({ upstream: failing, probeUrl: 'http://127.0.0.1:1/probe', timeoutMs: 1_000, secrets })
    expect(result.ok).toBe(false)
    expect(result.error).not.toContain(password)
    // Positive control: passing NO secrets to scrub against would have left
    // the password sitting right there — proving the assertion above is
    // about the scrubbing, not about the password never having been in the
    // message in the first place.
    const unscrubbed = await runEgressProbe({ upstream: failing, probeUrl: 'http://127.0.0.1:1/probe', timeoutMs: 1_000, secrets: [] })
    expect(unscrubbed.error).toContain(password)
  })

  test('runEgressProbe never throws — every failure resolves to `{ ok: false, error }`', async () => {
    const throwsWeird: Upstream = {
      description: 'test',
      connect: async () => {
        throw { not: 'an Error instance at all' }
      },
    }
    const result = await runEgressProbe({ upstream: throwsWeird, probeUrl: 'http://127.0.0.1:1/probe', timeoutMs: 1_000, secrets: [] })
    expect(result.ok).toBe(false)
    expect(typeof result.error).toBe('string')
  })
})
