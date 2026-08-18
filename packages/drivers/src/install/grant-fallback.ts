import { shellQuote } from '@enkaku/adb'
import type { ShellResult } from '@enkaku/protocol'

/**
 * The `-g` install flag, and what to do when a platform refuses it.
 *
 * `adb install -g` / `pm install -g` asks the package manager for
 * `INSTALL_GRANT_ALL_REQUESTED_PERMISSIONS`, which the caller may only use
 * while holding `android.permission.INSTALL_GRANT_RUNTIME_PERMISSIONS`. AOSP
 * grants the shell uid that permission; some OEM builds do not. Measured
 * live on a Xiaomi 25128PC17G (HyperOS, Android 16, API 36) — EVERY `-g`
 * install on that phone fails, guest agent and ui-server alike, with:
 *
 * ```
 * java.lang.SecurityException: You need the android.permission.INSTALL_GRANT_RUNTIME_PERMISSIONS
 *   permission to use the PackageManager.INSTALL_GRANT_ALL_REQUESTED_PERMISSIONS flag
 * ```
 *
 * `-g` is only ever a convenience: the same end state is reachable by
 * installing without it and running `pm grant <pkg> <permission>` for each
 * runtime permission the app declares. So the rule this module implements
 * is: keep asking for `-g` first (it is one round trip and it works on most
 * phones), detect THIS rejection specifically, and only then fall back —
 * never a blind retry on any install error, and never a fleet-wide drop of a
 * flag that is doing its job everywhere else.
 *
 * The second half of the rule matters as much as the first: an app installed
 * WITHOUT its runtime permissions is a different, worse state than one that
 * failed to install, because it looks present and then misbehaves at use
 * time. A `pm grant` that does not take is therefore reported as an install
 * failure, never swallowed.
 *
 * Which permissions to grant is read off the DEVICE rather than hardcoded
 * per package (`readRuntimePermissions` below): the installed APK's own
 * manifest is the only list that cannot drift, and it is the same list for
 * an APK this codebase does not build (the openatx ui-server pair declares
 * POST_NOTIFICATIONS, READ_PHONE_STATE and GET_ACCOUNTS; the guest agent
 * declares POST_NOTIFICATIONS alone). A caller may still pass an expected
 * list, which is unioned in as a backstop for a device whose `dumpsys`
 * output this parser does not recognise.
 */

/**
 * True only for the platform's refusal of the `-g` flag itself — matched on
 * the two permission names the message is built from rather than on the
 * sentence around them, which differs between API levels.
 */
export function isGrantAllPermissionsRejection(text: string): boolean {
  return text.includes('INSTALL_GRANT_RUNTIME_PERMISSIONS') || text.includes('INSTALL_GRANT_ALL_REQUESTED_PERMISSIONS')
}

/**
 * `pm grant` answers that mean "there is no runtime permission by that name
 * to grant on THIS build", not "the grant failed". `POST_NOTIFICATIONS` is
 * the case that actually occurs: it only became a runtime permission in API
 * 33, so on an API 29–32 phone the same manifest entry is an install-time
 * permission that `pm grant` rightly refuses to touch. Treating that as a
 * failure would fail provisioning on every older phone in the farm for a
 * permission it already holds.
 */
const NOT_A_RUNTIME_PERMISSION = ['Unknown permission', 'not a changeable permission type', 'has not requested permission']

/** Per-device shell exec — the structured form (plan 53), so a grant can be judged on its exit code and not on text alone. */
export type GrantExec = (cmd: string) => Promise<ShellResult>

/**
 * The `runtime permissions:` block of `dumpsys package <pkg>`, parsed.
 *
 * Verified to print the same `<permission>: granted=<bool>` shape on Samsung
 * (One UI, API 36), Motorola (Android 15) and OPPO (ColorOS, Android 15).
 * An output this parser finds nothing in reads as UNREADABLE (an empty map),
 * never as "no permissions" — `dumpsys` output is not stable across OEMs,
 * and this codebase's standing rule (`ui-server/verify.ts`, the launchers'
 * own `unreadable` branches) is that an unreadable device answer never
 * counts as a verdict.
 */
export async function readRuntimePermissions(exec: GrantExec, packageName: string): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>()
  let text: string
  try {
    text = (await exec(`dumpsys package ${shellQuote(packageName)}`)).stdout
  } catch {
    return out
  }
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*(android\.permission\.[A-Z0-9_]+|[a-z][\w.]*\.permission\.[A-Z0-9_]+):\s*granted=(true|false)/)
    if (match?.[1] && match[2]) out.set(match[1], match[2] === 'true')
  }
  return out
}

export interface GrantRuntimePermissionsDeps {
  exec: GrantExec
  packageName: string
  /**
   * Permissions the caller knows the app declares, unioned with whatever the
   * device reports as ungranted. Optional and usually unnecessary — it is
   * the backstop for a `dumpsys` output shape this parser misses.
   */
  expected?: readonly string[]
  onLog?: (level: 'debug' | 'info' | 'warn', msg: string) => void
}

