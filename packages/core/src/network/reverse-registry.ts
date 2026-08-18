import { EnkakuError } from '../util/errors'

/**
 * `adb reverse`, and the one map that survives a replug (plan 114 §4.3, step 114.4).
 *
 * **Why the wrappers are here and not on `HostAdb`.** `HostAdb` exposes a
 * generic bounded `run(args)` and deliberately has no per-verb methods (plan
 * 114 F9) — the repo's only `forward` wrapper likewise lives on
 * `GuestAgentLauncher`, next to the thing that needs it, not on the CLI
 * helper. So `addReverse`/`removeReverse` below are two small functions over
 * `run(['-s', serial, 'reverse', …])`, shaped exactly like
 * `packages/drivers/src/network/guest-agent/launcher.ts`'s `forward`. A
 * reverse is a control-socket round trip, so `run`'s ordinary 30 s deadline
 * is right and no new timeout profile is needed.
 *
 * **What this exists to insure against.** `adb forward` entries do not
 * survive a device reconnect (plan 109 R7), and a reverse is the same
 * mechanism pointed the other way — `packages/drivers/src/inspector/
 * ui-server/launcher.ts`'s `reassertForward` already carries a documented
 * re-issue path for exactly this class of bug. So this registry re-issues
 * every entry it holds on the device-online transition, whether or not the
 * reverse turned out to need it: a reverse that survives costs one redundant
 * idempotent call per reconnect, and one that does not and was assumed to
 * leaves a phone silently pointed at a loopback port that answers nothing.
 * `adb reverse` was measured working over **USB** on the reference device
 * (plan 109 §0.2 H1: a device process dialled `127.0.0.1:46999`, bytes
 * crossed both ways). **Wireless is untested** — plan 114 §0.3 H3 is the
 * probe, and nothing here may be read as a claim about `adb-tcp`.
 *
 * **What this module is NOT.** It holds no route, reads no `devices` row and
 * writes nothing to disk. The reverse is runtime *state* — gone when the core
 * restarts, exactly like the listener on the other end of it (plan 112 §3.5's
 * "state is never persisted, intent always is"). The intent lives in
 * `devices.network_route`, and the boot-time reconcile pass owned by steps
 * 114.3/114.5 is what re-seeds this map with `establish({ devicePort })` for
 * every enabled reverse route.
 */

/**
 * The device-side port range this registry owns, and the reasoning behind it,
 * because two features allocating device ports without a shared range collide
 * silently and intermittently.
 *
 * - **Below the ephemeral floor.** Android's `ip_local_port_range` is
 *   typically 32768–60999; a device port inside it can already be held by a
 *   transient outbound socket when `adb reverse` tries to bind, which shows up
 *   as an intermittent failure nobody can reproduce. (Plan 109's H1 probe used
 *   46999 — fine for a one-shot manual probe, wrong as a standing range.)
 * - **Not the well-known/registered ports an Android device actually uses.**
 *   The two device-side ports this workspace already binds are the ui-server's
 *   fixed `9008` (`UI_SERVER_DEVICE_PORT`) and adbd's own `5555` when a device
 *   is put into tcpip mode. Neither is anywhere near this range. scrcpy and the
 *   guest agent both use `localabstract:` sockets, not TCP ports, so they
 *   cannot collide with a reverse at all.
 * - **Adjacent to the host-side range on purpose.** `PortAllocator`'s default
 *   is 27100–27299 (**host** ports, for `adb forward`); this is 28100–28299
 *   (**device** ports, for `adb reverse`). Different namespaces that can never
 *   collide with each other, numbered so an operator reading `adb forward
 *   --list` beside `adb reverse --list` can tell at a glance which farm
 *   allocated which.
 *
 * What could still clash: anything else listening on the *device* in this
 * range — another automation tool's own reverse, or an app under test that
 * binds a fixed port. The host cannot bind-test a device port (§4.3), so the
 * only available collision signal is `adb reverse` itself failing, and
 * `establish()` treats it as exactly that.
 */
