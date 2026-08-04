import type { ZodType } from 'zod'
import {
  GUEST_AGENT_PROTOCOL,
  GuestAgentResponseSchema,
  HelloRequestSchema,
  HelloResultSchema,
  PingRequestSchema,
  PingResultSchema,
  RouteStartRequestSchema,
  RouteStartResultSchema,
  RouteStatusRequestSchema,
  RouteStatusResultSchema,
  RouteStopRequestSchema,
  RouteStopResultSchema,
  EgressProbeRequestSchema,
  EgressProbeResultSchema,
  RouteHoldRequestSchema,
  RouteHoldResultSchema,
  type GuestAgentErrorCode,
  type GuestAgentRequest,
  type HelloResult,
  type PingResult,
  type RouteStartResult,
  type RouteStatusResult,
  type RouteStopResult,
  type EgressProbeResult,
  type RouteHoldResult,
  type Socks5RouteConfig,
} from '@enkaku/protocol'

/**
 * The host-side client for the guest agent's control channel (plan 44 §4.4,
 * §5.5). Every call opens its own short-lived TCP connection to the forwarded
 * port, writes exactly one newline-delimited JSON request, reads exactly one
 * line back, and closes — mirroring the agent's own accept-handle-close loop
 * (verified against a real device by `scripts/guest-agent.ts`, plan 44 §5.1),
 * rather than assuming a persistent multiplexed connection the agent does not
 * actually offer.
 */

/** Coded failures — callers match on `.code`, never on `.message` (CLAUDE.md). */
export type GuestAgentClientErrorCode =
  | GuestAgentErrorCode
  | 'E_TIMEOUT'
  | 'E_TRANSPORT'
  | 'E_PROTOCOL_MISMATCH'
  | 'E_UNEXPECTED_RESPONSE'

export class GuestAgentClientError extends Error {
  constructor(
    public code: GuestAgentClientErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'GuestAgentClientError'
  }
}

/** The minimal surface this client needs from a connected socket — matches `Bun.Socket`. */
export interface GuestAgentSocketHandle {
  write(data: string): number | void
  end(): void
}

export interface GuestAgentSocketHandlers {
  data(socket: GuestAgentSocketHandle, data: Uint8Array): void
  close(socket: GuestAgentSocketHandle): void
  error(socket: GuestAgentSocketHandle, error: Error): void
  connectError?(socket: GuestAgentSocketHandle, error: Error): void
}

/**
 * Stands in for `Bun.connect` so tests can fake the wire without a real
 * socket — same shape as `Bun.connect`'s own options/return, so the default
 * below is a one-line pass-through.
 */
export type GuestAgentConnect = (opts: {
  hostname: string
  port: number
  socket: GuestAgentSocketHandlers
}) => Promise<GuestAgentSocketHandle>

const defaultConnect: GuestAgentConnect = (opts) => Bun.connect(opts) as unknown as Promise<GuestAgentSocketHandle>

export interface GuestAgentClientOptions {
  /** The host port `adb forward` bound the device's control socket to. */
  port: number
  /** The pairing token handed to the agent via `launcher.bootstrap(token)`. */
  token: string
  /** Defaults to `Bun.connect`; injected so tests can fake the wire (plan 44 §5.5). */
  connect?: GuestAgentConnect
  /** Per-call timeout in ms — a hung socket must not park a caller forever. Default 15000. */
  timeoutMs?: number
  /**
   * `hello()` retries its connect+handshake this many times. Verified on real hardware (plan 44
   * §5.1): the agent binds its control socket a moment after process start, and a cold start
   * after `force-stop` is slower than a warm one — a fixed sleep produced a spurious failure
   * during bring-up, so this retries instead of guessing at a delay. Default 8.
   */
  handshakeRetries?: number
  /** Delay between handshake retries in ms. Default 500. */
  handshakeRetryDelayMs?: number
  onLog?: (level: 'debug' | 'info' | 'warn', msg: string) => void
}

