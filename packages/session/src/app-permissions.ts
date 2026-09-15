import type { AppPermissionDenial, AppPermissionGrant, AppPictureInPictureDenial, DeniableAppPermission, GrantableAppPermission } from '@enkaku/protocol'

/**
 * `app.grantPermissions` / `app.denyPermissions` — answering an app's runtime permission dialogs
 * before it can show them.
 *
 * ## Why this exists
 *
 * Android 14+ marks the system permission dialog "accessibility data sensitive", and the farm's
 * UI reader is not a declared assistive tool (a line this project will not cross — see
 * `plugins/youtube-automation-pack/src/post-video.ts`). The dialog is therefore invisible to a
 * run, and so is the app window underneath it: the reader returns the status bar and nothing
 * else. Measured on the owner's production SM-A075F fleet (2026-09-14, exported runs 9babb00e and
 * e59f9d9e): TikTok's upload stopped five settle rounds in a row on a dump of 56 System UI nodes,
 * with Samsung's camera dialog on screen. The phones that worked on the dev farm had had the same
 * dialogs answered by hand once (`USER_SET` on the permission's flags).
 *
 * The package manager can set a runtime permission over adb without any dialog, so the reliable
 * answer is to set it before the app opens, not to try to tap what cannot be seen.
 *
 * ## Read, write, read back
 *
 * `pm`'s exit status is not the evidence: a permission the app never declared, or one this Android
 * version does not have, fails in ways that are not errors for a caller asking for the union its
 * apps need across versions. So the package is read once, only what is declared AND not already in
 * the wanted state is written, and the package is read again to report what is actually true.
 */

type Exec = (cmd: string) => Promise<{ stdout: string; stderr: string; exitCode: number | null }>

export interface RuntimePermissionState {
  granted: boolean
  /** The `flags=[…]` names, e.g. `USER_SET`, `USER_FIXED`. Empty when the line carries none. */
  flags: string[]
}

/**
 * `android.permission.X: granted=true|false, flags=[ A|B ]` lines from `dumpsys package <pkg>`.
 *
 * The FIRST occurrence wins: a multi-user phone lists the permission once per user, and user 0 —
 * the one the farm drives — is printed first. Install-time permissions share the line shape and
 * are always granted; they are never in the allowlist, so they cannot confuse an answer.
 */
export function parseRuntimePermissions(dumpsys: string): Map<string, RuntimePermissionState> {
  const out = new Map<string, RuntimePermissionState>()
  for (const m of dumpsys.matchAll(/^\s*(android\.permission\.[A-Z0-9_]+): granted=(true|false)(?:, flags=\[([^\]]*)\])?/gm)) {
    const name = m[1] as string
    if (out.has(name)) continue
    const flags = (m[3] ?? '')
      .split('|')
      .map((f) => f.trim())
      .filter((f) => f !== '')
    out.set(name, { granted: m[2] === 'true', flags })
  }
  return out
}

/** A package name, single-quoted. `PackageNameSchema` already refuses metacharacters; this is the second lock. */
function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * The package read, filtered ON THE DEVICE to the three kinds of line this module uses.
 *
 * The whole `dumpsys package` text is not bounded: Instagram 446.0's is 296 KB on the owner's moto
 * (2026-09-14), over the transport's 256 KB output cap, so every `grantPermissions` for it failed
 * with "adb output exceeded 262144 bytes" before a single permission was read (YouTube's is 57 KB,
 * which is why the first caller never met it). Filtered it is under 5 KB. `grep` exits 1 when
 * nothing matches, and nothing here reads the exit code — the text decides, exactly as before.
 */
export function readPackageCommand(pkg: string): string {
  return `dumpsys package ${quote(pkg)} | grep -E '^ *Package \\[|Unable to find package|android\\.permission\\.[A-Z0-9_]+: granted='`
}

