package dev.enkaku.guestagent.label

import android.app.WallpaperManager
import android.content.Context
import android.content.SharedPreferences
import android.graphics.BitmapFactory
import android.graphics.Point
import android.os.Build
import android.view.WindowManager
import java.io.File

/**
 * Applies [LabelRenderer]'s bitmap through [WallpaperManager] (plan 89 §3.4, §4.5; plan 90's
 * Task B — no step in plan 90 assigned this facet; see `ControlService.kt`'s `label.*` branches).
 * A stateless-ish singleton mirroring [dev.enkaku.guestagent.identity.MockLocation]'s shape, with
 * one piece of state this facet alone owns: the ORIGINAL wallpaper, captured once on this app's
 * very first apply and stored under this app's own private files dir (never anywhere the host or
 * another app can read it), so `label.clear(restoreOriginal = true)` can put it back.
 *
 * The five behavioural requirements plan 89 §4.5 states are implemented here, each noted at its
 * one enforcement point below: (1) `applied` reports what took; (2) an unchanged fingerprint is a
 * cheap no-op; (3) `originalCaptured` is never an optimistic `true`; (4) `label.clear` is
 * idempotent and consults no "already cleared" flag; (5) `rendererVersion` is an integer this
 * object owns.
 */
object WallpaperFacet {

  data class ApplyResult(
    val applied: List<String>, // "home" | "lock", subset of what took — requirement 1
    val fingerprint: String,
    val rendererVersion: Int,
    val widthPx: Int,
    val heightPx: Int,
    val wallpaperIdHome: Int?,
    val wallpaperIdLock: Int?,
  )

  data class StatusResult(
    val fingerprint: String?,
    val matchesOurs: Boolean,
    val wallpaperIdHome: Int?,
    val wallpaperIdLock: Int?,
    val originalCaptured: Boolean,
    val rendererVersion: Int,
  )

  data class ClearResult(val restored: String) // "original" | "system-default"

  /**
   * Requirement 5: bumped whenever [LabelRenderer]'s drawing changes. The host's own fingerprint
   * (plan 89 §4.4) includes this same integer, so every device re-renders once after a bump —
   * never silently keeps showing a stale label the fingerprint claims is current.
   */
  const val RENDERER_VERSION = 1

  private const val PREFS = "enkaku-label"
  private const val KEY_FINGERPRINT = "fingerprint"
  private const val KEY_ORIGINAL_CAPTURED = "original-captured"
  private const val KEY_WALLPAPER_ID_HOME = "wallpaper-id-home"
  private const val KEY_WALLPAPER_ID_LOCK = "wallpaper-id-lock"
  private const val ORIGINAL_FILENAME = "label-original-wallpaper.png"

  fun apply(context: Context, fingerprint: String, number: String, name: String?, surfaces: List<String>): ApplyResult {
    val prefs = prefs(context)
    val manager = WallpaperManager.getInstance(context)
    val size = displaySize(context)

    // Requirement 2: an unchanged fingerprint is a cheap no-op — this is what makes plan 89 §3.7's
    // reconnect probe free. Still returns the live ids, never a stale cached pair.
    if (prefs.getString(KEY_FINGERPRINT, null) == fingerprint) {
      return ApplyResult(
        applied = surfaces.filter { it == "home" || it == "lock" },
        fingerprint = fingerprint,
        rendererVersion = RENDERER_VERSION,
        widthPx = size.x,
        heightPx = size.y,
        wallpaperIdHome = wallpaperId(manager, WallpaperManager.FLAG_SYSTEM),
        wallpaperIdLock = wallpaperId(manager, WallpaperManager.FLAG_LOCK),
      )
    }

    captureOriginalOnce(context, manager, prefs)

    val bitmap = LabelRenderer.render(size.x, size.y, LabelRenderer.Label(name, number))
    val applied = mutableListOf<String>()
    if ("home" in surfaces) {
      runCatching { manager.setBitmap(bitmap, null, true, WallpaperManager.FLAG_SYSTEM) }
        .onSuccess { applied += "home" }
    }
    if ("lock" in surfaces) {
      runCatching { manager.setBitmap(bitmap, null, true, WallpaperManager.FLAG_LOCK) }
        .onSuccess { applied += "lock" }
    }

    val editor = prefs.edit().putString(KEY_FINGERPRINT, fingerprint)
    if ("home" in applied) editor.putInt(KEY_WALLPAPER_ID_HOME, wallpaperId(manager, WallpaperManager.FLAG_SYSTEM) ?: -1)
    if ("lock" in applied) editor.putInt(KEY_WALLPAPER_ID_LOCK, wallpaperId(manager, WallpaperManager.FLAG_LOCK) ?: -1)
    editor.apply()

    return ApplyResult(
      applied = applied,
      fingerprint = fingerprint,
      rendererVersion = RENDERER_VERSION,
      widthPx = size.x,
      heightPx = size.y,
      wallpaperIdHome = wallpaperId(manager, WallpaperManager.FLAG_SYSTEM),
      wallpaperIdLock = wallpaperId(manager, WallpaperManager.FLAG_LOCK),
    )
  }