export const DEFAULT_DEVICE_PORT_RANGE = { rangeStart: 28100, rangeEnd: 28299 } as const

/** How many device ports a FIRST allocation walks before giving up. A re-establish never walks — see `establish()`. */
const MAX_PORT_ATTEMPTS = 8

export interface DevicePortRange {
  rangeStart: number
  rangeEnd: number
}

/**
 * `ENKAKU_REVERSE_DEVICE_PORT_RANGE`, as `<start>-<end>`. Deliberately a local
 * parser rather than `@enkaku/session`'s `parsePortRange`: that one falls back
 * to the ui-server's *host* range (27100–27299) on anything it cannot read,
 * which would silently hand out host-range numbers as device ports.
 */
export function parseDevicePortRange(raw: string | undefined): DevicePortRange {
  if (!raw) return { ...DEFAULT_DEVICE_PORT_RANGE }
  const m = /^(\d+)-(\d+)$/.exec(raw.trim())
  if (!m) return { ...DEFAULT_DEVICE_PORT_RANGE }
  const rangeStart = Number.parseInt(m[1]!, 10)
  const rangeEnd = Number.parseInt(m[2]!, 10)
  if (!(rangeEnd > rangeStart) || rangeStart < 1 || rangeEnd > 65535) return { ...DEFAULT_DEVICE_PORT_RANGE }
  return { rangeStart, rangeEnd }
}

/** One live (or intended-live) reverse: the phone dials `127.0.0.1:<devicePort>` and lands on the host's `hostPort`. */
export interface ReverseEntry {
  deviceId: string
  /** The adb address the last (re-)establish used. Re-resolved on every device-online pass — a device can come back on a different serial. */
  serial: string
  /** The port ON THE PHONE. Sticky for the life of the entry: the phone's `http_proxy` setting points at it, so it may never be silently reallocated. */
  devicePort: number
  /** The port on THIS machine the reverse forwards to — the operator's listener (plan 112's bridge, typically). */
  hostPort: number
  /**
   * When the reverse was last successfully issued, or `null` when it is known
   * NOT to be live: the device is offline, or the last re-issue failed. This is
   * what step 114.5's `reverse` check reads to report `fail` in the window
   * between a phone coming back and its tunnel being rebuilt (plan 114 §3.7's
   * "the honest cost of rung 2", acceptance criterion 10).
   */
  establishedAt: number | null
}

/** One row of `adb reverse --list`. */
export interface ReverseListEntry {
  /** e.g. `UsbFfs` — see `parseReverseList`. Empty when the line carried no transport field. */
  transport: string
  devicePort: number
  hostPort: number
}

export interface ReverseRegistryDeps {
  /** The one bounded adb CLI helper (`hostAdb.run`). */
  hostAdb: (args: string[]) => Promise<string>
  /**
   * The device's CURRENT adb serial, or `null` when there is no such device.
   * Read fresh on every call rather than captured on the entry: a phone that
   * comes back over Wi-Fi returns on a different address, and re-issuing the
   * reverse against the address it left on would fail forever.
   */
  serialOf: (deviceId: string) => string | null
  /**
   * Consulted on the device-online path only. Presence in the map is already
   * the intent — `release()` is what removes it — so this defaults to "yes";
   * it exists so step 114.5's route service can veto a re-establish for a
   * route an operator disabled while the phone was away, without this module
   * needing to read the database.
   */
  routeEnabled?: (deviceId: string) => boolean
  /** Defaults to `ENKAKU_REVERSE_DEVICE_PORT_RANGE`, then `DEFAULT_DEVICE_PORT_RANGE`. */
  range?: DevicePortRange
  onLog?: (level: 'debug' | 'info' | 'warn', msg: string) => void
}

