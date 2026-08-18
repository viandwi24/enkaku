import type { NetworkObservation, ReverseProxyRouteConfig, Transport } from '@enkaku/protocol'
import type { NetworkRoute } from '../guest-agent/index'
import { createHttpProxyRoute, type HttpProxyCaptureStore } from './http-proxy'

/**
 * The `adb-reverse-proxy` network engine (plan 114 §3.2, §3.6, §3.8, §4.2, step
 * 114.5; spec §7.9 rung 2) — the same advisory Android setting as rung 1,
 * pointed at the phone's OWN loopback, with `adb reverse` carrying the
 * connection back to a proxy listening on this farm's machine.
 *
 * ```
 *   app → phone 127.0.0.1:<devicePort> → adb reverse → farm host <hostPort> → the real upstream
 * ```
 *
 * **Why this rung exists at all, in one sentence: it is the only one on which
 * an authenticated proxy is possible.** Android's system proxy value is
 * `host:port` and nothing else — there is no credential field, and the value is
 * world-readable by every app on the phone, so spec §7.9 forbids putting one
 * there. On this rung the account lives in the host-side listener (plan 112's
 * bridge, or whatever the operator runs), and the only thing ever written to
 * the device is `127.0.0.1:<devicePort>`. **Nothing this engine writes to a
 * phone may contain a username or password**, and the shape of the code is what
 * guarantees it: the only value that reaches the settings writer below is built
 * by `reverseProxyValue()` from a port number.
 *
 * **What it composes, and what it therefore does not re-implement.** The whole
 * settings half — capture-once, write, read back and compare, restore the
 * captured values on revert, the "nothing was ever captured" fallback — is
 * `createHttpProxyRoute` from `./http-proxy`, held as `settings` below and
 * driven with a `127.0.0.1:<devicePort>` config. There is no second copy of the
 * four `Settings.Global` keys, of the `null` normalisation, or of the read-back
 * comparison in this file, which is the point: rung 1 and rung 2 write the
 * same setting, and two writers would eventually disagree about the format,
 * about what a failed read-back means, or about whether a revert restores or
 * clears.
 *
 * **Order is the whole design, in both directions, and it is asymmetric on
 * purpose** (plan 114 §3.6, §3.7):
 *
 * - `apply()` establishes the reverse FIRST, then writes the setting. The port
 *   answers by the time any app can read the value pointing at it.
 * - `revert()` clears the setting FIRST, then tears the reverse down. There is
 *   never a moment where the phone is pointed at a port that has just stopped
 *   answering.
 *
 * The same rule decides the two half-failure cases, which are the ones that
 * actually happen on a farm:
 *
 * - **`adb reverse` fails →** the setting is never written and `apply()`
 *   throws. A phone is never left pointed at a loopback port that answers
 *   nothing because of something this engine did.
 * - **the reverse is established and the setting write fails →** the reverse is
 *   deliberately LEFT STANDING and `apply()` throws. Tearing it down would
 *   guarantee a dead port for a phone that may well have taken the write (a
 *   read-back mismatch is not proof the value was rejected — see
 *   `HttpProxyError`'s `E_SETTING_NOT_ACCEPTED`), which is the exact failure
 *   the revert order exists to prevent. The cost of the other choice is one
 *   idle tunnel on the farm's own machine until the route is reverted or
 *   deleted, and the route row is already persisted by then, so `revert()`
 *   still reaches it.
 *
 * **`health` is permanently `unverified` here, exactly as for rung 1** (plan
 * 114 §3.5): the `egress` check is `skip` forever because nothing on a phone
 * can tell you which apps honoured an advisory setting. `capabilities` are all
 * `false` including `auth` — the credential is somebody else's, and
 * `NetworkCapabilitiesSchema` describes what THIS engine supports, not what the
 * farm as a whole can arrange. `probe` and `hold` are deliberately not defined,
 * for the reasons `http-proxy.ts`'s header states in full.
 *
 * **This module holds no state.** The device-side port allocation lives on
 * `devices.network_route.reverse` and reaches this file through
 * `deps.allocation`; the live reverse lives in the core's own in-memory
 * `ReverseRegistry` and reaches it through `deps.reverse`; the pre-farm capture
 * lives on `devices.network_route.captured` and reaches the settings writer
 * through `deps.capture`. A core restart loses the registry and keeps both
 * persisted halves, which is what lets `apply()` come back on the SAME device
 * port rather than moving it out from under a setting the phone is still
 * carrying.
 */

/** The host every device-side value on this rung points at — the phone's own loopback, never a farm address. */
export const REVERSE_PROXY_DEVICE_HOST = '127.0.0.1'

