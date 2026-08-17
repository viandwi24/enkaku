import { afterAll, describe, expect, test } from 'bun:test'
import net from 'node:net'
import { createSocks5Upstream } from './dial-socks5'
import { startSocks5Upstream } from './fixtures'
import { createHttpListener, parseProxyRequestLine, toOriginForm } from './listen-http'
import type { BridgeEvent } from './logbook'
import type { Listener } from './listener'

/**
 * Plan 112 step 112.5 — the HTTP listener.
 *
 * **Two tests, never one.** Criterion 4 (CONNECT, https target) passing while
 * criterion 5 (absolute-form, http target) fails is the exact bug plan 112
 * §0.2 found on the probe's first run, and it is invisible to any test that
 * only speaks one of the two forms.
 */

const USERNAME = 'country-id-r9931204'
const PASSWORD = 'Sup3rSecretUpstreamPassword'

const plain = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('hello-from-plain-http') })

/** `Bun.serve().port` is `number | undefined` in the types; a served fixture always has one, and a missing one must fail loudly. */
function servedPort(server: { port?: number }): number {
  if (typeof server.port !== 'number') throw new Error('Bun.serve did not report a port')
  return server.port
}
const PLAIN_PORT = servedPort(plain)

async function withListener(
  upstreamPort: number,
  fn: (listener: Listener, events: BridgeEvent[]) => Promise<void>,
  opts: { maxConnections?: number; username?: string; password?: string } = {},
): Promise<void> {
  const events: BridgeEvent[] = []
  const listener = await createHttpListener({
    bindHost: '127.0.0.1',
    port: 0,
    upstream: createSocks5Upstream({
      host: '127.0.0.1',
      port: upstreamPort,
      username: opts.username ?? USERNAME,
      password: opts.password ?? PASSWORD,
      timeoutMs: 5_000,
    }),
    maxConnections: opts.maxConnections ?? 16,
    idleMs: 5_000,
    log: (event) => events.push(event),
  })
  try {
    await fn(listener, events)
  } finally {
    listener.close()
    listener.destroyLive()
  }
}

/** Speak to the bridge directly, so a test can send a request form `fetch` would never produce. */
function rawRequest(port: number, head: string): Promise<string> {
  return new Promise<string>((resolve) => {
    const sock = net.connect(port, '127.0.0.1')
    let out = ''
    sock.on('connect', () => sock.write(head))
    sock.on('data', (chunk: Buffer) => {
      out += chunk.toString('latin1')
    })
    sock.on('close', () => resolve(out))
    sock.on('error', () => resolve(out))
    setTimeout(() => {
      sock.destroy()
      resolve(out)
    }, 3_000)
  })
}

afterAll(() => plain.stop(true))

/**
 * The finding itself, proved against the real client rather than restated.
 *
 * This records the first request line a proxy client actually sends, for an
 * `http:` and an `https:` target, using a bare recorder rather than our own
 * listener — so what is under test is the CLIENT's asymmetry, which is the
 * thing that makes a CONNECT-only bridge pass every https test and die on
 * plain http.
 */
function recordFirstLine(): Promise<{ port: number; lines: string[]; close: () => void }> {
  const lines: string[] = []
  const server = net.createServer((client) => {
    let head = ''
    client.on('data', (chunk: Buffer) => {
      head += chunk.toString('latin1')
      const end = head.indexOf('\r\n')
      if (end === -1) return
      lines.push(head.slice(0, end))
      client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
    })
    client.on('error', () => {})
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({ port: typeof address === 'object' && address !== null ? address.port : 0, lines, close: () => server.close() })
    })
  })
}

describe('why two forms, measured against a real proxy client', () => {
  test('Bun’s fetch({ proxy }) sends CONNECT for https and absolute-form for http', async () => {
    const recorder = await recordFirstLine()
    try {
      await fetch('https://127.0.0.1:1/', { proxy: `http://127.0.0.1:${recorder.port}` }).catch(() => null)
      await fetch('http://127.0.0.1:1/some/path?q=1', { proxy: `http://127.0.0.1:${recorder.port}` }).catch(() => null)
      expect(recorder.lines.length).toBe(2)
      expect(recorder.lines[0]).toMatch(/^CONNECT 127\.0\.0\.1:1 HTTP\/1\.[01]$/)
      expect(recorder.lines[1]).toMatch(/^GET http:\/\/127\.0\.0\.1:1\/some\/path\?q=1 HTTP\/1\.[01]$/)
      // And the two really are different forms — the assertion that makes the
      // pair mean something rather than being two spellings of the same thing.
      expect(recorder.lines[0]?.startsWith('CONNECT')).toBe(true)
      expect(recorder.lines[1]?.startsWith('CONNECT')).toBe(false)
    } finally {
      recorder.close()
    }
  })
})

