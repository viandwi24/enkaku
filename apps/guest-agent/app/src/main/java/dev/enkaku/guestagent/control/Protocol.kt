package dev.enkaku.guestagent.control

/**
 * The wire contract between the farm host and this app.
 *
 * The host side of this lives in `packages/protocol/src/guest-agent.ts` (Zod). Both sides must be
 * changed together, and [PROTOCOL_VERSION] bumped, whenever a message shape changes — the host
 * refuses to talk to a mismatched major rather than degrading silently.
 */
object Protocol {
  /**
   * The abstract-namespace socket name the host reaches with `adb forward localabstract:<name>`.
   *
   * Abstract rather than a TCP port on purpose: no INTERNET permission, no device-side port
   * collision between phones, unreachable from any network interface, and nothing to clean up on
   * disk. See docs/research/android-guest-agent.md §4.
   */
  const val SOCKET_NAME = "enkaku-guest-agent"

  const val PROTOCOL_VERSION = 1

  /**
   * What this build can actually do. The host is expected to gate on this rather than assume, the
   * same way the driver registry advertises engine capabilities instead of guessing them.
   *
   * `egress-probe` (plan 51 §5.4): added now that [dev.enkaku.guestagent.route.EgressProbe]
   * actually runs — never claim a capability before it works, or the whole point of this list
   * (the host gates on it rather than assuming) is defeated. Advertised by every build since plan
   * 51 shipped; the host-side mirror of this file used to carry a comment claiming otherwise —
   * fixed in plan 90 §0.1 (F41), because this file is the one that was always right.
   *
   * `route-hold` (plan 55 §3.5, §4.1, §5.6): added now that [METHOD_ROUTE_HOLD] is handled below.
   *
   * `mock-location` (plan 58 §4.4, §5.4): added now that [METHOD_LOCATION_SET]/
   * [METHOD_LOCATION_CLEAR] are handled below and back by
   * [dev.enkaku.guestagent.identity.MockLocation]. An installed build that predates this still
   * answers `E_UNKNOWN_METHOD` for both, which the host treats as "identity GPS cannot be
   * applied" — never a spoofed value the device never actually received.
   *
   * `screen-label` (plan 89 §4.5; plan 90 §3.6, §4.1, step 90.5's Task B): gates
   * [METHOD_LABEL_APPLY] / [METHOD_LABEL_STATUS] / [METHOD_LABEL_CLEAR], backed by
   * `label/LabelRenderer.kt` and `label/WallpaperFacet.kt`, dispatched from
   * `ControlService.handle()`. Plan 90's own §5 step list never assigned this facet to a numbered
   * step — plan 89 §4.5 stated the contract, plan 90 §3.6 promised to honour it, and neither
   * plan's checklist actually built it until step 90.5 closed the gap alongside its own IME work
   * (the one worker touching `ControlService.kt` at the time).
   *
   * `text-input` (plan 90 §3.2, §3.3, §4.1, step 90.5): gates [METHOD_TEXT_COMMIT] /
   * [METHOD_TEXT_STATUS], backed by `input/EnkakuIme.kt` / `input/TextFacet.kt` and the matching
   * `ControlService.handle()` branches.
   *
   * `ui-tree` (plan 221 §4.2, MVP 02 §4 phase 2, MVP 10 §1.1): gates [METHOD_UI_DUMP] /
   * [METHOD_UI_FIND] / [METHOD_UI_WATCH] / [METHOD_UI_UNWATCH] / [METHOD_UI_STATUS], backed by
   * `ui/UiTreeService.kt`. Advertised by every build that CONTAINS the service, whether or not the
   * service is currently enabled in Settings: the capability says what the build can do, and
   * `ui.status` says whether it can do it right now. Conflating the two would make an unenabled
   * service look like an old APK, which is a different repair.
   *
   * `activity` (plan 221 §4.5, MVP 10 §1.3): gates [METHOD_ACTIVITY_SET] and
   * [METHOD_DEVICE_DESCRIBE]. Read-only on the device: nothing here acts on the list, it only
   * lets the phone's own screen say what the farm is doing to it.
   */
  val CAPABILITIES: List<String> =
    listOf(
      "socks5-route", "vpn-status", "egress-probe", "route-hold", "mock-location",
      "screen-label", "text-input", "ui-tree", "activity",
    )

  // Requests
  const val METHOD_HELLO = "hello"
  const val METHOD_PING = "ping"
  const val METHOD_ROUTE_START = "route.start"
  const val METHOD_ROUTE_STOP = "route.stop"
  const val METHOD_ROUTE_STATUS = "route.status"
  const val METHOD_EGRESS_PROBE = "egress.probe"
  const val METHOD_ROUTE_HOLD = "route.hold"
  const val METHOD_LOCATION_SET = "location.set"
  const val METHOD_LOCATION_CLEAR = "location.clear"

  /**
   * Plan 89 §4.5; plan 90 §3.6, §4.1. Method-name constants only — `ControlService.handle()`
   * gaining the matching `when` branches, and the facets that back them, is a later step. Kept
   * here (not invented ad hoc there) because the method name is part of the wire contract both
   * sides read, same as every other `METHOD_*` constant in this object.
   */
  const val METHOD_LABEL_APPLY = "label.apply"
  const val METHOD_LABEL_STATUS = "label.status"
  const val METHOD_LABEL_CLEAR = "label.clear"

  /** Plan 90 §3.2, §3.3, §4.1. Same note as the `METHOD_LABEL_*` constants above. */
  const val METHOD_TEXT_COMMIT = "text.commit"
  const val METHOD_TEXT_STATUS = "text.status"

  /** Plan 221 §4.2. */
  const val METHOD_UI_DUMP = "ui.dump"
  const val METHOD_UI_FIND = "ui.find"
  const val METHOD_UI_WATCH = "ui.watch"
  const val METHOD_UI_UNWATCH = "ui.unwatch"
  const val METHOD_UI_STATUS = "ui.status"

  /** Plan 221 §4.5. */
  const val METHOD_ACTIVITY_SET = "activity.set"
  const val METHOD_DEVICE_DESCRIBE = "device.describe"

  /** Plan 221 §4.6. */
  const val METHOD_TEXT_PREFS = "text.prefs"

  /** The event frame's own `event` value — never a `method`, so a reader can tell a push from a reply. */
  const val EVENT_UI_CHANGED = "ui.changed"

  // Error codes. Mirrored on the host so failures are matched on a code, never on message text.
  const val ERR_UNAUTHORISED = "E_UNAUTHORISED"
  const val ERR_BAD_REQUEST = "E_BAD_REQUEST"
  const val ERR_UNKNOWN_METHOD = "E_UNKNOWN_METHOD"
  const val ERR_NOT_PAIRED = "E_NOT_PAIRED"
  const val ERR_NOT_PREPARED = "E_NOT_PREPARED"

  /** Plan 221 §4.2: the service is in the build but is not enabled in Settings, or is enabled and not yet connected. */
  const val ERR_UI_TREE_UNAVAILABLE = "E_UI_TREE_UNAVAILABLE"
}
