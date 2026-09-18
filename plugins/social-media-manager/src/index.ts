import { definePlugin, defineService, type PluginServiceContext } from '@enkaku/sdk'
import { PLUGIN_UI_API_VERSION } from '@enkaku/protocol'
import { z } from 'zod'
import addPost from './add-post'
import addPosts from './add-posts'
import addGroup from './add-group'
import startGroup from './start-group'
import retryGroup from './retry-group'
import updatePost from './update-post'
import resolveAttempt from './resolve-attempt'
import skipPlatform from './skip-platform'
import updateGroup from './update-group'
import cleanPhoneVideos from './clean-phone-videos'
import syncAccounts from './sync-accounts'
import { warmupRotation } from './workflows/warmup-rotation'
import { NO_HASHTAG_RULE } from './hashtags'
import { platformPostTexts } from './platform-captions'
import { GROUP_PREFIX, GroupSchema, groupKeyFor, isRowDue, roomInFlight, withProgress, type Group, type RowState } from './groups'
import retryFailed from './retry-failed'
import { PLATFORMS, PLATFORM_IDS } from './platforms'
import {
  POST_PREFIX,
  PostSchema,
  deviceDisplayName,
  planDispatch,
  postSummary,
  refreshPost,
  rollUp,
  nextRound,
  pickAssignment,
  sessionOwner,
  stateFor,
  unassignedNote,
  withSummary,
  NO_CAPTION_YET,
  ATTEMPT_ERROR_MAX,
  isJobGone,
  partialNote,
  platformNote,
  settleJob,
  type Attempt,
  type Post,
  type RouterDevice,
} from './posts'

