import net from 'node:net'
import type { BridgeSocket } from './socket'
import { ProxyError, classifyDialError } from './errors'
import { describeUpstream, type Upstream, type UpstreamTarget } from './upstream'

/**
 * The HTTP upstream dial: `CONNECT host:port`, read one status line, assert
 * 2xx (plan 112 §3.2, §4.4).
 *
 * Ours rather than a dependency, and the reason is the same one that made the
 * SOCKS5 side a dependency: this is twenty lines and a second npm package for
 * it would be a worse trade than writing them. There is no HTTP parsing here
 * beyond finding the end of the head and reading the status line, because
 * there is nothing else in a CONNECT response worth reading.
 *
 * **The one subtlety, and it is a real bug if it is missed.** A server may put
 * the first bytes of the tunnel in the same TCP segment as the `200` response.
 * Whatever follows `\r\n\r\n` therefore belongs to the caller, not to us, and
 * is pushed back with `socket.unshift` before the socket is handed over. Drop
 * it and the first few bytes of every response vanish, intermittently, under
 * load only.
 */

export interface HttpUpstreamOptions {
  host: string
  port: number
  username: string
  password: string
  timeoutMs: number
}

/** The head may not exceed this before we give up — a server that never sends `\r\n\r\n` must not grow a buffer forever. */
const MAX_HEAD_BYTES = 16 * 1024

export function createHttpUpstream(opts: HttpUpstreamOptions): Upstream {
  const secrets = [opts.password].filter((s) => s.length > 0)
  // Built once, so the only place the password is ever encoded is here — and
  // this string is never logged, never returned, and never put in an error.
  const authorization = opts.username ? `Proxy-Authorization: Basic ${Buffer.from(`${opts.username}:${opts.password}`).toString('base64')}\r\n` : ''

  return {
    description: describeUpstream('http', opts.host, opts.port, opts.username),

    connect(dest: UpstreamTarget): Promise<BridgeSocket> {
      if (!opts.host || opts.port < 1) {
        return Promise.reject<BridgeSocket>(new ProxyError('E_PROXY_UPSTREAM_DIAL', 'this record names no upstream host and port'))
      }
      return new Promise<BridgeSocket>((resolve, reject) => {
        let settled = false
        let head = Buffer.alloc(0)
        const socket = net.connect({ host: opts.host, port: opts.port })

        const timer = setTimeout(() => {
          fail(new ProxyError('E_PROXY_UPSTREAM_TIMEOUT', `the upstream proxy did not answer CONNECT within ${opts.timeoutMs} ms`))
        }, opts.timeoutMs)

        function cleanup(): void {
          clearTimeout(timer)
          socket.removeListener('data', onData)
          socket.removeListener('error', onError)
          socket.removeListener('close', onClose)
        }

        function fail(err: unknown): void {
          if (settled) return
          settled = true
          cleanup()
          socket.destroy()
          reject(classifyDialError(err, secrets))
        }

        function succeed(rest: Buffer): void {
          if (settled) return
          settled = true
          cleanup()
          // Whatever came after the head is the tunnel's first bytes. Push it
          // back so the caller's `pipe` sees it.
          //
          // `pause()` first, and it is not optional: removing the last `data`
          // listener does NOT take a stream out of flowing mode, so an
          // `unshift` here would be re-emitted immediately — to nobody — and
          // silently discarded. Proved by the test in `dial-http.test.ts`,
          // which failed exactly this way before the `pause()` was added.
          if (rest.length > 0) {
            socket.pause()
            socket.unshift(rest)
          }
          resolve(socket)
        }

        function onData(chunk: Buffer): void {
          head = Buffer.concat([head, chunk])
          const end = head.indexOf('\r\n\r\n')
          if (end === -1) {
            if (head.length > MAX_HEAD_BYTES) {
              fail(new ProxyError('E_PROXY_UPSTREAM_PROTOCOL', 'the upstream proxy sent a CONNECT response head larger than this bridge will read'))
            }
            return
          }
          const statusLine = head.subarray(0, head.indexOf('\r\n') === -1 ? end : head.indexOf('\r\n')).toString('latin1')
          const match = /^HTTP\/1\.[01] (\d{3})/.exec(statusLine)
          if (!match) {
            fail(new ProxyError('E_PROXY_UPSTREAM_PROTOCOL', `the upstream proxy answered CONNECT with something that is not an HTTP status line: ${JSON.stringify(statusLine.slice(0, 80))}`))
            return
          }
          const status = Number(match[1])
          if (status === 407 || status === 401) {
            fail(new ProxyError('E_PROXY_UPSTREAM_AUTH', `the upstream proxy refused this account (HTTP ${status})`))
            return
          }
          if (status < 200 || status > 299) {
            fail(new ProxyError('E_PROXY_UPSTREAM_PROTOCOL', `the upstream proxy refused CONNECT with HTTP ${status}`))
            return
          }
          succeed(head.subarray(end + 4))
        }

        function onError(err: unknown): void {
          fail(err)
        }

        function onClose(): void {
          fail(new ProxyError('E_PROXY_UPSTREAM_PROTOCOL', 'the upstream proxy closed the connection before answering CONNECT'))
        }

        socket.on('data', onData)
        socket.on('error', onError)
        socket.on('close', onClose)
        socket.on('connect', () => {
          const target = `${dest.host}:${dest.port}`
          socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${authorization}\r\n`)
        })
      })
    },
  }
}
