package dev.enkaku.guestagent.route

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import java.net.Inet4Address

/**
 * What **Android** says about the VPN interface on this device, as opposed to what [RouteState]
 * remembers this app asked for.
 *
 * The two can disagree, and the disagreement is the single most useful thing a status screen can
 * show. The incident this was written for: the farm's core restarted, the operator turned the route
 * off in Studio, the host-side row went to `engine: none, enabled: false` — and the teardown never
 * reached the phone. `RouteVpnService` was still holding `0.0.0.0/0 → tun0` with nothing forwarding
 * behind it, so the device blocked all of its own traffic while every remote view said there was no
 * route at all. Diagnosing it took `dumpsys`, `ip link` and a `ping`; this object is the same three
 * facts, read on the phone.
 *
 * Reads system-wide network state (`getAllNetworks()`), NOT `getActiveNetwork()` — for the exact
 * reason [Ipv6Leak] documents at length: this app excludes its own uid from its own tunnel
 * (`addDisallowedApplication`), so "the network THIS app is using" is never the tunnel and would
 * answer a different question than the one being asked.
 *
 * Android runs at most one active `VpnService` connection at a time system-wide, so a network with
 * `TRANSPORT_VPN` is ours — but note that "ours" means *this package's*, not necessarily *this
 * route's*: another VPN app taking over shows up here too, which is itself worth seeing.
 */
object VpnLink {

  /**
   * @param interfaceName the kernel interface name (`tun0`), or null when [android.net.LinkProperties]
   *   has none to give.
   * @param ipv4Addresses the addresses on that interface — `198.18.0.1` is
   *   [Socks5Config.TUN_IPV4], this app's own tunnel; anything else is somebody else's VPN.
   * @param hasIpv4Default whether an IPv4 default route points into it, which is what makes it a
   *   full tunnel rather than a split one.
   * @param validated Android's own `NET_CAPABILITY_VALIDATED` — the platform actually reached the
   *   internet **through** this interface at some point. Absent (null) rather than false when the
   *   capabilities could not be read, because "not validated" and "not asked" are different claims.
   */
  data class Observation(
    val interfaceName: String?,
    val ipv4Addresses: List<String>,
    val hasIpv4Default: Boolean,
    val validated: Boolean?,
  )

  /**
   * The VPN interface Android currently has established, or null when there is none — the honest
   * answer to "is there a tunnel on this phone right now", independent of what this app believes.
   */
  fun observe(context: Context): Observation? {
    val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return null
    // Deprecated in favour of `registerNetworkCallback`, used anyway for the same reason
    // `Ipv6Leak.isBlocked` does: this is a one-shot synchronous read on a screen refresh, not a
    // place that wants a persistent callback registered on its behalf.
    @Suppress("DEPRECATION")
    for (network in cm.allNetworks) {
      val caps = cm.getNetworkCapabilities(network) ?: continue
      if (!caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) continue
      val props = cm.getLinkProperties(network)
      return Observation(
        interfaceName = props?.interfaceName,
        ipv4Addresses = props?.linkAddresses.orEmpty().mapNotNull { (it.address as? Inet4Address)?.hostAddress },
        hasIpv4Default = props?.routes.orEmpty().any { it.isDefaultRoute && it.destination.address is Inet4Address },
        validated = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED),
      )
    }
    return null
  }

  /** True when the addresses on the established VPN interface include this app's own TUN address. */
  fun isOurs(observation: Observation): Boolean = observation.ipv4Addresses.contains(Socks5Config.TUN_IPV4)
}
