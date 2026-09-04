import { and, asc, eq, inArray } from 'drizzle-orm'
import type { JobInfo, JobSettings, RuntimeClamp, RuntimeEnvelope, RunTrigger } from '@enkaku/protocol'
import { checkRuntimeMajor, JobSettingsSchema, resolveRuntime, RuntimeEnvelopeSchema } from '@enkaku/protocol'
import type { Db } from '../db'
import { batches, groups, devices, jobRuns, jobs, type BatchRow, type JobRow } from '../db/schema'
import type { AuditLogger } from '../auth/audit'
import { rowToJobInfo } from '../queue/job-store'
import type { RunStore } from '../jobs/runs/store'
import type { Scheduler } from '../queue/scheduler'
import { EnkakuError } from '../util/errors'
import { resolveGroup, resolveTarget, type ResolvedGroup } from './resolve'
import type { BatchPacer } from './pacer'

const DEFAULT_FARM_JOB_SETTINGS: JobSettings = JobSettingsSchema.parse({})

function resolveBatchRuntime(
  deps: { farmJobSettings?: () => JobSettings },
  scriptRuntime: RuntimeEnvelope | null,
  override: RuntimeEnvelope | null,
): { maxConcurrent: number; overrideClamps: RuntimeClamp[] } {
  const farm = deps.farmJobSettings?.() ?? DEFAULT_FARM_JOB_SETTINGS
  const { resolved, clamps } = resolveRuntime({ farm, script: scriptRuntime, override })
  return { maxConcurrent: resolved.maxConcurrent, overrideClamps: clamps.filter((c) => c.from === 'override') }
}

function parseBatchRuntimeOverride(raw: unknown): RuntimeEnvelope | null {
  const parsed = RuntimeEnvelopeSchema.nullable().safeParse(raw ?? null)
  if (!parsed.success) {
    throw new EnkakuError(
      'E_RUNTIME_ENVELOPE_INVALID',
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
    )
  }
  return parsed.data
}

function overBatchCeilingError(clamps: RuntimeClamp[]): EnkakuError {
  return new EnkakuError(
    'E_RUNTIME_OVER_CEILING',
    clamps.map((c) => `runtimeOverride.${c.field} (${c.requested}) exceeds the farm ceiling of ${c.ceiling}`).join('; '),
  )
}

export interface CreateBatchInput {
  scriptId: string
  params: unknown
  target: { groupId: string } | { deviceIds: string[] }
  concurrency: number
  order: 'as-listed' | 'random'
  priority?: number
  createdBy?: string | null
  runtimeOverride?: unknown
  expiresAt?: number | null
  pacing?: { count: number; intervalMs: [number, number]; deviceIntervalMs: number } | null
}

export interface BatchDispatchDeps {
  db: Db
  runs: RunStore
  scheduler: Scheduler
  audit: AuditLogger
  onJobStatus: (info: JobInfo) => void
  validateScript?: (scriptId: string, params: unknown) => unknown
  assertDeviceAllowed?: (deviceId: string) => void
  scriptNameOf?: (scriptId: string) => { name: string; version: string; runtime?: RuntimeEnvelope | null } | null
  farmJobSettings?: () => JobSettings
  pacer?: BatchPacer
}

/**
 * Fisher-Yates using `crypto.getRandomValues`, not `Math.random()` (plan 20
 * §4.4). Resolved once, at dispatch — the report then shows the order that
 * actually ran; nothing depends on a random number that no longer exists
 * (plan 20 §3.2).
 */
function shuffle<T>(items: T[]): T[] {
  const arr = [...items]
  const rand = new Uint32Array(arr.length)
  crypto.getRandomValues(rand)
  for (let i = arr.length - 1; i > 0; i--) {
    const j = (rand[i] as number) % (i + 1)
    const tmp = arr[i] as T
    arr[i] = arr[j] as T
    arr[j] = tmp
  }
  return arr
}

/**
 * Resolve targets → insert the batch → insert one job (plus its first run,
 * `trigger: 'batch'`) per device with `batchSeq` assigned in the final order
 * → audit → kick the scheduler (plan 20 §4.4, plan 211 §3.2 decision 3). The
 * batch row and every job/run row are inserted in one transaction, so a
 * crash between them cannot half-create a batch (plan 20 §3.4).
 *
 * A group (or an ad-hoc list) resolving to zero usable devices is a coded
 * error at dispatch, not an empty batch (plan 20 §3.1, §4.3): silently doing
 * nothing is the failure mode people notice last.
 */
