import { definePlugin } from '@enkaku/sdk'
import scrollReels from './scroll-reels'
import checkInbox from './check-inbox'
import checkActivity from './check-activity'
import checkProfile from './check-profile'
import searchKeyword from './search-keyword'
import scrollFeed from './scroll-feed'
import watchStories from './watch-stories'
import exploreReels from './explore-reels'
import postVideo from './post-video'

/**
 * Instagram automation pack.
 *
 * ## Status
 *
 * Nine members. Warm-up: `scroll-reels`, `scroll-feed`, `watch-stories`,
 * `explore-reels`, `check-inbox`, `check-activity`, `check-profile`,
 * `search-keyword`. Posting: `post-video`, the member the Social Media Manager
 * routes Instagram posts to. Every browse member carries the same human-shaped
 * randomness as the TikTok and YouTube packs (seeded RNG, heavy-tailed dwell,
 * verified swipes, jittered taps) and the scrolling ones carry **keyword
 * tilt**: content whose words contain an operator keyword gets a boosted
 * like/comment chance, and nothing else is penalised.
 *
 * ## Safety
 *
 * Nothing follows, sends a DM, comments, or edits the profile. The only writes
 * are likes the operator asked for (on reels, feed posts, and — off by default
 * — stories), each confirmed by reading the button again and never on a
 * sponsored item, and `post-video`, which shares exactly the video it was
 * given and confirms it by the profile's post count.
 *
 * ## The house rule
 *
 * An Instagram layout is not a fact this repo owns. Every anchor here was
 * measured on hardware and the screens are checked into `__fixtures__/`, with
 * `readings.test.ts` running every pure reading against them; every step that
 * can fail saves its tree and screenshot, so a failed run carries its own bug
 * report.
 *
 * ## Versioning
 *
 * `packages/core/packs/` is seeded ONCE, keyed on `${name}@${version}`
 * (`packages/core/src/plugins/seed-embedded.ts`). A rebuilt bundle at an
 * unchanged version is skipped on every later boot, so the change sits in
 * the repo, fully tested, and never reaches a browser. Bump `package.json`,
 * `version:` below, and `index.test.ts`'s assertion together, then
 * `bun run build:packs`. A seeded version is staged, not activated — the
 * operator activates it on the Plugins page.
 */
export default definePlugin({
  id: 'instagram',
  version: '0.3.0',
  /** Plan 310 §3.3 — shown wherever this plugin is offered as a choice. */
  icon: 'activity',
  title: 'Instagram automation pack',
  description: 'Browse Reels, the feed, stories and Explore, check inbox, notifications and profile, search, and post Reels — with keyword-tilted random behaviour.',
  scripts: [scrollReels, checkInbox, checkActivity, checkProfile, searchKeyword, scrollFeed, watchStories, exploreReels, postVideo],

  /**
   * ## Changelog
   *
   * **0.3.0 — posting, three more warm-ups, and anchors measured on the owner's
   * moto.** One hand walk on the owner's moto g06 power (Android 15, id-ID,
   * Instagram 446.0.0.49.77, signed in), 2026-09-14, every screen checked into
   * `__fixtures__/`:
   *
   * - **`post-video`** uploads a Reel: home "+" → REEL gallery → the newest
   *   video (MediaStore must list the pushed file as newest and the cell's
   *   duration must match it) → editor → share screen → caption → Share, and
   *   the first-reel "Tentang Reels" sheet. The caption is the one blind tap,
   *   and its consequence is readable: caption editing shows "Oke", and without
   *   it nothing is typed. `posted` means the profile's post count went up;
   *   after Share nothing reports `failed`. A `dryRun` walks to Share, types
   *   the caption and discards the edit.
   * - **`scroll-feed`**, **`watch-stories`**, **`explore-reels`** — the home
   *   feed, the story tray, and a reel opened from Explore, so a warm-up can
   *   rotate through the app the way a person uses it.
   * - **Every member waits for Instagram** (`instagram.ts`'s `relaunch`: grant
   *   media access, launch, poll for the bottom navigation, wait for the tree
   *   to settle) instead of sleeping five seconds, and names a signed-out app
   *   as `E_NOT_SIGNED_IN`.
   * - **`check-activity` opens the notifications.** It tapped `direct_tab`,
   *   which on this build is "Pesan", the inbox; the heart is `notification` in
   *   the home feed's top bar. Suggested people on that screen are no longer
   *   reported as notifications, and the result gained `sections` in place of
   *   an `unreadCount` it never actually read.
   * - **`check-profile` reads by id.** The "N postingan" sentence it parsed is
   *   now a number and a label in separate nodes, so it returned blanks.
   * - **Likes are confirmed** by reading the button again, never pressed on a
   *   sponsored item, and reported per attempt (`likes`).
   * - **What the routed runs added**, through the farm's own reader on the same
   *   moto: an announcement sheet ("Memperkenalkan instan") is closed with its
   *   "not now" button on launch, never its primary one; "+" after an
   *   unfinished edit asks "Terus edit draf Anda?" and is answered "Mulai video
   *   baru" (the old edit stays in Drafts); the share screen's "Orang lain
   *   sekarang dapat mengunduh…" sheet is acknowledged before the caption; the
   *   caption field IS readable to the farm (`caption_input_text_view`), so the
   *   caption is proven by reading the field back instead of by a blind tap;
   *   and `check-inbox` recognises the inbox by its own anchor — the reader
   *   keeps the feed's nodes in the tree after the tab changes, which made the
   *   old "feed still showing" check fail on an open inbox, and made the first
   *   run read an announcement sheet and the system navigation bar as threads.
   *   Granting media access before launch needs the core fix that ships beside
   *   this version (`dumpsys package` filtered on the device — Instagram's is
   *   296 KB, over the output cap).
   *
   * **0.2.0** — `check-activity` demands the tab it navigates by instead of
   * shrugging when it is absent, and throws the way `check-inbox` and
   * `check-profile` always have.
   *
   * **0.1.0 — initial.** Five members; `scroll-reels` carries verified
   * randomised swipes, heavy-tailed dwell, jittered taps, and keyword tilt.
   * Measured on OPPO CPH2173 (1080×2412), Indonesian locale, Instagram 443.0,
   * 2026-09-04.
   */
})
