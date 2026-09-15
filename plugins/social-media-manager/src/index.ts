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
import updateGroup from './update-group'
import cleanPhoneVideos from './clean-phone-videos'
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

/** How many post rows one tick will consider. A farm with more than this has a backlog problem the router cannot fix by reading harder. */
const MAX_POSTS_PER_TICK = 200

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

  let listed: Awaited<ReturnType<typeof ctx.storage.global.list>>
  try {
    listed = await ctx.storage.global.list({ prefix: POST_PREFIX, limit: MAX_POSTS_PER_TICK })
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
  version: '0.35.0',
  icon: 'upload',
  title: 'Social Media Manager',
  description: 'Upload a folder of videos and send them across the phones labelled for each platform, paced so they do not all move at once. TikTok, YouTube and Instagram post today.',
  scripts: [addPost, retryFailed, addPosts, addGroup, startGroup, retryGroup, updatePost, resolveAttempt, updateGroup, cleanPhoneVideos],
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
    permissions: ['device.list', 'job.run', 'job.get'],
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
