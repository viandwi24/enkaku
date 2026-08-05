package dev.enkaku.guestagent.route

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import java.net.Inet6Address

/**
 * Plan 51 §4.5, §5.7 — asserts IPv6 is actually blocked rather than assuming a `Builder` call
 * that returned a non-null descriptor did exactly what was asked.
 *
 * The property being asserted is that **no app can carry IPv6 off this device while the route is
 * up**. `RouteVpnService` deliberately does NOT force that by capturing `::/0` into the TUN — that
 * swallows packets instead of refusing them and broke every browser on the device (see its own
 * comment). It relies on Android refusing to route IPv6 through a VPN that has no IPv6 address,
 * and this object is what stops that from being an unexamined assumption: it reads the established
 * network back and fails the `leak` check the moment a usable IPv6 path appears.
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
   * True when the established VPN carries no usable IPv6 path — it has no IPv6 address of its own
   * AND no IPv6 default route an app could send over. Either one alone is not enough: an address
   * without a route cannot leave, and a route without an address is the swallowing behaviour this
   * deliberately does not do. Null when no VPN network can be found to ask (nothing established,
   * or the system service is unavailable) — the caller (`ControlService`) omits the field entirely
   * rather than reporting a guessed answer.
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
      val hasIpv6Address = props.linkAddresses.any { it.address is Inet6Address && !it.address.isLinkLocalAddress }
      // `RouteInfo` has no `isIPv6Default()` — a default route (`isDefaultRoute`, prefix length 0)
      // is family-agnostic, so the IPv6-ness comes from the destination's own address type.
      val hasIpv6Default = props.routes.any { it.isDefaultRoute && it.destination.address is Inet6Address }
      return !hasIpv6Address && !hasIpv6Default
    }
    return null
  }
}
