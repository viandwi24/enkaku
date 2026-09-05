import { join } from 'node:path'
import { homedir } from 'node:os'
import { EnkakuError } from '../util/errors'

/**
 * Resolves the host's Android SDK — plan 400 D3: three tiers, then a clear
 * error, and NEVER a download. Mirrors `resolveGuestAgentApkPath`
 * (`api/guest-agent.ts:150-179`) in spirit: a system image is 1.5-3 GB and
 * covered by the Android SDK Terms, the same licence that keeps adb out of
 * the release (`LICENSES.md:11`, `:19`).
 *
 * Tiers, first match wins:
 *   1. `ENKAKU_ANDROID_SDK_PATH` — an explicit override, always wins.
 *   2. `ANDROID_SDK_ROOT`, then `ANDROID_HOME`, then the per-OS default location.
 *   3. A clear error naming what to install and the command to install it.
 */

/** Per-OS default SDK locations (plan 400 D3 tier 2, last resort before the error). `$HOME`/`$LOCALAPPDATA` are expanded against `deps.env`. */
const DEFAULT_SDK_PATHS: Record<string, string[]> = {
  darwin: ['$HOME/Library/Android/sdk'],
  linux: ['$HOME/Android/Sdk', '$HOME/android-sdk'],
  win32: ['$LOCALAPPDATA/Android/Sdk'],
}

export interface AndroidSdk {
  root: string
  /** `<root>/emulator/emulator[.exe]` */
  emulator: string
  /** `<root>/cmdline-tools/latest/bin/avdmanager[.bat]`, falling back to the legacy `<root>/tools/bin/`. */
  avdmanager: string
  source: 'override' | 'env' | 'default'
}

/**
 * Test seam, mirroring `resolveGuestAgentApkPath`'s own `{ env, exists }` seam
 * (`api/guest-agent.ts:154-159`) so the tests do not depend on the executor's
 * own machine having (or not having) an Android SDK installed.
 */
export interface SdkResolveDeps {
  env?: NodeJS.ProcessEnv
  /** Defaults to a real filesystem existence check. Injected so tests need no disk. */
  exists?: (path: string) => Promise<boolean>
  platform?: NodeJS.Platform
}

async function defaultExists(path: string): Promise<boolean> {
  return await Bun.file(path).exists().catch(() => false)
}

function readVar(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name]
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  return trimmed === '' ? undefined : trimmed
}

function expandPath(template: string, env: NodeJS.ProcessEnv): string {
  return template
    .replace('$HOME', env.HOME ?? homedir())
    .replace('$LOCALAPPDATA', env.LOCALAPPDATA ?? join(env.HOME ?? homedir(), 'AppData', 'Local'))
}

function defaultCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  return (DEFAULT_SDK_PATHS[platform] ?? []).map((template) => expandPath(template, env))
}

async function resolveRoot(
  env: NodeJS.ProcessEnv,
  exists: (path: string) => Promise<boolean>,
  platform: NodeJS.Platform,
): Promise<{ root: string; source: AndroidSdk['source'] } | null> {
  const override = readVar(env, 'ENKAKU_ANDROID_SDK_PATH')
  if (override) return { root: override, source: 'override' }

  const sdkRoot = readVar(env, 'ANDROID_SDK_ROOT')
  if (sdkRoot) return { root: sdkRoot, source: 'env' }

  const androidHome = readVar(env, 'ANDROID_HOME')
  if (androidHome) return { root: androidHome, source: 'env' }

  for (const candidate of defaultCandidates(platform, env)) {
    if (await exists(candidate)) return { root: candidate, source: 'default' }
  }
  return null
}

async function resolveAvdmanagerPath(
  root: string,
  platform: NodeJS.Platform,
  exists: (path: string) => Promise<boolean>,
): Promise<string> {
  const bin = platform === 'win32' ? 'avdmanager.bat' : 'avdmanager'
  const modern = join(root, 'cmdline-tools', 'latest', 'bin', bin)
  if (await exists(modern)) return modern
  // Legacy layout — still shipped, still works (plan 400 D4).
  return join(root, 'tools', 'bin', bin)
}

function buildMissingMessage(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  const abi = platform === 'darwin' && process.arch === 'arm64' ? 'arm64-v8a' : 'x86_64'
  const defaults = defaultCandidates(platform, env)
  const lookedIn = ['ENKAKU_ANDROID_SDK_PATH', 'ANDROID_SDK_ROOT', 'ANDROID_HOME', ...defaults].join(', ')
  return (
    `the Android SDK was not found. Enkaku never downloads it (a system image is 1.5-3 GB and\n` +
    `is covered by the Android SDK Terms). Install the command-line tools and one system image,\n` +
    `then set ANDROID_SDK_ROOT or ENKAKU_ANDROID_SDK_PATH:\n\n` +
    `  sdkmanager "platform-tools" "emulator" "system-images;android-36;google_apis;${abi}"\n\n` +
    `Looked in: ${lookedIn}`
  )
}

/** Throws `E_ANDROID_SDK_MISSING` with the install command when every tier misses. */
export async function resolveAndroidSdk(deps: SdkResolveDeps = {}): Promise<AndroidSdk> {
  const env = deps.env ?? process.env
  const exists = deps.exists ?? defaultExists
  const platform = deps.platform ?? process.platform

  const found = await resolveRoot(env, exists, platform)
  if (!found) {
    throw new EnkakuError('E_ANDROID_SDK_MISSING', buildMissingMessage(platform, env))
  }

  const emulator = join(found.root, 'emulator', platform === 'win32' ? 'emulator.exe' : 'emulator')
  const avdmanager = await resolveAvdmanagerPath(found.root, platform, exists)
  return { root: found.root, emulator, avdmanager, source: found.source }
}

/**
 * Which tier `resolveAndroidSdk` WOULD take, without taking it — the twin of
 * `describeGuestAgentApk` (`api/guest-agent.ts:141`). Provisions nothing, so the
 * doctor check and the boot log may both call it.
 */
export async function describeAndroidSdk(deps: SdkResolveDeps = {}): Promise<{ source: AndroidSdk['source'] | 'missing'; detail: string }> {
  try {
    const sdk = await resolveAndroidSdk(deps)
    const label = sdk.source === 'override' ? 'ENKAKU_ANDROID_SDK_PATH' : sdk.source === 'env' ? 'ANDROID_SDK_ROOT/ANDROID_HOME' : 'the per-OS default location'
    return { source: sdk.source, detail: `${label} → ${sdk.root}` }
  } catch (err) {
    if (err instanceof EnkakuError && err.code === 'E_ANDROID_SDK_MISSING') {
      return { source: 'missing', detail: err.message }
    }
    throw err
  }
}