describe('the request line parser — the §0.2 finding, on its own', () => {
  test('CONNECT is recognised, with its port', () => {
    expect(parseProxyRequestLine('CONNECT api.ipify.org:443 HTTP/1.1')).toEqual({
      form: 'connect',
      method: 'CONNECT',
      host: 'api.ipify.org',
      port: 443,
      target: '',
    })
  })

  test('absolute-form is recognised, and defaults to port 80 — the form a CONNECT-only bridge answers 405 to', () => {
    expect(parseProxyRequestLine('GET http://api.ipify.org/?format=json HTTP/1.1')).toEqual({
      form: 'absolute',
      method: 'GET',
      host: 'api.ipify.org',
      port: 80,
      target: '/?format=json',
    })
    expect(parseProxyRequestLine('POST http://10.4.0.9:8080/v1/x HTTP/1.0')?.port).toBe(8080)
    // A bare path with no target still gets an origin-form `/`.
    expect(parseProxyRequestLine('GET http://example.com HTTP/1.1')?.target).toBe('/')
  })

  test('anything that is not a proxy request is refused rather than guessed at', () => {
    for (const line of ['GET / HTTP/1.1', 'PRI * HTTP/2.0', 'CONNECT nope HTTP/1.1', 'CONNECT h:99999 HTTP/1.1', '', 'garbage']) {
      expect(parseProxyRequestLine(line)).toBeNull()
    }
  })

  test('the rewrite turns an absolute-form head into an origin-form one, keeping every header', () => {
    const head = 'GET http://example.com:8080/a/b?c=1 HTTP/1.1\r\nHost: example.com:8080\r\nUser-Agent: probe\r\n\r\n'
    const parsed = parseProxyRequestLine(head.slice(0, head.indexOf('\r\n')))
    expect(parsed).not.toBeNull()
    const rewritten = toOriginForm(parsed as NonNullable<typeof parsed>, head)
    expect(rewritten).toBe('GET /a/b?c=1 HTTP/1.1\r\nHost: example.com:8080\r\nUser-Agent: probe\r\n\r\n')
    // The absolute URL is gone from the request line, which is the whole job.
    expect(rewritten.slice(0, rewritten.indexOf('\r\n'))).not.toContain('http://')
  })
})