/**
 * # Social Media Manager
 *
 * Upload a video once, say which platforms it is for, and let the farm send it
 * to every phone that carries each platform's label.
 *
 * ## What this plugin is, structurally
 *
 * It is **policy over primitives the farm already has**, and it adds nothing to
 * the core — no table, no column, no migration, no new concept in the product:
 *
 * | what it needs | what it uses | whose it is |
 * |---|---|---|
 * | somewhere to store a post | `ctx.storage.global` (`kv_entries`) | the farm's generic KV |
 * | "this phone posts to Instagram" | device **labels** | the farm's generic many-to-many |
 * | "run this on that phone" | `job.run` | the farm's generic dispatch |
 * | the actual upload flow | each platform pack's own member | that pack |
 *
 * That is the whole design, and it is the reason this could be built as a
 * plugin at all. The one thing a platform genuinely needs code for — walking
 * its app's upload screens — stays in that platform's own pack, where its
 * selectors sit beside the hardware dumps they were read from.
 *
 * ## The honest state of it
 *
 * The router works and is tested. **TikTok, YouTube and Instagram can post
 * today**: all three packs' upload flows were walked on real hardware and every
 * anchor in them was measured there (Instagram's on 2026-09-14, 0.13.0). A
 * platform added without such a walk is declared with no upload flow, and this
 * plugin says so by name rather than routing to it and reporting a success
 * nothing performed. See `platforms.ts` for why writing those selectors from
 * memory would be worse than not having them.
 *
 * ## Changelog
 *
 * - **0.50.0 — thirty phones read as "the YouTube You tab did not open" while
 *   their You tab was wide open and signed in.** The account chip is called
 *   `Ganti akun` on an Indonesian build, and `YOUTUBE_ACCOUNT_LABELS` knew only
 *   `Akun` / `Account` / `Accounts`. `labelled` matches a whole label, so none
 *   of them matched, the wait timed out, and the run blamed the tab.
 *
 *   This is the SAME defect 0.45.0 fixed for English (`account` never matched
 *   the plural `Accounts`) reappearing in the other language — which is why the
 *   farm split almost exactly in half: every English phone succeeded, every
 *   Indonesian one failed.
 *
 *   Measured, not guessed: the tree a failing run had already saved (job
 *   ffa62df6, artifact `accounts-youtube-no-you-tab`) carries
 *   `desc='Ganti akun'`, clickable, `[23,350][214,410]`, on a page showing
 *   `Lihat channel` and a real signed-in channel. The evidence was sitting in
 *   the artifact the whole time; the error message is what kept anyone from
 *   reading it.
 *
 *   The match stays EXACT. `Akun Google` is clickable 16 px away and opens
 *   Google's account settings, not YouTube's sheet — a substring match on
 *   "akun" would tap it. `Switch account` is added unmeasured, as the English
 *   wording of the same chip.
 *
 *   And the message now tells the two failures apart: the page carries
 *   `Lihat channel` / `View channel` whether or not its chip is one we know, so
 *   a tab that opened with an unfamiliar chip says exactly that and saves
 *   `accounts-youtube-no-account-chip`, rather than claiming the tab never
 *   opened.
 *
 * - **0.49.0 — YouTube finally looks at its own notifications and account page,
 *   like the other two platforms already did.** The rotation was lopsided and
 *   had been since it was written: TikTok reaches `notification-activity`,
 *   Instagram reaches `check-activity` and `check-profile`, and YouTube reached
 *   neither — it could search, scroll, watch and download, but never once
 *   opened the bell or the "You" tab.
 *
 *   `youtube/check-notifications` joins the `yt-a` shuffle and
 *   `youtube/check-profile` joins `yt-c`, one node each, the same cheap shape
 *   0.46.0 used. Both shipped in youtube@0.41.0 and were simply never wired
 *   here — a member that is maintained and never dispatched, which is the exact
 *   failure `warmup-rotation.test.ts` exists to catch and now does, per
 *   platform rather than per member.
 *
 *   Their counts are drawn with `max(5, …)` and `max(3, …)` rather than the
 *   document's `scaled()` helper: `scaled` floors at 1, and those two members'
 *   schemas have minimums of 5 and 3, so a low `amount` would have drawn a
 *   value the member's own schema refuses at dispatch.
 *
 *   **The rotation now holds 43 nodes of 50** — 0.48.0's closing line below
 *   ("41 nodes again") was true when it was written and is not any more.
 *
 *   Requires youtube@0.41.0 or newer to be ACTIVE on the farm. A farm still on
 *   0.39.x resolves both `@latest` refs to a version that does not carry these
 *   members, and the two draws fail rather than warm anything.
 *
 * - **0.48.0 — two of the four activities wired in 0.46.0 are withdrawn: they
 *   fail on hardware.** Both were run on the owner's moto g06 (2026-09-17) on a
 *   phone that was awake and idle, and both failed where `tiktok/shop-browse`
 *   and `youtube/search-channel` succeeded on the same device minutes apart.
 *
 *   `tiktok/live-browse` never found `id:"tv_search_textview"`, its own submit
 *   control — an id that appears in no fixture in its pack. `platforms.ts` says
 *   what that means: a selector nobody has observed is one that fails silently
 *   on the run that mattered. `youtube/scroll-live` fails whenever the query has
 *   no LIVE rows, which a trading niche routinely does not have; that is the
 *   right answer for a member asked to open a live stream and the wrong member
 *   for a warm-up, which must not spend its budget failing.
 *
 *   `continueOnMemberFailure` meant neither ended a run — which is exactly why
 *   this was worth undoing rather than leaving: they cost a member and a share
 *   of the session on every draw that reached them, quietly making warm-up
 *   coverage worse while the run still went green. The rotation holds 41 nodes
 *   again. They go back in when they pass on hardware, not before.
 *
 * - **0.47.0 — the router read one page of post rows, so a farm that outgrew
 *   that page had rows it could never see; and a row whose own phone was gone
 *   waited for it forever.** Both were found on the owner's production farm,
 *   2026-09-17, on one session that read "waiting" and would not move.
 *
 *   **The invisible rows.** `runTick` called `storage.global.list({ prefix:
 *   'post:', limit: 200 })` once and stopped, while `start-group`,
 *   `retry-group`, `update-group` and `resolve-attempt` all walked every page.
 *   The store sorts keys ascending, so the TAIL of the ordering simply did not
 *   exist as far as the router was concerned. Measured: 224 rows from 8
 *   sessions sharing the prefix, and six DUE rows of the newest session sat at
 *   positions 202-218 — four of them with an online, idle phone already
 *   assigned. No button could reach them either: Start only stamps rows with no
 *   turn yet (all 73 already had one, so it reported "nothing to start"), and
 *   Retry failed only re-sends attempts that actually failed, and these had
 *   never been sent at all. `readAllPostRows` now pages like its four siblings.
 *
 *   **The endless wait.** A row pinned to a phone that is offline, or no longer
 *   in the farm, cannot be rescued by waiting — it needs a person — but nothing
 *   said so and nothing ended it. After `GIVE_UP_AFTER_SEC` (45 minutes) the
 *   router now records a failure against that phone, carrying the reason and
 *   the way out ("bring it back online and press Retry failed", or "use Edit to
 *   give this video a different one"). The cell turns red, and Retry failed
 *   picks it up beside the genuine failures — which is the whole point of the
 *   SHAPE: it is written as an ATTEMPT, not as a bare `failed` word, because
 *   `failedDevices` reads attempts. A state word alone would have left the row
 *   red and still unreachable. The `unqueued:` job id is this plugin's existing
 *   prefix for an attempt that never reached the queue (`retry-failed.ts`), and
 *   `isJobGone` already reads it as settled, so no reconciler ever asks the farm
 *   about a job that was never created. The router leaves `failed` alone, so
 *   this escalates once and never loops.
 *
 *   **What it deliberately does NOT do**, each pinned by a test proven to fail
 *   when the guard is removed: a phone that is merely BUSY frees itself, so it
 *   is never given up on however long the wait; and a label-routed row has no
 *   single phone to blame, so no failure is written against one. Both would
 *   have meant inventing a failure on a real account's history.
 *
 *   `waitingSince` is the clock this needed and the row did not have: `at` means
 *   "the moment of the dispatch" and stays null on a row never sent, and
 *   `notBeforeAt` is when the TURN came, which says nothing about how long a
 *   phone has been unreachable. Optional, so none of the eight places that build
 *   a `PlatformState` literal had to change and every stored row still parses.
 *
 * - **0.46.0 — four activities the packs already shipped were never wired into
 *   the rotation, and one style's title named an activity it did not run.**
 *   The owner (2026-09-17) asked for every platform's activities to be complete
 *   and connected to the warm-up rotation. An audit of what the packs register
 *   against what this document calls found four members that existed, were
 *   maintained, and had never once been dispatched by a warm-up:
 *   `tiktok/shop-browse`, `tiktok/live-browse`, `youtube/scroll-live` and
 *   `youtube/search-channel`. They now join existing shuffles as extra members
 *   — `tt-a` (shop), `tt-b` (LIVE), `yt-a` (live) and `yt-c` (a channel).
 *
 *   Added as MEMBERS, not as new styles, and the reason is a measured limit:
 *   `WORKFLOW_LIMITS.maxNodes` is 50 and this document already held 39 nodes. A
 *   new style costs a switch case, a shuffle and its members; four extra member
 *   nodes cost four. 43 leaves room, a fifth style would not have.
 *
 *   `tt-c` was titled "TikTok: search + inbox + videos" while its members are
 *   search, NOTIFICATIONS and videos — there is no inbox member in this pack at
 *   all. A style whose title names an activity it never runs is how a fleet
 *   looks warmed on a screen while an app has never been opened, so the title
 *   now says what it does.
 *
 * - **0.45.2 — the app's own buttons were being stored as accounts, and they
 *   took SLOTS.** The owner found "Go to Meta Account settings" in the accounts
 *   table as Instagram slot 2, and reported the same shape on TikTok and YouTube
 *   in production (those strings were not captured). A slot is what
 *   `switch-account` selects by, so a phantom row is not only untidy — it can move
 *   which account a later run picks.
 *   Every reader already dropped the rows it knew BY NAME, and that list has been
 *   widened twice and missed anyway: `buka pengaturan` missed **Buka Pusat Akun**
 *   (0.41.0 — five production phones each reported one account too many), and the
 *   widened pattern then missed **"Go to Meta Account settings"**, because the
 *   English row opens with "Go to" and the pattern expected "open". A blacklist of
 *   sentences cannot be finished; the next build writes a new sentence.
 *   So this is a SHAPE rule — what a username IS — and it lives in
 *   `numberAccounts`, which all three readers pass through: one filter, three
 *   platforms, including wordings nobody has seen yet. A handle has no spaces on
 *   Instagram or TikTok; YouTube falls back to a CHANNEL NAME when a row carries
 *   no `@handle`, and a channel name can be two words ("Hendi sunadi"), which is
 *   why the bar is three words rather than "contains a space".
 *   The trade is stated rather than hidden: a three-word channel name with no
 *   handle would be dropped. That is rare, and the opposite error is worse.
 *   One subtlety the tests pin down: `markedIndex` is a POSITION in the unfiltered
 *   list, so the signed-in account is remembered by name and relocated after the
 *   filter. Dropping a row without that moves the "Signed in" tick onto a
 *   different account — a worse bug than the one being fixed.
 *
 * - **0.45.1 — YouTube's account control is "Accounts", plural. One of the
 *   reasons the reader failed, and NOT the whole of it.**
 *   Stated plainly because the first draft of this note claimed the fix: after
 *   publishing 0.45.1 the member STILL failed with "no platform could be read
 *   (youtube)". The plural is real and measured, the predicate really was wrong,
 *   and something else in that walk is wrong too. The table an operator sees kept
 *   showing a YouTube row throughout, because `mergeAccountReading` holds the last
 *   good reading beside a failure — which is correct behaviour and made the fix
 *   look like it had worked. It had not.
 *   `sync-accounts` reported "the YouTube You tab
 *   did not open" and saved an artifact named `accounts-youtube-no-you-tab` over a
 *   tab that was plainly on screen. The tab opened fine; the PREDICATE waiting on
 *   it did not: it looked for `['Akun', 'Account']`, and `labelled` matches a label
 *   EXACTLY (`wanted.includes(n.desc.trim().toLowerCase())`), so `account` can
 *   never match `accounts`.
 *   Walked by hand on the owner's moto g06 with YouTube in `en-US` (2026-09-17):
 *   the control reads `desc='Accounts'`, clickable, at (105,112), with NO
 *   resourceId at all — that description is the only way to find it. Tapping it
 *   produces a sheet carrying every id the reader wants (`title`='Accounts',
 *   `add_account`, `name`, `channel_handle`, `selection_checkmark`, and a row whose
 *   desc reads "Selected account: …", which its bilingual regex already matched).
 *   So `accounts-youtube.ts` was correct the whole time — the misleading artifact
 *   NAME is what sent me to read it first, twice.
 *   Confirmed on hardware twice with the network verified up (ping 8.8.8.8, 0%
 *   loss), because an earlier run of this same failure happened while the phone
 *   had no route out and that reading could not be trusted.
 *   `Akun` and `Account` are KEPT, not replaced: the Indonesian spelling of this
 *   control has not been measured, and dropping a spelling that may still be in use
 *   is how a fix for one language quietly breaks the other. Same shape as TikTok's
 *   `Video` → `Videos` earlier the same day: the obvious translation is the wrong
 *   one, and only a device dump settles it.
 *
 * - **0.45.0 — a platform can be skipped for a phone, and enabled again.** The
 *   owner (2026-09-16): twenty videos over twenty phones, three platforms each —
 *   but #2 has no YouTube channel and #3 was never signed in to TikTok. Those two
 *   cells used to be sent anyway: a real run on a real phone, walking an app it
 *   cannot post from, ending red. A finished session read as two things broken.
 *   The New Session screen now takes SKIP RULES — by device group, by label, or by
 *   naming a phone and a platform outright — and `add-group` resolves them once
 *   against the fleet and writes the result onto each row as a new platform state,
 *   `skipped`. The row still exists, in its place, saying "Skipped" and why
 *   ("this phone carries the no-youtube label"); nothing is sent, nothing failed,
 *   and the session's progress counts it apart from both (`groupProgress`'s own
 *   `skipped`, so "all 36 posted, 4 skipped" reads as done rather than four short).
 *   Either way round with one press: **Skip** on any cell that has sent nothing,
 *   **Enable** on a skipped one, which returns it to `pending` and sends it at the
 *   video's next turn (`smm/skip-platform`). A platform that HAS been sent can
 *   never be skipped — a skip would paper over what a phone actually did, and
 *   `setPlatformSkip` refuses it by name. The rule is applied once and never
 *   re-applied, so a cell an operator enables stays enabled; the session keeps
 *   what was asked for (`group.excludes`) only so the page can still say what the
 *   session's rule was. A row written by this version does not parse in 0.44.0 or
 *   older, which is the usual cost of a new state.
 *
 * - **0.44.0 — a tap is aimed from a tree read just now, not from an older one.**
 *   0.43.0's per-step evidence found it in one run. The capture the failing step
 *   saved is the PROFILE screen with "Profile menu" plainly in it — so the label
 *   was never missing — while the dump taken afterwards showed the video editor.
 *   Driven by hand on the moto (nine leftover drafts on the account): tapping that
 *   button from a tree captured moments earlier opens the EDITOR; tapping the very
 *   same point, `[632,80][706,150]`, on a profile that has settled opens the drawer
 *   properly, "Settings and privacy" and all. The editor never appears by itself —
 *   eight seconds untouched, nothing moved. The tap was not wrong about WHERE the
 *   button is, it was wrong about WHEN: a profile with drafts keeps drawing after
 *   its labels exist, and a point aimed from the older tree lands on a draft cell.
 *   That is both production messages in one — "the profile menu did not open" here
 *   and "the switch-account sheet did not open" on the farm — and why they moved
 *   between steps. `tapLabel` now re-reads the screen immediately before pressing,
 *   and hands back the tree its wait ended on so a failure saves what was really
 *   there. The YouTube walk uses the same helper and gets the same two fixes.
 *
 * - **0.43.0 — each step of the TikTok walk saves the screen IT was looking at,
 *   and 0.42.0's claim is corrected.** Re-run on the moto with a leftover edit
 *   deliberately left behind: 0.42.0's BACK recovery **never fired**, and the run
 *   failed at the third step ("the profile menu did not open") while the capture
 *   taken afterwards showed the video editor. So the editor is not there at launch
 *   — TikTok restores it DURING the walk — and a single picture at the end cannot
 *   tell that apart from "the walk began in the editor". Those two need opposite
 *   fixes, so rather than guess a second time, every step now saves the tree it
 *   was actually looking at when it gave up (`accounts-tiktok-no-navigation`,
 *   `-no-profile`, `-no-profile-menu`, `-no-settings`). The launch-time BACK from
 *   0.42.0 stays — it is cheap and harmless — but it is not the fix for this.
 *
 * - **0.42.0 — the Accounts sync presses BACK at launch (NOT the fix it was
 *   written to be — see 0.43.0).** 0.41.0's
 *   evidence fix paid for itself on its first run: the capture it saved is
 *   TikTok's VIDEO EDITOR — "Add sound", "Your Story", "Next", "Video templates",
 *   "AutoCut" — not its feed. TikTok had come up on an edit left behind by an
 *   earlier job, and the walk to Settings never had the screen it expected. That
 *   is what failed four of five production phones on 2026-09-16, invisible the
 *   whole time because nothing was captured. The TikTok pack answers this from
 *   its own modal register (`tt.resume-edit-en`); this member has no such
 *   machinery, so it presses BACK — the one press that leaves an editor without
 *   posting, saving or discarding anything — at most three times, looking for the
 *   bottom navigation after each. Measured on the moto: a BACK lands on the For
 *   You feed with its navigation and no sheet in the way. Nothing else is tapped,
 *   an account row least of all.
 *
 * - **0.41.0 — the Accounts sync stops overcounting, stops hiding its failures,
 *   and keeps the evidence.** Three findings from the production sync of
 *   2026-09-16 (5 phones, 10 runs, 15 stored rows): (1) every phone reported two
 *   Instagram accounts, the second being **"Buka Pusat Akun"** — the Accounts
 *   Centre row, which the action filter let through because it is not "Buka
 *   pengaturan"; (2) all 10 runs reported `success` while 7 rows held an error,
 *   and since the core derives no summary from a result, a clearer `reason` could
 *   never have shown that — so a run that reads NO platform now throws, while a
 *   partial read stays a success and logs which platforms failed; (3) every failed
 *   read saved only its log — no screenshot, no tree — so "the TikTok
 *   switch-account sheet did not open" arrived with no way to see what had opened
 *   instead. Each failure now captures both, before the app is closed.
 *
 * - **0.40.0 — four options, and this screen stops routing by label.** The owner
 *   (2026-09-16) dropped the fifth option 0.39.0 had kept. The picker now offers
 *   exactly four, everywhere: all phones in the farm, only the phones I choose,
 *   phones with the labels I choose (the default), phones in the groups I choose.
 *   Ticking a platform's own label under that default reaches exactly the phones
 *   the old label-driven option reached, which is where that behaviour lives now.
 *   Every option resolves to an EXPLICIT list of phones, so `planDispatch` no
 *   longer checks a platform's label for anything a NEW session sends: a phone
 *   not signed in to it fails its own job by name rather than being skipped. The
 *   control says that under itself, and New session refuses a pick that resolves
 *   to nobody rather than writing a session that could never send. **Sessions
 *   created before this still carry an empty `deviceIds` and still route by
 *   label** — no stored row was migrated and `smm/add-group` is unchanged.
 *   Cleanup and Accounts sync send every platform ticked to every phone picked;
 *   the per-phone refinement Accounts sync applied went with the mode that fed it.
 * - **0.39.0 — one phone chooser, the same five options everywhere.** The owner
 *   (2026-09-16) asked why the manager only offered a label choice, and they were
 *   right about the cause: the three panels that ask "which phones" had each
 *   written their own answer — New session offered the platform's label, labels
 *   and phones; Cleanup and Accounts sync offered the label and phones only.
 *   Nowhere could an operator say "every phone" or "this group". All three now
 *   use one shared picker (`ui/parts/device-picker.tsx`) with the same options in
 *   the same words: any phone carrying the platform's label (the default,
 *   unchanged), all phones in the farm, only the phones I choose, phones with the
 *   labels I choose, phones in the groups I choose — with **No group** as its own
 *   chip, so an ungrouped phone is never hidden behind a control that looks
 *   complete. Every mode but the default sends an EXPLICIT list of phones, which
 *   is what makes `planDispatch` stop checking the platform's label, so the
 *   control says that under itself in one line rather than leaving an operator to
 *   discover it from a post that failed on a phone nobody signed in. A session
 *   created on the default still stores an empty `deviceIds` and means exactly
 *   what it meant before.
 * - **0.38.0 — `sync-accounts`: which accounts each phone is signed in to.** The
 *   owner (2026-09-16) asked the manager to own this. The member opens each app on
 *   the phone, walks to its account list — TikTok's Profile → Profile menu →
 *   Settings and privacy → Switch account sheet, Instagram's profile toolbar and its
 *   switcher, YouTube's You tab account sheet — reads every account listed and marks
 *   the one in use, then stores one row per phone and platform under `account:`. It
 *   never taps an account row, so it cannot change which account is signed in; a
 *   platform that fails keeps its last good reading beside the error. Measured on the
 *   owner's moto (two TikTok accounts, one Instagram, one YouTube channel).
 * - **0.37.0 — a compacter tab row, and an Accounts tab.** The owner
 *   (2026-09-16): *"tabs dikompakkan lagi"*, and a way to know which account
 *   each phone is actually signed in to. The row is now four compact tabs —
 *   Sessions, Auto-Caption (the Whisper panel, renamed from "Speech"; its
 *   `tab=speech` links still work), Cleanup, Accounts — and **New session** is
 *   a button on the Sessions tab opening the compose flow as its own page
 *   (`tab=new` still addresses it), rather than a fifth tab standing beside
 *   four lists. The new **Accounts** tab sends `smm/sync-accounts` to the
 *   phones carrying each platform's label (or to the phones chosen), follows
 *   every job to its end, and tables what was stored under `account:`: the
 *   phone, the platform, each handle with its display name and slot, which one
 *   the app is standing in now, and when it was read. A phone no sync has ever
 *   read is named as such, and a row's own error is shown rather than hidden.
 * - **0.36.0 — the router never sends a video whose file was deleted.** Files
 *   can now be cleaned from the Files page. Before dispatching, the router asks the
 *   farm's new `artifact.get` whether the upload still exists (read once a minute
 *   per video); a deleted one is held on every waiting platform with the note
 *   "the video file was deleted from Files" instead of failing on every phone. The
 *   service now asks for the `artifact.get` permission — grant it when activating.
 *   The check fails open: a core without it keeps posting as before.
 * - **0.35.0 — the Drafts tab is Cleanup, and sweeps old phone videos too.**
 *   The owner (2026-09-16): the video files the post scripts push pile up. The new
 *   `clean-phone-videos` member deletes the farm-pushed `post-`/`ig-`/`yt-` videos in a
 *   phone's DCIM/Camera older than the hours given — never a fresher one an upload
 *   may still read, never any other file — and the tab can send it to the same
 *   phones as the drafts cleaning, with a dry run that counts.
 * - **0.34.0 — a video whose file was deleted from Files says so.** The owner
 *   (2026-09-16) asked for file cleaning and for what depends on a file to be
 *   handled when it goes. A session's page now reads the Files list and marks a
 *   row whose upload is gone "File deleted", counts such rows in a notice above
 *   the table, and blocks that row's Retry failed with the reason, instead of
 *   re-sending a job the phones can only fail. A failed read of Files marks
 *   nothing.
 * - **0.33.0 — YouTube can be picked in the Drafts tab.** Its pack's
 *   `clear-drafts` (YouTube 0.39.0) was measured on the owner's moto and ships now.
 * - **0.32.0 — a Drafts tab clears drafts on the phones picked.** The owner's
 *   request (2026-09-16): draft cleaning as a script on every platform, triggered
 *   from this page. The tab sends each pack's `clear-drafts` member (TikTok
 *   1.46.0, Instagram 0.10.0) to every phone carrying the platform's label, or to
 *   the phones chosen, asks before a real deletion, and follows each job to the
 *   reason its result gives. YouTube is listed and cannot be picked yet: its
 *   drafts screens are not measured.
 * - **0.31.0 — a caption never runs past its platform's limit, the session's
 *   required hashtags always stay, and a cut caption ends in "...".** The owner
 *   (2026-09-15): YouTube still refused some titles as too long, and a caption
 *   joined with its hashtags must stay within the limit while keeping the
 *   session's fixed hashtags. Fitting now takes those as required: they come
 *   first and are never the ones dropped (YouTube keeps them even past its
 *   usual three; TikTok and Instagram give way with hashtags written inside the
 *   caption, so their five-hashtag cap cannot drop one), and when the text
 *   must be cut it is cut at a word and ends in "..." (ASCII, which adb can
 *   type). Applied everywhere a platform's text is fitted: auto caption, a new
 *   session, an edit, and what the router and Retry send.
 *
 * - **0.30.0 — a session's pacing can be changed after it was made.** The
 *   owner (2026-09-15): "4 at a time, 30–120 s apart" was fixed once a session
 *   existed. A session's page now has **Edit pacing** beside its pacing line,
 *   which saves through a new member, `update-group`. "At once" is read by the
 *   router from the session row on every tick, so it applies from the next
 *   video sent. The gap is baked into each video's turn at Start, so the videos
 *   whose turn has not come yet (nothing of them sent) are spaced again with
 *   the new gap — in their order, the first keeping its time
 *   (`retimeTurns`); a video already sent or whose turn has passed is left as
 *   it is, and a session not started yet simply starts with the new gap.
 *
 * - **0.29.1 — a session is created even when the phone the page picked went
 *   offline.** The owner (2026-09-15, right after upgrading): "The session was
 *   not created — The farm did not run smm/add-group@latest: offline". The page
 *   picks the phone that runs its bookkeeping from the device list it loaded
 *   when it opened, and that phone had dropped off while the fleet reconnected.
 *   Every bookkeeping run (create, start, retry, edit, mark) now offers the job
 *   to up to three other online phones, read fresh, when the first is refused.
 *   A refusal enqueues nothing, so nothing can be written twice.
 *
 * - **0.29.0 — auto caption writes the video's main point, plainly.** The
 *   owner (2026-09-15): generated captions must be good, clear and to the
 *   point — the big point of what happens in the video, not a long retelling.
 *   The writer is now told to decide the one main point first and open with it
 *   concretely (no generic hooks), to keep sentences short with no filler or
 *   repetition (two or three sentences are usually enough), to summarise
 *   rather than retell the transcript, and to pick hashtags that name the
 *   video's actual subject. Each platform's words follow the same rule: TikTok
 *   and Instagram lead with the point and add at most two short sentences
 *   (TikTok with one or two emoji at most), and the YouTube title states the
 *   point plainly, without clickbait the video does not back up. Limits, JSON
 *   shape and fitting are unchanged.
 *
 * - **0.28.0 — every platform always has its own caption, fitted to it.**
 *   The owner (2026-09-15): TikTok, YouTube and Instagram each need their own
 *   caption, and this plugin must know each platform's limits. In 0.27.0 a
 *   per-platform caption existed only when auto caption wrote one; a video
 *   captioned from a file, by hand, or before 0.27.0 sent the shared text whole,
 *   and TikTok was sent seven hashtags. Now `add-group` fits a caption per
 *   platform for every video; the router and Retry failed fit the shared text
 *   for a row that still has none, and cap a hand-written TikTok or Instagram
 *   caption at five hashtags; hashtags written INSIDE a caption count toward
 *   the five (they were kept whole before). Editing the caption or hashtags
 *   re-fits every platform whose caption was still the fitted one, and names
 *   the platforms that keep a caption written for them. Edit fills every
 *   platform tab with the caption that platform posts, carries the tabs along
 *   as the caption is typed, and "Fit from the caption" replaces "Use the
 *   shared text"; an emptied tab is saved as the fitted caption. Stored rows
 *   are unchanged in shape.
 *
 * - **0.27.0 — regenerate captions, and a caption per platform.** The owner
 *   (2026-09-15): auto caption could only fill EMPTY captions, and one text
 *   fitted no platform — YouTube types it as a 100-character title through
 *   adb (emoji dropped), Instagram keeps five hashtags. A session's page now
 *   has **Regenerate all captions**, behind a confirm, which rewrites every
 *   video's caption, own hashtags and per-platform captions (a video with no
 *   speech keeps what it has), and a row's Auto button reads **Regenerate**
 *   once the video has a caption and overwrites it the same way. A post row
 *   gains `platformCaptions` (`platform-captions.ts`): an optional text for
 *   TikTok, YouTube and Instagram that, when set, is exactly what that
 *   platform's job receives instead of the shared caption and hashtags.
 *   Generation writes all three in one AI call and fits each to limits read
 *   from the packs — TikTok 2200 characters and 5 hashtags (its member's
 *   caption `.max` and `maxHashtags` default), YouTube a 100-character ASCII
 *   title with at most 3 hashtags (`TITLE_MAX`; 3 is this plugin's policy),
 *   Instagram 2200 ASCII characters and 5 hashtags (`CAPTION_MAX`,
 *   `INSTAGRAM_HASHTAG_LIMIT`). The router and Retry failed send each
 *   platform its own text, and fall back to the shared text when it has none;
 *   a platform with nothing to post is held while the others go. Edit shows
 *   and edits the three texts, refusing only a text over its platform's
 *   length and warning about emoji or hashtags the pack would drop. New
 *   session passes the generated texts through `add-group`. A row written by
 *   an older build parses with no per-platform captions; a row written by
 *   this version does not parse in 0.26.0 or older.
 *
 * - **0.26.0 — "Queued on phone" is not "Running", and a retry goes one at a time.**
 *   The owner (2026-09-15): after Retry failed, one phone showed TikTok,
 *   YouTube and Instagram all "Running" — it looked like three scripts driving
 *   one phone. The farm ran them one after another; the other two were queued.
 *   A cell now says "Queued on phone" until the phone actually starts its job
 *   (the router records `startedAt` the first time `job.get` reads `running`),
 *   and "for …" counts from that start. Retry failed on a session row now hands
 *   its failed platforms back to the router as waiting, so they are sent one
 *   at a time as the phone frees up, like the first send. And the page keeps
 *   refreshing after a row-level Retry: it decided whether to poll from the
 *   session's stored progress, which still said nothing was running, so the
 *   retried cells stayed "Running" after the phone had finished. The retry now
 *   recounts the session at once, and the page also polls while any row of it
 *   is running or due.
 *
 * - **0.25.0 — one Social job per phone at a time.** The owner (2026-09-15):
 *   one phone showed TikTok, YouTube and Instagram all "Running" together.
 *   The router sent every platform of a row in the same tick, so the farm
 *   queued two of them behind the first while the table called them running.
 *   A phone that takes a platform is now busy for the rest of that row, and a
 *   phone with a Social job still queued or running from an earlier tick is
 *   busy too; the next platform goes once the phone is free. A row waiting on
 *   such a phone says it is busy, not that it is disconnected.
 *
 * - **0.24.0 — a phone someone is using is never handed a post.** The owner
 *   (2026-09-15): a run reached phones that were open in Device Control. The
 *   router counted a phone free when it was online with no activity, but a
 *   `control` activity exists only while input is being sent, so a phone
 *   being watched looked idle. `isDeviceFree` now also reads `device.list`'s
 *   `inUse` (control or an open Device Control window) and treats a
 *   `lastControl` tail as a quiet period. A post waits for such a phone the
 *   way it waits for a busy one. A farm older than `inUse` routes as before.
 *
 * - **0.23.0 — force a post's status by hand, either way.** The owner
 *   (2026-09-14): YouTube Shorts landed on the channel while the farm said
 *   `failed` ("neither the trim screen nor the Shorts editor appeared", a run
 *   force-stopped after its upload went through), and Retry failed would have
 *   posted them twice; and something marked posted that is not on the account
 *   must be retryable. `resolve-attempt` now takes an `action`
 *   (`posts.ts` `markPost`, its transition table pinned by tests):
 *   **mark-posted** turns a failed, not-confirmed or finished-but-unsettled
 *   attempt into a success — refused while its job is still running — and, on a
 *   platform still waiting or unsupported with nothing sent, records a MANUAL
 *   attempt on the video's phone (`manual: true`, job id `manual:…`) so the
 *   router never sends it; **unmark-posted** turns a success into a failure
 *   that Retry failed re-sends; **mark-failed** is 0.21.0's. The old
 *   `resolution` parameter is still accepted. Each change appends to the
 *   attempt's `resolution`, now a list (a 0.21.0/0.22.0 single mark reads as a
 *   list of one), and the platform state is rolled up again exactly as the
 *   reconciler does; the session's progress is recounted at once. The session
 *   page offers Mark as posted on failed and not-confirmed cells, Remove posted
 *   mark on posted ones, Mark as posted (done by hand) in a waiting or
 *   unsupported platform's row detail, each behind a confirm saying what
 *   follows, and shows a "set by hand" badge with every mark in the row detail.
 *   A row written by this version does not parse in 0.22.0 or older.
 *
 * - **0.22.0 — every phone and every video, not the first 50.** The owner
 *   (2026-09-14), on a farm of more than 50 phones: the New session phone
 *   picker listed 50 and said "narrowed from 50". The page read one page of
 *   `/api/devices`, which answers 50 rows by default; `/api/artifacts` has the
 *   same default, so a folder of more than 50 uploads was cut the same way.
 *   Both lists now follow `nextCursor` to the end at 200 per request
 *   (`readAllPages`). The router was never affected: it reads the fleet
 *   through `device.list`, which is not paged.
 *
 * - **0.21.0 — an honest report per phone, and a way to settle "not confirmed".**
 *   The owner (2026-09-14): every platform must post, and when one does not the
 *   report must say so exactly, so a tester can retry by themselves. The case:
 *   Instagram posted a Reel, its script reported `outcome: "unverified"`, and
 *   the row sat at "Needs a look" with nothing to press. What changed:
 *   the job → attempt mapping (`posts.ts` `settleJob`, one test per row) now
 *   records a green job with no readable outcome, or an outcome this build does
 *   not know, as **not confirmed** instead of posted; a cancelled or expired job
 *   says so in its error; errors are kept to 1000 characters instead of 300; and
 *   a `job.get` that merely did not get through leaves the attempt running
 *   instead of marking it failed (only a job the farm no longer has is failed).
 *   A job that FAILED after its script had already said `posted` or
 *   `unverified` (killed while confirming, or dying in `finish`) is not
 *   confirmed rather than failed, so Retry failed never posts it twice.
 *   A new member, `resolve-attempt`, lets an operator who checked the account
 *   **Mark as posted** (the attempt becomes a success) or **Mark as failed**
 *   (it becomes failed, and so retryable through Retry failed) — only while the
 *   attempt is still not confirmed, written with `setIfVersion`, and recorded on
 *   the attempt (`resolution`: from, to, when, the job that wrote it, the
 *   script's reason). The session page reads "Not confirmed" with the script's
 *   reason on the cell and both buttons behind a confirm; a failed cell shows
 *   its error, and a row with a failure has its own **Retry failed**
 *   (`retry-failed`). Notes say "Retry failed", the button's real name.
 *
 * - **0.20.0 — a Speech tab: Whisper managed where auto captions need it.**
 *   The owner (2026-09-14): Whisper exists for this plugin's auto captions, so
 *   it should be managed here, not only under the farm's Settings. The page has
 *   a third tab, **Speech** (`?tab=speech`), with the same controls as Studio's
 *   Settings → AI → Speech (core plan 318), through the same doors: status and
 *   why (`media.transcribe.status`), the whisper-cli path, source and managed
 *   build, a path override with Save/Clear (`PATCH /api/settings`,
 *   `ai.whisperCliPath`), installing or removing the whisper.cpp build when the
 *   farm has one pinned for this host — or the `brew install whisper-cpp` hint
 *   when it does not — the tiny/base/small/medium models with Use, Install and a
 *   confirmed Uninstall (`ai.whisperModel`, `/api/tools/:id/…`), and Run check
 *   (`media.transcribe.check`). It asks again every few seconds while the farm
 *   is downloading. Changing anything needs an admin, and the buttons say so.
 *   "Manage speech" beside the Auto caption buttons now opens this tab in place
 *   instead of leaving for Settings. UI only; needs a core with plan 318.
 *
 * - **0.19.1 — the auto caption status says what it uses, and where to manage it.**
 *   The line under the buttons named the Whisper model by its full file path; it
 *   now reads "Whisper small (CLI from setting/env/managed)". It links to the
 *   farm's speech & AI settings and to the AI connectors, and while the farm is
 *   still downloading the speech model it checks again every ten seconds on its
 *   own. UI only.
 *
 * - **0.19.0 — auto captions, and hashtags kept apart from the caption.** The
 *   owner (2026-09-14): 73 videos with meaningless file names need captions, and
 *   hashtags are partly a session decision ("always #fyp", or one of these lines
 *   at random) and partly the video's own. Each video now has a caption and its
 *   own hashtags; a session has fixed hashtags and lines, one line picked per
 *   video when the session is made (`hashtags.ts`). They are joined only when a
 *   post is sent — caption, blank line, hashtags, trimmed from the end to 2200 —
 *   by the router and by Retry failed alike. A caption may be empty (a video
 *   with no speech); a row with nothing at all to post is held with a
 *   "No caption yet" note instead of being sent. Auto caption (per video and in
 *   bulk, on the New session page and in a session's table) extracts the audio
 *   in the browser, transcribes it on the farm (`media.transcribe`, Whisper) and
 *   has the farm's AI connector write the caption and hashtags (`ai.generate`);
 *   the style (language, tone, niche, hashtag count, length) is saved in the
 *   plugin. Needs a core with plan 317; without it the buttons say why they are
 *   off. Old rows and sessions read as having no hashtags.
 *
 * - **0.18.0 — a tidier page, sessions as a table, captions edited in place.**
 *   The owner (2026-09-14): the tab strip sat under a doubled top margin, the
 *   Refresh button floated alone, and the session list was cards. The plugin view
 *   no longer adds its own padding on top of the host's; Refresh sits on the tab
 *   row; the Sessions list is a table (session, platforms, progress, status,
 *   pacing, actions — the Start/Retry/Remove dialogs are one shared component, so
 *   their wording cannot drift); a session's video table shows the caption as a
 *   column and edits it in place (Ctrl/⌘+Enter saves) through `update-post`; the
 *   compose form's spacing is one scale and it no longer says "no phone" while
 *   the phone list is still loading. UI only.
 *
 * - **0.17.0 — Instagram can be chosen under "Where it posts".** The router
 *   has sent posts to Instagram since 0.13.0, but the page's own platform list
 *   still marked it not postable, so the New session form and the Edit form
 *   never offered it (owner, 2026-09-14). UI only.
 *
 * - **0.16.0 — the warm-up runs in phases, at the operator's pace.** The owner's
 *   model (2026-09-14): one daily run, platform groups split into sub-groups
 *   that run in turn, then the groups swap, so every phone warms up every
 *   platform in one day. `smm/warmup-rotation` now reads the phase from
 *   `$run.repeat` (core plan 316) and takes its pace as parameters — the gap
 *   between activities (`gapMinSec`/`gapMaxSec`), how much each activity does
 *   (`amount`) and the random start delay (`startDelayMaxSec`). Schedule it with
 *   3 repetitions, sub-groups of 27, order by device number and "one after
 *   another". Needs a core with plan 316.
 *
 * - **0.15.0 — the warm-up rotation is a trading-niche warm-up with sub-groups.**
 *   The owner's use (2026-09-14): eighty phones warmed up daily at a fixed hour,
 *   split across the three platforms and then into smaller groups, so phones on
 *   the same platform at the same moment are not doing the same thing, and every
 *   For You page leans toward trading and finance. `smm/warmup-rotation` now:
 *   waits a random 0-2 min per phone; picks the platform by
 *   `($device.number + slot + day) % 3`, so a single daily schedule moves each
 *   phone to the next platform every day (80 phones → 27/27/26, checked); sends
 *   each phone to one of three styles per platform by a weighted random switch
 *   (e.g. TikTok: For You + inbox / keyword videos + For You / search + inbox +
 *   videos); shuffles each style with 8-20 s random gaps and random counts; and
 *   takes a new `keywords` parameter — ten Indonesian trading and finance terms
 *   by default — searched as queries and passed to every script that tilts
 *   attention toward matching content. A phone with no device number now fails
 *   by name instead of finishing having done nothing. Needs the tiktok, youtube
 *   and instagram packs activated (their keyword scripts are used).
 *
 * - **0.14.0 — edit from the table.** The owner (2026-09-14): opening a row
 *   before Edit was too slow, and a phone dropdown over a hundred phones was a
 *   scroll hunt. The session table now always shows a Phone column, and on a
 *   one-per-phone row that cell is a searchable picker (number, name, label,
 *   group) that saves on choice; an Actions column carries Edit (the full form
 *   under the row) and the attempts toggle. The New session phone list gains a
 *   search box with "Select shown" and "Clear". UI only — no stored shape or
 *   member changed.
 *
 * - **0.13.0 — Instagram posts.** `instagram/post-video` exists now, walked by
 *   hand on the owner's moto g06 power (Instagram 446.0, 2026-09-14) with every
 *   screen in that pack's `__fixtures__/`, so the Instagram row in
 *   `platforms.ts` routes to it and a post targeting Instagram is sent instead
 *   of recorded as unsupported. `unsupported` is not a settled state, so a post
 *   already stored with Instagram `unsupported` starts routing on the next tick
 *   once auto-post is on — remove it first if that video should not reach
 *   Instagram now. The warm-up rotation's Instagram
 *   branch also shuffles the pack's three new warm-ups: `scroll-feed`,
 *   `watch-stories` and `explore-reels`. Needs instagram pack 0.3.0 activated.
 *
 * - **0.12.0 — one video, one phone; and a session page that says what is
 *   happening now.** Two production findings (2026-09-14):
 *
 *   1. "One video per phone" only meant each video went to one phone — WHICH
 *      phone was whoever was free when the video's turn came. A five-video,
 *      five-phone session put three videos on #21, and a retry sent a video to
 *      a phone that had already posted another. Now each video is bound to
 *      exactly one phone (`Post.assignedDeviceId`), paired randomly when the
 *      session is created (`add-group`). Every platform and every retry of that
 *      video goes to that phone. A row made before pairing existed is NOT
 *      guessed at — its history is the very tangle pairing prevents — so it is
 *      held, never sent, with a note suggesting a phone (`pickAssignment`,
 *      one owner per row via `sessionOwner`), until the operator chooses one
 *      with Edit. Nothing about such a row needs migrating: every new field
 *      defaults (no phone, empty history, round 1), and the row is rewritten in
 *      the new shape the first time the router touches it. The compose page says so up front instead of promising the extra
 *      videos would "wait for a phone to come free".
 *   2. The owner could not tell what was running, how far it had got, or
 *      whether an error was this run's or an earlier one. Attempts now record
 *      when they were sent and settled and which round they are, and a retry
 *      moves the failures it replaces into `history` instead of deleting them.
 *      The session page is a table built on those facts.
 *   3. A video already in a session can be edited — its phone, platforms and
 *      caption — through the new `update-post` member (rules in `posts.ts`
 *      `applyPostEdit`): refused while it is uploading or when the phone
 *      belongs to another video; what posted stays posted; the next attempt,
 *      or the operator's Retry failed, uses the new choice.
 *
 * - **0.11.0 — phones you choose are phones that post.** A session over phones
 *   chosen on the Social posts page (by name, or by a label such as "test 5")
 *   also needed each phone to carry the PLATFORM label (`tiktok`, `youtube`)
 *   before the router would send to it — the old "a choice narrows the
 *   label's fleet, never widens it" rule. The page asks for platforms and
 *   phones in one form, so that rule made the choice silently worthless: on
 *   the owner's production farm (2026-09-14) a started session of five videos
 *   over five "test 5" phones sent nothing and showed no failure, only
 *   "Waiting for a phone" on every row. Now a row that names its phones sends
 *   to those phones as they are; the platform label decides only when no
 *   phone is named. A chosen phone not signed in to the platform fails its
 *   upload by name and can be retried. And the page refuses to create a
 *   session that resolves to no phone at all — that was a warning, and a
 *   warning is not read by someone pressing Create and start.
 *
 * - **0.10.0 — ships the warm-up rotation as a workflow.** The three-platform
 *   warm-up the owner built in Studio (plan 314: `($device.number + slot) % 3`
 *   chooses TikTok, Instagram or YouTube per session, each branch shuffling
 *   that platform's activities) now ships with this plugin as
 *   `smm/warmup-rotation` (plan 315). Activating this version registers it on
 *   the farm, read-only; duplicate it to change it. Script refs are `@latest`
 *   because the platform packs version on their own.
 *
 * - **0.9.1 — tabs, and a page per session.** 0.9.0 put the whole job on one
 *   flat page: compose at the top, sessions underneath, each one expanding
 *   inline. With two sessions open that page could not be scanned, and the
 *   owner said so: *"ga bisa dibuat tabs aja kah biar rapih... dihalaman depan
 *   itu nampilin semua sesi atau grup, baru kalau di-details masing-masing sesi
 *   baru ada sub page nampilin list item"*. Still one sidebar entry — that part
 *   of 0.9.0 was right — now with two tabs (**Sessions**, **New session**) and
 *   a session that opens onto its own page: header, actions, then every video
 *   with every phone under it. Where you are lives in the URL (`?tab=`,
 *   `?session=`), so a reload lands where you were and one session is a link
 *   somebody can send.
 *
 *   It also ships the view's first stylesheet, and that is not cosmetic
 *   book-keeping: a plugin view inherits Studio's CSS, so any class Studio
 *   itself never writes was never GENERATED, and an ungenerated Tailwind class
 *   is silently nothing. `gap-x-1` resolved to `column-gap: normal` and a
 *   phone's name ran into its result — `#1 moto g06 powerpostedrun` — with no
 *   error anywhere. `src/ui/index.css` makes this pack's own classes real.
 *
 * - **0.9.0 — one screen for the whole job.** The plugin declared three views —
 *   a table of post rows, a table of sessions, a page listing platforms — and
 *   the owner's verdict after using them was that three menus for one job is
 *   three places to get lost: *"saya minta menunya sama aja jadi satu dong
 *   jangan dibedakan ada menu view page khusus untuk item post, untuk sesi dll
 *   jadi bingung user"*. They are now ONE React page (`src/ui/`), read top to
 *   bottom in the order the work happens: drop in forty files, watch them
 *   upload, pick the platforms, pick the phones (all labelled, by label, or by
 *   name), set the spread and the gaps, accept or replace the auto-generated
 *   title, Create or Create and start — then the sessions underneath, each
 *   expandable onto every video, every phone and every failure. Captions are
 *   written from the file names unless the operator types their own.
 *
 *   Three behavioural changes came with it, and each fixes something the old
 *   surface hid:
 *
 *   1. **A started session no longer consults the auto-post switch.** Pressing
 *      Start IS the consent, and the one screen has no such switch — a Start
 *      that quietly did nothing because of a setting nobody can see is the
 *      worst failure this plugin could have. Ungrouped rows (`add-post`,
 *      `add-posts`, which nothing starts) still wait for the timer, off by
 *      default, so a leftover row can never post itself on an upgrade.
 *   2. **Removing a session stops it.** The router refuses to dispatch a row
 *      whose session is gone. Before, an orphaned row read as unpaced and a
 *      deleted forty-video session would have fired all forty on the next tick.
 *   3. **The screen waits for what it asked for.** `run-script` answers when a
 *      job is ENQUEUED, so a member that then refused — forty videos and seven
 *      caption lines — left the screen saying "session created" with nothing
 *      created. The page now waits for the job's own verdict and shows the
 *      member's words, and reads the new session's id off its result rather
 *      than hunting for a row with the title it just typed.
 *
 *   No declared actions remain: they were buttons on tables that no longer
 *   exist, and the page calls the same members directly.
 *
 * - **0.8.0 — upload sessions: forty videos, forty phones, not all at once.**
 *   The farm this is built for loads a folder of videos, one per phone, and
 *   posts them as a batch. Three things were missing and are now here: a
 *   SESSION an operator names ("post hari Senin 14 Sep 2026"), watches as one
 *   thing and retries as one thing; a spread of ONE video per phone rather
 *   than every video to every labelled phone; and pacing, so forty phones do
 *   not light up in the same second — each video is stamped with its turn
 *   (drawn from a gap range, order shuffled or as listed) and the router
 *   sends it when the turn comes, never more than the session's "at once".
 *   Creating a session sends nothing; Start stamps the turns. Because the
 *   schedule is data on the rows, a plugin restart or a core restart resumes
 *   it. Group rows are considered on every poll rather than waiting for
 *   `intervalMinutes`, which would have rounded a 30-second gap up to the
 *   whole interval.
 *
 * - **0.7.0 — which phone, and the jobs behind the row.** The Posts table said
 *   `succeeded` and never WHERE, and a post's own jobs were unreachable from
 *   the row that caused them — the operator matched runs by timestamp on the
 *   Jobs screen. Three changes, all reading data the row already held:
 *
 *   1. Each platform cell is a sentence now, not a status word:
 *      `#3 moto g06 power · posted`, `2 phones · 1 posted, 1 failed`. Composed
 *      by `describePlatform` and stored as `dispatch.<platform>.summary`,
 *      because a tier-A column renders one stored path as text and has nowhere
 *      else to compose one. Every attempt records the phone's NAME as the farm
 *      gave it (`Attempt.deviceName`), so a phone since renamed, unplugged or
 *      removed still names itself.
 *   2. The row expands onto its jobs — one line per phone per platform, with
 *      the result, the error, and a link to the job the farm actually ran.
 *      This is the protocol's new `table.detail` (`@enkaku/protocol`), the
 *      smallest vocabulary that gives a tier-A row a real, clickable list;
 *      the alternative was a second screen the row could not link to.
 *   3. The timer settles on every poll, dispatches only when `enabled`. The
 *      two halves used to be one: with auto-posting off, a "Re-run failed"
 *      dispatched from the screen left its attempts `queued` forever and the
 *      platform pinned at `dispatched`, which is the disappearing act 0.2.0
 *      exists to end. Nothing is enqueued by the settling half.
 *
 * - **0.6.0 — YouTube posts.** The YouTube row of the platform table now names
 *   `youtube/post-video@latest` (youtube pack 0.20.0, walked on the owner's
 *   moto on 2026-09-11), so a post with YouTube ticked routes to phones
 *   labelled `youtube` exactly as TikTok does, and the row gains a
 *   "Post to YouTube now" action. Instagram still says why it cannot.
 *
 * - **0.5.0 — a green job is not a post.** The reconciler read the job's
 *   status and nothing else, so a TikTok run whose script returned
 *   `outcome: "unverified"` (the post was tapped, then TikTok's security
 *   check covered the profile and nothing could be confirmed) was written as
 *   "1 posted" on the owner's farm, 2026-09-11. It now reads the script's own
 *   `outcome`: `posted` is a success, `failed`/`skipped` is a retryable
 *   failure, and `unverified` is a new attempt state of its own — shown in
 *   the row's note and deliberately NOT re-sent by "Re-run failed", because a
 *   post that did land would become a duplicate on a real account.
 *
 * - **0.4.1 — the optional phone list was not optional.** Both post members
 *   wrote `deviceIds` as `.default([])`, and a Zod default still lands in the
 *   generated JSON Schema's `required` list — so submitting either form
 *   without choosing phones was refused with "deviceIds: required", on the
 *   one field whose whole point is that empty means "any phone carrying the
 *   label". `.optional()` instead, with the empty case handled in the body.
 *   It took a real form submission to find; a test now pins it.
 *
 * - **0.4.0 — twenty videos, one action.** `add-post` takes one video, so an
 *   operator holding twenty walked the same dialog twenty times, choosing the
 *   same platforms and phones each time — on a farm meant for a hundred
 *   devices. `add-posts` writes one row per ticked upload. The fan-out to
 *   devices was never the missing half: the router already spreads posts
 *   across free labelled phones, claiming each so two posts never land on one
 *   phone in a tick.
 *
 *   Captions are one per line — a single line for every video, or exactly one
 *   line per video. Anything else is refused, naming both counts, because
 *   cycling five captions over twenty videos would put the same text on four
 *   accounts each without saying so, and looking different per device is the
 *   whole point of the farm. Re-running over the same videos updates rows and
 *   re-posts nothing, by the same carry-over rule `add-post` follows.
 *
 * - **0.3.2 — `partial` says how partial.** The state word alone told an
 *   operator something had failed and nothing about how much, so the next
 *   move was a guess. The reconciler now writes the counts into `note`,
 *   which the Posts table already renders — "3 posted, 2 failed" — beside a
 *   reminder that a retry re-sends to those two only. In `note` rather than
 *   a new stored field because it is computed from the same array at the
 *   same instant as the state it describes, so the two cannot drift.
 *
 * - **0.3.0 — choose the phones, not just the label.** A post routed on the
 *   platform's device label and nothing else, so "send this to these five
 *   phones" had no expression at all. `deviceIds` on the post narrows the
 *   label's fleet: empty (every post before this) still means any phone
 *   carrying the label, and a chosen phone that does NOT carry it is still
 *   skipped — the label is what says this phone posts to Instagram, and a
 *   picker is not a way to overrule it. The stalled note distinguishes the
 *   two cases, because "none of your chosen phones carries the label" and
 *   "they are all busy" need different actions.
 *
 *   Drawn with the same `DevicePicker` every other screen uses, through a new
 *   `kind: 'deviceIds'` in the parameter vocabulary — the alternative was a
 *   free-text field holding UUIDs.
 *
 * - **0.2.0 — a post learns what happened.** `dispatched` was the end of a
 *   post's life here: the router handed N jobs to the queue, wrote "sent to
 *   N", and never looked again. Ten failed uploads and ten successful ones
 *   were the same row. No job id was stored, so there was no way back from a
 *   post to the phones, and "re-run the ones that failed" could not be asked
 *   at all — which is half of what the client asked this screen for.
 *
 *   Each dispatch now records one `Attempt` per phone (`jobId`, `deviceId`,
 *   state, error). The router reconciles them through `job.get` on its next
 *   tick and rolls them up into `succeeded`, `partial` or `failed`; the
 *   `retry-failed` member re-queues **only** the phones that failed, because
 *   re-sending to one that succeeded publishes the same video to that account
 *   twice. `job.get` joins the declared permissions for it.
 *
 *   `add-post`'s carry-over was widened in the same change: it preserved only
 *   `dispatched`, and with outcomes reachable it would have reset a finished
 *   platform to `pending` — handing the router a post it believed had never
 *   been sent.
 *
 * ## Auto-post is OFF until an operator turns it on
 *
 * The timer always runs; `enabled` decides whether any tick dispatches
 * anything, and it defaults to `false`. A farm that installs this pack must
 * never begin posting to real accounts merely because a timer exists — the
 * same posture, and for the same reason, as the TikTok pack's own auto-post
 * settings.
 */

