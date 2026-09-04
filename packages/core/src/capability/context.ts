import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import type { DeviceCall } from '@enkaku/session'
import { createDeviceExecutor, type TimingSettings, type TransferPort } from '@enkaku/session'
import { newSession, type Session } from '@enkaku/harness'
import { JobTraceEventSchema, type ActionRequest, type ActionResponse, type ActivityActor, type ActivityKind, type AgentRunStatus, type AgentStopReason, type ConnectionMedium, type DeviceInfo, type JobTraceEvent, type PolicyDecision, type UiNode } from '@enkaku/protocol'
import type { SessionManager } from '@enkaku/session'
import { can, canUseDevice, type Permission } from '../auth/acl'
import type { Role } from '../auth/service'
import type { Db } from '../db'
import { devices, jobEvents } from '../db/schema'
import type { ActivityRegistry } from '../activity/registry'
import { evaluate, type ControlPolicySettings } from '../activity/policy'
import type { DeviceNetworkPort } from '../network/route-service'
import { createDeviceNetworkService, type DeviceNetworkCapabilityService } from './device-network'
import { pluginNameFromPrincipal } from '../plugins/principal'
import type { DeviceStateMachine } from '../device/state-machine'
import type { ReadinessManager } from '../device/readiness'
import { resolveScriptRef } from '../scripts/resolve'
import type { ScriptRegistry } from '../scripts/registry'
import { resolveDirectPublishOwner } from '../plugins/owner'
import { getScriptDetail, listScriptGroups, publishScript, type PublishScriptInput, type ScriptDetail, type ScriptGroupInfo } from '../scripts/service'
import type { JobService } from '../services/job-service'
import { groupRefFor, listDevicesWithTags, rowToDeviceInfo, type FarmNetwork } from '../registry/device-registry'
import { lookupDeviceNumber } from '../registry/device-number'
import { loadDeviceTags } from '../registry/device-tags'
import { EnkakuError } from '../util/errors'
import type { WorkspaceStore } from '../workspace/store'
import type { NotifyService } from '../notify/service'
import { keysetWhere } from '../api/pagination'
import type { TraceFrameStore } from '../jobs/trace/frame-store'

/** The authenticated caller `invoke` checks against — a human today; Plan
 * 65 adds an agent actor with the same shape (id + role). */
export interface CapabilityActor {
  id: string
  role: Role
}

/**
 * What `script.publish` may ask for (plan 110 §3.2, §5 step 110.3) — a
 * PublishScriptInput minus the three fields the capability is not allowed to
 * choose:
 *
 * - `pluginId`/`exportId`: ownership is DERIVED from the name, never asserted
 *   by the caller, or an agent could publish a member into someone else's
 *   plugin;
 * - `kind`: this capability publishes scripts. A workflow is published through
 *   `POST /api/workflows`, which is where its document is validated.
 */
export type PublishScriptCapabilityInput = Omit<PublishScriptInput, 'pluginId' | 'exportId' | 'kind'>

export interface ScriptCapabilityService {
  listGroups(): ScriptGroupInfo[]
  get(id: string): ScriptDetail | null
  /** Publishes a PLUGIN member (plan 110 §3.2): `input.name` is `<plugin>/<script>`, and the owning plugin row is resolved or created here. */
  publish(input: PublishScriptCapabilityInput): { id: string; name: string; version: string }
}

