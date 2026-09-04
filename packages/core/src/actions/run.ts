import type {
  ActionRequest,
  ActionResponse,
  ActionResult,
  ActionVerb,
  DeviceSettingsPatch,
  ShellMode,
} from '@enkaku/protocol'
import { E_DEVICE_CONFLICT } from '@enkaku/protocol'
import type { Role } from '../auth/service'
import { can, canUseFiles, canUseShell } from '../auth/acl'
import type { Permission } from '../auth/acl'
import type { AuditLogger } from '../auth/audit'
import type { ActivityRegistry } from '../activity/registry'
import { evaluate, type ControlPolicySettings } from '../activity/policy'
import type { Db } from '../db'
import type { DeviceStateMachine } from '../device/state-machine'
import type { EventRecorder } from '../events/recorder'
import type { DeviceLifecycle } from '../device/lifecycle'
import type { LabellingService } from '../device/labelling'
import type { BatteryMonitor } from '../device/battery'
import type { ReadinessManager } from '../device/readiness'
import type { ShellPort } from '../device/shell-port'
import type { DeviceReconnector } from '../registry/reconnect'
import type { CutoverManager } from '../registry/cutover'
import type { FarmNetwork } from '../registry/device-registry'
import type { SessionManager } from '@enkaku/session'
import { EnkakuError } from '../util/errors'
import { resolveActionTarget } from '../groups/resolve'
import type { BatchDispatchDeps } from '../groups/dispatch'
import type { OperationRegistry } from './operations'
import { VERBS, ACTION_FANOUT_CONCURRENCY } from './verbs'
import { setReadiness } from './impl/readiness'
import { reconnectDevice, disconnectDevice, cutoverStart, cutoverCancel } from './impl/connection'
import { forgetDevice, blockDevice, unquarantineDevice } from './impl/lifecycle'
import { setLabel, clearLabel } from './impl/labelling'
import { setGroup, setTags } from './impl/membership'
import { prepareDevice, retryPrepareComponent, type PreparationDeps } from './impl/preparation'
import { installOnDevice, pushToDevice, pullFromDevice, type TransferDeps } from './impl/transfer'
import { runShellCommand } from './impl/shell'
import { applySettings } from './impl/settings'
import { screenshotDevice } from './impl/screenshot'
import { runScriptOnExistingJob, runScriptOnTargets } from './impl/run-script'
import { validateNetworkRoute, applyNetworkAction, type NetworkActionsDoor } from './impl/network'
import { createWorkflowBatch, type CreateWorkflowBatchInput } from '../groups/dispatch'
import type { JobService } from '../services/job-service'
import type { WorkflowStore } from '../workflows/store'

export interface ActionActor {
  id: string
  role: Role
}

export interface ActionsDeps {
  db: Db
  audit: AuditLogger
  record: EventRecorder['record']
  broadcast: (msg: unknown) => void
  activities: ActivityRegistry
  controlSettings: () => ControlPolicySettings
  states: Pick<DeviceStateMachine, 'current'>
  operations: OperationRegistry
  userLabel: (userId: string) => string
  shellSettings: () => { mode: ShellMode; execTimeoutMs: number; maxOutputBytes: number }
  transferSettings: () => { enabled: boolean }
  /**
   * `run-script`'s dispatch deps, built PER REQUEST from the acting user
   * (never a single static object) — `BatchDispatchDeps.validateScript`'s
   * `actorRole` closure is how `job/validate-script.ts`'s F10 fix (an
   * `internal:install` script needs `device.files`/`transfer.enabled`, not
   * merely `job.run`) is enforced; a fixed `null` actor here would silently
   * reopen F10 for every caller on the one surviving path to `run-script`
   * (`api/batches.ts`/`api/jobs.ts`'s own `POST /` routes are gone — this
   * verb is the only door left). `daemon.ts` wires this to
   * `(actor) => createBatchDispatchDeps(hostDeps, actor)`, the SAME factory
   * `api/batches.ts`'s own routes call for their own per-request actor.
   */
  batchesFor: (actor: ActionActor) => BatchDispatchDeps
  jobService: JobService
  /** The `workflows` table reader (plan 210), for `run-workflow`'s document snapshot (plan 211 §4.8). */
  workflows: WorkflowStore
  resolveScriptRef: (ref: string) => { id: string }
  transfer: TransferDeps
  shellPortFor: (deviceId: string) => ShellPort
  readiness: Pick<ReadinessManager, 'set'> | null
  reconnector: () => DeviceReconnector | null
  sessions: () => Pick<SessionManager, 'closeDevice' | 'restartAt' | 'get' | 'setRotation'> | null
  cutover: () => CutoverManager | null
  lifecycle: DeviceLifecycle
  battery: () => Pick<BatteryMonitor, 'unquarantine'> | null
  routeService: () => NetworkActionsDoor | null
  labelling: LabellingService | null
  preparation: PreparationDeps
  screenshot: (deviceId: string) => Promise<Uint8Array>
  dataDir: string
  networks: () => FarmNetwork[]
  infoWithTags: (deviceId: string) => { ownerId: string | null }
  now?: () => number
}

