import net from 'node:net'
import './socket'

/**
 * The test fixtures, promoted out of the scratchpad feasibility probe into the
 * pack's own tree (plan 112 §7).
 *
 * **These are real servers, not mocks, and that is the point.** A mock SOCKS5
 * upstream proves that our client sends the bytes our mock expects. A real one
 * — with RFC 1929 username/password sub-negotiation, because auth is what the
 * owner's actual proxies use — proves the handshake. The probe that these came
 * from is what caught the finding in plan 112 §0.2, and it caught it precisely
 * because the client was a real HTTP-proxy client rather than a hand-rolled
 * approximation of one.
 */

export interface Fixture {
  readonly port: number
  close(): Promise<void>
}

/** Bind on an ephemeral port and resolve once it is listening. */
function listen(server: net.Server): Promise<number> {
  return new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(typeof address === 'object' && address !== null ? address.port : 0)
    })
  })
}

function closer(server: net.Server, sockets: Set<net.Socket>): () => Promise<void> {
  return () =>
    new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy()
      server.close(() => resolve())
    })
}

export interface Socks5Fixture extends Fixture {
  /** Whether the last authentication attempt presented the expected credentials. */
  readonly authAccepted: boolean
  /** How many CONNECTs reached a real TCP dial. */
  readonly connects: number
  /** Every username the fixture was offered, so a test can assert what was actually sent. */
  readonly usernamesSeen: string[]
  /**
   * Every destination the fixture was asked for, as `host:port`.
   *
   * Recorded because without it the three address-type tests are vacuous: this
   * fixture dials `127.0.0.1:<port>` whatever it is given, so a listener that
   * parsed an IPv6 request and forwarded the wrong host would still make them
   * pass. Parsed here independently of `listen-socks5.ts`'s own parser, on
   * purpose — a fixture that shared the code under test would agree with it
   * about a bug.
   */
  readonly destinationsSeen: string[]
}

/** An RFC 1928 request's destination, parsed independently of the listener's own parser. */
function readDestination(buf: Buffer): string {
  const atyp = buf[3] ?? 0
  if (atyp === 0x01) return `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}:${buf.readUInt16BE(8)}`
  if (atyp === 0x03) {
    const len = buf[4] ?? 0
    return `${buf.subarray(5, 5 + len).toString()}:${buf.readUInt16BE(5 + len)}`
  }
  if (atyp === 0x04) {
    const groups: string[] = []
    for (let i = 0; i < 8; i++) groups.push(buf.readUInt16BE(4 + i * 2).toString(16))
    return `${groups.join(':')}:${buf.readUInt16BE(20)}`
  }
  return `?atyp=${atyp}`
}

/**
 * A minimal RFC 1928 + RFC 1929 SOCKS5 server.
 *
 * With `username`/`password` set it **demands** method X'02' and validates the
 * credentials; without them it accepts X'00'. Only CONNECT to an IPv4 or
 * domain destination on loopback is implemented — everything this pack's
 * dialler can ask of it, and nothing more.
 */
export async function startSocks5Upstream(opts: { username?: string; password?: string } = {}): Promise<Socks5Fixture> {
  const sockets = new Set<net.Socket>()
  const state = { authAccepted: false, connects: 0, usernamesSeen: [] as string[], destinationsSeen: [] as string[] }
  const wantsAuth = Boolean(opts.username)

  const server = net.createServer((sock) => {
    sockets.add(sock)
    sock.on('close', () => sockets.delete(sock))
    let stage: 'greet' | 'auth' | 'request' | 'piping' = 'greet'

    sock.on('data', (buf: Buffer) => {
      if (stage === 'greet') {
        sock.write(Buffer.from([0x05, wantsAuth ? 0x02 : 0x00]))
        stage = wantsAuth ? 'auth' : 'request'
        return
      }
      if (stage === 'auth') {
        const ulen = buf[1] ?? 0
        const user = buf.subarray(2, 2 + ulen).toString()
        const plen = buf[2 + ulen] ?? 0
        const pass = buf.subarray(3 + ulen, 3 + ulen + plen).toString()
        state.usernamesSeen.push(user)
        const ok = user === opts.username && pass === opts.password
        state.authAccepted = ok
        sock.write(Buffer.from([0x01, ok ? 0x00 : 0x01]))
        if (!ok) {
          sock.end()
          return
        }
        stage = 'request'
        return
      }
      if (stage === 'request') {
        state.destinationsSeen.push(readDestination(buf))
        const port = buf.readUInt16BE(buf.length - 2)
        const out = net.connect(port, '127.0.0.1', () => {
          state.connects++
          sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
          stage = 'piping'
          sock.pipe(out)
          out.pipe(sock)
        })
        out.on('error', () => sock.end())
      }
    })
    sock.on('error', () => {})
  })

  const port = await listen(server)
  return {
    port,
    get authAccepted() {
      return state.authAccepted
    },
    get connects() {
      return state.connects
    },
    get usernamesSeen() {
      return state.usernamesSeen
    },
    get destinationsSeen() {
      return state.destinationsSeen
    },
    close: closer(server, sockets),
  }
}