  fun status(context: Context): StatusResult {
    val prefs = prefs(context)
    val manager = WallpaperManager.getInstance(context)
    val fingerprint = prefs.getString(KEY_FINGERPRINT, null)
    val storedHome = prefs.getInt(KEY_WALLPAPER_ID_HOME, -1).takeIf { it >= 0 }
    val storedLock = prefs.getInt(KEY_WALLPAPER_ID_LOCK, -1).takeIf { it >= 0 }
    val liveHome = wallpaperId(manager, WallpaperManager.FLAG_SYSTEM)
    val liveLock = wallpaperId(manager, WallpaperManager.FLAG_LOCK)
    // Drift detection for plan 89 §3.7's reconnect probe: `getWallpaperId` is a monotonically
    // increasing counter bumped by ANY app that changes the wallpaper, so "the id we recorded at
    // our last apply still matches the live one" is exactly "nobody else touched it since".
    val matches = fingerprint != null &&
      (storedHome == null || storedHome == liveHome) &&
      (storedLock == null || storedLock == liveLock)
    return StatusResult(
      fingerprint = fingerprint,
      matchesOurs = matches,
      wallpaperIdHome = liveHome,
      wallpaperIdLock = liveLock,
      originalCaptured = prefs.getBoolean(KEY_ORIGINAL_CAPTURED, false),
      rendererVersion = RENDERER_VERSION,
    )
  }

  fun clear(context: Context, restoreOriginal: Boolean): ClearResult {
    val prefs = prefs(context)
    val manager = WallpaperManager.getInstance(context)
    val originalFile = File(context.filesDir, ORIGINAL_FILENAME)

    // Requirement 4: idempotent, no "already cleared" flag consulted — the tenth call performs
    // the identical writes the first one did.
    val restored = if (restoreOriginal && originalFile.exists()) {
      val original = BitmapFactory.decodeFile(originalFile.absolutePath)
      if (original != null) {
        runCatching { manager.setBitmap(original, null, true, WallpaperManager.FLAG_SYSTEM or WallpaperManager.FLAG_LOCK) }
        "original"
      } else {
        runCatching { manager.clear(WallpaperManager.FLAG_SYSTEM or WallpaperManager.FLAG_LOCK) }
        "system-default"
      }
    } else {
      runCatching { manager.clear(WallpaperManager.FLAG_SYSTEM or WallpaperManager.FLAG_LOCK) }
      "system-default"
    }

    prefs.edit()
      .remove(KEY_FINGERPRINT)
      .remove(KEY_WALLPAPER_ID_HOME)
      .remove(KEY_WALLPAPER_ID_LOCK)
      .apply()
    return ClearResult(restored = restored)
  }

  /**
   * Requirement 3: never an optimistic `true`. Runs at most once per install — guarded by
   * [KEY_ORIGINAL_CAPTURED], which is set to the ACTUAL outcome (true or false) the first time
   * this runs, never left unset to retry silently on a later apply.
   */
  private fun captureOriginalOnce(context: Context, manager: WallpaperManager, prefs: SharedPreferences) {
    if (prefs.contains(KEY_ORIGINAL_CAPTURED)) return
    val captured = runCatching {
      val file = manager.getWallpaperFile(WallpaperManager.FLAG_SYSTEM) ?: return@runCatching false
      val input = context.contentResolver.openInputStream(file) ?: return@runCatching false
      input.use { stream ->
        File(context.filesDir, ORIGINAL_FILENAME).outputStream().use { output -> stream.copyTo(output) }
      }
      true
    }.getOrDefault(false)
    prefs.edit().putBoolean(KEY_ORIGINAL_CAPTURED, captured).apply()
  }

  private fun wallpaperId(manager: WallpaperManager, which: Int): Int? =
    runCatching { manager.getWallpaperId(which) }.getOrNull()?.takeIf { it >= 0 }

  private fun prefs(context: Context): SharedPreferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  private fun displaySize(context: Context): Point {
    val wm = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
    return if (Build.VERSION.SDK_INT >= 30) {
      val bounds = wm.currentWindowMetrics.bounds
      Point(bounds.width(), bounds.height())
    } else {
      val point = Point()
      @Suppress("DEPRECATION")
      wm.defaultDisplay.getRealSize(point)
      point
    }
  }
}