const AUTO_POST_SETTINGS_KEY = 'settings:auto-post'
/** When the router last actually completed a tick, unix seconds — what `intervalMinutes` is measured against. */
const AUTO_POST_LAST_RUN_KEY = 'state:auto-post-last-run'

const AutoPostSettingsSchema = z
  .object({
    version: z.literal(1),
    enabled: z.boolean(),
    intervalMinutes: z.number().int().positive().max(24 * 60),
    /**
     * The per-tick, per-platform ceiling on how many phones one post fans out
     * to. A farm with eighty idle phones and one new video would otherwise
     * fire eighty upload jobs inside one second — a thundering herd on the
     * same network, launching the same app, which is both operationally rough
     * and the least human-shaped thing this codebase could do.
     */
    maxDevicesPerPlatform: z.number().int().positive().max(500),
  })
  .strict()
type AutoPostSettings = z.infer<typeof AutoPostSettingsSchema>

const DEFAULT_AUTO_POST_SETTINGS: AutoPostSettings = { version: 1, enabled: false, intervalMinutes: 60, maxDevicesPerPlatform: 5 }

/**
 * How often the timer WAKES to check the clock — not how often it posts.
 * Deliberately much finer than any sane `intervalMinutes`, so a setting an
 * operator just changed is honoured within a minute rather than only at the
 * next multiple of the OLD interval.
 */
