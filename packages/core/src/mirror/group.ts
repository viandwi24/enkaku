import type { DeviceSession, InputSource, SessionManager } from '@enkaku/session'
import type { MirrorAction, MirrorMember, MirrorResult, Point } from '@enkaku/protocol'
import type { DeviceStateMachine } from '../device/state-machine'
import type { LeaseManager } from '../lease/lease-manager'
import type { CoControlManager } from '../lease/co-control'
import type { JobService } from '../services/job-service'
import type { EventRecorder } from '../events/recorder'
import { EnkakuError } from '../util/errors'
import type { Logger } from '../util/logger'

/**
 * Mirror groups — one operator driving many phones at once (plan 91 §3.8,
 * §3.9, §4.7). `mirror.start` resolves every requested device independently,
 * against the §3.9 table, and reports an outcome for EVERY one — never a
 * silent drop. No multi-device lock is acquired anywhere in this file: a
 * `lease` member got an ordinary manual lease (`leases.acquireManual`, never
 * with `takeOverFrom` — §3.10 forbids a mirror ever displacing a holder), an
 * `assist` member got an ordinary co-control grant (`coControl.grant`) — both
 * exactly as a single-device operator would get, through the exact same
 * doors. `dispatch` then trusts that authorization for the life of the
 * group; it does not re-check `checkInputAllowed`/`checkAssistAllowed` on
 * every action, because nothing here can grant more than those two functions
 * already would for a single device (F1's blast radius is unchanged: this
 * file never touches `shell.exec`/`inspect.*`/`clipboard.set`/transfer —
 * §3.10's table).
 *
 * The property every method here is written to preserve: **no action ever
 * completes without a per-device result.** A member with nothing to report
 * is never simply absent from `MirrorStartedMessage.members` or
 * `InputMirrorResultMessage.results` — it is present with a named code.
 */

interface MemberState {
  mode: MirrorMember['mode']
  reason: string | null
  aspectDrift: boolean
  /** Consecutive DISPATCH failures (never reset by a skip at `start`/`reconcile` time — only by a successful `applyAction`). Drives the auto-drop (§3.9). */
  consecutiveFailures: number
}

export interface MirrorGroup {
  id: string
  ownerClientId: string
  ownerUserId: string | null
  focusDeviceId: string
  members: Map<string, MemberState>
  /** The focused device's orientation and aspect AT `mirror.start` (§3.7) — a snapshot, not re-read live, so every member is judged against the same reference for the group's whole life. */
  focusGeometry: { orientation: 'portrait' | 'landscape'; aspect: number }
}

