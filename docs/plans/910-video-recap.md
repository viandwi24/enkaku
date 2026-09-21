# 910 — Video recap: how every posted video is actually doing

> Status: implemented (smm 0.61.0, tiktok 1.54.0, instagram 0.14.0, youtube 0.49.0), verified against real posts on 2026-09-21
> Ships: plugins/social-media-manager/src/recap.ts

**Series:** 900 (warm-up in SMM) — the first thing added to the Social Media
Manager after 900 froze the workflow feature's scope. It needed no expression
engine, no fan-out and no new composition surface, which is the test 900 §D2
set for anything arriving after it.

## 1. What was asked

One message, on 2026-09-21, and it contains the whole design problem:

> *"saya minta fitur baru dong di smm yaitu rekap video bisa ngga? jadi goalsnya
> simpel yaitu nge rekap video dari 3 platform viewsnya berapa. nah masalahnya
> mungkin emang kan bisa aja ada akun yang sudah banyak 80 video misalnya ga
> mungkin dong melakukan scroll kebawah dan rekap satu per satu, nah menurut mu
> gimana enaknya? tadi saya berfikir sih dikasih max aja misal 6 aja. nah terus
> gimana kalau misalnya 6 video max sudah, terus nextnya 6 lagi berarti ada
> sistem smart merge jadi biar datanya itu tetap sync"*

Plus: a new tab on the SMM page, and the moto g06 power to measure on.

## 2. What the phones actually give (measured 2026-09-21)

Owner's moto g06 power, 720x1640. Every anchor below is from a dump taken that
day, and all six are checked into the packs' `__fixtures__/`.

| Platform | Where | A cell carries |
|---|---|---|
| TikTok | Profil tab, grid | `tv_play_count` — a number. **Nothing else.** No caption, no id, no date. The first tile is `tv_draft` ("Draf: 11") and is not a post. |
| Instagram | Profile → **Reels** tab | `preview_clip_play_count` — a number, and a description `Reel by <user>. View Count 140.` The **Grid-view** tab carries no number at all, only `at row 1, column 1`. |
| YouTube | You → View channel → Shorts | one description: `<title>, 246 thousand views - play Short`. The Videos tab adds a duration and an age. |

So **only YouTube gives identity.** That single fact decides the whole design.

Two traps found while measuring, both now pinned by tests:

- A Shorts title carries its own numbers — `2026 Solar Eclipse @ 50,000 Feet` —
  so reading "the first number in the description" answers 2026. The count is
  found backwards from the word it belongs to (`countBefore`, SDK).
- `1.655` is one thousand six hundred and fifty-five on an Indonesian TikTok and
  one point six five five on an English YouTube. Getting that wrong is a
  factor-of-a-thousand error in the number the feature exists to report.

## 3. Decisions

### D1 — Nothing is ever opened

Playing a post adds a view to the number being recapped. Six videos on
seventy-three phones every day is over a thousand fake views a day, on the
accounts this farm is trying to measure. So a reader reads the grid and taps
nothing inside it — which is also why identity cannot simply be looked up.

### D2 — A window, not the account

