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
   * (the host gates on it rather than assuming) is defeated.
   *
   * `route-hold` (plan 55 §3.5, §4.1, §5.6): added now that [METHOD_ROUTE_HOLD] is handled below.
   *
   * `mock-location` (plan 58 §4.4, §5.4): added now that [METHOD_LOCATION_SET]/
   * [METHOD_LOCATION_CLEAR] are handled below and back by
   * [dev.enkaku.guestagent.identity.MockLocation]. An installed build that predates this still
   * answers `E_UNKNOWN_METHOD` for both, which the host treats as "identity GPS cannot be
   * applied" — never a spoofed value the device never actually received.
   */
  val CAPABILITIES: List<String> =
    listOf("socks5-route", "vpn-status", "egress-probe", "route-hold", "mock-location")

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

  // Error codes. Mirrored on the host so failures are matched on a code, never on message text.
  const val ERR_UNAUTHORISED = "E_UNAUTHORISED"
  const val ERR_BAD_REQUEST = "E_BAD_REQUEST"
  const val ERR_UNKNOWN_METHOD = "E_UNKNOWN_METHOD"
  const val ERR_NOT_PAIRED = "E_NOT_PAIRED"
  const val ERR_NOT_PREPARED = "E_NOT_PREPARED"
}
