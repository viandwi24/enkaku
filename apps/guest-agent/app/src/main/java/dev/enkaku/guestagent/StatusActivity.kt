package dev.enkaku.guestagent

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dev.enkaku.guestagent.control.Pairing
import dev.enkaku.guestagent.route.RouteState
import dev.enkaku.guestagent.theme.EnkakuGuestAgentTheme

/**
 * The only screen a human ever sees, reached by tapping the launcher icon.
 *
 * It is deliberately separate from [BootstrapActivity]. Both jobs used to live in one activity, so
 * every machine-driven bootstrap — which the host does on provisioning and lazily on reconnect —
 * flashed a window in front of whoever was remotely driving the device. Splitting them means the
 * shim can be invisible (`Theme.NoDisplay`) while this stays a normal, visible screen.
 */
class StatusActivity : ComponentActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    enableEdgeToEdge()
    setContent {
      EnkakuGuestAgentTheme {
        Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
          StatusScreen(paired = Pairing.hasToken(), routeUp = RouteState.isUp())
        }
      }
    }
  }
}

@Composable
private fun StatusScreen(paired: Boolean, routeUp: Boolean) {
  Column(
    modifier = Modifier.fillMaxSize().padding(24.dp),
    verticalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterVertically),
    horizontalAlignment = Alignment.CenterHorizontally,
  ) {
    Text(text = "Enkaku guest agent", style = MaterialTheme.typography.titleLarge)
    Text(
      text = when {
        routeUp -> "Routing this device's traffic through a test proxy."
        paired -> "Paired with a farm host. No route is active."
        else -> "Idle — no host has paired yet."
      },
      style = MaterialTheme.typography.bodyMedium,
    )
    Text(
      text = "This device is managed by an Enkaku device farm. The app has no controls; " +
        "everything is driven by the host over adb.",
      style = MaterialTheme.typography.bodySmall,
    )
  }
}
