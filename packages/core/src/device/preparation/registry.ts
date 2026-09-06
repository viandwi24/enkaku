import type { UiServerExpectedArtifact } from '@enkaku/drivers'
import type { Logger } from '../../util/logger'
import { createAdbVerifierComponent } from './adb-verifier-component'
import { createUiServerComponent } from './ui-server-component'
import type { PreparationComponent } from './types'

export interface PreparationRegistryDeps {
  exec: (serial: string, cmd: string) => Promise<{ stdout: string; stderr: string; exitCode: number | null }>
  hostAdb: (args: string[], opts?: { lane?: 'default' | 'install'; serial?: string }) => Promise<string>
  uiServerApkPaths: () => Promise<{ app: string; test: string }>
  uiServerExpectedArtifact: () => Promise<UiServerExpectedArtifact | null>
  /** Plan 106 §5 step 106.8 — see `ui-server-component.ts`'s own `UiServerComponentDeps.installApk` doc comment. Optional; falls back to `hostAdb` (the pre-106.8 path) when absent. */
  installApk?: (deviceId: string, localPath: string, label: 'app' | 'test', packageName: string) => Promise<void>
  /**
   * `advanced.disableAdbInstallVerifier`, mapped to the component's own
   * vocabulary — see `adb-verifier-component.ts`. Read fresh on every pass so
   * flipping the setting takes effect without a restart. Optional; absent
   * means `keep`, the conservative reading for a caller with no settings
   * store to hand it (a unit test, say) rather than the farm default.
   */
  adbInstallVerifier?: () => 'keep' | 'disable'
  log: Logger
}

/**
 * The component roster (plan 106 §3.2, §4). `ui-server` was the roster's
 * first real entry (G3 — it had no per-device state at all before that
 * plan); `adb-verifier` was added later and runs ahead of it. See
 * `types.ts`'s own doc comment for why `guest-agent` and `scrcpy-server`
 * are NOT here yet/ever. Adding a future component is one more call in this
 * array — not a new subsystem, not a schema change, not a new runner.
 *
 * ORDER MATTERS: `runner.ts`'s `ensureImpl` walks this array in sequence for
 * one device, so `adb-verifier` goes first — turning Play Protect's
 * adb-install check off is only worth anything BEFORE the same pass installs
 * the `ui-server` pair. A farm that has turned that setting off gets an
 * `unsupported` row instead, and the device is never touched.
 */
export function createPreparationRegistry(deps: PreparationRegistryDeps): PreparationComponent[] {
  return [
    createAdbVerifierComponent({
      exec: deps.exec,
      policy: deps.adbInstallVerifier ?? (() => 'keep'),
      log: deps.log,
    }),
    createUiServerComponent({
      exec: deps.exec,
      hostAdb: deps.hostAdb,
      apkPaths: deps.uiServerApkPaths,
      expectedArtifact: deps.uiServerExpectedArtifact,
      installApk: deps.installApk,
      log: deps.log,
    }),
  ]
}
