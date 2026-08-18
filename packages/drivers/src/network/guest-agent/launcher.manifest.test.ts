import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { GUEST_AGENT_RUNTIME_PERMISSIONS } from './launcher'

/**
 * Keeps `GUEST_AGENT_RUNTIME_PERMISSIONS` honest against the agent's actual
 * manifest.
 *
 * That list is what `install()` grants by hand on a device that refuses the
 * `-g` install flag (a Xiaomi HyperOS build does), so a permission added to
 * the manifest and not to the list would install ungranted on exactly those
 * phones and fail at USE time — the silent half-install this whole path
 * exists to prevent.
 *
 * Protection levels are not in the manifest, so this cannot classify a new
 * permission by itself. It does the next best thing: every permission the
 * manifest declares must be either in the runtime list below or in the
 * explicit install-time allowlist. Adding ANY new `<uses-permission>` fails
 * this test until someone decides which side it belongs on — which is the
 * decision that was being skipped.
 *
 * Skipped, not failed, when `apps/` is not beside the checkout: a compiled
 * release binary has no `apps/` directory, and this guard is for the repo.
 */
const MANIFEST = join(import.meta.dir, '../../../../../apps/guest-agent/app/src/main/AndroidManifest.xml')

/**
 * Declared in the manifest and granted at install time whether `-g` is
 * present or not — `normal` protection level, nothing to `pm grant`.
 */
const INSTALL_TIME_PERMISSIONS = [
  'android.permission.INTERNET',
  'android.permission.ACCESS_NETWORK_STATE',
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_SPECIAL_USE',
  'android.permission.RECEIVE_BOOT_COMPLETED',
  'android.permission.SET_WALLPAPER',
]

describe('GUEST_AGENT_RUNTIME_PERMISSIONS vs the guest agent manifest', () => {
  test('every <uses-permission> is classified as either runtime or install-time', async () => {
    const file = Bun.file(MANIFEST)
    if (!(await file.exists())) return // not a checkout — see this file's doc comment
    const xml = await file.text()
    const declared = [...xml.matchAll(/<uses-permission\s+android:name="([^"]+)"/g)].map((m) => m[1]!)
    expect(declared.length).toBeGreaterThan(0)

    const known = new Set<string>([...INSTALL_TIME_PERMISSIONS, ...GUEST_AGENT_RUNTIME_PERMISSIONS])
    const unclassified = declared.filter((name) => !known.has(name))
    expect(unclassified).toEqual([])
  })

  test('every permission in the runtime list is actually declared by the manifest', async () => {
    const file = Bun.file(MANIFEST)
    if (!(await file.exists())) return
    const xml = await file.text()
    for (const permission of GUEST_AGENT_RUNTIME_PERMISSIONS) {
      expect(xml).toContain(`android:name="${permission}"`)
    }
  })
})
