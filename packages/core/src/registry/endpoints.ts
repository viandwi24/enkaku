import { and, eq, sql } from 'drizzle-orm'
import type { ConnectionMedium } from '@enkaku/protocol'
import type { Db } from '../db'
import { deviceEndpoints, type DeviceEndpointRow } from '../db/schema'

/**
 * `host:port` shape adb itself uses for a TCP serial — the same test
 * `device-registry.ts`'s (module-private) `TCP_SERIAL_RE` applies, repeated
 * here rather than exported across files for one regex: a USB serial never
 * contains a colon, so this is purely observational (plan 88 §3.1), not a
 * guess. `host` may be bracketed IPv6 or a bare hostname/IPv4.
 */
const TCP_ADDRESS_RE = /^(\[[0-9a-fA-F:]+\]|[^\s:]+):(\d{1,5})$/

/** One remembered network address for a device (plan 88 §3.2, §4.3). */
export interface Endpoint {
  stableId: string
  /** `host:port` — exactly the string adb uses as a serial. */
  address: string
  medium: ConnectionMedium | null
  source: 'observed' | 'declared' | 'scanned'
  firstSeen: number
  lastConnectedAt: number | null
  lastAttemptAt: number | null
  consecutiveFailures: number
  conflictStableId: string | null
}

export interface EndpointStore {
  /** Called from the registry's success path — free, no extra adb work (plan 88 §3.2). A no-op for a USB (non `host:port`) serial. */
  observe(stableId: string, serial: string): void
  /** An operator says an address belongs to a device (the cutover wizard, or device settings) — `source: 'declared'`, and a declaration is never silently overwritten by a later `observe`. */
  declare(stableId: string, address: string, medium: ConnectionMedium | null): void
  /**
   * Ordered for the ladder: `lastConnectedAt` DESC, `consecutiveFailures` ASC.
   * Retired (`consecutiveFailures >= discovery.endpointRetireAfter`) addresses
   * are excluded entirely unless `includeRetired`, in which case they are
   * appended, in the same order, after every active one.
   */
  candidates(stableId: string, opts?: { includeRetired?: boolean }): Endpoint[]
  noteAttempt(stableId: string, address: string, outcome: 'connected' | 'failed' | 'conflict', conflictStableId?: string): void
  /** Removes one address, or every address for `stableId` when `address` is omitted. */
  forget(stableId: string, address?: string): void
  /** Every `stableId` with at least one remembered address — the restart flow's reattach list (plan 88 §3.10). */
  allWithEndpoints(): Array<{ stableId: string; candidates: Endpoint[] }>
}

export interface EndpointStoreDeps {
  db: Db
  /**
   * `discovery.endpointsPerDevice` / `discovery.endpointRetireAfter`, read
   * live (not captured once) so a settings change takes effect on the very
   * next call — the same "read settings fresh each time" discipline
   * `reconcile.ts`'s `deps.settings()` already uses.
   */
  settings: () => { endpointsPerDevice: number; endpointRetireAfter: number }
}

function toEpochSeconds(d: Date): number {
  return Math.floor(d.getTime() / 1000)
}

function rowToEndpoint(row: DeviceEndpointRow): Endpoint {
  return {
    stableId: row.stableId,
    address: row.address,
    medium: (row.medium as ConnectionMedium | null) ?? null,
    source: row.source as Endpoint['source'],
    firstSeen: toEpochSeconds(row.firstSeen),
    lastConnectedAt: row.lastConnectedAt ? toEpochSeconds(row.lastConnectedAt) : null,
    lastAttemptAt: row.lastAttemptAt ? toEpochSeconds(row.lastAttemptAt) : null,
    consecutiveFailures: row.consecutiveFailures,
    conflictStableId: row.conflictStableId ?? null,
  }
}