/**
 * Grants every runtime permission the installed app declares and does not
 * already hold, then verifies by reading the device back. Throws — with the
 * device's own words — when any of them is still not granted, so the caller
 * reports a failed install rather than a `ready` package missing the
 * permissions it asked for.
 */
export async function grantRuntimePermissions(deps: GrantRuntimePermissionsDeps): Promise<void> {
  const declared = await readRuntimePermissions(deps.exec, deps.packageName)
  const wanted = new Set<string>(deps.expected ?? [])
  for (const [permission, granted] of declared) if (!granted) wanted.add(permission)
  // Already-granted ones are dropped so a device that only needed one grant
  // does not pay for three round trips — but only when the device told us so.
  for (const [permission, granted] of declared) if (granted) wanted.delete(permission)
  if (wanted.size === 0) {
    deps.onLog?.('debug', `${deps.packageName} has no ungranted runtime permissions after the no-\`-g\` install`)
    return
  }

  const failures: string[] = []
  const attempted: string[] = []
  for (const permission of wanted) {
    try {
      const result = await deps.exec(`pm grant ${shellQuote(deps.packageName)} ${shellQuote(permission)}`)
      const text = `${result.stdout}\n${result.stderr}`.trim()
      if (NOT_A_RUNTIME_PERMISSION.some((needle) => text.includes(needle))) {
        deps.onLog?.(
          'debug',
          `pm grant ${deps.packageName} ${permission}: not a runtime permission on this build (${JSON.stringify(text)}) — nothing to grant`,
        )
        continue
      }
      // `exitCode === null` means the device is too old for the framed shell
      // service and there is no exit status to read (plan 53 §3.4) — the
      // readback below is what decides in that case, exactly like
      // `isInstalled()` falls back to output shape rather than treating
      // "unknown" as "no".
      if ((result.exitCode !== null && result.exitCode !== 0) || text.includes('Exception')) {
        failures.push(`${permission} (${text || `pm grant exited ${result.exitCode}`})`)
        continue
      }
      attempted.push(permission)
    } catch (err) {
      failures.push(`${permission} (${err instanceof Error ? err.message : String(err)})`)
    }
  }

  if (attempted.length > 0) {
    const after = await readRuntimePermissions(deps.exec, deps.packageName)
    for (const permission of attempted) {
      // Absent from the readback = unreadable, not denied. See
      // `readRuntimePermissions`'s own doc comment.
      if (after.get(permission) === false) failures.push(`${permission} (pm grant reported success but the device still reads granted=false)`)
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `${deps.packageName} was installed without the -g flag (this platform refuses it) and ${failures.length} runtime ` +
        `permission(s) could not be granted afterwards: ${failures.join('; ')} — the package is installed but not fully ` +
        'usable, so this pass is reported as failed rather than ready',
    )
  }
  if (attempted.length > 0) {
    deps.onLog?.('info', `granted ${attempted.join(', ')} to ${deps.packageName} explicitly (the -g install flag is unavailable on this device)`)
  }
}

export interface InstallWithGrantFallbackDeps {
  serial: string
  /** CLI-level adb. The install lane is applied here, not by the caller. */
  hostAdb: (args: string[], opts?: { lane?: 'default' | 'install'; serial?: string }) => Promise<string>
  /** Per-device shell exec — only reached on the fallback path, for `pm grant`/`dumpsys`. */
  exec: GrantExec
  apkPath: string
  packageName: string
  /** Permissions the caller knows the app declares; unioned with the device's own answer. */
  expectedPermissions?: readonly string[]
  /** Extra `adb install` flags BEFORE the `-g` this helper owns, e.g. `['-r']`. */
  flags?: readonly string[]
  onLog?: (level: 'debug' | 'info' | 'warn', msg: string) => void
}

/**
 * `adb install -r -g <apk>`, falling back to `adb install -r <apk>` plus
 * explicit `pm grant`s when — and only when — the platform refuses the `-g`
 * flag itself. Every other install failure is rethrown untouched, so a
 * missing APK, a signature clash, or an out-of-space device still surfaces
 * with its own message and its own diagnosis.
 */
export async function installWithGrantFallback(deps: InstallWithGrantFallbackDeps): Promise<void> {
  const base = ['-s', deps.serial, 'install', ...(deps.flags ?? [])]
  const lane = { lane: 'install' as const, serial: deps.serial }
  try {
    await deps.hostAdb([...base, '-g', deps.apkPath], lane)
    return
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err)
    if (!isGrantAllPermissionsRejection(text)) throw err
    deps.onLog?.(
      'warn',
      `${deps.serial} refuses the -g install flag (the shell user has no INSTALL_GRANT_RUNTIME_PERMISSIONS on this build) — ` +
        `reinstalling ${deps.packageName} without it and granting its runtime permissions explicitly`,
    )
  }
  await deps.hostAdb([...base, deps.apkPath], lane)
  await grantRuntimePermissions({
    exec: deps.exec,
    packageName: deps.packageName,
    ...(deps.expectedPermissions ? { expected: deps.expectedPermissions } : {}),
    ...(deps.onLog ? { onLog: deps.onLog } : {}),
  })
}
