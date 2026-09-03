# Handoff: Enkaku Openpf — Farm Console (Devices, Jobs, Scripts, Plugins, Settings)

## Overview
Enkaku ("Enkaku Openpf" / "Enkaku — Open Phone Farm") is a desktop-and-web console for controlling an
Android phone farm over ADB. This bundle covers the whole console shell as designed so far:

- **Devices** — every phone on the farm, in a dense table or a screen-mirror grid, with cluster tabs,
  discovery of phones that are not yet on the farm, multi-select + bulk actions, and a floating
  **Device Control** window (live cast, hardware shortcuts, actions, UI inspector, per-device jobs/files).
- **Scripts & workflows** — the scripts plugins register, and workflows that chain them.
- **Jobs** — job/batch history with a full detail view: inputs, output, logs, replay timeline, artifacts.
- **Plugins** — installed plugins, their status, the scripts they register, and lifecycle actions.
- **Settings** — two-column settings with grouped navigation.

## About the Design Files
`Enkaku Device List.dc.html` is a **design reference created in HTML** — an interactive prototype showing
the intended look and behavior. It is not production code to port line-by-line. The task is to
**recreate these designs inside the target codebase's own environment** (React, Vue, Svelte, Tauri +
web UI, etc.) using its established component patterns, state management, and styling approach.
If the app does not have a UI environment yet, pick the most appropriate stack and implement there.

The prototype is a single self-contained page: a template plus a logic class, all styling inline, all
data mocked deterministically. Treat the logic class as a **behavior spec**, not an architecture
proposal — real data comes from the daemon/ADB.

`Enkaku Device List v1 terminal.dc.html` is an **earlier, rejected dark-terminal styling** of the same
Devices screen. It is included only as history; do not implement it.

## Fidelity
**High-fidelity.** Colors, typography, spacing, radii, and interaction states are final and should be
matched closely. Both light and dark themes are specified via CSS custom properties (below). Layout is
desktop-first (designed at ~1280–1600px wide, usable down to ~960px); no mobile layout was designed.

---

## Global shell

**Root:** `height: 100vh; display: flex; gap: 10px; padding: 10px; background: var(--bg)`.
Two children: the icon rail, then a column holding the active page panel and the status bar.

**Icon rail** — `width: 60px`, `background: var(--panel)`, `border: 1px solid var(--border)`,
`border-radius: 16px`, `padding: 10px 0 12px`, `gap: 6px`, centered column. No logo; the first item is
the first nav entry.

Nav items: 36×36, `border-radius: 10px`, icon 17px. Active = `background: var(--accent-soft)`,
`color: var(--accent)`. Idle = `color: var(--faint)`, hover `background: var(--muted-2)`, `color: var(--text)`.

| Order | Icon (Phosphor regular) | Title | Page |
|---|---|---|---|
| 1 | `ph-devices` | Devices | `devices` |
| 2 | `ph-code` | Scripts & workflows | `scripts` |
| 3 | `ph-lightning` | Jobs | `jobs` |
| 4 | `ph-puzzle-piece` | Plugins | `plugins` |

Then `flex: 1` spacer, then: **theme toggle** (`ph-moon` in light / `ph-sun` in dark, title
"Switch to dark mode" / "Switch to light mode"), **Settings** (`ph-gear`, opens the `settings` page),
and an avatar chip — 30×30, `border-radius: 999px`, `background: var(--avatar-bg)`,
`color: var(--avatar-fg)`, 11px/600, initials "RZ".

A **dynamic menu section** is planned: plugins may register their own view pages, appended under the
static nav. Not yet designed — needs the plugin manifest shape (label, icon, route, position).

**Status bar** (bottom, every page) — `height: 44px`, `background: var(--panel)`,
`border: 1px solid var(--border)`, `border-radius: 14px`, `padding: 0 8px 0 14px`, items separated by
1px×18px `var(--line-2)` dividers:

1. Pulsing 7px dot `var(--ok)` (`enkakuPulse`, 2.6s) + "System OK" (12px, `var(--text-3)`).
2. Scrollable stat row: `Devices 58/64` (value 12.5px/600 `var(--accent)`), `Jobs 12/17`
   (value 12.5px/600 `var(--text)`) — running/total where total includes queued.
3. Console toggle (`ph-terminal-window`) and Alerts (`ph-bell` with a 6px `var(--danger)` dot).
4. Clock, `Geist Mono` 12px `var(--text-3)`, ticking every second.

**Page panels** all share: `flex: 1; background: var(--panel); border: 1px solid var(--border);
border-radius: 16px; overflow: hidden`.

---

## Screen: Devices

**Toolbar** — `height: 58px`, `padding: 0 12px`, `border-bottom: 1px solid var(--line)`, `gap: 10px`.

