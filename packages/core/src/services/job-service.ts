import type { JobDetail, JobInfo, JobNodeInfo, JobSettings, JobStatus, RuntimeClamp, RuntimeEnvelope, ShellMode } from '@enkaku/protocol'
import { checkRuntimeMajor, JobSettingsSchema, resolveRuntime, RuntimeEnvelopeSchema, unknownRuntimeKeys } from '@enkaku/protocol'
import { canUseDevice } from '../auth/acl'
import type { Role } from '../auth/service'
import type { ExecutorRegistry } from '../jobs/executor'
import type { ExecutorHost } from '../jobs/executor-host'
import { parseJobRuntimeOverride, rowToJobDetail, rowToJobInfo, rowToJobNodeInfo, type JobCursor, type JobStore } from '../queue/job-store'
import type { Scheduler } from '../queue/scheduler'
import { EnkakuError } from '../util/errors'
import type { Logger } from '../util/logger'
import { validateScriptForRun } from '../jobs/validate-script'

/** A job's terminal statuses (plan 99 §3.5) — the gate `resume()` checks before letting a new job continue from one. */
const TERMINAL_JOB_STATUSES: ReadonlySet<JobStatus> = new Set(['success', 'failed', 'cancelled', 'expired'])

/**
 * Plan 98 §3.7, §4.1, §4.6, step 98.5 — `resolveRuntime`'s `farm` argument,
 * standing in for live `settingsStore.get().job` when this service's own
 * `deps.farmJobSettings` is not wired (a test harness, or any host built
 * before this step). This is safe rather than merely convenient:
 * `resolveRuntime`'s OWN doc comment states `retries`, `maxConcurrent` and
 * `sdk` "have no farm default or ceiling layer at all" — `maxConcurrent`
 * resolves purely from `override ?? script ?? 0`, so which `JobSettings`
 * object is passed in cannot change the one field this step reads out of the
 * result. Threading a live getter through anyway (`farmJobSettings` below)
 * costs nothing and keeps this call site shaped exactly like the one step
 * 98.7 will extend with a real per-job override.
 */
const DEFAULT_FARM_JOB_SETTINGS: JobSettings = JobSettingsSchema.parse({})

/**
 * Plan 98 §3.7, §3.8, §4.1, §4.6, §4.7, steps 98.5/98.7 — the ONE place BOTH
 * `jobs.max_concurrent` AND the operator's own per-job override are resolved
 * against precedence and the farm's ceiling, shared by `enqueue()` and
 * `resume()` below so a resumed job is bound by the EXACT rules a fresh
 * enqueue would apply (resume never re-resolves `scriptId` itself — plan 99
 * §3.5 — but it must still re-resolve the CAP and re-check the override,
 * since farm settings can have changed since the original job was enqueued,
 * and `resolveRuntime` is cheap and pure). One `resolveRuntime` call answers
 * both — never a second call site to drift from this one (§3.8 rule 1).
 *
 * `overrideClamps` is every clamp `resolveRuntime` attributed to the
 * OVERRIDE layer specifically (`RuntimeClamp.from === 'override'`) — a
 * `'script'` clamp is §3.8's OTHER, asymmetric branch (silently clamped and
 * logged at RUN time, `job-runner.ts`, never refused here). The caller
 * refuses on a non-empty `overrideClamps` with `E_RUNTIME_OVER_CEILING`: an
 * operator typed this number; silently narrowing it is the worse failure.
 */
function resolveJobRuntime(
  deps: { farmJobSettings?: () => JobSettings },
  scriptRuntime: RuntimeEnvelope | null,
  override: RuntimeEnvelope | null,
): { maxConcurrent: number; overrideClamps: RuntimeClamp[] } {
  const farm = deps.farmJobSettings?.() ?? DEFAULT_FARM_JOB_SETTINGS
  const { resolved, clamps } = resolveRuntime({ farm, script: scriptRuntime, override })
  return { maxConcurrent: resolved.maxConcurrent, overrideClamps: clamps.filter((c) => c.from === 'override') }
}

