import { eq } from 'drizzle-orm'
import type { DeviceCall } from '@enkaku/session'
import { createDeviceExecutor, type TimingSettings, type TransferPort } from '@enkaku/session'
import { newSession, type Session } from '@enkaku/harness'
import type { AgentRunStatus, AgentStopReason, DeviceInfo } from '@enkaku/protocol'
import type { SessionManager } from '@enkaku/session'
import { can, canUseDevice, type Permission } from '../auth/acl'
import type { Role } from '../auth/service'
import type { Db } from '../db'
import { devices } from '../db/schema'
import type { LeaseManager } from '../lease/lease-manager'
import type { DeviceStateMachine } from '../device/state-machine'
import type { ReadinessManager } from '../device/readiness'
import { resolveScriptRef } from '../scripts/resolve'
import type { ScriptRegistry } from '../scripts/registry'
import { getScriptDetail, listScriptGroups, publishScript, type PublishScriptInput, type ScriptDetail, type ScriptGroupInfo } from '../scripts/service'
import type { JobService } from '../services/job-service'
import { clusterRefFor, listDevicesWithTags, rowToDeviceInfo } from '../registry/device-registry'
import { loadDeviceTags } from '../registry/device-tags'
import { EnkakuError } from '../util/errors'
import type { WorkspaceStore } from '../workspace/store'
import type { NotifyService } from '../notify/service'

/** The authenticated caller `invoke` checks against — a human today; Plan
 * 65 adds an agent actor with the same shape (id + role). */
export interface CapabilityActor {
  id: string
  role: Role
}

export interface ScriptCapabilityService {
  listGroups(): ScriptGroupInfo[]
  get(id: string): ScriptDetail | null
  publish(input: PublishScriptInput): { id: string; name: string; version: string }
}

/**
 * What every capability handler receives (plan 63 §3.2, §3.4). This is the
 * concrete `Ctx` `@enkaku/protocol`'s generic `Capability<I, O, Ctx>` is
 * pinned to for this host (`CoreCapability` in `./types.ts`) — see that
 * file's comment for why the split exists.
 *
 * `invoke` (`./invoke.ts`) is the only caller that reads
 * `hasPermission`/`canReachDevice`/`controlLeaseBlockedBy`/`isDeviceOnline`
 * directly; a handler never re-checks them; a handler only ever calls the
 * service accessors below (`deviceCall`, `readiness`, `jobService`,
 * `scripts`, `resolveScriptRef`, `listDevices`/`getDevice`) — exactly the
 * "one-line delegation" §4.3 requires.
 */