export function createBatch(deps: BatchDispatchDeps, input: CreateBatchInput): { batch: BatchRow; jobs: JobRow[] } {
  const { db } = deps
  const validatedParams = deps.validateScript ? deps.validateScript(input.scriptId, input.params) : input.params

  let groupId: string | null = null
  let resolved: ResolvedGroup
  if ('groupId' in input.target) {
    const group = db.select().from(groups).where(eq(groups.id, input.target.groupId)).get()
    if (!group) throw new EnkakuError('group_not_found', `no such group: ${input.target.groupId}`)
    groupId = group.id
    resolved = resolveGroup(db, group)
  } else {
    resolved = resolveTarget(db, { tags: [], deviceIds: input.target.deviceIds })
  }

  if (resolved.usable.length === 0) {
    throw new EnkakuError(
      'E_NO_TARGETS',
      resolved.skipped.length > 0
        ? `no usable devices — every match was unavailable: ${resolved.skipped.map((s) => `${s.deviceId} (${s.reason})`).join(', ')}`
        : 'no devices matched this target',
    )
  }

  if (deps.assertDeviceAllowed) {
    for (const t of resolved.usable) deps.assertDeviceAllowed(t.deviceId)
  }

  const ordered = input.order === 'random' ? shuffle(resolved.usable) : resolved.usable
  const batchId = crypto.randomUUID()
  const now = new Date()
  const priority = input.priority ?? 0

  const named = deps.scriptNameOf?.(input.scriptId) ?? null

  const versionCheck = checkRuntimeMajor(named?.runtime?.sdk)
  if (versionCheck) throw new EnkakuError(versionCheck.code, versionCheck.message)

  const runtimeOverride = parseBatchRuntimeOverride(input.runtimeOverride)
  const { maxConcurrent, overrideClamps } = resolveBatchRuntime(deps, named?.runtime ?? null, runtimeOverride)
  if (overrideClamps.length > 0) throw overBatchCeilingError(overrideClamps)

  const expiresAt = input.expiresAt ?? null
  const pacing = input.pacing ?? null

  db.transaction(() => {
    db.insert(batches)
      .values({
        id: batchId,
        groupId,
        scriptId: input.scriptId,
        params: validatedParams ?? null,
        concurrency: input.concurrency,
        order: input.order,
        status: 'queued',
        repeatCount: pacing?.count ?? 1,
        intervalMinMs: pacing?.intervalMs[0] ?? 0,
        intervalMaxMs: pacing?.intervalMs[1] ?? 0,
        deviceIntervalMs: pacing?.deviceIntervalMs ?? 0,
        createdBy: input.createdBy ?? null,
        createdAt: now,
        finishedAt: null,
        skipped: resolved.skipped.length > 0 ? resolved.skipped : null,
      })
      .run()
    ordered.forEach((t, i) => {
      const job = deps.runs.createJob({
        kind: 'script',
        scriptId: input.scriptId,
        deviceId: t.deviceId,
        params: validatedParams,
        scriptName: named?.name ?? null,
        scriptVersion: named?.version ?? null,
        batchId,
        batchSeq: i,
        createdBy: input.createdBy ?? null,
      })
      deps.runs.addRun(job.id, { trigger: 'batch', priority, expiresAt, maxConcurrent, runtimeOverride })
    })
  })

  const batch = db.select().from(batches).where(eq(batches.id, batchId)).get()
  if (!batch) throw new EnkakuError('E_DB', 'batch insert did not persist')

  deps.pacer?.planFirst(batchId)

  const finalJobRows = db.select().from(jobs).where(eq(jobs.batchId, batchId)).orderBy(asc(jobs.batchSeq)).all()

  deps.audit.record({
    userId: input.createdBy ?? null,
    action: 'job.run',
    target: batchId,
    meta: { scriptId: input.scriptId, deviceCount: finalJobRows.length, order: input.order, skipped: resolved.skipped },
  })
  const latestRuns = deps.runs.latestRuns(finalJobRows.map((r) => r.id))
  for (const row of finalJobRows) deps.onJobStatus(rowToJobInfo(row, latestRuns.get(row.id) ?? null, named))
  deps.scheduler.kick()

  return { batch, jobs: finalJobRows }
}

export interface CreateWorkflowBatchInput {
  workflowName: string
  workflowDoc: unknown
  params: unknown
  target: { groupId: string } | { deviceIds: string[] }
  concurrency: number
  order: 'as-listed' | 'random'
  priority?: number
  createdBy?: string | null
}

/**
 * `run-workflow` (plan 211 §4.8) — one `kind: 'workflow'` job per accepted
 * device, inside the same batch-dispatch transaction `createBatch` uses for
 * a script batch. No `scriptId`/`scriptNameOf`/runtime resolution: a
 * workflow job carries its own snapshot document, not a pinned script row.
 */