*Left — cluster tabs:* a pill container that shrinks to its content (`flex: 0 1 auto`, `padding: 4px`,
`background: var(--muted)`, `border-radius: 999px`, `gap: 4px`, horizontal scroll when needed).
Each tab: `padding: 7px 14px`, `border-radius: 999px`, 12.5px; active = `background: var(--panel)`,
`box-shadow: 0 1px 3px #00000014`, weight 600; idle = `color: var(--dim)`. Each tab shows its device
count after the label (11px, `var(--faint)`, `margin-left: 7px`). First tab is **All**; the rest come
from the cluster list (Farm A, Farm B, Farm C, Rack 01, Rack 02).

Immediately right of the container: **add-group button** — 30×30 circle, `border: 1px dashed
var(--border-3)`, `ph-plus` 14px; hover turns accent. Opens a small popover (224px, `top: 40px`,
right-aligned) titled "New group" with a text input, **Create** (accent) and **Cancel** buttons;
Enter submits, Escape cancels. Names are uppercased and spaces become dashes (`Farm D` → `FARM-D`).

**Right-click a cluster tab** (not All) opens a 188px dropdown at that tab's x-offset with
**Rename group** (`ph-pencil-simple`) and **Delete group** (`ph-trash`, `var(--danger)`). Rename opens
the same popover pre-filled; delete removes the cluster and falls back to All if it was active.

*Right — controls:*
- **Discovered (N)** pill: `padding: 7px 13px`, `border-radius: 999px`, `border: 1px solid
  var(--border-2)`, `background: var(--panel-2)`, `ph-tray-arrow-down` + label. Opens the discovery sheet.
- Icon buttons, 32×32, `border-radius: 10px`, idle `color: var(--faint)`, hover
  `background: var(--muted-2)`; active (menu open or filter applied) = `background: var(--accent-soft)`,
  `color: var(--accent)`:
  - **Search** (`ph-magnifying-glass`) → 300px popover with a `var(--muted)` input
    ("serial, label, model, task"), a match count and **Clear**. Matches name, serial, model, group, task.
  - **Filter** (`ph-funnel`) → 216px menu: All, Free, Running job, Unauthorized, Disconnected, each with
    a status dot, count, and a `ph-check` on the active one.
  - **View** (`ph-rows` / `ph-squares-four`) → 200px menu with **Table** and **Screens**; when Screens is
    active the menu also shows a **Card width** control (label + px value) with presets S 112 / M 146 /
    L 190 / XL 240.
  - **Rescan** (`ph-arrows-clockwise`): spins (`enkakuSpin`, 0.9s) for 1400ms.

All popovers close on outside click (`[data-menu-root]` containment test) and on Escape.

### Table view
Horizontal scroller, `min-width: 1324px`. Sticky header row: `height: 38px`,
`background: var(--panel-2)`, `border-bottom: 1px solid var(--line)`, 11px `var(--faint)` labels.

Grid columns:
`38px 44px 1.3fr 108px 92px 138px 70px 74px 62px 62px 62px 76px 1.1fr`
→ checkbox · **#** · Device · Serial · OS · Endpoint · Batt · Temp · CPU · Mem · Disk · Uptime · Task.

Rows: `height: 54px`, `border-bottom: 1px solid var(--muted-2)`, hover `background: var(--hover)`.
Selected row: `background: var(--accent-soft)` + `box-shadow: inset 2px 0 0 var(--accent)`.
Disconnected rows render at `opacity: 0.6` and show `—` for every metric.

- **Checkbox**: 16×16, `border-radius: 5px`, `border: 1.5px solid var(--border-3)`; checked =
  `background: var(--accent)`, white `ph-check`. Header checkbox selects/clears all filtered rows.
- **#**: system row number, `Geist Mono` 11.5px `var(--faint)`, zero-padded (01, 02 …), follows the
  filtered order.
- **Device**: status dot (8px) + name (13px/500) over model (11px `var(--faint)`).
- **Serial / Endpoint**: `Geist Mono` 12px.
- **Batt**: value only (no progress bars anywhere in the table), colored `<20% var(--danger)`,
  `<45% var(--warn)`, else `var(--accent)`.
- **Temp**: `var(--danger)` above 42°, else `var(--text-3)`.
- **Task**: pill, `padding: 3px 9px`, `border-radius: 999px`, 11.5px —
  script running = `var(--accent-soft)`/`var(--accent)`; system action = `var(--warn-soft)`/`var(--warn)`;
  queued = `var(--muted-2)`/`var(--dim)`; idle = plain `var(--faint-2)` text, no pill.

There is **no per-row actions column** — actions come from selection (see Bulk actions) or Device Control.

### Screens view (card grid)
`display: grid; grid-template-columns: repeat(auto-fill, minmax(<cardWidth>px, 1fr)); gap: 12px;
padding: 14px`, `user-select: none`.

