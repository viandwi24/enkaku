package dev.enkaku.guestagent.route

import java.io.DataInputStream
import java.io.IOException
import java.net.InetSocketAddress
import java.net.Socket
import java.nio.charset.StandardCharsets

/**
 * A minimal SOCKS5 client (RFC 1928 CONNECT + RFC 1929 username/password auth), used ONLY by
 * [EgressProbe]'s tunnelled leg.
 *
 * Not a general-purpose implementation: it speaks CONNECT and username/password auth, nothing
 * else (no BIND, no UDP ASSOCIATE, no GSSAPI). It exists because this app's own uid is excluded
 * from its own TUN (`RouteVpnService.start()`'s `addDisallowedApplication`), so a plain socket
 * opened from this process can never be captured by the tunnel to prove anything about it —
 * proxying explicitly through the SAME upstream the tunnel forwards into is the only way to
 * measure that path from inside this process. See [EgressProbe]'s doc comment for the full
 * reasoning (plan 51 §3.2, §4.2).
 */
object Socks5Client {

  /**
   * Connects to `proxyHost:proxyPort`, performs the SOCKS5 handshake (and username/password
   * sub-negotiation when either credential is non-empty), then issues a CONNECT for
   * `targetHost:targetPort`. On success the returned [Socket] carries raw bytes straight to the
   * target exactly like a direct TCP connection would — the caller writes/reads its own
   * application protocol (HTTP, here) without any further SOCKS framing.
   *
   * Throws (never returns a half-connected socket) on any protocol violation or a non-success
   * reply — the caller ([EgressProbe]) is responsible for turning that into a failed [EgressProbe.Leg].
   */
  fun connect(
    proxyHost: String,
    proxyPort: Int,
    targetHost: String,
    targetPort: Int,
    username: String?,
    password: String?,
    timeoutMs: Int,
  ): Socket {
    val socket = Socket()
    try {
      socket.connect(InetSocketAddress(proxyHost, proxyPort), timeoutMs)
      socket.soTimeout = timeoutMs

      val out = socket.getOutputStream()
      val input = DataInputStream(socket.getInputStream())

      val useAuth = !username.isNullOrEmpty() || !password.isNullOrEmpty()
      val methods = if (useAuth) byteArrayOf(0x00, 0x02) else byteArrayOf(0x00)
      out.write(byteArrayOf(0x05, methods.size.toByte(), *methods))
      out.flush()

      val greeting = ByteArray(2)
      input.readFully(greeting)
      if (greeting[0] != VERSION) throw IOException("not a SOCKS5 proxy (version ${greeting[0]})")
      when (greeting[1]) {
        METHOD_NO_AUTH -> {
          // Proceed — no sub-negotiation needed.
        }
        METHOD_USER_PASS -> {
          val u = (username ?: "").toByteArray(StandardCharsets.UTF_8)
          val p = (password ?: "").toByteArray(StandardCharsets.UTF_8)
          out.write(byteArrayOf(0x01, u.size.toByte()) + u + byteArrayOf(p.size.toByte()) + p)
          out.flush()
          val authReply = ByteArray(2)
          input.readFully(authReply)
          if (authReply[1] != 0x00.toByte()) throw IOException("SOCKS5 authentication rejected")
        }
        METHOD_NO_ACCEPTABLE -> throw IOException("SOCKS5 proxy rejected every offered auth method")
        else -> throw IOException("SOCKS5 proxy chose an unsupported auth method (${greeting[1]})")
      }

      // ATYP domain name (0x03): let the proxy resolve the target, the same as any app routed
      // through the tunnel would — this process never resolves it itself.
      val hostBytes = targetHost.toByteArray(StandardCharsets.UTF_8)
      require(hostBytes.size <= 255) { "target host too long for SOCKS5 domain addressing: $targetHost" }
      val request = ByteArray(7 + hostBytes.size)
      request[0] = VERSION
      request[1] = 0x01 // CONNECT
      request[2] = 0x00 // reserved
      request[3] = 0x03 // ATYP domain name
      request[4] = hostBytes.size.toByte()
      hostBytes.copyInto(request, 5)
      request[5 + hostBytes.size] = ((targetPort shr 8) and 0xFF).toByte()
      request[6 + hostBytes.size] = (targetPort and 0xFF).toByte()
      out.write(request)
      out.flush()

      val replyHeader = ByteArray(4)
      input.readFully(replyHeader)
      if (replyHeader[0] != VERSION) throw IOException("malformed SOCKS5 reply")
      if (replyHeader[1] != 0x00.toByte()) throw IOException("SOCKS5 CONNECT failed (reply code ${replyHeader[1]})")
      // Skip the bound address the proxy echoes back — length depends on ATYP — then its 2-byte port.
      val addrLen = when (replyHeader[3]) {
        0x01.toByte() -> 4
        0x04.toByte() -> 16
        0x03.toByte() -> input.readUnsignedByte()
        else -> throw IOException("unknown SOCKS5 reply address type (${replyHeader[3]})")
      }
      input.skipBytes(addrLen + 2)
      return socket
    } catch (t: Throwable) {
      runCatching { socket.close() }
      throw t
    }
  }

  private val VERSION = 0x05.toByte()
  private val METHOD_NO_AUTH = 0x00.toByte()
  private val METHOD_USER_PASS = 0x02.toByte()
  private val METHOD_NO_ACCEPTABLE = 0xFF.toByte()
}