const POLL_MS = 15_000

/**
 * How many post rows one PAGE of the router's read carries. It is not a ceiling
 * on what a tick considers: `readAllPostRows` below walks every page.
 *
 * It used to be that ceiling, and the ceiling was a silent trap. The store sorts
 * keys ascending (`kv/store.ts`), so a farm whose `post:` rows outgrew one page
 * had the TAIL of that ordering permanently invisible to the router — never
 * dispatched, never even given a note saying why, and reachable by no button:
 * Start only stamps rows that have no turn yet, and Retry only re-sends attempts
 * that actually failed. Measured on the owner's farm (2026-09-17): 224 rows from
 * 8 sessions sharing this prefix, and six DUE rows of the newest session sat at
 * positions 202-218 — four of them with an online, idle phone already assigned.
 *
 * `start-group`, `retry-group`, `update-group` and `resolve-attempt` all paged
 * correctly; the router was the one reader that did not.
 */
const POST_PAGE_SIZE = 200

/**
 * The most rows one tick will hold in memory, across all pages. A farm past this
 * has a real backlog the router cannot fix by reading harder — but the limit is
 * stated here rather than hidden in a page size, and it is far above any farm
 * this plugin has seen (the owner's busiest held 224).
 */
const MAX_POST_ROWS_PER_TICK = 5_000