export interface MirrorManagerDeps {
  /** Read fresh, like every other cross-subsystem accessor in this codebase — `sessions` itself is reassigned once at boot, well after this manager is constructed (`daemon.ts`'s own `sessions: () => sessions` pattern). */
  sessions: () => SessionManager | null
  states: Pick<DeviceStateMachine, 'current'>
  leases: Pick<LeaseManager, 'getLease' | 'acquireManual' | 'touchManual'>
  coControl: Pick<CoControlManager, 'grant' | 'touch'>
  jobs: Pick<JobService, 'get'>
  /**
   * Node ownership (§2 non-goals) — a device belonging to a node is refused
   * `node_owned` BY NAME, never silently dropped. Deliberately its own tiny
   * function rather than importing `ws-handlers.ts`'s `RemoteSessions`
   * interface: that file imports `MirrorManager` (this file's own export)
   * for `WsHandlerDeps`, so importing a VALUE-bearing interface the other
   * direction would make the two modules genuinely circular. Structural
   * typing means a real `RemoteSessions` still satisfies this — daemon.ts
   * passes `(deviceId) => remoteSessions?.nodeIdFor(deviceId) ?? null`.
   * Undefined in a local-only build/test: no device is ever node-owned.
   */
  nodeIdFor?: (deviceId: string) => string | null
  /** `devices.label`, or the id itself when the device row cannot be found — a `MirrorMember` always carries something a human can read (never a bare uuid presented as if it were one). */
  deviceLabel: (deviceId: string) => string
  /**
   * The device's number from `device_numbers`, or `null` — the other half of
   * `MirrorMember`'s identity (plan 124 §3.7, plan 89 §3.1).
   *
   * Its own accessor rather than a widened `deviceLabel` return, for the same
   * reason `nodeIdFor` above is its own tiny function: this file resolves
   * members by `deviceId` and has no `Db` of its own, and threading the
   * `device_numbers` table in here to save one callback would give the mirror
   * manager a database dependency it otherwise does not have.
   *
   * OPTIONAL, and `null` when absent, because a host built before plan 124 —
   * and every test harness in `group.test.ts`, which constructs these deps by
   * hand — is a farm where the number simply is not known here. Plan 89 §3.3
   * already fixed what that renders as: the bare label, never `#null`.
   */
  deviceNumber?: (deviceId: string) => number | null
  /**
   * The SAME `canAssist(role, mode)` gate `assist.start` enforces (§3.6),
   * checked once per MEMBER that would need a fresh co-control grant — not
   * once for the whole `mirror.start` call, so an operator who lacks
   * `device.assist` can still mirror a group of otherwise-idle devices; only
   * the members that would have needed assisting are skipped
   * `assist_not_allowed`. `coControl.grant` itself still enforces the
   * farm-wide `mode: 'off'` switch underneath regardless of what this
   * returns (defense in depth, per `co-control.ts`'s own doc comment on
   * `CoControlConfig.mode`) — this is the ROLE half specifically, the half
   * that store has no notion of.
   */
  assistAllowedFor: (ownerUserId: string | null) => boolean
  /**
   * Attribution (plan 91 §3.5, §5 step 91.5). **Decision, not the plan's own
   * literal "dispatch in full" pseudocode**: step 91.7 built `dispatch`
   * exactly as §4.7 shows it, which calls neither `recorder.record` nor
   * `audit.record` at all — flagged by that step as a real gap against F16
   * ("every input is already recorded"). This step closes it with PER-DEVICE
   * rows, deliberately, not one aggregate row per mirror action: (a)
   * `device_events` has no field for "N devices" — every row belongs to
   * exactly one `deviceId`, and an aggregate row parked on the focus device
   * would leave the OTHER 19 members' own Device Log tabs blind to input
   * they visibly received, which is a worse dishonesty than the row count;
   * (b) `GET /api/jobs/:id/assists` (§4.9) finds assists by `deviceId` — an
   * `assist`-mode member being mirrored into while its job runs needs a REAL
   * row on ITS OWN device to be found at all, or a mirrored assist would be
   * invisible to the very endpoint this plan built to answer "was this job
   * assisted"; (c) the write cost is bounded by `mirror.maxDevices` (20
   * default, 64 ceiling) and lands in the SAME buffered-transaction recorder
   * every concurrent human operator's input already shares (`events/
   * recorder.ts`: one transaction per 250ms/200-row flush, not one write per
   * row) — write amplification is real (up to maxDevices× per action) but it
   * is the identical cost 20 separate operators tapping 20 separate devices
   * would already produce today, not a new scaling problem. `audit.record`
   * is deliberately NOT called per action here, matching the single-device
   * `input.*` branch (`ws-handlers.ts`), which never audits routine input
   * either — audit is for the grant/release boundary (`assist.start`/
   * `assist.stop`), not every tap.
   */
  recorder: Pick<EventRecorder, 'record'>
  /** `jobs.assistCount += 1` for a successfully-delivered `assist`-mode action whose primary hold is a job — the SAME increment the single-device `input.*` branch performs, called from a narrow callback rather than threading `Db`/the `jobs` table into this file directly. */
  incrementAssistCount: (jobId: string) => void
  config: {
    maxDevices: () => number
    requireSameOrientation: () => boolean
    aspectTolerance: () => number
    dropAfterConsecutiveFailures: () => number
  }
  /**
   * Fired whenever `reconcile` or `dispatch`'s auto-drop changes a LIVE
   * group's members after `start` returned — the unicast `mirror.changed`
   * trigger (`packages/protocol/src/messages/co-control.ts`'s own doc
   * comment on that message names all three causes: a job ending, an
   * auto-drop, or an `internal:install` job starting). Never fired for the
   * resolution `start` itself computes and returns directly.
   */
  onChanged?: (group: MirrorGroup, members: MirrorMember[]) => void
  log: Logger
}