/**
 * What every capability handler receives (plan 63 §3.2, §3.4). This is the
 * concrete `Ctx` `@enkaku/protocol`'s generic `Capability<I, O, Ctx>` is
 * pinned to for this host (`CoreCapability` in `./types.ts`) — see that
 * file's comment for why the split exists.
 *
 * `invoke` (`./invoke.ts`) is the only caller that reads
 * `hasPermission`/`canReachDevice`/`evaluateActivity`/`isDeviceOnline`
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
  /** The activity policy's verdict for starting `kind` on `deviceId` against
   * whatever is already live there (plan 63 §3.4 step 4, plan 205 §4.4,
   * acceptance #5) — `forbid` names the conflicting activity so `invoke`'s
   * refusal can say who/what is blocking, `warn` carries a sentence `invoke`
   * returns as the success `warning`. `exclusiveWith` is the capability's own
   * declared extra exclusions, when it has any. */
  evaluateActivity(deviceId: string, kind: ActivityKind, exclusiveWith?: ActivityKind[]): PolicyDecision
  /** Refreshes this caller's `control:<id>` marker on `deviceId` (plan 205
   * §4.4) — called by `invoke` only after a `control`-kind capability's
   * handler succeeds, never before. */
  touchActivity(deviceId: string, kind: ActivityKind): void
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
   * `quality` defaults to `'control'`; a read-only `activity: { kind: 'read' }`
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
  /**
   * The device network layer's one door, with this caller's activity admission and
   * principal bound in (plan 114 §3.3, step 114.9; plan 205 §5 step 205.8) — what
   * `device.network.get`/`.set`/`.clear` delegate to, and therefore what a
   * plugin holding `device.network` reaches through `ctx.farm.call`.
   *
   * Optional for two separate reasons, both real: an orchestrator-mode host has
   * no local device to have a route at all, and every pre-existing test that
   * hand-builds a `CapabilityContext` literal keeps compiling unedited. The
   * capabilities refuse with a named `E_NOT_SUPPORTED` when it is absent rather
   * than throwing something unreadable.
   */
  network?: DeviceNetworkCapabilityService
  /**
   * `job.trace`/`.trace.ui`/`.trace.frame`'s one-line delegation target (plan 130 §4.1, step
   * 130.1) — built from `deps.db` and the optional `deps.traceStore` exactly like `scripts`/
   * `workspace` above, never a raw `db` handed to a handler. Optional for the same reason
   * `notify`/`network` are (see their comments above): every pre-plan-130 test that hand-builds a
   * `CapabilityContext` literal keeps compiling unedited. A REAL host (`createCapabilityContext`
   * below) always sets it; the three capabilities refuse by name (`E_NOT_SUPPORTED`) on the rare
   * fixture that omits it.
   */
  jobTrace?: JobTraceCapabilityService
  /**
   * `actions.run`'s one door (plan 207 §4.10) — the SAME `runAction` the
   * actions API router (`api/actions.ts`) calls, so a plugin or agent
   * reaching a verb through the broker gets identical per-device policy
   * evaluation and results. Optional for the same reason `network`/`notify`
   * are: every pre-plan-207 test that hand-builds a `CapabilityContext`
   * literal keeps compiling unedited; the capability refuses by name
   * (`E_NOT_SUPPORTED`) on a fixture that omits it.
   */
  actions?: { run(request: ActionRequest, actor: CapabilityActor): Promise<ActionResponse> }
}

/** `job.trace`'s decoded cursor shape — the same `{ sortValue, id }` pair `decodeCursor` (`api/pagination.ts`) already returns; kept here rather than re-exported from there, since only this service consumes it. */
export interface JobTraceListParams {
  jobId: string
  kind?: JobTraceEvent['kind'][]
  limit: number
  cursor: { sortValue: number; id: string } | null
}

export interface JobTraceListResult {
  items: JobTraceEvent[]
  nextCursor: { sortValue: number; id: string } | null
  total: number
}

/**
 * `job.trace`/`.trace.ui`/`.trace.frame`'s service (plan 130 §4.1, step 130.1).
 *
 * `list` reads the identical `job_events` table with the identical
 * `(seq, id)` keyset ordering `api/jobs.ts`'s `GET /:id/trace` route already
 * uses — that route's own comment explains why: `seq` is the cursor and the
 * sort key, `atMs` is the display axis, ordering by `atMs` would break
 * paging to fix rendering. Reimplemented here (not imported) because the
 * route builds its query inline inside its own handler closure and this
 * plan's edit scope does not extend to `api/jobs.ts`; both read the same
 * table under the same predicate, so the two cannot drift apart in what
 * they SELECT, only in where the query text lives.
 *
 * `readFrame`/`readUiTree` are the opposite: NOT reimplemented. They
 * delegate straight to `TraceFrameStore`, which owns the hash/jobId
 * path-traversal guards (`jobs/trace/frame-store.ts`) — a malformed hash is
 * refused there, never sanitised here.
 */
