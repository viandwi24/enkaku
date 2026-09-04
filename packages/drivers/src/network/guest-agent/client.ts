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
  LocationSetRequestSchema,
  LocationSetResultSchema,
  LocationClearRequestSchema,
  LocationClearResultSchema,
  LabelApplyRequestSchema,
  LabelApplyResultSchema,
  LabelStatusRequestSchema,
  LabelStatusResultSchema,
  LabelClearRequestSchema,
  LabelClearResultSchema,
  TextCommitRequestSchema,
  TextCommitResultSchema,
  TextStatusRequestSchema,
  TextStatusResultSchema,
  UiDumpRequestSchema,
  UiDumpResultSchema,
  UiFindRequestSchema,
  UiFindResultSchema,
  ActivitySetRequestSchema,
  ActivitySetResultSchema,
  DeviceDescribeRequestSchema,
  DeviceDescribeResultSchema,
  TextPrefsRequestSchema,
  TextPrefsResultSchema,
  UiStatusRequestSchema,
  UiStatusResultSchema,
  type GuestAgentErrorCode,
  type GuestAgentRequest,
  type HelloResult,
  type PingResult,
  type RouteStartResult,
  type RouteStatusResult,
  type RouteStopResult,
  type EgressProbeResult,
  type RouteHoldResult,
  type LocationSetResult,
  type LocationClearResult,
  type LabelApplyResult,
  type LabelStatusResult,
  type LabelClearResult,
  type TextCommitResult,
  type TextStatusResult,
  type Socks5RouteConfig,
  type UiDumpResult,
  type UiFindResult,
  type ActivitySetResult,
  type DeviceDescribeResult,
  type TextPrefsResult,
  type UiStatusResult,
  type GuestAgentActivity,
  type GuestAgentVideo,
  type Selector,
} from '@enkaku/protocol'

/**
 * The host-side client for the guest agent's control channel (plan 44 §4.4,
 * §5.5). Every call opens its own short-lived TCP connection to the forwarded
 * port, writes exactly one newline-delimited JSON request, reads exactly one
 * line back, and closes — mirroring the agent's own accept-handle-close loop
 * (verified against a real device in plan 44 §5.1),
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

/**
 * R1 (plan 90 §3.9) — the version-skew seam. `hello()` below still throws `E_PROTOCOL_MISMATCH`
 * synchronously, out of its own retry loop, and does not retry it — "a different protocol version
 * will not fix itself" (F39) is still true of THIS call. What changed is what a caller is now
 * expected to do with it: before the manifest pinned a build (90.1), nothing knew which APK was
 * right, so a mismatch was a dead end. Now it is not — a caller that catches a code in this set is
 * expected to mark the device `outdated` (the state plan 90 §3.8 defines) and hand it to
 * `AgentProvisioner.ensure()` (`packages/core/src/device/agent-provisioner.ts`, step 90.3, not yet
 * built) for exactly one reinstall of the pinned build plus one re-`hello()`, the same
 * one-repair-then-degrade rule `ui-server` already uses (F8) — never a loop, never a second
 * attempt at the same repair. This client's own refusal to retry is unchanged; only the caller's
 * response to that refusal is no longer "give up forever".
 */
