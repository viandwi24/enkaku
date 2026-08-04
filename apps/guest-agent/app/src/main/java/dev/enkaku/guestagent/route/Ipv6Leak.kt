package dev.enkaku.guestagent.route

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import java.net.Inet6Address

/**
 * Plan 51 §4.5, §5.7 — asserts IPv6 is actually blocked rather than assuming a `Builder` call
 * that returned a non-null descriptor did exactly what was asked.
 *
 * `RouteVpnService.start()` now calls `addRoute("::", 0)` explicitly (see its own comment for
 * why: this captures ALL IPv6 traffic system-wide into a TUN interface `hev-socks5-tunnel` does
 * not understand, turning "IPv6 happens to be unreachable" — Android's own incidental behaviour
 * for a VPN with no IPv6 address — into "we deliberately swallow it"). This object reads that
 * request back rather than trusting it: it inspects `LinkProperties` on the network the OS
 * actually established, and confirms the `::/0` route is really there.
 *
 * Deliberately does NOT use `ConnectivityManager.getActiveNetwork()`: called from THIS process
 * (the guest agent app), that would return whatever network THIS app itself is routed over —
 * and `RouteVpnService.start()` excludes this app's own uid from its own tunnel
 * (`addDisallowedApplication(packageName)`), for the identical reason `EgressProbe`'s `direct`
 * leg cannot use a plain unprotected socket to measure anything about the tunnel (see its own
 * doc comment). `getAllNetworks()`/`getLinkProperties()` reads system-wide network state and is
 * unaffected by which network this particular app happens to be routed over.
 */
object Ipv6Leak {
  /**
   * True when the currently-established VPN network's routes capture `::/0` — i.e. no app on
   * this device (other than this one, excluded from its own tunnel) can reach the public
   * internet over IPv6 except through a TUN that cannot forward it. Null when no VPN network
   * can currently be found to ask (nothing established, or the system service is unavailable) —
   * the caller (`ControlService`) omits the field entirely in that case rather than reporting a
   * guessed answer.
   *
   * Android runs at most one active `VpnService` connection at a time system-wide, so finding a
   * network with `TRANSPORT_VPN` is safe to treat as "ours".
   */
  fun isBlocked(context: Context): Boolean? {
    val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return null
    // `getAllNetworks()` is deprecated in favour of `registerNetworkCallback` — deliberately used
    // anyway: this is a one-shot synchronous read on every `route.status` poll, not a place that
    // wants a persistent callback registered and unregistered on this object's behalf.
    @Suppress("DEPRECATION")
    for (network in cm.allNetworks) {
      val caps = cm.getNetworkCapabilities(network) ?: continue
      if (!caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) continue
      val props = cm.getLinkProperties(network) ?: continue
      // `RouteInfo` has no `isIPv6Default()` — a default route (`isDefaultRoute()`, prefix length
      // 0) is family-agnostic, so the IPv6-ness comes from the destination's own address type.
      return props.routes.any { it.isDefaultRoute && it.destination.address is Inet6Address }
    }
    return null
  }
}