export interface MirrorManager {
  start(input: {
    ownerClientId: string
    ownerUserId: string | null
    focusDeviceId: string
    deviceIds: string[]
  }): Promise<{ group: MirrorGroup; members: MirrorMember[] }>
  /** A no-op for a caller that is not this group's owner or names an already-gone group — ending your own mirror early is always allowed, the same tolerance `assist.stop`/`lease.release` give a non-holder. */
  stop(groupId: string, ownerClientId: string): void
  /** Every group this WS connection owns, anywhere on the farm — the WS-close path (mirrors `coControl.releaseAllForClient`). Does NOT release the members' own underlying leases/grants: those are ordinary, independent authorizations by the time this runs, and `handleClose` already releases every one the disconnecting client holds through `leases.releaseAllForClient`/`coControl.releaseAllForClient` regardless of which (if any) mirror group they were resolved through. */
  stopAllForClient(clientId: string): void
  /** Throws `mirror_not_found` for an unknown group or a caller who is not its owner — never a silent empty result array, which would look like "zero members" rather than "wrong caller". */
  dispatch(groupId: string, ownerClientId: string, action: MirrorAction, soloDeviceId?: string): Promise<MirrorResult[]>
  /** Live re-resolution for ONE device, across every group that has it as a member — a job ended (F27's re-admit), a lease/grant it depended on ended, or its session's geometry changed. Re-uses the exact same resolution `start` uses, so re-admission can only ever grant what a fresh `mirror.start` on that one device would have. */
  reconcile(deviceId: string): void
  /**
   * Every live group farm-wide, read-only (plan 91 §4.10, §5 step 91.10) —
   * for `/api/adb/stats`'s `input.mirrorGroups`/`input.mirrorMembers` counts
   * and the `co-control` doctor check's "owner connection gone" leak
   * detector, which needs `ownerClientId` to cross-reference against
   * currently-connected WS clients — a fact this file has no notion of on
   * its own (`ws-handlers.ts`'s `conns` map owns that).
   */
  allGroups(): Array<{ id: string; ownerClientId: string; memberCount: number }>
  /**
   * Farm-wide dispatch stats (plan 91 §4.10, §5 step 91.10, tests H4):
   * `fanoutMsP50`/`fanoutMsP95` sample the wall-clock duration of one
   * `dispatch` call's own `Promise.all` (§3.8's "N devices complete in
   * roughly the duration of the slowest single action" claim, made
   * measurable) — bounded the same way `input-arbiter.ts`'s own
   * `waitMsP50`/`waitMsP95` are, and computed with the SAME percentile
   * function, duplicated here for the same reason `mapNormToDevice` already
   * is in this file (importing across the `ws-handlers.ts` ⇄ `group.ts`
   * boundary the other way would be circular).
   */
  stats(): { groups: number; members: number; fanoutMsP50: number; fanoutMsP95: number }
}

const POINTER_VERBS = new Set(['tap', 'swipe', 'gesture'])

/** Which arbiter lane a mirror action's verb runs on (plan 91 §3.3, §5 step 91.10) — mirrors `input-arbiter.ts`'s own lane split (tap/swipe/gesture → `pointer`, key → `keys`, text → `text`), duplicated here for the SAME "a wire message owns its own vocabulary" reasoning `ws-handlers.ts`'s identical helper already applies, just for the E_INPUT_BUSY warn's own lane name. */
function laneForVerb(verb: MirrorAction['verb']): 'pointer' | 'keys' | 'text' {
  if (verb === 'key') return 'keys'
  if (verb === 'text') return 'text'
  return 'pointer'
}

/** Bounds the fan-out latency sample buffer (plan 91 §4.10, §5 step 91.10) — the same cap `input-arbiter.ts`'s own `MAX_WAIT_SAMPLES` uses, so `stats()` stays cheap forever on a long-lived group. */
const MAX_FANOUT_SAMPLES = 500

