import type { NetworkCapabilities, NetworkObservation, Socks5RouteConfig } from '@enkaku/protocol'
import { GuestAgentClientError, type GuestAgentClient, type GuestAgentClientOptions } from './client'
import type { GuestAgentLauncher } from './launcher'

/**
 * TODO(plan 44 §4.4, §5.6): `NetworkRoute` is the fifth driver-layer interface (spec §7.9,
 * docs/plans/33-m15-device-network.md §4.2), a sibling of `Transport`/`DisplaySource`/
 * `InputSink`/`Inspector` in `packages/protocol/src/driver.ts` — but it has not landed there
 * yet. Defined locally, matching the plan's shape exactly, so moving it into `driver.ts` later
 * is a pure cut-paste with no shape change. Do NOT edit `packages/protocol` from this file.
 */
export interface NetworkRoute {
  id: string
  capabilities: NetworkCapabilities
  apply(config: Socks5RouteConfig): Promise<void>
  observe(): Promise<NetworkObservation>
  /** Optional (spec §7.9): `vpn-helper` advertises `probe: false` below and leaves this undefined. */
  probe?(): Promise<{ ok: boolean; egressIp?: string; detail?: string }>
  revert(): Promise<void>
}

/** Builds a fresh, token-scoped client — `createGuestAgentClient` from `./client` fits this directly. */
export type GuestAgentClientFactory = (
  opts: Pick<GuestAgentClientOptions, 'port' | 'token' | 'handshakeRetries' | 'handshakeRetryDelayMs'>,
) => GuestAgentClient

/**
 * The agent holds exactly ONE token in memory at a time (Protocol.kt's `ControlService`) — every
 * `bootstrap(token)` overwrites whatever token a previous caller minted. A `GuestAgentSession` is
 * this codebase's ONE place allowed to mint that token for a given device: it owns the token, the
 * forwarded port, and the client, all lazily created on first use and reused by every subsequent
 * call — `apply`, `observe`, `revert`, a guest-agent status probe, the heartbeat, whatever. This
 * is what fixes the token-rotation defect (plan 44 §8b, this bugfix's "Bug 1"): as long as every
 * caller for a device shares the SAME session instead of minting its own token, no operation can
 * invalidate another's client mid-flight.
 *
 * Implementations live where the caller needs them (the core's `guest-agent.ts` builds the real
 * one, backed by `@enkaku/session`'s port allocator and the DB-backed device row) — this file only
 * declares the shape `createVpnHelperRoute` depends on, so `vpn-helper.ts` itself never mints a
 * token: every path through `apply`/`observe`/`revert` below goes through `deps.session`.
 */
export interface GuestAgentSession {
  /**
   * Runs `fn` against a live, authenticated client for this device — bootstrapping (grant →
   * mint token → forward → hello) on first use, and reusing that same token/port/client on every
   * subsequent call. `opts.handshakeRetries` only matters for a bootstrap this call itself
   * triggers (first use, or a re-auth below); it is a no-op when an already-live client is simply
   * reused.
   *
   * If `fn` fails with `E_UNAUTHORISED` or `E_NOT_PAIRED` — the coded signal that the on-device
   * agent has genuinely restarted and forgotten this token, not that some OTHER caller rotated it
   * out from under this one (that case cannot happen once every caller shares this session) —
   * this mints exactly ONE fresh token, re-bootstraps, and retries `fn` once on the new client
   * before giving up. A second failure is not retried again.
   */
  withClient<T>(fn: (client: GuestAgentClient) => Promise<T>, opts?: { handshakeRetries?: number }): Promise<T>
  /** True once a client has been established (equivalently: a port is currently held). */
  readonly active: boolean
  /**
   * Tears down the forwarded port and forgets the token/client. Idempotent and never throws
   * (mirrors `NetworkRoute.revert()`'s own contract) — safe to call from a teardown path that may
   * run twice, or on a session that was never used.
   */
  close(): Promise<void>
}

