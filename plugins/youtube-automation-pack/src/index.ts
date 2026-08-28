import { definePlugin } from '@enkaku/sdk'
import searchChannel from './search-channel'

/**
 * YouTube automation pack.
 *
 * ## Status
 *
 * One member: `search-channel`. Search for a channel by name, open its channel
 * page, hold, close. Nothing subscribes, likes, comments, or plays.
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
  version: '0.4.3',
  title: 'YouTube automation pack',
  description: 'Search and browse the YouTube app on a farm device.',
  scripts: [searchChannel],

  /**
   * ## Changelog
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
