import { Hono } from 'hono'
import { z } from 'zod'
import {
  COMMAND_RUN_STATUSES,
  CommandRunActionResponseSchema,
  CommandRunCreateResponseSchema,
  CommandRunDeleteResponseSchema,
  CommandRunDetailResponseSchema,
  CommandRunStatusSchema,
  CommandRunsPageResponseSchema,
  CommandTargetSchema,
  isHighConsequence,
  type CommandCounts,
  type CommandMember,
  type CommandMemberStatus,
  type CommandOutput,
  type CommandRunStatus,
  type CommandRunSummary,
  type CommandTarget,
  type FarmSettings,
} from '@enkaku/protocol'
import { canUseDevice, canUseShell } from '../auth/acl'
import type { AuthEnv } from '../auth/middleware'
import type { Role } from '../auth/service'
import type { CommandRunner } from '../command-console/runner'
import { resolveCommandTarget } from '../command-console/runner'
import type { CommandRunInfo, CommandRunStore } from '../command-console/store'
import type { Db } from '../db'
import { EnkakuError } from '../util/errors'
import { parsePageQuery } from './pagination'
import { typedJson } from './typed-json'

/**
 * `POST/GET/DELETE /api/command-runs`, saved-command-less REST surface for
 * the fleet command console (plan 93 §3.8, §3.14, §3.17, §4.4, step 93.4).
 *
 * **The gate order is §3.8's, evaluated HERE — not solely inside
 * `commandRunner.start()`.** `runner.ts`'s own doc comment on `start()`
 * calls its four checks "defense in depth alongside whatever 93.4's REST
 * route adds" — this file is that addition: it runs the identical gate
 * sequence (`canUseShell` → `shell.fanoutEnabled` → resolve target →
 * `fanoutMaxDevices` → §3.14's acknowledgement → `canUseDevice` per target)
 * BEFORE calling `runner.start()` at all, so nothing is written to the
 * database — not even the run row — until every gate has passed. Calling
 * `start()` afterward re-checks the first four for real (defense in depth,
 * never trust-then-verify-once); this file is the ONLY place that can add
 * the fifth (§3.14's acknowledgement), which `runner.ts` deliberately does
 * not enforce (see that file's own comment on why).
 */

const CreateBody = z.object({
  cmd: z.string().min(1).max(4096),
  target: CommandTargetSchema,
  /**
   * The requesting browser tab's WS session id — same pattern and reasoning
   * as `api/transfer.ts`'s `InstallBody.clientId` (plan 93 §3.17): a control
   * marker's actor IS a WS `clientId`, and HTTP has no native notion of one.
   */
  clientId: z.string().min(1),
  stageFirstN: z.number().int().min(0).optional(),
  concurrency: z.number().int().min(0).optional(),
  /**
   * §3.14's server-side acknowledgement — NOT a security control (any client
   * can send this field; see `isHighConsequence`'s own doc comment and
   * `runner.ts`'s audit call). What it buys: when the shared guard matches
   * AND the target is more than one device, this is required, and its
   * presence (or absence) is recorded on the run and in the audit row, so
   * "twenty phones were rebooted and somebody meant it" is a fact on the
   * record rather than a reconstruction.
   */
  acknowledge: z.object({ highConsequence: z.boolean() }).optional(),
  savedCommandId: z.string().min(1).optional(),
})

const RerunBody = z.object({
  clientId: z.string().min(1),
  acknowledge: z.object({ highConsequence: z.boolean() }).optional(),
})

const ERROR_STATUS: Record<string, number> = {
  'auth.forbidden': 403,
  E_FANOUT_DISABLED: 403,
  E_NO_TARGETS: 409,
  E_TOO_MANY_TARGETS: 400,
  E_ACK_REQUIRED: 409,
  E_BAD_REQUEST: 400,
  run_not_found: 404,
  run_not_awaiting_continue: 409,
  command_run_member_not_found: 404,
  cluster_not_found: 404,
  E_DB: 500,
}

export interface CommandRunRoutesDeps {
  db: Db
  store: CommandRunStore
  runner: Pick<CommandRunner, 'start' | 'cancel' | 'continueRun'>
  settings: () => FarmSettings['shell']
  roleOf: (userId: string | null) => Role
  getDeviceOwner: (deviceId: string) => { ownerId: string | null } | null
}

interface Actor {
  userId: string | null
  role: Role
}

