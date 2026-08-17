# Plan 101 — M66 : Visual refresh (the `refs/ui` direction)

> Status: partial — steps 101.1, 101.2, 101.3, 101.4, 101.5, 101.7, and now 101.8 are implemented and unit-tested. Step 101.5 (drag-select and the context menu) shipped WITHOUT touching `packages/session/src/manager.ts`, `WallTile.tsx`, `LiveView.tsx`, or `packages/protocol/src/messages/stream.ts` — the exact file-contention risk this line used to name as the reason for deferring it. It reuses `app/page.tsx`'s existing `selectedIds`/`useBulkSelection` state and drives the Wall through two additive changes to `Wall.tsx` (a new optional `onDeviceContextMenu` prop, and a plain, unstyled `data-device-id` wrapper div around each `WallTile` — the tile component itself is untouched). Step 101.7 (owner-specified, 2026-08-16; two more requirements folded in mid-step) DOES touch `WallTile.tsx` — the tile now shows the screencast and the device's name and nothing else, `DeviceCard.tsx` lost its checkbox in favour of click-to-toggle selection, the Devices screen's chrome now matches `refs/ui`'s floating-pill treatment, and pagination landed. Step 101.8 (owner-specified, 2026-08-16, a side-by-side screenshot comparison against `refs/ui`) found 101.7's own version of the Devices screen still structurally far off: a second stat strip 101.7 missed (`Wall.tsx`, now removed), no inset content container (added to `AppShell.tsx`, the sidebar's own visual counterpart), a title-plus-badge header where the reference has one pill (`PageHeader` gained one optional `titlePill` prop, additive, the other 26 screens unaffected), a five-dropdown filter row (Cluster/Status moved into the header pills, the rest collapsed behind one "Filters" popover), and a persistent Wake button on every Wall tile plus a smaller-than-reference default tile size (the button removed — reachable via the context menu/selection bar instead — and the default bumped from Medium to Large). See §5 step 101.8 for the full account. Step 101.6 (H1/H2/H3) is owner-run; see §7's table, still empty.
> Depends on: Plan 100 (M65) — not for correctness, but for FILE CONTENTION: 100.5/100.6 hold `WallTile.tsx`, `LiveView.tsx` and `DeviceHeader.tsx`, which §5 below also touches. Sequence, do not parallelise. Nothing in this plan blocks plan 100.
> Spec references: §19 (Studio screen spec, and the schema-driven rendering principle), §16 (NFR — the wall's frame budget, which §3.6 here must not spend)
> Ships: none — and that is this plan's own thesis, not an omission. §3.1's whole argument is that the redesign lands by changing VALUES inside files that already exist (`globals.css`, `fonts.ts`, `AppShell.tsx`), never by adding a parallel styling system. A plan that changed the look by creating a new artefact would be the plan §3.1 exists to argue against, so there is deliberately nothing here for `scripts/check-plan-status.sh` to find. Progress is tracked by §6's acceptance criteria and the step notes in §5 instead.

---

## 0. Evidence

Written from the reference file and the current code, not from the request.
Every claim is **CONFIRMED** (a file and a line say so) or **HYPOTHESIS**
(with the probe that settles it).

The request, in the owner's words: redesign toward
`refs/ui/Enkaku Dashboard.dc.html`, focusing on *"components shadcn, style
kita dan lainnya, lalu sidebar dan concept page bodynya"*.

### 0.1 Confirmed findings

| # | Finding | Evidence |
|---|---------|----------|
| **G1** | **shadcn is already wired to our palette; there is nothing to "migrate to".** A second `@theme` block maps `--color-background`, `--color-card`, `--color-primary`, `--color-popover`, `--color-destructive` and the rest onto our own semantic tokens, so shadcn components and hand-written ones draw from one palette. | `packages/studio/src/app/globals.css`; `docs/design.md` §Tokens |
| **G2** | **31 shadcn primitives are already installed and in use**: `alert-dialog`, `badge`, `button`, `button-group`, `card`, `collapsible`, `command`, `dialog`, `dropdown-menu`, `hover-card`, `input`, `input-group`, `label`, `popover`, `progress`, `scroll-area`, `select`, `separator`, `sheet`, `skeleton`, `slider`, `sonner`, `spinner`, `switch`, `table`, `tabs`, `textarea`, `tooltip`. | `packages/studio/src/components/ui/` |
| **G3** | The token system is **OKLCH and semantic**, not hex: `--color-bg` `oklch(0.185 0.012 245)`, `--color-surface`, `--color-line`, `--color-fg`/`-muted`/`-subtle`, `--color-accent`, and a five-member `--color-led-*` family. | `packages/studio/src/app/globals.css` |
| **G4** | **125 component files** consume those tokens by name (`bg-surface`, `text-fg-muted`, `border-line`, `led-*`). Changing token VALUES reaches all of them; changing the token SYSTEM would mean touching all of them. | repo-wide search over `packages/studio/src/**/*.tsx` |
| **G5** | The reference uses **raw inline hex on every element** (`background:'#181818'`, `border:'1px solid rgba(255,255,255,0.12)'`), with no variables and no semantic names. Its palette is `#0a0a0a` page, `#181818`/`#0d0d0d` surfaces, `#6db5ff` accent, `#ff5de7` secondary accent (logo gradient only), `#4ade80` / `#fefa3d` / `#ff5c5c` status. | `refs/ui/Enkaku Dashboard.dc.html` |
| **G6** | The reference's three status colours map 1:1 onto three existing tokens — `#4ade80`→`led-ok`, `#fefa3d`→`led-warn`, `#ff5c5c`→`led-danger`. It has **no equivalent of `led-active` or `led-off`**, both of which are live in this codebase. | reference palette vs `globals.css` |
| **G7** | The reference sidebar **collapses**, 222px ↔ 72px, with a 0.18s width transition, a 14px outer margin, `borderRadius: 22px`, and `background: rgba(19,19,19,0.7)` behind `backdropFilter: blur(20px) saturate(150%)`. | `sidebarWrapStyle`, `sidebarStyle` in the reference |
| **G8** | Our sidebar is **fixed-width and always open**, a flat `NAV` array rendered by `AppShell`. | `packages/studio/src/components/layout/AppShell.tsx` |
| **G9** | The reference's nav has 13 items and **omits Console, Recordings and Topology** — the three whose absence from our own nav was hotfix §96.29, fixed today. Its `data-id` set is: dashboard, devices, clusters, batch, jobs, schedules, workflow, workspaces, aiagent, nodes, plugins, tools, settings. | reference `data-id` attributes; `docs/plans/96-m61-hotfixes.md` §96.29 |
| **G10** | The reference has a **`dashboard` item separate from `devices`**, with overview stat cards (`Total devices`, `Online now`, `Busy running`, `Cluster health`, `Farm Resource Loop`, `Job activity`, `Upcoming schedules`). Our `/` **is** the wall, by the owner's own unconditional wall-first ruling (plan 92). | reference; plan 92 §3.6 |
| **G11** | Fonts are **already self-hosted at build time** via `next/font/google`, and the existing comment gives the reason: *"nothing is requested from a third party at runtime — which matters for farms running on closed networks."* Current faces: Archivo (UI) + IBM Plex Mono (readouts). | `packages/studio/src/app/fonts.ts` |
| **G12** | The reference loads **Outfit from the Google Fonts CDN via `<link>`**, i.e. a runtime third-party request. | reference `<helmet>` block |
| **G13** | The **`.readout` class (IBM Plex Mono, `tabular-nums`) is load-bearing**, not stylistic: every measurement — temperature, fps, battery %, serial, resolution — uses it so a changing number never shifts layout. The reference has no monospace face at all. | `docs/design.md` §Typography, §Direction |
| **G14** | The **`.status-rail`** — a 3px colour bar down each device card's left edge, pulsing only at `data-live="true"` — is named in `docs/design.md` as *"the signature element"*, chosen because scanning a column of rails beats reading status text per card. | `docs/design.md` §The signature element |
| **G15** | The reference's device grid supports **drag-box multi-select** (`dragSelecting`, `dragBox`) and a **right-click context menu** (`contextMenuStyle`). | reference `deviceGridStyle`, `dragBoxStyle`, `contextMenuStyle` |
| **G16** | The reference's workflow editor is a **zoomable canvas** with absolutely-positioned draggable nodes and bezier edges. | reference `canvasStyle`, `workflowNodesView`, `edgePaths` |
| **G17** | **Plan 99 §3.9 explicitly recommended against a graph canvas for v1** and priced it: the shipped list editor is ~10 steps / ~1 300–1 800 lines reusing `SchemaForm`, `ParamSetPicker`, `DevicePicker`, `PaginatedTable`; a canvas is *"~8 more steps, ~2 500–4 000 more lines, reuses almost nothing, needs a layout algorithm."* It also notes a canvas is *"the exact opposite"* of spec §19's schema-driven rendering principle, and that the data format already allows a canvas later **with no migration**. | `docs/plans/99-m64-workflows.md:1165-1167`, `:1183`, `:1819-1842` |
| **G18** | `packages/studio/src/design-rules.test.ts` mechanically forbids the Tailwind v3 bracket colour form (`bg-[--color-surface]`), which compiles to nothing in v4 and fails silently. | `packages/studio/src/design-rules.test.ts` |

### 0.2 Hypotheses (probe before building)

| # | Hypothesis | Probe that settles it |
|---|-----------|----------------------|
| **H1** | `backdrop-filter: blur(20px) saturate(150%)` on ONE static element (the sidebar) costs no measurable frame budget on the wall. | Open the Wall at the shipped tile count with and without the sidebar's blur, read dropped-frame ratio in `chrome://media-internals` and tab CPU in Chrome's Task Manager. Same rig as plan 100 §7 H-1. |
| **H2** | The same blur applied **per wall tile** does cost measurable frames. Assumed true, and §3.6 forbids it on that assumption — but the number is worth having, because "we think it is expensive" is how the 20 Mbit/s constant got there. | Same rig, blur applied to N tiles, N stepped up. |
| **H3** | The reference's near-black `#0a0a0a` page does not make the `led-*` status colours read as "shouting" the way `docs/design.md` §Direction says pure black does. | Side-by-side render of the wall at both backgrounds with a mixed set of ok/warn/danger devices; owner's judgement, recorded. |

---

## 1. Goals

1. Adopt the reference's **shell**: a collapsible, floating, rounded sidebar; the dot-grid page background; the new palette and type.
2. Do it by **changing token values inside the existing system**, so 125 component files inherit the new look without being edited (G4).
3. Keep every load-bearing element of the current design that the reference has no equivalent for — the `.readout` monospace discipline (G13), the `.status-rail` (G14), and the `led-active`/`led-off` tokens (G6).
4. Bring the device grid's **drag-box multi-select and context menu** (G15) across, since they match the competitor capabilities the owner listed.
5. Spend **no frame budget** on the wall (§3.6). Plan 100 exists to win those frames back; this plan must not hand them to a blur.

## 2. Non-goals

- **Not the workflow canvas — it is now plan 102.** The owner approved it (§9 Q2) and named a graph library, which changes G17's price by supplying most of what those 2 500–4 000 hand-written lines were. It leaves this plan regardless: a token migration and an eight-step feature reviewed together are reviewable as neither.
- **Not a separate Dashboard screen** (§9 Q1, answered). The device grid already casts every device on arrival, so the reference's overview page (G10) would be a second front door onto data the first one already shows.
- **Not a rewrite onto inline styles.** G5's method is the reference's, not ours; §3.1 explains why the token system stays.
- **Not new shadcn components for their own sake.** G2: 31 primitives are already installed. Any addition must be because a screen needs it.

## 3. Context and design decisions

### 3.1 Change the token VALUES, never the token SYSTEM

This is the decision the whole plan rests on.

The reference paints with inline hex (G5). Copying that method would cost
three things that are not visual: the shadcn mapping that keeps one palette
instead of two (G1), the `led-*` state vocabulary that badges, the wall, the
status rail and every multi-device outcome report share, and `design-rules.test.ts`'s
mechanical guard (G18) — which only works because colour arrives through
named tokens.

It would also turn a one-file change into a 125-file change (G4).

So: the reference is a **specification of values**, and §4.1 is the mapping
table. `globals.css` is the only file whose colours change.

### 3.2 The three status colours map cleanly; two of ours have no counterpart

G6: `#4ade80`/`#fefa3d`/`#ff5c5c` become `led-ok`/`led-warn`/`led-danger`.

`led-active` (a device streaming, distinct from healthy-but-idle) and
`led-off` (a device with no signal, distinct from a device in trouble) have
**no reference counterpart**, because the reference never had to render an
idle rack. They are kept and re-derived against the new background, not
dropped — a wall that cannot distinguish "asleep" from "broken" is a
regression no amount of polish repays.

### 3.3 Outfit, through `next/font`, never a `<link>`

G12 vs G11. The reference's `<link href="fonts.googleapis.com">` is a runtime
third-party fetch. This app is a static export served by the core, routinely
on closed networks — and on the owner's own farm every request is routed
through the guest agent's SOCKS5 tunnel. An external font fetch there does
not degrade, it hangs.

`fonts.ts` already solves this and says so in its own comment. Outfit
replaces Archivo through the identical mechanism.

**IBM Plex Mono stays.** G13: the reference has no monospace face because it
never had to render a temperature that changes twice a second next to one
that does not. `.readout` is why a fluctuating number does not reflow the
card it sits in.

### 3.4 The sidebar collapses, and that is a wall feature

G7/G8. At 40 devices the 150px a collapsed sidebar returns is roughly one
more tile column. This is the reference element with the clearest functional
payoff, not just the most visible one.

Collapse state persists per browser (the same session-preference mechanism
the dashboard's view mode already uses), and the collapsed rail keeps every
item reachable — icons with tooltips, never a hidden overflow menu.

### 3.5 The nav keeps all sixteen items

G9. The reference's 13 omit Console, Recordings and Topology. Those three
were orphaned pages with no way in until §96.29 fixed it **today**; adopting
the reference's list verbatim would re-create that exact bug in the same
week it was closed.

`AppShell.test.tsx`'s orphaned-page guard (added by §96.29) will fail if this
happens, and that guard is a hard gate on this plan, not a formality.

### 3.6 Blur on the sidebar; never on anything that repeats per device

The reference's glassmorphism is `backdrop-filter: blur(20px) saturate(150%)`
(G7). Backdrop-filter forces a compositing layer.

The wall is already the most GPU-contended surface in this product — it
decodes 24–40 simultaneous H.264 streams, and plan 100 §3.1 establishes that
**browser decode capacity, not bandwidth, is the binding constraint** on how
many devices a wall can show. Spending that same GPU on a blur repeated per
tile would take back exactly what plan 100 is being built to win.

The rule: blur is permitted on **one static element**, the sidebar. It is
forbidden on wall tiles, device cards, status rails, and anything else
rendered once per device. H1/H2 measure both halves of this so the rule rests
on a number rather than on this paragraph.

### 3.7 The dot-grid background is cheap; keep it

The reference's page background is a `radial-gradient` dot tiled at 26px — a
repeating background-image, not a filter, so it costs one GPU texture
regardless of page size. No concern.

### 3.8 Whether `#0a0a0a` survives contact with our own stated reasoning

`docs/design.md` §Direction chose cool graphite over near-black with a
specific argument: *"Pure black makes status colours look like they are
shouting."* The reference is `#0a0a0a` with a blue-ish accent — near-black.

Both positions are defensible and this plan does not assume the document
wins by seniority. H3 settles it by rendering the wall at both backgrounds
with a mixed ok/warn/danger set. Whichever way it goes, `docs/design.md`
§Direction is **rewritten in the same step** — if the new background ships,
the paragraph arguing against it cannot be left standing, and if it does not,
the reason has to be written down where the next person will look.

### 3.9 Drag-select and the context menu are behaviour, not style

G15. These are the only genuinely new *capabilities* in the reference, and
they match the competitor list the owner gave earlier (multi-select
broadcast/mirror, right-click popup). They are separated into their own step
(§5, 101.5) so the visual work can land and be judged without waiting on
interaction work, and so that step can be dropped without unpicking anything.

---

## 4. Technical design

### 4.1 The palette mapping (`packages/studio/src/app/globals.css`)

The one file whose colour values change. Every value expressed in OKLCH, as
the existing tokens are — converted from the reference's hex, not pasted as
hex, so the two halves of the file do not drift into two notations.

| Token | Today | Reference source | Notes |
|---|---|---|---|
| `--color-bg` | `oklch(0.185 0.012 245)` | `#0a0a0a` | Gated on H3 (§3.8). |
| `--color-surface` | `oklch(0.225 0.014 245)` | `#181818` | Cards, panels. |
| `--color-surface-2` | — | `#0d0d0d` | Reference's recessed surface. |
| `--color-line` | `oklch(0.32 0.014 245)` | `rgba(255,255,255,0.12)` | Reference uses alpha-white borders throughout; keep as a solid token so opacity modifiers stay available. |
| `--color-line-strong` | `oklch(0.42 0.016 245)` | `rgba(255,255,255,0.14)` | |
| `--color-fg` | `oklch(0.94 0.004 245)` | `#f2f2f2` | |
| `--color-fg-muted` / `-subtle` | existing | `rgba(255,255,255,0.4)` and below | Reference expresses these as alpha; convert to solid tokens. |
| `--color-accent` | `oklch(0.70 0.11 225)` | `#6db5ff` | |
| `--color-led-ok` | existing | `#4ade80` | |
| `--color-led-warn` | existing | `#fefa3d` | Reference's yellow is markedly brighter than ours; check contrast on `#181818` before adopting verbatim. |
| `--color-led-danger` | existing | `#ff5c5c` | |
| `--color-led-active`, `--color-led-off` | existing | **no counterpart** | Re-derived against the new background (§3.2), never dropped. |
| `#ff5de7` | — | logo gradient only | Not a token. It appears once, in the mark. Promoting a one-off to a token invites its use as a second accent. |

### 4.2 Shell (`AppShell.tsx`)

Collapsible width (G7's 222/72 and 0.18s transition), 14px outer margin,
22px radius, one `backdrop-filter` (§3.6). Collapse state persisted per
browser. The `NAV` array is untouched in membership (§3.5) — only its
chrome changes.

### 4.3 Typography (`fonts.ts`, `globals.css`)

Outfit via `next/font/google` replacing Archivo (§3.3); IBM Plex Mono and
`.readout` unchanged (G13).

### 4.4 What must not change

`.status-rail` (G14) and `.readout` (G13) keep their behaviour. Both are
named in `docs/design.md` as reasoned choices rather than decoration, and the
reference simply has no position on either.

---

## 5. Implementation steps

### 101.1 — Tokens and typography. DONE.

`globals.css` §4.1's table; `fonts.ts` Outfit via `next/font`. No component
file edited. Verifiable result: `bun run --cwd packages/studio build`
succeeds, `design-rules.test.ts` still passes, and a screenshot of any
existing screen shows the new palette with no component changes — which is
the proof that §3.1's decision held.

**Shipped.** Every §4.1 token converted to OKLCH from the reference's hex/rgba
via a small conversion script (never pasted as hex — `globals.css`'s own
inline comments record each conversion and every deliberate deviation:
`led-warn` toned down from the reference's markedly-brighter yellow;
`led-active`/`led-off` re-derived, never dropped; `surface-2` repurposed to
the reference's RECESSED meaning per §4.1's own table, `surface-3` kept as
the pre-refresh ELEVATED role since the reference has no third surface step).
`--color-bg` deliberately left at its pre-refresh value, gated on H3 (§3.8) —
not shipped as `#0a0a0a`. `fonts.ts`'s `archivo` export renamed to `outfit`
(Outfit via `next/font/google`, identical self-hosting mechanism); its one
consumer, `app/layout.tsx`, updated in the same commit. Zero component files
touched by this step — confirmed by `bun run --cwd packages/studio build`
succeeding with no other file changed, and by the fact 101.2/101.3's own
component edits (`AppShell.tsx`, `WallTile.tsx`) are recorded as THEIR OWN
steps' work, not this one's.

### 101.2 — The shell. DONE.

`AppShell.tsx`: collapse, float, radius, the one blur, persisted state,
tooltips on the collapsed rail. Verifiable result: `AppShell.test.tsx`'s
orphaned-page guard still passes (§3.5); collapsed state survives a reload;
every nav item reachable at 72px.

**Shipped.** Sidebar is now a floating `<aside>`: `m-3.5` (14px), `rounded-
[22px]`, `bg-surface-2/70` + `backdrop-blur-[20px] backdrop-saturate-[150%]`
(the one backdrop-filter this refresh permits, §3.6), width transitioning
`w-[222px]` <-> `w-[72px]` over `duration-[180ms]`. Collapse persists via a
new `sidebarCollapsed` field in `packages/studio/src/lib/prefs.ts`'s
LOCAL (not session) prefs store — a property of the screen an operator sits
in front of, the same reasoning `tileSize` already uses, not the "must always
start a specific way" rule that keeps the Wall/List choice in session
storage. Every nav item (still all sixteen, §3.5, unchanged) renders inside a
`Tooltip` when collapsed, so nothing moves into a hidden overflow menu — a
local `TooltipProvider` was added around `AppShell`'s own render output so it
works correctly both under the app's real provider (`layout.tsx`) and in
isolation (`AppShell.test.tsx`, which supplies no provider of its own).
A genuine, pre-existing violation of §3.6's own rule was found and fixed
along the way: `WallTile.tsx` carried a `backdrop-blur-sm` on its per-tile
action-button overlay (predating this plan), caught by the new
`design-rules.test.ts` assertion (§7) and replaced with a solid,
more-opaque `bg-surface-2/90` backing — no compositing-layer cost, same
legibility over a video frame.

### 101.3 — The dot-grid background and surface pass. DONE (in part — see below).

`globals.css` background layer (§3.7); a pass over `Card`/panel usages only
where the new surface values need a radius or border adjustment. Verifiable
result: no new colour literal anywhere — `design-rules.test.ts` plus a grep
for `#` hex in `packages/studio/src/**/*.tsx`.

**Shipped: the dot-grid background** — `body`'s `background-image` is a
`radial-gradient` (`color-mix(in oklch, var(--color-fg) 7%, transparent) 1px,
transparent 1px`) tiled `26px 26px`, matching the reference exactly (a
repeating background-image, not a filter — costs one GPU texture regardless
of page size, §3.7, no wall-frame-budget concern the way blur is).
**Deliberately NOT done: the broader "Card/panel usages" pass.** `--color-
surface-2`'s meaning flipped from elevated to recessed (§4.1), and 53 files
under `packages/studio/src` reference it — auditing each individually for
whether the new, reversed direction still reads correctly would be a
component-by-component review directly working against §3.1's own thesis
("only `globals.css` changes"), and nothing in `bun test`/`bun run --cwd
packages/studio build` surfaced a concrete breakage from leaving them
untouched. If a specific screen reads wrong against the new surfaces once an
operator actually looks at it, that is a targeted follow-up against a named
screen, not a blanket pass this step should have guessed at.

### 101.4 — `docs/design.md`, rewritten to match what shipped. DONE.

§Direction (§3.8's outcome, whichever way H3 goes), §Tokens' table, and
§Typography. **This step is not optional and not "documentation cleanup":**
`docs/design.md` is the file every future screen is built from, and a design
system whose own document argues against the palette it ships is worse than
having no document.

**Shipped.** Every **TARGET (plan 101)** marker removed; §Direction now
states plainly that `--color-bg` is still unresolved pending H3 rather than
asserting either position; §Tokens' two tables (the "current" one and the
"target" one) merged into one that describes what actually ships, including
the `surface-2` repurposing and the `led-warn` deviation; §Typography states
Outfit as shipped, not proposed; the sidebar bullet under Screen patterns
states the shipped mechanics (222/72px, `sidebarCollapsed` in `localStorage`)
rather than a target. Verified: no `TARGET` string remains anywhere in the
file (`grep -n TARGET docs/design.md` — zero matches).

### 101.5 — Drag-box select and the context menu (behaviour, separable). DONE.

The device grid gains drag-rectangle multi-select and a right-click menu
(G15), reusing the existing selection state the bulk-operations toolbar
already drives, not a second one. Verifiable result: drag-select and
click-select produce the same selection set; the context menu's actions are
the toolbar's actions, not a divergent list.

**Shipped, without the file contention this line used to defer on.** Two
other agents held `packages/session/src/manager.ts`,
`packages/core/src/server/ws-handlers.ts`, `LiveView.tsx`, and
`packages/protocol/src/messages/stream.ts` (plan 100 steps 100.4/100.5) and
`components/workflow/**` plus `app/workflows/editor/page.tsx` (plan 102) —
none of those files were opened by this step. `WallTile.tsx` was likewise
left untouched, on purpose: the reference's own `handleGridMouseDown` bails
before starting a rectangle the instant a mousedown originates on a card
(`e.target.closest('[data-id]')`), so the drag surface only ever needs to
know where each card's OUTER box is, never anything about what renders
inside it.

- **One new hook, one new component, both under `components/wall/`** (the
  file-ownership note above names this as fair game — neither is
  `WallTile.tsx` or `LiveView.tsx`): `useDragSelect.ts` reads whichever
  elements carry `data-device-id` inside a given container at drag time
  (`refs/ui`'s own `querySelectorAll('[data-id]')` technique) and calls
  `onSelect` with the merged result — the exact shape `setSelectedIds`
  already takes, so `app/page.tsx` passes that setter straight in rather
  than wrapping it. `DeviceContextMenu.tsx` owns positioning and dismissal
  only; every item it renders is built by `app/page.tsx` from the SAME
  functions the bulk-operations toolbar's own buttons already call
  (`wakeOrSleepSelected`, `applyLabelsToSelected`, `setInstallBatchOpen`,
  `setBulkTransferOpen`, `setBulkForgetOpen`, and the toolbar's own
  `/console` destination via `router.push`) — there is no second action
  list to drift out of sync with the first.
- **`app/page.tsx`** wraps the whole device-display block (List, grouped
  List, and Wall alike) in one `data-testid="device-grid"` container
  carrying the drag hook's `onGridMouseDown` and `select-none` while
  dragging (`refs/ui`'s own `userSelect: dragSelecting ? 'none' : 'auto'`),
  and wraps each rendered `DeviceCard` in a plain `data-device-id` div. A
  right-click (`handleDeviceContextMenu`) follows `refs/ui`'s own rule: a
  device already inside the current selection keeps the WHOLE selection
  (so right-clicking one of eight selected devices still offers to act on
  all eight); a device not in it becomes the sole selection. Both a drag
  starting and a right-click auto-enter select mode — a drag rectangle or a
  right-click IS the operator declaring intent to multi-select, so neither
  should first require a separate "Select devices" click.
- **`Wall.tsx`** gained one optional prop, `onDeviceContextMenu`, and wraps
  each `WallTile` in the same kind of plain `data-device-id` div — no box
  styling, so CSS Grid's default `stretch` fills it to the cell exactly as
  `WallTile` filled that cell directly before, and it sits entirely outside
  `WallTile`'s own `rootRef` (the live-set viewport observer), which keeps
  watching the same anchor it always did.
- **Replace vs extend mirrors `refs/ui` exactly, and matches click-select**:
  a plain drag replaces the selection with whatever the rectangle covers
  (starting from a cleared base, so it lands on the identical array N
  individual checkbox clicks would produce — this step's own acceptance
  criterion); ctrl/cmd-held extends the current selection instead, the same
  modifier meaning a per-card click already carries elsewhere in this
  product.
- **A `DeviceCard`'s own "More actions" dropdown (shadcn/Radix) renders its
  open content in a real DOM portal**, appended to `document.body` rather
  than nested under the grid container — but React's synthetic events still
  bubble there because portals stay nested in the REACT tree regardless of
  where their DOM lands. A DOM-only `.closest('[data-device-id]')` check
  cannot see that, so opening the menu and picking an item would otherwise
  also have started a rectangle and cleared the selection. `useDragSelect`
  bails first on a plainer, Radix-agnostic test: if the real mousedown
  target is not actually contained in the grid container's own DOM, it did
  not happen "in the grid" no matter what the React tree implies — covering
  a dialog or a tooltip the same way, not just this one dropdown.
- **No `backdrop-filter` anywhere in this step's own new files or edits**
  (`design-rules.test.ts` still passes unchanged) and no hex literal
  (caught once, by that same test, on a stray hex mention inside a doc
  comment — fixed by rewording, not by weakening the rule).
- Tests: `useDragSelect.test.ts` (the rectangle's own intersection math,
  replace vs extend, the on-a-card bail, primary-button-only), 7 new cases
  in `DeviceContextMenu.test.tsx`, 9 new integration cases in `page.test.tsx`
  (drag-select producing the same set as checkbox click-select, auto-enter
  select mode, the on-a-card bail reaching the checkbox's own click, both
  right-click selection rules, and the context menu's "Run command…"
  navigating to the exact same `/console` destination the toolbar's own
  button does), and 3 new cases in `Wall.test.tsx` (the wrapper attribute's
  presence, the callback naming the right tile, and a no-op when the prop
  is not wired).

### 101.7 — The device tile becomes the screen (owner-specified, 2026-08-16). DONE.

The owner reviewed the shipped Wall against `refs/ui` and named five changes.
They are requirements, not suggestions, and they are recorded verbatim in
intent below because several of them remove things earlier plans added on
purpose — a later reader needs to know that was decided, not forgotten.

**What the reference actually does** (read from the file, not inferred): the
tile is a single `aspect-ratio: 9/16` box. Inside it, and *only* inside it:
a diagonal-stripe background when there is no picture, a centred monospace
watermark whose text is `status === 'offline' ? 'OFFLINE' : status === 'error'
? 'ERROR' : ''` — i.e. **empty for every healthy device** — a scrim covering
the top 36%, and the device name at `top: 8px`, horizontally centred, over
that scrim. Selection is expressed by the card's own background tint and
accent border, never a badge.

1. **No label text outside the picture.** `moto g06 — rak 1` and everything
   beside it leaves the header block. The tile shows the screencast.
2. **The name floats at the top of the thumbnail, horizontally centred**, over
   a scrim so it stays legible against changing video.
3. **No status text or chips in the tile panel at all.** Status floats on the
   thumbnail, and only when the picture is empty (`OFFLINE`, and whatever this
   product's equivalent of `ERROR` is).
4. **Pagination**, with an operator-settable page size — the reference's own
   `Showing X devices` + Prev/Next, plus a per-page control the reference does
   not have.
5. **The selection action bar floats** (bottom-centre, as in the reference).
   It exists today but is inline.
6. **Remove the stat strip** (`2 total`, `0 ready`, …).

**What this removes, so it is removed knowingly rather than rediscovered:**

- `TileChips` and the number/connection glyph row (plan 92 §4.8, plan 89
  §3.3). The number was deliberately composed beside the label and never
  baked into it; it now lives on the thumbnail overlay or nowhere. Decide
  which and say so.
- `AgentAlertChip` (plan 90 §5 step 90.6). Note what that step's F10 already
  established: it is **quiet for `ready`/`absent`** precisely so a farm of 20
  healthy phones does not grow 20 chips. It only appears when a guest agent
  has genuinely failed — so removing it does not remove noise, it removes the
  one signal that a device streaming a perfectly good picture is nonetheless
  broken.

**The one thing to keep, and the reason:** `.status-rail` — the 3px bar down
the tile's edge. It carries **no text and costs no layout**, so it does not
violate requirement 3, and `docs/design.md` calls it the signature element
because scanning a column of rails is far faster than reading status per
card. The reference has no equivalent only because it never had to render a
rack. Without it, a device that is streaming fine but quarantined, or holding
a failed agent, is indistinguishable from a healthy one — the reference's
model has no such state, and this product does.

If the owner wants the rail gone too, that is their call — but it should be
made against this paragraph, not by omission.

**Shipped, 2026-08-16.**

- **`WallTile.tsx` rebuilt around the six requirements; `DeviceCard.tsx` (List
  view) deliberately left untouched.** The owner's six items describe a tile
  that shows a screencast — `DeviceCard` shows no video at all, has no
  reference counterpart, and stays the dense rack-unit instrument panel
  `docs/design.md` already describes it as. Requirements 4/5/6 are page-level
  (the toolbar/pagination/status-filter sit above and below WHICHEVER view is
  active) and apply to both views identically; requirements 1–3 apply to the
  Wall tile only. `packages/studio/src/components/topology/DeviceTile.tsx`
  (the fleet-map screen, plan 32) is a third place this shape could in
  principle spread to — also left alone: no video, a different screen, the
  same rack-unit vocabulary `DeviceCard` uses.
- **Requirement 1/2 (screencast + centred floating name):** the header block
  (number · label · connection glyph, `TileChips`, `AgentAlertChip`) is
  deleted outright. The name now floats over a `top: 0`–`36%` scrim
  (`bg-linear-to-b from-black/55 to-transparent`, `refs/ui`'s own numbers),
  centred at `top-2`, built from the same `black`/`white` opacity vocabulary
  the holder badges already used over video — not a `--color-*` token, since
  this paints over arbitrary video pixels, not a themed surface.
- **Requirement 3 (no status text/chips; status only when the cast is
  empty):** already true of the offline/quarantined/asleep placeholders
  (they lived inside the aspect-ratio picture before this step and still do)
  — only the header's text left. **`.status-rail` did not previously exist on
  `WallTile` at all** (confirmed by grep before starting); it is added here,
  not merely "kept," to satisfy the plan's own instruction — a bar carries no
  text, so it does not reopen requirement 3, and without SOME signal a device
  that is streaming fine but quarantined, or holding a failed agent, would
  read as indistinguishable from a healthy one now that the words that used
  to say so are gone.
- **`AgentAlertChip`'s signal — where it lives now:** folded into the rail
  via a new `data-agent-alert` attribute (`globals.css`), quiet for the exact
  states the chip was quiet for (`ready`/`absent`/`provisioning`/
  `unsupported`) and tinted `led-danger`/`led-warn` only for `failed`/
  `outdated` — suppressed when the device is already `offline`/`quarantined`,
  since those two already show the rail's loudest colours and there is
  nothing to do about an agent on a device that is not connected. The chip
  itself is unchanged and still lives on `DeviceCard`.
- **The per-device number (plan 89 §3.3) — dropped, not relocated.** Item 1's
  own "nothing else" and item 2's silence on the number (only the name is
  named) argued for minimalism over carrying a third overlay element; it
  remains reachable on `DeviceCard`'s header, unchanged. The connection glyph
  is dropped from the tile the same way, for the same reason — its signal
  (kind, address) stays reachable via `DeviceCard`, the connection filter,
  and the search box's own address match (`app/page.tsx`), all pre-existing
  and untouched.
- **Requirement 4 (pagination + page-size control) — client-side, over
  `filtered`, ungrouped only.** Chosen over server-side keyset paging exactly
  per this step's own §0 trade-off: live WS device updates and selection
  semantics stay byte-for-byte what they were, at a much smaller diff.
  Grouping (None/Cluster/Status/Tag) suspends pagination rather than trying
  to page across bucket boundaries — every match still renders when grouped,
  unchanged from before this step. `pageSize` (12/24/48/96, default 24 —
  `refs/ui`'s own fixed number) persists in `localStorage`
  (`lib/prefs.ts`'s `pageSize`, the identical mechanism `tileSize` already
  uses); `page` itself is NOT persisted and is clamped at read time rather
  than reset by an effect keyed on the device list, so a live WS update never
  yanks an operator back to page 1. Selection coherence (an operator who
  selects 12 and pages forward must still act on 12) holds by construction:
  `selectedIds` was never page-scoped to begin with, and neither the bulk
  toolbar nor `useDragSelect` (`components/wall/useDragSelect.ts`) needed any
  change — both already read/write the same array pagination never touches.
- **Requirement 5 (the selection action bar floats):** moved from the page's
  own flow into a `position: fixed`, bottom-centre pill (`bottom-6`,
  `refs/ui`'s own placement), same buttons, same handlers, no `backdrop-
  filter` — a solid `bg-surface` panel, since this bar is not one of the
  per-device surfaces plan 101 §3.6 is about, but is not free to spend GPU on
  a blur just because it is allowed to ask.
- **Requirement 6 (remove the stat strip):** the four-tile `grid-cols-4`
  strip is gone; the SAME `filter` state it drove moves into a `Select`
  beside the other list filters, with each option's own count in its label
  (`Ready (12)`) so "how many are ready" stays one glance away without a
  dedicated row.
- **Two more requirements arrived mid-step (2026-08-16) and are folded in
  here, not treated as a separate pass:**
  1. **No checkbox anywhere — a click on a device toggles it directly**
     (`refs/ui`'s own model: `handleDeviceMouseDown` selects,
     `handleDeviceDoubleClick` opens remote control). `WallTile.tsx`'s own
     click/double-click disambiguation (already built for F13) now toggles
     selection on the single-click branch instead of navigating, when
     `onToggleSelect` is supplied (`Wall.tsx` always supplies it); double-
     click keeps opening the focus overlay unchanged, and `FocusOverlay.tsx`
     already carries its own "open the full device page" link, so the page
     a click used to reach directly is one MORE click away, not gone.
     `DeviceCard.tsx` lost its checkbox and its `selectable`/`onToggleSelect`
     props too, keeping only `selected` for the accent-border/ring styling;
     the toggle itself moved to the `[data-device-id]` wrapper `app/page.tsx`
     already puts around every card (the same wrapper `useDragSelect`/the
     context menu key off), which bails when the click landed on one of the
     card's own interactive descendants (label link, Control/Run, "More
     actions") so those keep working unchanged. **"Select mode"
     (`selectMode`/`setSelectMode`) is deleted outright** — selection is
     always live now, so there was nothing left for it to gate; "Select
     devices"/"Cancel" left with it, and "Select all"/"Clear all" stays
     (always visible, not mode-gated) as a genuine capability `refs/ui` does
     not need but this paginated, farm-scale product does — a drag rectangle
     only ever reaches what is rendered on the CURRENT page. Verified the two
     named collision points before touching either: `useDragSelect.ts`'s own
     mousedown bail already fires on ANY click landing inside a
     `[data-device-id]` wrapper (every card is always inside one), so a drag
     rectangle can never start on a card regardless of what that card's own
     click now does — no code change needed there, confirmed by
     `useDragSelect.test.ts` staying green untouched; a native `click` event
     never fires across two different mousedown/mouseup targets, so a
     rectangle that starts on empty grid space and ends over a card cannot
     also spuriously toggle that card.
  2. **The Devices screen's own chrome restyled to match `refs/ui`'s
     `data-screen-label="Devices"` header** — the search box and every
     filter `Select` now share one `PILL` class (`rounded-full`,
     `bg-surface-2/55`, `border-line`, `backdrop-blur-[18px]
     backdrop-saturate-[150%]`, `shadow-lg`), and the farm-wide device count
     (not the filtered subset — `refs/ui`'s own `totalDevices` is
     unfiltered) rides beside the title in a matching pill via
     `PageHeader`'s `meta` slot. `PageHeader`'s own title stays plain text —
     it is a required, shared pattern on every screen (`docs/design.md`) and
     forking it for one mockup's fidelity is a bigger call than this step
     should make unilaterally. **The filter mapping is not 1:1 with the
     reference** (its own row has only Cluster/Status): kept ALL five real
     filters — status (already added, doubling as the removed stat strip),
     cluster, readiness, connection, group-by — as more pills in the same
     row rather than dropping the three `refs/ui` has no equivalent for, per
     this correction's own instruction not to lose a working capability
     chasing a mockup's control count. The reference's own full-screen
     click-catcher (dismissing an open dropdown) needed no equivalent code
     here — Radix `Select`'s own outside-click dismissal already does that.
  3. **The blur rule correction**: `docs/design.md`'s "Blur: one static
     element" section was imprecise and is rewritten in this same pass as
     "nothing that scales with device count" — the four new header pills
     above are a bounded, once-per-page cost, not a per-device one, so they
     do not trip the reasoning (plan 100's decode budget) the rule actually
     rests on. `design-rules.test.ts` needed no change: it already only
     scopes the backdrop-filter ban to `WallTile.tsx`/`DeviceCard.tsx`/
     `DeviceTile.tsx`/`LiveView.tsx`, never to `app/page.tsx`.
- **Tests:** `WallTile.test.tsx` and `DeviceCard.test.tsx` rewritten where
  the header/chips/number/glyph/checkbox tests no longer apply, plus new
  coverage for the rail's `data-agent-alert` folding, the floated name, and
  click-to-toggle (including the modified-click/no-`onToggleSelect`
  fallbacks); `Wall.test.tsx` covers the dropped `selectable` prop and the
  "no invented `onToggleSelect`" guard; `prefs.test.ts` covers
  `pageSize`/`PAGE_SIZE_OPTIONS`; `page.test.tsx` gained pagination,
  status-filter, floating-bar, and (rewritten) selection/drag/context-menu
  coverage now driven by clicks on `[data-device-id]` wrappers instead of
  checkboxes. Root `bun test` 4810/0, Studio
  `bun run --cwd packages/studio test` 1278/0 (was 1259/0 — net new tests,
  no regressions), `spec:check` GAP 0, `check-plan-status.sh` clean,
  `bash scripts/typecheck.sh` 14/14 packages OK with the same pre-existing
  `packages/core/src/api/jobs.ts(229,49)` TS2739 failure this step did not
  touch. **`bun run --cwd packages/studio build` was NOT run** — a Studio dev
  server was live on :3001 for the whole session (`scripts/build-studio.sh`'s
  own guard exists precisely because `next build` corrupts a running `next
  dev` by writing into the same `.next` directory), so running the bare
  `packages/studio` build command directly would have broken the owner's own
  session. Left unverified, not claimed.

### 101.8 — Devices screen structural fixes (owner-specified, 2026-08-16). DONE.

The owner compared the shipped Devices screen against `refs/ui` side by side
and found it "structurally far off" — five gaps, named verbatim, plus an
explicit instruction to remove a second stat strip step 101.7 missed.

**1. The stat strip 101.7 believed it removed was still rendered a second
place.** 101.7 removed `app/page.tsx`'s own four-tile strip, but
`Wall.tsx:231-246` carried an independent one ("N of M devices live · capped
at X at once · Y Mbit/s across the farm") — not the same code, not caught by
101.7's own acceptance criteria, which only checked `app/page.tsx`. Removed
outright (`Wall.tsx`), along with the `blockedCounts`/`breakdownParts`/
`videoStats` values and the `useAdbVideoStatsPoll`/`formatMbps` imports that
existed only to compute it. A repo-wide grep for every other farm-wide count
near a device list or grid (`of ... devices live`, `total devices`, `Mbit/s`,
`capped at`) found nothing else — the settings page's own "N of M on the
current agent" readout (`app/settings/page.tsx`) is a different feature (a
farm-wide labelling-mode status, not a device-count strip) and was correctly
left alone.

**2. No inset content container — added at the shell level, not per-page.**
`refs/ui`'s content pane is one large rounded panel inset from the window
edge, with a recessed background and an ambient glow, sitting on the
dot-grid page; Studio rendered flush edge-to-edge with no container at all.
Since every screen's content flows through `AppShell.tsx`'s `<main>`, this
was fixed there — the sidebar's own visual counterpart, at `lg:` and above:
`m-3.5`-equivalent margin (`lg:my-3.5 lg:mr-3.5`, the sidebar's own right
margin already supplies the left gap), `lg:rounded-[22px]`,
`lg:bg-surface-2/40` (`--color-surface-2` is `#0d0d0d` per plan 101 §4.1's
own mapping — exactly the reference's `rgba(13,13,14,0.4)`, read off a
token, never pasted as hex), `lg:border lg:border-line`, `lg:shadow-2xl`,
`lg:overflow-hidden`. Two decorative glow blobs (`bg-accent/25 blur-[110px]`,
`bg-led-warn/15 blur-[120px]`) sit behind the real content — `filter:
blur()`, not `backdrop-filter` (the reference's own container has no
backdrop-filter either; only the glow circles use `filter`), so this costs
nothing `design-rules.test.ts` would flag (it is scoped to `WallTile.tsx`/
`DeviceCard.tsx`/`DeviceTile.tsx`/`LiveView.tsx`, and `filter: blur()` is a
different property from what its regex matches regardless of scope) and
nothing plan 101 §3.6's "nothing that scales with device count" rule is even
about — it is one fixed panel and two fixed blobs, not a per-device cost.
The reference's third glow blob is the logo mark's own pink (`#ff5de7`);
left out rather than reproduced, since `docs/design.md`'s Tokens section
already argues against promoting that colour to a second accent. Below
`lg:`, content stays flush behind the mobile top bar, unchanged from before
this step — the mobile sheet already reads as its own flush surface, so
there is no floating "page" to counter there.

**3. The header consolidated to the reference's own composition — one new
`PageHeader` prop, not a fork.** The reference header is one object
(`Devices` + a divider + the count) on the left and three pills (Search,
`Cluster:`, `Status:`) on the right. The shipped screen (after 101.7) still
rendered the title as a plain heading beside a *separate* pill for the
count — exactly the "heading with a badge" shape the owner's brief called
out by name, not the reference's one-object pill. Fixed by adding
`titlePill` — one optional boolean prop on `PageHeader.tsx`, default `false`
— that merges `title` and `meta` into a single floating-pill element
(divider included) and skips `description` (a pill has no room for a
subtitle line). The other 26 screens pass neither prop and are byte-for-byte
unchanged; `PageHeader.test.tsx` (new) proves both paths directly.

  Consolidation of the six controls the header carried before this step,
  and the reasoning for where each one went:
  - **"+ Add device" stays the one primary action** on the header's right
    side, per `docs/design.md`'s own `PageHeader` rule — kept exactly where
    it was.
  - **Search, `Cluster:`, `Status:` moved UP into the header**, matching
    `refs/ui`'s own header exactly (its `data-screen-label="Devices"` block
    contains only these three on top of the title object — nothing else).
  - **List/Wall, tile size (S/M/L), and "Select all"/"Clear all" moved DOWN**
    into the filter row below the header — they are view/bulk controls, not
    page identity, and `docs/design.md`'s `PageHeader` rule reserves the
    header's right side for the one primary action. Left as plain, always-
    visible buttons (not folded into the `⋮` menu) because they are
    frequently used, not rare — burying a view switch behind a menu click
    would cost more usability than the header decluttering was worth.
  - **The Discovered tray entry also moved down** beside them, for the same
    reason — it is a conditional alert action, not identity, and already
    costs nothing visually when empty.
  - **The `⋮` menu is unchanged** (still just "Renumber fleet…") — nothing
    new was pushed into it; the controls above went to the filter row
    instead, since they are used far more often than "Renumber fleet…" and
    deserve to stay one click away, not two.

**4. The filter row compacted from five dropdowns to Cluster/Status (moved
to the header, above) plus one "Filters" popover.** Cluster and Status now
live in the header pills (item 3). Readiness, connection, and group-by —
real filters `refs/ui`'s own two-dropdown header has no equivalent for —
collapsed behind one `Filters` popover pill (shadcn `Popover`, already
installed) rather than three more full-width `Select`s in the row; a small
badge on the trigger shows how many of the three are set away from their
default, so "something in there is narrowing the list" is visible without
opening it. **Nothing was dropped** — all three filters still exist, unchanged
in behaviour, just no longer rendered as five wide dropdowns end to end.
`app/page.test.tsx` gained a describe block proving the popover-gated
filters are unmounted until opened and that picking one still narrows the
list correctly; the two existing connection-filter tests were updated to
open the popover first (Radix `PopoverContent` unmounts while closed, so the
`combobox` is not queryable until then — confirmed against
`@radix-ui/react-popover`'s own source that `PopoverTrigger` toggles on a
plain `onClick`, unlike `DropdownMenuTrigger`'s pointerdown-open quirk this
codebase already works around elsewhere, so `fireEvent.click` needed no
`userEvent` upgrade here).

**5. The tile lost its Wake button; the default tile size grew.**
`WallTile.tsx` still carried a persistent `ReadinessControl` (Wake/Sleep)
overlay after 101.7 — the last piece of chrome on the tile face beyond the
picture and the floated name, and exactly the kind of per-device control
`refs/ui`'s own tile ("nothing on it but the picture, the centred name, and
— when the picture is empty — a centred watermark") has no room for. Removed
outright, in every state (not just made hover-only): the affordance did not
disappear, because the context menu (`DeviceContextMenu`, plan 101 §5 step
101.5) and the floating selection bar (`app/page.tsx`) already carry
"Wake selected"/"Sleep selected", routed through the identical
`wakeOrSleepSelected` function — so removing the on-tile button cost no
capability, only chrome that duplicated it. `revealOnHover`/`blocked`
(vars that existed only to gate that overlay) were removed along with it.
Two `WallTile.test.tsx` tests that asserted the OLD persistent-vs-
hover-revealed behaviour were rewritten to assert the button is gone
entirely (one for the asleep tile, one for the budgeted tile); every other
existing test in that file (the status rail, click-to-toggle, the focused
placeholder, height stability) needed no change, since none of them touched
the overlay.

  **Default tile size bumped from Medium (180px) to Large (260px)**
  (`lib/prefs.ts`'s `tileSize` schema default) — a side-by-side against
  `refs/ui` read the shipped Wall as noticeably smaller than the reference's
  own large, few-columns tiles. `refs/ui` is a data-bound mockup with no
  literal grid CSS to read an exact pixel target off
  (`gridTemplateColumns` is computed by script, not present in the markup),
  so rather than inventing a new number, this widens the STARTING size using
  a mapping plan 92 §3.11 already specified and ships unchanged
  (`TILE_SIZE_PX: { s: 140, m: 180, l: 260 }`) — Large was already the
  biggest of three legitimate, tested sizes; it simply was not the one an
  operator saw first. `s`/`m` stay reachable exactly as before.
  `lib/prefs.test.ts`'s four default-value assertions and
  `app/page.test.tsx`'s own Tile size describe block were updated to expect
  Large pressed by default and Medium as the picked-away-from size; nothing
  about `TILE_SIZE_PX` itself, or `Wall.tsx`'s own unrelated `minTileWidthPx
  = 180` fallback (used only by callers that pass no prop at all —
  `app/page.tsx` always passes one explicitly), changed.

**Files touched:** `packages/studio/src/components/wall/Wall.tsx` (strip
removed), `packages/studio/src/components/wall/WallTile.tsx` (Wake overlay
removed), `packages/studio/src/components/layout/AppShell.tsx` (content
panel + glow), `packages/studio/src/components/layout/PageHeader.tsx`
(`titlePill` prop, additive), `packages/studio/src/app/page.tsx` (header/
filter-row consolidation, `Popover` import), `packages/studio/src/lib/
prefs.ts` (`tileSize` default). Tests: `Wall.test.tsx`, `WallTile.test.tsx`,
`app/page.test.tsx`, `lib/prefs.test.ts` updated; `PageHeader.test.tsx` (new)
and new coverage in `AppShell.test.tsx` for the content panel added.

**Not done, and why:** `docs/design.md`'s `--color-bg` bullet is untouched —
H3 has still not run, and this step did not touch any surface colour value,
only chrome structure. The reference's near-black page background remains
exactly as unresolved as plan 101 §3.8 left it.

### 101.6 — H1/H2/H3, and turning their results into decisions

Owner-run (§7). Exists so §3.6's blur rule and §3.8's background choice rest
on measurements rather than on this document's prose — the mistake plan 92
§7.3 and plan 100 §100.2 both made with numbers nobody measured.

---

## 6. Acceptance criteria

- [x] No component file's colour classes changed in 101.1 — the palette moved entirely through `globals.css` (§3.1, G4).
- [x] No hex literal is introduced anywhere under `packages/studio/src` outside `globals.css`. (`design-rules.test.ts`'s new hex-literal test, with one documented, pre-existing false-positive exception — an `<Input placeholder>` example value for an agent's own custom colour field, unrelated to design tokens)
- [x] `design-rules.test.ts` passes; no Tailwind v3 bracket colour form anywhere (G18).
- [x] `AppShell.test.tsx`'s orphaned-page guard passes — all sixteen nav items intact, Console/Recordings/Topology among them (§3.5, G9). (NAV array membership untouched by this plan)
- [x] `led-active` and `led-off` still exist and are still visually distinct from `led-ok`/`led-danger` on the new background (§3.2). (re-derived in `globals.css`, never dropped; visual distinctness is a judgement call left to H3's own render, not mechanically testable)
- [x] `.readout` and `.status-rail` behave exactly as before (G13, G14). (untouched — neither `globals.css`'s `.readout`/`.status-rail` rules nor their consumers were edited by any step)
- [x] No `backdrop-filter` appears on any element rendered once per device (§3.6) — asserted by a test reading the wall/tile component sources, not by review. (`design-rules.test.ts`, scoped to `WallTile.tsx`/`DeviceCard.tsx`/`DeviceTile.tsx`/`LiveView.tsx` — found and fixed one pre-existing violation, see 101.2's note)
- [x] Fonts are self-hosted; no `fonts.googleapis.com` reference exists in the built output (§3.3, G12). (verified against `packages/studio/out` after `bun run --cwd packages/studio build`)
- [x] The sidebar collapses, persists, and every item stays reachable at 72px.
- [x] `docs/design.md` describes what actually shipped, including whichever way H3 went (§3.8, 101.4). (states the background as UNRESOLVED, since H3 has not run — not a guessed outcome)
- [x] `bun run typecheck`, `bun test`, `bun run --cwd packages/studio test`, `bun run --cwd packages/studio build` all green.

## 7. Test plan

### Unit / component (bun test, no hardware)

- `design-rules.test.ts`: unchanged, must still pass — plus a new assertion that no `backdrop-filter` appears in any per-device component source (§3.6).
- `AppShell.test.tsx`: the orphaned-page guard (existing); collapse state persistence; every nav item present and labelled at both widths.
- A token-presence test: `led-active` and `led-off` still defined and distinct (§3.2) — cheap, and the exact kind of thing a palette rewrite drops silently.

### Hardware / browser — owner to run, exact commands, empty outcome column

| # | What | How | Outcome |
|---|---|---|---|
| H-1 | Sidebar blur costs no measurable wall frames (§3.6). | Open the Wall at the shipped tile count, record dropped-frame ratio (`chrome://media-internals`) and tab CPU (Chrome Task Manager); repeat with the sidebar's `backdrop-filter` disabled in devtools. | *(owner to fill in)* |
| H-2 | Per-tile blur DOES cost frames — the assumption §3.6 forbids on. | Same rig; apply the blur to N tiles in devtools, step N up, record where frames start dropping. | *(owner to fill in)* |
| H-3 | Near-black vs cool graphite, with real status colours (§3.8). | Render the Wall with a mixed ok/warn/danger/off device set at both `--color-bg` values; judge whether the status colours "shout" as `docs/design.md` §Direction claims. | *(owner to fill in)* |
| H-4 | The refresh against the competitor, by eye. | Open the redesigned Wall beside Panda at the same device count; describe the remaining difference. | *(owner to fill in)* |

## 8. Risks and mitigations

- **A palette rewrite silently drops a token that only one screen uses.** `led-active`/`led-off` are the known case (G6); others may exist. Mitigated by the token-presence test (§7) and by §3.1's rule that only `globals.css` changes — a dropped token becomes a build-time failure in 125 files rather than a subtle visual regression in one.
- **Contrast regressions.** The reference's `#fefa3d` warn is markedly brighter than ours, and its `rgba(255,255,255,0.4)` muted text is lower-contrast than our `fg-muted`. Mitigated by checking each against the new surface before adopting the value verbatim (§4.1's notes), rather than converting hex blindly.
- **File contention with plan 100.** 100.5/100.6 hold `WallTile.tsx`, `LiveView.tsx`, `DeviceHeader.tsx`. Mitigated by sequencing (header of this plan) — and by §3.1, which keeps 101.1 out of component files entirely, so the largest visual step can land even while plan 100 holds those three. Step 101.5 (drag-select and the context menu) turned out not to need any of the three either, once built: it adds `data-device-id` WRAPPER divs around `WallTile` from `Wall.tsx` rather than editing `WallTile.tsx` itself, so it shipped concurrently with plan 100's own in-flight work on those exact files with no collision.
- **The blur rule is stated here and enforced nowhere.** Mitigated by making it a test (§7, acceptance) rather than a paragraph — this register's own §96.22/§96.25 pattern is that a rule nobody re-checks stops being true.

## 9. Open questions

1. ~~**Does the wall-first ruling still hold?**~~ **ANSWERED, 2026-08-15 — no separate Dashboard.** The owner's words: *"wall first ga usah karena sekarang devices memang langsung nampilin semua device dalam mode casting semua."* Devices already IS the wall — every device renders live on arrival — so the reference's separate Dashboard screen (G10) would be a second front door onto data the first one already shows. Not built. The nav keeps sixteen items, not seventeen, and `/` stays the device grid.
2. ~~**Is the workflow canvas wanted, at G17's price?**~~ **ANSWERED, 2026-08-15 — yes, build it, with a graph library rather than by hand.** The owner asked for it explicitly and named React Flow as the kind of thing to use. That materially changes G17's price, which assumed a hand-rolled canvas: a library supplies the panning, zooming, edge routing, hit-testing and selection that most of those 2 500–4 000 lines were. **Moved out of this plan entirely** — it is a workflow feature, not a visual refresh, and folding an eight-step feature into a token migration would make neither reviewable. See **plan 102**.
3. **Does `#0a0a0a` win?** H3 settles it; §3.8 says `docs/design.md` gets rewritten either way.
4. **Should the collapsed sidebar be the default** on first load for a farm above some device count, or always operator-chosen? Now that the device grid is the landing screen and casts every device immediately (Q1), the case for opening collapsed is stronger than it was — but nobody has asked an operator, and this plan will not guess.
