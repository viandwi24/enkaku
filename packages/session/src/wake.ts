import type { KeepAwakeMode, Transport } from '@enkaku/protocol'
import type { Logger } from './logger'

/**
 * `svc power stayon` accepts `true|false|usb|ac|wireless`; `usb` only holds
 * the screen while plugged into USB, which does nothing for a device attached
 * over `adb-tcp` (Plan 17 §3.4).
 */
export const STAYON: Record<KeepAwakeMode, string> = {
  off: 'false',
  'while-charging': 'usb',
  always: 'true',
}

/**
 * Wake the screen and hold it awake (Plan 17 §3.4, extracted by Plan 43 §5
 * step 43.2 so there is ONE implementation, not two): `createSession` calls
 * this at the start of every session, and the readiness manager
 * (`packages/core/src/device/readiness.ts`) calls it to reconcile a device
 * toward `desired: 'awake'` without opening a session at all.
 *
 * `off` is a no-op, same as the old inline `stayAwake: false` did — a device
 * opted out keeps opting out unchanged (Plan 17 §4.2).
 *
 * The keyevent 82 dismisses a swipe-only lock screen. A device with a PIN,
 * pattern, or password cannot be unlocked from here, and will keep showing
 * its lock screen; that is a real limit, not a failure to handle (Plan 43 §2,
 * `blocked: 'locked'`).
 */
export async function wakeDevice(transport: Transport, opts: { keepAwake: KeepAwakeMode; log: Logger }): Promise<void> {
  const { keepAwake, log } = opts
  if (keepAwake === 'off') return
  for (const cmd of ['input keyevent KEYCODE_WAKEUP', `svc power stayon ${STAYON[keepAwake]}`]) {
    await transport.exec(cmd, { profile: 'probe' }).catch((err) => log.debug(`${cmd} failed: ${String(err)}`))
  }
  // Only nudge the lock screen when there is one. KEYCODE_MENU dismisses a
  // swipe-only keyguard, but on a phone that is already unlocked it opens the
  // launcher's wallpaper/widget menu — and the user's next tap just closes
  // that menu instead of hitting the app they aimed at.
  const locked = await transport
    .exec('dumpsys window | grep -m1 isKeyguardShowing', { profile: 'probe' })
    .then((out) => /isKeyguardShowing=true/.test(out))
    .catch(() => false)
  if (locked) {
    await transport.exec('input keyevent 82', { profile: 'probe' }).catch((err) => log.debug(`keyguard nudge failed: ${String(err)}`))
  }
}
