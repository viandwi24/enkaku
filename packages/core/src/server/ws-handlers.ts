import type { ServerWebSocket } from 'bun'
import type { AdbClient } from '@enkaku/adb'
import { engineDescriptors } from '@enkaku/drivers'
import { eq } from 'drizzle-orm'
import {
  ClientMessageSchema,
  describeKey,
  E_DEVICE_CONFLICT,
  encodeSnapshot,
  encodeVideoFrame,
  KEY_TABLE,
  KEYCODES,
  type ActivityKind,
  type ArtifactInfo,
  type ControlSettings,
  type DeviceActivity,
  type DeviceEvent,
  type DeviceEventStream,
  type FrameMeta,
  type GestureSample,
  type NormPoint,
  type PolicyDecision,
  type Point,
  type Quality,
  type ServerMessage,
  type ShellMode,
  type Viewer,
} from '@enkaku/protocol'
import type { PairingService } from '../enroll/pairing'
import type { AdbEndpointManager } from '../device/adb-endpoint'
import type { ActivityRegistry } from '../activity/registry'
import { evaluate } from '../activity/policy'
import type { ReadinessManager } from '../device/readiness'
import { DEFAULT_TIMING, resolveTextRoute, SessionError, buildSentence, type AlwaysOn, type DeviceSession, type InputLane, type InputSource, type SessionManager } from '@enkaku/session'
import type { JobService } from '../services/job-service'
import type { AuditLogger } from '../auth/audit'
import type { EventRecorder } from '../events/recorder'
import type { RecordingService } from '../recording/service'
import type { Db } from '../db'
import { devices } from '../db/schema'
import { canCancelJob, canUseDevice, canUseShell } from '../auth/acl'
import type { Role } from '../auth/service'
import type { DeviceStateMachine } from '../device/state-machine'
import { createMonitorHub, runOneshotMonitor } from '../device/monitor-hub'
import { createCrashWatcher, type CrashPolicy } from '../device/crash-watcher'
import { createLocalShellPort, createRemoteShellPort, type ShellPort } from '../device/shell-port'
import { createShellSessionStore } from '../device/shell-session'
import { redactShellCommand } from '../device/redact'
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
 * Exported (plan 93 §3.6, H2, step 93.4) so the deleted fleet command surface's own preview-byte Zod
 * bound (`@enkaku/protocol`'s `settings.ts`) can be asserted against the
 * REAL number in a unit test, rather than a hand-copied duplicate that can
 * drift out of step with this one silently.
 */
export const MAX_BUFFERED = 512 * 1024

/**
 * Plan 206 §3.8, §4.8 (R8) — Bun's own `websocket.backpressureLimit`, passed
 * to `Bun.serve` in `daemon.ts`. Wider than `MAX_BUFFERED` (which decides
 * per-frame drop-to-keyframe here) so Bun's own enqueue limit is never the
 * first thing to trip; `closeOnBackpressureLimit: false` means a socket that
 * hits it stays open and simply keeps dropping sends (the existing
 * congestion path), never disconnected outright.
 */
export const BACKPRESSURE_LIMIT_BYTES = 4 * MAX_BUFFERED

/** The Inspect tab's `dump`/`find` deadline (plan 56 §4.2 step 5, acceptance #9) — `ui-server` targets well under this; `uiautomator-dump` can legitimately take 1-2s, so this is generous, not tight. */
const INSPECT_DEADLINE_MS = 20_000
/**
 * The attach deadline, separate from `INSPECT_DEADLINE_MS` above and
 * deliberately larger (field report, 2026-08-26).
 *
 * `session.whenInspectorReady()` used to be awaited with NO deadline at all,
 * while every other inspect operation was bounded. On a 20-device farm the
 * ui-server cold start was measured at **32 s** (control taken 03:44:44 →
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
 *
 * Plan 208 §4.11: this ceiling still covers a first-ever start on a fresh
 * device (two APKs installed over USB before the instrumentation ever runs),
 * but the engine is session-scoped now (§3.2) — a healthy, prewarmed attach
 * answers in milliseconds, and this deadline is only ever paid once per
 * session, not once per Inspect tab open.
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
 * `GET /api/adb/stats`'s `input` block (plan 91 §4.10, narrowed by plan 205
 * §4.8 to `lanes` only — the subordinate-grant and per-client fan-out
 * observability fields this block used to carry had no producer once the
 * activity model replaced their source subsystems) — `daemon.ts` wires
 * `inputStats()` (below, on the returned object) into `createAdbStatsRoutes`
 * through the same forward-ref pattern `transportStats()` already uses.
 */
export interface InputStatsBlock {
  lanes: Record<InputLane, { depth: number; waitMsP50: number; waitMsP95: number; refusals: number }>
}

/** Which arbiter lane an `input.*` message type runs on (plan 91 §3.3, §5 step 91.10) — mirrors `input-arbiter.ts`'s own split, duplicated here (not imported) for the same "a caller owns its own naming" reasoning; used only to name the lane in the rate-limited E_INPUT_BUSY warn below. */
function laneForInputType(type: string): InputLane {
  if (type === 'input.key') return 'keys'
  if (type === 'input.text') return 'text'
  return 'pointer'
}

/** Rate-limit window for the E_INPUT_BUSY warn (plan 91 §5 step 91.10) — an operator holding a finger on a busy device refuses every ~40-120ms tap identically; one line per (device, lane) every this-many-ms says "still happening" without flooding the log, the same "once per key per window" shape `util/slow-log.ts`'s `createSlowLogger` already uses for slow commands (duplicated rather than reused: that helper gates on a duration threshold, a different contract). */
const INPUT_BUSY_WARN_WINDOW_MS = 10_000

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
   * at all requires passing the admission gate (plan 205 §4.8), so a
   * disconnect here really is "the controlling client went away", the same
   * case `endWhere` handles for the `command:<clientId>` activity itself.
   */
  shellDevices: Set<string>
  /** Devices this connection currently holds an `inspect.attach` on (plan 56 §3.2) — used to release its share of the ref count on `inspect.detach`, WS close, or a second attach being a harmless no-op. */
  inspectAttached: Set<string>
  /** One `device.activity.warning` per device per minute for this connection (MVP 04 §3, plan 205 §4.8) — deviceId → the unix-ms timestamp of the last warning sent. */
  warnedAt: Map<string, number>
  /** Plan 209 §3.2 D7/D8: one record per `${deviceId}:${pointerId}` while a finger is down. */
  touches: Map<string, TouchStream>
}

