import type { ServerWebSocket } from 'bun'
import type { AdbClient } from '@enkaku/adb'
import { engineDescriptors } from '@enkaku/drivers'
import { eq, sql } from 'drizzle-orm'
import {
  ClientMessageSchema,
  encodeSnapshot,
  encodeVideoFrame,
  KEYCODES,
  type ArtifactInfo,
  type CoControlMode,
  type DeviceEvent,
  type DeviceEventStream,
  type FrameMeta,
  type GestureSample,
  type MirrorSettings,
  type Point,
  type Quality,
  type ServerMessage,
  type ShellMode,
  type Viewer,
} from '@enkaku/protocol'
import type { PairingService } from '../enroll/pairing'
import type { AdbEndpointManager } from '../device/adb-endpoint'
import type { LeaseManager } from '../lease/lease-manager'
import type { CoControlManager } from '../lease/co-control'
import type { Hold, ReadinessManager } from '../device/readiness'
import { DEFAULT_TIMING, resolveTextRoute, SessionError, type DeviceSession, type InputLane, type InputSource, type SessionManager } from '@enkaku/session'
import type { JobService } from '../services/job-service'
import type { AuditLogger } from '../auth/audit'
import type { EventRecorder } from '../events/recorder'
import type { RecordingService } from '../recording/service'
import type { CommandRunStore } from '../command-console/store'
import type { Db } from '../db'
import { devices, jobs } from '../db/schema'
import { canAssist, canCancelJob, canUseDevice, canUseShell } from '../auth/acl'
import type { Role } from '../auth/service'
import type { DeviceStateMachine } from '../device/state-machine'
import { createMonitorHub, runOneshotMonitor } from '../device/monitor-hub'
import { createCrashWatcher, type CrashPolicy } from '../device/crash-watcher'
import { createLocalShellPort, createRemoteShellPort, type ShellPort } from '../device/shell-port'
import { createShellSessionStore } from '../device/shell-session'
import { redactShellCommand } from '../device/redact'
import { createMirrorManager } from '../mirror/group'
import { lookupDeviceNumber } from '../registry/device-number'
import type { TunnelRouter } from '../tunnel/router'
import type { TunnelRpc } from '../tunnel/rpc'
import { EnkakuError } from '../util/errors'
import type { Logger } from '../util/logger'
import { createSlowLogger } from '../util/slow-log'
import type { AgentWsHandler } from './ws-handlers-agent'
import { createTransportMetricsStore, type TransportSnapshot } from './transport-metrics'

/** Timeout-shaped error codes (plan 26 §3.6): a command that hit its
 * deadline is reported with the `stream_suggested` hint, whether the local
 * `AdbClient` timed it out directly (`E_ADB_TIMEOUT`) or the tunnel RPC gave
 * up waiting on a node (`E_NODE_TIMEOUT`, plan 25 §4.1). */
const DEADLINE_ERROR_CODES = new Set(['E_ADB_TIMEOUT', 'E_NODE_TIMEOUT'])

/**
 * Backpressure limit: past this, frames are dropped (only the newest one
 * matters). Dropped from 4MB to 512KB by plan 85 §3.6, §4.6 (tests H1) —
 * video already backs off correctly and requests a keyframe on its own; the
 * only thing the old 4MB bought was a deeper queue of already-buffered H.264
 * sitting in front of every control reply on the SAME socket (F15).
 *
 * Exported (plan 93 §3.6, H2, step 93.4) so `shell.fanoutPreviewBytes`'s Zod
 * bound (`@enkaku/protocol`'s `settings.ts`) can be asserted against the
 * REAL number in a unit test, rather than a hand-copied duplicate that can
 * drift out of step with this one silently — see
 * `ws-handlers-command.test.ts`.
 */
export const MAX_BUFFERED = 512 * 1024

/** The Inspect tab's `dump`/`find` deadline (plan 56 §4.2 step 5, acceptance #9) — `ui-server` targets well under this; `uiautomator-dump` can legitimately take 1-2s, so this is generous, not tight. */
const INSPECT_DEADLINE_MS = 20_000
/**
 * The attach deadline, separate from `INSPECT_DEADLINE_MS` above and
 * deliberately larger (field report, 2026-08-26).
 *
 * `session.whenInspectorReady()` used to be awaited with NO deadline at all,
 * while every other inspect operation was bounded. On a 20-device farm the
 * ui-server cold start was measured at **32 s** (`control.acquired` 03:44:44 →
 * `inspect.attached` 03:45:16), which is longer than Studio's own 25 s WS
 * request budget: the browser gave up and painted a bare "timeout" while the
 * core went on to attach successfully seven seconds later. The inspector was
 * working; nothing ever told the page so, and nothing was recorded.
 *
 * Bounded, so the await can never hang forever. Larger than a dump's budget,
 * because starting the engine is genuinely slower than using it — a cold
 * ui-server has to be pushed, spawned and polled before its first reply.
 * Studio pairs this with a slightly LONGER client budget on the attach
 * request specifically (`InspectorPanel.tsx`), so the core's own reason
 * always arrives before the client stops listening — a timeout that explains
 * itself beats one that does not.
 */
const INSPECT_ATTACH_DEADLINE_MS = 45_000

/** Races `promise` against a timer, rejecting with a coded `EnkakuError` rather than hanging forever (plan 56 §4.2 step 5). */
function withDeadline<T>(promise: Promise<T>, ms: number, code: string, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new EnkakuError(code, message)), ms)
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

/** `EngineDescriptor.capabilities` for an inspector engine id, or `[]` for one the registry does not know (plan 56 §4.2 step 4). */
function inspectorCapabilities(engineId: string): string[] {
  return engineDescriptors.find((d) => d.kind === 'inspector' && d.id === engineId)?.capabilities ?? []
}

/** Numeric keycode → its symbolic name, when one exists (plan 18 §4.2, input.key meta). */
const KEYCODE_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(KEYCODES).map(([name, code]) => [code, name]),
)

/**
 * `GET /api/adb/stats`'s `input` block (plan 91 §4.10, §5 step 91.10, tests
 * H2/H4) — `daemon.ts` wires `inputStats()` (below, on the returned object)
 * into `createAdbStatsRoutes` through the same forward-ref pattern
 * `transportStats()` already uses. Fields beyond §4.10's own literal
 * pseudocode (`queueWaitMs`, `uncollectedGrants`, `orphanedMirrorGroups`)
 * are this step's own extension, documented at `inputStats()` itself.
 */
export interface InputStatsBlock {
  lanes: Record<InputLane, { depth: number; waitMsP50: number; waitMsP95: number; refusals: number }>
  assistsActive: number
  mirrorGroups: number
  mirrorMembers: number
  mirrorFanoutMsP50: number
  mirrorFanoutMsP95: number
  /** The farm's currently-configured `coControl.queueWaitMs` (plan 91 §4.5) — reported beside the OBSERVED `lanes[*].waitMsP95` so the `co-control` doctor check's "p95 over half the budget" comparison reads both numbers from the same live farm rather than a second fetch. */
  queueWaitMs: number
  /** Grants whose `expiresAt` is more than `UNCOLLECTED_GRANT_GRACE_SEC` in the past (`co-control.ts`'s `rawGrantSnapshot()`) — a leak: the reaper (or a lazy prune) should have collected these already. */
  uncollectedGrants: number
  /** Mirror groups (`mirror.ts`'s `allGroups()`) whose `ownerClientId` no longer matches any currently-open WS connection — a leak: `stopAllForClient` should have ended these on WS close. */
  orphanedMirrorGroups: number
}

/** Which arbiter lane an `input.*` message type runs on (plan 91 §3.3, §5 step 91.10) — mirrors `input-arbiter.ts`'s own split, duplicated here (not imported) for the same "a caller owns its own naming" reasoning `mirror/group.ts`'s identical helper already documents; used only to name the lane in the rate-limited E_INPUT_BUSY warn below. */
function laneForInputType(type: string): InputLane {
  if (type === 'input.key') return 'keys'
  if (type === 'input.text') return 'text'
  return 'pointer'
}

/** Rate-limit window for the E_INPUT_BUSY warn (plan 91 §5 step 91.10) — an operator holding a finger on a busy device refuses every ~40-120ms tap identically; one line per (device, lane) every this-many-ms says "still happening" without flooding the log, the same "once per key per window" shape `util/slow-log.ts`'s `createSlowLogger` already uses for slow commands (duplicated rather than reused: that helper gates on a duration threshold, a different contract). */
const INPUT_BUSY_WARN_WINDOW_MS = 10_000

/** Grace period past a grant's own `expiresAt`, in seconds, before the co-control doctor check calls it "uncollected" (plan 91 §5 step 91.10) — comfortably beyond the reaper's default 5s sweep interval, so this only ever fires when the reaper genuinely is not collecting, never on an ordinary sweep-timing race. */
const UNCOLLECTED_GRANT_GRACE_SEC = 30

/** Reported as `input.queueWaitMs` when `deps.coControlQueueWaitMs` is not wired (plan 91 §5 step 91.10) — matches `input-arbiter.ts`'s own `DEFAULT_ARBITER_QUEUE_WAIT_MS`/`session.ts`'s stand-in default, so an unwired host reports the same number the arbiter itself actually falls back to. */
const DEFAULT_QUEUE_WAIT_MS = 5_000

const sha256Hex = (s: string): string => new Bun.CryptoHasher('sha256').update(s).digest('hex')

/**
 * The `input.text` meta (plan 18 §3.4). Off by default: `input.text` carries
 * whatever the operator typed, which routinely includes passwords and
 * one-time codes, so the literal string is stored ONLY when the device's
 * `logInputText` setting has been explicitly turned on. Pulled out as a pure
 * function so this exact contract — never a bare `text` key unless asked for
 * — is unit-testable without a whole WS handler and session stack.
 */
export function redactInputText(text: string, storeLiteral: boolean): { length: number; text: string } | { length: number; sha256Prefix: string } {
  return storeLiteral ? { length: text.length, text } : { length: text.length, sha256Prefix: sha256Hex(text).slice(0, 16) }
}

/** Normalised 0..1 → device pixels, using the LATEST frame dimensions (rotation). */
export function mapNormToDevice(pos: { x: number; y: number }, frame: { width: number; height: number }): Point {
  const clamp = (v: number, max: number) => Math.min(Math.max(max, 0), Math.max(0, v))
  return {
    x: clamp(Math.round(pos.x * frame.width), frame.width - 1),
    y: clamp(Math.round(pos.y * frame.height), frame.height - 1),
  }
}

interface StreamBinding {
  streamId: number
  deviceId: string
  remote?: boolean
  onFrame: (chunk: Uint8Array, meta: FrameMeta) => void
  /**
   * Plan 100 §4.2, §5 step 100.5 — the quality THIS binding is actually
   * showing (which can be `wall` even for a `control` request, see
   * `degradedReason` in `stream.started`). Undefined only for the brief
   * window between binding creation and `acquire` resolving; set before the
   * binding is ever stored in `state.streams`. Read later (congestion
   * keyframe requests) so a lookup always reaches the SAME entry this
   * viewer is subscribed to — `SessionManager.get(deviceId)` alone would
   * now resolve the wrong slot whenever the other quality is also open.
   */
  quality?: Quality
  lastSize: { width: number; height: number }
  /** Unix seconds — when this binding was created (plan 31 §4.1 Viewer.since). */
  since: number
  /** Readiness hold for this viewer (plan 43 §3.7 table, §5 step 43.7) — local devices only. */
  readinessHold?: Hold
  /**
   * Set while an H.264 stream recovers from congestion: everything is dropped
   * until a keyframe arrives, because a delta that references frames the
   * viewer never received produces a corrupt picture, not a late one.
   */
  awaitingKeyframe?: boolean
}

/** Per-connection WS state: the clientId and the streams this connection owns. */
interface ConnState {
  clientId: string
  /** The authenticated user, when known — null in local mode's implicit-admin
   * edge cases and for connections established before auth was wired through. */
  userId: string | null
  streams: Map<number, StreamBinding>
  nextStreamId: number
  /** Device event log subscriptions (plan 18 §3.6, §4.6): deviceId → streams. */
  logSubs: Map<string, Set<DeviceEventStream>>
  /** Monitor stream subscriptions this connection holds (plan 24 §4.4) — released on close. */
  monitorSubs: Set<string>
  /**
   * Devices this connection has run `shell.exec` against (plan 26 §4.4) —
   * used only to reset the emulated cwd on WS close. Reaching `shell.exec`
   * at all requires holding the manual lease (`checkInputAllowed`), so a
   * disconnect here really is "the lease holder went away", the same case
   * `LeaseManager.releaseAllForClient` handles for the lease itself.
   */
  shellDevices: Set<string>
  /** Devices this connection currently holds an `inspect.attach` on (plan 56 §3.2) — used to release its share of the ref count on `inspect.detach`, WS close, or a second attach being a harmless no-op. */
  inspectAttached: Set<string>
  /**
   * Command-run ids this connection subscribed to (plan 93 §3.17, §4.3, step
   * 93.4) — `command.subscribe`/`command.unsubscribe`. Subscriber-scoped,
   * deliberately unlike `transfer.progress`/`transfer.done` (F27): a fleet
   * command's output can contain anything a device prints, so
   * `commandTargets(runId)` below fans out only to connections that asked
   * for THIS run, never farm-wide.
   */
  commandSubs: Set<string>
}

/**
 * Plan 40 §4.6's `input.gesture` needs a `gesture` member on this shape too,
 * so the manual-control handler below can treat a local `DeviceSession` and
 * a node-owned remote session identically. It stays OPTIONAL and undefined
 * here on purpose: the cloud tunnel does not carry curved gestures yet (out
 * of scope for this plan — Plan 08/M9 own the input engine wiring for
 * node-owned devices), so a remote session always falls back to a linear
 * swipe, the same honest-absence contract `InputSink.gesture` uses locally.
 */
interface RemoteInput {
  tap(p: Point): Promise<void>
  swipe(f: Point, t: Point, ms: number): Promise<void>
  key(c: number): Promise<void>
  text(s: string): Promise<void>
  gesture?(samples: GestureSample[]): Promise<void>
}

export interface RemoteSessions {
  nodeIdFor(deviceId: string): string | null
  acquire(deviceId: string, onFrame: (chunk: Uint8Array, meta: FrameMeta) => void): Promise<{
    frameSize: { width: number; height: number }
    codec: 'png' | 'h264'
    input: RemoteInput
  }>
  release(deviceId: string, onFrame: (chunk: Uint8Array, meta: FrameMeta) => void): void
  get(deviceId: string): { frameSize: { width: number; height: number }; input: RemoteInput } | null
}

