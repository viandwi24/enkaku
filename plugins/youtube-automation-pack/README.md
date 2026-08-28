# YouTube automation pack

Search and browse the YouTube app on a farm device.

## Members

| id | what it does |
|---|---|
| `search-channel` | Searches for a channel by name, opens its channel page, optionally watches one of its videos, closes. Never subscribes, likes, or comments. |

### `search-channel` parameters

| param | default | what it does |
|---|---|---|
| `query` | — | the channel to search for, e.g. `eno bening` |
| `holdMs` | `3000` | how long to stay on the channel page |
| `watch` | `none` | `none` · `latest` · `random` — one enum, not two booleans, because "newest" and "random" are mutually exclusive and a pair of flags lets an operator ask for both |
| `watchMs` | `15000` | how long to leave the video playing. The clock starts **after** any pre-roll advert |
| `skipAds` | `true` | press YouTube's own "Skip ad" button when it appears. Only that button — the advert itself is never touched |

## The house rule

A YouTube layout is not a fact this repo owns — it moves with the app version,
the device locale, and whichever A/B bucket the install landed in. So:

- **every anchor is a ladder** — a `resourceId` first where one exists, then
  content descriptions, in more than one language;
- **every step saves its tree and screenshot** as artifacts, so a failed run
  arrives already carrying its own bug report;
- **the result reports which rung matched** (`anchors`), so one real run turns a
  guess into a measured fact.

Every defect listed in `src/index.ts`'s changelog was read out of exactly those
artifacts. None of them was found by reasoning about the app.

## What the hardware actually said

Measured on a moto g06 power, 720×1640, Android 15, YouTube in Indonesian
(2026-08-26). Four of these were surprises, and each one broke a version:

1. **The results page is Compose, and its rows carry no `resourceId` at all.** A
   fully loaded page had ids for three things: the search bar, the bottom
   navigation, and four `thumbnail_layout` nodes. Every result's identity lived
   in its content DESCRIPTION — `Buka channel`, `Subscribe ke Eno Bening.`
2. **A dump's root node has `bounds` of all zeros** and an empty `packageName`.
   Deriving the screen height from it produced a negative content band that
   rejected every node on the screen.
3. **Thumbnails render before their labels.** Waiting on thumbnails declares a
   blank page ready.
4. **The bottom navigation looks exactly like a result row** to any test loose
   enough to accept "clickable, and has a description".
5. **The microphone FAB floats over the content**, so it is inside any
   geometric content band. On a page that had loaded nothing else it was the
   only readable node there, and made "results are ready" fire on a blank
   screen — two runs in three.
6. **A row's top can be on screen while its centre is under the navigation
   bar.** Tapping such a row opens whatever nav item is beneath it. Only
   `watch: 'random'` could ever reach that row; `latest` is always row 0.
7. **A sponsored card sits in the recommendations feed below every video**, so
   "does the screen say sponsored" is not a test for a pre-roll advert.
8. **The player's first readable text is the closed captions**, not the title.

### Check-then-act

`waitForTree` polls until a tree passes a predicate and returns that tree.
Re-dumping afterwards to save the artifact meant acting on a different tree than
the one that was checked — a results page passed, re-rendered, and the run then
searched bare chrome. `capture(ctx, label, tree)` takes the validated tree.

## Fixtures

`src/__fixtures__/` holds four real trees from that session — a loaded results
page, the same page mid-load, the channel page reached, and the suggestions
screen. `src/search-channel.test.ts` runs every predicate against them.

The mid-load fixture is the valuable one: it is the exact page that three
successive readiness tests each declared "ready", and it is what turns "wait
longer" into a regression test.

That test pass immediately found two defects no run had yet exposed — a results
page being recognised as a channel page (it carries `Subscribe ke <channel>.` on
the channel's own row), and the channel title being read out of the search bar.
Both would have failed silently, reporting success.

## A note for anyone writing a member here

`DeviceApi` declares `tapNorm`, `swipeNorm`, `longPress` and `gesture`;
`packages/session/src/device-executor.ts` implements them; and
`packages/session/src/runner/child-entry.ts`'s `deviceApi` — the IPC bridge a
script actually calls through — **does not forward them**. A member calling
`tapNorm` typechecks, publishes, verifies, and dies at runtime with
`ctx.device.tapNorm is not a function`. Use `tap({ point })`, which is a real
`SelectorSchema` rung and takes device pixels — the units `bounds` are already
in. See `src/youtube.ts`'s `tapNode`.

## Editing this pack

`packages/core/packs/` is seeded **once**, keyed on `${name}@${version}`
(`packages/core/src/plugins/seed-embedded.ts`). A rebuilt bundle at an unchanged
version is skipped on every later boot. Bump `package.json`, `src/index.ts`'s
`version:`, and `src/index.test.ts`'s assertion together, add the reason to the
changelog block, then `bun run build:packs`. A seeded version is **staged, not
activated** — the operator activates it on the Plugins page.

## Commands

```bash
bun run --cwd plugins/youtube-automation-pack test
bun run build:packs

# publish to a local dev farm and run it
bun run packages/sdk/src/cli/index.ts publish plugins/youtube-automation-pack/src/index.ts
```
