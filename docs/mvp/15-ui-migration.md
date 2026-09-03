# MVP 15 — UI migration: the design handoff and how it reconciles with 03–14

> Status: direction decided (CEO, 2026-09-03). The design of record is `docs/mvp/design_handoff_enkaku_openpf/Enkaku Device List.dc.html` with its `README.md` (540 lines: shell, five screens, Device Control, discovery sheet, tokens, typography, behaviour). This document does not restate the handoff; it records what it decides, where it and documents 03–14 disagree, which side wins, and the rebuild order.
> Related: MVP 03, 04, 05, 06, 07, 08, 12, 13, 14; `docs/design.md` (to be rewritten from the handoff tokens); `packages/ui/src/theme.css`; `packages/studio/src/components/layout/AppShell.tsx`.

---

## 0. What the handoff fixes

- **Shell**: 60 px icon rail (Devices, Scripts & workflows, Jobs, Plugins; then theme toggle, Settings, avatar), a 44 px status bar (pulsing "System OK", Devices n/m, Jobs n/m, Console toggle, Alerts bell, clock), one 16 px-radius page panel. Desktop-first, 1280–1600 px, usable to 960 px, no mobile layout.
- **Devices**: cluster tab pills with counts and a "+" popover (create, rename, delete by right-click), Discovered (N) opening a right sheet, search / filter / view / rescan icon buttons, a 13-column table (grid `38px 44px 1.3fr 108px 92px 138px 70px 74px 62px 62px 62px 76px 1.1fr`) and a Screens card grid with four width presets. Selection: click toggles, double-click opens Device Control, marquee drag, Ctrl/Cmd+A, tiered Escape. A floating "N selected" pill opens the **generic action set**: Reconnect, Disconnect, Install apk, Adb command, Run script, Screenshot, Sleep, Move group, Upload file, Clear cache, Settings, Forget. No per-row actions column.
- **Device Control**: a draggable floating window, not a modal, width from the device's aspect ratio. Three columns: a 52 px hardware shortcut rail (Power, Volume, Mute, Back, Home, Recents, Rotate, Brightness, Clipboard), the cast with a stats strip (fps, resolution, codec, latency), and a 274 px info column with an [i] popover (identity and active engines with a Change button), meta strip, and three compact tabs: **Actions** (the same generic set), **Inspector** (snapshot with node bounds, UI node tree, node details), **Device** (a container with Jobs and Files sections). With several devices selected, a "Host device" banner: input mirrors to the rest of the selection.
- **Scripts & workflows**: two tabs. Scripts as a table; workflows as cards with a step chain and a footer such as "12 devices · daily 07:00".
- **Jobs**: tabs Jobs and Batches; a 268 px left list with wrapping filter chips and 12 rows per page; a right detail with Inputs, Output, Logs, Timeline (the replay debugger with transport, lanes, frames, and event panel), Artifacts; Re-run, Open device, Export.
- **Plugins**: table Plugin · Status · Scripts · Verified · Actions with Disable / Activate and an overflow (Reset data, Remove).
- **Settings**: two columns; left nav General, Connection (Host & daemon, ADB transport, Network scan), Automation (Job runner, Capture & replay, Scripts), Storage (Artifacts, Retention), Farm (Clusters, Privacy, Appearance).
- **Tokens**: the full light and dark palette on `:root` and `:root[data-theme="dark"]`, Geist and Geist Mono, Phosphor regular icons, radii 16/18/14/12/10/9/8/7/5/999, six named shadows, two animations only.

## 0.1 Corrections from the CEO after reading the reconciliation (2026-09-03)

1. **Schedules is the third tab of Scripts & Workflows**: Scripts, Workflows, Schedules. This replaces the "schedule as an attribute" resolution below; a workflow card may still show its schedule, but the list of schedules lives on that tab.
2. **Workspace is renamed Files and lives under Agents.**
3. **Clusters are renamed Groups** everywhere (UI, API, and the `clusters` table and routes, to keep one word). Groups are managed only from the Devices tab strip; there is no dedicated page.
4. **Console is removed entirely**, including the status-bar log console the handoff draws. The status bar keeps System OK, the counters, Alerts, and the clock. The Adb command action in the generic set stays.
5. **Recordings are deferred**: not in the MVP, not in the nav; the code is parked behind the deferral list in MVP 06, not deleted, and its plugin-per-recording rework (MVP 03 §2.2) waits with it.
6. **The workflow editor, Agents, and Nodes are not designed yet**; the handoff's Workflows tab only draws the card list. These three are added to §2.