/**
 * Enough of `device.list`'s output to route, declared locally rather than
 * imported from the protocol package. `FarmApi.call`'s own contract: the
 * farm's output shape can change under a plugin published months ago, so the
 * CALLER validates against what it needs and nothing more. `labels` is the
 * field this plugin exists to read.
 */
const DeviceListOutput = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      stableId: z.string(),
      status: z.string(),
      activities: z.array(z.object({ kind: z.string() })),
      labels: z.array(z.object({ name: z.string() })).default([]),
      /**
       * The two naming fields, read so a post row can say WHICH phone it ran
       * on rather than a uuid. Both are defaulted rather than required: a farm
       * older than `number` (plan 89) still answers this call, and a name is
       * never worth failing a router tick over.
       */
      label: z.string().default(''),
      number: z.number().int().nullable().default(null),
      /**
       * 0.24.0 — who is using the phone (`isDeviceFree`). Defaulted so a farm
       * older than the field still answers; that farm is routed on
       * `activities` alone, exactly as before.
       */
      inUse: z.object({ control: z.boolean(), viewers: z.number().int().min(0) }).default({ control: false, viewers: 0 }),
      lastControl: z.object({ endedAt: z.number() }).nullable().default(null),
    }),
  ),
})

/** Every phone's display name, by device id — what an attempt records and the Posts table reads. */
function fleetNames(fleet: z.infer<typeof DeviceListOutput>): Map<string, string> {
  return new Map(fleet.items.map((d) => [d.id, deviceDisplayName(d)]))
}

