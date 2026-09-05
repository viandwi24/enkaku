# Plan 500 — Shell : the picture-in-picture page panel

> Status: implemented (software) — G1-G3 and G5-G12 done and verified by their own commands 2026-09-05. G4 (the magnet) and G13 (how it feels to use) stay open: they are owner rows, and nothing in this repo can render a browser.
> Ships: packages/studio/src/components/shell/PipHost.tsx
> Depends on: plan 213 (the shell, rail and page panel); plan 216's `ActionDialogHost` and `DeviceControlHost` for the module-store pattern
> Spec references: §13 (Studio)

## 0. Goal checklist

| # | Goal | Parameter | Verified by | Done |
|---|---|---|---|---|
| G1 | A rail entry can be opened as a floating panel instead of a navigation | one affordance per eligible rail item | `rg -n "openPip" packages/studio/src/components/shell/Rail.tsx` → at least 1 match | [x] |
| G2 | There is exactly **one** panel, and opening another page switches its content in place | 1 host, 1 store value, no array | `rg -n "current|OpenRequest" packages/studio/src/components/shell/PipHost.tsx` → a single nullable value, no list | [x] |
| G3 | Devices is not eligible, and the exclusion is data, not a special case at the call site | `pip: false` (or absent) on the `/` entry in `NAV` | `rg -n "pip" packages/studio/src/components/shell/nav.ts` → the `/` entry is excluded | [x] |
| G4 | The panel is dragged by its title bar and snaps to a viewport edge within the magnet threshold | 20 px threshold, 4 edges, snap survives a window resize | owner smoke §7 step 2 | owner |
| G5 | Close, refresh, zoom out and zoom in are the panel's four controls | 4 buttons, in that order | `rg -n "aria-label=" packages/studio/src/components/shell/PipPanel.tsx` → 4 matches plus the drag handle's | [x] |
| G6 | Refresh reloads the framed document itself, never remounts the shell around it | `contentWindow.location.reload()` | `rg -n "location.reload" packages/studio/src/components/shell/PipPanel.tsx` → 1 match | [x] |
| G7 | Zoom scales the framed page and the frame keeps filling the panel | `transform: scale(z)` with inverse `width`/`height`; 5 steps, 50 %–150 % | `rg -n "scale\(" packages/studio/src/components/shell/PipPanel.tsx` → 1 match | [x] |
| G8 | Inside the panel the framed Studio renders **no rail, no status bar and no Device Control** | `?pip=1`; 3 suppressions | `rg -n "isPipFrame|pip=1" packages/studio/src` → `AppShell`, `DeviceControlHost` and the helper only | [x] |
| G9 | Position, size, zoom and the snapped edge survive a reload | 1 `localStorage` key, parsed through Zod, a bad value falls back to the default geometry | `rg -n "localStorage" packages/studio/src/components/shell/pip-store.ts` → 1 read, 1 write; `rg -n "safeParse" packages/studio/src/components/shell/pip-store.ts` → 1 match | [x] |
| G10 | The frame is loaded from `coreBase()`, not from a hand-built origin | 1 call | `rg -n "coreBase\(\)" packages/studio/src/components/shell/PipPanel.tsx` → 1 match | [x] |
| G11 | No Studio test file is added, and no `dark:` or v3 bracket colour class enters the shell | 0 each | `rg --files packages/studio -g '*.test.tsx'` → empty; `rg -n "dark:|bg-\[--|text-\[--" packages/studio/src/components/shell` → empty | [x] |
| G12 | `bun run typecheck` and `bun run build:studio` are clean | 0 errors, exit 0 | both exit 0 | [x] |
| G13 | The panel is usable: dragging is smooth, the magnet feels deliberate rather than sticky, and a switched page does not flash the previous one | owner judgement | owner smoke §7 | owner |

## 1. Goals

The owner's ask, 2026-09-05:

> "menu yang ada di sidebar itu bisa di mode picture in picture gitu, jadi nanti
> akan muncul floating panel yang bisa di geser, tapi dia punya magnet fitur
> biar dia bisa enak digesernya kalau di geser di pinggiran biar langsung
> sticky gitu. nah harapan saya di panelnya itu ada tombol close, refresh, sama
> zoom in zoom out."

