import type { AdbClient } from '@enkaku/adb'
import type { AttemptTrace, ReconnectOutcome, SweepReport } from '@enkaku/protocol'
import { probeDeviceIdentity } from '@enkaku/session'
import { eq } from 'drizzle-orm'
import type { Db } from '../db'
import { devices } from '../db/schema'
import type { Logger } from '../util/logger'
import { deriveConnection } from './device-registry'
import type { EndpointStore } from './endpoints'

// `AttemptTrace`/`ReconnectOutcome` (plan 88 §4.4) used to be defined here as
// plain local interfaces; they now live in `@enkaku/protocol`
// (`AttemptTraceSchema`/`ReconnectOutcomeSchema`, plan 88 §5 step 88.4) —
// the same "declared once, imported, never redefined" convention this file
// already follows for `SweepReport` above, extended to the two shapes Studio
// also needs a Zod schema for (`POST /:id/connection/reconnect`'s response).
// Re-exported here so every existing importer of this module keeps working
// unchanged.
export type { AttemptTrace, ReconnectOutcome }

export interface DeviceReconnector {
  /**
   * The ladder (plan 88 §3.3, §4.4), all four steps as of step 88.3: already
   * connected, remembered addresses cheapest-first, then — ONLY when
   * `opts.allowSweep` is true AND a sweeper is wired — the bounded sweep
   * (step 4, `./sweep.ts`), matched against this one `stableId` via
   * `expect`. No cooldown gates step 4: there is no automatic cadence to
   * protect against (§9 Q1, decided 2026-08-12), only an explicit ask.
   * `opts.allowSweep` with no sweeper wired (or `scan.mode: 'off'`, or no
   * scannable network) behaves exactly like `allowSweep` unset: `not-found`
   * with `sweep: null`, never a thrown error — a caller that always passes
   * `allowSweep: true` must not have to special-case an unconfigured farm.
   */
  reconnect(stableId: string, opts?: { allowSweep?: boolean; force?: boolean }): Promise<ReconnectOutcome>
  /** Drops a `tcp` device's adb transport (plan 88 §3.8) — refuses on a `usb` device, adb has no host service to release one USB transport. */
  disconnect(stableId: string): Promise<{ result: 'disconnected' | 'not-connected' | 'refused'; detail?: string }>
}

/** Injectable so a test proves the ladder against a fake, never a real socket (plan 88 §5 step 88.2's own instruction). Defaults to a real `Bun.connect` dial. */
export type TcpPreProbe = (host: string, port: number, timeoutMs: number) => Promise<'accepted' | 'refused' | 'timeout'>

export interface DeviceReconnectorDeps {
  client: AdbClient
  db: Db
  endpoints: EndpointStore
  /** The exact path a live tracker `add` event and the reconciler's own adopt path use (plan 88 §3.3 step 3: "the same probe every other path uses"). */
  registry: { onOnline(serial: string): Promise<void> }
  /**
   * `probeTimeoutMs` is `discovery.scan.probeTimeoutMs` (plan 88 §3.3: "a
   * cheap TCP pre-probe (Bun.connect, `discovery.scan.probeTimeoutMs`,
   * default 300 ms)") — step 88.2 hard-coded the spec's own default here
   * because that setting lives under `discovery.scan`, which step 88.2
   * explicitly did not add; step 88.3 threads the real, live setting through,
   * exactly as that step's own comment said it would.
   */
  settings: () => { connectSettleMs: number; probeTimeoutMs: number }
  log: Logger
  tcpPreProbe?: TcpPreProbe
  /**
   * The bounded sweep (plan 88 §3.5, §4.5, step 88.3's own deliverable).
   * Optional so every caller that predates this step (88.2's own tests, and
   * any wiring built before the sweeper exists) keeps working unchanged: with
   * no sweeper, step 4 never runs, `opts.allowSweep` or not — the ladder
   * behaves exactly as it did before this step landed.
   */
  sweeper?: { sweep(opts?: { expect?: string[] }): Promise<SweepReport> }
}

