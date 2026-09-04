import { eq } from 'drizzle-orm'
import type { AdbClient } from '@enkaku/adb'
import { Semaphore } from '@enkaku/adb'
import { AdbTcpTransport, AdbUsbTransport, type GuestAgentClient } from '@enkaku/drivers'
import {
  DEFAULT_DEVICE_LABEL_STATE,
  DeviceLabelStateSchema,
  DeviceSettingsSchema,
  type DeviceLabelState,
  type DeviceSettings,
  type Transport,
} from '@enkaku/protocol'
import {
  clearLockScreenLabelToDefault,
  readLockScreenLabel,
  restoreLockScreenLabel,
  writeLockScreenLabel,
} from '@enkaku/session'
import type { Db } from '../db'
import { devices, type DeviceRow } from '../db/schema'
import type { EventRecorder } from '../events/recorder'
import { lookupDeviceNumber } from '../registry/device-number'
import { EnkakuError } from '../util/errors'
import type { Logger } from '../util/logger'
import type { Actor } from './lifecycle'

/**
 * The labelling service, host side (plan 89 §4.6, §5 step 89.6).
 *
 * Two tiers, gated, never a silent fallback (§3.5): `wallpaper` needs the
 * guest agent's `screen-label` capability and reports `unavailable` — never a
 * quiet downgrade — when it is absent; `lock-screen` is plain adb, no agent,
 * no image, no font (§4.5's H2, `packages/session/src/screen-label.ts`).
 *
 * Device-scoped, persistent state (§3.6) — NOT a session step. `reconcile()`
 * is probe-first: an already-correct device costs one cheap round trip and no
 * write. `apply()` is unconditional (the "Re-apply label" action and the
 * fleet-wide switch-on). Both, and `clear()`, are serialised per device
 * (`serialize` below) so a reconnect racing an explicit apply — or a core
 * restart landing mid-pass — can never interleave two writes to the same
 * device's cached state; the device's own reported fingerprint (or, for tier
 * 0, a read-back) is the only source of truth `reconcile()` ever trusts, so a
 * crash mid-push leaves nothing worse than a `labelState` that a following
 * `reconcile()` corrects.
 *
 * `labelling.mode: 'off'` (the default, §3.8) does exactly zero device I/O
 * and, once the cache already reads `off`, zero DB writes too — a farm that
 * has not opted in costs nothing on every reconnect.
 */

export interface LabellingServiceDeps {
  db: Db
  /** Live adb client accessor — same forward-ref-safe shape `readiness.ts`'s `transportFor` uses; null before the adb subsystem is up. */
  client: () => AdbClient | null
  /**
   * Tier 1 — the SAME per-device guest-agent session a network route/identity
   * already own (plan 44 §8b's "Bug 1": never a second, independent
   * bootstrap that would rotate a live route's token out from under it).
   * `daemon.ts` wires this to `guestAgent.withGuestAgentClient`.
   */
  withGuestAgentClient: <T>(deviceId: string, fn: (client: GuestAgentClient) => Promise<T>) => Promise<T>
  /** `FarmSettings.labelling.maxConcurrent`, read fresh on every pass — the same "read settings live" discipline every settings-derived accessor in this codebase follows. */
  maxConcurrent: () => number
  /** Main-stream device events: `device.label`, recorded only on an actual transition (mirrors `agent-provisioner.ts`'s `maybeRecordTransition`). */
  record?: EventRecorder['record']
  log: Logger
  /** Test seam — replaces `Date.now()`. */
  now?: () => number
  /** Test seam — replaces the real `AdbUsbTransport`/`AdbTcpTransport` construction for tier 0. Defaults to the real thing. */
  buildTransport?: (row: DeviceRow) => Transport | null
}