function tally(members: { status: CommandMemberStatus }[]): CommandCounts {
  const counts: CommandCounts = { total: members.length, pending: 0, running: 0, ok: 0, failed: 0, skipped: 0, cancelled: 0 }
  for (const m of members) counts[m.status] += 1
  return counts
}

function toSummary(run: CommandRunInfo): CommandRunSummary {
  return {
    id: run.id,
    cmd: run.cmd,
    target: run.target,
    savedCommandId: run.savedCommandId,
    stageFirstN: run.stageFirstN,
    stage: run.stage,
    concurrency: run.concurrency,
    status: run.status,
    acknowledged: run.acknowledged,
    createdBy: run.createdBy,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    counts: tally(run.members),
  }
}

function toWireMember(m: CommandRunInfo['members'][number]): CommandMember {
  return {
    deviceId: m.deviceId,
    seq: m.seq,
    stageIndex: m.stageIndex,
    status: m.status,
    exitCode: m.exitCode,
    durationMs: m.durationMs,
    outputHash: m.outputHash,
    truncated: m.truncated,
    skip: m.skip,
    error: m.error,
  }
}

/** One entry per DISTINCT output hash, first-seen order (§3.6) — the same grouping key the live `command.output` WS event uses. */
function distinctOutputs(run: CommandRunInfo, previewBytes: number): CommandOutput[] {
  const seen = new Set<string>()
  const outputs: CommandOutput[] = []
  for (const m of run.members) {
    if (!m.outputHash || seen.has(m.outputHash)) continue
    seen.add(m.outputHash)
    const stdout = m.stdout ?? ''
    const stderr = m.stderr ?? ''
    const stdoutPreview = stdout.slice(0, previewBytes)
    const stderrPreview = stderr.slice(0, previewBytes)
    outputs.push({
      hash: m.outputHash,
      stdoutPreview,
      stderrPreview,
      previewTruncated: stdoutPreview.length < stdout.length || stderrPreview.length < stderr.length,
    })
  }
  return outputs
}

/**
 * Everything a run needs to START (plan 93 §3.8, §3.14) — shared by
 * `POST /api/command-runs` and `POST /:id/rerun`, so the two never drift
 * into two different gate sequences.
 */
async function createRun(
  deps: CommandRunRoutesDeps,
  actor: Actor,
  input: {
    cmd: string
    target: CommandTarget
    clientId: string
    stageFirstN?: number
    concurrency?: number
    acknowledge?: { highConsequence: boolean }
    savedCommandId?: string | null
  },
): Promise<{ run: CommandRunSummary; members: CommandMember[]; skipped: { deviceId: string; reason: string }[] }> {
  const settings = deps.settings()

  // §3.8, gate 1: role + the farm-wide `shell.mode` switch. Identical to
  // the terminal's own gate (F18) — fan-out is authorised exactly as
  // strictly as the terminal it extends, plus its own opt-in below.
  if (!canUseShell(actor.role, settings.mode)) {
    throw new EnkakuError('auth.forbidden', 'shell access is turned off for this farm')
  }
  // §3.8, gate 2: the SEPARATE fan-out opt-in (F25's `endpointEnabled`
  // precedent) — running one gated shell and running a hundred at once are
  // different decisions.
  if (!settings.fanoutEnabled) {
    throw new EnkakuError('E_FANOUT_DISABLED', 'fleet commands are turned off for this farm')
  }

  const resolved = resolveCommandTarget(deps.db, input.target)
  if (resolved.usable.length === 0) {
    throw new EnkakuError(
      'E_NO_TARGETS',
      resolved.skipped.length > 0
        ? `no usable devices — every match was unavailable: ${resolved.skipped.map((s) => `${s.deviceId} (${s.reason})`).join(', ')}`
        : 'no devices matched this target',
    )
  }
  // §3.8, gate 3: a farm may cap the blast radius outright.
  if (settings.fanoutMaxDevices > 0 && resolved.usable.length > settings.fanoutMaxDevices) {
    throw new EnkakuError(
      'E_TOO_MANY_TARGETS',
      `this command would target ${resolved.usable.length} devices, above the farm's limit of ${settings.fanoutMaxDevices}`,
    )
  }

  // §3.14 — a SCALE confirmation, not a security control: `pm clear` on one
  // device is the operator's own business; on fifty it is worth making them
  // say so. Evaluated only above one device, matching the terminal's own
  // client-side dialog (which never fires for N = 1 either).
  const highConsequence = isHighConsequence(input.cmd)
  const acknowledged = input.acknowledge?.highConsequence === true
  if (highConsequence.hit && resolved.usable.length > 1 && !acknowledged) {
    throw new EnkakuError(
      'E_ACK_REQUIRED',
      `"${input.cmd}" matches a high-consequence pattern (${highConsequence.pattern}) and would run on ${resolved.usable.length} devices — resend with acknowledge: { highConsequence: true } to proceed`,
    )
  }

  // §3.8, gate 4: device ownership, per resolved target — refused for the
  // WHOLE run before any member row exists, matching `createBatch`'s own
  // `assertDeviceAllowed` (plan 20/34) and the identical check
  // `runner.start()` re-does below.
  for (const t of resolved.usable) {
    const owner = deps.getDeviceOwner(t.deviceId)
    if (owner && !canUseDevice({ id: actor.userId ?? '', role: actor.role }, owner)) {
      throw new EnkakuError('auth.forbidden', `you do not have access to device ${t.deviceId}`)
    }
  }

  const { run, members } = await deps.runner.start({
    cmd: input.cmd,
    target: input.target,
    clientId: input.clientId,
    createdBy: actor.userId,
    ...(input.stageFirstN !== undefined ? { stageFirstN: input.stageFirstN } : {}),
    ...(input.concurrency !== undefined ? { concurrency: input.concurrency } : {}),
    acknowledged,
    savedCommandId: input.savedCommandId ?? null,
  })

  return { run, members, skipped: resolved.skipped }
}

