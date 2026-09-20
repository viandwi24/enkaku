# 909 — Warm-up as a product: start, stop, target, report

> Status: implemented (smm 0.57.0)
> Ships: plugins/social-media-manager/src/warmup-report.ts

**Series:** 900 (warm-up in SMM)

Plans 901–908 built a warm-up ENGINE and put a screen on it. This one is what
the owner asked for after using that screen on a real fleet, in one sitting on
2026-09-20. Every item below is a quote, and the order is theirs.

## 1. What was asked

1. *"halaman detail warmup sesi bisa di gruping lagi ngga dengan bagus biar enak
   per 1 devices 1 field"* — one row per phone, not one per phone-per-phase.
2. *"bisa aja suatu hari inginnya devices tertentu aja, atau inginya semau
   device kecuali beberapa device, atau kecuali beberapa labels/grup"* — four
   ways to say which phones, with exceptions.
3. *"report, tombols logs, ke jobs atau dashboard kaya success rates, waktu,
   elapsed, estimated"*.
4. *"ada sistem stop / start ... memaksa yang lagi running di cancel, dan
   waiting di masukan ke antrian terus ... tapi bisa di start lagi juga"*.
5. *"ga perlu ada slot sesi lagi, biarkan sistem smm yang mengaturnya"*.
6. *"kenapa pas bikin warmup kok ga kaya halaman lain device selectornya ... ini
   cuman input textbox doang kurang menurut saya"*.
7. *"setiap 1 device yah harus urut ada youtube, tiktok dan instagram semuanya
   ke warmup"*, with *"1 device itu melakukan 4 aktifitas"*, and
   *"user maunya tinggal start, dan semua sudah diahandle"*.
8. *"keywords itu dipakai sebagai sarana personality atau interests nya ...
   maka menaikan likes dan open comment section"*.

## 2. Decisions

### D1 — The rows stay per phase; the SCREEN reads per phone

The dispatcher needs a row per phase: a phase is a separate pass with its own
platform and schedule. A person needs a phone. `warmup-report.ts` is the second
reading of the same rows and is generic over a minimal shape, so the service's
schema and the browser's mirror share one implementation and one set of tests.

Its `covered` field exists because of a follow-up: *"kenapa kok ada tanda '—' di
platform field tabel"*. A session covering three platforms writes three rows per
phone, and a phone carrying two has a third deliberately left empty (D4). That
row is bookkeeping, not an outcome, and drawing it made the table ask a question
whose answer is "nothing is wrong".

### D2 — Success rate is `null`, not `0`, until something answers

A session two minutes old with nothing settled has not got a 0% success rate. It
has no success rate. The screen renders `—`. Skipped activities are not counted
against it either: nobody asked for them.

The same honesty bounds "estimated". The rows know when an activity is DUE; they
do not know how long a script takes on a phone. So the stat is **Last due**, and
is never worded as a finish time.

### D3a — Stop runs in the BROWSER, and needs no phone (0.57.1)

It shipped as a member, which meant halting a session needed a phone online.
The owner asked the obvious question — *"masa mau stop atau start harus
jalanin jobs terpisah dulu, ini buat apa?"* — and there is no good answer: a
member runs on a device, and the moment you most want to stop everything is
the moment you can least count on a device.

Both doors were already open to the operator: this plugin's own KV
(`PUT /api/plugins/smm/data/entry`, which Remove has always used) and the
farm's `POST /api/jobs/:id/cancel`. So Stop is `ui/shared.ts`'s
`setSessionStopped`, `smm/stop-session` is gone, and `job.cancel` left the
permissions with it — the plugin is never granted the power to cancel work.

`add-warmup` stays a member, and the contrast is the rule: **a member is for
work a SCHEDULE has to be able to run.** A nightly warm-up is one. Stopping is
never scheduled.

`session-control.ts` is therefore generic over the little it needs of a row,
like `warmup-report.ts`, so the service's schema and the browser mirror share
one implementation.

### D3 — Stop is three promises, and Start is a fourth

1. Nothing new goes out — `group.stopped`, read by the router each tick.
2. What is out now is cancelled on the farm — hence `job.cancel` in the
   permissions. The plugin could already create work on an operator's phones;
   being unable to take it back was the asymmetry that made a runaway session
   something you had to wait out.
