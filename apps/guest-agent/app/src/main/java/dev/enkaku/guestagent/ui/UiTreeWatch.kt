package dev.enkaku.guestagent.ui

import dev.enkaku.guestagent.control.Protocol
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import org.json.JSONObject

/**
 * Plan 221 §4.4 — the `ui.watch` subscription. Exactly one watcher per agent, because there is
 * exactly one core per device: a second `subscribe` closes whatever was there. The event carries
 * no tree — the host calls `ui.dump`/`ui.find` on a different connection when it wants content.
 */
object UiTreeWatch {
  /** A single-thread scheduler, matching `DeadMansSwitch`'s own executor shape. */
  private val scheduler = Executors.newSingleThreadScheduledExecutor { r ->
    Thread(r, "enkaku-ui-watch").apply { isDaemon = true }
  }

  const val DEBOUNCE_MS = 50L

  private val sink = AtomicReference<((JSONObject) -> Unit)?>(null)
  private val seq = AtomicInteger(0)
  private val pending = AtomicReference<ScheduledFuture<*>?>(null)
  private val lastPackage = AtomicReference("")
  private val lastReason = AtomicReference("content")

  /** Registers [newSink] as the sole watcher, closing whatever was there. */
  @Synchronized
  fun subscribe(newSink: (JSONObject) -> Unit) {
    pending.getAndSet(null)?.cancel(false)
    seq.set(0)
    sink.set(newSink)
  }

  @Synchronized
  fun unsubscribe() {
    pending.getAndSet(null)?.cancel(false)
    sink.set(null)
  }

  fun isWatching(): Boolean = sink.get() != null

  /** Called from [UiTreeService.onAccessibilityEvent]; coalesces a burst within [DEBOUNCE_MS] into one frame. */
  fun onChanged(packageName: String, reason: String) {
    if (sink.get() == null) return
    lastPackage.set(packageName)
    lastReason.set(reason)
    if (pending.get() != null) return
    val future =
      scheduler.schedule(::deliver, DEBOUNCE_MS, TimeUnit.MILLISECONDS)
    pending.set(future)
  }

  private fun deliver() {
    pending.set(null)
    val current = sink.get() ?: return
    val frame =
      JSONObject().apply {
        put("event", Protocol.EVENT_UI_CHANGED)
        put("seq", seq.incrementAndGet())
        put("at", System.currentTimeMillis() / 1000)
        put("packageName", lastPackage.get())
        put("reason", lastReason.get())
      }
    runCatching { current(frame) }
      .onFailure { unsubscribe() }
  }
}