export function createCommandRunRoutes(deps: CommandRunRoutesDeps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>()

  const mustGet = (id: string): CommandRunInfo => {
    const run = deps.store.get(id)
    if (!run) throw new EnkakuError('run_not_found', `no such command run: ${id}`)
    return run
  }

  const actorOf = (userId: string | null): Actor => ({ userId, role: deps.roleOf(userId) })

  /**
   * `GET`/output visibility (plan 93 §3.9): admins see every run; the
   * creator always sees their own; an operator otherwise sees a run only
   * when they could use at least one of its targeted devices — the same
   * per-device visibility `device_events` already gives, not a cross-user
   * leak of a run over devices entirely someone else's.
   */
  const canView = (actor: Actor, run: CommandRunInfo): boolean => {
    if (actor.role === 'admin') return true
    if (run.createdBy === actor.userId) return true
    return run.members.some((m) => {
      const owner = deps.getDeviceOwner(m.deviceId)
      return !owner || canUseDevice({ id: actor.userId ?? '', role: actor.role }, owner)
    })
  }

  const isOwnerOrAdmin = (actor: Actor, run: CommandRunInfo): boolean => actor.role === 'admin' || run.createdBy === actor.userId

  app.post('/', async (c) => {
    const body = CreateBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) {
      throw new EnkakuError('E_BAD_REQUEST', body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
    }
    const actor = actorOf(c.get('user')?.id ?? null)
    const { run, members, skipped } = await createRun(deps, actor, body.data)
    return typedJson(c, CommandRunCreateResponseSchema, { run, members, skipped }, 201)
  })

  app.get('/', (c) => {
    const { cursor, limit } = parsePageQuery(c)
    const actor = actorOf(c.get('user')?.id ?? null)
    const mine = c.req.query('mine') === '1'
    const deviceId = c.req.query('deviceId') || null
    const q = c.req.query('q') || null
    const statusRaw = c.req.query('status')
    let status: CommandRunStatus | null = null
    if (statusRaw) {
      const parsed = CommandRunStatusSchema.safeParse(statusRaw)
      if (!parsed.success) throw new EnkakuError('E_BAD_REQUEST', `'status' must be one of ${COMMAND_RUN_STATUSES.join(', ')}`)
      status = parsed.data
    }
    // Plan 93 §3.9: everyone's history is visible to admins; an operator
    // sees their own regardless of `?mine=1` — a conservative reading of
    // "operators only for devices they can use" (a run can target devices
    // with different owners, and command output can contain anything a
    // device printed) until a per-device-ownership join across
    // `command_run_members` is worth building on its own evidence.
    const createdBy = actor.role === 'admin' && !mine ? null : actor.userId
    const page = deps.store.listPage({ createdBy, deviceId, q, status, cursor, limit })
    return typedJson(c, CommandRunsPageResponseSchema, page)
  })

  app.get('/:id', (c) => {
    const run = mustGet(c.req.param('id'))
    const actor = actorOf(c.get('user')?.id ?? null)
    if (!canView(actor, run)) throw new EnkakuError('auth.forbidden', 'you do not have access to this command run')
    const previewBytes = deps.settings().fanoutPreviewBytes
    return typedJson(c, CommandRunDetailResponseSchema, {
      run: { ...toSummary(run), members: run.members.map(toWireMember), outputs: distinctOutputs(run, previewBytes) },
    })
  })

  // Full retained output, `text/plain` — NEVER over the WebSocket (§3.6).
  // `?stream=stderr` selects the other stream; default is stdout.
  app.get('/:id/members/:deviceId/output', (c) => {
    const run = mustGet(c.req.param('id'))
    const actor = actorOf(c.get('user')?.id ?? null)
    if (!canView(actor, run)) throw new EnkakuError('auth.forbidden', 'you do not have access to this command run')
    const deviceId = c.req.param('deviceId')
    const member = run.members.find((m) => m.deviceId === deviceId)
    if (!member) throw new EnkakuError('command_run_member_not_found', `no member ${deviceId} on run ${run.id}`)
    const wantsStderr = c.req.query('stream') === 'stderr'
    return c.text(wantsStderr ? (member.stderr ?? '') : (member.stdout ?? ''))
  })

  app.post('/:id/cancel', (c) => {
    const run = mustGet(c.req.param('id'))
    const actor = actorOf(c.get('user')?.id ?? null)
    if (!isOwnerOrAdmin(actor, run)) throw new EnkakuError('auth.forbidden', "only this run's own creator or an admin may cancel it")
    deps.runner.cancel(run.id, actor.userId)
    const updated = deps.store.get(run.id) ?? run
    return typedJson(c, CommandRunActionResponseSchema, { run: toSummary(updated) })
  })

  app.post('/:id/continue', (c) => {
    const run = mustGet(c.req.param('id'))
    const actor = actorOf(c.get('user')?.id ?? null)
    if (!isOwnerOrAdmin(actor, run)) throw new EnkakuError('auth.forbidden', "only this run's own creator or an admin may continue it")
    deps.runner.continueRun(run.id, actor.userId)
    const updated = deps.store.get(run.id) ?? run
    return typedJson(c, CommandRunActionResponseSchema, { run: toSummary(updated) })
  })

  // A NEW run over a subset of a previous one's members (§4.4) — same gate
  // sequence as `POST /`, via the shared `createRun` above.
  app.post('/:id/rerun', async (c) => {
    const run = mustGet(c.req.param('id'))
    const only = c.req.query('only') ?? 'all'
    if (only !== 'failed' && only !== 'skipped' && only !== 'all') {
      throw new EnkakuError('E_BAD_REQUEST', "'only' must be one of failed, skipped, all")
    }
    const body = RerunBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw new EnkakuError('E_BAD_REQUEST', 'a body of { clientId } is required')
    const subset = only === 'all' ? run.members : run.members.filter((m) => m.status === only)
    const deviceIds = subset.map((m) => m.deviceId)
    if (deviceIds.length === 0) throw new EnkakuError('E_NO_TARGETS', `this run has no ${only} members to re-run`)
    const actor = actorOf(c.get('user')?.id ?? null)
    const { run: newRun, members, skipped } = await createRun(deps, actor, {
      cmd: run.cmd,
      target: { deviceIds },
      clientId: body.data.clientId,
      ...(body.data.acknowledge !== undefined ? { acknowledge: body.data.acknowledge } : {}),
      savedCommandId: run.savedCommandId,
    })
    return typedJson(c, CommandRunCreateResponseSchema, { run: newRun, members, skipped }, 201)
  })

  app.delete('/:id', (c) => {
    const run = mustGet(c.req.param('id'))
    const actor = actorOf(c.get('user')?.id ?? null)
    if (!isOwnerOrAdmin(actor, run)) throw new EnkakuError('auth.forbidden', "only this run's own creator or an admin may delete it")
    const deleted = deps.store.deleteRun(run.id)
    return typedJson(c, CommandRunDeleteResponseSchema, { deleted })
  })

  app.onError((err, c) => {
    if (err instanceof EnkakuError) return c.json(err.toJSON(), (ERROR_STATUS[err.code] ?? 500) as 400)
    throw err
  })

  return app
}
