package dev.enkaku.guestagent.control

import android.os.SystemClock
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

/**
 * What the control channel is actually doing, readable without holding a reference to
 * [ControlService] — the channel's own counterpart to [dev.enkaku.guestagent.route.RouteState].
 *
 * It exists for one reader today, [dev.enkaku.guestagent.StatusActivity]: the question "is the farm
 * still talking to this phone, and when did it last say anything?" had no answer anywhere in the
 * process, even though [ControlService] observes it on every single request. `hasToken()` alone
 * cannot answer it — a token handed over an hour ago by a host that has since died looks exactly
 * like one handed over a second ago, and the difference is the whole diagnosis when a device is
 * sitting in [dev.enkaku.guestagent.route.RouteLifecycleState.HELD].
 *
 * Every timestamp here is [SystemClock.elapsedRealtime] — monotonic and counted across deep sleep,
 * unlike `System.nanoTime`, and unaffected by the clock being set. Only ever rendered as an
 * elapsed duration, never as a wall-clock time, because that is the only thing it can honestly be.
 *
 * Deliberately holds nothing secret: the pairing token itself stays in [Pairing], and the only
 * thing recorded about a request is its method name, which is a wire constant from [Protocol].
 */
object ControlChannelState {

  /** Nothing recorded yet — distinct from "recorded, zero ms ago". */
  const val NEVER = 0L

  private val listening = AtomicBoolean(false)
  private val listenError = AtomicReference<String?>(null)
  private val startedAt = AtomicLong(NEVER)
  private val lastRequestAt = AtomicLong(NEVER)
  private val lastMethod = AtomicReference<String?>(null)
  private val requestCount = AtomicInteger(0)
  private val lastRejectionAt = AtomicLong(NEVER)
  private val lastRejectionCode = AtomicReference<String?>(null)

  /** The accept loop is bound and running: the host's `adb forward` has something to connect to. */
  fun markListening() {
    listening.set(true)
    listenError.set(null)
    startedAt.set(SystemClock.elapsedRealtime())
  }

  /**
   * The accept loop is gone. [reason] is null for an ordinary shutdown (`onDestroy` closed the
   * socket) and carries the throwable's own message when the loop died on its own — the two are
   * very different things to read on a phone, so they are not collapsed.
   */
  fun markStopped(reason: String?) {
    listening.set(false)
    if (reason != null) listenError.set(reason)
  }

  /** An authorised request was served — the same event that feeds [dev.enkaku.guestagent.route.DeadMansSwitch.touch]. */
  fun recordRequest(method: String) {
    lastRequestAt.set(SystemClock.elapsedRealtime())
    lastMethod.set(method)
    requestCount.incrementAndGet()
  }

  /**
   * A request arrived and was refused before it could run — `E_NOT_PAIRED` or `E_UNAUTHORISED`.
   * Worth recording separately from [recordRequest]: "something is knocking with the wrong token"
   * and "nothing is knocking at all" look identical through the last-request timestamp alone, and
   * only the first one means the host is alive but out of step with this process.
   */
  fun recordRejection(code: String) {
    lastRejectionAt.set(SystemClock.elapsedRealtime())
    lastRejectionCode.set(code)
  }

  fun isListening(): Boolean = listening.get()

  /** The last accept-loop failure, if the loop ever died on its own. Never cleared by a clean stop. */
  fun listenError(): String? = listenError.get()

  /** [SystemClock.elapsedRealtime] when the channel last started listening, or [NEVER]. */
  fun startedAt(): Long = startedAt.get()

  /** [SystemClock.elapsedRealtime] of the last authorised request, or [NEVER] if the farm has never spoken. */
  fun lastRequestAt(): Long = lastRequestAt.get()

  fun lastMethod(): String? = lastMethod.get()

  fun requestCount(): Int = requestCount.get()

  fun lastRejectionAt(): Long = lastRejectionAt.get()

  fun lastRejectionCode(): String? = lastRejectionCode.get()
}
