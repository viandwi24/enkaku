package dev.enkaku.guestagent

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import dev.enkaku.guestagent.control.ControlService

/**
 * Brings the control channel back after a reboot.
 *
 * This only ever fires if the host has launched [BootstrapActivity] at least once: a freshly
 * installed app sits in the stopped state and receives no broadcasts at all, BOOT_COMPLETED
 * included. See docs/research/android-guest-agent.md §1.3.
 *
 * Starting a foreground service from here is legal — BOOT_COMPLETED is a documented exemption from
 * the Android 12+ background-start restriction, and `specialUse` is not among the types Android 15
 * forbids a boot receiver from starting.
 *
 * The service comes up unpaired: the token lives in memory only, so the host must re-bootstrap
 * before it can issue requests. That is deliberate — a token surviving a reboot would be a
 * credential nobody can revoke.
 */
class BootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    when (intent.action) {
      Intent.ACTION_BOOT_COMPLETED,
      Intent.ACTION_LOCKED_BOOT_COMPLETED,
      Intent.ACTION_MY_PACKAGE_REPLACED -> ControlService.start(context, token = null)
    }
  }
}
