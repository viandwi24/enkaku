import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

  test('the legacy tools/bin/avdmanager is used when it is the one that exists', async () => {
    const root = '/sdk'
    const legacy = `${root}/tools/bin/avdmanager`
    const deps: SdkResolveDeps = {
      env: { ENKAKU_ANDROID_SDK_PATH: root },
      exists: onlyExists(legacy),
      platform: 'linux',
    }
    const sdk = await resolveAndroidSdk(deps)
    expect(sdk.avdmanager).toBe(legacy)
  })

  /*
    This used to assert the legacy path was returned when NOTHING existed —
    the bug, written down as the contract. A path to a file that is not there
    is not a fallback; it reaches the operator as `posix_spawn ENOENT` at the
    end of a create, and it made a failed VM impossible to delete, because
    delete runs the same tool (owner, 2026-09-06).
  */
  test('the Toolchain Manager’s own avdmanager is found when the SDK has none', async () => {
    const root = '/sdk'
    const toolchain = '/data/tools/cmdline-tools/1/cmdline-tools/bin/sdkmanager'
    const sibling = '/data/tools/cmdline-tools/1/cmdline-tools/bin/avdmanager'
    const sdk = await resolveAndroidSdk({
      env: { ENKAKU_ANDROID_SDK_PATH: root },
      exists: onlyExists(sibling),
      platform: 'linux',
      toolchainSdkmanager: async () => toolchain,
    })
    expect(sdk.avdmanager).toBe(sibling)
  })

  test('with no avdmanager anywhere, the modern path is the one named', async () => {
    const root = '/sdk'
    const sdk = await resolveAndroidSdk({
      env: { ENKAKU_ANDROID_SDK_PATH: root },
      exists: neverExists,
      platform: 'linux',
      toolchainSdkmanager: async () => null,
    })
    expect(sdk.avdmanager).toBe(`${root}/cmdline-tools/latest/bin/avdmanager`)
  })

  test('the managed root answers when no other tier does', async () => {
    const managedRoot = '/data/android-sdk'
    const sdk = await resolveAndroidSdk({
      env: {},
      exists: onlyExists(managedRoot),
      platform: 'linux',
      managedRoot,
    })
    expect(sdk.root).toBe(managedRoot)
    expect(sdk.source).toBe('managed')
  })

  test('a real SDK still beats the managed root', async () => {
    const managedRoot = '/data/android-sdk'
    const real = '/home/u/Android/Sdk'
    const sdk = await resolveAndroidSdk({
      env: { ANDROID_SDK_ROOT: real },
      exists: async (p) => p === real || p === managedRoot,
      platform: 'linux',
      managedRoot,
    })
    expect(sdk.root).toBe(real)
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

describe('the default existence check handles a DIRECTORY (2026-09-05)', () => {
  test('an SDK sitting in the per-OS default location is found with nothing injected', async () => {
    // The bug this pins: `Bun.file(dir).exists()` is false for a directory,
    // so the default tier could never match in production while the doctor —
    // which injects `existsSync` — reported the same SDK as present. Every
    // other test in this file injects `exists`, which is precisely why none
    // of them could see it. This one injects nothing but the location.
    const root = mkdtempSync(join(tmpdir(), 'enkaku-sdk-'))
    try {
      mkdirSync(join(root, 'emulator'), { recursive: true })
      const resolved = await resolveAndroidSdk({ env: { ENKAKU_ANDROID_SDK_PATH: root } as NodeJS.ProcessEnv, platform: 'darwin' })
      expect(resolved.root).toBe(root)
      expect(resolved.source).toBe('override')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
