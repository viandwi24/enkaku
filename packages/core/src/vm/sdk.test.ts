import { describe, expect, test } from 'bun:test'
import { EnkakuError } from '../util/errors'
import { describeAndroidSdk, resolveAndroidSdk, type SdkResolveDeps } from './sdk'

function neverExists(): Promise<boolean> {
  return Promise.resolve(false)
}

function onlyExists(...paths: string[]): (path: string) => Promise<boolean> {
  const set = new Set(paths)
  return (path: string) => Promise.resolve(set.has(path))
}

describe('resolveAndroidSdk', () => {
  test('tier 1 (ENKAKU_ANDROID_SDK_PATH) wins over tier 2 (ANDROID_SDK_ROOT)', async () => {
    const deps: SdkResolveDeps = {
      env: { ENKAKU_ANDROID_SDK_PATH: '/override/sdk', ANDROID_SDK_ROOT: '/env/sdk' },
      exists: neverExists,
      platform: 'linux',
    }
    const sdk = await resolveAndroidSdk(deps)
    expect(sdk.root).toBe('/override/sdk')
    expect(sdk.source).toBe('override')
  })

  test('ANDROID_SDK_ROOT beats ANDROID_HOME', async () => {
    const deps: SdkResolveDeps = {
      env: { ANDROID_SDK_ROOT: '/env/root-sdk', ANDROID_HOME: '/env/home-sdk' },
      exists: neverExists,
      platform: 'linux',
    }
    const sdk = await resolveAndroidSdk(deps)
    expect(sdk.root).toBe('/env/root-sdk')
    expect(sdk.source).toBe('env')
  })

  test('ANDROID_HOME is used when ANDROID_SDK_ROOT is unset', async () => {
    const deps: SdkResolveDeps = {
      env: { ANDROID_HOME: '/env/home-sdk' },
      exists: neverExists,
      platform: 'linux',
    }
    const sdk = await resolveAndroidSdk(deps)
    expect(sdk.root).toBe('/env/home-sdk')
    expect(sdk.source).toBe('env')
  })

  test('the per-OS default is used when both env vars are unset', async () => {
    const deps: SdkResolveDeps = {
      env: { HOME: '/home/op' },
      exists: onlyExists('/home/op/Android/Sdk'),
      platform: 'linux',
    }
    const sdk = await resolveAndroidSdk(deps)
    expect(sdk.root).toBe('/home/op/Android/Sdk')
    expect(sdk.source).toBe('default')
  })

  test('the miss throws E_ANDROID_SDK_MISSING and the message contains the sdkmanager line', async () => {
    const deps: SdkResolveDeps = {
      env: { HOME: '/home/op' },
      exists: neverExists,
      platform: 'linux',
    }
    let caught: unknown
    try {
      await resolveAndroidSdk(deps)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(EnkakuError)
    const enkakuErr = caught as EnkakuError
    expect(enkakuErr.code).toBe('E_ANDROID_SDK_MISSING')
    expect(enkakuErr.message).toContain('sdkmanager "platform-tools" "emulator" "system-images;android-36;google_apis;')
    expect(enkakuErr.message).toContain('Looked in: ENKAKU_ANDROID_SDK_PATH, ANDROID_SDK_ROOT, ANDROID_HOME')
  })

  test('on win32 the binaries end .exe and .bat', async () => {
    const deps: SdkResolveDeps = {
      env: { ENKAKU_ANDROID_SDK_PATH: 'C:/sdk' },
      exists: neverExists,
      platform: 'win32',
    }
    const sdk = await resolveAndroidSdk(deps)
    expect(sdk.emulator.endsWith('emulator.exe')).toBe(true)
    expect(sdk.avdmanager.endsWith('avdmanager.bat')).toBe(true)
  })

  test('the legacy tools/bin/avdmanager is used when cmdline-tools/latest is absent', async () => {
    const root = '/sdk'
    const deps: SdkResolveDeps = {
      env: { ENKAKU_ANDROID_SDK_PATH: root },
      // Nothing exists at cmdline-tools/latest, so the legacy path is used.
      exists: neverExists,
      platform: 'linux',
    }
    const sdk = await resolveAndroidSdk(deps)
    expect(sdk.avdmanager).toBe(`${root}/tools/bin/avdmanager`)
  })

  test('the modern cmdline-tools/latest/bin/avdmanager wins when present', async () => {
    const root = '/sdk'
    const modern = `${root}/cmdline-tools/latest/bin/avdmanager`
    const deps: SdkResolveDeps = {
      env: { ENKAKU_ANDROID_SDK_PATH: root },
      exists: onlyExists(modern),
      platform: 'linux',
    }
    const sdk = await resolveAndroidSdk(deps)
    expect(sdk.avdmanager).toBe(modern)
  })
})

describe('describeAndroidSdk', () => {
  test('reports the tier it would take, without throwing', async () => {
    const deps: SdkResolveDeps = {
      env: { ENKAKU_ANDROID_SDK_PATH: '/override/sdk' },
      exists: neverExists,
      platform: 'linux',
    }
    const result = await describeAndroidSdk(deps)
    expect(result.source).toBe('override')
    expect(result.detail).toContain('/override/sdk')
  })

  test('reports "missing" with the same message resolveAndroidSdk would throw, never throwing itself', async () => {
    const deps: SdkResolveDeps = {
      env: {},
      exists: neverExists,
      platform: 'linux',
    }
    const result = await describeAndroidSdk(deps)
    expect(result.source).toBe('missing')
    expect(result.detail).toContain('sdkmanager')
  })
})
