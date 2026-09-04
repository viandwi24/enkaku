import type { ActionResult, ActionVerb, Operation, Target } from '@enkaku/protocol'

export const OPERATION_TTL_MS = 3_600_000
export const OPERATION_MAX = 1_000

export interface OperationRegistry {
  create(input: { verb: ActionVerb; target: Target; createdBy: string | null; results: ActionResult[] }): Operation
  /** Replaces one device's result; a result that is not `accepted` is never replaced (a settle races nothing). Returns false when unknown. */
  settle(operationId: string, deviceId: string, patch: Omit<ActionResult, 'deviceId'>): boolean
  get(id: string): Operation | null
  /** Evicts settled operations older than the TTL and, past OPERATION_MAX, the oldest first. Called by a 60 s interval `daemon.ts` starts beside the activity sweep. */
  sweep(): number
  startSweep(): void
  stopSweep(): void
}

/** True once no result is `accepted`. */
function isSettled(results: ActionResult[]): boolean {
  return results.every((r) => r.status !== 'accepted')
}

interface Entry {
  operation: Operation
  /** Unix ms; set the moment `isSettled` first became true. Null while still live. */
  settledAt: number | null
  /** Insertion order, for the OPERATION_MAX eviction (oldest first). */
  seq: number
}

export function createOperationRegistry(deps: { now?: () => number }): OperationRegistry {
  const now = deps.now ?? (() => Date.now())
  const byId = new Map<string, Entry>()
  let seq = 0
  let sweepHandle: ReturnType<typeof setInterval> | null = null

  function create(input: { verb: ActionVerb; target: Target; createdBy: string | null; results: ActionResult[] }): Operation {
    const id = crypto.randomUUID()
    const operation: Operation = {
      operationId: id,
      verb: input.verb,
      target: input.target,
      createdBy: input.createdBy,
      createdAt: Math.floor(now() / 1000),
      results: input.results,
      settled: isSettled(input.results),
    }
    byId.set(id, { operation, settledAt: operation.settled ? now() : null, seq: seq++ })
    return operation
  }

  function settle(operationId: string, deviceId: string, patch: Omit<ActionResult, 'deviceId'>): boolean {
    const entry = byId.get(operationId)
    if (!entry) return false
    const idx = entry.operation.results.findIndex((r) => r.deviceId === deviceId)
    if (idx === -1) return false
    const current = entry.operation.results[idx]!
    if (current.status !== 'accepted') return false
    const results = entry.operation.results.slice()
    results[idx] = { ...current, ...patch, deviceId }
    const settled = isSettled(results)
    entry.operation = { ...entry.operation, results, settled }
    if (settled && entry.settledAt === null) entry.settledAt = now()
    if (!settled) entry.settledAt = null
    return true
  }

  function get(id: string): Operation | null {
    return byId.get(id)?.operation ?? null
  }

  function sweep(): number {
    let evicted = 0
    const nowMs = now()
    for (const [id, entry] of byId) {
      if (entry.settledAt !== null && nowMs - entry.settledAt >= OPERATION_TTL_MS) {
        byId.delete(id)
        evicted++
      }
    }
    if (byId.size > OPERATION_MAX) {
      const over = byId.size - OPERATION_MAX
      const ordered = [...byId.entries()].sort((a, b) => a[1].seq - b[1].seq)
      for (let i = 0; i < over; i++) {
        const [id] = ordered[i]!
        byId.delete(id)
        evicted++
      }
    }
    return evicted
  }

  function startSweep(): void {
    if (sweepHandle) return
    sweepHandle = setInterval(sweep, 60_000)
    sweepHandle.unref?.()
  }

  function stopSweep(): void {
    if (sweepHandle) clearInterval(sweepHandle)
    sweepHandle = null
  }

  return { create, settle, get, sweep, startSweep, stopSweep }
}