/** Duplicated from `input-arbiter.ts`'s own private `percentile` — a four-line pure function, not shared state, the same reasoning `co-control.ts` already gives for duplicating `lease-manager.ts`'s private `defaultResolveLabel`. */
function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0
  const sorted = [...samples].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length))
  return sorted[idx] ?? 0
}

/**
 * Rate-limits the `E_INPUT_BUSY` warn (plan 91 §5 step 91.10) — a mirrored
 * gesture held down across a busy member would otherwise refuse, and log,
 * once per fanned-out action; one line per (group, device) every
 * `WARN_WINDOW_MS` says "this is still happening" without flooding the log,
 * the same shape `util/slow-log.ts`'s `createSlowLogger` already uses for
 * slow commands (duplicated rather than imported: that helper gates on a
 * duration threshold, not "once per key", a different enough contract that
 * reusing it would need a fake threshold of `-Infinity` to always fire).
 */
const WARN_WINDOW_MS = 10_000

/**
 * Normalised 0..1 → device pixels, using THIS device's own live frame size
 * (F9) — deliberately duplicated from `ws-handlers.ts`'s identical helper
 * rather than imported: that file imports `MirrorManager` (a type) from
 * THIS one for `WsHandlerDeps`, so importing a value the other direction
 * would be a real circular module dependency, not merely inconvenient. The
 * same reasoning `co-control.ts` already gives for duplicating
 * `lease-manager.ts`'s private `defaultResolveLabel` rather than exporting
 * it across a module boundary for a four-line pure function.
 */
function mapNormToDevice(pos: { x: number; y: number }, frame: { width: number; height: number }): Point {
  const clamp = (v: number, max: number) => Math.min(Math.max(max, 0), Math.max(0, v))
  return {
    x: clamp(Math.round(pos.x * frame.width), frame.width - 1),
    y: clamp(Math.round(pos.y * frame.height), frame.height - 1),
  }
}

/** §3.7: orientation from a live frame size, defaulting to portrait/1 when the size is unknown (a session that has not produced a frame yet) — an honest neutral rather than a guess that would wrongly flag every landscape member. */
function geometryOf(frameSize: { width: number; height: number } | undefined): { orientation: 'portrait' | 'landscape'; aspect: number } {
  const w = frameSize?.width ?? 0
  const h = frameSize?.height ?? 0
  if (w <= 0 || h <= 0) return { orientation: 'portrait', aspect: 1 }
  return { orientation: w > h ? 'landscape' : 'portrait', aspect: Math.max(w, h) / Math.min(w, h) }
}

/** The SAME extraction `ws-handlers.ts`'s own outer catch uses — a `mirror.start`/`dispatch` refusal names the identical code a single-device caller would already get for the same underlying refusal (`assist_taken`, `device_busy_job`, `E_INPUT_BUSY`, ...). */
function codeOf(err: unknown): string {
  return err instanceof Error && 'code' in err ? String((err as { code: unknown }).code) : 'E_INTERNAL'
}

interface ResolveCtx {
  deviceId: string
  ownerClientId: string
  ownerUserId: string | null
  focusGeometry: { orientation: 'portrait' | 'landscape'; aspect: number }
}

interface Resolved {
  mode: MirrorMember['mode']
  reason: string | null
  aspectDrift: boolean
}

/**
 * The §3.9 resolution table, for exactly one device. Called both by `start`
 * (building each member before the group even exists) and by `reconcile`
 * (re-deriving one member of an already-running group) — the two are
 * deliberately the SAME function, so re-admitting a device after its
 * `internal:install` job ends can only ever grant what a fresh
 * `mirror.start` on that one device would. Idempotent by construction:
 * `leases.acquireManual` and `coControl.grant` both treat a re-request from
 * the SAME (deviceId, clientId) as a TTL refresh, not a second acquisition,
 * so calling this again for an already-resolved member is harmless.
 */
