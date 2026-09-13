import { describe, expect, test } from 'bun:test'
import { denyAppPermissions, grantAppPermissions, parseRuntimePermissions } from './app-permissions'

/**
 * `app.grantPermissions` / `app.denyPermissions` against a fake package manager that STORES what
 * is written, so read-back is what decides an outcome — the same discipline `orientation.test.ts`
 * applies to settings. The dumpsys text is the real line shape, copied from the owner's moto
 * (Android 15, 2026-09-14): `android.permission.CAMERA: granted=false, flags=[ USER_SET|USER_FIXED|… ]`.
 */

type Perm = { granted: boolean; flags: string[] }

function fakePm(opts: { installed?: boolean; perms?: Record<string, Perm>; refuseGrant?: string[]; ignoreFlags?: boolean } = {}) {
  const installed = opts.installed ?? true
  const perms: Record<string, Perm> = JSON.parse(JSON.stringify(opts.perms ?? {}))
  const calls: string[] = []
  const ok = (stdout: string, stderr = '', exitCode = 0) => ({ stdout, stderr, exitCode })
  const exec = async (cmd: string) => {
    calls.push(cmd)
    if (cmd.startsWith('dumpsys package')) {
      if (!installed) return ok('Unable to find package: com.example.app\n')
      const lines = Object.entries(perms).map(([name, p]) => `      ${name}: granted=${p.granted}, flags=[ ${p.flags.join('|')}]`)
      return ok(`Packages:\n  Package [com.example.app] (abc):\n    runtime permissions:\n${lines.join('\n')}\n`)
    }
    const grant = /^pm grant '[^']+' (\S+)$/.exec(cmd)
    if (grant) {
      const name = grant[1] as string
      if (opts.refuseGrant?.includes(name)) return ok('', `Exception occurred while executing 'grant': java.lang.SecurityException: ${name} is not a changeable permission type`, 255)
      if (perms[name]) perms[name].granted = true
      return ok('')
    }
    const revoke = /^pm revoke '[^']+' (\S+)$/.exec(cmd)
    if (revoke) {
      const name = revoke[1] as string
      if (perms[name]) perms[name].granted = false
      return ok('')
    }
    const flags = /^pm set-permission-flags '[^']+' (\S+) (.+)$/.exec(cmd)
    if (flags) {
      const name = flags[1] as string
      if (perms[name] && !opts.ignoreFlags) {
        for (const f of (flags[2] as string).split(' ')) {
          const upper = f.toUpperCase().replace(/-/g, '_')
          if (!perms[name].flags.includes(upper)) perms[name].flags.push(upper)
        }
      }
      return ok('')
    }
    return ok('')
  }
  return { exec, calls, perms }
}

describe('parseRuntimePermissions', () => {
  test('reads granted and flags from the real dumpsys line shape; the first user wins', () => {
    const text = [
      '    runtime permissions:',
      '      android.permission.CAMERA: granted=false, flags=[ USER_SET|USER_FIXED|USER_SENSITIVE_WHEN_GRANTED]',
      '      android.permission.READ_MEDIA_VIDEO: granted=true, flags=[ USER_SET]',
      '  User 10:',
      '      android.permission.CAMERA: granted=true, flags=[ ]',
    ].join('\n')
    const parsed = parseRuntimePermissions(text)
    expect(parsed.get('android.permission.CAMERA')).toEqual({ granted: false, flags: ['USER_SET', 'USER_FIXED', 'USER_SENSITIVE_WHEN_GRANTED'] })
    expect(parsed.get('android.permission.READ_MEDIA_VIDEO')).toEqual({ granted: true, flags: ['USER_SET'] })
  })
})