/**
 * Plan 98 §3.3 S1, §4.5, step 98.6 — refuses an unsupported `runtime.sdk`
 * with `E_RUNTIME_UNSUPPORTED`, naming the declared major and the supported
 * range (`checkRuntimeMajor`'s own message). Called at every write path this
 * service owns (`enqueue()`, `resume()`) — `jobs/triggers.ts`'s `trigger()`
 * is the THIRD write path onto `jobs` and calls the SAME `checkRuntimeMajor`
 * directly, since it already holds a `ScriptRegistry` entry with no
 * `scriptNameOf` indirection to go through. `undefined` (a pre-plan-98
 * script, or a `scriptNameOf` that predates this plan) never refuses — every
 * script published before this plan keeps enqueueing exactly as before.
 */
function assertRuntimeSupported(sdk: number | undefined): void {
  const result = checkRuntimeMajor(sdk)
  if (result) throw new EnkakuError(result.code, result.message)
}

/**
 * Plan 98 §3.3 S3, §3.8, §4.5, step 98.7 — validates the operator's own
 * per-job layer against `RuntimeEnvelopeSchema` (`E_RUNTIME_ENVELOPE_INVALID`
 * on a shape violation — never trusting a caller's own checks alone, the
 * SAME two-stage discipline `scripts/routes.ts`'s publish route already
 * applies to `scripts.runtime`), and reports an unknown field with one
 * `warn` naming it rather than refusing — the identical schema serves both
 * `scripts.runtime` and `jobs.runtime_override` (this schema's own doc
 * comment), so the identical S3 tolerance applies to both. `raw` is
 * `unknown` deliberately: an operator's own typed input crosses the SAME
 * kind of external boundary `params` does, so it is validated HERE rather
 * than trusted from whatever called `enqueue()`/`resume()`.
 */
function parseRuntimeOverrideInput(deps: { log: Logger }, raw: unknown, context: string): RuntimeEnvelope | null {
  const parsed = RuntimeEnvelopeSchema.nullable().safeParse(raw ?? null)
  if (!parsed.success) {
    throw new EnkakuError(
      'E_RUNTIME_ENVELOPE_INVALID',
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
    )
  }
  const unknown = unknownRuntimeKeys(raw)
  if (unknown.length > 0) {
    deps.log.warn(`${context}: unknown runtime override key(s) dropped: ${unknown.join(', ')}`)
  }
  return parsed.data
}

/** `E_RUNTIME_OVER_CEILING` (plan 98 §3.8, step 98.7) — naming every offending field, its requested value and the ceiling it exceeded, never just one. */
function overCeilingError(clamps: RuntimeClamp[]): EnkakuError {
  return new EnkakuError(
    'E_RUNTIME_OVER_CEILING',
    clamps.map((c) => `runtimeOverride.${c.field} (${c.requested}) exceeds the farm ceiling of ${c.ceiling}`).join('; '),
  )
}

