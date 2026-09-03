# Plan 58 — M28 : Device identity spoofing (timezone, locale, GPS)

> Status: partial — protocol, read seam, core API, host driver, lookup tables, Studio panel, and
> drift detection are implemented and tested; the guest agent's `MockLocation.kt` compiles (`bun
> run build:guest-agent --debug` succeeds) but is unverified against real hardware — no device has
> had a build installed that advertises the `mock-location` capability, so acceptance criterion 4
> (`LocationManager.getLastKnownLocation()` returning the spoofed fix) is unconfirmed. Timezone and
> locale (plain `setprop`, no guest agent involved) are implemented and unit-tested but likewise
> unverified on a real device in this session.
> Ships: packages/core/src/api/device-identity.ts
> **Depends on:** Plan 52 (device-scoped routes), Plan 55 (geo observation, which this syncs against).
> **Spec references:** §7 (driver layers — this is NOT a driver layer, it's a device-settings extension), §17 (positioning).
> **Research needed:** Android mock location provider API, `appops set MOCK_LOCATION`, `setprop persist.sys.timezone` behavior across Android versions.

---

## 0. The gap this fills

A device routes traffic through a SOAX residential proxy in New York. The proxy's exit IP geolocates to `US, NY, New York`. The `geo` check passes, `health` reads `ok`.

But Instagram's fraud detection sees:
- IP: New York (from proxy)
- GPS: Jakarta (from device's real location services)
- Timezone: Asia/Jakarta (from device settings)
- Locale: id_ID (from device settings)

Three signals contradict the IP. The account gets flagged, shadowbanned, or suspended. The proxy system did its job perfectly — the leak is in the **device identity**, not the network path.

This plan closes that gap: align timezone, locale, and GPS location with the proxy's observed geo, so every signal Instagram/TikTok can see agrees on one identity.

---

## 1. Goals

Once this plan is done, all of the following are TRUE:

1. An operator can set a device's timezone, locale, and GPS location from Studio (per-device, not fleet-wide).
2. The identity settings persist across device reboots and route changes.
3. A "sync with proxy" button auto-fills timezone/locale/GPS from the most recent `geo` observation (Plan 55 §4.3's `exitHistory`).
4. GPS location is applied via Android's mock location provider (no root required).
5. Timezone and locale are applied via `adb shell setprop` (no root required).
6. Identity settings are visible on the device page alongside the network route status.
7. Changing the proxy's geo (e.g., switching from US to JP) surfaces a warning when identity no longer matches, with a one-click "sync" action.
8. `bun run typecheck` passes and `bun test` is green.

---

## 2. Non-goals

- **IMEI spoofing.** Requires root or a custom ROM. Out of scope for stock Android devices.
- **Device model/manufacturer spoofing.** Same — requires root or build.prop edits.
- **MAC address spoofing.** Requires root.
- **TLS fingerprint manipulation (JA3/JA4).** Different layer (network interception), different plan if ever needed.
- **Fleet-wide identity templates.** Per-device only for now; fleet bulk assignment is adjacent but out of scope (mirrors Plan 33's per-device proxy stance).
- **Automatic identity rotation.** Detect mismatch and warn; the operator decides (same boundary as Plan 55's geo drift).
- **Browser fingerprint spoofing (canvas, WebGL, fonts).** Out of scope — that's the app under test's concern, not the device farm's.

---

## 3. Context and design decisions

### 3.1 Why this is NOT a driver layer

Plan 33 established five driver layers (transport, display, input, inspector, network), each with a `NetworkRoute`-style interface and lease-scoped lifecycle. Identity spoofing does not fit that pattern:

- It has no `apply()`/`revert()` lifecycle tied to a lease. A device's timezone stays set whether or not a script is running.
- It has no `observe()` that reads back device state in real time (timezone is set once, not continuously monitored).
- It has no capability negotiation (every Android device supports timezone/locale/GPS mock).

So this is a **device-settings extension**, not a driver layer. It lives in `devices.settings` (JSON column, same as `timing` and `prep`), with its own API endpoints and Studio UI, but no registry entry.

### 3.2 Why mock location provider and not `am start-activity` with fake GPS

Two paths exist for GPS spoofing on stock Android:

**Path A: Mock location provider (chosen)**
- `adb shell appops set <pkg> MOCK_LOCATION allow`
- Install a small helper app (or extend the guest agent) that implements `LocationProvider`
- The helper receives lat/lng from the host via the control channel and reports it as the device's location
- Apps that call `LocationManager.getLastKnownLocation()` or register for updates get the spoofed location
- No root required, works on stock Android 10+

**Path B: `am start-activity` with intent extras**
- Some apps accept location via intent extras
- Not universal — most apps read from `LocationManager`, not intents
- Does not affect system-wide location

Path A is the only one that works for Instagram/TikTok, which read from `LocationManager`. The guest agent already has a control channel and a foreground service — extending it with a `MockLocationService` is incremental, not a second APK.

### 3.3 Why `setprop persist.sys.timezone` and not `Settings.Global`

Android stores timezone in two places:
- `Settings.Global.TIME_ZONE` (deprecated, read-only from API 29+)
- `persist.sys.timezone` system property (the source of truth from API 29+)

`setprop persist.sys.timezone America/New_York` works from adb shell without root, and survives reboot (the `persist.` prefix writes to `/data/property/`). Verified on Android 15.

Locale is similar: `setprop persist.sys.locale en_US` (or `setprop persist.sys.locale b+zh+Hans+CN` for BCP 47 tags).

### 3.4 The "sync with proxy" affordance

The `geo` check (Plan 55 §4.2) already observes the proxy's exit location: country, region, city, ASN, ISP. This plan adds a "sync" action that:

1. Reads the most recent `GeoObservation` from `exitHistory` (Plan 55 §4.3).
2. Maps `country` → timezone (via a static lookup table, e.g., `US` → `America/New_York` as a default, or a more granular `region` → timezone mapping).
3. Maps `country` → locale (e.g., `US` → `en_US`, `JP` → `ja_JP`).
4. Maps `city` → GPS coordinates (via a static lookup table or a geocoding API call).
5. Pre-fills the identity form with these values, but does NOT auto-apply — the operator confirms.

This is a convenience, not automation. The operator can override any field before applying.

### 3.5 Identity drift detection

When the proxy's `geo` observation changes (Plan 55's drift detection), and the device's identity settings no longer match, surface a warning:

- Timezone mismatch: proxy says `US, NY` but device timezone is `Asia/Jakarta`
- Locale mismatch: proxy says `JP` but device locale is `id_ID`
- GPS mismatch: proxy says `New York` but GPS is set to Jakarta coordinates

The warning appears on the device page's Identity section, with a "sync" button to realign. This mirrors Plan 55's geo drift detection pattern: detect, warn, let the operator decide.

---

## 4. Technical design

### 4.1 Protocol — `packages/protocol/src/settings.ts`

Extend `DeviceSettingsSchema` with an `identity` section:

```ts
export const DeviceIdentitySchema = z.object({
  timezone: z.string().optional().describe('IANA timezone, e.g. "America/New_York"').meta({ title: 'Timezone' }),
  locale: z.string().optional().describe('BCP 47 locale tag, e.g. "en_US" or "ja_JP"').meta({ title: 'Locale' }),
  gps: z.object({
    lat: z.number().min(-90).max(90).describe('Latitude').meta({ title: 'Latitude' }),
    lng: z.number().min(-180).max(180).describe('Longitude').meta({ title: 'Longitude' }),
    accuracy: z.number().positive().optional().describe('Accuracy in meters, default 100').meta({ title: 'Accuracy' }),
  }).optional().describe('Mock GPS location').meta({ title: 'GPS location' }),
}).describe('Device identity settings (timezone, locale, GPS)').meta({ title: 'Identity' })

