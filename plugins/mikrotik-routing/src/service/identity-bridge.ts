import type { DeviceInfo } from '@enkaku/protocol'
import type { Lease } from './router-driver'

/**
 * The device → LAN IP bridge, plan 122 §3.4 / §4.9 / step 122.4.
 *
 * The single most dangerous piece of this whole plugin (§8, first risk row):
 * a stale or wrong LAN IP steers the WRONG device, silently — the router
 * cannot tell "this rule is for the right phone" from "this rule is for a
 * phone that used to have this address." Everything below exists to make
 * that uncertainty visible rather than paper over it.
 *
 * Pure and I/O-free by design (plan 122 task brief for step 122.4): this
 * module takes `DeviceInfo[]` (what `device.list` returns) and the router's
 * DHCP leases (`RouterInventory.leases`, from `inventory()`) as plain data
 * and returns a plain data structure. It never calls the capability broker,
 * never touches KV, and never reaches the router — that wiring is a later
 * step's job. This is what makes the three-tier preference and the
 * lease-cross-check exhaustively unit-testable with no fixtures beyond
 * plain objects.
 *
 * ## The three tiers (§3.4)
 *
 * 1. `transport` — the device is on adb-tcp, so `DeviceInfo.connection.address`
 *    (`packages/protocol/src/device.ts`, `DeviceConnectionSchema`, confirmed
 *    at lines 23-33: `address: z.string().nullable()`, `port:
 *    z.number().int().nullable()`) *is* the LAN IP — exact and live, no
 *    probing, no guessing. This covers the owner's entire farm.
 * 2. `probe` — read from the device itself by the `discover-lan-ip` member
 *    script (step 122.10, not built yet). Needed only for USB-attached
 *    devices, which `DeviceInfo.connection.address` is `null` for (§0.3 item
 *    4 — nothing in the repo reads a device's IP any other way).
 * 3. `manual` — typed by the operator (UI, a later step).
 *
 * Tiers 2 and 3 are sourced elsewhere and handed in here as plain data (the
 * `stored` parameter) — this module's job is only to REPRESENT which tier
 * produced a value (`lanIpSource`) and to prefer correctly between all
 * three: `transport` always wins when the device is live on adb-tcp (it is
 * more current than anything stored, by construction); failing that,
 * `probe` wins over `manual` (a device that has actually answered a probe is
 * more trustworthy than a value an operator once typed, which can go stale
 * the moment the phone's IP changes). Both stored candidates are accepted at
 * once, rather than a single already-resolved `{ lanIp, lanIpSource }`,
 * specifically so this preference is a real, testable code path rather than
 * an assumption baked into whatever wrote the KV row — plan 122 §4.9's
 * `assignment` record happens to hold only one at a time today, but the
 * bridge does not assume that will always be true of every caller.
 *
 * A device with no derivable address at all (USB, nothing probed, nothing
 * typed) comes out as an explicit `needs-address` state — never hidden, and
 * never guessed at. `DeviceLanAddress` is a discriminated union on `state`
 * for exactly this reason: a caller cannot read `.lanIp` off an unresolved
 * device by accident, because the field does not exist on that arm of the
 * type.
 *
 * ## The lease cross-check (§3.4, §0.3 item 3)
 *
 * Once a LAN IP is resolved (whichever tier it came from), it is looked up
 * in the router's own DHCP lease table BY IP — never by MAC, because there
 * is no MAC anywhere in this codebase (§0.3 item 3: no `mac`/`wifiMac`/
 * `hwaddr` column, field, or adb read in `packages/core`, `packages/protocol`,
 * or `packages/adb`). The result is a `leaseKind`:
 *
 * - `'dynamic'` — a lease exists and RouterOS's own `dynamic` flag is true:
 *   this IP was handed out by the DHCP server and can move to a different
 *   phone at any time. This is the warning §3.4 calls for on the assignment,
 *   because a `dynamic` lease is exactly the condition under which a stale
 *   stored IP silently steers the wrong device.
 * - `'static'` — a lease exists and is an operator-added static entry: this
 *   IP is reserved for this MAC and will not move underneath the assignment.
 * - `'none'` — no lease at all for this IP. Deliberately its own state, not
 *   folded into either of the above: an IP with no lease is not proven safe
 *   (it could be a stale IP the device no longer holds) and it is not proven
 *   dangerous (it could be reserved outside DHCP entirely) — it is simply
 *   unverifiable from the lease table, which is a different fact from either
 *   'static' or 'dynamic' and must read differently in the UI.
 */