`maxVideos` (6 by default, the owner's own proposal) is the newest few. A video
pushed out of the window keeps its last known count with a "last seen" stamp
rather than being forgotten: forgetting it would make the account's total drop
every time something new was posted, which is the one number an operator would
notice and disbelieve.

### D3 — The merge keys on identity where there is one, and on a SHIFT where there is not

A profile grid is append-at-front: a new post pushes every older one down by
one, and nothing reorders. So yesterday's list is today's list with `s` new
items in front — one unknown, a small integer. Two facts pin it down:

1. **A view count does not go down** (within a tolerance, because a rounded
   count moves in steps of a hundred and platforms do revise counts down).
2. **Between two runs a video grows a little, not a lot.**

Both are needed, and each has a test that fails when the other is removed:

- Without (1): a new video with 50 views in front of one with 100 scores best as
  "nothing is new", rewriting that video from 100 down to 50 and dropping the
  oldest one off the end.
- Without (2), and scoring by the MEAN: one video going 10 → 100 overnight while
  its neighbours gain a view each makes "nothing is new" average 2.28 and "one
  new video" average 0.67, so the wrong one wins — inventing a post nobody made.
  **The cost is therefore a median, not a mean.** On a warm-up farm, one video
  in six outgrowing its neighbours by an order of magnitude is the normal case.

### D4 — Where the numbers cannot decide, the length does; where nothing can, it says so

A window that reads all zeros satisfies every shift at zero cost. When neither
reading filled its window, the LENGTH settles it — seven videos where there were
six is one new video whatever the counts say. When even that is unavailable, the
merge records that it guessed. When no shift survives at all (an account signed
out and another signed in, a misread grid), every incoming video is recorded as
new and the stored ones keep their last known counts: nothing is lost and nothing
is silently attached to the wrong video. `Forget` is the operator's escape hatch.

### D5 — The pages of one reading are stitched by their overlap, never counted

Scrolling a grid whose cells have no identity cannot be done by counting swipes:
the grid snaps and a fling goes further than a drag. Consecutive dumps overlap,
and `mergePages` (SDK) joins them on that overlap — or reports `truncated` when
two pages cannot be shown to meet, rather than appending a guess with a hole in
it. The LARGEST overlap wins, so a row of brand-new videos all at zero is not
read as the whole page having moved past.

### D6 — A member queues; the router reads

`smm/recap-videos` marks rows as wanted and returns. `runRecapPass` sends the
reads, and it runs **after** the post pass and **after** the warm-up pass, with
both their claims: a recap is the least urgent thing a phone can be doing and
must never take one from an upload. It is a member rather than a button because
a schedule can only run a script, and a daily recap is the whole point.

### D6a — The fleet is paced by a CAP on reads in flight, not by a delay

The first version sent a read to every online phone in one router tick. The
owner watched it on production: *"sya di prod 73 devices itu langsung jalan
semua serentak"* — seventy-three apps, seventy-three inspector sessions and
seventy-three jobs at one instant, for the least urgent work this plugin does.

`planRecapTick` (pure, tested, split out for the reason `warmup-tick.ts` was)
now holds at most `concurrency` reads in flight across the whole farm, eight by
default, set on the member and stored in one `settings:recap` row the router
reads each tick.

A cap rather than a sleep between batches. A delay has to guess how long a read
takes — too short and the next batch lands on top of the last, too long and the
farm idles between them, and the right guess differs per platform and per
phone. A cap needs no guess: a slot frees the moment a phone answers and the
next tick fills it. Two properties the tests pin: a slot freed by a read
SETTLED this tick is filled in the same tick, and a full farm still expires
reads whose phone never came back — a spent send budget must never stop the
pass noticing them.

### D6b — "Only the phones that are connected" is a flag, not a mode

73 phones registered, 20 connected, and the owner wanted to warm up those
twenty: *"saya mau warm up cuman 20 ini doang"* (2026-09-21). Until then the
target resolver did not know a phone's status at all — `TargetableDevice` had
no `status` field — so a session aimed at every phone wrote a row for all 73,
and the 53 that were offline waited. Correctly: a warm-up has no deadline to
miss, so `planWarmupTick` skips an offline phone rather than failing it. But
the session then never finishes, and nothing on the page tells a phone that
will be back tonight from one that is gone for good.

`onlineOnly` sits beside the exceptions rather than becoming a fifth `mode`,
for two reasons. "Which phones" and "only the connected ones" are different
questions, and an operator asks both — the connected phones OF a label is a
sentence a mode could not say. And it is resolved at each RUN, never frozen
into a list of ids, because a session is a definition that gets started again:
started tonight it must mean tonight's twenty.

Applied LAST, after every other exception, so a phone that was never in the
running says that rather than "was not connected" — two different mistakes, and
the row has to say which. The same flag is on the recap, where it stops a fleet
of mostly-absent phones filling the table with rows that say "waiting".

### D7 — Two dev-only frictions worth writing down

Running from source embeds no packs, so `seedEmbeddedPacks` is a no-op and a new
pack reaches a dev farm only through `POST /api/plugins`. And a staged version
must match the version inside the bundle, so republishing the same version
number in dev needs the source bumped too — which is what every `+yN`/`+bN`
version on the owner's dev farm is.

## 4. Verified on hardware

All three readers were run on the moto g06 power on 2026-09-21, against the live
accounts, after the fixtures were captured:

- `tiktok/my-videos` — `@dewi_purnama280`, 11 posts read across stitched pages,
  `1.655` → 1655, `140,1 rb` → 140 100, `12,3 rb` → 12 300, drafts tile excluded.
- `instagram/my-videos` — `bitorex.bkk`, the one reel at 140, stopping honestly
  at the end of the grid.
- `youtube/my-videos` — `Hendi sunadi`, a Shorts tab holding only drafts,
  reported as "nothing has been posted from this channel" rather than as a
  failure or as an empty account that would push every video out of the window.

## 4a. What a real post taught it, the same day

The feature was verified a second time by actually POSTING — one video to all
three platforms from the SMM Posts tab, then recapping — and that hour found
three things the fixtures could not.

**1. A fresh YouTube Short has no number at all.** It reads
`Tes upload otomatis 21 September, No views - play Short`. `countBefore` finds
the label, finds no digits before it, and the row was dropped — so the video an
operator most wants to see, the one just posted, was the only video the recap
could not report, and the channel read as "nothing has been posted". That is
worse than a wrong number: it is a confident statement of the opposite of the
truth. `NO_VIEWS` now reads the word as a zero.

**2. A cell and the label inside it are not two videos.** Fixing (1) made the
overlay `No views` — a child node of the same cell — pass the same test and
appear as a second, phantom video titled "No views". Rows are now deduplicated
by CONTAINMENT rather than by equal text, which is the rule that was always
correct: walking depth-first, anything lying inside an accepted row is that row
seen again.

**3. A fixture from `uiautomator` is not the tree the member reads.** The first
test written for (1) passed immediately, which was the clue: the phantom node
exists only in the guest agent's `ui-tree`, not in a `uiautomator dump`. The
fixture was replaced with the member's own saved artifact, and only then did
the test fail without the fix. **A reading test is worth exactly as much as the
provenance of its fixture.**

Plus one timing defect with no fixture at all: a recap read dispatched straight
after a `post-video` job caught YouTube still coming up, and the member — alone
among its steps — read the bottom navigation from a single dump instead of
waiting for it. A relaunch is the one moment an app is guaranteed not to be
drawn yet.

The end-to-end result, on the owner's moto with three live accounts: TikTok 6
videos to 7, Instagram 1 to 2, YouTube 0 to 1. Every previously known video kept
its key and shifted down by exactly one; TikTok's sixth left the six-video
window and kept its last count in the `Older` column, where 0 + 420 + 73 + 8 +
11 + 71 + 1,655 still adds to the 2,238 the row reports.

## 4b. The window is not a fence — and the merge has to know it

The owner asked the obvious follow-up (2026-09-21): six videos read, then seven
known — what about the other five on the account? Raising **Videos per account**
reads them. That exposed a fault the fixtures could not, because it only appears
when a window WIDENS.

A video that has fallen out of the window comes back into the reading, at the
END of it. The merge aligned against the videos in the window and nothing else,
so the returning video matched nothing and was minted as new: a twelve-video
account reported as **thirteen videos and 277,101 views where the truth was
twelve and 275,446**. Double-counting views is the one error that makes this
whole feature untrustworthy, since the total is the number an operator reads
first.

Two changes, both about the same thing — the merge must know the WHOLE account,
not the part currently on screen:

- **`lastRank`.** A video keeps the position it last held after `rank` goes
  null, so everything known can be laid out as one ordered sequence: the window
  by rank, then what has fallen out, by the position it last had. A wider window
  simply reads further down that list, and the returning video is the next
  entry — matched, not minted.
- **`complete`.** The length rule ("seven where there were six is one new
  video") is only sound when what is stored is everything there is. After a
  reading that FILLED its window, a longer reading later may be longer at the
  back — videos finally reached — not at the front. Each row now records
  whether its reading covered the whole account, and the floor is used only
  when it did. Without that gate, widening the window would have forced a shift
  and renamed every video on the account.

Verified on the moto: the same account, read at six and then at twelve, gives
twelve videos and 275,446 views with no repeated count — the same total a
manual fourteen-video read gives.

## 5. What this does NOT do

- It cannot tell a TikTok account with no posts AND no drafts from a grid that
  has not drawn yet, so it refuses rather than reporting an empty account. TikTok
  draws an empty-state for that case; it has not been measured, so the pack does
  not claim to recognise it.
- It cannot PROVE two readings are the same video, on TikTok or Instagram: the
  grid carries no id, so there is nothing to compare. What it can do is refuse
  to guess — see D3 and D4 — and say so in the row when the evidence runs out.
- It reads view counts only. Likes, comments and shares are on the same screens
  for some platforms and not for others, and a column that is populated for one
  platform and blank for two is worse than no column.
