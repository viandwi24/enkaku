import type { AdbClient } from '@enkaku/adb'
import { probeDeviceIdentity } from '@enkaku/session'
import type { ConnectionMedium, SweepReport } from '@enkaku/protocol'
import { addressCount } from '@enkaku/protocol'
import type { Db } from '../db'
import { EnkakuError } from '../util/errors'
import type { Logger } from '../util/logger'
import { classify } from './admission'
import type { EndpointStore } from './endpoints'
import { defaultTcpPreProbe, isConnectSuccess, splitHostPort, type TcpPreProbe } from './reconnect'

/**
 * The bounded subnet sweep (plan 88 §3.5, §4.5, §5 step 88.3) — the fix for
 * H4's premise: a competitor's "scan all networks" button, reimplemented so
 * it cannot become a background loop (§9 Q1) and cannot become a packet
 * storm (§3.5's five axes: singleton, explicit address space, a hard
 * ceiling, bounded concurrency behind a cheap pre-probe, on-demand only).
 *
 * H5's spike (this step's own first task) confirmed a raw `host:connect`
 * against a genuinely dead address is NOT cheap — the local adb server's own
 * outbound TCP attempt can block for tens of seconds to well over a minute
 * before it gives up — but that neither case (an instantly refused port, nor
 * an unroutable black hole) left any residue in `host:devices-l` afterwards.
 * So there is no `host:disconnect` cleanup pass here: nothing to clean up,
 * and the mandatory cheap pre-probe below (never `host:connect` without one
 * accepting first) means a real `host:connect` is never issued to a dead
 * address in the first place.
 */

/** One configured farm network (`discovery.networks[]`, `packages/protocol/src/settings.ts`). */
export interface SweepNetwork {
  cidr: string
  label: string
  medium: ConnectionMedium
  scan: boolean
  /** Overrides `SweeperSettings.tcpPort` for this network only (plan 88 §9 Q7, resolved). `undefined` falls back to the farm-wide port. */
  port?: number
}

/**
 * `SweepReport` itself is declared in `@enkaku/protocol`
 * (`packages/protocol/src/api/devices.ts`'s `SweepReportSchema`), not here —
 * the same "declared once, `POST /api/devices/scan`'s consumer imports the
 * type" convention `ReconcileReportSchema`/`reconcile.ts` already established
 * (00-overview §4.4, plan 72 §3.2).
 */
export interface Sweeper {
  /** Rejects `E_SCAN_BUSY` if one is already running; `E_SCAN_UNAVAILABLE` when scanning is off or no scannable network is configured. */
  sweep(opts?: { expect?: string[] }): Promise<SweepReport>
  running(): boolean
}

export interface SweeperSettings {
  tcpPort: number
  /** How long to wait for a just-`host:connect`ed address to settle into `device` state before the identity probe (plan 88 §3.3's same wait, reused here rather than probing an address that has not finished authorizing/settling yet). */
  connectSettleMs: number
  networks: SweepNetwork[]
  scan: { mode: 'off' | 'on-demand'; maxAddresses: number; concurrency: number; probeTimeoutMs: number }
}

export interface SweeperDeps {
  client: AdbClient
  db: Db
  endpoints: EndpointStore
  /** The exact admission-gated path every other adopt/discover route uses (plan 56, F14) — see the module comment on WHY nothing here writes to `devices` or `discovered_devices` directly. */
  registry: { onOnline(serial: string): Promise<void> }
  settings: () => SweeperSettings
  log: Logger
  /** Injectable so a test proves this against a fake, never a real socket — same discipline as `reconnect.ts`. Defaults to `defaultTcpPreProbe`. */
  tcpPreProbe?: TcpPreProbe
}

/** `10.20.0.0` → `169083904` (a plain sum of weighted octets — safe well within `Number`'s exact-integer range, no bit-shift sign issues). */
function ipToInt(ip: string): number {
  const parts = ip.split('.').map((s) => Number(s))
  return parts[0]! * 2 ** 24 + parts[1]! * 2 ** 16 + parts[2]! * 2 ** 8 + parts[3]!
}

/** The inverse of `ipToInt`. */
function intToIp(n: number): string {
  return [Math.floor(n / 2 ** 24) % 256, Math.floor(n / 2 ** 16) % 256, Math.floor(n / 2 ** 8) % 256, n % 256].join('.')
}

/** `null` for anything not exactly four dot-separated `[0,255]` octets — used only for the BEST-EFFORT priority-octet hint below, never for admission or validation (that is `CidrSchema`'s job, already enforced at settings save time). */
function ipToIntSafe(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  const nums = parts.map((p) => Number(p))
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null
  return ipToInt(ip)
}

function parseCidrRange(cidr: string): { base: number; prefix: number; total: number } {
  const [addr, prefixStr] = cidr.split('/')
  const prefix = Number(prefixStr)
  return { base: ipToInt(addr!), prefix, total: 2 ** (32 - prefix) }
}

