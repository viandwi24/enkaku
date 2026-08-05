package dev.enkaku.guestagent.identity

import android.content.Context
import android.location.Criteria
import android.location.LocationManager
import android.location.Location
import android.location.provider.ProviderProperties
import android.os.Build
import android.os.SystemClock

/**
 * Plan 58 §4.4 — installs a mock GPS fix via Android's test-provider API. No root, stock Android:
 * the host grants the `android:mock_location` app-op before ever calling [set]
 * (`adb shell appops set <pkg> android:mock_location allow`, `ControlService.MOCK_LOCATION_OP` in
 * the launcher's provisioning step) — [set] itself only ever reports whether that grant already
 * happened, it never requests it.
 *
 * A stateless singleton called directly from
 * [dev.enkaku.guestagent.control.ControlService] with its own `Context` — mirrors
 * [dev.enkaku.guestagent.route.Ipv6Leak]'s shape rather than the plan sketch's `Service`: there is
 * no lifecycle to own here (no foreground notification, nothing that outlives one call), only two
 * synchronous `LocationManager` calls, exactly like `Ipv6Leak.isBlocked`'s one-shot read.
 */
object MockLocation {
  /** Never `enkaku-guest-agent`'s own package name or any real provider name — a distinct id keeps a caller from ever confusing this with `gps`/`network`. */
  private const val PROVIDER_NAME = "enkaku-mock"

  /**
   * Installs (or moves) the mock fix. Idempotent — safe to call again with a new fix without an
   * intervening [clear]; [ensureProvider] only adds the test provider the first time.
   *
   * Throws [SecurityException] when this app is not currently the device's selected mock-location
   * app (the host has not granted the `android:mock_location` app-op yet, or an operator changed
   * it in Developer Options) — the caller (`ControlService`) maps that to `E_NOT_PREPARED`, the
   * same code `RouteVpnService`'s missing-VPN-consent path uses, since both mean "an operator
   * precondition is missing, not a request-shaped failure".
   */
  fun set(context: Context, lat: Double, lng: Double, accuracy: Float) {
    val lm = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
    ensureProvider(lm)
    lm.setTestProviderLocation(
      PROVIDER_NAME,
      Location(PROVIDER_NAME).apply {
        latitude = lat
        longitude = lng
        this.accuracy = accuracy
        time = System.currentTimeMillis()
        elapsedRealtimeNanos = SystemClock.elapsedRealtimeNanos()
      },
    )
  }

  /**
   * Removes the mock provider, restoring the device's real location. Tolerates "was never
   * installed" (a bare `location.clear` with no prior `location.set` this process lifetime) —
   * `removeTestProvider` on an absent provider throws, and a clear that was already the state
   * being asked for is not a failure.
   */
  fun clear(context: Context) {
    val lm = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
    runCatching { lm.removeTestProvider(PROVIDER_NAME) }
  }

  private fun ensureProvider(lm: LocationManager) {
    if (lm.allProviders.contains(PROVIDER_NAME)) return
    if (Build.VERSION.SDK_INT >= 31) {
      lm.addTestProvider(
        PROVIDER_NAME,
        ProviderProperties.Builder()
          .setHasNetworkRequirement(false)
          .setHasSatelliteRequirement(false)
          .setHasCellRequirement(false)
          .setHasMonetaryCost(false)
          .setHasAltitudeSupport(true)
          .setHasSpeedSupport(true)
          .setHasBearingSupport(true)
          .setPowerUsage(ProviderProperties.POWER_USAGE_LOW)
          .setAccuracy(ProviderProperties.ACCURACY_FINE)
          .build(),
      )
    } else {
      // `addTestProvider(String, Boolean...)` is deprecated in favour of the `ProviderProperties`
      // overload above, but that overload does not exist below API 31 — minSdk here is 29
      // (ControlService's own doc comment), so this path is still live.
      @Suppress("DEPRECATION")
      lm.addTestProvider(
        PROVIDER_NAME,
        /* requiresNetwork = */ false,
        /* requiresSatellite = */ false,
        /* requiresCell = */ false,
        /* hasMonetaryCost = */ false,
        /* supportsAltitude = */ true,
        /* supportsSpeed = */ true,
        /* supportsBearing = */ true,
        Criteria.POWER_LOW,
        Criteria.ACCURACY_FINE,
      )
    }
    lm.setTestProviderEnabled(PROVIDER_NAME, true)
  }
}
