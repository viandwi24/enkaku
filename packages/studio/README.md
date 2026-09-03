# @enkaku/studio

The Enkaku web UI (Next.js App Router, static export).

## Dev mode

```bash
# terminal 1 — core
ENKAKU_DATA_DIR=/tmp/enkaku-dev bun run --cwd packages/core dev
# terminal 2 — studio (hot reload)
NEXT_PUBLIC_ENKAKU_CORE_URL=http://localhost:7700 bun run --cwd packages/studio dev
# open http://localhost:3001
```

The core only allows CORS from `localhost:*` while `NODE_ENV !== 'production'`.

## Prod mode (single origin)

```bash
bun run --cwd packages/studio build     # → packages/studio/out
bun run --cwd packages/core dev         # the core serves out/ at /
# open http://localhost:7700
```

The build location can be overridden with `ENKAKU_STUDIO_DIST`.

## Configuration

This package's configuration follows what `create-next-app` produces (TypeScript, App Router, no Tailwind or ESLint scaffolding) so it does not drift from Next's conventions:

- `tsconfig.json` **stands alone** and does not extend the repo's `tsconfig.base.json`. The base sets options for Bun and TypeScript 7 (`types: ["bun"]`, `verbatimModuleSyntax`) that collide with Next's toolchain.
- `typescript` and `@types/*` are devDependencies **local to this package**, pinned to 5.x. The repo root uses TypeScript 7 for its own typecheck; Next calls the TS 5 compiler API, so both have to coexist.
- `next-env.d.ts` is regenerated on every `dev` and `build` and is not tracked by git.

## Design system

Tokens, screen patterns, and writing rules live in [`docs/design.md`](../../docs/design.md). One rule worth repeating: write Tailwind v4 colour classes as `bg-surface` and `text-fg-muted`, never `bg-[--color-surface]` — the v3 bracket form compiles to nothing in v4 and fails silently.

## Notes

The device page uses the query param `/device?id=<deviceId>` rather than a dynamic `[id]` route, because a static export cannot pre-render dynamic ids.

## Workspace file presenters (plan 116)

`/workspace` (`app/workspace/page.tsx`) does not render every file through
one `Textarea`. It resolves a **presenter** from the file's content type and
mounts that instead — `components/workspace/presenters/index.ts` is the
whole seam:

```ts
export interface FilePresenter {
  id: 'text' | 'image' | 'video' | 'download'
  /** First match in the registry wins — order is meaning, not style. */
  match(file: { contentType: string; path: string }): boolean
  capabilities: { view: true; edit: boolean }
  /** Over this many bytes, the page shows metadata and a download instead of `Component`. */
  maxBytes: number
  /** Why this presenter cannot edit — rendered verbatim; required when `edit` is `false`. */
  readOnlyReason?: string
  Component: (props: PresenterProps) => JSX.Element
}
```

Deliberately not called a "driver" — plan 115 already owns that word for a
different seam (`ContentDriver`, `packages/core/src/workspace/drivers/index.ts`)
answering WHERE a file's bytes live; this one answers HOW a file is shown
and whether it can be edited. Neither file mentions the other's word.

**Adding a presenter is one new file plus one registry line, and nothing
else** — this is how the image and video presenters (`presenters/image.tsx`,
`presenters/video.tsx`) were added, without touching `app/workspace/page.tsx`
at all:

1. Write a file exporting a `FilePresenter`. `match` decides which content
   types it claims; `capabilities.edit: false` requires a `readOnlyReason`
   (the sentence the page shows in place of a Save control — the page reads
   this rather than a component special-casing itself); `maxBytes` is the
   ceiling past which the page shows the file's metadata and a download
   instead of mounting `Component` at all.
2. Add the export to `REGISTRY` in `index.ts`, in the position its `match`
   needs. Order is meaning: the first match wins, so a narrower presenter
   must sit ahead of a broader one, and the catch-all `download` presenter
   (`match: () => true`) must stay last or it would swallow every file
   before a real presenter ever saw it.

