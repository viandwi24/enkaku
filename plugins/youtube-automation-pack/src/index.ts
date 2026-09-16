import { definePlugin } from '@enkaku/sdk'
import searchChannel from './search-channel'
import scrollShorts from './scroll-shorts'
import scrollLive from './scroll-live'
import downloadHome from './download-home'
import searchPlay from './search-play'
import watchVideo from './watch-video'
import postVideo from './post-video'
import clearDrafts from './clear-drafts'

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
  // 0.18.0 — the navigation is not readiness. It draws about a second after
  // the settle, and a tap sent then does nothing, while the identical tap
  // twelve seconds after launch opens the screen it names — both measured
  // directly through the same session (2026-09-08). `relaunch` now waits for
  // the tree to stop changing as well: two dumps of the same size mean the app
  // has finished drawing.
  // 0.17.0 — `openSearchField` waited for "a field OR a bar", and the bar also
  // exists on the home screen of an account with no watch history, so the poll
  // returned instantly on HOME and the fallback tapped that card instead of
  // the search screen. It waits for the field alone now; the bar is reached
  // only after that wait comes back empty.
  // 0.16.0 — the search icon's own tap was still a guess. `openSearchField`
  // now polls for the search page instead of the caller sleeping 1.2-2 s and
  // capturing: that capture was catching the HOME FEED, and 0.15.0's
  // geometric fallback then tapped a VIDEO ROW because it was wide and near
  // the top. The fallback is gone — an anchor that can match the wrong thing
  // turns "I could not find it" into "I did something else".
  // 0.15.0 — two more guesses replaced by waits, from the first two-device
  // warm-up on the owner's phones (2026-09-08, both at 0/3 actions):
  // `scroll-shorts` slept 4-6 s after tapping the Shorts tab and judged the
  // screen once — Shorts loads video before it has a rail — and every
  // search-based script expected an `EditText` that this YouTube build does
  // not show: its search bar is a `Button` (`desc:"Telusuri YouTube"`) and the
  // input appears only after that is tapped. `openSearchField` handles both
  // shapes, matching the bar by description in three languages with a
  // geometric fallback for a build whose wording we have not met.
  // 0.14.0 — wait for the app, do not guess at it. Every launch site slept a
  // flat 5 s after a `clearRecents` cold start and then acted; on the owner's
  // phones all six actions of a two-device warm-up failed on 2026-09-08, each
  // one a tap that landed before YouTube could act on it ("tapped the Shorts
  // tab but the Shorts rail never appeared", "the search screen opened with no
  // text field"). `relaunch` in `youtube.ts` now polls for the app's own
  // bottom bar — the principle `waitForTree`'s comment already stated for
  // search results, finally applied to the launch before them. The readiness
  // labels are bilingual (Home / Beranda, Subscriptions / Langganan).
  version: '0.39.3',
  /** Plan 310 §3.3 — shown wherever this plugin is offered as a choice (the script palette's plugin page, the Plugins rail). */
  icon: 'play',
  title: 'YouTube automation pack',
  description: 'Search, browse, watch, like, read comments, download, and post Shorts in the YouTube app on a farm device.',
  scripts: [searchChannel, scrollShorts, scrollLive, downloadHome, searchPlay, watchVideo, postVideo, clearDrafts],

  /**
   * ## Changelog
   *
   * **0.39.3 — a trim "Done" YouTube ignored is tapped again.** Production #42
 * (2026-09-16) tapped the trim screen's own `shorts_trim_finish_trim_button`
 * — drawn "Done" on that phone's English build — and twenty seconds later the
 * dump was still that same screen, the button in it, nothing processing. The
 * run reported that the Shorts editor never opened, which was true and not the
 * reason. It is the swallowed tap the editor's "Berikutnya" already gets, fixed
 * there in 0.37.0; the trim screen now gets the same two retaps.
 *
 * **0.39.2 — a search result is never a sponsored card.** Production
   * (2026-09-16): twelve `search-play` runs and two `watch-video` runs failed "a
   * result was tapped but nothing that looks like a player appeared". The dumps
   * show why — a query's first page carried two sponsored install cards above the
   * first real result, and a random pick tapped one, which leaves YouTube. The
   * search walk now drops the rows YouTube sold, the way `download-home` already
   * did, and falls back to the full list only if every row is an advert.
   *
   * **0.39.1 — the pushed videos are cleaned up.** Every run left its video in /sdcard/DCIM/Camera and nothing removed it (the owner, 2026-09-16: old video files pile up). Before pushing, `removeStalePushedVideos` deletes this pack's own pushed files older than six hours
   *
   * **0.39.0 — `clear-drafts`: every draft on the channel, deleted on its own.**
 * The owner asked (2026-09-16) for draft cleaning as a script of its own on every
 * platform, triggered from the Social Media Manager page. Measured on the owner's
 * moto that night: Anda → "Lihat channel" → the channel's "Draf" cell → each
 * draft's "Action menu" → "Hapus" → "Hapus draf ini?" → "Hapus". Every deletion
 * is proven by the page's count or its empty message; a tap that did not take is
 * tried again. A dry run counts. The title is still typed in one go: typed at a
 * person's pace, only "Market hari ini agak aneh, ki" of a 69-character title
 * landed on the moto before the field let go of focus.
 *
 * **0.38.3 — the title is never typed twice.** Production 4e4eac2b and
   * 9073e560 (2026-09-15): after the title opened the thumbnail editor, 0.36.0
   * left the editor and typed the title again — but part of the first typing
   * had already landed, so the field held the title twice, YouTube refused it
   * in red ("Tulis teks yang lebih singkat") and Upload stayed disabled. The
   * field is now read first: typed again only when it reads empty, left alone
   * when it already holds the whole title, and otherwise the run stops, with
   * nothing uploaded. YouTube's refusal itself is recognised too
   * (E_TITLE_REFUSED) instead of reading as "something covers Upload".
   *
   * **0.38.2 — the details screen gets up to 2 min 30 s.** The owner
   * (2026-09-15): a slow phone still preparing a Short should be waited for,
   * not failed. The details screen now gets up to 150 s to open once the
   * Shorts editor is gone (it was 30 s, plus the retaps of "Berikutnya") and up
   * to 150 s to finish loading (it was 45 s). The job's time limit is 15
   * minutes (it was 10) so processing, the details screen and the confirmation
   * all still fit.
   *
   * **0.38.1 — two corrections to 0.37.0's readable details screen.**
   * Production session g-1789475048-2bac (2026-09-15, 0.38.0): 2 runs typed the
   * title into YouTube's thumbnail editor — 0.37.0 aimed the title tap at the
   * middle of the "Caption your Short" node, which is not where the field
   * takes it — so the title is aimed at the measured offset again, as every
   * earlier post on both phones was; only Upload is aimed at by its own bounds.
   * And 3 runs failed "the details screen never stopped loading within 45s"
   * on a screen that was ready: its thumbnail preview kept playing. A readable
   * details screen with its Upload button drawn now counts as loaded.
   *
   * **0.38.0 — a YouTube that must be updated says so.** Production job
   * 75895645 (2026-09-15) failed "YouTube's bottom bar has no Create button —
   * usually a signed-out YouTube" while the phone showed YouTube's own
   * full-screen "Update aplikasi Anda" with a single UPDATE button. That screen
   * is now recognised (`updateRequired`) and the run stops with
   * E_APP_UPDATE_REQUIRED, naming the fix: update YouTube on the phone. Nothing
   * is pressed on it — updating an app is the operator's call.
   *
   * **0.37.0 — the details screen is recognised when it is readable.** Two
   * production sessions (2026-09-15) failed 16 times "the details screen did
   * not open after the editor". In 13 the screen was open and in plain view —
   * "Tambahkan detail", the title area "Tambahkan teks pada video Shorts" and
   * `upload_bottom_button` "Upload video Shorts" — but every check was written
   * for the moto, where the screen is hidden from the reader. `onDetailsScreen`
   * now accepts either, and on a readable screen the title area and Upload
   * (or the toolbar's `upload_menu_button`) are tapped by their own bounds
   * instead of the moto's measured offsets. In 2 more the Shorts editor was
   * still up after "Berikutnya": while it and its button are still there, and
   * YouTube is not processing, the button is tapped again, twice at most.
   *
   * **0.36.0 — three production failures after 0.35.0 (2026-09-15).** Phone
   * #10: YouTube kept coming up as a small Shorts player over the launcher, even
   * after 0.35.0's second launch and force-stop, and the run failed "no Create
   * button". Picture-in-picture is now turned off for YouTube before every
   * launch (`app.denyPictureInPicture`, `appops … PICTURE_IN_PICTURE ignore`,
   * read back; a core without it logs a warning and the run goes on). Phone #5:
   * the camera screen's "Tambahkan dari Galeri" was tapped and nothing happened,
   * so while that screen is still up six seconds later its button is tapped
   * again, twice at most. Phone #13: the title tap did not focus the field and
   * the title opened the thumbnail editor; with nothing uploaded and nothing in
   * the field, the run now leaves the editor by "Keluar dari editor thumbnail",
   * taps the title again and types it once more, and fails as before only if
   * that misses too.
   *
   * **Also in 0.35.0 — YouTube opened as a picture-in-picture window is brought
   * back full screen.** The owner's production phone #8 (2026-09-15): right
   * after a clean launch, YouTube's whole window was a small video box over the
   * Samsung home screen, and the run failed "no Create button" after waiting
   * 25 s for a bottom bar PiP never draws. `relaunch` now recognises that shape
   * (`pictureInPictureOnly`: every YouTube node in a box under 60% wide and 50%
   * tall, another app across the screen), launches YouTube again to bring its
   * task back, and force-stops and launches once more if that does not work.
   *
   * **0.35.0 — the channel is pulled to refresh, and the looks after Upload
   * vary like a person waiting.** The owner watched production phones
   * (2026-09-15): re-opening the channel through the Anda tab does not refresh
   * it — the uploading cell seen right after Upload disappeared from the
   * re-opened channel and came back only once the upload had finished. Every
   * look after the first now pulls the channel's video list down to refresh
   * it (a slow drag inside the list, never a tap), and the rounds vary: usually
   * a pull on the channel already open, sometimes a visit to Home first and
   * back through Anda, at jittered 8–16 s gaps. The budgets (3 minutes, 5 once
   * the upload was seen in flight), the early exit and the no-force-stop rule
   * are unchanged. Also from the Samsung farm (#6, #7): after the trim
   * screen's "Selesai", YouTube showed "Memproses — Mungkin perlu waktu
   * beberapa saat" over the trim screen for longer than the 20 s the editor
   * got, and the run failed "the Shorts editor's Berikutnya did not appear".
   * While that processing overlay is on screen the run now keeps waiting for
   * the editor, up to 3 minutes, without tapping "Selesai" again, and says it
   * was still processing if it never finishes.
   *
   * **0.34.0 —hashtags survive a long caption, and every upload is watched
   * for at least three minutes.** The owner's production farm (2026-09-15):
   * a 224-character caption was cut at character 100, which dropped every
   * hashtag (the post puts them at the end) and could cut a word in half.
   * `youtubeTitle` now keeps the caption's text cut at a word and adds as many
   * of its hashtags as fit, keeping at least 40 characters of text. And a run
   * that never caught its upload in flight still looks at the channel for 3
   * minutes before "unverified" (5 once the upload was seen), because the
   * uploading cell disappears from a re-opened channel until it finishes.
   *
   * **0.33.0 — an upload seen in flight is watched until it lands.** The
   * owner's production farm (2026-09-15, #12): the first look after Upload read
   * "Mengirim file • 10%", the channel re-opened through the Anda tab lists a
   * Short only once it is sent and processed, and five more looks over ~90 s
   * ended "unverified" — the Short went live afterwards. A run that saw its
   * upload in flight now keeps looking every 15 s for up to 5 minutes, and an
   * unverified result says it was still uploading instead of "the channel page
   * was as it was before Upload".
   *
   * **0.32.0 — a Google account page over YouTube at launch is left with BACK.**
   * The owner's Samsung production farm (2026-09-15): posts failed "YouTube's
   * bottom bar has no Create button" because, right after a clean launch,
   * Play services showed "Akun Google" ("Jangan sampai Akun Google Anda
   * terkunci", add a recovery phone) over YouTube. The page is drawn by
   * `com.google.android.gms` and shows the reader only empty containers, so
   * `relaunch` recognises it by shape (a screen-covering gms window, no
   * YouTube node) and presses BACK, up to three times, before waiting for the
   * navigation again. Nothing on the page is ever tapped.
   *
   * **0.31.1 — the real exit sheet, and a dry run that leaves no draft.**
   * Measured on the owner's moto g06 (2026-09-14, YouTube id-ID): BACK from the
   * details screen returns to the editor, and BACK there raises a sheet with
   * `close_bottom_sheet_reshoot` "Hapus hasil edit", `close_bottom_sheet_exit`
   * "Simpan sebagai draf" and `close_bottom_sheet_cancel` "Batal". 0.31.0's
   * exact-label discard ("Buang", "Hapus", …) never matched "Hapus hasil edit",
   * so a failed run would still have left a draft. `discardButton` now takes
   * that id or label, and tapping it on the moto returned to the Shorts camera
   * with nothing kept. A dry run now leaves the same way instead of stopping on
   * the details screen, where YouTube kept every dry run as a draft.
   *
   * **0.31.0 — the production Samsung flow, from its exported runs.** Twenty
   * SM-A075F/SM-A065F runs of `post-video` (2026-09-13/14) and their ui trees.
   * The trim screen's "Selesai" is now `shorts_trim_finish_trim_button` on this
   * YouTube build (12 hours earlier it was `creation_next_button`): the wait
   * and the tap accept either id, or a clickable "Selesai" / "Tambahkan segmen
   * ke project" — 0.30.0 stopped there four runs out of four. The channel read
   * before posting was "unreadable" on every run, because "Lihat channel" is no
   * longer clickable itself: the row holding it is tapped, and a "Dapatkan
   * YouTube Premium" page opened instead is left with BACK and read again; a
   * baseline that still cannot be read is tried once more. After Upload
   * YouTube shows the channel itself with the new cell at "Mengirim file •
   * 1%": that screen is read first, the channel is re-opened through the Anda
   * tab rather than by force-stopping YouTube mid-upload, and a new cell
   * carrying the title that is still uploading or processing reports
   * `unverified` ("uploaded, still processing on YouTube") — or `posted` once
   * the run has seen it finish. The details screen's taps and the Upload band
   * are measured from YouTube's content frame instead of fractions of a
   * 1640-tall screen, which on 1600 put the band inside the farm keyboard's
   * strip; the farm keyboard (`dev.enkaku.guestagent`) counts as a keyboard,
   * and BACK is pressed only when a keyboard window is in the tree, never on
   * pixels alone. The details screen is checked for landscape before anything
   * is typed. A failure on the details screen backs out and taps a discard
   * button matched by exact label before YouTube is closed (not yet measured on
   * hardware), and `finish` leaves YouTube open while an upload is still
   * sending.
   *
   * **0.30.1 — a landscape YouTube gets one relaunch before
   * `E_SCREEN_LANDSCAPE`.** Most of the production Samsung fleet (SM-A075F,
   * SM-A065F) stopped at the home screen on 2026-09-14 with YouTube lying on
   * its side. `post-video` now relaunches once — the launch re-asserts the
   * farm's rotation lock, from the device's stored setting on a core of this
   * release — saves `yt-01-home-relaunched`, and fails by name only if the
   * screen is still landscape.
   *
   * **0.30.0 — `posted` means this title, and no "failed" once Upload was
   * pressed.** An audit of `post-video` against the Social Media Manager's
   * contract. `posted` now needs one more channel cell carrying the WHOLE title
   * (or a start of it the channel visibly cut with an ellipsis); a count that
   * went up with no such cell is `unverified` ("a video appeared but its title
   * was not confirmed"), because a title that lost keys uploads under YouTube's
   * default. Cells are compared by their title words, not their view counts,
   * and read on screen only; the bottom bar is the lowest "Beranda", not a
   * channel's own "Beranda" tab. After Upload, "the details frame is still
   * empty" is no longer read as "nothing was uploaded" — a loading screen looks
   * the same: the run throws `E_UPLOAD_TAP_NOT_TAKEN` (and taps a second time)
   * only while the screen is pixel-for-pixel the one before the tap
   * (`screen-pixels.ts`), and anything else is confirmed on the channel. Before
   * Upload the keyboard is PROVEN gone — the Upload button's pixels back to how
   * they were before the title was tapped — instead of waited out, which only
   * worked while a scrcpy session was attached: a tap on plain page first, BACK
   * only with evidence the keyboard is up, `E_KEYBOARD_OVER_UPLOAD` if neither
   * clears it. A hidden permission dialog needs two readings in a row (one
   * empty tree is a transition frame), and the unfinished-draft prompt is
   * answered in every wait up to the gallery cell.
   *
   * **0.29.0 — the Premium offer is closed, not waited behind.** A full-screen
   * "Coba paket keluarga YouTube Premium" sheet appeared over the app on the
   * owner's production farm (2026-09-14), and every step waiting for its own
   * anchor behind it failed naming that anchor. `popups.ts` recognises the offer
   * by name (a "YouTube Premium" mention, a "Coba…/Try…" action and a close
   * control) and closes it with its "Tutup" button — BACK if that is not
   * readable — on every poll of `waitForTree` and while `relaunch` settles. It
   * only ever taps close labels, and a test proves none of them subscribes,
   * buys or starts a trial; no other dialog is touched.
   *
   * **0.28.0 — the new gallery, and no "failed" after Upload.** Three runs on
   * the owner's production SM-A075F fleet (2026-09-14) failed "the gallery did
   * not open" with the gallery on screen: YouTube's newer "Galeri" bottom sheet
   * has no `gallery_header_create_title`. `galleryOpen` recognises both
   * pickers. And once Upload has been tapped and YouTube left the details
   * screen, an error while confirming on the channel now reports "unverified"
   * instead of throwing — a failed attempt is re-sent by Retry, and re-sending a
   * Short that did upload is a duplicate on a real channel.
   *
   * **0.27.0 — permissions answered before YouTube opens.** On Android 14+ the
   * system permission dialog is hidden from the farm's reader; the owner's
   * production SM-A075F fleet (2026-09-14) stopped on "YouTube is asking for
   * access to photos and videos" on phones nobody had answered. `relaunch` now
   * grants media and notifications and REFUSES the camera (fixed) through the
   * farm's `app.grantPermissions`/`app.denyPermissions` before launching — the
   * camera refused because this flow was walked that way and a phone that grants
   * it shows a different Create screen. The landscape refusal also now points at
   * the device's rotation setting: the farm re-locks rotation and pins the
   * display on every app launch, so a landscape YouTube means the lock is off.
   * Needs a core with those capabilities; an older core warns and runs as before.
   *
   * **0.26.1 — no BACK before Upload.** The keyboard closes itself with the
   * focus, so the BACK meant to close it navigated off the details screen and
   * lost a title that had just been typed correctly (2026-09-14). It waits
   * instead, and gives Upload a second tap if the first does not take.
   *
   * **0.26.0 — type the title inside the two seconds it stays focused.** Why
   * every earlier attempt typed into an unfocused field: the title field
   * loses focus about two seconds after the tap, and only while the farm's
   * own scrcpy session is attached — with that session killed, focus holds
   * indefinitely. The farm is interrupting the app it is driving. Until the
   * session layer stops doing that, the member types immediately after the
   * tap (400ms) instead of settling for six seconds first.
   *
   * **0.25.0 — stop claiming to prove focus; prove the consequence.** The
   * keyboard's window never reaches the reader on the details screen (Android
   * withholds the whole window set there), so 0.24's keyboard check failed
   * every run even while the keyboard was up. The member now taps, waits for
   * the field to settle, types in one call, and checks where it ended up: the
   * thumbnail editor means the tap missed and nothing was uploaded, said in
   * those words. Whether the title landed is settled by the channel page, as
   * before.
   *
   * **0.24.1 — give the keyboard time to appear.** 0.24.0 waited 4s for it and
   * tapped again; the phone's own keyboard took about 8s on a cold start, and
   * the second tap removed the focus the first had won. 15s now.
   *
   * **0.24.0 — post-video proves focus by the keyboard, not by pixels.** The
   * old check ("the screen changed after the tap") was satisfied by the
   * thumbnail rendering, so a run typed into a field that never had focus.
   * The details screen is invisible to the reader but the KEYBOARD is an
   * ordinary window in the same dump, so the member now taps until a keyboard
   * appears (three tries), and waits for it to go away after BACK before
   * aiming at Upload.
   *
   * **0.23.0 — post-video: one bulk title, and close the keyboard first.**
   * Two findings from the 2026-09-13 runs. Typing the title character by
   * character let YouTube's tag completion swallow everything before the
   * hashtag (the field ended up holding "#test " alone), so it goes in one
   * `input text` call. And the phone's own keyboard covers the whole button
   * bar, so the Upload tap hit the keyboard — BACK closes it first, and the
   * run stops if that leaves the details screen. The member also now states
   * that a phone posting to YouTube must keep its own keyboard
   * (`prep.textInput: 'device'`): with the farm's IME as default, the title
   * field never takes focus at all.
   *
   * **0.22.0 — post-video types the title through adb.** YouTube's details
   * screen ignores the farm's own input: a scrcpy-UHID tap never focuses its
   * title field and the guest agent's keyboard commits nothing into it, while
   * `input tap`/`input text` do both (measured on the owner's moto). The
   * title tap, the title and the Upload tap now go `via: 'adb'` — the new
   * per-call SDK option — and only there. The title is printable ASCII (what
   * `input text` carries); other characters are left out and logged.
   * **Needs a core with `via: 'adb'`** — an older core ignores the option and
   * the run stops at the focus check with nothing posted.
   *
   * **0.21.2 — post-video proves the title field has focus before typing.**
   * A tap that missed the field let the typed keys reach the focused
   * thumbnail, and a space in the title opened the thumbnail editor. Focusing
   * the field visibly changes the screen, so the member now requires that
   * change (one retry) before typing, and stops with nothing posted otherwise.
   *
   * **0.21.1 — post-video waits for the details screen to finish loading.**
   * It opens as a header over a spinner, invisible to the reader either way;
   * the third routed run aimed its title tap during the spinner, opened the
   * thumbnail editor, and (rightly) reported `unverified` for an upload that
   * never happened. The member now waits for two identical screenshots before
   * any blind tap, re-checks it is still on the details screen before Upload,
   * and names the thumbnail editor as `E_DETAILS_LAYOUT` — nothing uploaded.
   *
   * **0.21.0 — post-video: an unfinished Shorts edit.** After a run fails
   * inside the editor, YouTube keeps that edit and asks "Lanjutkan video draf
   * Anda?" on the next Create. The new `unfinishedDraft` setting answers it:
   * `start-over` (default — YouTube discards the leftover, which on a farm
   * phone is an aborted run's, and continuing it would post the wrong video)
   * or `stop` (`E_UNFINISHED_DRAFT`, leaving it for a person).
   *
   * **0.20.2 — post-video: the trim screen is optional.** The first routed
   * run went from the gallery straight to the Shorts editor, where the hand
   * walk had met a trim screen first; the member now accepts either. A
   * signed-out older English build (bar: Home, Shorts, Subscriptions,
   * Library) is probed through its Library tab too.
   *
   * **0.20.1 — post-video refuses a landscape screen.** Its details-screen
   * taps are measured in portrait; the owner's moto, lying on its side,
   * re-enabled auto-rotate on every YouTube launch over the farm's lock. The
   * run now stops with `E_SCREEN_LANDSCAPE` before touching anything.
   *
   * **0.20.0 — post-video: upload a Short.** The member the Social Media
   * Manager routes YouTube posts to, walked by hand on the owner's moto g06
   * (2026-09-11) with every screen checked into `__fixtures__/`. The gallery
   * names each cell by file name, so the video tapped is provably the one
   * pushed. Two kinds of screen are hidden from the farm's reader by Android's
   * "accessibility data sensitive" flag — the runtime-permission dialogs and
   * YouTube's own details screen — and the member does not pretend to be an
   * assistive tool to get past that: a permission dialog stops the run with
   * `E_PERMISSION_DIALOG_HIDDEN` and the answer to give once on the phone, and
   * the details screen is driven by taps measured on hardware, with the
   * outcome then proven on the channel page (before and after), never assumed.
   *
   * **0.19.0 — added watch-video script.** New script that searches for videos
   * and watches them with human-like behavior patterns, including varied watch
   * times, random interactions, and natural scrolling patterns.
   *
   * **0.13.0 — icons, plugin and member (plan 310 §3.3).** The pack declares
   * `icon: 'play'`; each of the five members now carries the SAME icon it
   * already reports on its `node` descriptor, moved up to a top-level field
   * (`node.icon` stays as a fallback read for a core older than this plan).
   * Cosmetic; nothing about how any member runs changed.
   *
   * **0.12.0 — every member is now a workflow flow-editor node (plan 303
   * §4.5).** Each of the five scripts gains a `node` descriptor (category,
   * icon, up to 3 summary params, keywords) so the flow editor's palette can
   * present it — presentation only; nothing about how any member EXECUTES
   * changes (plan 300 D6, D7).
   *
   * **0.11.0 — a Shorts SHELF is not the Shorts TAB.** Job 24ca474e failed on a
   * home feed that happened to carry a Shorts row: the walk matched the shelf
   * header (DFS reaches feed content before the bottom nav) and tapping it did
   * nothing. `shortsTabOf` is now bounded to the nav band — the bottom 15% of
   * the screen, measured — which is the same lesson 0.1.4 recorded for the
   * results page, learned again from the other direction.
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