export interface LabellingService {
  /** Probe-first (§3.7): asks the device, re-applies only on a fingerprint mismatch. The reconnect hook. */
  reconcile(deviceId: string): Promise<DeviceLabelState>
  /** Unconditional apply — the "Re-apply label" action and the fleet-wide switch-on. */
  apply(deviceId: string, actor: Actor): Promise<DeviceLabelState>
  /** Idempotent (§3.6, F18's rule): performs the same writes on the tenth call as the first, and consults no "already cleared" flag. */
  clear(deviceId: string, opts: { restoreOriginal: boolean; actor: Actor }): Promise<DeviceLabelState>
  /** Read-only. Live when the device is online, the cached row when not — never writes `devices.labelState` or `devices.labelFingerprint`. */
  status(deviceId: string): Promise<DeviceLabelState>
}

/** `label ASC` is Studio's own sort (F25) — sanitisation here is about GLYPHS, not order. */
function sanitiseName(raw: string): string {
  const stripped = raw.replace(/[\x00-\x1f\x7f]/g, '').trim()
  // Intl.Segmenter, not `Array.from`/`[...raw]`: a codepoint split still
  // breaks a combining-mark sequence apart (F11 — this repo has full Unicode
  // names and no font to render them, so the HOST's own truncation must not
  // be the thing that mangles one first). `undefined` locale — this is a
  // display-length truncation, not a locale-aware collation, so no locale
  // preference is meaningful here.
  const graphemes = Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(stripped), (s) => s.segment)
  return graphemes.slice(0, 24).join('')
}

function sha256Hex(s: string): string {
  return new Bun.CryptoHasher('sha256').update(s).digest('hex')
}

/**
 * Plan 89 §4.4's formula, verbatim. `density` is deliberately absent — the
 * plan's own comment states why (an operator reads from a metre away, so
 * apparent size on the panel is what matters, not physical dp) — nobody
 * should "fix" this into including it.
 */
function computeWallpaperFingerprint(input: { number: number; name: string | null; rendererVersion: number; screenW: number | null; screenH: number | null }): string {
  const parts = ['wallpaper', String(input.number), input.name ?? '', String(input.rendererVersion), `${input.screenW ?? 0}x${input.screenH ?? 0}`]
  return sha256Hex(parts.join('\n')).slice(0, 16)
}

/**
 * Tier 0's own, simpler fingerprint — no `rendererVersion`/geometry, since
 * there is no bitmap and no per-panel rendering: the only thing that can
 * change what is on screen is the text itself.
 */
function computeLockScreenFingerprint(text: string): string {
  return sha256Hex(`lock-screen\n${text}`).slice(0, 16)
}

function labelText(number: number, name: string | null): string {
  return name ? `#${number} ${name}` : `#${number}`
}

function nowSeconds(now: () => number): number {
  return Math.floor(now() / 1000)
}

