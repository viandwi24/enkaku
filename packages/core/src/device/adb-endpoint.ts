import type { AdbClient } from '@enkaku/adb'
import { buildDeviceBanner, createAdbdShim, type AdbdShimDeps, type AdbdShimHandlers } from '@enkaku/adb'
import { eq } from 'drizzle-orm'
import type { Db } from '../db'
import { devices } from '../db/schema'
import { createRemoteOpenService } from '../tunnel/adb-remote'
import type { TunnelRouter } from '../tunnel/router'
import type { TunnelRpc } from '../tunnel/rpc'
import { EnkakuError } from '../util/errors'
import type { Logger } from '../util/logger'

const nowSec = (): number => Math.floor(Date.now() / 1000)

/** A live TCP listener, abstracted so tests can inject an in-memory fake (plan 27 §7 — "lifecycle against a fake shim") instead of a real `Bun.listen`. */
export interface AdbEndpointListener {
  port: number
  stop(): void
}

export interface AdbEndpointManager {
  /**
   * Opens (or, for a device that already has one, returns) the endpoint for
   * `deviceId` — "one endpoint per device" (plan §4.2). The caller has
   * already verified `device.adb` plus activity admission before reaching this.
   */
  open(deviceId: string, clientId: string, userId: string | null): Promise<{ host: string; port: number; expiresAt: number }>
  /** Idempotent — closing an endpoint that does not exist is a no-op. */
  close(deviceId: string, reason: string): void
  /**
   * `host`/`expiresAt` are a superset of the plan's literal §4.2 sketch
   * (`port`/`connections`/`openedAt`) — both are cheap to report and the
   * Studio card needs them (the copyable command on a page reload, and the
   * idle countdown) without a second round trip through `open()`.
   */
  get(deviceId: string): { host: string; port: number; connections: number; openedAt: number; expiresAt: number } | null
  /** WS disconnect (plan §4.2) — every endpoint this client opened is torn down. */
  closeAllForClient(clientId: string): void
}

export interface AdbEndpointManagerDeps {
  db: Db
  adb: () => AdbClient | null
  shellSettings: () => { endpointBind: string; endpointIdleSec: number; maxEndpointStreams: number }
  /** Production wiring binds `Bun.listen`; tests inject an in-memory fake — the seam the plan's "fake shim" lifecycle test needs. */
  listen: (hostname: string, handlers: AdbdShimHandlers) => AdbEndpointListener
  /** Production wiring is `createAdbdShim` from `@enkaku/adb`; injectable for the same reason as `listen`. */
  createShim: (shimDeps: AdbdShimDeps) => AdbdShimHandlers
  /** Audit hook: one `OPEN` destination (plan §3.6, `adb.open` on the input stream). */
  onStreamOpen: (deviceId: string, service: string) => void
  /** Audit hook: `adb.endpoint.opened` on the main stream — `nodeId` is set for a cloud device (plan 28 §4.4) so a session can be traced to the machine that served it. */
  onEndpointOpened: (deviceId: string, userId: string | null, port: number, nodeId?: string | null) => void
  /** Audit hook: `adb.endpoint.closed` on the main stream. */
  onEndpointClosed: (deviceId: string, reason: string) => void
  /**
   * Cloud mode (plan 28 §4.4): when the device is node-owned, `open()`
   * builds `openService` from `createRemoteOpenService` instead of
   * `AdbClient.openRaw` — mirroring `ws-handlers.ts`'s `shellPortFor`
   * resolution exactly. `rpc`/`router` are accessors (not values) because,
   * like `adb` above, this manager is constructed before the tunnel layer
   * exists in `daemon.ts`'s forward-ref wiring; read fresh on every `open()`.
   */
  remoteNodeIdFor?: (deviceId: string) => string | null
  rpc?: () => TunnelRpc | null
  router?: () => TunnelRouter | null
  /**
   * Readiness hold (plan 43 §3.7 table, §5 step 43.7): an open endpoint keeps
   * its device at least `awake`, released when the endpoint closes for any
   * reason. Optional so tests that do not wire readiness keep working.
   */
  holdFor?: (deviceId: string) => Promise<{ release(): void }>
  log: Logger
}