/** Plan 209 §4.10: tracks one live pointer stream from `down` to `up`, so the core coalesces moves and recovers the recorded shape on `up`. */
interface TouchStream {
  deviceId: string
  pointerId: number
  startedAt: number
  /** Normalised samples, `atMs` relative to `startedAt`. Only meaningful for pointer 0 (the recorded stream). */
  samples: Array<{ x: number; y: number; atMs: number }>
  /** A `touch()` submit currently running on the arbiter for this key. */
  inFlight: boolean
  /** The newest un-dispatched move while `inFlight` (D7: newest wins). */
  latestMove: NormPoint | null
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
  /** The device activity registry (plan 205 §4.2) — the one door every gated case goes through via `admit()`. */
  activities: ActivityRegistry
  /** `control.overControl`/`control.idleSec`, read fresh on every admission check (plan 205 §4.5). */
  controlSettings: () => ControlSettings
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
  /** Security audit trail (plan 18 §3.2, §18.4) — a control marker itself is never audited (only recorded to the device event log), just the actions this file already calls `audit.record` for. */
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
   * other settings accessor in this file uses; omitted falls back to
   * `DEFAULT_TIMING.tapJitterMs`.
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
   * `canUseDevice`'s device half (plan 34 §3.5, §4.4) — an ownership check
   * used elsewhere (job enqueue, bulk operations). Optional so an existing
   * test harness (or a host that has not wired auth) keeps compiling
   * unchanged; omitting it means "no ownership check", the same default
   * every other optional ACL dep here uses.
   */
  getDeviceOwner?: (deviceId: string) => { ownerId: string | null } | null
  /** The farm's `shell` settings block, read fresh on every `shell.exec` (plan 26 §4.1). */
  shellSettings: () => { mode: ShellMode; execTimeoutMs: number; maxOutputBytes: number }
  /** The adb endpoint, scoped to a controlling client (plan 27 §4.2) — torn down on WS disconnect (`handleClose`). */
  adbEndpoint: AdbEndpointManager
  /**
   * Device readiness — `stream.start` no longer takes a viewer hold (plan
   * 206 §3.7: the wake happens inside the always-on build's own step 2).
   * `hold` stays on this Pick because `holdFor` (the Monitor tab, below)
   * still calls it; `set` backs `device.readiness.set`. Optional so
   * tests/hosts (and orchestrator mode, which has no local readiness manager
   * at all) that do not wire it keep working unchanged.
   */
  readiness?: Pick<ReadinessManager, 'hold' | 'set'>
  /** The always-on builder (plan 206 §4.2) — `stream.start`'s `E_SESSION_PREPARING` reads its per-device build state for the activity sentence. Optional: a host or test that predates plan 206 gets the bare `'Preparing'` fallback. */
  alwaysOn?: Pick<AlwaysOn, 'stateOf'>
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
   * Raw device status, with no notion of any particular client (plan 205
   * §4.8) — `admit()`'s own first check, and the crash watcher's
   * attribution. Required (unlike the deleted optional deps this plan
   * removes): every host wires the real state machine.
   */
  states: Pick<DeviceStateMachine, 'current'>
  /**
   * The action recorder (plan 94 §4.6, §5 step 94.3) — one active recording
   * per device, keyed by deviceId, owned by whoever holds the device's
   * control marker. `recording.start`/`.stop`/`.cancel` are gated by the SAME
   * `admit()` gate `input.*` already uses (never a parallel check — this
   * plan's own brief). Optional, the same "omitted means it does not exist
   * here" convention every other optional dep in this file uses: a host or
   * test that has not wired plan 94 gets `E_NOT_SUPPORTED` from
   * `recording.*`, and the `input.*` tee below is a harmless no-op
   * (`deps.recording?.get(...)`).
   */
  recording?: RecordingService
  log: Logger
}

