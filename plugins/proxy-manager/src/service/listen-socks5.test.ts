import { afterAll, describe, expect, test } from 'bun:test'
import net from 'node:net'
import { createSocks5Upstream } from './dial-socks5'
import { startSocks5Upstream } from './fixtures'
import {
  ATYP_DOMAIN,
  ATYP_IPV4,
  ATYP_IPV6,
  CMD_BIND,
  CMD_CONNECT,
  CMD_UDP_ASSOCIATE,
  METHOD_NONE_ACCEPTABLE,
  METHOD_NO_AUTH,
  METHOD_USERNAME_PASSWORD,
  REPLY_COMMAND_NOT_SUPPORTED,
  createSocks5Listener,
  parseSocks5Greeting,
  parseSocks5Request,
  socks5Reply,
} from './listen-socks5'
import type { BridgeEvent } from './logbook'
import type { Listener } from './listener'

/** Plan 112 step 112.6 — the SOCKS5 listener: RFC 1928 framing, all three address types, and X'07' for what a bridge cannot do. */

const USERNAME = 'country-id-r9931204'
const PASSWORD = 'Sup3rSecretUpstreamPassword'

const plain = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('hello-from-plain-http') })

/** `Bun.serve().port` is `number | undefined` in the types; a served fixture always has one, and a missing one must fail loudly. */
function servedPort(server: { port?: number }): number {
  if (typeof server.port !== 'number') throw new Error('Bun.serve did not report a port')
  return server.port
}
const PLAIN_PORT = servedPort(plain)
afterAll(() => plain.stop(true))

