/**
 * Plan 134 (M99) — what "Up" actually means.
 *
 * Until this file, a path's health was one boolean built from one router
 * field: `/ip/route`'s `active`, which is `check-gateway=ping`'s verdict. That
 * answers *"does the modem's LAN interface reply to ICMP"*. Every operator who
 * reads it reads *"traffic sent down this path reaches the internet"*. On the
 * owner's farm those came apart on the first try: device #20's modem answered
 * every ping and had **no data plan at all** — no upstream, reported healthy,
 * and the operator went looking at the router instead of the SIM (§0.1).
 *
 * So health is three independent facts here, each named after the question it
 * actually answers, none of them standing in for another:
 *
 *   link     — can the router reach this path's gateway at all?
 *              (an address in the gateway's subnet, and a resolvable route)
 *   gateway  — does the modem answer?  (today's signal, correctly labelled)
 *   egress   — does traffic through this table reach the internet, and from
 *              which public IP?  Costs a real request through a metered SIM,
 *              so it is `unknown` until something measures it — §3.2.
 *
 * The rule that makes the whole thing worth having: **a fact nobody measured
 * is `unknown`, never `ok`.** That is the workspace's standing rule about
 * `unverified` never being worded as success (CLAUDE.md), and it is the only
 * reason a three-field model beats the one boolean it replaces — a model that
 * guesses the third field is the old lie with more columns.
 *
 * Pure: no I/O, no clock, no router. `router-driver.ts` fetches, this decides.
 */

import type { DhcpClient, IpRoute } from './schemas'

/** A fact the plugin either observed (`ok`/`fail`) or did not (`unknown`). There is no fourth state, and `unknown` is never rendered as success (§1.2). */
export type Probe = 'ok' | 'fail' | 'unknown'

export type PathDownReason = 'no-default-route' | 'no-route-to-gateway' | 'gateway-unreachable'

/**
 * Plan 133 §3.1. Order matters: no route at all outranks an unresolvable one,
 * which outranks a silent gateway.
 *
 * A route whose `immediate-gw` field is ABSENT (rather than present-and-empty)
 * yields `gateway-unreachable` — the least specific answer. A future RouterOS
 * that stopped sending the field must not be read as a wiring fault nobody
 * observed (plan 133 §8 R1).
 */
export function downReason(route: { 'immediate-gw'?: string } | undefined): PathDownReason {
  if (!route) return 'no-default-route'
  const immediate = route['immediate-gw']
  if (immediate !== undefined && immediate.trim() === '') return 'no-route-to-gateway'
  return 'gateway-unreachable'
}

/** The router-side half of a path's health. `egress` and `publicIp` are added later, by whatever actually probed (§3.3) — never derived here. */
export interface DerivedHealth {
  /**
   * UNCHANGED from every version before plan 134: `defaultRoute?.active ??
   * false`. The planner, plan 132's `overDownPath` and every other consumer
   * read this and must keep reading exactly what they read before — the three
   * new fields are additive, and §8 R4 is the test that says so.
   */
  up: boolean
  /** Absent when `up`. Plan 133. */
  reason?: PathDownReason
  link: Probe
  gateway: Probe
}

/**
 * §4.2/§4.3. Note the one non-obvious case, and it is the point of the whole
 * three-field split: when `link` fails, `gateway` is **`unknown`, not
 * `fail`**. The router never got far enough to ask the modem anything, so
 * reporting the modem as failing would be claiming an observation nobody made
 * — the same category of lie as #20's false "Up", pointed the other way.
 */
export function deriveHealth(defaultRoute: IpRoute | undefined): DerivedHealth {
  const up = defaultRoute?.active ?? false
  if (up) return { up: true, link: 'ok', gateway: 'ok' }

  const reason = downReason(defaultRoute)
  const link: Probe = reason === 'gateway-unreachable' ? 'ok' : 'fail'
  // `link: fail` means the question was never put to the modem.
  const gateway: Probe = link === 'ok' ? 'fail' : 'unknown'
  return { up: false, reason, link, gateway }
}

// ---------------------------------------------------------------------------
// Fleet faults — §3.4. A duplicate is a property of a PAIR, not of either
// member, so it cannot be derived while looping over one path at a time. It is
// computed across the whole inventory and attached to every path involved, so
// one row can name its twin instead of an operator cross-referencing forty.
// ---------------------------------------------------------------------------

/** `192.168.8.100/24` → `192.168.8.100`. RouterOS prints the WAN address WITH its prefix; the prefix is not part of the identity being compared. */
export function bareAddress(address: string | undefined): string | null {
  if (!address) return null
  const trimmed = address.trim()
  if (trimmed === '') return null
  const slash = trimmed.indexOf('/')
  return slash === -1 ? trimmed : trimmed.slice(0, slash)
}