export function createWsMessageHandler(deps: WsHandlerDeps) {
  // A plain Map, not a WeakMap: publishing a device event needs to iterate
  // every connection's subscriptions, which a WeakMap cannot do. `handleClose`
  // deletes the entry explicitly so this cannot grow unbounded.
  const conns = new Map<ServerWebSocket<unknown>, ConnState>()

  /** Plan 209 §3.2 D11: host-side `input.touch` dispatch times, deviceId → a 128-sample ring, most recent last. */
  const INPUT_DISPATCH_RING_SIZE = 128
  const inputDispatch = new Map<string, number[]>()
  function recordDispatch(deviceId: string, ms: number): void {
    let ring = inputDispatch.get(deviceId)
    if (!ring) {
      ring = []
      inputDispatch.set(deviceId, ring)
    }
    ring.push(ms)
    if (ring.length > INPUT_DISPATCH_RING_SIZE) ring.shift()
  }
  function dispatchPercentile(sortedAsc: number[], p: number): number {
    if (sortedAsc.length === 0) return 0
    const idx = Math.min(sortedAsc.length - 1, Math.floor(p * sortedAsc.length))
    return sortedAsc[idx] ?? 0
  }

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
        warnedAt: new Map(),
        touches: new Map(),
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
   * The engine is session-scoped now (plan 208 §3.2): `inspect.attach`
   * attaches to whatever inspector the session already has (started by the
   * session itself), and a viewer leaving — an explicit `inspect.detach`, a
   * WS close, or the device going away — releases NOTHING but this
   * connection's own bookkeeping. Idempotent — a connection that never
   * attached (or already detached) is a harmless no-op.
   */
  const noteInspectDetached = (deviceId: string, state: ConnState): void => {
    if (!state.inspectAttached.delete(deviceId)) return
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
    // Attribution requires a RUNNING JOB specifically (plan 37 §3.3, §8
    // risks) — a live control marker at the moment of the crash means
    // "record only". The activity registry is the one source of truth for
    // "is a job running on this device" (plan 205 §4.2).
    runningJobOf: (deviceId) => {
      const jobActivity = deps.activities.list(deviceId).find((a) => a.kind === 'job' || a.kind === 'workflow-job')
      return jobActivity ? { jobId: jobActivity.id.replace(/^(job|workflow-job):/, '') } : null
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
  // `device.activity` already establishes for "who is doing what to this
  // device" facts.
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
   * structure); `holdsControl` reads the activity registry (plan 205 §4.8),
   * true whenever that connection's `control:<clientId>` marker is live —
   * several viewers may be true at once, unlike the old single-holder model.
   */
  const viewersOf = (deviceId: string): Viewer[] => {
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
        holdsControl: deps.activities.controlOf(deviceId, state.clientId) !== null,
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

  /**
   * The one admission door for every gated case below (plan 205 §4.8) —
   * never acquires anything, just asks the activity policy. `starting` is
   * the activity kind about to begin; `admit` never starts it — callers
   * that need a marker call `deps.activities.touchControl`/`.start`
   * themselves after a `{ ok: true }` result.
   */
  type Gate = { ok: true; warning: PolicyDecision | null } | { ok: false; code: string; message: string }
  function admit(deviceId: string, state: ConnState, starting: ActivityKind): Gate {
    const status = deps.states.current(deviceId)
    if (status === null) return { ok: false, code: 'device_not_found', message: 'no such device' }
    if (status !== 'online') return { ok: false, code: 'device_unavailable', message: `the device is ${status}` }
    const decision = evaluate(starting, deps.activities.list(deviceId), deps.controlSettings(), {
      selfIds: [`control:${state.clientId}`, `command:${state.clientId}`],
    })
    if (decision.decision === 'forbid') return { ok: false, code: E_DEVICE_CONFLICT, message: decision.message }
    return { ok: true, warning: decision.decision === 'warn' ? decision : null }
  }

  /** One `device.activity.warning` per device per minute per connection (MVP 04 §3, plan 205 §4.8). */
  function warnOnce(ws: ServerWebSocket<unknown>, state: ConnState, deviceId: string, decision: PolicyDecision): void {
    if (!decision.conflicting) return
    const now = Date.now()
    const last = state.warnedAt.get(deviceId)
    if (last !== undefined && now - last < 60_000) return
    state.warnedAt.set(deviceId, now)
    send(ws, { type: 'device.activity.warning', payload: { deviceId, message: decision.message, conflicting: decision.conflicting } })
  }

  /** The actor a live `input.*`/`command`/etc. message is attributed to (plan 205 §4.8). */
  function actorOf(state: ConnState): { kind: 'user'; id: string; label: string } {
    return { kind: 'user', id: state.userId ?? state.clientId, label: deps.userLabel?.(state.userId) ?? 'a signed-out client' }
  }

  /** Plan 209 §3.2 D8: travel under 1% of the frame's normalised space is a tap, not a gesture. */
  const TAP_MAX_TRAVEL = 0.01

  /** Appends a normalised sample to a `TouchStream`, capped at 299 + the release point (D8, the `input.gesture` schema ceiling of 300). */
  function pushSample(stream: TouchStream, pos: NormPoint): void {
    const atMs = Date.now() - stream.startedAt
    if (stream.samples.length < 299) stream.samples.push({ x: pos.x, y: pos.y, atMs })
    else stream.samples[stream.samples.length - 1] = { x: pos.x, y: pos.y, atMs }
  }

  /** Plan 209 §3.2 D8: a finished touch stream (pointer 0 only) is recorded as one tap or one gesture on `up`, never per sample. */
  function observeStream(deviceId: string, stream: TouchStream, actor: string | null): void {
    const first = stream.samples[0]
    const last = stream.samples[stream.samples.length - 1]
    if (!first || !last) return
    let travel = 0
    for (const s of stream.samples) travel = Math.max(travel, Math.hypot(s.x - first.x, s.y - first.y))
    if (travel < TAP_MAX_TRAVEL) {
      deps.recorder.record({
        deviceId,
        stream: 'input',
        kind: 'input.tap',
        actor,
        meta: { x: last.x, y: last.y, w: 0, h: 0, holdMs: last.atMs },
      })
      deps.recording?.get(deviceId)?.observe({ kind: 'tap', pos: { x: last.x, y: last.y }, holdMs: last.atMs })
    } else {
      deps.recorder.record({
        deviceId,
        stream: 'input',
        kind: 'input.gesture',
        actor,
        meta: { from: first, to: last, samples: stream.samples.length, durationMs: last.atMs - first.atMs },
      })
      deps.recording?.get(deviceId)?.observe({ kind: 'gesture', samples: stream.samples })
    }
  }

  /**
   * Plan 209 §4.10 "Release on stop": any `TouchStream` still open on this
   * connection for the given device (or every device, on a full disconnect)
   * gets an `up` sent through the sink at its last sample, and is observed
   * as the tap or gesture it was — a browser that never sent its own `up`
   * (a closed tab, a dropped stream) must never leave a finger down on the
   * device (MVP 08 §1.1 last row).
   */
  function releaseTouchStreams(connState: ConnState, onlyDeviceId: string | null): void {
    for (const [key, stream] of [...connState.touches]) {
      if (onlyDeviceId && stream.deviceId !== onlyDeviceId) continue
      connState.touches.delete(key)
      try {
        const session = deps.sessions?.get(stream.deviceId) ?? null
        if (session) {
          const source: InputSource = { kind: 'user', id: connState.clientId, userId: connState.userId }
          const sink = session.arbiter.for(source)
          const last = stream.samples[stream.samples.length - 1]
          if (last && sink.touch) {
            const p = mapNormToDevice(last, session.frameSize)
            void sink.touch('up', p, stream.pointerId).catch(() => undefined)
          }
        }
      } catch {
        // Best-effort, matching every other cleanup call in `handleClose`/
        // `stream.stop` — a fixture with no real arbiter (most tests) or a
        // session that has already gone away must not stop the rest of
        // teardown from running.
      }
      if (stream.pointerId === 0) observeStream(stream.deviceId, stream, connState.userId)
    }
  }

  /** Plan 209 §4.10: every key up, called on stream stop and disconnect. */
  function releaseKeysFor(connState: ConnState, deviceId: string): void {
    try {
      const session = deps.sessions?.get(deviceId) ?? null
      if (!session) return
      const source: InputSource = { kind: 'user', id: connState.clientId, userId: connState.userId }
      const sink = session.arbiter.for(source)
      void sink.releaseKeys?.().catch(() => undefined)
    } catch {
      // Best-effort — see `releaseTouchStreams` above.
    }
  }

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
                    transportMetrics.recordFrameDropped()
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
                // Plan 206 §3.8, §4.8 (R8): `ws.send()` returns `0` when Bun
                // dropped the message under backpressure — treated exactly
                // like the buffered-amount congestion check above (mark
                // `awaitingKeyframe`, ask for a fresh IDR). `handleDrain`
                // below is the other half: it re-asks the moment the socket
                // is writable again, instead of waiting for the encoder's
                // next scheduled IDR.
                const sent = ws.send(encoded)
                if (sent === 0 && meta.codec !== 'png' && !binding.awaitingKeyframe) {
                  binding.awaitingKeyframe = true
                  countersFor(binding).keyframeRequests++
                  transportMetrics.recordFrameDropped()
                  sessionForBinding(binding)?.requestKeyframe?.()
                }
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
            // Plan 206 §3.4, §4.5 — set only when a `control` request is
            // being served by the always-on WALL encoder while the control
            // encoder's own build is still in flight (or has none to serve
            // it from). Reported honestly on `stream.started` rather than a
            // new message type, and the wire says so again on `stream.meta`
            // once the switch actually happens.
            let substitute: 'wall' | undefined
            let degradedReason: 'control_encoder_unavailable' | undefined
            let degradedDetail: string | undefined
            let localSession: DeviceSession | null = null

            /** SPS/PPS then the cached IDR — a joining viewer has nothing to decode without both (plan 17 §3.6). */
            const primeSession = (session: DeviceSession, size: { width: number; height: number }): boolean => {
              const primer: FrameMeta = { width: size.width, height: size.height, codec: 'h264', seq: 0, ptsUs: 0n, hostReceivedAt: Date.now(), keyframe: true }
              const config = session.videoConfig?.()
              if (config) ws.send(encodeVideoFrame(streamId, primer, config))
              const keyframe = session.videoKeyframe?.()
              if (keyframe) ws.send(encodeVideoFrame(streamId, primer, keyframe))
              return keyframe !== null && keyframe !== undefined
            }

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
              // Plan 206 §3.7: the wake happens inside the always-on build's
              // own step 2, not here — there is no viewer readiness hold any
              // more (`ws-handlers.ts:1012`'s old `readiness.hold(...,
              // 'viewer')` is deleted).
              let attach
              try {
                attach = await deps.sessions.attachViewer(msg.payload.deviceId, requestedQuality, binding.onFrame, {
                  onSwitched: (control) => {
                    binding.quality = 'control'
                    binding.lastSize = { width: control.frameSize.width, height: control.frameSize.height }
                    send(ws, {
                      type: 'stream.meta',
                      payload: { streamId, width: control.frameSize.width, height: control.frameSize.height, quality: 'control' },
                    })
                    // No `requestKeyframe` here (unlike the initial prime
                    // below): the keyframe that triggered this very switch
                    // IS the fresh IDR — asking for another would be the
                    // same premature `RESET_VIDEO` §3.6 already avoids.
                    primeSession(control, control.frameSize)
                  },
                  onControlFailed: (reason) => {
                    send(ws, { type: 'stream.meta', payload: { streamId, width: binding.lastSize.width, height: binding.lastSize.height, quality: 'wall', detail: reason } })
                  },
                })
              } catch (err) {
                if (err instanceof SessionError && err.code === 'device_not_ready') {
                  const status = deps.states.current(msg.payload.deviceId)
                  if (status === 'offline' || status === null) {
                    sendError(ws, 'device_offline', 'the device is offline', msg.id)
                  } else {
                    const info = deps.alwaysOn?.stateOf(msg.payload.deviceId)
                    sendError(ws, 'E_SESSION_PREPARING', buildSentence(info ?? null), msg.id)
                  }
                  return
                }
                throw err
              }
              const session = attach.session
              codec = session.displayEngineId === 'scrcpy' ? 'h264' : 'png'
              frameSize = session.frameSize
              quality = attach.quality
              substitute = attach.substitute
              degradedReason = attach.degradedReason
              degradedDetail = attach.degradedDetail
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
            // Recorded AFTER attach succeeds: if attach throws, no binding is
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
                ...(substitute ? { substitute } : {}),
                ...(degradedReason ? { degradedReason } : {}),
                ...(degradedDetail ? { degradedDetail } : {}),
              },
            })
            // A new viewer needs SPS/PPS to configure its decoder, and then a
            // keyframe to actually paint something. Sending only the config
            // leaves the canvas black until the encoder's next IDR — seconds
            // later — and the browser rejects the deltas that arrive meanwhile
            // ("a key frame is required after configure()"). `localSession`
            // is the EXACT entry `attachViewer` returned above (plan 206
            // §4.3) — never re-fetched via `sessions.get(deviceId)`, which
            // would resolve the wrong slot whenever the other quality is
            // also open.
            const hadKeyframe = localSession ? primeSession(localSession, frameSize) : false
            if (hadKeyframe) {
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
            else deps.sessions?.detachViewer(binding.onFrame)
            // Plan 209 §4.10: an open touch stream on this device must not
            // leave a finger down when the viewer stops.
            releaseTouchStreams(state, binding.deviceId)
            releaseKeysFor(state, binding.deviceId)
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
            // Read-only, no admission check, allowed alongside a running job
            // (plan 24 §4.4) — watching a job's logcat is a primary use
            // case, so this deliberately does NOT call `admit()`.
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
            // 2. The SAME admission gate input uses (plan 205 §4.8) — no
            // second policy: online/conflicting-activity are both covered
            // here.
            const gate = admit(deviceId, state, 'command')
            if (!gate.ok) {
              sendError(ws, gate.code, gate.message, msgId)
              return
            }
            if (gate.warning) warnOnce(ws, state, deviceId, gate.warning)
            // 3. Resolve local vs. remote — throws node_offline/device_not_found/E_ADB_UNAVAILABLE,
            // caught by the outer try/catch below, same as monitor.start/oneshot.
            const port = shellPortFor(deviceId)
            // 4. The command activity lasts exactly as long as this call
            // (plan 205 §4.8, §4.10) — started here, ended in the `finally`
            // below, never left running past this handler.
            deps.activities.start(deviceId, { id: `command:${state.clientId}`, kind: 'command', label: 'Running an adb command', actor: actorOf(state) })
            state.shellDevices.add(deviceId)

            const actor = state.userId
            const cwdAtStart = shellSessions.getCwd(deviceId)
            const startedAt = Date.now()

            try {
            // 6. Emitted the instant the command is accepted, before it has
            // run, so every viewer sees what is executing (plan 26 §3.8, §4.2).
            for (const target of shellTargets(deviceId, ws)) {
              send(target, {
                type: 'shell.echo',
                payload: { deviceId, cmd, cwd: cwdAtStart, actor, at: Math.floor(startedAt / 1000) },
              })
            }
            // 5. Recorded AFTER the admission check passes and BEFORE the device
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
            }
            } finally {
              deps.activities.end(deviceId, `command:${state.clientId}`)
            }
            return
          }

          case 'input.tap':
          case 'input.swipe':
          case 'input.gesture':
          case 'input.key':
          case 'input.text': {
            // Server-authoritative: the activity policy and status are
            // validated here, not merely disabled in the UI (spec §10.1,
            // plan 205 §4.8). The server never refuses a tap for lack of a
            // control marker — only on `forbid`, or when the device is
            // offline/quarantined; `warn` proceeds and tells (MVP 04 §3).
            const gate = admit(msg.payload.deviceId, state, 'control')
            if (!gate.ok) {
              sendError(ws, gate.code, gate.message, msgId)
              return
            }
            if (gate.warning) warnOnce(ws, state, msg.payload.deviceId, gate.warning)
            const source: InputSource = { kind: 'user', id: state.clientId, userId: state.userId }
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
            // The control marker is created or refreshed on every accepted
            // input (MVP 04 §1.2, plan 205 §4.2) — several operators may
            // control one device at once, so this never refuses for lack of
            // a marker, only touches the caller's own.
            deps.activities.touchControl(msg.payload.deviceId, state.clientId, actorOf(state))
            // Recorded AFTER the admission check passes and BEFORE awaiting
            // the device (plan 18 §18.5): a rejected input (handled above,
            // this point is unreached) is never logged as if it happened. The
            // record() call itself never awaits — buffered, never on the
            // input path's critical section (plan 18 §3.5).
            const actor = state.userId
            // Plan 91 §3.1, §3.3, §4.1 — fixes F6/H1: a local session's writes
            // go through its arbiter (three non-preemptive priority lanes over
            // the ONE shared virtual pointer), never the raw `input` sink
            // directly, so a second person controlling the same device (MVP
            // 04 §1.3's own "several operators at once" reading) can never
            // interleave with this write. A node-owned remote session has no
            // arbiter (§2 non-goals: cloud/node devices are out of scope for
            // this plan) — `'arbiter' in session` is the same kind of
            // structural discriminant the `'textInput' in session` check
            // below already uses to tell the two session shapes apart.
            const sink = 'arbiter' in session ? session.arbiter.for(source) : session.input
            if (msg.type === 'input.tap') {
              const p = mapNormToDevice(msg.payload.pos, session.frameSize)
              deps.recorder.record({
                deviceId: msg.payload.deviceId,
                stream: 'input',
                kind: 'input.tap',
                actor,
                meta: { x: p.x, y: p.y, w: session.frameSize.width, h: session.frameSize.height },
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
                meta: { from, to, durationMs: msg.payload.durationMs },
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
                meta: { keycode: msg.payload.keycode, ...(name ? { name } : {}) },
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
                meta: { ...redactInputText(text, logText) },
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

          case 'input.touch':
          case 'input.scroll':
          case 'input.keyEvent':
          case 'input.pinch': {
            // Plan 209 §2 non-goals: the cloud path's `input.*` refuses these
            // four new verbs with `E_NOT_SUPPORTED` — the remote branch never
            // reaches the arbiter/sink code below.
            if (deps.remote?.nodeIdFor(msg.payload.deviceId)) {
              sendError(ws, 'E_NOT_SUPPORTED', 'live input is not available for a node-owned device in the MVP', msgId)
              return
            }
            const gate = admit(msg.payload.deviceId, state, 'control')
            if (!gate.ok) {
              sendError(ws, gate.code, gate.message, msgId)
              return
            }
            if (gate.warning) warnOnce(ws, state, msg.payload.deviceId, gate.warning)
            const source: InputSource = { kind: 'user', id: state.clientId, userId: state.userId }
            const session = deps.sessions?.get(msg.payload.deviceId) ?? null
            if (!session) {
              sendError(ws, 'E_DEVICE_NOT_READY', 'no active session for this device (start the stream first)', msgId)
              return
            }
            const actor = state.userId
            const sink = session.arbiter.for(source)
            const deviceId = msg.payload.deviceId

            if (msg.type === 'input.touch') {
              const { action, pos, pointerId } = msg.payload
              const key = `${deviceId}:${pointerId}`
              const t0 = performance.now()
              const p = mapNormToDevice(pos, session.frameSize)
              const deliver = async (a: 'down' | 'move' | 'up', q: Point): Promise<void> => {
                if (sink.touch) await sink.touch(a, q, pointerId)
              }
              const markSettled = (): void => {
                const s = state.touches.get(key)
                if (!s) return
                s.inFlight = false
                if (s.latestMove) {
                  const next = s.latestMove
                  s.latestMove = null
                  s.inFlight = true
                  void deliver('move', mapNormToDevice(next, session.frameSize)).finally(markSettled)
                }
              }

              if (action === 'down') {
                // A lost `up` (tab switch mid-drag): close the prior stream first (MVP 08 §1.1 last row).
                const prior = state.touches.get(key)
                if (prior) {
                  const priorLast = prior.samples[prior.samples.length - 1] ?? pos
                  if (sink.touch) await sink.touch('up', mapNormToDevice(priorLast, session.frameSize), pointerId)
                  state.touches.delete(key)
                  if (pointerId === 0) observeStream(deviceId, prior, actor)
                }
                state.touches.set(key, { deviceId, pointerId, startedAt: Date.now(), samples: [{ x: pos.x, y: pos.y, atMs: 0 }], inFlight: true, latestMove: null })
                deps.activities.touchControl(deviceId, state.clientId, actorOf(state))
                try {
                  await deliver('down', p)
                } finally {
                  markSettled()
                }
                recordDispatch(deviceId, performance.now() - t0)
                return
              }

              const stream = state.touches.get(key)
              if (!stream) return // a move/up with no down: dropped, never an error

              if (action === 'move') {
                pushSample(stream, pos)
                if (stream.inFlight) {
                  // D7: newest wins — this sample replaces whatever was pending.
                  stream.latestMove = pos
                  return
                }
                stream.inFlight = true
                try {
                  await deliver('move', p)
                } finally {
                  markSettled()
                }
                recordDispatch(deviceId, performance.now() - t0)
                return
              }

              // action === 'up'
              stream.latestMove = null
              pushSample(stream, pos)
              state.touches.delete(key)
              deps.activities.touchControl(deviceId, state.clientId, actorOf(state))
              if (sink.touch) {
                await sink.touch('up', p, pointerId)
              } else if (pointerId === 0 && stream.samples.length >= 2) {
                // No touch(): adb-input. The stream is replayed as one swipe on up.
                const firstPoint = mapNormToDevice(stream.samples[0]!, session.frameSize)
                await sink.swipe(firstPoint, p, Math.max(50, Date.now() - stream.startedAt))
              }
              recordDispatch(deviceId, performance.now() - t0)
              if (pointerId === 0) observeStream(deviceId, stream, actor)
              return
            }

            if (msg.type === 'input.scroll') {
              const { pos, hDelta, vDelta } = msg.payload
              const p = mapNormToDevice(pos, session.frameSize)
              if (!sink.scroll) {
                sendError(ws, 'E_INPUT_UNSUPPORTED', 'this input engine cannot scroll (adb-input)', msgId)
                return
              }
              deps.activities.touchControl(deviceId, state.clientId, actorOf(state))
              deps.recorder.record({
                deviceId,
                stream: 'input',
                kind: 'input.scroll',
                actor,
                meta: { x: p.x, y: p.y, hDelta, vDelta },
              })
              await sink.scroll(p, hDelta, vDelta)
              return
            }

            if (msg.type === 'input.keyEvent') {
              const { action, code, meta } = msg.payload
              const key = describeKey(code)
              if (action === 'down') {
                deps.activities.touchControl(deviceId, state.clientId, actorOf(state))
                if (sink.keyDown) await sink.keyDown(key, meta)
                return
              }
              // action === 'up': the D9 event-log row — a printable key is
              // redacted like typed text when `logInputText` is off; a
              // non-printable key always logs its `code`.
              deps.activities.touchControl(deviceId, state.clientId, actorOf(state))
              const logText = deps.isLogInputTextEnabled(deviceId)
              const isPrintable = KEY_TABLE[code].printable
              deps.recorder.record({
                deviceId,
                stream: 'input',
                kind: 'input.keyEvent',
                actor,
                meta:
                  isPrintable && !logText
                    ? { printable: true }
                    : { code, androidKeycode: key.androidKeycode, shift: meta.shift, ctrl: meta.ctrl, alt: meta.alt, meta: meta.meta },
              })
              deps.recording?.get(deviceId)?.observe({ kind: 'key', keycode: key.androidKeycode })
              if (sink.keyUp) await sink.keyUp(key, meta)
              else await sink.key(key.androidKeycode)
              return
            }

            // msg.type === 'input.pinch'
            {
              const { center, scaleFrom, scaleTo, durationMs } = msg.payload
              if (!sink.pinch) {
                sendError(ws, 'E_INPUT_UNSUPPORTED', 'this input engine cannot pinch (adb-input)', msgId)
                return
              }
              const c = mapNormToDevice(center, session.frameSize)
              const base = Math.min(session.frameSize.width, session.frameSize.height)
              deps.activities.touchControl(deviceId, state.clientId, actorOf(state))
              deps.recorder.record({
                deviceId,
                stream: 'input',
                kind: 'input.pinch',
                actor,
                meta: { center, scaleFrom, scaleTo, durationMs },
              })
              await sink.pinch({ center: c, radiusFromPx: scaleFrom * base, radiusToPx: scaleTo * base, durationMs })
              return
            }
          }

          case 'recording.start': {
            // Plan 94 §4.6, §4.9, §5 step 94.3 — the SAME `admit()` gate
            // `input.*` uses above, never a parallel check ("if you find
            // yourself writing a second permission check, stop and report" —
            // this plan's own brief, reaffirmed by plan 205 §4.8).
            const { deviceId } = msg.payload
            const gate = admit(deviceId, state, 'control')
            if (!gate.ok) {
              sendError(ws, gate.code, gate.message, msgId)
              return
            }
            if (gate.warning) warnOnce(ws, state, deviceId, gate.warning)
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
            // try/catch exactly like any other coded error.
            //
            // Anchors/screenshots come from WHATEVER inspector this session
            // already has attached (the same `session.inspector` the
            // `inspect.*` cases above read) — this deliberately does NOT
            // start one of its own: the engine is session-scoped (plan 208
            // §3.2), started by the session itself (`prewarmInspector()` or
            // the first `whenInspectorReady()`), never by this recording
            // handler. A recording opened before the prewarm settles simply
            // gets no anchors and no screenshots yet — never a failed
            // recording (§4.6).
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
            const gate = admit(deviceId, state, 'control')
            if (!gate.ok) {
              sendError(ws, gate.code, gate.message, msgId)
              return
            }
            if (gate.warning) warnOnce(ws, state, deviceId, gate.warning)
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
            const gate = admit(deviceId, state, 'control')
            if (!gate.ok) {
              sendError(ws, gate.code, gate.message, msgId)
              return
            }
            if (gate.warning) warnOnce(ws, state, deviceId, gate.warning)
            deps.recording?.cancel(deviceId)
            deps.recorder.record({ deviceId, stream: 'main', kind: 'recording.cancelled', actor: state.userId })
            send(ws, {
              type: 'recording.state',
              ...(msgId ? { id: msgId } : {}),
              payload: { deviceId, active: false, stepCount: 0, startedAt: null },
            })
            return
          }

          case 'inspect.attach':
          case 'inspect.dump':
          case 'inspect.find': {
            // Reading the screen is a control-grade action (plan 56 §3.7): it
            // can carry whatever text is on screen (passwords included) and
            // seizes the `instrumentation` lock, so it is gated exactly like
            // `input.*` — the SAME server-authoritative admission check,
            // never merely a disabled button (spec §10.1, plan 205 §4.8).
            const { deviceId } = msg.payload
            const gate = admit(deviceId, state, 'control')
            if (!gate.ok) {
              sendError(ws, gate.code, gate.message, msgId)
              return
            }
            if (gate.warning) warnOnce(ws, state, deviceId, gate.warning)
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
            deps.activities.touchControl(deviceId, state.clientId, actorOf(state))

            if (msg.type === 'inspect.attach') {
              send(ws, {
                type: 'inspect.status',
                payload: { deviceId, state: 'starting', engineId: session.inspectorEngineId, capabilities: [] },
              })
              const attachStartedAt = Date.now()
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
              // Plan 208 §3.2, §4.11: attach to whatever the session already
              // has running — a tab is a viewer, never an owner. Idempotent
              // per connection: a tab that calls attach twice (e.g. a
              // reconnect) records nothing new. `tookMs` is near-zero for a
              // prewarmed engine and the whole cold-start cost only the
              // first-ever attach on a fresh device.
              if (!state.inspectAttached.has(deviceId)) {
                state.inspectAttached.add(deviceId)
                deps.recorder.record({
                  deviceId,
                  stream: 'main',
                  kind: 'inspect.attached',
                  actor: state.userId,
                  meta: { engineId, tookMs: Date.now() - attachStartedAt },
                })
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
              // Plan 208 §3.8: a caller that reached this before the
              // session's engine exists gets "starting, retry", never
              // "unavailable" — the engine is on its way (the prewarm, or a
              // job's own `whenInspectorReady()`), not genuinely broken.
              if (session.inspectorEngineId === 'starting') {
                sendError(ws, 'E_INSPECTOR_STARTING', 'the inspector is still starting; retry in a moment', msgId)
              } else {
                sendError(ws, 'E_INSPECT_UNAVAILABLE', `the ${session.inspectorEngineId} engine is not available on this session`, msgId)
              }
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
            noteInspectDetached(msg.payload.deviceId, state)
            return
          }

          case 'clipboard.get': {
            // Read-only, no admission check (plan 38 §4.5, acceptance #5) —
            // same "no state change, no gate" reasoning `monitor.start` uses.
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
            // The exact plan 26 admission pattern (§4.5, reworked by plan 205
            // §4.8): admit, then touchControl, then record — writing the
            // clipboard is input.
            const gate = admit(deviceId, state, 'control')
            if (!gate.ok) {
              sendError(ws, gate.code, gate.message, msgId)
              return
            }
            if (gate.warning) warnOnce(ws, state, deviceId, gate.warning)
            // Resolve local vs. remote — and refuse a session that genuinely
            // cannot do this — BEFORE touching the control marker or
            // recording anything (mirrors `shellPortFor`'s ordering, plan 25 §4.1 step
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
            deps.activities.touchControl(deviceId, state.clientId, actorOf(state))
            const actor = state.userId
            // Recorded AFTER the admission check passes and BEFORE the device is
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
            // No admission/permission check: knowing a `transferId` at all already
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
        // their payload.
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

    /** WS dropped → this connection's streams, log subscriptions, and command activities auto-release. */
    handleClose(ws: ServerWebSocket<unknown>): void {
      const state = conns.get(ws)
      if (!state) return
      // Captured before the map is cleared and this connection is dropped —
      // every device this tab was a viewer of needs an updated list telling
      // the rest that this row is gone (plan 31 §4.2).
      const watchedDeviceIds = new Set(Array.from(state.streams.values(), (b) => b.deviceId))
      for (const binding of state.streams.values()) {
        if (binding.remote) deps.remote?.release(binding.deviceId, binding.onFrame)
        else deps.sessions?.detachViewer(binding.onFrame)
      }
      state.streams.clear()
      // Plan 209 §4.10: a dropped tab must not leave a finger down or a key held.
      for (const deviceId of watchedDeviceIds) releaseKeysFor(state, deviceId)
      releaseTouchStreams(state, null)
      state.logSubs.clear()
      // A dropped WS must not leak a monitor stream (plan 24 §4.4, §4.5 —
      // this is the call the plan's risk table calls out explicitly).
      monitors.releaseClient(state.clientId)
      state.monitorSubs.clear()
      for (const deviceId of state.shellDevices) shellSessions.release(deviceId)
      state.shellDevices.clear()
      // A control marker is deliberately NOT ended on close (MVP 04 §1.3: it
      // expires from the last input, via the registry's own sweep) — but any
      // `command:<clientId>` activity this connection started (`shell.exec`)
      // must not outlive the connection that opened it, the same reasoning
      // every other per-client cleanup call in this function already follows.
      // Every recording this connection's disconnect should end, too — a
      // recording is scoped to whoever is controlling the device, and a
      // dropped tab is one more way that stops (plan 94 §4.6).
      const endedActivityDeviceIds = new Set<string>()
      deps.activities.endWhere((deviceId, activity) => {
        if (activity.kind === 'command' && activity.id === `command:${state.clientId}`) {
          endedActivityDeviceIds.add(deviceId)
          return true
        }
        return false
      })
      for (const deviceId of endedActivityDeviceIds) deps.recording?.stopForDisconnect(deviceId)
      // Any adb endpoint(s) this WS session (the REST route's `clientId`,
      // the same session id `hello` sent) opened must not outlive it either
      // (plan 27 §4.2 — "a WS disconnect" is one of the three teardown triggers).
      deps.adbEndpoint.closeAllForClient(state.clientId)
      // A dropped tab is one more way a viewer leaves (plan 208 §3.2) — the
      // engine itself lives with the session, not with any Inspect tab, so
      // this only records the departure and clears this connection's own
      // bookkeeping.
      for (const deviceId of [...state.inspectAttached]) noteInspectDetached(deviceId, state)
      // A WS disconnect does NOT revert any `vpn-helper` route a connection's
      // control marker was covering (plan 52 §0, §3.1, §4.1): the route
      // belongs to the device, not the connection.
      conns.delete(ws)
      for (const deviceId of watchedDeviceIds) broadcastViewers(deviceId)
      // Agent chat subscriptions are tracked independently of `ConnState` (plan 66 §4.4) — release
      // this connection's share regardless of what else it was doing.
      deps.agent?.handleClose(ws)
    },

    /**
     * Bun's own `websocket.drain` handler (plan 206 §3.8, §4.8, R8): fires
     * when a backpressured socket becomes writable again. Every binding on
     * THIS connection that is `awaitingKeyframe` asks for a fresh IDR right
     * now, instead of waiting for the encoder's next scheduled one — the
     * congestion-recovery half `onFrame`'s own `sent === 0` check starts.
     */
    handleDrain(ws: ServerWebSocket<unknown>): void {
      const state = conns.get(ws)
      if (!state) return
      for (const binding of state.streams.values()) {
        if (binding.awaitingKeyframe) {
          countersFor(binding).keyframeRequests++
          sessionForBinding(binding)?.requestKeyframe?.()
        }
      }
    },

    /**
     * `TransferBroadcast` (plan 93 §4.6, §5 step 93.9, closing F27) —
     * `daemon.ts`'s forward-ref from `transferBroadcast` (constructed well
     * before this router, right after `states`) into `deviceTargets(deviceId)`
     * above, the same "built later, wired back in through a forward
     * reference" shape every other cross-module hook on this returned object
     * already uses. Subscriber-scoped, never `hub.broadcast`: at 100 devices
     * pushing concurrently, a farm-wide broadcast put every open tab on
     * every device's progress ticks. Unlike `shellTargets`, no sender is
     * added — a transfer started by a job has no acting WS connection to
     * add.
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
     * inspector the session owned as part of tearing itself down (plan 208
     * §3.2), so this only clears every connection's stale `inspectAttached`
     * bookkeeping. A later `inspect.attach` on this device then starts
     * clean instead of thinking it is already attached to a dead session.
     */
    resetInspectForDevice(deviceId: string): void {
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

    /** A device's control marker ended, however that happened (plan 26 §3.7, §4.4) — the next controlling client starts at `/`. */
    releaseShellSession(deviceId: string): void {
      shellSessions.release(deviceId)
    },

    /**
     * Any open recording on this device (plan 94 §4.6), for a disconnect-like
     * path outside this router's own `handleClose` (quarantine, a forced
     * teardown) — `handleClose` already calls `deps.recording?.stopForDisconnect`
     * directly for a plain WS drop; this forward-ref is what lets `daemon.ts`
     * reach the same effect for the other paths.
     */
    stopRecordingForDisconnect(deviceId: string): void {
      deps.recording?.stopForDisconnect(deviceId)
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
     * `GET /api/adb/stats`'s `input` block (plan 91 §4.10, narrowed to
     * `lanes` only by plan 205 §4.8) — `daemon.ts` wires this the same
     * forward-ref way `transportStats` right above is.
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

      return { lanes }
    },

    /** Plan 209 §3.2 D11: host-side `input.touch` dispatch times for `GET /api/video/latency`. */
    inputDispatchStats(deviceId: string): { dispatchMsP50: number; dispatchMsP95: number; samples: number } | null {
      const ring = inputDispatch.get(deviceId)
      if (!ring || ring.length === 0) return null
      const sorted = [...ring].sort((a, b) => a - b)
      return { dispatchMsP50: dispatchPercentile(sorted, 0.5), dispatchMsP95: dispatchPercentile(sorted, 0.95), samples: ring.length }
    },

    /**
     * A device-side clipboard change (plan 209 §3.2 D10, §4.9): unicast to
     * every connection holding a `control`-quality stream binding on this
     * device, and to nobody else — never broadcast (plan 38's clipboard rule).
     */
    handleClipboardChanged(deviceId: string, text: string): void {
      for (const [connWs, connState] of conns) {
        if (connWs.readyState !== 1) continue
        const isControlViewer = [...connState.streams.values()].some(
          (b) => b.deviceId === deviceId && (b.quality ?? 'control') === 'control' && !b.remote,
        )
        if (!isControlViewer) continue
        send(connWs, { type: 'clipboard.changed', payload: { deviceId, text } })
      }
      deps.recorder.record({ deviceId, stream: 'input', kind: 'clipboard.changed', actor: null, meta: { length: text.length } })
    },
  }
}