export interface GuestAgentClient {
  hello(): Promise<HelloResult>
  ping(): Promise<PingResult>
  routeStart(config: Socks5RouteConfig): Promise<RouteStartResult>
  routeStop(): Promise<RouteStopResult>
  routeStatus(): Promise<RouteStatusResult>
  /**
   * Plan 51 §4.2, §5.4. Always present on this interface — like every other method here, the wire
   * request can always be sent; whether the agent actually understands it is a property of the
   * INSTALLED BUILD, discovered from `hello().capabilities` (`'egress-probe'`), not of this client.
   * An older build answers `E_UNKNOWN_METHOD`, which callers treat as "this check cannot run" (a
   * `skip`), never as a route failure.
   */
  egressProbe(url: string, timeoutMs: number): Promise<EgressProbeResult>
  /**
   * Plan 55 §3.5, §4.1, §5.6. Same "always present on the client, gated on `hello().capabilities`"
   * treatment as `egressProbe` above — an older build answers `E_UNKNOWN_METHOD`, which callers
   * treat as "cannot force a hold" rather than a route failure.
   */
  routeHold(reason: string): Promise<RouteHoldResult>
}

/** One connect → write one line → read one line → close, with a hard timeout. */
function sendOnce(connect: GuestAgentConnect, port: number, timeoutMs: number, line: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false
    let sock: GuestAgentSocketHandle | undefined
    const chunks: string[] = []
    const decoder = new TextDecoder()

    const timer = setTimeout(() => {
      finish(() => {
        try {
          sock?.end()
        } catch {
          // already gone — nothing to clean up
        }
        reject(new GuestAgentClientError('E_TIMEOUT', `guest agent did not respond within ${timeoutMs}ms`))
      })
    }, timeoutMs)

    function finish(fn: () => void): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }

    connect({
      hostname: '127.0.0.1',
      port,
      socket: {
        data(s, data) {
          chunks.push(decoder.decode(data, { stream: true }))
          const joined = chunks.join('')
          const nl = joined.indexOf('\n')
          if (nl === -1) return
          finish(() => {
            try {
              s.end()
            } catch {
              // already gone — nothing to clean up
            }
            resolve(joined.slice(0, nl))
          })
        },
        close() {
          finish(() =>
            reject(new GuestAgentClientError('E_TRANSPORT', 'guest agent closed the connection before responding')),
          )
        },
        error(_s, err) {
          finish(() => reject(new GuestAgentClientError('E_TRANSPORT', `guest agent socket error: ${err.message}`)))
        },
        connectError(_s, err) {
          finish(() =>
            reject(new GuestAgentClientError('E_TRANSPORT', `could not connect to 127.0.0.1:${port}: ${err.message}`)),
          )
        },
      },
    })
      .then((s) => {
        sock = s
        s.write(`${line}\n`)
      })
      .catch((err: unknown) => {
        finish(() =>
          reject(new GuestAgentClientError('E_TRANSPORT', `could not connect to 127.0.0.1:${port}: ${String(err)}`)),
        )
      })
  })
}

/** Send one request, parse+validate the envelope, and validate+return its typed result. */
async function call<TResult>(
  connect: GuestAgentConnect,
  port: number,
  timeoutMs: number,
  request: GuestAgentRequest,
  resultSchema: ZodType<TResult>,
): Promise<TResult> {
  const raw = await sendOnce(connect, port, timeoutMs, JSON.stringify(request))

  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (err) {
    throw new GuestAgentClientError('E_UNEXPECTED_RESPONSE', `guest agent response was not valid JSON: ${String(err)}`)
  }

  const envelope = GuestAgentResponseSchema.safeParse(json)
  if (!envelope.success) {
    throw new GuestAgentClientError(
      'E_UNEXPECTED_RESPONSE',
      `guest agent response did not match the wire schema: ${envelope.error.message}`,
    )
  }

  if (!envelope.data.ok) {
    // Carries the agent's own code so callers match on it, never on message text (CLAUDE.md).
    throw new GuestAgentClientError(envelope.data.error.code, envelope.data.error.message)
  }

  const result = resultSchema.safeParse(envelope.data.result)
  if (!result.success) {
    throw new GuestAgentClientError(
      'E_UNEXPECTED_RESPONSE',
      `guest agent ${request.method} result did not match its schema: ${result.error.message}`,
    )
  }
  return result.data
}