function resolveOne(deps: MirrorManagerDeps, ctx: ResolveCtx): Resolved {
  const { deviceId, ownerClientId, ownerUserId, focusGeometry } = ctx

  const nodeId = deps.nodeIdFor?.(deviceId) ?? null
  if (nodeId) return { mode: 'skipped', reason: 'node_owned', aspectDrift: false }

  const status = deps.states.current(deviceId)
  let kind: 'lease' | 'assist'

  if (status === 'idle' || (status === 'manual' && deps.leases.getLease(deviceId)?.holder === ownerClientId)) {
    // idle → an ordinary manual lease; manual-held-by-this-same-client → the
    // lease they already have (§3.9's first two rows). `acquireManual`
    // itself is what tells the two apart internally (its own fast-path
    // refresh for an already-matching holder) — never `takeOverFrom` (§3.10).
    try {
      deps.leases.acquireManual(deviceId, ownerClientId, ownerUserId)
      kind = 'lease'
    } catch (err) {
      return { mode: 'skipped', reason: codeOf(err), aspectDrift: false }
    }
  } else if (status === 'manual' || status === 'busy') {
    // manual, held by someone else, or busy (a job) — a co-control grant,
    // after the group confirmation the caller already showed (§3.9's next
    // two rows). F27: a `busy` device running `internal:install` gets
    // nothing, and rejoins on its own once `reconcile` sees the job end.
    if (status === 'busy') {
      const lease = deps.leases.getLease(deviceId)
      const jobId = lease?.type === 'job' ? lease.holder : null
      const job = jobId ? deps.jobs.get(jobId) : null
      if (job?.scriptId === 'internal:install') {
        return { mode: 'skipped', reason: 'installing', aspectDrift: false }
      }
    }
    if (!deps.assistAllowedFor(ownerUserId)) {
      return { mode: 'skipped', reason: 'assist_not_allowed', aspectDrift: false }
    }
    try {
      deps.coControl.grant(deviceId, ownerClientId, ownerUserId)
      kind = 'assist'
    } catch (err) {
      return { mode: 'skipped', reason: codeOf(err), aspectDrift: false }
    }
  } else {
    // offline, quarantined, or the device does not exist at all — nothing to be subordinate to.
    return { mode: 'skipped', reason: 'unavailable', aspectDrift: false }
  }

  // §3.7: orientation is a GATE (downgrades an already-authorized member to
  // `partial`), aspect drift is a FLAG (never blocks). Both compare against
  // the group's frozen `focusGeometry`, never a live re-read of the focus
  // device — every member is judged against the same reference all group long.
  const session = deps.sessions()?.get(deviceId) ?? null
  const geom = geometryOf(session?.frameSize)
  const aspectDrift = Math.abs(geom.aspect - focusGeometry.aspect) > deps.config.aspectTolerance()

  if (deps.config.requireSameOrientation() && geom.orientation !== focusGeometry.orientation) {
    return { mode: 'partial', reason: 'orientation_mismatch', aspectDrift }
  }
  return { mode: kind, reason: null, aspectDrift }
}

/**
 * The `device_events` `(kind, meta)` pair for one delivered mirror action —
 * deliberately the same `kind` strings and meta shapes the single-device
 * `input.*` branch already records (`ws-handlers.ts`), so `DeviceLog.tsx`'s
 * existing per-kind `summarize()` renders a mirrored row exactly like an
 * ordinary one, plus `mirrored: true`/`groupId` naming what made it happen.
 * `input.text` is always redacted here (never the literal string): this file
 * has no per-device `logInputText` accessor threaded through it, and a
 * redacted default is the fail-safe one.
 */
function inputEventFor(action: MirrorAction, session: DeviceSession): { kind: string; meta: Record<string, unknown> } {
  switch (action.verb) {
    case 'tap': {
      const p = mapNormToDevice(action.pos, session.frameSize)
      return { kind: 'input.tap', meta: { x: p.x, y: p.y, w: session.frameSize.width, h: session.frameSize.height } }
    }
    case 'swipe': {
      const from = mapNormToDevice(action.from, session.frameSize)
      const to = mapNormToDevice(action.to, session.frameSize)
      return { kind: 'input.swipe', meta: { from, to, durationMs: action.durationMs } }
    }
    case 'gesture': {
      const points = action.samples.map((s) => mapNormToDevice(s, session.frameSize))
      const first = action.samples[0]
      const last = action.samples[action.samples.length - 1]
      return {
        kind: 'input.gesture',
        meta: { from: points[0] ?? null, to: points[points.length - 1] ?? null, samples: points.length, durationMs: last && first ? last.atMs - first.atMs : 0 },
      }
    }
    case 'key':
      return { kind: 'input.key', meta: { keycode: action.keycode } }
    case 'text':
      return { kind: 'input.text', meta: { length: action.text.length } }
  }
}