An operator reading one screen while watching another, without giving up either.
Today the only way to see Jobs while working in Plugins is to navigate away and
back.

## 2. Non-goals

| Not done here | Where |
|---|---|
| **Devices in the panel** | never — decided by the owner 2026-09-05, §3.7 |
| More than one panel at a time | never — decided by the owner 2026-09-05, §3.2 |
| A panel that survives a full page reload as an OPEN panel | §9 Q1 — geometry persists, openness does not |
| Making `bun run dev:studio`'s hot reload reach inside the frame | never — §3.4's accepted consequence |
| Resizing by any edge but the bottom-right corner | §9 Q2 |
| Popping the panel out into a real browser window | §9 Q3 |

## 3. Context and design decisions

### 3.1 What exists today, cited

| Fact | Where |
|---|---|
| The shell renders `Rail`, then a column of `PagePanel` + `StatusBar` | `packages/studio/src/components/shell/AppShell.tsx:91-99` |
| The rail is data: a `NAV` array of `{ href, label, icon }`, plus `SETTINGS_HREF` and dynamic plugin groups | `packages/studio/src/components/shell/nav.ts:31-40` |
| Each rail item renders as a `next/link` | `packages/studio/src/components/shell/Rail.tsx:37-50` |
| **Device Control is already a floating window**, mounted once by the root layout so it survives navigation, with a module-level store rather than a context ("a context would force every page under the shell to re-render") | `packages/studio/src/components/device-control/DeviceControlHost.tsx:1-40` |
| That window drags with `mousedown` + document `mousemove`/`mouseup`, and is `fixed … z-50` | `packages/studio/src/components/device-control/DeviceControl.tsx:161-173`, `:198` |
| It does **not** persist its geometry — position and height reset on every reload | same file (no `localStorage` anywhere under `device-control/`) |
| The Escape tier stack and the outside-click listener are installed once, by `AppShell` | `packages/studio/src/lib/overlays.ts:32-100` |
| The WS client is a module singleton, one per document | `packages/studio/src/lib/ws.ts:392` |
| `coreBase()` resolves `NEXT_PUBLIC_ENKAKU_CORE_URL`, else the page origin, else `:7700` | `packages/ui/src/lib/core-base.ts`, re-exported from `packages/studio/src/lib/ws.ts` |
| **There is no `<iframe>` anywhere in Studio today** | `rg -n "<iframe" packages/studio/src packages/ui/src` → empty (2026-09-05) |
| The core sends **no** `X-Frame-Options` and no CSP `frame-ancestors` for the Studio export; `Content-Security-Policy: sandbox` exists only on workspace artefacts | `packages/core/src/api/workspace.ts:152`, `:260`; `packages/core/src/api/plugins.ts:429` |

### 3.2 One panel, and it switches

Decided with the owner, 2026-09-05: *"cukup satu panel aja … kalau dia udah buka
page plugin misalnya terus dia mau buka halaman workflow di panel yah panel
sekarang langsung switch aja."*

So the store holds **one nullable value**, exactly like `DeviceControlHost`'s
`OpenRequest`. Opening a second page retargets the panel; it does not stack, and
there is no list to reason about. This is why G2 is written as a shape
constraint rather than a behaviour: an array here would be the beginning of a
window manager nobody asked for.

### 3.3 The framed page is an iframe, not a mounted component

The alternative — rendering the target page's component into a portal — was
rejected on a fact, not a preference: **Studio's pages read the real URL.**
`scripts/page.tsx:32`, `settings/page.tsx:35-36`, `plugins/view/page.tsx:62` and
four others call `useSearchParams()`/`useRouter()`. A page rendered into a panel
while the address bar says something else would read the wrong parameters, and
fixing that means changing every page to take its parameters as props.

An iframe costs a second document, which means a second `ws` singleton and a
second WebSocket connection. With exactly one panel (§3.2) that is one extra
connection, which is the price of not refactoring seven pages.