export interface ReverseRegistry {
  /**
   * Establish (or re-point) this device's reverse. Idempotent: `adb reverse`
   * replaces an existing binding for the same device port rather than
   * refusing it, so re-issuing is always safe.
   *
   * `devicePort` is a **requirement, not a hint**, and the caller supplies it
   * when the phone already carries a setting pointing at it (a core restart
   * restoring a persisted route). Given one, this never walks the range — a
   * silently different device port would leave the phone's `http_proxy`
   * pointing at nothing. Without one, a first allocation walks the range and
   * treats a failing `adb reverse` as the collision signal (§4.3).
   *
   * Throws `E_REVERSE_FAILED` (the code plan 114 §3.9 classifies) when the
   * reverse cannot be established, leaving the entry in place with
   * `establishedAt: null` so the `reverse` check can report it.
   */
  establish(deviceId: string, opts: { hostPort: number; devicePort?: number }): Promise<ReverseEntry>
  /**
   * Tear the reverse down and forget it. **Idempotent, and never throws** —
   * this runs on disconnect and revert paths where the device is routinely
   * already gone, and `adb reverse --remove` against an absent device exits
   * non-zero. The entry is dropped either way: a reverse we cannot reach is
   * not one we are still managing.
   */
  release(deviceId: string): Promise<void>
  get(deviceId: string): ReverseEntry | null
  list(): ReverseEntry[]
  /**
   * The device-online hook (plan 114 §4.3, H3's insurance). Re-issues this
   * device's reverse on the SAME device port. Rejects on failure — the caller
   * is `daemon.ts`'s `onDeviceReady`, which tolerates and logs exactly like
   * every other hook on that path — after marking the entry not-live.
   */
  handleDeviceOnline(deviceId: string): Promise<void>
  /** The device-offline hook. Keeps the entry (the intent survives a replug) and marks it not-live. Never touches the device — it is gone. */
  handleDeviceOffline(deviceId: string): void
  /**
   * Asks the adb server whether this device's reverse is actually listed, for
   * step 114.5's `reverse` check. Never throws: an unreadable listing answers
   * `false`, which is the honest reading — we could not confirm it.
   */
  verify(deviceId: string): Promise<boolean>
}

/** `adb -s <serial> reverse tcp:<devicePort> tcp:<hostPort>` — the phone's loopback port first, this machine's second. */
export async function addReverse(
  hostAdb: (args: string[]) => Promise<string>,
  serial: string,
  devicePort: number,
  hostPort: number,
): Promise<void> {
  await hostAdb(['-s', serial, 'reverse', `tcp:${devicePort}`, `tcp:${hostPort}`])
}

/** `adb -s <serial> reverse --remove tcp:<devicePort>`. Scoped to the exact (serial, device port) pair — never `--remove-all`, which would take another tool's reverses with it. */
export async function removeReverse(
  hostAdb: (args: string[]) => Promise<string>,
  serial: string,
  devicePort: number,
): Promise<void> {
  await hostAdb(['-s', serial, 'reverse', '--remove', `tcp:${devicePort}`])
}

/**
 * Parses `adb reverse --list`.
 *
 * **The trap this function exists to absorb** (measured, plan 109 §0.2): the
 * output is prefixed with the transport, not a bare port pair —
 * `UsbFfs tcp:46999 tcp:45999`, where the FIRST port is the device side and
 * the second is this machine's. A parser that assumes two fields reads the
 * device port out of the transport name and silently matches nothing. Both
 * the three-field and the bare two-field forms are accepted, since the prefix
 * is an adb implementation detail nobody promised us.
 */
export function parseReverseList(raw: string): ReverseListEntry[] {
  const out: ReverseListEntry[] = []
  for (const rawLine of raw.split('\n')) {
    const fields = rawLine.trim().split(/\s+/).filter((f) => f.length > 0)
    if (fields.length < 2) continue
    const [remote, local] = fields.length >= 3 ? [fields[1], fields[2]] : [fields[0], fields[1]]
    const devicePort = parseTcpPort(remote)
    const hostPort = parseTcpPort(local)
    if (devicePort === null || hostPort === null) continue
    out.push({ transport: fields.length >= 3 ? fields[0]! : '', devicePort, hostPort })
  }
  return out
}

