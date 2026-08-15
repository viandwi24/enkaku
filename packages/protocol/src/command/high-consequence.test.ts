import { describe, expect, test } from 'bun:test'
import { isHighConsequence } from './high-consequence'

/**
 * The confirmation dialog's patterns (plan 26 §3.4).
 *
 * This is a usability guard, never a security control — the server does not
 * know the list exists. Which is exactly why the false-positive direction
 * matters more than the false-negative one: a dialog that interrupts an
 * everyday command teaches operators to dismiss every dialog, and the one that
 * mattered goes with it.
 *
 * `am start -a android.intent.action.VIEW -d <url>` was flagged for months
 * because the pattern matched any bare "start" between spaces. Opening a page
 * is not a device-wide act.
 */

describe('isHighConsequence — commands that must NOT interrupt anyone', () => {
  for (const cmd of [
    'am start -a android.intent.action.VIEW -d https://whoer.net',
    'am start -n com.example/.MainActivity',
    'am force-stop com.example',
    'pm list packages',
    'dumpsys battery',
    'input keyevent KEYCODE_WAKEUP',
    // plan 93 §3.14 — must not fire on read-only pm subcommands neighbouring
    // `pm uninstall`/`pm clear`.
    'pm path com.example',
    'pm dump com.example',
  ]) {
    test(cmd, () => expect(isHighConsequence(cmd).hit).toBe(false))
  }
})

describe('isHighConsequence — commands that must still ask', () => {
  for (const cmd of [
    'reboot',
    'svc power stayon true',
    'settings put global adb_enabled 0',
    'rm -rf /sdcard',
    // Android's own framework restart, as a command in its own right.
    'stop',
    'start',
    'stop; start',
    'setprop ctl.restart zygote && stop',
    // plan 93 §3.14 — irreversible; takes the app's data with it.
    'pm uninstall com.example',
    'cmd package uninstall com.example',
    'pm clear com.example',
  ]) {
    test(cmd, () => expect(isHighConsequence(cmd).hit).toBe(true))
  }
})
