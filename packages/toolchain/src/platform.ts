import { ToolchainError } from './errors'
import type { PlatformKey } from './types'

/** Deteksi platform key host (plan 02 §4.2). */
export function currentPlatformKey(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): Exclude<PlatformKey, '*'> {
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64'
  if (platform === 'darwin' && arch === 'x64') return 'darwin-x64'
  if (platform === 'linux' && arch === 'x64') return 'linux-x64'
  if (platform === 'linux' && arch === 'arm64') return 'linux-arm64'
  if (platform === 'win32' && arch === 'x64') return 'win32-x64'
  throw new ToolchainError('E_PLATFORM_UNSUPPORTED', `unsupported platform: ${platform}-${arch}`)
}

/** Artifact for the host platform: a specific entry wins, '*' is the fallback. */
export function pickPlatformKey(
  available: string[],
  host: Exclude<PlatformKey, '*'>,
): PlatformKey | null {
  if (available.includes(host)) return host
  if (available.includes('*')) return '*'
  return null
}
