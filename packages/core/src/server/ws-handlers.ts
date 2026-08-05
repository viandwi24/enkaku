import type { ServerWebSocket } from 'bun'
import type { AdbClient } from '@enkaku/adb'
import { engineDescriptors } from '@enkaku/drivers'
import { eq } from 'drizzle-orm'
import {
  ClientMessageSchema,
  encodeSnapshot,
  encodeVideoFrame,
  KEYCODES,
  type ArtifactInfo,
  type DeviceEvent,
  type DeviceEventStream,
  type FrameMeta,
  type GestureSample,
  type Point,
  type Quality,
  type ServerMessage,
  type ShellMode,
  type Viewer,
} from '@enkaku/protocol'
import type { PairingService } from '../enroll/pairing'
import type { AdbEndpointManager } from '../device/adb-endpoint'
import type { LeaseManager } from '../lease/lease-manager'
import type { Hold, ReadinessManager } from '../device/readiness'
import type { DeviceSession, SessionManager } from '@enkaku/session'
import type { JobService } from '../services/job-service'
import type { AuditLogger } from '../auth/audit'
import type { EventRecorder } from '../events/recorder'
import type { Db } from '../db'
import { devices } from '../db/schema'
import { canUseDevice, canUseShell } from '../auth/acl'
import type { Role } from '../auth/service'
import { createMonitorHub, runOneshotMonitor } from '../device/monitor-hub'
import { createCrashWatcher, type CrashPolicy } from '../device/crash-watcher'
import { createLocalShellPort, createRemoteShellPort, type ShellPort } from '../device/shell-port'
import { createShellSessionStore } from '../device/shell-session'
import { redactShellCommand } from '../device/redact'
import type { TunnelRouter } from '../tunnel/router'
import type { TunnelRpc } from '../tunnel/rpc'
import { EnkakuError } from '../util/errors'
import type { Logger } from '../util/logger'

/** Timeout-shaped error codes (plan 26 §3.6): a command that hit its
 * deadline is reported with the `stream_suggested` hint, whether the local
 * `AdbClient` timed it out directly (`E_ADB_TIMEOUT`) or the tunnel RPC gave
 * up waiting on an agent (`E_AGENT_TIMEOUT`, plan 25 §4.1). */
const DEADLINE_ERROR_CODES = new Set(['E_ADB_TIMEOUT', 'E_AGENT_TIMEOUT'])

/** Backpressure limit: past this, frames are dropped (only the newest one matters). */
const MAX_BUFFERED = 4 * 1024 * 1024

/** The Inspect tab's `dump`/`find` deadline (plan 56 §4.2 step 5, acceptance #9) — `ui-server` targets well under this; `uiautomator-dump` can legitimately take 1-2s, so this is generous, not tight. */
const INSPECT_DEADLINE_MS = 20_000

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
}

/**
 * Plan 40 §4.6's `input.gesture` needs a `gesture` member on this shape too,
 * so the manual-control handler below can treat a local `DeviceSession` and
 * an agent-owned remote session identically. It stays OPTIONAL and undefined
 * here on purpose: the cloud tunnel does not carry curved gestures yet (out
 * of scope for this plan — Plan 08/M9 own the input engine wiring for
 * agent-owned devices), so a remote session always falls back to a linear
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
  agentIdFor(deviceId: string): string | null
  acquire(deviceId: string, onFrame: (chunk: Uint8Array, meta: FrameMeta) => void): Promise<{
    frameSize: { width: number; height: number }
    codec: 'png' | 'h264'
    input: RemoteInput
  }>
  release(deviceId: string, onFrame: (chunk: Uint8Array, meta: FrameMeta) => void): void
  get(deviceId: string): { frameSize: { width: number; height: number }; input: RemoteInput } | null
}

export interface WebRtcSignaling {
  request(ws: ServerWebSocket<unknown>, deviceId: string): Promise<void>
  answer(deviceId: string, sdp: string): Promise<void>
  ice(deviceId: string, candidate: unknown): Promise<void>
  stop(deviceId: string): Promise<void>
}

export interface WsHandlerDeps {
  /** The WebRTC video path (cloud mode); unused on a LAN. */
  webrtc?: WebRtcSignaling
  /** null under the orchestrator: the control plane holds no local devices. */
  sessions: SessionManager | null
  /** Sessions for agent-owned devices (cloud mode); null in pure local mode. */
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
  /** The `declared` policy's target package set for a running job (plan 37 §3.4) — from `JobRunnerDeps.onTargetPackages`, wired in daemon.ts. */
  targetPackagesForJob: (jobId: string) => string[]
  /** Writes the crash trace as an artifact (plan 37 §3.6) — job-scoped or device-scoped, decided in daemon.ts by whether a jobId is given. */
  saveCrashTrace: (opts: { deviceId: string; jobId: string | null; label: string; text: string }) => Promise<ArtifactInfo>
  /** A crash matched the farm's policy for a running job — abort it (plan 37 §4.4), wired to `ExecutorHost.notifyCrash` in daemon.ts. */
  onJobCrash?: (jobId: string, e: { package: string; exception: string; message: string }) => void
  log: Logger
}

