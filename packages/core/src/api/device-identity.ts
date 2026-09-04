import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { shellQuote } from '@enkaku/adb'
import { GUEST_AGENT_PACKAGE, type GuestAgentClient } from '@enkaku/drivers'
import {
  DeviceIdentitySchema,
  DeviceSettingsSchema,
  E_DEVICE_CONFLICT,
  PersistedNetworkRouteSchema,
  defaultDeviceSettings,
  type DeviceIdentity,
  type DeviceSettings,
  type ShellResult,
} from '@enkaku/protocol'
import type { AuthEnv } from '../auth/middleware'
import { requirePermission } from '../auth/middleware'
import type { Db } from '../db'
import { devices, type DeviceRow } from '../db/schema'
import type { EventRecorder } from '../events/recorder'
import { countryToLocale, countryToTimezone, cityToGps } from '../identity/lookups'
import type { ActivityRegistry } from '../activity/registry'
import type { ControlPolicySettings } from '../activity/policy'
import { requireAdmission } from '../activity/admission'
import type { DeviceStateMachine } from '../device/state-machine'
import type { Logger } from '../util/logger'
import { EnkakuError } from '../util/errors'

/**
 * `GET/PUT/DELETE /api/devices/:id/identity` and `POST /api/devices/:id/identity/sync`
 * (plan 58 §4.3, §5.3) — timezone, locale, and a mock GPS fix, aligned with a route's observed
 * exit so every signal an app under test can see agrees on one identity (plan 58 §0).
 *
 * NOT a driver layer (plan 58 §3.1): no activity-scoped apply/revert tied to a session, no
 * capability negotiation of its own. It lives in `devices.settings.identity` exactly like
 * `timing`/`prep`, with its own endpoints — a separate file from `guest-agent.ts` because identity
 * is a device-settings extension, not part of the network route, even though applying GPS reuses
 * that file's guest-agent session machinery via `withGuestAgentClient` (see its doc comment on
 * `GuestAgentRoutesHandle` for why a SECOND, independent session must never be built here).
 *
 * Timezone and locale are plain `adb shell setprop` — they do not depend on the guest agent at
 * all and always work when the device is reachable (plan 58 §4's scoping note). GPS depends on
 * the guest agent advertising the `mock-location` capability (§5.4): an older or missing agent
 * build means GPS cannot be applied, and this file says so in the response — it never fabricates
 * success and never silently drops the request.
 */

const ERROR_STATUS: Record<string, number> = {
  device_not_found: 404,
  E_BAD_REQUEST: 400,
  [E_DEVICE_CONFLICT]: 409,
  device_unavailable: 409,
  E_NO_GEO_OBSERVATION: 409,
}

export interface DeviceIdentityRoutesDeps {
  db: Db
  /** Per-device shell exec, through the adb queue — the same shape `Transport.exec` uses (mirrors `guest-agent.ts`'s `exec` dep). */
  exec: (serial: string, cmd: string) => Promise<ShellResult>
  /** The device activity registry (plan 205 §4.2, §4.8) — the one admission door every mutating endpoint here takes. */
  activities: Pick<ActivityRegistry, 'list'>
  /** `control.overControl`/`control.idleSec`, read fresh on every admission check (plan 205 §4.5). */
  controlSettings: () => ControlPolicySettings
  states: Pick<DeviceStateMachine, 'current'>
  /** Main-stream device events: identity.applied / identity.cleared. */
  record?: EventRecorder['record']
  log: Logger
  /**
   * Reuses the SAME per-device guest-agent session a network route already owns, or builds and
   * closes an ephemeral one when none is applied — `guestAgent.withGuestAgentClient` from
   * `createGuestAgentRoutes`'s returned handle. Never build a second, independent session here.
   */
  withGuestAgentClient: <T>(deviceId: string, fn: (client: GuestAgentClient) => Promise<T>) => Promise<T>
}

/** What actually happened to each field of a PUT — distinct from what got PERSISTED, since GPS can be declared but not appliable. */
interface ApplyResult {
  timezone?: 'applied'
  locale?: 'applied'
  gps?: 'applied' | 'unavailable'
  gpsDetail?: string
}