It also makes G6 honest: **refresh is a real reload of that document**, not a
React remount that leaves module state behind.

### 3.4 The frame's `src` is `coreBase()`, and what that costs in dev

Decided by the owner, 2026-09-05: *"gapapa dia langsung pakai port core basenya
kalau di local kan 7700 udah itu aja abaikan aja bun studio dev nya yang di
3001."*

Consequence, recorded rather than discovered later: under `bun run dev:studio`
the shell runs on `:3001` but the frame loads from the core on `:7700`, which
serves the **last `bun run build:studio` output**. Editing a screen and watching
the panel will show the previous build until the export is rebuilt. This is
accepted, not a defect — but it belongs in the panel's own doc comment so the
next person does not spend an afternoon on it.

### 3.5 The magnet

A 20 px threshold against each viewport edge, evaluated on pointer-up, not
continuously: a panel that jumps while the pointer is still down feels like a
bug. When an edge is captured the panel stores which one, and a `window.resize`
re-pins it to that edge rather than leaving it stranded off-screen — which is
the one thing that makes edge-snapping worth having over free-form dragging.

Drag uses **pointer events with `setPointerCapture`**, not the `mousedown` +
document-listener pair `DeviceControl.tsx:161-173` uses. That older pair loses
the drag when the pointer leaves the window, and copying it forward would mean
fixing the same bug twice later.

### 3.6 Zoom is a transform, and the frame is sized against it

`transform: scale(z)` on the iframe with `width: 100 / z %`, `height: 100 / z %`
and `transform-origin: top left`. The inverse sizing is the whole trick: without
it, zooming out leaves the framed page occupying a shrinking rectangle in the
corner instead of showing **more** of itself, which is what an operator wants
from zoom-out on a responsive page.

Five steps, 50 % to 150 %. `zoom` as a CSS property would be shorter, but it
interacts badly with `position: fixed` inside the framed document, and Studio's
own dialogs are fixed.

### 3.7 Devices is excluded, and the exclusion is a data flag

Decided by the owner, 2026-09-05: *"khusus untuk devices itu ga bisa di jalankan
di fitur ini."*

The reason is worth writing down. The Devices screen mounts `DeviceControlHost`,
and a framed copy would mount a **second** one: a second scrcpy session against
the same phone, doubling that device's encode load for a picture the operator
already has in the existing floating window. The exclusion is therefore not
squeamishness about a busy screen; it is about not opening a duplicate session.

It lives as a flag on the `NAV` row (`pip: false`, or simply absent) so that
`Rail.tsx` asks the data rather than testing `href === '/'`. `?pip=1` suppressing
`DeviceControlHost` (G8) is the belt to that braces: even if a plugin nav entry
someday renders a device surface, no framed document can open a cast.

## 4. Steps

### 4.1 `nav.ts` — mark which entries may be framed

Add `pip?: boolean` to `NavItem`. Set it `true` on `/scripts`, `/jobs`,
`/agents`, `/plugins` and `SETTINGS_HREF`; leave it off `/`. Plugin nav items
inherit `true` — a plugin screen is an ordinary page.

### 4.2 `pip-store.ts` — one value, one subscriber list, persisted geometry

Mirror `DeviceControlHost`'s module store exactly: `current: PipRequest | null`,
a `Set<Listener>`, `setCurrent`, and a `usePip()` hook. `PipRequest` is
`{ href: string; label: string }` — the label is the panel's title, so the panel
never has to look it up.

Geometry (`x`, `y`, `w`, `h`, `zoom`, `edge`) is a separate concern with its own
`localStorage` key, read once on mount through a Zod `safeParse` and written on
pointer-up and on zoom change. A stored geometry that no longer fits the current
viewport is clamped, not discarded.

### 4.3 `PipPanel.tsx` — the window

`fixed`, `z-40` (below Device Control's `z-50`: the cast is the more important
picture), `rounded-window border border-border-2 bg-panel shadow-window` to match
the existing window. A 34 px title bar with the page's label, then the four
controls in order: **zoom out, zoom in, refresh, close**. The iframe fills the
rest; a bottom-right corner handle resizes.

