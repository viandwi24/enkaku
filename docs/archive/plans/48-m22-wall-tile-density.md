# Plan 48 — M22 : Wall Tile Density and Hover Actions

> Status: implemented — verified by the presence of the artefact below
> Ships: packages/studio/src/components/TileChips.tsx
> Depends on: Plan 42 (the Wall and `TileGrid`), Plan 45 (readiness badge and control), Plan 47 (the merged fleet view). All landed.
> Spec references: `docs/design.md` (tokens, density, writing rules).

---

## 1. Goals

- A wall tile carries **one** chrome block instead of two, so more of each tile is the actual screen.
- Identity on its own line; battery, temperature, readiness, and status on a single chip row beneath it.
- Actions (Wake, Sleep, and anything added later) live as an **overlay on the screen**, revealed on hover or focus, instead of occupying a permanent footer.
- The overlay never hides a control from someone who cannot hover — touch, and keyboard, both reach it.
- A tile with no picture still shows its action, because there is nothing to cover.

## 2. Non-goals

- Changing what a tile *reports*. Every value shown today is still shown; this is arrangement, not content.
- Changing the Wall's live-set cap, paging, or quality profiles (Plan 42 §3.5).
- Adding control (tap-to-tap) on tiles. They stay read-only; clicking a tile opens the device page.
- Touching the device page's own Control tab layout.

## 3. Context and design decisions

### 3.1 Two bars, one screen

`packages/studio/src/components/wall/WallTile.tsx` renders, in order: a header with `border-b` (label, readiness badge, status badge), the screen at `aspect-[9/16]`, then a footer with `border-t` (battery, temperature, running job, the readiness control).

So every tile spends two bordered rows of vertical space on chrome. On a wall of eight tiles that is eight bars' worth of height taken from the thing the wall exists to show. The proposed shape:

```
moto g06 power
🔋 100%  🌡 29.0°C   asleep   idle
[            screen            ]
```

One block, two lines, then picture to the bottom edge.

### 3.2 Chips read better than a sentence

Putting battery, temperature, readiness, and status on one row makes them scannable across a grid: the eye compares the same position in each tile. Splitting them across a header and a footer defeats that — you cannot compare temperatures down a column when half the tiles put it in a different place.

Order is fixed and never reflows: battery, temperature, readiness, status. A missing value renders a dash in place rather than collapsing, so the columns stay aligned across tiles. A tile whose chips shift position when a value is absent is worse than one showing a dash.

The running job, which today sits in the footer, becomes a caption strip along the bottom edge of the screen — it is about what the screen is doing, so that is where it belongs.

### 3.3 Hover-only would exclude people, so it is hover-*plus*

Revealing actions on hover is right for a dense grid, and wrong as the only mechanism:

- **Touch** has no hover. On a tablet the Wake button would simply not exist.
- **Keyboard** users tab to a control; if it is only revealed by a mouse, they cannot reach it.
- **Discoverability**: a first-time operator has no reason to suspect a hidden control.

So the rule has three parts, and all three are required:

1. Reveal on `hover` **and** on `focus-within`, so tabbing into the tile shows the same overlay a mouse would.
2. Under `@media (hover: none)`, the overlay is **always visible** — coarse pointers get a permanently shown control rather than nothing.
3. A tile with **no live picture** (asleep, offline, or beyond the live-set cap) shows its action persistently regardless, because there is no picture to protect. The overlay is the content there, not an intrusion.

That last rule also fixes discoverability for free: the very tiles an operator most wants to Wake are the ones showing the button already.

### 3.4 The overlay must not fight the picture

An overlay on live video needs to stay legible without washing the frame out. A scrim confined to the overlay's own bounds — not the whole tile — plus the existing design tokens, keeps the picture readable. No full-tile dimming: the wall is for watching, and dimming eight tiles because the cursor is near one of them is worse than the footer it replaces.

## 4. Technical design

### 4.1 `WallTile.tsx`

```
<article>                       ← group, focus-within
  <header>                      ← one block, no border-b
    <span>{label}</span>        ← line 1, truncated
    <div>chips</div>            ← line 2: battery · temp · readiness · status
  </header>
  <div className="relative aspect-[9/16]">
    <LiveView … />              ← or the asleep/offline placeholder
    {runningJob && <caption/>}  ← bottom strip over the picture
    <div className="overlay">   ← actions; hidden until hover/focus, per §3.3
      <ReadinessControl … />
    </div>
  </div>
</article>
```

