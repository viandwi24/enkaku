import type { AdbSwapHook } from '@enkaku/toolchain'
import type { AdbServerControl } from './adb-server-control'

/**
 * Koordinator swap versi adb (plan 02 §4.11).
 *
 * Plan 88 §3.10: a thin wrapper around the shared `AdbServerControl.cycle()`
 * — the version swap and the operator's "Restart adb server" button
 * (`tools/routes.ts`'s `POST /adb/restart`) are the same seven steps
 * (drain → stop → [swap the binary pointer] → start → restart the tracker →
 * resume the queue → reattach remembered network addresses → reconcile),
 * through the exact same `control` instance and its one mutex, so a swap and
 * a restart can never interleave. `adb-server-control.ts` is the ONLY file
 * in the workspace that runs `kill-server` (spec §10.4) — this file no
 * longer does.
 *
 * `AdbSwapHook`'s shape (`@enkaku/toolchain`) is unchanged, so the
 * Toolchain Manager needed no edit for this.
 */
export function createAdbSwapCoordinator(control: AdbServerControl): AdbSwapHook {
  return {
    async swap(oldBinaryPath, newBinaryPath, commit) {
      await control.cycle({ reason: 'swap', oldBinaryPath, newBinaryPath, commit })
    },
  }
}
