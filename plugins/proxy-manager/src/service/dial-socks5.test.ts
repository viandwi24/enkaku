import { afterAll, describe, expect, test } from 'bun:test'
import { createSocks5Upstream } from './dial-socks5'
import { ProxyError, scrubSecrets } from './errors'
import { reserveClosedPort, startBlackHoleUpstream, startSilentUpstream, startSocks5Upstream } from './fixtures'
import { createRelay } from './relay'

/**
 * Plan 112 step 112.4 — the SOCKS5 upstream dial, against a real RFC 1928 +
 * RFC 1929 server (`fixtures.ts`), and plan 112 H3's three failure fixtures
 * with their measured time-to-error asserted as bounds.
 */

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

describe('a working upstream', () => {
  test('dials through RFC 1929 username/password auth and carries bytes', async () => {
    const upstream = await startSocks5Upstream({ username: USERNAME, password: PASSWORD })
    try {
      const dialler = createSocks5Upstream({ host: '127.0.0.1', port: upstream.port, username: USERNAME, password: PASSWORD, timeoutMs: 5_000 })
      const socket = await dialler.connect({ host: '127.0.0.1', port: TARGET_PORT })
      expect(upstream.authAccepted).toBe(true)
      expect(upstream.usernamesSeen).toEqual([USERNAME])
      const body = await new Promise<string>((resolve) => {
        let out = ''
        socket.on('data', (chunk: Buffer) => {
          out += chunk.toString('latin1')
          if (out.includes('hello-from-target')) resolve(out)
        })
        socket.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${TARGET_PORT}\r\nConnection: close\r\n\r\n`)
      })
      expect(body).toContain('hello-from-target')
      socket.destroy()
    } finally {
      await upstream.close()
    }
  })

  test('an upstream that needs no account is dialled without offering RFC 1929 at all', async () => {
    const upstream = await startSocks5Upstream()
    try {
      const dialler = createSocks5Upstream({ host: '127.0.0.1', port: upstream.port, username: '', password: '', timeoutMs: 5_000 })
      const socket = await dialler.connect({ host: '127.0.0.1', port: TARGET_PORT })
      expect(upstream.usernamesSeen).toEqual([])
      socket.destroy()
    } finally {
      await upstream.close()
    }
  })

  test('the description an operator sees carries the account and never the password', () => {
    const dialler = createSocks5Upstream({ host: '10.4.0.9', port: 1080, username: USERNAME, password: PASSWORD, timeoutMs: 1 })
    expect(dialler.description).toBe(`socks5://${USERNAME}@10.4.0.9:1080`)
    expect(dialler.description).not.toContain(PASSWORD)
  })
})

describe('H3 — a dead upstream is detected promptly rather than hanging', () => {
  /**
   * The measured numbers are recorded in plan 112 §0.3. Asserted here as
   * BOUNDS rather than as the exact figures, because a test that pins a
   * measurement to the millisecond fails on a loaded CI box and teaches
   * nothing when it does. What each bound is protecting is written beside it.
   */

  test('fixture 1 — a refusing upstream fails in well under a second, named UNREACHABLE (measured: 10 ms)', async () => {
    const port = await reserveClosedPort()
    const dialler = createSocks5Upstream({ host: '127.0.0.1', port, username: '', password: '', timeoutMs: 10_000 })
    const started = performance.now()
    const err = await dialler.connect({ host: '127.0.0.1', port: TARGET_PORT }).then(
      () => null,
      (e: unknown) => e,
    )
    const elapsed = performance.now() - started
    expect(err).toBeInstanceOf(ProxyError)
    // Not `E_PROXY_UPSTREAM_DIAL`: a SocksClientError carries no `code` at all,
    // so a classifier that only read `err.code` labelled this generically.
    expect((err as ProxyError).code).toBe('E_PROXY_UPSTREAM_UNREACHABLE')
    expect(elapsed).toBeLessThan(1_000)
  })

  test('fixture 2 — a silent upstream fails at OUR deadline, not at `socks`’s 30 s default (measured: 10 002 ms at 10 s)', async () => {
    const upstream = await startSilentUpstream()
    try {
      // 800 ms rather than the shipped 10 s so the suite does not wait; what is
      // being proved is that the deadline is honoured and is ours, and the
      // margin below is what would catch a fall-through to `socks`'s own 30 s.
      const dialler = createSocks5Upstream({ host: '127.0.0.1', port: upstream.port, username: '', password: '', timeoutMs: 800 })
      const started = performance.now()
      const err = await dialler.connect({ host: '127.0.0.1', port: TARGET_PORT }).then(
        () => null,
        (e: unknown) => e,
      )
      const elapsed = performance.now() - started
      expect((err as ProxyError).code).toBe('E_PROXY_UPSTREAM_TIMEOUT')
      expect(elapsed).toBeGreaterThanOrEqual(700)
      expect(elapsed).toBeLessThan(3_000)
    } finally {
      await upstream.close()
    }
  })

  test('fixture 3 — a black hole completes the handshake, so only the RELAY’s idle timer catches it', async () => {
    // This is the fixture that decided plan 112 H3: `socks`'s timeout is
    // disarmed the moment the reply arrives, so the dial SUCCEEDS and the
    // tunnel then carries nothing, forever. Measured end to end: 45 004 ms
    // with no idle timer (i.e. never — that is the client's own abort), and
    // 2 014 ms with one set to 2 000 ms.
    const upstream = await startBlackHoleUpstream()
    try {
      const dialler = createSocks5Upstream({ host: '127.0.0.1', port: upstream.port, username: '', password: '', timeoutMs: 5_000 })
      const started = performance.now()
      const socket = await dialler.connect({ host: '127.0.0.1', port: TARGET_PORT })
      const dialMs = performance.now() - started

      // The finding itself: the dial SUCCEEDS, quickly, against an upstream
      // that will never carry a byte. `socks`'s timeout is disarmed the moment
      // the reply arrives, so nothing it offers can ever detect this.
      expect(socket.destroyed).toBe(false)
      expect(dialMs).toBeLessThan(1_000)

      // Nothing comes back, ever. Control: the working upstream at the top of
      // this file answers the identical request in milliseconds.
      const answered = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 500)
        socket.on('data', () => {
          clearTimeout(timer)
          resolve(true)
        })
        socket.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${TARGET_PORT}\r\nConnection: close\r\n\r\n`)
      })
      expect(answered).toBe(false)

      // So the only thing that ends it is the relay's own idle timer, which is
      // why `DEFAULT_IDLE_MS` exists. Proved here on the real black-holed
      // socket rather than on a stub.
      const { promise, resolve } = Promise.withResolvers<string>()
      const idleStarted = performance.now()
      createRelay(socket, socket, { idleMs: 300, onClose: (_counters, reason) => resolve(reason) })
      expect(await promise).toBe('idle')
      expect(performance.now() - idleStarted).toBeLessThan(3_000)
    } finally {
      await upstream.close()
    }
  })
})

describe('a thrown message never carries the credential (criterion 13)', () => {
  /**
   * An absence claim needs **two** controls: that the thing it looks for is
   * real, and that it would be seen if it were there. Both are below.
   */

  test('control 1 — the password is real, and it is what the dialler was actually given', async () => {
    const upstream = await startSocks5Upstream({ username: USERNAME, password: PASSWORD })
    try {
      const dialler = createSocks5Upstream({ host: '127.0.0.1', port: upstream.port, username: USERNAME, password: PASSWORD, timeoutMs: 5_000 })
      const socket = await dialler.connect({ host: '127.0.0.1', port: TARGET_PORT })
      // The fixture only accepts when the exact password arrived over the wire.
      expect(upstream.authAccepted).toBe(true)
      socket.destroy()
    } finally {
      await upstream.close()
    }
  })

  test('control 2 — the search would find the password if it were there', () => {
    const leaky = new Error(`socks5://${USERNAME}:${PASSWORD}@10.4.0.9:1080 refused`)
    expect(leaky.message).toContain(PASSWORD)
    expect(scrubSecrets(leaky.message, [PASSWORD])).not.toContain(PASSWORD)
    expect(scrubSecrets(leaky.message, [PASSWORD])).toContain('«redacted»')
  })

  test('the claim — a wrong password produces an auth failure whose message contains no part of it', async () => {
    const upstream = await startSocks5Upstream({ username: USERNAME, password: 'something-else-entirely' })
    try {
      const dialler = createSocks5Upstream({ host: '127.0.0.1', port: upstream.port, username: USERNAME, password: PASSWORD, timeoutMs: 5_000 })
      const err = await dialler.connect({ host: '127.0.0.1', port: TARGET_PORT }).then(
        () => null,
        (e: unknown) => e,
      )
      expect(err).toBeInstanceOf(ProxyError)
      const thrown = err as ProxyError
      expect(thrown.code).toBe('E_PROXY_UPSTREAM_AUTH')
      expect(thrown.message).not.toContain(PASSWORD)
      // And the stack, which is what actually reaches a log when somebody
      // writes `log.error(String(err))` in a hurry.
      expect(String(thrown.stack ?? '')).not.toContain(PASSWORD)
    } finally {
      await upstream.close()
    }
  })

  test('the reason the raw error must never be re-thrown: `socks` hangs the whole config off it, password included', async () => {
    // *(measured, socks@2.8.9)* — `Object.keys(err)` is `["options"]` and
    // `err.options.proxy.password` is the plaintext. This is the control that
    // proves the re-wording in `classifyDialError` is load-bearing rather than
    // decorative: if `socks` ever stopped doing this, the assertion below
    // fails and the comment can be deleted.
    const port = await reserveClosedPort()
    const raw = await import('socks').then(({ SocksClient }) =>
      SocksClient.createConnection({
        proxy: { host: '127.0.0.1', port, type: 5, userId: USERNAME, password: PASSWORD },
        command: 'connect',
        destination: { host: '127.0.0.1', port: 1 },
        timeout: 1_000,
      }).then(
        () => null,
        (e: unknown) => e,
      ),
    )
    expect(JSON.stringify(raw)).toContain(PASSWORD)
    // …and ours, built from `.message` alone, does not.
    const dialler = createSocks5Upstream({ host: '127.0.0.1', port, username: USERNAME, password: PASSWORD, timeoutMs: 1_000 })
    const ours = await dialler.connect({ host: '127.0.0.1', port: 1 }).then(
      () => null,
      (e: unknown) => e,
    )
    expect(JSON.stringify({ code: (ours as ProxyError).code, message: (ours as ProxyError).message })).not.toContain(PASSWORD)
  })
})