Visibility is expressed with Tailwind state variants — `opacity-0 group-hover:opacity-100 group-focus-within:opacity-100`, plus a `hover-none:opacity-100` utility for §3.3's rule 2 and an explicit `alwaysShowActions` prop for rule 3. It must be `opacity`/`pointer-events`, **not** conditional rendering: a control that unmounts cannot receive focus, which would break rule 1.

Token classes only (`bg-surface`, `text-fg-muted`, `text-led-warn`, `text-led-danger`) — never Tailwind v3 bracket syntax, which compiles to nothing in v4 and fails silently.

### 4.2 Chip row

A small `TileChips` component so the same row can be reused by topology tiles and, later, the list view's compact mode. Fixed order, dash for missing values (§3.2), and the existing `low battery` / `hot` colour rules preserved exactly as they are today.

### 4.3 What must not change

The tile's props, its click-through to the device page, the Plan 42 live-set membership logic, and every value currently displayed. This plan is a re-layout; a reviewer should be able to diff the rendered *content* and find it identical.

## 5. Implementation steps

**48.1 — `TileChips`** (§4.2), with the fixed order and dash-for-missing behaviour.

**48.2 — Re-layout `WallTile`** (§4.1): one header block, footer removed, running-job caption moved onto the screen.

**48.3 — The overlay** (§3.3): hover, focus-within, `hover: none`, and the no-picture persistent case.

**48.4 — Reuse on topology tiles** so the two do not drift.

**48.5 — Check density.** Measure the tile height before and after at the same grid width and report the number; the whole point is the screen getting bigger.

## 6. Acceptance criteria

1. A tile renders one chrome block — label line, chip line — and no footer.
2. Every value shown before is still shown: label, battery, temperature, readiness, status, running job.
3. Chips keep a fixed order and render a dash for a missing value, so columns align across tiles.
4. Actions are hidden until hover **or** keyboard focus reaches the tile, and are operable by keyboard alone.
5. Under `@media (hover: none)` the actions are always visible.
6. A tile with no live picture (asleep, offline, beyond the cap) shows its action persistently.
7. The overlay scrim is confined to the overlay; the rest of the picture is not dimmed.
8. Tile height at a fixed grid width is measurably smaller than before, and the screen area is larger — with the figure recorded.
9. Clicking a tile still opens the device page via `next/link`.
10. Topology tiles use the same chip row.
11. No Tailwind bracket-syntax colour classes are introduced.
12. `bun run typecheck` passes; `bun test` is green.

## 7. Test plan

**Unit:** `TileChips.test.tsx` — fixed order, dash for each missing value, colour rules for low battery and high temperature.

**Manual smoke:**
```bash
bun run dev && bun run dev:studio
# 1. devices list → Wall: tiles show label + one chip row, no footer
# 2. hover a live tile → Wake/Sleep appears over the picture, picture stays readable
# 3. Tab into a tile with the keyboard → the same controls appear and can be activated
# 4. an asleep tile → its Wake button is visible without hovering
# 5. narrow to a touch-sized viewport / device emulation → controls always visible
# 6. compare tile height against the previous build at the same window width
```

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Hover-only controls become unreachable on tablets or by keyboard. | Three-part rule in §3.3, each with its own acceptance criterion (§6.4–6.6). Visibility via `opacity`, never conditional rendering, so focus always has a target. |
| An operator cannot find Wake because it is hidden. | The tiles most likely to need it — asleep, offline — show it persistently (§3.3 rule 3). |
| The overlay makes live video unreadable. | Scrim confined to the overlay's own bounds; no full-tile dimming (§3.4, §6.7). |
| A value quietly disappears during the re-layout. | §6.2 lists them explicitly, and §4.3 states the content diff should be empty. |
| Chips reflow and columns stop aligning across the grid. | Fixed order plus dash-for-missing (§3.2, §6.3). |

## 9. Open questions

1. Should the chip row also appear on the list view's rows, so the two views read the same? Likely yes; deferred until this shape is in use.
2. Should a tile show its cluster? It is available and it is one more chip — held back to see whether the row is already busy enough.