/**
 * `host:port` → `{host, port}`, undoing the bracket IPv6 quoting
 * `deriveConnection` applies. Every `address` here already passed
 * `EndpointStore`'s own TCP-shape check, so this never sees a USB serial.
 * Exported for `./sweep.ts` (step 88.3) — the sweep dials the SAME shape of
 * address the ladder does, and a second copy of this parser would be one
 * more place for the bracket-IPv6 handling to drift.
 */
export function splitHostPort(address: string): { host: string; port: number } {
  const idx = address.lastIndexOf(':')
  const hostRaw = address.slice(0, idx)
  const host = hostRaw.startsWith('[') && hostRaw.endsWith(']') ? hostRaw.slice(1, -1) : hostRaw
  return { host, port: Number(address.slice(idx + 1)) }
}

/**
 * adb's `host:connect` reply is prose, not a status code — "connected to X"
 * / "already connected to X" on success, "unable to connect..." / "failed to
 * connect..." on failure. Exported for `./sweep.ts`, same reason as
 * `splitHostPort` above.
 */
export function isConnectSuccess(message: string): boolean {
  const trimmed = message.trim().toLowerCase()
  return trimmed.startsWith('connected to') || trimmed.startsWith('already connected to')
}

/**
 * The cheap TCP pre-probe's default implementation (plan 88 §3.3, §3.5) —
 * `Bun.connect` with its own hard timeout, so it can never hang regardless
 * of whether the target refuses instantly or is a silent black hole.
 * Exported for `./sweep.ts`: the sweep's mandatory pre-probe (§3.5) is the
 * SAME cheap dial the ladder's step 2 already uses, not a second
 * implementation of it — a spike confirmed a real `host:connect` against an
 * unroutable address can block for the OS's own TCP connect timeout (tens of
 * seconds to well over a minute), which is exactly why nothing in this repo
 * calls `client.connectDevice` without this gate in front of it first.
 */
export async function defaultTcpPreProbe(host: string, port: number, timeoutMs: number): Promise<'accepted' | 'refused' | 'timeout'> {
  return await new Promise((resolve) => {
    let settled = false
    const finish = (outcome: 'accepted' | 'refused' | 'timeout') => {
      if (settled) return
      settled = true
      resolve(outcome)
    }
    const timer = setTimeout(() => finish('timeout'), timeoutMs)
    Bun.connect({
      hostname: host,
      port,
      socket: {
        open(socket) {
          clearTimeout(timer)
          finish('accepted')
          socket.end()
        },
        error() {
          clearTimeout(timer)
          finish('refused')
        },
        data() {},
        close() {},
      },
    }).catch(() => {
      clearTimeout(timer)
      finish('refused')
    })
  })
}

/**
 * A per-key async mutex/queue (plan 88 §4.4: "a per-`stableId` mutex").
 * Deliberately a `Map<string, Promise<void>>`, not one lock for the whole
 * store — a flapping phone must not block recovery for nineteen others
 * (this step's own "judgement" note). Calls for the SAME key chain FIFO;
 * calls for different keys never wait on each other. Entries are removed
 * once settled, so the map only ever holds currently in-flight or queued
 * keys, never one per stableId the farm has ever seen.
 */
function createKeyedMutex() {
  const tails = new Map<string, Promise<void>>()
  return function runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prior = tails.get(key) ?? Promise.resolve()
    const result = prior.then(fn, fn)
    const settled = result.then(
      () => undefined,
      () => undefined,
    )
    tails.set(key, settled)
    void settled.finally(() => {
      if (tails.get(key) === settled) tails.delete(key)
    })
    return result
  }
}

/**
 * The reconnect ladder (plan 88 §3.3, §4.4) — fixes F8/F10/F13. Cheapest
 * first, and it usually stops at step one: already connected, then every
 * remembered address, cheapest (a 300ms TCP dial) before the expensive part
 * (a full adb handshake). No sweep here (step 88.3's own deliverable) —
 * exhausting the remembered addresses reports `not-found` with a trace
 * naming exactly what was tried, never a silent failure.
 */