// In DeviceSettingsSchema:
identity: DeviceIdentitySchema.optional().default({}),
```

### 4.2 The read seam — `packages/session/src/types.ts`

Extend `DeviceSnapshot` to carry identity settings:

```ts
export interface DeviceSnapshot {
  // ... existing fields
  identity: {
    timezone?: string
    locale?: string
    gps?: { lat: number; lng: number; accuracy?: number }
  }
}
```

`createDbDeviceSource` (`packages/core/src/session/adapters.ts`) projects `devices.settings.identity` into the snapshot.

### 4.3 Core API — `packages/core/src/api/device-identity.ts`

New endpoints, gated by `device.settings` permission (same as `timing`/`prep`):

```
GET    /api/devices/:id/identity     → DeviceIdentity | null
PUT    /api/devices/:id/identity     → apply timezone/locale/GPS
DELETE /api/devices/:id/identity     → clear identity settings (revert to device defaults)
POST   /api/devices/:id/identity/sync → auto-fill from geo observation, return suggested values (does NOT apply)
```

**PUT handler logic:**

```ts
async function applyIdentity(row: DeviceRow, identity: DeviceIdentity): Promise<void> {
  // Timezone
  if (identity.timezone) {
    await hostAdb(['-s', row.serial, 'shell', 'setprop', 'persist.sys.timezone', identity.timezone])
  }
  // Locale
  if (identity.locale) {
    await hostAdb(['-s', row.serial, 'shell', 'setprop', 'persist.sys.locale', identity.locale])
  }
  // GPS mock location
  if (identity.gps) {
    // Grant MOCK_LOCATION app-op to guest agent
    await hostAdb(['-s', row.serial, 'shell', 'appops', 'set', GUEST_AGENT_PACKAGE, 'MOCK_LOCATION', 'allow'])
    // Send location to guest agent via control channel
    await withEphemeralSession(row, (client) => client.locationSet(identity.gps!))
  }
  // Persist to devices.settings
  const settings = readSettings(row)
  writeSettings(row.id, { ...settings, identity })
}
```

**DELETE handler logic:**

```ts
async function clearIdentity(row: DeviceRow): Promise<void> {
  // Revert timezone to auto (network-provided)
  await hostAdb(['-s', row.serial, 'shell', 'setprop', 'persist.sys.timezone', ''])
  // Revert locale to default
  await hostAdb(['-s', row.serial, 'shell', 'setprop', 'persist.sys.locale', ''])
  // Clear mock location
  await hostAdb(['-s', row.serial, 'shell', 'appops', 'set', GUEST_AGENT_PACKAGE, 'MOCK_LOCATION', 'ignore'])
  await withEphemeralSession(row, (client) => client.locationClear())
  // Clear from devices.settings
  const settings = readSettings(row)
  writeSettings(row.id, { ...settings, identity: {} })
}
```

**POST /sync handler logic:**

```ts
async function suggestIdentity(row: DeviceRow): Promise<DeviceIdentity> {
  const persisted = readPersistedRoute(row)
  const geoObs = persisted?.exitHistory?.[0] // most recent
  if (!geoObs) throw new EnkakuError('E_NO_GEO_OBSERVATION', 'no geo observation available')
  
  const timezone = countryToTimezone(geoObs.country) // static lookup
  const locale = countryToLocale(geoObs.country)     // static lookup
  const gps = cityToGps(geoObs.city)                 // static lookup or geocoding API
  
  return { timezone, locale, gps }
}
```

### 4.4 Guest agent: mock location provider

Extend the guest agent APK with a `MockLocationService`:

**`apps/guest-agent/app/src/main/java/dev/enkaku/guestagent/identity/MockLocationService.kt`:**

```kotlin
class MockLocationService : Service() {
  private var locationManager: LocationManager? = null
  private val providerName = "enkaku-mock"