export const GUEST_AGENT_REPAIRABLE_ERROR_CODES: ReadonlySet<GuestAgentClientErrorCode> = new Set<GuestAgentClientErrorCode>([
  'E_PROTOCOL_MISMATCH',
])

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
  /**
   * `expectVersionCode` (plan 221 §4.9) — the host's own toolchain pin, echoed by the agent's
   * status screen as "host expects build N". Optional: omitted, the agent simply shows no such
   * row, which is what a caller with no pin to compare against should get.
   */
  hello(opts?: { expectVersionCode?: number }): Promise<HelloResult>
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
  /**
   * Plan 58 §4.4. Installs a mock GPS fix on the device via the guest agent's
   * test-provider API (no root). Gated on `hello().capabilities` including
   * `mock-location`; an older build answers `E_UNKNOWN_METHOD`, which callers
   * treat as "identity GPS cannot be applied" rather than a route failure.
   */
  locationSet(lat: number, lng: number, accuracy?: number): Promise<LocationSetResult>
  /** Plan 58 §4.4. Removes the mock provider, restoring real location. Same capability gate as `locationSet`. */
  locationClear(): Promise<LocationClearResult>
  /**
   * Plan 89 §4.5; plan 90 §3.6, §4.1. Always present on this interface — like every other method
   * here, the wire request can always be sent; whether the agent actually understands it is a
   * property of the INSTALLED BUILD, discovered from `hello().capabilities` (`'screen-label'`),
   * not of this client. An older build (or one predating the label facet) answers
   * `E_UNKNOWN_METHOD`, which plan 89 §3.5's `unavailable` tier treats as a precondition, not a
   * route failure.
   */
  labelApply(params: { fingerprint: string; number: string; name: string | null; surfaces: Array<'home' | 'lock'> }): Promise<LabelApplyResult>
  /** Plan 89 §4.5; plan 90 §3.6, §4.1. Same "always present, gated on `hello().capabilities`" treatment as `labelApply`. */
  labelStatus(): Promise<LabelStatusResult>
  /** Plan 89 §4.5; plan 90 §3.6, §4.1. Same gate as `labelApply`. `restoreOriginal` picks which of `label.clear`'s two possible writes runs. */
  labelClear(restoreOriginal: boolean): Promise<LabelClearResult>
  /**
   * Plan 90 §3.2, §3.3, §4.1. Same "always present on the client, gated on `hello().capabilities`"
   * treatment as `egressProbe`/`routeHold` above — an older build (or one predating the IME facet)
   * answers `E_UNKNOWN_METHOD`, which the text-routing resolver (`resolveTextRoute`, §4.5) reads as
   * "rung 1 (`agent-ime`) unavailable" and falls down the ladder rather than failing the call.
   */
  textCommit(text: string, perCharMs?: [number, number]): Promise<TextCommitResult>
  /** Plan 90 §3.2, §3.3, §4.1. Same gate as `textCommit` — reports whether the agent's IME is currently the live one. */
  textStatus(): Promise<TextStatusResult>
  /**
   * Plan 221 §4.2. Same "always present on the client, gated on `hello().capabilities`" treatment
   * as every other method here — an older build answers `E_UNKNOWN_METHOD`, which plan 222's
   * engine ladder reads as "the `ui-tree` engine is unavailable on this device" and falls back to
   * ui-server, never as a device failure. A build that has the service but has not had it enabled
   * answers `E_UI_TREE_UNAVAILABLE`, which is a DIFFERENT thing and gets a different repair
   * (`ensureAccessibilityEnabled`, launcher.ts).
   */
  uiDump(opts?: { maxDepth?: number; maxNodes?: number }): Promise<UiDumpResult>
  /** Plan 221 §4.2. Throws `E_BAD_REQUEST` locally, before the wire, for a `{ point }` selector. */
  uiFind(selector: Selector, opts?: { maxDepth?: number; maxNodes?: number }): Promise<UiFindResult>
  /** Plan 221 §4.5. The activity mirror push; read-only on the device. */
  activitySet(activities: GuestAgentActivity[], video: GuestAgentVideo | null): Promise<ActivitySetResult>
  /** Plan 221 §4.5. The farm's own facts about this device, for the status screen's Device section. */
  deviceDescribe(device: {
    stableId: string | null
    label: string | null
    number: string | null
    group: string | null
    tags: string[]
  }): Promise<DeviceDescribeResult>
  /** Plan 221 §4.6. Writes the per-device soft-keyboard preference; returns the device's read-back. */
  textPrefs(showSoftKeyboardWithHardware: boolean): Promise<TextPrefsResult>
  /** Plan 221 §4.2. Cheap enough to call on every provisioning pass; never starts anything. */
  uiStatus(): Promise<UiStatusResult>
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
    async hello(helloOpts) {
      let lastErr: unknown
      for (let attempt = 1; attempt <= handshakeRetries; attempt++) {
        try {
          const req = HelloRequestSchema.parse({
            id: crypto.randomUUID(),
            token: opts.token,
            method: 'hello',
            ...(helloOpts?.expectVersionCode !== undefined ? { expectVersionCode: helloOpts.expectVersionCode } : {}),
          })
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

    locationSet(lat, lng, accuracy) {
      const req = LocationSetRequestSchema.parse({
        id: crypto.randomUUID(),
        token: opts.token,
        method: 'location.set',
        lat,
        lng,
        ...(accuracy !== undefined ? { accuracy } : {}),
      })
      return call(connect, opts.port, timeoutMs, req, LocationSetResultSchema)
    },

    locationClear() {
      const req = LocationClearRequestSchema.parse({
        id: crypto.randomUUID(),
        token: opts.token,
        method: 'location.clear',
      })
      return call(connect, opts.port, timeoutMs, req, LocationClearResultSchema)
    },

    labelApply(params) {
      const req = LabelApplyRequestSchema.parse({
        id: crypto.randomUUID(),
        token: opts.token,
        method: 'label.apply',
        fingerprint: params.fingerprint,
        number: params.number,
        name: params.name,
        surfaces: params.surfaces,
      })
      return call(connect, opts.port, timeoutMs, req, LabelApplyResultSchema)
    },

    labelStatus() {
      const req = LabelStatusRequestSchema.parse({
        id: crypto.randomUUID(),
        token: opts.token,
        method: 'label.status',
      })
      return call(connect, opts.port, timeoutMs, req, LabelStatusResultSchema)
    },

    labelClear(restoreOriginal) {
      const req = LabelClearRequestSchema.parse({
        id: crypto.randomUUID(),
        token: opts.token,
        method: 'label.clear',
        restoreOriginal,
      })
      return call(connect, opts.port, timeoutMs, req, LabelClearResultSchema)
    },

    textCommit(text, perCharMs) {
      const req = TextCommitRequestSchema.parse({
        id: crypto.randomUUID(),
        token: opts.token,
        method: 'text.commit',
        text,
        ...(perCharMs !== undefined ? { perCharMs } : {}),
      })
      return call(connect, opts.port, timeoutMs, req, TextCommitResultSchema)
    },

    textStatus() {
      const req = TextStatusRequestSchema.parse({
        id: crypto.randomUUID(),
        token: opts.token,
        method: 'text.status',
      })
      return call(connect, opts.port, timeoutMs, req, TextStatusResultSchema)
    },

    uiDump(dumpOpts) {
      const req = UiDumpRequestSchema.parse({
        id: crypto.randomUUID(),
        token: opts.token,
        method: 'ui.dump',
        ...(dumpOpts?.maxDepth !== undefined ? { maxDepth: dumpOpts.maxDepth } : {}),
        ...(dumpOpts?.maxNodes !== undefined ? { maxNodes: dumpOpts.maxNodes } : {}),
      })
      return call(connect, opts.port, timeoutMs, req, UiDumpResultSchema)
    },

    async uiFind(selector, findOpts) {
      // `{ point }` is a host-side synthetic node (`selector-match.ts`'s `matchSelector`) — there
      // is nothing on the device to look up, so this is refused here, before the wire, rather than
      // relying on the device's own `E_BAD_REQUEST` for a mistake the client can catch for free.
      // `async` so this rejects rather than throws synchronously — the same shape every other
      // failure on this interface arrives in, and what lets a caller `await` uniformly.
      if ('point' in selector) {
        throw new GuestAgentClientError('E_BAD_REQUEST', 'ui.find does not accept a point selector')
      }
      const req = UiFindRequestSchema.parse({
        id: crypto.randomUUID(),
        token: opts.token,
        method: 'ui.find',
        selector,
        ...(findOpts?.maxDepth !== undefined ? { maxDepth: findOpts.maxDepth } : {}),
        ...(findOpts?.maxNodes !== undefined ? { maxNodes: findOpts.maxNodes } : {}),
      })
      return call(connect, opts.port, timeoutMs, req, UiFindResultSchema)
    },

    activitySet(activities, video) {
      const req = ActivitySetRequestSchema.parse({
        id: crypto.randomUUID(),
        token: opts.token,
        method: 'activity.set',
        activities,
        video,
      })
      return call(connect, opts.port, timeoutMs, req, ActivitySetResultSchema)
    },

    deviceDescribe(device) {
      const req = DeviceDescribeRequestSchema.parse({
        id: crypto.randomUUID(),
        token: opts.token,
        method: 'device.describe',
        ...device,
      })
      return call(connect, opts.port, timeoutMs, req, DeviceDescribeResultSchema)
    },

    textPrefs(showSoftKeyboardWithHardware) {
      const req = TextPrefsRequestSchema.parse({
        id: crypto.randomUUID(),
        token: opts.token,
        method: 'text.prefs',
        showSoftKeyboardWithHardware,
      })
      return call(connect, opts.port, timeoutMs, req, TextPrefsResultSchema)
    },

    uiStatus() {
      const req = UiStatusRequestSchema.parse({
        id: crypto.randomUUID(),
        token: opts.token,
        method: 'ui.status',
      })
      return call(connect, opts.port, timeoutMs, req, UiStatusResultSchema)
    },
  }
}
