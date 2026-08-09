import type { AdbClient } from '@enkaku/adb'
import type { ReconcileReport, ServerMessage } from '@enkaku/protocol'
import type { Logger } from '../util/logger'

export type { ReconcileReport }

/**
 * The discovery reconciler (plan 85 §3.3, §4.4 — fixes F8/F9/F10, tests H3).
 *
 * `host:track-devices` is an excellent primary signal and a terrible ONLY
 * signal: it speaks on change, which for a phone that never gets unplugged
 * may never come again. This runs a periodic, independent re-derivation of
 * adb's own truth (`host:devices-l`) and reconciles it against the
 * registry's live view, so a device that missed its one event — plugged in
 * before the core started, stuck `offline`/`authorizing`, or a probe that
 * failed outright — recovers on its own within one scan interval instead of
 * needing a physical replug.
 */
export interface DeviceReconcilerDeps {
  client: AdbClient
  registry: {
    onOnline(serial: string): Promise<void>
    onRemove(serial: string): void
    knownSerials(): Set<string>
    /** Surfaced verbatim in `ReconcileReport.retriesPending` (plan 85 §4.4). */
    pendingRetryCount(): number
  }
  settings: () => { scanIntervalSec: number; offlineGraceSec: number; recoveryCooldownSec: number }
  log: Logger
  broadcast: (msg: ServerMessage) => void
}

export interface DeviceReconciler {
  start(): void
  stop(): void
  /** One pass, now — `POST /api/devices/rescan` and the boot sequence both call this. */
  runOnce(): Promise<ReconcileReport>
}

const EMPTY_REPORT: ReconcileReport = {
  seen: 0,
  adopted: [],
  dropped: [],
  offline: [],
  unauthorized: [],
  reconnectIssued: false,
  retriesPending: 0,
}

/**
 * `discovery.scanIntervalSec: 0` disables the reconciler ENTIRELY (plan 85
 * §5 step 85.2, §7.4 regression watch) — not just its automatic cadence.
 * The setting's own description says so ("0 disables the rescan"), and
 * making `runOnce()` itself a no-op (rather than only `start()`) is what
 * lets `POST /api/devices/rescan` and the boot-time call in `daemon.ts`
 * share the same guarantee without each needing to re-check the setting
 * themselves: with this set, behaviour is exactly the pre-plan
 * tracker-only behaviour, full stop.
 */