export interface JobService {
  enqueue(input: {
    scriptId: string
    deviceId: string
    params: unknown
    priority?: number
    /**
     * `canUseDevice` (plan 34 §3.5, §4.4) — the caller acting on this device;
     * undefined means "no ownership check" (a test harness, or a host that
     * has not wired auth). Both `POST /api/jobs` and the `job.enqueue` WS
     * message pass this through the SAME choke point rather than duplicating
     * the check at each call site.
     */
    actor?: { id: string; role: Role } | null
    /**
     * Plan 98 §3.8, §4.5, §5 step 98.7 — the operator's own per-job runtime
     * layer, an operator's deliberate instruction at THIS enqueue, checked
     * against the farm's ceiling ALONGSIDE the script's own declaration and
     * refused outright (`E_RUNTIME_OVER_CEILING`) rather than clamped — the
     * asymmetric half of §3.8's precedence rule. `unknown` because it
     * crosses the same kind of external boundary `params` does — validated
     * inside `enqueue()` against `RuntimeEnvelopeSchema`, never trusted from
     * the caller. Omitted/`null`/`undefined` all mean "no override for this
     * job", identical to every job enqueued before this field existed.
     */
    runtimeOverride?: unknown
  }): JobInfo
  /**
   * `opts.cancelDescendants` (plan 81 §4.4) — opt-in, never automatic:
   * also cancels every still-queued job transitively triggered by `jobId`.
   * `cancelledDescendants` is always present, 0 when the option was not
   * used, so a caller never has to guess whether an older server omitted it.
   */
  cancel(jobId: string, opts?: { cancelDescendants?: boolean }): { job: JobInfo; cancelledDescendants: number }
  /**
   * One job, in full (plan 60 §4.3) — including `result`, the script's own
   * return value. `list` deliberately does not: a result can be large, and
   * fifty of them is not what a list is for.
   */
  get(jobId: string): JobDetail | null
  /** `rootJobId` (plan 81 §4.5) — every other member of a trigger chain, for the job detail page's lineage view. */
  list(filter: { deviceId?: string; status?: JobStatus; rootJobId?: string; limit?: number; cursor?: JobCursor | null }): {
    jobs: JobInfo[]
    nextCursor: JobCursor | null
    total: number
  }
  /**
   * `GET /api/jobs/:id/nodes` (plan 99 §3.5, §4.9, step 99.8) — the node
   * timeline: one entry per node EXECUTION, including the ones the cursor
   * never reached (H4), plus `finalized` (has the PARENT job settled — the
   * same terminal check `resume()` gates on, so a "Resume from here" control
   * knows when it may appear). Throws `job_not_found` for a missing job —
   * `jobStore.nodes()` itself returns `[]` either way, so this is the one
   * place that distinguishes "no nodes yet" from "no such job".
   */
  nodes(jobId: string): { items: JobNodeInfo[]; finalized: boolean }
  /**
   * `POST /api/jobs/:id/resume` (plan 99 §3.5, §4.9, step 99.8) — creates a
   * NEW job for the SAME resolved `scriptId` the original job ran: copied
   * straight off the original row, never re-resolved through `@latest` — a
   * pipeline resumed a week later runs exactly the code it started with.
   *
   * `input.fromNode` omitted means "the last node this job actually
   * attempted, if it did not succeed" (`defaultResumeNode` below) — the
   * common case, and the one a bare "Resume" button sends. Throws
   * `job_not_found` for a missing job, `job_not_terminal` (409 — see
   * `api/jobs.ts`'s `ERROR_STATUS`) if the original job has not settled yet,
   * and `job_node_not_found` (400) if `fromNode` never actually executed in
   * it (a node the cursor skipped over does not count as "ran") — or, when
   * `fromNode` was omitted, if no node in the job ever failed to succeed (an
   * all-success job, or one a GATE alone ended failed) and the caller must
   * name one explicitly.
   */
  resume(jobId: string, input?: { fromNode?: string }): JobInfo
}

/**
 * The default resume point when `POST /api/jobs/:id/resume` omits
 * `fromNode` (plan 99 §3.5, §4.9, step 99.8) — "the last node this job
 * actually attempted, if it did not succeed."
 *
 * `rows` is already in seq (execution) order (`JobStore.nodes()`'s own
 * contract). `'skipped'` and `'skipped-on-resume'` rows are never real
 * executions IN THIS JOB — a gate steering around a node, or a node replayed
 * from an earlier resume — so they are filtered out before looking at the
 * LAST remaining row, not merely the first non-success one: a `goto` loop
 * can re-run the same `nodeId` after an earlier failure, and scanning
 * forward for the first failure would then point at a node that went on to
 * succeed later in the very same job. The interpreter only ever has ONE node
 * "in flight" when a job ends, so the last attempted row IS that node.
 *
 * Returns `null` when the last attempted row already succeeded — every node
 * ran fine and a GATE alone chose to end the workflow failed (§3.7's `then`/
 * `else`), or the job is not actually failed at all — because there is no
 * node-level failure to default to, and guessing one would be worse than
 * asking the caller to name it.
 */
function defaultResumeNode(rows: { nodeId: string; status: string }[]): string | null {
  const attempted = rows.filter((r) => r.status !== 'skipped' && r.status !== 'skipped-on-resume')
  const last = attempted[attempted.length - 1]
  if (!last || last.status === 'success') return null
  return last.nodeId
}

