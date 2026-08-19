import { asc, eq, inArray, sql } from 'drizzle-orm'
import type { Db } from '../db'
import { deviceNumbers, devices, sequences } from '../db/schema'
import type { Actor } from '../device/lifecycle'
import { EnkakuError } from '../util/errors'

/**
 * The device-number allocator (plan 89 §3.1, §3.2, §4.2).
 *
 * A device's short, human-facing number is a reservation keyed on `stableId`
 * (schema.ts's `device_numbers`), allocated once — inside `admitDevice`'s own
 * transaction, the one place a `devices` row is born (plan 89 §0.1 F2) — and
 * never reassigned by Forget, Block, unblock, or re-admission. It is released
 * only by an explicit operator action: `releaseDeviceNumber` below, or
 * `compactDeviceNumbers`.
 */

const SEQUENCE_NAME = 'device_number'

export interface AllocatedNumber {
  number: number
  /** false when this stableId already had a reservation — the sticky path (§3.2). */
  fresh: boolean
}

function readWatermark(tx: Db): number {
  const row = tx.select({ next: sequences.next }).from(sequences).where(eq(sequences.name, SEQUENCE_NAME)).get()
  return row?.next ?? 1
}

function highestAssigned(tx: Db): number {
  const row = tx.select({ n: sql<number>`coalesce(max(${deviceNumbers.number}), 0)` }).from(deviceNumbers).get()
  return row?.n ?? 0
}

function writeWatermark(tx: Db, next: number): void {
  tx.insert(sequences)
    .values({ name: SEQUENCE_NAME, next })
    .onConflictDoUpdate({ target: sequences.name, set: { next } })
    .run()
}

/**
 * Allocates (or re-uses) a device's number, inside the CALLER's transaction.
 *
 * Correctness under concurrent first-connections rests on three things, in
 * descending order of how much weight they carry:
 *
 * 1. `device_numbers.number` is UNIQUE. Whatever else is wrong, two phones
 *    cannot end up displaying the same number — the insert fails instead.
 * 2. `next = max(storedWatermark, max(number) + 1)`. The stored watermark is
 *    the fast path; the `max()` is the defence. It is what makes a restored
 *    backup safe (a watermark that went backwards cannot re-issue a number
 *    that is still reserved), and it is what makes a manual override above
 *    the watermark safe (`setDeviceNumber`) without a second bookkeeping
 *    step.
 * 3. `bun:sqlite` is synchronous on one connection and the data directory is
 *    single-owner-locked (plan 89 §0.1 F28), so nothing can interleave
 *    inside this transaction body. This is the reason the code looks naive;
 *    it is not the reason it is correct, which is (1).
 *
 * Callers MUST already be inside a transaction — `admitDevice` is, so that a
 * failed insert cannot consume a number.
 */
export function allocateDeviceNumber(tx: Db, stableId: string, opts?: { assignedBy?: string | null }): AllocatedNumber {
  const existing = tx.select().from(deviceNumbers).where(eq(deviceNumbers.stableId, stableId)).get()
  if (existing) return { number: existing.number, fresh: false }

  const n = Math.max(readWatermark(tx), highestAssigned(tx) + 1)
  tx.insert(deviceNumbers)
    .values({ stableId, number: n, assignedAt: new Date(), assignedBy: opts?.assignedBy ?? null })
    .run()
  writeWatermark(tx, n + 1)
  return { number: n, fresh: true }
}

/** The reservation for a stableId, or null. Never allocates. */
export function lookupDeviceNumber(db: Db, stableId: string): number | null {
  const row = db.select({ number: deviceNumbers.number }).from(deviceNumbers).where(eq(deviceNumbers.stableId, stableId)).get()
  return row?.number ?? null
}

/**
 * The one place a device's number and its label compose into human-facing
 * text (plan 89 §1, §3.3, §5 step 89.4) — `#7 Pixel 5`, or bare `Pixel 5`
 * when `number` is `null` (a device whose reservation was explicitly
 * released, or — legitimately — never allocated: plan 89's own rule that a
 * missing number is a real state, not an error, applies here too). Every
 * log line, device event, and doctor row that names a device by its label
 * goes through this so none of them can drift from what `#7  Pixel 5` (§3.3)
 * already means everywhere else.
 */
export function formatDeviceLabel(number: number | null, label: string): string {
  return number === null ? label : `#${number} ${label}`
}

