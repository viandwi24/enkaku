import type { DeviceRow } from '../../db/schema'
import type { Logger } from '../../util/logger'
import { EnkakuError } from '../../util/errors'
import type { PreparationComponent, PreparationRunResult } from './types'

/**
 * The `@hide` global that decides whether an `adb install` is handed to Play
 * Protect for a verdict. Undocumented by Google; the name and its default of
 * `1` are read off AOSP (`docs/research/android-guest-agent.md` §6).
 */
export const ADB_INSTALL_VERIFIER_SETTING = 'verifier_verify_adb_installs'

/** What `settings get global` prints for a key that was never written. */
const UNSET_VALUES = new Set(['', 'null'])

/** Only a literal `0` means the verifier is off — an unset key still verifies, because the platform default is 1. */
function isDisabled(value: string): boolean {
  return value === '0'
}

export interface AdbVerifierComponentDeps {
  /** Per-device shell exec, through the adb queue — the same shape every other component's `exec` dep uses. */
  exec: (serial: string, cmd: string) => Promise<{ stdout: string; stderr: string; exitCode: number | null }>
  /**
   * `ADB_INSTALL_VERIFIER`, read through a function so a test can drive both
   * policies without reaching into module-load environment state.
   */
  policy: () => 'keep' | 'disable'
  log: Logger
}

/**
 * Turns Android's adb-install verifier off on one device (opt-in).
 *
 * Why this is a preparation component rather than a step hidden inside an
 * installer: it is per-device, it can fail per-device, and an operator has
 * to be able to SEE that it failed — which is exactly the visible, bounded,
 * retryable state the registry already gives every other component (plan
 * 106 §3.2). It is registered FIRST in `registry.ts` so the verifier is off
 * before the `ui-server` pair is installed in the same pass.
 *
 * What it does NOT cover: `agent-provisioner.ts` runs its own sweep, not
 * this registry, and the two boot sweeps in `daemon.ts` are both
 * fire-and-forget, so a device meeting Enkaku for the very first time may
 * still install the guest agent before this component has run. That has not
 * mattered in the field — the guest agent is not a binary Play Protect
 * holds a verdict on — and the setting is persistent, so every later
 * install on that device is covered.
 */
export function createAdbVerifierComponent(deps: AdbVerifierComponentDeps): PreparationComponent {
  return {
    id: 'adb-verifier',
    label: 'Play Protect install check',

    applicable() {
      return deps.policy() === 'disable'
    },
    unsupportedReason() {
      return `Enkaku leaves this device's install verifier as the device shipped it — set ENKAKU_ADB_INSTALL_VERIFIER=disable to turn Play Protect's adb-install check off farm-wide`
    },

    async run(row: DeviceRow): Promise<PreparationRunResult> {
      const read = async (): Promise<string> => (await deps.exec(row.serial, `settings get global ${ADB_INSTALL_VERIFIER_SETTING}`)).stdout.trim()

      try {
        const before = await read()
        if (isDisabled(before)) return { state: 'ready', version: 'off', reason: null }

        deps.log.info(`preparation(adb-verifier): ${ADB_INSTALL_VERIFIER_SETTING} reads ${JSON.stringify(before)} on ${row.serial} — turning it off`)
        const put = await deps.exec(row.serial, `settings put global ${ADB_INSTALL_VERIFIER_SETTING} 0`)

        // The readback is what decides, never `put`'s exit code: `settings
        // put` is cheerful about writes it did not make, and this is the
        // one component whose whole job is a value the device has to agree
        // it now holds (the same rule `grant-fallback.ts` follows for
        // `pm grant`).
        const after = await read()
        if (isDisabled(after)) return { state: 'ready', version: 'off', reason: null }

        const said = [put.stderr.trim(), put.stdout.trim()].filter(Boolean).join(' ')
        const because = said ? ` — the device said: ${said}` : ''
        const unset = UNSET_VALUES.has(after) ? ' (the key reads unset, which the platform treats as 1)' : ''
        return {
          state: 'failed',
          version: null,
          reason: `${ADB_INSTALL_VERIFIER_SETTING} still reads ${JSON.stringify(after)} after being set to 0${unset}${because}`,
        }
      } catch (err) {
        // §96.25 fix 2's rule, generalised (plan 106 §3.3): a core-side
        // `E_ADB_UNAVAILABLE` is rethrown UNCHANGED so the runner defers the
        // pass rather than scoring it as a device failure.
        if (err instanceof EnkakuError && err.code === 'E_ADB_UNAVAILABLE') throw err
        return { state: 'failed', version: null, reason: err instanceof Error ? err.message : String(err) }
      }
    },
  }
}
