import { eq } from 'drizzle-orm'
import { isHighConsequence, type CommandMember, type CommandOutput, type FarmSettings, type ServerMessage } from '@enkaku/protocol'
import type { Db } from '../db'
import { clusters } from '../db/schema'
import { canUseDevice, canUseShell } from '../auth/acl'
import type { AuditLogger } from '../auth/audit'
import type { Role } from '../auth/service'
import { resolveCluster, resolveTarget, type ResolvedCluster } from '../clusters/resolve'
import { redactShellCommand } from '../device/redact'
import type { ShellPort } from '../device/shell-port'
import type { EventRecorder } from '../events/recorder'
import type { Lease, LeaseManager } from '../lease/lease-manager'
import { EnkakuError } from '../util/errors'
import type { Logger } from '../util/logger'
import {
  type CommandCounts,
  type CommandMemberStatus,
  type CommandRunInfo,
  type CommandRunMemberInfo,
  type CommandRunStatus,
  type CommandRunStore,
  type CommandRunSummary,
  type CommandTarget,
} from './store'

/**
 * The command console's runner (plan 93 §3.5, §3.6, §3.7, §3.8, §4.5, step
 * 93.3) — target resolution, the per-member lease policy, the worker pool,
 * the 250 ms progress coalescer, the output hash, cancellation, staged
 * rollout, and the boot orphan sweep.
 *
 * **Naming note** (§4.5's own warning, carried over verbatim): no identifier
 * in this file may be named `console` — it shadows the global.
 *
 * **Step 93.4 reconciliation.** Wire event types used to be declared LOCALLY
 * here — `CommandMember`/`CommandOutput`/`CommandRunnerEvent` — because
 * `packages/protocol/src/command/` was off limits to step 93.3. That
 * directory (plus `packages/protocol/src/messages/command.ts`) now holds the
 * real copy; `CommandMember`/`CommandOutput` are imported from
 * `@enkaku/protocol` (and re-exported below so nothing importing them from
 * THIS file needs to change), and `CommandRunnerEvent` is now the exact
 * `command.*` slice of the real `ServerMessage` union rather than a
 * hand-rolled mirror of it — so this file and the wire schema cannot drift
 * apart silently.
 */
export type { CommandMember, CommandOutput }

/** A worker pool never holds more than this many members in flight at once, whatever `shell.fanoutConcurrency` says (plan 93 §3.5) — so a 1000-device run cannot pin 1000 pending awaits. */
const MAX_POOL_CONCURRENCY = 32

const TERMINAL_MEMBER_STATUSES: ReadonlySet<CommandMemberStatus> = new Set(['ok', 'failed', 'skipped', 'cancelled'])

/** §4.3's server → client `command.*` union — the exact slice of the real `ServerMessage` union, never a hand-rolled mirror of it (step 93.4). */
export type CommandRunnerEvent = Extract<ServerMessage, { type: `command.${string}` }>

export interface StartCommandRunInput {
  cmd: string
  target: CommandTarget
  /**
   * The WS `clientId` whose lease conventions apply for the idle-device
   * auto-acquire branch (§3.8) — HTTP has no native notion of a session, so
   * the caller supplies it, the same precedent `api/transfer.ts` and
   * `api/adb-endpoint.ts` already set (§3.17).
   */
  clientId: string
  createdBy: string | null
  stageFirstN?: number
  concurrency?: number
  acknowledged?: boolean
  savedCommandId?: string | null
}

export interface CommandRunnerDeps {
  db: Db
  store: CommandRunStore
  leases: LeaseManager
  shellPortFor: (deviceId: string) => ShellPort
  /** `clusters/resolve.ts`, reused (§3.2, §4.5) — resolves any `CommandTarget` shape. `resolveCommandTarget` below is the implementation; wired here so a fake can bypass the DB in a test. */
  resolve: (target: CommandTarget) => ResolvedCluster
  settings: () => FarmSettings['shell']
  /** The `device_events` audit — unchanged, the SAME row `shell.exec` already writes (§3.17, §4.5 step "echo"). */
  recorder: EventRecorder['record']
  audit: AuditLogger
  /** To subscribers of THIS run only — no subscriber registry exists yet (step 93.4 wires `command.subscribe`), so a host with nothing listening may safely no-op or log this. */
  broadcast: (runId: string, msg: CommandRunnerEvent) => void
  roleOf: (userId: string | null) => Role
  getDevice: (deviceId: string) => { ownerId: string | null } | null
  log: Logger
}