  override fun onCreate() {
    super.onCreate()
    locationManager = getSystemService(Context.LOCATION_SERVICE) as LocationManager
    // Add a test provider
    locationManager?.addTestProvider(
      providerName,
      false, // requiresNetwork
      false, // requiresSatellite
      false, // requiresCell
      false, // hasMonetaryCost
      true,  // supportsAltitude
      true,  // supportsSpeed
      true,  // supportsBearing
      LocationProvider.POWER_LOW,
      LocationProvider.ACCURACY_FINE
    )
    locationManager?.setTestProviderEnabled(providerName, true)
  }

  fun setLocation(lat: Double, lng: Double, accuracy: Float) {
    val location = Location(providerName).apply {
      latitude = lat
      longitude = lng
      this.accuracy = accuracy
      time = System.currentTimeMillis()
      elapsedRealtimeNanos = SystemClock.elapsedRealtimeNanos()
    }
    locationManager?.setTestProviderLocation(providerName, location)
  }

  fun clearLocation() {
    locationManager?.removeTestProvider(providerName)
  }

  override fun onBind(intent: Intent?): IBinder? = null
}
```

**Control channel methods (extend `Protocol.kt`):**

```kotlin
const val METHOD_LOCATION_SET = "location.set"
const val METHOD_LOCATION_CLEAR = "location.clear"
```

**ControlService handler:**

```kotlin
Protocol.METHOD_LOCATION_SET -> {
  val gps = request.optJSONObject("gps")
    ?: return error(id, Protocol.ERR_BAD_REQUEST, "missing gps")
  val lat = gps.optDouble("lat")
  val lng = gps.optDouble("lng")
  val accuracy = gps.optDouble("accuracy", 100.0).toFloat()
  MockLocationService.startAndSet(this, lat, lng, accuracy)
  ok(id) { put("set", true) }
}