The iframe's `src` is `` `${coreBase()}${href}?pip=1` `` and its `key` is the
`href`, so switching pages replaces the document rather than navigating inside
it — which is what makes a switch instant and stateless.

### 4.4 `AppShell.tsx` — mount the host, and learn the frame flag

Render `<PipHost />` as a sibling of the rail/column pair. Add a
`isPipFrame(searchParams)` helper; when true, `AppShell` renders **only** the
page panel — no rail, no status bar — and `DeviceControlHost` returns `null`.

### 4.5 `Rail.tsx` — the affordance

Each eligible item gets a small PiP button revealed on hover/focus, which calls
`openPip(item)` instead of navigating. It must not be nested inside the `Link`
(a button inside an anchor is invalid and swallows the click); render the link
and the button as siblings in the same relatively-positioned cell.

### 4.6 The Escape key

Register the panel with `registerOverlay` at a tier **below** dialogs, so
Escape closes an open dialog first and the panel only when nothing else is open.
A floating panel that vanishes on the Escape meant for a dropdown is worse than
one that ignores Escape entirely.

## 5. Verified references

- R1 — `transform: scale()` with inverse sizing is the portable page-zoom
  technique; the CSS `zoom` property mis-anchors `position: fixed` descendants.
- R2 — `setPointerCapture` keeps a drag alive when the pointer leaves the
  window; the `mousedown` + document-listener pattern does not.
- R3 — Same-origin framing needs no header change here: the core sets neither
  `X-Frame-Options` nor `frame-ancestors` on the Studio export (§3.1).

## 6. Acceptance

Every §0 row that is not `owner` passes its own command; `bun run typecheck` and
`bun run build:studio` are clean; no `*.test.tsx` is added.

## 7. Owner smoke

1. Open Jobs in the panel from the rail; confirm the rail, status bar and any
   cast window are absent **inside** the panel.
2. Drag it near each of the four edges; confirm it snaps at roughly a finger's
   width and stays pinned after resizing the browser window.
3. Zoom out twice; confirm more of the page is visible, not a smaller picture of
   the same amount.
4. Press refresh; confirm the framed page reloads and the outer app does not.
5. With the panel showing Plugins, open Scripts & workflows in it; confirm it
   switches in place with no flash of the previous page.
6. Confirm the Devices entry offers no PiP affordance at all.
7. Reload the browser; confirm the panel is closed but its geometry and zoom are
   remembered when reopened.

## 8. Tests

None. Studio and `@enkaku/ui` have zero tests by decision
(`docs/plans/200-mvp-program.md` §8.3), and this plan adds no backend code. The
whole feature is verified by `bun run typecheck`, `bun run build:studio`, the
greps in §0, and §7 — which is why §7 is written as seven concrete steps rather
than "check it works".

## 9. Open questions

- **Q1 — should the panel reopen itself after a browser reload?** Left closed.
  A panel that reappears over the screen an operator just navigated to is the
  kind of helpfulness that gets switched off; geometry is remembered so
  reopening costs one click.
- **Q2 — resize from any edge?** Bottom-right only for now, matching Device
  Control's single-axis handle. Four-edge resize is a bigger interaction than it
  looks once snapping is involved.
- **Q3 — a real pop-out window?** `window.open` would give a genuine OS window
  and a third WebSocket. Not now.

## 10. Removed

| Removed | Proof |
|---|---|
| — (this plan adds only) | |

## 11. Handoff

**Files.** `PipHost.tsx` and `pip-store.ts` (module store + geometry), `PipPanel.tsx`
(the window), `pip-frame.ts` (the `isPipFrame` helper), edits to `AppShell.tsx`,
`Rail.tsx`, `nav.ts`, `DeviceControlHost.tsx`, `packages/ui/src/icons.ts`, and
`scripts/check-design-tokens.ts` (the icon-count guard, widened by 3 for the
three icons this plan adds — the guard caught the omission on the first pass,
exactly as designed).

