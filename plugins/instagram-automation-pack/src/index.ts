import { definePlugin } from '@enkaku/sdk'
import scrollReels from './scroll-reels'
import checkInbox from './check-inbox'
import checkActivity from './check-activity'
import checkProfile from './check-profile'
import searchKeyword from './search-keyword'

/**
 * Instagram automation pack.
 *
 * ## Status
 *
 * Five members: `scroll-reels`, `check-inbox`, `check-activity`, `check-profile`,
 * `search-keyword`. `scroll-reels` carries the full random behaviour suite
 * (seeded RNG, heavy-tailed dwell, verified swipes, jittered taps) with
 * **keyword tilt**: if a reel's caption, author, or audio contains any of the
 * operator's keywords, the like/comment probability is multiplied by a boost
 * factor — non-matching reels keep the base chance untouched.
 *
 * ## Safety
 *
 * Nothing follows, buys, sends a DM, or edits the profile. The only writes
 * are optional likes on reels (default off). Comment-sheet visits open and
 * close without typing.
 *
 * ## Versioning
 *
 * `packages/core/packs/` is seeded ONCE, keyed on `${name}@${version}`
 * (`packages/core/src/plugins/seed-embedded.ts`). A rebuilt bundle at an
 * unchanged version is skipped on every later boot, so the change sits in
 * the repo, fully tested, and never reaches a browser. Bump `package.json`,
 * `version:` below, and `index.test.ts`'s assertion together, then
 * `bun run build:packs`.
 */
export default definePlugin({
  id: 'instagram',
  version: '0.1.1',
  title: 'Instagram automation pack',
  description: 'Browse Reels, check inbox & notifications, read profile stats, and search — with keyword-tilted random behaviour.',
  scripts: [scrollReels, checkInbox, checkActivity, checkProfile, searchKeyword],

  /**
   * ## Changelog
   *
   * **0.1.0 — initial.** Five members; `scroll-reels` carries verified
   * randomised swipes, heavy-tailed dwell, jittered taps, and keyword tilt
   * (caption/author/audio match → boosted like/comment probability). Measured
   * on OPPO CPH2173 (1080×2412), Indonesian locale, Instagram 443.0, 2026-09-04.
   */
})