const JobRunOutput = z.object({ jobId: z.string() })

/** What `artifact.get` answers (core, 2026-09-16): a deleted file is `{ exists: false }`, never an error. */
const ArtifactGetOutput = z.object({ exists: z.boolean() }).passthrough()
const VIDEO_FILE_DELETED = 'the video file was deleted from Files, so nothing is sent — upload it again and add it to a new session'
/** How long one reading of "does this file still exist" is trusted, so a tick over forty rows is not forty calls every poll. */
const FILE_CHECK_TTL_MS = 60_000
const fileChecks = new Map<string, { exists: boolean; at: number }>()
let fileCheckUnavailableLogged = false

/**
 * Does the video's upload still exist (0.36.0)? The owner (2026-09-16): files can now be cleaned from the Files page, and
 * what depends on a file must handle it going. A post whose file is gone would only fail on every phone it is sent to,
 * so the router holds it with a note instead. Fails OPEN: a core without `artifact.get`, or a read that throws, says
 * "exists" — an outage of this check must never stop a farm from posting.
 */
async function videoFileExists(ctx: PluginServiceContext, artifactId: string): Promise<boolean> {
  const cached = fileChecks.get(artifactId)
  if (cached && Date.now() - cached.at < FILE_CHECK_TTL_MS) return cached.exists
  try {
    const { exists } = await ctx.farm.call('artifact.get', { artifactId }, ArtifactGetOutput)
    fileChecks.set(artifactId, { exists, at: Date.now() })
    return exists
  } catch (err) {
    if (!fileCheckUnavailableLogged) {
      fileCheckUnavailableLogged = true
      ctx.log.warn('could not check whether video files still exist — sending as before', { error: messageOf(err) })
    }
    return true
  }
}
/** Only the fields the reconciler reads. Validated at this boundary because the farm's own shape may move under a published plugin. */
const JobGetOutput = z.object({ status: z.string(), error: z.string().nullable().optional(), result: z.unknown().optional(), startedAt: z.number().nullable().optional() })

/*
  Settling a finished job into an attempt state is `posts.ts`'s `settleJob` — pure, with the whole
  mapping table written out there and pinned case by case in `index.test.ts`. Re-exported from this
  module, with `partialNote`, because the tests and older notes name them from here.
*/
export { partialNote, settleJob }

/**
 * Turn queued attempts into answers, for ONE post.
 *
 * Returns the post to store, or `null` when nothing moved — the caller must
 * not write in that case, because rewriting an unchanged row every tick makes
 * the Posts table look permanently busy for no reason.
 *
 * A job the farm no longer knows about (pruned, or a farm restored from a
 * backup taken before it ran) resolves to `failed` with that stated as the
 * reason. The alternative is an attempt that stays `queued` forever, which
 * pins its platform at `dispatched` and quietly removes the row from both the
 * success and the failure column — the same disappearing act this whole change
 * exists to end.
 */
