import { shellQuote, type AdbClient } from '@enkaku/adb'
// `GUEST_AGENT_SOCKET` now lives in `@enkaku/protocol` (plan 44 §4.2) —
// re-exported here so callers of this launcher don't need a second import
// for the one constant they need alongside it.
import { GUEST_AGENT_SOCKET, type ShellResult } from '@enkaku/protocol'
// On-device artifact verification (plan 41 §3.1, §4.2) — the SAME function
// `ui-server/launcher.ts` uses, not a second copy (plan 90 §3.8, F8): "the
// `ui-server` algorithm, not a new one".
import { verifyDeviceArtifact, type DeviceArtifactExpectation } from '../../inspector/ui-server/verify'
// The `-g` fallback, shared with `ui-server/launcher.ts` and the core's own
// `TransferService` — see that module's doc comment for the Xiaomi
// (HyperOS) build that refuses the flag outright.
import { installWithGrantFallback } from '../../install/grant-fallback'

export { GUEST_AGENT_SOCKET }

/** The first-party guest agent package (plan 43, plan 44 §4.4). */
export const GUEST_AGENT_PACKAGE = 'dev.enkaku.guestagent'

/**
 * The RUNTIME permissions the agent declares — the list `install()` below
 * grants by hand when a device refuses the `-g` install flag.
 *
 * Derived from `apps/guest-agent/app/src/main/AndroidManifest.xml`, which is
 * the source of truth, not a guess. Of the seven `<uses-permission>` entries
 * there — INTERNET, ACCESS_NETWORK_STATE, FOREGROUND_SERVICE,
 * FOREGROUND_SERVICE_SPECIAL_USE, RECEIVE_BOOT_COMPLETED, SET_WALLPAPER and
 * POST_NOTIFICATIONS — exactly one has a `dangerous` protection level and is
 * therefore the only thing `-g` was ever granting: POST_NOTIFICATIONS
 * (runtime from API 33; an install-time permission below that, which is why
 * `grantRuntimePermissions` tolerates `pm grant` refusing to touch it on an
 * older phone). Everything else is `normal` and granted at install time
 * whether `-g` is present or not.
 *
 * It matters more than it looks: `ControlService` is a foreground service,
 * and its ongoing notification is how a human holding the phone can tell the
 * farm is driving it. `launcher.manifest.test.ts` guards this list against
 * the manifest drifting away from it: every `<uses-permission>` there must be
 * classified as runtime (here) or install-time (that test's own allowlist), so
 * adding a permission and forgetting this list fails a test rather than a
 * phone.
 */
export const GUEST_AGENT_RUNTIME_PERMISSIONS = ['android.permission.POST_NOTIFICATIONS'] as const

/**
 * Clears the freshly-installed app's stopped state
 * (docs/research/android-guest-agent.md §1.3) — mandatory, not optional: a
 * stopped app receives no broadcasts at all, so without this call the agent
 * never restarts after the device's first reboot.
 */
const BOOTSTRAP_ACTIVITY = `${GUEST_AGENT_PACKAGE}/.BootstrapActivity`

/**
 * The app op that pre-grants VPN consent without a dialog
 * (docs/research/android-guest-agent.md §1.2). It is `@hide`/`@SystemApi`
 * and appears in zero public docs, so `ensurePreGranted()` below reads it
 * back rather than trusting the `set` call.
 */
const ACTIVATE_VPN_OP = 'ACTIVATE_VPN'

/** `AccessibilityServiceInfo.getId()`'s form, matching `UiTreeService.COMPONENT_ID` in the Kotlin. */
export const GUEST_AGENT_UI_TREE_SERVICE = `${GUEST_AGENT_PACKAGE}/${GUEST_AGENT_PACKAGE}.ui.UiTreeService`

/** R4 (plan 200 §5) — Android 13+ restricted settings block enabling an accessibility service for a sideloaded app. */
const RESTRICTED_SETTINGS_OP = 'ACCESS_RESTRICTED_SETTINGS'

