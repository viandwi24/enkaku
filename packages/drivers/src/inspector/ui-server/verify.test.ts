import { describe, expect, test } from 'bun:test'
import { verifyDeviceArtifact, type DeviceArtifactExpectation } from './verify'

const PKG = 'com.github.uiautomator'

/** A realistic `dumpsys package <pkg>` excerpt — the part this parser reads. */
function dumpsysFixture(opts: { versionCode?: number; signature?: string } = {}): string {
  const versionLine = opts.versionCode !== undefined ? `      versionCode=${opts.versionCode} minSdk=21 targetSdk=29` : ''
  const sigLine = opts.signature !== undefined ? `      signatures=PackageSignatures{9f5c123 [1]}\n      cert=${opts.signature}` : ''
  return [
    'Activity Resolver Table:',
    '  Non-Data Actions:',
    '',
    'Packages:',
    `  Package [${PKG}] (39a4179):`,
    '    userId=10123',
    `    pkg=Package{39a4179 ${PKG}}`,
    '    codePath=/data/app/~~abc==/com.github.uiautomator-def==',
    versionLine,
    '    versionName=2.3.3',
    sigLine,
    '    dataDir=/data/user/0/com.github.uiautomator',
    '',
  ].join('\n')
}

const notInstalled = 'Unable to find package: com.github.uiautomator\n'

describe('verifyDeviceArtifact (plan 41 §3.2, §4.2)', () => {
  test('AC1: installed with the expected versionCode → ok', async () => {
    const expected: DeviceArtifactExpectation = { packageName: PKG, versionCode: 2003003 }
    const result = await verifyDeviceArtifact(async () => dumpsysFixture({ versionCode: 2003003 }), expected)
    expect(result).toEqual({ ok: true, versionCode: 2003003 })
  })

  test('AC1: a versionCode differing from the manifest is detected as version_mismatch', async () => {
    const expected: DeviceArtifactExpectation = { packageName: PKG, versionCode: 2003003 }
    const result = await verifyDeviceArtifact(async () => dumpsysFixture({ versionCode: 2001001 }), expected)
    expect(result).toEqual({ ok: false, reason: 'version_mismatch', observed: { versionCode: 2001001 } })
  })

  test('AC2: right name and version, different signing certificate → signature_mismatch', async () => {
    const expectedSig = 'AA'.repeat(32)
    const observedSig = 'BB'.repeat(32)
    const expected: DeviceArtifactExpectation = { packageName: PKG, versionCode: 2003003, signatureSha256: expectedSig }
    const result = await verifyDeviceArtifact(
      async () => dumpsysFixture({ versionCode: 2003003, signature: observedSig }),
      expected,
    )
    expect(result).toEqual({
      ok: false,
      reason: 'signature_mismatch',
      observed: { versionCode: 2003003, signature: observedSig },
    })
  })

  test('a matching signature (case-insensitive, colon-free) verifies ok', async () => {
    const sig = 'CD'.repeat(32)
    const expected: DeviceArtifactExpectation = { packageName: PKG, versionCode: 2003003, signatureSha256: sig.toLowerCase() }
    const result = await verifyDeviceArtifact(async () => dumpsysFixture({ versionCode: 2003003, signature: sig }), expected)
    expect(result).toEqual({ ok: true, versionCode: 2003003 })
  })

  test('absent package → not_installed', async () => {
    const expected: DeviceArtifactExpectation = { packageName: PKG, versionCode: 2003003 }
    const result = await verifyDeviceArtifact(async () => notInstalled, expected)
    expect(result).toEqual({ ok: false, reason: 'not_installed' })
  })

  test('installed but versionCode cannot be parsed → unreadable, never a false mismatch', async () => {
    const expected: DeviceArtifactExpectation = { packageName: PKG, versionCode: 2003003 }
    const result = await verifyDeviceArtifact(async () => dumpsysFixture({}), expected)
    expect(result).toEqual({ ok: false, reason: 'unreadable' })
  })

  test('installed, versionCode ok, but the signature line is unparseable → unreadable, not signature_mismatch', async () => {
    const expected: DeviceArtifactExpectation = { packageName: PKG, versionCode: 2003003, signatureSha256: 'AA'.repeat(32) }
    const out = dumpsysFixture({ versionCode: 2003003 }) // no signature line at all
    const result = await verifyDeviceArtifact(async () => out, expected)
    expect(result).toEqual({ ok: false, reason: 'unreadable', observed: { versionCode: 2003003 } })
  })

  test('AC4: no expectation recorded at all (only packageName) — installed presence only, never blocks', async () => {
    const expected: DeviceArtifactExpectation = { packageName: PKG }
    const result = await verifyDeviceArtifact(async () => dumpsysFixture({ versionCode: 9999999 }), expected)
    expect(result).toEqual({ ok: true, versionCode: 9999999 })
  })

  test('exec is called with the probe profile (§3.2 — cheap shell reads)', async () => {
    let seenOpts: unknown
    await verifyDeviceArtifact(async (cmd, opts) => {
      seenOpts = opts
      return dumpsysFixture({ versionCode: 1 })
    }, { packageName: PKG })
    expect(seenOpts).toEqual({ profile: 'probe' })
  })
})