export interface CapabilityContext {
  actor: CapabilityActor | null
  hasPermission(permission: Permission): boolean
  /** For a human this is `canUseDevice`'s ownership check; Plan 65 replaces
   * the human-only body with an agent's device grant list. `invoke` calls
   * this and does not care which (plan 63 §3.4 step 3). */
  canReachDevice(deviceId: string): boolean
  /** `null` when the caller already holds the manual lease (or the device
   * has none and that is fine); otherwise a display name for who does, so a
   * refusal can NAME the holder (plan 63 §3.4 step 4, acceptance #5) rather
   * than just saying "no". */
  controlLeaseBlockedBy(deviceId: string): string | null
  isDeviceOnline(deviceId: string): boolean
  /** Wakes the device through Plan 45's `readiness.hold`, before a
   * capability's deadline clock effectively matters (plan 63 §3.4 step 5). */
  ensureAwake(deviceId: string): Promise<void>
  /**
   * Runs one `DeviceCall` against the device's live session, through the
   * SAME executor a script's IPC bridge uses (`@enkaku/session`'s
   * `createDeviceExecutor`) — the one delegation point every `device.*`
   * capability handler calls, so no handler reimplements driver behaviour
   * (plan 63 §4.3, non-goal §2, step 63.4).
   *
   * `quality` defaults to `'control'`; a read-only `lease: 'device'`
   * capability (`device.screenshot`, `.find`, `.dump`, `.clipboard.get`,
   * `.push`, `.pull`) passes `'wall'` instead, so a plain read never forces
   * `SessionManager.acquire`'s quality-upgrade restart (`manager.ts`'s
   * `upgradeToControl`) onto a session a Wall viewer already has open —
   * the read itself does not depend on video bitrate at all.
   */
  deviceCall(deviceId: string, call: DeviceCall, quality?: 'control' | 'wall'): Promise<unknown>
  /** `null` only when this host has no local readiness manager at all
   * (orchestrator mode) — `device.wake`/`.sleep` refuse cleanly in that case. */
  readiness: Pick<ReadinessManager, 'get' | 'set'> | null
  listDevices(): DeviceInfo[]
  getDevice(deviceId: string): DeviceInfo | null
  jobService: JobService
  scripts: ScriptCapabilityService
  /** Plan 62's resolver — `name@version` / `name@latest` → a concrete script
   * row. Thrown `EnkakuError`s (`script_not_found` etc.) pass through
   * `invoke` with their own code, unchanged (`./invoke.ts`). */
  resolveScriptRef(ref: string): { id: string }
  /** The database-backed workspace (plan 64 §4.2) — `fs.*` capabilities
   * delegate to this and nothing else; there is no second path to a file. */
  workspace: WorkspaceStore
  /**
   * Path prefixes this actor may read/write (plan 64 §3.2). Plan 65 replaces
   * this human-only body with an agent's actual grant list, the same
   * `canReachDevice`-style split `invoke` already relies on for devices —
   * `capability/fs.ts` calls this and does not care which. Today every human
   * actor gets the full tree both ways (§3.2: "readable and writable by
   * anyone with fs.write" — the PERMISSION is what gates a human, not a
   * scope; an agent's narrower default ("write to its own home, read
   * everywhere") has nothing to attach to yet, since no agent actor exists
   * before Plan 65).
   */
  workspaceScope(): { read: string[]; write: string[] }
  /** The run currently invoking a capability through this context — `null` for a human/REST/MCP
   * caller (plan 67 §4.2: `agent.*` capabilities only make sense from within a running agent's own
   * tool-calling, and refuse cleanly when this is null). */
  currentRunId: string | null
  /** The run-tree operations `agent.*` capabilities delegate to (plan 67 §4.2) — implemented by
   * `agent/runner.ts`, the only thing with the machinery to launch and await a run; `null` for a
   * caller with no current run, exactly like `currentRunId`. */
  agentTree: AgentTreeOps | null
  /** `notify.send`'s one-line delegation (plan 68 §4.3) — writes the in-app row first, then attempts
   * any requested webhooks (detached beyond the first bounded attempt), rate-limited per agent.
   * Optional (unlike every other service accessor here) purely so the many pre-plan-68 tests that
   * hand-build a `CapabilityContext` literal — none of which exercise `notify.send` — keep compiling
   * unedited; a real host always supplies it (`daemon.ts`), and the capability's own handler refuses
   * cleanly with a named error if it is somehow absent. */
  notify?: NotifyService
  /**
   * The ported harness file tools' (`capability/file-tools.ts`) "read before edit" state (plan 77
   * §3.3) — `edit_file`'s staleness check needs to remember which version of a file THIS caller
   * last read, across many separate tool calls. Kept alive for the lifetime of one agent run
   * (`fileToolsSessionFor` below, keyed by `currentRunId`) so the workflow upstream's file tools
   * assume actually holds; kept alive per actor for a human/REST/MCP caller instead, so repeated
   * calls through the same identity still get read-before-edit continuity even though
   * `createCapabilityContext` itself is rebuilt fresh per call. Optional for the SAME reason
   * `notify` is: every pre-existing `CapabilityContext` test fake keeps compiling unedited; a
   * handler that needs one falls back to a throwaway `newSession()` (plan 77 §3.3 — degrades to "no
   * memory of a prior read" rather than throwing).
   */
  fileToolsSession?: Session
}

/**
 * One `Session` per agent run (or per human/REST/MCP actor identity, when there is no run) —
 * bounded so a long-lived process cannot grow this without limit; the oldest entry is evicted once
 * the cap is reached, which only ever costs a caller an extra "read before edit" round trip, never
 * correctness (plan 77 §3.3).
 */
const MAX_FILE_TOOLS_SESSIONS = 2_000
const fileToolsSessions = new Map<string, Session>()

export function fileToolsSessionFor(actor: CapabilityActor | null, runId: string | null): Session {
  const key = runId ? `run:${runId}` : actor ? `actor:${actor.id}` : 'anonymous'
  let session = fileToolsSessions.get(key)
  if (!session) {
    if (fileToolsSessions.size >= MAX_FILE_TOOLS_SESSIONS) {
      const oldestKey = fileToolsSessions.keys().next().value
      if (oldestKey !== undefined) fileToolsSessions.delete(oldestKey)
    }
    session = newSession()
    fileToolsSessions.set(key, session)
  }
  return session
}