/**
 * The exact `http_proxy` value this rung writes. Exported for the same reason
 * `httpProxyValue()` is: the core's `setting` check compares the device's own
 * answer against ONE definition of the format instead of re-deriving it and
 * drifting from it (plan 114 §3.5).
 *
 * Note what it takes and what it therefore cannot contain: a port number. There
 * is no parameter here through which a credential could reach a phone.
 */
export function reverseProxyValue(devicePort: number): string {
  return `${REVERSE_PROXY_DEVICE_HOST}:${devicePort}`
}

/**
 * The core's `ReverseRegistry` (`packages/core/src/network/reverse-registry.ts`,
 * step 114.4), narrowed to what this engine actually calls and declared here
 * rather than imported: `@enkaku/drivers` may not depend on `@enkaku/core`, and
 * the registry satisfies this structurally. The three properties this engine
 * relies on are the registry's own documented contracts, not assumptions:
 *
 * - `establish` honours a supplied `devicePort` EXACTLY and never walks the
 *   range for it. That is what makes the port sticky across a core restart,
 *   and it matters because the phone's `http_proxy` literally contains that
 *   number — a silently reallocated port would leave the setting pointing at
 *   nothing while the logs said the tunnel was re-established.
 * - `establish` throws `E_REVERSE_FAILED` and leaves the entry in place with
 *   `establishedAt: null` rather than reallocating on failure.
 * - `release` is idempotent and never throws, which is what lets `revert()`
 *   below promise the same.
 */
export interface ReverseBinding {
  /** The port ON THE PHONE that `http_proxy` points at. */
  devicePort: number
  /** The port on the farm's own machine the reverse forwards to. */
  hostPort: number
  /** When the reverse was last successfully issued, or `null` when it is known NOT to be live. */
  establishedAt: number | null
}

export interface ReversePort {
  establish(deviceId: string, opts: { hostPort: number; devicePort?: number }): Promise<ReverseBinding>
  release(deviceId: string): Promise<void>
  get(deviceId: string): ReverseBinding | null
}

/** `PersistedNetworkRoute.reverse`'s shape — what the farm allocated, as opposed to what the operator asked for. */
export interface ReverseAllocation {
  devicePort: number
  hostPort: number
  /** Unix epoch seconds. */
  at: number
}

/**
 * Where the device-port allocation is read from and written to. Deliberately
 * not owned by the engine, for the same reason `HttpProxyCaptureStore` is not:
 * an allocation that only lived in this process would be gone after a core
 * restart, which is precisely when the phone is still carrying a setting that
 * names it.
 *
 * Unlike a capture, this is NOT write-once — `hostPort` changes whenever the
 * operator points the route at a different listener, and the write below always
 * records the current pair. What is sticky is `devicePort`, and it is kept
 * sticky by PINNING it on `establish`, never by refusing to write.
 */
export interface ReverseAllocationStore {
  read(): ReverseAllocation | null | Promise<ReverseAllocation | null>
  write(allocation: ReverseAllocation): void | Promise<void>
}

export interface CreateReverseProxyRouteOptions {
  transport: Transport
  deviceId: string
  /** `adb reverse` and the map that survives a replug (plan 114 §4.3). */
  reverse: ReversePort
  /** Reads/writes `devices.network_route.reverse`. */
  allocation: ReverseAllocationStore
  /**
   * Reads/writes `devices.network_route.captured` — the SAME device-scoped
   * store rung 1 uses, deliberately. The capture is a fact about the phone
   * before this farm ever wrote a proxy setting; it belongs to the device and
   * survives an engine switch, so a device moved from rung 1 to rung 2 and back
   * still restores what was originally found.
   */
  capture: HttpProxyCaptureStore
  onLog?: (level: 'debug' | 'info' | 'warn', msg: string) => void
}