3. That work goes back in the queue, so the session still owes it. A post
   attempt is RETIRED to `history`, never deleted: "did this phone already open
   the app?" is the first question after a stop.
4. Start re-bases a warm-up's remaining schedule onto now, shifting every
   waiting step by the same amount, so the gaps survive a long stop. Firing four
   activities back to back on one phone is the exact shape a platform looks for.

The flag is written BEFORE anything is cancelled. A half-done stop must leave a
session that sends nothing, never one that cancelled and carried on.

**Stop is not Remove.** Removing a session stopped it by deleting every row
saying what the phones had done. That is why this exists.

### D3b — The session list counts phones, not rows (0.57.1)

*"kok ada yang waiting ... jangan sampai ghost state"*. The list reported a
fourteen-phone farm as "42 phones": a three-phase session stores three rows per
phone and the summary counted rows. The states were real; the NOUN was wrong,
which is worse — a number nobody can check against the shelf makes every number
beside it suspect.

`warmupProgress` now rolls a phone's phases up first, with the ladder in
`rollUpPhases`, which `warmup-report.ts` delegates to so the list and the
detail page cannot drift.

### D4 — A phone covers each platform once, and a phase past that gives it nothing

`phases` defaults to 3. `phaseCount` bounds a session by the platforms it
covers; `planWarmup` now bounds each PHONE by the platforms it carries. Without
the second bound a phone with two of three labels is sent to one of them twice —
invisibly: three green phases, one account never touched and another warmed up
twice within the hour.

### D5 — The activity count is the operator's; the style decides what

A style is a shape and happens to be three or four steps long. The operator
thinks in activities. `pickActivities` takes the front of the shuffled style and
tops up from the platform's OTHER styles, never repeating an id — repeating one
activity inside a sequence is the one shape that reads as a script.

### D6 — The rotation slot is the plugin's job

`slotFor` counts the warm-ups this farm ran in the last 20 hours. A rolling
window rather than a calendar day, because a day needs a timezone and a UTC
boundary falls at 07:00 in the owner's. A knob whose right value is "however
many you already ran" is a knob asking the operator to keep count for the
computer.

### D7 — The target is stored as INTENT, and resolved every time

`warmup-target.ts` stores the mode and the names, not the ids they resolve to,
so a schedule reaches the phones carrying the label TODAY. Its `NO_GROUP`
literal is kept in step with Studio's picker for the same reason.

An exception always beats the include that named the same phone: "everything in
this group except that one" is the commonest thing an operator wants and is
only expressible that way. Every left-out phone comes back with the rule that
removed it, because the question a warm-up screen gets asked is never "how many
phones" but "why isn't THAT phone in it".

The UI does not invent a picker for this — `DevicePicker` already existed, in
four identical words, on New session, Cleanup and Accounts sync. It takes a
`consequence` override because its own lines are about POSTING, where an
explicit list of phones stops the platform label being checked. A warm-up always
checks it.

### D8 — The keywords are interests, and had been doing half their job

Every scrolling member already reads the caption, author and hashtags of what is
on screen and multiplies BOTH its like and its comment chance by
`keywordBoostFactor` on a match — exactly what §1.8 describes. Eight of the nine
styles were sending only `likeProbability`.

Nothing could see it. An undeclared param is refused loudly at dispatch; a
param the script declares and nobody sends is silent, and the feature simply
does half of what it promises. `scripts/check-warmup-params.ts` is the gate, and
it caught a second instance the moment it existed (`watch-stories` accepts a
like chance and no keyword boost).

## 3. What landed

| # | thing | where |
|---|---|---|
| 1 | One row per phone, with the phases inside it | `warmup-report.ts`, `ui/parts/warmup.tsx` |
| 2 | Success rate, elapsed, last due, per-activity `logs` links | same |
| 3 | Stop / Start on BOTH session kinds | `stop-session.ts`, `session-control.ts`, `groups.ts`'s `stopped` |
| 4 | The shared device picker, with exceptions | `warmup-target.ts`, `ui/parts/device-picker.tsx` |
| 5 | Activities per phone; every platform once | `warmup.ts`'s `pickActivities` and the phase bound |
| 6 | Automatic rotation slot | `groups.ts`'s `slotFor` |
| 7 | Comment chance sent wherever it is accepted | `warmup-catalog.ts`, `scripts/check-warmup-params.ts` |
| 8 | A simple form; the rest behind Advanced | `ui/parts/warmup.tsx` |

