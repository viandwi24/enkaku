'use client'

import { useEffect, useRef, useState } from 'react'
import { ConfirmDialog, Button, Input, Label, ErrorState, LoadingRows, useAction } from '@enkaku/ui'
import {
  applyDeviceIdentity,
  clearDeviceIdentity,
  fetchDeviceIdentity,
  syncDeviceIdentity,
  type DeviceIdentity,
  type IdentityApplyResult,
  type IdentitySyncSuggestion,
} from '@/lib/api'
import { computeIdentityDrift, hasIdentityDrift } from '@/lib/identityDrift'

/**
 * The device page's Identity tab (plan 58 §4.6, §5.7) — timezone, locale, and a mock GPS fix,
 * aligned with the network route's observed exit so every signal an app under test can see agrees
 * on one identity (plan 58 §0's SOAX-in-New-York-but-GPS-in-Jakarta scenario).
 *
 * Timezone and locale always work when the device is reachable — plain `adb shell setprop`, no
 * guest agent involved. GPS depends on the guest agent's build advertising `mock-location`
 * (plan 58 §5.4): an older or missing build means GPS cannot be applied, and this panel says so
 * inline rather than pretending the fix landed on the device.
 */
export function IdentityPanel({
  deviceId,
  canUse,
}: {
  deviceId: string
  /** Same server-authoritative gate every other mutating control on this page uses — the server checks the held lease itself on every request regardless. */
  canUse: boolean
}) {
  const [identity, setIdentity] = useState<DeviceIdentity | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [lastResult, setLastResult] = useState<IdentityApplyResult | null>(null)
  const [suggestion, setSuggestion] = useState<IdentitySyncSuggestion | null>(null)
  const { run, isPending } = useAction()

  const [timezone, setTimezone] = useState('')
  const [locale, setLocale] = useState('')
  const [lat, setLat] = useState('')
  const [lng, setLng] = useState('')
  const [accuracy, setAccuracy] = useState('')

  // Seeded from the server exactly once — re-seeding on every reload would stomp on an
  // in-progress edit the moment a background sync-suggestion fetch resolves (same pattern
  // `NetworkRouteForm`'s `seeded` ref uses).
  const seeded = useRef(false)

  const load = () => {
    setLoadError(null)
    fetchDeviceIdentity(deviceId)
      .then(setIdentity)
      .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)))
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [deviceId])

  useEffect(() => {
    if (identity && !seeded.current) {
      seeded.current = true
      setTimezone(identity.timezone ?? '')
      setLocale(identity.locale ?? '')
      setLat(identity.gps ? String(identity.gps.lat) : '')
      setLng(identity.gps ? String(identity.gps.lng) : '')
      setAccuracy(identity.gps?.accuracy !== undefined ? String(identity.gps.accuracy) : '')
    }
  }, [identity])

  // A quiet background check for the drift banner — never shown as a loading state, and a 409
  // "no geo observation yet" is completely normal (most devices have never run a geo-checked
  // route) so it is swallowed here rather than surfaced as an error.
  useEffect(() => {
    syncDeviceIdentity(deviceId)
      .then(setSuggestion)
      .catch(() => setSuggestion(null))
  }, [deviceId])

  const latNum = lat.trim() ? Number(lat.trim()) : undefined
  const lngNum = lng.trim() ? Number(lng.trim()) : undefined
  const accuracyNum = accuracy.trim() ? Number(accuracy.trim()) : undefined
  const gpsFieldsFilled = lat.trim().length > 0 || lng.trim().length > 0
  const gpsValid =
    !gpsFieldsFilled ||
    (latNum !== undefined && lngNum !== undefined && latNum >= -90 && latNum <= 90 && lngNum >= -180 && lngNum <= 180)

  const nextIdentity: DeviceIdentity = {
    ...(timezone.trim() ? { timezone: timezone.trim() } : {}),
    ...(locale.trim() ? { locale: locale.trim() } : {}),
    ...(gpsFieldsFilled && latNum !== undefined && lngNum !== undefined
      ? { gps: { lat: latNum, lng: lngNum, ...(accuracyNum !== undefined ? { accuracy: accuracyNum } : {}) } }
      : {}),
  }

  const apply = () =>
    run('apply', () => applyDeviceIdentity(deviceId, nextIdentity), {
      success: 'Identity applied',
      failure: 'Could not apply identity',
      onSuccess: ({ identity: applied, result }) => {
        setIdentity(applied)
        setLastResult(result)
      },
    })

  const clear = () =>
    run('clear', () => clearDeviceIdentity(deviceId), {
      success: 'Identity cleared — timezone and locale reverted, mock location removed',
      failure: 'Could not clear identity',
      onSuccess: () => {
        setIdentity({})
        setLastResult(null)
        setTimezone('')
        setLocale('')
        setLat('')
        setLng('')
        setAccuracy('')
      },
    })

  const sync = () =>
    run('sync', () => syncDeviceIdentity(deviceId), {
      failure: 'Could not suggest identity from the proxy',
      onSuccess: (s) => {
        setSuggestion(s)
        if (s.suggestion.timezone) setTimezone(s.suggestion.timezone)
        if (s.suggestion.locale) setLocale(s.suggestion.locale)
        if (s.suggestion.gps) {
          setLat(String(s.suggestion.gps.lat))
          setLng(String(s.suggestion.gps.lng))
          setAccuracy(s.suggestion.gps.accuracy !== undefined ? String(s.suggestion.gps.accuracy) : '')
        }
      },
    })

  const drift = computeIdentityDrift(identity ?? {}, suggestion?.suggestion ?? null)
  const showDrift = hasIdentityDrift(drift)
  const disabled = !canUse

  if (loadError) return <ErrorState message={loadError} onRetry={load} />
  if (identity === null) return <LoadingRows rows={2} />

  return (
    /*
     * `@container`, not `sm:` — this panel is hosted at two widths that have
     * nothing to do with the browser window: the device page (wide) and the
     * device popup's Settings → Identity section (~400px today). `px-5` is the
     * device page's own tab padding, which the popup's section pane already
     * supplies. The container element is separate from the padded one because a
     * size container's own padding feeds back into the width its queries read.
     */
    <div className="@container">
      <div className="py-4 @min-[32rem]:px-5">
        {disabled && (
          <p className="mb-4 rounded-lg border bg-surface px-3.5 py-2.5 text-[12.5px] text-fg-muted">
            Take control of this device to change its timezone, locale, or GPS location.
          </p>
        )}

        <div className="max-w-2xl space-y-4">
          {showDrift && (
            <section className="rounded-lg border border-led-warn/35 bg-led-warn/10 p-4">
              <h3 className="text-[13px] font-semibold text-led-warn">Identity does not match the proxy&apos;s exit</h3>
              <p className="mt-1 text-[12px] leading-relaxed text-fg-muted">
                {[
                  drift.timezone && 'timezone',
                  drift.locale && 'locale',
                  drift.gps && 'GPS location',
                ]
                  .filter(Boolean)
                  .join(', ')}{' '}
                {drift.timezone || drift.locale || drift.gps ? (drift.timezone && drift.locale && drift.gps ? 'do' : 'does') : ''} not match{' '}
                {suggestion?.city && suggestion?.country ? `the exit in ${suggestion.city}, ${suggestion.country}` : 'the proxy\'s observed exit'}.
                An app under test can see the same contradiction a fraud check does.
              </p>
              <Button
                size="sm"
                variant="outline"
                className="mt-3"
                disabled={disabled || isPending('sync')}
                onClick={() => void sync()}
              >
                {isPending('sync') ? 'Filling in…' : 'Fill in from proxy'}
              </Button>
            </section>
          )}

          <section className="@container rounded-lg border bg-surface p-4">
            {/* `flex-wrap`: a heading and a button on one row is a promise the
                row cannot keep at ~340px, and the button is not shrinkable. */}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-[13.5px] font-semibold tracking-tight">Timezone &amp; locale</h3>
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled || isPending('sync')}
                onClick={() => void sync()}
              >
                {isPending('sync') ? 'Checking proxy…' : 'Fill in from proxy'}
              </Button>
            </div>
            <p className="mt-1 text-[12px] leading-relaxed text-fg-muted">
              Applied with <code className="rounded bg-bg px-1 py-0.5 text-[11px]">adb shell setprop</code> — works on any
              reachable device, no guest agent required.
            </p>
            {/* Two text fields side by side need ~11.5rem each: 2 × 11.5 +
                0.75rem gap ≈ 24rem of the CARD's own width. */}
            <div className="mt-3 grid gap-3 @min-[24rem]:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor={`identity-timezone-${deviceId}`} className="text-[12px] font-normal">
                  Timezone (IANA)
                </Label>
                <Input
                  id={`identity-timezone-${deviceId}`}
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                  placeholder="America/New_York"
                  disabled={disabled}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`identity-locale-${deviceId}`} className="text-[12px] font-normal">
                  Locale (BCP 47)
                </Label>
                <Input
                  id={`identity-locale-${deviceId}`}
                  value={locale}
                  onChange={(e) => setLocale(e.target.value)}
                  placeholder="en-US"
                  disabled={disabled}
                />
              </div>
            </div>
          </section>

          <section className="@container rounded-lg border bg-surface p-4">
            <h3 className="text-[13.5px] font-semibold tracking-tight">GPS location</h3>
            <p className="mt-1 text-[12px] leading-relaxed text-fg-muted">
              Installed as a mock location provider through the guest agent. Requires an installed
              agent build that advertises the <code className="rounded bg-bg px-1 py-0.5 text-[11px]">mock-location</code>{' '}
              capability — an older build cannot carry this out, and applying will say so rather than
              claim success.
            </p>

            {/* Three number fields want ~11rem each: 3 × 11 + 2 × 0.75rem gap =
                34.5rem, so three columns wait for 35rem. Between 24 and 35rem
                two columns (latitude beside longitude, accuracy below) is
                genuinely better than three crushed ones. */}
            <div className="mt-3 grid gap-3 @min-[24rem]:grid-cols-2 @min-[35rem]:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor={`identity-lat-${deviceId}`} className="text-[12px] font-normal">
                  Latitude
                </Label>
                <Input
                  id={`identity-lat-${deviceId}`}
                  inputMode="decimal"
                  value={lat}
                  onChange={(e) => setLat(e.target.value)}
                  placeholder="40.7128"
                  disabled={disabled}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`identity-lng-${deviceId}`} className="text-[12px] font-normal">
                  Longitude
                </Label>
                <Input
                  id={`identity-lng-${deviceId}`}
                  inputMode="decimal"
                  value={lng}
                  onChange={(e) => setLng(e.target.value)}
                  placeholder="-74.0060"
                  disabled={disabled}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`identity-accuracy-${deviceId}`} className="text-[12px] font-normal">
                  Accuracy (m)
                </Label>
                <Input
                  id={`identity-accuracy-${deviceId}`}
                  inputMode="decimal"
                  value={accuracy}
                  onChange={(e) => setAccuracy(e.target.value)}
                  placeholder="100"
                  disabled={disabled}
                />
              </div>
            </div>
            {!gpsValid && <p className="mt-2 text-[11.5px] text-led-danger">Latitude must be -90..90 and longitude -180..180.</p>}

            {lastResult?.gps === 'unavailable' && (
              <p className="mt-3 rounded-md border border-led-warn/35 bg-led-warn/10 px-3 py-2 text-[12px] text-led-warn">
                GPS was not applied: {lastResult.gpsDetail ?? "this device's guest agent cannot set a mock location"}.
                Timezone and locale above were still applied.
              </p>
            )}
            {lastResult?.gps === 'applied' && (
              <p className="mt-3 text-[11.5px] text-led-ok">Mock location installed on the device.</p>
            )}
          </section>

          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={disabled || !gpsValid || isPending('apply')} onClick={() => void apply()}>
              {isPending('apply') ? 'Applying…' : 'Apply'}
            </Button>
            <ConfirmDialog
              trigger={
                <Button size="sm" variant="ghost" disabled={disabled}>
                  Clear identity
                </Button>
              }
              title="Clear this device's identity?"
              description="Timezone and locale revert to the device's own default, and the mock GPS location is removed. The device's real location services take over again."
              confirmLabel="Clear"
              onConfirm={clear}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