**The geometry key's final shape.** One `localStorage` key,
`enkaku:pip-geometry`, holding `{ x, y, w, h, zoom, edge }` — `x`/`y`/`w`/`h`
in px, `zoom` a number bounded to `[0.5, 1.5]` (not a literal-union enum: a
value from a future step table still clamps sanely rather than failing to
parse), `edge` one of `'left' | 'right' | 'top' | 'bottom' | null`. Read once
through `GeometrySchema.safeParse`, written on drag pointer-up, resize
pointer-up, and on every zoom-button click. A snapped panel is re-pinned to
its edge on `window.resize` via `repinToEdge`, then re-clamped to the new
viewport.

**Deviations from the plan's own §4 steps, and why:**

- **G2's stated grep targets the wrong file.** §0's G2 row says
  `rg -n "current|OpenRequest" packages/studio/src/components/shell/PipHost.tsx`,
  but §4.2 itself says the module store (`current`, the `Listener` type, the
  subscriber `Set`) belongs in **`pip-store.ts`**, mirroring
  `DeviceControlHost.tsx` in spirit but not in file layout — `PipHost.tsx` is
  kept as a thin render host (`usePipRequest()` + `usePip().close`), matching
  `DeviceControlHost`'s own render body rather than its whole file. The goal
  itself (exactly one nullable value, no array) is real and verified — just
  against `pip-store.ts`, not `PipHost.tsx`. Re-run as
  `rg -n "current|OpenRequest" packages/studio/src/components/shell/pip-store.ts`
  to see it.
- **Escape tier.** §4.6 says "a tier below dialogs" without naming one;
  `lib/overlays.ts` only has three tiers (`menu`, `window`, `selection`), and
  both `ActionDialog` and `DeviceControl` register at `window`. The panel
  registers at `selection` — the only tier below `window` — via
  `registerOverlay('selection', onClose)` in a plain `useEffect`, so an open
  dialog's Escape is consumed first and the panel only closes once nothing
  else is registered.
- **The icon set.** The plan names no icons. `MagnifyingGlassMinusIcon`,
  `MagnifyingGlassPlusIcon` and `PictureInPictureIcon` (Phosphor, already
  vendored at `@phosphor-icons/react` 2.1.10) were added to `@enkaku/ui`'s
  barrel and to `check-design-tokens.ts`'s `GROUP_3` allowlist, which asserts
  an exact total — an omission the guard is built to catch, and did.
- **Magnet margin.** §3.5 states the 20 px threshold but not how far inside
  the edge a snapped panel sits. Implemented as an 8 px gap
  (`EDGE_MARGIN_PX`) between the panel and the true viewport edge, matching
  the visual margin the shell's own root padding uses elsewhere
  (`AppShell.tsx`'s `p-[10px]`) closely enough to look intentional rather
  than flush-to-glass.
- **Default panel geometry.** Not specified by the plan. Opens at 480×360,
  bottom-right, pre-snapped to the right edge — a corner an operator's eye
  returns to least, chosen the same way `DeviceControl`'s own centred default
  was: a reasonable starting point with no owner input yet.

**What the framed document does that the plan did not predict:** nothing
observed — this was verified by build output and code inspection only (see
below), not by loading the panel in a browser, so "did not predict" cannot
yet be answered from real evidence. The one behaviour the plan itself flags
as a known cost (§3.4) — the frame's `src` is `coreBase()`, so under
`bun run dev:studio` the panel shows the last `build:studio` output, not a
live-reloading page — is documented in `PipPanel.tsx`'s own file comment and
was not re-verified in a browser either.

**Whether the magnet threshold survived contact with the owner's hand:**
untested — no browser session was run this pass (see the report's "never
exercised" list). The 20 px/8 px numbers are implemented exactly as specified
but unverified by touch.

**Verification actually run:** `bun run typecheck`, `bun run build:studio`,
`bun run scripts/check-design-tokens.ts` (not itself part of §0, but the
coordinator's own gate — it caught the icon-count omission on the first
pass), and every §0 grep. No `bun test` of any kind was run — this plan
touches no backend package.
