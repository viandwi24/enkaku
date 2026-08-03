package dev.enkaku.guestagent.route

import java.io.File

/**
 * The SOCKS5 upstream a route points at.
 *
 * Credentials arrive from the host per route and are held only for as long as the route lives —
 * they are never persisted. The farm resolves them from a named reference on its own side, so a
 * raw secret never enters a job's parameters, the jobs table, artifacts, or the device event log.
 */
data class Socks5Upstream(
  val host: String,
  val port: Int,
  val username: String? = null,
  val password: String? = null,
  /** `udp` carries UDP over UDP; `tcp` tunnels it over the TCP connection when the server refuses. */
  val udpMode: String = "udp",
)

/**
 * Writes `hev-socks5-tunnel`'s YAML configuration.
 *
 * The field names and value shapes come from the upstream `conf/main.yml` at tag 2.16.0. The
 * addresses below are the tunnel's own private endpoints inside the TUN, matching what
 * [RouteVpnService] hands to `VpnService.Builder` — the two must agree or packets are dropped
 * without an error anyone can see.
 */
object Socks5Config {

  const val TUN_IPV4 = "198.18.0.1"
  const val TUN_PREFIX_LENGTH = 32
  /**
   * 1400, not hev's sample 8500. The TUN MTU sets the MSS apps advertise; at 8500 the device
   * emitted segments far larger than the real path could carry, and connections through the
   * tunnel died with ERR_CONNECTION_RESET while the route itself stayed up. 1400 leaves room for
   * the SOCKS5 and outer IP/TCP overhead on a 1500-byte path.
   */
  const val MTU = 1400

  /**
   * The tunnel's own DNS resolver, and the reason the device can browse at all through a
   * TCP-only SOCKS5 proxy.
   *
   * Pointing the VPN at a real resolver (1.1.1.1) sends every DNS query as UDP through SOCKS5
   * UDP ASSOCIATE — which residential proxies commonly refuse. Name resolution then fails while
   * TCP still works, so `curl http://<ip>` succeeds and a browser hangs and finally reports
   * "no internet" / "DNS probe started". Observed exactly that way.
   *
   * `mapdns` answers queries inside the tunnel, hands the app an address from [MAPPED_NETWORK],
   * and when the app connects to it hev maps it back to the hostname and sends the **name** to
   * the proxy over TCP — which plain SOCKS5 supports. No UDP anywhere.
   */
  const val MAPPED_DNS_IPV4 = "198.18.0.2"
  private const val MAPPED_NETWORK = "100.64.0.0"
  private const val MAPPED_NETMASK = "255.192.0.0"
  private const val MAPPED_CACHE = 10_000


  fun write(dir: File, upstream: Socks5Upstream): File {
    val file = File(dir, "hev-socks5-tunnel.yml")
    file.writeText(render(upstream))
    // The config carries the upstream password in clear text, so it must never be world-readable.
    // It lives in the app's private storage and is deleted when the route stops.
    file.setReadable(false, false)
    file.setReadable(true, true)
    return file
  }

  fun render(upstream: Socks5Upstream): String = buildString {
    appendLine("tunnel:")
    appendLine("  mtu: $MTU")
    appendLine("  ipv4: $TUN_IPV4")
    appendLine("socks5:")
    appendLine("  address: '${upstream.host}'")
    appendLine("  port: ${upstream.port}")
    appendLine("  udp: '${upstream.udpMode}'")
    upstream.username?.takeIf { it.isNotEmpty() }?.let { appendLine("  username: '${yaml(it)}'") }
    upstream.password?.takeIf { it.isNotEmpty() }?.let { appendLine("  password: '${yaml(it)}'") }
    appendLine("mapdns:")
    appendLine("  address: $MAPPED_DNS_IPV4")
    appendLine("  port: 53")
    appendLine("  network: $MAPPED_NETWORK")
    appendLine("  netmask: $MAPPED_NETMASK")
    appendLine("  cache-size: $MAPPED_CACHE")
    appendLine("misc:")
    appendLine("  log-level: warn")
  }

  /** Single-quoted YAML escapes a quote by doubling it; nothing else needs escaping. */
  private fun yaml(value: String): String = value.replace("'", "''")
}