Protocol.METHOD_LOCATION_CLEAR -> {
  MockLocationService.clear(this)
  ok(id) { put("cleared", true) }
}
```

### 4.5 Host-side driver — `packages/drivers/src/identity/mock-location.ts`

```ts
export interface MockLocationDriver {
  set(gps: { lat: number; lng: number; accuracy?: number }): Promise<void>
  clear(): Promise<void>
}

export function createMockLocationDriver(deps: { session: GuestAgentSession }): MockLocationDriver {
  return {
    async set(gps) {
      await deps.session.withClient((client) => client.locationSet(gps))
    },
    async clear() {
      await deps.session.withClient((client) => client.locationClear())
    },
  }
}
```

### 4.6 Studio UI — `packages/studio/src/components/identity/IdentityPanel.tsx`

New tab on the device page (alongside Network, Control, Jobs, etc.):

- **Timezone dropdown** — searchable list of IANA timezones, with a "sync from proxy" button
- **Locale dropdown** — searchable list of BCP 47 locales, with a "sync from proxy" button
- **GPS location** — lat/lng input fields (or a map widget if feasible), with a "sync from proxy" button
- **Apply button** — calls `PUT /api/devices/:id/identity`
- **Clear button** — calls `DELETE /api/devices/:id/identity`
- **Drift warning** — if proxy geo ≠ identity settings, show a warning with a "sync all" button

**Drift detection logic:**

```ts
function computeIdentityDrift(identity: DeviceIdentity, geoObs: GeoObservation | null): { timezone: boolean; locale: boolean; gps: boolean } {
  if (!geoObs) return { timezone: false, locale: false, gps: false }
  
  const expectedTimezone = countryToTimezone(geoObs.country)
  const expectedLocale = countryToLocale(geoObs.country)
  const expectedGps = cityToGps(geoObs.city)
  
  return {
    timezone: identity.timezone !== expectedTimezone,
    locale: identity.locale !== expectedLocale,
    gps: expectedGps && identity.gps
      ? Math.abs(identity.gps.lat - expectedGps.lat) > 0.1 || Math.abs(identity.gps.lng - expectedGps.lng) > 0.1
      : false,
  }
}
```

### 4.7 Static lookup tables

**`packages/core/src/identity/lookups.ts`:**

```ts
// Country → default timezone (for countries with multiple timezones, pick the most populous)
const COUNTRY_TIMEZONE: Record<string, string> = {
  US: 'America/New_York',
  JP: 'Asia/Tokyo',
  ID: 'Asia/Jakarta',
  GB: 'Europe/London',
  // ... extend as needed
}

// Country → default locale
const COUNTRY_LOCALE: Record<string, string> = {
  US: 'en_US',
  JP: 'ja_JP',
  ID: 'id_ID',
  GB: 'en_GB',
  // ... extend as needed
}

// City → GPS coordinates (top 100 cities, or call a geocoding API)
const CITY_GPS: Record<string, { lat: number; lng: number }> = {
  'New York': { lat: 40.7128, lng: -74.0060 },
  'Tokyo': { lat: 35.6762, lng: 139.6503 },
  'Jakarta': { lat: -6.2088, lng: 106.8456 },
  // ... extend as needed, or use a geocoding API
}

export function countryToTimezone(country: string): string | undefined {
  return COUNTRY_TIMEZONE[country.toUpperCase()]
}

export function countryToLocale(country: string): string | undefined {
  return COUNTRY_LOCALE[country.toUpperCase()]
}

