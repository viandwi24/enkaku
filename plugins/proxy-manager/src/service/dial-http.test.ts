import { afterAll, describe, expect, test } from 'bun:test'
import { createHttpUpstream } from './dial-http'
import { ProxyError } from './errors'
import { reserveClosedPort, startHttpUpstream, startSilentUpstream } from './fixtures'

/** Plan 112 step 112.4 — the HTTP upstream dial: `CONNECT`, one status line, 2xx or a coded error. */

const USERNAME = 'country-id-r9931204'
const PASSWORD = 'Sup3rSecretUpstreamPassword'

const target = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('hello-from-target') })

/** `Bun.serve().port` is `number | undefined` in the types; a served fixture always has one, and a missing one must fail loudly. */
function servedPort(server: { port?: number }): number {
  if (typeof server.port !== 'number') throw new Error('Bun.serve did not report a port')
  return server.port
}
const TARGET_PORT = servedPort(target)
afterAll(() => target.stop(true))

describe('CONNECT through an HTTP upstream', () => {
  test('reaches the target and carries bytes', async () => {
    const upstream = await startHttpUpstream()
    try {
      const dialler = createHttpUpstream({ host: '127.0.0.1', port: upstream.port, username: '', password: '', timeoutMs: 5_000 })
      const socket = await dialler.connect({ host: '127.0.0.1', port: TARGET_PORT })
      const body = await new Promise<string>((resolve) => {
        let out = ''
        socket.on('data', (chunk: Buffer) => {
          out += chunk.toString('latin1')
          if (out.includes('hello-from-target')) resolve(out)
        })
        socket.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${TARGET_PORT}\r\nConnection: close\r\n\r\n`)
      })
      expect(body).toContain('hello-from-target')
      expect(upstream.connects).toBe(1)
      socket.destroy()
    } finally {
      await upstream.close()
    }
  })

  test('sends Basic proxy authentication when the record names an account, and the upstream can decode it', async () => {
    const upstream = await startHttpUpstream({ requireAuth: true })
    try {
      const dialler = createHttpUpstream({ host: '127.0.0.1', port: upstream.port, username: USERNAME, password: PASSWORD, timeoutMs: 5_000 })
      const socket = await dialler.connect({ host: '127.0.0.1', port: TARGET_PORT })
      const header = upstream.authHeaders[0] ?? ''
      expect(header.startsWith('Basic ')).toBe(true)
      expect(Buffer.from(header.slice(6), 'base64').toString()).toBe(`${USERNAME}:${PASSWORD}`)
      socket.destroy()
    } finally {
      await upstream.close()
    }
  })

  test('a 407 is reported as an auth failure, and the message carries no part of the password', async () => {
    const upstream = await startHttpUpstream({ requireAuth: true })
    try {
      // No account configured, so no header is sent and the fixture answers 407.
      const dialler = createHttpUpstream({ host: '127.0.0.1', port: upstream.port, username: '', password: PASSWORD, timeoutMs: 5_000 })
      const err = await dialler.connect({ host: '127.0.0.1', port: TARGET_PORT }).then(
        () => null,
        (e: unknown) => e,
      )
      expect((err as ProxyError).code).toBe('E_PROXY_UPSTREAM_AUTH')
      expect((err as ProxyError).message).toContain('407')
      expect((err as ProxyError).message).not.toContain(PASSWORD)
    } finally {
      await upstream.close()
    }
  })

  test('a refusing upstream is named UNREACHABLE, promptly', async () => {
    const port = await reserveClosedPort()
    const dialler = createHttpUpstream({ host: '127.0.0.1', port, username: '', password: '', timeoutMs: 5_000 })
    const started = performance.now()
    const err = await dialler.connect({ host: '127.0.0.1', port: TARGET_PORT }).then(
      () => null,
      (e: unknown) => e,
    )
    expect((err as ProxyError).code).toBe('E_PROXY_UPSTREAM_UNREACHABLE')
    expect(performance.now() - started).toBeLessThan(1_000)
  })

  test('a silent upstream fails at the deadline rather than hanging', async () => {
    const upstream = await startSilentUpstream()
    try {
      const dialler = createHttpUpstream({ host: '127.0.0.1', port: upstream.port, username: '', password: '', timeoutMs: 500 })
      const started = performance.now()
      const err = await dialler.connect({ host: '127.0.0.1', port: TARGET_PORT }).then(
        () => null,
        (e: unknown) => e,
      )
      const elapsed = performance.now() - started
      expect((err as ProxyError).code).toBe('E_PROXY_UPSTREAM_TIMEOUT')
      expect(elapsed).toBeGreaterThanOrEqual(400)
      expect(elapsed).toBeLessThan(3_000)
    } finally {
      await upstream.close()
    }
  })

  test('bytes the upstream sent in the same segment as the 200 are not eaten', async () => {
    // The subtlety `dial-http.ts`'s header names: a server may pack the
    // tunnel's first bytes behind `\r\n\r\n`. Dropping them loses the head of
    // every response, intermittently and only under load — so the fixture here
    // deliberately writes both in one call.
    const greedy = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: {
        data(socket) {
          socket.write('HTTP/1.1 200 Connection Established\r\n\r\nFIRST-TUNNEL-BYTES')
        },
      },
    })
    try {
      const dialler = createHttpUpstream({ host: '127.0.0.1', port: greedy.port, username: '', password: '', timeoutMs: 5_000 })
      const socket = await dialler.connect({ host: 'example.invalid', port: 443 })
      // The bytes are already on the socket, and it is PAUSED — see
      // `Upstream.connect`'s doc comment. `resume()` here stands in for the
      // `pipe()` the relay does, and is the reason this test is written with
      // one: attaching a bare `on('data')` after an explicit `pause()` does
      // NOT resume the stream, and the first version of this test failed
      // exactly that way while the bytes sat in the buffer.
      expect(socket.readableLength).toBe('FIRST-TUNNEL-BYTES'.length)
      const first = await new Promise<string>((resolve) => {
        socket.on('data', (chunk: Buffer) => resolve(chunk.toString('latin1')))
        setTimeout(() => resolve('(nothing arrived)'), 1_000)
        socket.resume()
      })
      expect(first).toBe('FIRST-TUNNEL-BYTES')
      socket.destroy()
    } finally {
      greedy.stop(true)
    }
  })

  test('the description carries the account and never the password', () => {
    const dialler = createHttpUpstream({ host: '10.4.0.9', port: 8080, username: USERNAME, password: PASSWORD, timeoutMs: 1 })
    expect(dialler.description).toBe(`http://${USERNAME}@10.4.0.9:8080`)
    expect(dialler.description).not.toContain(PASSWORD)
  })
})
