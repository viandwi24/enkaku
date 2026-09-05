import { describe, expect, test } from 'bun:test'
import { INSTALLABLE_PACKAGES, installSdkPackages, managedSdkRoot, packagesFor, type SdkInstallRequest } from './sdk-install'
import { createLogger } from '../util/logger'

const base: SdkInstallRequest = { target: 'detected', packages: ['emulator'], acceptLicenses: true }
const log = createLogger('test')

describe('packagesFor', () => {
  test('a system image brings its platform with it — avdmanager refuses an AVD whose platform is absent', () => {
    expect(packagesFor({ ...base, systemImage: { apiLevel: 35, variant: 'google_apis', abi: 'arm64-v8a' } })).toEqual([
      'emulator',
      'system-images;android-35;google_apis;arm64-v8a',
      'platforms;android-35',
    ])
  })

  test('no image, no extras', () => {
    expect(packagesFor(base)).toEqual(['emulator'])
  })

  test('the installable list is closed — this is not a shell', () => {
    expect(INSTALLABLE_PACKAGES).toEqual(['emulator', 'platform-tools'])
  })
})

describe('installSdkPackages refuses before it spawns anything', () => {
  test('licences not accepted', async () => {
    await expect(installSdkPackages({ ...base, acceptLicenses: false }, { dataDir: '/tmp/x', log }, () => {})).rejects.toThrow(/Android SDK Terms/)
  })

  test('nothing requested', async () => {
    await expect(installSdkPackages({ ...base, packages: [] }, { dataDir: '/tmp/x', log }, () => {})).rejects.toThrow(/no packages/)
  })
})

describe('the managed destination is this farm’s own directory', () => {
  test('never a caller-supplied path — the request cannot name one at all', () => {
    expect(managedSdkRoot('/var/enkaku')).toBe('/var/enkaku/android-sdk')
    // The type has no field for a path, which is the point: a free-text
    // directory would be an authenticated operator telling the core to write
    // gigabytes anywhere it can reach.
    expect(Object.keys(base)).not.toContain('path')
  })
})