export function createWsMessageHandler(deps: WsHandlerDeps) {
  // A plain Map, not a WeakMap: publishing a device event needs to iterate
  // every connection's subscriptions, which a WeakMap cannot do. `handleClose`
  // deletes the entry explicitly so this cannot grow unbounded.
  const conns = new Map<ServerWebSocket<unknown>, ConnState>()

  const send = (ws: ServerWebSocket<unknown>, msg: ServerMessage) => ws.send(JSON.stringify(msg))
  const sendError = (ws: ServerWebSocket<unknown>, code: string, message: string, id?: string) =>
    send(ws, { type: 'error', ...(id ? { id } : {}), payload: { code, message } })

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
   * resolution below (`deps.remote?.agentIdFor`) exactly.
   */
  const shellPortFor = (deviceId: string): ShellPort => {
    const remoteAgent = deps.remote?.agentIdFor(deviceId) ?? null
    if (remoteAgent) {
      if (!deps.rpc || !deps.router) {
        throw new EnkakuError('agent_offline', 'the agent that owns this device is currently disconnected')
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
    targetPackagesForJob: deps.targetPackagesForJob,
    log: deps.log.child('crash'),
  })
  crashWatcher.onJobCrash((_deviceId, jobId, e) =>
    deps.onJobCrash?.(jobId, { package: e.package, exception: e.exception, message: e.message }),
  )

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

  return {
    publishEvent,
    viewersOf,
    broadcastViewers,
    /** Sent the moment a WS opens (plan 31 §4.2) — before any client message. */
    handleOpen(ws: ServerWebSocket<unknown>): void {
      const state = stateOf(ws)
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
                const congested = ws.getBufferedAmount() > MAX_BUFFERED
                if (meta.codec === 'png') {
                  if (congested) return // one lost picture; nothing downstream depends on it
                } else {
                  if (congested && !binding.awaitingKeyframe) {
                    binding.awaitingKeyframe = true
                    deps.sessions?.get(binding.deviceId)?.requestKeyframe?.()
                  }
                  if (binding.awaitingKeyframe) {
                    // Resume only on a keyframe, and only once the socket drained.
                    if (congested || !meta.keyframe) return
                    binding.awaitingKeyframe = false
                  }
                }

                if (meta.width !== binding.lastSize.width || meta.height !== binding.lastSize.height) {
                  binding.lastSize = { width: meta.width, height: meta.height }
                  send(ws, { type: 'stream.meta', payload: { streamId, width: meta.width, height: meta.height } })
                }
                ws.send(encodeVideoFrame(streamId, meta, chunk))
              },
            }
            // Video keeps running even while a device is `busy` (spec §10.1) —
            // only input is rejected.
            const remoteAgent = deps.remote?.agentIdFor(msg.payload.deviceId) ?? null
            // Defaults to `control` — every pre-plan-42 caller, and the
            // device page itself. Only the Wall asks for `wall` (Plan 42 §4.5).
            const requestedQuality = msg.payload.quality ?? 'control'
            let codec: 'png' | 'h264'
            let frameSize: { width: number; height: number }
            let quality: Quality = 'control'
            if (remoteAgent) {
              // The tunnel protocol does not carry a quality profile yet
              // (Plan 42 §9 open question) — every remote-agent device
              // streams at its one existing profile regardless of what was
              // requested, which this reports honestly rather than claiming
              // an upgrade that never happened.
              const remoteSession = await deps.remote!.acquire(msg.payload.deviceId, binding.onFrame)
              codec = remoteSession.codec
              frameSize = remoteSession.frameSize
              binding.remote = true
            } else if (deps.sessions) {
              // Readiness hold (plan 43 §3.6, §5 step 43.7) — local devices
              // only (remote/agent-owned devices are handled by the branch
              // above and are out of scope for this plan, §9 open question
              // #2). Ensures the device is at least `awake` before the
              // session itself is acquired; `sessions.acquire` below is what
              // actually brings it to `hot` and is what Plan 42's
              // `session.idleTtlSec` governs once this connection releases.
              binding.readinessHold = await deps.readiness?.hold(msg.payload.deviceId, 'viewer').catch((err) => {
                deps.log.warn(`readiness hold failed for viewer on ${msg.payload.deviceId}, proceeding anyway: ${String(err)}`)
                return undefined
              })
              const session = await deps.sessions.acquire(msg.payload.deviceId, binding.onFrame, requestedQuality)
              codec = session.displayEngineId === 'scrcpy' ? 'h264' : 'png'
              frameSize = session.frameSize
              quality = session.quality
            } else {
              // The device belongs to no agent AND there is no local session.
              sendError(
                ws,
                'device_not_reachable',
                'the device is connected neither to this control plane nor to any agent',
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
              },
            })
            // A new viewer needs SPS/PPS to configure its decoder, and then a
            // keyframe to actually paint something. Sending only the config
            // leaves the canvas black until the encoder's next IDR — seconds
            // later — and the browser rejects the deltas that arrive meanwhile
            // ("a key frame is required after configure()").
            const localSession = remoteAgent ? null : (deps.sessions?.get(msg.payload.deviceId) ?? null)
            const primer: FrameMeta = {
              width: frameSize.width,
              height: frameSize.height,
              codec: 'h264',
              seq: 0,
              capturedAt: Date.now(),
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
            deps.sessions?.get(binding.deviceId)?.requestKeyframe?.()
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
            const lease = deps.leases.acquireManual(msg.payload.deviceId, state.clientId, state.userId)
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
              payload: { deviceId: lease.deviceId, held: true, expiresAt: lease.expiresAt },
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
                payload: { deviceId: msg.payload.deviceId, held: false, expiresAt: null },
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

          case 'monitor.oneshot': {
            const { text, truncated } = await runOneshotMonitor({ shellPort: shellPortFor }, msg.payload.deviceId, msg.payload.kind)
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
            // 3. Resolve local vs. remote — throws agent_offline/device_not_found/E_ADB_UNAVAILABLE,
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
            return
          }

          case 'input.tap':
          case 'input.swipe':
          case 'input.gesture':
          case 'input.key':
          case 'input.text': {
            // Server-authoritative: the lease and status are validated here,
            // not merely disabled in the UI (spec §10.1).
            const allowed = deps.leases.checkInputAllowed(msg.payload.deviceId, state.clientId)
            if (!allowed.ok) {
              sendError(ws, allowed.code, allowed.message, msgId)
              return
            }
            const remoteAgent = deps.remote?.agentIdFor(msg.payload.deviceId) ?? null
            const session = remoteAgent
              ? deps.remote!.get(msg.payload.deviceId)
              : (deps.sessions?.get(msg.payload.deviceId) ?? null)
            if (!session) {
              sendError(
                ws,
                remoteAgent ? 'agent_offline' : 'E_DEVICE_NOT_READY',
                remoteAgent
                  ? 'the device belongs to an agent that is currently disconnected'
                  : 'no active session for this device (start the stream first)',
                msgId,
              )
              return
            }
            deps.leases.touchManual(msg.payload.deviceId, state.clientId)
            // Recorded AFTER the lease check passes and BEFORE awaiting the
            // device (plan 18 §18.5): a rejected input (handled above, this
            // point is unreached) is never logged as if it happened. The
            // record() call itself never awaits — buffered, never on the
            // input path's critical section (plan 18 §3.5).
            const actor = state.userId
            if (msg.type === 'input.tap') {
              const p = mapNormToDevice(msg.payload.pos, session.frameSize)
              deps.recorder.record({
                deviceId: msg.payload.deviceId,
                stream: 'input',
                kind: 'input.tap',
                actor,
                meta: { x: p.x, y: p.y, w: session.frameSize.width, h: session.frameSize.height },
              })
              await session.input.tap(p)
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
              await session.input.swipe(from, to, msg.payload.durationMs)
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
                meta: { from: first, to: last, samples: samples.length, durationMs: last && first ? last.atMs - first.atMs : 0 },
              })
              if (session.input.gesture) {
                await session.input.gesture(samples)
              } else if (first && last) {
                // The engine cannot curve (AdbInput) — fall back to a linear
                // swipe over the trace's endpoints, honestly, rather than
                // dropping the input. Already reported once at session
                // creation (plan 40 §3.6), so nothing further to report here.
                await session.input.swipe(first, last, Math.max(50, last.atMs - first.atMs))
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
              await session.input.key(msg.payload.keycode)
            } else {
              const text = msg.payload.text
              const logText = deps.isLogInputTextEnabled(msg.payload.deviceId)
              deps.recorder.record({
                deviceId: msg.payload.deviceId,
                stream: 'input',
                kind: 'input.text',
                actor,
                meta: redactInputText(text, logText),
              })
              await session.input.text(text)
            }
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
            // Agent-owned devices have no local `Inspector` to call (§2
            // non-goals) — `RemoteSessions` exposes only `frameSize` and
            // `input`. Reported honestly, never a fabricated empty tree.
            const remoteAgent = deps.remote?.agentIdFor(deviceId) ?? null
            if (remoteAgent) {
              if (msg.type === 'inspect.attach') {
                send(ws, {
                  type: 'inspect.status',
                  ...(msgId ? { id: msgId } : {}),
                  payload: {
                    deviceId,
                    state: 'unavailable',
                    engineId: '',
                    capabilities: [],
                    reason: 'inspection is not available for cloud (agent-owned) devices yet',
                  },
                })
              } else {
                sendError(ws, 'E_NOT_SUPPORTED', 'inspection is not available for cloud (agent-owned) devices yet', msgId)
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
                await session.whenInspectorReady()
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
            const remoteAgent = deps.remote?.agentIdFor(deviceId) ?? null
            let text: string
            if (remoteAgent) {
              if (!deps.rpc) throw new EnkakuError('agent_offline', 'the agent that owns this device is currently disconnected')
              const reply = await deps.rpc.request<{ ok: boolean; text?: string; error?: { code: string; message: string } }>(
                deviceId,
                'clipboard.get.request',
                { deviceId },
              )
              if (!reply.ok) {
                throw new EnkakuError(
                  reply.error?.code ?? 'E_CLIPBOARD_UNAVAILABLE',
                  reply.error?.message ?? 'the agent could not read the clipboard',
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
            const remoteAgent = deps.remote?.agentIdFor(deviceId) ?? null
            let localSession: DeviceSession | null = null
            if (remoteAgent) {
              if (!deps.rpc) throw new EnkakuError('agent_offline', 'the agent that owns this device is currently disconnected')
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
            if (remoteAgent) {
              const reply = await deps.rpc!.request<{ ok: boolean; error?: { code: string; message: string } }>(
                deviceId,
                'clipboard.set.request',
                { deviceId, text, paste },
              )
              if (!reply.ok) {
                throw new EnkakuError(
                  reply.error?.code ?? 'E_CLIPBOARD_UNAVAILABLE',
                  reply.error?.message ?? 'the agent could not write the clipboard',
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
            const info = deps.jobs.cancel(msg.payload.jobId)
            send(ws, { type: 'job.status', payload: info })
            return
          }

          case 'video.webrtc.request': {
            if (!deps.webrtc) {
              send(ws, {
                type: 'video.webrtc.failed',
                payload: { deviceId: msg.payload.deviceId, reason: 'the WebRTC path is not active in this mode' },
              })
              return
            }
            await deps.webrtc.request(ws, msg.payload.deviceId)
            return
          }

          case 'video.webrtc.answer': {
            await deps.webrtc?.answer(msg.payload.deviceId, msg.payload.sdp)
            return
          }

          case 'video.webrtc.ice': {
            await deps.webrtc?.ice(msg.payload.deviceId, msg.payload.candidate)
            return
          }

          case 'video.webrtc.stop': {
            await deps.webrtc?.stop(msg.payload.deviceId)
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
        sendError(ws, code, message, msgId)
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
      // `LeaseManager.releaseAllForClient` drops the manual lease itself but
      // does not (today) tell us it did so — reaching `shell.exec` at all
      // required holding that lease, so every device this connection ran a
      // command on is, by construction, a device whose lease this close is
      // about to release (plan 26 §3.7, §4.4, acceptance #11).
      for (const deviceId of state.shellDevices) shellSessions.release(deviceId)
      state.shellDevices.clear()
      deps.leases.releaseAllForClient(state.clientId)
      // Nor does any readiness hold this connection's lease(s) took (plan 43
      // §5 step 43.7) — `LeaseManager.releaseAllForClient` above does not
      // report back which devices it released, so this walks `leaseHolds`
      // directly for anything still attributed to this connection.
      for (const [deviceId, entry] of [...leaseHolds]) {
        if (entry.clientId === state.clientId) releaseLeaseHold(deviceId)
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
  }
}