describe('grantAppPermissions', () => {
  test('grants only what is declared and not yet granted, and reports each from the read-back', async () => {
    const pm = fakePm({
      perms: {
        'android.permission.CAMERA': { granted: false, flags: [] },
        'android.permission.READ_MEDIA_VIDEO': { granted: true, flags: ['USER_SET'] },
      },
    })
    const results = await grantAppPermissions(pm.exec, 'com.example.app', ['CAMERA', 'READ_MEDIA_VIDEO', 'POST_NOTIFICATIONS'])
    expect(results).toEqual([
      { permission: 'CAMERA', outcome: 'granted' },
      { permission: 'READ_MEDIA_VIDEO', outcome: 'already' },
      // Not declared by this app (or not on this Android version) — normal, not an error.
      { permission: 'POST_NOTIFICATIONS', outcome: 'not-requested' },
    ])
    expect(pm.calls.filter((c) => c.startsWith('pm '))).toEqual(["pm grant 'com.example.app' android.permission.CAMERA"])
  })

  test('nothing to write means no second read', async () => {
    const pm = fakePm({ perms: { 'android.permission.CAMERA': { granted: true, flags: [] } } })
    await grantAppPermissions(pm.exec, 'com.example.app', ['CAMERA'])
    expect(pm.calls).toEqual(["dumpsys package 'com.example.app'"])
  })

  test('a grant the platform refuses is reported as failed with its own words, not as granted', async () => {
    const pm = fakePm({ perms: { 'android.permission.CAMERA': { granted: false, flags: [] } }, refuseGrant: ['android.permission.CAMERA'] })
    const [result] = await grantAppPermissions(pm.exec, 'com.example.app', ['CAMERA'])
    expect(result?.outcome).toBe('failed')
    expect(result?.detail).toContain('not a changeable permission type')
  })

  test('an app that is not installed is refused by name, not reported as eight not-requested', async () => {
    const pm = fakePm({ installed: false })
    await expect(grantAppPermissions(pm.exec, 'com.example.app', ['CAMERA'])).rejects.toMatchObject({ code: 'E_APP_NOT_INSTALLED' })
  })
})

describe('denyAppPermissions', () => {
  test('refused and USER_FIXED already is left alone — the state the YouTube walk needs', async () => {
    const pm = fakePm({ perms: { 'android.permission.CAMERA': { granted: false, flags: ['USER_SET', 'USER_FIXED'] } } })
    const [result] = await denyAppPermissions(pm.exec, 'com.example.app', ['CAMERA'])
    expect(result).toEqual({ permission: 'CAMERA', outcome: 'already' })
    expect(pm.calls.filter((c) => c.startsWith('pm '))).toEqual([])
  })

  test('a granted permission is revoked AND fixed, so Android never asks again', async () => {
    const pm = fakePm({ perms: { 'android.permission.CAMERA': { granted: true, flags: ['USER_SET'] } } })
    const [result] = await denyAppPermissions(pm.exec, 'com.example.app', ['CAMERA'])
    expect(result).toEqual({ permission: 'CAMERA', outcome: 'denied' })
    expect(pm.calls.filter((c) => c.startsWith('pm '))).toEqual([
      "pm revoke 'com.example.app' android.permission.CAMERA",
      "pm set-permission-flags 'com.example.app' android.permission.CAMERA user-set user-fixed",
    ])
    expect(pm.perms['android.permission.CAMERA']).toEqual({ granted: false, flags: ['USER_SET', 'USER_FIXED'] })
  })

  test('a never-answered permission is only fixed (there is nothing to revoke)', async () => {
    const pm = fakePm({ perms: { 'android.permission.CAMERA': { granted: false, flags: [] } } })
    await denyAppPermissions(pm.exec, 'com.example.app', ['CAMERA'])
    expect(pm.calls.filter((c) => c.startsWith('pm '))).toEqual(["pm set-permission-flags 'com.example.app' android.permission.CAMERA user-set user-fixed"])
  })

  test('flags that did not take are reported as failed — a refusal Android will still ask about is not a denial', async () => {
    const pm = fakePm({ perms: { 'android.permission.CAMERA': { granted: false, flags: [] } }, ignoreFlags: true })
    const [result] = await denyAppPermissions(pm.exec, 'com.example.app', ['CAMERA'])
    expect(result?.outcome).toBe('failed')
  })
})