type ActivityActor = { kind: 'user'; id: string; label: string }

function activityActorOf(deps: ActionsDeps, actor: ActionActor): ActivityActor {
  return { kind: 'user', id: actor.id, label: deps.userLabel(actor.id) }
}

function failedStatusOf(err: unknown): { status: 'forbidden' | 'skipped' | 'failed'; code: string; message: string } {
  const code = err instanceof EnkakuError ? err.code : 'E_INTERNAL'
  const message = err instanceof Error ? err.message : String(err)
  if (code === E_DEVICE_CONFLICT || code === 'device_busy' || code === 'device_in_use' || code === 'job_running') {
    return { status: 'forbidden', code, message }
  }
  if (code === 'device_unavailable' || code === 'device_offline' || code === 'device_quarantined' || code === 'not_quarantined') {
    return { status: 'skipped', code, message }
  }
  return { status: 'failed', code, message }
}

function canUseDevice(actor: ActionActor, ownerId: string | null): boolean {
  return ownerId === null || ownerId === actor.id || actor.role === 'admin'
}

function requireDep<T>(value: T | null, verb: string): T {
  if (value === null) throw new EnkakuError('E_NOT_SUPPORTED', `${verb} is not available (orchestrator mode, or the adb subsystem is not ready)`)
  return value
}

function checkGate(deps: ActionsDeps, actor: ActionActor, verb: ActionVerb): void {
  const spec = VERBS[verb]
  if ('permission' in spec.gate) {
    if (!can(actor.role, spec.gate.permission as Permission)) {
      throw new EnkakuError('auth.forbidden', `you do not have permission to run ${verb}`)
    }
    return
  }
  const shell = deps.shellSettings()
  if (spec.gate.gate === 'shell') {
    if (!canUseShell(actor.role, shell.mode)) throw new EnkakuError('auth.forbidden', 'you do not have permission to run shell commands on a device')
    return
  }
  if (!canUseFiles(actor.role, shell.mode) || !deps.transferSettings().enabled) {
    throw new EnkakuError('auth.forbidden', 'you do not have permission to transfer files on this device')
  }
}

/** One device's candidacy: a final result, or `null` meaning "dispatch it". */
function evaluateDevice(deps: ActionsDeps, verb: ActionVerb, deviceId: string, force: boolean): ActionResult | null {
  const spec = VERBS[verb]
  const status = deps.states.current(deviceId)
  if (status === null) return { deviceId, status: 'skipped', message: 'no longer exists' }
  if (status !== 'online' && spec.offline === 'skip') {
    return { deviceId, status: 'skipped', message: status }
  }
  if (spec.policyKind) {
    const decision = evaluate(spec.policyKind, deps.activities.list(deviceId), deps.controlSettings())
    if (decision.decision === 'forbid') {
      return { deviceId, status: 'forbidden', code: E_DEVICE_CONFLICT, message: decision.message }
    }
    if (decision.decision === 'warn' && !force) {
      return { deviceId, status: 'warned', message: decision.message }
    }
  }
  return null
}

async function dispatchBounded<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let idx = 0
  async function worker(): Promise<void> {
    while (idx < items.length) {
      const item = items[idx++]!
      await fn(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()))
}