/** stableId → number for a whole fleet, in one query (never N+1, plan 19 §4.3's rule). */
export function loadDeviceNumbers(db: Db): Map<string, number> {
  const rows = db.select({ stableId: deviceNumbers.stableId, number: deviceNumbers.number }).from(deviceNumbers).all()
  const map = new Map<string, number>()
  for (const r of rows) map.set(r.stableId, r.number)
  return map
}

/**
 * Sets a number by hand. Throws `E_NUMBER_TAKEN` naming the current holder
 * — a collision is refused, never resolved (§4.3). Advances the watermark
 * past `n` so the next automatic allocation cannot collide with it.
 */
export function setDeviceNumber(db: Db, stableId: string, n: number, actor: Actor): void {
  if (!Number.isInteger(n) || n <= 0) {
    throw new EnkakuError('E_BAD_REQUEST', `device number must be a positive integer, got ${n}`)
  }
  db.transaction((tx) => {
    const holder = tx.select().from(deviceNumbers).where(eq(deviceNumbers.number, n)).get()
    if (holder && holder.stableId !== stableId) {
      throw new EnkakuError('E_NUMBER_TAKEN', `#${n} is already assigned to ${holder.stableId}`)
    }
    const now = new Date()
    tx.insert(deviceNumbers)
      .values({ stableId, number: n, assignedAt: now, assignedBy: actor.userId })
      .onConflictDoUpdate({ target: deviceNumbers.stableId, set: { number: n, assignedAt: now, assignedBy: actor.userId } })
      .run()
    if (n + 1 > readWatermark(tx)) writeWatermark(tx, n + 1)
  })
}

/**
 * Explicit release (§3.2). The number becomes available to the compaction
 * below, not to the next automatic allocation — `allocateDeviceNumber` never
 * reuses a released number on its own, because the whole point of §3.2 is
 * that a number never moves without an operator asking for it.
 */
export function releaseDeviceNumber(db: Db, stableId: string, _actor: Actor): void {
  db.delete(deviceNumbers).where(eq(deviceNumbers.stableId, stableId)).run()
}

/**
 * Reassigns 1..n across every current farm device, ordered by each device's
 * EXISTING number — never by `label` — and returns the devices whose number
 * changed so the caller can re-push their labels in the SAME operation. A
 * compaction that renumbered without re-labelling would leave phones
 * displaying numbers that moved, which is the one outcome §3.2 exists to
 * prevent.
 *
 * Sorting by number (not label) is the whole point of "compaction": §3.2
 * point 5 defines it as closing the gaps left by released numbers while
 * everything else keeps its relative order — `#1, #2, #4, #5` becomes
 * `#1, #2, #3, #4`, never a full reshuffle. `number` and `label` are
 * deliberately separate identities (§3.3): a device's number is incremental
 * from first connection and never reused, while its label is operator-chosen
 * free text that says nothing about arrival order. Sorting the renumber by
 * label — the previous, buggy behaviour — let two devices that happened to
 * alphabetize differently swap positions arbitrarily, so device #1 could end
 * up as #9 even though it never lost its reservation; that defeats the
 * "your sticker still matches" guarantee this whole feature exists for.
 *
 * `from: 0` means the device had no reservation before this call (an
 * explicitly released number, or a device admitted between §4.1's backfill
 * and this call never existing in the first place) — 0 is never a valid
 * device number, so it is unambiguous as "there was none." Such devices sort
 * AFTER every already-numbered device (by `id ASC` among themselves), so an
 * unnumbered device can never displace an existing device's relative order.
 *
 * **Orphaned reservations are released first, unconditionally.** `forget()`
 * (`packages/core/src/device/lifecycle.ts`) deliberately leaves a device's
 * `device_numbers` row in place — §3.2's sticky-reservation guarantee is
 * that a device which reconnects gets its old number back. But that row has
 * no matching `devices` row while the device is gone, and this function used
 * to compute its dense `1..n` target sequence purely from the LIVE `devices`
 * table, with no idea an orphaned reservation might already be squatting on
 * a number inside that range. The first live device (or newly-numbered
 * device) whose target collided with a still-present orphan blew up with a
 * raw, uncaught `UNIQUE constraint failed: device_numbers.number` — exactly
 * what happened against the owner's live farm database, where a forgotten
 * device still held #3 while nine live devices held 1,2,4..10 (plan 96
 * §96.42).
 *
 * Deleting every orphan here — rather than only the ones whose number
 * happens to fall inside this run's target range — is deliberate, not
 * laziness: compaction is itself an explicit, operator-initiated "finalize
 * the current numbering" action (§3.2 point 5's whole reason for existing
 * as a separate verb from automatic allocation), so it is the natural place
 * to also finalize the fact that a still-orphaned reservation is not coming
 * back to reclaim its slot. Anything narrower — "only release an orphan if
 * its number is actually needed this time" — would leave some orphans alive
 * after a compaction that promised (`packages/studio/src/app/page.tsx`'s
 * "Renumber fleet?" dialog copy) to close gaps left by "released or
 * forgotten" devices, and would reintroduce exactly this bug on the NEXT
 * compaction that happens to need that particular slot. The cost accepted:
 * a forgotten device's number is no longer guaranteed to survive forever —
 * only until the next operator-run compaction, at which point it is
 * genuinely gone and a reconnect allocates a brand-new one. That is a
 * narrower, deliberate loosening of §3.2, not an accident, and every
 * release is reported back to the caller (`released`) so it is never a
 * silent behaviour change (CLAUDE.md's rule on this).
 */
