import type { ServerWebSocket } from 'bun'
import type { AdbClient } from '@enkaku/adb'
import { eq } from 'drizzle-orm'
import {
  ClientMessageSchema,
  encodeVideoFrame,
  KEYCODES,
  type DeviceEvent,
  type DeviceEventStream,
  type FrameMeta,
  type Point,
  type ServerMessage,
  type ShellMode,
  type Viewer,
} from '@enkaku/protocol'
import type { PairingService } from '../enroll/pairing'
import type { AdbEndpointManager } from '../device/adb-endpoint'
import type { LeaseManager } from '../lease/lease-manager'
import type { SessionManager } from '@enkaku/session'
import type { JobService } from '../services/job-service'
import type { AuditLogger } from '../auth/audit'
import type { EventRecorder } from '../events/recorder'
import type { Db } from '../db'
import { devices } from '../db/schema'
import { canUseShell } from '../auth/acl'
import type { Role } from '../auth/service'
import { createMonitorHub, runOneshotMonitor } from '../device/monitor-hub'
import { createLocalShellPort, createRemoteShellPort, type ShellPort } from '../device/shell-port'
import { createShellSessionStore } from '../device/shell-session'
import { withExitMarker, parseExitMarker } from '../device/exit-marker'
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
}

export interface RemoteSessions {
  agentIdFor(deviceId: string): string | null
  acquire(deviceId: string, onFrame: (chunk: Uint8Array, meta: FrameMeta) => void): Promise<{
    frameSize: { width: number; height: number }
    codec: 'png' | 'h264'
    input: { tap(p: Point): Promise<void>; swipe(f: Point, t: Point, ms: number): Promise<void>; key(c: number): Promise<void>; text(s: string): Promise<void> }
  }>
  release(deviceId: string, onFrame: (chunk: Uint8Array, meta: FrameMeta) => void): void
  get(deviceId: string): { frameSize: { width: number; height: number }; input: { tap(p: Point): Promise<void>; swipe(f: Point, t: Point, ms: number): Promise<void>; key(c: number): Promise<void>; text(s: string): Promise<void> } } | null
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
  /** The farm's `shell` settings block, read fresh on every `shell.exec` (plan 26 §4.1). */
  shellSettings: () => { mode: ShellMode; execTimeoutMs: number; maxOutputBytes: number }
  /** The lease-scoped adb endpoint (plan 27 §4.2) — torn down on an explicit `lease.release` below and on WS disconnect (`handleClose`). */
  adbEndpoint: AdbEndpointManager
  /**
   * A human-readable label for an authenticated user (plan 31 §3.3, §4.1) —
   * null in local mode (one implicit admin: the UI falls back to the session
   * id) and whenever the user cannot be resolved. Optional so existing
   * callers (and tests) do not need to wire it up.
   */
  userLabel?: (userId: string | null) => string | null
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

  const monitors = createMonitorHub({
    shellPort: shellPortFor,
    log: deps.log.child('monitor'),
    onData: (streamId, lines) => {
      for (const ws of monitorTargets(streamId)) send(ws, { type: 'monitor.data', payload: { streamId, lines } })
    },
    onEnded: (streamId, reason) => {
      for (const ws of monitorTargets(streamId)) {
        send(ws, { type: 'monitor.ended', payload: { streamId, reason } })
        conns.get(ws)?.monitorSubs.delete(streamId)
      }
    },
    onSubscribersChanged: (streamId, count) => {
      for (const ws of monitorTargets(streamId)) send(ws, { type: 'monitor.subscribers', payload: { streamId, count } })
    },
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
                if (ws.getBufferedAmount() > MAX_BUFFERED) return // backpressure: skip frame
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
            let codec: 'png' | 'h264'
            let frameSize: { width: number; height: number }
            if (remoteAgent) {
              const remoteSession = await deps.remote!.acquire(msg.payload.deviceId, binding.onFrame)
              codec = remoteSession.codec
              frameSize = remoteSession.frameSize
              binding.remote = true
            } else if (deps.sessions) {
              const session = await deps.sessions.acquire(msg.payload.deviceId, binding.onFrame)
              codec = session.displayEngineId === 'scrcpy' ? 'h264' : 'png'
              frameSize = session.frameSize
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
            broadcastViewers(binding.deviceId)
            return
          }

          case 'lease.acquire': {
            const lease = deps.leases.acquireManual(msg.payload.deviceId, state.clientId, state.userId)
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
            }
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
              // never the user.
              const result = await port.exec(withExitMarker(onDeviceCmd), {
                timeoutMs: shellSettings.execTimeoutMs,
                maxOutputBytes: shellSettings.maxOutputBytes,
              })
              const { stdout, exitCode } = parseExitMarker(result.stdout)
              let resultCwd = cwdAtStart
              let reportedStdout = stdout
              if (cdAttempt) {
                if (exitCode === 0) {
                  // `pwd`'s own output, on success — never the `cmd` echo,
                  // there is none for a `cd`.
                  resultCwd = stdout.trim() || cwdAtStart
                  shellSessions.commitCwd(deviceId, resultCwd)
                  reportedStdout = ''
                }
                // A failed cd (exitCode !== 0, or exitCode null — the marker
                // was lost): the probe's own error text is the output, and
                // the cwd is deliberately left unchanged (acceptance #9).
              }
              const durationMs = Date.now() - startedAt
              // 8. Broadcast the outcome to every viewer (plan 26 §3.8).
              for (const target of shellTargets(deviceId, ws)) {
                send(target, {
                  type: 'shell.result',
                  payload: {
                    deviceId,
                    stdout: reportedStdout,
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
                meta: { exitCode, bytes: reportedStdout.length, truncated: result.truncated, durationMs },
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
                  payload: { deviceId, stdout: message, exitCode: null, truncated, durationMs, cwd: cwdAtStart, ...hint },
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

          case 'job.enqueue': {
            const info = deps.jobs.enqueue({
              scriptId: msg.payload.scriptId,
              deviceId: msg.payload.deviceId,
              params: msg.payload.params,
              priority: msg.payload.priority,
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
      // Any adb endpoint(s) this WS session (the REST route's `clientId`,
      // the same session id `hello` sent) opened must not outlive it either
      // (plan 27 §4.2 — "a WS disconnect" is one of the three teardown triggers).
      deps.adbEndpoint.closeAllForClient(state.clientId)
      conns.delete(ws)
      for (const deviceId of watchedDeviceIds) broadcastViewers(deviceId)
    },

    /** Device offline / session closed (plan 24 §4.5) — stops its monitor streams regardless of subscriber count. */
    stopMonitorsForDevice(deviceId: string): void {
      monitors.stopForDevice(deviceId)
    },

    /** The manual lease on this device was released, however that happened (plan 26 §3.7, §4.4) — the next holder starts at `/`. */
    releaseShellSession(deviceId: string): void {
      shellSessions.release(deviceId)
    },
  }
}
