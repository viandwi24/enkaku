package dev.enkaku.guestagent.input

import android.content.Context
import android.inputmethodservice.InputMethodService
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.LayoutInflater
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.Button
import dev.enkaku.guestagent.R
import java.lang.ref.WeakReference
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * The farm's keyboard (plan 90 §3.2, §3.3, §4.2). An [InputMethodService] granted
 * `BIND_INPUT_METHOD` by the system with no `<uses-permission>` of our own — the same class of
 * system-granted binding [dev.enkaku.guestagent.route.RouteVpnService] already holds for
 * `BIND_VPN_SERVICE`.
 *
 * Nothing here is meant to be typed on by a human: every commit arrives over the control channel
 * from [TextFacet], reached by [dev.enkaku.guestagent.control.ControlService]'s
 * `text.commit`/`text.status` branches. But a human who is physically holding the phone while a
 * session is open still sees SOME keyboard the instant a field is focused — a keyboard with no
 * visible explanation is exactly the half-feature §3.2 warns against — so [onCreateInputView]
 * renders one explanatory line plus a "Switch keyboard" button that opens the system picker, the
 * same escape hatch [dev.enkaku.guestagent.StatusActivity]'s button offers.
 */
class EnkakuIme : InputMethodService() {

  /** True while an editor holds a live [android.view.inputmethod.InputConnection] to this service — [TextFacet.status]'s `connected`. */
  @Volatile private var connected = false

  override fun onCreateInputView(): View {
    val view = LayoutInflater.from(this).inflate(R.layout.ime_input_view, null)
    view.findViewById<Button>(R.id.ime_switch_keyboard_button).setOnClickListener {
      getSystemService(InputMethodManager::class.java)?.showInputMethodPicker()
    }
    return view
  }

  override fun onStartInputView(info: EditorInfo?, restarting: Boolean) {
    super.onStartInputView(info, restarting)
    connected = true
    active = WeakReference(this)
  }

  override fun onFinishInputView(finishingInput: Boolean) {
    super.onFinishInputView(finishingInput)
    connected = false
  }

  /**
   * MVP 08 §1.2's UHID side effect, answered on the device: when scrcpy creates a virtual hardware
   * keyboard, Android hides the soft keyboard, and an operator who wants to see it has no way to
   * ask. This is that way. Per device, applied here, persisted in SharedPreferences so it survives
   * the session that set it and the next reboot.
   */
  override fun onEvaluateInputViewShown(): Boolean =
    if (ImePrefs.showSoftKeyboardWithHardware(this)) true else super.onEvaluateInputViewShown()

  override fun onDestroy() {
    if (active?.get() === this) active = null
    super.onDestroy()
  }

  fun hasConnection(): Boolean = connected

  /**
   * Commits [chunk] through [getCurrentInputConnection], marshalled onto the main thread —
   * [android.view.inputmethod.InputConnection] is defined to be driven from the IME's own UI
   * thread, the same thread [onCreateInputView]/[onStartInputView] run on, and
   * [dev.enkaku.guestagent.control.ControlService] calls in from one of its own per-connection
   * worker threads (`serve()`), never this one. Returns `false` on a timeout or when there is
   * currently no connection to commit into (nothing focused) — [TextFacet] reads that as "0
   * committed", never throws it onward.
   */
  internal fun commitOnMainThread(chunk: String): Boolean {
    if (Looper.myLooper() == mainLooper) return commitNow(chunk)
    val latch = CountDownLatch(1)
    var result = false
    Handler(mainLooper).post {
      result = commitNow(chunk)
      latch.countDown()
    }
    return latch.await(COMMIT_TIMEOUT_MS, TimeUnit.MILLISECONDS) && result
  }

  private fun commitNow(chunk: String): Boolean {
    val ic = currentInputConnection ?: return false
    return ic.commitText(chunk, 1)
  }

  companion object {
    /**
     * [android.view.inputmethod.InputMethodInfo.getId] — the exact string `text.status` reports
     * (plan 90 §4.1) and [dev.enkaku.guestagent.StatusActivity] checks the enabled list for.
     */
    const val COMPONENT_ID = "dev.enkaku.guestagent/.input.EnkakuIme"
    private const val COMMIT_TIMEOUT_MS = 2_000L

    @Volatile private var active: WeakReference<EnkakuIme>? = null

    /**
     * The live instance, or `null` when the system has not created/bound one right now —
     * [TextFacet] reads this instead of queueing or waiting for one to appear (§4.2: "no
     * queueing, no waiting").
     */
    fun instance(): EnkakuIme? = active?.get()

    /**
     * Is this component the OS's selected default input method right now — the axis `ime set`
     * changes, and what `text.commit`'s `ime: 'current'|'not-current'` reports (plan 90 §4.1).
     * A plain settings read, independent of whether any field is currently focused.
     */
    fun isCurrent(context: Context): Boolean =
      Settings.Secure.getString(context.contentResolver, Settings.Secure.DEFAULT_INPUT_METHOD) == COMPONENT_ID

    /** Is this component present in the enabled list at all — `text.status`'s `'enabled'` vs `'disabled'` (plan 90 §4.1). */
    fun isEnabled(context: Context): Boolean =
      context.getSystemService(InputMethodManager::class.java)
        ?.enabledInputMethodList?.any { it.id == COMPONENT_ID } == true
  }
}