A presenter never fetches its own bytes for anything but text.
`PresenterProps.src` is the `GET /api/workspace/file?path=…` URL (streamed,
`Range`-aware — see `packages/core/README.md`'s own section on that route),
and an image or video presenter points an `<img>`/`<video>` straight at it.
Only `PresenterProps.text` carries loaded content plus a CAS-guarded
`onSave`, and the page only supplies it to a presenter whose
`capabilities.edit` is `true`.

A type with no presenter still resolves to one: `download` names the
content type, shows the size, and offers the file at the same `src` URL as
a link — a real presenter, not a blank pane or an error.

`Component`'s return type is `JSX.Element`, imported as `import type { JSX }
from 'react'` — **not** the bare `JSX` namespace. Studio is on React 19,
where the JSX types live under `declare module 'react'` and there is no
ambient global `JSX` namespace; writing the bare form fails with
`TS2503: Cannot find namespace 'JSX'`.

## Tab lifecycle and the Wall (plan 42)

The device page's tabs stay mounted and are hidden with the `hidden` HTML attribute (`TabPanel` in `app/device/page.tsx`) instead of being conditionally rendered — a tab switch no longer unmounts `LiveView`, which is what makes returning to Control instant instead of replaying the wake-up sequence. **Monitor and Crashes are the deliberate exception**: each holds a device-side `logcat` stream, so they stay mount-on-demand exactly as before, with their own cleanup effect stopping the stream on unmount. A gated panel like `FilesPanel` renders its controls disabled with one explanatory line rather than an empty panel, so "Take control" from any tab takes effect immediately without a tab switch.

The devices list's **Wall** mode (`components/wall/`) shows every device's screen live in a grid — the same `LiveView` component in a `compact`, read-only mode, subscribed at the `wall` quality profile. `TileGrid` is the one responsive grid layout. Offline and quarantined devices always render a static card with the reason, never a blank tile.

## The Wall is the front door (plan 92 §1, §3.1, §3.10, §9 Q1)

`/` opens on the Wall, unconditionally, for every farm. This is a rule, not
a convenience default, and it has one deliberately-cut escape hatch worth
naming so nobody re-adds it: **there is no `wall.defaultView` farm
setting.** The owner's own words on this: *"wall first emang wajib
tampilannya itu"* — the Wall is mandatory, not merely the default. A
farm-wide switch that let one admin default everyone else to List is
exactly the configurability that was ruled out, generalising the reason a
*per-operator* setting was already rejected for ("one operator's choice
should not change everyone's front door") to cover an admin editing
Settings too.

**Precedence, most specific first, no third rung:**

```
URL query parameter (?view=) → this tab's session preference → 'wall'
```

- A `?view=list` (or `?view=wall`) link always wins — a shared link shows
  what the sender saw (plan 47's own reason for putting the view in the
  query string).
- `packages/studio/src/lib/prefs.ts` splits what looks like one "UI
  preferences" concern into two storage backends on purpose, because they
  have to forget on different schedules:
  - **`view` lives in `sessionStorage`.** A view switch survives a reload
    of the *same tab*, but a new tab, a new window, or a new browser
    session sees nothing and therefore always lands on the Wall. This is
    the mechanical device that makes "List is one click away" and "the
    Wall is the unconditional landing view" both true at once — nothing to
    configure, nothing to reset, nothing an admin can change for anyone
    else.
  - **`tileSize` lives in `localStorage`.** It is a property of the screen
    an operator is sitting in front of (a laptop vs. a lobby display), not
    a landing-view choice, so it does not reset just because a new tab
    opened.
- There is no farm-settings rung in this chain at all. If a future field
  ever tempts a "and default everyone to X" farm setting for what a fresh
  session sees, re-read this section first — that is the exact shape of
  what was rejected here.

## The wall's live-set policy (plan 92 §3.2, §4.6, `components/wall/useLiveSet.ts`)

The wall does not stream "however many devices happen to be first in the
list" — `useLiveSet` decides, deliberately, which devices are live at any
moment, split into a pure decision function (`computeLiveSet`, provable
with hand-built inputs, no DOM) and a hook that owns the three things a
pure function cannot (`IntersectionObserver`, dwell timers, a ramp
counter). Four rules, in order, and **the order is the policy** — a later
rule never overrides an earlier one:

1. **Eligibility is a readiness fact, not only a status one.** A device is
   only ever a streaming candidate when `readiness.actual` is `awake` or
   `hot`. **`asleep` is a blocked state**, in the same bucket as `offline`
   and `quarantined` — never a candidate for live/pending/budgeted at all.
   This is the one non-negotiable rule: there is no way to stream a device
   without waking its screen (building a session wakes it unconditionally
   — a dark screen returns black frames, so that is inherent, not a bug to
   fix later), so "the wall shows the farm" and "opening the wall does not
   change the farm" can only both be true if a sleeping device is never
   promoted in the first place. `WallTile` enforces the same check a
   second time, independently, ahead of its own `live` branch — belt and
   braces at two different layers, not redundant.
2. **Membership follows the viewport, with a dwell.** A device becomes a
   *candidate* only after it has been continuously visible for `DWELL_MS`
   (400ms). Scrolling past forty tiles in under that time promotes none of
   them — that is the guarantee, not a side effect of one.
3. **Ranking inside the candidates is pinned → hot-and-visible →
   already-live-and-visible → newly-visible-and-awake → everything else**,
   never fleet-list order and never a JS-measured "importance". A hot
   device's session is already open, so promoting it costs a map lookup
   and a primed keyframe rather than a fresh build.
4. **The cap is the number ACTUALLY APPLIED, read from `/api/adb/stats`'s
   `video.maxTiles`** (already resolved server-side when the stored
   `wall.maxTiles` is `0`/auto — see `packages/session/README.md`'s "`0`
   means auto, not zero" note) — never the raw setting fetched directly,
   which would show `0` and cap the wall at nothing for the common case.
   Eviction under the cap takes the lowest-ranked member of the *previous*
   live set first, which in practice means the tile that has been off
   screen longest — never one still on screen, and never a tile that is
   already decoding being displaced by a same-tier newcomer (`liveIds`
   feeds back into every call precisely so that stability holds).

The server-side half of the safety story lives in `@enkaku/session`
(`session.maxConcurrentBuilds`, the build lane): the client's ramp
(`wall.rampConcurrency`, at most N tiles asking for a stream at once while
the wall fills in) is a courtesy that makes the fill-in orderly, never the
thing that actually prevents a stampede — two browser tabs (or a tab and a
script) defeat any client-side ramp, so the authoritative bound is always
server-side. Do not read `useLiveSet`'s ramp as a safety mechanism when
reasoning about a new caller of it.

## The tile grammar (plan 92 §4.8) — a rule for the next field, not a precedent to copy

`WallTile`/`TileChips` are not "how this tile happens to be laid out
today" — they encode a stated grammar that a new field is expected to
*follow*, the same way plan 48 established one chrome block (not two) that
this plan extended rather than replaced. Read this section before adding
anything to a tile.

**The layout, top to bottom:**

```
line 1   number · label · connection glyph          (identity — never drops)
line 2   TileChips: battery · temperature ·          (condition — fixed order,
         readiness · status                           drops under a container query)
picture  the live/placeholder screen, with the        (state — holder chip and
         holder chip and running-job caption           job caption float ON the
         floating on top, scrimmed                     picture, never beside it)
```

**The rules, and why each one exists — read these before changing anything:**

- **A tile's height must never depend on its content.** The chrome block is
  exactly two fixed lines, always — never three, never a line that appears
  only when some fact is true (a holder, a running job, an error). The
  reason: a tile that grows changes its whole ROW's height in a CSS grid,
  which reflows every tile below it the instant one device gains a fact
  that most devices don't have. If a new field is genuinely important
  enough to show, it goes **on the picture** (scrimmed, like the holder
  chip and the running-job caption already are), not into the chrome
  block. `WallTile.test.tsx` proves this structurally today (the header's
  DOM child count is asserted identical with vs. without a holder) because
  happy-dom has no layout engine to measure a real pixel height with — a
  new field's own test should do the same: assert the header's shape is
  unchanged, not just that the new content renders somewhere.
- **Line 1 is identity, and identity never drops under a narrow tile.**
  Number, label, and the connection glyph are always present, even at the
  smallest tile size (140px, "S"). If a future field belongs on line 1, it
  must earn a place that never disappears — line 1 is not where "nice to
  have but can hide" fields go. That's line 2's job.
- **Line 2 is condition, rendered through `TileChips`, in ONE fixed
  order that never reflows: battery · temperature · readiness · status.**
  A missing value renders a dash IN PLACE of that chip, never a collapsed
  gap — collapsing shifts every chip after it, and because `TileGrid`
  gives every tile in the grid the same width, a per-tile collapse would
  make columns stop lining up across the whole wall. **Adding a fifth chip
  means appending to `ALL_TILE_CHIPS`, in a position chosen deliberately
  (it renders in fixed order regardless of what order a caller lists
  `chips` in) — never inserting it ahead of an existing chip**, which
  would silently reorder every tile that already shipped.
- **A field's fitness under a narrow tile is a CSS container query on the
  tile's own `@container` (`WallTile`'s root), never a JS width
  measurement.** The established drop order is temperature first
  (`@max-[200px]:hidden`), then battery (`@max-[160px]:hidden`); readiness
  and status never drop. A new chip that needs to drop under narrow
  widths picks a threshold in that same spectrum and says, in a comment,
  where it sits relative to the existing two and why — "before
  temperature" or "after battery" is a real design decision (what
  survives longest is what most operators check first), not an arbitrary
  pixel number.
- **A per-device fact that isn't yet available is a dash, never a
  conditional render that changes the DOM shape.** `tile-identity.ts`'s
  own `tileIdentityOf` adapter is the pattern: it is the *one* place a
  tile reads a field plan 88/89-shaped fields live on, so if a field's
  name changes or a plan lands later than expected, there is exactly one
  function to edit, not every call site. A new tile field sourced from a
  future plan should get its own adapter function in the same file (or a
  sibling one) rather than being read off `DeviceInfo` inline in
  `WallTile.tsx`.
- **The IP/address is not on the tile, on purpose**, and this generalises:
  a fact that is 15 characters someone reads once while debugging and
  never again belongs in **search and a filter**, not permanent tile
  space (`page.tsx`'s search predicate, the Connection filter beside the
  readiness filter) — it is discoverable, not silently omitted. Before
  adding a new line or badge to a tile, ask whether the fact is something
  an operator *scans* (tile) or something an operator *looks up*
  (search/filter/popover) — plan 92 §4.8 made that split explicit for the
  IP and it applies to any future field the same way.

**What deliberately still floats on the picture, and stays there:** the
holder chip (top-left, scrimmed) and the running-job caption. Both are
about the picture's *current state*, not the device's identity or
condition, and both get the exact same scrim treatment so a future
"who/what is happening right now" fact has an obvious place to go that
does not touch tile height.
