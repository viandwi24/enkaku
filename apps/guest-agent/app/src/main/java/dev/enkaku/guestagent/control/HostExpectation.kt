package dev.enkaku.guestagent.control

import java.util.concurrent.atomic.AtomicInteger

/**
 * Plan 221 §4.9, MVP 10 §2 — the `deviceArtifact.versionCode` the host last told us it has
 * pinned, from `hello`'s optional `expectVersionCode`. `0` means "no host has said" — never
 * confused with a real code, since a real `versionCode` is always positive.
 */
object HostExpectation {
  private const val NONE = 0
  private val versionCode = AtomicInteger(NONE)

  fun set(code: Int) {
    if (code > 0) versionCode.set(code)
  }

  /** `0` when no host has ever told us. */
  fun versionCode(): Int = versionCode.get()
}