export interface CreateVpnHelperRouteOptions {
  launcher: GuestAgentLauncher
  /**
   * The ONE session this route's `apply`/`observe`/`revert` go through — see `GuestAgentSession`'s
   * doc comment. Supplied by the caller (created lazily, per device, and shared with every other
   * operation on that device) rather than built here, which is exactly what stops this file from
   * minting its own token (plan 44 §8b, this bugfix's "Bug 1").
   */
  session: GuestAgentSession
  /**
   * Accepted for parity with `GuestAgentLauncherDeps.apkPath` and potential future use (e.g.
   * re-verifying the installed build at apply time); the launcher passed in already owns its own
   * `apkPath` supplier internally, so `apply()`/`observe()`/`revert()` below do not call this.
   */
  apkPath: () => Promise<string>
  deviceId: string
  onLog?: (level: 'debug' | 'info' | 'warn', msg: string) => void
  /** How long `apply()` waits for the device to confirm the route carries traffic — overridable so tests need not wait out a real budget. Default 8000. */
  applySettleTimeoutMs?: number
  /** Poll interval while waiting for that confirmation. Default 500. */
  applySettleIntervalMs?: number
  /** Revert poll tuning (see `revert()`'s doc comment) — overridable so tests need not wait out a real budget. Default 5000. */
  revertPollTimeoutMs?: number
  /** Default 250. */
  revertPollIntervalMs?: number
}

/**
 * The `vpn-helper` `NetworkRoute` (plan 44 §4.4): a full-tunnel VPN on the device, driven over
 * the guest agent's control channel. `apply()` walks the whole bring-up chain — install, grant,
 * bootstrap, forward, handshake, start — so a caller only ever needs to hold one config and one
 * lease across the four device-side steps that chain has been proven to need (plan 44 §5.1).
 *
 * Every device-facing call below goes through `deps.session` — this file mints no token itself
 * (plan 44 §8b, "Bug 1"), and `observe()` never requires that THIS process is the one that called
 * `apply()` (plan 44 §8b, "Bug 2"): it just asks `deps.session` for a client, which bootstraps
 * lazily if nothing is live yet.
 */
