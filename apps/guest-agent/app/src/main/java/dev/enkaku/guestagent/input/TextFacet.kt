package dev.enkaku.guestagent.input

import android.content.Context

/**
 * What [dev.enkaku.guestagent.control.ControlService] calls for `text.commit`/`text.status`
 * (plan 90 §3.2, §3.3, §4.2). A stateless singleton, mirroring
 * [dev.enkaku.guestagent.identity.MockLocation]'s shape: it hands work to the live [EnkakuIme]
 * instance through [EnkakuIme.instance]'s static weak reference and answers "not current"
 * (never a wait or a queue) when there is none.
 *
 * `ime: 'current'|'not-current'` (the `text.commit` axis) tracks ONLY whether this component is
 * the OS's selected default input method right now ([EnkakuIme.isCurrent]) — independent of
 * whether a field happens to be focused at this exact instant. An IME that is current but has
 * nothing focused commits 0 code points and still reports `current`; an IME that is not the
 * default commits nothing and reports `not-current`, which is the precondition the host can fix
 * with `ime set` (plan 90 §4.1's doc comment on `TextCommitResultSchema`).
 */
object TextFacet {

  data class CommitOutcome(val committed: Int, val current: Boolean)
  data class StatusOutcome(val ime: String, val id: String, val connected: Boolean)

  /**
   * Commits [text] through the live IME. One code point at a time, sleeping between commits for a
   * duration drawn from [perCharMs], when [perCharMs] is present (plan 40's realism — `perCharMs`
   * mirrors `typeText`'s `[minMs, maxMs]` range); the whole string in a single call otherwise
   * (plan 90 §4.2). Stops at the first code point [EnkakuIme.commitOnMainThread] reports as
   * failed, rather than continuing to commit the remainder into whatever the connection is now
   * pointed at.
   */
  fun commit(context: Context, text: String, perCharMs: Pair<Long, Long>?): CommitOutcome {
    if (!EnkakuIme.isCurrent(context)) return CommitOutcome(committed = 0, current = false)
    val ime = EnkakuIme.instance() ?: return CommitOutcome(committed = 0, current = true)
    if (text.isEmpty()) return CommitOutcome(committed = 0, current = true)

    if (perCharMs == null) {
      val ok = ime.commitOnMainThread(text)
      return CommitOutcome(committed = if (ok) text.codePointCount(0, text.length) else 0, current = true)
    }

    var committed = 0
    var index = 0
    while (index < text.length) {
      val codePoint = text.codePointAt(index)
      val charCount = Character.charCount(codePoint)
      val chunk = text.substring(index, index + charCount)
      if (!ime.commitOnMainThread(chunk)) break
      committed++
      index += charCount
      if (index < text.length) sleepBetween(perCharMs)
    }
    return CommitOutcome(committed = committed, current = true)
  }

  fun status(context: Context): StatusOutcome {
    val state = when {
      EnkakuIme.isCurrent(context) -> "current"
      EnkakuIme.isEnabled(context) -> "enabled"
      else -> "disabled"
    }
    return StatusOutcome(
      ime = state,
      id = EnkakuIme.COMPONENT_ID,
      connected = EnkakuIme.instance()?.hasConnection() == true,
    )
  }

  private fun sleepBetween(perCharMs: Pair<Long, Long>) {
    val (min, max) = perCharMs
    val delay = if (max > min) min + (Math.random() * (max - min)).toLong() else min
    if (delay > 0) Thread.sleep(delay)
  }
}
