package dev.enkaku.guestagent.identity

import android.os.SystemClock
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

/**
 * What the status screen reads about [MockLocation]. [MockLocation] itself is a stateless
 * singleton by design (its own doc comment: "a stateless singleton") and therefore remembers no
 * fix — this object is the one place that does, written by
 * [dev.enkaku.guestagent.control.ControlService]'s `location.set`/`location.clear` branches
 * alongside the calls into [MockLocation] itself, never instead of them.
 */
object MockLocationState {
  const val NEVER = 0L

  private val active = AtomicBoolean(false)
  private val lat = AtomicReference(0.0)
  private val lng = AtomicReference(0.0)
  private val setAt = AtomicLong(NEVER)

  fun recordSet(latValue: Double, lngValue: Double) {
    active.set(true)
    lat.set(latValue)
    lng.set(lngValue)
    setAt.set(SystemClock.elapsedRealtime())
  }

  fun recordCleared() {
    active.set(false)
  }

  fun isActive(): Boolean = active.get()

  /** `null` when nothing was ever set this process lifetime. */
  fun lastFix(): Pair<Double, Double>? = if (setAt.get() == NEVER) null else lat.get() to lng.get()

  fun setAt(): Long = setAt.get()
}
