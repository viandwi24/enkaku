# 910 — Video recap: how every posted video is actually doing

> Status: implemented (smm 0.60.0, tiktok 1.54.0, instagram 0.14.0, youtube 0.49.0)
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

## 5. What this does NOT do

- It cannot tell a TikTok account with no posts AND no drafts from a grid that
  has not drawn yet, so it refuses rather than reporting an empty account. TikTok
  draws an empty-state for that case; it has not been measured, so the pack does
  not claim to recognise it.
- It reads view counts only. Likes, comments and shares are on the same screens
  for some platforms and not for others, and a column that is populated for one
  platform and blank for two is worse than no column.