/** `agent.spawn`'s input, already Zod-validated (plan 67 §3.2, §4.2). */
export interface AgentSpawnInput {
  /** The child agent's slug or id. */
  agent: string
  prompt: string
  /** Default true (plan 67 §3.2's table) — resolved by the capability handler, not here. */
  waitFor: boolean
  /** Narrows the child's device grants below the authority intersection; never widens it (§4.2). */
  deviceIds?: string[]
}

export type AgentSpawnResult =
  | { waited: true; runId: string; status: AgentRunStatus; stopReason: AgentStopReason | null; output: string | null }
  | { waited: false; runId: string }

export interface AgentStatusResult {
  runId: string
  status: AgentRunStatus
  stopReason: AgentStopReason | null
  steps: number
  lastMessage: string | null
}

export interface AgentCancelResult {
  ok: true
  /** How many runs in the subtree (the target plus every descendant) were asked to cancel — shown
   * to an operator/model BEFORE the fact would be nicer, but this is what confirms it happened. */
  cancelledCount: number
}

/**
 * The run-tree operations `capability/agent.ts`'s five capabilities delegate
 * to (plan 67 §4.2) — one-line delegations, exactly like every other
 * `CapabilityContext` service accessor. Bound to the CALLING run already (no
 * `fromRunId`/`callerRunId` parameter anywhere): `send`/`reply`/`status`/
 * `cancel` all resolve "who is calling" from the context that built this,
 * which is what makes addressing an arbitrary run NOT EXPRESSIBLE for
 * `agent.reply` (no run id parameter exists at all) and checked immediately,
 * before any state changes, for `agent.send`/`.status`/`.cancel` (plan 67
 * §4.2's "refused at input validation, not at delivery").
 */
export interface AgentTreeOps {
  spawn(input: AgentSpawnInput): Promise<AgentSpawnResult>
  /** to a DESCENDANT run only (any depth) — refuses anything else (plan 67 §4.2). */
  send(targetRunId: string, message: string): { queued: true; inboxId: string }
  /** to the calling run's PARENT only — no target parameter, so nothing else is expressible. */
  reply(message: string): { queued: true; inboxId: string }
  /** a descendant's status, steps, and last message (plan 67 §4.2). */
  status(targetRunId: string): AgentStatusResult
  /** cancels a descendant SUBTREE, depth-first (plan 67 §3.5, §4.2). */
  cancel(targetRunId: string): AgentCancelResult
}

export interface CapabilityContextDeps {
  db: Db
  leases: LeaseManager
  states: DeviceStateMachine
  /** Lazy, like every other adb-dependent accessor in `daemon.ts` — null
   * until the local adb subsystem is up, or permanently null in orchestrator
   * mode (no local device session is ever possible there). */
  sessions: () => SessionManager | null
  readiness: () => ReadinessManager | null
  transfer: TransferPort | null
  jobService: JobService
  timing?: TimingSettings
  onAppLaunch?: (deviceId: string, pkg: string) => void
  /** Plan 64 §4.2 — one store per boot, threaded through exactly like `jobService`. */
  workspace: WorkspaceStore
  /** Plan 68 §4.3, §4.4 — one instance per boot, exactly like `workspace` above. Optional for the same reason `CapabilityContext.notify` is (see its comment). */
  notify?: NotifyService
  /**
   * Plan 82 §3.3 — replaces the raw `resolveScriptRef(deps.db, ref)` call
   * below with the registry's merge of persisted scripts (standalone AND
   * plugin members — an ordinary `scripts` row either way) plus dev slots.
   * Optional, like `notify`/`workspace` before it were introduced: every
   * pre-plan-82 test that hand-builds a `CapabilityContextDeps` literal
   * keeps compiling unedited, and falls back to the exact old behaviour.
   */
  registry?: ScriptRegistry
}

function buildScriptService(db: Db): ScriptCapabilityService {
  return {
    listGroups: () => listScriptGroups(db),
    get: (id) => getScriptDetail(db, id),
    publish: (input) => publishScript(db, input),
  }
}

/** One `CapabilityContext` per invocation (plan 63 §3.4) — cheap to build,
 * so `invoke` callers (REST, MCP, the script bridge) construct a fresh one
 * per call rather than sharing mutable state across callers. */