## 4. Verified

On the owner's moto g06 power, against a freshly restarted core with
smm 0.57.0 seeded from a real `.enkaku` package (2026-09-20):

- a session over 14 phones planned 16 activities across 2 able phones, 12 given
  nothing, each with its reason;
- 34 jobs succeeded and 5 failed on the phone;
- Stop cancelled the running job, wrote `stopped: true`, and the row offered
  Start again; Start again cleared it;
- the stored session carried `slot: 2` (derived), `phases: 3`,
  `activitiesPerPhone: 4` and `like.commentChance: 0.05`.

### D9 — "Watch a long video" had to mean a length, not a video (youtube 0.48.0)

`youtube/watch-video` opened one video, watched it for whatever the dwell
model drew, and stopped. `WATCH_BUCKETS` is a SCROLLING model — half its mass
is 4 to 10 seconds and 0.15 of it is under four — so a warm-up asking a phone
to watch a long video got four seconds one time in seven, and nothing said so.

`minWatchMs` is now the ask. Two properties of how it is met are the point:

- **a short video is never stretched.** Another one is opened, with a fresh
  query drawn from `queries` and a row this run has not seen. The owner asked
  for exactly that: *"kalau satu video tidak kuat sampai minimum misalnya yah
  cari video lagi ... biar ga dikira bot nonton video yang sama terus
  terusan"*.
- **a minimum changes the BEHAVIOUR, not only the exit condition.** With one
  set, the per-video dwell comes from a long-video range instead of the Shorts
  table. Approaching 90 s nine seconds at a time is ten searches to do what
  was asked for once, which is its own tell.

#### What the phone taught us, which no reading would have

Three failures on the owner's moto g06 power, each one diagnosed from the
captured tree rather than guessed:

1. **The phone left YouTube entirely** for an advertiser's ebook sign-up form.
   A later round had tapped a promoted result.
2. **Skipping rows labelled `Sponsored` did not fix it.** On a half-loaded
   results page `resultRowsOf` returns the ad card's own SUB-nodes as rows —
   one search produced three "rows": the ad's `More options` button, the
   advertiser's name, and one real video. The `Sponsored` label is a sibling of
   those, so no filter that walks the row can see it.
3. So the question became **"is this a video"**, not "is this an advert". A
   real row carries a duration, a view count or an age somewhere inside it; a
   toolbar button and an advertiser's name carry none. Verified offline against
   both captured trees before it went near a phone again.

4. Then the row test itself was too loose in the other direction. A bare
   `views?` matched **"View Channel"**, so a run picked a channel card and
   opened the channel. Every pattern is anchored on a DIGIT now — a duration, a
   view count and an age all carry a number, and the words around it are
   localised while the number is not. A page of channel results reports zero
   playable rows, which is the honest answer, and the run searches for
   something else rather than failing: that is an answer about the QUERY, not
   about the run.
5. And the numbers this catalog asked for were wrong in a way reading them
   would not show. `scaled(base, spread)` is base PLUS a draw over spread, not
   a range, so `scaled(d, 240_000, 420_000)` meant up to eleven minutes of
   watching inside a member whose job timeout is fifteen — before the searches,
   ad waits and relaunches between videos are counted. Caught by asking the
   catalog what it SENDS rather than by reading the arithmetic, which is now
   the habit: `bun scripts/check-warmup-params.ts` proves the names, and a
   three-line script proves the values.

Plus the two guards that came out of it: a round that cannot open a video no
longer throws away the ones that did (`reachedMinimum` says so), and a phone
that ends up outside YouTube is brought back rather than failing the run.

## 5. Still open

- **Cadence** (*"sehari bisa sekali, atau sehari bisa 2 kali"*) is the farm's
  own schedules plus `dedupeMinutes`; the rotation now advances on its own, so
  two schedules a day is already correct. A warm-up-shaped shortcut for making
  those schedules is not built.
- Per-style weighting still has no UI (deferred by 904 §2).
