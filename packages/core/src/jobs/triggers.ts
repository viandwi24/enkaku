import { and, count, eq } from 'drizzle-orm'
import { checkRuntimeMajor, JobSettingsSchema, resolveRuntime, type JobSettings, type ScriptRef } from '@enkaku/protocol'
import type { Db } from '../db'
import { devices, jobs, type JobRow } from '../db/schema'
import { EnkakuError } from '../util/errors'
import type { Logger } from '../util/logger'
import type { ScriptRegistry } from '../scripts/registry'
import type { RunStore } from './runs/store'

/**
 * `ctx.jobs.trigger()` (plan 81) — a running script enqueues another job on
 * the SAME device (by default) and keeps going. Fire-and-forget: this
 * returns a job id, never a result, never blocks (§3.6) — one device runs
 * one job at a time, so awaiting a triggered job from inside a job on that
 * same device would deadlock by construction.
 *
 * Every triggered row records who triggered it, the root of the chain, and
 * how deep it is (§3.2) — set HERE, from the triggering job's OWN row,
 * never from anything the caller supplies. A child that could name its own
 * depth could name zero, which is exactly the failure mode this exists to
 * close off.
 */

export interface TriggerInput {
  /** `name`, `name@version`, or `name@latest` — resolved and pinned INSIDE the write transaction (§3.4), same as a schedule firing (plan 62's lesson applied to a new caller). */
  script: string
  params?: unknown
  /** Defaults to the triggering job's own device (§3.5). */
  deviceId?: string
  /** Defaults to 0 — a triggered job never jumps the queue (§8 risk table: a separate lower-priority lane was considered and rejected). */
  priority?: number
  /** Always concrete by the time this runs — `jobs-client.ts` derives a default before the IPC call is ever sent (§3.3). */
  key: string
  /** `undefined` inherits the triggering job's own `expiresAt`; explicit `null` means no expiry. */
  expiresAt?: number | null
}

export interface TriggerResult {
  jobId: string
  deduped: boolean
}

export interface TriggerBudgets {
  maxDepth: number
  maxPerChain: number
  maxPerJob: number
}

export interface JobTriggerDeps {
  db: Db
  runs: RunStore
  registry: ScriptRegistry
  log?: Logger
  /** Read fresh per call (the same freshness pattern `adb.maxConcurrent`/`resetPolicy` use) — a Settings change reaches the very next trigger, no restart. */
  budgets: () => TriggerBudgets
  /**
   * Plan 98 §3.7, §4.6, step 98.5 — live `job` farm settings, threaded into
   * `resolveRuntime` exactly like `job-service.ts`'s own `farmJobSettings`
   * (same doc comment's reasoning applies verbatim: `maxConcurrent` has no
   * farm layer, so an omitted getter — a test, or a host built before this
   * step — resolves identically to a live farm at its defaults). A triggered
   * job is a THIRD write path onto `jobs` (alongside `job-service.ts`'s
   * `enqueue`/`resume`) and must pin the same cap a fresh enqueue of the
   * same script would — a `maxConcurrent: 1` script that re-triggers itself
   * must stay bounded, not escape the gate by using this door instead.
   */
  farmJobSettings?: () => JobSettings
}

/** Mirrors `services/job-service.ts`'s own constant — see its doc comment for why a fabricated default is provably equivalent to live settings for `maxConcurrent` alone. */
const DEFAULT_FARM_JOB_SETTINGS: JobSettings = JobSettingsSchema.parse({})

export interface JobTrigger {
  /** `from` is the CALLING job's own row — its `deviceId`, `depth`, `rootJobId`, and `expiresAt` are what this derives everything from. Synchronous: one write transaction, like `JobStore.claimNext`. */
  trigger(from: JobRow, input: TriggerInput): TriggerResult
}

