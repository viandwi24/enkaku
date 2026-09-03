import type { Transport } from '@enkaku/protocol'
import type { Logger } from './logger'

/**
 * The system property a session writes to disclose that a device is part of
 * an Enkaku farm (spec §9.4/§17; plan 87 §4.12, §5 step 87.13).
 *
 * `debug.` is not decoration — it is close to the ONLY property namespace a
 * non-root `adb shell` can write to on a stock, unrooted Android device.
 * System properties are gated by SELinux: `property_contexts` maps every
 * property name (by prefix) onto a context, and `setprop` is checked against
 * THAT context, not the literal string. `debug.` is the one open-ended
 * prefix mapped to `debug_prop`, and `shell.te` grants the shell domain
 * `set_prop` on `debug_prop` — this is the mechanism behind long-documented,
 * works-without-root-on-every-version tricks developers already rely on,
 * e.g. `adb shell setprop debug.hwui.profile true` (Android's own GPU
 * Rendering Profile guide) or `debug.layout true` (show layout bounds). An
 * invented, unlisted prefix has no `property_contexts` entry of its own, so
 * it falls back to `default_prop` — and shell has no `set_prop` permission
 * there. `adb shell setprop enkaku.farm.instrumented 1` fails with
 * "Permission denied" (an `avc: denied` in logcat) on a stock, unrooted
 * device precisely because it is not under `debug.`.
 *
 * `persist.sys.timezone` / `persist.sys.locale`
 * (`packages/core/src/api/device-identity.ts`) are not a counterexample:
 * those two specific names are individually whitelisted in AOSP's
 * `property_contexts` (kept shell-writable so CTS can exercise them without
 * root) — a name-by-name allowlist, not a prefix wildcard. It does not
 * extend to a name Enkaku just invented; only `debug.` does that.
 *
 * No physical device was reachable in the environment this module was
 * written in (no `adb` binary, no attached hardware) — the above is
 * Android's documented SELinux property model plus a `debug.*` behavior
 * developers already exercise daily without root, not a claim of having run
 * this exact command on hardware. Verify it yourself on a real device with:
 *
 *   adb shell setprop debug.enkaku.instrumented 1
 *   adb shell getprop debug.enkaku.instrumented   # -> 1
 */
const FARM_TAG_PROPERTY = 'debug.enkaku.instrumented'

/**
 * Device-under-automation marker. Mirrors `applyRotation`'s shape
 * (`./orientation.ts`) exactly: apply at session start, hand back an
 * idempotent revert thunk for `close()` to call.
 *
 * This marks the DEVICE, not any network traffic: it never touches a
 * packet, a proxy, or a header — it only sets one system property that says
 * "this device currently has an active Enkaku session on it." An app under
 * test can read that for itself (Android's `SystemProperties.get`, reflected
 * into from app code, or — for a human verifying it from outside — `adb
 * shell getprop debug.enkaku.instrumented`). That is the entire mechanism:
 * a disclosure a device makes about itself, nothing more.
 *
 * `tagTraffic: false` means the operator turned off that disclosure, not
 * gained a capability. Nothing else about how the session behaves changes,
 * and the property is simply never written — the returned revert is a
 * no-op, same as `applyRotation`'s `'device'` case.
 *
 * Unlike rotation, there is no legitimate "prior device value" to read and
 * restore here: this property is Enkaku's own invention, and nothing else
 * has a real reason to have set `debug.enkaku.instrumented` before this
 * session touched it. Revert therefore always clears to the same empty
 * string, regardless of how many times it is called — that is what makes it
 * idempotent, the same requirement CLAUDE.md states for a script's
 * `finish()` (a timeout kill followed by a fresh-process rerun must be safe).
 *
 * A `setprop` failure while APPLYING (denied permission, an OEM ROM that
 * blocks it, a dead adb link) is logged at `warn`, not the `debug` level
 * `wake`/`orientation` use for cosmetic device-settings drift — because the
 * entire value of this mechanism is that it can be trusted: a session that
 * could not mark the device is recorded as unmarked (the revert thunk
 * becomes a no-op, and nothing downstream is ever told the device is
 * tagged), never silently treated as tagged when it is not.
 */
export async function applyFarmTag(
  transport: Transport,
  opts: { tagTraffic: boolean; log: Logger },
): Promise<() => Promise<void>> {
  const { tagTraffic, log } = opts
  if (!tagTraffic) return async () => {}

  let tagged = false
  await transport
    .exec(`setprop ${FARM_TAG_PROPERTY} 1`, { profile: 'probe' })
    .then(() => {
      tagged = true
    })
    .catch((err) => {
      log.warn(
        `farm tag could not be set (${String(err)}) — this device is UNMARKED for this session; an app checking ${FARM_TAG_PROPERTY} will not see it, and the disclosure DeviceSettings.instrumentation.tagTraffic promises is not actually present on this device right now`,
      )
    })
  if (!tagged) return async () => {}

  return async () => {
    await transport
      .exec(`setprop ${FARM_TAG_PROPERTY} ''`, { profile: 'probe' })
      .catch((err) => log.debug(`farm tag clear failed: ${String(err)}`))
  }
}
