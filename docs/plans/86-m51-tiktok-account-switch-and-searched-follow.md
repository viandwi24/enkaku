# Plan 86 — M51 : The TikTok pack learns to switch accounts and to follow a searched account

> Status: implemented — executed. All seven steps in §5 are done; `search.ts` and
> `search-follow.ts` are implemented, unit-tested, and hardware-verified
> (pack version 1.3.2 — steps 4–6 shipped two corrections found on hardware
> after the initial 1.3.0 publish, §0.10a and §0.10b). §7.3's probe closed §0.7.
> Owner decisions recorded in §9 are already answered unless marked OPEN.
>
> *(Header reformatted 2026-08-11 into the `> Status:` / `> Ships:` blockquote
> convention `scripts/check-plan-status.sh` reads. The wording above is
> unchanged — only the prefix was missing, so the checker could not see this
> plan at all and reported it as undeclared. Nothing about what shipped was
> re-judged here; this plan's own hardware verification stands as written.)*
> Ships: plugins/tiktok-automation-pack/src/search-follow.ts

Scope is one package: `plugins/tiktok-automation-pack`. No `packages/*` code
changes. The pack goes from one script to three, plus a reusable search helper
that later scripts inherit.

---

## 0. Evidence

Everything below was measured on the farm device on 2026-08-09 — moto g06,
720×1640, Android 15 / API 35, TikTok `com.ss.android.ugc.trill` v46.3.3,
device UI language **Indonesian**. The device was driven through the running
core's capability API (`POST /api/v1/cap/device.*`). The full reconnaissance
map is reproduced in §4; this section records only the findings that changed
the design.

### 0.1 `find()` silently returns the wrong node on list screens

`matchSelector` (`packages/protocol/src/selector-match.ts:31`) is a depth-first
walk that returns the **first** match, and the active `ui-server` inspector
engine never reports `ambiguous`. So a selector matching several nodes does not
fail — it quietly resolves to whichever one the walk reaches first.

Reproduced against the live switch-account sheet, where three rows share
`id=l_z`:

```
curl … -d '{"sel":{"id":"l_z"}}'
→ {"ok":true,"node":{"resourceId":"…l_z","desc":"user2578127329501",
   "bounds":{"top":1164,…}}}          ← row 1, not an error
```

The same pattern holds for `id=ugl` (one per search-result row), `id=do8`
(every drawer row), and `id=sdn`/`id=sdo` (the three profile stat labels and
their numbers).

**Consequence:** on any list-shaped screen a script must call `dump()` once and
walk the tree itself. `find()` is reserved for text or content-descs that are
genuinely unique.

### 0.2 `desc:"Cari"` changed meaning mid-session

At the start of the reconnaissance `desc:"Cari"` resolved to the persistent
top-bar search icon at `[622,72-720,170]`. Later in the same session, after the
feed had autoplayed to a different video, the identical query resolved to a
completely different node:

```
curl … -d '{"sel":{"desc":"Cari"}}'
→ {"node":{"resourceId":"…enm","desc":"Cari","className":"ImageView",
   "bounds":{"left":21,"top":1424,"right":49,"bottom":1452},"clickable":false}}
```

A full dump of that moment showed why:

```
id=hxc CLICK [0,1406-720,1470]
  id=ukt [21,1406-529,1470]
    id=uks [21,1406-529,1470]
      id=enm desc="Cari" [21,1424-49,1452]        ← the impostor
      id=ukr text="Pencarian · gt trader fundamental" [56,1424-522,1452]
```

TikTok injects a per-video "search this content" chip into some captions, and
it carries the exact same content-desc as the real search icon. Combined with
§0.1 this is the worst class of automation bug: a selector that is correct
today and wrong tomorrow, with no error to notice.

`id:"jvu"` is the real icon and re-verified unique — but `jvu` is a
three-character generated id of the kind this app rotates between builds, so it
is not a durable answer either. **The durable answer is a bounds filter**: the
chip only ever appears low in the caption block, the icon only ever in the top
bar.

### 0.3 Text and desc matching is exact, not substring

`matches()` (`selector-match.ts:21-28`) compares `node.text.trim() ===
sel.text.trim()`. So `text:"Ikuti"` cannot accidentally match `"Mengikuti"`.
This was worth confirming because the follow button and the "accounts this
profile follows" stat label sit on the same screen; a substring matcher would
have made the follow-state check unsafe by construction. It does not.

### 0.4 Nothing in this app reports `scrollable: true`

No node in any dump — settings, the sheet, the results list, the profile grid —
carries the accessibility `scrollable` flag, yet `device.scroll` gestures work
everywhere. A readiness check gated on that flag would deadlock. Scrolling is
always a gesture here, never a queried capability.

### 0.5 The selected tab loses its `clickable` flag

On the search results tab strip, the currently selected tab reports
`clickable:false`; it regains `clickable:true` once another tab is selected.
A script that waits for a tab to become clickable in order to confirm the
switch happened would wait forever. Confirm by content instead.

### 0.6 "Keluar" sits 98 px below "Beralih akun", with no gap

```
desc="Beralih akun"  bounds [14,1255-706,1357]
desc="Keluar"        bounds [14,1357-706,1459]
```

The two rows are flush. A tap aimed by screen fraction rather than by the
node's own measured bounds risks logging the account out. This single fact
dictates that the switch-account script must tap from dumped bounds only.

### 0.7 The already-following button state was never observed

The reconnaissance scrolled roughly 30 result rows for the query `scalping` and
found no account the logged-in user already follows, so the follow button's
already-following text (presumed `"Mengikuti"`) was never seen. §7.3 closes
this with a deliberate follow → observe → unfollow probe rather than leaving it
an assumption.

**CLOSED (2026-08-09), job `3fcd9434-2561-42f4-97e1-064f035f3926`.** The
presumption was correct: the profile follow button's own text after a
successful follow reads `followButtonAfter: "Mengikuti"`, verbatim, matching
`ALREADY_FOLLOWING_LABEL` unchanged. No constant needed correcting. What DID
need correcting, found while exercising this exact button on hardware, is
where the button lives and how uniquely `id:"fds"` names it — see §0.10a and
§0.10b.

### 0.8 An inspector outage is indistinguishable from a missing element

Added after the first hardware run of `switch-account` (§7.2) failed. The
ui-server inspector goes briefly unresponsive under load:

```
http://127.0.0.1:27100/jsonrpc/0 did not respond within 20000ms:
Error: The socket connection was closed unexpectedly
```

`device-executor.ts`'s `waitFor` maps **every** inspector error to a plain
`not-found`, so from a script's point of view an outage and a genuinely absent
element look identical. This is the same flakiness class `dialogs.ts` already
documents (`uiautomator dump` returning `Killed`), and it is why no recovery
path may assume "the anchor is missing" means "a dialog is covering it".

### 0.9 BACK is a navigation action, not a recovery, outside `auto-scroll`

The first `switch-account` hardware failure ended with the device on the
Android launcher, and the obvious story — the dialog sweep's BACK fallback
walking backwards out of Settings → Profile → feed → launcher — turned out to
be **wrong**. It was refuted, not assumed: after shipping `allowBack: false`
the same failure reproduced with the log line `no ack or deny button was
readable — NOT pressing BACK`, zero BACK presses, and the device still ended on
the launcher. The app leaving the foreground has a cause outside this script.

The fix stands anyway, for a different and better reason: on `auto-scroll` the
feed is the app's root screen, so BACK clears a modal and stays put. On a
five-screen linear walk BACK undoes the step just taken. A recovery that can
navigate away from the screen it is trying to recover is not a recovery.

### 0.10a The profile follow button relocates once the human-shaping scroll runs, and §4.5 only documented its resting position

**Added after the first hardware run of `search-follow` (§7.3), job `bc6170ec-9caf-4a1c-8874-bb628bd35c3f`.** §4.5 records the follow button's bounds on a FRESHLY-OPENED profile only: `id:"fds"`, `top 371–441`. §4.6's own pseudocode scrolls the profile grid 1–3 times BEFORE tapping follow — and that scroll collapses the profile's header into a sticky top toolbar. In that state `id:"fds"` is not merely relocated, it is **absent from the tree entirely** (the whole expanded-header section, stats row included, is recycled out — confirmed with `ui.py dump` immediately after a `scroll down`), and a new, id-less button appears inside the sticky header instead:

```
id=p9i [0,70-720,161]                          ← the collapsed sticky header
  id=p_c
    id=p_i                                     ← back arrow
    id=p9y CLICK                                ← avatar, now clickable
    id=p_8
      CLICK [450,87-632,143]
        text="Ikuti" [464,87-618,143]           ← the follow button, NO resourceId at all
      desc="Bagikan" [632,80-706,150]           ← share
```

Scrolling back up made `id:"fds"` reappear at its original `[28,371-524,441]` — reproducible in both directions, not a one-off inspector outage (§0.8 does not apply: the miss was 100% repeatable). The first hardware run failed with `E_FOLLOW_BUTTON_NOT_FOUND` for exactly this reason. **The fix (shipped, not just noted): `findProfileFollowButton` now checks two disjoint bounds bands — `360–500` (the original, expanded-header case) and `60–200` (the collapsed sticky header) — neither of which can ever collide with the stats row (`top` 286–360), because the stats row is not in the tree at all when the collapsed band is the one worth reading.**

### 0.10b `id:"fds"` is shared by a "Pesan" (Message) button once already following, and "Pesan" is first in document order

**Found exploring the manual-unfollow path for §7.3 step 5** (2026-08-09), on the very account the probe had just followed. §4.5 treats `id:"fds"` as resolving uniquely to the follow button. On an ALREADY-FOLLOWING profile it does not — TikTok adds a "Pesan" (Message) button alongside it, and "Pesan" appears first in the accessibility tree:

```
id=fds text="Pesan"      [170,371-246,441]
id=fds text="Mengikuti"  [431,371-580,441]
```

A bare "first id match wins" lookup — the exact §0.1 failure mode this file exists to avoid everywhere else — would silently read "Pesan" here. It did not actually misfire during either hardware `search-follow` run in this plan (the immediate post-tap re-render kept the single-button layout; the two-button split was only observed on a FRESH profile navigation, which manual exploration is and an in-flight verify is not), but depending on that timing detail would be fragile. **The fix (shipped): the id lookup additionally requires the node's text to be a recognised follow-state label (`"Ikuti"`/`"Mengikuti"`), so "Pesan" is never a candidate regardless of document order or how many buttons share the id.**

### 0.10 An account with no display name breaks a bare-username check

`user2578127329501` has no display name set — the profile shows
`+ Tambah nama` — so the bare username appears **nowhere** in that screen's
tree. Only the `@`-prefixed handle node does:

```
id=sd0 text="dewi_purnama280"    [28,172-503,239]    ← display name (absent on some accounts)
id=s_y text="@dewi_purnama280"   [28,243-239,269]    ← the @handle (always present)
```

A verification searching the tree for the bare username therefore reports a
switch that plainly landed as `E_SWITCH_NOT_VERIFIED`. Reproduced on hardware.

---

## 1. Goals

1. A `switch-account` script that moves the device to another logged-in TikTok
   account, selected either by list position or by username, and **proves** it
   landed on the requested account before reporting success.
2. A reusable `search.ts` helper covering: open search, type a query the way a
   person types, submit, land on a chosen results tab, and scroll for more
   results. Later scripts inherit it rather than re-deriving it.
3. A `search-follow` script that finds one specific account through search and
   follows it, with human-shaped browsing before the action, and that does
   nothing when the account is already followed.
4. A shared `tree.ts` that makes dump-and-walk the normal way to address a list
   screen, so §0.1 stops being a trap every future script rediscovers.
5. Every new screen interaction carries the lesson of Plan 85's dialog work: a
   semantic progress assertion, and a loud failure rather than a silent
   success.

## 2. Non-goals

- No bulk following, no follow lists, no follow/unfollow loops. One run follows
  at most one account. Anything resembling mass engagement is out of scope for
  this plan and for this pack.
- No login, no logout, no account creation, no "Tambah akun". The pack operates
  only on accounts a human has already signed into on the device.
- No locale independence beyond the mitigations in §4.6. The pack is Indonesian
  UI-first, exactly as `DENY_SELECTORS` already is.
- No change to `auto-scroll`'s behaviour. It is moved-from, not modified.
- No changes to `packages/*`. Where the control surface is missing something
  (§9), the gap is recorded, not worked around inside the pack.

## 3. Context and design decisions

### 3.1 Module split

The pack is one 730-line file. Three scripts sharing dialog handling, gesture
timing, and tree walking need that split, but the split must not put the one
script that already works on hardware at risk.

```
src/
  index.ts            definePlugin + the three script definitions; auto-scroll's
                      body stays here, moved-from only where it is genuinely shared
  tree.ts             dump-and-walk primitives — the §0.1 answer
  dialogs.ts          ACK_SELECTORS, DENY_SELECTORS, clearBlockingDialog,
                      nextDialogAction (lifted verbatim from index.ts)
  human.ts            makeRng, between, pickWatchMs, sleep, pngSize (lifted verbatim)
  search.ts           the search helper
  switch-account.ts   script 2
  search-follow.ts    script 3
```

`enkaku publish` bundles from `src/index.ts` with the same builder `publish`
uses, so a multi-file pack ships as one bundle. Verified already: the pack's
`publish:farm` produced a 680.5 KB single bundle from the current single file,
and bundling is not file-count sensitive.

**The extraction is behaviour-preserving and must be proven so**: `human.ts`
and `dialogs.ts` move code without editing it, and the existing 18 tests must
stay green with only their import paths changed.

### 3.2 One string parameter, parsed — not a union

`switch-account` takes a single `target: string`, described as "list position
(2, 3, …) or username". `/^\d+$/` means position; anything else is a username.

The alternative — a `z.union([z.number(), z.string()])`, or two optional fields
with a `.refine()` — is rejected on evidence already recorded in this pack's own
history: `commentProbe` was an enum whose default the run form failed to apply,
so pressing Run with nothing touched submitted an empty string and the job died
on a validation error before doing anything. A single plain string field cannot
fail that way.

### 3.3 Position 1 is never selectable

The currently signed-in account is always the first row. That is what makes
position 1 meaningless as a switch target, and the script rejects it with an
explicit error rather than silently doing nothing — a no-op that reports
success is the exact failure mode Plan 85 was written to eliminate.

This also defuses the locale risk in §4.6: even if the checkmark marker cannot
be read, the script still knows position 1 is off-limits.

### 3.4 Exact handle matching only, and refuse on ambiguity

`search-follow` matches the target against the row's **handle** by exact,
case-insensitive comparison. If two rows match, the script stops and fails.

Following the wrong person is a visible, social, and not-quietly-reversible act
against a real account. Fuzzy matching buys convenience and pays for it with a
failure mode that cannot be undone by a retry. Display-name matching is
available only as an explicit, separate opt-in (§4.5) and never as a fallback
from a failed handle match.

### 3.5 Switching accounts leaves state behind, deliberately

A switched account persists after the job ends. `reset: policy=home` (the
pre-job reset, Plan 35) restores app foreground state, not identity — the next
job on that device runs as whatever account this script left behind.

This is inherent to what the script does, not a defect, but it makes the script
different in kind from `auto-scroll`, which leaves nothing. Two consequences:

- The result object reports the account the device was left on, so a scheduler
  or an operator reading job history can tell.
- `finish()` must not switch back. Switching back would make the script useless
  and would violate the stateless/idempotent rule for `finish()` (it may run
  again in a fresh process after a timeout kill).

### 3.6 Every wait asserts on an anchor

Plan 85's finding generalises: a screenshot diff is not a progress assertion,
and a missing element is a signal worth acting on. Each navigation step in this
plan names an **anchor** — a node that is unique to the destination screen —
and waits for it. A step that cannot find its anchor sweeps for a blocking
dialog (the Plan 85 ladder, now shared through `dialogs.ts`) and then fails
loudly with a screenshot artifact.

---

## 4. Technical design

### 4.1 `tree.ts`

```ts
/** One `dump()`, walked many times — a dump costs 334–584 ms, a find ~80 ms. */
export function flatten(root: UiNode): UiNode[]
/** Every node matching a predicate, in depth-first order — the `findAll` the SDK does not have. */
export function all(root: UiNode, pred: (n: UiNode) => boolean): UiNode[]
/** Nodes whose resourceId ends with `:id/<short>` — the repeated-row case of §0.1. */
export function rowsById(root: UiNode, shortId: string): UiNode[]
/** Depth-first text/desc lookup INSIDE one subtree — the scoping `find()` cannot express. */
export function textIn(node: UiNode, pred: (n: UiNode) => boolean): string | null
/** True when `inner` sits inside `outer`'s box — how a child is attributed to its row. */
export function within(outer: Bounds, inner: Bounds): boolean
/** Bounds centre; re-exported from @enkaku/protocol so callers need one import. */
export { centerOf } from '@enkaku/protocol'
```

`rowsById` plus `within` is the whole answer to §0.1: enumerate the row
containers, then attribute each child node to the row whose box contains it.

### 4.2 Selector map — flow A, switch account

| Step | Screen | Target | Selector | Verified | Bounds | Note |
|---|---|---|---|---|---|---|
| A1 | Home feed | Profil tab | `desc:"Profil"` | `ok`, unique | `[576,1470-720,1556]` | Bottom nav; stable label. |
| A2 | Profile | Hamburger | `desc:"Menu profil"` | tapped OK | `[632,80-706,150]` | No resource id at all on the node. |
| A3 | Drawer | Settings row | `desc:"Pengaturan dan privasi"` | tapped OK | `[133,805-695,890]` | `id=do8` is shared by **every** drawer row — desc is mandatory here. |
| A4 | Settings | scroll to bottom | — | — | — | 4 × `scroll down` from the top. No `scrollable` flag (§0.4). |
| A5 | Settings | "Beralih akun" | `desc:"Beralih akun"` | `ok`, unique | `[14,1255-706,1357]` | Tap the **dumped bounds centre** (≈ y 1306). §0.6. |
| A6 | Sheet | container | `desc:"Lembar bawah"` | `ok`, unique | `[0,1059-720,1556]` | Anchor proving the sheet opened. |
| A7 | Sheet | close | `desc:"Tutup"` | `ok`, unique | `[636,1066-706,1143]` | |

The sheet, dumped verbatim:

```
id=fsz desc="Lembar bawah" [0,1059-720,1556]
  id=p9w text="Beralih akun" desc="Beralih akun" [271,1085-450,1124]
  desc="Tutup" CLICK [636,1066-706,1143]
  id=l_z desc="user2578127329501" CLICK [0,1164-720,1290]
    id=mvp text="user2578127329501" [147,1210-416,1245]
    id=fef desc="Tanda centang" [650,1206-692,1248]     ← current account
  id=l_z desc="dewi_purnama280" CLICK [0,1290-720,1416]
    id=mvp text="dewi_purnama280" [147,1336-390,1371]
    id=ofu desc="9+" [642,1336-692,1369]                ← unread badge, not a position signal
  id=l_z desc="Tambah akun" CLICK [0,1416-720,1542]
```

Rows are exactly 126 px tall. Each row's `desc` equals its username, which is
unique, so rows are addressed by `desc` — never by the shared `id=l_z`.

### 4.3 `switch-account` algorithm

```
parse target            "2" | "3" | … → position (1-based)   else → username
reject position 1       E_TARGET_IS_CURRENT
navigate A1 → A5, asserting each anchor
wait for A6 (sheet open)
dump once
rows := rowsById(tree, 'l_z')
      → [{ desc, bounds }]  in visual order (dump order == visual order here)
drop the row whose desc is "Tambah akun"          -- never a target
current := the row containing a child with desc in CHECKMARK_LABELS
        → assert it is row 0; if no checkmark found, assume row 0 and warn
resolve target
  position p → rows[p-1]        (p ≥ 2, and p ≤ rows.length)
  username u → the single row whose desc equals u (case-insensitive)
                zero matches → E_NO_SUCH_ACCOUNT (list the usernames found)
                the current row → E_TARGET_IS_CURRENT
tap centerOf(row.bounds)
wait for the feed anchor (the sheet is gone and the app is back on the feed)
verify: open Profil; assert the "@<username>" handle node is present
        AND assert the sheet (desc:"Lembar bawah") is GONE
        -- the @-prefix matters: an account with no display name shows the bare
        -- username nowhere at all (§0.10). The sheet check matters because the
        -- sheet lists every username, so a still-open sheet would otherwise
        -- read as a landed switch.
        mismatch → fail with a screenshot artifact
return { from, to, position, accounts: [...], verified: true }
```

**In-sheet scrolling.** Two accounts plus "Tambah akun" fit without scrolling
(378 px of rows in a 497 px sheet). A longer list will not. When the requested
position exceeds the visible rows, the script gesture-scrolls **bounded to the
sheet's y range** and re-dumps, up to a small bounded number of times, then
fails if the target never appears. It never scrolls the screen behind the
sheet.

### 4.4 Selector map — flow B, search

| Step | Screen | Target | Selector | Verified | Bounds | Note |
|---|---|---|---|---|---|---|
| B1 | Home feed | Search icon | dump-and-walk: `desc == "Cari"` **and** `bounds.top < 200` | — | `[622,72-720,170]` | §0.2. Bare `desc:"Cari"` is unsafe; `id:"jvu"` is obfuscated. |
| B2 | Search | Query input | `tap({point})` at the bar centre | typed OK | `[87,84-635,147]` | `id:"hhu"` obfuscated; its `text` is a rotating placeholder, so text-matching it is unreliable. |
| B3 | Search | Submit | `id:"tv_search_textview"`, fallback `text:"Cari"` with `top < 200` | tapped OK | `[613,77-720,154]` | The one descriptive, non-obfuscated id in this app. ENTER was never needed. |
| B4 | Results | Tab | `desc:"Pengguna"` (also Teratas / Video / LIVE / Toko / Foto) | `ok`, unique | `[348,161-510,231]` | Do not wait for clickable (§0.5). |
| B5 | Results | List container | `id:"mzw"` (RecyclerView) | `ok`, unique | `[0,231-720,1556]` | Gesture-scroll only. |

The suggestion dropdown fills the area below the bar (`y ≥ 161`) and never
overlaps the submit button (`y 77-154`), so submitting by button is safe while
suggestions are open. The area below the bar also holds search-history rows
whose per-row X (`desc:"Tutup"`, `id:"lkj"`) **deletes history** — the helper
must never tap there.

### 4.5 Selector map — flow B, a Pengguna result row

```
id=mzw [0,231-720,1556]                            ← results list
  id=ugl CLICK [0,245-720,374]                     ← row, 129 px tall
    id=tv_username text="<display name>" [150,265-346,298]   ← NOT the handle
    id=zjo text="rajafxgold" [150,298-517,326]               ← the handle
    id=zro text="147,3 rb pengikut · 1,4 jt suka" [150,326-452,354]
    id=tcj text="Ikuti" CLICK [538,280-692,336]              ← follow button
```

Two traps recorded here. `id="tv_username"` holds the **display name**, not the
handle, despite the name. And `zro` is one locale-formatted string
(`rb` = ribu, `jt` = juta) with no separate follower-count node, so any script
wanting the number must parse it.

Profile screen, reached by tapping a row:

| Target | Selector | Verified | Bounds |
|---|---|---|---|
| Follow button | `text:"Ikuti"` (resolves to `id:"fds"`) | `ok`, unique, `clickable:false` | `[28,371-524,441]` |
| Stats labels | `id:"sdn"` × 3 → Mengikuti / Pengikut / Suka | repeats 3×, resolves to the first | — |
| Video grid | `id:"ubz"` | `ok`, unique | `[0,732-720,1556]` |
| Back | none in-app | — | — |

`clickable:false` on the follow button does not prevent a tap — `tap` aims at
the bounds centre and does not gate on the flag. But it does mean `clickable`
is useless as a sanity check on this screen.

**The `"Mengikuti"` disambiguation.** On a profile screen that string is also
the *stat label* for "accounts this profile follows". Follow-state must be read
from the button node found by position (the `text:"Ikuti"` / `id:"fds"` box at
`y ≈ 371-441`), never by matching the string anywhere on screen. On a results
row the same rule applies scoped to the row's box.

### 4.6 `search-follow` algorithm

```
searchFor(query, tab: 'Pengguna')
loop up to MAX_SCROLLS:
  dump once
  rows := rowsById(tree, 'ugl')
  for each row: handle  := text of the child at the row's second text line (id zjo)
                display := text of the child with id tv_username
                button  := the child within the row whose box is the right-hand button
  matches := rows where handle.toLowerCase() === target.toLowerCase()
             (or display name, only if matchDisplayName was explicitly asked for)
  if matches.length > 1  → E_AMBIGUOUS_TARGET, stop        (§3.4)
  if matches.length == 1 → break
  scrollResults(); continue
not found after the loop → E_TARGET_NOT_FOUND (report handles seen)

if button.text is a following-state label → return { alreadyFollowing: true }

-- human shaping, all probabilistic against a seeded RNG
dwell on the results a moment
open the profile by tapping the row
scroll the grid 1–3 times with uneven pauses
sometimes open one post, watch briefly, BACK
pause
tap the profile's follow button
wait, re-read the button, assert it now reads a following-state label
        → not changed = failure, with a screenshot artifact
BACK to the results
return { handle, display, followers, seed, verified: true }
```

`MAX_SCROLLS` is a constant, not a parameter — the pack's stated position is
that a lever nobody can reason about from a form is worse than no lever.

Parameters are exactly two: `query` and `target`. A third, `matchDisplayName`
(boolean, default false), exists only because §3.4 requires the loose match to
be a deliberate act.

### 4.7 Dialog resilience, shared

**Corrected by §0.9 after the first hardware run.** `clearBlockingDialog` takes
`{ allowBack?: boolean }`, defaulting to `true` so `auto-scroll` is untouched.
Every multi-screen flow — `switch-account` now, `search-follow` next — passes
`allowBack: false`. Reusing the sweep verbatim in a navigation flow, as this
section originally specified, is a live landmine: its last resort undoes the
navigation it was called to protect.

`dialogs.ts` is otherwise lifted from `index.ts` unchanged and used by all three scripts.
`search-follow` and `switch-account` additionally treat "the anchor for this
screen did not appear" the way `auto-scroll` treats a blind read: sweep once,
retry, then fail with `blocked` and a screenshot. The blocked-path escalation
that has never executed in production (noted after Plan 85's rollout) will get
its first real exercise here, because these flows have far more anchors to miss.

---

## 5. Implementation steps

Executed **sequentially**, per the owner's decision: switch-account complete
and tested on hardware before the search work begins.

1. **Extract, without editing.** Create `human.ts`, `dialogs.ts`, `tree.ts`.
   Move `makeRng`, `between`, `pickWatchMs`, `sleep`, `pngSize`,
   `ACK_SELECTORS`, `DENY_SELECTORS`, `clearBlockingDialog`,
   `nextDialogAction` verbatim. Update `index.ts` imports. Write `tree.ts` new,
   with its own unit tests over synthetic `UiNode` trees.
   *Gate: the existing 18 tests pass with only import-path edits.*
2. **`switch-account.ts`** per §4.3. Register it in `definePlugin`. Bump the
   pack to `1.2.0` in both `package.json` and `index.ts`.
3. **Test on hardware** per §7.2. This is a real account switch; it must land
   on `dewi_purnama280` and be verified by reading the profile handle.
4. **`search.ts`** per §4.4, exporting `searchFor` and `scrollResults`. Done —
   `plugins/tiktok-automation-pack/src/search.ts`.
5. **`search-follow.ts`** per §4.6. Done —
   `plugins/tiktok-automation-pack/src/search-follow.ts`. Registered in
   `definePlugin`; pack bumped through 1.3.0 → 1.3.2 (two hardware-driven
   fixes landed during step 6, both re-typechecked/re-tested before the final
   1.3.2 publish — see §0.10a, §0.10b).
6. **Test on hardware** per §7.3, including the follow → observe → unfollow
   probe that closes §0.7. Done — see §7.3 for job ids and the observed label.
7. Add the plan-86 row to the index table in `docs/plans/00-overview.md`.

## 6. Acceptance criteria

1. `bun run typecheck` passes.
2. `bun test` from the repo root passes (nothing under `packages/` is touched).
3. `bun run --cwd plugins/tiktok-automation-pack test` passes, including new
   unit tests for `tree.ts`, the target parser, and the row-resolution logic.
4. `switch-account` with `target: "2"` moves the device to the second account
   and reports `verified: true` with the resulting handle.
5. `switch-account` with `target: "<username>"` does the same by name.
6. `switch-account` with `target: "1"` fails with `E_TARGET_IS_CURRENT` and
   changes nothing on the device.
7. `switch-account` with an unknown username fails with `E_NO_SUCH_ACCOUNT`
   and lists the usernames it did see.
8. `"Tambah akun"` is unreachable as a target by either position or name.
9. `searchFor(query, 'Pengguna')` lands on the Pengguna tab with result rows
   present, without tapping any search-history delete control.
10. `search-follow` follows exactly one correctly-identified account and
    verifies the button changed state.
11. `search-follow` against an already-followed account performs no tap and
    returns `alreadyFollowing: true`.
12. `search-follow` refuses, without tapping, when more than one row matches.
13. No run of any script reports `success` while its target screen was never
    reached.

## 7. Test plan

### 7.1 Unit (no device)

- `tree.ts`: `rowsById` over a synthetic tree with three same-id rows returns
  all three in order; `within` attributes children to the right row; `textIn`
  does not leak across sibling subtrees.
- Target parser: `"2"` → position 2, `"dewi_purnama280"` → username,
  `"1"` → rejected, `""` → rejected, `"  3 "` → position 3.
- Row resolution: current-account detection with the checkmark present, and the
  fallback when it is absent; `"Tambah akun"` excluded in both cases.
- Follow-state reader: a row whose button reads `"Ikuti"` vs a following-state
  label, and a profile tree where the stat label `"Mengikuti"` is present but
  must be ignored.

### 7.2 Hardware — switch account

Run the script for `target: "2"`, then for `target: "user2578127329501"` to
switch back. Between runs, read the profile handle independently through the
cap API to confirm the device really moved. Then run `target: "1"` and confirm
it fails without touching the device.

The "Keluar" adjacency (§0.6) gets an explicit check: after the run, the
account must still be signed in.

### 7.3 Hardware — the follow probe that closes §0.7

One pass, three observations, no residue:

1. Search a benign query, pick a result account, and **record its handle**.
2. Dump the row and record the follow button's text in the not-following state
   (expected `"Ikuti"`).
3. Run `search-follow` against that handle. Record the button's text
   afterwards — **this is the previously unobserved following-state label**.
4. Re-run `search-follow` against the same handle. It must now take the
   `alreadyFollowing: true` branch and perform no tap. This is the branch that
   was pure assumption before this plan.
5. Unfollow manually through the cap API and confirm the button returns to
   `"Ikuti"`, leaving the account exactly as it was found.

If step 3's label is anything other than `"Mengikuti"`, the constant is
corrected from the observation and step 4 is repeated.

**EXECUTED (2026-08-09), device `f125719b-62d1-4500-b7a8-2e237391ea5d`, query
`"kucing lucu"`, target `meongkitty_lucu` (a benign cat account, 29.8k
followers, chosen arbitrarily off the first results page):**

1. Handle recorded by hand via `ui.py`: `meongkitty_lucu` (display name
   "Kucing Lucu"), row bounds `[0,538-720,594]`.
2. Row's inline follow button (`id:"tcj"`) read `"Ikuti"` before anything ran.
3. First run: job `bc6170ec-9caf-4a1c-8874-bb628bd35c3f` (pack 1.3.0) **failed**
   with `E_FOLLOW_BUTTON_NOT_FOUND` — the human-shaping grid scroll had already
   collapsed the profile header by the time the script looked for the follow
   button, and neither `id:"fds"` nor the then-single bounds band could see it
   there (§0.10a). Fixed and republished as 1.3.1; re-run as job
   `3fcd9434-2561-42f4-97e1-064f035f3926`, which **succeeded**:
   `followButtonBefore: "Ikuti"`, **`followButtonAfter: "Mengikuti"`** — the
   previously unobserved label, confirming the presumed constant needed no
   correction (§0.7 closed).
4. Re-run as job `f70d02b3-8ee2-4e46-9b7b-20b7966bc974` (pack 1.3.1): took the
   `alreadyFollowing: true` branch, `verified: true`, finished in ~25s versus
   ~46s for the follow run — consistent with no profile visit and no tap.
5. Unfollowed by hand: tapped the `"Mengikuti"` button on the profile, which
   opened a `"Lembar bawah"` confirmation sheet with two rows ("Sesuaikan
   nama" / "Batal ikuti"); tapped "Batal ikuti". Confirmed by dump the button
   read `"Ikuti"` again afterwards, and by a follow-up search that the row and
   stats (`"29,8 rb pengikut · 209,6 rb suka"`) were unchanged. While
   exploring this step, found that `id:"fds"` is shared with a "Pesan"
   (Message) button once already following, with "Pesan" first in document
   order (§0.10b) — fixed and shipped as pack 1.3.2 (no further hardware run
   against it, to respect the one-follow limit for this exercise; covered by
   a unit test instead). Device left signed in as `user2578127329501`,
   nothing else on the device changed.

### 7.4 What is deliberately not tested

An account list long enough to need in-sheet scrolling (§4.3) cannot be staged
with two accounts. That path ships unexercised and is recorded as a risk (§8).

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| A tap lands on "Keluar" and logs the account out (§0.6). | Tap only dumped bounds centres, never screen fractions. `desc:"Keluar"` is on no list the script can ever tap. §7.2 checks sign-in survived. |
| `"Tanda centang"` is locale-dependent, so the current account cannot be identified under another language. | Position 1 is rejected regardless (§3.3), so the marker is a cross-check rather than the safety mechanism. A small label table plus a warn-and-assume-row-0 fallback covers the rest. |
| Obfuscated ids (`l_z`, `ugl`, `zjo`, `tcj`, `hhu`, `jvu`) change on a TikTok update and every selector breaks at once. | Prefer `desc`/`text` and bounds-relative addressing wherever one exists; where an obfuscated id is unavoidable, pair it with a structural fallback. The anchors-and-loud-failure rule (§3.6) means a break is reported, not silently mis-clicked. |
| Following the wrong account. | Exact handle match, refuse on multiple matches, display-name matching only on explicit opt-in (§3.4). |
| The in-sheet scroll path ships untested (§7.4). | Bounded scroll count, and failure rather than an unbounded loop. Flagged for the first operator with three or more accounts. |
| The extraction in step 1 changes `auto-scroll`'s behaviour. | Move verbatim, no edits; the 18 existing tests are the gate. |
| The inspector goes briefly unresponsive and every anchor reads as missing (§0.8). | No recovery may assume "anchor missing" means "dialog on top". `allowBack: false` keeps a wrong guess from making things worse, and the failure is loud with a screenshot rather than a wrong-screen tap. |
| A hardware failure is diagnosed from the most plausible story rather than from evidence. | The BACK hypothesis in §0.9 was plausible, widely applicable, and false. Reproduce with the fix in place before believing a root cause. |
| Switching accounts leaks into the next job on that device (§3.5). | Reported in the result. Not hidden, not auto-reverted. |

## 9. Open questions

1. **ANSWERED, EXECUTED — how to close §0.7.** Follow a recorded account, observe the
   changed label, re-run to exercise the already-following branch, then
   unfollow. One pass, three observations, no residue. §7.3. The observed
   label was `"Mengikuti"`, matching the presumed constant exactly — but
   getting to that observation surfaced two selector gaps the plan had not
   documented (§0.10a, §0.10b), both fixed before the final publish.
2. **ANSWERED — build order.** Sequential: switch-account and its hardware test
   first, then the helper and search-follow with their own test pass.
3. **ANSWERED — parameter shape.** One parsed string (§3.2).
4. **OPEN — should the search helper be promoted out of this pack?** It is
   written here as pack-local. If a second pack ever needs TikTok search, the
   question of a shared plugin library arises; nothing in this plan answers it.
5. **OPEN — no lease acquisition over plain HTTP.** The capability API's
   `device.tap`/`type`/`scroll` require a control lease that can only be
   acquired over WebSocket (`lease.acquire`). Scripts running inside the core's
   own executor get one automatically, so this does not affect the pack — but
   it makes out-of-band device driving (exactly what §7's hardware tests need)
   require a WS shim. Whether the cap surface should expose lease acquisition
   is a `packages/core` question, deliberately out of scope here.
6. **OPEN — `find()` cannot express "Nth match" or "within this subtree".**
   Every list screen in this app therefore pays for a full `dump()`
   (334–584 ms) where a scoped find would cost ~80 ms. `tree.ts` makes this
   bearable inside the pack; whether the SDK should grow a scoped find is a
   `packages/sdk` question.