/**
 * `lastConnectedAt` DESC (nulls last), `consecutiveFailures` ASC — the
 * ladder's own ordering (plan 88 §3.3, §4.3) — with `seq` DESC as a final
 * tiebreaker. Operates on raw rows (not the public `Endpoint` shape) because
 * `seq` is an internal-only column (see its comment in `db/schema.ts`):
 * every repo timestamp is unix SECONDS, so several writes for one device
 * within the same wall-clock second — plausible in a burst — would otherwise
 * tie with no defined order.
 */
function sortForLadder(rows: DeviceEndpointRow[]): DeviceEndpointRow[] {
  return [...rows].sort((a, b) => {
    const at = a.lastConnectedAt?.getTime() ?? -Infinity
    const bt = b.lastConnectedAt?.getTime() ?? -Infinity
    if (at !== bt) return bt - at
    if (a.consecutiveFailures !== b.consecutiveFailures) return a.consecutiveFailures - b.consecutiveFailures
    return b.seq - a.seq
  })
}

/**
 * The address book (plan 88 §3.2, §4.3) — the fix for F10. Two write paths
 * (`observe`, free and automatic; `declare`, an operator's explicit say-so),
 * one eviction rule enforced inside both: after any upsert, only the newest
 * `discovery.endpointsPerDevice` rows survive for that `stableId`, ranked by
 * `COALESCE(lastConnectedAt, firstSeen)` (then `seq`, the same tiebreak
 * `sortForLadder` uses) — a row that has never connected (a fresh `declare`)
 * is ranked by when it was DECLARED, not treated as infinitely old, so
 * declaring an address never evicts itself on the same call that created it.
 * A phone that has walked through five DHCP leases does not need the
 * fifth-oldest; an unbounded table is a slow leak on a farm that runs for
 * months (plan 88 §3.2, and its own "judgement" note on a farm that
 * re-enrols devices often).
 */
