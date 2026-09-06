# Plan 501 — Shell : the rail context menu and the right panel

> Status: draft
> Ships: packages/studio/src/components/shell/RailContextMenu.tsx
> Depends on: plan 500 (the PiP panel, its store, its frame flag) — this plan revises it
> Spec references: §13 (Studio)

## 0. Goal checklist

| # | Goal | Parameter | Verified by | Done |
|---|---|---|---|---|
| G1 | Right-clicking a rail entry opens a context menu; the hover PiP button is gone | `onContextMenu` on the rail cell; `PipButton` deleted | `rg -n "PipButton" packages/studio/src` → empty; `rg -n "onContextMenu" packages/studio/src/components/shell/Rail.tsx` → at least 1 | [ ] |
| G2 | The menu offers Open, Open in PiP, Open in side panel — in that order | 3 rows | `rg -n "Open in" packages/studio/src/components/shell/RailContextMenu.tsx` → 2 matches | [ ] |
| G3 | An entry that may not be panelled offers only Open | Devices shows 1 row | `rg -n "item.pip|canPanel" packages/studio/src/components/shell/RailContextMenu.tsx` → the two panel rows are conditional | [ ] |
| G4 | The menu follows this repo's existing context menus, not a new primitive | positioned by viewport coords, closed through `useOverlay` | `rg -n "useOverlay" packages/studio/src/components/shell/RailContextMenu.tsx` → 1 match; `rg -n "radix|ContextMenu\." packages/studio/src/components/shell/` → empty | [ ] |
| G5 | There is still exactly **one** panel; it has a mode | `mode: 'pip' \| 'side'` on one nullable store value, no second store | `rg -n "mode" packages/studio/src/components/shell/pip-store.ts` → a `PanelMode` on `PipRequest`; `rg --files packages/studio/src/components/shell -g '*store*'` → 1 file | [ ] |
| G6 | Opening in the other mode moves the panel, never opens a second one | 1 request in, 1 panel out | `rg -n "usePipRequest" packages/studio/src/components/shell/PipHost.tsx` → one read, one branch per mode | [ ] |
| G7 | The layout becomes rail, page, right panel — three siblings, each its own bordered container | `AppShell` renders `SidePanel` as the third child of the root flex row | `rg -n "SidePanel" packages/studio/src/components/shell/AppShell.tsx` → 1 match | [ ] |
| G8 | The right panel is resizable by its left edge, and its width persists | drag handle; width in the same `localStorage` key as the PiP geometry, Zod-parsed | `rg -n "sideWidth" packages/studio/src/components/shell/pip-store.ts` → in the schema and the default | [ ] |
| G9 | The right panel carries close, refresh, zoom out, zoom in — and no drag or magnet | 4 controls | `rg -n "aria-label=" packages/studio/src/components/shell/SidePanel.tsx` → 4 plus the resize handle's | [ ] |
| G10 | Both modes frame the same way: `coreBase()`, `?pip=1`, one iframe each | no second framing path | `rg -n "coreBase\(\)" packages/studio/src/components/shell/` → `PipPanel` and `SidePanel` only; `rg -n "pip=1" packages/studio/src/components/shell/` → the shared helper | [ ] |
| G11 | No Studio test file is added, and no `dark:` or v3 bracket colour class enters the shell | 0 each | `rg --files packages/studio -g '*.test.tsx'` → empty; `rg -n "dark:\|bg-\[--\|text-\[--" packages/studio/src/components/shell` → empty | [ ] |
| G12 | `bun run typecheck` and `bun run build:studio` are clean | 0 errors, exit 0 | both exit 0 | [ ] |
| G13 | The three-column layout holds together: the page panel still fills its space, the right panel does not crush it, and the status bar still spans correctly | owner judgement | owner smoke §7 | owner |
| G14 | The menu opens where the cursor is, flips near an edge, and closes on Escape and on an outside click | owner smoke §7 step 1 | owner | owner |

## 1. Goals

The owner, 2026-09-06:

> "harusnya di klik kanan di sidebar itu ada pilihan mau open, open in pip, open
> in side … jadi kita revisi action buttonnya pakai klik kanan muncul context
> menu, dan sama fitur panel right … kalau user klik kanan terus dia open in
> right panel maka akan kebuka panel gitu: `[sidebar] [page body] [right panel]`"

Two changes to plan 500's feature:

- **The affordance becomes a right-click menu.** A hover button on a 36 px rail
  cell is a small target that only appears when the pointer is already there;
  a context menu is where a desktop user looks for "what else can I do with
  this", and it has room to name the choices.