export function createJobTrigger(deps: JobTriggerDeps): JobTrigger {
  const { db, runs, registry, budgets, log } = deps
  const farmJobSettings = () => deps.farmJobSettings?.() ?? DEFAULT_FARM_JOB_SETTINGS

  return {
    trigger(from, input) {
      // The root and depth come from the TRIGGERING JOB'S OWN ROW (§3.2) —
      // a job with no trigger of its own IS its own root, but that is never
      // written back onto it (a pre-existing row has `rootJobId: null,
      // depth: 0`, which is exactly true of it; see schema.ts's comment).
      const rootJobId = from.rootJobId ?? from.id
      const depth = (from.depth ?? 0) + 1

      return db.transaction((tx) => {
        // Idempotency FIRST, before resolution, before the device check,
        // before any budget (§3.3) — a second trigger with the same key
        // returns the SAME job id and writes nothing, even if the script
        // has since been disabled, the target device has since been
        // quarantined, or a budget has since been lowered. A re-run
        // `finish()` must not be punished by state that changed after its
        // first attempt already succeeded.
        const existing = tx
          .select()
          .from(jobs)
          .where(and(eq(jobs.rootJobId, rootJobId), eq(jobs.triggerKey, input.key)))
          .get()
        if (existing) {
          return { jobId: existing.id, deduped: true }
        }

        // Resolved and pinned HERE, inside the same transaction the insert
        // runs in (plan 62's lesson applied to a new caller, §3.4): the
        // concrete `scripts.id` (or dev-slot id) written to the row is
        // fixed the instant this trigger runs, never re-resolved later when
        // the queue actually gets to it. `allowDev: true` — a trigger is one
        // of the two callers permitted to start or continue a chain from a
        // dev slot (the other being an ad-hoc run), because a schedule
        // outlives the session that owns the slot and a running job does not.
        const entry = registry.resolve(input.script as ScriptRef, { allowDev: true })

        // Plan 98 §3.3 S1, §4.5, step 98.6 — the version gate, checked the
        // instant the entry resolves (before the device check, before any
        // budget, before the row is built) — the THIRD write path onto
        // `jobs` gets the identical refusal a fresh `enqueue()`/`resume()`
        // would give the same script, so a self-triggering script cannot
        // route around the gate by using this door instead. `entry.runtime`
        // is the SCRIPT's own declaration (never the caller's — a running
        // script has no "override" layer here, §3.8's per-job layer is an
        // operator's own action at enqueue time, not something `ctx.jobs
        // .trigger()` exposes).
        const versionCheck = checkRuntimeMajor(entry.runtime?.sdk)
        if (versionCheck) {
          log?.warn('trigger refused: unsupported runtime.sdk', { fromJobId: from.id, script: input.script, sdk: entry.runtime?.sdk })
          throw new EnkakuError(versionCheck.code, versionCheck.message)
        }

        const targetDeviceId = input.deviceId ?? from.deviceId
        const device = tx.select().from(devices).where(eq(devices.id, targetDeviceId)).get()
        if (!device) {
          throw new EnkakuError('device_not_found', `no such device: ${targetDeviceId}`)
        }
        if (device.status === 'quarantined') {
          throw new EnkakuError('device_unavailable', `device ${device.label} is quarantined`)
        }

        const limits = budgets()

        if (depth > limits.maxDepth) {
          log?.warn('trigger refused: too deep', { fromJobId: from.id, rootJobId, depth, maxDepth: limits.maxDepth })
          throw new EnkakuError(
            'E_TRIGGER_TOO_DEEP',
            `trigger refused: this chain would reach depth ${depth}, past the farm's jobs.trigger.maxDepth (${limits.maxDepth})`,
          )
        }

        // Counts every job sharing this root — the origin's own row is
        // excluded (its `rootJobId` is null, not `rootJobId` itself), so
        // this is exactly "how many jobs has this chain produced so far".
        // The bound that actually stops a self-triggering script: a chain
        // that keeps re-rooting itself at depth 1 would otherwise never hit
        // `maxDepth` (§3.2).
        const chainSize = tx.select({ n: count() }).from(jobs).where(eq(jobs.rootJobId, rootJobId)).get()?.n ?? 0
        if (chainSize >= limits.maxPerChain) {
          log?.warn('trigger refused: chain full', { fromJobId: from.id, rootJobId, chainSize, maxPerChain: limits.maxPerChain })
          throw new EnkakuError(
            'E_TRIGGER_CHAIN_FULL',
            `trigger refused: chain ${rootJobId} already has ${chainSize} jobs, at the farm's jobs.trigger.maxPerChain (${limits.maxPerChain})`,
          )
        }

        const triggeredByThisJob = tx.select({ n: count() }).from(jobs).where(eq(jobs.triggeredByJobId, from.id)).get()?.n ?? 0
        if (triggeredByThisJob >= limits.maxPerJob) {
          log?.warn('trigger refused: fan-out', { fromJobId: from.id, triggeredByThisJob, maxPerJob: limits.maxPerJob })
          throw new EnkakuError(
            'E_TRIGGER_FAN_OUT',
            `trigger refused: this job has already triggered ${triggeredByThisJob} jobs, at the farm's jobs.trigger.maxPerJob (${limits.maxPerJob})`,
          )
        }

        // §8 risk table — a chain triggered by, say, a 02:00 schedule
        // cannot outlive its root's own expiry window unless the caller
        // deliberately asks for a different one (explicit `null` = no
        // expiry; explicit number = an explicit override). The triggering
        // job's own expiry lives on its latest RUN now (plan 211 §4.1.1).
        const fromRun = runs.latestRun(from.id)
        const expiresAt = input.expiresAt !== undefined ? input.expiresAt : (fromRun?.expiresAt ?? null)

        const maxConcurrent = resolveRuntime({ farm: farmJobSettings(), script: entry.runtime, override: null }).resolved.maxConcurrent

        const job = runs.createJob({
          kind: 'script',
          scriptId: entry.id,
          deviceId: targetDeviceId,
          params: input.params ?? null,
          scriptName: entry.name,
          scriptVersion: entry.version,
          triggeredByJobId: from.id,
          rootJobId,
          depth,
          triggerKey: input.key,
        })
        // Plan 98 §3.8, §4.4, step 98.7 — a triggered job has no per-job
        // override layer: `ctx.jobs.trigger()` is a SCRIPT calling itself,
        // never an operator typing a number at enqueue time, and §3.8's
        // whole design is that layer belonging to a human at the moment
        // they enqueue. Always `null` here.
        runs.addRun(job.id, { trigger: 'manual', priority: input.priority ?? 0, expiresAt, maxConcurrent, runtimeOverride: null })
        return { jobId: job.id, deduped: false }
      })
    },
  }
}
