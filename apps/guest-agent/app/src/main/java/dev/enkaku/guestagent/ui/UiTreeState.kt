package dev.enkaku.guestagent.ui

import android.os.SystemClock
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

/**
 * What the status screen and `ui.status` read about [UiTreeService]. Same shape as
 * `control/ControlChannelState.kt`: atomics only, [SystemClock.elapsedRealtime] stamps,
 * [NEVER] for "has not happened", and nothing secret.
 */
object UiTreeState {
  const val NEVER = 0L

  private val connected = AtomicBoolean(false)
  private val connectedAt = AtomicLong(NEVER)
  private val lastEventAt = AtomicLong(NEVER)
  private val eventCount = AtomicInteger(0)
  private val lastDumpAt = AtomicLong(NEVER)
  private val lastDumpNodes = AtomicInteger(0)
  private val lastDumpTookMs = AtomicInteger(0)
  private val lastError = AtomicReference<String?>(null)

  fun markConnected() {
    connected.set(true)
    connectedAt.set(SystemClock.elapsedRealtime())
  }

  fun markDisconnected() {
    connected.set(false)
  }

  fun recordEvent() {
    lastEventAt.set(SystemClock.elapsedRealtime())
    eventCount.incrementAndGet()
  }

  fun recordDump(nodeCount: Int, tookMs: Int) {
    lastDumpAt.set(SystemClock.elapsedRealtime())
    lastDumpNodes.set(nodeCount)
    lastDumpTookMs.set(tookMs)
  }

  fun recordError(message: String) {
    lastError.set(message)
  }

  fun isConnected(): Boolean = connected.get()
  fun connectedAt(): Long = connectedAt.get()
  fun lastEventAt(): Long = lastEventAt.get()
  fun eventCount(): Int = eventCount.get()
  fun lastDumpAt(): Long = lastDumpAt.get()
  fun lastDumpNodes(): Int = lastDumpNodes.get()
  fun lastDumpTookMs(): Int = lastDumpTookMs.get()
  fun lastError(): String? = lastError.get()
}