export async function runAction(deps: ActionsDeps, request: ActionRequest, actor: ActionActor): Promise<ActionResponse> {
  checkGate(deps, actor, request.verb)
  // The whole-request route validation `set-network op: set` needs (plan
  // 207 §4.3 step 4): a malformed route or a credential is a bad request,
  // not one failure per device.
  if (request.verb === 'set-network' && request.op === 'set') {
    validateNetworkRoute(request.route)
  }

  // `run-script`/`run-workflow` with `jobId` (plan 211 §4.8) — a re-run of
  // an EXISTING job: the target is ignored (a job names its own device),
  // and this never goes through the batch-fan-out machinery below at all.
  if ((request.verb === 'run-script' || request.verb === 'run-workflow') && request.jobId) {
    const targetDeviceIds = 'deviceIds' in request.target ? request.target.deviceIds : []
    const { result } = runScriptOnExistingJob(deps.jobService, request.jobId, { deviceIds: targetDeviceIds }, { params: request.params })
    const op = deps.operations.create({ verb: request.verb, target: request.target, createdBy: actor.id, results: [result] })
    return deps.operations.get(op.operationId)!
  }

  const resolved = resolveActionTarget(deps.db, request.target)
  const results: ActionResult[] = []
  const candidates: string[] = []
  const seen = new Set<string>()
  const spec = VERBS[request.verb]

  for (const skip of resolved.skipped) {
    if (seen.has(skip.deviceId)) continue
    seen.add(skip.deviceId)
    if (spec.offline === 'allow' && (skip.reason === 'offline' || skip.reason === 'quarantined')) {
      candidates.push(skip.deviceId)
      continue
    }
    results.push({ deviceId: skip.deviceId, status: 'skipped', message: skip.reason })
  }
  for (const usable of resolved.usable) {
    if (seen.has(usable.deviceId)) continue
    seen.add(usable.deviceId)
    const owner = deps.infoWithTags(usable.deviceId)
    if (!canUseDevice(actor, owner.ownerId)) {
      results.push({ deviceId: usable.deviceId, status: 'forbidden', code: 'auth.forbidden', message: 'you may not act on this device' })
      continue
    }
    const evaluated = evaluateDevice(deps, request.verb, usable.deviceId, request.force)
    if (evaluated) {
      results.push(evaluated)
      continue
    }
    candidates.push(usable.deviceId)
  }
  for (const deviceId of candidates) results.push({ deviceId, status: 'accepted' })

  const activityActor = activityActorOf(deps, actor)
  const op = deps.operations.create({ verb: request.verb, target: request.target, createdBy: actor.id, results })
  const settle = (deviceId: string, patch: Omit<ActionResult, 'deviceId'>) => deps.operations.settle(op.operationId, deviceId, patch)

  // `run-script` and `set-group` dispatch once, for every candidate together.
  if (request.verb === 'run-script' && candidates.length > 0) {
    const { results: rsResults } = runScriptOnTargets(deps.batchesFor(actor), deps.resolveScriptRef, candidates, {
      ...(request.scriptId ? { scriptId: request.scriptId } : {}),
      ...(request.scriptRef ? { scriptRef: request.scriptRef } : {}),
      params: request.params,
      concurrency: request.concurrency,
      order: request.order,
      ...(request.priority !== undefined ? { priority: request.priority } : {}),
      ...(request.runtimeOverride !== undefined ? { runtimeOverride: request.runtimeOverride } : {}),
      ...(request.pacing ? { pacing: request.pacing } : {}),
      createdBy: actor.id,
    })
    for (const r of rsResults) {
      settle(r.deviceId, {
        status: r.status,
        ...(r.message ? { message: r.message } : {}),
        ...(r.jobId ? { jobId: r.jobId } : {}),
        ...(r.batchId ? { batchId: r.batchId } : {}),
      })
    }
    return deps.operations.get(op.operationId)!
  }

  if (request.verb === 'run-workflow' && candidates.length > 0) {
    const workflowDoc = deps.workflows.snapshotForJob(request.workflowName)
    const batchDeps = deps.batchesFor(actor)
    const { batch, jobs: memberJobs } = createWorkflowBatch(batchDeps, {
      workflowName: request.workflowName,
      workflowDoc,
      params: request.params,
      target: { deviceIds: candidates },
      concurrency: 0,
      order: 'as-listed',
      createdBy: actor.id,
    } satisfies CreateWorkflowBatchInput)
    const jobByDevice = new Map(memberJobs.map((j) => [j.deviceId, j]))
    for (const deviceId of candidates) {
      const job = jobByDevice.get(deviceId)
      settle(deviceId, job ? { status: 'done', jobId: job.id, batchId: batch.id, runId: job.latestRunId ?? undefined } : { status: 'skipped', message: 'not dispatched', batchId: batch.id })
    }
    return deps.operations.get(op.operationId)!
  }

  if (request.verb === 'set-group' && candidates.length > 0) {
    const moves = setGroup(deps.db, candidates, request.groupId)
    deps.audit.record({ userId: actor.id, action: request.groupId === null ? 'group.unassign' : 'group.assign', meta: { groupId: request.groupId, deviceIds: candidates } })
    for (const deviceId of candidates) {
      settle(deviceId, { status: 'done', detail: { movedFrom: moves.get(deviceId)?.from ?? null } })
    }
    return deps.operations.get(op.operationId)!
  }

  if (spec.mode === 'sync') {
    for (const deviceId of candidates) {
      try {
        const detail = await dispatchSyncVerb(deps, request, deviceId, actor)
        settle(deviceId, { status: 'done', detail })
      } catch (err) {
        settle(deviceId, failedStatusOf(err))
      }
    }
  } else {
    void dispatchBounded(candidates, ACTION_FANOUT_CONCURRENCY, async (deviceId) => {
      try {
        const { detail, activityId } = await dispatchAsyncVerb(deps, request, deviceId, op.operationId, activityActor)
        settle(deviceId, { status: 'done', detail, ...(activityId ? { activityId } : {}) })
      } catch (err) {
        settle(deviceId, failedStatusOf(err))
      }
    })
  }

  return deps.operations.get(op.operationId)!
}