/**
 * The addresses one CIDR block actually contributes to a sweep — fewer than
 * `addressCount()` reports, on purpose (plan 88 §3.5's cost table: "254
 * pre-probes" for a `/24`, not 256): a `/24`-or-larger block's network and
 * broadcast address are excluded, since neither is ever a device. A `/31`
 * (point-to-point, RFC 3021) or `/32` (a single declared host) has no such
 * addresses to exclude — every address in the block is usable.
 */
function hostsForCidr(cidr: string): number[] {
  const { base, prefix, total } = parseCidrRange(cidr)
  const start = prefix <= 30 ? base + 1 : base
  const end = prefix <= 30 ? base + total - 1 : base + total // exclusive
  const hosts: number[] = []
  for (let i = start; i < end; i++) hosts.push(i)
  return hosts
}

/** Ascending, but rotated to start at `priorityHost` when it falls inside `hosts` — "probe the last-known final octet first, then ascending" (plan 88 §3.5). */
function orderHosts(hosts: number[], priorityHost: number | null): number[] {
  if (priorityHost === null) return hosts
  const idx = hosts.indexOf(priorityHost)
  if (idx <= 0) return hosts
  return [...hosts.slice(idx), ...hosts.slice(0, idx)]
}

/**
 * For each network, the most useful "start here" address: the host portion
 * of the newest remembered endpoint (across every `stableId` in `expect`,
 * retired ones included — any past sighting beats none) that falls inside
 * that network's range. A device usually comes back near where it was (plan
 * 88 §3.5) — this is a free optimisation, never a correctness requirement:
 * every address in every scannable network is still probed regardless.
 */
function computePriorityHosts(networks: SweepNetwork[], expect: string[] | undefined, endpoints: EndpointStore): Map<string, number> {
  const result = new Map<string, number>()
  if (!expect || expect.length === 0) return result
  const ranges = networks.map((n) => ({ cidr: n.cidr, ...parseCidrRange(n.cidr) }))
  for (const stableId of expect) {
    for (const candidate of endpoints.candidates(stableId, { includeRetired: true })) {
      let host: string
      try {
        ;({ host } = splitHostPort(candidate.address))
      } catch {
        continue
      }
      const hostInt = ipToIntSafe(host)
      if (hostInt === null) continue
      for (const range of ranges) {
        if (result.has(range.cidr)) continue // first (newest) match for this network wins
        if (hostInt >= range.base && hostInt < range.base + range.total) result.set(range.cidr, hostInt)
      }
    }
  }
  return result
}

/** Same wait `reconnect.ts`'s ladder uses before trusting a just-connected address (plan 88 §3.3 step 3) — a fresh `host:connect` does not mean the transport has finished settling into `device` state yet. */
async function waitForSettle(client: AdbClient, address: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  const pollMs = Math.min(200, Math.max(25, Math.floor(timeoutMs / 10)))
  for (;;) {
    const list = await client.listDevices()
    if (list.some((d) => d.serial === address && d.state === 'device')) return true
    if (Date.now() >= deadline) return false
    await Bun.sleep(pollMs)
  }
}

/** Runs `worker` over `items` with at most `concurrency` in flight — a pull-based pool, not fixed batches, so one slow address never stalls the others behind it. */
async function runPool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const lanes = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      await worker(items[i]!)
    }
  })
  await Promise.all(lanes)
}

/**
 * Builds the sweeper (plan 88 §4.5). A singleton BY CONSTRUCTION, not by
 * locking a shared resource: one process constructs one `Sweeper`, and its
 * `inFlight` promise IS the farm-wide mutex — twenty callers asking at once
 * still produce at most one running sweep, with the other nineteen rejected
 * `E_SCAN_BUSY` immediately rather than queued (a queued sweep behind a
 * sweep behind a sweep is not what "singleton" is for).
 */
