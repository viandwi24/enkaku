package dev.enkaku.guestagent.route

import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.Socket
import java.net.URI
import java.nio.charset.StandardCharsets
import javax.net.ssl.SSLSocketFactory

/**
 * Measures whether the world is actually reachable, from two vantage points at once (plan 51
 * §3.2, §4.2):
 *
 * - [Leg] `direct` uses a socket protected out of our own tunnel via
 *   [RouteVpnService.protectOutbound] — belt-and-suspenders alongside `addDisallowedApplication`
 *   (this app's own uid is already excluded from its own TUN, see below), and the only path
 *   available at all when no route is currently up.
 * - [Leg] `tunnelled` is measured by proxying the SAME request through the route's own configured
 *   SOCKS5 upstream ([Socks5Client]) — the identical connection `hev-socks5-tunnel` makes on this
 *   device's behalf for every app actually routed through the TUN.
 *
 * Why not just open a plain socket for `tunnelled` and let the TUN carry it? Because
 * `RouteVpnService.start()` calls `addDisallowedApplication(packageName)` — this app's own uid is
 * excluded from its own tunnel, on purpose, or the tunnel's upstream connection would re-enter
 * itself and loop forever. That means a plain socket opened from ANYWHERE in this process
 * (including this probe) already bypasses the TUN, always, by construction — there is no way to
 * "listen on tun0" without becoming a second copy of the tunnel's own forwarding path. Proxying
 * explicitly through the configured SOCKS5 upstream is the honest substitute: it measures the
 * exact connection the tunnel makes, not an approximation of it running somewhere else.
 *
 * Comparing both legs in one call is what proves the tunnel is actually carrying traffic rather
 * than the device merely having internet some other way (plan 51 §3.2): a dead upstream shows
 * `direct: ok, tunnelled: fail`; a device with no internet at all shows both failing.
 */
object EgressProbe {

  /** One measurement — mirrors `EgressProbeLegSchema` in `packages/protocol/src/guest-agent.ts` exactly; both sides change together. */
  data class Leg(
    val ok: Boolean,
    val status: Int? = null,
    val body: String? = null,
    val ms: Long = 0,
    val error: String? = null,
    /** `"connect"` or `"fetch"` — see the Zod schema's doc comment for what each covers. Null on a successful leg. */
    val stage: String? = null,
  )

  data class Result(val tunnelled: Leg, val direct: Leg)

  /** Truncates a probe response body — never assume the whole thing was read. */
  private const val MAX_BODY_CHARS = 4_096

  fun run(url: String, timeoutMs: Int): Result =
    Result(
      tunnelled = measureLeg { fetchTunnelled(url, timeoutMs) },
      direct = measureLeg { fetchDirect(url, timeoutMs) },
    )

  /** A stage-tagged failure — the only kind of throw `fetchDirect`/`fetchTunnelled` are expected to raise past their own try/catch. */
  private class ProbeStageException(val stage: String, message: String) : Exception(message)

  private fun measureLeg(block: () -> Leg): Leg {
    val started = System.nanoTime()
    return try {
      block().copy(ms = elapsedMs(started))
    } catch (t: ProbeStageException) {
      Leg(ok = false, ms = elapsedMs(started), error = t.message, stage = t.stage)
    } catch (t: Throwable) {
      // Anything that escapes without an explicit stage (a malformed url, an unexpected runtime
      // exception) is treated as a connect-stage failure — the pre-network step is where an
      // ungoverned throw is most likely to originate.
      Leg(ok = false, ms = elapsedMs(started), error = t.message ?: t.javaClass.simpleName, stage = "connect")
    }
  }

  private fun elapsedMs(startedNanos: Long): Long = (System.nanoTime() - startedNanos) / 1_000_000

  private fun fetchDirect(url: String, timeoutMs: Int): Leg {
    val uri = parseProbeUri(url)
    val raw = Socket()
    try {
      // Belt-and-suspenders alongside `addDisallowedApplication` (see the class doc comment) —
      // and the only mechanism available at all when this call runs with no route currently up,
      // where there is nothing to be excluded from in the first place. Safe to call even then:
      // `protect()` on a VpnService instance with no established tunnel is a documented no-op.
      RouteVpnService.activeInstance()?.protectOutbound(raw)
      raw.connect(java.net.InetSocketAddress(uri.host, targetPort(uri)), timeoutMs)
    } catch (t: Throwable) {
      runCatching { raw.close() }
      throw ProbeStageException("connect", t.message ?: t.javaClass.simpleName)
    }
    val socket = tlsWrapIfNeeded(raw, uri, timeoutMs)
    val (status, body) = fetchStage(socket, uri, timeoutMs)
    return Leg(ok = true, status = status, body = body)
  }