export interface JobTraceCapabilityService {
  list(params: JobTraceListParams): JobTraceListResult
  /** `null` when the store has no file for this hash (never captured, or swept) — a 404 upstream, same as the REST route. */
  readFrame(jobId: string, hash: string): Promise<Uint8Array | null>
  readUiTree(jobId: string, hash: string): Promise<UiNode | null>
}

function toTraceEvent(row: typeof jobEvents.$inferSelect): JobTraceEvent {
  const parsed = JobTraceEventSchema.safeParse(row)
  if (!parsed.success) {
    throw new EnkakuError('E_TRACE_CORRUPT', `job_events row ${row.id} does not match JobTraceEventSchema`)
  }
  return parsed.data
}

/** Exported so a test builds the SAME service the real context does (mirrors `buildScriptService` above). */
export function buildJobTraceService(db: Db, traceStore?: TraceFrameStore): JobTraceCapabilityService {
  return {
    list({ jobId, kind, limit, cursor }) {
      const scope = and(eq(jobEvents.jobId, jobId), kind && kind.length > 0 ? inArray(jobEvents.kind, kind) : undefined)
      const counted = db.select({ n: sql<number>`count(*)` }).from(jobEvents).where(scope).get()
      const rows = db
        .select()
        .from(jobEvents)
        .where(and(scope, keysetWhere(cursor ? { value: cursor.sortValue, id: cursor.id } : null, jobEvents.seq, jobEvents.id, 'asc')))
        // Same tiebreak reasoning as the REST route: `seq` is unique per job, so `id` only breaks a
        // tie `keysetWhere`'s predicate cannot otherwise produce.
        .orderBy(asc(jobEvents.seq), asc(jobEvents.id))
        .limit(limit + 1)
        .all()
      const page = rows.slice(0, limit)
      const last = page.at(-1)
      return {
        items: page.map(toTraceEvent),
        nextCursor: rows.length > limit && last ? { sortValue: last.seq, id: last.id } : null,
        total: counted?.n ?? 0,
      }
    },
    async readFrame(jobId, hash) {
      if (!traceStore) throw new EnkakuError('E_NOT_SUPPORTED', 'trace frame storage is not available on this host')
      return traceStore.readFrame(jobId, hash)
    },
    async readUiTree(jobId, hash) {
      if (!traceStore) throw new EnkakuError('E_NOT_SUPPORTED', 'trace ui storage is not available on this host')
      return traceStore.readUiTree(jobId, hash)
    },
  }
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
  activities: ActivityRegistry
  controlSettings: () => ControlPolicySettings
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
   * below with the registry's merge of persisted scripts (plugin members
   * and workflows — an ordinary `scripts` row either way) plus dev slots.
   * Optional, like `notify`/`workspace` before it were introduced: every
   * pre-plan-82 test that hand-builds a `CapabilityContextDeps` literal
   * keeps compiling unedited, and falls back to the exact old behaviour.
   */
  registry?: ScriptRegistry
  /**
   * Farm networks (plan 88 §3.6, §4.1, §5 step 88.5) — `discovery.networks`,
   * read fresh on every call, same discipline as every other settings-derived
   * accessor here. Without this, `ctx.listDevices()`/`ctx.getDevice()` (an
   * agent script's own device view, `capability/device-state.ts`) could never
   * badge a device OTG/WI-FI — only `GET /api/devices` would have, which
   * would have made a script's view of a device disagree with Studio's.
   * Optional, like `registry` above: every existing caller that predates
   * this plan keeps compiling unedited, with no network ever matched.
   */
  networks?: () => FarmNetwork[]
  /**
   * The address book's declared media (plan 88 §3.1, §3.2, §4.3, §5 step
   * 88.5) — `loadDeclaredMedia`'s own return shape, resolved fresh on every
   * call, same reasoning as `networks` just above. Optional the same way.
   */
  declaredMedia?: () => Map<string, ConnectionMedium | null> | undefined
  /**
   * Plan 114 §3.3, step 114.9 — the network layer's one door, threaded in from
   * `createGuestAgentRoutes`'s handle exactly the way `jobService`/`workspace`
   * are. `createCapabilityContext` wraps it with this caller's activity admission
   * and principal; the raw port has neither and is never handed to a handler.
   *
   * Optional, so orchestrator mode and every pre-existing
   * `CapabilityContextDeps` literal keep working — the capabilities refuse by
   * name when it is absent.
   */
  network?: DeviceNetworkPort
  /**
   * The trace frame/UI-tree file store (plan 128 §3.5, `jobs/trace/frame-store.ts`) — the SAME
   * store `api/jobs.ts`'s `GET /:id/trace/frames|ui/:hash` routes already read, threaded through
   * exactly like `workspace`/`jobService` above (plan 130 §4.1, step 130.1). Optional: an
   * orchestrator-mode host or a pre-plan-130 test literal has none, and `job.trace.frame`/
   * `.trace.ui` refuse by name (`E_NOT_SUPPORTED`) rather than throwing something unreadable —
   * `job.trace` itself needs no store at all, since it only ever reads `job_events`.
   */
  traceStore?: TraceFrameStore
  /**
   * `actions.run`'s one door (plan 207 §4.10) — the SAME `runAction` the
   * actions API router (`api/actions.ts`) calls, threaded in from
   * `daemon.ts` exactly like `network`/`jobService` above. Optional for the
   * same reason `network`/`notify`/`jobTrace` are: an orchestrator-mode host
   * or a pre-plan-207 test literal has none, and `actions.run` refuses by
   * name (`E_NOT_SUPPORTED`) rather than throwing something unreadable.
   */
  actionsRun?: (request: ActionRequest, actor: CapabilityActor) => Promise<ActionResponse>
}