export function createWorkflowBatch(
  deps: Pick<BatchDispatchDeps, 'db' | 'runs' | 'scheduler' | 'audit' | 'onJobStatus' | 'assertDeviceAllowed'>,
  input: CreateWorkflowBatchInput,
): { batch: BatchRow; jobs: JobRow[] } {
  const { db } = deps

  let groupId: string | null = null
  let resolved: ResolvedGroup
  if ('groupId' in input.target) {
    const group = db.select().from(groups).where(eq(groups.id, input.target.groupId)).get()
    if (!group) throw new EnkakuError('group_not_found', `no such group: ${input.target.groupId}`)
    groupId = group.id
    resolved = resolveGroup(db, group)
  } else {
    resolved = resolveTarget(db, { tags: [], deviceIds: input.target.deviceIds })
  }

  if (resolved.usable.length === 0) {
    throw new EnkakuError(
      'E_NO_TARGETS',
      resolved.skipped.length > 0
        ? `no usable devices — every match was unavailable: ${resolved.skipped.map((s) => `${s.deviceId} (${s.reason})`).join(', ')}`
        : 'no devices matched this target',
    )
  }

  if (deps.assertDeviceAllowed) {
    for (const t of resolved.usable) deps.assertDeviceAllowed(t.deviceId)
  }

  const batchId = crypto.randomUUID()
  const now = new Date()
  const priority = input.priority ?? 0

  db.transaction(() => {
    db.insert(batches)
      .values({
        id: batchId,
        groupId,
        scriptId: `workflow:${input.workflowName}`,
        params: input.params ?? null,
        concurrency: input.concurrency,
        order: input.order,
        status: 'queued',
        createdBy: input.createdBy ?? null,
        createdAt: now,
        finishedAt: null,
        skipped: resolved.skipped.length > 0 ? resolved.skipped : null,
      })
      .run()
    resolved.usable.forEach((t, i) => {
      const job = deps.runs.createJob({
        kind: 'workflow',
        workflowName: input.workflowName,
        workflowDoc: input.workflowDoc,
        deviceId: t.deviceId,
        params: input.params,
        scriptName: input.workflowName,
        scriptVersion: null,
        batchId,
        batchSeq: i,
        createdBy: input.createdBy ?? null,
      })
      deps.runs.addRun(job.id, { trigger: 'batch', priority })
    })
  })

  const batch = db.select().from(batches).where(eq(batches.id, batchId)).get()
  if (!batch) throw new EnkakuError('E_DB', 'batch insert did not persist')

  const finalJobRows = db.select().from(jobs).where(eq(jobs.batchId, batchId)).orderBy(asc(jobs.batchSeq)).all()
  const latestRuns = deps.runs.latestRuns(finalJobRows.map((r) => r.id))
  for (const row of finalJobRows) deps.onJobStatus(rowToJobInfo(row, latestRuns.get(row.id) ?? null))
  deps.scheduler.kick()

  return { batch, jobs: finalJobRows }
}

/**
 * Adds a run to every named member job of a batch (a re-run or re-run-failed,
 * plan 211 §4.8/§4.9). Creates a member job for a device newly in the target
 * that has none yet — deliberately NOT done here (a schedule's own re-target
 * happens in `schedules/runner.ts`; a batch's own re-run only ever touches
 * jobs the batch already has).
 */
export function addRunsToBatch(
  deps: BatchDispatchDeps,
  batchId: string,
  input: { jobIds: string[]; trigger: RunTrigger; priority?: number; expiresAt?: number | null },
): { jobs: JobRow[]; runIds: string[] } {
  const runIds: string[] = []
  for (const jobId of input.jobIds) {
    const run = deps.runs.addRun(jobId, { trigger: input.trigger, priority: input.priority, expiresAt: input.expiresAt })
    runIds.push(run.id)
  }
  const finalJobRows = deps.db.select().from(jobs).where(eq(jobs.batchId, batchId)).orderBy(asc(jobs.batchSeq)).all()
  const touched = finalJobRows.filter((j) => input.jobIds.includes(j.id))
  const latestRuns = deps.runs.latestRuns(touched.map((r) => r.id))
  for (const row of touched) deps.onJobStatus(rowToJobInfo(row, latestRuns.get(row.id) ?? null))
  deps.scheduler.kick()
  return { jobs: touched, runIds }
}

/**
 * Plan 36 §3.6 — after an infra failure, a batch member should move to
 * another eligible device rather than retrying against the one that is
 * failing. Picks the lowest-`batchSeq` sibling device that is currently
 * `online` with no running RUN of its own (plan 205 §4.6, §4.7, plan 211
 * §4.6) and not the device the job just failed on.
 */
export function pickRebindDevice(db: Db, job: JobRow): string | null {
  if (!job.batchId) return null
  const siblings = db.select({ deviceId: jobs.deviceId }).from(jobs).where(eq(jobs.batchId, job.batchId)).orderBy(asc(jobs.batchSeq)).all()
  const candidateIds = [...new Set(siblings.map((s) => s.deviceId))].filter((id) => id !== job.deviceId)
  if (candidateIds.length === 0) return null
  const rows = db.select().from(devices).where(inArray(devices.id, candidateIds)).all()
  const byId = new Map(rows.map((r) => [r.id, r]))
  const runningDeviceIds = new Set(
    db
      .select({ deviceId: jobRuns.deviceId })
      .from(jobRuns)
      .where(and(inArray(jobRuns.deviceId, candidateIds), eq(jobRuns.status, 'running')))
      .all()
      .map((r) => r.deviceId),
  )
  for (const id of candidateIds) {
    if (byId.get(id)?.status === 'online' && !runningDeviceIds.has(id)) return id
  }
  return null
}
