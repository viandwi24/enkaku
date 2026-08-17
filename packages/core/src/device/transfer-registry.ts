import type { TransferKind, TransferOrigin, TransferRecord } from '@enkaku/protocol'

/**
 * The in-memory index behind `GET /api/transfers` (plan 107 §3.1, §3.4, §4,
 * step 107.2) — see `@enkaku/protocol`'s `TransfersResponseSchema` (in
 * `packages/protocol/src/api/transfers.ts`) for the full reasoning on why an
 * in-memory registry rather than a table, and what it loses on a core
 * restart. Short version, restated here because it governs this file's own
 * design: a restart forgets every entry, including one whose `adb push`/
 * `pm install` is still running on the phone — the transfer is server-side
 * work outliving the request that started it, so it can survive the process
 * that was tracking it.
 *
 * **Deliberately not threaded through `runTransfer`'s nine call sites**
 * (`api/transfer.ts` ×3, `jobs/executors/{install,push,pull}.ts` ×3, the
 * script IPC bridge in `daemon.ts` ×3). `TransferBroadcast` (`transfer-
 * dispatch.ts`) is already the ONE shared object every one of those nine
 * call sites is handed — `daemon.ts` constructs exactly one `transferBroadcast`
 * and passes the same instance everywhere — so wrapping `progress`/`done`
 * there (`daemon.ts`'s own wiring, not this file) reaches all nine for free,
 * with nothing new to remember to pass at a tenth call site if one is ever
 * added. This is the "one seam" this repo's own defect log (21+ instances of
 * "correct code, unreachable production call site") keeps pointing at
 * avoiding.
 *
 * `progress`/`done` therefore carry the SAME `(deviceId, transferId, kind,
 * ...)` shape `TransferBroadcast`'s methods already do, and each one
 * lazily creates its entry if this is the first event this registry has
 * seen for that `transferId` — there is no separate `start()`. That
 * matters for `done()` specifically: an install that fails before a single
 * progress tick (bad artifact id, device offline) calls `done()` with no
 * preceding `progress()` call at all, and it must still appear, briefly, as
 * a failed transfer rather than never having existed.
 */

interface Entry {
  transferId: string
  deviceId: string
  kind: TransferKind
  state: 'running' | 'done'
  startedAtMs: number
  updatedAtMs: number
  sent: number
  total: number | null
  ok: boolean | null
  error: string | null
  /** Plan 106 §5 step 106.8 — fixed at whichever of `progress()`/`done()` creates this entry, never overwritten afterward (mirrors `kind`/`deviceId`: a transferId names exactly one origin for its whole life). */
  origin: TransferOrigin
}

/** How long a finished transfer stays listable after `done()` — long enough for a client to poll and see the terminal state, short enough that this never grows into an unbounded history (a durable row, plan 107 §3.4's other option, is where "history" belongs). */
const RETENTION_MS = 30_000

export interface TransferRegistry {
  progress(deviceId: string, transferId: string, kind: TransferKind, sent: number, total: number | null, origin?: TransferOrigin): void
  done(deviceId: string, transferId: string, kind: TransferKind, ok: boolean, error?: string, origin?: TransferOrigin): void
  list(): TransferRecord[]
}

function toRecord(e: Entry): TransferRecord {
  return {
    transferId: e.transferId,
    deviceId: e.deviceId,
    kind: e.kind,
    state: e.state,
    startedAt: Math.floor(e.startedAtMs / 1000),
    updatedAt: Math.floor(e.updatedAtMs / 1000),
    origin: e.origin,
    sent: e.sent,
    total: e.total,
    ok: e.ok,
    error: e.error,
  }
}

/** `now` is injectable for tests; defaults to the real clock. */
export function createTransferRegistry(now: () => number = Date.now): TransferRegistry {
  const entries = new Map<string, Entry>()

  function sweep(): void {
    const cutoff = now() - RETENTION_MS
    for (const [id, e] of entries) {
      if (e.state === 'done' && e.updatedAtMs <= cutoff) entries.delete(id)
    }
  }

  return {
    progress(deviceId, transferId, kind, sent, total, origin) {
      sweep()
      const existing = entries.get(transferId)
      const t = now()
      if (!existing) {
        entries.set(transferId, { transferId, deviceId, kind, state: 'running', startedAtMs: t, updatedAtMs: t, sent, total, ok: null, error: null, origin: origin ?? 'operator' })
        return
      }
      // A `done()` is terminal for a given transferId (`runTransfer` calls it
      // exactly once, after `op()` settles) — a stray late progress tick must
      // never resurrect a finished entry as 'running' again.
      if (existing.state === 'done') return
      existing.sent = sent
      existing.total = total
      existing.updatedAtMs = t
    },
    done(deviceId, transferId, kind, ok, error, origin) {
      sweep()
      const existing = entries.get(transferId)
      const t = now()
      if (!existing) {
        entries.set(transferId, {
          transferId,
          deviceId,
          kind,
          state: 'done',
          startedAtMs: t,
          updatedAtMs: t,
          sent: 0,
          total: null,
          ok,
          error: error ?? null,
          origin: origin ?? 'operator',
        })
        return
      }
      existing.state = 'done'
      existing.ok = ok
      existing.error = error ?? null
      existing.updatedAtMs = t
    },
    list() {
      sweep()
      return [...entries.values()].sort((a, b) => b.startedAtMs - a.startedAtMs).map(toRecord)
    },
  }
}
