import { describe, expect, test } from 'bun:test'
import { accountKey, accountProblemOf, accountProblemText } from './account-status'

/*
  The sentences below are copied from the packs that write them, and from production (2026-09-21):
  - tiktok-automation-pack/src/screens.ts `signedOutError`
  - tiktok-automation-pack/src/post-video.ts, the pre-post security check
  - instagram-automation-pack/src/post-video.ts, the "confirm you are human" gate
  If a pack rewords one, the matching test fails here rather than the router going quiet.
*/
describe('accountProblemOf — the scripts\' own words', () => {
  test('TikTok signed out, with the account the sign-in sheet named', () => {
    expect(
      accountProblemOf('tiktok', 'TikTok has signed this phone out of the account "bitorex.pics", so this run could not go on. Sign in again on the phone (TikTok asks for the password), then run it again.'),
    ).toEqual({ kind: 'signed-out', account: 'bitorex.pics' })
  })

  test('TikTok signed out, from the "Status akun" dialog that names nobody', () => {
    expect(accountProblemOf('tiktok', 'TikTok has signed this phone out of its account, so nothing could be posted.')).toEqual({ kind: 'signed-out', account: null })
  })

  test('TikTok\'s security check', () => {
    expect(
      accountProblemOf('tiktok', 'TikTok is asking this account for a security check ("pemeriksaan keamanan"). Nothing was posted. Complete it on the phone, then re-run.'),
    ).toEqual({ kind: 'security-check', account: null })
  })

  test('Instagram\'s human check, with the handle it names', () => {
    expect(
      accountProblemOf(
        'instagram',
        'Instagram is holding bitorextoday_ behind its "confirm you are human" check, so the app never reached the home screen — nothing was posted, and this phone needs a person to answer it. See artifact ig-01-home.',
      ),
    ).toEqual({ kind: 'human-check', account: 'bitorextoday_' })
  })

  test('an ordinary failure is not an account problem', () => {
    expect(accountProblemOf('tiktok', 'expected the "camera" screen but the dump reads "unknown" after 5 settle rounds (no modal matched)')).toBeNull()
    expect(accountProblemOf('youtube', 'the title opened YouTube\'s thumbnail editor')).toBeNull()
    expect(accountProblemOf('tiktok', null)).toBeNull()
  })

  test('a sentence about one platform is not read against another', () => {
    expect(accountProblemOf('instagram', 'TikTok has signed this phone out of its account.')).toBeNull()
  })
})

describe('what the operator reads', () => {
  test('says what is wrong, with whom, and what to press', () => {
    expect(accountProblemText({ platform: 'tiktok', kind: 'signed-out', account: 'bitorex.pics' })).toBe('TikTok is signed out (bitorex.pics) — sign in on the phone, then press Signed in.')
  })

  test('keys are per phone and platform', () => {
    expect(accountKey('dev-1', 'tiktok')).toBe('acct:dev-1:tiktok')
  })
})
