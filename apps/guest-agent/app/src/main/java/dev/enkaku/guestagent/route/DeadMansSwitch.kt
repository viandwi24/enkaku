package dev.enkaku.guestagent.route

import android.util.Log
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

/**
 * Tears the route down when the farm stops talking to us.
 *
 * This exists because of a real incident, not a hypothetical one. A route was applied, the core was
 * killed, and the device was left holding `0.0.0.0/0 → tun0` pointed at an upstream nobody was
 * talking to any more: WiFi connected, network `VALIDATED`, and no usable internet. Recovering it
 * needed adb. On a farm, one core crash would strand every routed device at once.
 *
 * It has to live here rather than on the host for the obvious reason — **the host may be the thing
 * that died**, and a dead process runs no cleanup. Host-side lease teardown is still the normal
 * path; this is the backstop for when there is no host left to run it.
 *
 * The contract with the core: while a route is enabled it pings every [HEARTBEAT_HINT_MS]. Missing
 * a few in a row is normal (a slow adb queue, a device asleep), so the deadline is several times
 * that. Only silence long enough to mean "nobody is coming back" trips it.
 */
class DeadMansSwitch(
  private val timeoutMs: Long = DEFAULT_TIMEOUT_MS,
  private val onExpired: () -> Unit,
) {
  private val lastContact = AtomicLong(0)
  private val scheduler = Executors.newSingleThreadScheduledExecutor { r ->
    Thread(r, "enkaku-deadman").apply { isDaemon = true }
  }

  /** Called on every authorised request — any contact at all proves the farm is still there. */
  fun touch() = lastContact.set(System.nanoTime())

  fun start() {
    touch()
    scheduler.scheduleWithFixedDelay(::check, CHECK_INTERVAL_MS, CHECK_INTERVAL_MS, TimeUnit.MILLISECONDS)
  }

  fun stop() = scheduler.shutdownNow()

  private fun check() {
    // Only meaningful while a route is actually up: with no route there is nothing to strand, and
    // firing then would tear down something the operator never asked us to touch.
    if (!RouteState.isUp()) {
      touch()
      return
    }
    val silentMs = (System.nanoTime() - lastContact.get()) / 1_000_000
    if (silentMs < timeoutMs) return

    Log.w(TAG, "no contact from the farm for ${silentMs}ms — tearing the route down")
    RouteState.markError("no contact from the farm for ${silentMs}ms; route torn down to avoid stranding the device")
    runCatching { onExpired() }
      .onFailure { Log.e(TAG, "dead-man teardown failed", it) }
    touch()
  }

  companion object {
    private const val TAG = "EnkakuGuestAgent"

    /** What the core promises while a route is enabled. Documented here so the two stay in step. */
    const val HEARTBEAT_HINT_MS = 20_000L

    /** Four missed heartbeats. Long enough to ride out a slow adb queue, short enough to matter. */
    const val DEFAULT_TIMEOUT_MS = 90_000L

    private const val CHECK_INTERVAL_MS = 10_000L
  }
}
