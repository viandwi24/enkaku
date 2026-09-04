import { definePlugin } from '@enkaku/sdk'
import searchChannel from './search-channel'
import scrollShorts from './scroll-shorts'
import scrollLive from './scroll-live'
import downloadHome from './download-home'
import searchPlay from './search-play'

/**
 * YouTube automation pack.
 *
 * ## Status
 *
 * Five members: `search-channel`, `scroll-shorts`, `scroll-live`,
 * `download-home`, `search-play`. The three browse/watch members can, on an
 * explicit operator-set probability, press YouTube's own like button and read
 * its own comment section — writes the operator asked for, never a side
 * effect: a signed-out device answers with the account sheet and every such
 * attempt is reported as `not-signed-in`, not as a like. Nothing subscribes or
 * comments; `download-home` only presses the app's own Download line and
 * reports the account's real answer.
 *
 * ## The house rule this pack is built around
 *
 * A YouTube layout is not a fact this repo owns — it moves with the app
 * version, the device locale and the A/B bucket the install landed in. So every
 * anchor here is a LADDER (resource id first, then labels in more than one
 * language), every step saves its tree and screenshot as an artifact, and the
 * result reports which rung actually matched. A failed run therefore arrives
 * carrying its own bug report, and one real run turns a ladder into a measured
 * fact instead of a standing guess.
 *
 * The tree captures are also what makes the results page tractable: it is a
 * `RecyclerView` of near-identical rows where `find()` returns row 0 and can
 * never report `ambiguous` (`tree.ts`'s header), so picking "the channel, not a
 * video by it" has to be a walk, and a walk needs the tree.
 *
 * ## Versioning — read before editing anything under `src/`
 *
 * `packages/core/packs/` is seeded ONCE, keyed on `${name}@${version}`
 * (`packages/core/src/plugins/seed-embedded.ts`). A rebuilt bundle at an
 * unchanged version is skipped on every later boot, so the change sits in the
 * repo, fully tested, and never reaches a browser. Bump `package.json`,
 * `version:` below, and `index.test.ts`'s assertion together, then
 * `bun run build:packs`. A seeded version is staged, not activated — the
 * operator activates it on the Plugins page.
 */
