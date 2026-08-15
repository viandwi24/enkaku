# Plan 101 — M66 : Visual refresh (the `refs/ui` direction)

> Status: not started
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

### 101.1 — Tokens and typography

`globals.css` §4.1's table; `fonts.ts` Outfit via `next/font`. No component
file edited. Verifiable result: `bun run --cwd packages/studio build`
succeeds, `design-rules.test.ts` still passes, and a screenshot of any
existing screen shows the new palette with no component changes — which is
the proof that §3.1's decision held.

### 101.2 — The shell

`AppShell.tsx`: collapse, float, radius, the one blur, persisted state,
tooltips on the collapsed rail. Verifiable result: `AppShell.test.tsx`'s
orphaned-page guard still passes (§3.5); collapsed state survives a reload;
every nav item reachable at 72px.

### 101.3 — The dot-grid background and surface pass

`globals.css` background layer (§3.7); a pass over `Card`/panel usages only
where the new surface values need a radius or border adjustment. Verifiable
result: no new colour literal anywhere — `design-rules.test.ts` plus a grep
for `#` hex in `packages/studio/src/**/*.tsx`.

### 101.4 — `docs/design.md`, rewritten to match what shipped

§Direction (§3.8's outcome, whichever way H3 goes), §Tokens' table, and
§Typography. **This step is not optional and not "documentation cleanup":**
`docs/design.md` is the file every future screen is built from, and a design
system whose own document argues against the palette it ships is worse than
having no document.

### 101.5 — Drag-box select and the context menu (behaviour, separable)

The device grid gains drag-rectangle multi-select and a right-click menu
(G15), reusing the existing selection state the bulk-operations toolbar
already drives, not a second one. Verifiable result: drag-select and
click-select produce the same selection set; the context menu's actions are
the toolbar's actions, not a divergent list.

### 101.6 — H1/H2/H3, and turning their results into decisions

Owner-run (§7). Exists so §3.6's blur rule and §3.8's background choice rest
on measurements rather than on this document's prose — the mistake plan 92
§7.3 and plan 100 §100.2 both made with numbers nobody measured.

---

## 6. Acceptance criteria

- [ ] No component file's colour classes changed in 101.1 — the palette moved entirely through `globals.css` (§3.1, G4).
- [ ] No hex literal is introduced anywhere under `packages/studio/src` outside `globals.css`.
- [ ] `design-rules.test.ts` passes; no Tailwind v3 bracket colour form anywhere (G18).
- [ ] `AppShell.test.tsx`'s orphaned-page guard passes — all sixteen nav items intact, Console/Recordings/Topology among them (§3.5, G9).
- [ ] `led-active` and `led-off` still exist and are still visually distinct from `led-ok`/`led-danger` on the new background (§3.2).
- [ ] `.readout` and `.status-rail` behave exactly as before (G13, G14).
- [ ] No `backdrop-filter` appears on any element rendered once per device (§3.6) — asserted by a test reading the wall/tile component sources, not by review.
- [ ] Fonts are self-hosted; no `fonts.googleapis.com` reference exists in the built output (§3.3, G12).
- [ ] The sidebar collapses, persists, and every item stays reachable at 72px.
- [ ] `docs/design.md` describes what actually shipped, including whichever way H3 went (§3.8, 101.4).
- [ ] `bun run typecheck`, `bun test`, `bun run --cwd packages/studio test`, `bun run --cwd packages/studio build` all green.

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
- **File contention with plan 100.** 100.5/100.6 hold `WallTile.tsx`, `LiveView.tsx`, `DeviceHeader.tsx`. Mitigated by sequencing (header of this plan) — and by §3.1, which keeps 101.1 out of component files entirely, so the largest visual step can land even while plan 100 holds those three.
- **The blur rule is stated here and enforced nowhere.** Mitigated by making it a test (§7, acceptance) rather than a paragraph — this register's own §96.22/§96.25 pattern is that a rule nobody re-checks stops being true.

## 9. Open questions

1. ~~**Does the wall-first ruling still hold?**~~ **ANSWERED, 2026-08-15 — no separate Dashboard.** The owner's words: *"wall first ga usah karena sekarang devices memang langsung nampilin semua device dalam mode casting semua."* Devices already IS the wall — every device renders live on arrival — so the reference's separate Dashboard screen (G10) would be a second front door onto data the first one already shows. Not built. The nav keeps sixteen items, not seventeen, and `/` stays the device grid.
2. ~~**Is the workflow canvas wanted, at G17's price?**~~ **ANSWERED, 2026-08-15 — yes, build it, with a graph library rather than by hand.** The owner asked for it explicitly and named React Flow as the kind of thing to use. That materially changes G17's price, which assumed a hand-rolled canvas: a library supplies the panning, zooming, edge routing, hit-testing and selection that most of those 2 500–4 000 lines were. **Moved out of this plan entirely** — it is a workflow feature, not a visual refresh, and folding an eight-step feature into a token migration would make neither reviewable. See **plan 102**.
3. **Does `#0a0a0a` win?** H3 settles it; §3.8 says `docs/design.md` gets rewritten either way.
4. **Should the collapsed sidebar be the default** on first load for a farm above some device count, or always operator-chosen? Now that the device grid is the landing screen and casts every device immediately (Q1), the case for opening collapsed is stronger than it was — but nobody has asked an operator, and this plan will not guess.