/**
 * `GET /api/adb/stats`'s `commandConsole` block (plan 93 §5 step 93.12,
 * H1/H2/H4) — see `AdbStatsResponseSchema`'s own doc comment in
 * `@enkaku/protocol` for the wire shape and field-by-field reasoning. This
 * is that same shape, computed here rather than duplicated.
 */
export interface CommandConsoleStats {
  runsInFlight: number
  membersInFlight: number
  coalescedFramesPerSec: number
  distinctOutputRatio: number
  leaseChangedPerMinute: number
}

export interface CommandRunner {
  start(input: StartCommandRunInput): Promise<{ run: CommandRunSummary; members: CommandMember[] }>
  cancel(runId: string, actor: string | null): void
  continueRun(runId: string, actor: string | null): void
  /** Boot sweep: every non-terminal run becomes `cancelled` (§3.7, mirroring `failOrphanRunning`). Returns the number of runs swept. */
  sweepOrphans(): number
  /** Every process this thing started is dead once this returns (`00-overview.md` §7): every active run's pending members are cancelled, in-flight execs are aborted, every timer is cleared. */
  stop(): void
  /** §5 step 93.12's measurement surface — see `CommandConsoleStats`'s own doc comment. Read-only; nothing here is persisted. */
  stats(): CommandConsoleStats
}

/**
 * Resolve any `CommandTarget` shape (§4.3's union) into a `ResolvedCluster` —
 * the one adapter between the console's three-shape target and `clusters/resolve.ts`'s
 * two entry points (§3.2, §4.5's `resolve` dep). A `clusterId` that no longer
 * exists throws `cluster_not_found`, the exact code `createBatch` already
 * uses for the same failure (`clusters/dispatch.ts`).
 */
export function resolveCommandTarget(db: Db, target: CommandTarget): ResolvedCluster {
  if ('clusterId' in target) {
    const cluster = db.select().from(clusters).where(eq(clusters.id, target.clusterId)).get()
    if (!cluster) throw new EnkakuError('cluster_not_found', `no such cluster: ${target.clusterId}`)
    return resolveCluster(db, cluster)
  }
  if ('deviceIds' in target) {
    return resolveTarget(db, { tags: [], deviceIds: target.deviceIds })
  }
  return resolveTarget(db, { tags: target.tags, deviceIds: [] })
}

/**
 * `admitMember` — the three-branch lease policy §3.8 specifies verbatim,
 * exported standalone so it is unit-testable without the worker pool around
 * it. Never touches the store; the caller decides what to do with the result.
 */
export type AdmitResult = { ok: true; acquiredHere: boolean } | { ok: false; code: string; message: string }

export function admitMember(leases: LeaseManager, deviceId: string, clientId: string, userId: string | null): AdmitResult {
  const allowed = leases.checkInputAllowed(deviceId, clientId)
  if (allowed.ok) {
    // The operator already holds this device — run immediately, hold nothing
    // new, release nothing when done (§3.8, verifiable result #1).
    return { ok: true, acquiredHere: false }
  }
  if (allowed.code === 'no_lease') {
    // Idle: `acquireManual` succeeds outright (F19) — briefly, genuinely held
    // by the run for the duration of one command, released in the caller's
    // `finally` (§3.8, verifiable result #2).
    try {
      leases.acquireManual(deviceId, clientId, userId, { purpose: 'command' })
      return { ok: true, acquiredHere: true }
    } catch (err) {
      // Defensive only: `no_lease` is returned for an idle device, and
      // `acquireManual` succeeds outright on idle (F19). A concurrent
      // acquire by someone else between the check and this call, or a
      // `checkInputAllowed`/`acquireManual` disagreement, is the only way
      // this throws — reported as skipped, not crashed.
      const e = err instanceof EnkakuError ? err : null
      return { ok: false, code: e?.code ?? 'E_LEASE', message: e?.message ?? String(err) }
    }
  }
  // `not_lease_holder`, `device_busy`, `device_unavailable`, `device_not_found`
  // — verbatim, never paraphrased (§3.8, verifiable results #3/#4).
  return { ok: false, code: allowed.code, message: allowed.message }
}

