import type { AdbStreamEndReason } from '@enkaku/adb'
import type { TransportExecOptions } from '@enkaku/protocol'
import { verifyDeviceArtifact } from './verify'

/** The pinned openatx APK package and component (plan 06 §3.2/§4.6). */
export const UI_SERVER_PACKAGE = 'com.github.uiautomator'
export const UI_SERVER_TEST_PACKAGE = 'com.github.uiautomator.test'
export const UI_SERVER_INSTRUMENTATION = `${UI_SERVER_TEST_PACKAGE}/androidx.test.runner.AndroidJUnitRunner`
/**
 * The stub lives in the APP package under `stub` — NOT in the test package.
 * `com.github.uiautomator.test.Stub` throws ClassNotFoundException on the
 * pinned APK (v2.3.3), which is why this inspector silently fell back to
 * `uiautomator dump` from M4.5 until Plan 34 (§3.1) — measured on a real
 * device: the wrong class fails in ~1.3s with
 * `INSTRUMENTATION_STATUS: stack=java.lang.ClassNotFoundException:
 * com.github.uiautomator.test.Stub`; the corrected class makes port 9008
 * start listening and the command then hang, which is intended (§3.2).
 */
export const UI_SERVER_STUB_CLASS = `${UI_SERVER_PACKAGE}.stub.Stub`
/** The openatx server listens on this fixed port on the device. */
export const UI_SERVER_DEVICE_PORT = 9008

/** What the toolchain manifest expects to find on the device for this build of the ui-server APK (plan 41 §3.2, §4.1). Absent fields are simply not compared. */
export interface UiServerExpectedArtifact {
  versionCode?: number
  signatureSha256?: string
}

/**
 * Reported once, when a repair attempt still leaves the artifact mismatched
 * (plan 41 §3.3). `not_installed` is included alongside the two mismatch
 * reasons because the repair path re-verifies after `installBoth()` — if
 * that install itself did not stick (e.g. `adb install` reported success but
 * the package manager silently dropped it), that is just as much "the
 * repair did not work" as a version/signature mismatch.
 */
export interface UiServerArtifactMismatch {
  reason: 'not_installed' | 'version_mismatch' | 'signature_mismatch'
  observed?: { versionCode?: number; signature?: string }
}

export interface UiServerLauncherDeps {
  serial: string
  /** Per-device shell exec (through the Plan 01 queue) — everything EXCEPT the instrumentation itself (see `execStream` below). */
  exec: (cmd: string, opts?: TransportExecOptions) => Promise<string>
  /**
   * `adb forward` and `install` need CLI-level adb, supplied by the core.
   * Installs pass `{ lane: 'install', serial }` so the core's bounded
   * host-adb helper (plan 85 §3.4, §4.5) can serialise them per device AND
   * apply the farm's `adb.maxInstallConcurrent` cap — a fleet attaching
   * inspectors at once would otherwise fire two unbounded `pm install`
   * commands per device, all at once, across every device (H5).
   */
  hostAdb: (args: string[], opts?: { lane?: 'default' | 'install'; serial?: string }) => Promise<string>
  /** APK path from the Toolchain Manager. */
  apkPaths: () => Promise<{ app: string; test: string }>
  /**
   * The manifest's on-device expectation for the app APK (plan 41 §3.2) —
   * `undefined`/empty when the manifest carries none, in which case
   * `ensureInstalled()` only verifies that SOMETHING named `UI_SERVER_PACKAGE`
   * is installed and never blocks the inspector on missing metadata of our own.
   */
  expectedArtifact?: UiServerExpectedArtifact
  /**
   * Called at most once per `ensureInstalled()` call, and only when a single
   * uninstall-reinstall-reverify cycle still leaves the artifact mismatched
   * (plan 41 §3.3) — the caller's cue to record `device.artifact.mismatch`
   * on the Plan 18 main stream. `ensureInstalled()` still throws afterward so
   * the session falls back to `uiautomator-dump`; this callback exists purely
   * for observability, not for control flow.
   */
  onMismatch?: (info: UiServerArtifactMismatch) => void
  /**
   * Long-lived commands: the Plan 24 streaming lane, never the per-device
   * queue (plan 34 §3.2, §4.1) — `am instrument -w` never returns while the
   * server is healthy, so routing it through `exec`'s `PerDeviceQueue` would
   * park a queue slot (and, before this plan, a 15s timeout) for as long as
   * the session lives. The caller (`inspector-factory.ts`) is expected to
   * bind this to `AdbClient.execStream` with BOTH stream clocks disabled
   * (`idleTimeoutMs: 0`, `absoluteTimeoutMs: 0`) — the instrumentation is
   * silent once up and must live as long as the session, not the lane's
   * default idle/absolute budgets.
   */
  execStream: (
    cmd: string,
    opts: { onEnd: (reason: AdbStreamEndReason, err?: unknown) => void },
  ) => Promise<{ stop: () => Promise<void> }>
  onLog?: (level: 'debug' | 'info' | 'warn', msg: string) => void
}