export interface WsHandlerDeps {
  /** null under the orchestrator: the control plane holds no local devices. */
  sessions: SessionManager | null
  /** Sessions for node-owned devices (cloud mode); null in pure local mode. */
  remote?: RemoteSessions
  pairing: PairingService
  leases: LeaseManager
  jobs: JobService
  /** For the Monitor tab (plan 24 §4.4) — local devices only; a null accessor means "not ready yet". */
  adb: () => AdbClient | null
  /** Correlated tunnel request/response (plan 25 §4.1) — undefined in pure local mode, same as `remote`. */
  rpc?: TunnelRpc
  /** The tunnel's channel allocation (plan 25 §4.5) — paired with `rpc` for the remote `ShellPort`. */
  router?: TunnelRouter
  db: Db
  /** Fan a message out to every connected client, not just the sender. */
  broadcast: (msg: ServerMessage) => void
  /** Device event log (plan 18 §4.3) — buffered; never awaited on the input path. */
  recorder: EventRecorder
  /** Security audit trail — control.acquired / control.revoked also land here (plan 18 §3.2, §18.4). */
  audit: AuditLogger
  /** DeviceSettings.logInputText, read fresh on every input.text (plan 18 §3.4). */
  isLogInputTextEnabled: (deviceId: string) => boolean
  /**
   * A device's tap hold-duration range (plan 94 §4.4, closes F5) — read
   * fresh on every manual `input.tap` that carries no `holdMs` of its own,
   * the same freshness discipline `isLogInputTextEnabled` above already
   * gives its own per-device setting. This is the SAME range the script path
   * already gets from `TimingSettings.tapJitterMs` (`device-executor.ts`) —
   * before this plan, a manual tap and a scripted tap silently disagreed
   * about hold duration (F5) because nothing here read it at all.
   *
   * Optional, the same "omitted means the shipped default" convention every
   * other settings accessor in this file uses (`mirrorSettings`,
   * `coControlMode`, …); omitted falls back to `DEFAULT_TIMING.tapJitterMs`.
   * Making this genuinely PER-DEVICE (F36: today only the farm default is
   * read anywhere in production) is `daemon.ts`'s wiring to do — outside
   * this step's file list — so a host that has not wired it yet gets the
   * farm-wide default rather than a compile error or a crash.
   */
  tapJitterMs?: (deviceId: string) => [number, number]
  /**
   * The authenticated user's ACL role, resolved fresh on every `shell.exec`
   * (plan 26 §4.1, §4.3) — never cached on `ConnState`, so a role change
   * takes effect on the connection's very next command, the same freshness
   * guarantee `isLogInputTextEnabled` gives `logInputText`.
   */
  roleOf: (userId: string | null) => Role
  /**
   * `canUseDevice`'s device half (plan 34 §3.5, §4.4) — `lease.acquire`'s
   * ownership check. Optional so an existing test harness (or a host that
   * has not wired auth) keeps compiling unchanged; omitting it means "no
   * ownership check", the same default every other optional ACL dep here uses.
   */
  getDeviceOwner?: (deviceId: string) => { ownerId: string | null } | null
  /** The farm's `shell` settings block, read fresh on every `shell.exec` (plan 26 §4.1). */
  shellSettings: () => { mode: ShellMode; execTimeoutMs: number; maxOutputBytes: number }
  /**
   * Plan 93 §3.3, §3.17, step 93.5 — "a single-device terminal command is a
   * run with ONE member — there is one history, not two". `shell.exec`
   * writes through this the SAME way the runner (`command-console/runner.ts`)
   * does, so `/console`'s History lists both without a merge step. Optional
   * so every existing test harness that builds `WsHandlerDeps` by hand keeps
   * compiling unchanged; omitting it means a command still runs and still
   * broadcasts exactly as before, it just is not added to command history —
   * never a refusal, and never a change to the transport, the transcript
   * broadcast, the cwd emulation, or the `device_events` rows (unchanged
   * per this step's brief).
   */
  commandRunStore?: CommandRunStore
  /** The lease-scoped adb endpoint (plan 27 §4.2) — torn down on an explicit `lease.release` below and on WS disconnect (`handleClose`). */
  adbEndpoint: AdbEndpointManager
  /**
   * Device readiness (plan 43 §5 step 43.7) — `stream.start` and
   * `lease.acquire` each take a hold before proceeding, local devices only.
   * Optional so tests/hosts (and orchestrator mode, which has no local
   * readiness manager at all) that do not wire it keep working unchanged.
   */
  readiness?: Pick<ReadinessManager, 'hold' | 'set'>
  /** `transfer.cancel` (plan 39 §4.4, acceptance #9) — undefined only in tests that do not wire file transfer. */
  transfer?: { cancel(transferId: string): void }
  /**
   * A human-readable label for an authenticated user (plan 31 §3.3, §4.1) —
   * null in local mode (one implicit admin: the UI falls back to the session
   * id) and whenever the user cannot be resolved. Optional so existing
   * callers (and tests) do not need to wire it up.
   */
  userLabel?: (userId: string | null) => string | null
  /**
   * Crash detection (plan 37 §4.3, §4.4) — always on for any device with an
   * active session, independent of the Monitor tab or any of the deps
   * above. `crashPolicy`/`targetPackagesForJob` are read fresh per crash,
   * the same freshness guarantee `shellSettings`/`isLogInputTextEnabled`
   * already give their own farm settings.
   */
  crashPolicy: () => CrashPolicy
  /**
   * `monitor.crashWatch` (plan 85 §3.2) — `'off'` trades crash detection for
   * the one stream slot it costs per device, which a 20-device farm may want.
   * Read fresh like `crashPolicy`, so flipping it takes effect without a
   * restart. Optional: a host or test that has not wired plan 85 keeps the
   * `'always'` behaviour that predates it.
   */
  crashWatch?: () => 'always' | 'off'
  /** The `declared` policy's target package set for a running job (plan 37 §3.4) — from `JobRunnerDeps.onTargetPackages`, wired in daemon.ts. */
  targetPackagesForJob: (jobId: string) => string[]
  /** Writes the crash trace as an artifact (plan 37 §3.6) — job-scoped or device-scoped, decided in daemon.ts by whether a jobId is given. */
  saveCrashTrace: (opts: { deviceId: string; jobId: string | null; label: string; text: string }) => Promise<ArtifactInfo>
  /** A crash matched the farm's policy for a running job — abort it (plan 37 §4.4), wired to `ExecutorHost.notifyCrash` in daemon.ts. */
  onJobCrash?: (jobId: string, e: { package: string; exception: string; message: string }) => void
  /** The agent chat protocol's subscribe/unsubscribe/cancel half (plan 66 §3.4, §4.4) — undefined only in a host or test that has not wired Plan 66. */
  agent?: AgentWsHandler
  /**
   * Co-control — Assist (plan 91 §3.2, §4.2, §5 step 91.4). Consulted in
   * exactly two places: the `input.*` fallback (§3.2's pseudocode — after
   * `checkInputAllowed` has already failed) and the `assist.start`/
   * `assist.stop` handlers below. Optional so a host or test that has not
   * wired plan 91 keeps compiling and running unchanged, the same pattern
   * every other optional dep in this file uses: omitted means "co-control
   * does not exist here" — `input.*` never gets a grant to fall back to, and
   * `assist.*` refuses `E_NOT_SUPPORTED`.
   */
  coControl?: CoControlManager
  /**
   * The farm's `coControl.mode` switch (plan 91 §3.6, §4.6), read fresh on
   * every `assist.start` — the same "read settings live" discipline
   * `shellSettings`/`crashPolicy` already give their own farm settings.
   * Optional alongside `coControl`; omitted defaults to `'off'`, the
   * fail-safe reading (assisting is unavailable until both are wired).
   */
  coControlMode?: () => CoControlMode
  /**
   * `coControl.queueWaitMs` (plan 91 §4.5, §5 step 91.10), read fresh —
   * reported on `/api/adb/stats`'s `input.queueWaitMs`, beside the OBSERVED
   * `lanes[*].waitMsP95`, so the `co-control` doctor check's "a lane whose
   * p95 exceeds half the budget" comparison reads both numbers from the
   * same live farm. Optional, the same convention every other settings
   * accessor in this file uses; omitted falls back to
   * `DEFAULT_QUEUE_WAIT_MS` below (the arbiter's own shipped default).
   */
  coControlQueueWaitMs?: () => number
  /**
   * Delivers `{t:'assist', at, actor}` to a running job's child (plan 91
   * §3.6, §4.8, §5 step 91.5) — called from the `input.*` branch below on
   * every ACCEPTED assist action attributed to a job (never on a plain
   * `assist.start`/`assist.stop`, which grants/ends the authorization but is
   * not itself an input action). Optional, wired in `daemon.ts` to
   * `ExecutorHost.notifyAssist`; omitted means a running script simply never
   * learns — the same fail-quiet default `onJobCrash` above uses. **Known
   * gap, flagged rather than silently left**: as of this step `daemon.ts`
   * does not yet pass this — `daemon-wiring.test.ts`'s
   * "createWsMessageHandler(...) passes a live onAssist accessor" test
   * documents the exact wiring still needed and fails until it lands.
   */
  onAssist?: (jobId: string, e: { at: number; actor: string | null }) => void
  /**
   * Raw device status, with no notion of any particular client (plan 91
   * §3.9, §4.7, §5 step 91.7) — `mirror.start`'s resolution table needs to
   * tell `idle`/`manual`/`busy`/`offline`/`quarantined` apart for a device
   * BEFORE deciding who (if anyone) it belongs to, which nothing else in
   * this router does today: every existing caller only ever asks
   * `checkInputAllowed`/`checkAssistAllowed` for a SPECIFIC client. A narrow
   * `Pick`, not the whole `DeviceStateMachine`, matching `leases: Pick<...>`
   * in `co-control.ts`. Optional, the same "omitted means it does not exist
   * here" convention as `coControl` right above — mirroring refuses
   * `E_NOT_SUPPORTED` without it.
   */
  states?: Pick<DeviceStateMachine, 'current'>
  /**
   * `mirror.maxDevices` / `requireSameOrientation` / `aspectTolerance` /
   * `dropAfterConsecutiveFailures` (plan 91 §4.5, §5 step 91.7), read fresh
   * on every `mirror.start`/`input.mirror`, the same freshness discipline
   * `shellSettings`/`crashPolicy` already give their own farm settings.
   * Optional; omitted falls back to the settings block's own shipped
   * defaults (`DEFAULT_MIRROR_SETTINGS` below), so a test/host that has not
   * wired plan 91's settings still gets sane, non-zero bounds rather than
   * `undefined` reaching a `Math` call.
   */
  mirrorSettings?: () => MirrorSettings
  /**
   * The action recorder (plan 94 §4.6, §5 step 94.3) — one active recording
   * per device, keyed by deviceId, owned by whoever holds the manual lease.
   * `recording.start`/`.stop`/`.cancel` are gated by the SAME
   * `checkInputAllowed` gate `input.*` already uses (never a parallel check
   * — this plan's own brief). Optional, the same "omitted means it does not
   * exist here" convention as `coControl`/`states` above: a host or test
   * that has not wired plan 94 gets `E_NOT_SUPPORTED` from `recording.*`,
   * and the `input.*` tee below is a harmless no-op (`deps.recording?.get(...)`).
   */
  recording?: RecordingService
  log: Logger
}

