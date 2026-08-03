package dev.enkaku.guestagent.control

import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicReference

/**
 * The pairing token, held in memory only.
 *
 * It is never written to disk on purpose: the host regenerates it on every provisioning pass, so a
 * token that survived a restart would be a stale credential with no way to revoke it. Losing it on
 * reboot is the correct behaviour — the host re-bootstraps and hands over a fresh one.
 */
object Pairing {
  private val token = AtomicReference<String?>(null)

  fun setToken(value: String?) {
    token.set(value?.takeIf { it.isNotBlank() })
  }

  fun hasToken(): Boolean = token.get() != null

  fun clear() = token.set(null)

  /**
   * Constant-time comparison. The control channel is only reachable through `adb forward`, so this
   * is not the primary defence, but a timing-variable compare on a secret is not worth keeping.
   */
  fun matches(candidate: String?): Boolean {
    val expected = token.get() ?: return false
    if (candidate.isNullOrEmpty()) return false
    val a = expected.toByteArray(Charsets.UTF_8)
    val b = candidate.toByteArray(Charsets.UTF_8)
    return MessageDigest.isEqual(a, b)
  }
}