export function createVpnHelperRoute(deps: CreateVpnHelperRouteOptions): NetworkRoute {
  const applySettleTimeoutMs = deps.applySettleTimeoutMs ?? 8000
  const applySettleIntervalMs = deps.applySettleIntervalMs ?? 500
  const revertPollTimeoutMs = deps.revertPollTimeoutMs ?? 5000
  const revertPollIntervalMs = deps.revertPollIntervalMs ?? 250

  return {
    id: 'vpn-helper',

    // `probe: false` is deliberate (plan 44 §4.3/§4.4): the egress probe does not exist in this
    // build, and claiming a capability this engine lacks is exactly the failure mode the
    // registry's capability advertisement exists to prevent.
    capabilities: { auth: true, enforcing: true, udp: true, probe: false },

    async apply(config) {
      await deps.launcher.ensureInstalled()
      // `deps.session.withClient()` handles grant → bootstrap → forward → hello on first use (or
      // reuses the already-live client) — see `GuestAgentSession`'s doc comment. This is the one
      // and only place `route.start` is sent, so a route this process applies always goes through
      // the shared session, never a private one.
      await deps.session.withClient((client) => client.routeStart(config))

      // `route.start` acknowledges the request, not completion — the device still has to build the
      // TUN and finish the SOCKS5 handshake, which takes a second or two. Returning immediately
      // made the very next status read report `up: false, drift: true`, so the UI flashed
      // "route on — not carrying traffic" at an operator whose route was simply still coming up.
      // Wait for the device to agree, and give up quietly rather than failing an apply that may
      // yet succeed — the honest reading is then reported as drift by the caller.
      const deadline = Date.now() + applySettleTimeoutMs
      let consecutiveErrors = 0
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, applySettleIntervalMs))
        const settled = await deps.session
          .withClient((client) => client.routeStatus())
          .catch(() => null)
        if (settled?.up) break
        // A device that keeps refusing the connection is gone, not still starting. Waiting out the
        // full budget on a dead agent only delays the honest answer the caller is about to report.
        if (settled === null && ++consecutiveErrors >= 2) break
        if (settled !== null) consecutiveErrors = 0
      }
    },

    async observe() {
      // No `client` guard here on purpose (plan 44 §8b, "Bug 2"): `withClient()` bootstraps lazily
      // if nothing is live yet, so a read never requires that THIS process is the one that
      // brought the route up. If the agent genuinely cannot be reached, `withClient()` throws a
      // coded `GuestAgentClientError` (E_TIMEOUT/E_TRANSPORT/...) — an observation failure, not an
      // apply failure — and the caller (`guest-agent.ts`) is responsible for reporting it as such.
      const status = await deps.session.withClient((client) => client.routeStatus())
      const observation: NetworkObservation = {
        prepared: status.prepared,
        up: status.up,
        ...(status.upstream !== undefined ? { upstream: status.upstream } : {}),
        ...(status.stats !== undefined ? { stats: status.stats } : {}),
        ...(status.lastError !== undefined ? { lastError: status.lastError } : {}),
      }
      return observation
    },

    /**
     * Tears the route down. MUST be idempotent and MUST NOT trust `route.stop`'s acknowledgement
     * as a completion signal (known defect, plan 44 §8b #1): the agent replies `{ stopped: true
     * }` the instant it accepts the request, while its `teardown()` is still joining the tunnel
     * thread on-device — so a `route.status` read taken immediately after that reply can still
     * report `up: true` even though Android already dropped the VPN underneath it. A lease
     * teardown that trusted the acknowledgement would report success before the route was
     * actually gone, so this polls `route.status` and waits for the device itself to agree
     * `up === false` (bounded to ~5s) before doing anything else. Tolerates an already-gone
     * device, an unreachable agent, and being called twice — this never throws, because it runs
     * from lease-teardown paths that may run twice or after a crash.
     *
     * Only talks to the device at all when `deps.session.active` — a session that was never used
     * (e.g. `revert()` before any `observe()`/`apply()` ever ran) or one already closed by a
     * previous `revert()` call has nothing left to stop, and reconnecting just to ask "are you
     * down?" would both be pointless and mint a token the agent has no reason to expect.
     */
    async revert() {
      if (deps.session.active) {
        try {
          await deps.session.withClient((client) => client.routeStop())
        } catch (err) {
          deps.onLog?.('warn', `vpn-helper[${deps.deviceId}] revert(): route.stop failed, tolerated: ${String(err)}`)
        }

        const deadline = Date.now() + revertPollTimeoutMs
        while (Date.now() < deadline) {
          let up = false
          try {
            up = (await deps.session.withClient((client) => client.routeStatus())).up
          } catch (err) {
            // Unreachable agent or gone device — nothing left to confirm, stop polling rather
            // than spin against a peer that will never answer.
            deps.onLog?.(
              'warn',
              `vpn-helper[${deps.deviceId}] revert(): route.status failed, tolerated: ${String(err)}`,
            )
            break
          }
          if (!up) break
          await Bun.sleep(revertPollIntervalMs)
        }
      }

      // Idempotent and never throws (GuestAgentSession's own contract) — releases the forwarded
      // port and forgets the token/client so a device with no applied route is never left holding
      // one (see the port-allocator contract in `guest-agent.ts`).
      await deps.session.close()
    },
  }
}

/** The set of `GuestAgentClientError` codes that mean "the agent forgot this token" rather than "the agent is unreachable" — the only codes `GuestAgentSession.withClient()` treats as worth one re-bootstrap. */
const REAUTH_CODES = new Set(['E_UNAUTHORISED', 'E_NOT_PAIRED'])

export interface CreateGuestAgentSessionOptions {
  launcher: GuestAgentLauncher
  /** Builds a fresh client bound to a freshly-minted token — see `GuestAgentClientFactory`'s doc comment. */
  client: GuestAgentClientFactory
  /** Claims a host port for this device (e.g. `PortAllocator.claim`), called lazily on first use. */
  claimPort: () => Promise<number>
  /** Releases a port claimed by `claimPort` — called once, from `close()`. */
  releasePort: (port: number) => void
  deviceId: string
  onLog?: (level: 'debug' | 'info' | 'warn', msg: string) => void
}

