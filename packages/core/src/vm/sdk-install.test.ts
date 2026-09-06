import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { INSTALLABLE_PACKAGES, appendInstallLine, installSdkPackages, managedSdkRoot, packagesFor, type SdkInstallRequest } from './sdk-install'
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
    expect(INSTALLABLE_PACKAGES).toEqual(['emulator', 'platform-tools', 'cmdline-tools'])
  })

  test('cmdline-tools resolves to the sdkmanager coordinate, not its own name', () => {
    // `avdmanager` reads the SDK it manages off its own location, so this is
    // the package that has to land INSIDE the SDK root for a create to work.
    expect(packagesFor({ ...base, packages: ['cmdline-tools'] })).toEqual(['cmdline-tools;latest'])
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
    // `join`, not a `/` literal — `managedSdkRoot` builds this with `node:path`,
    // so the real answer carries backslashes on Windows.
    expect(managedSdkRoot('/var/enkaku')).toBe(join('/var/enkaku', 'android-sdk'))
    // The type has no field for a path, which is the point: a free-text
    // directory would be an authenticated operator telling the core to write
    // gigabytes anywhere it can reach.
    expect(Object.keys(base)).not.toContain('path')
  })
})

describe('appendInstallLine keeps the progress bar in place', () => {
  test('a progress redraw replaces the previous one', () => {
    const lines: string[] = []
    appendInstallLine(lines, '$ sdkmanager --sdk_root=/x system-images;android-35;google_apis;x86_64')
    appendInstallLine(lines, '[=====                  ] 12% Downloading system-image...')
    appendInstallLine(lines, '[==========             ] 41% Downloading system-image...')
    appendInstallLine(lines, '[====================   ] 88% Downloading system-image...')
    expect(lines).toEqual(['$ sdkmanager --sdk_root=/x system-images;android-35;google_apis;x86_64', '[====================   ] 88% Downloading system-image...'])
  })

  test('an ordinary line after a bar is kept, and starts a new bar', () => {
    const lines: string[] = []
    appendInstallLine(lines, '[=====                  ] 12% Downloading system-image...')
    appendInstallLine(lines, '"Install system-images;android-35;google_apis;x86_64"')
    appendInstallLine(lines, '[=                      ] 3% Downloading platforms...')
    appendInstallLine(lines, '[===                    ] 9% Downloading platforms...')
    expect(lines).toEqual([
      '[=====                  ] 12% Downloading system-image...',
      '"Install system-images;android-35;google_apis;x86_64"',
      '[===                    ] 9% Downloading platforms...',
    ])
  })
})