export interface FleetFaults {
  /** Other path ids whose uplink holds the SAME address this one does. The plan 133 fault, named directly (§0.3). */
  duplicateAddressWith: string[]
  /** Other path ids observed egressing from the SAME public IP. Only ever populated from paths that were actually probed — §3.4. This is plan 132 §0's ban risk, made visible. */
  duplicatePublicIpWith: string[]
}

export interface FleetFaultInput {
  pathId: string
  /** The uplink interface this path's gateway is reached through, if it could be identified. */
  wanInterface?: string | null
  /** As measured, not as assumed. Absent for a path nothing has probed. */
  publicIp?: string | null
}

/**
 * Groups by value and reports every member of any group larger than one.
 *
 * Deliberately NOT keyed on the interface: two uplinks holding one address is
 * exactly the fault being looked for, so keying on the thing that differs
 * would hide the thing that matches. An absent value is never a group — forty
 * unprobed paths must not all become "duplicates of each other", which is the
 * obvious way to write this and is worse than reporting nothing.
 */
function duplicatesOf<T extends { pathId: string }>(rows: readonly T[], valueOf: (row: T) => string | null | undefined): Map<string, string[]> {
  const byValue = new Map<string, string[]>()
  for (const row of rows) {
    const value = valueOf(row)
    if (value === null || value === undefined || value === '') continue
    const list = byValue.get(value)
    if (list) list.push(row.pathId)
    else byValue.set(value, [row.pathId])
  }
  const out = new Map<string, string[]>()
  for (const pathIds of byValue.values()) {
    if (pathIds.length < 2) continue
    for (const pathId of pathIds) out.set(pathId, pathIds.filter((other) => other !== pathId))
  }
  return out
}

/**
 * §3.4. `clients` is `/ip/dhcp-client` — the router's WAN side, one row per
 * uplink, and the place the plan 133 fault was legible in a single line.
 */
export function deriveFleetFaults(rows: readonly FleetFaultInput[], clients: readonly DhcpClient[]): Map<string, FleetFaults> {
  const addressByInterface = new Map<string, string>()
  for (const client of clients) {
    const iface = client.interface
    const address = bareAddress(client.address)
    if (iface && address) addressByInterface.set(iface, address)
  }

  const dupAddress = duplicatesOf(rows, (row) => (row.wanInterface ? addressByInterface.get(row.wanInterface) : null))
  const dupPublicIp = duplicatesOf(rows, (row) => row.publicIp)

  const out = new Map<string, FleetFaults>()
  for (const row of rows) {
    out.set(row.pathId, {
      duplicateAddressWith: dupAddress.get(row.pathId) ?? [],
      duplicatePublicIpWith: dupPublicIp.get(row.pathId) ?? [],
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// The egress probe — §4.4.
// ---------------------------------------------------------------------------

/**
 * What a probe actually returned. `status: 'unknown'` is a first-class,
 * expected outcome, not an error path: a router that cannot run the probe at
 * all must say so plainly rather than report the path as failing.
 */
export interface EgressProbeResult {
  status: Probe
  /** One sentence for the operator. Always present, including when `ok`. */
  message: string
  /** Best-effort, from the router's own reply. Absent when the probe could not run. */
  packetLoss?: number
}

/**
 * RouterOS `POST /rest/ping` returns one object per packet. Only the fields
 * read here are named; this build has NOT been run against a real router's
 * `/ping` response (the owner's RouterOS 7.24 rejected `routing-table=` on
 * `/ping` during the plan 133 session, which is how the parameter below was
 * chosen — `interface=` — but the RESPONSE shape is still inference from
 * public documentation, exactly the kind of inference `schemas.ts`'s header
 * records going wrong once already).
 *
 * That is why nothing here rejects a row and why the failure mode is
 * `unknown`: if the shape is wrong, the operator is told the probe could not
 * be read, never that the path is broken.
 */
export function summarisePing(raw: unknown, target: string, iface: string): EgressProbeResult {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { status: 'unknown', message: `The router accepted the probe but returned nothing readable for ${iface}. Egress is unmeasured, not failed.` }
  }
  let received = 0
  for (const row of raw) {
    if (typeof row !== 'object' || row === null) continue
    const record = row as Record<string, unknown>
    // RouterOS prints `status` only on a FAILED packet ("timeout",
    // "host unreachable"). A packet that carries a round-trip time and no
    // status is one that came back.
    const failed = typeof record.status === 'string' && record.status.trim() !== ''
    if (!failed && record.time !== undefined) received += 1
  }
  const sent = raw.length
  const packetLoss = Math.round(((sent - received) / sent) * 100)
  if (received === 0) {
    return {
      status: 'fail',
      message: `Nothing came back from ${target} through ${iface} (${sent}/${sent} lost). The modem answers the router, but has no working upstream — check the SIM's data plan or the carrier session, not the router.`,
      packetLoss,
    }
  }
  return { status: 'ok', message: `${received}/${sent} replies from ${target} through ${iface}. This path reaches the internet.`, packetLoss }
}