export function createWsMessageHandler(deps: WsHandlerDeps) {
  // A plain Map, not a WeakMap: publishing a device event needs to iterate
  // every connection's subscriptions, which a WeakMap cannot do. `handleClose`
  // deletes the entry explicitly so this cannot grow unbounded.
  const conns = new Map<ServerWebSocket<unknown>, ConnState>()

  // The shared transport's own health (plan 85 §3.6, §4.6, §5 85.7a) —
  // exposed to `/api/adb/stats` through `transportStats()` on the returned
  // object below. `logSlowCommand` is the WS half of the slow-request/
  // slow-command logger (§4.6's last bullet); `http.ts` carries the HTTP half.
  const transportMetrics = createTransportMetricsStore()
  const logSlowCommand = createSlowLogger(deps.log, { thresholdMs: 2000, label: 'ws command' })
  /** Rate-limit bookkeeping for the E_INPUT_BUSY warn (plan 91 §5 step 91.10), keyed `deviceId:lane` — per-router-instance, like `transportMetrics`/`logSlowCommand` above. */
  const lastInputBusyWarnAt = new Map<string, number>()

  /**
   * Plan 203 §4.6: `GET /api/video/latency`'s per-stream counters, keyed
   * `${deviceId}:${quality}`. In-memory, cleared on restart, like
   * `transportMetrics` above. `deviceId`/`quality` are kept on the counters
   * themselves (not re-parsed out of the key) since a device id is never
   * guaranteed free of `:`.
   */
  interface StreamCounters {
    deviceId: string
    quality: Quality
    keyframeRequests: number
    congestionDrops: number
  }
  const streamCounters = new Map<string, StreamCounters>()
  function countersFor(binding: StreamBinding): StreamCounters {
    const quality = binding.quality ?? 'control'
    const key = `${binding.deviceId}:${quality}`
    let counters = streamCounters.get(key)
    if (!counters) {
      counters = { deviceId: binding.deviceId, quality, keyframeRequests: 0, congestionDrops: 0 }
      streamCounters.set(key, counters)
    }
    return counters
  }

  const send = (ws: ServerWebSocket<unknown>, msg: ServerMessage) => ws.send(JSON.stringify(msg))
  /** `action` (plan 90 §3.3, §5 step 90.5) is optional — every existing caller omits it, unchanged. */
  const sendError = (ws: ServerWebSocket<unknown>, code: string, message: string, id?: string, action?: 'install-agent' | 'update-agent') =>
    send(ws, { type: 'error', ...(id ? { id } : {}), payload: { code, message, ...(action ? { action } : {}) } })
  /**
   * Plan 100 §4.2, §5 step 100.5 — the SESSION this specific stream binding
   * is showing, not whichever slot `SessionManager.get(deviceId)` resolves
   * highest-quality-wins to (now potentially the WRONG one, whenever the
   * other quality is also open for the same device). Prefers `getByQuality`
   * when the manager offers it (every production `SessionManager`); falls
   * back to plain `get(deviceId)` for a test/fixture `SessionManager` that
   * only implements that — the pre-100.4 behaviour, unchanged for them.
   */
  const sessionForBinding = (binding: StreamBinding): DeviceSession | null => {
    if (binding.remote) return null
    if (deps.sessions?.getByQuality && binding.quality) return deps.sessions.getByQuality(binding.deviceId, binding.quality)
    return deps.sessions?.get(binding.deviceId) ?? null
  }

  const stateOf = (ws: ServerWebSocket<unknown>): ConnState => {
    let s = conns.get(ws)
    if (!s) {
      const userId = (ws.data as { userId?: string | null } | null)?.userId ?? null
      s = {
        clientId: crypto.randomUUID(),
        userId,
        streams: new Map(),
        nextStreamId: 1,
        logSubs: new Map(),
        monitorSubs: new Set(),
        shellDevices: new Set(),
        inspectAttached: new Set(),
        commandSubs: new Set(),
      }
      conns.set(ws, s)
    }
    return s
  }

  /**
   * Fan `monitor.data`/`monitor.ended`/`monitor.subscribers` out ONLY to
   * connections actually subscribed to that `streamId` (plan 24 §4.4) — the
   * same scoping `publishEvent` uses for the device event log, so a busy
   * logcat never lands on a WS that has nothing to do with it.
   */
  const monitorTargets = (streamId: string): ServerWebSocket<unknown>[] =>
    [...conns.entries()].filter(([ws, s]) => ws.readyState === 1 && s.monitorSubs.has(streamId)).map(([ws]) => ws)

  /**
   * Fan `command.*` out ONLY to connections subscribed to that `runId` (plan
   * 93 §3.17, §4.3, step 93.4) — the SAME scoping shape `monitorTargets`
   * above already gives monitor streams, deliberately UNLIKE
   * `transfer.progress`/`transfer.done` (F27, closed here for this surface):
   * a fleet command's output can contain anything a device prints, so a
   * broadcast would make every open tab a reader of it, and at 100 devices
   * it is also a wire-flooding bug.
   */
  const commandTargets = (runId: string): ServerWebSocket<unknown>[] =>
    [...conns.entries()].filter(([ws, s]) => ws.readyState === 1 && s.commandSubs.has(runId)).map(([ws]) => ws)

  /**
   * Every viewer of a device (plan 26 §3.8) — the terminal transcript is
   * broadcast here. The protocol (§4.2) defines no dedicated
   * subscribe/unsubscribe pair for `shell.echo`/`shell.result` the way
   * monitors have their own (`monitorSubs`), so this reuses TWO EXISTING
   * presence signals instead of inventing a third: a connection with the
   * device's video open (`state.streams`, the Control tab) OR a connection
   * subscribed to this device's event log (`state.logSubs`, plan 18 §3.6 —
   * Studio's terminal component subscribes to the `input` stream purely to
   * register this presence, since `shell.exec`/`shell.result` are recorded
   * there too). Either is a legitimate "has this device open" signal.
   */
  const deviceTargets = (deviceId: string): ServerWebSocket<unknown>[] =>
    [...conns.entries()]
      .filter(
        ([ws, s]) =>
          ws.readyState === 1 &&
          ([...s.streams.values()].some((b) => b.deviceId === deviceId) || s.logSubs.has(deviceId)),
      )
      .map(([ws]) => ws)

  /**
   * `deviceTargets` plus the ACTING connection itself, always — the person
   * who just ran a command must see its own echo/result regardless of
   * whether their tab happens to also carry one of the two presence signals
   * above (e.g. sitting on the Terminal tab alone, video and log tail both
   * closed). De-duplicated via `Set` so a sender who IS also a viewer never
   * gets the same message twice.
   */
  const shellTargets = (deviceId: string, sender: ServerWebSocket<unknown>): ServerWebSocket<unknown>[] => {
    const targets = new Set(deviceTargets(deviceId))
    targets.add(sender)
    return [...targets]
  }

  /** The interactive terminal's emulated-cwd state (plan 26 §3.7, §4.4) — one instance for the life of the router, like `monitors` above. */
  const shellSessions = createShellSessionStore()

  /**
   * Readiness holds taken by `lease.acquire` (plan 43 §5 step 43.7), keyed
   * by deviceId — a device has at most one manual lease at a time, so at
   * most one entry. Released on an explicit `lease.release`, or here on WS
   * disconnect for whichever devices this connection held (`handleClose`),
   * mirroring `shellSessions`'s own per-device release above. `daemon.ts`'s
   * `onManualRevoked` (idle timeout, quarantine, forced release) reaches
   * this through the `releaseLeaseHold` export below, the same forward-ref
   * pattern `releaseShellSession` already uses.
   */
  const leaseHolds = new Map<string, { clientId: string; hold: Hold }>()
  const releaseLeaseHold = (deviceId: string): void => {
    const entry = leaseHolds.get(deviceId)
    if (!entry) return
    leaseHolds.delete(deviceId)
    entry.hold.release()
  }

  /**
   * Ref-counted per device across every attached Inspect tab (plan 56 §3.2,
   * §4.2 step 4/7): `inspect.attach` starts (or joins) the engine,
   * `inspect.detach` — from an explicit message, a WS close, or the device
   * going away — releases this connection's share, and the engine itself is
   * given back only once the count reaches zero. A `Map` (not a per-`state`
   * count) because two different connections both attaching to the SAME
   * device must share one count, the same reasoning `MonitorHub` already
   * uses for one logcat stream serving several viewers.
   */
  const inspectorRefCounts = new Map<string, number>()

  /** One connection's share of a device's inspector attachment, released on `inspect.detach`, WS close, or the device going away (`resetInspectForDevice`). Idempotent — a connection that never attached (or already detached) is a harmless no-op. */
  const detachInspector = async (deviceId: string, state: ConnState): Promise<void> => {
    if (!state.inspectAttached.delete(deviceId)) return
    const remaining = Math.max(0, (inspectorRefCounts.get(deviceId) ?? 1) - 1)
    if (remaining > 0) {
      inspectorRefCounts.set(deviceId, remaining)
      return
    }
    inspectorRefCounts.delete(deviceId)
    const session = deps.sessions?.get(deviceId) ?? null
    await session?.releaseInspector().catch((err) => deps.log.warn(`releaseInspector failed for ${deviceId}: ${String(err)}`))
    deps.recorder.record({ deviceId, stream: 'main', kind: 'inspect.detached', actor: state.userId })
  }

  /**
   * The ONE place local-vs-remote is decided for shell work (plan 25 §3.4,
   * §4.3) — `MonitorHub` and `runOneshotMonitor` just consume a `ShellPort`
   * and never branch on it themselves. Mirrors the existing `stream.start`
   * resolution below (`deps.remote?.nodeIdFor`) exactly.
   */
  const shellPortFor = (deviceId: string): ShellPort => {
    const remoteNode = deps.remote?.nodeIdFor(deviceId) ?? null
    if (remoteNode) {
      if (!deps.rpc || !deps.router) {
        throw new EnkakuError('node_offline', 'the node that owns this device is currently disconnected')
      }
      return createRemoteShellPort({ rpc: deps.rpc, router: deps.router, deviceId })
    }
    const client = deps.adb()
    if (!client) throw new EnkakuError('E_ADB_UNAVAILABLE', 'the adb subsystem is not ready')
    const row = deps.db.select().from(devices).where(eq(devices.id, deviceId)).get()
    if (!row) throw new EnkakuError('device_not_found', 'no such device')
    return createLocalShellPort({ client, serial: row.serial })
  }

  // Forward-referenced (same pattern as `shellSessions` below and the
  // several forward-refs in daemon.ts): the crash watcher is constructed
  // right after `monitors` and needs `monitors` itself as its hub (plan 37
  // §4.3), but `monitors`'s own `onData`/`onEnded` — set at construction —
  // must ALSO feed the watcher, since `MonitorHub` has no per-subscription
  // callback (`subscribe()` only returns a `streamId`, not a data channel).
  let crashWatcher: ReturnType<typeof createCrashWatcher> | null = null

  const monitors = createMonitorHub({
    shellPort: shellPortFor,
    log: deps.log.child('monitor'),
    onData: (streamId, lines) => {
      for (const ws of monitorTargets(streamId)) send(ws, { type: 'monitor.data', payload: { streamId, lines } })
      crashWatcher?.handleStreamData(streamId, lines)
    },
    onEnded: (streamId, reason) => {
      for (const ws of monitorTargets(streamId)) {
        send(ws, { type: 'monitor.ended', payload: { streamId, reason } })
        conns.get(ws)?.monitorSubs.delete(streamId)
      }
      crashWatcher?.handleStreamEnded(streamId, reason)
    },
    onSubscribersChanged: (streamId, count) => {
      for (const ws of monitorTargets(streamId)) send(ws, { type: 'monitor.subscribers', payload: { streamId, count } })
    },
    // Readiness hold (plan 43 §3.7 table, §5 step 43.7) — one per underlying
    // stream entry (not per subscriber), released when the last subscriber leaves.
    holdFor: (deviceId) => deps.readiness?.hold(deviceId, 'monitor') ?? Promise.resolve({ release() {} }),
  })

  crashWatcher = createCrashWatcher({
    hub: monitors,
    record: deps.recorder.record,
    saveTrace: deps.saveCrashTrace,
    // Attribution requires a JOB lease specifically (plan 37 §3.3, §8 risks)
    // — a manual lease at the moment of the crash means "record only".
    getJobLease: (deviceId) => {
      const lease = deps.leases.getLease(deviceId)
      return lease?.type === 'job' ? { jobId: lease.holder } : null
    },
    crashPolicy: deps.crashPolicy,
    crashWatch: deps.crashWatch,
    targetPackagesForJob: deps.targetPackagesForJob,
    log: deps.log.child('crash'),
  })
  crashWatcher.onJobCrash((_deviceId, jobId, e) =>
    deps.onJobCrash?.(jobId, { package: e.package, exception: e.exception, message: e.message }),
  )

  // Plan 94 §4.9, §5 step 94.3 — the recorder's two pushes, registered once
  // at router construction, the same "one router, one subscriber" shape
  // `crashWatcher.onJobCrash` above already uses. `recording.step` and a
  // bound-triggered `recording.state` are both broadcasts (every viewer of
  // the device sees them), not unicasts — the same reasoning
  // `AssistChangedMessage`/`LeaseChangedMessage` already establish for "who
  // is doing what to this device" facts.
  deps.recording?.onStep((deviceId, index, kind, hasCandidate) => {
    deps.broadcast({ type: 'recording.step', payload: { deviceId, index, kind, hasCandidate } })
  })
  deps.recording?.onBoundStopped((deviceId, reason, doc) => {
    deps.broadcast({
      type: 'recording.state',
      payload: { deviceId, active: false, stepCount: doc.steps.length, startedAt: doc.recordedAt, stoppedReason: reason },
    })
  })

  /**
   * Fan a device event out to connections that explicitly subscribed to it
   * (plan 18 §3.6) — never to every client, which would put one device's
   * input traffic on the WS of someone looking at an unrelated page.
   */
  const publishEvent = (deviceId: string, ev: DeviceEvent): void => {
    for (const [ws, state] of conns) {
      if (ws.readyState !== 1) continue
      if (state.logSubs.get(deviceId)?.has(ev.stream)) send(ws, { type: 'device.event', payload: ev })
    }
  }

  /**
   * Every live viewer of a device (plan 31 §4.2) — derived from the SAME
   * stream bindings the video path already keeps (no second bookkeeping
   * structure) plus the lease manager (the single source of truth for who
   * holds control; presence never stores its own copy).
   */
  const viewersOf = (deviceId: string): Viewer[] => {
    const lease = deps.leases.getLease(deviceId)
    const holder = lease?.type === 'manual' ? lease.holder : null
    const out: Viewer[] = []
    for (const [ws, state] of conns) {
      if (ws.readyState !== 1) continue
      let since: number | null = null
      for (const binding of state.streams.values()) {
        if (binding.deviceId === deviceId) {
          since = binding.since
          break
        }
      }
      if (since === null) continue
      out.push({
        sessionId: state.clientId,
        userLabel: deps.userLabel?.(state.userId) ?? null,
        since,
        holdsControl: holder === state.clientId,
      })
    }
    return out
  }

  /**
   * Fan the current viewer list out to every connection watching this
   * device (plan 31 §3.5, §4.2) — the same scoping `publishEvent` uses for
   * log subscriptions, so a busy farm's presence churn never lands on a WS
   * that has nothing to do with this device.
   */
  const broadcastViewers = (deviceId: string): void => {
    const viewers = viewersOf(deviceId)
    for (const [ws, state] of conns) {
      if (ws.readyState !== 1) continue
      const isViewer = [...state.streams.values()].some((b) => b.deviceId === deviceId)
      if (isViewer) send(ws, { type: 'device.viewers', payload: { deviceId, viewers } })
    }
  }

  /** The settings block's own shipped defaults (`packages/protocol/src/settings.ts`'s `mirror.default(...)`) — used only when `deps.mirrorSettings` is not wired (a test, or a host built before plan 91). */
  const DEFAULT_MIRROR_SETTINGS: MirrorSettings = { maxDevices: 20, requireSameOrientation: true, aspectTolerance: 0.05, dropAfterConsecutiveFailures: 3 }
  const mirrorSettings = (): MirrorSettings => deps.mirrorSettings?.() ?? DEFAULT_MIRROR_SETTINGS

  /**
   * Unicast to exactly one WS connection by `clientId` — `mirror.changed`'s
   * own doc comment (`packages/protocol/src/messages/co-control.ts`) says
   * "Unicast to the mirror's owner", unlike `assist.changed`'s broadcast. A
   * `clientId` is generated fresh per connection (`stateOf`, above) and
   * never reused, so at most one entry ever matches.
   */
  const sendToClient = (clientId: string, msg: ServerMessage): void => {
    for (const [ws, s] of conns) {
      if (ws.readyState === 1 && s.clientId === clientId) send(ws, msg)
    }
  }

  /** `devices.label`, or the id itself when the row cannot be found — a `MirrorMember` always carries something a human can read, never a bare id presented as if it were one. */
  const deviceLabelOf = (deviceId: string): string =>
    deps.db.select({ label: devices.label }).from(devices).where(eq(devices.id, deviceId)).get()?.label ?? deviceId

  /**
   * The other half of a `MirrorMember`'s identity (plan 124 §3.7) — the
   * device's `device_numbers` reservation, or `null`.
   *
   * Two reads rather than one joined statement, deliberately: `device_numbers`
   * is keyed on `stableId` (plan 89 §3.1 — never on `devices.id`, which is
   * what a mirror group resolves members by), so naming the number for a
   * `deviceId` means going through the device row regardless. Both reads are
   * indexed primary/unique-key lookups, they happen at most `mirror.maxDevices`
   * times per reconciliation (20 by default, 64 at the ceiling), and only
   * while an operator is actively mirroring — this is not the per-row, per-
   * request path `loadDeviceNumbers` exists to keep out of the fleet queries.
   *
   * `null` for an unknown device id, matching `deviceLabelOf` above: a member
   * whose row vanished mid-group still renders, just without a number.
   */
  const deviceNumberOf = (deviceId: string): number | null => {
    const row = deps.db.select({ stableId: devices.stableId }).from(devices).where(eq(devices.id, deviceId)).get()
    return row ? lookupDeviceNumber(deps.db, row.stableId) : null
  }

  /**
   * Mirror groups (plan 91 §3.8, §3.9, §4.7, §5 step 91.7) — constructed
   * only when BOTH `coControl` and `states` are wired, the same "omitted
   * means it does not exist here" convention every other optional dep in
   * this file uses. It needs `coControl` for the identical reason
   * `assist.start` does (a busy/held member becomes an ordinary Assist
   * grant, never a takeover — §3.9), and it needs `states` to read a
   * device's RAW status at all, which nothing else in this router exposes.
   */
  const coControlForMirror = deps.coControl
  const statesForMirror = deps.states
  const mirror =
    coControlForMirror && statesForMirror
      ? createMirrorManager({
          sessions: () => deps.sessions,
          states: statesForMirror,
          leases: deps.leases,
          coControl: coControlForMirror,
          jobs: deps.jobs,
          nodeIdFor: (deviceId) => deps.remote?.nodeIdFor(deviceId) ?? null,
          deviceLabel: deviceLabelOf,
          deviceNumber: deviceNumberOf,
          // The SAME `canAssist(role, mode)` gate `assist.start` enforces
          // (plan 91 §3.6, §4.6) — checked once per MEMBER that would need a
          // fresh assist grant, not once for the whole `mirror.start` call,
          // so an operator who lacks `device.assist` can still mirror a
          // group of otherwise-idle devices; only the members that would
          // have needed assisting are skipped `assist_not_allowed`.
          // `coControl.grant` itself still enforces the farm-wide
          // `mode: 'off'` switch underneath regardless of this (see
          // `co-control.ts`'s own doc comment on `CoControlConfig.mode`).
          assistAllowedFor: (userId) => canAssist(deps.roleOf(userId), deps.coControlMode?.() ?? 'off'),
          // Plan 91 §3.5, §5 step 91.5 — per-device attribution for a
          // mirrored action, closing the gap step 91.7 flagged (`group.ts`'s
          // own `MirrorManagerDeps.recorder` doc comment has the full
          // reasoning). The SAME increment the single-device `input.*`
          // branch performs above, reused rather than duplicated.
          recorder: deps.recorder,
          incrementAssistCount: (jobId) =>
            deps.db
              .update(jobs)
              .set({ assistCount: sql`COALESCE(${jobs.assistCount}, 0) + 1` })
              .where(eq(jobs.id, jobId))
              .run(),
          config: {
            maxDevices: () => mirrorSettings().maxDevices,
            requireSameOrientation: () => mirrorSettings().requireSameOrientation,
            aspectTolerance: () => mirrorSettings().aspectTolerance,
            dropAfterConsecutiveFailures: () => mirrorSettings().dropAfterConsecutiveFailures,
          },
          onChanged: (group, members) =>
            sendToClient(group.ownerClientId, { type: 'mirror.changed', payload: { groupId: group.id, members } }),
          log: deps.log.child('mirror'),
        })
      : null

  return {
    publishEvent,
    viewersOf,
    broadcastViewers,
    /** Sent the moment a WS opens (plan 31 §4.2) — before any client message. */
    handleOpen(ws: ServerWebSocket<unknown>): void {
      const state = stateOf(ws)
      // Connection churn (plan 85 §3.6, §4.6) — see `transport-metrics.ts`'s
      // `noteOpen` doc comment for exactly what this can and cannot prove.
      transportMetrics.noteOpen(conns.size)
      send(ws, { type: 'hello', payload: { sessionId: state.clientId } })
    },
    async handleMessage(ws: ServerWebSocket<unknown>, raw: string): Promise<void> {
      let json: unknown
      try {
        json = JSON.parse(raw)
      } catch {
        sendError(ws, 'E_BAD_MESSAGE', 'the payload is not JSON')
        return
      }
      const parsed = ClientMessageSchema.safeParse(json)
      if (!parsed.success) {
        sendError(ws, 'E_BAD_MESSAGE', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
        return
      }
      const msg = parsed.data
      const state = stateOf(ws)
      const msgId = 'id' in msg ? msg.id : undefined
      // Plan 85 §3.6, §4.6, §5 85.7a (tests H1) — wall time from this
      // message's arrival to the handler finishing it. Recorded as a
      // "control reply" only when `msgId` is set: those are exactly the
      // messages a `ws.request()` caller on the client is waiting on
      // (fire-and-forget messages like `input.tap` carry no `id`, so they
      // never skew the percentile with traffic nobody is blocked on).
      const startedAt = performance.now()

      try {
        switch (msg.type) {
          case 'stream.start': {
            const streamId = state.nextStreamId++ & 0xff
            const binding: StreamBinding = {
              streamId,
              deviceId: msg.payload.deviceId,
              lastSize: { width: 0, height: 0 },
              since: Math.floor(Date.now() / 1000),
              onFrame: (chunk, meta) => {
                if (ws.readyState !== 1) return

                /**
                 * Backpressure, handled per codec — dropping a frame means two
                 * completely different things.
                 *
                 * A PNG frame stands alone: skip one and the next is whole
                 * again. An H.264 delta does not — it describes the change
                 * since the frame before it, so dropping one corrupts every
                 * frame after it until the next keyframe. The encoder's IDR
                 * interval is measured in seconds, so at 40 fps a single
                 * skipped delta can smear several hundred frames. That is the
                 * "artifacts even at high fps" an operator reported, and why
                 * raising the buffer limit would not have helped: the higher
                 * the frame rate, the more often the socket fills.
                 *
                 * So a congested H.264 stream stops sending entirely and asks
                 * for a fresh keyframe, then resumes from it. A brief freeze
                 * is honest; a smeared picture pretending to be live is not.
                 */
                const bufferedAmount = ws.getBufferedAmount()
                // Sampled here, not only on congestion (plan 85 §3.6, §4.6) —
                // `/api/adb/stats`'s `transport.bufferedBytesP95` needs the
                // ordinary case too, not just the moments this stream was
                // already backed off.
                transportMetrics.recordBufferedBytes(bufferedAmount)
                const congested = bufferedAmount > MAX_BUFFERED
                if (meta.codec === 'png') {
                  if (congested) {
                    countersFor(binding).congestionDrops++
                    return // one lost picture; nothing downstream depends on it
                  }
                } else {
                  if (congested && !binding.awaitingKeyframe) {
                    binding.awaitingKeyframe = true
                    countersFor(binding).keyframeRequests++
                    sessionForBinding(binding)?.requestKeyframe?.()
                  }
                  if (binding.awaitingKeyframe) {
                    // Resume only on a keyframe, and only once the socket drained.
                    if (congested || !meta.keyframe) {
                      countersFor(binding).congestionDrops++
                      return
                    }
                    binding.awaitingKeyframe = false
                  }
                }

                if (meta.width !== binding.lastSize.width || meta.height !== binding.lastSize.height) {
                  binding.lastSize = { width: meta.width, height: meta.height }
                  send(ws, { type: 'stream.meta', payload: { streamId, width: meta.width, height: meta.height } })
                }
                const encoded = encodeVideoFrame(streamId, meta, chunk)
                transportMetrics.recordVideoBytes(encoded.byteLength)
                ws.send(encoded)
              },
            }
            // Video keeps running even while a device is `busy` (spec §10.1) —
            // only input is rejected.
            const remoteNode = deps.remote?.nodeIdFor(msg.payload.deviceId) ?? null
            // Defaults to `control` — every pre-plan-42 caller, and the
            // device page itself. Only the Wall asks for `wall` (Plan 42 §4.5).
            const requestedQuality = msg.payload.quality ?? 'control'
            let codec: 'png' | 'h264'
            let frameSize: { width: number; height: number }
            let quality: Quality = 'control'
            // Plan 100 §3.2, §3.7 item 2, §4.4, §5 step 100.5 — set only when
            // `sessions.acquire`'s fast path for `control` threw
            // `E_CONTROL_SESSION_UNAVAILABLE` and this viewer was handed the
            // device's already-open `wall` entry instead. Carried on
            // `stream.started` itself (`degradedReason`/`degradedDetail`,
            // `packages/protocol/src/messages/stream.ts`) rather than a new
            // message type, per §3.7's "two tiers, no silent fallback" rule.
            let degradedReason: 'control_session_unavailable' | undefined
            let degradedDetail: string | undefined
            let localSession: DeviceSession | null = null
            if (remoteNode) {
              // The tunnel protocol does not carry a quality profile yet
              // (Plan 42 §9 open question) — every remote-node device
              // streams at its one existing profile regardless of what was
              // requested, which this reports honestly rather than claiming
              // an upgrade that never happened.
              const remoteSession = await deps.remote!.acquire(msg.payload.deviceId, binding.onFrame)
              codec = remoteSession.codec
              frameSize = remoteSession.frameSize
              binding.remote = true
            } else if (deps.sessions) {
              // Readiness hold (plan 43 §3.6, §5 step 43.7) — local devices
              // only (remote/node-owned devices are handled by the branch
              // above and are out of scope for this plan, §9 open question
              // #2). Ensures the device is at least `awake` before the
              // session itself is acquired; `sessions.acquire` below is what
              // actually brings it to `hot` and is what Plan 42's
              // `session.idleTtlSec` governs once this connection releases.
              binding.readinessHold = await deps.readiness?.hold(msg.payload.deviceId, 'viewer').catch((err) => {
                deps.log.warn(`readiness hold failed for viewer on ${msg.payload.deviceId}, proceeding anyway: ${String(err)}`)
                return undefined
              })
              let session: DeviceSession
              try {
                session = await deps.sessions.acquire(msg.payload.deviceId, binding.onFrame, requestedQuality)
              } catch (err) {
                // Plan 100 §4.4: never let the fast-path failure become a
                // bare `stream.start` refusal for a device that IS streaming
                // — just not at the quality asked for. Substitute the wall
                // entry's own frames, honestly labelled, only for exactly
                // the one coded failure this represents; anything else
                // (device offline, not found, ...) still refuses ordinarily.
                if (requestedQuality === 'control' && err instanceof SessionError && err.code === 'E_CONTROL_SESSION_UNAVAILABLE') {
                  deps.log.warn(`control session unavailable for ${msg.payload.deviceId}, showing the wall feed instead: ${err.message}`)
                  degradedReason = 'control_session_unavailable'
                  degradedDetail = err.message
                  session = await deps.sessions.acquire(msg.payload.deviceId, binding.onFrame, 'wall')
                } else {
                  throw err
                }
              }
              codec = session.displayEngineId === 'scrcpy' ? 'h264' : 'png'
              frameSize = session.frameSize
              quality = session.quality
              localSession = session
              binding.quality = quality
            } else {
              // The device belongs to no node AND there is no local session.
              sendError(
                ws,
                'device_not_reachable',
                'the device is connected neither to this control plane nor to any node',
                msg.id,
              )
              return
            }
            // Recorded AFTER acquire succeeds: if acquire throws, no binding is
            // left behind with no session under it. Without this line,
            // stream.stop and the disconnect cleanup do nothing at all — the
            // capture loop keeps running on the device forever.
            state.streams.set(streamId, binding)
            // A new viewer just joined — everyone watching this device
            // (including this connection itself) needs the updated list.
            broadcastViewers(msg.payload.deviceId)
            send(ws, {
              type: 'stream.started',
              id: msg.id,
              payload: {
                deviceId: msg.payload.deviceId,
                streamId,
                codec,
                width: frameSize.width,
                height: frameSize.height,
                quality,
                ...(degradedReason ? { degradedReason } : {}),
                ...(degradedDetail ? { degradedDetail } : {}),
              },
            })
            // A new viewer needs SPS/PPS to configure its decoder, and then a
            // keyframe to actually paint something. Sending only the config
            // leaves the canvas black until the encoder's next IDR — seconds
            // later — and the browser rejects the deltas that arrive meanwhile
            // ("a key frame is required after configure()"). `localSession`
            // is the EXACT entry `acquire` returned above (plan 100 §4.2) —
            // never re-fetched via `sessions.get(deviceId)`, which would
            // resolve the wrong slot whenever the other quality is also open.
            const primer: FrameMeta = {
              width: frameSize.width,
              height: frameSize.height,
              codec: 'h264',
              seq: 0,
              ptsUs: 0n,
              hostReceivedAt: Date.now(),
              keyframe: true,
            }
            const config = localSession?.videoConfig?.()
            if (config) ws.send(encodeVideoFrame(streamId, primer, config))
            const keyframe = localSession?.videoKeyframe?.()
            if (keyframe) {
              ws.send(encodeVideoFrame(streamId, primer, keyframe))
              // Only now ask the encoder for a fresh IDR (Plan 17 §3.6): the
              // cached keyframe can be seconds old, so the viewer's first real
              // picture ends up current rather than stale-then-jumping.
              //
              // Gated on a cached keyframe existing, which is the only cheap
              // proof that this encoder has already produced output. Sent to a
              // session that was created milliseconds ago it does the opposite
              // of helping: measured on a moto g06 power, RESET_VIDEO issued
              // before the encoder is running kills the server outright — 0
              // packets and a closed socket, versus 143 packets in five seconds
              // without it. The same message 3.8 s later is harmless.
              countersFor(binding).keyframeRequests++
              localSession?.requestKeyframe?.()
            }
            return
          }

          case 'stream.stop': {
            const binding = state.streams.get(msg.payload.streamId)
            if (!binding) return
            state.streams.delete(binding.streamId)
            if (binding.remote) deps.remote?.release(binding.deviceId, binding.onFrame)
            else deps.sessions?.release(binding.deviceId, binding.onFrame)
            binding.readinessHold?.release()
            broadcastViewers(binding.deviceId)
            return
          }

          case 'stream.keyframe': {
            // A hidden `<video>` becoming visible again (Plan 42 §4.1) — an
            // unrecognised or already-stopped streamId is silently ignored,
            // the same tolerance `stream.stop` above already gives a race
            // with the server ending the stream first.
            const binding = state.streams.get(msg.payload.streamId)
            if (!binding || binding.remote) return
            countersFor(binding).keyframeRequests++
            sessionForBinding(binding)?.requestKeyframe?.()
            return
          }

          case 'lease.acquire': {
            // `canUseDevice` (plan 34 §3.5, §4.4) — checked before the lease
            // is even attempted, so a device owned by another user is
            // refused the same way an already-busy device is, not after
            // control has already been granted.
            const role = deps.roleOf(state.userId)
            const owner = deps.getDeviceOwner?.(msg.payload.deviceId) ?? null
            if (owner && !canUseDevice({ id: state.userId ?? '', role }, owner)) {
              sendError(ws, 'auth.forbidden', 'this device belongs to another user', msgId)
              return
            }
            // A takeover (plan 71 §3.4) — `takeOverFrom` names the holder the
            // caller BELIEVES holds it; `acquireManual` itself is the
            // compare-and-swap and the atomic revoke-then-acquire. A stale
            // dialog (the holder changed since it was drawn) is refused with
            // `lease_holder_changed`, caught by the outer try/catch below
            // exactly like any other coded refusal.
            const lease = deps.leases.acquireManual(msg.payload.deviceId, state.clientId, state.userId, {
              ...(msg.payload.takeOverFrom ? { takeOverFrom: msg.payload.takeOverFrom } : {}),
            })
            // Readiness hold (plan 43 §3.6, §5 step 43.7) — taking manual
            // control is one of the acquisition paths listed in §3.6's
            // pseudocode. One hold per device (a device has at most one
            // manual lease); a re-acquire by the same client below the
            // `existing` early-return in `acquireManual` never reaches here
            // twice for the same lease.
            const readinessHold = await deps.readiness?.hold(lease.deviceId, 'lease').catch((err) => {
              deps.log.warn(`readiness hold failed for lease on ${lease.deviceId}, proceeding anyway: ${String(err)}`)
              return undefined
            })
            if (readinessHold) leaseHolds.set(lease.deviceId, { clientId: state.clientId, hold: readinessHold })
            send(ws, {
              type: 'lease.acquired',
              ...(msgId ? { id: msgId } : {}),
              payload: { deviceId: lease.deviceId, expiresAt: lease.expiresAt },
            })
            // Everyone else watching this device needs to know it is being
            // driven now, so their page stops offering control it cannot get.
            deps.broadcast({
              type: 'lease.changed',
              payload: { deviceId: lease.deviceId, heldBy: deps.leases.getHolder(lease.deviceId), expiresAt: lease.expiresAt },
            })
            broadcastViewers(lease.deviceId)
            deps.recorder.record({
              deviceId: lease.deviceId,
              stream: 'main',
              kind: 'control.acquired',
              actor: state.userId,
              meta: { clientId: state.clientId },
            })
            // Taking manual control is security-relevant, not just a device
            // fact — it also lands in the farm-wide audit trail (plan 18 §3.2).
            deps.audit.record({ userId: state.userId, action: 'device.control', target: lease.deviceId, meta: { action: 'acquired' } })
            return
          }

          case 'lease.release': {
            const released = deps.leases.releaseManual(msg.payload.deviceId, state.clientId)
            send(ws, {
              type: 'lease.released',
              ...(msgId ? { id: msgId } : {}),
              payload: { deviceId: msg.payload.deviceId },
            })
            if (released) {
              deps.broadcast({
                type: 'lease.changed',
                payload: { deviceId: msg.payload.deviceId, heldBy: null, expiresAt: null },
              })
              broadcastViewers(msg.payload.deviceId)
              deps.recorder.record({
                deviceId: msg.payload.deviceId,
                stream: 'main',
                kind: 'control.released',
                actor: state.userId,
                meta: { clientId: state.clientId },
              })
              // The terminal's emulated cwd does not survive a release — the
              // next holder (even the same client, re-acquiring later)
              // starts at `/` (plan 26 §3.7, §4.4, acceptance #11).
              shellSessions.release(msg.payload.deviceId)
              state.shellDevices.delete(msg.payload.deviceId)
              // Nor does an open adb endpoint — it "exists only for the life
              // of the lease... and disappears when the lease is released"
              // (plan 27 §1, acceptance #5).
              deps.adbEndpoint.close(msg.payload.deviceId, 'lease_released')
              // Nor does the readiness hold this lease took (plan 43 §5 step
              // 43.7) — releasing it lets the device drift back toward its
              // `desired` readiness rather than staying awake forever.
              releaseLeaseHold(msg.payload.deviceId)
              // Nor does an open recording (plan 94 §4.6: "released when the
              // lease is released") — ends it exactly like a bound would,
              // with `stoppedReason: 'lease-lost'`, never a silent drop of
              // whatever was captured so far.
              deps.recording?.stopForLeaseLost(msg.payload.deviceId)
              // A `vpn-helper` route deliberately does NOT tear down on lease
              // release (plan 52 §0, §3.1, §4.1 — superseding plan 44 §5.7):
              // a route is a property of the device, not of whoever held the
              // lease, so releasing it — explicit or automatic — leaves the
              // route exactly as it was.
            }
            return
          }

          case 'device.readiness.set': {
            // Server-authoritative (spec §10.1, plan 43 §3.4, acceptance #7):
            // `readiness.set` itself enforces the whole permission matrix —
            // crafting this message directly is refused exactly the same way
            // the Wall's Wake/Sleep control would be, whether or not the
            // client bothered to check first.
            if (!deps.readiness) {
              sendError(ws, 'E_NOT_SUPPORTED', 'device readiness is not available (orchestrator mode)', msgId)
              return
            }
            const readiness = await deps.readiness.set(msg.payload.deviceId, msg.payload.desired, {
              userId: state.userId,
              clientId: state.clientId,
            })
            // `readiness.set` already broadcasts the result to every
            // connected client (through `reconcile`'s own `deps.broadcast`,
            // wired in daemon.ts to `hub.broadcast`) — this reply just
            // carries the request's correlation `id` back to the sender
            // (acceptance #13: one broadcast, no page refresh, for everyone
            // including this connection).
            send(ws, { type: 'device.readiness', id: msgId, payload: { deviceId: msg.payload.deviceId, readiness } })
            return
          }

          case 'log.subscribe': {
            let subs = state.logSubs.get(msg.payload.deviceId)
            if (!subs) {
              subs = new Set()
              state.logSubs.set(msg.payload.deviceId, subs)
            }
            for (const s of msg.payload.streams) subs.add(s)
            return
          }

          case 'log.unsubscribe': {
            state.logSubs.delete(msg.payload.deviceId)
            return
          }

          // `deps.agent` is optional so a host or test that has not wired
          // Plan 66 keeps compiling and running unchanged, the same pattern
          // every other optional dep in this file uses.
          case 'agent.run.cancel': {
            deps.agent?.cancelRun(msg.payload.runId, deps.userLabel?.(state.userId) ?? state.userId)
            // Audited to match its HTTP sibling (`POST /runs/:id/cancel`,
            // `api/threads.ts`), which has always recorded this — the WS path
            // simply never called `audit.record` (a sweep finding, not a
            // permission gap: `agent.run` is an OPERATOR permission, so
            // `requirePermission('agent.run')` on the HTTP route is already a
            // no-op check for every authenticated caller in this codebase's
            // two-role model, same as this message).
            deps.audit.record({ userId: state.userId, action: 'agent.run.cancel', target: msg.payload.runId, meta: {} })
            return
          }

          case 'monitor.start': {
            // Read-only, no lease, allowed while `busy` (plan 24 §4.4) —
            // watching a job's logcat is a primary use case, so this
            // deliberately does NOT call `leases.checkInputAllowed`.
            const { streamId, backlog } = await monitors.subscribe(
              state.clientId,
              msg.payload.deviceId,
              msg.payload.kind,
              msg.payload.options,
            )
            state.monitorSubs.add(streamId)
            send(ws, {
              type: 'monitor.started',
              id: msg.id,
              payload: { streamId, deviceId: msg.payload.deviceId, kind: msg.payload.kind, backlog },
            })
            return
          }

          case 'monitor.stop': {
            state.monitorSubs.delete(msg.payload.streamId)
            monitors.unsubscribe(state.clientId, msg.payload.streamId)
            return
          }

          // `command.subscribe`/`command.unsubscribe` (plan 93 §3.17, §4.3,
          // step 93.4) — bookkeeping only, no lease, no permission check:
          // `POST /api/command-runs` is the only way to START a run, and a
          // client must already `GET` it before subscribing (`/ws` has no
          // snapshot replay, spec §13), so subscribing to a runId that does
          // not exist (or belongs to someone else) is simply inert — it will
          // never receive a `command.*` event, the same "harmless no-op"
          // shape `monitor.stop` on an unknown `streamId` already has.
          case 'command.subscribe': {
            state.commandSubs.add(msg.payload.runId)
            return
          }

          case 'command.unsubscribe': {
            state.commandSubs.delete(msg.payload.runId)
            return
          }

          case 'monitor.oneshot': {
            const { text, truncated } = await runOneshotMonitor(
              { shellPort: shellPortFor },
              msg.payload.deviceId,
              msg.payload.kind,
              msg.payload.options,
            )
            send(ws, {
              type: 'monitor.result',
              id: msg.id,
              payload: { deviceId: msg.payload.deviceId, kind: msg.payload.kind, text, truncated },
            })
            return
          }

          case 'shell.exec': {
            const { deviceId, cmd } = msg.payload
            // 1. Permission + the farm-wide `shell.mode` switch — BOTH are
            // server-authoritative (spec §10.1): Studio hiding/disabling the
            // terminal is a convenience, never the control. This is the
            // first such per-message ACL check on this router; the pattern
            // (resolve the role fresh, check before anything else) is meant
            // to be copied by the next permission-gated message type.
            const role = deps.roleOf(state.userId)
            const shellSettings = deps.shellSettings()
            if (!canUseShell(role, shellSettings.mode)) {
              sendError(ws, 'auth.forbidden', 'you do not have permission to run shell commands on this device', msgId)
              return
            }
            // 2. The SAME lease rule input uses (plan 26 §3.1) — no second
            // policy: busy/offline/idle/wrong-holder are all covered here.
            const allowed = deps.leases.checkInputAllowed(deviceId, state.clientId)
            if (!allowed.ok) {
              sendError(ws, allowed.code, allowed.message, msgId)
              return
            }
            // 3. Resolve local vs. remote — throws node_offline/device_not_found/E_ADB_UNAVAILABLE,
            // caught by the outer try/catch below, same as monitor.start/oneshot.
            const port = shellPortFor(deviceId)
            // 4. Keep the lease alive while the operator is thinking between commands (mirrors input.*).
            deps.leases.touchManual(deviceId, state.clientId)
            state.shellDevices.add(deviceId)

            const actor = state.userId
            const cwdAtStart = shellSessions.getCwd(deviceId)
            const startedAt = Date.now()

            // 6. Emitted the instant the command is accepted, before it has
            // run, so every viewer sees what is executing (plan 26 §3.8, §4.2).
            for (const target of shellTargets(deviceId, ws)) {
              send(target, {
                type: 'shell.echo',
                payload: { deviceId, cmd, cwd: cwdAtStart, actor, at: Math.floor(startedAt / 1000) },
              })
            }
            // 5. Recorded AFTER the lease check passes and BEFORE the device
            // is awaited (plan 18's ordering, reused verbatim, §3.3): a
            // refused command never reaches this line, so it is never
            // logged as if it ran. Redacted the same way credential-bearing
            // typed text is (plan 18 §3.4) — this is a log-hygiene measure,
            // not a security control (see `redact.ts`).
            deps.recorder.record({
              deviceId,
              stream: 'input',
              kind: 'shell.exec',
              actor,
              meta: { cmd: redactShellCommand(cmd), cwd: cwdAtStart },
            })

            // Plan 93 §3.3, §3.17, step 93.5 — the SAME lease check above is
            // the one this reuses (no second admission decision, unlike a
            // fan-out member which can still be skipped after this point).
            // Written at the SAME point as the `device_events` row just
            // above, for the same reason: a refused command never reaches
            // this line, so it is never recorded as if it ran. Synchronous
            // and local (SQLite, `better-sqlite3`), exactly like the
            // `recorder.record` call it sits beside — it adds a row, not a
            // round trip, so it does not change when `port.exec` below is
            // awaited (this step's own "must not change timing" constraint).
            // `cmd` is redacted the same way the audit row above is; the
            // stored `stdout`/`stderr` are filled in once the result below
            // is known — this call only creates the run and moves its one
            // member to `running`, mirroring `runOneMember` in
            // `command-console/runner.ts`.
            const commandRun = deps.commandRunStore?.recordSingle({ cmd: redactShellCommand(cmd), deviceId, actor })

            // The emulated cwd (plan 26 §3.7): a bare `cd [target]` is
            // intercepted and probed; every other command is prefixed with
            // `cd <cwd> &&`. NOT a security control (§3.4) — no command
            // string is ever blocked or rewritten to change its meaning,
            // only where it runs.
            const cdAttempt = shellSessions.parseCd(cmd)
            const onDeviceCmd = cdAttempt
              ? shellSessions.cdProbeCommand(deviceId, cdAttempt.target)
              : shellSessions.withCwd(deviceId, cmd)

            try {
              // 7. One-shot, through the NORMAL per-device queue (`default`
              // profile budget from farm settings) — never the plan 24
              // streaming lane. §3.6: the core chooses one-shot vs. stream,
              // never the user. The framed shell,v2,raw protocol (plan 53)
              // reports the real exit code and separates stderr — no marker
              // is appended to `onDeviceCmd`, so the command the operator
              // typed reaches the device byte for byte.
              const result = await port.exec(onDeviceCmd, {
                timeoutMs: shellSettings.execTimeoutMs,
                maxOutputBytes: shellSettings.maxOutputBytes,
              })
              const { stdout, stderr, exitCode } = result
              // The two streams travel apart all the way to Studio (plan 53).
              // Merging them here would have put error text in a field named
              // `stdout` — the same naming lie plan 53 removed from the
              // transport — and left the operator unable to see which was
              // which. Studio renders `stderr` distinctly.
              let resultCwd = cwdAtStart
              let reportedStdout = stdout
              if (cdAttempt) {
                if (exitCode === 0) {
                  // `pwd` writes only to stdout, so `stdout` is the path. It
                  // is consumed into the cwd rather than shown — a successful
                  // `cd` prints nothing in a real shell.
                  resultCwd = stdout.trim() || cwdAtStart
                  shellSessions.commitCwd(deviceId, resultCwd)
                  reportedStdout = ''
                }
                // A failed cd (exitCode !== 0, or exitCode null — the device
                // could not report one): the probe's own error text goes to
                // stderr, which is forwarded untouched, and the cwd is
                // deliberately left unchanged (acceptance #9).
              }
              const durationMs = Date.now() - startedAt
              // 8. Broadcast the outcome to every viewer (plan 26 §3.8).
              for (const target of shellTargets(deviceId, ws)) {
                send(target, {
                  type: 'shell.result',
                  payload: {
                    deviceId,
                    stdout: reportedStdout,
                    stderr,
                    exitCode,
                    truncated: result.truncated,
                    durationMs,
                    cwd: resultCwd,
                  },
                })
              }
              // 9. The matching outcome record — every accepted command
              // produces exactly these two rows (plan 26 acceptance #5).
              deps.recorder.record({
                deviceId,
                stream: 'input',
                kind: 'shell.result',
                actor,
                meta: {
                  exitCode,
                  bytes: reportedStdout.length + stderr.length,
                  truncated: result.truncated,
                  durationMs,
                },
              })
              // Plan 93 §3.5's "update it with the result" — AFTER the
              // broadcast and the `device_events` row above, never before:
              // this is bookkeeping for `/console`'s History, not part of
              // what the operator is watching live. `exitCode` (not
              // `reportedStdout`'s cd-consumed value in the count) mirrors
              // `command-console/runner.ts`'s `settleExecuted`: a non-zero or
              // absent exit code is `failed`, never silently folded into
              // `ok`. `outputHash` is computed the same way the runner
              // computes it (over the retained bytes) purely for row shape
              // consistency — nothing reads it for a one-member run, since
              // grouping (plan 93 §3.6, §3.15) only matters for fan-out.
              if (commandRun) {
                const historyStatus: 'ok' | 'failed' = exitCode === 0 ? 'ok' : 'failed'
                const historyError =
                  exitCode === null ? (result.truncated ? 'output was truncated before a matching exit code arrived' : 'no exit code reported') : null
                deps.commandRunStore?.updateMember(commandRun.id, deviceId, {
                  status: historyStatus,
                  exitCode,
                  durationMs,
                  stdout: reportedStdout,
                  stderr,
                  truncated: result.truncated,
                  outputHash: Bun.hash(`${exitCode}\0${reportedStdout}\0${stderr}`).toString(),
                  error: historyError,
                })
                deps.commandRunStore?.finish(commandRun.id, { status: historyStatus })
              }
            } catch (err) {
              const code = err instanceof Error && 'code' in err ? String((err as { code: unknown }).code) : 'E_INTERNAL'
              const message = err instanceof Error ? err.message : String(err)
              const durationMs = Date.now() - startedAt
              // §3.6: a command that hit its deadline is stream-shaped —
              // offer the one-click hint to re-run it on the Plan 24 lane.
              // `AdbClient.exec` discards any partial output on a timeout
              // (there is no partial-output outcome for a one-shot exec, only
              // full output or a thrown error — see `shell-port.ts`), so this
              // cannot additionally condition on "produced output along the
              // way" as §3.6 describes; every deadline hit gets the hint,
              // which is a strict superset of that behaviour and never a
              // false negative.
              const hint = DEADLINE_ERROR_CODES.has(code) ? ({ hint: 'stream_suggested' as const }) : {}
              // Acceptance #7: exceeding the output cap reports `truncated:
              // true` with a `null` exit code. The local `ShellPort` has no
              // partial-truncation return value — it throws `E_ADB_OUTPUT_LIMIT`
              // instead of resolving with a truncated flag (`shell-port.ts`) —
              // so this is where that error code is translated into the
              // truncation outcome the protocol promises.
              const truncated = code === 'E_ADB_OUTPUT_LIMIT'
              for (const target of shellTargets(deviceId, ws)) {
                send(target, {
                  type: 'shell.result',
                  // The failure text is ours, not the command's — it belongs
                  // on `stderr`. Reporting it as `stdout` said the command
                  // had printed "adb shell exceeded 15000ms", which it never
                  // did; `stdout` stays empty because nothing was produced.
                  payload: {
                    deviceId,
                    stdout: '',
                    stderr: message,
                    exitCode: null,
                    truncated,
                    durationMs,
                    cwd: cwdAtStart,
                    ...hint,
                  },
                })
              }
              deps.recorder.record({
                deviceId,
                stream: 'input',
                kind: 'shell.result',
                actor,
                meta: { exitCode: null, error: code, truncated, durationMs },
              })
              // Plan 93 §3.5's property 1: a failed/aborted exec is recorded
              // with its REAL outcome, not skipped. Same placement as the
              // success branch above — after the broadcast, after the
              // `device_events` row.
              if (commandRun) {
                deps.commandRunStore?.updateMember(commandRun.id, deviceId, {
                  status: 'failed',
                  exitCode: null,
                  durationMs,
                  stdout: '',
                  stderr: message,
                  truncated,
                  error: message,
                })
                deps.commandRunStore?.finish(commandRun.id, { status: 'failed' })
              }
            }
            return
          }

          case 'input.tap':
          case 'input.swipe':
          case 'input.gesture':
          case 'input.key':
          case 'input.text': {
            // Server-authoritative: the lease and status are validated here,
            // not merely disabled in the UI (spec §10.1). Plan 91 §3.2, §4.1,
            // §5 step 91.4 — the ONE fallback: a client `checkInputAllowed`
            // refuses gets a second, narrower chance — does it hold a
            // co-control (assist) grant on this EXACT device? `checkInputAllowed`
            // itself is untouched (F1's whole point); this fallback lives ONLY
            // here, in `input.*`, by construction — `deps.coControl` is not
            // consulted by any other case in this switch.
            let allowed = deps.leases.checkInputAllowed(msg.payload.deviceId, state.clientId)
            let source: InputSource = { kind: 'lease', id: state.clientId, userId: state.userId }
            if (!allowed.ok) {
              const assist = deps.coControl?.checkAssistAllowed(msg.payload.deviceId, state.clientId)
              if (assist?.ok) {
                allowed = assist
                source = { kind: 'assist', id: state.clientId, userId: state.userId }
              }
            }
            if (!allowed.ok) {
              sendError(ws, allowed.code, allowed.message, msgId)
              return
            }
            const remoteNode = deps.remote?.nodeIdFor(msg.payload.deviceId) ?? null
            const session = remoteNode
              ? deps.remote!.get(msg.payload.deviceId)
              : (deps.sessions?.get(msg.payload.deviceId) ?? null)
            if (!session) {
              sendError(
                ws,
                remoteNode ? 'node_offline' : 'E_DEVICE_NOT_READY',
                remoteNode
                  ? 'the device belongs to a node that is currently disconnected'
                  : 'no active session for this device (start the stream first)',
                msgId,
              )
              return
            }
            // `touchManual` stays for the lease path — it is already a safe
            // no-op for a non-holder (`lease-manager.ts`'s own `lease.holder
            // === clientId` guard); the assist path refreshes the GRANT's own
            // TTL instead (plan 91 §3.2, §5 step 91.4) — touching the wrong
            // store here would either do nothing (a non-holder touching the
            // manual lease) or, worse, silently extend a lease nobody holding
            // a mere assist grant is entitled to extend.
            if (source.kind === 'assist') {
              deps.coControl?.touch(msg.payload.deviceId, state.clientId)
            } else {
              deps.leases.touchManual(msg.payload.deviceId, state.clientId)
            }
            // Plan 91 §3.5, §4.9, §5 step 91.5 — attribution. Only meaningful
            // when the PRIMARY hold is a job: §3.9's "manual, held by someone
            // else" row also grants an assist, but there is no job to
            // attribute to, so `jobs.assistCount`/`deps.onAssist` both stay
            // untouched for it, correctly (a human helping another human is
            // not a job attribution question). Derived fresh from the lease
            // rather than the grant's own snapshot — equivalent by
            // construction (a grant dies the instant its primary hold ends,
            // §3.2's subordination rule), and avoids a second lookup surface
            // on `CoControlManager` for one field.
            const assistJobId =
              source.kind === 'assist'
                ? (() => {
                    const primaryLease = deps.leases.getLease(msg.payload.deviceId)
                    return primaryLease?.type === 'job' ? primaryLease.holder : null
                  })()
                : null
            if (assistJobId) {
              deps.db
                .update(jobs)
                .set({ assistCount: sql`COALESCE(${jobs.assistCount}, 0) + 1` })
                .where(eq(jobs.id, assistJobId))
                .run()
              // The second unsolicited parent→child push ever (plan 91 §3.6,
              // §4.8, F20/F21) — NOT an abort, the job keeps running exactly
              // as before; a script that never calls `ctx.onAssist` is
              // unaffected. Fire-and-forget, like `recorder.record` below.
              deps.onAssist?.(assistJobId, { at: Math.floor(Date.now() / 1000), actor: state.userId })
            }
            // Recorded AFTER the lease check passes and BEFORE awaiting the
            // device (plan 18 §18.5): a rejected input (handled above, this
            // point is unreached) is never logged as if it happened. The
            // record() call itself never awaits — buffered, never on the
            // input path's critical section (plan 18 §3.5).
            const actor = state.userId
            // Plan 91 §3.5, §5 step 91.5 — spread into every `input.*`
            // recorder call below, never mutating `meta`'s existing shape
            // for a non-assist action (`assistJobId` is null on the lease
            // path, so the spread is a no-op there). This is the ONLY
            // change 91.5 makes to F16's existing per-verb recorder calls.
            const assistMeta = assistJobId ? { assist: true as const, jobId: assistJobId } : {}
            // Plan 91 §3.1, §3.3, §4.1 — fixes F6/H1: a local session's writes
            // go through its arbiter (three non-preemptive priority lanes over
            // the ONE shared virtual pointer), never the raw `input` sink
            // directly, so a concurrently assisting human (plan 91's whole
            // premise) can never interleave with this write. A node-owned
            // remote session has no arbiter (§2 non-goals: cloud/node devices
            // are out of scope for this plan) — `'arbiter' in session` is the
            // same kind of structural discriminant the `'textInput' in
            // session` check below already uses to tell the two session
            // shapes apart.
            const sink = 'arbiter' in session ? session.arbiter.for(source) : session.input
            if (msg.type === 'input.tap') {
              const p = mapNormToDevice(msg.payload.pos, session.frameSize)
              deps.recorder.record({
                deviceId: msg.payload.deviceId,
                stream: 'input',
                kind: 'input.tap',
                actor,
                meta: { x: p.x, y: p.y, w: session.frameSize.width, h: session.frameSize.height, ...assistMeta },
              })
              // Plan 94 §4.6, step 94.3 — the recorder's TEE: observes the
              // SAME normalised payload the wire already carries (F2), never
              // the mapped device-pixel `p` above, so a recording replays on
              // a different screen size unchanged. Placed immediately after
              // the event-log `record()` call, same as it, and BEFORE the
              // real device call below — a rejected input never reaches
              // either. `observe` is synchronous and never awaited: the tee
              // must observe, never alter what the device receives (plan 94's
              // property 1).
              deps.recording?.get(msg.payload.deviceId)?.observe({ kind: 'tap', pos: msg.payload.pos, holdMs: msg.payload.holdMs })
              // Plan 94 §4.4, closes F5: the client's OWN measured pointer
              // down→up duration wins when it sent one (exact, not sampled —
              // §3.4's "faithful" replay fidelity starts here, at the point a
              // recording is actually captured); an older client, or one that
              // never measured (unlikely, but the field is optional on the
              // wire), falls back to this device's own tapJitterMs range —
              // the SAME range a script's plain `tap()` already gets, so
              // manual and scripted taps no longer silently disagree.
              const holdMs = msg.payload.holdMs
              const tapJitterMs = deps.tapJitterMs?.(msg.payload.deviceId) ?? DEFAULT_TIMING.tapJitterMs
              await sink.tap(p, { holdMs: holdMs !== undefined ? [holdMs, holdMs] : tapJitterMs })
            } else if (msg.type === 'input.swipe') {
              const from = mapNormToDevice(msg.payload.from, session.frameSize)
              const to = mapNormToDevice(msg.payload.to, session.frameSize)
              deps.recorder.record({
                deviceId: msg.payload.deviceId,
                stream: 'input',
                kind: 'input.swipe',
                actor,
                meta: { from, to, durationMs: msg.payload.durationMs, ...assistMeta },
              })
              // Plan 94 §4.6, step 94.3 — the tee (see the `input.tap` branch
              // above for the full reasoning).
              deps.recording?.get(msg.payload.deviceId)?.observe({ kind: 'swipe', from: msg.payload.from, to: msg.payload.to, durationMs: msg.payload.durationMs })
              await sink.swipe(from, to, msg.payload.durationMs)
            } else if (msg.type === 'input.gesture') {
              // Plan 40 §4.6: a manual drag sends the OPERATOR'S REAL pointer
              // trace, batched to the sample interval on the client — not a
              // synthesised curve over a path the human already drew.
              const samples: GestureSample[] = msg.payload.samples.map((s) => {
                const p = mapNormToDevice(s, session.frameSize)
                return { x: p.x, y: p.y, atMs: s.atMs }
              })
              const first = samples[0]
              const last = samples[samples.length - 1]
              deps.recorder.record({
                deviceId: msg.payload.deviceId,
                stream: 'input',
                kind: 'input.gesture',
                actor,
                meta: {
                  from: first,
                  to: last,
                  samples: samples.length,
                  durationMs: last && first ? last.atMs - first.atMs : 0,
                  ...assistMeta,
                },
              })
              // Plan 94 §4.6, step 94.3 — the tee, fed the operator's REAL
              // normalised sample trace verbatim (F3) — not the mapped
              // device-pixel `samples` computed above, so the recording
              // stores exactly what `RecordingStepSchema.gesture.samples`
              // documents: "the real trace, not a synthesised curve".
              deps.recording?.get(msg.payload.deviceId)?.observe({ kind: 'gesture', samples: msg.payload.samples })
              if (sink.gesture) {
                await sink.gesture(samples)
              } else if (first && last) {
                // The engine cannot curve (AdbInput) — fall back to a linear
                // swipe over the trace's endpoints, honestly, rather than
                // dropping the input. Already reported once at session
                // creation (plan 40 §3.6), so nothing further to report here.
                await sink.swipe(first, last, Math.max(50, last.atMs - first.atMs))
              }
            } else if (msg.type === 'input.key') {
              const name = KEYCODE_NAMES[msg.payload.keycode]
              deps.recorder.record({
                deviceId: msg.payload.deviceId,
                stream: 'input',
                kind: 'input.key',
                actor,
                meta: { keycode: msg.payload.keycode, ...(name ? { name } : {}), ...assistMeta },
              })
              // Plan 94 §4.6, step 94.3 — the tee.
              deps.recording?.get(msg.payload.deviceId)?.observe({ kind: 'key', keycode: msg.payload.keycode })
              await sink.key(msg.payload.keycode)
            } else {
              // msg.type === 'input.text'
              const text = msg.payload.text
              const logText = deps.isLogInputTextEnabled(msg.payload.deviceId)
              deps.recorder.record({
                deviceId: msg.payload.deviceId,
                stream: 'input',
                kind: 'input.text',
                actor,
                meta: { ...redactInputText(text, logText), ...assistMeta },
              })
              // Plan 94 §4.6, step 94.3 — the tee, given the LITERAL string
              // regardless of `logInputText` above: that setting governs
              // what the AUDIT log may show a farm user, an orthogonal
              // concern to a recording, which must hold the real text to be
              // replayable at all (§3.4: "text — the string, delivered
              // through the device's own typing cadence"). A recording is
              // therefore exactly as sensitive as the device itself already
              // is — reviewing one (94.5) shows what was typed, the same as
              // watching the screen live already would.
              deps.recording?.get(msg.payload.deviceId)?.observe({ kind: 'text', text })

              // Plan 90 §3.3, §4.5, §5 step 90.5: node-owned devices are out of scope for the
              // text ladder (§2 — the guest agent's control channel is `adb forward`, which has
              // no meaning across a tunnel, and `RemoteInput` carries none of the capability
              // facts `resolveTextRoute` needs). `'textInput' in session` is the actual
              // TypeScript narrowing this depends on; `remoteNode` is kept in the condition only
              // for the (should-never-happen) defensive case where a local session object
              // somehow lacks the field. Unchanged behaviour otherwise — straight to the driver,
              // exactly as every build before this plan.
              if (remoteNode || !('textInput' in session)) {
                await sink.text(text)
                send(ws, {
                  type: 'input.text.result',
                  id: msg.id,
                  payload: { deviceId: msg.payload.deviceId, via: 'scrcpy-text', clobberedClipboard: false },
                })
                return
              }

              // Plan 125 §3.8, §8, §5 step 125.8 — the guest-agent IME
              // bootstrap moved off the pre-video chain and now runs after the
              // first frame, so an operator typing the instant a device opens
              // can reach this line while it is still in flight. Awaiting it
              // here is where the old "the session resolved, so the IME is
              // set" guarantee now lives: the facts `resolveTextRoute` reads
              // on the next line are exactly the ones this produces, and
              // routing on the pre-bootstrap `null`/`false` would silently
              // demote rung 1 to rung 2 for the first keystrokes of every
              // session. Resolved-and-free once the setup has completed, and
              // it starts the setup on demand for a session whose display
              // never produced a frame to trigger it.
              await session.whenTextInputReady?.()

              const decision = resolveTextRoute({
                text,
                agentCapabilities: session.textInput.agentCapabilities,
                imeCurrent: session.textInput.imeCurrent,
                hasScrcpyControl: session.inputEngineId !== 'adb-input',
                prefer: session.textInput.mode,
              })

              if (decision.unmet) {
                // Plan 59: a precondition, not a failure — the resolved rung could not carry this
                // string (F25's bug: today a CJK string reaches `AdbInput.text()` and dies inside
                // it as `INPUT_TEXT_UNSUPPORTED`, never a refusal a human can act on).
                sendError(ws, decision.unmet.code, decision.unmet.message, msg.id, decision.unmet.action)
                return
              }

              if (decision.rung === 'agent-ime') {
                await session.textInput.commitViaAgent(text)
              } else {
                // 'scrcpy-text' and 'adb-ascii' both go through the same `InputSink.text()` the
                // engine already implements — the ladder only changed WHETHER this call is
                // reached, never how it is made once reached. (A third rung, clipboard paste,
                // was designed alongside these two and removed as architecturally unreachable —
                // docs/plans/96-m61-hotfixes.md §96.7, §96.8.)
                await sink.text(text)
              }

              send(ws, {
                type: 'input.text.result',
                id: msg.id,
                payload: { deviceId: msg.payload.deviceId, via: decision.rung, clobberedClipboard: decision.clobbersClipboard },
              })
            }
            return
          }

          case 'recording.start': {
            // Plan 94 §4.6, §4.9, §5 step 94.3 — the SAME gate `input.*`
            // uses above, never a parallel check ("if you find yourself
            // writing a second permission check, stop and report" — this
            // plan's own brief). Deliberately NOT the `assist` fallback
            // `input.*` has: recording is a side-channel on the LEASE
            // holder's own input, not an action an assisting human takes on
            // someone else's behalf.
            const { deviceId } = msg.payload
            const allowed = deps.leases.checkInputAllowed(deviceId, state.clientId)
            if (!allowed.ok) {
              sendError(ws, allowed.code, allowed.message, msgId)
              return
            }
            if (!deps.recording) {
              sendError(ws, 'E_NOT_SUPPORTED', 'recording is not available on this host', msgId)
              return
            }
            if (deps.remote?.nodeIdFor(deviceId)) {
              sendError(ws, 'E_NOT_SUPPORTED', 'recording is not available for cloud (node-owned) devices yet', msgId)
              return
            }
            const session = deps.sessions?.get(deviceId) ?? null
            if (!session) {
              sendError(ws, 'E_DEVICE_NOT_READY', 'no active session for this device (start the stream first)', msgId)
              return
            }
            const row = deps.db.select().from(devices).where(eq(devices.id, deviceId)).get()
            if (!row) {
              sendError(ws, 'device_not_found', 'no such device', msgId)
              return
            }
            // `E_RECORDING_ACTIVE` (a synchronous throw from `deps.recording.start`
            // when one is already open) is caught by this handler's outer
            // try/catch exactly like any other coded error — the same
            // pattern `assist.start`'s own doc comment describes below.
            //
            // Anchors/screenshots come from WHATEVER inspector this session
            // already has attached (the same `session.inspector` the
            // `inspect.*` cases above read) — this deliberately does NOT
            // start one of its own: doing so would mean either duplicating
            // `inspectorRefCounts`'s ref-counted attach/release lifecycle
            // here (a second copy of state this router already owns once)
            // or leaking an inspector engine that nothing ever releases. A
            // recording opened with no Inspect tab open simply gets no
            // anchors and no screenshots — never a failed recording (§4.6).
            const rec = deps.recording.start(deviceId, state.userId, {
              recordedOn: { stableId: row.stableId, model: row.label, width: session.frameSize.width, height: session.frameSize.height },
              captureAnchor: async () => {
                if (!session.inspector) return null
                const root = await session.inspector.dump()
                return { root, packageName: root.packageName }
              },
              captureScreenshot: async () => {
                if (!session.inspector) return null
                return session.inspector.screenshot()
              },
            })
            deps.recorder.record({ deviceId, stream: 'main', kind: 'recording.started', actor: state.userId })
            send(ws, {
              type: 'recording.state',
              ...(msgId ? { id: msgId } : {}),
              payload: { deviceId, active: true, stepCount: rec.stepCount, startedAt: rec.startedAt },
            })
            return
          }

          case 'recording.stop': {
            const { deviceId } = msg.payload
            const allowed = deps.leases.checkInputAllowed(deviceId, state.clientId)
            if (!allowed.ok) {
              sendError(ws, allowed.code, allowed.message, msgId)
              return
            }
            if (!deps.recording) {
              sendError(ws, 'E_NOT_SUPPORTED', 'recording is not available on this host', msgId)
              return
            }
            // `E_NO_RECORDING` (nothing open on this device) is caught by
            // the outer try/catch, same as `E_RECORDING_ACTIVE` above.
            const doc = await deps.recording.stop(deviceId)
            deps.recorder.record({ deviceId, stream: 'main', kind: 'recording.stopped', actor: state.userId, meta: { steps: doc.steps.length } })
            send(ws, {
              type: 'recording.state',
              ...(msgId ? { id: msgId } : {}),
              payload: { deviceId, active: false, stepCount: doc.steps.length, startedAt: doc.recordedAt },
            })
            return
          }

          case 'recording.cancel': {
            const { deviceId } = msg.payload
            const allowed = deps.leases.checkInputAllowed(deviceId, state.clientId)
            if (!allowed.ok) {
              sendError(ws, allowed.code, allowed.message, msgId)
              return
            }
            deps.recording?.cancel(deviceId)
            deps.recorder.record({ deviceId, stream: 'main', kind: 'recording.cancelled', actor: state.userId })
            send(ws, {
              type: 'recording.state',
              ...(msgId ? { id: msgId } : {}),
              payload: { deviceId, active: false, stepCount: 0, startedAt: null },
            })
            return
          }

          case 'assist.start': {
            // Plan 91 §3.2, §3.6, §4.6, §5 step 91.4 — the ONLY entry point
            // that mints a co-control grant from a client message.
            // `mirror.start` (step 91.7) is the other; both call
            // `coControl.grant` directly, never `acquireManual` — the lease
            // is never touched (§3.2's table).
            if (!deps.coControl) {
              sendError(ws, 'E_NOT_SUPPORTED', 'assisting is not available on this host', msgId)
              return
            }
            const { deviceId } = msg.payload
            // `canAssist` (F23's shape, `auth/acl.ts`): the farm-wide
            // `coControl.mode` switch PLUS the `device.assist` role
            // permission, checked together, server-authoritative — a
            // hidden/disabled Assist button in Studio is a convenience only.
            const role = deps.roleOf(state.userId)
            const mode = deps.coControlMode?.() ?? 'off'
            if (!canAssist(role, mode)) {
              sendError(ws, 'auth.forbidden', 'you do not have permission to assist devices on this farm', msgId)
              return
            }
            // Throws a coded `EnkakuError` for every refusal
            // (`assist_not_allowed` / `assist_taken` / `assist_denied_by_script`
            // / `device_not_held`, §4.2) — caught by this handler's outer
            // try/catch exactly like any other coded error. The script's own
            // `assist: 'deny'` declaration (§3.6) is honoured INSIDE `grant`
            // via its optional `scriptAssistPolicy` hook — permissive until
            // step 91.5 supplies the real per-job data, by that hook's own
            // documented default.
            const grant = deps.coControl.grant(deviceId, state.clientId, state.userId)
            const primary = deps.leases.getHolder(deviceId)
            if (!primary) {
              // Defensive only: `grant` above already required a live lease
              // to exist (its own `device_not_held` refusal), and nothing
              // async ran in between to let it disappear.
              throw new EnkakuError('E_INTERNAL', 'the device lost its lease the instant assisting was granted')
            }
            // Plan 91 §3.5 — the "was this job assisted at all" bookend (F16)
            // and the "who, farm-wide" audit row (F24), mirroring exactly
            // what `lease.acquire` already does for `control.acquired`/
            // `device.control` right above in this file. `jobId` is null
            // whenever the primary hold is a manually-held lease rather than
            // a job (§3.9's "manual, held by someone else" row) — there is no
            // job to attribute to, and that is the correct, honest value.
            const assistMeta = { jobId: primary.kind === 'job' ? primary.id : null, primaryKind: primary.kind }
            deps.recorder.record({ deviceId, stream: 'main', kind: 'control.assist.started', actor: state.userId, meta: assistMeta })
            deps.audit.record({ userId: state.userId, action: 'device.assist', target: deviceId, meta: assistMeta })
            send(ws, {
              type: 'assist.started',
              ...(msgId ? { id: msgId } : {}),
              payload: { deviceId, expiresAt: grant.expiresAt, primary },
            })
            return
          }

          case 'assist.stop': {
            // A no-op for a client that holds no grant on this device —
            // ending your own help early is always allowed, the same
            // tolerance `lease.release` gives a non-holder. Nothing is
            // recorded for a no-op release: `release()`'s own boolean return
            // is exactly "did anything actually end", matching `lease.release`'s
            // `released` guard around ITS OWN recorder/audit calls a few
            // cases up in this file.
            const { deviceId } = msg.payload
            const released = deps.coControl?.release(deviceId, state.clientId, 'released') ?? false
            if (released) {
              const primary = deps.leases.getHolder(deviceId)
              const assistMeta = { jobId: primary?.kind === 'job' ? primary.id : null, primaryKind: primary?.kind ?? null, reason: 'released' as const }
              deps.recorder.record({ deviceId, stream: 'main', kind: 'control.assist.ended', actor: state.userId, meta: assistMeta })
              deps.audit.record({ userId: state.userId, action: 'device.assist', target: deviceId, meta: assistMeta })
            }
            send(ws, {
              type: 'assist.stopped',
              ...(msgId ? { id: msgId } : {}),
              payload: { deviceId, reason: 'released' },
            })
            return
          }

          case 'mirror.start': {
            // Plan 91 §3.9, §4.7, §5 step 91.7 — the operator acquires NO
            // multi-device lock. Every requested device is resolved
            // independently against the §3.9 table and reported, never
            // silently dropped (`mirror.started` always names every one).
            if (!mirror) {
              sendError(ws, 'E_NOT_SUPPORTED', 'mirroring is not available on this host', msgId)
              return
            }
            const { focusDeviceId, deviceIds } = msg.payload
            const { group, members } = await mirror.start({
              ownerClientId: state.clientId,
              ownerUserId: state.userId,
              focusDeviceId,
              deviceIds,
            })
            // `assist`-mode members already broadcast `assist.changed` for
            // free (`coControl`'s `onGranted` hook, wired centrally in
            // `daemon.ts` — plan 91 §5 step 91.4). `lease`-mode members do
            // NOT get that for free: unlike co-control, `lease-manager.ts`
            // has no equivalent "a lease was just acquired" hook of its
            // own — every existing `lease.acquire` broadcasts
            // `lease.changed`/viewers/the event/the audit row itself, at
            // THIS exact call site (`case 'lease.acquire'`, above). Every
            // member for which `mirror.start` just acquired a fresh manual
            // lease needs that identical treatment repeated here, or every
            // other tab watching that device silently never learns who
            // holds it now (F25).
            for (const m of members) {
              if (m.mode !== 'lease') continue
              const holder = deps.leases.getHolder(m.deviceId)
              deps.broadcast({ type: 'lease.changed', payload: { deviceId: m.deviceId, heldBy: holder, expiresAt: holder?.expiresAt ?? null } })
              broadcastViewers(m.deviceId)
              deps.recorder.record({
                deviceId: m.deviceId,
                stream: 'main',
                kind: 'control.acquired',
                actor: state.userId,
                meta: { clientId: state.clientId, mirror: true, groupId: group.id },
              })
              deps.audit.record({
                userId: state.userId,
                action: 'device.control',
                target: m.deviceId,
                meta: { action: 'acquired', mirror: true, groupId: group.id },
              })
            }
            send(ws, {
              type: 'mirror.started',
              ...(msgId ? { id: msgId } : {}),
              payload: { groupId: group.id, focusDeviceId: group.focusDeviceId, members },
            })
            return
          }

          case 'mirror.stop': {
            // A no-op for a caller who does not own this group (or names an
            // already-gone one) — the same tolerance `assist.stop` gives a
            // non-holder. Deliberately does NOT release the members' own
            // leases/grants: those are ordinary, independent authorizations
            // by now, and a WS disconnect already releases every one this
            // client holds (`handleClose`, below) regardless of which (if
            // any) mirror group they were resolved through.
            const { groupId } = msg.payload
            mirror?.stop(groupId, state.clientId)
            send(ws, { type: 'mirror.stopped', ...(msgId ? { id: msgId } : {}), payload: { groupId } })
            return
          }

          case 'input.mirror': {
            // Plan 91 §3.8, §4.7, §5 step 91.7 — ONE message in, N parallel
            // arbiter submissions out, one `input.mirror.result` back with
            // an entry per live member, always (never silence). Correlated
            // by `seq`, not the envelope `id` — this message carries none.
            if (!mirror) {
              sendError(ws, 'E_NOT_SUPPORTED', 'mirroring is not available on this host', msgId)
              return
            }
            const { groupId, seq, action, soloDeviceId } = msg.payload
            const results = await mirror.dispatch(groupId, state.clientId, action, soloDeviceId)
            send(ws, { type: 'input.mirror.result', payload: { groupId, seq, results } })
            return
          }

          case 'inspect.attach':
          case 'inspect.dump':
          case 'inspect.find': {
            // Reading the screen is a control-grade action (plan 56 §3.7): it
            // can carry whatever text is on screen (passwords included) and
            // seizes the `instrumentation` lock, so it is gated exactly like
            // `input.*` — the SAME server-authoritative lease check, never
            // merely a disabled button (spec §10.1).
            const { deviceId } = msg.payload
            const allowed = deps.leases.checkInputAllowed(deviceId, state.clientId)
            if (!allowed.ok) {
              sendError(ws, allowed.code, allowed.message, msgId)
              return
            }
            // Node-owned devices have no local `Inspector` to call (§2
            // non-goals) — `RemoteSessions` exposes only `frameSize` and
            // `input`. Reported honestly, never a fabricated empty tree.
            const remoteNode = deps.remote?.nodeIdFor(deviceId) ?? null
            if (remoteNode) {
              if (msg.type === 'inspect.attach') {
                send(ws, {
                  type: 'inspect.status',
                  ...(msgId ? { id: msgId } : {}),
                  payload: {
                    deviceId,
                    state: 'unavailable',
                    engineId: '',
                    capabilities: [],
                    reason: 'inspection is not available for cloud (node-owned) devices yet',
                  },
                })
              } else {
                sendError(ws, 'E_NOT_SUPPORTED', 'inspection is not available for cloud (node-owned) devices yet', msgId)
              }
              return
            }
            const session = deps.sessions?.get(deviceId) ?? null
            if (!session) {
              sendError(ws, 'E_DEVICE_NOT_READY', 'no active session for this device (start the stream first)', msgId)
              return
            }
            deps.leases.touchManual(deviceId, state.clientId)

            if (msg.type === 'inspect.attach') {
              send(ws, {
                type: 'inspect.status',
                payload: { deviceId, state: 'starting', engineId: session.inspectorEngineId, capabilities: [] },
              })
              try {
                await withDeadline(
                  session.whenInspectorReady(),
                  INSPECT_ATTACH_DEADLINE_MS,
                  'E_INSPECT_TIMEOUT',
                  `the inspector did not start within ${Math.round(INSPECT_ATTACH_DEADLINE_MS / 1000)}s`,
                )
              } catch (err) {
                send(ws, {
                  type: 'inspect.status',
                  ...(msgId ? { id: msgId } : {}),
                  payload: {
                    deviceId,
                    state: 'unavailable',
                    engineId: session.inspectorEngineId,
                    capabilities: [],
                    reason: `the inspector could not start: ${err instanceof Error ? err.message : String(err)}`,
                  },
                })
                return
              }
              const engineId = session.inspectorEngineId
              const capabilities = inspectorCapabilities(engineId)
              if (!session.inspector || !capabilities.includes('dump')) {
                send(ws, {
                  type: 'inspect.status',
                  ...(msgId ? { id: msgId } : {}),
                  payload: {
                    deviceId,
                    state: 'unavailable',
                    engineId,
                    capabilities,
                    reason: `the ${engineId} engine does not support reading the UI tree (no "dump" capability)`,
                  },
                })
                return
              }
              // Ref-counted, and idempotent per connection: a tab that calls
              // attach twice (e.g. a reconnect) must not inflate the count.
              if (!state.inspectAttached.has(deviceId)) {
                state.inspectAttached.add(deviceId)
                const count = (inspectorRefCounts.get(deviceId) ?? 0) + 1
                inspectorRefCounts.set(deviceId, count)
                // Recorded once per device going from zero viewers to one —
                // never once per dump, which would drown the log (§3.7).
                if (count === 1) {
                  deps.recorder.record({ deviceId, stream: 'main', kind: 'inspect.attached', actor: state.userId, meta: { engineId } })
                }
              }
              send(ws, {
                type: 'inspect.status',
                ...(msgId ? { id: msgId } : {}),
                payload: { deviceId, state: 'ready', engineId, capabilities },
              })
              return
            }

            const inspector = session.inspector
            if (!inspector) {
              sendError(ws, 'E_INSPECT_UNAVAILABLE', 'attach to the inspector first (inspect.attach)', msgId)
              return
            }

            if (msg.type === 'inspect.dump') {
              const startedAt = Date.now()
              const root = await withDeadline(
                inspector.dump(),
                INSPECT_DEADLINE_MS,
                'E_INSPECT_TIMEOUT',
                'reading the UI tree took too long',
              )
              const tookMs = Date.now() - startedAt
              const requestId = msg.payload.requestId
              let png: Uint8Array | null = null
              if (msg.payload.screenshot) {
                // Best-effort: a screenshot failure must not lose the tree
                // that already succeeded — `inspect.tree.snapshot` reports
                // honestly whether one is actually following.
                png = await inspector.screenshot().catch((err) => {
                  deps.log.warn(`inspect screenshot failed for ${deviceId}: ${String(err)}`)
                  return null
                })
              }
              send(ws, {
                type: 'inspect.tree',
                ...(msgId ? { id: msgId } : {}),
                payload: {
                  deviceId,
                  requestId,
                  root,
                  frameSize: session.frameSize,
                  at: Math.floor(Date.now() / 1000),
                  tookMs,
                  snapshot: png !== null,
                },
              })
              if (png) ws.send(encodeSnapshot(requestId, png))
              return
            }

            // inspect.find — the "Test on device" round trip (§4.4).
            const startedAt = Date.now()
            const node = await withDeadline(
              inspector.find(msg.payload.selector),
              INSPECT_DEADLINE_MS,
              'E_INSPECT_TIMEOUT',
              'the on-device find took too long',
            )
            send(ws, {
              type: 'inspect.match',
              ...(msgId ? { id: msgId } : {}),
              payload: { deviceId, requestId: msg.payload.requestId, node, tookMs: Date.now() - startedAt },
            })
            return
          }

          case 'inspect.detach': {
            await detachInspector(msg.payload.deviceId, state)
            return
          }

          case 'clipboard.get': {
            // Read-only, no lease (plan 38 §4.5, acceptance #5) — same
            // "no state change, no gate" reasoning `monitor.start` uses.
            const { deviceId } = msg.payload
            const remoteNode = deps.remote?.nodeIdFor(deviceId) ?? null
            let text: string
            if (remoteNode) {
              if (!deps.rpc) throw new EnkakuError('node_offline', 'the node that owns this device is currently disconnected')
              const reply = await deps.rpc.request<{ ok: boolean; text?: string; error?: { code: string; message: string } }>(
                deviceId,
                'clipboard.get.request',
                { deviceId },
              )
              if (!reply.ok) {
                throw new EnkakuError(
                  reply.error?.code ?? 'E_CLIPBOARD_UNAVAILABLE',
                  reply.error?.message ?? 'the node could not read the clipboard',
                )
              }
              text = reply.text ?? ''
            } else {
              const session = deps.sessions?.get(deviceId) ?? null
              if (!session) {
                sendError(ws, 'E_DEVICE_NOT_READY', 'no active session for this device (start the stream first)', msgId)
                return
              }
              if (!session.clipboard) {
                sendError(ws, 'E_CLIPBOARD_UNAVAILABLE', 'this session cannot access the clipboard', msgId)
                return
              }
              text = await session.clipboard.get()
            }
            // Unicast, never broadcast (plan 38 §4.5, acceptance #6):
            // clipboard content is very often a password or a token, unlike
            // the plan 26 terminal transcript which every viewer sees.
            send(ws, { type: 'clipboard.value', id: msg.id, payload: { deviceId, text } })
            return
          }

          case 'clipboard.set': {
            const { deviceId, text, paste } = msg.payload
            // The exact plan 26 lease pattern (§4.5): checkInputAllowed, then
            // touchManual, then record — writing the clipboard is input.
            const allowed = deps.leases.checkInputAllowed(deviceId, state.clientId)
            if (!allowed.ok) {
              sendError(ws, allowed.code, allowed.message, msgId)
              return
            }
            // Resolve local vs. remote — and refuse a session that genuinely
            // cannot do this — BEFORE touching the lease timer or recording
            // anything (mirrors `shellPortFor`'s ordering, plan 25 §4.1 step
            // 3): a routing failure must never look like an accepted write
            // in the audit trail.
            const remoteNode = deps.remote?.nodeIdFor(deviceId) ?? null
            let localSession: DeviceSession | null = null
            if (remoteNode) {
              if (!deps.rpc) throw new EnkakuError('node_offline', 'the node that owns this device is currently disconnected')
            } else {
              localSession = deps.sessions?.get(deviceId) ?? null
              if (!localSession) {
                sendError(ws, 'E_DEVICE_NOT_READY', 'no active session for this device (start the stream first)', msgId)
                return
              }
              if (!localSession.clipboard) {
                sendError(ws, 'E_CLIPBOARD_UNAVAILABLE', 'this session cannot access the clipboard', msgId)
                return
              }
            }
            deps.leases.touchManual(deviceId, state.clientId)
            const actor = state.userId
            // Recorded AFTER the lease check passes and BEFORE the device is
            // awaited (plan 18/26's ordering, reused verbatim): a refused
            // write is never logged as if it happened. The LENGTH only,
            // never the text (plan 38 §3.6, §4.5, acceptance #7) — clipboard
            // content is routinely a password or a one-time code.
            deps.recorder.record({
              deviceId,
              stream: 'input',
              kind: 'clipboard.set',
              actor,
              meta: { length: text.length, paste },
            })
            if (remoteNode) {
              const reply = await deps.rpc!.request<{ ok: boolean; error?: { code: string; message: string } }>(
                deviceId,
                'clipboard.set.request',
                { deviceId, text, paste },
              )
              if (!reply.ok) {
                throw new EnkakuError(
                  reply.error?.code ?? 'E_CLIPBOARD_UNAVAILABLE',
                  reply.error?.message ?? 'the node could not write the clipboard',
                )
              }
            } else {
              await localSession!.clipboard!.set(text, { paste })
            }
            send(ws, { type: 'clipboard.ok', id: msg.id, payload: { deviceId } })
            return
          }

          case 'transfer.cancel': {
            // No lease/permission check: knowing a `transferId` at all already
            // requires having started (or watched) that transfer — it is a
            // random server-minted id, never guessable — and cancelling one's
            // own (or a device's own) in-flight transfer is harmless either
            // way (plan 39 §4.4, acceptance #9).
            deps.transfer?.cancel(msg.payload.transferId)
            return
          }

          case 'job.enqueue': {
            // `canUseDevice` (plan 34 §3.5, §4.4) — refused inside
            // `deps.jobs.enqueue` with `auth.forbidden`, caught by this
            // handler's outer try/catch like any other coded error.
            const info = deps.jobs.enqueue({
              scriptId: msg.payload.scriptId,
              deviceId: msg.payload.deviceId,
              params: msg.payload.params,
              priority: msg.payload.priority,
              actor: { id: state.userId ?? '', role: deps.roleOf(state.userId) },
            })
            send(ws, { type: 'job.status', payload: info })
            return
          }

          case 'job.cancel': {
            // Server-authoritative permission + ownership check (spec §10.1)
            // — same pattern `shell.exec` above establishes: resolve the
            // role fresh, check before anything else. This route used to
            // call `deps.jobs.cancel` directly with no check at all, so any
            // authenticated operator could cancel any job farm-wide.
            // `canCancelJob` (`auth/acl.ts`) admits `job.cancel.any` (the
            // capability layer's admin-shaped rule) OR an operator cancelling
            // a job on a device they are themselves allowed to use — the
            // same ownership boundary `job.enqueue` above already enforces.
            const job = deps.jobs.get(msg.payload.jobId)
            if (!job) throw new EnkakuError('job_not_found', `no such job: ${msg.payload.jobId}`)
            const role = deps.roleOf(state.userId)
            const device = deps.getDeviceOwner?.(job.deviceId) ?? null
            if (!canCancelJob({ id: state.userId ?? '', role }, device)) {
              sendError(ws, 'auth.forbidden', 'you do not have permission to cancel this job', msgId)
              return
            }
            // The WS message has no way to ask for cancel-with-descendants
            // (plan 81 §4.4) — that opt-in lives only on the REST route.
            const { job: info } = deps.jobs.cancel(msg.payload.jobId)
            deps.audit.record({
              userId: state.userId,
              action: 'job.cancel',
              target: info.jobId,
              meta: { deviceId: info.deviceId },
            })
            send(ws, { type: 'job.status', payload: info })
            return
          }

          case 'device.pairing.request': {
            const res = await deps.pairing.request(msg.payload.host, msg.payload.port)
            send(ws, { type: 'device.pairing.request.result', id: msg.id, payload: res })
            return
          }

          case 'device.pairing.code': {
            const res = await deps.pairing.submitCode(msg.payload.pairingId, msg.payload.code, msg.payload.connectPort)
            send(ws, { type: 'device.pairing.code.result', id: msg.id, payload: res })
            return
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        const code = err instanceof Error && 'code' in err ? String((err as { code: unknown }).code) : 'E_INTERNAL'
        deps.log.warn(`handler ${msg.type} failed: ${message}`)
        // Plan 91 §5 step 91.10 — a SEPARATE, rate-limited warn naming the
        // lane and the blocking source, beside the generic (unconditional,
        // per-message) warn right above: an operator holding a finger on a
        // busy device refuses every ~40-120ms tap identically, and the
        // generic warn would otherwise produce a log line per event. Only
        // the single-device `input.*` messages carry a bare `deviceId` in
        // their payload — `input.mirror`'s own payload carries `groupId`
        // instead, and its per-member E_INPUT_BUSY refusals are already
        // reported as ordinary `MirrorResult`s rather than thrown up to this
        // catch, so this block is never reached for them; `mirror/group.ts`'s
        // own `dispatch` carries the identical rate-limited warn for that path.
        if (code === 'E_INPUT_BUSY' && typeof msg.payload === 'object' && msg.payload !== null && 'deviceId' in msg.payload) {
          const deviceId = String((msg.payload as { deviceId: unknown }).deviceId)
          const lane = laneForInputType(msg.type)
          const key = `${deviceId}:${lane}`
          const now = Date.now()
          const last = lastInputBusyWarnAt.get(key) ?? 0
          if (now - last >= INPUT_BUSY_WARN_WINDOW_MS) {
            lastInputBusyWarnAt.set(key, now)
            deps.log.warn(`input refused E_INPUT_BUSY: device=${deviceId} lane=${lane} — ${message}`)
          }
        }
        sendError(ws, code, message, msgId)
      } finally {
        const elapsedMs = performance.now() - startedAt
        if (msgId) transportMetrics.recordControlReplyMs(elapsedMs)
        logSlowCommand(msg.type, elapsedMs)
      }
    },

    /** WS dropped → this connection's streams, log subscriptions, and manual leases auto-release. */
    handleClose(ws: ServerWebSocket<unknown>): void {
      const state = conns.get(ws)
      if (!state) return
      // Captured before the map is cleared and this connection is dropped —
      // every device this tab was a viewer of needs an updated list telling
      // the rest that this row is gone (plan 31 §4.2).
      const watchedDeviceIds = new Set(Array.from(state.streams.values(), (b) => b.deviceId))
      for (const binding of state.streams.values()) {
        if (binding.remote) deps.remote?.release(binding.deviceId, binding.onFrame)
        else deps.sessions?.release(binding.deviceId, binding.onFrame)
        binding.readinessHold?.release()
      }
      state.streams.clear()
      state.logSubs.clear()
      // A dropped WS must not leak a monitor stream (plan 24 §4.4, §4.5 —
      // this is the call the plan's risk table calls out explicitly).
      monitors.releaseClient(state.clientId)
      state.monitorSubs.clear()
      // A command-run subscription is pure bookkeeping on THIS connection —
      // nothing external to release, unlike `monitors.releaseClient` above
      // (plan 93 §3.17, step 93.4).
      state.commandSubs.clear()
      // `LeaseManager.releaseAllForClient` drops the manual lease itself but
      // does not (today) tell us it did so — reaching `shell.exec` at all
      // required holding that lease, so every device this connection ran a
      // command on is, by construction, a device whose lease this close is
      // about to release (plan 26 §3.7, §4.4, acceptance #11).
      for (const deviceId of state.shellDevices) shellSessions.release(deviceId)
      state.shellDevices.clear()
      deps.leases.releaseAllForClient(state.clientId)
      // Plan 91 §3.5, §5 step 91.5 — the `control.assist.ended`/`device.assist`
      // bookend for a WS DISCONNECT specifically: read BEFORE releasing,
      // because `releaseAllForClient` below has no return value of its own
      // to report which grants it ended (unlike `assist.stop`'s explicit
      // `release()` boolean, which the WS handler above uses the same way).
      for (const grant of deps.coControl?.grantsForClient(state.clientId) ?? []) {
        const assistMeta = { jobId: grant.jobId, primaryKind: grant.primaryKind, reason: 'disconnected' as const }
        deps.recorder.record({ deviceId: grant.deviceId, stream: 'main', kind: 'control.assist.ended', actor: grant.userId, meta: assistMeta })
        deps.audit.record({ userId: grant.userId, action: 'device.assist', target: grant.deviceId, meta: assistMeta })
      }
      // Every co-control grant this connection held, anywhere on the farm
      // (plan 91 §3.2's "On WS close" row, §5 step 91.4) — the same
      // "disconnect ends what this connection was authorised to do" reasoning
      // as `deps.leases.releaseAllForClient` immediately above, for the
      // grant store instead of the lease store.
      deps.coControl?.releaseAllForClient(state.clientId)
      // Every mirror group this connection owned, anywhere on the farm
      // (plan 91 §5 step 91.7) — only the mirror bookkeeping itself; the
      // members' own underlying leases/grants are already released by the
      // two calls immediately above, regardless of which (if any) mirror
      // group they were resolved through.
      mirror?.stopAllForClient(state.clientId)
      // Nor does any readiness hold this connection's lease(s) took (plan 43
      // §5 step 43.7) — `LeaseManager.releaseAllForClient` above does not
      // report back which devices it released, so this walks `leaseHolds`
      // directly for anything still attributed to this connection.
      for (const [deviceId, entry] of [...leaseHolds]) {
        if (entry.clientId === state.clientId) {
          releaseLeaseHold(deviceId)
          // Same reasoning as `lease.release` above — a WS drop is one more
          // way "the lease is released" (plan 94 §4.6).
          deps.recording?.stopForLeaseLost(deviceId)
        }
      }
      // Any adb endpoint(s) this WS session (the REST route's `clientId`,
      // the same session id `hello` sent) opened must not outlive it either
      // (plan 27 §4.2 — "a WS disconnect" is one of the three teardown triggers).
      deps.adbEndpoint.closeAllForClient(state.clientId)
      // A dropped tab must not leave the inspector engine running forever
      // (plan 56 §3.2, acceptance #8) — released for real once this was the
      // last attached viewer. Fire-and-forget: `handleClose` itself stays
      // synchronous, matching every other cleanup call above.
      for (const deviceId of [...state.inspectAttached]) {
        void detachInspector(deviceId, state).catch((err) => deps.log.warn(`inspect detach on close failed for ${deviceId}: ${String(err)}`))
      }
      // A WS disconnect does NOT revert any `vpn-helper` route this
      // connection's manual lease(s) were covering, for the same reason as
      // the `lease.release` handler above (plan 52 §0, §3.1, §4.1): the
      // route belongs to the device, not the connection.
      conns.delete(ws)
      for (const deviceId of watchedDeviceIds) broadcastViewers(deviceId)
      // Agent chat subscriptions are tracked independently of `ConnState` (plan 66 §4.4) — release
      // this connection's share regardless of what else it was doing.
      deps.agent?.handleClose(ws)
    },

    /**
     * `CommandRunnerDeps.broadcast` (plan 93 §3.17, §4.3, §4.5, step 93.4) —
     * `daemon.ts`'s forward-ref from the command runner (constructed well
     * before this router, right after `leases`) into `commandTargets(runId)`
     * above, the same "built later, wired back in through a forward
     * reference" shape every other cross-module hook on this returned object
     * already uses (`releaseLeaseHold`, `reconcileMirror`, ...). Subscriber-
     * scoped, never `hub.broadcast` — see `commandTargets`'s own doc comment
     * for why (F27).
     */
    broadcastCommand(runId: string, msg: ServerMessage): void {
      for (const ws of commandTargets(runId)) send(ws, msg)
    },

    /**
     * `TransferBroadcast` (plan 93 §4.6, §5 step 93.9, closing F27) —
     * `daemon.ts`'s forward-ref from `transferBroadcast` (constructed well
     * before this router, right after `states`) into `deviceTargets(deviceId)`
     * above, the same "built later, wired back in through a forward
     * reference" shape `broadcastCommand` right above already uses.
     * Subscriber-scoped, never `hub.broadcast`: at 100 devices pushing
     * concurrently, a farm-wide broadcast put every open tab on every
     * device's progress ticks. Unlike `shellTargets`, no sender is added —
     * a transfer started by a job has no acting WS connection to add.
     */
    broadcastTransfer(deviceId: string, msg: ServerMessage): void {
      for (const ws of deviceTargets(deviceId)) send(ws, msg)
    },

    /** Device offline / session closed (plan 24 §4.5) — stops its monitor streams regardless of subscriber count. */
    stopMonitorsForDevice(deviceId: string): void {
      monitors.stopForDevice(deviceId)
      // A stopped monitor stream includes a running crash watch — `unwatch`
      // just drops now-stale bookkeeping (plan 37 §3.3: detection resumes
      // the next time a session opens for this device).
      crashWatcher?.unwatch(deviceId)
    },

    /**
     * The device went away entirely (plan 56 §4.2 step 7) — `DeviceSession.close()`
     * (called from `sessions.closeDevice()`) already released whatever
     * inspector the session owned as part of tearing itself down, so this
     * only clears OUR bookkeeping (the ref count and every connection's
     * `inspectAttached` entry) rather than releasing a second time against a
     * session that no longer exists. A later `inspect.attach` on this device
     * then starts clean instead of inheriting a stale count.
     */
    resetInspectForDevice(deviceId: string): void {
      inspectorRefCounts.delete(deviceId)
      for (const s of conns.values()) s.inspectAttached.delete(deviceId)
    },

    /** A session opened for this device (plan 37 §3.3, §4.3) — detection is always on, independent of jobs. Idempotent. */
    watchDevice(deviceId: string): void {
      void crashWatcher?.watch(deviceId).catch((err) => deps.log.warn(`crash watch failed to start for ${deviceId}: ${String(err)}`))
    },

    /** A session closed for this device — stop watching until the next one opens. */
    unwatchDevice(deviceId: string): void {
      crashWatcher?.unwatch(deviceId)
    },

    /** The manual lease on this device was released, however that happened (plan 26 §3.7, §4.4) — the next holder starts at `/`. */
    releaseShellSession(deviceId: string): void {
      shellSessions.release(deviceId)
    },

    /**
     * The manual lease's readiness hold (plan 43 §5 step 43.7), for the
     * automatic-revocation paths (idle timeout, quarantine) that go through
     * `daemon.ts`'s `onManualRevoked` rather than through this router's own
     * `lease.release`/`handleClose`, which already call this directly.
     */
    releaseLeaseHold,

    /**
     * Any open recording on this device (plan 94 §4.6), for the SAME
     * automatic-revocation paths `releaseLeaseHold` above already documents
     * (idle timeout, quarantine, a takeover) — `lease.release` and
     * `handleClose` in this router already call `deps.recording?.stopForLeaseLost`
     * directly; this forward-ref is what lets `daemon.ts`'s `onManualRevoked`
     * reach the same effect for the automatic paths, which is NOT yet wired
     * (flagged in plan 94 step 94.3's own report — `daemon.ts` is outside
     * this step's file list).
     */
    stopRecordingForLeaseLost(deviceId: string): void {
      deps.recording?.stopForLeaseLost(deviceId)
    },

    /**
     * Live re-resolution for one device, across every mirror group that has
     * it as a member (plan 91 §4.7, §5 step 91.7) — `daemon.ts` wires this
     * to `onJobFinished` through the same forward-ref pattern every other
     * WS-router hook here already uses, so an `internal:install` job ending
     * (F27) re-admits the device to any mirror group it was skipped from,
     * without a client asking. A harmless no-op when `mirror` was never
     * constructed (plan 91 not wired) or the device belongs to no group.
     */
    reconcileMirror(deviceId: string): void {
      mirror?.reconcile(deviceId)
    },

    /** `GET /api/adb/stats`'s `transport` block (plan 85 §3.6, §4.6) — `daemon.ts` wires this into `createAdbStatsRoutes` through the same forward-ref pattern every other WS-router hook here already uses. */
    transportStats(): TransportSnapshot {
      return transportMetrics.snapshot(conns.size)
    },

    /** Plan 203 §4.6: `GET /api/video/latency`'s per-stream counters. `daemon.ts` wires this into `createVideoRoutes` through the same forward-ref pattern `transportStats` above already uses. */
    videoStreamStats(deviceId: string): Array<{ quality: Quality; keyframeRequests: number; congestionDrops: number }> {
      const rows: Array<{ quality: Quality; keyframeRequests: number; congestionDrops: number }> = []
      for (const counters of streamCounters.values()) {
        if (counters.deviceId !== deviceId) continue
        rows.push({ quality: counters.quality, keyframeRequests: counters.keyframeRequests, congestionDrops: counters.congestionDrops })
      }
      return rows
    },

    /**
     * `GET /api/adb/stats`'s `input` block (plan 91 §4.10, §5 step 91.10,
     * tests H2/H4) — `daemon.ts` wires this the same forward-ref way
     * `transportStats` right above is. See `InputStatsBlock`'s own doc
     * comment for the two fields (`uncollectedGrants`, `orphanedMirrorGroups`)
     * this step added beyond §4.10's literal pseudocode.
     *
     * Every local `DeviceSession` carries its OWN three-lane arbiter (91.1)
     * — there is no farm-wide arbiter to read percentiles from directly, and
     * raw per-action wait samples never leave `input-arbiter.ts` (this file
     * has no business reaching into another package's internals for a
     * merged percentile). `depth`/`refusals` are additive across devices;
     * `waitMsP50`/`waitMsP95` take the WORST (max) value observed among live
     * device arbiters for that lane — for H2's own purpose ("is a lane's
     * wait budget under threat anywhere on the farm"), the worst lane is the
     * actionable number, not an average smoothed by mostly-idle devices.
     */
    inputStats(): InputStatsBlock {
      const lanes: InputStatsBlock['lanes'] = {
        pointer: { depth: 0, waitMsP50: 0, waitMsP95: 0, refusals: 0 },
        keys: { depth: 0, waitMsP50: 0, waitMsP95: 0, refusals: 0 },
        text: { depth: 0, waitMsP50: 0, waitMsP95: 0, refusals: 0 },
      }
      // plan 100 §4.2: `activeDeviceIds()` is deduped per DEVICE now that a
      // device can hold both a `wall` and a `control` entry, each with its
      // own independent arbiter — reading only the highest-quality-wins
      // `get(deviceId)` would silently drop the wall entry's own lane stats
      // whenever both are open. Checked explicitly for both slots when
      // `getByQuality` is wired; a fixture `SessionManager` that supplies
      // only `get` (every pre-100.4 test) falls back to that, unchanged.
      for (const deviceId of deps.sessions?.activeDeviceIds?.() ?? []) {
        const sessions = deps.sessions?.getByQuality
          ? [deps.sessions.getByQuality(deviceId, 'control'), deps.sessions.getByQuality(deviceId, 'wall')].filter(
              (s): s is DeviceSession => s !== null,
            )
          : [deps.sessions?.get(deviceId)].filter((s): s is DeviceSession => s !== null && s !== undefined)
        for (const session of sessions) {
          const perLane = session.arbiter.stats()
          for (const lane of ['pointer', 'keys', 'text'] as const) {
            const s = perLane[lane]
            const agg = lanes[lane]
            agg.depth += s.depth
            agg.refusals += s.refusals
            agg.waitMsP50 = Math.max(agg.waitMsP50, s.waitMsP50)
            agg.waitMsP95 = Math.max(agg.waitMsP95, s.waitMsP95)
          }
        }
      }

      const mirrorStats = mirror?.stats() ?? { groups: 0, members: 0, fanoutMsP50: 0, fanoutMsP95: 0 }
      // "Owner connection gone" (plan 91 §5 step 91.10, §8 risk table's own
      // "a mirror group outlives its owner's tab" row) — cross-referenced
      // against every currently-OPEN connection's clientId, the same
      // `readyState === 1` filter `deviceTargets`/`monitorTargets` above use.
      const connectedClientIds = new Set([...conns.entries()].filter(([ws]) => ws.readyState === 1).map(([, s]) => s.clientId))
      const orphanedMirrorGroups = (mirror?.allGroups() ?? []).filter((g) => !connectedClientIds.has(g.ownerClientId)).length

      const rawGrants = deps.coControl?.rawGrantSnapshot() ?? []
      const nowSec = Math.floor(Date.now() / 1000)
      const uncollectedGrants = rawGrants.filter((g) => nowSec - g.expiresAt > UNCOLLECTED_GRANT_GRACE_SEC).length

      return {
        lanes,
        assistsActive: deps.coControl?.activeGrantCount() ?? 0,
        mirrorGroups: mirrorStats.groups,
        mirrorMembers: mirrorStats.members,
        mirrorFanoutMsP50: mirrorStats.fanoutMsP50,
        mirrorFanoutMsP95: mirrorStats.fanoutMsP95,
        queueWaitMs: deps.coControlQueueWaitMs?.() ?? DEFAULT_QUEUE_WAIT_MS,
        uncollectedGrants,
        orphanedMirrorGroups,
      }
    },
  }
}