- **A second way to hold a page: docked to the right.** PiP floats over the
  work; the side panel sits beside it and takes its own space. Both are useful,
  for different reading.

## 2. Non-goals

| Not done here | Where |
|---|---|
| A PiP panel and a side panel open at once | §3.3 — one panel, two modes |
| **Devices in either mode** | unchanged from plan 500 §3.7 — a framed copy would open a second scrcpy session |
| A left-hand panel, or a bottom panel | never asked for |
| Tabs inside the right panel | §9 Q1 |
| Dragging a rail item into the panel | §9 Q2 |

## 3. Context and design decisions

### 3.1 What exists today, cited

| Fact | Where |
|---|---|
| This repo already has two hand-rolled context menus — positioned by viewport coordinates, closed through `useOverlay`, flipped near an edge with `MENU_W`/`MENU_H`/`EDGE` | `packages/studio/src/components/devices/DeviceContextMenu.tsx:10-27`, `packages/studio/src/components/flow/CanvasContextMenu.tsx` |
| Neither uses a radix `ContextMenu`; `@enkaku/ui` ships `dropdown-menu.tsx` but no `context-menu.tsx` | `packages/ui/src/components/` |
| The rail renders each entry as a `next/link`, with plan 500's `PipButton` as a hover sibling | `packages/studio/src/components/shell/Rail.tsx:30-40`, `:79`, `:119`, `:141` |
| The shell's root is a flex row: `Rail`, then a `flex-1` column of `PagePanel` + `StatusBar` | `packages/studio/src/components/shell/AppShell.tsx:91-99` |
| `PagePanel` is the one bordered container: `rounded-panel border border-border bg-panel`, `min-h-0`, `flex-1` | `packages/studio/src/components/shell/PagePanel.tsx` |
| The panel store holds ONE nullable request and its geometry, in one Zod-parsed `localStorage` key | `packages/studio/src/components/shell/pip-store.ts` |
| `isPipFrame()` suppresses the rail, the status bar and Device Control inside a framed document | `packages/studio/src/components/shell/pip-frame.ts`, `AppShell.tsx`, `DeviceControlHost.tsx` |
| `nav.ts` carries `pip?: boolean`; `/` (Devices) does not have it | `packages/studio/src/components/shell/nav.ts` |

### 3.2 The menu is hand-rolled, like the other two

`DeviceContextMenu` is the pattern: a fixed-position card at the click's
viewport coordinates, flipped when it would overflow, registered with
`useOverlay` so Escape and an outside click close it through the shell's own
tier stack rather than a second listener.

Introducing a radix `ContextMenu` here would make this the **third** way this
product opens a menu on right-click, and the first that a plugin's own view
could not match. The existing pattern is not elegant, but it is one pattern,
and `useOverlay` already solves the part that is easy to get wrong.

**Left-click is unchanged**: it navigates, exactly as today. The menu's first
row does the same thing, named — a menu whose obvious row does something
surprising is worse than no menu.

### 3.3 One panel, two modes — not two panels

Plan 500 §3.2 settled on one nullable value because "an array here would be the
beginning of a window manager nobody asked for". That reasoning does not change
because a second mode exists, so `PipRequest` gains
`mode: 'pip' | 'side'` and the store still holds exactly one.

Opening Jobs in the side panel while Plugins floats in PiP therefore **moves**
the panel: same one panel, new target, new mode. This is the conservative
reading of the owner's "cukup satu panel aja", and it is the one that keeps the
answer to "where did my panel go" simple. If a floating panel and a docked panel
should coexist, that is a real product decision and §9 Q3 is where it goes — it
is deliberately not smuggled in here.

### 3.4 The right panel is a sibling, not an overlay

The root flex row gains a third child, so the layout reads exactly as the owner
drew it:

```
[ rail ] [ page column ] [ right panel ]
```

It is a real column with its own `rounded-panel border border-border bg-panel`
container, matching `PagePanel` — the owner asked for the border and radius by
name, and matching the existing container is what makes it look like part of the
shell rather than something pasted over it.

Placing it as a sibling of the **column**, not inside it, means it spans the
status bar's height too. That is deliberate: a docked panel that stopped short
of the bottom would leave a notch of background beside the status bar, and the
handoff's shell has no such shape anywhere.

### 3.5 Width, and what happens when there is no room

