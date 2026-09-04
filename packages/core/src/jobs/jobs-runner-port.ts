import type { JobsCall } from '@enkaku/session'
import type { JobSettings } from '@enkaku/protocol'
import type { Db } from '../db'
import type { Logger } from '../util/logger'
import { EnkakuError } from '../util/errors'
import type { JobStore } from '../queue/job-store'
import type { RunStore } from './runs/store'
import type { ScriptRegistry } from '../scripts/registry'
import type { JobRow } from '../db/schema'
import { createScriptJobsReader } from './script-jobs'
import { createJobTrigger, type TriggerBudgets, type TriggerResult } from './triggers'

/**
 * The parent-side implementation of `ctx.jobs`'s IPC port (plan 80 §4.2,
 * extended by plan 81 §4.2 with `trigger`) —
 * `packages/session/src/runner/job-runner.ts`'s `JobRunnerDeps.jobs` is a
 * plain, session-local interface (that package cannot depend on
 * `@enkaku/core`, where the queue itself lives); this is the concrete object
 * `daemon.ts` hands it, exactly like `kv/runner-port.ts` does for `ctx.kv`.
 *
 * The IPC boundary only carries `{ jobId, deviceId }` — the caller's own job
 * id and device. This is where that gets resolved into the caller's full
 * `JobRow`, which `createScriptJobsReader`'s methods (and `JobTrigger`)
 * actually scope against; the wire protocol never carries a `JobRow` itself.
 */
export interface JobsRunnerPortDeps {
  db: Db
  jobStore: JobStore
  runs: RunStore
  /** `ctx.jobs.trigger()`'s reference resolution and pinning (plan 81 §3.4) — the same registry every other caller resolves through. */
  registry: ScriptRegistry
  /** Read fresh per call, not captured at daemon start — a Settings change reaches the very next trigger. */
  triggerBudgets: () => TriggerBudgets
  /**
   * Plan 98 §3.7, §4.6, step 98.5 — forwarded straight into `createJobTrigger`'s
   * own `farmJobSettings` (see that interface's doc comment for why an
   * omitted getter still resolves `maxConcurrent` correctly). Optional for
   * the same reason `onTriggered` is: a host built before this step keeps
   * compiling and behaving unchanged.
   */
  farmJobSettings?: () => JobSettings
  /** One `job.triggered` device event per successful (non-deduped) trigger (plan 81 §4.5) — the host turns this into a main-stream event on the TARGET device. */
  onTriggered?: (from: JobRow, targetDeviceId: string, result: TriggerResult) => void
  log?: Logger
}

export interface JobsRunnerPort {
  call(ctx: { jobId: string; deviceId: string }, call: JobsCall): Promise<unknown>
}

export function createJobsRunnerPort(deps: JobsRunnerPortDeps): JobsRunnerPort {
  const reader = createScriptJobsReader({ jobStore: deps.jobStore, db: deps.db, runs: deps.runs })
  const trigger = createJobTrigger({
    db: deps.db,
    runs: deps.runs,
    registry: deps.registry,
    budgets: deps.triggerBudgets,
    ...(deps.farmJobSettings ? { farmJobSettings: deps.farmJobSettings } : {}),
    ...(deps.log ? { log: deps.log } : {}),
  })

  return {
    async call(ctx, call) {
      const job = deps.jobStore.get(ctx.jobId)
      if (!job) throw new EnkakuError('E_JOB_NOT_FOUND', `no such job: ${ctx.jobId}`)

      switch (call.method) {
        case 'list':
          return reader.list(job, {
            ...(call.status ? { status: call.status } : {}),
            limit: call.limit ?? 50,
            cursor: call.cursor ?? null,
          })
        case 'previous':
          return reader.previous(job)
        case 'queuedAfter':
          return reader.queuedAfter(job, call.limit ?? 50)
        case 'resultOf': {
          const outcome = reader.resultOf(job, call.jobId)
          if (!outcome.ok) {
            // Criterion 9 — the refusal reason is logged HERE, parent-side,
            // and never crosses the IPC boundary: `jobs-client.ts` collapses
            // every refusal to `null`, so a script cannot act differently on
            // "foreign namespace" than on "not found" (§4.3).
            deps.log?.warn('jobs.resultOf refused', { callerJobId: job.id, targetJobId: call.jobId, reason: outcome.reason })
            return null
          }
          return outcome.result
        }
        case 'trigger': {
          const result = trigger.trigger(job, {
            script: call.script,
            key: call.key,
            ...(call.params !== undefined ? { params: call.params } : {}),
            ...(call.deviceId !== undefined ? { deviceId: call.deviceId } : {}),
            ...(call.priority !== undefined ? { priority: call.priority } : {}),
            ...(call.expiresAt !== undefined ? { expiresAt: call.expiresAt } : {}),
          })
          if (!result.deduped) deps.onTriggered?.(job, call.deviceId ?? job.deviceId, result)
          return result
        }
        default: {
          const _exhaustive: never = call
          throw new EnkakuError('E_BAD_REQUEST', `unknown jobs method: ${JSON.stringify(_exhaustive)}`)
        }
      }
    },
  }
}
