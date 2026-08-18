import { messageOf, scrubSecrets } from './errors'
import type { ProxyProbeResult } from '../shared'
import type { Upstream } from './upstream'

/**
 * The egress probe — plan 117 §3.7, §4.2, §4.5: what a record's own
 * `Upstream` actually reaches when it dials out, dialled to the farm's own
 * probe endpoint rather than a third-party IP-echo site (`packages/probe-
 * server`'s own reasoning, plan 51 §3.3, applies unchanged here).
 *
 * **Dialled through the SAME `Upstream` object the record's listener holds**
 * (`service/supervisor.ts` builds one with `createUpstream()` and hands it to
 * both) — deliberately, not a fresh HTTP client of its own. That is what
 * makes the probe worth anything: it exercises the bind (`net.connect`'s own
 * `localAddress`) and, for a `direct` record with `resolveThroughEgress` on,
 * the bound resolver — the two things that can actually be wrong about an
 * egress. The listener SOCKET's own state is already reported by the
 * supervisor; probing it again would prove nothing new.
 *
 * There is no HTTP client dependency here for the same reason
 * `service/dial-http.ts` has none: a `GET` and one status line is a smaller
 * surface than a second npm package, and the request line is minimal on
 * purpose — `packages/probe-server`'s own `/probe` route answers `{ address,
 * nonce, at }` from nothing but the TCP peer address, so nothing here needs
 * to send more than a bare `GET`.
 *
 * **Plain HTTP only.** `packages/probe-server`'s own README defaults to plain
 * HTTP for exactly this round trip ("it sidesteps a real correctness trap");
 * an `ENKAKU_NETWORK_PROBE_URL` with an `https:` scheme is refused by name
 * here rather than silently sent in the clear or silently failing a TLS
 * handshake this file does not speak — see `runEgressProbe`'s own check.
 */

const MAX_HEAD_BYTES = 16 * 1024
const MAX_BODY_BYTES = 8 * 1024

/**
 * `ENKAKU_NETWORK_PROBE_URL`, trimmed. `null` means unset, which is the
 * `skip` state (§3.7) — never a false `ok`. Read fresh on every call rather
 * than cached once at setup: an operator can set or clear the variable
 * without restarting the core, and a cached `null` would keep skipping every
 * record until the next restart for no reason a person watching the screen
 * could see.
 */
export function probeUrlFromEnv(): string | null {
  return process.env.ENKAKU_NETWORK_PROBE_URL?.trim() || null
}

export interface EgressProbeOptions {
  /** The record's own upstream — see this file's header for why it must be this exact object and not a fresh one. */
  upstream: Upstream
  /** Already known non-empty — the caller (`service/supervisor.ts`) decides `skip` itself before ever building this object. */
  probeUrl: string
  timeoutMs: number
  /**
   * Scrubbed from any error text the way every other error in this pack is
   * (`errors.ts`'s `scrubSecrets`): the record's own outbound upstream
   * password, and — when this record's listener authenticates — that
   * credential's plaintext and base64 forms (`listenerAuthSecrets`). Neither
   * is ever sent to the probe endpoint; this is defence in depth over a
   * library's or a system error's own message text, the same reasoning
   * `service/supervisor.ts`'s own `startLocked` catch already applies.
   */
  secrets: readonly string[]
}

/**
 * One probe, dialled and parsed. **Never throws** — every failure becomes
 * `{ ok: false, error }` instead, because this runs off a timer and a throw
 * out of it would take the whole sweep down with it (`service/supervisor.ts`
 * still wraps the call defensively, but the contract here is "always
 * resolves" so that caller does not have to reason about which failures are
 * which).
 */
export async function runEgressProbe(opts: EgressProbeOptions): Promise<ProxyProbeResult> {
  const at = Math.floor(Date.now() / 1000)
  const startedAt = Date.now()
  try {
    const url = new URL(opts.probeUrl)
    if (url.protocol !== 'http:') {
      throw new Error(
        `the probe endpoint must be plain http — "${url.protocol}" is not spoken by this bridge's own probe (packages/probe-server's README defaults to plain http for exactly this round trip)`,
      )
    }
    const port = url.port ? Number(url.port) : 80
    const body = await fetchThroughUpstream(opts.upstream, url, port, opts.timeoutMs)
    const latencyMs = Date.now() - startedAt
    const publicAddress = parseObservedAddress(body)
    if (publicAddress === undefined) {
      return { at, ok: false, latencyMs, error: `the probe endpoint answered but named no address — got ${JSON.stringify(body.slice(0, 200))}` }
    }
    return { at, ok: true, publicAddress, latencyMs }
  } catch (err: unknown) {
    return { at, ok: false, latencyMs: Date.now() - startedAt, error: scrubSecrets(messageOf(err), opts.secrets) }
  }
}

/**
 * The observed address out of `packages/probe-server`'s own `/probe`
 * response (`{ address, nonce, at }`), tolerant of the `ip`/`origin` spellings
 * a different IP-echo service might use and, failing that, a bare literal
 * body — the same three-field fallback and the same plain-text fallback
 * `packages/core/src/network/route-checks.ts`'s `parseEgressAddress` already
 * uses for the identical question asked over the guest agent's tunnelled leg.
 * Reimplemented rather than imported: a plugin cannot import across the
 * `packages/core` boundary, and the parsing is a dozen lines either way.
 */