function parseTcpPort(spec: string | undefined): number | null {
  if (!spec) return null
  const m = /^tcp:(\d+)$/.exec(spec)
  if (!m) return null
  const port = Number.parseInt(m[1]!, 10)
  return Number.isFinite(port) && port > 0 && port <= 65535 ? port : null
}

export function createReverseRegistry(deps: ReverseRegistryDeps): ReverseRegistry {
  const log = deps.onLog ?? (() => {})
  const range = deps.range ?? parseDevicePortRange(process.env.ENKAKU_REVERSE_DEVICE_PORT_RANGE)
  const routeEnabled = deps.routeEnabled ?? (() => true)
  /** deviceId → the one reverse that device has. The `network-route` lock (plan 114 F23) is what makes "one" structural rather than a convention. */
  const entries = new Map<string, ReverseEntry>()

  const mustSerial = (deviceId: string): string => {
    const serial = deps.serialOf(deviceId)
    if (!serial) throw new EnkakuError('device_not_found', `no such device: ${deviceId}`)
    return serial
  }

  /**
   * `release()`'s body, hoisted so `handleDeviceOnline` can reach it without
   * `this` — the returned object is routinely destructured by callers and a
   * method that depended on its own receiver would break silently there.
   */
  const releaseEntry = async (deviceId: string): Promise<void> => {
    const entry = entries.get(deviceId)
    entries.delete(deviceId)
    if (!entry) return
    const serial = deps.serialOf(deviceId) ?? entry.serial
    try {
      await removeReverse(deps.hostAdb, serial, entry.devicePort)
      log('info', `reverse removed for ${deviceId} (device tcp:${entry.devicePort})`)
    } catch (err) {
      // Routine, not exceptional: the device is usually already gone by the
      // time a revert or a disconnect path gets here, and adb answers
      // "device not found" with a non-zero exit. Nothing is left behind on
      // this machine either way — the reverse lives in the adb server and
      // on a phone we can no longer reach.
      log('debug', `reverse removal for ${deviceId} (device tcp:${entry.devicePort}) failed, tolerated: ${String(err)}`)
    }
  }

  const registry: ReverseRegistry = {
    async establish(deviceId, opts) {
      const serial = mustSerial(deviceId)
      const existing = entries.get(deviceId)
      // A device port already chosen — by a previous establish, or by the
      // caller restoring a persisted route — is honoured exactly. Walking
      // here would move the port out from under the phone's own setting.
      const pinned = opts.devicePort ?? existing?.devicePort ?? null

      if (pinned !== null) {
        const entry: ReverseEntry = { deviceId, serial, devicePort: pinned, hostPort: opts.hostPort, establishedAt: null }
        entries.set(deviceId, entry)
        try {
          await addReverse(deps.hostAdb, serial, pinned, opts.hostPort)
        } catch (err) {
          throw new EnkakuError(
            'E_REVERSE_FAILED',
            `adb reverse tcp:${pinned} tcp:${opts.hostPort} failed on ${serial}: ${String(err)}`,
            err,
          )
        }
        entry.establishedAt = Date.now()
        log('info', `reverse established for ${deviceId}: device tcp:${pinned} → host tcp:${opts.hostPort}`)
        return { ...entry }
      }

      // First allocation. The host cannot bind-test a port on the phone
      // (§4.3), so the ONLY collision signal available is `adb reverse`
      // refusing — walk the range on failure and record what was tried.
      const tried: number[] = []
      let lastErr: unknown = null
      for (let port = range.rangeStart; port <= range.rangeEnd && tried.length < MAX_PORT_ATTEMPTS; port++) {
        tried.push(port)
        try {
          await addReverse(deps.hostAdb, serial, port, opts.hostPort)
        } catch (err) {
          lastErr = err
          log('debug', `reverse tcp:${port} rejected on ${serial}, treating as a device-side collision: ${String(err)}`)
          continue
        }
        const entry: ReverseEntry = { deviceId, serial, devicePort: port, hostPort: opts.hostPort, establishedAt: Date.now() }
        entries.set(deviceId, entry)
        log('info', `reverse established for ${deviceId}: device tcp:${port} → host tcp:${opts.hostPort}`)
        return { ...entry }
      }
      throw new EnkakuError(
        'E_REVERSE_FAILED',
        `no usable device port for ${deviceId} in ${range.rangeStart}-${range.rangeEnd} (tried ${tried.join(', ')}): ${String(lastErr)}`,
        lastErr,
      )
    },

    release: releaseEntry,

    get(deviceId) {
      const entry = entries.get(deviceId)
      return entry ? { ...entry } : null
    },

    list() {
      return [...entries.values()].map((e) => ({ ...e }))
    },

    async handleDeviceOnline(deviceId) {
      const entry = entries.get(deviceId)
      // The common case by a wide margin: no device has a reverse.
      if (!entry) return
      if (!routeEnabled(deviceId)) {
        // **Torn down, not merely skipped.** This map is host-side bookkeeping and the route
        // record is the authority; an entry that outlived its record is an orphan, and leaving it
        // sitting here is how the two stores stay disagreeing. Skipping alone was enough while
        // `adb reverse` died with the transport — but it also meant every later pass had to
        // re-decide the same question, and one that answered "enabled" for a stale row (or a
        // reverse that did survive) would hand the phone a live tunnel to an upstream nobody had
        // asked for since yesterday. `release()` is idempotent and never throws.
        log('info', `device ${deviceId} came online with a reverse entry but no route on record wants it — releasing it rather than re-establishing`)
        // Through the object, not the local: a caller that wrapped `release`
        // (the test harness mirrors it into a fake `adb reverse --list`) must
        // see this teardown too.
        await registry.release(deviceId)
        return
      }
      // Re-resolved, never taken from the entry: a phone that comes back over
      // Wi-Fi returns on a different adb address.
      const serial = mustSerial(deviceId)
      entry.serial = serial
      entry.establishedAt = null
      try {
        await addReverse(deps.hostAdb, serial, entry.devicePort, entry.hostPort)
      } catch (err) {
        // Left `establishedAt: null` deliberately — the `reverse` check reads
        // it and reports `fail`, which is the whole point of plan 114 §3.7's
        // "between the phone coming back and the tunnel being rebuilt, apps
        // using the proxy will fail to connect". A dead reverse must be
        // visible, never silently retried into a different port.
        throw new EnkakuError(
          'E_REVERSE_FAILED',
          `re-establishing reverse tcp:${entry.devicePort} → tcp:${entry.hostPort} on ${serial} failed: ${String(err)}`,
          err,
        )
      }
      entry.establishedAt = Date.now()
      log('info', `reverse re-established for ${deviceId} after reconnect: device tcp:${entry.devicePort} → host tcp:${entry.hostPort}`)
    },

    handleDeviceOffline(deviceId) {
      const entry = entries.get(deviceId)
      if (!entry) return
      entry.establishedAt = null
    },

    async verify(deviceId) {
      const entry = entries.get(deviceId)
      if (!entry) return false
      const serial = deps.serialOf(deviceId) ?? entry.serial
      try {
        const raw = await deps.hostAdb(['-s', serial, 'reverse', '--list'])
        return parseReverseList(raw).some((r) => r.devicePort === entry.devicePort && r.hostPort === entry.hostPort)
      } catch (err) {
        log('debug', `reverse --list failed for ${deviceId}, reporting unverified: ${String(err)}`)
        return false
      }
    },
  }
  return registry
}