/**
 * The one place allowed to mint a guest-agent token for a device (plan 44 §8b, "Bug 1") — see
 * `GuestAgentSession`'s doc comment for why this exists. Exported so `guest-agent.ts` (the only
 * other file with call sites that used to mint their own token) can build one instance per device
 * and share it across the guest-agent status probe, the network route, and the heartbeat alike.
 */
export function createGuestAgentSession(deps: CreateGuestAgentSessionOptions): GuestAgentSession {
  let port: number | null = null
  let client: GuestAgentClient | null = null
  // Coalesces concurrent first-use (or concurrent re-auth) calls onto ONE in-flight bootstrap —
  // without this, two callers racing `withClient()` before either has set `client` would each
  // start their OWN bootstrap and mint TWO tokens, reintroducing the exact race plan 44 §8b's
  // "Bug 1" is about. Cleared as soon as the bootstrap settles (success or failure) so the next
  // caller that actually needs one starts a fresh attempt rather than replaying a stale rejection.
  let inFlight: Promise<GuestAgentClient> | null = null

  async function bootstrap(handshakeRetries: number | undefined): Promise<GuestAgentClient> {
    // Read back rather than trusted (docs/research/android-guest-agent.md §1.2) — see
    // `launcher.ensurePreGranted()`'s own doc comment. Run on every (re-)bootstrap, not just the
    // first: cheap, idempotent, and a defensive re-check costs nothing next to a full handshake.
    await deps.launcher.ensurePreGranted()
    const token = crypto.randomUUID()
    if (port === null) port = await deps.claimPort()
    await deps.launcher.bootstrap(token)
    await deps.launcher.forward(port)
    const newClient = deps.client({
      port,
      token,
      ...(handshakeRetries !== undefined ? { handshakeRetries } : {}),
    })
    // `hello()` checks the protocol version and throws a coded error on mismatch — refuse, never
    // degrade (CLAUDE.md, plan 44 §5.5's client.ts).
    await newClient.hello()
    client = newClient
    return newClient
  }

  /**
   * Synchronous on purpose (not `async`): the `client`/`inFlight` check-and-set below must run to
   * completion before this function returns control to the event loop, or two calls issued
   * back-to-back (e.g. `Promise.all([session.withClient(...), session.withClient(...)])`) would
   * each see `client` and `inFlight` still null and each start their own bootstrap.
   */
  function ensureClient(handshakeRetries: number | undefined): Promise<GuestAgentClient> {
    if (client) return Promise.resolve(client)
    if (!inFlight) {
      inFlight = bootstrap(handshakeRetries).finally(() => {
        inFlight = null
      })
    }
    return inFlight
  }

  return {
    get active() {
      return client !== null
    },

    async withClient(fn, opts) {
      const current = await ensureClient(opts?.handshakeRetries)
      try {
        return await fn(current)
      } catch (err) {
        if (!(err instanceof GuestAgentClientError) || !REAUTH_CODES.has(err.code)) throw err
        // The agent answered but does not recognise this token — it can only mean the on-device
        // process restarted and forgot everything it knew (a crash, a `force-stop`, a reboot).
        // Rotate exactly once here, never pre-emptively (plan 44 §8b, "Bug 1"): every other caller
        // sharing this session sees the SAME re-bootstrap instead of racing to mint their own.
        // Only clear `client` if nothing else already replaced it (a concurrent caller may have
        // already rotated onto a fresh one while this call was awaiting `fn`) — otherwise this
        // would null out a client another caller just finished establishing.
        if (client === current) {
          deps.onLog?.(
            'warn',
            `guest-agent session[${deps.deviceId}]: ${err.code} — the agent forgot this token, re-bootstrapping once`,
          )
          client = null
        }
        const fresh = await ensureClient(opts?.handshakeRetries)
        return await fn(fresh)
      }
    },

    async close() {
      client = null
      const held = port
      port = null
      if (held === null) return
      try {
        await deps.launcher.removeForward(held)
      } catch (err) {
        deps.onLog?.('warn', `guest-agent session[${deps.deviceId}] close(): removeForward failed, tolerated: ${String(err)}`)
      }
      deps.releasePort(held)
    },
  }
}