The panel's width lives in the same `localStorage` key as the PiP geometry
(`sideWidth`), Zod-parsed with the rest, and is dragged from the panel's **left
edge**. Clamped between 320 px and half the viewport: below 320 px a framed page
is unreadable, and above half the viewport the "page body" the owner is reading
becomes the smaller half, which is not what a side panel is for.

Below 900 px of viewport width the side panel is not offered — the handoff
designed no layout under ~960 px, and three columns in 800 px is four columns of
nothing. The menu row is hidden rather than disabled, for the same reason the
Devices rows are: an offer that cannot be taken is noise.

### 3.6 Both modes frame identically

`PipPanel` and `SidePanel` differ in **chrome**, not in what they hold: both
build `` `${coreBase()}${href}?pip=1` ``, both key the iframe on the href, both
zoom with `transform: scale()` and inverse sizing. The framing itself moves into
one shared helper so a change to how a page is framed cannot land in one mode
and miss the other.

What the side panel does not have: drag, the magnet, and stored x/y. It is
docked; those belong to the floating mode alone.

## 4. Steps

### 4.1 `pip-store.ts` — a mode, and a width

Add `PanelMode = 'pip' | 'side'` and put `mode` on `PipRequest`. `open()` takes
the mode. Extend the geometry schema with `sideWidth` (default 420, clamped
320..vw/2 on read) and keep the single key.

### 4.2 `panel-frame.ts` (new) — the one framing helper

`frameSrc(href)` returning `` `${coreBase()}${href}?pip=1` ``, plus the zoom
step table and the `scale`/inverse-size style object both panels use.

### 4.3 `SidePanel.tsx` (new)

The docked column: a `PagePanel`-matching container, a 34 px header with the
page's label and four controls (zoom out, zoom in, refresh, close), the iframe,
and a left-edge resize handle using pointer capture with `setPointerCapture` —
the same choice plan 500 §3.5 made and for the same reason.

### 4.4 `RailContextMenu.tsx` (new)

Modelled on `DeviceContextMenu`: `{ x, y, item }` request, fixed positioning,
edge flip, `useOverlay`. Rows: **Open**, then **Open in PiP** and **Open in side
panel** when the entry allows it and the viewport is wide enough (§3.5).

### 4.5 `Rail.tsx` — delete the hover button, add the handler

Remove `PipButton` entirely (G1 greps for its absence). Each cell gets
`onContextMenu`, `preventDefault`, and opens the menu with the item.

### 4.6 `AppShell.tsx` — the third column

Render `<SidePanel />` after the page column when the store holds a `side`
request. `PipHost` keeps rendering the floating panel when the mode is `pip`.
Neither renders inside a framed document (`isPipFrame`), unchanged.

## 5. Acceptance

Every §0 row that is not `owner` passes its own command; `bun run typecheck` and
`bun run build:studio` are clean; no `*.test.tsx` is added.

## 6. Owner smoke

1. Right-click each rail entry: the menu opens at the cursor, flips near the
   screen edges, and closes on Escape and on an outside click.
2. Devices offers only **Open**.
3. Open a page in the side panel: the layout becomes three columns, every one of
   them bordered and rounded, and the status bar still spans the page column.
4. Drag the side panel's left edge; confirm it clamps and that the page column
   stays usable.
5. With a page in the side panel, open another in PiP: the panel **moves** — it
   does not become two.
6. Reload: the width and zoom are remembered, the panel is closed.
7. Narrow the window below ~900 px: the side-panel row is not offered.

## 7. Tests

None. Studio and `@enkaku/ui` have zero tests by decision
(`docs/plans/200-mvp-program.md` §8.3) and this plan adds no backend code. It is
verified by `bun run typecheck`, `bun run build:studio`, the greps in §0, and §6
— which is why §6 is seven concrete steps rather than "check it works".

## 8. Open questions

- **Q1 — tabs in the right panel?** No. One panel, one page; a tab strip is a
  second navigation and this product already has one.
- **Q2 — drag a rail item into the panel?** No. The menu is discoverable and a
  drag target on a 36 px cell is not.
- **Q3 — should a floating panel and a docked panel coexist?** Left closed
  (§3.3). It is a genuine product question, not an oversight, and answering it
  yes means deciding what "the panel" means everywhere else in this feature.

## 9. Removed

| Removed | Proof |
|---|---|
| `PipButton`, the hover affordance on each rail cell (plan 500 §4.5) | `rg -n "PipButton" packages/studio/src` → empty |

## 10. Handoff

To be written by the executing agent: the final geometry key shape, whether the
900 px cutoff felt right against the handoff's own breakpoints, and anything the
three-column layout did that this plan did not predict.
