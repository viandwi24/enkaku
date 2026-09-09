import { describe, expect, test } from 'bun:test'
import { PLATFORMS, PLATFORM_IDS, deviceCarriesPlatform, platformById, postablePlatforms } from './platforms'

describe('the platform registry', () => {
  test('every declared id has exactly one row, and every row a declared id', () => {
    expect(PLATFORMS.map((p) => p.id).sort()).toEqual([...PLATFORM_IDS].sort())
  })

  test('`script` and `unsupportedReason` are exact opposites — a platform is postable or it says why not', () => {
    // The surface renders one or the other without checking both, so a row
    // with neither (silently unpostable) or both (a reason nobody reads) is
    // the defect this asserts against.
    for (const platform of PLATFORMS) {
      expect(platform.script === null).toBe(platform.unsupportedReason !== null)
    }
  })

  test('TikTok is postable, through the member that actually exists', () => {
    expect(platformById('tiktok')?.script).toBe('tiktok/post-video@latest')
  })

  test('Instagram and YouTube declare themselves unpostable rather than routing nowhere', () => {
    // Not a wish: no verified upload flow exists for either app in this repo.
    // If someone adds one, this test is the reminder to update it here too.
    for (const id of ['instagram', 'youtube'] as const) {
      const platform = platformById(id)
      expect(platform?.script).toBeNull()
      expect(platform?.unsupportedReason).toContain('No verified upload flow')
    }
  })

  test('postablePlatforms is exactly the rows with a script', () => {
    expect(postablePlatforms().map((p) => p.id)).toEqual(['tiktok'])
  })

  test('an unknown id resolves to null rather than throwing', () => {
    expect(platformById('myspace')).toBeNull()
  })
})

describe('deviceCarriesPlatform — matching a human-typed label', () => {
  const tiktok = platformById('tiktok')!

  test('the exact label matches', () => {
    expect(deviceCarriesPlatform([{ name: 'tiktok' }], tiktok)).toBe(true)
  })

  test('case does not matter — a label is typed by a human onto a chip', () => {
    expect(deviceCarriesPlatform([{ name: 'TikTok' }], tiktok)).toBe(true)
    expect(deviceCarriesPlatform([{ name: 'TIKTOK' }], tiktok)).toBe(true)
  })

  test('spacing does not matter either — "Tik Tok" is the same intent', () => {
    expect(deviceCarriesPlatform([{ name: 'Tik Tok' }], tiktok)).toBe(true)
  })

  test('a different label does not match, and a substring is not a match', () => {
    expect(deviceCarriesPlatform([{ name: 'instagram' }], tiktok)).toBe(false)
    // The whole point of matching the full normalised name: a fleet labelled
    // "tiktok-backup" is a DIFFERENT fleet, and routing to it because the
    // string happens to contain "tiktok" is exactly the silent mis-send this
    // avoids.
    expect(deviceCarriesPlatform([{ name: 'tiktok-backup' }], tiktok)).toBe(false)
  })

  test('one phone can carry several platforms — that is what labels are for', () => {
    const labels = [{ name: 'tiktok' }, { name: 'instagram' }]
    expect(deviceCarriesPlatform(labels, tiktok)).toBe(true)
    expect(deviceCarriesPlatform(labels, platformById('instagram')!)).toBe(true)
  })

  test('no labels at all is not a match', () => {
    expect(deviceCarriesPlatform([], tiktok)).toBe(false)
  })
})
