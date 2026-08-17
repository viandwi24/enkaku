import { eq } from 'drizzle-orm'
import {
  DevicePreparationSchema,
  PreparationComponentStatusSchema,
  DEFAULT_DEVICE_PREPARATION,
  DEFAULT_PREPARATION_COMPONENT_STATUS,
  type DevicePreparation,
  type PreparationComponentStatus,
} from '@enkaku/protocol'
import type { Db } from '../../db'
import { devices, type DeviceRow } from '../../db/schema'
import type { EventRecorder } from '../../events/recorder'
import type { Logger } from '../../util/logger'
import { EnkakuError } from '../../util/errors'
import { hasExhaustedRetryBudget, isWithinBackoffWindow, nextBoundedRetry } from '../bounded-retry'
import type { PreparationComponent } from './types'

/**
 * The device-preparation runner (plan 106 §3.3, §3.5) — the generalisation
 * of `agent-provisioner.ts`'s own `ensureImpl`, one pass per REGISTERED
 * COMPONENT rather than one pass for the single guest agent. Same rules,
 * carried over deliberately rather than reinvented (§96.25's own three
 * fixes, plan 106's explicit requirement):
 *
 * 1. A core-side `E_ADB_UNAVAILABLE` defers a component's pass — no write,
 *    no attempt consumed, no transition event — never counted against that
 *    component's bound (§3.3).
 * 2. The bound (`retryBackoffS`) is real and per-component: twenty phones
 *    with a bad artifact must not produce an install storm. An explicit
 *    `force: true` (an operator's retry) always clears it.
 * 3. Nothing here decides WHEN it runs — `daemon.ts` gates the first call
 *    on the same adb-readiness signal §96.25 fixed for the guest agent, and
 *    calls this on admission/reconnect/on-demand, never on a timer (§3.5).
 */

/** Same shape network-route recovery and the guest agent's own provisioner already use (`agent-provisioner.ts`'s `DEFAULT_RETRY_BACKOFF_S`). */
const DEFAULT_RETRY_BACKOFF_S = [5, 20, 60]

export interface PreparationRunnerDeps {
  db: Db
  /** The component roster (`registry.ts`) — open-ended by design (plan 106 §3.2). */
  registry: PreparationComponent[]
  /** Main-stream device events: `device.preparation`. */
  record?: EventRecorder['record']
  log: Logger
  /** Test seam — defaults to `DEFAULT_RETRY_BACKOFF_S`. */
  retryBackoffS?: number[]
  /** Test seam — replaces `Date.now()`. */
  now?: () => number
}

export interface PreparationRunner {
  /** One pass across every registered component for this device, in registry order. Idempotent; safe to call on every hook. */
  ensure(deviceId: string, opts?: { force?: boolean }): Promise<DevicePreparation>
  /** One pass for exactly one component — the operator-facing "Retry" (plan 106 §3.3): passing `{ force: true }` clears that component's exhausted bound. */
  ensureComponent(deviceId: string, componentId: string, opts?: { force?: boolean }): Promise<PreparationComponentStatus>
  /** The persisted row, Zod-validated — never issues an adb call of its own. */
  status(deviceId: string): Promise<DevicePreparation>
  /** Every device currently online, bounded by the shared install lane (same reasoning as `agent-provisioner.ts`'s own `ensureAll` — no second concurrency mechanism). */
  ensureAll(opts?: { force?: boolean }): Promise<{ total: number; results: Array<{ deviceId: string; preparation: DevicePreparation }> }>
  /**
   * Plan 106 §5 step 106.7 — which of this device's components have a
   * `component.run()` call genuinely executing RIGHT NOW, and since when
   * (unix seconds). In-memory only, never persisted to `devices.preparation`
   * and never fed through `maybeRecordTransition` — deliberately: writing an
   * intermediate `'provisioning'` row to the DB would mean reverting it on
   * an `E_ADB_UNAVAILABLE` defer (or leaving a stale row behind on a core
   * crash mid-install), and would double the event count every existing
   * transition test in this file asserts. This is the read-only fact
   * `api/device-preparation.ts`'s `GET /:id/preparation` overlays onto the
   * persisted record instead — the truth about "is a pass in flight" lives
   * here, for exactly as long as it is true, and nowhere else.
   */
  runningSince(deviceId: string): Record<string, number>
}

function nowSeconds(now: () => number): number {
  return Math.floor(now() / 1000)
}