export interface UiServerLauncher {
  ensureInstalled(): Promise<void>
  start(localPort: number): Promise<void>
  stop(localPort: number): Promise<void>
  isInstalled(): Promise<boolean>
  /**
   * Re-issues `adb forward` for an ALREADY-RUNNING instrumentation, without
   * touching install state or the instrumentation stream (plan 85 §3.5,
   * fixes F18's real cause): `adb forward` entries do not survive a
   * ui-server restart, so a client `fetch` holding a pooled keep-alive
   * connection to the old forward fails with "the socket connection was
   * closed unexpectedly" rather than a clean refusal. `UiServerClient` calls
   * this at most once per failed request, right before its one retry.
   */
  reassertForward(localPort: number): Promise<void>
}

/**
 * On-device server lifecycle: install the APKs (app and test), run them as
 * the instrumentation, forward the port. `am instrument` is used because it
 * is the only sanctioned way to reach the UiAutomator2 API — which means the process
 * gampang di-kill sistem, ditangani watchdog.
 */
export function createUiServerLauncher(deps: UiServerLauncherDeps): UiServerLauncher {
  // The running instrumentation's stream handle, so `stop()` can tear it
  // down explicitly rather than relying only on `am force-stop` (plan 34
  // §4.1) — set on a successful `start()`, cleared on `onEnd` or `stop()`.
  let instrumentation: { stop: () => Promise<void> } | null = null

  const expectation = () => ({ packageName: UI_SERVER_PACKAGE, ...deps.expectedArtifact })

  const installBoth = async (): Promise<void> => {
    const { app, test } = await deps.apkPaths()
    deps.onLog?.('info', `installing the ui-server APKs on ${deps.serial}`)
    // -g auto-grants runtime permissions; -r replaces a different version.
    // `lane: 'install'` (plan 85 §3.4, §5 step 85.3, tests H5): these two
    // installs for the SAME device never run concurrently with each other,
    // nor with more than `adb.maxInstallConcurrent` installs farm-wide.
    await deps.hostAdb(['-s', deps.serial, 'install', '-r', '-g', app], { lane: 'install', serial: deps.serial })
    await deps.hostAdb(['-s', deps.serial, 'install', '-r', '-g', test], { lane: 'install', serial: deps.serial })
  }

  /**
   * `adb forward` plus the ownership check below (plan 34 §4.1's port-races
   * note). Shared between `start()` and `reassertForward()` (plan 85 §3.5)
   * so the client's stale-forward retry re-issues EXACTLY the same forward
   * `start()` would have, not a second, slightly different implementation.
   */
  const assertForward = async (localPort: number): Promise<void> => {
    await deps.hostAdb(['-s', deps.serial, 'forward', `tcp:${localPort}`, `tcp:${UI_SERVER_DEVICE_PORT}`])

    // A host port belongs to one device. Every phone's ui-server listens on
    // the same device port, so a host port that another device already holds
    // gets silently rebound and this inspector would answer with the OTHER
    // phone's screen. Throwing here drops us to the uiautomator-dump
    // fallback, which is slow but at least reads the right device.
    const list = await deps.hostAdb(['forward', '--list'])
    const owner = list
      .split('\n')
      .map((line) => line.trim().split(/\s+/))
      .find(([, local]) => local === `tcp:${localPort}`)
    if (!owner || owner[0] !== deps.serial) {
      throw new Error(
        `tcp:${localPort} is bound to ${owner?.[0] ?? 'nothing'}, not to ${deps.serial} — refusing to inspect another device`,
      )
    }
    deps.onLog?.('debug', `forward tcp:${localPort} → device tcp:${UI_SERVER_DEVICE_PORT}`)
  }

  return {
    async isInstalled() {
      const result = await verifyDeviceArtifact(deps.exec, { packageName: UI_SERVER_PACKAGE })
      return result.ok
    },

    /**
     * Verify → (not installed → install) → (mismatch → uninstall, reinstall,
     * re-verify ONCE) → (still mismatched → report and stop). Plan 41 §3.3:
     * looping on a device where something keeps reinstalling a conflicting
     * package would burn farm time forever, so this makes exactly one repair
     * attempt and then degrades visibly (throws, so the session falls back
     * to `uiautomator-dump`).
     */
    async ensureInstalled() {
      const expected = expectation()
      if (expected.versionCode === undefined && expected.signatureSha256 === undefined) {
        deps.onLog?.(
          'info',
          `no versionCode/signature expectation recorded for ${UI_SERVER_PACKAGE} — verifying installed presence only (plan 41 §3.2)`,
        )
      }

      let result = await verifyDeviceArtifact(deps.exec, expected)
      if (result.ok) return

      if (result.reason === 'not_installed') {
        await installBoth()
        return
      }
      if (result.reason === 'unreadable') {
        deps.onLog?.(
          'warn',
          `could not read ${UI_SERVER_PACKAGE}'s installed version/signature on ${deps.serial} — skipping artifact verification for this session`,
        )
        return
      }

      // version_mismatch or signature_mismatch: repair exactly once (§3.3).
      deps.onLog?.(
        'warn',
        `${UI_SERVER_PACKAGE} on ${deps.serial} is ${result.reason} (observed ${JSON.stringify(result.observed ?? {})}) — reinstalling`,
      )
      await deps.hostAdb(['-s', deps.serial, 'uninstall', UI_SERVER_PACKAGE]).catch(() => undefined)
      await installBoth()
      result = await verifyDeviceArtifact(deps.exec, expected)
      if (result.ok) {
        deps.onLog?.('info', `${UI_SERVER_PACKAGE} reinstalled and reverified on ${deps.serial}`)
        return
      }
      if (result.reason === 'unreadable') {
        deps.onLog?.(
          'warn',
          `could not re-verify ${UI_SERVER_PACKAGE} on ${deps.serial} after reinstalling — skipping artifact verification for this session`,
        )
        return
      }

      // Still mismatched after one repair attempt — stop, do not loop.
      deps.onLog?.(
        'warn',
        `${UI_SERVER_PACKAGE} on ${deps.serial} is still ${result.reason} after one repair attempt — giving up`,
      )
      deps.onMismatch?.({ reason: result.reason, ...(result.observed ? { observed: result.observed } : {}) })
      throw new Error(`ui-server artifact verification failed after one repair attempt: ${result.reason}`)
    },

    async start(localPort) {
      await this.ensureInstalled()
      // The instrumentation runs detached from the caller's perspective — it
      // never "finishes" while the server is alive — but unlike the old
      // `deps.exec` path this is now the Plan 24 streaming lane (§3.2, §4.1):
      // the returned promise resolves once the shell handshake completes,
      // not once (or if) the instrumentation itself exits, so awaiting it
      // does not block on the server's lifetime.
      const cmd = `am instrument -w -r -e debug false -e class ${UI_SERVER_STUB_CLASS} ${UI_SERVER_INSTRUMENTATION}`
      instrumentation = await deps.execStream(cmd, {
        onEnd: (reason, err) => {
          instrumentation = null
          // `'stopped'` is `stop()` tearing this down on purpose — anything
          // else is the instrumentation dying (or never starting) on its
          // own, which per plan 34 §8's risk table must be visible rather
          // than swallowed at debug level the way the pre-plan `.catch()` did.
          if (reason !== 'stopped') {
            deps.onLog?.(
              'warn',
              `ui-server instrumentation (class ${UI_SERVER_STUB_CLASS}) ended unexpectedly on ${deps.serial}: ${reason}${err ? ` (${String(err)})` : ''}`,
            )
          }
        },
      })
      try {
        await assertForward(localPort)
      } catch (err) {
        // The stream is now the thing holding the instrumentation open, so a
        // failure past this point (a lost port race, a dead hostAdb) must not
        // leak it — the old fire-and-forget `exec` never held a handle to
        // clean up here, but this one does.
        const handle = instrumentation
        instrumentation = null
        await handle?.stop().catch(() => undefined)
        throw err
      }
    },

    async stop(localPort) {
      await deps
        .hostAdb(['-s', deps.serial, 'forward', '--remove', `tcp:${localPort}`])
        .catch(() => undefined)
      // Tears the stream down first — release order matters (plan 24 §4.2):
      // this both stops the `execStream` from reporting a spurious `onEnd`
      // reason later and best-effort kills the instrumentation's shell PID.
      const handle = instrumentation
      instrumentation = null
      await handle?.stop().catch(() => undefined)
      await deps.exec(`am force-stop ${UI_SERVER_PACKAGE}`).catch(() => undefined)
      await deps.exec(`am force-stop ${UI_SERVER_TEST_PACKAGE}`).catch(() => undefined)
    },

    async reassertForward(localPort) {
      await assertForward(localPort)
    },
  }
}