interface EndpointRecord {
  deviceId: string
  holderClientId: string
  holderUserId: string | null
  /** Frozen at creation from `shellSettings().endpointBind` — a mid-flight settings change must not make an already-open endpoint report a bind address it is not actually listening on. */
  host: string
  listener: AdbEndpointListener
  openedAt: number
  connections: number
  expiresAt: number
  idleTimer: ReturnType<typeof setTimeout> | null
  /** The readiness hold for this endpoint's lifetime (plan 43 §5 step 43.7). */
  hold: { release(): void } | null
}

/**
 * The activity-gated adb endpoint's lifecycle (plan 27 §4.2): one `Bun.listen`
 * per device, created on `open()` and torn down on `close()` — by an
 * explicit control-marker end, a device going offline, or a WS disconnect (the
 * same three triggers `shell-session.ts`'s cwd store resets on), or by its
 * own idle timer. This module owns none of those trigger wires itself
 * (matching this codebase's daemon.ts forward-ref pattern, not a shared
 * event bus) — `daemon.ts` calls `close`/`closeAllForClient` explicitly from
 * the same places it already calls `releaseShellSession`.
 */
export function createAdbEndpointManager(deps: AdbEndpointManagerDeps): AdbEndpointManager {
  const endpoints = new Map<string, EndpointRecord>()

  function armIdleTimer(rec: EndpointRecord): void {
    if (rec.idleTimer) clearTimeout(rec.idleTimer)
    const idleSec = deps.shellSettings().endpointIdleSec
    rec.expiresAt = nowSec() + idleSec
    rec.idleTimer = setTimeout(() => {
      // A connection could have arrived in the same tick the timer fired;
      // re-check rather than trust the closure's stale read.
      if (rec.connections === 0) closeInternal(rec.deviceId, 'idle_timeout')
    }, idleSec * 1000)
  }

  function closeInternal(deviceId: string, reason: string): void {
    const rec = endpoints.get(deviceId)
    if (!rec) return
    endpoints.delete(deviceId)
    if (rec.idleTimer) clearTimeout(rec.idleTimer)
    rec.listener.stop()
    rec.hold?.release()
    deps.onEndpointClosed(deviceId, reason)
  }

  function resolveDeviceInfo(deviceId: string): { serial: string; banner: string } {
    const row = deps.db.select().from(devices).where(eq(devices.id, deviceId)).get()
    if (!row) throw new EnkakuError('device_not_found', `no such device: ${deviceId}`)
    const banner = buildDeviceBanner({
      model: row.label,
      // A stable, host-unique, never-user-controlled token — the identity
      // itself (plan §7.5), not the mutable adb transport serial.
      product: row.stableId,
      device: row.stableId,
      apiLevel: row.apiLevel,
    })
    return { serial: row.serial, banner }
  }

  return {
    async open(deviceId, clientId, userId) {
      const existing = endpoints.get(deviceId)
      if (existing) {
        existing.holderClientId = clientId
        existing.holderUserId = userId
        // A fresh `open()` counts as activity even with zero live
        // connections yet — it is what the acceptance smoke test calls
        // right after enabling the feature, and it should not be one idle
        // tick away from expiring.
        if (existing.connections === 0) armIdleTimer(existing)
        return { host: deps.shellSettings().endpointBind, port: existing.listener.port, expiresAt: existing.expiresAt }
      }

      const { serial, banner } = resolveDeviceInfo(deviceId)
      const settings = deps.shellSettings()
      // Readiness hold (plan 43 §5 step 43.7): wakes the device before the
      // listener even opens, if it was asleep.
      const hold = (await deps.holdFor?.(deviceId).catch(() => null)) ?? null

      // A node-owned device gets the remote `openService`, everything else
      // the local one (plan 28 §4.4) — the ONE place local-vs-remote is
      // decided for the adb endpoint, mirroring `ws-handlers.ts`'s
      // `shellPortFor`. `resolveDeviceInfo` above works unchanged either way
      // — a node-owned device's row is populated by `syncDevices` exactly
      // like a local one's.
      const nodeId = deps.remoteNodeIdFor?.(deviceId) ?? null
      let openService: AdbdShimDeps['openService']
      if (nodeId) {
        const rpc = deps.rpc?.()
        const router = deps.router?.()
        if (!rpc || !router) throw new EnkakuError('E_ADB_UNAVAILABLE', 'the cloud tunnel is not ready')
        openService = createRemoteOpenService({ rpc, router, deviceId })
      } else {
        const client = deps.adb()
        if (!client) throw new EnkakuError('E_ADB_UNAVAILABLE', 'the adb subsystem is not ready')
        openService = (svcSerial, service) => client.openRaw(svcSerial, service)
      }

      const shimDeps: AdbdShimDeps = {
        serial,
        banner,
        maxStreams: settings.maxEndpointStreams,
        openService,
        onOpen: (service) => deps.onStreamOpen(deviceId, service),
        onClose: () => {},
        log: (level, msg) => deps.log[level](msg),
      }
      const shimHandlers = deps.createShim(shimDeps)

      // Wraps the shim's per-socket handlers purely to count live TCP
      // connections (plan §4.2's `connections`, and acceptance #6's idle
      // clock — "no TCP CONNECTION", not byte-level idleness): the shim
      // itself has no notion of a connection COUNT, only of individual
      // sockets.
      const wrapped: AdbdShimHandlers = {
        open(socket) {
          rec.connections++
          if (rec.idleTimer) {
            clearTimeout(rec.idleTimer)
            rec.idleTimer = null
          }
          shimHandlers.open(socket)
        },
        data: shimHandlers.data,
        close(socket) {
          shimHandlers.close(socket)
          rec.connections = Math.max(0, rec.connections - 1)
          if (rec.connections === 0) armIdleTimer(rec)
        },
        error(socket, err) {
          shimHandlers.error(socket, err)
          rec.connections = Math.max(0, rec.connections - 1)
          if (rec.connections === 0) armIdleTimer(rec)
        },
      }

      const listener = deps.listen(settings.endpointBind, wrapped)
      const rec: EndpointRecord = {
        deviceId,
        holderClientId: clientId,
        holderUserId: userId,
        host: settings.endpointBind,
        listener,
        openedAt: nowSec(),
        connections: 0,
        expiresAt: 0,
        idleTimer: null,
        hold,
      }
      endpoints.set(deviceId, rec)
      armIdleTimer(rec)
      deps.onEndpointOpened(deviceId, userId, listener.port, nodeId)
      return { host: settings.endpointBind, port: listener.port, expiresAt: rec.expiresAt }
    },

    close(deviceId, reason) {
      closeInternal(deviceId, reason)
    },

    get(deviceId) {
      const rec = endpoints.get(deviceId)
      if (!rec) return null
      return { host: rec.host, port: rec.listener.port, connections: rec.connections, openedAt: rec.openedAt, expiresAt: rec.expiresAt }
    },

    closeAllForClient(clientId) {
      for (const [deviceId, rec] of [...endpoints]) {
        if (rec.holderClientId === clientId) closeInternal(deviceId, 'disconnected')
      }
    },
  }
}

/** Production `listen` wiring — a thin `Bun.listen` wrapper (plan §4.2: port 0, the OS allocates). */
export function bunAdbEndpointListen(hostname: string, handlers: AdbdShimHandlers): AdbEndpointListener {
  const listener = Bun.listen<undefined>({
    hostname,
    port: 0,
    socket: {
      open: handlers.open,
      data: handlers.data,
      close: handlers.close,
      error: handlers.error,
      drain() {},
    },
  })
  return {
    port: listener.port as number,
    stop: () => listener.stop(true),
  }
}