export function compactDeviceNumbers(db: Db): {
  changed: { stableId: string; from: number; to: number }[]
  released: { stableId: string; number: number }[]
} {
  return db.transaction((tx) => {
    const current = new Map<string, number>()
    for (const r of tx.select({ stableId: deviceNumbers.stableId, number: deviceNumbers.number }).from(deviceNumbers).all()) {
      current.set(r.stableId, r.number)
    }

    // `id ASC` here is only the tie-break base order for devices sharing the
    // same sort bucket (unnumbered devices, or — impossible in practice,
    // since `number` is UNIQUE — a number collision). The real ordering key,
    // applied below, is each device's existing number.
    const rows = tx.select({ stableId: devices.stableId }).from(devices).orderBy(asc(devices.id)).all()
    const liveIds = new Set(rows.map((r) => r.stableId))
    const released = [...current.entries()]
      .filter(([stableId]) => !liveIds.has(stableId))
      .map(([stableId, number]) => ({ stableId, number }))
      .sort((a, b) => a.number - b.number)
    if (released.length > 0) {
      tx.delete(deviceNumbers)
        .where(inArray(deviceNumbers.stableId, released.map((r) => r.stableId)))
        .run()
      for (const r of released) current.delete(r.stableId)
    }

    const sorted = [...rows].sort((a, b) => {
      const an = current.get(a.stableId) ?? 0
      const bn = current.get(b.stableId) ?? 0
      if (an === 0 || bn === 0) return an === bn ? 0 : an === 0 ? 1 : -1
      return an - bn
    })

    const targets = sorted.map((row, i) => ({ stableId: row.stableId, from: current.get(row.stableId) ?? 0, to: i + 1 }))
    const changes = targets.filter((t) => t.from !== t.to)

    // Two passes, deliberately: writing final numbers directly, in order,
    // would collide with `number`'s UNIQUE index the moment row A's target
    // is a number row B (not yet updated) still holds — which happens on
    // essentially every real compaction, since the whole point is closing
    // gaps below numbers that are still live. Pass 1 moves every changing,
    // already-reserved stableId to a negative placeholder unique per row
    // (negatives never collide with the positive numbers pass 2 writes, or
    // with each other); pass 2 then writes the real 1..n numbers with
    // nothing left in the way.
    changes.forEach((c, i) => {
      if (c.from !== 0) {
        tx.update(deviceNumbers)
          .set({ number: -(i + 1) })
          .where(eq(deviceNumbers.stableId, c.stableId))
          .run()
      }
    })

    const now = new Date()
    for (const c of changes) {
      if (c.from === 0) {
        tx.insert(deviceNumbers).values({ stableId: c.stableId, number: c.to, assignedAt: now, assignedBy: null }).run()
      } else {
        tx.update(deviceNumbers)
          .set({ number: c.to, assignedAt: now, assignedBy: null })
          .where(eq(deviceNumbers.stableId, c.stableId))
          .run()
      }
    }

    writeWatermark(tx, targets.length + 1)
    return { changed: changes, released }
  })
}