Card: `padding: 6px`, `border-radius: 16px`, `border: 1px solid var(--line-2)`; selected =
`border-color: var(--accent)`, `background: var(--accent-soft)`. **No checkbox** — the card itself is
the selection target.

Inside: a 9:19.5 screen box, `border-radius: 12px`. Live devices get a flat `var(--muted-2)` surface
(placeholder for the real Android cast); non-live get a 135° 6px stripe pattern at `opacity: 0.7`.
Overlays:
- Top, centered, over a `linear-gradient(to bottom, var(--panel-a), transparent)`: device name
  (12px/500) and serial (`Geist Mono` 10px `var(--faint)`).
- Center text **only when not live**: "Disconnected" or "Unauthorized" (11px; unauthorized in `var(--warn)`).
  A connected device shows no center text — the cast fills the box.
- Bottom-left **state dot**: 9px circle, `box-shadow: 0 0 0 3px var(--panel-a)`. Green `var(--ok)` = free,
  amber `var(--warn-2)` = someone is controlling it, red `var(--danger)` = a job is running,
  grey `var(--faint-2)` = disconnected, `var(--warn)` = unauthorized. **Hover the dot** for a dark
  tooltip (`var(--tooltip-bg)`/`var(--tooltip-fg)`, `border-radius: 8px`, 10px) naming the reason:
  "Job · tiktok_warmup.py", "Controlled by rz@studio", "Free · idle", "Last seen 12m ago".
- No percentages anywhere on the card.

The same state mapping drives the table's status dot, so table and grid never disagree.

### Selection
Identical in both views:
- **Single click** toggles select/unselect. The click handler is deferred 200ms and cancelled by a
  double-click so double-clicking never leaves a stray selection.
- **Marquee drag** anywhere in the list area draws a `1px solid var(--accent)` /
  `var(--accent-a1)` box (`border-radius: 6px`) and selects every intersecting row/card. Holding
  **Shift / Ctrl / Cmd** unions with the existing selection; otherwise it replaces it. A 5px threshold
  distinguishes a drag from a click.
- **Ctrl/Cmd + A** selects everything currently filtered (ignored while Device Control is open or while
  typing in an input).
- **Escape** is tiered: close any open popup/menu first; if nothing is open, clear the selection.

### Bulk actions (floating, bottom-right of the panel)
Appears only when something is selected: a pill — `height: 40px`, `padding: 0 16px`,
`border-radius: 999px`, `background: var(--accent)`, `color: var(--on-accent)`,
`box-shadow: 0 10px 24px var(--accent-a3)` — reading "**N selected**" with a caret. It is
**click-to-open**, not always-expanded. Beside it, a 40×40 circular `ph-x` button
(`background: var(--panel)`, `border: 1px solid var(--border-2)`; hover turns `var(--danger)`) clears
the selection.

Opening it reveals a 226px menu above the pill (`border-radius: 14px`,
`box-shadow: 0 20px 50px #00000026`) headed "Bulk action" + **Clear**, listing the **generic action set**.

### Generic action set (one list, used everywhere)
The same twelve actions appear in the bulk menu and in Device Control → Actions, so selecting one
device and selecting twenty behave identically:

`Reconnect` (`ph-arrows-clockwise`) · `Disconnect` (`ph-plugs`) · `Install apk` (`ph-download-simple`) ·
`Adb command` (`ph-terminal`) · `Run script` (`ph-play`) · `Screenshot` (`ph-camera`) ·
`Sleep` (`ph-moon`) · `Move group` (`ph-folder-simple`) · `Upload file` (`ph-upload-simple`) ·
`Clear cache` (`ph-broom`) · `Settings` (`ph-gear`) · `Forget` (`ph-trash`, `var(--danger)`).

Rows: `padding: 9px 10px`, `border-radius: 10px`, 13px, hover `background: var(--muted)`.

### Console (floating)
Toggled from the status bar. `position: absolute; left/right: 14px; bottom: 14px; height: 190px;
max-height: calc(100% - 90px)`, `border-radius: 14px`, `box-shadow: 0 20px 50px #00000024`.
Header (40px): `ph-terminal-window` accent, "Console", event count, "adb · logcat stream", close ✕.
Body: `Geist Mono` 11px rows — time `var(--faint)`, level (36px wide, 500;
INFO `var(--accent)`, WARN `var(--warn)`, ERR `var(--danger)`, DEBUG `var(--faint)`), device, message.

### Discovery sheet (right sheet)
Opened by the Discovered pill. `position: fixed; inset: 0` scrim `var(--scrim)`; panel
`width: 452px; height: 100%`, `background: var(--panel)`, `border-left: 1px solid var(--border)`,
slides in from the right. Clicking the scrim or ✕ closes it.

- Title "Discovered" (16px/600) and body copy: *"Phones adb can see that are not part of the farm. Add
  one to make it schedulable, or dismiss it — a dismissed phone is not blocked, it just comes back here
  the next time it connects."*