| Topic | Handoff | Documents | Resolution |
|---|---|---|---|
| Agents in the rail | absent | MVP 06 keeps Agents in core | **Open (§4.1).** Either a fifth icon is added to the rail, or Agents ships as the first plugin view under the dynamic menu the handoff reserves. |
| Script versions and Enabled switch | Scripts table has Latest · Versions · Published · Enabled columns and a "New script" button; Settings → Scripts has auto-update, version pinning, run-as | MVP 03 §2: scripts have no version and no enable toggle; they only come from plugins | **Documents win; the design is revised.** Columns become Name (`plugin/script`, mono) · Plugin (version chip) · Params · Last run · Run. "New script" opens the plugin scaffold flow (`enkaku init`) or the install sheet; the three Settings → Scripts fields are dropped. |
| Job kinds | one Jobs list; a workflow job shows "step 4 of 12 · 34 %" as its sub-line; tabs Jobs and Batches | MVP 05 §1.5: four tabs (Script jobs, Workflow jobs, Batches, Schedules) | **Handoff wins for the surface.** One Jobs list, kind visible in the row; Batches as the second tab. The data model in MVP 05 and 14 is unchanged. |
| Schedules | no Schedules page; a workflow card's footer reads "12 devices · daily 07:00" | MVP 03 and 05 put Schedules under Jobs | **Superseded by §0.1.1:** Schedules is the third tab of Scripts & Workflows. Fires appear as runs (MVP 14). The Schedules tab is deleted from Jobs. |
| Runs of one job | Jobs detail has no run selector | MVP 14: a job keeps every run | **Documents win; a small design addition.** The detail header's meta line gains a run picker ("run 3 of 3 ·") and Re-run adds a run. To be drawn into the prototype. |
| Mirror | Device Control shows a "Host device" banner and mirrors input to the other selected devices | MVP 06 deferred mirror | **Handoff wins; MVP 06 §1 amended.** Mirror returns as a client-side fan-out of `input.*` to the selection (exactly what MVP 07 §1.4 and MVP 08 §1.5 anticipated), with no grants and no server object: each member simply gets a control marker (MVP 04). |
| State dot colours | green free, amber someone controlling, red job running, grey disconnected, warn unauthorized; the same mapping in table and grid; the reason only in a tooltip | MVP 15 (earlier draft) proposed blue for active | **Handoff wins; the earlier open point is closed.** |
| Device page | none: Device Control is the device surface; "Open full detail" on a job goes to the Jobs page | MVP 06 §1 kept a seven-tab device page | **Handoff wins; MVP 06 §1 amended.** The device page and its route are deleted. Terminal becomes the Adb command action and the log Console; Diagnostics becomes the Console filtered to the device; Files and Jobs live in the Device tab; Network lives in the plugin views (proxy-manager, mikrotik-routing) and the [i] engines popover; device Settings is the Settings action. Identity is the [i] popover. |
| Console in the status bar | a floating log console ("adb · logcat stream", levelled rows) | MVP 03 and 07 mapped the terminal icon to the adb command drawer | **Superseded by §0.1.4:** Console is removed entirely. Adb command stays as an action in the generic set. |
| DevicePicker in Device Control | none; the window retargets by double-clicking another device; the header names the device | MVP 07 §2.1 said every action modal has the picker as its first row | **Both hold.** Device Control is a window, not an action modal; the picker rule applies to the action dialogs the generic set opens (Run script, Install apk, Upload file, Adb command, Move group, Settings, Forget), which the handoff has not drawn yet. To be drawn with the picker container from MVP 07 §2.1. |
| Settings content | about 40 fields across 12 sections, including log level, max concurrent jobs, per-device cap, scan interval, frame quality, script auto-update, version pinning, run-as, access token | MVP 12: 15 visible, 11 advanced, the rest constants | **Documents decide the field list; the handoff decides the layout.** The two-column layout and the group structure are adopted. Fields MVP 12 classified as constants are dropped from the pane; the 11 advanced ones form an "Advanced" section under Farm. Clusters in Settings is the same cluster list the tab strip manages. |
| Generic action set versus MVP 07 verbs | adds Screenshot, Clear cache, Move group, Settings (bulk); lacks Wake, Block, Label, Prepare, Network | MVP 07 §1.1 verb list | **Union.** MVP 07 gains `screenshot`, `clear-cache`; `move-group` is `set-cluster`; bulk `settings` is the device Settings dialog with the picker. Wake is implicit under MVP 11 (Sleep is the explicit one); Block moves into the discovery sheet and Forget; Label and Prepare become actions in the overflow of the same menu, not in the first twelve. |
| Icons | Phosphor regular, by class name | Studio uses lucide; the plugin icon allowlist (`IconNameSchema`, 41 names) is lucide-shaped | Phosphor. The plugin allowlist is remapped to Phosphor names in `@enkaku/protocol`, keeping the same ids so bundled plugins do not change. |
| Fonts | Geist and Geist Mono from Google Fonts | system font stack | Geist, self-hosted in the static export (the core serves Studio on a LAN that may have no internet). |