export interface HttpProxyFixture extends Fixture {
  readonly connects: number
  /** Every `Proxy-Authorization` header value seen, verbatim, so a test can decode what was sent. */
  readonly authHeaders: string[]
}

/** A minimal HTTP proxy that serves `CONNECT` and nothing else. */
export async function startHttpUpstream(opts: { requireAuth?: boolean } = {}): Promise<HttpProxyFixture> {
  const sockets = new Set<net.Socket>()
  const state = { connects: 0, authHeaders: [] as string[] }

  const server = net.createServer((client) => {
    sockets.add(client)
    client.on('close', () => sockets.delete(client))
    let head = ''
    const onData = (chunk: Buffer): void => {
      head += chunk.toString('latin1')
      const end = head.indexOf('\r\n\r\n')
      if (end === -1) return
      client.removeListener('data', onData)
      const line = head.slice(0, head.indexOf('\r\n'))
      const auth = /proxy-authorization:\s*(\S+ \S+)/i.exec(head)
      if (auth?.[1]) state.authHeaders.push(auth[1])
      if (opts.requireAuth && !auth) {
        client.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n')
        return
      }
      const match = /^CONNECT (\S+):(\d+) HTTP\/1\.[01]$/.exec(line)
      if (!match) {
        client.end('HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\n\r\n')
        return
      }
      const out = net.connect(Number(match[2]), '127.0.0.1', () => {
        state.connects++
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        client.pipe(out)
        out.pipe(client)
      })
      out.on('error', () => client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n'))
    }
    client.on('data', onData)
    client.on('error', () => {})
  })

  const port = await listen(server)
  return {
    port,
    get connects() {
      return state.connects
    },
    get authHeaders() {
      return state.authHeaders
    },
    close: closer(server, sockets),
  }
}

/** H3 fixture 2: accepts TCP and never says another word. */
export async function startSilentUpstream(): Promise<Fixture> {
  const sockets = new Set<net.Socket>()
  const server = net.createServer((sock) => {
    sockets.add(sock)
    sock.on('close', () => sockets.delete(sock))
    sock.on('error', () => {})
  })
  return { port: await listen(server), close: closer(server, sockets) }
}

/** H3 fixture 3: completes the whole SOCKS5 handshake, then swallows everything. */
export async function startBlackHoleUpstream(): Promise<Fixture> {
  const sockets = new Set<net.Socket>()
  const server = net.createServer((sock) => {
    sockets.add(sock)
    sock.on('close', () => sockets.delete(sock))
    let stage: 'greet' | 'request' | 'dead' = 'greet'
    sock.on('data', () => {
      if (stage === 'greet') {
        sock.write(Buffer.from([0x05, 0x00]))
        stage = 'request'
        return
      }
      if (stage === 'request') {
        sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
        stage = 'dead'
      }
      // Anything after the reply is swallowed. This is the failure `socks`'s
      // own timeout cannot see: the handshake succeeded, so it is disarmed.
    })
    sock.on('error', () => {})
  })
  return { port: await listen(server), close: closer(server, sockets) }
}

/** H3 fixture 1: a port that was bound long enough to learn its number, and is now closed. */
export async function reserveClosedPort(): Promise<number> {
  const server = net.createServer()
  const port = await listen(server)
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}