export function createDeviceIdentityRoutes(deps: DeviceIdentityRoutesDeps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>()
  const { db } = deps

  const mustGet = (id: string): DeviceRow => {
    const row = db.select().from(devices).where(eq(devices.id, id)).get()
    if (!row) throw new EnkakuError('device_not_found', `no such device: ${id}`)
    return row
  }

  /**
   * Plan 205 §4.9 — the SAME `command` policy row `shell.exec` takes: a
   * manual control marker is no longer required to change what a device
   * presents to apps under test (only a live job/workflow-job/install warns,
   * never forbids, against `command`), which is the correct, deliberate
   * liberalisation this row already gives every other adb-touching write.
   */
  function requireIdentityAdmission(deviceId: string): void {
    requireAdmission(deps.activities, deps.controlSettings, deps.states, deviceId, 'command')
  }

  function readSettings(row: DeviceRow): DeviceSettings {
    const parsed = DeviceSettingsSchema.safeParse(row.settings ?? {})
    return parsed.success ? parsed.data : defaultDeviceSettings()
  }

  function writeSettings(deviceId: string, settings: DeviceSettings): void {
    db.update(devices).set({ settings }).where(eq(devices.id, deviceId)).run()
  }

  /**
   * GPS is gated on the guest agent's own advertised capabilities (§5.4) — checked here, on
   * every apply, rather than cached: an operator can swap in a build that supports it (or
   * downgrade to one that doesn't) between two calls, and a stale "supported" reading would be
   * exactly the silent failure CLAUDE.md forbids. Never throws for a capability/reachability
   * problem — always returns an honest `{ applied: false, detail }` instead, so a PUT that also
   * asked for timezone/locale can still apply those.
   */
  async function applyGps(row: DeviceRow, gps: NonNullable<DeviceIdentity['gps']>): Promise<{ applied: boolean; detail?: string }> {
    try {
      const hello = await deps.withGuestAgentClient(row.id, (client) => client.hello())
      if (!hello.capabilities.includes('mock-location')) {
        return {
          applied: false,
          detail: "this device's guest agent cannot set a mock location — its installed build does not advertise the mock-location capability",
        }
      }
      // Granted every time, not just once: `appops` resets to `default` (deny) on an app update
      // or a `pm clear`, and a stale "already granted" belief would surface as a confusing
      // E_NOT_PREPARED from `location.set` instead of a clear explanation here.
      await deps.exec(row.serial, `appops set ${shellQuote(GUEST_AGENT_PACKAGE)} android:mock_location allow`)
      await deps.withGuestAgentClient(row.id, (client) => client.locationSet(gps.lat, gps.lng, gps.accuracy))
      return { applied: true }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      deps.log.warn(`identity[${row.id}]: could not apply GPS via the guest agent: ${detail}`)
      return { applied: false, detail: `this device's guest agent cannot set a mock location right now — ${detail}` }
    }
  }

  /** Best-effort — a device that is offline or whose agent was uninstalled cannot be reached to clear anything, and that is not a reason to fail the clear of the STORED settings below. */
  async function clearGps(row: DeviceRow): Promise<void> {
    try {
      await deps.exec(row.serial, `appops set ${shellQuote(GUEST_AGENT_PACKAGE)} android:mock_location ignore`)
      await deps.withGuestAgentClient(row.id, (client) => client.locationClear())
    } catch (err) {
      deps.log.warn(`identity[${row.id}]: could not clear GPS via the guest agent (tolerated): ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  app.get('/:id/identity', requirePermission('device.settings'), (c) => {
    const row = mustGet(c.req.param('id'))
    return c.json({ identity: readSettings(row).identity })
  })

  app.put('/:id/identity', requirePermission('device.settings'), async (c) => {
    const row = mustGet(c.req.param('id'))
    requireIdentityAdmission(row.id)
    const parsed = DeviceIdentitySchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) {
      throw new EnkakuError('E_BAD_REQUEST', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
    }
    const identity = parsed.data
    const result: ApplyResult = {}

    // Timezone/locale: plain `setprop`, no guest agent involved (plan 58 §4's scoping note) —
    // a failure here is a genuine adb/infrastructure problem and is allowed to throw and fail
    // the whole request, unlike GPS below.
    if (identity.timezone !== undefined) {
      await deps.exec(row.serial, `setprop persist.sys.timezone ${shellQuote(identity.timezone)}`)
      result.timezone = 'applied'
    }
    if (identity.locale !== undefined) {
      await deps.exec(row.serial, `setprop persist.sys.locale ${shellQuote(identity.locale)}`)
      result.locale = 'applied'
    }
    if (identity.gps !== undefined) {
      const gpsResult = await applyGps(row, identity.gps)
      result.gps = gpsResult.applied ? 'applied' : 'unavailable'
      if (gpsResult.detail) result.gpsDetail = gpsResult.detail
    }

    // Persisted regardless of whether GPS could actually be applied — the operator's DECLARED
    // intent survives even when the agent cannot carry it out right now, mirroring
    // `guest-agent.ts`'s own network PUT ("persisted BEFORE the apply attempt, so the config
    // survives even if the apply below fails").
    const settings = readSettings(row)
    writeSettings(row.id, { ...settings, identity })

    deps.record?.({
      deviceId: row.id,
      stream: 'main',
      kind: 'identity.applied',
      actor: c.get('user')?.id ?? null,
      meta: { keys: Object.keys(identity), gpsApplied: result.gps === 'applied' },
    })

    return c.json({ identity, result })
  })

  app.delete('/:id/identity', requirePermission('device.settings'), async (c) => {
    const row = mustGet(c.req.param('id'))
    requireIdentityAdmission(row.id)
    const settings = readSettings(row)
    const previous = settings.identity

    // Reverts to the device's own auto value — an empty `setprop` argument clears the persisted
    // property (plan 58 §3.3) — only for whatever this farm actually set, never blind.
    if (previous.timezone !== undefined) {
      await deps.exec(row.serial, `setprop persist.sys.timezone ''`).catch((err) =>
        deps.log.warn(`identity[${row.id}]: could not clear timezone (tolerated): ${err instanceof Error ? err.message : String(err)}`),
      )
    }
    if (previous.locale !== undefined) {
      await deps.exec(row.serial, `setprop persist.sys.locale ''`).catch((err) =>
        deps.log.warn(`identity[${row.id}]: could not clear locale (tolerated): ${err instanceof Error ? err.message : String(err)}`),
      )
    }
    if (previous.gps !== undefined) {
      await clearGps(row)
    }

    writeSettings(row.id, { ...settings, identity: {} })
    deps.record?.({ deviceId: row.id, stream: 'main', kind: 'identity.cleared', actor: c.get('user')?.id ?? null })

    return c.json({ identity: {} })
  })

  /**
   * Pre-fills suggested identity values from the most recent geo observation (plan 58 §3.4) —
   * NEVER applies anything; the operator confirms in Studio before a PUT. `E_NO_GEO_OBSERVATION`
   * (409) when no route has ever observed an exit for this device, distinguishing "nothing to
   * suggest yet" from a malformed request.
   */
  app.post('/:id/identity/sync', requirePermission('device.settings'), (c) => {
    const row = mustGet(c.req.param('id'))
    const parsedRoute = row.networkRoute === null || row.networkRoute === undefined ? null : PersistedNetworkRouteSchema.safeParse(row.networkRoute)
    const persisted = parsedRoute && parsedRoute.success ? parsedRoute.data : null
    const geo = persisted?.exitHistory?.[0]
    if (!geo) {
      throw new EnkakuError(
        'E_NO_GEO_OBSERVATION',
        'no geo observation is available for this device yet — apply a network route with a geo provider configured and let it observe at least one exit',
      )
    }

    const suggestion: DeviceIdentity = {}
    if (geo.country) {
      const timezone = countryToTimezone(geo.country)
      if (timezone) suggestion.timezone = timezone
      const locale = countryToLocale(geo.country)
      if (locale) suggestion.locale = locale
    }
    if (geo.city) {
      const gps = cityToGps(geo.city)
      if (gps) suggestion.gps = { lat: gps.lat, lng: gps.lng, accuracy: 100 }
    }

    return c.json({ suggestion, observedAt: geo.at, country: geo.country, city: geo.city })
  })

  app.onError((err, c) => {
    if (err instanceof EnkakuError) return c.json(err.toJSON(), (ERROR_STATUS[err.code] ?? 500) as 400)
    throw err
  })

  return app
}