/**
 * Exported (plan 110 §5 step 110.3) so a test builds the SAME service the real
 * context does. A hand-rolled `{ publish: (input) => publishScript(db, input) }`
 * in a fixture would be a second answer to "what does publishing mean", and it
 * is exactly the answer that would miss the owning-plugin rule.
 */
export function buildScriptService(db: Db): ScriptCapabilityService {
  return {
    listGroups: () => listScriptGroups(db),
    get: (id) => getScriptDetail(db, id),
    /**
     * Plan 110 §3.2, §5 step 110.3 — `script.publish` publishes a PLUGIN. The
     * bundle is built exactly as it was (the `{ path }` form still goes
     * through `buildScriptFromWorkspace` in `capability/script.ts`); what
     * changed is only what gets written: a member row owned by the plugin
     * named in `<plugin>/<script>`, resolved or created by the same helper
     * `POST /api/scripts` uses, so the REST route and the capability still
     * cannot disagree about what publishing means (plan 63 §6.9).
     */
    publish: (input) => {
      const owner = resolveDirectPublishOwner(db, {
        name: input.name,
        version: input.version,
        bundle: input.bundle,
        source: input.source ?? null,
      })
      return publishScript(db, { ...input, pluginId: owner.pluginId, exportId: owner.exportId })
    },
  }
}

/**
 * The activity-registry client id a `CapabilityActor` touches its control
 * marker under (plan 205 §4.4): `user:<id>` for a person, `plugin:<name>`
 * for a plugin call (`actor.id` is already `plugin:<name>` for those —
 * `farm-broker.ts`'s `actorFor` — so this only strips the prefix to rebuild
 * it consistently), `anonymous` for no actor at all.
 */
function clientIdOf(actor: CapabilityActor | null): string {
  if (!actor) return 'anonymous'
  const pluginName = pluginNameFromPrincipal(actor.id)
  return pluginName ? `plugin:${pluginName}` : `user:${actor.id}`
}

