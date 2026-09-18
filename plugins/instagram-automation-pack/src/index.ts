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
import clearDrafts from './clear-drafts'

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
  version: '0.11.0',
  /** Plan 310 §3.3 — shown wherever this plugin is offered as a choice. */
  icon: 'activity',
  title: 'Instagram automation pack',
  description: 'Browse Reels, the feed, stories and Explore, check inbox, notifications and profile, search, and post Reels — with keyword-tilted random behaviour.',
  scripts: [scrollReels, checkInbox, checkActivity, checkProfile, searchKeyword, scrollFeed, watchStories, exploreReels, postVideo, clearDrafts],

  /**
   * ## Changelog
   *
   * **0.11.0 — another app over Instagram stopped being reported as a signed-out
 *   account.** This pack had no foreign-app guard at all, and that absence cost
 *   twice.
 *
 *   `isSignedOut` reads the WHOLE tree, so ANY app in front carrying a "Log in"
 *   button answered yes — a Google sign-in page, a Play sheet, a browser. And
 *   `relaunch` does not merely report that: it THROWS `E_NOT_SIGNED_IN`, whose
 *   message sends the operator to sign in the account this phone should use. On
 *   a phone that was signed in the whole time, that is the most expensive wrong
 *   lead available, and it makes a stuck screen look like an account problem.
 *   `youtube-automation-pack` shipped the identical accusation ("that is usually
 *   a signed-out YouTube", over a Play Store sheet) and fixed it in 0.39.14;
 *   this is the same bug in a second pack, found by looking rather than by
 *   another farm paying for it.
 *
 *   So: `foreignAppOnTop` (`@enkaku/sdk`, carrying both other packs' production
 *   trees), `isSignedOut` answers false when Instagram is not the app on screen,
 *   and `relaunch` gets the recovery loop YouTube has had since 0.39.14 — three
 *   rounds of BACK and launch, running BEFORE the signed-out check, and never
 *   force-stopping the intruder, which may be something of the owner's. The
 *   give-up warning names the app that held the screen.
 *
 *   Instagram's own login screen is still read as signed out — asserted
 *   directly, because a guard that suppressed that too would trade a wrong
 *   accusation for a phone that silently never runs.
 *
 * **0.10.10 — the drafts tab is tapped until it opens, and the failure stops
   * blaming the wrong button.**
   * `clear-drafts` reported `the "Draf" tab opened but its "Kelola" button was
   * not found` on the owner's moto g06 (2026-09-17). The tree saved beside that
   * message showed the gallery still on its folder list — `gallery_folder_menu_tv`
   * ("Terbaru") present, `drafts_tab_text` still sitting there unpressed, and
   * `gallery_manage_button` absent from all 401 nodes. Nothing had opened.
   * "Kelola" was not missing or renamed: the run never reached the screen that
   * button lives on. The old wording asserted a step nothing had proven, and it
   * cost two separate readings of this failure before the tree was opened.
   * `drafts.ts`'s own measured header says why the tap was lost — in this app
   * "about one tap in three was not taken and had to be repeated" — which every
   * DELETION here already accounts for. This one tab tap was sent once and
   * believed. It is re-read from the current tree and repeated up to 3x now, and
   * the failure states only what was actually established.
   *
   * **0.10.9 — the timing kit is the SDK's now, not this pack's own copy.**
   * `makeRng`, `between`, the dwell model and `planConfirmStep` existed three
   * times over — once in each of the TikTok, Instagram and YouTube packs — and
   * the copies had already drifted, which is exactly why a fix written in one of
   * them never reached the other two. They delegate to `@enkaku/sdk` now:
   * `makeRng`, `between`, `pickDwellMs`, `planRevisitStep`. Behaviour is
   * unchanged, and that is verified rather than asserted — the SDK's test
   * transcribes the implementation this pack carried and compares the two step
   * for step, four seeds, 120 rounds each, including the order the rng is drawn
   * in, which is what a seeded replay depends on. The dwell TABLE stays here: a
   * reel is not a Short and not a TikTok clip, and the model takes the table as
   * an argument for that reason. No call site in this pack changed.
   *
   * **0.10.8 — the retry swipe stops being identical, and the easing is drawn.**
   * Two leftovers from the 2026-09-17 survey. `verifiedSwipeUp` drew its first
   * reach at random and then fell back to the bare constant `0.88`, so a feed
   * that needed a second push got a byte-identical gesture every single time —
   * the first swipe randomised, the second a signature. It is a range now. And
   * the swipe pinned `easing: 'linear'` on every reel advance, which is a shape
   * of its own; it is drawn per swipe from the three the engine supports.
   * `pullToRefresh` keeps `easeInOutCubic` on purpose — that one must DRAG to
   * trigger the refresh rather than flick past it.
   *
   * **0.10.7 — this pack stops only ever going forwards.** A survey against the
   * TikTok and YouTube packs (2026-09-17) found two behaviours missing here
   * entirely: TikTok scrolls back over a reel it just passed (5%) and takes a
   * real break (3%), and the reels loop here did neither — it advanced, every
   * time, forever. Both are now in, with the same constants, and the back-scroll
   * is the first thing in this pack to use the API's own human gesture:
   * `scroll({ direction, human: true })` draws its corridor, reach, duration and
   * easing per call, so the loop computes no geometry at all. The inlined jitter
   * helper is gone too — `aimInside` from `@enkaku/sdk` is the same rule all
   * three packs had copied, and it takes the run's rng, so a seeded run finally
   * replays its taps. `search-keyword` types through the SDK's `human` mode,
   * typos off: Explore edits its suggestion list under the cursor, and a
   * backspace there can commit a suggestion rather than what was typed.
   *
   * **0.10.6 — the phone-number wall is a wall of its own.** Six phones in one
   * production session (#41, #46, #50, #51, #72, #73 on 2026-09-16) failed with
   * the generic "bottom navigation is not on screen" while Instagram held them on
   * an English screen: "Enter your mobile number" over "You'll need to confirm
   * this mobile number with a code via SMS or WhatsApp", an "ID +62" chip, a
   * "Phone number" field and "Send code". That is an account demand, not the bot
   * check 0.10.4 named — `humanCheckAccount` rightly said nothing about it — so it
   * now has its own reader and its own message. Two sentences are required to
   * match, because "Enter your mobile number" alone also appears in ordinary
   * settings. **Nothing types a number and nothing presses "Send code"**: entering
   * contact details for an account is not something this automation does. The
   * fixture's wording is verbatim from the production dumps; its bounds are
   * reconstructed from the screenshot, which the reader does not use.
   *
   * **0.10.5 — the gate is read from either half of a node, in either language.**
   * The session that prompted 0.10.4 reached eight held phones by the evening, and
   * they are not all worded alike: `bitorexsocial` is an English build ("Confirm
   * you're human to use your account"), and the Indonesian ones vary between
   * "menggunakan profil Anda" and "menggunakan akun Anda". The reader now matches
   * the first clause only, and looks at a node's `text` and `desc` separately
   * rather than joined — the handle sits at the END of whichever line carries it,
   * so joining would hide the name on any build that describes the screen in one
   * half and names the account in the other. Still no press on "Lanjut".
   *
   * **0.10.4 — a held account is named, not reported as a missing navigation.**
   * Three phones in one production session (#4, #14, #59 on 2026-09-16) failed
   * "Instagram's bottom navigation is not on screen after launch", and all three
   * dumps were the same screen: Instagram holding the account behind
   * "Konfirmasikan bahwa Anda adalah manusia untuk menggunakan profil Anda,
   * &lt;handle&gt;". The failure now names the handle and says a person has to answer
   * it on the phone. The pack does NOT press "Lanjut" — working an app's own bot
   * check is not something this automation does — so this is a better report, not
   * a recovered run.
   *
   * **0.10.3 — the Explore search box is found when it is a Button.** Seven
   * production runs (2026-09-16) failed "the Explore screen shows no search field"
   * with the field on screen: `action_bar_search_edit_text` at [23,64][697,130],
   * clickable and reading "Cari", but an `android.widget.Button` on that build,
   * while this pack required an `EditText`. The id now counts as much as the class,
   * and both still have to sit in the top bar.
   *
   * **0.10.2 — the pushed videos are cleaned up.** Every run left its video in /sdcard/DCIM/Camera and nothing removed it (the owner, 2026-09-16: old video files pile up). Before pushing, `removeStalePushedVideos` deletes this pack's own pushed files older than six hours
   *
   * **0.10.1 — the caption is typed at a person's pace.** The owner
   * (2026-09-16): captions went in "like a robot, or like copy and paste".
   * Word by word through the SDK's `human` typing — a slower cadence, a longer
   * beat at each word's end, a thinking pause every few words, rare corrected
   * typos — with a varied beat at every space; a hashtag's space, `#` and first
   * letter still go as one command, so the suggestion list never swallows the
   * `#`, and the rest of the tag has no typos.
   *
   * **0.10.0 — `clear-drafts`: every draft on the account, deleted on its
   * own.** The owner asked (2026-09-16) for draft cleaning as a script of its
   * own on every platform, triggered from the Social Media Manager page.
   * Instagram keeps TWO lists, both measured on the owner's moto that night: the
   * new-post gallery's "Draf" → "Kelola" list (a Compose page whose row menu
   * "Hapus" deletes at once) and the Reel gallery's "Draf · N" → "Draf Reel"
   * (row menu "Hapus", then "Hapus draf?"). The member empties the list of the
   * gallery "+" opens, then reaches the other; every deletion is proven by the
   * row count, and a tap that did not take is tried again. A dry run counts.
   *
   * **0.9.2 — leaving the new-post gallery is read from what is drawn.**
   * Production #59 (0.9.0, 2026-09-15) failed "the new-post gallery has no REEL
   * destination tab, and it did not close with its own Batal", and the owner's
   * moto g06 (Instagram 446.0.0.49.77, id-ID) reproduced it on a 0.9.1 dry run.
   * "Batal" HAD closed the gallery and the home feed was back, but the tree
   * still held the destination bar's `cam_dest_clips` squashed off the left
   * edge (right -25); counted, the gallery read as still open, BACK was pressed
   * on the home feed and the run failed. The gallery and its REEL tab now count
   * only when on screen, so the profile's "Buat Baru" route 0.9.0 added is
   * actually reached. (That dump's new-post gallery also shows why the REEL
   * tab is "missing": the bar is drawn over the grid — POSTINGAN, CERITA, REEL
   * on the screenshot — but the farm's reading carries no node for it.)
   *
   * **0.9.1 — the keyboard is never put away with a tap on a sentence that may
   * hold a link.** Production job 032494ca (2026-09-15, English build): the tap
   * meant to close the keyboard over Share landed on a text whose inline link
   * is not a node of its own, and opened Instagram's Help Center in its in-app
   * browser; the run then failed "the share screen is not showing". The spot is
   * now chosen only among short labels (40 characters at most) that name no
   * link ("Learn more", "Pelajari selengkapnya", "Manage settings", …); with
   * none, the run closes the keyboard with BACK as before.
   *
   * **0.9.0 — "+" is tapped again when it did not take, and the Reel
   * gallery has a second way in.** This pack's 0.8.0 on the owner's Samsung
   * SM-A075F (id-ID and en builds, 2026-09-15): 2 runs (e.g. job 8a3321b4)
   * failed "the create gallery did not open after +", and the tree saved as
   * `ig-03-gallery` was still the home feed — reels tray, "Your story",
   * "Suggested for you", Follow and Dismiss — so "+" had never been taken.
   * While nothing it opens is showing and "+" is still on screen with nothing
   * over it, it is tapped again after a short pause, twice at most, and only
   * from a reading taken after that pause (a gallery that opens late puts its
   * own close button where "+" was). And job 0d376657 still failed "the
   * new-post gallery has no REEL destination tab" after 0.8.0's wait and
   * drag: `tab_bar` at zero width at x=720, no `cam_dest_clips` at all. The
   * run now closes that gallery with its own "Batal" (never "Selanjutnya"),
   * opens the profile, taps its "Buat Baru" and takes the "Buat" sheet's Reel
   * row — anchors already measured in `screen-profile-empty.json` and
   * `screen-create-menu-sheet.json` — and fails as before, naming both
   * artifacts, if that route does not reach the Reel gallery either.
   *
   * **0.8.0 — Share is tapped again when it did not take, and a hidden REEL
   * tab is brought back.** Two production sessions (2026-09-15): 5 runs failed
   * "Share was tapped but Instagram stayed on the share screen" with
   * "Selanjutnya" in view, nothing over it and the caption still holding its
   * cursor — the tap only took the focus off the caption. While the share
   * screen is still up (so nothing was shared), the button is tapped again,
   * twice at most. 3 runs failed "the new-post gallery has no REEL destination
   * tab": the POSTINGAN / CERITA / REEL bar was tucked away (`tab_bar` at zero
   * width, off screen). The run now waits for it, then drags the grid down a
   * little and looks again, before failing as before.
   *
   * **0.7.1 — the caption is typed only into a focused field.** The owner
   * watched production phone #20 (2026-09-15) on the share screen: the page
   * kept bouncing as if swiped against its end, and the run failed "does not
   * hold all of it". Its share screen had been read while still sliding in (the
   * page 342 px to the right), so the caption tap went to x=702, past the
   * field; the field never took focus, and every space and ENTER of the caption
   * scrolled the page instead. The field is now tapped only once two readings
   * place it the same, and after the tap the run reads the screen: with no
   * focus and no keyboard it taps once more, and then stops with
   * E_CAPTION_NOT_FOCUSED without typing anything. Also phone #3: Instagram
   * raised Android's camera dialog at launch, and the microphone's right after
   * it, although both had been refused before launch; hidden from the reader,
   * the run saw only System UI and failed "bottom navigation is not on
   * screen". A launch that reads as System UI alone now presses BACK — which
   * refuses such a dialog — and waits again, up to three times. And once past
   * that dialog, #3 still failed "does not hold all of it" with the whole
   * caption in the field: its reader returned the two ENTERs as `&#10;`, which
   * the check squashed to "#10#10". The check now reads such a reference as
   * the space it is (and the core's XML reader decodes it too).
   *
   * **Also in 0.7.0 — three production failures (2026-09-15).** Phone #3:
   * Android's hidden "Izinkan Instagram mengambil gambar dan merekam video?"
   * stopped the editor → share step, so camera and microphone are now refused
   * and fixed before launch (the gallery upload never uses them). Phone #16:
   * an announcement sheet swallowed the "Berikutnya" tap, so while the editor
   * is still up with nothing over it, Next is tapped again (twice at most).
   * Phone #20: a caption ending in "#liquidity" left the hashtag suggestion
   * list open and the caption check failed, so a line ending in a hashtag or
   * mention now gets one trailing space.
   *
   * **0.7.0 — the profile is pulled to refresh at a person's rhythm.** The
   * owner asked (2026-09-15) for the looks after Share to stop being one
   * mechanical loop: every look after the first either pulls the open profile
   * down to refresh it or visits Home and comes back to the profile (usually
   * pulling there too), at jittered 10–20 s gaps, never Home twice in a row
   * and never more than three pulls in a row. The pull is a slow drag inside
   * the profile content, never a tap. The 4-minute budget, the early exit on a
   * higher post count and "unverified, never failed" are unchanged.
   *
   * **0.6.0 —the profile is re-read for up to four minutes after Share.**
   * The owner watched production phone #2 (2026-09-15): the new Reel counted
   * on the profile only on the third refresh, just as its upload finished.
   * The confirmation looked eight times (about two minutes); it now keeps
   * looking by time, every 15 s for up to 4 minutes, so a slow upload is not
   * closed and reported "unverified" before it lands.
   *
   * **0.5.0 — an announcement sheet is closed wherever it lands.** The owner's
   * Samsung production farm (2026-09-15): posts stopped at "the Reel editor's
   * Berikutnya did not appear" and "the share screen did not open after the
   * editor", both with Instagram's camera-shortcut announcement ("Abadikan
   * momen dengan pintasan kamera baru") on screen. Every `waitForTree` poll
   * now closes such a sheet with "Lain kali" — never "Buka pengaturan
   * perangkat", which leaves Instagram — before checking its own anchor, and
   * the editor wait says so by name if the sheet will not go. The sheet is also
   * recognised by that settings label if drawn without Instagram's igds ids.
   * And "a dialog the farm cannot read after +" is reported only when the
   * screen is still unreadable at the end of the wait: a production screenshot
   * behind that error was Instagram's own resume-draft dialog fading in, which
   * the waits used to stop on during its first empty frame.
   *
   * **0.4.5 — the farm's keyboard, a covered Share, and no draft left behind.**
   * From the exported timelines of the 2026-09-14 Samsung production run:
   * with Text input on `auto` the keyboard on screen is the guest agent's own
   * (`dev.enkaku.guestagent`), which `keyboardShowing` did not recognise, and in
   * one run its "Switch keyboard" button sat over "Selanjutnya" — the Share tap
   * would land on it. The farm keyboard now counts as a keyboard, and Share is
   * tapped only when no other window covers it (else `E_SHARE_COVERED`, nothing
   * shared). A failed run now backs out and discards the unposted edit ("Mulai
   * dari awal") before stopping Instagram: a force-stop alone kept it, and the
   * next "+" saved it as a draft on the account. A hashtag with punctuation
   * around it (`#fyp,`) counts toward the five.
   *
   * **0.4.4 — five hashtags, as Instagram allows.** The first production run
   * (2026-09-14, 20 Samsung phones through the Social Media Manager) failed every
   * Instagram post at the caption check, and the saved fields all read the same
   * way: five hashtags, then the sixth onward with no `#`
   * ("#choch marketstructure belajartrading"). Instagram keeps at most five
   * hashtags; the session had three fixed plus five per video. `captionLines`
   * now keeps the first five hashtags and leaves the rest out by name, the log
   * says which, and the caption check compares against what was typed.
   *
   * **0.4.3 — a Reel that posted is reported `posted`, and the caption check
   * sees a lost `#`.** The 0.4.2 retry DID post (the profile showed 1 post), yet
   * reported `unverified`: after Share Instagram sits on the Reels tab and keeps
   * the profile page in the tree off screen with its old count, and
   * `profilePostCount` read that stale "0" eight times. It now reads only an
   * on-screen header (fixture `screen-reels-tab-stale-profile.json`). The same run's
   * caption lost one `#` ("#liquidity tradingindonesia") and still passed, because
   * `captionLanded` compared letters and digits only; `#` and `@` now count, and
   * a line with hashtags is typed word by word with a short human pause, each
   * word carrying its leading space so no `#` begins a command.
   *
   * **0.4.2 — the caption arrives whole, and Share is not tapped through the
   * keyboard.** The 0.4.1 retry reached Share and stopped there, for two reasons
   * its artifacts show. The caption carried an emoji, so it was typed through the
   * session's text engine instead of adb, and Instagram's hashtag suggestions ate
   * the hashtags ("#fyp #tra rtro") — while `captionLanded`, which compared only
   * the first 24 letters, called it landed. And the keyboard was still up over
   * "Selanjutnya", so the Share tap hit a key. Now the caption is typed line by
   * line through adb with ENTER between lines (characters adb cannot carry are
   * left out, and the log says how many), `captionLanded` compares the whole
   * caption, and a keyboard still showing is put away before Share the way a
   * person does it — a tap on plain page just above the keys, on a label that
   * is part of nothing tappable (`keyboardDismissPoint`) — with BACK only as the
   * fallback when there is no such spot or the keyboard stays up.
   *
   * **0.4.1 — the right "+", and a draft prompt that lands late.** The 0.4.0
   * retry's timeline showed two causes. "+" was tapped at x=-1398: with the
   * profile open, the home feed stays in the tree off screen, and its "+" was
   * taken as the button — the tap hit the profile's own "+", which is what
   * opened the "Buat" sheet. `homeCreateButton` now only takes an on-screen
   * button. Then "Terus edit draf Anda?" appeared a moment AFTER the Reel
   * gallery drew, over its grid, and the wait for video cells timed out. The
   * gallery wait now also stops on that dialog or the draft sheet, starts a new
   * video (the old edit stays in Drafts), and waits again.
   *
   * **0.4.0 — "+" that opens the "Buat" sheet still reaches the Reel gallery.**
   * On a routed run (2026-09-14, the owner's moto, a fresh account) "+" opened a
   * "Buat" bottom sheet — Reel, Edits, Posting, Cerita, Sorotan, Siaran Langsung —
   * instead of the gallery, and `post-video` failed with "the create gallery did
   * not open". It now recognises that sheet (`createMenuSheet`, fixture
   * `screen-create-menu-sheet.json`), taps its Reel row, and carries on; a sheet
   * with no recognisable Reel row fails by name before anything is posted.
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