## 2. What the handoff leaves undesigned, and who draws it

- The action dialogs behind the generic set, each with the DevicePicker container (MVP 07 §2.1) as its first row.
- The run picker on the Jobs detail (MVP 14).
- The dynamic plugin menu under the static rail: the handoff asks for the manifest shape; it already exists (`PluginSurface.nav`: id, label, icon, view), so the design only needs the rendering.
- The Scripts table after the version columns are removed (§1).
- Agents (Roster, Runs, Approvals, Files), if it stays a rail item (§4.1).
- Nodes (cloud mode is after the MVP, MVP 06 §4.1; no design needed for the MVP).
- The workflow editor: the handoff draws only the Workflows card list.
- The Schedules tab under Scripts & Workflows (§0.1.1).
- The device Settings dialog (schema-driven form, same fields as the per-device overrides in MVP 12 §5).
- The `Enkaku Device List v1 terminal.dc.html` file the README mentions as rejected history is not in the directory; nothing to do, noted so nobody looks for it.

## 3. Rebuild order

Per the README's Approach, the shell and every control-touching screen are rebuilt on the handoff, not restyled.

1. **Tokens and primitives.** `packages/ui/src/theme.css` is replaced by the handoff's token table (light and dark, Tailwind v4 `@theme` mapping). Geist self-hosted, Phosphor icons, the shadows and radii scale. `@enkaku/ui` primitives are re-skinned to the handoff (buttons, inputs, checkbox, switch, tabs, chips, popover, sheet, tooltip); anything the handoff does not use is deleted.
2. **Shell**: rail, status bar with live counters and the pulsing health dot, page panel, theme toggle persisted under `enkaku-theme`. No Console. The old `AppShell`, `NAV`, `Counts`, collapse preference, `OperationTray`, and banners go (MVP 13 A.6).
3. **Devices**: table and Screens views, cluster tabs with CRUD, search / filter / view / rescan, discovery sheet, selection model, bulk pill with the generic set, on top of the activity push (MVP 04) and always-on sessions (MVP 11). The `#` column is the device number; Task is the activity list; the status dot uses the handoff's five states.
4. **Device Control** (MVP 08 input model inside the handoff's window): shortcut rail, cast with the stats strip fed by the latency overlay from MVP 01, [i] popover, Actions, Inspector (MVP 02 and 10), Device with Jobs and Files, host banner with input fan-out.
5. **Action dialogs** with the DevicePicker (MVP 07), then **Scripts & workflows** (revised table, workflow cards, Schedules tab, the workflow editor once designed), **Jobs** (list, detail, timeline, artifacts, run picker), **Agents** (once designed; Files inside it), **Plugins**, **Settings** (MVP 12 fields in the handoff layout). Each replaces its old page and deletes the old route directory.
6. `docs/design.md` is rewritten from the handoff as the screens land: tokens, type scale, spacing, radii, shadows, the dot and chip semantics, the picker container, the selection model, the writing rules. The old screen-patterns section is replaced.

## 4. Open points for the CEO

1. **Agents**: a fifth rail icon, or the first entry of the dynamic plugin menu.
2. Confirm the three design revisions the documents force: the Scripts table without version columns, the run picker on Jobs detail, and the Settings pane reduced to the MVP 12 field list.
3. Whether the Screens view's live cast is the wall encoder from MVP 11 at every card width, or a still for the S preset (proposed: live at every width; the live-set gating already limits decoding to visible cards).