  private fun fetchTunnelled(url: String, timeoutMs: Int): Leg {
    val uri = parseProbeUri(url)
    val upstream = RouteVpnService.currentUpstream()
      ?: throw ProbeStageException("connect", "no route is currently up — nothing to measure through")
    val proxied =
      try {
        Socks5Client.connect(
          proxyHost = upstream.host,
          proxyPort = upstream.port,
          targetHost = uri.host,
          targetPort = targetPort(uri),
          username = upstream.username,
          password = upstream.password,
          timeoutMs = timeoutMs,
        )
      } catch (t: Throwable) {
        throw ProbeStageException("connect", t.message ?: t.javaClass.simpleName)
      }
    val socket = tlsWrapIfNeeded(proxied, uri, timeoutMs)
    val (status, body) = fetchStage(socket, uri, timeoutMs)
    return Leg(ok = true, status = status, body = body)
  }

  private fun parseProbeUri(url: String): URI {
    val uri = URI(url)
    requireNotNull(uri.host) { "probe url has no host: $url" }
    require(uri.scheme == "http" || uri.scheme == "https") { "probe url must be http or https: $url" }
    return uri
  }

  private fun targetPort(uri: URI): Int = if (uri.port != -1) uri.port else if (uri.scheme == "https") 443 else 80

  private fun tlsWrapIfNeeded(socket: Socket, uri: URI, timeoutMs: Int): Socket {
    if (uri.scheme != "https") return socket
    return try {
      socket.soTimeout = timeoutMs
      // `SSLSocketFactory.getDefault()`'s DECLARED return type is the base `SocketFactory`, which
      // lacks the `(Socket, String, Int, Boolean)` overload — that one only exists on
      // `SSLSocketFactory` itself, hence the cast.
      (SSLSocketFactory.getDefault() as SSLSocketFactory).createSocket(socket, uri.host, targetPort(uri), true)
    } catch (t: Throwable) {
      runCatching { socket.close() }
      throw ProbeStageException("connect", "TLS handshake failed: ${t.message ?: t.javaClass.simpleName}")
    }
  }

  /** Writes a minimal HTTP/1.1 GET and reads back a status code plus a size-capped body. Always closes `socket`, success or failure. */
  private fun fetchStage(socket: Socket, uri: URI, timeoutMs: Int): Pair<Int, String> {
    try {
      socket.soTimeout = timeoutMs
      val path = (uri.rawPath.takeIf { it.isNotEmpty() } ?: "/") + (uri.rawQuery?.let { "?$it" } ?: "")
      val request = buildString {
        append("GET ").append(path).append(" HTTP/1.1\r\n")
        append("Host: ").append(uri.host).append("\r\n")
        append("Connection: close\r\n")
        append("User-Agent: enkaku-guest-agent\r\n")
        append("\r\n")
      }
      socket.getOutputStream().write(request.toByteArray(StandardCharsets.US_ASCII))
      socket.getOutputStream().flush()

      val reader = BufferedReader(InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8))
      val statusLine = reader.readLine() ?: throw IllegalStateException("empty response")
      val status = STATUS_LINE_RE.find(statusLine)?.groupValues?.get(1)?.toIntOrNull()
        ?: throw IllegalStateException("malformed status line: $statusLine")

      // Skip headers — the probe only needs the body (the nonce/address it echoes back).
      while (true) {
        val line = reader.readLine() ?: break
        if (line.isEmpty()) break
      }

      val buf = CharArray(MAX_BODY_CHARS)
      val read = reader.read(buf, 0, MAX_BODY_CHARS).coerceAtLeast(0)
      return status to String(buf, 0, read)
    } catch (t: Throwable) {
      throw ProbeStageException("fetch", t.message ?: t.javaClass.simpleName)
    } finally {
      runCatching { socket.close() }
    }
  }

  private val STATUS_LINE_RE = Regex("""HTTP/\d\.\d (\d{3})""")
}
