# Device identity (timezone, locale, GPS)

A route that exits through a residential proxy in New York can still leak the device underneath it: GPS from real location services, timezone and locale still set to wherever the phone actually is. An app doing fraud detection reads all three the same way a human reviewer would — if the IP says New York but the GPS says Jakarta, the account gets flagged regardless of how good the proxy is. The Identity tab on a device page (`/device?id=...&tab=identity`) exists to align those signals with the route's observed exit.

## What it does

- **Timezone** (IANA, e.g. `America/New_York`) and **locale** (BCP 47, e.g. `en-US`) — applied with `adb shell setprop persist.sys.timezone`/`persist.sys.locale`. This works on any reachable device, no extra software required, and takes effect immediately.
- **GPS location** — installed as a mock location provider through the guest agent (`apps/guest-agent`). Apps that read `LocationManager.getLastKnownLocation()` see the fix you set instead of the device's real location.
- **Sync from proxy** — pre-fills the three fields from the most recent exit the network route's `geo` check observed (Plan 55), using a small built-in country → timezone/locale and city → coordinates table. This only fills the form; nothing is applied until you press Apply.
- **Drift warning** — if the route's exit later moves to a different country and the applied identity no longer matches, the tab shows a warning with a one-click "fill in from proxy" action. Nothing is re-applied automatically — you still confirm.

Every field is independent and optional. Setting only a timezone leaves locale and GPS untouched; clearing identity reverts timezone and locale to the device's own default and removes the mock GPS provider.

## GPS requires the guest agent — and an honest "no"

Timezone and locale never depend on the guest agent. GPS does, because Android has no adb-only way to fake `LocationManager`'s answer — it requires an app registered as a mock location provider.

The guest agent advertises what it can do through a `capabilities` list the host checks before ever attempting to apply a fix (the same pattern used for the network layer's `egress-probe` and `route-hold`). A build that does not include `mock-location` — an older install, or a device that has never had the guest agent installed at all — means GPS **cannot** be applied. The Identity tab says exactly that:

> GPS was not applied: this device's guest agent cannot set a mock location — its installed build does not advertise the mock-location capability.

This is deliberate. The alternative — reporting success anyway, or silently dropping the request — would let a device's Studio page claim a location the phone was never actually told to report, which is worse than no spoofing at all: an operator would trust a signal the app under test never received. Timezone and locale still apply in the same request even when GPS cannot.

## Applying GPS, once the guest agent supports it

1. Install the guest agent for the device (Network tab → Install), on a build that reports the `mock-location` capability.
2. Grant the mock-location app-op once: this happens automatically on Apply (`adb shell appops set dev.enkaku.guestagent android:mock_location allow`) — you do not need to run it by hand.
3. Set latitude/longitude (and optionally accuracy, in metres) on the Identity tab and press Apply.
4. Verify with `adb shell dumpsys location`, or any app that reads `LocationManager.getLastKnownLocation()`.

Clearing identity removes the mock provider and revokes the app-op.

## Limitations

- **IMEI, device model, and MAC address are not spoofed.** All three require root or a custom ROM and are out of scope — see the plan's non-goals.
- **A mock location provider is, in principle, detectable.** Some apps call `Location.isFromMockProvider()`. This is a cat-and-mouse concern the way any spoofing technique is; pairing GPS with a geographically matching proxy (the whole point of "sync from proxy") is the primary defense, not a guarantee against detection.
- **Identity is device-scoped, not lease-scoped.** It persists across lease release, job runs, and reboots, exactly like the Timing and Prep settings — releasing a lease does not clear it.