/**
 * What `ensurePreGranted()` learned about this device's VPN consent.
 *
 * It is a RESULT, not an exception, because "this phone will not pre-grant
 * VPN consent from adb" is not the same event as "the agent could not be
 * installed or reached", and collapsing the two costs a device every facet
 * the agent has. Measured live on two OPPO phones (CPH2819/ColorOS Android
 * 15 and CPH2173/Android 14): `appops set` there fails for EVERY op, not
 * just this one —
 *
 * ```
 * java.lang.SecurityException: uid 2000 does not have android.permission.MANAGE_APP_OPS_MODES
 * ```
 *
 * — while the agent itself installs, starts, pairs, and answers `hello`
 * with its full capability list. The only thing genuinely unavailable there
 * is `vpn-helper` routing, which the platform gates behind a human accepting
 * Android's VPN "Connection request" dialog on the phone. That consent is
 * recorded as this very app op, so the readback below is also the detector
 * for "someone accepted it" — no second mechanism needed, and the state
 * clears itself on the next pass.
 */
export interface GuestAgentVpnConsent {
  /** `granted` — the op reads `allow`, by whichever route it got there (adb, or a human accepting the dialog). */
  state: 'granted' | 'pending'
  /** Verbatim, operator-facing, and never summarised. `null` when granted. */
  reason: string | null
}

/**
 * What `ensureAccessibilityEnabled()` learned about this device's accessibility settings (plan
 * 221 §4.10). A RESULT, not an exception, for the same reason `GuestAgentVpnConsent` is: "this
 * phone will not enable an accessibility service from adb" is not the same event as "the agent
 * could not be reached", and collapsing the two would cost a device every other facet it has.
 */
export interface GuestAgentAccessibility {
  /** `enabled` — both settings read back correct, by whichever route they got there (adb, or a human on the phone). */
  state: 'enabled' | 'pending'
  /** Verbatim, operator-facing, never summarised. `null` when enabled. */
  reason: string | null
}

/**
 * Reported once, when a repair attempt still leaves the artifact mismatched
 * (plan 90 §3.8, mirrors `UiServerArtifactMismatch` — F8). `not_installed`
 * is included alongside the two mismatch reasons because the repair path
 * re-verifies after reinstalling — if THAT install itself did not stick
 * (e.g. `adb install` reported success but the package manager silently
 * dropped it), that is just as much "the repair did not work" as a
 * version/signature mismatch.
 */
export interface GuestAgentArtifactMismatch {
  reason: 'not_installed' | 'version_mismatch' | 'signature_mismatch'
  observed?: { versionCode?: number; signature?: string }
}

export interface GuestAgentLauncherDeps {
  serial: string
  /**
   * Per-device shell exec (through the Plan 01 queue). Returns the three
   * fields separately (plan 53) — this launcher decides installation from
   * the real exit code rather than by matching text.
   */
  exec: (cmd: string) => Promise<ShellResult>
  /**
   * `adb install`/`uninstall`/`forward` need CLI-level adb, supplied by the
   * core. Installs pass `{ lane: 'install', serial }` (plan 90 §3.8, F12,
   * mirrors `packages/drivers/src/inspector/ui-server/launcher.ts`) so the
   * core's bounded host-adb helper (plan 85 §3.4, §4.5) can serialise them
   * per device AND apply the farm's `adb.maxInstallConcurrent` cap — a
   * fleet-wide admission wave must queue, not saturate one USB tree.
   */
  hostAdb: (args: string[], opts?: { lane?: 'default' | 'install'; serial?: string }) => Promise<string>
  /**
   * The forward/list-forward/killForward trio (plan 119 §4.1, §4.2), talking to the adb server
   * directly over its `host:`-protocol socket instead of spawning `adb.exe` — what `forward()`/
   * `removeForward()` below use now, replacing the `hostAdb(['forward', ...])` CLI path they used
   * before this plan. `client.ts`'s own doc comments record that the ADD (`forward`) and REMOVE
   * (`killForward`) success shapes were inferred by analogy, not verified against a real device (no
   * device was attached when they were built) — this launcher does not re-derive that judgment, it
   * only consumes the three methods.
   *
   * A caller may not have a live `AdbClient` yet at the point this launcher is constructed (the core
   * builds its `AdbClient` well after `hello()`'s own dependency graph is wired, same reason
   * `hostAdb` above is a bound function rather than an object) — a lazy, throwing wrapper satisfying
   * this same `Pick` is expected there, not a null check inside this file.
   */
  adb: Pick<AdbClient, 'forward' | 'listForward' | 'killForward'>
  /** APK path from the Toolchain Manager (or `ENKAKU_GUEST_AGENT_PATH`, plan 44 §7). */
  apkPath: () => Promise<string>
  /**
   * The manifest's on-device expectation for this build (plan 90 §3.8, F6's
   * fix — the manifest previously had no `guest-agent` entry at all, so this
   * was always empty). `undefined`/empty fields mean `ensureInstalled()`
   * only verifies presence, never blocking on missing metadata of our own —
   * the identical rule `ui-server/launcher.ts` already follows.
   */
  expectedArtifact?: { versionCode?: number; signatureSha256?: string }
  /**
   * Called at most once per `ensureInstalled()` call, and only when a single
   * uninstall-reinstall-reverify cycle still leaves the artifact mismatched
   * (plan 90 §3.8) — the caller's (`AgentProvisioner`'s) cue to record
   * `device.agent`/report `outdated` or `failed`. `ensureInstalled()` still
   * throws afterward; this callback exists purely for observability, not
   * for control flow.
   */
  onMismatch?: (info: GuestAgentArtifactMismatch) => void
  onLog?: (level: 'debug' | 'info' | 'warn', msg: string) => void
}