async function readPackage(exec: Exec, pkg: string): Promise<Map<string, RuntimePermissionState>> {
  const r = await exec(readPackageCommand(pkg))
  const text = `${r.stdout}\n${r.stderr}`
  // `dumpsys package` for an unknown package prints this and exits 0; an installed one always
  // prints its `Package [name]` block. Refused by name rather than reported as a list of
  // `not-requested`, which would read as "nothing to do" for an app that is not there at all.
  if (/Unable to find package/i.test(text) || !/Package \[/.test(text)) {
    throw Object.assign(new Error(`${pkg} is not installed on this device`), { code: 'E_APP_NOT_INSTALLED' })
  }
  return parseRuntimePermissions(r.stdout)
}

/** The mode `appops get <pkg> PICTURE_IN_PICTURE` prints (`PICTURE_IN_PICTURE: ignore; time=…`), or null when it prints none ("No operations."). */
export function parsePictureInPictureMode(text: string): string | null {
  const m = /PICTURE_IN_PICTURE:\s*([a-z_]+)/i.exec(text)
  return m ? (m[1] as string).toLowerCase() : null
}

/**
 * `app.denyPictureInPicture` — the app may not open as a picture-in-picture window. Read, write, read back, like the
 * permissions above: production phone #10 (2026-09-15) had YouTube come up as a small Shorts player over the launcher
 * even after a force-stop and a second launch, and a run cannot tap its way out of a window the app keeps reopening.
 */
export async function denyPictureInPicture(exec: Exec, pkg: string): Promise<AppPictureInPictureDenial> {
  const safe = async (cmd: string) => exec(cmd).catch((err: unknown) => ({ stdout: '', stderr: String(err), exitCode: 1 }))
  const read = async (): Promise<{ mode: string | null; text: string }> => {
    const r = await safe(`appops get ${quote(pkg)} PICTURE_IN_PICTURE`)
    const text = `${r.stdout}\n${r.stderr}`.trim()
    return { mode: parsePictureInPictureMode(text), text }
  }
  const before = await read()
  if (before.mode === 'ignore') return { outcome: 'already', mode: 'ignore' }
  const wrote = await safe(`appops set ${quote(pkg)} PICTURE_IN_PICTURE ignore`)
  const after = await read()
  if (after.mode === 'ignore') return { outcome: 'denied', mode: 'ignore' }
  return { outcome: 'failed', mode: after.mode ?? 'unreadable', detail: `${wrote.stdout}\n${wrote.stderr}\n${after.text}`.trim().slice(0, 300) }
}

async function run(exec: Exec, cmd: string): Promise<string> {
  const r = await exec(cmd).catch((err: unknown) => ({ stdout: '', stderr: String(err), exitCode: 1 }))
  return `${r.stdout} ${r.stderr}`.replace(/\s+/g, ' ').trim()
}

export async function grantAppPermissions(exec: Exec, pkg: string, permissions: readonly GrantableAppPermission[]): Promise<AppPermissionGrant[]> {
  const before = await readPackage(exec, pkg)
  const said = new Map<GrantableAppPermission, string>()
  const results: AppPermissionGrant[] = []

  for (const permission of [...new Set(permissions)]) {
    const state = before.get(`android.permission.${permission}`)
    if (state === undefined) {
      results.push({ permission, outcome: 'not-requested' })
    } else if (state.granted) {
      results.push({ permission, outcome: 'already' })
    } else {
      said.set(permission, await run(exec, `pm grant ${quote(pkg)} android.permission.${permission}`))
      results.push({ permission, outcome: 'granted' })
    }
  }
  if (said.size === 0) return results

  const after = await readPackage(exec, pkg)
  return results.map((result) => {
    if (!said.has(result.permission)) return result
    if (after.get(`android.permission.${result.permission}`)?.granted === true) return result
    return { permission: result.permission, outcome: 'failed', detail: said.get(result.permission) || 'still not granted after pm grant' }
  })
}

export async function denyAppPermissions(exec: Exec, pkg: string, permissions: readonly DeniableAppPermission[]): Promise<AppPermissionDenial[]> {
  const before = await readPackage(exec, pkg)
  const said = new Map<DeniableAppPermission, string>()
  const results: AppPermissionDenial[] = []

  for (const permission of [...new Set(permissions)]) {
    const full = `android.permission.${permission}`
    const state = before.get(full)
    if (state === undefined) {
      results.push({ permission, outcome: 'not-requested' })
    } else if (!state.granted && state.flags.includes('USER_FIXED')) {
      // Refused and "don't ask again" already — the exact state the walk needs. Nothing written.
      results.push({ permission, outcome: 'already' })
    } else {
      // Revoke first (a no-op when it was never granted), then fix the refusal so Android does not
      // show the dialog on the next request. `user-set` alone would still allow one more prompt.
      const revoke = state.granted ? await run(exec, `pm revoke ${quote(pkg)} ${full}`) : ''
      const fix = await run(exec, `pm set-permission-flags ${quote(pkg)} ${full} user-set user-fixed`)
      said.set(permission, [revoke, fix].filter((s) => s !== '').join('; '))
      results.push({ permission, outcome: 'denied' })
    }
  }
  if (said.size === 0) return results

  const after = await readPackage(exec, pkg)
  return results.map((result) => {
    if (!said.has(result.permission)) return result
    const state = after.get(`android.permission.${result.permission}`)
    if (state && !state.granted && state.flags.includes('USER_FIXED')) return result
    return {
      permission: result.permission,
      outcome: 'failed',
      detail: said.get(result.permission) || `reads ${state ? `granted=${state.granted}, flags=[${state.flags.join('|')}]` : 'nothing'} after revoke`,
    }
  })
}