- Row above the divider: "Missing a phone? Rescan checks adb directly, right now." + **Rescan** button
  (shares the toolbar's spin state).
- One card per phone: `border: 1px solid var(--border-2)`, `border-radius: 14px`, `padding: 12px 13px 13px`
  — model (13px/600), endpoint (`Geist Mono` 11.5px `var(--dim)`), "Android 10 · waiting since 13d ago"
  (11.5px `var(--faint)`), a ✕ dismiss button top-right, and **Add to farm** bottom-right
  (`padding: 8px 13px`, `border-radius: 10px`, `background: var(--muted)`, `border: 1px solid
  var(--border-2)`) which becomes a non-interactive "Added" chip in `var(--accent-soft)`/`var(--accent)`.
- The pill's counter only counts phones still un-added. Empty state: *"Nothing waiting — every phone adb
  can see is already on the farm."*

**Important product rule:** a phone visible to ADB is **not** automatically on the farm. It appears in
discovery and must be explicitly added before it can be scheduled.

---

## Floating window: Device Control

Opened by **double-clicking** a device (table row or card). Deliberately **not a modal**: there is no
backdrop and the page stays fully interactive — the operator can keep scrolling, filtering, and
selecting while it is open.

- `position: fixed`, centered via `top/left: 50%` + a translate that also carries the drag offset;
  `height: calc(100vh - 48px)`, `max-height: 640px`, `border-radius: 18px`,
  `box-shadow: 0 30px 80px #00000033`, `background: var(--panel)`, `border: 1px solid var(--border-2)`.
- **Draggable** by either header strip (`cursor: grab`; mousemove/mouseup on `document`).
- **Width follows the device's screen aspect ratio**: `max(560 * (w/h) + 36, 380) + 52 + 274` px, so the
  cast column fits the panel height without overflowing.
- Escape closes it and resets the drag offset.
- Double-clicking a **different** device switches the window to it. If that device was already part of
  the selection the selection is kept (host just moves); if it was not, the selection collapses to
  just that device.

**Three columns.**

1. **Shortcut rail** — `width: 52px`, `background: var(--panel-2)`. 34×34 buttons, `border-radius: 10px`,
   16px icons, `var(--dim)`: Power, Volume up, Volume down, Mute, Back, Home, Recents, Rotate,
   Brightness, Clipboard (`ph-power`, `ph-speaker-high`, `ph-speaker-low`, `ph-speaker-slash`,
   `ph-caret-left`, `ph-circle`, `ph-square`, `ph-clock-counter-clockwise`, `ph-sun`, `ph-clipboard`).

2. **Cast column** — `background: var(--muted)`. A 40px stats strip on `var(--panel)` (all items
   `flex: none`, `white-space: nowrap`): green dot + "Streaming", "5.3 fps", resolution (`Geist Mono`),
   "H.264", and right-aligned "524 ms". Below, the cast surface: the device's exact aspect ratio,
   `border-radius: 18px`, `border: 1px solid var(--border-2)`, `box-shadow: 0 8px 24px #00000014`.
   Live = clean surface labelled "Android cast · 1080x2400"; offline/unauthorized = stripe pattern with
   the state text. **No instructional caption under the cast** — hints live in the drag tooltip only.

3. **Info column** — `width: 274px`.
   - Header (44px): state dot · `#11` (11px `var(--faint)`) · **DEV-011** (14px/600, uppercased) ·
     spacer · **[i]** info button · ✕ close. Hovering the dot shows the same state tooltip as the cards
     ("Job running · tiktok_warmup.py", "Held 4:55", "Free · idle", "No link") — the state is expressed
     by the dot, never by a stray text label.
   - **[i] popover** (306px): "This device" — cluster, stable id, endpoint, api level, screen, density,
     guest agent — then "Active engines" — transport `ADB (USB)`, video `scrcpy (H.264, low latency)`,
     input `scrcpy UHID (hardware-like)`, inspection `UI server (persistent)` — and a **Change** button.
   - Meta strip: battery (colored, 500), temperature, Android version.
   - **Compact tabs** (chips, `padding: 4px 10px`, `border-radius: 7px`, 12px; active
     `background: var(--accent-soft)`, `color: var(--accent)`): **Actions · Inspector · Device**.
     They are intentionally small — a full segmented control ate the space the content needs.
   - **Actions** — the generic action set, same order, same icons.
   - **Inspector** — three stacked parts: **Snapshot** (a small 9:19.5 thumbnail with the selected
     node's bounds drawn as a `1.5px solid var(--accent)` / `var(--accent-a2)` rectangle, plus a
     **Capture** action), **UI nodes** (an indented, clickable tree — 12px indent per depth,
     `Geist Mono` 11.5px, selected row `var(--accent-soft)`), and **Node details** (class, resource id,
     text, bounds, clickable, enabled, package, depth).
   - **Device** — a generic container tab, not one tab per feature. Inside, a small chip switch selects
     the section: **Jobs** or **Files** (more sections can be added here without touching the tab bar).
     - *Jobs*: the device's jobs, unfiltered (no All/Running chips — that belongs on the Jobs page).
       Each row: state dot + script name + a sub-line (step and %, queue position, or finish time).
       Opening one shows a **compact** detail — state badge beside the name, progress bar when running,
       then just Job id / Trigger / Started / Duration — with **Stop | Cancel | Re-run** plus **Logs**
       buttons and an **Open full detail** button that navigates to the Jobs page for that job.
     - *Files*: an on-device browser — breadcrumb (`sdcard / Download`, segments clickable),
       "N items · X% free", **Upload file**, then rows with type icons (`ph-folder-simple` amber,
       `ph-image`, `ph-package`, `ph-film-slate`, `ph-file`), name, size · time, and a trailing caret
       (folders) or `ph-dots-three` (files). Folders navigate.
   - When more than one device is selected, a **host banner** sits under the meta strip:
     `background: var(--warn-soft)`, `border-radius: 10px`, `ph-broadcast` + "**Host device**" +
     "Mirroring input to N other selected devices · N+1 under control". The double-clicked device is
     the host; input mirrors to the rest of the selection.

---

## Screen: Scripts & workflows

Header: title "Scripts & workflows" (15px/600) + a subtitle that changes per tab, and a primary button
(**New script** `ph-file-plus` / **New workflow** `ph-flow-arrow`) — `background: var(--accent)`,
`color: var(--on-accent)`, `border-radius: 10px`.

Tabs (`padding: 7px 12px`, `border-radius: 9px`, 13px, active `var(--accent-soft)`/`var(--accent)`):
**Scripts** and **Workflows**, each with a count. Below, a search field on `var(--muted)`
(`border-radius: 10px`) with a right-aligned "N shown".

**Scripts table** — `min-width: 780px`, columns `1.6fr 92px 104px 104px 78px 86px` →
Name · Latest · Versions · Published · Enabled · Actions. Rows 48px,
`border-bottom: 1px solid var(--muted-2)`. Name is `Geist Mono` 12.5px and always
`plugin/script` (e.g. `mikrotik-routing/verify-egress`) so the plugin half is searchable.
**Enabled** is a 34×19 switch (`border-radius: 999px`; on = `var(--accent)` with the 15px knob right,
off = `var(--border-3)` with the knob left). **Actions** is a single **Run** (`ph-play`, accent, hover
`background: var(--accent-soft)`). Footer: "1–10 of 12" (`Geist Mono` 11px) + prev/page/next controls
(26×26, `border-radius: 8px`, `border: 1px solid var(--border-2)`; disabled = `var(--faint-2)`).

**Workflows** — cards, `grid-template-columns: repeat(auto-fill, minmax(276px, 1fr))`, `gap: 10px`,
`border: 1px solid var(--line-2)`, `border-radius: 14px`. Name (13px/600) + state badge
(active `var(--accent-soft)`, paused `var(--warn-soft)`, draft `var(--muted-2)`), a one-sentence
description (11.5px `var(--dim)`, `line-height: 1.55`), the step chain as `Geist Mono` 10.5px chips on
`var(--muted)`, then a footer line ("12 devices · daily 07:00") with a **Run** link.

---

## Screen: Jobs

Jobs and batches share one page — same shape, different scope. The tab strip **is** the page header
(no separate "Jobs / N total" title above it): `padding: 10px 14px`,
`border-bottom: 1px solid var(--line)`, tabs **Jobs** (63) and **Batches** (21) with counts.

Below, two columns.

**Left list** — `width: 268px`, `border-right: 1px solid var(--line)`.
- Filter chips, **wrapping** (never a clipped scroll row): All · Running · Queued · Success · Failed,
  each with a count; `padding: 5px 10px`, `border-radius: 8px`, active `var(--accent-soft)`.
- Rows: state dot + name (`Geist Mono` 12px) on the first line, with the sub-line indented 14px beneath
  ("step 4 of 12 · 34%", "position 1 · est 4m", "19:58 · 12m 41s", "element not found · 17:32").
  Selected row = `background: var(--accent-soft)`.
- Footer: "1–12 of 63" + prev/next (26×26). **12 rows per page**; changing tab or filter resets to page 1.

**Right detail** —
- Header (`min-height: 58px`, wraps): the script name (`Geist Mono` 15px/500) with the **state badge
  beside it on the same line** (never a badge to the left of a multi-line block), the meta line beneath
  ("job_8f21c4 · dev-011 · schedule · 20:40 · running 3m 08s", single line, ellipsized), and a
  `flex: none` button group pushed right by `margin-left: auto`: **Re-run** (accent tint),
  **Open device**, **Export**.
- Sub-tabs (`padding: 6px 11px`, `border-radius: 9px`, 12.5px + icon):
  **Inputs** `ph-sign-in` · **Output** `ph-sign-out` · **Logs** `ph-list-dashes` ·
  **Timeline** `ph-film-strip` · **Artifacts** `ph-images`.

**Inputs / Output** — a JSON snapshot rendered as a node tree, not raw text: header
("Input snapshot" / "Output snapshot"), size + capture moment ("1.4 KB · captured at start"), and a
**Copy JSON** action. Body on `var(--panel-2)`, `border: 1px solid var(--line-2)`,
`border-radius: 12px`; each node indents 16px per depth with a `ph-caret-down` (object/array) or
`ph-dot-outline` (leaf), the key in `Geist Mono` `var(--text)`, the value colored by type
(string `var(--accent)`, number `var(--warn)`, boolean `var(--warn-2)`, null/collection `var(--faint)`),
and the type name at the right edge in 10px `var(--faint-2)`.

**Logs** — level chips (All/info/debug/warn/error with counts) then a bordered table,
`border-radius: 12px`, alternating `var(--panel-2)` rows: time (74px, `Geist Mono` 11px), level
(52px, 11px/600, colored), scope (92px, `var(--dim)`), message (`Geist Mono` 11.5px `var(--text-3)`).

**Timeline** — the replay debugger, four stacked cards (`border: 1px solid var(--line-2)`,
`border-radius: 12px`):
1. *Transport*: 30×30 accent play/pause button, a 1×/2×/4× segmented control on `var(--muted)`,
   a centered readout ("+3.181s · prepare · app.forceStop"), a right-aligned "event 10 of 18", and a
   6px scrub track (`border-radius: 99px`, `var(--muted-2)`) with an accent fill and a 14px knob
   (`background: var(--panel)`, `border: 2px solid var(--accent)`). Clicking the track snaps to the
   nearest event.
2. *Lanes*: "+0ms" / "+12.922s" bounds, then three 18px lanes on `var(--muted-2)` with 58px uppercase
   labels — **Phase** (proportional blocks: reset `var(--warn-2)`, prepare `var(--faint)`,
   run `var(--accent)`, label inset in `var(--panel)` text), **Actions** (4px ticks per event; current
   = `var(--text)`, retry = `var(--warn)`, else accent; clickable, tooltip "name · +3.181s"),
   **Logs** (grey `var(--border-3)` clusters).
3. *Frames*: "Frames · 18 events · frames captured per action" and a horizontal strip of 76px 9:19.5
   thumbnails, each with its timestamp and action name; the current frame gets a
   `2px solid var(--accent)` border. Clicking a frame moves the playhead.
4. *Frame + Event*: a 168px column showing the current frame large, beside an event panel — action name
   (`Geist Mono` 13px), an `ok`/`retry` badge, the timestamp, then phase / attempt / duration / seq /
   ui nodes rows, and an **Arguments** note: *"Recorded already redacted — typed text and clipboard
   writes store only a length."*

**Artifacts** — "Artifacts" + "5 files · 44.1 MB", then a
`repeat(auto-fill, minmax(164px, 1fr))` grid of cards (`border-radius: 12px`): a 92px thumbnail area
(stripe pattern, 22px `ph-image` / `ph-film-slate` / `ph-file-code`) over the file name and
"screenshot · 1.2 MB". Artifacts are the *file* outputs (frames, ui dumps, replay video, metric copies)
as distinct from the JSON **Output** snapshot.

---

## Screen: Plugins

Header: "Plugins" + "Everything this farm can run — the plugins installed on it, and the scripts they
register", with **Reload all** (`ph-arrows-clockwise`, `var(--muted)`) and **Install plugin**
(`ph-plus`, accent). Then a search field with an "N of M" counter; it matches name, slug, version and
description.

Table — `min-width: 940px`, columns `1.7fr 100px 160px 88px 132px` →
Plugin · Status · Scripts · Verified · Actions.

Plugin cell: title (13px/600); a chip row (all `white-space: nowrap`, `flex: none`) with the slug in
`Geist Mono` 11.5px, the version chip (`background: var(--muted)`, `border-radius: 6px`, e.g.
`0.11.0 · active`), and tags — `service` in `var(--warn-soft)`/`var(--warn)`, `latest` / `9 versions`
in `var(--muted-2)`/`var(--faint)`; then the description (11.5px `var(--faint)`, `line-height: 1.6`,
`max-width: 460px`).

Status pill: dot + label — `active` = `var(--accent-soft)`/`var(--accent)` with an `var(--ok)` dot,
`staged` = `var(--muted-2)`/`var(--faint)` with a `var(--faint-2)` dot.
Scripts reads "4 registered" or "0 registered / 2 declared". Verified reads "7d ago".
Actions: **Disable** (active) or **Activate** (staged) as the bordered primary, plus a **⋯** overflow
holding Reset data / Remove (Remove in `var(--danger)`) so the row never clips.

---

## Screen: Settings

Two columns inside the panel.

**Left nav** — `width: 236px`, `border-right: 1px solid var(--line)`, `padding: 12px 10px 16px`.
Items: `padding: 8px 10px`, `border-radius: 9px`, 12.5px, icon 15px in an 18px box; active =
`var(--accent-soft)`/`var(--accent)`/600. Group headings are non-interactive: 11px/600 `var(--faint)`,
`padding: 14px 10px 6px`, `border-top: 1px solid var(--line)`, `margin-top: 8px`.

Order: **General** · *Connection* (Host & daemon, ADB transport, Network scan) · *Automation*
(Job runner, Capture & replay, Scripts) · *Storage* (Artifacts, Retention) · *Farm* (Clusters, Privacy,
Appearance).

**Right pane** — `max-width: 720px`, `padding: 18px 22px 28px`. Each section: a 19px/600 title with a
`border-bottom: 1px solid var(--line)`, an optional intro paragraph (12.5px `var(--dim)`), then fields
`padding-top: 14px`:
- *Text field*: 12.5px/600 label, then an input (`padding: 9px 12px`, `border-radius: 9px`,
  `border: 1px solid var(--border-2)`, `background: var(--panel-2)`; `Geist Mono` for paths/addresses)
  with optional trailing buttons (Rename, Test, Rotate, Browse, Scan now, Open, Add) and an 11.5px
  `var(--faint)` hint below.
- *Checkbox*: 16×16 accent box + 12.5px/600 label + 11.5px `var(--faint)` explanation.
- *Choice*: label then option buttons (`padding: 7px 12px`, `border-radius: 9px`; selected =
  `border-color: var(--accent)`, `background: var(--accent-soft)`, 600).

Content per page (all values are real settings, no filler): farm name / auto-start / new-device trust
and naming / default cluster / wipe-on-forget; listen address, access token, remote clients, log level
and directory; adb binary, preferred transport, keep-awake, restart-on-stall; subnet, ports, scan
interval; max concurrent jobs, per-device cap, on-failure policy, queue pause; frame capture mode,
UI-tree capture, frame quality, replay video; script auto-update, version pinning, run-as; artifact
directory, compression; frame/log retention, never-delete-failed; cluster list and hub auto-assign;
redact typed text, mask proxy credentials, crash reports; theme, table density, monospace numbers.

---

## Interactions & Behavior (summary)

| Trigger | Result |
|---|---|
| Click device row/card | Toggle selection (deferred 200ms so it loses to a double-click) |
| Double-click device | Open/retarget Device Control; that device becomes the control host |
| Drag in list area | Marquee selection; Shift/Ctrl/Cmd unions with the current selection |
| Ctrl/Cmd + A | Select all filtered devices (ignored while Device Control is open or typing) |
| Escape | Close popover/menu/window if any; otherwise clear selection |
| Right-click cluster tab | Rename / Delete group menu |
| Click outside a `[data-menu-root]` | Close menus, the info popover, and the group form |
| Rescan | 1400ms spin on both the toolbar button and the sheet button |
| Drag Device Control header | Move the window (offset resets on close) |
| Click timeline track / tick / frame | Move the playhead to that event |
| Theme toggle | Flip `data-theme` on `<html>`, persisted in `localStorage` under `enkaku-theme` |

Animations are deliberately minimal: `enkakuPulse` (2.6s status dot) and `enkakuSpin` (0.9s rescan).
No page transitions.

## State Management
Prototype state, as a guide to what the real implementation needs:

- Navigation: `page` (devices/scripts/jobs/plugins/settings), `setNav` (settings section).
- Devices: `view` (table/cards), `cardW`, `query`, `status`, `group`, `groups[]`, `selected{}`,
  `active`, `hoverDot`, `marquee`, `menu` (which popover), `scanning`.
- Groups: `groupMenu`, `groupMenuX`, `groupForm` (new/rename), `groupTarget`, `groupDraft`.
- Discovery: `discOpen`, `discAdded{}`, `discGone{}`.
- Device Control: `ctrl` (device id), `ctrlPos{x,y}`, `ctrlTab`, `ctrlSection` (Jobs/Files),
  `ctrlJob`, `ctrlNode`, `ctrlInfo`, `ctrlPath[]`, `ctrlDotTip`.
- Jobs page: `jpKind` (Jobs/Batches), `jpFilter`, `jpPage`, `jpJob`, `jpTab`, `jpLogLevel`, `jpEvent`,
  `jpSpeed`, `jpPlaying`.
- Scripts page: `spTab`, `spQuery`, `spPage`, `spOff{}`.
- Plugins page: `ppQuery`. Settings: `setVals{}`. Shell: `theme`, `logOpen`, `clock`.

Real data needs: device list + live metrics (battery, temp, cpu, mem, disk, uptime, task, controller),
discovery feed, cluster CRUD, job/batch history with per-action frames and UI dumps, log stream,
artifact storage, plugin registry with script versions, and settings persistence.

## Design Tokens

Declared on `:root`, overridden under `:root[data-theme="dark"]`.

| Token | Light | Dark |
|---|---|---|
| `--bg` | `#f1f1f2` | `#0c0c0e` |
| `--panel` | `#ffffff` | `#16161a` |
| `--panel-2` | `#fbfbfc` | `#1a1a1f` |
| `--panel-a` | `#ffffffee` | `#16161aee` |
| `--muted` | `#f6f6f7` | `#202027` |
| `--muted-2` | `#f4f4f5` | `#1d1d23` |
| `--hover` | `#fafafa` | `#1e1e25` |
| `--line` / `--line-2` | `#f0f0f1` / `#eeeef0` | `#26262d` / `#26262d` |
| `--border` / `--border-2` / `--border-3` | `#e8e8ea` / `#e4e4e7` / `#d4d4d8` | `#2a2a32` / `#32323b` / `#3c3c46` |
| `--text` / `--text-2` / `--text-3` | `#18181b` / `#3f3f46` / `#52525b` | `#f4f4f5` / `#d4d4d8` / `#b0b0b8` |
| `--dim` / `--faint` / `--faint-2` | `#71717a` / `#a1a1aa` / `#c4c4c8` | `#8e8e98` / `#71717a` / `#55555f` |
| `--accent` / `--accent-2` | `#16803c` / `#12652f` | `#4ade80` / `#86efac` |
| `--accent-soft` / `--on-accent` | `#ecf6ef` / `#ffffff` | `#16281d` / `#08130c` |
| `--accent-a1` / `-a2` / `-a3` | `#16803c14` / `1f` / `40` | `#4ade8014` / `1f` / `40` |
| `--ok` | `#16a34a` | `#4ade80` |
| `--warn` / `--warn-2` / `--warn-soft` | `#b45309` / `#d97706` / `#fef6e7` | `#fbbf24` / `#f59e0b` / `#2a2110` |
| `--danger` / `--danger-soft` | `#dc2626` / `#fdeceb` | `#f87171` / `#2b1616` |
| `--avatar-bg` / `--avatar-fg` | `#fde8ea` / `#b4405a` | `#34212a` / `#f0a3b4` |
| `--tooltip-bg` / `--tooltip-fg` | `#18181b` / `#fafafa` | `#f4f4f5` / `#18181b` |
| `--scrim` | `#18181b33` | `#00000080` |

**Typography** — `Geist` (400/500/600/700) for UI, `Geist Mono` (400/500) for serials, endpoints,
paths, versions, script names, timestamps and numeric readouts. Scale: 19px/600 settings section titles,
16px/600 sheet titles, 15px/600 page and job titles, 14px/600 device name in Device Control,
13px/500-600 row titles and buttons, 12.5px body and controls, 11.5px meta, 11px column labels and
hints, 10.5px badges, 10px tooltips and frame captions.

**Spacing** — 10px shell gap and padding; 12–14px panel padding; 6/8/10/12/14px gaps.
**Radii** — 16px page panels, 18px floating window and cast, 14px cards/sheets/status bar, 12px inner
cards, 10px buttons and rows, 9px settings inputs and nav items, 8px small buttons, 7px compact chips,
5px checkboxes, 999px pills.
**Shadows** — `0 1px 3px #00000014` (active pill), `0 8px 24px #00000014` (cast),
`0 10px 24px var(--accent-a3)` (bulk pill), `0 16px 40px #0000001f` (popovers),
`0 20px 50px #00000024` (console/menus), `0 30px 80px #00000033` (Device Control).

## Assets
- **Fonts**: Geist + Geist Mono from Google Fonts.
- **Icons**: Phosphor Icons web font, regular weight (`@phosphor-icons/web@2.1.1`), used by class name
  (e.g. `ph ph-devices`). Every icon in this doc is a Phosphor regular name.
- **No bitmap assets.** Every phone screen (cards, cast, snapshot, frames, artifact thumbnails) is a
  placeholder: a flat surface or a 135° striped gradient. Replace these with the real scrcpy/cast
  surface, real screenshots and real artifact thumbnails.

## Files
- `Enkaku Device List.dc.html` — the full console prototype (all five screens, Device Control,
  discovery sheet, both themes). This is the design of record.
- `Enkaku Device List v1 terminal.dc.html` — superseded dark-terminal exploration of the Devices
  screen only. Reference for history; do not implement.
- `support.js` — runtime for the prototype's template/logic format. Not part of the design; do not port.
