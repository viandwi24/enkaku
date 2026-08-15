package dev.enkaku.guestagent

import android.os.Bundle
import android.app.Activity
import android.view.inputmethod.InputMethodManager
import android.widget.Button
import android.widget.TextView
import android.widget.Toast
import dev.enkaku.guestagent.control.Pairing
import dev.enkaku.guestagent.route.RouteState

/**
 * The only screen a human ever sees, reached by tapping the launcher icon.
 *
 * It is deliberately separate from [BootstrapActivity]. Both jobs used to live in one activity, so
 * every machine-driven bootstrap — which the host does on provisioning and lazily on reconnect —
 * flashed a window in front of whoever was remotely driving the device. Splitting them means the
 * shim can be invisible (`Theme.NoDisplay`) while this stays a normal, visible screen.
 *
 * A plain [Activity] with a hand-written layout (`res/layout/activity_status.xml`), not Compose:
 * this screen draws three `TextView`s and a button, and Compose plus its material3/tooling/
 * lifecycle-compose dependency graph was 21.3 MB of the 21.7 MB release APK for exactly that
 * (plan 90 §3.11, F1/F3). `BootstrapActivity` already made this same choice.
 */
class StatusActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContentView(R.layout.activity_status)

    findViewById<TextView>(R.id.state_line).text = stateLine(paired = Pairing.hasToken(), routeUp = RouteState.isUp())

    findViewById<Button>(R.id.switch_keyboard_button).setOnClickListener { onSwitchKeyboardClicked() }
  }

  /**
   * Opens the system keyboard picker so a human physically holding the phone can switch to the
   * Enkaku keyboard — but only when it is actually there to switch to. [dev.enkaku.guestagent.input.EnkakuIme]
   * is added by a later step (plan 90 §90.5); until then, or on a build where the host has not yet
   * run `ime enable` for it, this must say so rather than opening a picker with nothing useful in
   * it or throwing. A dead button with no explanation is exactly the half-feature plan 90 §3.2
   * exists to avoid.
   */
  private fun onSwitchKeyboardClicked() {
    val imm = getSystemService(InputMethodManager::class.java)
    val available = imm?.enabledInputMethodList?.any { it.id == ENKAKU_IME_ID } == true
    if (available) {
      imm?.showInputMethodPicker()
    } else {
      Toast.makeText(this, R.string.keyboard_not_available, Toast.LENGTH_LONG).show()
    }
  }

  private fun stateLine(paired: Boolean, routeUp: Boolean): String =
    when {
      routeUp -> getString(R.string.state_routing)
      paired -> getString(R.string.state_paired_no_route)
      else -> getString(R.string.state_idle)
    }

  companion object {
    /** [android.view.inputmethod.InputMethodInfo.getId] — matches `text.status`'s documented `id` (plan 90 §4.1). */
    private const val ENKAKU_IME_ID = "dev.enkaku.guestagent/.input.EnkakuIme"
  }
}