/** Which of the three tiers produced a resolved LAN IP (§3.4). */
export type LanIpSource = 'transport' | 'probe' | 'manual'

/** Whether the resolved LAN IP's own DHCP lease (matched by IP, never MAC — §0.3 item 3) makes it safe to trust going forward. */
export type LeaseKind = 'static' | 'dynamic' | 'none'

/**
 * Tier 2 and tier 3 candidates, sourced elsewhere (probe script, manual UI
 * entry — both later steps) and handed to this pure module as plain data.
 * Either or both may be absent; when both are present `probe` wins (see this
 * file's header). Deliberately NOT `{ lanIp, lanIpSource }` — see the header
 * for why two independent candidates make the tier-2-vs-tier-3 preference a
 * real, tested code path.
 */
export interface StoredLanCandidates {
  probe: string | null
  manual: string | null
}

interface DeviceLanBase {
  deviceId: string
  stableId: string
  label: string
}

/** A device whose LAN IP could be resolved from one of the three tiers, cross-checked against the router's lease table. */
export interface ResolvedDeviceLan extends DeviceLanBase {
  state: 'resolved'
  lanIp: string
  lanIpSource: LanIpSource
  leaseKind: LeaseKind
  /** The matching lease row, or `null` when `leaseKind` is `'none'`. Carried through so a caller can show the lease's own fields (status, id) without a second lookup. */
  lease: Lease | null
}

/**
 * A device with no derivable LAN IP at all — not on adb-tcp, never probed,
 * never typed. This is the honest "needs an address" state §3.4 and this
 * step's own task brief both require: it must not be hidden from a fleet
 * view and must not be papered over with a guess. There is deliberately no
 * `lanIp` field on this arm of the union.
 */
export interface UnresolvedDeviceLan extends DeviceLanBase {
  state: 'needs-address'
}

export type DeviceLanAddress = ResolvedDeviceLan | UnresolvedDeviceLan

/** Picks the LAN IP and its source, honouring the tier order `transport > probe > manual` (§3.4). Returns `null` when none of the three tiers produced anything. */
function pickLanIp(transportAddress: string | null, stored: StoredLanCandidates | undefined): { lanIp: string; lanIpSource: LanIpSource } | null {
  if (transportAddress) return { lanIp: transportAddress, lanIpSource: 'transport' }
  if (stored?.probe) return { lanIp: stored.probe, lanIpSource: 'probe' }
  if (stored?.manual) return { lanIp: stored.manual, lanIpSource: 'manual' }
  return null
}

/** Looks the resolved IP up in the router's own lease table BY IP (never MAC — §0.3 item 3) and classifies it. */
function classifyLease(lanIp: string, leases: readonly Lease[]): { leaseKind: LeaseKind; lease: Lease | null } {
  const lease = leases.find((l) => l.address === lanIp) ?? null
  if (lease === null) return { leaseKind: 'none', lease: null }
  return { leaseKind: lease.dynamic ? 'dynamic' : 'static', lease }
}

/**
 * Resolves one device's LAN address. Exported alongside `buildIdentityBridge`
 * (the fleet-wide convenience below) so a caller that already has a single
 * `DeviceInfo` in hand — the assignment flow of a later step, for instance —
 * is not forced to build a one-element array just to reuse the logic.
 */
export function resolveDeviceLan(device: DeviceInfo, stored: StoredLanCandidates | undefined, leases: readonly Lease[]): DeviceLanAddress {
  const base: DeviceLanBase = { deviceId: device.id, stableId: device.stableId, label: device.label }
  const picked = pickLanIp(device.connection.address, stored)
  if (picked === null) {
    return { ...base, state: 'needs-address' }
  }
  const { leaseKind, lease } = classifyLease(picked.lanIp, leases)
  return { ...base, state: 'resolved', lanIp: picked.lanIp, lanIpSource: picked.lanIpSource, leaseKind, lease }
}

/**
 * Builds the whole fleet's device → LAN IP table (step 122.4's own "Result"
 * line: "'which device is which IP' is answerable and its uncertainty is
 * visible, not assumed away"). `stored` is keyed by `DeviceInfo.id` — the
 * same id the plan's §4.9 `assignment` KV record is scoped to
 * (`storage.forDevice(deviceId)`).
 */
export function buildIdentityBridge(devices: readonly DeviceInfo[], leases: readonly Lease[], stored: ReadonlyMap<string, StoredLanCandidates> = new Map()): DeviceLanAddress[] {
  return devices.map((device) => resolveDeviceLan(device, stored.get(device.id), leases))
}
