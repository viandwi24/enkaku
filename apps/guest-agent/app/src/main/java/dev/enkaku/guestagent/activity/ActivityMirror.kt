package dev.enkaku.guestagent.activity

import android.os.SystemClock
import dev.enkaku.guestagent.control.ControlChannelState
import dev.enkaku.guestagent.route.DeadMansSwitch
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

/**
 * Plan 221 §4.5, MVP 10 §1.3 — a read-only mirror of what the FARM says is happening on this
 * device: plan 205's own activity list, its own facts about the device (label, group, tags), and
 * whether a scrcpy server is currently running. Nothing here acts on any of it: no notification,
 * no route change, no service start. It exists only so the phone's own screen can answer "what is
 * the farm doing to me right now" without adb.
 *
 * It never persists: a restarted agent has an empty mirror until the host's next `activity.set` /
 * `device.describe`, and [StatusActivity] says so ("the farm has not sent an activity list since
 * this app started") rather than showing a stale copy from before the restart.
 */
object ActivityMirror {
  /** MVP 10 §1.3: "the control-channel timeout". Named once so a change is one constant. */
  const val STALE_AFTER_MS = DeadMansSwitch.DEFAULT_TIMEOUT_MS

  data class Activity(val id: String, val kind: String, val label: String, val actorLabel: String, val startedAt: Long)

  data class Video(val running: Boolean, val widthPx: Int, val heightPx: Int, val fps: Int)

  data class Device(
    val stableId: String?,
    val label: String?,
    val number: String?,
    val group: String?,
    val tags: List<String>,
  )

  private val activitiesRef = AtomicReference<List<Activity>>(emptyList())
  private val videoRef = AtomicReference<Video?>(null)
  private val deviceRef = AtomicReference<Device?>(null)
  private val updatedAt = AtomicLong(NEVER)

  fun setActivities(activities: List<Activity>, video: Video?) {
    activitiesRef.set(activities)
    videoRef.set(video)
    updatedAt.set(SystemClock.elapsedRealtime())
  }

  fun setDevice(device: Device) {
    deviceRef.set(device)
  }

  fun activities(): List<Activity> = activitiesRef.get()

  fun video(): Video? = videoRef.get()

  fun device(): Device? = deviceRef.get()

  /** [SystemClock.elapsedRealtime] of the last `activity.set`, or [NEVER]. */
  fun updatedAt(): Long = updatedAt.get()

  /**
   * True once the FARM (not this method) has been silent longer than [STALE_AFTER_MS] — reads
   * [ControlChannelState.lastRequestAt], not [updatedAt], because any authorised request proves
   * the farm is still there, not only an `activity.set`.
   */
  fun isStale(): Boolean {
    val last = ControlChannelState.lastRequestAt()
    if (last == ControlChannelState.NEVER) return false
    return SystemClock.elapsedRealtime() - last > STALE_AFTER_MS
  }

  const val NEVER = 0L
}