async function dispatchSyncVerb(deps: ActionsDeps, request: ActionRequest, deviceId: string, actor: ActionActor): Promise<unknown> {
  switch (request.verb) {
    case 'wake':
      return setReadiness(requireDep(deps.readiness, 'wake'), deviceId, 'awake', { userId: actor.id })
    case 'sleep':
      return setReadiness(requireDep(deps.readiness, 'sleep'), deviceId, 'asleep', { userId: actor.id })
    case 'reconnect':
      return reconnectDevice(requireDep(deps.reconnector(), 'reconnect'), deviceId, { ...(request.allowSweep !== undefined ? { allowSweep: request.allowSweep } : {}) })
    case 'disconnect': {
      // `request.force` has to reach `disconnectDevice`'s own internal
      // job-running check here: `disconnect`'s `policyKind` is `null` (VERBS
      // table), so the outer `evaluateDevice` warn/force layer never runs for
      // it — this IS the only door `force: true` has, the same as the old
      // `POST /:id/connection/disconnect { force }` route it replaces.
      // Dropping it silently made "disconnect anyway" unreachable through
      // this verb (discovered while wiring `DisconnectDeviceDialog.tsx`'s
      // own force checkbox, plan 207 §4.9).
      const outcome = await disconnectDevice(
        { db: deps.db, activities: deps.activities, reconnector: requireDep(deps.reconnector(), 'disconnect'), sessions: deps.sessions() },
        deviceId,
        { force: request.force },
      )
      if (outcome.status === 'warned') throw new EnkakuError(E_DEVICE_CONFLICT, outcome.message)
      if (outcome.status === 'failed') throw new EnkakuError('E_TRANSPORT_NOT_DETACHABLE', outcome.message)
      return outcome.outcome
    }
    case 'cutover': {
      if (request.op === 'cancel') return cutoverCancel(requireDep(deps.cutover(), 'cutover'), deviceId)
      const outcome = await cutoverStart(
        { db: deps.db, activities: deps.activities, cutover: requireDep(deps.cutover(), 'cutover'), networks: deps.networks },
        deviceId,
        { medium: request.medium!, ...(request.port !== undefined ? { port: request.port } : {}), ...(request.address !== undefined ? { address: request.address } : {}) },
      )
      if (outcome.status === 'forbidden') throw new EnkakuError(E_DEVICE_CONFLICT, outcome.message)
      if (outcome.status === 'failed') throw new EnkakuError('E_ALREADY_ON_NETWORK', outcome.message)
      return outcome.state
    }
    case 'forget':
      return forgetDevice(deps.lifecycle, deviceId, { deleteHistory: request.deleteHistory, actor: { userId: actor.id } })
    case 'block':
      return blockDevice(deps.lifecycle, deviceId, { ...(request.reason ? { reason: request.reason } : {}), actor: { userId: actor.id } })
    case 'unquarantine': {
      const ok = unquarantineDevice(deps.battery(), deviceId)
      if (!ok) throw new EnkakuError('not_quarantined', 'not quarantined')
      return { unquarantined: true }
    }
    case 'set-label':
      return setLabel(requireDep(deps.labelling, 'set-label'), deviceId, { userId: actor.id })
    case 'clear-label':
      return clearLabel(requireDep(deps.labelling, 'clear-label'), deviceId, { restoreOriginal: request.restoreOriginal, actor: { userId: actor.id } })
    case 'set-tags':
      return setTags(deps.db, deviceId, request.tags)
    case 'reprofile': {
      const sessionsApi = deps.sessions()
      const s = sessionsApi?.get(deviceId)
      if (!s) return { restarted: false }
      await sessionsApi?.restartAt?.(deviceId, s.quality, 'applying new video settings')
      return { restarted: true }
    }
    case 'settings': {
      const rawPatch = request.settings as unknown as Record<string, unknown>
      return applySettings(
        {
          db: deps.db,
          record: deps.record,
          runningJobOf: (id) => deps.activities.list(id).some((a) => a.kind === 'job' || a.kind === 'workflow-job' || a.kind === 'install'),
          sessions: deps.sessions,
        },
        deviceId,
        rawPatch,
        request.settings as unknown as DeviceSettingsPatch,
        actor.id,
      )
    }
    default:
      throw new EnkakuError('E_UNKNOWN_VERB', `${request.verb} is not a sync verb`)
  }
}