function parseObservedAddress(body: string): string | undefined {
  const trimmed = body.trim().slice(0, 400)
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (parsed && typeof parsed === 'object') {
      const rec = parsed as Record<string, unknown>
      const address = rec.ip ?? rec.address ?? rec.origin
      if (typeof address === 'string' && address.length > 0) return address
    }
  } catch {
    // Not JSON — fall through to the plain-text shape below.
  }
  return /^[0-9a-f.:]+$/i.test(trimmed) ? trimmed : undefined
}

/**
 * `GET` one path over `upstream`'s own connection, return the body.
 *
 * The head-parsing shape mirrors `service/dial-http.ts`'s CONNECT reader:
 * accumulate until `\r\n\r\n`, bounded by `MAX_HEAD_BYTES`, read a status
 * line, and only then read a body — bounded by `MAX_BODY_BYTES` and by
 * `Content-Length` when the response carries one, or by the connection
 * closing when it does not (this file always sends `Connection: close`, so
 * that is the expected shape for a response with no length).
 */
async function fetchThroughUpstream(upstream: Upstream, url: URL, port: number, timeoutMs: number): Promise<string> {
  const socket = await upstream.connect({ host: url.hostname, port })
  return new Promise<string>((resolve, reject) => {
    let settled = false
    let head = Buffer.alloc(0)
    let bodyBuf = Buffer.alloc(0)
    let headParsed = false
    let contentLength: number | null = null

    const timer = setTimeout(() => {
      fail(new Error(`the probe endpoint did not answer within ${timeoutMs} ms`))
    }, timeoutMs)

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
      reject(err)
    }

    function succeed(text: string): void {
      if (settled) return
      settled = true
      cleanup()
      socket.end()
      resolve(text)
    }

    function onData(chunk: Buffer): void {
      if (!headParsed) {
        head = Buffer.concat([head, chunk])
        const end = head.indexOf('\r\n\r\n')
        if (end === -1) {
          if (head.length > MAX_HEAD_BYTES) fail(new Error('the probe endpoint sent a response head larger than this bridge will read'))
          return
        }
        headParsed = true
        const headerText = head.subarray(0, end).toString('latin1')
        const firstLineEnd = headerText.indexOf('\r\n')
        const statusLine = firstLineEnd === -1 ? headerText : headerText.slice(0, firstLineEnd)
        const match = /^HTTP\/1\.[01] (\d{3})/.exec(statusLine)
        if (!match) {
          fail(new Error(`the probe endpoint answered with something that is not an HTTP status line: ${JSON.stringify(statusLine.slice(0, 80))}`))
          return
        }
        const status = Number(match[1])
        if (status < 200 || status > 299) {
          fail(new Error(`the probe endpoint answered HTTP ${status}`))
          return
        }
        const clMatch = /content-length:\s*(\d+)/i.exec(headerText)
        contentLength = clMatch?.[1] ? Number(clMatch[1]) : null
        bodyBuf = head.subarray(end + 4)
        if (contentLength !== null && bodyBuf.length >= contentLength) {
          succeed(bodyBuf.subarray(0, contentLength).toString('utf8'))
          return
        }
        if (bodyBuf.length > MAX_BODY_BYTES) fail(new Error('the probe endpoint sent a response body larger than this bridge will read'))
        return
      }
      bodyBuf = Buffer.concat([bodyBuf, chunk])
      if (bodyBuf.length > MAX_BODY_BYTES) {
        fail(new Error('the probe endpoint sent a response body larger than this bridge will read'))
        return
      }
      if (contentLength !== null && bodyBuf.length >= contentLength) succeed(bodyBuf.subarray(0, contentLength).toString('utf8'))
    }

    function onError(err: unknown): void {
      fail(err)
    }

    function onClose(): void {
      if (settled) return
      // No `Content-Length` and the connection closed — the body is whatever
      // arrived, exactly what `Connection: close` below is asking the server
      // to do at the end of a short JSON reply.
      if (contentLength === null && bodyBuf.length > 0) {
        succeed(bodyBuf.toString('utf8'))
        return
      }
      fail(new Error('the probe endpoint closed the connection before answering'))
    }

    socket.on('data', onData)
    socket.on('error', onError)
    socket.on('close', onClose)
    // `Upstream.connect`'s own doc: the socket may come back PAUSED with
    // bytes already buffered (an upstream that packed its handshake reply and
    // the tunnel's first bytes into one segment). `resume()` AFTER the
    // listeners are attached, never before — see `dial-http.test.ts`'s own
    // proof that a bare `on('data')` after an explicit `pause()` does not.
    socket.resume()
    socket.write(`GET ${url.pathname || '/'}${url.search} HTTP/1.1\r\nHost: ${url.host}\r\nConnection: close\r\nAccept: application/json\r\n\r\n`)
  })
}