/**
 * Newline-delimited-JSON client for the guest agent's control channel
 * (plan 44 §4.2, §4.4). Talks to `127.0.0.1:<port>` — the host end of the
 * `adb forward` set up by `launcher.ts`.
 */
export function createGuestAgentClient(opts: GuestAgentClientOptions): GuestAgentClient {
  const connect = opts.connect ?? defaultConnect
  const timeoutMs = opts.timeoutMs ?? 15_000
  const handshakeRetries = opts.handshakeRetries ?? 8
  const handshakeRetryDelayMs = opts.handshakeRetryDelayMs ?? 500

  return {
    async hello() {
      let lastErr: unknown
      for (let attempt = 1; attempt <= handshakeRetries; attempt++) {
        try {
          const req = HelloRequestSchema.parse({ id: crypto.randomUUID(), token: opts.token, method: 'hello' })
          const result = await call(connect, opts.port, timeoutMs, req, HelloResultSchema)
          if (result.protocol !== GUEST_AGENT_PROTOCOL) {
            // Refuse rather than degrade (CLAUDE.md, plan 44 §4.2): a major-version mismatch
            // means the request/response shapes may differ in ways this client cannot safely
            // guess at, so this is not retried below — a different protocol version will not
            // become the right one by waiting.
            throw new GuestAgentClientError(
              'E_PROTOCOL_MISMATCH',
              `guest agent speaks protocol ${result.protocol}, this host expects ${GUEST_AGENT_PROTOCOL}`,
            )
          }
          return result
        } catch (err) {
          if (err instanceof GuestAgentClientError && err.code === 'E_PROTOCOL_MISMATCH') throw err
          lastErr = err
          if (attempt === handshakeRetries) break
          opts.onLog?.(
            'debug',
            `guest agent hello attempt ${attempt}/${handshakeRetries} failed, retrying in ${handshakeRetryDelayMs}ms: ${String(err)}`,
          )
          await Bun.sleep(handshakeRetryDelayMs)
        }
      }
      throw lastErr
    },

    ping() {
      const req = PingRequestSchema.parse({ id: crypto.randomUUID(), token: opts.token, method: 'ping' })
      return call(connect, opts.port, timeoutMs, req, PingResultSchema)
    },

    routeStart(config) {
      const req = RouteStartRequestSchema.parse({
        id: crypto.randomUUID(),
        token: opts.token,
        method: 'route.start',
        config,
      })
      return call(connect, opts.port, timeoutMs, req, RouteStartResultSchema)
    },

    routeStop() {
      const req = RouteStopRequestSchema.parse({ id: crypto.randomUUID(), token: opts.token, method: 'route.stop' })
      return call(connect, opts.port, timeoutMs, req, RouteStopResultSchema)
    },

    routeStatus() {
      const req = RouteStatusRequestSchema.parse({
        id: crypto.randomUUID(),
        token: opts.token,
        method: 'route.status',
      })
      return call(connect, opts.port, timeoutMs, req, RouteStatusResultSchema)
    },

    egressProbe(url, probeTimeoutMs) {
      const req = EgressProbeRequestSchema.parse({
        id: crypto.randomUUID(),
        token: opts.token,
        method: 'egress.probe',
        url,
        timeoutMs: probeTimeoutMs,
      })
      // The device measures BOTH legs sequentially, each individually bounded by `probeTimeoutMs`
      // (`EgressProbe.run` in the Kotlin), and `ControlService` itself waits up to
      // `probeTimeoutMs * 2 + 5_000` for that — this socket-level timeout must outlive the
      // device's own budget, or a slow but genuinely still-running probe would be cut off here
      // before the agent ever answers.
      return call(connect, opts.port, Math.max(timeoutMs, probeTimeoutMs * 2 + 10_000), req, EgressProbeResultSchema)
    },

    routeHold(reason) {
      const req = RouteHoldRequestSchema.parse({
        id: crypto.randomUUID(),
        token: opts.token,
        method: 'route.hold',
        reason,
      })
      return call(connect, opts.port, timeoutMs, req, RouteHoldResultSchema)
    },
  }
}
