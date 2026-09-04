import { describe, expect, test } from 'bun:test'
import { PinGuestAgentError, pinGuestAgent, type PinGuestAgentArgs } from './pin-guest-agent'

function fixtureManifest() {
  return {
    tools: [
      { id: 'adb', versions: [{ version: '1.0.0', platforms: { '*': { url: 'x', sha256: 'a'.repeat(64), sizeBytes: 1 } } }] },
      {
        id: 'guest-agent',
        versions: [
          {
            version: '0.1.8',
            releasedAt: 'unknown',
            compatibleCoreRange: 'TODO-M55',
            deviceArtifact: {
              packageName: 'dev.enkaku.guestagent',
              versionCode: 1008,
              signatureSha256: 'DEADBEEF',
            },
            platforms: {
              '*': {
                url: 'https://example.com/old/guest-agent.apk',
                sha256: '0'.repeat(64),
                sizeBytes: 1,
              },
            },
          },
        ],
      },
    ],
  }
}

const ARGS: PinGuestAgentArgs = {
  version: '0.1.9',
  versionCode: 1009,
  sha256: 'b'.repeat(64),
  sizeBytes: 1_234_567,
  url: 'https://example.com/v0.1.9/guest-agent.apk',
}

describe('pinGuestAgent (plan 221 §4.12)', () => {
  test('pin-guest-agent rewrites exactly the five fields', () => {
    const manifest = fixtureManifest()
    const result = pinGuestAgent(manifest, ARGS)
    const entry = result.tools.find((t) => t.id === 'guest-agent')!.versions[0]!
    expect(entry.version).toBe('0.1.9')
    expect(entry.deviceArtifact!.versionCode).toBe(1009)
    expect(entry.platforms['*']!.url).toBe(ARGS.url)
    expect(entry.platforms['*']!.sha256).toBe(ARGS.sha256)
    expect(entry.platforms['*']!.sizeBytes).toBe(1_234_567)
    expect(entry.compatibleCoreRange).toBe('>=0.1.9')
    // The other tool entry is untouched.
    expect(result.tools.find((t) => t.id === 'adb')!.versions[0]!.version).toBe('1.0.0')
  })

  test('it leaves signatureSha256 untouched', () => {
    const manifest = fixtureManifest()
    const result = pinGuestAgent(manifest, ARGS)
    const entry = result.tools.find((t) => t.id === 'guest-agent')!.versions[0]!
    expect(entry.deviceArtifact!.signatureSha256).toBe('DEADBEEF')
  })

  test('it refuses a sha256 that is not 64 hex characters', () => {
    const manifest = fixtureManifest()
    expect(() => pinGuestAgent(manifest, { ...ARGS, sha256: 'not-hex' })).toThrow(PinGuestAgentError)
  })

  test('it refuses when the guest-agent entry is missing', () => {
    const manifest = { tools: [{ id: 'adb', versions: [] }] }
    expect(() => pinGuestAgent(manifest, ARGS)).toThrow(PinGuestAgentError)
  })

  test('it refuses a non-positive versionCode', () => {
    const manifest = fixtureManifest()
    expect(() => pinGuestAgent(manifest, { ...ARGS, versionCode: 0 })).toThrow(PinGuestAgentError)
  })

  test('a compatibleCoreRange that is already set (not the TODO-M55 sentinel) is left alone', () => {
    const manifest = fixtureManifest()
    manifest.tools[1]!.versions[0]!.compatibleCoreRange = '>=0.1.8'
    const result = pinGuestAgent(manifest, ARGS)
    expect(result.tools.find((t) => t.id === 'guest-agent')!.versions[0]!.compatibleCoreRange).toBe('>=0.1.8')
  })
})