export interface GuestAgentLauncher {
  isInstalled(): Promise<boolean>
  /**
   * Verify → (not installed → install) → (mismatch → uninstall, reinstall,
   * re-verify ONCE) → (still mismatched → report and stop) — the exact
   * `ui-server` algorithm (F8), replacing the old presence-only check (F7).
   *
   * Resolves with the versionCode this pass leaves the device with: the
   * OBSERVED one whenever a verify pass actually read it back, the pinned
   * EXPECTED one on a blind not-installed→install (no re-verify there,
   * mirroring `ui-server/launcher.ts`'s identical choice), and `null` when
   * the device's `dumpsys package` output was unreadable (never treated as
   * a mismatch — `dumpsys` output is not stable across OEMs).
   *
   * `opts.force` skips the fast "already matches" path and goes straight to
   * uninstall+reinstall+reverify once — used for the version-skew repair
   * (plan 90 §3.9 rule 1, R1): a live protocol mismatch discovered over
   * `hello()` that the on-device artifact check alone cannot see (the
   * installed versionCode can still read as expected while the running
   * process answers an old protocol, in principle — R1 exists to repair
   * that case exactly once too, never loop).
   */
  ensureInstalled(opts?: { force?: boolean }): Promise<{ versionCode: number | null }>
  /**
   * Grants the VPN app op if this build allows it, and REPORTS rather than
   * throws when it does not — see `GuestAgentVpnConsent`. Still throws for
   * the one case that genuinely is an install failure: a package the package
   * manager has no UID for.
   */
  ensurePreGranted(): Promise<GuestAgentVpnConsent>
  /** Read-only: the same readback `ensurePreGranted()` ends on, with no `appops set` attempt of its own. */
  vpnConsent(): Promise<GuestAgentVpnConsent>
  /**
   * Plan 221 §4.10 — the appops call always runs before the settings write, and a read-back always
   * decides (R4: no source settles whether an `adb install` is exempt on every OEM). Reports
   * `pending` rather than throwing when the write is refused; the status screen's "Open
   * accessibility settings" button is the fallback this result exists to point at.
   */
  ensureAccessibilityEnabled(): Promise<GuestAgentAccessibility>
  bootstrap(token: string): Promise<void>
  forward(localPort: number): Promise<void>
  removeForward(localPort: number): Promise<void>
  stop(): Promise<void>
}

/**
 * On-device agent lifecycle: install the APK, pre-grant the VPN app op,
 * clear the stopped state, forward the control-channel socket. Mirrors
 * `packages/drivers/src/inspector/ui-server/launcher.ts` file for file
 * (plan 44 §4.4; `ensureInstalled` specifically mirrors it again for plan 90
 * §3.8, F7/F8).
 */