export function createLabellingService(deps: LabellingServiceDeps): LabellingService {
  const { db } = deps
  const now = deps.now ?? (() => Date.now())
  const sem = new Semaphore(Math.max(1, deps.maxConcurrent()))

  const mustGet = (id: string): DeviceRow => {
    const row = db.select().from(devices).where(eq(devices.id, id)).get()
    if (!row) throw new EnkakuError('device_not_found', `no such device: ${id}`)
    return row
  }

  function readDeviceSettings(row: DeviceRow): DeviceSettings {
    const parsed = DeviceSettingsSchema.safeParse(row.settings ?? {})
    return parsed.success ? parsed.data : DeviceSettingsSchema.parse({})
  }

  /** Zod-validated (CLAUDE.md: never trust a JSON DB column raw) — a corrupt/pre-migration row reads as "never applied" rather than throwing. */
  function readCached(row: DeviceRow): DeviceLabelState {
    if (row.labelState === null || row.labelState === undefined) return DEFAULT_DEVICE_LABEL_STATE
    const parsed = DeviceLabelStateSchema.safeParse(row.labelState)
    if (!parsed.success) {
      deps.log.warn(`device ${row.id}: stored label state failed validation, treating as never-applied: ${parsed.error.message}`)
      return DEFAULT_DEVICE_LABEL_STATE
    }
    return parsed.data
  }

  function writeCached(deviceId: string, state: DeviceLabelState): void {
    db.update(devices).set({ labelFingerprint: state.fingerprint, labelState: state }).where(eq(devices.id, deviceId)).run()
  }

  /** One `device.label` event per actual transition (mirrors `agent-provisioner.ts`'s own rule) — a probe that confirms nothing changed emits nothing. */
  function finish(row: DeviceRow, prior: DeviceLabelState, next: DeviceLabelState, actor?: string | null): DeviceLabelState {
    writeCached(row.id, next)
    if (prior.state !== next.state || prior.mode !== next.mode || prior.reason !== next.reason) {
      deps.record?.({
        deviceId: row.id,
        stream: 'main',
        kind: 'device.label',
        actor: actor ?? null,
        meta: { mode: next.mode, state: next.state, reason: next.reason, from: prior.state },
      })
    }
    return next
  }

  const buildTransport: (row: DeviceRow) => Transport | null =
    deps.buildTransport ??
    ((row: DeviceRow) => {
      const client = deps.client()
      if (!client) return null
      const opts = { client, serial: row.serial, stableId: row.stableId }
      return row.transport === 'adb-tcp' ? new AdbTcpTransport(opts) : new AdbUsbTransport(opts)
    })

  // --- tier 1: wallpaper --------------------------------------------------

  async function runWallpaperPass(row: DeviceRow, settings: DeviceSettings, prior: DeviceLabelState, force: boolean, actor?: string | null): Promise<DeviceLabelState> {
    const number = lookupDeviceNumber(db, row.stableId)
    if (number === null) {
      return finish(row, prior, { ...DEFAULT_DEVICE_LABEL_STATE, mode: 'wallpaper', state: 'unavailable', reason: 'this device has no number assigned' }, actor)
    }
    const name = settings.labelling.showName ? sanitiseName(row.label) : null

    let hello: { capabilities: string[] }
    let status: { fingerprint: string | null; matchesOurs: boolean; rendererVersion: number; originalCaptured: boolean } | null
    try {
      const result = await deps.withGuestAgentClient(row.id, async (client) => {
        const h = await client.hello()
        if (!h.capabilities.includes('screen-label')) return { hello: h, status: null }
        return { hello: h, status: await client.labelStatus() }
      })
      hello = result.hello
      status = result.status
    } catch (err) {
      const reason = `this device's guest agent is unreachable: ${err instanceof Error ? err.message : String(err)}`
      return finish(row, prior, { ...DEFAULT_DEVICE_LABEL_STATE, mode: 'wallpaper', state: 'unavailable', reason }, actor)
    }
    if (!hello.capabilities.includes('screen-label') || status === null) {
      return finish(row, prior, { ...DEFAULT_DEVICE_LABEL_STATE, mode: 'wallpaper', state: 'unavailable', reason: "this device's guest agent has no screen-label capability" }, actor)
    }

    const desired = computeWallpaperFingerprint({ number, name, rendererVersion: status.rendererVersion, screenW: row.screenW, screenH: row.screenH })

    // Probe-first (§3.7 point 1): a device already confirmed at THIS exact
    // fingerprint (our own cache agrees, the agent's own consistency check
    // agrees) costs one status call and no render. `label.status` alone
    // cannot say whether BOTH surfaces took — only `label.apply`'s own
    // `applied` array can (behavioural requirement 1) — so this branch
    // trusts the cached `state`/`reason` from the pass that last actually
    // called `label.apply`, rather than re-deriving `applied`/`partial` from
    // wallpaper ids that would be an unproven heuristic.
    if (!force && desired === status.fingerprint && status.matchesOurs && prior.fingerprint === desired) {
      return finish(row, prior, { ...prior, mode: 'wallpaper', fingerprint: desired, originalCaptured: status.originalCaptured }, actor)
    }

    let applyResult: { applied: Array<'home' | 'lock'>; fingerprint: string }
    try {
      applyResult = await deps.withGuestAgentClient(row.id, (client) => client.labelApply({ fingerprint: desired, number: String(number), name, surfaces: ['home', 'lock'] }))
    } catch (err) {
      const reason = `label.apply failed: ${err instanceof Error ? err.message : String(err)}`
      return finish(row, prior, { ...DEFAULT_DEVICE_LABEL_STATE, mode: 'wallpaper', state: 'unavailable', reason }, actor)
    }

    const hasHome = applyResult.applied.includes('home')
    const hasLock = applyResult.applied.includes('lock')
    let state: DeviceLabelState['state']
    let reason: string | null = null
    if (hasHome && hasLock) {
      state = 'applied'
    } else if (hasHome || hasLock) {
      state = 'partial'
      reason = `only the ${hasHome ? 'home' : 'lock'} screen accepted the label — the other surface likely refused it (an OEM skin, plan 89 §0.2 H5)`
    } else {
      // UNPROVEN on hardware (no device was reachable while this was
      // written): no observed skin refuses BOTH surfaces of one
      // `label.apply` call. Treated as `unavailable` rather than a
      // `partial` with nothing accepted — "applied nothing" is not a shade
      // of success. 89.10's hardware pass should confirm whether this
      // branch is ever actually reached.
      state = 'unavailable'
      reason = 'the device refused the label on both surfaces'
    }

    // `LabelApplyResultSchema` carries no `originalCaptured` (only
    // `label.status`/`label.clear` do, plan 89 §4.5) — one more read, through
    // the same session shape, is the only honest way to learn it; tolerated
    // on failure since the apply itself already succeeded.
    let originalCaptured = prior.originalCaptured
    try {
      const after = await deps.withGuestAgentClient(row.id, (client) => client.labelStatus())
      originalCaptured = after.originalCaptured
    } catch (err) {
      deps.log.debug(`device ${row.id}: post-apply label.status failed (tolerated, originalCaptured kept stale): ${String(err)}`)
    }

    return finish(row, prior, { mode: 'wallpaper', state, reason, fingerprint: applyResult.fingerprint, appliedAt: nowSeconds(now), originalCaptured, capturedLockScreen: null }, actor)
  }

  // --- tier 0: lock-screen -------------------------------------------------

  async function runLockScreenPass(row: DeviceRow, settings: DeviceSettings, prior: DeviceLabelState, force: boolean, actor?: string | null): Promise<DeviceLabelState> {
    const number = lookupDeviceNumber(db, row.stableId)
    if (number === null) {
      return finish(row, prior, { ...DEFAULT_DEVICE_LABEL_STATE, mode: 'lock-screen', state: 'unavailable', reason: 'this device has no number assigned' }, actor)
    }
    const name = settings.labelling.showName ? sanitiseName(row.label) : null
    const text = labelText(number, name)
    const desired = computeLockScreenFingerprint(text)

    if (!force && desired === prior.fingerprint && prior.mode === 'lock-screen' && prior.state === 'applied') {
      return prior // cheap path — a full read-back re-check happens on `force`/an actual mismatch, not every reconnect
    }

    const transport = buildTransport(row)
    if (!transport) {
      return finish(row, prior, { ...prior, mode: 'lock-screen', state: 'unknown', reason: 'adb is not ready yet' }, actor)
    }
    await transport.connect()
    try {
      // Capture the original EXACTLY ONCE (H2's genuinely-readable original)
      // and persist it BEFORE the first write — so a crash between capture
      // and write never strands the phone with no way back to what it had
      // (the trap this step's brief names explicitly). A later pass finds
      // `prior.capturedLockScreen` already set and never re-captures over it.
      let captured = prior.capturedLockScreen
      if (!captured) {
        captured = await readLockScreenLabel(transport)
        writeCached(row.id, { ...prior, mode: 'lock-screen', capturedLockScreen: captured, originalCaptured: true })
      }
      const { verified } = await writeLockScreenLabel(transport, text)
      if (!verified) {
        // H2 is unproven on hardware (§0's own note) — a read-back mismatch
        // is reported honestly, never rounded up to `applied`.
        return finish(row, prior, { mode: 'lock-screen', state: 'unavailable', reason: 'the device did not accept the lock-screen text (read-back mismatch)', fingerprint: null, appliedAt: null, originalCaptured: true, capturedLockScreen: captured }, actor)
      }
      return finish(row, prior, { mode: 'lock-screen', state: 'applied', reason: null, fingerprint: desired, appliedAt: nowSeconds(now), originalCaptured: true, capturedLockScreen: captured }, actor)
    } catch (err) {
      const reason = `lock-screen write failed: ${err instanceof Error ? err.message : String(err)}`
      return finish(row, prior, { ...prior, mode: 'lock-screen', state: 'unavailable', reason }, actor)
    } finally {
      await transport.disconnect()
    }
  }

  async function runPass(deviceId: string, opts: { force: boolean; actor?: string | null }): Promise<DeviceLabelState> {
    const row = mustGet(deviceId)
    const settings = readDeviceSettings(row)
    const mode = settings.labelling.mode
    const prior = readCached(row)

    if (mode === 'off') {
      // §3.8: zero device I/O, ever. Once the cache already agrees, zero DB
      // writes too — a farm that has not opted in costs exactly nothing on
      // every reconnect (the acceptance criterion this line exists for).
      if (prior.state === 'off' && prior.mode === 'off') return prior
      return finish(row, prior, { ...DEFAULT_DEVICE_LABEL_STATE }, opts.actor)
    }

    // `labelling.maxConcurrent` (plan 89 §3.7): bounds simultaneous DEVICE
    // WRITES farm-wide — read fresh so a live settings change takes effect
    // on the next pass without a restart, the same discipline `host-adb.ts`
    // already applies to its own semaphores.
    const wanted = Math.max(1, deps.maxConcurrent())
    if (wanted !== sem.max) sem.resize(wanted)
    const release = await sem.acquire()
    try {
      return mode === 'wallpaper' ? await runWallpaperPass(row, settings, prior, opts.force, opts.actor) : await runLockScreenPass(row, settings, prior, opts.force, opts.actor)
    } finally {
      release()
    }
  }

  // Per-device serialisation (the trap this step's brief names explicitly):
  // a reconnect racing an explicit "Re-apply", or a clear racing either,
  // must never interleave two writes to the same device's cached state.
  // Mirrors `agent-provisioner.ts`'s `inFlight` map in spirit, but chains
  // rather than dedupes — `apply()` and `clear()` are distinct operations
  // that must each actually run, not collapse into "whichever started
  // first", unlike `agent-provisioner`'s single idempotent `ensure()`.
  const chains = new Map<string, Promise<unknown>>()
  function serialize<T>(deviceId: string, fn: () => Promise<T>): Promise<T> {
    const prior = chains.get(deviceId) ?? Promise.resolve()
    const chained = prior.catch(() => undefined).then(fn)
    chains.set(
      deviceId,
      chained.catch(() => undefined),
    )
    return chained
  }

  async function clearImpl(deviceId: string, opts: { restoreOriginal: boolean; actor: Actor }): Promise<DeviceLabelState> {
    const row = mustGet(deviceId)
    const prior = readCached(row)
    const actor = opts.actor.userId

    if (prior.mode === 'wallpaper') {
      await deps.withGuestAgentClient(row.id, (client) => client.labelClear(opts.restoreOriginal && prior.originalCaptured))
      return finish(row, prior, { ...DEFAULT_DEVICE_LABEL_STATE, mode: readDeviceSettings(row).labelling.mode }, actor)
    }

    if (prior.mode === 'lock-screen') {
      const transport = buildTransport(row)
      if (!transport) throw new EnkakuError('E_ADB_UNAVAILABLE', 'adb is not ready yet')
      await transport.connect()
      try {
        if (opts.restoreOriginal && prior.capturedLockScreen) {
          await restoreLockScreenLabel(transport, prior.capturedLockScreen, deps.log)
        } else {
          await clearLockScreenLabelToDefault(transport, deps.log)
        }
      } finally {
        await transport.disconnect()
      }
      return finish(row, prior, { ...DEFAULT_DEVICE_LABEL_STATE, mode: readDeviceSettings(row).labelling.mode }, actor)
    }

    // Nothing was ever applied (`mode: 'off'`, or a state predating this
    // service) — nothing on the device to undo. Idempotent by construction:
    // every subsequent call finds the identical `prior.mode` and takes this
    // same branch, writing the identical default state.
    return finish(row, prior, { ...DEFAULT_DEVICE_LABEL_STATE, mode: readDeviceSettings(row).labelling.mode }, actor)
  }

  async function statusImpl(deviceId: string): Promise<DeviceLabelState> {
    const row = mustGet(deviceId)
    const cached = readCached(row)
    if ((row.status ?? 'offline') === 'offline') return cached // "the cached row when not [online]" — never mutated here

    const settings = readDeviceSettings(row)
    const mode = settings.labelling.mode
    if (mode === 'off') return cached

    const number = lookupDeviceNumber(db, row.stableId)
    if (number === null) return { ...cached, state: 'unavailable', reason: 'this device has no number assigned' }
    const name = settings.labelling.showName ? sanitiseName(row.label) : null

    if (mode === 'wallpaper') {
      try {
        const result = await deps.withGuestAgentClient(row.id, async (client) => {
          const h = await client.hello()
          if (!h.capabilities.includes('screen-label')) return { capable: false as const }
          return { capable: true as const, status: await client.labelStatus() }
        })
        if (!result.capable) return { ...cached, mode: 'wallpaper', state: 'unavailable', reason: "this device's guest agent has no screen-label capability" }
        const desired = computeWallpaperFingerprint({ number, name, rendererVersion: result.status.rendererVersion, screenW: row.screenW, screenH: row.screenH })
        const matches = desired === result.status.fingerprint && result.status.matchesOurs
        return { ...cached, mode: 'wallpaper', fingerprint: desired, originalCaptured: result.status.originalCaptured, state: matches ? cached.state : 'stale' }
      } catch (err) {
        return { ...cached, mode: 'wallpaper', state: 'unavailable', reason: `this device's guest agent is unreachable: ${err instanceof Error ? err.message : String(err)}` }
      }
    }

    // lock-screen: read-only probe, no write.
    const transport = buildTransport(row)
    if (!transport) return cached
    await transport.connect()
    try {
      const text = labelText(number, name)
      const live = await readLockScreenLabel(transport)
      const matches = live.text === text && live.enabled
      return { ...cached, mode: 'lock-screen', fingerprint: computeLockScreenFingerprint(text), state: matches ? 'applied' : 'stale' }
    } catch (err) {
      return { ...cached, mode: 'lock-screen', state: 'unavailable', reason: `lock-screen read failed: ${err instanceof Error ? err.message : String(err)}` }
    } finally {
      await transport.disconnect()
    }
  }

  return {
    reconcile: (deviceId) => serialize(deviceId, () => runPass(deviceId, { force: false })),
    apply: (deviceId, actor) => serialize(deviceId, () => runPass(deviceId, { force: true, actor: actor.userId })),
    clear: (deviceId, opts) => serialize(deviceId, () => clearImpl(deviceId, opts)),
    status: (deviceId) => statusImpl(deviceId),
  }
}