export function createEndpointStore(deps: EndpointStoreDeps): EndpointStore {
  const { db } = deps

  function getRow(stableId: string, address: string): DeviceEndpointRow | undefined {
    return db
      .select()
      .from(deviceEndpoints)
      .where(and(eq(deviceEndpoints.stableId, stableId), eq(deviceEndpoints.address, address)))
      .get()
  }

  /** Strictly higher than every `seq` written so far (plan 88 §3.2 deviation note in `db/schema.ts`). */
  function nextSeq(): number {
    const row = db.select({ maxSeq: sql<number>`coalesce(max(${deviceEndpoints.seq}), 0)` }).from(deviceEndpoints).get()
    return (row?.maxSeq ?? 0) + 1
  }

  /** Keep only the newest `endpointsPerDevice` rows for `stableId` (plan 88 §4.3's "eviction happens inside observe/declare"). */
  function evict(stableId: string): void {
    const cap = Math.max(1, Math.floor(deps.settings().endpointsPerDevice))
    const rows = db.select().from(deviceEndpoints).where(eq(deviceEndpoints.stableId, stableId)).all()
    if (rows.length <= cap) return
    const ranked = [...rows].sort((a, b) => {
      const at = (a.lastConnectedAt ?? a.firstSeen).getTime()
      const bt = (b.lastConnectedAt ?? b.firstSeen).getTime()
      if (at !== bt) return bt - at
      return b.seq - a.seq
    })
    for (const row of ranked.slice(cap)) {
      db.delete(deviceEndpoints)
        .where(and(eq(deviceEndpoints.stableId, stableId), eq(deviceEndpoints.address, row.address)))
        .run()
    }
  }

  return {
    observe(stableId, serial) {
      if (!TCP_ADDRESS_RE.test(serial)) return // USB serial — nothing for the address book to remember.
      const now = new Date()
      const existing = getRow(stableId, serial)
      if (existing) {
        db.update(deviceEndpoints)
          .set({
            lastConnectedAt: now,
            lastAttemptAt: now,
            consecutiveFailures: 0,
            conflictStableId: null,
            // A human's declaration is never silently downgraded by the same
            // free signal that would have found this address anyway (plan 88
            // §3.1's "neither is ever overwritten by the other silently",
            // applied here to the address's own source rather than medium).
            source: existing.source === 'declared' ? existing.source : 'observed',
            seq: nextSeq(),
          })
          .where(and(eq(deviceEndpoints.stableId, stableId), eq(deviceEndpoints.address, serial)))
          .run()
      } else {
        db.insert(deviceEndpoints)
          .values({
            stableId,
            address: serial,
            medium: null,
            source: 'observed',
            firstSeen: now,
            lastConnectedAt: now,
            lastAttemptAt: now,
            consecutiveFailures: 0,
            conflictStableId: null,
            seq: nextSeq(),
          })
          .run()
      }
      evict(stableId)
    },

    declare(stableId, address, medium) {
      const now = new Date()
      const existing = getRow(stableId, address)
      if (existing) {
        db.update(deviceEndpoints)
          .set({ medium, source: 'declared', seq: nextSeq() })
          .where(and(eq(deviceEndpoints.stableId, stableId), eq(deviceEndpoints.address, address)))
          .run()
      } else {
        db.insert(deviceEndpoints)
          .values({
            stableId,
            address,
            medium,
            source: 'declared',
            firstSeen: now,
            lastConnectedAt: null,
            lastAttemptAt: null,
            consecutiveFailures: 0,
            conflictStableId: null,
            seq: nextSeq(),
          })
          .run()
      }
      evict(stableId)
    },

    candidates(stableId, opts) {
      const cfg = deps.settings()
      const rows = db.select().from(deviceEndpoints).where(eq(deviceEndpoints.stableId, stableId)).all()
      const active = sortForLadder(rows.filter((r) => r.consecutiveFailures < cfg.endpointRetireAfter))
      if (!opts?.includeRetired) return active.map(rowToEndpoint)
      const retired = sortForLadder(rows.filter((r) => r.consecutiveFailures >= cfg.endpointRetireAfter))
      return [...active, ...retired].map(rowToEndpoint)
    },

    noteAttempt(stableId, address, outcome, conflictStableId) {
      const existing = getRow(stableId, address)
      if (!existing) return // nothing to note against — only an address `candidates()` returned is ever attempted.
      const now = new Date()
      if (outcome === 'connected') {
        db.update(deviceEndpoints)
          .set({ lastAttemptAt: now, lastConnectedAt: now, consecutiveFailures: 0, conflictStableId: null, seq: nextSeq() })
          .where(and(eq(deviceEndpoints.stableId, stableId), eq(deviceEndpoints.address, address)))
          .run()
        return
      }
      db.update(deviceEndpoints)
        .set({
          lastAttemptAt: now,
          consecutiveFailures: existing.consecutiveFailures + 1,
          conflictStableId: outcome === 'conflict' ? (conflictStableId ?? null) : existing.conflictStableId,
          seq: nextSeq(),
        })
        .where(and(eq(deviceEndpoints.stableId, stableId), eq(deviceEndpoints.address, address)))
        .run()
    },

    forget(stableId, address) {
      if (address) {
        db.delete(deviceEndpoints)
          .where(and(eq(deviceEndpoints.stableId, stableId), eq(deviceEndpoints.address, address)))
          .run()
      } else {
        db.delete(deviceEndpoints).where(eq(deviceEndpoints.stableId, stableId)).run()
      }
    },

    allWithEndpoints() {
      const rows = db.select().from(deviceEndpoints).all()
      const byStableId = new Map<string, DeviceEndpointRow[]>()
      for (const row of rows) {
        const list = byStableId.get(row.stableId)
        if (list) list.push(row)
        else byStableId.set(row.stableId, [row])
      }
      return Array.from(byStableId.entries()).map(([stableId, deviceRows]) => ({
        stableId,
        candidates: sortForLadder(deviceRows).map(rowToEndpoint),
      }))
    },
  }
}