/** Reads `devices.preparation`, Zod-validated (CLAUDE.md: never trust a JSON DB column). A row that fails validation reads as empty rather than throwing — an old/corrupt value must not 500 every caller. */
function readPreparation(row: DeviceRow, log: Logger): DevicePreparation {
  if (row.preparation === null || row.preparation === undefined) return DEFAULT_DEVICE_PREPARATION
  const parsed = DevicePreparationSchema.safeParse(row.preparation)
  if (!parsed.success) {
    log.warn(`device ${row.id}: stored preparation record failed validation, treating as empty: ${parsed.error.message}`)
    return DEFAULT_DEVICE_PREPARATION
  }
  return parsed.data
}

export function createPreparationRunner(deps: PreparationRunnerDeps): PreparationRunner {
  const { db } = deps
  const now = deps.now ?? (() => Date.now())
  const retryBackoffS = deps.retryBackoffS ?? DEFAULT_RETRY_BACKOFF_S
  const registryById = new Map(deps.registry.map((c) => [c.id, c]))
  /** Plan 106 §5 step 106.7 — see `runningSince`'s own doc comment on the `PreparationRunner` interface above. Keyed `${deviceId}:${componentId}`. */
  const runningSinceMap = new Map<string, number>()

  const mustGet = (id: string): DeviceRow => {
    const row = db.select().from(devices).where(eq(devices.id, id)).get()
    if (!row) throw new EnkakuError('device_not_found', `no such device: ${id}`)
    return row
  }

  /** Re-reads the row fresh so a sequential run of several components never clobbers an earlier one's write in the same pass. */
  function writeComponent(deviceId: string, componentId: string, status: PreparationComponentStatus): void {
    const row = mustGet(deviceId)
    const current = readPreparation(row, deps.log)
    const next: DevicePreparation = { ...current, [componentId]: status }
    db.update(devices).set({ preparation: next }).where(eq(devices.id, deviceId)).run()
  }

  /** One event per state transition (mirrors `agent-provisioner.ts`'s `maybeRecordTransition`) — a clean pass that changes nothing emits none. */
  function maybeRecordTransition(row: DeviceRow, componentId: string, prior: PreparationComponentStatus, next: PreparationComponentStatus): void {
    if (prior.state === next.state && prior.reason === next.reason) return
    deps.record?.({
      deviceId: row.id,
      stream: 'main',
      kind: 'device.preparation',
      meta: { componentId, state: next.state, reason: next.reason, from: prior.state },
    })
  }

  async function ensureComponentImpl(deviceId: string, componentId: string, opts?: { force?: boolean }): Promise<PreparationComponentStatus> {
    const component = registryById.get(componentId)
    if (!component) throw new EnkakuError('preparation_component_not_found', `no such preparation component: ${componentId}`)

    const row = mustGet(deviceId)
    const preparation = readPreparation(row, deps.log)
    const prior = PreparationComponentStatusSchema.parse(preparation[componentId] ?? DEFAULT_PREPARATION_COMPONENT_STATUS)
    const checkedAt = nowSeconds(now)

    // Terminal by design, not a failure to retry — exactly like
    // `agent-provisioner.ts`'s SDK-floor check (plan 106 §3.2).
    if (!component.applicable(row)) {
      const next: PreparationComponentStatus = {
        state: 'unsupported',
        version: null,
        reason: component.unsupportedReason(row),
        checkedAt,
        attempts: 0,
        nextAttemptAt: null,
      }
      writeComponent(row.id, componentId, next)
      maybeRecordTransition(row, componentId, prior, next)
      return next
    }

    // Bounded retry (plan 106 §3.3) — a forced call (an explicit retry)
    // always bypasses this; that IS the retry the bound exists to wait for.
    if (!opts?.force && prior.state === 'failed') {
      if (hasExhaustedRetryBudget(prior, retryBackoffS)) {
        deps.log.debug(`preparation(${componentId}): device ${row.id} has exhausted its ${retryBackoffS.length} automatic attempts — waiting for an explicit retry`)
        return prior
      }
      if (isWithinBackoffWindow(prior, checkedAt)) {
        return prior
      }
    }

    let result: { state: 'ready' | 'outdated' | 'failed'; version: string | null; reason: string | null }
    // Plan 106 §5 step 106.7: mark this component's `run()` genuinely
    // in-flight for exactly its real duration — in-memory only, cleared in
    // the `finally` below regardless of which path out of `run()` is taken
    // (success, a translated `failed`, or the `E_ADB_UNAVAILABLE` defer
    // return inside the `catch`). See `runningSince`'s own doc comment.
    const inFlightKey = `${deviceId}:${componentId}`
    runningSinceMap.set(inFlightKey, checkedAt)
    try {
      try {
        result = await component.run(row)
      } catch (err) {
        // Plan 106 §3.3 / hotfix §96.25 fix 2, generalised: a core-side
        // `E_ADB_UNAVAILABLE` means this pass never reached the device at
        // all — defer exactly like the branches above: no write, no attempt
        // consumed, no transition event, `prior` unchanged.
        if (err instanceof EnkakuError && err.code === 'E_ADB_UNAVAILABLE') {
          deps.log.debug(`preparation(${componentId}): deferring device ${row.id} — adb subsystem was not ready for this pass (not counted against its retry budget)`)
          return prior
        }
        // A well-behaved component should already have returned `{ state:
        // 'failed', reason }` rather than throw — this is a defensive
        // fallback so one component's surprise cannot crash the whole pass,
        // scored as a device-side failure since it is, by elimination, not
        // the one core-side error class this runner treats specially.
        result = { state: 'failed', version: prior.version, reason: err instanceof Error ? err.message : String(err) }
      }
    } finally {
      runningSinceMap.delete(inFlightKey)
    }

    const { attempts, nextAttemptAt } = nextBoundedRetry({
      result: result.state,
      priorAttempts: prior.attempts,
      checkedAt,
      retryBackoffS,
      forced: !!opts?.force,
    })

    const next: PreparationComponentStatus = { state: result.state, version: result.version, reason: result.reason, checkedAt, attempts, nextAttemptAt }
    writeComponent(row.id, componentId, next)
    maybeRecordTransition(row, componentId, prior, next)
    return next
  }

  async function ensureImpl(deviceId: string, opts?: { force?: boolean }): Promise<DevicePreparation> {
    // Sequential, not `Promise.all` — `writeComponent` re-reads the row
    // fresh each call, so components must not race each other's writes for
    // the SAME device. The shared install lane (`hostAdb`'s
    // `adb.maxInstallConcurrent`) is what bounds cross-device concurrency;
    // `ensureAll` below still runs different DEVICES in parallel.
    for (const component of deps.registry) {
      await ensureComponentImpl(deviceId, component.id, opts)
    }
    const row = mustGet(deviceId)
    return readPreparation(row, deps.log)
  }

  const inFlight = new Map<string, Promise<unknown>>()

  async function dedup<T>(key: string, run: () => Promise<T>): Promise<T> {
    const existing = inFlight.get(key)
    if (existing) return existing as Promise<T>
    const p = run().finally(() => {
      inFlight.delete(key)
    })
    inFlight.set(key, p)
    return p
  }

  return {
    ensure(deviceId, opts) {
      const key = opts?.force ? `${deviceId}:all:force` : `${deviceId}:all`
      return dedup(key, () => ensureImpl(deviceId, opts))
    },

    ensureComponent(deviceId, componentId, opts) {
      const key = opts?.force ? `${deviceId}:${componentId}:force` : `${deviceId}:${componentId}`
      return dedup(key, () => ensureComponentImpl(deviceId, componentId, opts))
    },

    async status(deviceId) {
      const row = mustGet(deviceId)
      return readPreparation(row, deps.log)
    },

    runningSince(deviceId) {
      const prefix = `${deviceId}:`
      const out: Record<string, number> = {}
      for (const [key, startedAt] of runningSinceMap.entries()) {
        if (key.startsWith(prefix)) out[key.slice(prefix.length)] = startedAt
      }
      return out
    },

    async ensureAll(opts) {
      const rows = db.select().from(devices).all()
      const results: Array<{ deviceId: string; preparation: DevicePreparation }> = []
      await Promise.all(
        rows.map(async (row) => {
          if (row.status === 'offline') return // unreachable by construction — nothing to verify
          try {
            const preparation = await this.ensure(row.id, opts)
            results.push({ deviceId: row.id, preparation })
          } catch (err) {
            // `ensure()` only throws for a missing row, which cannot happen
            // here — caught anyway so one device's surprise can never abort
            // the whole fleet pass (mirrors `agent-provisioner.ts`'s own
            // `ensureAll`).
            deps.log.warn(`preparation-runner: ensureAll skipped device ${row.id} after an unexpected error: ${String(err)}`)
          }
        }),
      )
      return { total: results.length, results }
    },
  }
}
