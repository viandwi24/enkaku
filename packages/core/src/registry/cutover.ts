import type { AdbClient } from '@enkaku/adb'
import type { ConnectionMedium, CutoverState, ReconnectOutcome, ServerMessage } from '@enkaku/protocol'
import type { HostAdb } from '../device/host-adb'
import type { Logger } from '../util/logger'
import type { DeviceReconnector } from './reconnect'
import type { EndpointStore } from './endpoints'

/**
 * The USB → network cutover wizard's server-side state machine (plan 88
 * §3.4, §4.6, §5 step 88.5) — arm, flip, watch. In-memory, keyed by
 * `stableId`, deliberately NOT persisted: an armed window that survives a
 * core restart is a surprise, and the operator is standing at the chassis
 * (§5 step 88.5's own checklist entry).
 *
 * The whole flow reuses machinery this plan already built rather than
 * inventing a parallel path:
 *   - "enable TCP mode" is H1's own mechanism (`AdbClient.tcpip`, a device
 *     service over `openRaw`'s connect-and-handshake shape), with H1's own
 *     documented fallback to the bounded `hostAdb.run(['-s', serial,
 *     'tcpip', port])` on any failure — see this module's `enableTcp`.
 *   - "watch for the phone" is `DeviceReconnector.reconnect(stableId,
 *     { allowSweep: true })`, THE SAME ladder+sweep every other reconnect
 *     path uses (§3.3, §4.4) — polled every `armPollSec` rather than run
 *     once, and the poll count/answered count come straight from its own
 *     `AttemptTrace`/`SweepReport`.
 *   - "declare the medium" is `EndpointStore.declare`, THE SAME write path
 *     `PATCH /:id/connection` uses (§3.1, §4.3) — a completed cutover is
 *     indistinguishable, from `deriveConnection`'s point of view, from an
 *     operator declaring the medium by hand right after the phone answers.
 */

const TCP_ADDRESS_RE = /^(\[[0-9a-fA-F:]+\]|[^\s:]+):(\d{1,5})$/

/** `host:port` (adb's own TCP serial shape) vs a USB serial (F16/§3.1's own regex, repeated here for the same one-purpose reason `endpoints.ts` repeats it). */
function isTcpAddress(serial: string): boolean {
  return TCP_ADDRESS_RE.test(serial)
}

export interface CutoverManager {
  /**
   * Screens 1–3 of §3.4, run here: enable TCP mode, verify by read-back
   * (refusing to arm on a mismatch), attempt `persist.adb.tcp.port` and
   * report which persistence actually happened (H3), then arm and start
   * polling. Restarts cleanly if a window was already open for this device
   * (the operator retrying at the chassis) rather than refusing a second
   * call. Every transition broadcasts `device.cutover`.
   */
  start(
    device: { id: string; stableId: string; serial: string; label: string },
    opts: { port?: number; medium: ConnectionMedium; address?: string },
  ): Promise<CutoverState>
  /** Cancel available at every step (§3.4: "reverts nothing" — TCP mode stays on; a phone in TCP mode still works over USB). Idempotent. */
  cancel(stableId: string): CutoverState | null
  get(stableId: string): CutoverState | null
  /**
   * Clears every pending poll timer with no further broadcast (00-overview
   * §7's "every process this registry started is dead on stop" — the same
   * discipline `DeviceRegistry.stop()`/`AdbServerHealthMonitor.stop()`
   * already apply). Called once, from `daemon.ts`'s own `stop()`, so an
   * armed window never fires a `reconnect()` — or a broadcast — against a
   * torn-down hub after the core has stopped. Unlike `cancel`, this is not
   * an operator action: it does not audit, and it does not pretend the
   * window was cleanly cancelled — a restart resumes provisioning from
   * scratch, and an armed window does not survive one anyway (§3.4's own
   * "deliberately not persisted").
   */
  stopAll(): void
}

export interface CutoverManagerDeps {
  client: AdbClient
  hostAdb: Pick<HostAdb, 'run'>
  endpoints: Pick<EndpointStore, 'declare'>
  /** The SAME `DeviceReconnector` steps 88.2/88.8 built — not a second ladder. */
  reconnector: Pick<DeviceReconnector, 'reconnect'>
  settings: () => { tcpPort: number; armWindowSec: number; armPollSec: number }
  broadcast: (msg: ServerMessage) => void
  log: Logger
}

interface Session {
  state: CutoverState
  timer: ReturnType<typeof setTimeout> | null
}

/**
 * `tcpip:<port>` — H1's own device service, over `AdbClient.tcpip` (which
 * itself is `openRaw`'s connect/transport/service shape, F16). On ANY
 * failure — the exact case H1's write-up could not verify without hardware
 * — falls back to the bounded, drained, deadline-enforced `hostAdb.run`,
 * per this plan's own documented fallback (§0.2 H1, §5 step 88.5's opening
 * bullet). Returns which mechanism actually worked, purely for the
 * `detail` string; correctness is never inferred from this alone — the
 * caller always verifies by reading `service.adb.tcp.port` back.
 */