/** One code path for both REST and WS (plan 04 §4.7). */
export function createJobService(deps: {
  jobStore: JobStore
  registry: ExecutorRegistry
  scheduler: Scheduler
  host: ExecutorHost
  log: Logger
  onJobStatus: (info: JobInfo) => void
  /** Check the `scripts` table for a non-built-in scriptId (M4). */
  findScript?: (scriptId: string) => { enabled: boolean } | null
  /**
   * Plan 82 §3.4 — denormalises `jobs.scriptName`/`.scriptVersion` at
   * enqueue, from whatever resolved `scriptId` (the entry a
   * `ScriptRegistry.resolve()` returned, in the host that has one wired —
   * `daemon.ts`). Optional and additive: omitted, a job enqueues exactly as
   * it did before this plan, and its name keeps resolving through
   * `scriptNames()`'s `scripts` table lookup.
   *
   * Plan 98 §3.1, §3.7, §4.6, step 98.5 widens the return shape with an
   * OPTIONAL `runtime` field — never a second accessor — because
   * `daemon.ts`'s existing wiring (`scriptNameOf: (scriptId) =>
   * scriptRegistry.get(scriptId)`) already returns the full `ScriptEntry`,
   * `runtime` included; only the type this interface declared was narrower.
   * `runtime` is `RuntimeEnvelope | null` on a real `ScriptEntry`, never
   * actually `undefined` — optional here only so a hand-written fake that
   * predates this plan (returning bare `{ name, version }`) keeps compiling
   * unchanged.
   */
  scriptNameOf?: (scriptId: string) => { name: string; version: string; runtime?: RuntimeEnvelope | null } | null
  /**
   * Plan 98 §3.7, §3.8, §4.1, §4.6, §4.7, steps 98.5/98.7 — live `job` farm
   * settings, read fresh on every call (the same freshness pattern
   * `resetPolicy`/`adb.maxConcurrent` already use, F25) and threaded into
   * `resolveRuntime`. `maxConcurrent` itself has no farm layer at all (see
   * `resolveJobRuntime`'s own comment above); the override's ceiling check
   * DOES read this farm layer (`job.maxTimeoutMs`/`job.memory.maxRssBytes`),
   * so omitting this (a test harness, or a host that has not wired it)
   * resolves identically to a live farm with every `job.*` setting left at
   * its default — including "no ceiling", so an override is never refused
   * by an unwired getter that a real farm would have refused for real.
   */
  farmJobSettings?: () => JobSettings
  /** A batch member job was cancelled while still queued — recompute the batch (plan 20 §4.5). */
  onBatchChanged?: (batchId: string) => void
  /**
   * `canUseDevice`'s device half (plan 34 §3.5, §4.4) — a lookup, not the
   * whole `devices` row, so a caller with no interest in ACL (a test, or a
   * host that has not wired auth) can simply omit it. Undefined means "no
   * ownership check", same as `input.actor` being undefined.
   */
  getDeviceOwner?: (deviceId: string) => { ownerId: string | null } | null
  /**
   * Plan 93 §3.12, §4.6, step 93.8 — live `shell.mode`, threaded into
   * `validateScriptForRun` alongside `input.actor`'s role (below) so
   * `POST /api/jobs {scriptId:'internal:install'}` is finally gated by
   * `device.files`, closing F10's "checks no permission at all" half.
   * Optional so every pre-93.8 test keeps compiling unedited; unwired, the
   * `JobExecutor.requires` gate is not evaluated, exactly today's behaviour.
   */
  shellMode?: () => ShellMode
  /** Live `transfer.enabled` — same reasoning as `shellMode` above. */
  transferEnabled?: () => boolean
}): JobService {
  return {
    enqueue(input) {
      if (input.actor) {
        const device = deps.getDeviceOwner?.(input.deviceId)
        if (device && !canUseDevice(input.actor, device)) {
          throw new EnkakuError('auth.forbidden', 'this device belongs to another user')
        }
      }
      const named = deps.scriptNameOf?.(input.scriptId) ?? null
      // Plan 98 §3.3 S1, §4.5, step 98.6 — refused HERE, before params
      // validation and before any device is claimed (F4's own reasoning
      // applied to a new gate): a bundle this core cannot run is refused by
      // name, naming the declared major and the supported range, and no
      // device is ever claimed for it. An older core meeting a newer script's
      // envelope is a normal condition on a farm that updates in stages
      // (plan 59), never surprising — `undefined` (every pre-plan-98 script)
      // never refuses.
      assertRuntimeSupported(named?.runtime?.sdk)
      // Plan 93 §3.12, §4.6, step 93.8 — `input.actor`'s role is per-CALL
      // (unlike `shellMode`/`transferEnabled`, which are farm-wide and live
      // on `deps` itself), so it is merged in here rather than on `deps`
      // directly — the same "per-call actorRole, farm-wide everything else"
      // split `api/batches.ts`'s own call sites use.
      const params = validateScriptForRun({ ...deps, actorRole: () => input.actor?.role ?? null }, input.scriptId, input.params)
      // Plan 98 §3.8, §4.5, §4.7, step 98.7 — the operator's own per-job
      // layer: shape-validated, unknown keys warned (never fatal, §3.3 S3),
      // then resolved ALONGSIDE `maxConcurrent` through the SAME
      // `resolveRuntime` call — refused with `E_RUNTIME_OVER_CEILING`
      // before the row is written if the override itself exceeds the
      // farm's ceiling (never clamped: a human typed this number, §3.8).
      const runtimeOverride = parseRuntimeOverrideInput(deps, input.runtimeOverride, `enqueue ${input.scriptId}`)
      // Plan 98 §3.7, §3.8, §4.6, §4.7, steps 98.5/98.7 — resolved HERE,
      // before the device is ever claimed (F4's own reasoning applied to a
      // new field), and `maxConcurrent` pinned onto the row `jobStore.enqueue`
      // is about to write — never re-derived later, so a republish with a
      // different `runtime.maxConcurrent` never reaches an already-queued
      // job (spec §11.6, matching `scriptName`/`scriptVersion` immediately
      // below). The farm ceiling still wins over the override — §3.8's own
      // precedence, `resolveJobRuntime`'s own contract.
      const { maxConcurrent, overrideClamps } = resolveJobRuntime(deps, named?.runtime ?? null, runtimeOverride)
      if (overrideClamps.length > 0) throw overCeilingError(overrideClamps)
      const row = deps.jobStore.enqueue({
        scriptId: input.scriptId,
        deviceId: input.deviceId,
        params,
        scriptName: named?.name,
        scriptVersion: named?.version,
        priority: input.priority ?? 0,
        maxConcurrent,
        runtimeOverride,
      })
      const info = rowToJobInfo(row, deps.jobStore.scriptNames([row.scriptId]).get(row.scriptId) ?? null)
      deps.onJobStatus(info)
      deps.scheduler.kick()
      return info
    },

    cancel(jobId, opts) {
      const job = deps.jobStore.get(jobId)
      if (!job) throw new EnkakuError('job_not_found', `no such job: ${jobId}`)
      // Cancel-with-descendants (plan 81 §4.4) runs regardless of the
      // caller's own status branch below — a RUNNING job can still have
      // queued descendants (it triggered them and kept going), so this is
      // not folded into either branch.
      const cancelledDescendants = opts?.cancelDescendants ? deps.jobStore.cancelQueuedDescendants(jobId) : 0
      if (job.status === 'queued') {
        const cancelled = deps.jobStore.cancelQueued(jobId)
        if (!cancelled) throw new EnkakuError('job_not_cancellable', 'the job changed status first')
        const info = rowToJobInfo(cancelled)
        deps.onJobStatus(info)
        if (cancelled.batchId) deps.onBatchChanged?.(cancelled.batchId)
        return { job: info, cancelledDescendants }
      }
      if (job.status === 'running') {
        if (!deps.host.abort(jobId)) {
          // No live executor (after a restart, say) → close it immediately.
          deps.host.finishExternally(jobId, 'cancelled', 'cancelled (no executor was running)')
        }
        return { job: rowToJobInfo(deps.jobStore.get(jobId) ?? job), cancelledDescendants }
      }
      throw new EnkakuError('job_not_cancellable', `the job is ${job.status}`)
    },

    get(jobId) {
      const row = deps.jobStore.get(jobId)
      if (!row) return null
      return rowToJobDetail(row, deps.jobStore.scriptNames([row.scriptId]).get(row.scriptId) ?? null)
    },

    nodes(jobId) {
      const job = deps.jobStore.get(jobId)
      if (!job) throw new EnkakuError('job_not_found', `no such job: ${jobId}`)
      // `?? []` covers a `JobStore` fake with no `nodes()` implementation
      // (the method is optional — see its own comment in `job-store.ts`);
      // the REAL store always has one.
      const items = (deps.jobStore.nodes?.(jobId) ?? []).map(rowToJobNodeInfo)
      const finalized = TERMINAL_JOB_STATUSES.has((job.status ?? 'queued') as JobStatus)
      return { items, finalized }
    },

    resume(jobId, input) {
      const original = deps.jobStore.get(jobId)
      if (!original) throw new EnkakuError('job_not_found', `no such job: ${jobId}`)
      if (!TERMINAL_JOB_STATUSES.has((original.status ?? 'queued') as JobStatus)) {
        throw new EnkakuError('job_not_terminal', `job ${jobId} is still ${original.status} — resume only a job that has settled`)
      }

      const rows = deps.jobStore.nodes?.(jobId) ?? []
      const fromNode = input?.fromNode ?? defaultResumeNode(rows)
      if (!fromNode) {
        throw new EnkakuError('job_node_not_found', `job ${jobId} has no failed node to resume from — pass fromNode explicitly`)
      }
      // "ran" excludes `status: 'skipped'` — a node the cursor never reached
      // (a gate steered around it, or the workflow ended first) is not a
      // valid resume point even if it is a real node in the document.
      const ran = rows.some((n) => n.nodeId === fromNode && n.status !== 'skipped')
      if (!ran) {
        throw new EnkakuError('job_node_not_found', `node "${fromNode}" never ran in job ${jobId}`)
      }

      // Plan 98 §3.7, §4.6, step 98.5 — resolved fresh from the ORIGINAL
      // job's own pinned `scriptId` (never re-resolved through `@latest`,
      // same as every other field copied below): a resume must be bound by
      // the same farm-wide cap an ordinary enqueue would apply, or a
      // `maxConcurrent: 1` script would become uncapped the moment its jobs
      // start getting resumed instead of freshly enqueued.
      const originalRuntime = deps.scriptNameOf?.(original.scriptId)?.runtime ?? null
      // Plan 98 §3.3 S1, step 98.6 — re-checked on resume too, not only on a
      // fresh enqueue: a resume creates a genuinely NEW job that will be
      // claimed and run fresh, and the core this resumes on may have been
      // downgraded since the original job was enqueued.
      assertRuntimeSupported(originalRuntime?.sdk)
      // Plan 98 §3.8, §4.4, step 98.7 — the ORIGINAL job's own per-job
      // override carries FORWARD, exactly like `params`/`scriptName` above:
      // an operator who overrode this job's runtime meant that instruction
      // for the whole pipeline, not just its first attempt. Re-checked
      // against whatever the farm's ceiling is NOW, not what it was when the
      // original job was enqueued — the same "re-resolve, never copy blind"
      // rule `maxConcurrent` already follows on this exact path.
      const originalOverride = parseJobRuntimeOverride(original.runtimeOverride)
      const { maxConcurrent, overrideClamps } = resolveJobRuntime(deps, originalRuntime, originalOverride)
      if (overrideClamps.length > 0) throw overCeilingError(overrideClamps)
      const row = deps.jobStore.enqueue({
        scriptId: original.scriptId, // RESOLVED, copied verbatim — never re-resolved (plan 99 §3.5)
        deviceId: original.deviceId,
        params: original.params,
        scriptName: original.scriptName,
        scriptVersion: original.scriptVersion,
        priority: original.priority ?? 0,
        maxConcurrent,
        runtimeOverride: originalOverride,
      })
      deps.jobStore.recordResume?.(row.id, { resumedFromJobId: jobId, resumedFromNode: fromNode })
      const info = rowToJobInfo(row, deps.jobStore.scriptNames([row.scriptId]).get(row.scriptId) ?? null)
      deps.onJobStatus(info)
      deps.scheduler.kick()
      return info
    },

    list(filter) {
      const { rows, nextCursor, total } = deps.jobStore.list({
        deviceId: filter.deviceId,
        status: filter.status,
        rootJobId: filter.rootJobId,
        limit: filter.limit ?? 50,
        cursor: filter.cursor,
      })
      const names = deps.jobStore.scriptNames(rows.map((r) => r.scriptId))
      return { jobs: rows.map((r) => rowToJobInfo(r, names.get(r.scriptId) ?? null)), nextCursor, total }
    },
  }
}