function membersOf(deps: MirrorManagerDeps, group: MirrorGroup): MirrorMember[] {
  return [...group.members.entries()].map(([deviceId, m]) => ({
    deviceId,
    label: deps.deviceLabel(deviceId),
    // Plan 124 §3.7 — the number travels beside the label, never inside it
    // (§3.1). A group is bounded by `mirror.maxDevices` (20 default, 64
    // ceiling), and this runs on every `reconcile`/auto-drop, so the accessor
    // it calls is a keyed lookup, not a scan — see `ws-handlers.ts`, which
    // resolves it through `lookupDeviceNumber`'s indexed `stableId` read.
    number: deps.deviceNumber?.(deviceId) ?? null,
    mode: m.mode,
    reason: m.reason,
    aspectDrift: m.aspectDrift,
  }))
}

/**
 * One fanned-out action, applied to one device (plan 91 §3.7, §3.8). The
 * SAME per-device sequence the single-device `input.*` branch in
 * `ws-handlers.ts` already runs — `mapNormToDevice` against this device's
 * OWN live `frameSize`, then the arbiter facade — so a mirrored tap is
 * mechanically identical to a manual one, just issued by a different caller.
 * Coordinates travel VERBATIM (§3.7 — F8 already does the work): no rotation,
 * no rescaling, the same normalised fraction handed to every member.
 */
async function applyAction(session: DeviceSession, source: InputSource, action: MirrorAction): Promise<void> {
  const sink = session.arbiter.for(source)
  switch (action.verb) {
    case 'tap': {
      const p = mapNormToDevice(action.pos, session.frameSize)
      await sink.tap(p)
      return
    }
    case 'swipe': {
      const from = mapNormToDevice(action.from, session.frameSize)
      const to = mapNormToDevice(action.to, session.frameSize)
      await sink.swipe(from, to, action.durationMs)
      return
    }
    case 'gesture': {
      const samples = action.samples.map((s) => {
        const p = mapNormToDevice(s, session.frameSize)
        return { x: p.x, y: p.y, atMs: s.atMs }
      })
      if (sink.gesture) {
        await sink.gesture(samples)
      } else {
        // The engine cannot curve (AdbInput) — the same honest linear-swipe
        // fallback the single-device path uses, over the trace's endpoints.
        const first = samples[0]
        const last = samples[samples.length - 1]
        if (first && last) await sink.swipe(first, last, Math.max(50, last.atMs - first.atMs))
      }
      return
    }
    case 'key':
      await sink.key(action.keycode)
      return
    case 'text':
      await sink.text(action.text)
      return
  }
}