export default definePlugin({
  id: 'youtube',
  version: '0.10.0',
  title: 'YouTube automation pack',
  description: 'Search, browse, watch, like, read comments and download in the YouTube app on a farm device.',
  scripts: [searchChannel, scrollShorts, scrollLive, downloadHome, searchPlay],

  /**
   * ## Changelog
   *
   * **0.10.0 — keyword tilt.** `scroll-shorts`, `search-play` and `scroll-live`
   * take `keywords` + `keywordBoostFactor`: when the content's own words
   * (caption/channel/title read off the live tree) contain a keyword, the
   * like/comment chance is multiplied — a non-match keeps the base chance
   * untouched, because punishing content the operator never mentioned is a
   * different product decision. `behavior.ts` exports `keywordBoost` and
   * `readableStrings`; the result now reports `keywordMatches` so a run says
   * how often the tilt actually fired.
   *
   * **0.9.0 — a thumb that lands on the same pixel every time is the tell.**
   * `tapNode` now aims at a uniform random point in the MIDDLE 70% of the node
   * (`insetPoint`, youtube.ts) instead of its exact centre — an operator asked
   * for touch placement to vary like a human's, and the farm's own
   * `tapJitterMs` jitters the tap, not the aim. The inset can never leave the
   * node, and sub-24px rails keep the plain centre so a tap cannot fall into
   * the gap beside them.
   *
   * **0.8.0 — a list full of live streams read as having none.** `scroll-live`
   * looked for the word LIVE on the `thumbnail_layout` nodes `resultRowsOf`
   * returns — and thumbnails carry no description at all. The failing job's
   * own artifact showed the truth: the badge is a `- Live -` SEGMENT of the
   * whole row's description ("… 4 ribu sedang menonton - Live - putar video"),
   * with a companion node "Ketuk untuk menonton livestream". Live detection now
   * reads the row descriptions it actually measured.
   *
   * **0.7.0 — a Shorts search result played fine and the run still failed.**
   * `search-play` tapped rank 2 of "drama komedi indonesia", the artifact
   * showed the reel fully playing (`reel_watch_player`, its rail, its worded
   * time bar "0 menit 29 detik dari 0 menit 35 detik"), and `playerEvidence`
   * said *no player* — its ids, its transport ladder and its `a / b` clock all
   * describe the regular watch page only, and a search result is free to be a
   * Short. `playerEvidence` gained the reel ids and the spelled-out
   * "N … dari M …" clock, both measured off that failing job's own artifact.
   *
   * **0.6.0 — the first hardware run of `scroll-shorts` caught a lie it was
   * telling.** Three likes reported `already-liked` and `signedIn: true` on a
   * device the probe had just proven signed out — because `likeState` read
   * `suka video ini bersama 29 ribu orang lainnya` as "the user liked this",
   * when it is the button's TOTAL COUNT, present on a never-liked video whose
   * like press only ever raises the "Akun / Tambahkan akun" sheet. The liked
   * spelling is the one that names the viewer ("Anda …", "Batalkan …",
   * "Liked"); the count line now reads not-liked, and the fix's own evidence
   * is a `not-signed-in` outcome on exactly the device that was reporting a
   * false green. (measured 2026-09-03, job `1a61e76b`.)
   *
   * **0.5.0 — four new members, and the anchors are measured, not guessed.**
   * `scroll-shorts`, `scroll-live`, `download-home`, `search-play`, plus
   * `behavior.ts` — the shared human primitives (seeded RNG, heavy-tailed
   * dwell, fully randomised verified swipes: corridor, start, distance, speed,
   * drift and curvature all vary, and a swipe that left the screen
   * byte-identical is retried harder and then REPORTED as stuck rather than
   * counted). Every ladder in there was anchored on a live probe of the farm
   * device (moto g06 power, Indonesian locale, signed out, 2026-09-03):
   * the Shorts rail's "Sukai video ini" ↔ "suka video ini bersama N …" pair,
   * the comment sheet's `close_button` "Tutup", the home rows'
   * "Menu tindakan untuk <title>" overflow, its `list_item_text` "Download"
   * line, and two traps found only by looking: a signed-out like is answered
   * by the "Akun / Tambahkan akun" sheet (which every member now reports as
   * `not-signed-in` instead of a fake like), and sponsored install cards carry
   * their own "Download" call to action (which `download-home` excludes, and
   * which answered the first real attempt with the measured snackbar
   * "Download tidak tersedia" — an honest failure this pack now carries as a
   * first-class outcome). `search-channel`'s `SEARCH_ENTRY`/`SEARCH_FIELD`/
   * `clickableFor` gained `export` so the new members walk the same ladders.
   *
   * **0.4.3 — no behaviour change; republished to re-verify against a patched
   * runner.** `packages/session/src/runner/child-entry.ts` gained the four
   * replay verbs this pack's own first run proved were missing (see
   * `src/youtube.ts`'s `tapNode`). That file is on EVERY script's path, so this
   * pack was re-run on hardware afterwards to confirm an ordinary script still
   * works through it.
   *
   * **0.4.2 — a floating microphone is not a search result.** YouTube's mic FAB
   * hovers OVER the content at roughly two-thirds down the screen, so it is
   * inside the content band by geometry. On a results page that had loaded
   * nothing else it was the only readable node there, and "results are ready"
   * fired on a blank page — intermittently, two runs in three. Excluded by id,
   * and a page must now show at least TWO readable nodes: excluding each stray
   * control as it is discovered is a game with no end, and a real results page
   * is never one lonely string.
   *
   * **0.4.1 — check-then-act: the tree that was validated is the tree that gets
   * used.** `waitForTree` polls until a tree passes a predicate and hands that
   * tree back; `capture` then re-dumped to save the artifact, so the run acted
   * on a DIFFERENT tree than the one it had checked. A results page that
   * satisfied the predicate was re-dumped a moment later as bare chrome, and
   * the run searched an empty page. `capture` now takes the validated tree.
   *
   * **0.4.0 — press Skip ad.** Two measured runs sat through 50 s and 34 s of
   * advert with a skip button on screen for most of it. `waitOutAdvert` is a
   * loop rather than a wait, because the control appears mid-advert and has to
   * be acted on: adverts now clear in about 5 s. It presses YouTube's own
   * dismiss control and nothing else — not the advert, not its call to action,
   * not its links — and `skipAds: false` presses nothing at all.
   *
   * **0.3.3 — a tap has to land on the row.** `inContentBand` tests a node's
   * TOP edge, which answers "is this content" and not "can this be tapped". The
   * bottom row of a video list had its top inside the band and its centre under
   * the navigation bar, so `watch: 'random'` tapped it and opened
   * **Subscription**. `watch: 'latest'` is always row 0 and could never reach
   * it — a defect only one of two code paths could produce.
   *
   * **0.3.2 — read the title from the row, and detect adverts by id only.**
   * Scraping the player for a title returned the video's **closed captions**
   * (`subtitle_window_identifier`); a row's own description carries the title
   * as its first segment and is what was chosen anyway. And a free-text advert
   * detector matched a **sponsored card in the recommendations feed**, which
   * never disappears — the pre-roll had ended at six seconds and the wait ran
   * its full budget.
   *
   * **0.3.1 — an advert is not the video.** The first watch run spent all ten
   * of its seconds on a six-second sponsored spot, and reported the video's
   * title as "Kunjungi pengiklan". The watch clock now starts after the advert.
   *
   * **0.3.0 — `watch` and `watchMs`.** One enum (`none` / `latest` / `random`)
   * rather than two booleans, which would let an operator ask for both and
   * leave the script to invent an answer. `none` is the default, so every
   * existing caller keeps what it had.
   *
   * **0.2.0 — it works, and four real trees now hold it in place.** The member
   * reached the Eno Bening channel page on hardware. The dumps from that
   * session are checked in as `src/__fixtures__/` — a loaded results page, the
   * SAME page mid-load, the channel page, and the suggestions screen — and
   * `search-channel.test.ts` runs every predicate against them. That test pass
   * immediately found two more defects that no run had yet exposed:
   *
   * 1. **A results page was recognised as a channel page.** It carries
   *    `Subscribe ke Eno Bening.` on the channel's own row, so the subscribe
   *    rung matched the results list itself — the run would have reported
   *    "channel opened" while still sitting on it. A page holding a search
   *    widget is now disqualified outright.
   * 2. **The title was read off the chrome.** On a results page it returned the
   *    QUERY (from the search bar); mid-load it returned "Subscription" (from
   *    the bottom navigation). Both read like answers. The title is now gated
   *    on the same evidence `channelOpened` uses, so the two can never
   *    disagree.
   *
   * Also fixed: "largest text node" reported the channel's name as **"Beranda"**
   * on the first real channel page, because a tab strip draws bigger text than
   * the toolbar title. The name now comes from the subscribe control's own
   * description (`Subscribe ke Eno Bening.`), with its real capitalisation.
   *
   * Minor, not patch: the result gained `channelEvidence`, and `channelTitle`
   * means something different now.
   *
   * **0.1.6 — thumbnails render before their labels do.** With the content band
   * finally correct, a results page still reported no channel: it carried four
   * `thumbnail_layout` nodes and not one readable string. The images arrive
   * first. Readiness is now "has anything a human could read appeared between
   * the toolbar and the navigation bar", which is the only one of the three
   * signals tried that is true exactly when the page is usable.
   *
   * **0.1.5 — the root node's bounds are all zeros.** 0.1.4 derived the
   * content band's lower edge from `tree.bounds.bottom`, which reads 0 on a
   * dump's root (the root also has an empty `packageName`). The edge computed
   * to −200, every node on the screen was rejected, and a results page carrying
   * four thumbnails reported no channel row. Height is now the furthest
   * `bottom` any node reaches, and a tree with no height at all no longer
   * excludes everything.
   *
   * **0.1.4 — the bottom navigation is not a search result.** 0.1.3's row test
   * accepted "any clickable node with a description below the toolbar", and
   * YouTube's bottom navigation is exactly that: four clickable items carrying
   * "Beranda", "Shorts", "Subscription", "Anda". So a results page that had
   * loaded nothing but its own chrome was declared ready in zero milliseconds,
   * and the channel search then ran against an empty page. Content is now
   * bounded at BOTH edges, with the lower one measured from the root's own
   * height so it scales with the device, and the fallback row test narrowed to
   * markers that appear on no chrome at all.
   *
   * **0.1.3 — the results page is Compose, and Compose rows have no ids.**
   * Measured on hardware: a fully loaded results page carried `resourceId`s for
   * exactly three things — the search bar, the bottom navigation, and four
   * `thumbnail_layout` nodes. Every result's identity was in its content
   * DESCRIPTION, in the device's own language (`Buka channel`,
   * `Subscribe ke Eno Bening.`). 0.1.2's row detector looked for `lockup` /
   * `*_item` ids, found none on a page full of results, and timed out claiming
   * nothing had loaded. Anchors are now descriptions with a language ladder,
   * the row test is the thumbnail, and the toolbar is excluded by a measured
   * floor so a walk cannot pick the back button as its first "result".
   *
   * **0.1.2 — wait for rows, and never tap the search bar.** Two defects, both
   * found on hardware and both invisible from the outside:
   *
   * 1. Three seconds after pressing search, the results page had drawn its
   *    search bar and its bottom navigation and NOT ONE result row. The script
   *    acted on that page anyway. Waiting is now for the rows themselves
   *    (`waitForTree`), not for a duration.
   * 2. A search for "eno bening" leaves "eno bening" in the search bar, so the
   *    `exact-title` rung matched `:id/search_query`, tapped it, and reopened
   *    the suggestions screen. From the outside that looks like the script did
   *    nothing at all. Row picking now excludes the app's own chrome by id.
   *
   * **0.1.1 — `tapNorm` is not reachable from a script.** The first run on
   * hardware failed with `ctx.device.tapNorm is not a function`. `DeviceApi`
   * declares it, `packages/session/src/device-executor.ts` implements the
   * `'tapNorm'` case, and the IPC bridge between them
   * (`packages/session/src/runner/child-entry.ts`'s `deviceApi`) never forwards
   * it — so the call typechecks, publishes, verifies, and dies at runtime.
   * Every tap here goes through `tapNode`, i.e. `tap({ point })`, which is a
   * real `SelectorSchema` rung and takes device pixels — the units `bounds` are
   * already in.
   *
   * **0.1.0 — `search-channel`.** The MVP: search by channel name, open the
   * channel page, hold, close. No service, no Studio screen, and no declared
   * `permissions` — the member reaches the device and nothing else, and an
   * undeclared capability is refused at the point of use (`E_FARM_UNDECLARED`,
   * plan 113 finding C3) rather than granted quietly. All three are added when
   * a member actually needs them, so the install consent screen never lists
   * more than this pack uses.
   */
})
