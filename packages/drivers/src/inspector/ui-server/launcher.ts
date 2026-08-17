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
   * Plan 106 §5 step 106.8 — when supplied, `installBoth()` routes each
   * APK's install through THIS instead of a raw `hostAdb install` call
   * (the core's own `TransferService.installFromLocalApk`, wrapped in
   * `runTransfer` by the caller for a real transferId and byte progress).
   * Optional: falls back to `hostAdb` when absent, so this launcher's own
   * unit tests (which only fake `hostAdb`) and the guest agent's separate
   * launcher (`network/guest-agent/launcher.ts`, deliberately NOT given
   * this seam — see plan 106 §9 Q5) are both unaffected.
   */
  installApk?: (localPath: string, label: 'app' | 'test') => Promise<void>
  /**
   * The manifest's on-device expectation for the app APK (plan 41 §3.2) —
   * `undefined`/empty when the manifest carries none, in which case
   * `ensureInstalled()` only verifies that SOMETHING named `UI_SERVER_PACKAGE`
   * is installed and never blocks the inspector on missing metadata of our own.
   *
   * This expectation covers the APP package only. The instrumentation package
   * (`UI_SERVER_TEST_PACKAGE`) is verified for PRESENCE regardless — see
   * `ensureTestPackage()`; no version/signature is recorded for it.
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
    // Plan 106 §5 step 106.8: `deps.installApk`, when supplied, replaces
    // BOTH raw `hostAdb install` calls below with the transfer machinery
    // (real progress, a transferId, staged-file cleanup) — `-r`/`-g` are
    // applied there by `TransferService.installFromLocalApk`'s own defaults
    // (both default `true`), the same flags this call always passed.
    if (deps.installApk) {
      await deps.installApk(app, 'app')
      await deps.installApk(test, 'test')
      return
    }
    // -g auto-grants runtime permissions; -r replaces a different version.
    // `lane: 'install'` (plan 85 §3.4, §5 step 85.3, tests H5): these two
    // installs for the SAME device never run concurrently with each other,
    // nor with more than `adb.maxInstallConcurrent` installs farm-wide.
    await deps.hostAdb(['-s', deps.serial, 'install', '-r', '-g', app], { lane: 'install', serial: deps.serial })
    await deps.hostAdb(['-s', deps.serial, 'install', '-r', '-g', test], { lane: 'install', serial: deps.serial })
  }

  /**
   * Both openatx packages in ONE round trip — the same probe an operator runs
   * by hand (`pm list packages | grep uiautomator`). `pm list packages <name>`
   * matches by substring, so a healthy device answers with both
   * `package:com.github.uiautomator` and `package:com.github.uiautomator.test`.
   */
  const listUiServerPackages = async (): Promise<Set<string>> => {
    const out = await deps.exec(`pm list packages ${UI_SERVER_PACKAGE}`, { profile: 'probe' })
    const names = new Set<string>()
    for (const line of out.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('package:')) continue
      const rest = trimmed.slice('package:'.length)
      // `-f` is never passed here, but its `path=name` shape costs one line to survive.
      names.add(rest.includes('=') ? rest.slice(rest.lastIndexOf('=') + 1) : rest)
    }
    return names
  }

  /**
   * uiautomator2 is TWO packages, and `am instrument` targets the TEST one
   * (`UI_SERVER_INSTRUMENTATION`) — so a device carrying only
   * `UI_SERVER_PACKAGE` passes every `dumpsys package com.github.uiautomator`
   * check above (versionCode and signature included) and the instrumentation
   * then dies on the spot. Measured on ZP2222RMBS (moto g06): `ended
   * unexpectedly: closed`, three restart cycles, and every job failing on a
   * socket timeout that named the port instead of the absent package — while
   * the preparation panel reported the APP package's versionCode as "ready".
   *
   * Deliberately conservative: this acts only on POSITIVE evidence — the
   * listing shows the app and does NOT show the test package. A listing that
   * does not even mention the app `dumpsys` just confirmed contradicts itself,
   * so it reads as "could not check" and is skipped (verify.ts's `unreadable`
   * rule, plan 41 §8), never as grounds for an install cycle.
   *
   * `repair: false` is for callers that have JUST run `installBoth()` — the
   * one-repair-then-degrade budget (§3.3) is already spent, so a still-absent
   * test package is reported, not reinstalled a second time.
   */
  const ensureTestPackage = async (opts: { repair: boolean }): Promise<void> => {
    let names = await listUiServerPackages()
    if (!names.has(UI_SERVER_PACKAGE)) {
      deps.onLog?.(
        'debug',
        `could not read the installed package list on ${deps.serial} — skipping the ${UI_SERVER_TEST_PACKAGE} presence check`,
      )
      return
    }
    if (names.has(UI_SERVER_TEST_PACKAGE)) return

    if (opts.repair) {
      deps.onLog?.(
        'warn',
        `${UI_SERVER_TEST_PACKAGE} is missing on ${deps.serial} while ${UI_SERVER_PACKAGE} is installed — the ui-server instrumentation cannot start without it; installing both APKs`,
      )
      await installBoth()
      names = await listUiServerPackages()
      if (names.has(UI_SERVER_TEST_PACKAGE)) {
        deps.onLog?.('info', `${UI_SERVER_TEST_PACKAGE} installed and verified on ${deps.serial}`)
        return
      }
      if (!names.has(UI_SERVER_PACKAGE)) {
        deps.onLog?.(
          'warn',
          `could not re-read the installed package list on ${deps.serial} after installing both APKs — skipping the ${UI_SERVER_TEST_PACKAGE} presence check`,
        )
        return
      }
    }

    deps.onMismatch?.({ reason: 'not_installed' })
    throw new Error(
      `${UI_SERVER_TEST_PACKAGE} is not installed on ${deps.serial} after ${opts.repair ? 'one repair attempt' : 'reinstalling both APKs'} — ${UI_SERVER_PACKAGE} alone cannot run the ui-server instrumentation (${UI_SERVER_INSTRUMENTATION})`,
    )
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
    /**
     * "Can this device run the ui-server?" — which takes BOTH packages, not
     * just the app one, for the reason `ensureTestPackage()` documents. An
     * unreadable package listing keeps the answer to the app's verification
     * alone rather than inventing a `false`.
     */
    async isInstalled() {
      const result = await verifyDeviceArtifact(deps.exec, { packageName: UI_SERVER_PACKAGE })
      if (!result.ok) return false
      const names = await listUiServerPackages()
      if (!names.has(UI_SERVER_PACKAGE)) return true
      return names.has(UI_SERVER_TEST_PACKAGE)
    },

    /**
     * Verify → (not installed → install) → (mismatch → uninstall, reinstall,
     * re-verify ONCE) → (still mismatched → report and stop). Plan 41 §3.3:
     * looping on a device where something keeps reinstalling a conflicting
     * package would burn farm time forever, so this makes exactly one repair
     * attempt and then degrades visibly (throws, so the session falls back
     * to `uiautomator-dump`).
     *
     * BOTH packages are verified. Every path that concludes "the app package
     * is fine" then runs `ensureTestPackage()` through the SAME
     * one-repair-then-degrade budget — an app-only device is a real,
     * observed state (see `ensureTestPackage()`), and before this check it
     * was reported as ready and then failed every job.
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
      if (result.ok) {
        await ensureTestPackage({ repair: true })
        return
      }

      if (result.reason === 'not_installed') {
        // Nothing to be selective about: `installBoth()` puts both APKs on
        // the device, which is exactly what a missing test package needs, so
        // this path is left exactly as it was. An install that reports success
        // and does not stick is caught by the `result.ok` branch above on the
        // very next pass (preparation re-runs; so does every session start).
        await installBoth()
        return
      }
      if (result.reason === 'unreadable') {
        deps.onLog?.(
          'warn',
          `could not read ${UI_SERVER_PACKAGE}'s installed version/signature on ${deps.serial} — skipping artifact verification for this session`,
        )
        await ensureTestPackage({ repair: true })
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
        // `installBoth()` above already spent the repair budget, so this only
        // reports an install that did not stick — it never installs again.
        await ensureTestPackage({ repair: false })
        return
      }
      if (result.reason === 'unreadable') {
        deps.onLog?.(
          'warn',
          `could not re-verify ${UI_SERVER_PACKAGE} on ${deps.serial} after reinstalling — skipping artifact verification for this session`,
        )
        await ensureTestPackage({ repair: false })
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
