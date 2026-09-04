package dev.enkaku.guestagent.input

import android.content.Context

/**
 * Plan 221 §4.6, MVP 08 §1.2 — the "show the soft keyboard while a hardware keyboard is
 * connected" preference. A [android.content.SharedPreferences] file, not an in-memory flag: it
 * has to survive both the session that set it and the next reboot (G10), and a
 * `SharedPreferences` file is the smallest thing on this device that does both without inventing
 * a new persistence format.
 */
object ImePrefs {
  private const val FILE = "enkaku-ime"
  private const val KEY_SHOW_WITH_HARDWARE = "show_soft_keyboard_with_hardware"

  fun setShowSoftKeyboardWithHardware(context: Context, value: Boolean) {
    prefs(context).edit().putBoolean(KEY_SHOW_WITH_HARDWARE, value).apply()
  }

  fun showSoftKeyboardWithHardware(context: Context): Boolean =
    prefs(context).getBoolean(KEY_SHOW_WITH_HARDWARE, false)

  private fun prefs(context: Context) =
    context.getSharedPreferences(FILE, Context.MODE_PRIVATE)
}