async function enableTcp(deps: CutoverManagerDeps, serial: string, port: number): Promise<{ mechanism: 'device-service' | 'adb-cli'; error: string | null }> {
  try {
    await deps.client.tcpip(serial, port)
    return { mechanism: 'device-service', error: null }
  } catch (err) {
    deps.log.debug(`cutover: tcpip:${port} via the device service failed for ${serial}, falling back to hostAdb.run (H1's documented fallback): ${String(err)}`)
  }
  try {
    await deps.hostAdb.run(['-s', serial, 'tcpip', String(port)])
    return { mechanism: 'adb-cli', error: null }
  } catch (err) {
    return { mechanism: 'adb-cli', error: String(err) }
  }
}

async function readProp(deps: CutoverManagerDeps, serial: string, prop: string): Promise<string> {
  const result = await deps.client.exec(serial, `getprop ${prop}`, { profile: 'probe' })
  return result.stdout.trim()
}

export function createCutoverManager(deps: CutoverManagerDeps): CutoverManager {
  const sessions = new Map<string, Session>()

  function broadcastState(state: CutoverState): void {
    deps.broadcast({ type: 'device.cutover', payload: { state } })
  }

  /** Patches the tracked state for `stableId` and broadcasts the result — a no-op (returns the untouched last state) if the session was cancelled out from under an in-flight step. */
  function setState(stableId: string, patch: Partial<CutoverState>): CutoverState {
    const entry = sessions.get(stableId)
    if (!entry) {
      // Cancelled mid-step (§3.4: Cancel is available at every step). There
      // is nothing left to update — the caller's own state is discarded,
      // never resurrected into a map entry nobody asked for.
      return patch as CutoverState
    }
    entry.state = { ...entry.state, ...patch }
    broadcastState(entry.state)
    return entry.state
  }

  function clearTimer(stableId: string): void {
    const entry = sessions.get(stableId)
    if (entry?.timer) {
      clearTimeout(entry.timer)
      entry.timer = null
    }
  }

  function schedulePoll(stableId: string): void {
    if (!sessions.has(stableId)) return
    const pollMs = Math.max(1000, deps.settings().armPollSec * 1000)
    const entry = sessions.get(stableId)!
    entry.timer = setTimeout(() => void poll(stableId), pollMs)
  }

  async function poll(stableId: string): Promise<void> {
    const entry = sessions.get(stableId)
    if (!entry) return // cancelled while the timer was pending

    if (entry.state.expiresAt !== null && Date.now() >= entry.state.expiresAt) {
      setState(stableId, {
        step: 'failed',
        detail: `no phone answered within the watch window (tried ${entry.state.triedAddresses} address(es), ${entry.state.answered} answered). Likely causes, in order: the port did not flip, the chassis port has not been assigned an address yet, or the configured network is wrong.`,
        expiresAt: null,
      })
      clearTimer(stableId)
      return
    }

    // The fourth screen (§3.4): briefly `connecting` while THIS poll's
    // `reconnect()` call is actually in flight (a sweep can take seconds),
    // then either `done` below or back to `armed` for the next tick — so
    // "checking now" reads differently from "idle, waiting for the next
    // check in `armPollSec`".
    setState(stableId, { step: 'connecting', detail: 'checking for the phone on the network…' })

    let outcome: ReconnectOutcome
    try {
      outcome = await deps.reconnector.reconnect(stableId, { allowSweep: true })
    } catch (err) {
      deps.log.debug(`cutover: reconnect poll for ${stableId} threw, treated as not-found: ${String(err)}`)
      outcome = { result: 'not-found', tried: [], sweep: null }
    }

    // The session may have been cancelled WHILE the poll above was in
    // flight (a sweep can take seconds) — re-check before acting on it.
    const current = sessions.get(stableId)
    if (!current) return

    // While the phone is still on USB, `reconnect`'s step 1 ("already
    // connected?") answers TRUE against the device's own CURRENT (USB)
    // serial every single poll — that is not the cutover succeeding, it is
    // the phone not having been flipped yet. Only a `host:port`-shaped
    // address counts as this wizard's idea of "found" (§3.1's own
    // observational split, reused here as the ONE filter that tells "still
    // on USB" apart from "answered on the network").
    const foundAddress =
      (outcome.result === 'already-connected' && isTcpAddress(outcome.serial) && outcome.serial) ||
      (outcome.result === 'connected' && isTcpAddress(outcome.address) && outcome.address) ||
      null

    if (foundAddress) {
      // The SAME write path `PATCH /:id/connection` uses (§3.1, §4.3) — a
      // completed cutover reads back `mediumSource: 'declared'` on the very
      // next GET, exactly like a manual declaration would.
      deps.endpoints.declare(stableId, foundAddress, current.state.medium)
      const label = current.state.medium === 'wired' ? 'OTG' : 'Wi-Fi'
      setState(stableId, {
        step: 'done',
        connectedAddress: foundAddress,
        detail: `Connected at ${foundAddress} over ${label}.`,
        expiresAt: null,
      })
      clearTimer(stableId)
      return
    }

    const triedDelta = outcome.result === 'not-found' ? outcome.tried.length : 0
    const sweepReport = outcome.result === 'not-found' ? outcome.sweep : null
    const answeredDelta = sweepReport?.answered ?? 0
    const triedAddresses = current.state.triedAddresses + triedDelta
    const answered = current.state.answered + answeredDelta
    setState(stableId, {
      step: 'armed',
      triedAddresses,
      answered,
      detail: sweepReport
        ? `swept ${sweepReport.networks.map((n) => n.cidr).join(', ') || 'the configured networks'} · ${sweepReport.answered} answered · none matched yet`
        : `waiting for the phone on the network — ${triedAddresses} address(es) tried so far`,
    })
    schedulePoll(stableId)
  }

  return {
    async start(device, opts) {
      const { stableId } = device
      // A restart, not a stack: the operator retrying at the chassis gets a
      // clean window, not a refusal or a second timer racing the first.
      clearTimer(stableId)

      const port = opts.port ?? deps.settings().tcpPort
      const initial: CutoverState = {
        deviceId: device.id,
        stableId,
        step: 'enabling-tcp',
        detail: `enabling TCP mode on port ${port}…`,
        port,
        medium: opts.medium,
        persistSurvivesReboot: null,
        triedAddresses: 0,
        answered: 0,
        startedAt: Date.now(),
        expiresAt: null,
        connectedAddress: null,
      }
      sessions.set(stableId, { state: initial, timer: null })
      broadcastState(initial)

      if (opts.address) {
        // The Check screen's manual fallback (§3.4 step 1, "an address
        // typed by hand") — declared immediately so it becomes a candidate
        // the ladder's step 2 tries, cheapest-first, same as any other
        // remembered address (§3.3). No second code path for "the operator
        // typed an address" — it is just another row in the address book.
        // `splitHostPort`/`isTcpAddress` both accept the same `host:port`
        // shape the endpoint store expects; a malformed typed address
        // simply never matches on the wire, surfacing as an ordinary
        // `not-found` at the window's expiry rather than a special error
        // here.
        deps.endpoints.declare(stableId, opts.address, opts.medium)
      }

      const enabled = await enableTcp(deps, device.serial, port)
      if (enabled.error) {
        return setState(stableId, {
          step: 'failed',
          detail: `could not enable TCP mode on port ${port}: ${enabled.error}`,
        })
      }

      let serviceReadback: string
      try {
        serviceReadback = await readProp(deps, device.serial, 'service.adb.tcp.port')
      } catch (err) {
        return setState(stableId, {
          step: 'failed',
          detail: `enabled TCP mode but could not read back service.adb.tcp.port: ${String(err)}`,
        })
      }
      if (serviceReadback !== String(port)) {
        // §3.4 step 2's own rule: refuse to arm on a failed read-back —
        // after the flip there is no adb path back to the phone until the
        // port is flipped again, so arming here is how an operator ends up
        // at the chassis with a phone that was never actually listening.
        return setState(stableId, {
          step: 'failed',
          detail: `refusing to arm — service.adb.tcp.port reads "${serviceReadback || '(empty)'}", not ${port}. The phone may not actually be listening yet.`,
        })
      }

      // H3 — attempted, never fatal either way; the wizard MEASURES and
      // REPORTS which persistence the phone actually gave (§3.4 step 2,
      // §0.2 H3) rather than promising one.
      let persistSurvivesReboot = false
      try {
        await deps.client.exec(device.serial, `setprop persist.adb.tcp.port ${port}`, { profile: 'probe' })
        const persistReadback = await readProp(deps, device.serial, 'persist.adb.tcp.port')
        persistSurvivesReboot = persistReadback === String(port)
      } catch (err) {
        deps.log.debug(`cutover: persist.adb.tcp.port attempt failed for ${device.serial} (H3, tolerated): ${String(err)}`)
      }

      const armWindowMs = deps.settings().armWindowSec * 1000
      const armed = setState(stableId, {
        step: 'armed',
        persistSurvivesReboot,
        detail: `Flip the port on the chassis from USB to OTG now. Enkaku is watching for the phone on the network.${persistSurvivesReboot ? '' : ' This phone will need re-arming after a reboot.'}`,
        expiresAt: Date.now() + armWindowMs,
      })
      schedulePoll(stableId)
      return armed
    },

    cancel(stableId) {
      const entry = sessions.get(stableId)
      if (!entry) return null
      clearTimer(stableId)
      sessions.delete(stableId)
      return entry.state
    },

    get(stableId) {
      return sessions.get(stableId)?.state ?? null
    },

    stopAll() {
      for (const stableId of [...sessions.keys()]) clearTimer(stableId)
      sessions.clear()
    },
  }
}