export function cityToGps(city: string): { lat: number; lng: number } | undefined {
  return CITY_GPS[city]
}
```

For production, replace `CITY_GPS` with a geocoding API call (e.g., OpenStreetMap Nominatim, or a self-hosted GeoNames database).

---

## 5. Implementation steps

**5.1 Protocol.** Add `DeviceIdentitySchema` to `packages/protocol/src/settings.ts`, extend `DeviceSettingsSchema`. → `bun run typecheck` clean.

**5.2 The read seam.** Extend `DeviceSnapshot` and `createDbDeviceSource` to project `identity` from `devices.settings`. → a unit test asserts the snapshot carries identity settings.

**5.3 Core API.** `packages/core/src/api/device-identity.ts` with GET/PUT/DELETE/POST endpoints, `device.settings` permission gating. → integration tests cover apply/clear/sync.

**5.4 Guest agent: mock location provider.** `MockLocationService.kt`, control channel methods `location.set`/`location.clear`, `Protocol.kt` constants. → build the APK, install on a device, verify `LocationManager.getLastKnownLocation()` returns the spoofed location.

**5.5 Host-side driver.** `packages/drivers/src/identity/mock-location.ts`, extend `GuestAgentClient` with `locationSet()`/`locationClear()` methods. → integration test drives set/clear against a real device.

**5.6 Static lookup tables.** `packages/core/src/identity/lookups.ts` with country→timezone, country→locale, city→GPS mappings. → unit tests cover lookups.

**5.7 Studio UI.** `packages/studio/src/components/identity/IdentityPanel.tsx` with timezone/locale/GPS inputs, apply/clear buttons, sync button, drift warning. → manual verification on a real device.

**5.8 Drift detection.** `computeIdentityDrift()` logic, integrate with Network tab's geo observation display. → unit tests cover drift computation.

**5.9 Docs.** `docs/guide/identity.md` explaining the feature, the "sync with proxy" workflow, and the limitations (mock location requires the guest agent, timezone/locale require `setprop`).

---

## 6. Acceptance criteria

1. A device with no identity settings behaves identically to before this plan.
2. Setting a timezone from Studio applies it to the device (`adb shell getprop persist.sys.timezone` confirms).
3. Setting a locale from Studio applies it to the device (`adb shell getprop persist.sys.locale` confirms).
4. Setting a GPS location from Studio makes `LocationManager.getLastKnownLocation()` return the spoofed coordinates (verified via a test app or `dumpsys location`).
5. The "sync with proxy" button pre-fills timezone/locale/GPS from the most recent geo observation.
6. Applying identity settings persists them to `devices.settings` and survives a device reboot.
7. Clearing identity settings reverts timezone/locale to defaults and disables mock location.
8. When the proxy's geo observation drifts away from the device's identity settings, a warning appears on the Identity tab with a "sync" button.
9. No root access is required for any operation.
10. `bun run typecheck` clean, `bun test` green.

---

## 7. Test plan

**Unit** — `DeviceIdentitySchema` validation (lat/lng bounds, timezone format); `computeIdentityDrift()` across every mismatch combination; static lookup tables; `setprop` command construction.

**Integration (no device)** — API permission gating (`device.settings` required); apply/clear/sync endpoint logic; identity persistence to `devices.settings`.

**Device (`ENKAKU_TEST_DEVICE=1`)** — apply timezone and verify via `getprop`; apply locale and verify via `getprop`; apply GPS and verify via `dumpsys location` or a test app; reboot and verify settings persist; clear and verify defaults restored.

---

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| `setprop persist.sys.timezone` does not survive reboot on some Android versions | Test on Android 10/11/12/13/14/15; fall back to `Settings.Global.TIME_ZONE` if needed |
| Mock location provider is detected by Instagram/TikTok | Some apps check `Location.isFromMockProvider()` — the guest agent's provider name (`enkaku-mock`) is not on known mock provider lists, but this is a cat-and-mouse game. Mitigation: document the limitation, recommend using proxies with geo-aligned IPs as the primary defense |
| Geocoding API (for city→GPS) is unavailable or rate-limited | Use a static lookup table for top 100 cities; for production, self-host a GeoNames database or use a paid geocoding API |
| Identity drift warning becomes noise (residential pools drift within a region) | Only warn on country mismatch, not city/region (mirrors Plan 55's "match at the narrowest level declared" pattern) |
| Scope creep toward fleet-wide identity templates | Per-device only for now; fleet bulk assignment is a separate plan if needed |

---

## 9. Open questions

1. **Should identity settings be lease-scoped or device-scoped?** Current assumption: device-scoped (like Plan 52's device-scoped routes). A lease release does NOT clear identity settings. Revisit if operators want identity to follow leases.
2. **Should the guest agent's mock location provider be a separate APK or integrated into the existing guest agent?** Current assumption: integrated (one less APK to manage). But if the guest agent is ever published to Google Play (Plan 43 §0), mock location provider might trigger Play review. Revisit if §0's scope changes.
3. **Should timezone/locale be applied via `setprop` or via a Settings app intent?** `setprop` is simpler and works from adb shell, but some vendor ROMs might ignore it. Test on Samsung/Xiaomi/Huawei devices.
4. **Should GPS mock location be continuously updated (e.g., simulate movement) or static?** Current assumption: static (one lat/lng). Continuous movement simulation is a different feature (and more likely to be detected as spoofing).

---

## 10. Spec alignment

This plan does NOT add a driver layer (spec §7 lists five: transport, display, input, inspector, network). Identity spoofing is a device-settings extension, not a driver. It lives in `devices.settings` alongside `timing` and `prep`, with its own API endpoints and Studio UI, but no registry entry or capability negotiation.

Spec §17 (positioning) states the boundary: "detect and report; the operator decides." This plan follows that boundary — it detects identity drift and warns, but does not automatically rotate identity settings.