function tally(members: CommandRunMemberInfo[]): CommandCounts {
  const counts: CommandCounts = { total: members.length, pending: 0, running: 0, ok: 0, failed: 0, skipped: 0, cancelled: 0 }
  for (const m of members) counts[m.status] += 1
  return counts
}

function toWireMember(m: CommandRunMemberInfo): CommandMember {
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

function toSummary(info: CommandRunInfo, counts: CommandCounts): CommandRunSummary {
  return {
    id: info.id,
    cmd: info.cmd,
    target: info.target,
    savedCommandId: info.savedCommandId,
    stageFirstN: info.stageFirstN,
    stage: info.stage,
    concurrency: info.concurrency,
    status: info.status,
    acknowledged: info.acknowledged,
    createdBy: info.createdBy,
    startedAt: info.startedAt,
    finishedAt: info.finishedAt,
    counts,
  }
}

/**
 * Run status, recomputed from member counts — never incremented (§3.4),
 * exactly the shape `clusters/status.ts`'s `computeBatchStatus` already uses
 * for batches, adapted for `skipped` as its own first-class outcome (a run
 * that is all `ok`/`skipped` with nothing failed is `ok`, not `failed` —
 * §3.4: "This is a first-class outcome, not an absence.").
 */
export function computeCommandRunStatus(counts: CommandCounts): CommandRunStatus {
  if (counts.total === 0) return 'ok'
  if (counts.pending > 0 || counts.running > 0) return 'running'
  const terminal = counts.ok + counts.failed + counts.skipped + counts.cancelled
  if (terminal !== counts.total) return 'running'
  if (counts.cancelled === counts.total) return 'cancelled'
  if (counts.failed > 0) return 'failed'
  return 'ok'
}

function resolvePoolConcurrency(requested: number, poolSize: number): number {
  const base = requested > 0 ? requested : MAX_POOL_CONCURRENCY
  return Math.max(1, Math.min(base, MAX_POOL_CONCURRENCY, poolSize))
}

interface RunState {
  runId: string
  clientId: string
  createdBy: string | null
  cmd: string
  currentStage: number
  cancelled: boolean
  awaitingContinue: boolean
  /** Guards against writing a member's outcome twice — cancel's forced sweep and the member's own late-arriving completion race each other; whichever gets here first wins, the other is a no-op (§3.7). */
  settled: Set<string>
  /** Only while a member's `exec` is genuinely outstanding — used to abort on cancel (§3.7). */
  inFlight: Map<string, AbortController>
  /** DeviceIds changed since the coalescer's last tick (§3.5). */
  dirty: Set<string>
  seenHashes: Set<string>
  coalesceTimer: ReturnType<typeof setInterval> | null
  stageTimer: ReturnType<typeof setTimeout> | null
  startedAtMs: number
}

/** Trailing window `stats()` rates are computed over (§5 step 93.12) — one minute, matching the wire field names (`...PerMinute`) and long enough that a single quiet moment does not read as zero. */
const STATS_WINDOW_MS = 60_000

/** Drops timestamps older than `STATS_WINDOW_MS`, in place, then returns how many remain — the one function both `coalescedFramesPerSec` and `leaseChangedPerMinute` are built from (§5 step 93.12). */
function pruneAndCount(times: number[], now: number): number {
  const cutoff = now - STATS_WINDOW_MS
  let i = 0
  while (i < times.length && (times[i] as number) < cutoff) i++
  if (i > 0) times.splice(0, i)
  return times.length
}

export function createCommandRunner(deps: CommandRunnerDeps): CommandRunner {
  const { store, leases, log } = deps
  const active = new Map<string, RunState>()
  /** Overridable only for tests — production always uses the spec's 250 ms (§3.5, §4.5). */
  const coalesceIntervalMs = 250

  // §5 step 93.12's measurement state — farm-wide, across every run this
  // runner instance has ever driven, never reset per run (a per-run number
  // would hide exactly the cross-run pattern H1/H4 ask about). Bounded by
  // `STATS_WINDOW_MS`'s own pruning, so none of this grows unbounded.
  const frameTimes: number[] = []
  const leaseChangeTimes: number[] = []
  let outputsSettled = 0
  let outputsDistinct = 0

  function clearCoalescer(state: RunState): void {
    if (state.coalesceTimer) clearInterval(state.coalesceTimer)
    state.coalesceTimer = null
  }

  function clearStageTimer(state: RunState): void {
    if (state.stageTimer) clearTimeout(state.stageTimer)
    state.stageTimer = null
  }

  function flushCoalescer(state: RunState): void {
    if (state.dirty.size === 0) return
    const run = store.get(state.runId)
    if (!run) return
    const changedIds = state.dirty
    state.dirty = new Set()
    const changed = run.members.filter((m) => changedIds.has(m.deviceId)).map(toWireMember)
    const counts = tally(run.members)
    frameTimes.push(Date.now())
    deps.broadcast(state.runId, { type: 'command.progress', payload: { runId: state.runId, counts, changed } })
  }

  function startCoalescer(state: RunState): void {
    clearCoalescer(state)
    state.coalesceTimer = setInterval(() => flushCoalescer(state), coalesceIntervalMs)
  }

  function markDirty(state: RunState, deviceId: string): void {
    state.dirty.add(deviceId)
  }

  function maybeEmitOutput(state: RunState, hash: string | null, stdout: string, stderr: string): void {
    if (!hash || state.seenHashes.has(hash)) return
    state.seenHashes.add(hash)
    outputsDistinct += 1
    const previewBytes = deps.settings().fanoutPreviewBytes
    const stdoutPreview = stdout.slice(0, previewBytes)
    const stderrPreview = stderr.slice(0, previewBytes)
    const previewTruncated = stdoutPreview.length < stdout.length || stderrPreview.length < stderr.length
    deps.broadcast(state.runId, { type: 'command.output', payload: { runId: state.runId, output: { hash, stdoutPreview, stderrPreview, previewTruncated } } })
  }

  function finalizeRun(state: RunState): void {
    // A final flush so the LAST batch of changes is not lost between the
    // coalescer's last tick and `command.finished` (§3.5).
    flushCoalescer(state)
    clearCoalescer(state)
    clearStageTimer(state)
    active.delete(state.runId)
    const run = store.get(state.runId)
    if (!run) return
    const counts = tally(run.members)
    const status = computeCommandRunStatus(counts)
    store.finish(state.runId, { status })
    deps.broadcast(state.runId, { type: 'command.finished', payload: { runId: state.runId, status, counts, durationMs: Date.now() - state.startedAtMs } })
  }

  function enterAwaitingContinue(state: RunState): void {
    flushCoalescer(state)
    clearCoalescer(state)
    state.awaitingContinue = true
    store.setStage(state.runId, { status: 'awaiting-continue', stage: state.currentStage })
    const waitSec = deps.settings().fanoutStageWaitSec
    state.stageTimer = setTimeout(() => {
      state.stageTimer = null
      log.info(`command run ${state.runId}: staged wait timed out — cancelling the remainder`)
      cancel(state.runId, null)
    }, waitSec * 1000)
    deps.broadcast(state.runId, { type: 'command.stage', payload: { runId: state.runId, stage: state.currentStage, of: 2, awaitingContinue: true } })
  }

  /** Called after EVERY member settle — decides whether the current stage (or the whole run) is done (§3.4, §3.7). Recomputed from the store every time, never incremented. */
  function onMemberSettled(state: RunState): void {
    const run = store.get(state.runId)
    if (!run) return
    if (state.cancelled) {
      if (run.members.every((m) => TERMINAL_MEMBER_STATUSES.has(m.status))) finalizeRun(state)
      return
    }
    const activeStageMembers = run.members.filter((m) => m.stageIndex <= state.currentStage)
    const stageDone = activeStageMembers.length > 0 && activeStageMembers.every((m) => TERMINAL_MEMBER_STATUSES.has(m.status))
    if (!stageDone) return
    const hasMoreStages = run.members.some((m) => m.stageIndex > state.currentStage)
    if (hasMoreStages) {
      enterAwaitingContinue(state)
      return
    }
    finalizeRun(state)
  }

  function settleCancelled(state: RunState, deviceId: string): void {
    if (state.settled.has(deviceId)) return
    state.settled.add(deviceId)
    store.updateMember(state.runId, deviceId, { status: 'cancelled', error: 'the run was cancelled — the command may have completed on the device' })
    markDirty(state, deviceId)
  }

  function settleSkipped(state: RunState, deviceId: string, code: string, message: string): void {
    if (state.settled.has(deviceId)) return
    state.settled.add(deviceId)
    store.updateMember(state.runId, deviceId, { status: 'skipped', skipCode: code, skipMessage: message })
    markDirty(state, deviceId)
    onMemberSettled(state)
  }

  function settleFailed(state: RunState, deviceId: string, error: string, durationMs: number): void {
    if (state.settled.has(deviceId)) return
    state.settled.add(deviceId)
    store.updateMember(state.runId, deviceId, { status: 'failed', exitCode: null, durationMs, error })
    markDirty(state, deviceId)
    onMemberSettled(state)
  }

  function settleExecuted(
    state: RunState,
    deviceId: string,
    result: { stdout: string; stderr: string; exitCode: number | null; truncated: boolean },
    durationMs: number,
    outputHash: string,
  ): void {
    if (state.settled.has(deviceId)) return
    state.settled.add(deviceId)
    const status: CommandMemberStatus = result.exitCode === 0 ? 'ok' : 'failed'
    const error = result.exitCode === null ? (result.truncated ? 'output was truncated before a matching exit code arrived' : 'no exit code reported') : null
    store.updateMember(state.runId, deviceId, {
      status,
      exitCode: result.exitCode,
      durationMs,
      stdout: result.stdout,
      stderr: result.stderr,
      truncated: result.truncated,
      outputHash,
      error,
    })
    markDirty(state, deviceId)
    outputsSettled += 1
    maybeEmitOutput(state, outputHash, result.stdout, result.stderr)
    onMemberSettled(state)
  }

  async function runOneMember(state: RunState, deviceId: string): Promise<void> {
    if (state.cancelled) {
      settleCancelled(state, deviceId)
      return
    }
    const admitted = admitMember(leases, deviceId, state.clientId, state.createdBy)
    if (!admitted.ok) {
      settleSkipped(state, deviceId, admitted.code, admitted.message)
      return
    }
    // §5 step 93.12 / H4 — a lease genuinely acquired HERE produces one real
    // `lease.changed` broadcast now (the grant) and another when it is
    // released below (the same two-broadcast shape `onManualRevoked`/
    // `lease.acquire` already produce for any manual hold in production).
    // The already-held branch (`admitted.acquiredHere === false`) acquires
    // nothing and is correctly not counted — H4's own premise.
    if (admitted.acquiredHere) leaseChangeTimes.push(Date.now())
    store.updateMember(state.runId, deviceId, { status: 'running' })
    markDirty(state, deviceId)
    const ac = new AbortController()
    state.inFlight.set(deviceId, ac)
    const startedAt = Date.now()
    const settings = deps.settings()
    try {
      deps.recorder({ deviceId, stream: 'input', kind: 'shell.exec', actor: state.createdBy, meta: { cmd: redactShellCommand(state.cmd), runId: state.runId } })
      const result = await deps.shellPortFor(deviceId).exec(state.cmd, {
        timeoutMs: settings.execTimeoutMs,
        maxOutputBytes: settings.fanoutMaxOutputBytes,
        signal: ac.signal,
      })
      const durationMs = Date.now() - startedAt
      // wyhash over the RETAINED bytes, not the preview (§3.6) — a grouping
      // key, not a security primitive.
      const outputHash = Bun.hash(`${result.exitCode}\0${result.stdout}\0${result.stderr}`).toString()
      deps.recorder({
        deviceId,
        stream: 'input',
        kind: 'shell.result',
        actor: state.createdBy,
        meta: { exitCode: result.exitCode, bytes: result.stdout.length + result.stderr.length, durationMs, runId: state.runId },
      })
      settleExecuted(state, deviceId, result, durationMs, outputHash)
    } catch (err) {
      const durationMs = Date.now() - startedAt
      const message = err instanceof Error ? err.message : String(err)
      settleFailed(state, deviceId, message, durationMs)
    } finally {
      state.inFlight.delete(deviceId)
      if (admitted.acquiredHere) {
        leases.releaseManual(deviceId, state.clientId)
        leaseChangeTimes.push(Date.now())
      }
    }
  }

  async function dispatchPool(state: RunState, deviceIds: string[], concurrency: number): Promise<void> {
    if (deviceIds.length === 0) {
      onMemberSettled(state)
      return
    }
    let idx = 0
    const n = resolvePoolConcurrency(concurrency, deviceIds.length)
    const workers: Promise<void>[] = []
    for (let w = 0; w < n; w++) {
      workers.push(
        (async () => {
          while (idx < deviceIds.length) {
            const deviceId = deviceIds[idx++] as string
            if (state.cancelled) {
              settleCancelled(state, deviceId)
              continue
            }
            await runOneMember(state, deviceId)
          }
        })(),
      )
    }
    await Promise.all(workers)
  }

  function cancel(runId: string, _actor: string | null): void {
    const state = active.get(runId)
    if (!state || state.cancelled) return
    state.cancelled = true
    state.awaitingContinue = false
    for (const ac of state.inFlight.values()) ac.abort()
    const run = store.get(runId)
    if (run) {
      for (const m of run.members) {
        if (!state.settled.has(m.deviceId) && (m.status === 'pending' || m.status === 'running')) {
          settleCancelled(state, m.deviceId)
        }
      }
    }
    clearStageTimer(state)
    finalizeRun(state)
  }

  function continueRun(runId: string, _actor: string | null): void {
    const state = active.get(runId)
    if (!state) throw new EnkakuError('run_not_found', `no such active command run: ${runId}`)
    if (!state.awaitingContinue) throw new EnkakuError('run_not_awaiting_continue', 'this run is not waiting to continue')
    clearStageTimer(state)
    state.awaitingContinue = false
    state.currentStage = 2
    const run = store.get(runId)
    if (!run) throw new EnkakuError('run_not_found', `no such command run: ${runId}`)
    store.setStage(runId, { status: 'running', stage: 2 })
    startCoalescer(state)
    const nextStageDevices = run.members.filter((m) => m.stageIndex === 2).map((m) => m.deviceId)
    void dispatchPool(state, nextStageDevices, run.concurrency)
  }

  async function start(input: StartCommandRunInput): Promise<{ run: CommandRunSummary; members: CommandMember[] }> {
    const settings = deps.settings()
    const role = deps.roleOf(input.createdBy)
    if (!canUseShell(role, settings.mode)) {
      throw new EnkakuError('auth.forbidden', 'shell access is turned off for this farm')
    }
    if (!settings.fanoutEnabled) {
      throw new EnkakuError('E_FANOUT_DISABLED', 'fleet commands are turned off for this farm')
    }
    const resolved = deps.resolve(input.target)
    if (resolved.usable.length === 0) {
      throw new EnkakuError(
        'E_NO_TARGETS',
        resolved.skipped.length > 0
          ? `no usable devices — every match was unavailable: ${resolved.skipped.map((s) => `${s.deviceId} (${s.reason})`).join(', ')}`
          : 'no devices matched this target',
      )
    }
    if (settings.fanoutMaxDevices > 0 && resolved.usable.length > settings.fanoutMaxDevices) {
      throw new EnkakuError(
        'E_TOO_MANY_TARGETS',
        `this command would target ${resolved.usable.length} devices, above the farm's limit of ${settings.fanoutMaxDevices}`,
      )
    }
    // `canUseDevice` per resolved target (§3.8) — before any run row exists,
    // so a refusal never leaves a half-created run, the same discipline
    // `createBatch`'s `assertDeviceAllowed` already applies.
    for (const t of resolved.usable) {
      const owner = deps.getDevice(t.deviceId)
      if (owner && !canUseDevice({ id: input.createdBy ?? '', role }, owner)) {
        throw new EnkakuError('auth.forbidden', `you do not have access to device ${t.deviceId}`)
      }
    }

    const stageFirstN = input.stageFirstN ?? 0
    const members = resolved.usable.map((t, i) => ({
      deviceId: t.deviceId,
      seq: i,
      stageIndex: stageFirstN > 0 && i >= stageFirstN ? 2 : 1,
    }))

    const created = store.create({
      cmd: input.cmd,
      target: input.target,
      savedCommandId: input.savedCommandId ?? null,
      stageFirstN,
      concurrency: input.concurrency ?? 0,
      acknowledged: input.acknowledged ?? false,
      createdBy: input.createdBy,
      members,
    })

    // `acknowledged`/`pattern` (plan 93 §3.14, step 93.4) — the acknowledgement
    // requirement itself is enforced at the REST layer (`api/command-runs.ts`),
    // never here (this file's own gates stay `canUseShell`/`fanoutEnabled`/
    // `fanoutMaxDevices`/`canUseDevice`, per this function's own doc history).
    // This audit row still records the FACT of it — whether the operator's
    // request carried an acknowledgement and which pattern (if any) the
    // shared guard saw — so "twenty phones were rebooted and somebody meant
    // it" is on the record rather than a reconstruction.
    const highConsequence = isHighConsequence(input.cmd)
    deps.audit.record({
      userId: input.createdBy,
      action: 'command.run',
      target: created.id,
      meta: {
        cmd: redactShellCommand(input.cmd),
        deviceCount: members.length,
        skipped: resolved.skipped,
        acknowledged: input.acknowledged ?? false,
        pattern: highConsequence.hit ? highConsequence.pattern : null,
      },
    })

    const state: RunState = {
      runId: created.id,
      clientId: input.clientId,
      createdBy: input.createdBy,
      cmd: input.cmd,
      currentStage: 1,
      cancelled: false,
      awaitingContinue: false,
      settled: new Set(),
      inFlight: new Map(),
      dirty: new Set(),
      seenHashes: new Set(),
      coalesceTimer: null,
      stageTimer: null,
      startedAtMs: Date.now(),
    }
    active.set(created.id, state)
    startCoalescer(state)

    const counts = tally(created.members)
    const wireMembers = created.members.map(toWireMember)
    deps.broadcast(created.id, {
      type: 'command.started',
      payload: { runId: created.id, cmd: input.cmd, stages: stageFirstN > 0 ? 2 : 1, members: wireMembers, counts },
    })

    const stage1Devices = members.filter((m) => m.stageIndex === 1).map((m) => m.deviceId)
    // Fire-and-forget: `start()` returns as soon as the run and its `pending`
    // member rows exist, so the caller (the REST route, step 93.4) can
    // respond with the full preview immediately — rows stream in from here
    // (§3.5), they do not block the response.
    void dispatchPool(state, stage1Devices, input.concurrency ?? settings.fanoutConcurrency)

    return { run: toSummary(created, counts), members: wireMembers }
  }

  return {
    start,
    cancel,
    continueRun,
    sweepOrphans() {
      return store.sweepOrphans()
    },
    stop() {
      // `00-overview.md` §7: every process this thing starts must be dead on
      // stop. `cancel()` already clears both timers, aborts every in-flight
      // exec, and force-settles every non-terminal member synchronously —
      // running it for every still-active run is sufficient; nothing here
      // needs its own separate teardown path.
      for (const runId of [...active.keys()]) cancel(runId, null)
    },
    stats(): CommandConsoleStats {
      const now = Date.now()
      let membersInFlight = 0
      for (const state of active.values()) membersInFlight += state.inFlight.size
      return {
        runsInFlight: active.size,
        membersInFlight,
        coalescedFramesPerSec: Math.round((pruneAndCount(frameTimes, now) / (STATS_WINDOW_MS / 1000)) * 100) / 100,
        distinctOutputRatio: outputsSettled > 0 ? Math.round((outputsDistinct / outputsSettled) * 1000) / 1000 : 0,
        leaseChangedPerMinute: pruneAndCount(leaseChangeTimes, now),
      }
    },
  }
}