async function withListener(upstreamPort: number, fn: (listener: Listener, events: BridgeEvent[]) => Promise<void>): Promise<void> {
  const events: BridgeEvent[] = []
  const listener = await createSocks5Listener({
    bindHost: '127.0.0.1',
    port: 0,
    upstream: createSocks5Upstream({ host: '127.0.0.1', port: upstreamPort, username: USERNAME, password: PASSWORD, timeoutMs: 5_000 }),
    maxConnections: 16,
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

/** Drive the bridge as a SOCKS5 client, one scripted step at a time. */
function socksClient(port: number): {
  send: (bytes: Buffer) => void
  next: (n: number) => Promise<Buffer>
  connected: Promise<void>
  close: () => void
} {
  const sock = net.connect(port, '127.0.0.1')
  let buffered = Buffer.alloc(0)
  let waiting: { want: number; resolve: (b: Buffer) => void } | null = null
  const pump = (): void => {
    if (waiting && buffered.length >= waiting.want) {
      const take = buffered.subarray(0, waiting.want)
      buffered = buffered.subarray(waiting.want)
      const { resolve } = waiting
      waiting = null
      resolve(take)
    }
  }
  sock.on('data', (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk])
    pump()
  })
  sock.on('error', () => {})
  return {
    send: (bytes) => sock.write(bytes),
    next: (n) =>
      new Promise<Buffer>((resolve) => {
        waiting = { want: n, resolve }
        pump()
        setTimeout(() => {
          if (waiting) {
            waiting = null
            resolve(Buffer.alloc(0))
          }
        }, 3_000)
      }),
    connected: new Promise<void>((resolve) => sock.on('connect', () => resolve())),
    close: () => sock.destroy(),
  }
}

const greeting = (...methods: number[]) => Buffer.from([0x05, methods.length, ...methods])

function connectRequest(atyp: number, host: string, port: number): Buffer {
  const head = Buffer.from([0x05, CMD_CONNECT, 0x00, atyp])
  const portBytes = Buffer.alloc(2)
  portBytes.writeUInt16BE(port)
  if (atyp === ATYP_IPV4) return Buffer.concat([head, Buffer.from(host.split('.').map(Number)), portBytes])
  if (atyp === ATYP_DOMAIN) return Buffer.concat([head, Buffer.from([host.length]), Buffer.from(host), portBytes])
  const v6 = Buffer.alloc(16)
  v6[15] = 1 // ::1
  return Buffer.concat([head, v6, portBytes])
}

describe('the framing parsers, on their own', () => {
  test('the greeting reports the methods and its own length, and asks for more when it is short', () => {
    expect(parseSocks5Greeting(Buffer.from([0x05]))).toEqual({ kind: 'need-more' })
    expect(parseSocks5Greeting(Buffer.from([0x05, 0x02, 0x00]))).toEqual({ kind: 'need-more' })
    expect(parseSocks5Greeting(greeting(0x00, 0x02))).toEqual({ kind: 'ok', methods: [0x00, 0x02], length: 4 })
    expect(parseSocks5Greeting(Buffer.from([0x04, 0x01, 0x00]))).toEqual({ kind: 'bad' })
  })

  test('every address type parses, and `length` is where the tunnel’s own bytes begin', () => {
    const ipv4 = parseSocks5Request(connectRequest(ATYP_IPV4, '10.4.0.9', 8080))
    expect(ipv4).toEqual({ kind: 'ok', request: { command: CMD_CONNECT, atyp: ATYP_IPV4, host: '10.4.0.9', port: 8080, length: 10 } })

    const domain = parseSocks5Request(connectRequest(ATYP_DOMAIN, 'api.ipify.org', 443))
    expect(domain).toEqual({
      kind: 'ok',
      request: { command: CMD_CONNECT, atyp: ATYP_DOMAIN, host: 'api.ipify.org', port: 443, length: 5 + 13 + 2 },
    })

    const ipv6 = parseSocks5Request(connectRequest(ATYP_IPV6, '::1', 443))
    expect(ipv6).toEqual({ kind: 'ok', request: { command: CMD_CONNECT, atyp: ATYP_IPV6, host: '0:0:0:0:0:0:0:1', port: 443, length: 22 } })
  })

  test('a short request asks for more rather than reading past the buffer', () => {
    const full = connectRequest(ATYP_DOMAIN, 'api.ipify.org', 443)
    for (let n = 0; n < full.length; n++) expect(parseSocks5Request(full.subarray(0, n)).kind).toBe('need-more')
    expect(parseSocks5Request(full).kind).toBe('ok')
  })

  test('an unknown address type is refused rather than guessed', () => {
    expect(parseSocks5Request(Buffer.from([0x05, 0x01, 0x00, 0x09, 1, 2, 3, 4, 0, 80])).kind).toBe('bad')
  })

  test('a reply is ten bytes with a zeroed bound address', () => {
    expect([...socks5Reply(REPLY_COMMAND_NOT_SUPPORTED)]).toEqual([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
  })
})

describe('CONNECT through the bridge', () => {
  for (const [name, atyp, host, expected] of [
    ['IPv4', ATYP_IPV4, '127.0.0.1', '127.0.0.1'],
    ['a domain', ATYP_DOMAIN, 'localhost', 'localhost'],
    ['IPv6', ATYP_IPV6, '::1', '0:0:0:0:0:0:0:1'],
  ] as const) {
    test(`serves ${name} destinations`, async () => {
      const upstream = await startSocks5Upstream({ username: USERNAME, password: PASSWORD })
      try {
        await withListener(upstream.port, async (listener) => {
          const client = socksClient(listener.port)
          await client.connected
          client.send(greeting(METHOD_NO_AUTH))
          expect([...(await client.next(2))]).toEqual([0x05, METHOD_NO_AUTH])
          client.send(connectRequest(atyp, host, PLAIN_PORT))
          const reply = await client.next(10)
          expect(reply[0]).toBe(0x05)
          expect(reply[1]).toBe(0x00)
          // …and the tunnel is real, not just a well-formed reply.
          client.send(Buffer.from(`GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`))
          const body = (await client.next(17)).toString('latin1')
          expect(body.length).toBeGreaterThan(0)
          client.close()
          expect(upstream.connects).toBe(1)
          // The control that stops these three tests being one test written
          // three times: the fixture dials 127.0.0.1 whatever it is asked
          // for, so without checking what it was ASKED for, a listener that
          // parsed IPv6 and forwarded garbage would pass.
          expect(upstream.destinationsSeen).toEqual([`${expected}:${PLAIN_PORT}`])
        })
      } finally {
        await upstream.close()
      }
    })
  }

  test('a client that pipelines its first bytes behind the request does not lose them', async () => {
    const upstream = await startSocks5Upstream({ username: USERNAME, password: PASSWORD })
    try {
      await withListener(upstream.port, async (listener) => {
        const client = socksClient(listener.port)
        await client.connected
        // Greeting, request AND payload in one write — which is what a client
        // on a slow link does, and what loses the payload if the leftover
        // after the request frame is dropped instead of pushed back.
        client.send(
          Buffer.concat([
            greeting(METHOD_NO_AUTH),
            connectRequest(ATYP_IPV4, '127.0.0.1', PLAIN_PORT),
            Buffer.from('GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'),
          ]),
        )
        expect([...(await client.next(2))]).toEqual([0x05, METHOD_NO_AUTH])
        expect((await client.next(10))[1]).toBe(0x00)
        const body = (await client.next(15)).toString('latin1')
        expect(body).toContain('HTTP/1.1')
        client.close()
      })
    } finally {
      await upstream.close()
    }
  })
})

describe('what a bridge will not do, answered by the RFC’s own codes', () => {
  for (const [name, command] of [
    ['BIND', CMD_BIND],
    ['UDP ASSOCIATE', CMD_UDP_ASSOCIATE],
  ] as const) {
    test(`${name} is refused with reply X'07', not a dropped socket`, async () => {
      const upstream = await startSocks5Upstream({ username: USERNAME, password: PASSWORD })
      try {
        await withListener(upstream.port, async (listener, events) => {
          const client = socksClient(listener.port)
          await client.connected
          client.send(greeting(METHOD_NO_AUTH))
          await client.next(2)
          const request = connectRequest(ATYP_IPV4, '127.0.0.1', PLAIN_PORT)
          request[1] = command
          client.send(request)
          const reply = await client.next(10)
          // The two controls an "it is refused properly" claim needs: that a
          // reply arrived at all (a dropped socket returns an empty buffer
          // here), and that it is the RIGHT code rather than any code.
          expect(reply.length).toBe(10)
          expect(reply[1]).toBe(REPLY_COMMAND_NOT_SUPPORTED)
          expect(upstream.connects).toBe(0)
          expect(events.some((e) => e.event === 'refused')).toBe(true)
          client.close()
        })
      } finally {
        await upstream.close()
      }
    })
  }

  test('a client that will not do no-auth is told X’FF’ rather than being dropped — there is no listener-side auth in v1', async () => {
    const upstream = await startSocks5Upstream({ username: USERNAME, password: PASSWORD })
    try {
      await withListener(upstream.port, async (listener, events) => {
        const client = socksClient(listener.port)
        await client.connected
        client.send(greeting(METHOD_USERNAME_PASSWORD))
        expect([...(await client.next(2))]).toEqual([0x05, METHOD_NONE_ACCEPTABLE])
        expect(events.some((e) => e.event === 'refused' && e.reason === 'listener-auth-not-supported')).toBe(true)
        client.close()
      })
    } finally {
      await upstream.close()
    }
  })

  test('a client that offers BOTH is served, because it can speak no-auth', async () => {
    const upstream = await startSocks5Upstream({ username: USERNAME, password: PASSWORD })
    try {
      await withListener(upstream.port, async (listener) => {
        const client = socksClient(listener.port)
        await client.connected
        client.send(greeting(METHOD_NO_AUTH, METHOD_USERNAME_PASSWORD))
        expect([...(await client.next(2))]).toEqual([0x05, METHOD_NO_AUTH])
        client.close()
      })
    } finally {
      await upstream.close()
    }
  })

  test('something that is not SOCKS5 at all is refused by name', async () => {
    const upstream = await startSocks5Upstream({ username: USERNAME, password: PASSWORD })
    try {
      await withListener(upstream.port, async (listener, events) => {
        const client = socksClient(listener.port)
        await client.connected
        client.send(Buffer.from('GET / HTTP/1.1\r\n\r\n'))
        await Bun.sleep(200)
        expect(events.some((e) => e.event === 'refused' && e.reason === 'not-socks5')).toBe(true)
        client.close()
      })
    } finally {
      await upstream.close()
    }
  })
})