export function createCapabilityContext(deps: CapabilityContextDeps, actor: CapabilityActor | null): CapabilityContext {
  const getDeviceRow = (deviceId: string) => deps.db.select().from(devices).where(eq(devices.id, deviceId)).get()
  const scripts = buildScriptService(deps.db)

  return {
    actor,
    // A human/REST/MCP caller has no current run and cannot reach the `agent.*` tree capabilities
    // (plan 67 §4.2) — `createAgentCapabilityContext` (`agent/loop/context.ts`) is what overrides
    // both of these for an actual running agent.
    currentRunId: null,
    agentTree: null,
    notify: deps.notify,
    fileToolsSession: fileToolsSessionFor(actor, null),
    hasPermission: (permission) => (actor ? can(actor.role, permission) : false),

    canReachDevice(deviceId) {
      if (!actor) return false
      const row = getDeviceRow(deviceId)
      if (!row) return false
      return canUseDevice(actor, { ownerId: row.ownerId })
    },

    controlLeaseBlockedBy(deviceId) {
      const lease = deps.leases.getLease(deviceId)
      if (!lease || lease.type !== 'manual') return 'nobody — no manual lease is held; acquire it first'
      if (actor && lease.holderUserId === actor.id) return null
      return lease.holderUserId ?? lease.holder
    },

    isDeviceOnline(deviceId) {
      const status = deps.states.current(deviceId)
      return status !== null && status !== 'offline' && status !== 'quarantined'
    },

    async ensureAwake(deviceId) {
      const readiness = deps.readiness()
      if (!readiness) return
      const hold = await readiness.hold(deviceId, 'capability')
      hold.release()
    },

    async deviceCall(deviceId, call, quality = 'control') {
      const sessions = deps.sessions()
      if (!sessions) {
        throw new EnkakuError('E_DEVICE_OFFLINE', 'no local session manager is available for this device (orchestrator mode, or adb is not ready)')
      }
      const onFrame = () => {}
      const session = await sessions.acquire(deviceId, onFrame, quality)
      try {
        const execute = createDeviceExecutor({
          session,
          ...(deps.timing ? { timing: deps.timing } : {}),
          ...(deps.transfer ? { transfer: deps.transfer } : {}),
          onAppLaunch: (pkg) => deps.onAppLaunch?.(deviceId, pkg),
        })
        return await execute(call)
      } finally {
        sessions.release(deviceId, onFrame)
      }
    },

    readiness: deps.readiness(),

    listDevices() {
      const readiness = deps.readiness()
      // `listDevicesWithTags` itself falls back to `staticReadinessFallback`
      // per row when `readinessOf` is omitted — same as `getDevice` below.
      // `heldBy` (plan 71 §4.4) is always available — `deps.leases` exists in
      // every mode, unlike `readiness`.
      return listDevicesWithTags(
        deps.db,
        readiness ? (deviceId) => readiness.get(deviceId) : undefined,
        (deviceId) => deps.leases.getHolder(deviceId),
      )
    },

    getDevice(deviceId) {
      const row = getDeviceRow(deviceId)
      if (!row) return null
      const cluster = row.clusterId ? clusterRefFor(deps.db, row.clusterId) : null
      return rowToDeviceInfo(
        row,
        loadDeviceTags(deps.db, [deviceId]).get(deviceId) ?? [],
        cluster,
        null,
        deps.readiness()?.get(deviceId) ?? null,
        deps.leases.getHolder(deviceId),
      )
    },

    jobService: deps.jobService,
    scripts,
    // `ScriptRef` (`@enkaku/protocol`) is `z.string().regex(...)` — the
    // inferred TS type is plain `string`, so no cast is involved here; the
    // regex itself is enforced by the capability's OWN input schema at
    // `invoke`'s parse step (step 1), before this is ever called. Plan 82
    // §3.3 — goes through the registry when one is wired (`daemon.ts`
    // always wires it), so a capability caller (e.g. `job.enqueue`'s
    // `scriptRef` form, `capability/job.ts`) resolves a plugin member the
    // same as a standalone script; a test with no registry keeps the exact
    // pre-plan-82 behaviour.
    resolveScriptRef: (ref) => (deps.registry ? deps.registry.resolve(ref) : resolveScriptRef(deps.db, ref)),

    workspace: deps.workspace,
    // Plan 64 §3.2, §4.2: every human actor gets the whole tree both ways
    // today. Plan 65 gives an agent actor its own narrower grant; this
    // function is the one place that will change.
    workspaceScope: () => ({ read: ['/'], write: ['/'] }),
  }
}