async function dispatchAsyncVerb(
  deps: ActionsDeps,
  request: ActionRequest,
  deviceId: string,
  operationId: string,
  activityActor: ActivityActor,
): Promise<{ detail: unknown; activityId?: string }> {
  switch (request.verb) {
    case 'install': {
      const transferId = crypto.randomUUID()
      const detail = await installOnDevice(deps.transfer, deviceId, transferId, {
        artifactId: request.artifactId,
        ...(request.reinstall !== undefined ? { reinstall: request.reinstall } : {}),
        ...(request.grantPermissions !== undefined ? { grantPermissions: request.grantPermissions } : {}),
        ...(request.allowDowngrade !== undefined ? { allowDowngrade: request.allowDowngrade } : {}),
      })
      return { detail, activityId: `transfer:${transferId}` }
    }
    case 'push': {
      const transferId = crypto.randomUUID()
      const detail = await pushToDevice(deps.transfer, deviceId, transferId, { artifactId: request.artifactId, remotePath: request.remotePath, mediaScan: request.mediaScan })
      return { detail, activityId: `transfer:${transferId}` }
    }
    case 'pull': {
      const transferId = crypto.randomUUID()
      const detail = await pullFromDevice(deps.transfer, deviceId, transferId, { remotePath: request.remotePath })
      return { detail, activityId: `transfer:${transferId}` }
    }
    case 'adb': {
      const detail = await runShellCommand(
        { activities: deps.activities, shellPortFor: deps.shellPortFor, record: deps.record },
        deviceId,
        operationId,
        request.cmd,
        { timeoutMs: deps.shellSettings().execTimeoutMs, maxOutputBytes: deps.shellSettings().maxOutputBytes, actor: activityActor },
      )
      return { detail, activityId: `command:${operationId}:${deviceId}` }
    }
    case 'clear-cache': {
      const cmd = `cmd package clear --cache-only ${request.package}`
      const detail = await runShellCommand(
        { activities: deps.activities, shellPortFor: deps.shellPortFor, record: deps.record },
        deviceId,
        operationId,
        cmd,
        { timeoutMs: deps.shellSettings().execTimeoutMs, maxOutputBytes: deps.shellSettings().maxOutputBytes, actor: activityActor },
      )
      if (detail.exitCode !== 0) throw new EnkakuError('E_CLEAR_CACHE_FAILED', detail.stderr || 'clear-cache failed')
      return { detail, activityId: `command:${operationId}:${deviceId}` }
    }
    case 'set-network': {
      const routeService = requireDep(deps.routeService(), 'set-network')
      const detail = await applyNetworkAction(routeService, deviceId, request.op, activityActor.id, request.op === 'set' ? request.route : undefined)
      return { detail }
    }
    case 'prepare':
      return { detail: await prepareDevice(deps.preparation, deviceId, { force: request.forceRecheck }) }
    case 'retry-prepare':
      return { detail: await retryPrepareComponent(deps.preparation, deviceId, request.component) }
    case 'screenshot':
      return { detail: await screenshotDevice({ db: deps.db, dataDir: deps.dataDir, screenshot: deps.screenshot }, deviceId) }
    default:
      throw new EnkakuError('E_UNKNOWN_VERB', `${request.verb} is not an async verb`)
  }
}
