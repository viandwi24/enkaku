package dev.enkaku.guestagent

import android.content.Intent
import android.os.Bundle
import android.app.Activity
import dev.enkaku.guestagent.control.ControlService

/**
 * The host's entry point into this app: an invisible shim that hands a token to [ControlService]
 * and finishes. It draws nothing — see `Theme.NoDisplay` on it in the manifest.
 *
 * Why it must exist, and must be exported:
 *  - `adb shell am` cannot reach a component declared `exported="false"` (only root and system
 *    bypass the export check), so an unexported entry point is unreachable from the farm.
 *  - A freshly installed app sits in the stopped state and receives NO broadcasts at all,
 *    BOOT_COMPLETED included; launching this once after install is what clears that state.
 *
 * Why it draws nothing: the host bootstraps on provisioning and again lazily whenever it needs to
 * reach the agent, so anything visible here flashes a window in front of whoever is remotely
 * driving the device. The human-facing screen is [StatusActivity], behind the launcher icon.
 *
 * `singleTop` (manifest) plus [onNewIntent] are both required: under the default launch mode an
 * `am start` aimed at an activity already on top merely brings its task forward — neither
 * `onCreate` nor `onNewIntent` runs — so the first token would stick forever and every later one
 * would be dropped, leaving the agent answering `E_UNAUTHORISED`.
 */
class BootstrapActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    handOver(intent)
    finish()
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    handOver(intent)
    finish()
  }

  private fun handOver(intent: Intent?) {
    ControlService.start(this, intent?.getStringExtra(EXTRA_TOKEN))
  }

  companion object {
    const val EXTRA_TOKEN = "token"
  }
}