export function createSweeper(deps: SweeperDeps): Sweeper {
  const tcpPreProbe = deps.tcpPreProbe ?? defaultTcpPreProbe

  async function sweepImpl(opts?: { expect?: string[] }): Promise<SweepReport> {
    const started = Date.now()
    const cfg = deps.settings()
    const scannable = cfg.networks.filter((n) => n.scan)

    if (cfg.scan.mode === 'off') {
      throw new EnkakuError('E_SCAN_UNAVAILABLE', 'network scanning is turned off (discovery.scan.mode) — turn it on in Settings to sweep')
    }
    if (scannable.length === 0) {
      throw new EnkakuError('E_SCAN_UNAVAILABLE', 'no scannable network is configured — add one under Settings → Farm networks')
    }

    // Skip-known (§3.5): an address adb already lists, in ANY state, is
    // never re-probed here — the ordinary reconciler pass already owns it.
    const known = new Set((await deps.client.listDevices()).map((d) => d.serial))

    const priorityHosts = computePriorityHosts(scannable, opts?.expect, deps.endpoints)
    const networksReport: SweepReport['networks'] = []
    const plan: string[] = []
    let skipped = 0
    for (const net of scannable) {
      const effectivePort = net.port ?? cfg.tcpPort
      networksReport.push({ cidr: net.cidr, label: net.label, addresses: addressCount(net.cidr), port: effectivePort })
      const ordered = orderHosts(hostsForCidr(net.cidr), priorityHosts.get(net.cidr) ?? null)
      for (const hostInt of ordered) {
        const address = `${intToIp(hostInt)}:${effectivePort}`
        if (known.has(address)) {
          skipped++
          continue
        }
        plan.push(address)
      }
    }
    // Defence in depth: `discovery`'s own save-time refinement already keeps
    // `sum(addressCount) <= scan.maxAddresses`, so `plan.length` should never
    // exceed it — this cap is what makes that a guarantee, not an assumption.
    const capped = plan.slice(0, cfg.scan.maxAddresses)

    // The address book's reverse index (address → the ONE stableId it is
    // remembered for) — this is what makes a conflict detectable at all: a
    // brand-new address with no history is never a conflict, only ever
    // 'adopted' or 'discovered' below.
    const addressOwner = new Map<string, string>()
    for (const { stableId, candidates } of deps.endpoints.allWithEndpoints()) {
      for (const candidate of candidates) addressOwner.set(candidate.address, stableId)
    }

    let scanned = 0
    let answered = 0
    let connected = 0
    let identified = 0
    const adopted: string[] = []
    const discovered: string[] = []
    const conflicts: SweepReport['conflicts'] = []

    await runPool(capped, Math.max(1, cfg.scan.concurrency), async (address) => {
      const { host, port } = splitHostPort(address)
      const preProbeResult = await tcpPreProbe(host, port, cfg.scan.probeTimeoutMs)
      scanned++
      if (preProbeResult !== 'accepted') {
        return
      }
      answered++

      let connectReply: string
      try {
        connectReply = await deps.client.connectDevice(address)
      } catch (err) {
        deps.log.debug(`sweep: host:connect to ${address} threw: ${String(err)}`)
        return
      }
      if (!isConnectSuccess(connectReply)) return
      connected++

      const settled = await waitForSettle(deps.client, address, cfg.connectSettleMs)
      if (!settled) {
        deps.log.debug(`sweep: ${address} connected but never settled into "device" state`)
        return
      }

      let probe: Awaited<ReturnType<typeof probeDeviceIdentity>>
      try {
        probe = await probeDeviceIdentity(deps.client, address)
      } catch (err) {
        deps.log.debug(`sweep: identity probe of ${address} failed: ${String(err)}`)
        return
      }
      identified++

      const owner = addressOwner.get(address)
      if (owner && owner !== probe.stableId) {
        // Somebody else's phone at an address WE remember for a different
        // one (plan 88 §8 risk table) — dropped immediately, never adopted
        // here. The reconciler's own ordinary pass may pick `probe.stableId`
        // up later, through the SAME admission gate every other path uses.
        conflicts.push({ address, expected: owner, found: probe.stableId })
        try {
          await deps.client.disconnectDevice(address)
        } catch (err) {
          deps.log.warn(`sweep: could not disconnect ${address} after finding a conflicting stableId: ${String(err)}`)
        }
        return
      }

      // Every identified stableId — expected or not — goes through the SAME
      // admission gate every other path uses (plan 56, F14). This function
      // only READS `classify` first, to know which bucket to report; it is
      // `registry.onOnline` below, not this sweep, that ever writes a
      // `devices` or `discovered_devices` row. A sweep cannot enrol a
      // device: 'admitted' reconnects one that already exists, 'discovered'
      // records a sighting for the tray, 'blocked' is a safe no-op either way.
      const admission = classify(deps.db, probe.stableId)
      if (admission === 'admitted') adopted.push(probe.stableId)
      else if (admission === 'discovered') discovered.push(probe.stableId)
      await deps.registry.onOnline(address)
    })

    return {
      networks: networksReport,
      scanned,
      skipped,
      answered,
      connected,
      identified,
      adopted,
      discovered,
      conflicts,
      durationMs: Date.now() - started,
    }
  }

  let inFlight: Promise<SweepReport> | null = null

  async function sweep(opts?: { expect?: string[] }): Promise<SweepReport> {
    if (inFlight) {
      throw new EnkakuError('E_SCAN_BUSY', 'a sweep is already running — wait for it to finish before starting another')
    }
    const run = sweepImpl(opts).finally(() => {
      inFlight = null
    })
    inFlight = run
    return run
  }

  return {
    sweep,
    running: () => inFlight !== null,
  }
}
