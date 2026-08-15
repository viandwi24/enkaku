package dev.enkaku.guestagent.label

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.Typeface

/**
 * Draws the label bitmap on-device (plan 89 §3.4, §4.4; plan 90's Task B, the facet no step in
 * plan 90 assigned — see `ControlService.kt`'s `label.*` branches for the gap this closes). The
 * host sends `{ name, number }` as plain text; nothing on the host renders a byte of image, so
 * full Unicode support and exact per-device pixel geometry come for free (§3.4's argument for why
 * the device, not the host, draws this).
 *
 * Layout, per the owner's own specification (plan 89 §4.4, restated verbatim by plan 90's brief):
 * solid black background, pure white text, the device's name and its number centred, on two
 * lines — name above, number below, number the larger of the two. `showName == false` (a `null`
 * name) drops the name line entirely and enlarges the number for maximum legibility.
 */
object LabelRenderer {

  /** Fraction of `min(width, height)` used as the NAME line's cap height, when a name is drawn. */
  private const val NAME_FRACTION = 0.07f

  /** Fraction used for the NUMBER line's cap height, when a name is also drawn. */
  private const val NUMBER_FRACTION_WITH_NAME = 0.22f

  /** Fraction used for the NUMBER line when there is no name — legibility over layout (plan 89 §4.4). */
  private const val NUMBER_FRACTION_ALONE = 0.32f

  /**
   * The centred square text is constrained to, as a fraction of `min(width, height)`. A wallpaper
   * is cropped toward the centre when the orientation changes, so staying inside this square means
   * ONE bitmap serves both orientations — there is no separate landscape image (plan 89 §4.4).
   */
  private const val SAFE_FRACTION = 0.8f

  /** Vertical gap between the two lines, as a fraction of the short edge. */
  private const val LINE_GAP_FRACTION = 0.03f

  /**
   * Grapheme-cluster cap. The host is already expected to enforce this (plan 89 §4.4), but this
   * socket is reached by anything holding the pairing token, not only the host — the same
   * re-validate-on-the-wire reasoning `ControlService`'s other branches already use.
   */
  private const val MAX_NAME_CODE_POINTS = 24

  data class Label(val name: String?, val number: String)

  fun render(width: Int, height: Int, label: Label): Bitmap {
    val bitmap = Bitmap.createBitmap(width.coerceAtLeast(1), height.coerceAtLeast(1), Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    canvas.drawColor(Color.BLACK)

    val shortEdge = minOf(width, height).toFloat()
    val safeWidth = shortEdge * SAFE_FRACTION
    val name = label.name?.let { sanitise(it) }?.takeIf { it.isNotEmpty() }

    val numberFraction = if (name == null) NUMBER_FRACTION_ALONE else NUMBER_FRACTION_WITH_NAME
    val numberPaint = textPaint(shortEdge * numberFraction, bold = true)
    val namePaint = name?.let { textPaint(shortEdge * NAME_FRACTION, bold = false) }

    val numberLine = fit(label.number, numberPaint, safeWidth)
    val nameLine = name?.let { namePaint?.let { paint -> fit(it, paint, safeWidth) } }

    val gap = shortEdge * LINE_GAP_FRACTION
    val numberHeight = capHeight(numberPaint)
    val nameHeight = namePaint?.let { capHeight(it) } ?: 0f
    val totalHeight = numberHeight + if (nameLine != null) nameHeight + gap else 0f

    var y = height / 2f - totalHeight / 2f
    if (nameLine != null && namePaint != null) {
      y += nameHeight
      canvas.drawText(nameLine, width / 2f, y, namePaint)
      y += gap
    }
    y += numberHeight
    canvas.drawText(numberLine, width / 2f, y, numberPaint)

    return bitmap
  }

  private fun textPaint(targetCapHeightPx: Float, bold: Boolean): Paint {
    val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      color = Color.WHITE
      textAlign = Paint.Align.CENTER
      typeface = Typeface.create(Typeface.DEFAULT, if (bold) Typeface.BOLD else Typeface.NORMAL)
    }
    paint.textSize = capHeightToTextSize(targetCapHeightPx, paint)
    return paint
  }

  /**
   * `Paint.textSize` sizes roughly the em box, not the cap height an operator actually reads from
   * a metre away (plan 89 §4.4's "sized as a fraction of the panel" argument). Measures a capital
   * reference glyph once at a known size, then scales — good enough for the Latin/CJK/kana mix a
   * device name realistically contains; this is a display calibration, not a typographic claim.
   */
  private fun capHeightToTextSize(targetCapHeightPx: Float, paint: Paint): Float {
    val probeSize = 100f
    paint.textSize = probeSize
    val bounds = Rect()
    paint.getTextBounds("H", 0, 1, bounds)
    val measuredCapHeight = bounds.height().toFloat().coerceAtLeast(1f)
    return probeSize * (targetCapHeightPx / measuredCapHeight)
  }

  private fun capHeight(paint: Paint): Float {
    val bounds = Rect()
    paint.getTextBounds("H", 0, 1, bounds)
    return bounds.height().toFloat()
  }

  /**
   * Ellipsises [text] to fit [maxWidth] at [paint]'s current size — the agent is the only party
   * that can measure glyph widths for whatever the operator actually typed (plan 89 §4.4).
   */
  private fun fit(text: String, paint: Paint, maxWidth: Float): String {
    if (text.isEmpty() || paint.measureText(text) <= maxWidth) return text
    val ellipsis = "…"
    var end = text.length
    while (end > 0 && paint.measureText(text.substring(0, end) + ellipsis) > maxWidth) end--
    return if (end <= 0) ellipsis else text.substring(0, end) + ellipsis
  }

  /** Strips control characters/newlines and caps at [MAX_NAME_CODE_POINTS] code points (not UTF-16 units, so a name made of astral emoji is not cut mid-glyph). */
  private fun sanitise(name: String): String {
    val stripped = name.filter { it.code >= 0x20 && it != '\n' && it != '\r' }
    val builder = StringBuilder()
    var count = 0
    var index = 0
    while (index < stripped.length && count < MAX_NAME_CODE_POINTS) {
      val codePoint = stripped.codePointAt(index)
      builder.appendCodePoint(codePoint)
      index += Character.charCount(codePoint)
      count++
    }
    return builder.toString()
  }
}