export function createReverseProxyRoute(deps: CreateReverseProxyRouteOptions): NetworkRoute<ReverseProxyRouteConfig> {
  const { deviceId, reverse, allocation } = deps
  const log = (level: 'debug' | 'info' | 'warn', msg: string) => deps.onLog?.(level, `adb-reverse-proxy[${deviceId}] ${msg}`)

  /**
   * The settings half, whole and unmodified. Its own log lines carry an
   * `adb-proxy[<device>]` prefix and that is left alone on purpose: it is
   * literally the same writer touching the same four `Settings.Global` keys,
   * and relabelling it here would hide that the two rungs share one
   * implementation.
   */
  const settings = createHttpProxyRoute({
    transport: deps.transport,
    deviceId,
    capture: deps.capture,
    ...(deps.onLog ? { onLog: deps.onLog } : {}),
  })

  /**
   * The device port to ask for: the persisted allocation first, then whatever
   * the live registry already holds. `undefined` means "allocate a fresh one",
   * and it is the only case in which the registry is allowed to walk its range.
   *
   * Persisted before live, not the other way round, because the persisted value
   * is the one the PHONE's setting agrees with — after a core restart the
   * registry is empty and the row is the only record of what the phone is
   * pointed at. When both exist they are the same number.
   */
  async function pinnedDevicePort(): Promise<number | undefined> {
    const stored = await allocation.read()
    return stored?.devicePort ?? reverse.get(deviceId)?.devicePort ?? undefined
  }

  return {
    id: 'adb-reverse-proxy',

    /**
     * Every field `false`, and `auth` is the one worth stating out loud: this
     * rung is how an authenticated proxy becomes possible at all, and the
     * engine still supports no authentication whatsoever. The account belongs
     * to the listener on this machine; the engine only builds a tunnel and
     * writes a loopback address. Advertising `auth: true` here would claim a
     * capability that lives in another process entirely (plan 114 §3.8).
     */
    capabilities: { auth: false, enforcing: false, udp: false, probe: false },

    /**
     * Reverse first, setting second (plan 114 §3.6) — see this file's header
     * for both half-failure cases and why they resolve the way they do.
     *
     * Idempotent in the way that matters: re-applying pins the same device
     * port, re-issues the same `adb reverse` (which replaces rather than
     * refuses), and re-writes the same setting. Re-applying with a different
     * `hostPort` keeps the device port and re-points the tunnel, so the phone's
     * own setting never has to change for an operator to move the proxy to a
     * different listener on this machine.
     */
    async apply(config) {
      const requested = await pinnedDevicePort()
      const binding = await reverse.establish(deviceId, {
        hostPort: config.hostPort,
        ...(requested !== undefined ? { devicePort: requested } : {}),
      })

      // Persisted BEFORE the setting write, so a crash in between still leaves the port on disk:
      // the restore pass then re-establishes the same one and re-applies the setting, converging.
      // The reverse order would lose the allocation and hand the phone a different port on the
      // next apply.
      await allocation.write({ devicePort: binding.devicePort, hostPort: binding.hostPort, at: Math.floor(Date.now() / 1000) })
      log('info', `reverse ready: phone tcp:${binding.devicePort} → this machine tcp:${binding.hostPort}`)

      try {
        await settings.apply({
          engine: 'adb-proxy',
          host: REVERSE_PROXY_DEVICE_HOST,
          port: binding.devicePort,
          ...(config.exclusions ? { exclusions: config.exclusions } : {}),
        })
      } catch (err) {
        // Left standing deliberately — see the header. A tunnel a phone may already be pointed at
        // is never torn down as part of handling a failure to point it there.
        log(
          'warn',
          `the proxy setting could not be applied (${String(err)}); the reverse on phone tcp:${binding.devicePort} is left standing rather than torn down, because the phone may already be pointed at it`,
        )
        throw err
      }
      log('info', `phone points at ${reverseProxyValue(binding.devicePort)}; the upstream account never left this machine`)
    },

    /**
     * What the DEVICE says, delegated whole to the settings half.
     *
     * `up` therefore means "the phone reports a non-empty system proxy" and
     * nothing more — on this rung it does NOT mean the tunnel behind that
     * address is live, because a reverse that died with a replug leaves the
     * setting perfectly intact and pointing at a port that answers nothing.
     * That fact has its own name and its own place: the `reverse` check (plan
     * 114 §3.5, acceptance criterion 10), computed by the core from the
     * registry's `establishedAt`. Folding it into `up` here would collapse two
     * genuinely different facts into one boolean and lose the ability to say
     * which of them failed.
     */
    observe(): Promise<NetworkObservation> {
      return settings.observe()
    },

    // `probe` and `hold` are deliberately NOT defined, for the reasons `http-proxy.ts`'s header
    // gives in full: an egress probe on this rung could only ever prove that a client which
    // honours the setting reached the proxy, never that any app under test did.

    /**
     * **Setting first, reverse second** (plan 114 §3.6), and the order is the
     * reason this method exists rather than the two halves being torn down by
     * whoever happens to call them: clearing the setting first means there is
     * never a window in which the phone is pointed at a port that has just
     * stopped answering.
     *
     * Never throws and is safe to call twice, per `NetworkRoute.revert()`'s own
     * contract. `settings.revert()` already promises both and does not clear
     * its capture (so a second revert re-issues the same values rather than
     * falling into the "nothing was captured" path); `release()` is idempotent
     * and never throws by the registry's own contract, and is wrapped anyway so
     * that a future change there cannot break this promise from a distance.
     *
     * The allocation on disk is deliberately NOT cleared. The row's lifetime
     * belongs to the caller — `DELETE /:id/network` erases the whole row, while
     * `/disable` keeps it — and a disabled route that is switched back on
     * should come back on the port the phone last knew.
     */
    async revert() {
      await settings.revert()
      try {
        await reverse.release(deviceId)
      } catch (err) {
        log('warn', `releasing the reverse failed, tolerated: ${String(err)}`)
      }
    },
  }
}
