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
   */
  val CAPABILITIES: List<String> = listOf("socks5-route", "vpn-status", "egress-probe")

  // Requests
  const val METHOD_HELLO = "hello"
  const val METHOD_PING = "ping"
  const val METHOD_ROUTE_START = "route.start"
  const val METHOD_ROUTE_STOP = "route.stop"
  const val METHOD_ROUTE_STATUS = "route.status"
  const val METHOD_EGRESS_PROBE = "egress.probe"

  // Error codes. Mirrored on the host so failures are matched on a code, never on message text.
  const val ERR_UNAUTHORISED = "E_UNAUTHORISED"
  const val ERR_BAD_REQUEST = "E_BAD_REQUEST"
  const val ERR_UNKNOWN_METHOD = "E_UNKNOWN_METHOD"
  const val ERR_NOT_PAIRED = "E_NOT_PAIRED"
  const val ERR_NOT_PREPARED = "E_NOT_PREPARED"
}
