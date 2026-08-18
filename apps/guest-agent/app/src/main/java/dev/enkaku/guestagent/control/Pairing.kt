package dev.enkaku.guestagent.control

import android.os.SystemClock
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicLong
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

  /**
   * [SystemClock.elapsedRealtime] when a token was last accepted, or [ControlChannelState.NEVER].
   * The token itself never leaves this object; this is only ever rendered as "paired N ago" by
   * [dev.enkaku.guestagent.StatusActivity], which is what tells a human whether the host that
   * bootstrapped this agent did so a moment ago or before it wandered off.
   */
  private val setAt = AtomicLong(ControlChannelState.NEVER)

  fun setToken(value: String?) {
    val accepted = value?.takeIf { it.isNotBlank() }
    token.set(accepted)
    if (accepted != null) setAt.set(SystemClock.elapsedRealtime())
  }

  fun hasToken(): Boolean = token.get() != null

  /** See [setAt]. [ControlChannelState.NEVER] when no token has ever been accepted this process lifetime. */
  fun pairedAt(): Long = setAt.get()

  fun clear() {
    token.set(null)
    setAt.set(ControlChannelState.NEVER)
  }

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