/** The `ActivityActor` a `CapabilityActor`'s marker is attributed to — the label a viewer of the device actually reads. */
function activityActorOf(actor: CapabilityActor | null): ActivityActor {
  if (!actor) return { kind: 'user', id: 'anonymous', label: 'a signed-out client' }
  const pluginName = pluginNameFromPrincipal(actor.id)
  if (pluginName) return { kind: 'plugin', id: actor.id, label: pluginName }
  return { kind: 'user', id: actor.id, label: actor.id }
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
    // Plan 114 step 114.9, reworked by plan 205 §5 step 205.8 — bound to THIS
    // actor, so a transient network-apply activity is started under the
    // caller's own principal and the route's `setBy` names them. A context
    // with no network port simply has no `network`, and the capabilities say
    // so by name.
    ...(deps.network ? { network: createDeviceNetworkService({ port: deps.network, activities: deps.activities, controlSettings: deps.controlSettings }, actor) } : {}),
    // `actions.run` (plan 207 §4.10) — the SAME `runAction` the actions API
    // router calls; `deps.actionsRun` is absent on an orchestrator-mode host
    // or a pre-plan-207 test literal, and the capability refuses by name.
    ...(deps.actionsRun ? { actions: { run: deps.actionsRun } } : {}),
    fileToolsSession: fileToolsSessionFor(actor, null),
    hasPermission: (permission) => (actor ? can(actor.role, permission) : false),

    canReachDevice(deviceId) {
      if (!actor) return false
      const row = getDeviceRow(deviceId)
      if (!row) return false
      return canUseDevice(actor, { ownerId: row.ownerId })
    },

    evaluateActivity(deviceId, kind, exclusiveWith) {
      return evaluate(kind, deps.activities.list(deviceId), deps.controlSettings(), { selfIds: [`control:${clientIdOf(actor)}`], ...(exclusiveWith ? { exclusiveWith } : {}) })
    },

    touchActivity(deviceId, kind) {
      // Only `control` maintains a marker this way (`invoke.ts`'s own step 6
      // never calls this for any other kind, plan 205 §4.4) — the clause is
      // still here, not assumed, so a future caller cannot silently touch a
      // `job`/`transfer`/... marker it does not own.
      if (kind !== 'control') return
      deps.activities.touchControl(deviceId, clientIdOf(actor), activityActorOf(actor))
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

    // Plan 206 §4.3, §5 step 206.5: `SessionManager.acquire` always serves the
    // one base (`wall`) entry now — there is no per-call quality to acquire
    // against. `quality` stays on the public `deviceCall` signature (every
    // caller in `device-inspect.ts`/`device-clipboard.ts`/`device-files.ts`
    // still passes `'wall'` explicitly) but is no longer read here.
    async deviceCall(deviceId, call) {
      const sessions = deps.sessions()
      if (!sessions) {
        throw new EnkakuError('E_DEVICE_OFFLINE', 'no local session manager is available for this device (orchestrator mode, or adb is not ready)')
      }
      const onFrame = () => {}
      const session = await sessions.acquire(deviceId, onFrame)
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
      // The activity state (plan 205 §4.10) is always available —
      // `deps.activities` exists in every mode, unlike `readiness`.
      // `networks`/`declaredMedia` (plan 88 §5 step 88.5) are resolved ONCE
      // here, never per row — the same N+1 rule `device-registry.ts:171-175`
      // already states.
      return listDevicesWithTags(
        deps.db,
        readiness ? (deviceId) => readiness.get(deviceId) : undefined,
        (deviceId) => ({ activities: deps.activities.list(deviceId), lastControl: deps.activities.lastControl(deviceId) }),
        deps.networks?.() ?? [],
        deps.declaredMedia?.(),
      )
    },

    getDevice(deviceId) {
      const row = getDeviceRow(deviceId)
      if (!row) return null
      const group = row.groupId ? groupRefFor(deps.db, row.groupId) : null
      return rowToDeviceInfo(
        row,
        loadDeviceTags(deps.db, [deviceId]).get(deviceId) ?? [],
        group,
        null,
        deps.readiness()?.get(deviceId) ?? null,
        { activities: deps.activities.list(deviceId), lastControl: deps.activities.lastControl(deviceId) },
        deps.networks?.() ?? [],
        deps.declaredMedia?.(),
        lookupDeviceNumber(deps.db, row.stableId),
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
    // `scriptRef` form, `capability/job.ts`) resolves a plugin member and a
    // dev build through one path; a test with no registry keeps the exact
    // pre-plan-82 behaviour.
    resolveScriptRef: (ref) => (deps.registry ? deps.registry.resolve(ref) : resolveScriptRef(deps.db, ref)),

    workspace: deps.workspace,
    // Plan 64 §3.2, §4.2: every human actor gets the whole tree both ways
    // today. Plan 65 gives an agent actor its own narrower grant; this
    // function is the one place that will change.
    workspaceScope: () => ({ read: ['/'], write: ['/'] }),

    jobTrace: buildJobTraceService(deps.db, deps.traceStore),
  }
}