export function createMirrorManager(deps: MirrorManagerDeps): MirrorManager {
  const groups = new Map<string, MirrorGroup>()
  /** Bounded fan-out latency samples (plan 91 §4.10, §5 step 91.10) — one push per `dispatch` call, read by `stats()`. */
  const fanoutSamples: number[] = []
  /** Rate-limit bookkeeping for the `E_INPUT_BUSY` warn below — per-instance, like `groups`/`fanoutSamples`, so two `createMirrorManager()` calls (e.g. two tests) never share state. */
  const lastInputBusyWarnAt = new Map<string, number>()

  return {
    async start({ ownerClientId, ownerUserId, focusDeviceId, deviceIds }) {
      const uniqueIds = [...new Set(deviceIds)]
      const maxDevices = deps.config.maxDevices()
      if (uniqueIds.length > maxDevices) {
        throw new EnkakuError(
          'mirror_too_many_devices',
          `a mirror may drive at most ${maxDevices} devices at once (${uniqueIds.length} requested)`,
        )
      }

      const focusSession = deps.sessions()?.get(focusDeviceId) ?? null
      const focusGeometry = geometryOf(focusSession?.frameSize)

      const members = new Map<string, MemberState>()
      for (const deviceId of uniqueIds) {
        const resolved = resolveOne(deps, { deviceId, ownerClientId, ownerUserId, focusGeometry })
        members.set(deviceId, { ...resolved, consecutiveFailures: 0 })
      }

      const group: MirrorGroup = { id: crypto.randomUUID(), ownerClientId, ownerUserId, focusDeviceId, members, focusGeometry }
      groups.set(group.id, group)
      deps.log.info(`mirror group started: id=${group.id} owner=${ownerClientId} focus=${focusDeviceId} requested=${uniqueIds.length}`)
      return { group, members: membersOf(deps, group) }
    },

    stop(groupId, ownerClientId) {
      const group = groups.get(groupId)
      if (!group || group.ownerClientId !== ownerClientId) return
      groups.delete(groupId)
      deps.log.info(`mirror group stopped: id=${groupId} owner=${ownerClientId}`)
    },

    stopAllForClient(clientId) {
      for (const [groupId, group] of [...groups]) {
        if (group.ownerClientId === clientId) groups.delete(groupId)
      }
    },

    async dispatch(groupId, ownerClientId, action, soloDeviceId) {
      const group = groups.get(groupId)
      if (!group || group.ownerClientId !== ownerClientId) {
        throw new EnkakuError('mirror_not_found', 'no such mirror group')
      }
      if (soloDeviceId !== undefined && !group.members.has(soloDeviceId)) {
        throw new EnkakuError('mirror_not_found', 'that device is not a member of this mirror group')
      }

      const targets = soloDeviceId !== undefined ? [soloDeviceId] : [...group.members.keys()]
      const sessionMgr = deps.sessions()
      let anyDropped = false
      // Plan 91 §4.10, §5 step 91.10 (tests H4) — the whole batch's own
      // wall-clock duration, sampled once per `dispatch` call regardless of
      // target count, feeding `stats().fanoutMsP50/P95`.
      const dispatchStarted = Date.now()

      // `Promise.all` over independent per-device sockets (§3.8, §4.7) — 20
      // devices complete in roughly the duration of the slowest single
      // action, not 20× it. Every branch below returns a `MirrorResult`, so
      // a member that could not be reached is reported, never omitted.
      const results = await Promise.all(
        targets.map(async (deviceId): Promise<MirrorResult> => {
          const m = group.members.get(deviceId)
          if (!m || m.mode === 'skipped') {
            return { deviceId, ok: false, code: m?.reason ?? 'not_a_member', latencyMs: 0 }
          }
          // §3.7's per-lane gate: a rotated member withholds POINTER actions
          // only. Keys and text carry no geometry and always go through —
          // the owner's own Home-button example (§0.3).
          if (m.mode === 'partial' && POINTER_VERBS.has(action.verb)) {
            return { deviceId, ok: false, code: 'orientation_mismatch', latencyMs: 0 }
          }
          const session = sessionMgr?.get(deviceId) ?? null
          if (!session) return { deviceId, ok: false, code: 'E_DEVICE_NOT_READY', latencyMs: 0 }

          const source: InputSource = { kind: m.mode === 'lease' ? 'lease' : 'assist', id: group.ownerClientId, userId: group.ownerUserId }
          const started = Date.now()
          try {
            await applyAction(session, source, action)
            m.consecutiveFailures = 0
            // Keep the underlying authorization alive across a long mirror
            // session — the same TTL-refresh-on-activity the single-device
            // `input.*` branch already gives `touchManual`/`coControl.touch`.
            if (source.kind === 'assist') deps.coControl.touch(deviceId, group.ownerClientId)
            else deps.leases.touchManual(deviceId, group.ownerClientId)
            // Plan 91 §3.5, §5 step 91.5 — attribution, PER DEVICE (see
            // `MirrorManagerDeps.recorder`'s own doc comment for why an
            // aggregate row was rejected). Recorded on DELIVERY SUCCESS —
            // deliberately later than the single-device `input.*` branch's
            // "record before awaiting" rule (plan 18 §18.5), because THAT
            // rule exists to keep a REFUSED action off the log; here the
            // authorization was already established at `start`/`reconcile`
            // and `dispatch` trusts it (this file's own header comment), so
            // the only thing left to report honestly is whether the action
            // actually reached the device — which a member stuck on
            // `E_DEVICE_NOT_READY` never did.
            const { kind, meta } = inputEventFor(action, session)
            const assistJobId =
              source.kind === 'assist'
                ? (() => {
                    const lease = deps.leases.getLease(deviceId)
                    return lease?.type === 'job' ? lease.holder : null
                  })()
                : null
            deps.recorder.record({
              deviceId,
              stream: 'input',
              kind,
              actor: group.ownerUserId,
              meta: { ...meta, mirrored: true, groupId: group.id, ...(assistJobId ? { assist: true, jobId: assistJobId } : {}) },
            })
            if (assistJobId) deps.incrementAssistCount(assistJobId)
            return { deviceId, ok: true, code: null, latencyMs: Date.now() - started }
          } catch (err) {
            m.consecutiveFailures++
            if (m.consecutiveFailures >= deps.config.dropAfterConsecutiveFailures()) {
              // Auto-drop (§3.9): continuing to "send" to a device that is
              // not receiving is exactly the silence this plan removes.
              m.mode = 'skipped'
              m.reason = 'repeated_failures'
              m.consecutiveFailures = 0
              anyDropped = true
            }
            const code = codeOf(err)
            if (code === 'E_INPUT_BUSY') {
              // Plan 91 §5 step 91.10 — rate-limited: an operator holding a
              // gesture down against a busy member would otherwise refuse,
              // and log, once per fanned-out action.
              const key = `${group.id}:${deviceId}:${laneForVerb(action.verb)}`
              const now = Date.now()
              const last = lastInputBusyWarnAt.get(key) ?? 0
              if (now - last >= WARN_WINDOW_MS) {
                lastInputBusyWarnAt.set(key, now)
                const message = err instanceof Error ? err.message : String(err)
                deps.log.warn(
                  `mirror dispatch refused E_INPUT_BUSY: group=${group.id} device=${deviceId} lane=${laneForVerb(action.verb)} — ${message}`,
                )
              }
            }
            return { deviceId, ok: false, code, latencyMs: Date.now() - started }
          }
        }),
      )
      fanoutSamples.push(Date.now() - dispatchStarted)
      if (fanoutSamples.length > MAX_FANOUT_SAMPLES) fanoutSamples.shift()

      // One `mirror.changed` for the whole batch, even if several members
      // dropped from the SAME action — never one push per drop.
      if (anyDropped) deps.onChanged?.(group, membersOf(deps, group))
      return results
    },

    reconcile(deviceId) {
      for (const group of groups.values()) {
        const m = group.members.get(deviceId)
        if (!m) continue
        const resolved = resolveOne(deps, {
          deviceId,
          ownerClientId: group.ownerClientId,
          ownerUserId: group.ownerUserId,
          focusGeometry: group.focusGeometry,
        })
        const changed = resolved.mode !== m.mode || resolved.reason !== m.reason || resolved.aspectDrift !== m.aspectDrift
        if (!changed) continue
        m.mode = resolved.mode
        m.reason = resolved.reason
        m.aspectDrift = resolved.aspectDrift
        m.consecutiveFailures = 0
        deps.log.info(
          `mirror member reconciled: group=${group.id} device=${deviceId} mode=${resolved.mode}${resolved.reason ? ` (${resolved.reason})` : ''}`,
        )
        deps.onChanged?.(group, membersOf(deps, group))
      }
    },

    allGroups() {
      return [...groups.values()].map((g) => ({ id: g.id, ownerClientId: g.ownerClientId, memberCount: g.members.size }))
    },

    stats() {
      let members = 0
      for (const g of groups.values()) members += g.members.size
      return {
        groups: groups.size,
        members,
        fanoutMsP50: percentile(fanoutSamples, 0.5),
        fanoutMsP95: percentile(fanoutSamples, 0.95),
      }
    },
  }
}