export function createDeviceReconnector(deps: DeviceReconnectorDeps): DeviceReconnector {
  const { db } = deps
  const runExclusive = createKeyedMutex()
  const tcpPreProbe = deps.tcpPreProbe ?? defaultTcpPreProbe

  async function waitForSettle(address: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    const pollMs = Math.min(200, Math.max(25, Math.floor(timeoutMs / 10)))
    for (;;) {
      const list = await deps.client.listDevices()
      if (list.some((d) => d.serial === address && d.state === 'device')) return true
      if (Date.now() >= deadline) return false
      await Bun.sleep(pollMs)
    }
  }

  /** One rung: pre-probe → `host:connect` → settle → verify identity. Never throws — every failure mode becomes a trace entry. */
  async function attemptCandidate(targetStableId: string, address: string): Promise<AttemptTrace & { outcome: 'connected' | 'failed' | 'conflict' }> {
    const started = Date.now()
    const { host, port } = splitHostPort(address)
    const ms = () => Date.now() - started

    const preProbe = await tcpPreProbe(host, port, deps.settings().probeTimeoutMs)
    if (preProbe !== 'accepted') {
      deps.endpoints.noteAttempt(targetStableId, address, 'failed')
      return { address, preProbe, ms: ms(), outcome: 'failed' }
    }

    let connectReply: string
    try {
      connectReply = await deps.client.connectDevice(address)
    } catch (err) {
      deps.log.debug(`reconnect: host:connect to ${address} threw: ${String(err)}`)
      deps.endpoints.noteAttempt(targetStableId, address, 'failed')
      return { address, preProbe, connect: 'failed', ms: ms(), outcome: 'failed' }
    }
    if (!isConnectSuccess(connectReply)) {
      deps.endpoints.noteAttempt(targetStableId, address, 'failed')
      return { address, preProbe, connect: 'failed', ms: ms(), outcome: 'failed' }
    }

    const settled = await waitForSettle(address, deps.settings().connectSettleMs)
    if (!settled) {
      deps.endpoints.noteAttempt(targetStableId, address, 'failed')
      return { address, preProbe, connect: 'ok', probe: 'failed', ms: ms(), outcome: 'failed' }
    }

    let probe: Awaited<ReturnType<typeof probeDeviceIdentity>>
    try {
      probe = await probeDeviceIdentity(deps.client, address)
    } catch (err) {
      deps.log.debug(`reconnect: identity probe of ${address} failed: ${String(err)}`)
      deps.endpoints.noteAttempt(targetStableId, address, 'failed')
      return { address, preProbe, connect: 'ok', probe: 'failed', ms: ms(), outcome: 'failed' }
    }

    if (probe.stableId === targetStableId) {
      deps.endpoints.noteAttempt(targetStableId, address, 'connected')
      // The ordinary adopt path (plan 88 §3.3 step 3) — upserts, transitions,
      // and broadcasts exactly like a live tracker `add` event would.
      await deps.registry.onOnline(address)
      return { address, preProbe, connect: 'ok', probe: 'match', ms: ms(), outcome: 'connected' }
    }

    // A DIFFERENT phone answered at this address (plan 88 §3.3 step 3) — drop
    // it immediately and move on. It is NOT adopted here: the reconciler's
    // ordinary pass discovers/admits it later, through the Plan 56 gate
    // (F14) — never as a side effect of someone else's reconnect attempt.
    deps.endpoints.noteAttempt(targetStableId, address, 'conflict', probe.stableId)
    try {
      await deps.client.disconnectDevice(address)
    } catch (err) {
      deps.log.warn(`reconnect: could not disconnect ${address} after finding a conflicting stableId: ${String(err)}`)
    }
    return { address, preProbe, connect: 'ok', probe: 'conflict', conflictStableId: probe.stableId, ms: ms(), outcome: 'conflict' }
  }

  async function reconnectImpl(stableId: string, opts?: { allowSweep?: boolean; force?: boolean }): Promise<ReconnectOutcome> {
    const row = db.select().from(devices).where(eq(devices.stableId, stableId)).get()

    // Step 1 — already connected? Zero work is the common case after a Rescan.
    if (row?.serial) {
      const list = await deps.client.listDevices()
      if (list.some((d) => d.serial === row.serial && d.state === 'device')) {
        return { result: 'already-connected', serial: row.serial }
      }
    }

    // Step 2 — remembered addresses, cheapest first. A sweep may still be
    // able to help even with ZERO remembered candidates (a device that has
    // never been seen on the network before, or whose only endpoint was
    // retired) — plan 88 §3.3 step 4 is gated on `allowSweep`/`scan.mode`
    // ONLY, not on candidates existing first, so the early refusal below is
    // skipped whenever a sweep is actually possible.
    const candidates = deps.endpoints.candidates(stableId, { includeRetired: Boolean(opts?.force) })
    const canSweep = Boolean(opts?.allowSweep && deps.sweeper)
    if (candidates.length === 0 && !canSweep) {
      const kind = row ? deriveConnection(row.serial, []).kind : null
      if (kind === 'usb') {
        return {
          result: 'refused',
          reason: 'usb-device',
          detail: `${row?.label ?? stableId} is on USB — there is no remembered network address to reconnect to. Unplug and replug it, or use adb's own offline recovery.`,
        }
      }
      return {
        result: 'refused',
        reason: 'no-endpoints',
        detail: `no remembered network address for ${row?.label ?? stableId} — connect it over the network once so Enkaku can learn one, or declare an address.`,
      }
    }

    const tried: AttemptTrace[] = []
    for (const candidate of candidates) {
      const attempt = await attemptCandidate(stableId, candidate.address)
      if (attempt.outcome === 'connected') {
        return { result: 'connected', address: attempt.address, viaSweep: false }
      }
      tried.push({
        address: attempt.address,
        preProbe: attempt.preProbe,
        connect: attempt.connect,
        probe: attempt.probe,
        conflictStableId: attempt.conflictStableId,
        ms: attempt.ms,
      })
    }

    // Step 4 — the bounded sweep (plan 88 §3.5, §4.5), matched against this
    // ONE stableId via `expect` (it still probes the whole configured address
    // space — `expect` only changes what the report calls out first, and
    // what THIS ladder checks for afterwards). `sweeper.sweep` itself is the
    // ONLY place `scan.mode`/"no scannable network" is enforced (it rejects
    // with a coded error) — that failure folds into an ordinary `not-found`
    // here rather than throwing, so a caller that always passes
    // `allowSweep: true` never has to special-case an unconfigured farm.
    if (canSweep) {
      let sweepReport: SweepReport | null = null
      try {
        sweepReport = await deps.sweeper!.sweep({ expect: [stableId] })
      } catch (err) {
        deps.log.debug(`reconnect: sweep for ${stableId} did not run: ${String(err)}`)
      }
      if (sweepReport?.adopted.includes(stableId)) {
        // The sweep already ran `registry.onOnline` for a match (same as
        // step 3 above) — the `devices` row's `serial` IS the new address.
        const after = db.select().from(devices).where(eq(devices.stableId, stableId)).get()
        if (after?.serial) {
          return { result: 'connected', address: after.serial, viaSweep: true }
        }
      }
      return { result: 'not-found', tried, sweep: sweepReport }
    }

    return { result: 'not-found', tried, sweep: null }
  }

  async function disconnectImpl(stableId: string): Promise<{ result: 'disconnected' | 'not-connected' | 'refused'; detail?: string }> {
    const row = db.select().from(devices).where(eq(devices.stableId, stableId)).get()
    if (!row) return { result: 'refused', detail: `${stableId} is not an enrolled device` }

    const conn = deriveConnection(row.serial, [])
    if (conn.kind === 'usb') {
      return { result: 'refused', detail: 'adb has no way to release a single USB transport — unplug the cable.' }
    }

    const list = await deps.client.listDevices()
    if (!list.some((d) => d.serial === row.serial && d.state === 'device')) {
      return { result: 'not-connected' }
    }

    try {
      await deps.client.disconnectDevice(row.serial)
    } catch (err) {
      return { result: 'refused', detail: String(err) }
    }
    return { result: 'disconnected' }
  }

  return {
    reconnect: (stableId, opts) => runExclusive(stableId, () => reconnectImpl(stableId, opts)),
    disconnect: (stableId) => runExclusive(stableId, () => disconnectImpl(stableId)),
  }
}