export function createDeviceReconciler(deps: DeviceReconcilerDeps): DeviceReconciler {
  const log = deps.log
  /** serial → when it was FIRST observed `offline` this streak (cleared the moment it is no longer offline, or no longer seen at all). */
  const offlineSince = new Map<string, number>()
  /** serial → the last time a `host:reconnect-offline` was issued on its behalf (plan 85 §3.3 point 5's per-serial cooldown). */
  const lastReconnectAttempt = new Map<string, number>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let running = false

  async function runOnce(): Promise<ReconcileReport> {
    const cfg = deps.settings()
    if (cfg.scanIntervalSec === 0) return EMPTY_REPORT

    const nowMs = Date.now()
    const adbList = await deps.client.listDevices()
    const known = deps.registry.knownSerials()
    const seenSerials = new Set<string>()

    const toAdopt: string[] = []
    const offline: string[] = []
    const unauthorized: string[] = []

    for (const d of adbList) {
      seenSerials.add(d.serial)
      if (d.state === 'device') {
        offlineSince.delete(d.serial)
        if (!known.has(d.serial)) toAdopt.push(d.serial)
        continue
      }
      if (d.state === 'offline') {
        const since = offlineSince.get(d.serial) ?? nowMs
        if (!offlineSince.has(d.serial)) offlineSince.set(d.serial, since)
        if (nowMs - since >= cfg.offlineGraceSec * 1000) offline.push(d.serial)
        continue
      }
      if (d.state === 'unauthorized') {
        unauthorized.push(d.serial)
        // Repeating cadence (plan 85 §3.3 point 6): the tracker's own event
        // fires once, the moment a device BECOMES unauthorized. This keeps
        // saying so for as long as it stays that way, so Studio's "accept
        // the prompt on the phone" does not go stale after the first paint.
        deps.broadcast({ type: 'device.unauthorized', payload: { serial: d.serial } })
        continue
      }
      // `authorizing` and anything else: counted in `seen`, acted on once
      // adb itself moves it to one of the three states above.
      offlineSince.delete(d.serial)
    }

    // Known to the registry but gone from adb entirely — the tracker's own
    // `remove` event usually gets here first; this is the safety net (plan
    // 85 §3.3 point 4).
    const dropped: string[] = []
    for (const serial of known) {
      if (!seenSerials.has(serial)) {
        dropped.push(serial)
        deps.registry.onRemove(serial)
      }
    }

    // Adopt every unknown, currently-reachable device (plan 85 §3.3 point
    // 3) — through the EXACT SAME `onOnline` path a live tracker `add`
    // event uses, whose own `probesInFlight` guard already dedupes a serial
    // the tracker is concurrently probing. Awaited (not fire-and-forget) so
    // the report — and a human pressing Rescan — reflects completed state,
    // not merely "kicked off".
    const adopted: string[] = []
    if (toAdopt.length > 0) {
      await Promise.all(
        toAdopt.map(async (serial) => {
          adopted.push(serial)
          await deps.registry.onOnline(serial)
        }),
      )
    }

    // At most one `host:reconnect-offline` per serial per
    // `discovery.recoveryCooldownSec` (plan 85 §3.3 point 5). The command
    // itself is not serial-scoped — one call re-opens every transport
    // currently stuck offline — so this only decides WHETHER to issue it
    // this pass; issuing it resets the cooldown clock for every serial it
    // was issued on behalf of, not just one.
    let reconnectIssued = false
    const dueForReconnect = offline.filter((serial) => nowMs - (lastReconnectAttempt.get(serial) ?? 0) >= cfg.recoveryCooldownSec * 1000)
    if (dueForReconnect.length > 0) {
      try {
        await deps.client.reconnectOffline()
        reconnectIssued = true
        for (const serial of dueForReconnect) lastReconnectAttempt.set(serial, nowMs)
        log.warn(
          `host:reconnect-offline issued for ${dueForReconnect.length} device(s) stuck offline past ${cfg.offlineGraceSec}s: ${dueForReconnect.join(', ')}`,
        )
      } catch (err) {
        log.warn(`host:reconnect-offline failed: ${String(err)}`)
      }
    }

    // Prune bookkeeping for serials adb no longer mentions at all, so a
    // long-gone device does not leak memory forever.
    for (const serial of offlineSince.keys()) if (!seenSerials.has(serial)) offlineSince.delete(serial)
    for (const serial of lastReconnectAttempt.keys()) if (!seenSerials.has(serial)) lastReconnectAttempt.delete(serial)

    return {
      seen: adbList.length,
      adopted,
      dropped,
      offline,
      unauthorized,
      reconnectIssued,
      retriesPending: deps.registry.pendingRetryCount(),
    }
  }

  function scheduleNext(): void {
    if (!running) return
    const cfg = deps.settings()
    if (cfg.scanIntervalSec === 0) {
      // Disabled — do not even arm a timer. A settings change back to a
      // non-zero value takes effect on the next explicit start() (a core
      // restart, in practice), the same limitation every other
      // interval-shaped setting in this codebase already has.
      timer = null
      return
    }
    timer = setTimeout(() => {
      void runOnce()
        .catch((err) => log.warn(`reconcile pass failed, will retry next tick: ${String(err)}`))
        .finally(scheduleNext)
    }, cfg.scanIntervalSec * 1000)
  }

  return {
    start() {
      if (running) return
      running = true
      scheduleNext()
    },
    stop() {
      running = false
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    },
    runOnce,
  }
}