describe('both request forms reach a target through a SOCKS5 upstream', () => {
  test('criterion 5 — ABSOLUTE-FORM (a plain http target), through Bun’s own fetch({ proxy })', async () => {
    const upstream = await startSocks5Upstream({ username: USERNAME, password: PASSWORD })
    try {
      await withListener(upstream.port, async (listener, events) => {
        const res = await fetch(`http://127.0.0.1:${PLAIN_PORT}/`, { proxy: `http://127.0.0.1:${listener.port}` })
        expect(await res.text()).toBe('hello-from-plain-http')
        expect(upstream.authAccepted).toBe(true)
        expect(upstream.connects).toBe(1)
        expect(events.map((e) => e.event)).toContain('upstream-connected')
        // Control that this really was the absolute-form path and not a
        // CONNECT: a CONNECT-only bridge answers 405, so a passing assertion
        // above with a 405 here would mean the test proved nothing.
        expect(events.some((e) => e.event === 'refused')).toBe(false)
      })
    } finally {
      await upstream.close()
    }
  })

  test('criterion 4 — CONNECT, and it is a real CONNECT because the client chose it', async () => {
    const upstream = await startSocks5Upstream({ username: USERNAME, password: PASSWORD })
    try {
      await withListener(upstream.port, async (listener) => {
        // A raw CONNECT, so the test does not depend on having a TLS target:
        // what is being proved is that the bridge answers `200 Connection
        // Established` and then pipes, which is the entire CONNECT path.
        const reply = await rawRequest(
          listener.port,
          `CONNECT 127.0.0.1:${PLAIN_PORT} HTTP/1.1\r\nHost: 127.0.0.1:${PLAIN_PORT}\r\n\r\n`,
        )
        expect(reply).toContain('200 Connection Established')
        expect(upstream.connects).toBe(1)
      })
    } finally {
      await upstream.close()
    }
  })

  test('a CONNECT tunnel really carries bytes both ways after the 200', async () => {
    const upstream = await startSocks5Upstream({ username: USERNAME, password: PASSWORD })
    try {
      await withListener(upstream.port, async (listener) => {
        const body = await new Promise<string>((resolve) => {
          const sock = net.connect(listener.port, '127.0.0.1')
          let out = ''
          let tunnelled = false
          sock.on('connect', () => sock.write(`CONNECT 127.0.0.1:${PLAIN_PORT} HTTP/1.1\r\n\r\n`))
          sock.on('data', (chunk: Buffer) => {
            out += chunk.toString('latin1')
            if (!tunnelled && out.includes('200 Connection Established')) {
              tunnelled = true
              out = ''
              sock.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${PLAIN_PORT}\r\nConnection: close\r\n\r\n`)
              return
            }
            if (tunnelled && out.includes('hello-from-plain-http')) {
              sock.destroy()
              resolve(out)
            }
          })
          setTimeout(() => {
            sock.destroy()
            resolve(out)
          }, 3_000)
        })
        expect(body).toContain('hello-from-plain-http')
      })
    } finally {
      await upstream.close()
    }
  })

  test('a request that is neither form gets 405, and the refusal is logged with a reason', async () => {
    const upstream = await startSocks5Upstream({ username: USERNAME, password: PASSWORD })
    try {
      await withListener(upstream.port, async (listener, events) => {
        const reply = await rawRequest(listener.port, 'GET / HTTP/1.1\r\nHost: localhost\r\n\r\n')
        expect(reply).toContain('405 Method Not Allowed')
        expect(events.some((e) => e.event === 'refused' && e.reason === 'not-a-proxy-request')).toBe(true)
        expect(upstream.connects).toBe(0)
      })
    } finally {
      await upstream.close()
    }
  })

  test('a dead upstream becomes a 502 with no upstream detail in it', async () => {
    const upstream = await startSocks5Upstream({ username: USERNAME, password: 'the-wrong-one' })
    try {
      await withListener(upstream.port, async (listener, events) => {
        const reply = await rawRequest(listener.port, `CONNECT 127.0.0.1:${PLAIN_PORT} HTTP/1.1\r\n\r\n`)
        expect(reply).toContain('502 Bad Gateway')
        expect(reply).not.toContain(PASSWORD)
        expect(reply).not.toContain(USERNAME)
        expect(events.some((e) => e.event === 'refused' && e.reason === 'upstream')).toBe(true)
      })
    } finally {
      await upstream.close()
    }
  })
})

describe('framing the head', () => {
  test('a head split across TCP segments is still parsed — the probe’s once(“data”) would not have been', async () => {
    const upstream = await startSocks5Upstream({ username: USERNAME, password: PASSWORD })
    try {
      await withListener(upstream.port, async (listener) => {
        const reply = await new Promise<string>((resolve) => {
          const sock = net.connect(listener.port, '127.0.0.1')
          let out = ''
          sock.on('connect', () => {
            // Deliberately three writes, with the request line itself cut in
            // half. A `once('data')` parser sees `CONNECT 127.` and gives up.
            sock.write('CONNECT 127.')
            setTimeout(() => sock.write(`0.0.1:${PLAIN_PORT} HTTP/1.1\r\nHost: x\r\n`), 30)
            setTimeout(() => sock.write('\r\n'), 60)
          })
          sock.on('data', (chunk: Buffer) => {
            out += chunk.toString('latin1')
            if (out.includes('\r\n\r\n')) {
              sock.destroy()
              resolve(out)
            }
          })
          setTimeout(() => {
            sock.destroy()
            resolve(out)
          }, 3_000)
        })
        expect(reply).toContain('200 Connection Established')
      })
    } finally {
      await upstream.close()
    }
  })

  test('a client that never ends its head is refused rather than buffered forever', async () => {
    const upstream = await startSocks5Upstream({ username: USERNAME, password: PASSWORD })
    try {
      await withListener(upstream.port, async (listener, events) => {
        const reply = await new Promise<string>((resolve) => {
          const sock = net.connect(listener.port, '127.0.0.1')
          let out = ''
          sock.on('connect', () => {
            sock.write('GET http://x/ HTTP/1.1\r\n')
            // 96 KiB of headers with no terminator — past MAX_HEAD_BYTES.
            for (let i = 0; i < 96; i++) sock.write(`X-Pad-${i}: ${'p'.repeat(1000)}\r\n`)
          })
          sock.on('data', (chunk: Buffer) => {
            out += chunk.toString('latin1')
          })
          sock.on('close', () => resolve(out))
          sock.on('error', () => resolve(out))
          setTimeout(() => {
            sock.destroy()
            resolve(out)
          }, 3_000)
        })
        expect(reply).toContain('431')
        expect(events.some((e) => e.event === 'refused' && e.reason === 'head-too-large')).toBe(true)
      })
    } finally {
      await upstream.close()
    }
  })
})

describe('maxConnections', () => {
  test('a client past the cap gets a 503 and its own logged reason, and the ones under it are unaffected', async () => {
    const upstream = await startSocks5Upstream({ username: USERNAME, password: PASSWORD })
    try {
      await withListener(
        upstream.port,
        async (listener, events) => {
          const held: net.Socket[] = []
          // Fill the cap with CONNECT tunnels that stay open.
          for (let i = 0; i < 2; i++) {
            const sock = net.connect(listener.port, '127.0.0.1')
            await new Promise<void>((resolve) => {
              sock.on('connect', () => sock.write(`CONNECT 127.0.0.1:${PLAIN_PORT} HTTP/1.1\r\n\r\n`))
              sock.on('data', () => resolve())
              sock.on('error', () => resolve())
            })
            held.push(sock)
          }
          expect(listener.live.size).toBe(2)

          const reply = await rawRequest(listener.port, `CONNECT 127.0.0.1:${PLAIN_PORT} HTTP/1.1\r\n\r\n`)
          expect(reply).toContain('503 Service Unavailable')
          expect(events.some((e) => e.event === 'refused' && e.reason === 'max-connections')).toBe(true)
          // The cap refused, it did not drop: the held tunnels are still live.
          expect(listener.live.size).toBe(2)
          for (const sock of held) sock.destroy()
        },
        { maxConnections: 2 },
      )
    } finally {
      await upstream.close()
    }
  })
})
