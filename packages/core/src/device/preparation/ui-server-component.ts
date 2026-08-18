import {
  createUiServerLauncher,
  UI_SERVER_PACKAGE,
  verifyDeviceArtifact,
  type UiServerArtifactMismatch,
  type UiServerExpectedArtifact,
} from '@enkaku/drivers'
import type { DeviceRow } from '../../db/schema'
import type { Logger } from '../../util/logger'
import { EnkakuError } from '../../util/errors'
import type { PreparationComponent, PreparationRunResult } from './types'

/**
 * `ui-server` as a registry entry (plan 106 §3.2, §4, G3) — the on-device
 * openatx APK pair that `packages/session/src/inspector-factory.ts` already
 * installs lazily, per session, with no persisted per-device record of
 * whether the LAST attempt worked. This gives it the same visible,
 * retryable state the guest agent already had (G1/G3): nothing here changes
 * how a session itself starts the inspector — `ensureInstalled()` is the
 * SAME idempotent verify/install/repair call `inspector-factory.ts` makes,
 * just also run proactively on admission/reconnect/demand instead of only
 * the first time a session needs it.
 */
export interface UiServerComponentDeps {
  /** Per-device shell exec, through the adb queue — same shape `agent-provisioner.ts`'s own `exec` dep uses. */
  exec: (serial: string, cmd: string) => Promise<{ stdout: string; stderr: string; exitCode: number | null }>
  /** CLI-level adb (install/uninstall/forward), the SAME bounded `hostAdbHandle.run` the guest agent's own provisioner is wired to. */
  hostAdb: (args: string[], opts?: { lane?: 'default' | 'install'; serial?: string }) => Promise<string>
  apkPaths: () => Promise<{ app: string; test: string }>
  expectedArtifact: () => Promise<UiServerExpectedArtifact | null>
  /**
   * Plan 106 §5 step 106.8 (§9 Q5's recommendation, now built) — when
   * supplied, each APK install (app, then test) is routed through the SAME
   * transfer machinery `POST /api/devices/:id/install` uses (`runTransfer`,
   * G6: a real transferId, real byte progress, and a staged-file cleanup
   * that runs on every exit path — `daemon.ts`'s own wiring comment has the
   * full reasoning) instead of one opaque `hostAdb install` call with
   * nothing reported until it resolves. Optional and falls back to the raw
   * `hostAdb install` path (`createUiServerLauncher`'s own default) when
   * absent — e.g. a unit test that only fakes `hostAdb`, or a future caller
   * that has no `TransferService` to hand it.
   */
  installApk?: (deviceId: string, localPath: string, label: 'app' | 'test', packageName: string) => Promise<void>
  log: Logger
}

export function createUiServerComponent(deps: UiServerComponentDeps): PreparationComponent {
  return {
    id: 'ui-server',
    label: 'UI server (openatx)',

    // No known SDK floor for this component today (unlike the guest agent's
    // `MIN_SUPPORTED_SDK`) — always applicable. This branch exists in the
    // shared type/runner for a FUTURE component that DOES have one; see
    // `registry.test.ts`'s synthetic "unsupported" component for proof the
    // mechanism works generically, not only for the one entry that needs it
    // today.
    applicable() {
      return true
    },
    unsupportedReason() {
      return 'ui-server has no minimum Android version'
    },

    async run(row: DeviceRow): Promise<PreparationRunResult> {
      const serial = row.serial
      const execFor = (cmd: string): Promise<string> => deps.exec(serial, cmd).then((r) => r.stdout)

      let expectedArtifact: UiServerExpectedArtifact | undefined
      try {
        expectedArtifact = (await deps.expectedArtifact()) ?? undefined
      } catch (err) {
        // Reading the manifest expectation itself failed — degrade
        // honestly (agent-provisioner.ts's `runOnePass` follows the exact
        // same rule for its own `expectedArtifact()` call).
        return { state: 'failed', version: null, reason: err instanceof Error ? err.message : String(err) }
      }

      const mismatch: { current: UiServerArtifactMismatch | null } = { current: null }
      const launcher = createUiServerLauncher({
        serial,
        exec: execFor,
        hostAdb: deps.hostAdb,
        apkPaths: deps.apkPaths,
        expectedArtifact,
        installApk: deps.installApk ? (localPath, label, packageName) => deps.installApk!(row.id, localPath, label, packageName) : undefined,
        onMismatch: (info) => {
          mismatch.current = info
        },
        // This component only ever calls `ensureInstalled()` — never
        // `start()`/`stop()`, so the instrumentation stream is never
        // touched by a preparation pass. A real session's own
        // `inspector-factory.ts` supplies the live `execStream`; this one
        // throws if ever reached, as proof it never is.
        execStream: () => {
          throw new Error('ui-server preparation component does not start the instrumentation')
        },
        onLog: (level, msg) => deps.log[level](`preparation(ui-server): ${msg}`),
      })

      try {
        await launcher.ensureInstalled()
      } catch (err) {
        // §96.25 fix 2's rule, generalised (plan 106 §3.3): a core-side
        // `E_ADB_UNAVAILABLE` is rethrown UNCHANGED so the runner defers the
        // whole pass rather than scoring it as a device failure.
        if (err instanceof EnkakuError && err.code === 'E_ADB_UNAVAILABLE') throw err
        const reason = err instanceof Error ? err.message : String(err)
        const seen = mismatch.current
        if (seen && (seen.reason === 'version_mismatch' || seen.reason === 'signature_mismatch')) {
          return { state: 'outdated', version: seen.observed?.versionCode != null ? String(seen.observed.versionCode) : null, reason }
        }
        return { state: 'failed', version: null, reason }
      }

      // Installed and matching (or verification was skipped as unreadable —
      // `ensureInstalled()` itself already treats that as success). Read the
      // version once more purely for display — a failure here must not
      // fail an otherwise-successful pass over a details-only read.
      try {
        const verify = await verifyDeviceArtifact(execFor, { packageName: UI_SERVER_PACKAGE, ...expectedArtifact })
        return { state: 'ready', version: verify.ok ? String(verify.versionCode) : null, reason: null }
      } catch (err) {
        if (err instanceof EnkakuError && err.code === 'E_ADB_UNAVAILABLE') throw err
        return { state: 'ready', version: null, reason: null }
      }
    },
  }
}