async function reconcilePost(ctx: PluginServiceContext, post: Post): Promise<Post | null> {
  let any = false
  const dispatch: Post['dispatch'] = { ...post.dispatch }
  for (const platformId of post.platforms) {
    const state = stateFor(post, platformId)
    if (!state.attempts.some((a) => a.state === 'queued')) continue
    // Per platform, NOT per post: a shared flag would rewrite an untouched
    // platform's state merely because a different one moved.
    let moved = false
    const settled: Attempt[] = []
    for (const attempt of state.attempts) {
      if (attempt.state !== 'queued') {
        settled.push(attempt)
        continue
      }
      try {
        const job = await ctx.farm.call('job.get', { jobId: attempt.jobId }, JobGetOutput)
        const next = settleJob(job)
        if (!next) {
          // Still in flight. The first tick that sees the phone actually RUNNING it records when
          // (0.26.0), so the page can tell "running" from "queued behind another job on this phone".
          if (job.status === 'running' && attempt.startedAt == null) {
            settled.push({ ...attempt, startedAt: typeof job.startedAt === 'number' ? job.startedAt : Math.floor(Date.now() / 1000) })
            moved = true
            continue
          }
          settled.push(attempt)
          continue
        }
        settled.push({ ...attempt, ...next, settledAt: Math.floor(Date.now() / 1000) })
        moved = true
      } catch (err) {
        /*
          Only a job the farm no longer HAS is settled from an error (0.21.0). Any other failed read —
          a deadline, a busy farm — says nothing about what the phone did; it used to be written as
          `failed`, which handed a post that may be live to Retry failed. It is asked again next tick.
        */
        if (!isJobGone(err)) {
          ctx.log.warn('could not read a post job — asking again next tick', { jobId: attempt.jobId, error: messageOf(err) })
          settled.push(attempt)
          continue
        }
        settled.push({
          ...attempt,
          state: 'failed',
          error: `The farm no longer has this job, so what it did cannot be read: ${messageOf(err)}`.slice(0, ATTEMPT_ERROR_MAX),
          settledAt: Math.floor(Date.now() / 1000),
        })
        moved = true
      }
    }
    if (!moved) continue
    /*
      The counts go in `note`, which the page renders, because `partial` on its own tells an operator
      something went wrong and nothing about how much. `platformNote` computes it from the same array
      as the state, at the same instant — and `resolve-attempt` uses the same function, so a hand
      resolution and a reconcile can never word one state two ways.
    */
    const next = rollUp(settled)
    const note = platformNote(next, settled, state.note)
    // `withSummary` last, so the line the Posts table shows is computed from
    // the attempts this very pass settled — the state word and the sentence
    // beside it can never describe two different moments.
    dispatch[platformId] = withSummary({ ...state, attempts: settled, state: next, note })
    any = true
  }
  return any ? { ...post, dispatch } : null
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Every group, by id. A group this build cannot parse is skipped rather than
 * rewritten — the same rule the post rows keep, and for the same reason: it
 * may have been written by a newer version an operator is about to activate.
 */
async function readGroups(ctx: PluginServiceContext): Promise<Map<string, Group>> {
  const out = new Map<string, Group>()
  try {
    let cursor: string | null = null
    do {
      const opts: { prefix: string; limit: number; cursor?: string } = { prefix: GROUP_PREFIX, limit: 200 }
      if (cursor !== null) opts.cursor = cursor
      const page = await ctx.storage.global.list(opts)
      for (const entry of page.items) {
        const parsed = GroupSchema.safeParse(entry.value)
        if (parsed.success) out.set(parsed.data.id, parsed.data)
      }
      cursor = page.nextCursor
    } while (cursor !== null)
  } catch (err) {
    ctx.log.warn('router tick could not read the groups — pacing falls back to the farm settings this tick', { error: messageOf(err) })
  }
  return out
}

/**
 * One router tick: read the fleet once, then walk every post.
 *
 * The fleet is read ONCE for the whole tick rather than per post, and that is
 * a correctness choice as much as an efficiency one — two posts planned
 * against two different readings of the same fleet can both pick the same idle
 * phone, and the farm would then run two upload jobs back to back on it. One
 * reading, and `claimed` below removes a phone from the pool as soon as any
 * post takes it.
 *
 * ## `dispatch: false` — the settle-only pass
 *
 * A tick does two quite different things, and only one of them is "post to a
 * real account". Settling what is already in flight (`job.get` on the queued
 * attempts) and keeping each row's phone names and summary line current are
 * pure bookkeeping about work the farm has ALREADY done, so they run on every
 * poll whether or not auto-posting is on. Planning and firing new jobs is the
 * half `enabled` gates, and it is the only half `dispatch: false` skips.
 *
 * That split is a fix, not a tidy-up: "Re-run failed" enqueues jobs from the
 * Posts screen with auto-posting off, and before this those attempts stayed
 * `queued` forever — the platform pinned at `dispatched`, the retry's outcome
 * invisible on the very screen that offered the button.
 */
type PostRowEntries = Awaited<ReturnType<PluginServiceContext['storage']['global']['list']>>['items']

/**
 * Every `post:` row, across every page the store has — the same `do/while`
 * cursor walk `start-group`, `retry-group`, `update-group` and `resolve-attempt`
 * already use. See `POST_PAGE_SIZE` for what reading one page only did to a
 * farm that outgrew it.
 */
async function readAllPostRows(ctx: PluginServiceContext): Promise<PostRowEntries> {
  const items: PostRowEntries = []
  let cursor: string | null = null
  do {
    const opts: { prefix: string; limit: number; cursor?: string } = { prefix: POST_PREFIX, limit: POST_PAGE_SIZE }
    if (cursor !== null) opts.cursor = cursor
    const page = await ctx.storage.global.list(opts)
    items.push(...page.items)
    cursor = page.nextCursor
  } while (cursor !== null && items.length < MAX_POST_ROWS_PER_TICK)
  return items
}

async function runTick(ctx: PluginServiceContext, settings: AutoPostSettings, options: { dispatch: boolean; enabled: boolean }): Promise<void> {
  let fleet: z.infer<typeof DeviceListOutput>
  try {
    fleet = await ctx.farm.call('device.list', {}, DeviceListOutput)
  } catch (err) {
    // Fatal for a dispatching tick — there is no fleet to route to. Not fatal
    // for a settle-only one: names simply stay as they were, which is what a
    // removed phone's attempt shows anyway.
    if (options.dispatch || options.enabled) {
      ctx.log.warn('router tick could not list devices — skipping this tick', { error: messageOf(err) })
      return
    }
    fleet = { items: [] }
  }
  const names = fleetNames(fleet)

  let listed: { items: PostRowEntries }
  try {
    listed = { items: await readAllPostRows(ctx) }
  } catch (err) {
    ctx.log.warn('router tick could not read the post rows — skipping this tick', { error: messageOf(err) })
    return
  }
  if (listed.items.length === 0) return

  /*
   * Phones already spoken for THIS tick. A phone carrying both `tiktok` and
   * `instagram`, with two posts waiting, must take one of them and not both:
   * `device.list`'s `activities` was read before either job existed, so it
   * cannot see a job this same tick just created.
   */
  const claimed = new Set<string>()
  /*
    And phones with a Social job from an EARLIER tick still in the air (0.25.0): `activities` is empty
    while such a job waits in the farm's queue, so without this the phone looked free and took a
    second platform to queue behind the first.
  */
  for (const entry of listed.items) {
    const parsed = PostSchema.safeParse(entry.value)
    if (!parsed.success) continue
    for (const id of parsed.data.platforms) {
      for (const attempt of parsed.data.dispatch[id]?.attempts ?? []) {
        if (attempt.state === 'queued') claimed.add(attempt.deviceId)
      }
    }
  }

  /*
    The groups this tick may have to pace, and what their rows are doing.
    Read ONCE: forty rows asking "how many of my group are in the air" would
    otherwise be forty scans, and two rows reading different answers could
    both decide there was room for one more.
  */
  const groups = await readGroups(ctx)
  const groupStates = new Map<string, RowState[]>()
  /** groupId → deviceId → the row key that owns that phone. */
  const ownersByGroup = new Map<string, Map<string, string>>()
  const rowsByGroup = new Map<string, number>()
  for (const entry of listed.items) {
    const parsed = PostSchema.safeParse(entry.value)
    if (!parsed.success || parsed.data.groupId === null) continue
    const states = groupStates.get(parsed.data.groupId) ?? []
    for (const id of parsed.data.platforms) states.push((parsed.data.dispatch[id]?.state ?? 'pending') as RowState)
    groupStates.set(parsed.data.groupId, states)
    /*
      Which phone each row of the session OWNS (0.12.0): its assigned phone, and the phones of its
      attempts that posted, could not be confirmed, or are still running. `pickAssignment` reads
      this so a row without a phone never takes one another row already has.
    */
    const owned = ownersByGroup.get(parsed.data.groupId) ?? new Map<string, string>()
    const phone = sessionOwner(parsed.data)
    if (phone !== null && !owned.has(phone)) owned.set(phone, entry.key)
    ownersByGroup.set(parsed.data.groupId, owned)
    rowsByGroup.set(parsed.data.groupId, (rowsByGroup.get(parsed.data.groupId) ?? 0) + 1)
  }
  /** Room left per group this tick, decremented as rows are sent so one tick cannot exceed the cap. */
  const room = new Map<string, number>()
  for (const [groupId, states] of groupStates) {
    const group = groups.get(groupId)
    room.set(groupId, group ? roomInFlight(states, group.pacing.concurrency) : Number.POSITIVE_INFINITY)
    /*
      The group's own row carries the counts the Groups table renders. Written
      here, from the same reading the pacing above used, and only when
      something actually moved — `withProgress` returns null otherwise, so a
      quiet farm does not rewrite every group every fifteen seconds.
    */
    if (group) {
      const next = withProgress(group, states)
      if (next) {
        try {
          await ctx.storage.global.set(groupKeyFor(group.id), next)
        } catch (err) {
          ctx.log.warn('could not write a group\'s progress — the rows themselves are unaffected', { groupId: group.id, error: messageOf(err) })
        }
      }
    }
  }

  for (const entry of listed.items) {
    let post: Post
    try {
      post = PostSchema.parse(entry.value)
    } catch (err) {
      // A row this build cannot understand is LEFT ALONE, never rewritten:
      // it may carry a dispatch record that is already true on a phone, and
      // overwriting it is the one way to make this plugin post twice.
      ctx.log.warn('a post row has a shape this build does not understand — leaving it untouched', { key: entry.key, error: messageOf(err) })
      continue
    }

    /*
      Settle what is already in flight before planning anything new.

      Order matters: reconciling first means a platform whose jobs have all
      finished leaves `dispatched` in the same tick it stopped being true, so
      the operator never sees "running on 10" for a fan-out that ended
      an hour ago. It is also written back on its own, because a post with
      nothing new to dispatch would otherwise never be stored at all.
    */
    const reconciled = await reconcilePost(ctx, post)
    /*
      Then bring the two DISPLAY fields up to date — the phone names and the
      summary line — on whatever the reconciler left behind. Folded into the
      same write rather than given one of its own: a row that settled and a row
      whose phone was renamed are one `setIfVersion` either way, and two writes
      would race each other for the version.
    */
    const settled = reconciled ?? post
    const refreshed = refreshPost(settled, names) ?? (reconciled !== null ? settled : null)
    if (refreshed !== null) {
      const written = await ctx.storage.global.setIfVersion(entry.key, refreshed, entry.version)
      if (!written) {
        // Someone else wrote this row between the read and here. Leave it; the
        // next tick re-reads and reconciles from whatever they stored.
        continue
      }
      post = refreshed
      entry.version += 1
      if (reconciled !== null) ctx.log.info('post outcomes settled', { key: entry.key, subject: entry.key, summary: postSummary(post) })
    }

    /*
      Everything above is bookkeeping about work already done. Everything
      below posts to real accounts.

      Two kinds of row reach this line, and they are told apart by who said
      "send it":

      - A row in a SESSION was started by an operator pressing Start, which
        stamped its turn (`notBeforeAt`). That press IS the consent, so the
        row is considered on every poll and does not consult the auto-post
        switch — the one screen has no such switch, and a Start that quietly
        did nothing because of a setting nobody can see is the worst failure
        this plugin could have.
      - An UNGROUPED row (written by `add-post`/`add-posts`, which nothing
        starts) has no such moment, so it still waits for the auto-post timer,
        off by default. Fail closed: a leftover row from an old build must
        never post itself because a new version was activated.
    */
    if (post.groupId === null) {
      if (!options.enabled || !options.dispatch) continue
    } else if (!groups.has(post.groupId)) {
      /*
        Its session was removed. Removing is therefore a STOP for whatever has
        not gone out yet — which is what an operator means by removing a
        running batch, and the only reading that is safe: the alternative,
        treating an orphan as unpaced, would let a deleted forty-video session
        dispatch all forty at once on the very next tick.
      */
      continue
    }

    /*
      One video, one phone (0.12.0). A one-per-phone row WITHOUT a phone is held here and never sent.

      Rows paired at creation always have one. A row that does not is from an older build — the
      owner's production session among them — and its history is the very tangle pairing exists to
      prevent, so it is not guessed at: the row carries a note with a suggested phone, and it waits
      until an operator chooses with Edit. Without this hold the row would fall through to "any free
      phone in its pool", which is exactly how one phone ended up with three videos.
    */
    if (post.groupId !== null && post.maxDevices === 1 && post.assignedDeviceId === null) {
      const owned = ownersByGroup.get(post.groupId) ?? new Map<string, string>()
      const ownedByOthers = new Set([...owned].filter(([, key]) => key !== entry.key).map(([deviceId]) => deviceId))
      const pick = pickAssignment({ post, ownedByOthers, fleet: fleet.items, sessionVideos: rowsByGroup.get(post.groupId) ?? 1 })
      const note = unassignedNote(pick, names)
      const dispatch: Post['dispatch'] = { ...post.dispatch }
      let changed = false
      for (const id of post.platforms) {
        const state = stateFor(post, id)
        if (state.state !== 'pending' || state.note === note) continue
        dispatch[id] = withSummary({ ...state, note })
        changed = true
      }
      if (changed) {
        const written = await ctx.storage.global.setIfVersion(entry.key, { ...post, dispatch }, entry.version)
        if (written) entry.version += 1
      }
      continue
    }

    /*
      What the phone types (0.19.0): the caption, then the session's fixed hashtags, the line this video was given and
      its own hashtags — joined here, at the moment of sending, so the three stay separate everywhere else. A row with
      nothing to post is held with a note rather than sent, because the direct upload path refuses an empty text on the
      phone and the operator is expected to write one (auto caption leaves a video without speech empty on purpose).
    */
    /*
      Per platform since 0.27.0: a platform with its own caption posts that text, the rest post the shared one
      (`platformPostTexts`). A platform with nothing to post is held with the note; the others still go, so a
      video whose only text is its YouTube title is sent to YouTube and waits everywhere else.
    */
    // A deleted upload is held with a note on every platform still waiting, never sent (0.36.0, `videoFileExists`).
    if (post.platforms.some((id) => stateFor(post, id).state === 'pending') && !(await videoFileExists(ctx, post.videoArtifactId))) {
      const dispatch: Post['dispatch'] = { ...post.dispatch }
      let changed = false
      for (const id of post.platforms) {
        const state = stateFor(post, id)
        if (state.state !== 'pending' || state.note === VIDEO_FILE_DELETED) continue
        dispatch[id] = withSummary({ ...state, note: VIDEO_FILE_DELETED })
        changed = true
      }
      if (changed) {
        const written = await ctx.storage.global.setIfVersion(entry.key, { ...post, dispatch }, entry.version)
        if (written) entry.version += 1
      }
      continue
    }

    const rule = post.groupId !== null ? (groups.get(post.groupId)?.hashtags ?? NO_HASHTAG_RULE) : NO_HASHTAG_RULE
    const { texts, bare } = platformPostTexts(post, rule)
    if (bare.length > 0) {
      const note = `${NO_CAPTION_YET} — write a caption or hashtags for this video on its session's page`
      const dispatch: Post['dispatch'] = { ...post.dispatch }
      let changed = false
      for (const id of bare) {
        const state = stateFor(post, id)
        if (state.state !== 'pending' || state.note === note) continue
        dispatch[id] = withSummary({ ...state, note })
        changed = true
      }
      if (changed) {
        const written = await ctx.storage.global.setIfVersion(entry.key, { ...post, dispatch }, entry.version)
        // Someone wrote the row meanwhile; the next tick re-reads it rather than planning on a stale copy.
        if (!written) continue
        entry.version += 1
        post = { ...post, dispatch }
      }
      if (bare.length === post.platforms.length) continue
    }
    // Only the platforms that have something to post are planned; the held ones keep their note.
    const planned: Post = bare.length > 0 ? { ...post, platforms: post.platforms.filter((id) => !bare.includes(id)) } : post

    /*
      A group row waits for two things before it may send: its own turn
      (`notBeforeAt`, stamped by Start) and room under the group's "how many
      at once". Both are skips, not states — a row whose turn has not come is
      not "pending for a reason an operator should read", it is simply not yet.
    */
    const nowSec = Math.floor(Date.now() / 1000)
    if (!isRowDue(post, nowSec)) continue
    if (post.groupId !== null) {
      const left = room.get(post.groupId) ?? Number.POSITIVE_INFINITY
      if (left <= 0) continue
    }

    const devices: RouterDevice[] = fleet.items
    const plan = planDispatch({ post: planned, devices, busy: claimed, now: nowSec, maxDevicesPerPlatform: settings.maxDevicesPerPlatform })
    if (plan.dispatches.length === 0 && Object.keys(plan.states).length === 0 && plan.note === post.lastNote) continue

    /*
     * Dispatch BEFORE writing state, and record only what was actually
     * enqueued. The alternative — mark dispatched, then fire — turns a farm
     * that refuses the job (offline since the list was read, no grant) into a
     * post that says "sent" and never was, which is the failure an operator
     * cannot detect from this screen.
     */
    if (post.groupId !== null) {
      const left = room.get(post.groupId)
      if (left !== undefined && Number.isFinite(left)) room.set(post.groupId, left - 1)
    }
    const sent: string[] = []
    /*
      The job id is kept, per platform, because it is the ONLY link back from
      a post to what the farm actually did on the phones. Without it this row
      could say "sent to 10" and never learn that ten uploads failed — which
      is exactly what it used to do — and "re-run the ones that failed" could
      not be answered at all.
    */
    const attempts: Record<string, Attempt[]> = {}
    for (const dispatch of plan.dispatches) {
      try {
        const params = { source: 'direct', videoArtifactId: post.videoArtifactId, caption: texts.get(dispatch.platform) ?? '' }
        const job = await ctx.farm.call('job.run', { scriptRef: dispatch.script, deviceId: dispatch.deviceId, params }, JobRunOutput)
        claimed.add(dispatch.deviceId)
        sent.push(dispatch.platform)
        ;(attempts[dispatch.platform] ??= []).push({
          jobId: job.jobId,
          deviceId: dispatch.deviceId,
          // Recorded at the moment of the dispatch, from the fleet reading
          // this tick was planned against — so the row can name the phone even
          // after it is unplugged, renamed or removed.
          deviceName: names.get(dispatch.deviceId) ?? null,
          state: 'queued',
          error: null,
          at: nowSec,
          settledAt: null,
          round: nextRound(stateFor(post, dispatch.platform)),
        })
      } catch (err) {
        // One phone's refusal never stops the rest — the same posture the
        // TikTok pack's own auto-post tick takes with its fleet.
        ctx.log.warn('could not enqueue a post job', {
          key: entry.key,
          platform: dispatch.platform,
          device: dispatch.stableId,
          error: messageOf(err),
        })
      }
    }

    const next: Post = { ...post, dispatch: { ...post.dispatch }, lastNote: plan.note }
    for (const [platformId, state] of Object.entries(plan.states)) {
      // A planned `dispatched` whose jobs ALL failed to enqueue stays where it
      // was, so the next tick tries again. `sent` is what actually happened;
      // `plan.states` is only what was intended.
      if (state.state === 'dispatched' && !sent.includes(platformId)) continue
      const fired = attempts[platformId]
      // `deviceCount` is corrected to what was enqueued, not what was planned:
      // a phone whose `job.run` threw is not a phone this post was sent to.
      // `withSummary` then writes the line naming those phones — it could not
      // be written inside `planDispatch`, which is pure and had no job ids.
      next.dispatch[platformId] = withSummary(fired ? { ...state, attempts: fired, deviceCount: fired.length } : state)
    }

    try {
      // `setIfVersion` against the version this row was read at: an operator
      // editing the same post through "New post" mid-tick must not have their
      // write silently stomped by the router's. A refusal is a no-op — the
      // next tick re-reads and re-plans from whatever they wrote.
      const written = await ctx.storage.global.setIfVersion(entry.key, next, entry.version)
      if (written === null) {
        ctx.log.info('a post row changed while this tick was planning it — leaving it for the next tick', { key: entry.key })
        continue
      }
    } catch (err) {
      ctx.log.warn('could not write back a post row', { key: entry.key, error: messageOf(err) })
      continue
    }

    if (sent.length > 0) ctx.log.info('dispatched a post', { key: entry.key, platforms: sent.join(','), summary: postSummary(next) })
  }
}

/**
 * The timer body — reads the settings fresh on every poll, so a changed
 * `enabled`/`intervalMinutes` takes effect without a republish, and only
 * actually DISPATCHES once `intervalMinutes` has genuinely elapsed.
 *
 * Every poll still settles: `runTick(..., { dispatch: false })` reads back the
 * jobs already in flight and refreshes what the Posts screen shows. That is
 * not a weakening of "auto-post is off until an operator turns it on" — it
 * enqueues nothing and can post nothing — it is what makes a manually
 * triggered retry visible on a farm that never turns the timer on at all.
 */
async function maybeRunTick(ctx: PluginServiceContext): Promise<void> {
  let settings: AutoPostSettings
  let readable = true
  try {
    settings = (await ctx.storage.global.get(AUTO_POST_SETTINGS_KEY, AutoPostSettingsSchema)) ?? DEFAULT_AUTO_POST_SETTINGS
  } catch (err) {
    // A stored shape this build cannot read must never be misread as
    // "enabled" — fail closed. Posting to real accounts is not a default.
    ctx.log.warn('auto-post settings have an incompatible shape — leaving auto-posting off this tick', { error: messageOf(err) })
    settings = { ...DEFAULT_AUTO_POST_SETTINGS, enabled: false }
    readable = false
  }

  let dispatch = false
  const enabled = readable && settings.enabled
  if (enabled) {
    const nowSec = Math.floor(Date.now() / 1000)
    const lastRunSec = (await ctx.storage.global.get(AUTO_POST_LAST_RUN_KEY, z.number().int().nonnegative())) ?? 0
    if (nowSec - lastRunSec >= settings.intervalMinutes * 60) {
      // Stamped BEFORE the tick: a tick slow enough to still be running (many
      // posts, many phones) must not be re-entered by the next 60 s poll.
      await ctx.storage.global.set(AUTO_POST_LAST_RUN_KEY, nowSec)
      dispatch = true
    }
  }

  await runTick(ctx, settings, { dispatch, enabled })
}

/** The platform choice an operator sees in the New post form — `tiktok` → `TikTok`. */
const PLATFORM_LABELS: Record<string, string> = Object.fromEntries(PLATFORMS.map((p) => [p.id, p.title]))

export default definePlugin({
  id: 'smm',
  // 0.1.0 — first release. The router, the post row, the Social posts and
  // Platforms screens, and the auto-post timer (off by default). TikTok is the
  // only platform with a verified upload flow; Instagram and YouTube are
  // declared and say why they cannot post yet.
  version: '0.50.0',
  icon: 'upload',
  title: 'Social Media Manager',
  description: 'Upload a folder of videos and send them across the phones labelled for each platform, paced so they do not all move at once. TikTok, YouTube and Instagram post today.',
  scripts: [addPost, retryFailed, addPosts, addGroup, startGroup, retryGroup, updatePost, resolveAttempt, skipPlatform, updateGroup, cleanPhoneVideos, syncAccounts],
  /*
    Plan 315 — workflows this plugin ships. Registered on the farm as
    `smm/<name>` when this version is activated, read-only there; an operator
    who wants a different rotation duplicates it.
  */
  workflows: [warmupRotation],

  service: defineService({
    /**
     * Exhaustive, and nothing below calls anything absent from it — this list
     * is what the operator is shown and consents to at install.
     *
     * `device.list` is the fleet read (status, activities, labels); `job.run`
     * is the dispatch; `job.get` is how a dispatched post learns what actually
     * happened on each phone. `job.list` is still deliberately absent:
     * `activities` already answers "is this phone busy", and the reconciler
     * asks about jobs it holds ids for, one at a time — a permission asked for
     * and not needed is one an operator granted for nothing.
     */
    permissions: ['device.list', 'job.run', 'job.get', 'artifact.get'],
    setup: (ctx) => {
      const timer = setInterval(() => {
        void maybeRunTick(ctx).catch((err) => ctx.log.warn('router tick failed', { error: messageOf(err) }))
      }, POLL_MS)
      ctx.onStop(() => clearInterval(timer))
    },
  }),

  surface: {
    /*
      ONE entry, for one screen. The plugin used to carry three — posts,
      sessions, platforms — and the owner's verdict after using it was that
      three menus for one job is three places to get lost. The work is a
      single sequence (upload a folder, spread it over the phones, watch it),
      so the screen is a single page; see `ui/index.tsx`.
    */
    nav: [{ id: 'posts', label: 'Social posts', icon: 'upload', view: 'posts' }],
    views: {
      posts: {
        title: 'Social posts',
        description: 'Upload the videos, choose where they go and how fast, then start the session — all on this page.',
        /*
          Tier C. A declared table can render stored rows and fire an action
          per row, which is right for a list and cannot express this flow:
          files uploading one after another with progress, a fleet count that
          answers back as labels are picked, a pacing sentence that recomputes
          as the numbers move, captions generated from file names. Those are
          answers the screen computes WHILE the operator decides.
        */
        react: { entry: 'index.js', apiVersion: PLUGIN_UI_API_VERSION },
      },
    },

    /*
      No declared actions, deliberately.

      Tier A's actions are buttons a declared TABLE puts on a row or a
      toolbar, and this plugin no longer has a table: the one screen does the
      creating, the starting, the retrying and the removing itself, through the
      same members those buttons used to call. Keeping them declared would
      leave a set of controls nothing can render and no one can press — the
      exact kind of half-real surface this rewrite exists to remove.
    */
  },
})