/**
 * The one line of an `appops set` failure worth quoting. A refusal arrives as
 * a whole Java stack trace whose FIRST `Exception` line is the useless header
 * ("Exception occurred while executing 'set':"); the line that names the
 * actual cause is the one below it. Picking the specific line is the
 * difference between a reason an operator can act on and one they cannot.
 */
function summariseSetFailure(text: string, exitCode: number | null): string {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  return (
    lines.find((line) => /does not have|SecurityException|Permission|Unknown operation/.test(line)) ??
    lines.find((line) => line.includes('Exception')) ??
    lines[0] ??
    `exit ${exitCode}`
  )
}

export function createGuestAgentLauncher(deps: GuestAgentLauncherDeps): GuestAgentLauncher {
  const expectation = (): DeviceArtifactExpectation => ({ packageName: GUEST_AGENT_PACKAGE, ...deps.expectedArtifact })

  /** Adapts `deps.exec`'s structured `ShellResult` to the plain-stdout shape `verifyDeviceArtifact` expects. */
  const verifyExec = (cmd: string): Promise<string> => deps.exec(cmd).then((r) => r.stdout)

  const install = async (): Promise<void> => {
    const apk = await deps.apkPath()
    deps.onLog?.('info', `installing the guest agent on ${deps.serial}`)
    // -g auto-grants runtime permissions; -r replaces a different version.
    // -g cannot grant ACTIVATE_VPN — that is an app op, not a permission,
    // hence the separate ensurePreGranted() below.
    // `lane: 'install'` (plan 85 §3.4, plan 90 §3.8, F12): this install for
    // THIS device never runs concurrently with more than
    // `adb.maxInstallConcurrent` installs farm-wide — applied inside
    // `installWithGrantFallback`, which owns the `-g`-refused retry.
    await installWithGrantFallback({
      serial: deps.serial,
      hostAdb: deps.hostAdb,
      exec: deps.exec,
      apkPath: apk,
      packageName: GUEST_AGENT_PACKAGE,
      expectedPermissions: GUEST_AGENT_RUNTIME_PERMISSIONS,
      flags: ['-r'],
      ...(deps.onLog ? { onLog: deps.onLog } : {}),
    })
  }

  /**
   * Classifies an `appops get ... ACTIVATE_VPN` readback. Shared by
   * `ensurePreGranted()` and `vpnConsent()` so there is exactly one place
   * that decides what "granted" looks like — and therefore exactly one place
   * that would have to change if a future Android renames the op.
   */
  function classify(readback: string, setFailure: string | null): GuestAgentVpnConsent {
    if (readback.includes('allow')) return { state: 'granted', reason: null }
    const attempted = `appops set ${GUEST_AGENT_PACKAGE} ${ACTIVATE_VPN_OP} allow`
    const cause =
      setFailure !== null
        ? `\`${attempted}\` was refused by the platform (${setFailure})`
        : `\`${attempted}\` reported no error but the readback still says ${JSON.stringify(readback.trim())} — this app op is @hide/@SystemApi and its behaviour is not guaranteed across Android releases`
    return {
      state: 'pending',
      reason:
        `the guest agent is installed and answering, but Android VPN consent (${ACTIVATE_VPN_OP}) is not granted on this phone and this build will not let adb grant it: ${cause}. ` +
        'Everything else the agent does — text input, screen labels, mock location, egress probes — works; only vpn-helper network routing is blocked. ' +
        'To clear it, accept the VPN "Connection request" dialog on the phone itself: Android records that consent as this same app op, so the next provisioning pass will see it and the device turns ready on its own.',
    }
  }

  const readConsent = async (setFailure: string | null): Promise<GuestAgentVpnConsent> => {
    const readback = await deps.exec(`appops get ${shellQuote(GUEST_AGENT_PACKAGE)} ${ACTIVATE_VPN_OP}`)
    return classify(readback.stdout, setFailure)
  }

  return {
    async isInstalled() {
      // `cmd package path <pkg>` takes the package name as an argument, not
      // a filter — unlike `pm list packages`, whose substring match would
      // false-positive on a sibling package (docs/research/android-guest-agent.md
      // §6). It prints `package:/data/app/.../base.apk` and exits 0 when
      // installed, or nothing and exit 1 when it is not.
      //
      // Deliberately UNCHANGED by plan 90 (presence-only): this is still
      // what `packages/core/src/api/guest-agent.ts`'s pre-plan-90 GET/POST/
      // DELETE `/:id/guest-agent` endpoints call — `ensureInstalled()` below
      // is where F7's fix actually lives.
      //
      // Unlike `dumpsys` — which exits 0 even for a service that does not
      // exist, verified on hardware in plan 53 §5.5 — this command reports
      // the answer in its exit status, so that is what decides. The prefix
      // is still required for the positive case: an exit of 0 with output
      // in some other shape means the command did something we do not
      // understand, and "installed" is too consequential a thing to assume.
      const { stdout, exitCode } = await deps.exec(`cmd package path ${shellQuote(GUEST_AGENT_PACKAGE)}`)
      // `null` means the device is too old for the framed shell service
      // (plan 53 §3.4). No exit code exists to read, so fall back to the
      // prefix alone rather than treat "unknown" as "not installed".
      if (exitCode === null) return stdout.startsWith('package:')
      return exitCode === 0 && stdout.startsWith('package:')
    },

    async ensureInstalled(opts) {
      const expected = expectation()

      if (!opts?.force) {
        if (expected.versionCode === undefined && expected.signatureSha256 === undefined) {
          deps.onLog?.(
            'info',
            `no versionCode/signature expectation recorded for ${GUEST_AGENT_PACKAGE} — verifying installed presence only (plan 90 §3.8, fixes F6)`,
          )
        }

        const result = await verifyDeviceArtifact(verifyExec, expected)
        if (result.ok) return { versionCode: result.versionCode }

        if (result.reason === 'not_installed') {
          await install()
          // No re-verify here — mirrors `ui-server/launcher.ts`'s identical
          // choice: a blind install's versionCode is reported as the pinned
          // expectation until the NEXT pass confirms it for real.
          return { versionCode: expected.versionCode ?? null }
        }
        if (result.reason === 'unreadable') {
          deps.onLog?.(
            'warn',
            `could not read ${GUEST_AGENT_PACKAGE}'s installed version/signature on ${deps.serial} — skipping artifact verification for this pass`,
          )
          return { versionCode: null }
        }

        // version_mismatch or signature_mismatch: repair exactly once, below.
        deps.onLog?.(
          'warn',
          `${GUEST_AGENT_PACKAGE} on ${deps.serial} is ${result.reason} (observed ${JSON.stringify(result.observed ?? {})}) — reinstalling`,
        )
      } else {
        deps.onLog?.('info', `forcing a reinstall of ${GUEST_AGENT_PACKAGE} on ${deps.serial} (plan 90 §3.9 rule 1)`)
      }

      // Repair-once: uninstall, reinstall, re-verify (plan 41 §3.3's rule,
      // reused as-is). Reached either because verify reported a mismatch
      // above, or because the caller asked for a forced repair (R1's
      // protocol-mismatch case, where the on-device artifact may read as
      // matching yet the running process answers stale).
      await deps.hostAdb(['-s', deps.serial, 'uninstall', GUEST_AGENT_PACKAGE]).catch(() => undefined)
      await install()
      const reverified = await verifyDeviceArtifact(verifyExec, expected)
      if (reverified.ok) {
        deps.onLog?.('info', `${GUEST_AGENT_PACKAGE} reinstalled and reverified on ${deps.serial}`)
        return { versionCode: reverified.versionCode }
      }
      if (reverified.reason === 'unreadable') {
        deps.onLog?.(
          'warn',
          `could not re-verify ${GUEST_AGENT_PACKAGE} on ${deps.serial} after reinstalling — skipping artifact verification for this pass`,
        )
        return { versionCode: null }
      }

      // Still mismatched after one repair attempt — stop, do not loop.
      deps.onLog?.(
        'warn',
        `${GUEST_AGENT_PACKAGE} on ${deps.serial} is still ${reverified.reason} after one repair attempt — giving up`,
      )
      deps.onMismatch?.({ reason: reverified.reason, ...(reverified.observed ? { observed: reverified.observed } : {}) })
      throw new Error(`guest agent artifact verification failed after one repair attempt: ${reverified.reason}`)
    },

    async ensurePreGranted() {
      // "No UID for <pkg> in user 0" means package manager has not registered the package yet —
      // a fresh install, or a reinstall still settling. That is transient and worth one retry,
      // and it is a different thing from the app op having stopped behaving as documented, which
      // must still fail loudly. Seen in the field as an install that reported success and then
      // failed to pre-grant.
      for (let attempt = 1; attempt <= 3; attempt++) {
        // `appops get` writes "No UID for <pkg>" to stderr, not stdout, so
        // both streams are searched — before plan 53 they arrived merged and
        // this read stdout alone.
        const probe = await deps.exec(`appops get ${shellQuote(GUEST_AGENT_PACKAGE)} ${ACTIVATE_VPN_OP}`)
        const probeText = `${probe.stdout}\n${probe.stderr}`
        if (!probeText.includes('No UID')) break
        if (attempt === 3) {
          throw new Error(
            `${GUEST_AGENT_PACKAGE} is not registered with package manager (${JSON.stringify(probeText.trim())}) — ` +
              'the install did not take, so the VPN app op cannot be granted',
          )
        }
        await new Promise((r) => setTimeout(r, 500))
      }
      const set = await deps.exec(`appops set ${shellQuote(GUEST_AGENT_PACKAGE)} ${ACTIVATE_VPN_OP} allow`)
      // Captured, not thrown on: ColorOS answers this with a SecurityException
      // for EVERY app op (the shell uid has no MANAGE_APP_OPS_MODES there),
      // which is a fact about the phone worth naming in the reason rather
      // than a reason to abandon a working agent. The readback below is
      // still what decides — a build that prints something alarming and
      // grants the op anyway must read as granted.
      const setText = `${set.stdout}\n${set.stderr}`.trim()
      const setFailure = (set.exitCode !== null && set.exitCode !== 0) || setText.includes('Exception') ? summariseSetFailure(setText, set.exitCode) : null
      // Read back rather than trust: this app op is @hide/@SystemApi
      // (docs/research/android-guest-agent.md §1.2) and could stop behaving
      // this way on any future Android release without notice.
      const consent = await readConsent(setFailure)
      if (consent.state === 'pending') deps.onLog?.('warn', `${deps.serial}: ${consent.reason}`)
      return consent
    },

    vpnConsent() {
      return readConsent(null)
    },

    async ensureAccessibilityEnabled() {
      // R4 (plan 200 §5) is explicit that no source settles whether `adb install` is exempt from
      // Android 13+ restricted settings on every OEM, so this call always runs first — the
      // documented workaround, never assumed unnecessary. Captured, never thrown on: the same
      // OEMs that refuse `appops set` for ACTIVATE_VPN (ColorOS, above) refuse it here too, and the
      // read-back at the end is what decides, not this call's own exit code.
      await deps
        .exec(`cmd appops set ${shellQuote(GUEST_AGENT_PACKAGE)} ${RESTRICTED_SETTINGS_OP} allow`)
        .catch(() => undefined)

      const before = await deps.exec('settings get secure enabled_accessibility_services')
      const beforeList = before.stdout.trim()
      const current = beforeList === '' || beforeList === 'null' ? [] : beforeList.split(':').filter(Boolean)

      // Never a blind overwrite — another accessibility service on the phone is an operator's, not
      // ours to remove. Skipped entirely when our component is already present.
      if (!current.includes(GUEST_AGENT_UI_TREE_SERVICE)) {
        const nextList = [...current, GUEST_AGENT_UI_TREE_SERVICE].join(':')
        await deps.exec(`settings put secure enabled_accessibility_services ${shellQuote(nextList)}`)
      }
      // Always run, even when the list write above was skipped: the list can be right while the
      // master switch is off.
      await deps.exec('settings put secure accessibility_enabled 1')

      const afterList = await deps.exec('settings get secure enabled_accessibility_services')
      const afterEnabled = await deps.exec('settings get secure accessibility_enabled')
      const listOk = afterList.stdout.includes(GUEST_AGENT_UI_TREE_SERVICE)
      const enabledOk = afterEnabled.stdout.trim() === '1'
      if (listOk && enabledOk) return { state: 'enabled', reason: null }

      const reason =
        `the guest agent is installed and answering, but its accessibility service is not enabled on this phone and this build will not let adb enable it: ` +
        `\`settings put secure enabled_accessibility_services ...\` reported no error but the readback still says ${JSON.stringify(afterList.stdout.trim())}. ` +
        'Everything else the agent does works; only the `ui-tree` inspector is blocked, and the farm falls back to ui-server. ' +
        'To clear it, open the agent on the phone and press "Open accessibility settings", then turn Enkaku Guest Agent on: Android records that the same way, so the next provisioning pass will see it and the device turns ready on its own.'
      deps.onLog?.('warn', `${deps.serial}: ${reason}`)
      return { state: 'pending', reason }
    },

    async bootstrap(token) {
      // A freshly installed app sits in the stopped state and receives no
      // broadcasts at all (docs/research/android-guest-agent.md §1.3) — this
      // `am start` is mandatory, not optional, or the agent never restarts
      // after the device's first reboot. Budget for the same after any
      // force-stop (see stop() below).
      //
      // It is also ASYNCHRONOUS in a way that matters: this returns as soon
      // as `am start` returns, but the token only reaches `Pairing` after
      // BootstrapActivity has run and `startForegroundService` has delivered
      // `onStartCommand`. Measured at ~500 ms on a moto g06 and two OPPOs.
      // Until then the agent still holds whatever token the PREVIOUS session
      // gave it and answers `E_UNAUTHORISED` ("bad or missing token") — so
      // callers must treat that code as "not yet", re-push, and retry, never
      // as a terminal pairing failure. `createDeviceSession` in
      // `packages/core/src/api/guest-agent.ts` is the one that does.
      const out = await deps.exec(`am start -n ${BOOTSTRAP_ACTIVITY} --es token ${shellQuote(token)}`)
      // Measured on a moto g06 (Android 15): a failing `am start` exits 1 and
      // puts "Error: Activity class {...} does not exist." on stderr — while
      // stdout still reads `Starting: Intent { ... }`, which looks like
      // success. Merged into one stream and logged at debug, as it was before
      // plan 53, a bootstrap that never happened was indistinguishable from
      // one that did: the agent stays dead and the route never comes up, with
      // nothing louder than a debug line to say so. Unlike `am broadcast`,
      // which reports success for a component that does not exist, this
      // command's exit code can be trusted.
      if (out.exitCode !== null && out.exitCode !== 0) {
        throw new Error(
          `bootstrapping the guest agent on ${deps.serial} failed (exit ${out.exitCode}): ${out.stderr || out.stdout}`,
        )
      }
      deps.onLog?.('debug', `bootstrap on ${deps.serial}: ${out.stdout}`)
    },

    async forward(localPort) {
      await deps.adb.forward(deps.serial, `tcp:${localPort}`, `localabstract:${GUEST_AGENT_SOCKET}`)

      // A host port belongs to one device. Every device's guest agent
      // listens on the same socket name, so a host port that another
      // device already holds gets silently rebound and this driver would
      // talk to the OTHER phone. Same check as before plan 119 (originally
      // copied verbatim, adapted to this socket, from
      // packages/drivers/src/inspector/ui-server/launcher.ts:57-71, per
      // plan 44 §4.4) — only the mechanism underneath changed, from parsing
      // `adb forward --list`'s CLI text to reading `listForward()`'s
      // structured result.
      const list = await deps.adb.listForward()
      const owner = list.find((f) => f.local === `tcp:${localPort}`)
      if (!owner || owner.serial !== deps.serial) {
        throw new Error(
          `tcp:${localPort} is bound to ${owner?.serial ?? 'nothing'}, not to ${deps.serial} — refusing to drive another device's guest agent`,
        )
      }
      deps.onLog?.('debug', `forward tcp:${localPort} → device localabstract:${GUEST_AGENT_SOCKET}`)
    },

    async removeForward(localPort) {
      await deps.adb.killForward(deps.serial, `tcp:${localPort}`).catch(() => undefined)
    },

    async stop() {
      await deps.exec(`am force-stop ${shellQuote(GUEST_AGENT_PACKAGE)}`).catch(() => undefined)
    },
  }
}
