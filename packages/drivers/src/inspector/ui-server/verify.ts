import type { TransportExecOptions } from '@enkaku/protocol'

/**
 * On-device artifact verification (plan 41 §3.1, §3.2, §4.2). What is
 * downloaded is already sha256-verified (`@enkaku/toolchain`'s
 * `downloadVerified`); this checks what actually ended up installed on the
 * device, which a package-name-only `pm list packages` cannot distinguish
 * from a stale build or an APK installed by something else entirely — the
 * exact drift measured on the farm's moto g06 devices (v2.3.3, installed by
 * something other than the current toolchain run).
 */
export interface DeviceArtifactExpectation {
  packageName: string
  /** Omit to skip the version check (plan 41 §3.2 — a missing expectation must SKIP, not fail). */
  versionCode?: number
  /** Uppercase, colon-free hex SHA-256 of the signing certificate. Omit to skip the signature check. */
  signatureSha256?: string
}

export type VerifyResult =
  | { ok: true; versionCode: number }
  | {
      ok: false
      reason: 'not_installed' | 'version_mismatch' | 'signature_mismatch' | 'unreadable'
      observed?: { versionCode?: number; signature?: string }
    }

/** A full 64-hex-char token — the shape a signing certificate's SHA-256 digest takes once normalised. */
const SHA256_TOKEN = /\b[0-9a-fA-F]{64}\b/

/**
 * Reads `dumpsys package <pkg>` once and compares it against `expected`.
 * Two cheap greps over one shell round trip (§3.2) rather than pulling and
 * re-hashing the APK on every session start.
 *
 * Fields `expected` does not set are never compared — that is how a manifest
 * with no recorded expectation (§3.2, AC4) ends up only checking that the
 * package is installed at all, never blocking the inspector on missing
 * metadata of our own. A signature line this parser cannot make sense of
 * (`unreadable`) is likewise NOT treated as a mismatch by the caller — Android's
 * `dumpsys package` output for signatures is not stable across versions/OEMs
 * (plan 41 §8 risk table), so silence here must read as "could not check",
 * not as "different".
 */
export async function verifyDeviceArtifact(
  exec: (cmd: string, opts?: TransportExecOptions) => Promise<string>,
  expected: DeviceArtifactExpectation,
): Promise<VerifyResult> {
  const out = await exec(`dumpsys package ${expected.packageName}`, { profile: 'probe' })

  if (!out.includes(`Package [${expected.packageName}]`)) {
    return { ok: false, reason: 'not_installed' }
  }

  const versionMatch = out.match(/versionCode=(\d+)/)
  const observedVersionCode = versionMatch?.[1] !== undefined ? Number(versionMatch[1]) : undefined

  if (expected.versionCode !== undefined) {
    if (observedVersionCode === undefined) {
      return { ok: false, reason: 'unreadable' }
    }
    if (observedVersionCode !== expected.versionCode) {
      return { ok: false, reason: 'version_mismatch', observed: { versionCode: observedVersionCode } }
    }
  }

  if (expected.signatureSha256) {
    const observedSignature = extractSignature(out)
    if (!observedSignature) {
      return {
        ok: false,
        reason: 'unreadable',
        ...(observedVersionCode !== undefined ? { observed: { versionCode: observedVersionCode } } : {}),
      }
    }
    if (observedSignature !== expected.signatureSha256.toUpperCase()) {
      return {
        ok: false,
        reason: 'signature_mismatch',
        observed: {
          ...(observedVersionCode !== undefined ? { versionCode: observedVersionCode } : {}),
          signature: observedSignature,
        },
      }
    }
  }

  return { ok: true, versionCode: observedVersionCode ?? expected.versionCode ?? 0 }
}

/** The `signatures=` line plus the one after it (roughly `grep -A1 signatures`, §3.2), scanned for a sha256-shaped token. */
function extractSignature(dumpsysOutput: string): string | null {
  const lines = dumpsysOutput.split('\n')
  const idx = lines.findIndex((l) => l.includes('signatures='))
  if (idx === -1) return null
  const block = `${lines[idx]}\n${lines[idx + 1] ?? ''}`
  const match = block.match(SHA256_TOKEN)
  return match ? match[0].toUpperCase() : null
}
