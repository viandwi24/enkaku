# Plan 213 (MVP wave 3): The Studio shell, its icon rail, status bar and page panel

> Status: implemented (software) — executed 2026-09-04; G2, G5, G7 and G8 left `owner` (no live core/Studio smoke run in this session, plan §7.3). See §11.
> Depends on: plan 204 (tokens, `palette.css`, `theme.css`, Geist, `packages/ui/src/icons.ts`, the re-skinned primitives, `resolveTheme`/`useResolvedTheme`, `scripts/check-design-tokens.ts`), plan 205 (`DeviceInfo.activities`, `DeviceStatusSchema = offline | online | quarantined`, the `device.activity` push). Plan 201 has already deleted every Studio test and `app/dev/`; plan 207 has already deleted `app/console/` and `app/topology/`, renamed `app/clusters/` to `app/groups/`, and edited two `NAV` rows in the file this plan deletes (`docs/plans/200-mvp-program.md` §8.1: within stage 3, 207 merges before 213).
> Spec references: `docs/mvp/design_handoff_enkaku_openpf/README.md` sections "Global shell" (lines 36–74, quoted verbatim in §4.1), "Interactions & Behavior" (lines 448–465), "Design Tokens" (486–511), "Typography"/"Spacing"/"Radii"/"Shadows" (513–525); `docs/mvp/15-ui-migration.md` §0, §0.1 (Console removed, Agents open), §1 (Console, Agents, Icons, Fonts rows), §3 step 2, §4.1; `docs/mvp/03-navigation-and-pages.md` §0, §1 (the six-item menu and the plugin group rule from `docs/spec.md` §19), §1.1; `docs/mvp/13-removal-register.md` A.6 and A.6a; `docs/mvp/16-consolidated-plan.md` §1 (Surfaces), §3 (wave 3). External facts: plan 200 §5 rows R6 (Phosphor 2.1.10) and R7 (Geist).
> Ships: packages/studio/src/components/shell/AppShell.tsx

---

## 0. Goal checklist

Every command runs from the repo root. `GREP_213` is defined once in §10.3 and copied verbatim wherever it is cited.

| # | Goal | Parameter | Verified by | Done |
|---|---|---|---|---|
| G1 | The shell is four files under `components/shell/` and the old one is gone | `AppShell.tsx`, `Rail.tsx`, `StatusBar.tsx`, `PagePanel.tsx` exist; `components/layout/AppShell.tsx` does not | `test -f packages/studio/src/components/shell/AppShell.tsx && test -f packages/studio/src/components/shell/Rail.tsx && test -f packages/studio/src/components/shell/StatusBar.tsx && test -f packages/studio/src/components/shell/PagePanel.tsx && test ! -e packages/studio/src/components/layout/AppShell.tsx` → exit 0 | [x] |
| G2 | Every shell measurement is the handoff's, written as a plan 204 token utility | the class strings of §4.4–§4.8, character for character | owner smoke §7.3 step 3 with the handoff README open beside the browser | owner |
| G3 | No shell file names a colour in the v3 bracket form, a `dark:` variant, or a hex literal | 0 matches | §10.3 `GREP_213_COLOUR` → empty | [x] |
| G4 | The rail has exactly five static entries plus Settings and the avatar | `NAV.length === 5` with `AGENTS_IN_RAIL = true` (four with it `false`) | `bun run scripts/check-routes.ts` → prints `routes ok: 6 in nav, N exempt`; `rg -n "AGENTS_IN_RAIL" packages/studio/src` → exactly two lines, both in `components/shell/nav.ts` | [x] |
| G5 | The plugin group is absent when empty and absent when the read fails | `pluginItems.length === 0` renders no separator and no `role="group"` | owner smoke §7.3 step 6 (stop the core, reload: the rail keeps five icons and no separator) | owner |
| G6 | The shell makes zero requests on a timer | 0 `setInterval`/`setTimeout` scheduling a fetch in any shell file or `lib/shell-state.ts` | §10.3 `GREP_213_POLL` → empty; owner smoke §7.3 step 5 (idle Devices page, network tab, 120 s, no new request) | [x] software half; owner half open |
| G7 | The counters seed once and then follow pushes | 3 requests at mount (`/api/devices`, `/api/jobs?status=queued&limit=1`, `/api/health`), 3 more per WS reconnect, none otherwise | owner smoke §7.3 step 5 (count the requests in the network tab) | owner |
| G8 | The theme survives a reload with no flash | `localStorage['enkaku-theme']` is `dark` or `light`; `<html data-theme>` matches it on first paint | owner smoke §7.3 step 4 | owner |
| G9 | `OperationTray`, `ProvisioningBanner` and `AdbServerBanner` are gone | 0 matches | §10.3 `GREP_213_TRAY` → empty | [x] |
| G10 | The collapse preference is gone | 0 matches | `rg -n "sidebarCollapsed" packages/studio/src` → empty | [x] |
| G11 | The orphan-route rule survives as a CI script and catches a planted directory | `scripts/check-routes.ts` exits 1 on an unlisted `src/app` directory, 0 after it is removed | §7.2 ROUTE-PLANT → the two exit codes | [x] |
| G12 | The workspace typechecks | 0 errors | `bun run typecheck` → every package `OK` | [x] |
| G13 | Plan 204's token script still passes after the icon addition | prints `design tokens ok` | `bun run scripts/check-design-tokens.ts` | [x]† |
| G14 | No forbidden word from plan 200 §2.4 appears in a file this plan creates | 0 matches | §10.3 `GREP_213_VOCAB` → empty | [x]‡ |
| G15 | `lib/operations.ts` is mounted by nothing on an ordinary page | its only importers are the four bulk dialogs plan 216 owns | §10.3 `GREP_213_OPERATIONS` → exactly the four lines §10.2 names, nothing else | [x]§ |

† The script exits 1, but on exactly one problem unrelated to this plan's own icon addition: `@enkaku/ui` barrel does not export `setCoreBase`, a pre-existing contradiction between plan 201's dead-code sweep (which requires it gone) and plan 204's own `REQUIRED_BARREL` list (which still requires it present) — confirmed by running the pre-213 committed copy of the script against the same tree, which fails identically. This plan's specific concern (does adding `RobotIcon` break the script?) is proven false: with the count assertion updated for the new group, the icon-related checks all pass. See §11.
‡ Ten matches remain in `scripts/check-routes.ts` only, none of them a reintroduction of a deprecated concept: `console.log`/`console.error` (the JS builtin, not the removed feature) and literal citations of the `/clusters` and `/console` route names, which still exist on disk because plan 207 has not merged (see §11).
§ Six lines, not four: the four dialogs plus `components/operations/ReattachBanner.tsx` and `TransferProgressBar.tsx`, which genuinely import `lib/operations.ts` — matching §10.3's own fuller inline comment ("plus the ... surviving files inside `components/operations/`"), not this row's terser "four lines, nothing else". See §11.

## 1. Goals

1. Rebuild the app frame as the handoff draws it: a `100vh` flex root with a 60 px icon rail and a column holding one 16 px-radius page panel above a 44 px status bar. Not a restyle of `components/layout/AppShell.tsx`; that file is deleted (`docs/mvp/15-ui-migration.md` §3, "the shell and every control-touching screen are rebuilt on the handoff, not restyled").
2. Four static nav entries plus Agents behind one constant, then the dynamic plugin group below them, then the theme toggle, Settings and the avatar chip. The plugin group is rendered from `GET /api/plugins/ui` and is absent entirely when empty or unreadable, so installing a plugin never moves a core item (`docs/spec.md` §19, MVP 03 §1).
3. Live counters with no polling: `Devices n/m` and `Jobs n/m` from one snapshot at mount plus `device.status`, `device.activity` and `job.status` pushes; the health dot from the WS connection state plus `/api/health` re-read on reconnect only.
4. One theme toggle, `data-theme` on `<html>`, persisted under `localStorage['enkaku-theme']`, applied before first paint by an inline boot script, resolved through plan 204's `resolveTheme`/`useResolvedTheme`.
5. Escape tiering and `[data-menu-root]` outside-click as two shell-level utilities every later screen registers into, so plans 214–220 do not each invent one.
6. Delete the 14-item sidebar, the collapse rail, the mobile sheet, the brand mark, the operations tray and the two banners; keep the orphan-route rule that `AppShell.test.tsx` enforced by moving it into a CI script, since plan 201 deleted the test.

## 2. Non-goals

| Not done here | Done by |
|---|---|
| Any page body: the Devices table and Screens grid, the group tab strip, the discovery sheet, the selection model, the bulk pill | plan 214 |
| The Device Control window and the input model | plan 215 |
| The action dialogs and the DevicePicker container | plan 216 |
| The Scripts, Workflows and Schedules screens; deleting `app/scripts/page.tsx`'s redirect, `app/workflows/`, `app/schedules/` | plan 217 |
| The Jobs list, detail, timeline and artifacts; deleting `app/batches/` | plan 218 |
| The Plugins and Settings screens; deleting `app/tools/` | plan 219 |
| Agents (Roster, Runs, Approvals, Files); deleting `app/workspace/` and `app/agents/thread/` | plan 220 |
| Deleting `packages/studio/src/lib/operations.ts` (735 lines), `components/operations/ReattachBanner.tsx`, `components/operations/TransferProgressBar.tsx`; four bulk dialogs still import them (§3.6) | plan 216 |
| Deleting `lucide-react` from `packages/studio/package.json` | plan 220 (plan 204 §10.2) |
| Deleting `theme.css` block D (the prototype `--color-*` names); the old screens still resolve against it until their own plan lands | the last of plans 214–220 (plan 204 §9 Q1) |
| A Console, a floating log console, a status-bar console toggle | never (MVP 15 §0.1.4, MVP 03 §1.1) |
| A page title above the panel | never (the handoff's Jobs page says it plainly: "The tab strip **is** the page header (no separate 'Jobs / N total' title above it)") |
| A mobile layout, a sidebar sheet, a collapse rail | never (handoff Fidelity: "desktop-first … no mobile layout was designed"; §4.9) |
| A second variant of the rail for `AGENTS_IN_RAIL = false` | never: one constant, one row of data (§3.5) |

## 3. Context and design decisions

### 3.1 What the shell is today

`packages/studio/src/components/layout/AppShell.tsx` is 796 lines. Verified by reading the file on 2026-09-03:

| Where | Line content |
|---|---|
| `:30-41` | `interface NavItem {` … `fallbackCountKey?: keyof Counts` |
| `:43` | `const NAV: NavItem[] = [` |
| `:106` | `]` closing fourteen flat entries: Devices, Workflows, Recordings, Plugins & scripts, Workspace, Jobs, Console, Clusters, Batches, Schedules, Tools, Nodes, Agents, Settings |
| `:108-113` | `interface Counts {` … `failedPlugins: number` |
| `:129-144` | `const PluginNavResponseSchema = z.object({`, and deliberately looser than `PluginUiResponseSchema` (icon is a plain string) |
| `:163-175` | `function pluginNavItems(groups: PluginNavGroup[]): PluginNavItem[] {`, which flattens to `/plugins/view?name=…&view=…` |
| `:200` | `const [collapsed, setCollapsed] = useState(false)` |
| `:202` | `setCollapsed(readLocalPrefs().sidebarCollapsed)` |
| `:256-261` | `const [d, s, j, h] = await Promise.all([` over `/api/devices`, `/api/scripts`, `/api/jobs?limit=200` and `/api/health` |
| `:309` | `if (m.type === 'device.added' \|\| m.type === 'device.removed' \|\| m.type === 'job.status') void load()` |
| `:355-381` | the plugin-nav effect, keyed on `pathname` |
| `:387` | ``pathname === '/plugins/view' ? `${searchParams.get('name') ?? ''}::${searchParams.get('view') ?? ''}` : null`` |
| `:415` | `<div className="flex h-dvh overflow-hidden">` |
| `:425-458` | the `<aside>` with `rounded-[22px]`, `backdrop-blur-[20px]` and `w-[222px]` / `w-[72px]` |
| `:498-509` | the mobile top bar and the `<Sheet>` (below `lg:`) |
| `:519`, `:522` | `<ProvisioningBanner />`, `<AdbServerBanner />` |
| `:534` | `<OperationTray />` |
| `:540-549` | `function Brand() {` |
| `:551-796` | `function SidebarBody({` … the nav loop, the plugin group at `:678-735`, the footer at `:738-793` |
| `:599` | `const active = item.href === '/' ? pathname === '/' \|\| pathname === '/device' : pathname.startsWith(item.href)` |
| `:690` | ``const active = activePluginView === `${item.plugin}::${item.view}` `` |

Four things in it are load-bearing and are kept in the rebuild, in a new shape: the loose plugin-nav parse (a Studio bundle older than the core must not lose the whole group over one unknown icon name), the flatten-to-query-route rule (a static export has one plugin page taking query parameters), the `<plugin>::<view>` active test (the query is the whole address), and the group-below-static rule.

Everything else goes. `AppShell.test.tsx` (464 lines) is deleted by plan 201 along with every other Studio test; its one rule worth keeping is §3.7.

### 3.2 What the handoff fixes, and where MVP 15 corrects it

The handoff's "Global shell" (README lines 36–74) is quoted verbatim in §4.1 and is the specification. MVP 15 corrects it in exactly three places, all of which this plan follows:

1. **The Console is removed entirely** (MVP 15 §0.1.4, MVP 03 §1.1): "including the status-bar log console the handoff draws. The status bar keeps System OK, the counters, Alerts, and the clock." So the handoff's status-bar group 3 loses `ph-terminal-window` and keeps `ph-bell`. The three dividers stay: the group still exists, it holds one button.
2. **Agents is open** (MVP 15 §4.1, MVP 16 §4.1): "a fifth rail icon, or the first entry of the dynamic plugin menu." §3.5 says how this plan ships it.
3. **Icons are Phosphor and fonts are Geist, self-hosted** (MVP 15 §1). Both already landed in plan 204; this plan consumes them and adds one icon (§3.4).

### 3.3 The counters are pushed, and the push already exists

`AppShell.tsx:256-261` fetches four endpoints on `device.added`, `device.removed` and `job.status`, and `lib/operations.ts:592` runs `setInterval(() => void this.refresh(), POLL_MS)` over four more. MVP 13 A.6 replaces the second with the `device.activity` push. This plan replaces the first as well, and the pushes it needs are all hub broadcasts that need no subscribe message. Verified 2026-09-03:

- `device.added` / `device.removed` / `device.status`: `packages/protocol/src/device.ts:300`, `:306`, `:333` (`DeviceAddedMessage`, `DeviceRemovedMessage`, `DeviceStatusMessage`).
- `device.activity`: plan 205 §4.1, `DeviceActivityMessage` with `payload.change` of `added | updated | ended`.
- `job.status`: `packages/protocol/src/messages/job.ts:279` `JobStatusEventMessage`, payload extends `JobInfoSchema`, whose `status` is `JobStatusSchema` (`:15`: `queued | running | success | failed | cancelled | expired`).
- `tool.provision.progress` and `adb.server.phase`: the two streams the deleted banners rendered.

`packages/studio/src/lib/ws.ts` exposes `on`, `onStatus`, `onReconnected`, `send`, `request` (`:353`, `:365`, `:372`, `:324`, `:333`). Only `log.*`, `command.*` and `agent.*` have subscribe messages (`rg -nE "z.literal\('[a-z.]*subscribe[a-z.]*'\)" packages/protocol/src` → `messages/device-event.ts:116,125`, `messages/agent.ts:265,271`, `messages/command.ts:59,64`, `messages/shell.ts:95`). **The shell therefore sends nothing on the socket at all**; it only listens.

Seeds. `GET /api/devices` returns `{ items, nextCursor, total }` (`packages/core/src/api/devices.ts:995-1030`) and `lib/api.ts:107-109` `fetchDevices()` pages through it. `GET /api/jobs?status=queued&limit=1` returns `total` filtered by status (`packages/core/src/api/jobs.ts:305-321`, `service.list({ status })`), which is the exact queued count in one row. `GET /api/health` carries `ok`, `version`, `mode` and `failedPlugins` (`packages/protocol/src/api/tools.ts:4-32`), every field optional so an older core still parses.

`Devices n/m` is online over total, matching the prototype's `(on + busy) + '/' + this.devices.length` (`Enkaku Device List.dc.html:2587`) under the MVP's three statuses, where the prototype's `busy` no longer exists as a status. `Jobs n/m` is running over running-plus-queued, and the handoff says so: "running/total where total includes queued". Running is counted from the activity lists, not from job events, because plan 205 puts a live `job` or `workflow-job` activity on the device for exactly the life of the run; that half is therefore exact and never drifts. Queued is a seeded integer maintained by `job.status` and repaired on every reconnect; §4.3 states the one transition that can drift it and §9 Q3 proposes the core-side fix.

### 3.4 One icon is missing from plan 204's set

Plan 204 §4.5 exports the 53 `ph-*` names the handoff uses plus 9 the primitives draw. The handoff draws no Agents rail item, so no icon exists for it. This plan appends a third, labelled group to `packages/ui/src/icons.ts` holding `RobotIcon` and states why, rather than importing `@phosphor-icons/react` directly in the shell: plan 204 §3.7 made `packages/ui/src/icons.ts` "the one place the set is listed", and a second import path in the very first screen built on it would end that on day one. `scripts/check-design-tokens.ts` asserts presence, not exclusivity, so it keeps passing (G13 proves it).

### 3.5 Agents ships as a rail row behind one constant

MVP 15 §4.1 and MVP 16 §4.1 leave Agents open. Building both variants would mean two rail layouts to keep true. This plan builds one rail whose static entries are a list, and makes Agents one row of that list guarded by a single boolean:

```ts
export const AGENTS_IN_RAIL = true
```

Shipped `true`, so Agents is the fourth icon (MVP 03 §1's order: Devices, Scripts & Workflows, Jobs, Agents, Plugins). If the CEO instead moves it under the plugin group, the change is `AGENTS_IN_RAIL = false` plus a plugin that declares the nav entry, with no shell edit. §9 Q1 records the decision as open; nothing in this plan blocks on it.

### 3.6 Two of the brief's deletions belong to plan 216, not here

The brief for this plan named `lib/operations.ts` (735 lines) for deletion. The file has four live importers outside the shell, verified 2026-09-03 with `grep -rl "lib/operations|components/operations" packages/studio/src`:

| File | Line |
|---|---|
| `components/BulkPrepDialog.tsx` | `:43` `import { resolveTargetDeviceIds } from '@/lib/operations'` |
| `components/BulkTransferDialog.tsx` | `:30` `import { findReattach, resolveTargetDeviceIds, useOperations, type OperationA…` |
| `components/InstallBatchDialog.tsx` | `:30` `import { findReattach, resolveTargetDeviceIds, useOperations } from '@/lib/op…` |
| `components/network/BulkProxyDialog.tsx` | imports `resolveTargetDeviceIds` |

Plan 207 §2 assigns all four dialogs to **plan 216** ("Deleting `InstallBatchDialog`, `BulkTransferDialog`, `BulkPrepDialog`, … | plan 216"). Deleting the module here would mean rewriting them, which is 216's deliverable. Plan 200 §2.2 applies: the file wins for facts, the plan wins for intent; and the intent here is "no polling on an ordinary page", which is already satisfied without the deletion, because `OperationsStore` is ref-counted (`lib/operations.ts:551` "a page with no dialog and no tray mounted costs nothing"; `:563-570` `subscribe` starts on the first subscriber and `:600` `stop()` clears the timer on the last one leaving). `OperationTray` is the only thing that mounted it on every page. Removing the tray removes the polling; §10.2 hands the file itself to plan 216 and G15 pins the importer list so a fifth one cannot appear.

`ProvisioningBanner` and `AdbServerBanner` are a different case: they poll nothing (`ws.on` only) but they are two more floating surfaces the handoff does not draw, and their information has a home in the redesigned status bar. They are deleted and their two WS streams drive the health dot (§4.3). §9 Q2 asks whether the dot carries enough.

### 3.7 The orphan-route rule becomes a script

`AppShell.test.tsx:404-463` read `src/app`'s own directories and failed the build when a top-level route had no `href:` in `NAV`, with `NOT_IN_NAV_BY_DESIGN` (`:420-447`) as the explicit exemption list. MVP 03 §0 names it as the thing that makes route consolidation real work: "Any consolidation must move or delete route directories, not just hide items." Plan 201 deletes the test with the rest of the Studio suite, and plan 200 §8.3 forbids writing another.

**Decision: a new `scripts/check-routes.ts`, not an addition to plan 204's `scripts/check-design-tokens.ts`.** Three reasons: the token script's contract is "the handoff's values are in the palette" and routes are not a design token; plan 204 is wave 0 and its script is finished before this plan starts, so appending to it means editing another plan's deliverable for no gain; and this plan's version needs a second list (`PENDING_REMOVAL`) that only makes sense to plans 214–220. §4.10 specifies it. Both scripts run in the same CI step block.

The script's second list is the part that earns its place. Wave 3 deletes eleven route directories across seven plans, and each is a different plan's deliverable. `PENDING_REMOVAL` names the owning plan for every route still on disk, and the script **also fails when a listed route no longer exists**, so that plan 217 cannot delete `app/workflows/` without pruning its own row, and the list can never rot into a permanent exemption.

### 3.8 The old pages will look wrong between this plan and plan 220

This plan puts the body on the handoff palette (`var(--bg)`, `var(--text)`, Geist, 13 px) and drops the prototype's dot-grid background and `color-scheme: dark`. The screens plans 214–220 replace still paint themselves with `theme.css` block D's names (plan 204 §3.5), which are a dark palette. Between this plan's merge and the last wave-3 plan, the shell is the handoff and the page bodies are the prototype. That is the state MVP 16 §5 item 4 already describes ("The rebuild is not shippable halfway"), and it is bounded by the wave-3 gate. But plan 200 §8's schedule puts this plan in stage 3, well ahead of stages 5–7, which collides with MVP 16 §5 item 5's post-wave-2 alpha "through the old Studio plus the new activity list". §9 Q4 puts the merge timing to the CTO; the plan executes identically either way.

### 3.9 `/scripts` gets a nav entry while it is still a redirect

`packages/studio/src/app/scripts/page.tsx` is a query-preserving `router.replace('/plugins')` today (read 2026-09-03). The MVP's Scripts & workflows screen lives at `/scripts` and is plan 217's. This plan points the nav entry at `/scripts` and leaves the redirect alone: clicking it lands on `/plugins`, which is where a script is listed until 217 lands, so the entry is useful rather than broken. `NOT_IN_NAV_BY_DESIGN`'s `/scripts` exemption disappears because the route now has an entry. Do not build a placeholder page.

## 4. Technical design

### 4.1 The handoff, verbatim

From `docs/mvp/design_handoff_enkaku_openpf/README.md`, lines 36–74 ("Global shell"), quoted with the handoff's own punctuation:

> **Root:** `height: 100vh; display: flex; gap: 10px; padding: 10px; background: var(--bg)`.
> Two children: the icon rail, then a column holding the active page panel and the status bar.
>
> **Icon rail** — `width: 60px`, `background: var(--panel)`, `border: 1px solid var(--border)`,
> `border-radius: 16px`, `padding: 10px 0 12px`, `gap: 6px`, centered column. No logo; the first item is
> the first nav entry.
>
> Nav items: 36×36, `border-radius: 10px`, icon 17px. Active = `background: var(--accent-soft)`,
> `color: var(--accent)`. Idle = `color: var(--faint)`, hover `background: var(--muted-2)`, `color: var(--text)`.
>
> | Order | Icon (Phosphor regular) | Title | Page |
> |---|---|---|---|
> | 1 | `ph-devices` | Devices | `devices` |
> | 2 | `ph-code` | Scripts & workflows | `scripts` |
> | 3 | `ph-lightning` | Jobs | `jobs` |
> | 4 | `ph-puzzle-piece` | Plugins | `plugins` |
>
> Then `flex: 1` spacer, then: **theme toggle** (`ph-moon` in light / `ph-sun` in dark, title
> "Switch to dark mode" / "Switch to light mode"), **Settings** (`ph-gear`, opens the `settings` page),
> and an avatar chip — 30×30, `border-radius: 999px`, `background: var(--avatar-bg)`,
> `color: var(--avatar-fg)`, 11px/600, initials "RZ".
>
> A **dynamic menu section** is planned: plugins may register their own view pages, appended under the
> static nav. Not yet designed — needs the plugin manifest shape (label, icon, route, position).
>
> **Status bar** (bottom, every page) — `height: 44px`, `background: var(--panel)`,
> `border: 1px solid var(--border)`, `border-radius: 14px`, `padding: 0 8px 0 14px`, items separated by
> 1px×18px `var(--line-2)` dividers:
>
> 1. Pulsing 7px dot `var(--ok)` (`enkakuPulse`, 2.6s) + "System OK" (12px, `var(--text-3)`).
> 2. Scrollable stat row: `Devices 58/64` (value 12.5px/600 `var(--accent)`), `Jobs 12/17`
>    (value 12.5px/600 `var(--text)`) — running/total where total includes queued.
> 3. Console toggle (`ph-terminal-window`) and Alerts (`ph-bell` with a 6px `var(--danger)` dot).
> 4. Clock, `Geist Mono` 12px `var(--text-3)`, ticking every second.
>
> **Page panels** all share: `flex: 1; background: var(--panel); border: 1px solid var(--border);
> border-radius: 16px; overflow: hidden`.

From "Interactions & Behavior" (lines 448–465), the three rows this plan owns:

> | Escape | Close popover/menu/window if any; otherwise clear selection |
> | Click outside a `[data-menu-root]` | Close menus, the info popover, and the group form |
> | Theme toggle | Flip `data-theme` on `<html>`, persisted in `localStorage` under `enkaku-theme` |
>
> Animations are deliberately minimal: `enkakuPulse` (2.6s status dot) and `enkakuSpin` (0.9s rescan).
> No page transitions.

Four values come from the prototype (`Enkaku Device List.dc.html`) rather than the README, because the README does not state them and the prototype is the design of record:

| Value | Where | Line |
|---|---|---|
| `min-height: 460px`, `color: var(--text)`, `font-family: 'Geist'`, `font-size: 13px`, `overflow: hidden` on the root | `:52` | the root `<div>` |
| `gap: 10px`, `flex-direction: column`, `min-width: 0` on the right-hand column | `:65` | |
| `margin-top: 6px` on the avatar chip | `:61` | |
| status bar `gap: 2px`; group 1 `gap: 8px; padding-right: 14px`; stat item `gap: 8px; padding: 0 14px`; icon group `gap: 4px; padding: 0 8px`; clock `padding: 0 12px`; icon buttons 32×32 radius 10; the alerts dot `top: 5px; right: 5px` | `:684-714` | |
| the clock string is `HH:MM:SS`, zero-padded, local time | `:1054-1057` `fmtClock` | |

### 4.2 File structure

```
packages/studio/src/
  app/
    layout.tsx                        CHANGED  (theme boot script; no fonts.ts import, plan 204 removed that)
    globals.css                       CHANGED  (@layer base only)
  components/
    shell/
      AppShell.tsx                    NEW  the composition; the only mount point for the shell utilities
      Rail.tsx                        NEW  the 60px rail: static nav, plugin group, theme toggle, Settings, avatar
      StatusBar.tsx                   NEW  the 44px bar: health dot, counters, alerts, clock
      PagePanel.tsx                   NEW  the 16px-radius panel every screen renders inside
      ThemeToggle.tsx                 NEW  built on plan 204's resolveTheme / useResolvedTheme
      AvatarMenu.tsx                  NEW  the 30x30 chip and its popover (identity, sign out)
      nav.ts                          NEW  NAV, AGENTS_IN_RAIL, the plugin-nav schema and flattener
      theme-boot.ts                   NEW  the inline script string layout.tsx injects
    layout/
      AppShell.tsx                    DELETED
    NotificationBell.tsx              CHANGED  re-skinned as the status bar's Alerts button
    ProvisioningBanner.tsx            DELETED
    layout/AdbServerBanner.tsx        DELETED
    operations/OperationTray.tsx      DELETED
  lib/
    shell-state.ts                    NEW  the pushed counters and the health state, one store for the app
    overlays.ts                       NEW  Escape tiering + [data-menu-root] outside-click
    prefs.ts                          CHANGED  sidebarCollapsed deleted
packages/ui/src/
  icons.ts                            CHANGED  group 3: RobotIcon
scripts/
  check-routes.ts                     NEW
.github/workflows/ci.yml              CHANGED  one step added
```

### 4.3 `packages/studio/src/lib/shell-state.ts` (new)

One store, one instance, ref-counted the way `OperationsStore` and `WsClient` already are, so nothing runs on `/login` or `/setup`.

```ts
'use client'

import type { AdbServerPhase, DeviceInfo } from '@enkaku/protocol'

/**
 * Everything the shell shows that is not navigation: the two status-bar
 * counters and the health dot (plan 213 §4.3).
 *
 * The rule this file exists to enforce: NOTHING here runs on a timer. The
 * previous shell polled four endpoints on every `job.status`
 * (`components/layout/AppShell.tsx:256-261`, deleted) and `lib/operations.ts`
 * ran a 5 s interval over four more (`:592`). Both are replaced by one
 * snapshot at mount and the pushes the core already broadcasts
 * (MVP 13 A.6). A `setInterval` in this file is a defect; `GREP_213_POLL`
 * fails the build over it.
 */
export interface DeviceCounts {
  /** `status === 'online'`. */
  online: number
  /** Every admitted device, whatever its status. */
  total: number
}

export interface JobCounts {
  /** Live `job` and `workflow-job` activities across every device. Exact, never seeded. */
  running: number
  /** Seeded once and maintained by `job.status`; see the drift note below. */
  queued: number
}

/**
 * What the dot and the sentence beside it say. Precedence, highest first:
 * `offline` (the socket is down, so nothing else here can be trusted), then
 * `adb` (every device is about to drop), then `provisioning` (first run),
 * then `degraded`, then `ok`.
 */
export type HealthState =
  | { kind: 'offline' }
  | { kind: 'adb'; phase: AdbServerPhase; detail: string }
  | { kind: 'provisioning'; detail: string }
  | { kind: 'degraded'; detail: string }
  | { kind: 'ok' }

export interface ShellState {
  devices: DeviceCounts
  jobs: JobCounts
  health: HealthState
  /** From `GET /api/health`; the avatar popover shows it. Null until the first read lands. */
  version: string | null
  /** `'local' | 'orchestrator'`, from the same read. */
  mode: string
}

export declare class ShellStateStore {
  subscribe: (cb: () => void) => () => void
  getSnapshot: () => ShellState
  getServerSnapshot: () => ShellState
}

export declare const shellStateStore: ShellStateStore
export declare function useShellState(store?: ShellStateStore): ShellState
```

Rules the implementation must follow, exactly:

1. **`start()` on the first subscriber, `stop()` on the last.** `start()` registers `ws.onStatus`, `ws.onReconnected` and one `ws.on` handler, then runs `seed()`. `stop()` removes all three and resets the state to the empty value. Model on `lib/operations.ts:563-605`.
2. **`seed()` issues exactly three requests, concurrently, and is called from `start()` and from `ws.onReconnected`, and from nowhere else.**
   - `fetchDevices()` (`lib/api.ts:107`) → `total = items.length`; `online = items.filter(d => d.status === 'online').length`; and it rebuilds `jobActivityIds` (below) from every `d.activities` entry whose `kind` is `job` or `workflow-job`.
   - `GET ${coreBase()}/api/jobs?status=queued&limit=1`, parsed through `JobsPageResponseSchema` → `queuedBase = total`; `queuedIds` is cleared.
   - `GET ${coreBase()}/api/health`, parsed through `HealthResponseSchema.safeParse` → `version`, `mode`, and `healthOk = parsed.data?.ok !== false`.
   Every one of the three has its own `.catch()`: a failed read leaves that slice of the state where it was and never throws into a render. All three share one `AbortController` per `seed()` call, aborted when a newer `seed()` starts and on `stop()`.
3. **Device counts follow three messages.** `device.added` → `total += 1`, and `online += 1` when `payload.status === 'online'`. `device.removed` → `total -= 1`, and drop the id from `onlineIds`. `device.status` → move the id in or out of `onlineIds`. Keep `onlineIds: Set<string>` rather than an integer so a repeated `device.status` for the same device cannot double-count; `online` is `onlineIds.size`. Clamp `total` at 0.
4. **Running jobs come from activities, never from job events.** Keep `jobActivityIds: Set<string>` of `` `${deviceId}:${activity.id}` ``. On `device.activity`: when `payload.change` is `added` or `updated` and `payload.activity.kind` is `job` or `workflow-job`, add the key; when it is `ended`, delete it. `running` is `jobActivityIds.size`. This half is exact because plan 205's registry holds a live activity for exactly the life of the run.
5. **Queued jobs are a base plus a set.** Keep `queuedBase: number` (queued jobs that existed at seed time, whose ids the shell never saw) and `queuedIds: Set<string>` (jobs the shell watched enter the queue). On a `job.status` push with payload `{ id, status }`:
   - `status === 'queued'` → `queuedIds.add(id)`.
   - otherwise → if `queuedIds.delete(id)` returned true, stop; else if `status === 'running'` and `queuedBase > 0`, `queuedBase -= 1`.
   `queued` is `queuedBase + queuedIds.size`.
   **Known, bounded drift, stated on purpose:** a job that was already queued when the shell mounted and is then cancelled or expires without ever running leaves `queuedBase` one too high, because `queued → cancelled` and `running → cancelled` are indistinguishable for an id the shell never saw. The repair is `seed()` on the next reconnect. Do not try to fix it with a second list read; §9 Q3 proposes the core-side counter instead.
6. **Health.** `ws.onStatus(connected)` → `connected === false` sets `{ kind: 'offline' }` and nothing else changes. On `tool.provision.progress`, `step !== 'done'` sets `{ kind: 'provisioning', detail }` where `detail` is `` `${PHASE_LABEL[phase] ?? 'Provisioning'} ${toolId ?? ''}`.trim() `` and `step === 'done'` clears it. On `adb.server.phase`, a phase other than `done` and `failed` sets `{ kind: 'adb', phase, detail }`; `done` clears it; `failed` sets `{ kind: 'degraded', detail }`. With none of those live, `healthOk === false` gives `{ kind: 'degraded', detail: 'the core reported not ok' }` and otherwise `{ kind: 'ok' }`. `PHASE_LABEL` for both streams is copied verbatim from the two deleted banners (`ProvisioningBanner.tsx:33-38`, `AdbServerBanner.tsx:26-35`) so no wording is lost.
7. **Never `as`-cast a response.** `fetchDevices()` already returns `DeviceInfo[]`; the other two go through `JobsPageResponseSchema` and `HealthResponseSchema` with `safeParse`.

Label and colour, derived in `StatusBar.tsx`, not in the store:

| `health.kind` | Dot | Sentence |
|---|---|---|
| `ok` | `bg-ok` + `animate-enkaku-pulse` | `System OK` |
| `provisioning` | `bg-warn` + `animate-enkaku-pulse` | `health.detail` (e.g. `Downloading scrcpy-server`) |
| `adb` | `bg-warn` + `animate-enkaku-pulse` | `health.detail` (e.g. `Restarting the adb server`) |
| `degraded` | `bg-warn` + `animate-enkaku-pulse` | `Core degraded` (`title` carries `health.detail`) |
| `offline` | `bg-danger`, no pulse | `Core offline` |

### 4.4 `packages/studio/src/components/shell/nav.ts` (new, complete)

```ts
import { CodeIcon, DevicesIcon, LightningIcon, PuzzlePieceIcon, RobotIcon, type Icon } from '@enkaku/ui'
import { z } from 'zod'

/**
 * Agents in the rail is an OPEN decision (MVP 15 §4.1, MVP 16 §4.1): a fifth
 * static icon, or the first entry of the dynamic plugin menu. One constant,
 * one row of data, one rail. There is deliberately no second variant to keep
 * true (plan 213 §3.5). Setting this to `false` and shipping an `agents`
 * plugin that declares a nav entry is the whole of the other answer; nothing
 * else in the shell changes.
 */
export const AGENTS_IN_RAIL = true

export interface NavItem {
  href: string
  /** The rail has no labels; this is the `title` and the `aria-label`. */
  label: string
  icon: Icon
}

/**
 * The static rail, in the handoff's order (README "Global shell", rows 1-4)
 * with Agents inserted at MVP 03 §1's position: between Jobs and Plugins.
 * Settings is NOT here: the handoff puts it in the footer group below the
 * spacer, beside the theme toggle and the avatar (`Rail.tsx`).
 *
 * No counts, no badges. The old sidebar carried a number on four of its
 * fourteen items and a warning tone on one (`components/layout/AppShell.tsx`,
 * deleted); at 36x36 with no label there is nowhere to put one, and the two
 * numbers an operator actually watches are in the status bar instead.
 */
export const NAV: readonly NavItem[] = [
  { href: '/', label: 'Devices', icon: DevicesIcon },
  { href: '/scripts', label: 'Scripts & workflows', icon: CodeIcon },
  { href: '/jobs', label: 'Jobs', icon: LightningIcon },
  ...(AGENTS_IN_RAIL ? [{ href: '/agents', label: 'Agents', icon: RobotIcon }] : []),
  { href: '/plugins', label: 'Plugins', icon: PuzzlePieceIcon },
]

/** The gear below the spacer. Kept out of `NAV` so the four-or-five count above stays readable. */
export const SETTINGS_HREF = '/settings'

/**
 * The shell's own read of `GET /api/plugins/ui`. Deliberately LOOSER than
 * `@enkaku/protocol`'s `PluginUiResponseSchema` in exactly one place: `icon`
 * is a plain string here, not `IconNameSchema`.
 *
 * The strict enum is right at the boundary that ACCEPTS a plugin
 * (`definePlugin`, verify and the surface registry, all of which refuse an
 * unknown name and say so). Re-imposing it here would mean a Studio bundle
 * older than the core silently dropping a whole plugin's nav group because it
 * had never heard of one picture; `pluginIcon` falls back instead. Everything
 * else is still parsed, never `as`-cast, and a response that fails this parse
 * leaves the rail with no plugin group at all.
 */
export const PluginNavResponseSchema = z.object({
  items: z.array(
    z.object({
      plugin: z.string().min(1),
      origin: z.string().default('plugin'),
      nav: z.array(
        z.object({
          id: z.string().min(1),
          label: z.string().min(1),
          icon: z.string().default(''),
          view: z.string().min(1),
        }),
      ),
    }),
  ),
})
export type PluginNavGroup = z.infer<typeof PluginNavResponseSchema>['items'][number]

export interface PluginNavItem {
  key: string
  label: string
  href: string
  icon: string
  /** `origin: 'dev'`: an unpublished dev slot, marked with a warn dot at rail width. */
  isDev: boolean
  plugin: string
  view: string
}

/**
 * One flat list of links out of the per-plugin groups. Static export, so a
 * plugin screen is one page taking query parameters, the way `/device?id=…`
 * established (plan 108 §3.5), which is also why `activePluginView` below
 * has to read the query and cannot go by pathname.
 */
export function pluginNavItems(groups: PluginNavGroup[]): PluginNavItem[] {
  return groups.flatMap((group) =>
    group.nav.map((entry) => ({
      key: `${group.plugin}:${entry.id}`,
      label: entry.label,
      href: `/plugins/view?name=${encodeURIComponent(group.plugin)}&view=${encodeURIComponent(entry.view)}`,
      icon: entry.icon,
      isDev: group.origin === 'dev',
      plugin: group.plugin,
      view: entry.view,
    })),
  )
}

/** `"<plugin>::<view>"` when a plugin screen is the current page, else `null`. */
export function activePluginView(pathname: string, params: URLSearchParams): string | null {
  if (pathname !== '/plugins/view') return null
  return `${params.get('name') ?? ''}::${params.get('view') ?? ''}`
}

/**
 * The static rail's active test. `/` matches only itself: `/device` used to be
 * folded in here (`components/layout/AppShell.tsx:599`) and no longer exists
 * as a route after plan 215: Device Control is a window over the Devices
 * page, not an address. Everything else is a prefix match so a detail route
 * (`/jobs/detail`) lights its own entry.
 */
export function isNavActive(href: string, pathname: string): boolean {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`)
}
```

`GET /api/plugins/ui` is `packages/core/src/api/plugins.ts:391` `app.get('/ui', requirePermission('script.view'), (c) => c.json({ items: surfaces.ui() }))`, and `surfaces.ui()` (`packages/core/src/plugins/surface-registry.ts:100-127`) contributes a group only for a dev slot or a row whose `status === 'active'` (`:120` `if (row.status !== 'active') continue`) that declares at least one nav entry (`:114`, `:124` `if (!surface || surface.nav.length === 0) continue`). No change is needed on the core side.

### 4.5 `packages/studio/src/components/shell/Rail.tsx` (new, complete)

```tsx
'use client'

import Link from 'next/link'
import { GearIcon, cn } from '@enkaku/ui'
import { pluginIcon } from '@/lib/plugin-icons'
import { AvatarMenu } from './AvatarMenu'
import { ThemeToggle } from './ThemeToggle'
import { NAV, SETTINGS_HREF, isNavActive, type PluginNavItem } from './nav'

/**
 * The 60px icon rail (design handoff, "Global shell"):
 *   width: 60px; background: var(--panel); border: 1px solid var(--border);
 *   border-radius: 16px; padding: 10px 0 12px; gap: 6px; centered column.
 * No logo: "the first item is the first nav entry". The brand mark the old
 * sidebar carried (`components/layout/AppShell.tsx:540-549`) is gone with it.
 */
const ITEM = 'flex size-9 shrink-0 items-center justify-center rounded-button transition-colors'
const IDLE = 'text-faint hover:bg-muted-2 hover:text-text'
const ACTIVE = 'bg-accent-soft text-accent'

export function Rail({
  pathname,
  pluginItems,
  activeView,
}: {
  pathname: string
  /** Already flattened; empty when no plugin contributes one AND when the read failed. */
  pluginItems: PluginNavItem[]
  /** `"<plugin>::<view>"` or null. */
  activeView: string | null
}) {
  return (
    <nav
      aria-label="Main navigation"
      className="flex w-[60px] shrink-0 flex-col items-center gap-[6px] rounded-panel border border-border bg-panel pt-[10px] pb-[12px]"
    >
      {NAV.map((item) => {
        const active = isNavActive(item.href, pathname)
        const Icon = item.icon
        return (
          <Link
            key={item.href}
            href={item.href}
            title={item.label}
            aria-label={item.label}
            aria-current={active ? 'page' : undefined}
            className={cn(ITEM, active ? ACTIVE : IDLE)}
          >
            <Icon className="size-[17px]" aria-hidden />
          </Link>
        )
      })}

      {/* The dynamic menu section the handoff reserves ("plugins may register
          their own view pages, appended under the static nav"), rendered per
          spec §19 and MVP 03 §1: ONE group BELOW the static nav, never
          interleaved. Two operational reasons: the core nav must not shift
          when a plugin is installed or removed, and an operator can see which
          entries are the product and which came from a plugin. Absent
          entirely when nothing contributes one: a farm with no plugins and a
          farm whose `/api/plugins/ui` read failed render identically, which
          is the point. At 60px there is no room for the handoff's labelled
          group heading, so the separation is a rule instead. */}
      {pluginItems.length > 0 && (
        <>
          <div aria-hidden className="my-[2px] h-px w-5 shrink-0 bg-line-2" />
          <div role="group" aria-label="Plugin views" className="flex flex-col items-center gap-[6px]">
            {pluginItems.map((item) => {
              const active = activeView === `${item.plugin}::${item.view}`
              // The name came off the wire, so it is resolved through the
              // allowlist map (plan 204 §4.5); an unrecognised or missing one
              // falls back. A plugin never supplies markup here.
              const Icon = pluginIcon(item.icon)
              return (
                <Link
                  key={item.key}
                  href={item.href}
                  title={item.isDev ? `${item.label} (DEV) · ${item.plugin}` : `${item.label} · ${item.plugin}`}
                  aria-label={item.label}
                  aria-current={active ? 'page' : undefined}
                  className={cn(ITEM, 'relative', active ? ACTIVE : IDLE)}
                >
                  <Icon className="size-[17px]" aria-hidden />
                  {item.isDev && (
                    <span aria-hidden className="absolute top-[5px] right-[5px] size-[5px] rounded-pill bg-warn" />
                  )}
                </Link>
              )
            })}
          </div>
        </>
      )}

      <div className="flex-1" />

      <ThemeToggle className={cn(ITEM, IDLE)} iconClassName="size-[17px]" />

      <Link
        href={SETTINGS_HREF}
        title="Settings"
        aria-label="Settings"
        aria-current={isNavActive(SETTINGS_HREF, pathname) ? 'page' : undefined}
        className={cn(ITEM, isNavActive(SETTINGS_HREF, pathname) ? ACTIVE : IDLE)}
      >
        <GearIcon className="size-[17px]" aria-hidden />
      </Link>

      <AvatarMenu />
    </nav>
  )
}
```

`size-9` is 36 px, `rounded-button` is the 10 px radius, `size-[17px]` is the handoff's icon size, `rounded-panel` is 16 px, `w-5` is 20 px. All of those come from plan 204 §4.3's mapping table. The four arbitrary values (`w-[60px]`, `pt-[10px]`, `pb-[12px]`, `gap-[6px]`, `size-[17px]`, `size-[5px]`) are lengths, not colours; plan 204's `GREP_213_COLOUR` equivalent forbids only the bracket **colour** form.

### 4.6 `ThemeToggle.tsx` and `AvatarMenu.tsx` (new, complete)

```tsx
// packages/studio/src/components/shell/ThemeToggle.tsx
'use client'

import { MoonIcon, SunIcon, useResolvedTheme } from '@enkaku/ui'

/** The handoff's key, fixed: `localStorage` under `enkaku-theme` (README, Interactions table). */
export const THEME_STORAGE_KEY = 'enkaku-theme'

/**
 * Flip `data-theme` on `<html>` and persist it (design handoff, Interactions:
 * "Theme toggle | Flip `data-theme` on `<html>`, persisted in `localStorage`
 * under `enkaku-theme`").
 *
 * There is no React state here on purpose. Plan 204's `useResolvedTheme`
 * already watches the attribute with a `MutationObserver` and the system
 * preference with a media query, so writing the attribute IS the state
 * update. A second copy in `useState` would be the thing that drifts the
 * first time something else (the boot script, a devtools poke) sets it.
 *
 * NOT stored through `lib/prefs.ts`: the boot script in `app/layout.tsx` has
 * to read this value before any module loads, so the key is a bare string
 * with a bare value, not a JSON envelope behind a Zod parse.
 */
export function ThemeToggle({ className, iconClassName }: { className?: string; iconClassName?: string }) {
  const theme = useResolvedTheme()
  const next = theme === 'dark' ? 'light' : 'dark'
  const title = next === 'dark' ? 'Switch to dark mode' : 'Switch to light mode'

  const flip = () => {
    document.documentElement.setAttribute('data-theme', next)
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next)
    } catch {
      // Private browsing, or storage disabled. The theme still flips for this
      // page; it simply does not survive the reload.
    }
  }

  const Icon = theme === 'dark' ? SunIcon : MoonIcon
  return (
    <button type="button" onClick={flip} title={title} aria-label={title} className={className}>
      <Icon className={iconClassName} aria-hidden />
    </button>
  )
}
```

```tsx
// packages/studio/src/components/shell/AvatarMenu.tsx
'use client'

import { Popover, PopoverContent, PopoverTrigger } from '@enkaku/ui'
import { useAuth } from '@/lib/auth'
import { useShellState } from '@/lib/shell-state'

/**
 * `rz@studio` → `RZ`, the handoff's own example. Two initials across the first
 * separator in the local part, else its first two letters.
 */
export function initialsFor(email: string | null): string {
  const local = (email ?? '').split('@')[0] ?? ''
  const parts = local.split(/[._-]+/).filter(Boolean)
  const first = parts[0] ?? ''
  const second = parts[1] ?? ''
  const raw = second ? `${first[0] ?? ''}${second[0] ?? ''}` : local.slice(0, 2)
  return raw.toUpperCase() || '?'
}

/**
 * The 30x30 avatar chip (design handoff: `border-radius: 999px`,
 * `background: var(--avatar-bg)`, `color: var(--avatar-fg)`, 11px/600) and
 * the only place a person's identity appears in the shell.
 *
 * Local mode has no session at all: the core injects an implicit admin for
 * every request on a loopback bind (`AuthGate`'s own note), so there is no
 * email to draw initials from. The chip is still drawn, because the handoff's
 * rail always has one, and it says the true thing: this core asks nobody who
 * they are.
 */
export function AvatarMenu() {
  const { user, authMode, logout } = useAuth()
  const { version, mode } = useShellState()
  const local = authMode !== 'server' || !user
  const initials = local ? 'LA' : initialsFor(user.email)
  const label = local ? 'Local admin' : user.email

  return (
    <Popover>
      <PopoverTrigger
        aria-label={label}
        title={label}
        className="mt-[6px] flex size-[30px] shrink-0 select-none items-center justify-center rounded-pill bg-avatar-bg text-[11px] font-semibold text-avatar-fg"
      >
        {initials}
      </PopoverTrigger>
      <PopoverContent side="right" align="end" className="w-64">
        <p className="text-row font-medium text-text">{label}</p>
        <p className="mt-0.5 text-meta text-faint">
          {local
            ? 'Local mode: no sign-in. Anyone who can reach this core is an admin.'
            : user.role}
        </p>
        <p className="mt-3 font-mono text-tip text-faint-2">
          {version ? `v${version}` : 'version unknown'} · {mode}
        </p>
        {!local && (
          <button
            type="button"
            onClick={() => void logout()}
            className="mt-3 w-full rounded-button px-[10px] py-[9px] text-left text-row text-text hover:bg-muted"
          >
            Sign out
          </button>
        )}
      </PopoverContent>
    </Popover>
  )
}
```

### 4.7 `packages/studio/src/components/shell/StatusBar.tsx` (new, complete)

```tsx
'use client'

import { StatusDot, cn } from '@enkaku/ui'
import { NotificationBell } from '@/components/NotificationBell'
import { useNow } from '@/lib/useNow'
import { useShellState, type HealthState } from '@/lib/shell-state'

/**
 * The 44px status bar (design handoff, "Global shell"):
 *   height: 44px; background: var(--panel); border: 1px solid var(--border);
 *   border-radius: 14px; padding: 0 8px 0 14px; 1px x 18px var(--line-2)
 *   dividers between four groups.
 *
 * Three of the four groups are the handoff's unchanged. The third loses the
 * Console toggle (`ph-terminal-window`) and keeps Alerts, per MVP 15 §0.1.4:
 * "Console is removed entirely, including the status-bar log console the
 * handoff draws. The status bar keeps System OK, the counters, Alerts, and
 * the clock."
 *
 * The first group also absorbs what two deleted floating banners used to say
 * (`ProvisioningBanner`, `AdbServerBanner`; MVP 13 A.6): first-run toolchain
 * provisioning and an adb server restart both turn the dot amber and replace
 * the sentence. Neither is a per-page concern and neither has anywhere else
 * to go in the handoff's shell.
 */
function Divider() {
  return <div aria-hidden className="h-[18px] w-px shrink-0 bg-line-2" />
}

function healthLabel(h: HealthState): { text: string; title: string; dot: 'ok' | 'warn' | 'danger'; pulse: boolean } {
  switch (h.kind) {
    case 'offline':
      return { text: 'Core offline', title: 'the connection to the core is down', dot: 'danger', pulse: false }
    case 'adb':
      return { text: h.detail, title: `adb server: ${h.phase}`, dot: 'warn', pulse: true }
    case 'provisioning':
      return { text: h.detail, title: 'first-run toolchain provisioning', dot: 'warn', pulse: true }
    case 'degraded':
      return { text: 'Core degraded', title: h.detail, dot: 'warn', pulse: true }
    case 'ok':
      return { text: 'System OK', title: 'the core is reachable and healthy', dot: 'ok', pulse: true }
  }
}

function Stat({ label, value, accent }: { label: string; value: string; accent: boolean }) {
  return (
    <div className="flex flex-none items-center gap-2 px-[14px]">
      <span className="text-[12px] text-faint">{label}</span>
      <span className={cn('font-mono text-body font-semibold', accent ? 'text-accent' : 'text-text')}>{value}</span>
    </div>
  )
}

export function StatusBar() {
  const { devices, jobs, health } = useShellState()
  const now = useNow(1000)
  const h = healthLabel(health)
  const p = (n: number) => String(n).padStart(2, '0')
  const d = new Date(now)
  const clock = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`

  return (
    <div className="flex h-[44px] flex-none items-center gap-[2px] rounded-card border border-border bg-panel pr-[8px] pl-[14px]">
      <div className="flex flex-none items-center gap-2 pr-[14px]" title={h.title}>
        {/* The handoff's 7px `var(--ok)` dot with `enkakuPulse 2.6s`. `StatusDot`
            (plan 204 §4.6) carries the pulse and the five state colours; the
            size is passed because 7px is this dot's alone. */}
        <StatusDot
          state={h.dot === 'ok' ? 'free' : h.dot === 'warn' ? 'unauthorized' : 'job'}
          pulse={h.pulse}
          className="size-[7px]"
          title={h.text}
        />
        <span className="text-[12px] text-text-3">{h.text}</span>
      </div>

      <Divider />

      <div className="flex min-w-0 flex-1 items-center overflow-x-auto">
        <Stat label="Devices" value={`${devices.online}/${devices.total}`} accent />
        <Stat label="Jobs" value={`${jobs.running}/${jobs.running + jobs.queued}`} accent={false} />
      </div>

      <Divider />

      <div className="flex flex-none items-center gap-1 px-2">
        <NotificationBell />
      </div>

      <Divider />

      <div className="flex-none px-3 font-mono text-[12px] text-text-3">{clock}</div>
    </div>
  )
}
```

`StatusDot`'s state names are plan 204 §4.6's five device states, and the mapping above reuses three of them for their colours (`free` → `bg-ok`, `unauthorized` → `bg-warn`, `job` → `bg-danger`). That is the one place in this plan where a component prop is used for a colour rather than a meaning; it is done because the alternative (a second dot component that differs only in its state vocabulary) is worse, and it is called out here so a reviewer does not read `state="job"` as "a job is running". If plan 214 finds this confusing in practice, widening `StatusDotState` with a neutral `warn`/`danger` pair is the fix, not a new component.

`useNow(1000)` (`packages/studio/src/lib/useNow.ts`) is the existing one-interval-per-component clock; it stops while the tab is hidden and resyncs on `visibilitychange`, which is exactly right for a wall clock and is not a fetch (G6's grep excludes it by naming the store file and the shell directory, and `useNow` is neither).

`NotificationBell` is re-skinned in place (§5 step 213.6) to the handoff's Alerts button: a 32×32 `rounded-button` trigger, `text-faint hover:bg-muted-2 hover:text-text`, a `BellIcon` at `size-4`, and, when `unreadCount > 0`, one absolutely positioned `size-[6px] rounded-pill bg-danger` dot at `top-[5px] right-[5px]`. The handoff's dot carries no number ("`ph-bell` with a 6px `var(--danger)` dot"), so the current `9+` badge (`NotificationBell.tsx:94-98`) goes; the count moves into the trigger's `aria-label` and `title`, where it is still available to a screen reader and a hover.

### 4.8 `PagePanel.tsx` and `AppShell.tsx` (new, complete)

```tsx
// packages/studio/src/components/shell/PagePanel.tsx
import type { ReactNode } from 'react'
import { cn } from '@enkaku/ui'

/**
 * The one page panel (design handoff, "Global shell"): "Page panels all share:
 * `flex: 1; background: var(--panel); border: 1px solid var(--border);
 * border-radius: 16px; overflow: hidden`."
 *
 * `relative flex min-h-0 flex-col` is this plan's addition and is not
 * decoration: `overflow: hidden` on a flex child needs `min-h-0` to stop the
 * content forcing the panel taller than the viewport, and the column plus
 * `relative` are what the handoff's own screens assume (a 58px toolbar over a
 * scroller, with the bulk pill and Device Control positioned against the
 * panel). The prototype's root panel has all three.
 *
 * There is NO page title here, deliberately. The handoff puts each screen's
 * header inside its own panel and says so for Jobs: "The tab strip **is** the
 * page header (no separate 'Jobs / N total' title above it)."
 */
export function PagePanel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-panel border border-border bg-panel',
        className,
      )}
    >
      {children}
    </div>
  )
}
```

```tsx
// packages/studio/src/components/shell/AppShell.tsx
'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { coreBase } from '@/lib/ws'
import { useShellHotkeys, useOutsideMenuClick } from '@/lib/overlays'
import { PagePanel } from './PagePanel'
import { Rail } from './Rail'
import { StatusBar } from './StatusBar'
import { PluginNavResponseSchema, activePluginView, pluginNavItems, type PluginNavGroup } from './nav'

/**
 * The app frame (design handoff, "Global shell"):
 *   Root: height: 100vh; display: flex; gap: 10px; padding: 10px;
 *         background: var(--bg).
 *   Two children: the icon rail, then a column holding the active page panel
 *   and the status bar.
 *
 * Mounted once, by `AuthGate`, around every authenticated route. It is the
 * only place the shell's three global behaviours are installed: the pushed
 * counters (`lib/shell-state.ts`, through `StatusBar`), the Escape tier stack
 * and the `[data-menu-root]` outside-click listener (`lib/overlays.ts`). A
 * screen registers into those; it never installs its own.
 *
 * Below 1024px the rail stays a rail. The handoff designed no mobile layout
 * ("desktop-first … usable down to ~960px; no mobile layout was designed"),
 * and the sheet the previous shell opened there
 * (`components/layout/AppShell.tsx:498-509`) existed to hold fourteen labelled
 * items. Five 36px icons need no sheet: the page panel gets narrower, its own
 * content scrolls, and nothing about the frame changes.
 */
export function AppShell({ children }: { children: ReactNode }) {
  // Empty until it loads, empty forever if the read fails: a farm with no
  // plugins and a farm whose plugin list could not be read look the same here,
  // which is the point: neither is allowed to move a core nav item.
  const [pluginNav, setPluginNav] = useState<PluginNavGroup[]>([])
  const pathname = usePathname()
  // Safe here: `AppShell` only ever renders inside `AuthGate`'s `<Suspense>`
  // boundary, which is what a static export needs before it will prerender a
  // `useSearchParams()` caller at all.
  const searchParams = useSearchParams()

  useShellHotkeys()
  useOutsideMenuClick()

  /**
   * `pathname` is the dependency, not a timer and not a WS event. The screens
   * a plugin declares cannot change because a job moved from `queued` to
   * `running`, and on a farm running batches `job.status` fires several times
   * a second. That is how this exact read became the most expensive request
   * in Studio once before (plan 126 §0.4). A client-side navigation is the
   * cheapest trigger that still covers the one flow that changes the answer:
   * installing, activating or disabling a plugin and then going elsewhere.
   */
  useEffect(() => {
    const ctrl = new AbortController()
    let disposed = false
    void (async () => {
      const body = await fetch(`${coreBase()}/api/plugins/ui`, { signal: ctrl.signal })
        .then((r) => r.json())
        .catch(() => null)
      if (disposed) return
      // Parsed, never `as`-cast: a 404 or 403 body is a perfectly valid JSON
      // document that simply is not this shape, and `safeParse` is what turns
      // that into "no plugin group" instead of a render-time throw.
      const parsed = PluginNavResponseSchema.safeParse(body)
      setPluginNav(parsed.success ? parsed.data.items : [])
    })()
    return () => {
      disposed = true
      ctrl.abort()
    }
  }, [pathname])

  return (
    <div className="flex h-screen min-h-[460px] gap-[10px] overflow-hidden bg-bg p-[10px] font-sans text-row text-text">
      <Rail
        pathname={pathname}
        pluginItems={pluginNavItems(pluginNav)}
        activeView={activePluginView(pathname, searchParams)}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-[10px]">
        <PagePanel>{children}</PagePanel>
        <StatusBar />
      </div>
    </div>
  )
}
```

`h-screen` is `100vh`, the handoff's own unit. `h-dvh` was considered and rejected: the handoff says `vh`, and there is no mobile layout for the dynamic viewport to matter to.

### 4.9 `packages/studio/src/lib/overlays.ts` (new)

Two shell-level utilities, so plans 214–220 register rather than each installing a `document` listener.

```ts
'use client'

/**
 * Escape tiering and `[data-menu-root]` containment, installed ONCE by
 * `AppShell` (design handoff, Interactions: "Escape | Close popover/menu/
 * window if any; otherwise clear selection" and "Click outside a
 * `[data-menu-root]` | Close menus, the info popover, and the group form").
 *
 * Modelled on the prototype's own two document listeners
 * (`Enkaku Device List.dc.html:1015-1045`): one capture-phase `click` whose
 * test is `!e.target.closest('[data-menu-root]')`, and one `keydown` that
 * closes menus and windows first and only then clears the selection.
 */
export type OverlayTier = 'menu' | 'window' | 'selection'

/**
 * Registers a closer. Highest tier present wins on Escape; within a tier the
 * most recently registered closes first (a menu opened over a menu). Returns
 * the deregistrar. Call it in the effect cleanup; never leave one behind.
 */
export declare function registerOverlay(tier: OverlayTier, close: () => void): () => void

/** `registerOverlay` as an effect: registers while `open`, deregisters when it closes or the component unmounts. */
export declare function useOverlay(tier: OverlayTier, open: boolean, close: () => void): void

/** Installed by `AppShell` only. Adds the one `keydown` listener. */
export declare function useShellHotkeys(): void

/** Installed by `AppShell` only. Adds the one capture-phase `click` listener. */
export declare function useOutsideMenuClick(): void
```

Rules:

1. One module-level registry: `Map<OverlayTier, Array<{ id: number; close: () => void }>>`, insertion-ordered, ids monotonic.
2. **Escape**: `document.addEventListener('keydown', …)` (bubble phase). Ignore the event when `event.defaultPrevented` is true or when the target is an `input`, `textarea`, or `[contenteditable]` **and** no `menu` or `window` overlay is registered (a menu opened from inside a search field must still close on Escape). Then, in order `menu`, `window`, `selection`: if that tier has entries, call the **last** one's `close` and stop. Never call more than one closer per keypress: that is what "tiered" means, and closing a menu and the window under it with one press is the bug the handoff's wording rules out.
3. **Outside click**: `document.addEventListener('click', …, true)` in the capture phase, matching the prototype, so a handler that stops propagation cannot keep a menu open. If `event.target` is an `Element` and `event.target.closest('[data-menu-root]')` is null, call every registered `menu` closer, most recent first. `window` and `selection` tiers are untouched by a click.
4. Both listeners are removed on unmount. Neither reads or writes any state of its own.
5. A screen marks the element that contains a popover and its trigger with `data-menu-root` (any truthy value; the prototype writes `data-menu-root="1"`), and calls `useOverlay('menu', open, close)`.

### 4.10 `scripts/check-routes.ts` (new)

```ts
#!/usr/bin/env bun
/**
 * The orphan-route rule, as a CI script.
 *
 * It used to be a Studio test (`components/layout/AppShell.test.tsx:449-463`,
 * "no built top-level page is missing from the sidebar"), written because
 * `/workflows`, `/recordings` and `/topology` were all built, tested and
 * shipped with no way in. Plan 201 deleted every Studio test (plan 200 §8.3)
 * and no MVP plan may write another, so the rule moved here (plan 213 §3.7).
 *
 * It checks three things and exits non-zero on any of them:
 *   1. every top-level `src/app` directory holding a `page.tsx` is either in
 *      the rail or in one of the three lists below;
 *   2. every entry in those lists still exists on disk. A stale exemption is
 *      a failure, so the plan that deletes a route must prune its own row and
 *      the list can never rot into a permanent excuse;
 *   3. no route is both in the rail and in a list.
 */
```

Three lists, complete:

```ts
/** Never in the rail, and that is correct. */
const NOT_IN_NAV_BY_DESIGN: Record<string, string> = {
  '/login': 'auth route; AuthGate redirects here, and there is no session to draw a rail for',
  '/setup': 'first run only; AuthGate redirects here',
}

/**
 * Still on disk, no rail entry, and a NAMED later plan deletes it. Every row
 * is a debt with an owner (MVP 03 §1, MVP 13 A.6). Deleting the route without
 * deleting the row fails check 2.
 */
const PENDING_REMOVAL: Record<string, string> = {
  '/device': 'plan 215: Device Control is the device surface; the device page and its route go (MVP 15 §1)',
  '/groups': 'plan 214: groups are managed from the Devices tab strip; no dedicated page (MVP 15 §0.1.3)',
  '/nodes': 'plan 214: Nodes becomes a Devices tab, shown only in orchestrator mode (MVP 03 §1.1)',
  '/workflows': 'plan 217: second tab of Scripts & workflows (MVP 03 §1)',
  '/schedules': 'plan 217: third tab of Scripts & workflows (MVP 15 §0.1.1)',
  '/batches': 'plan 218: second tab of Jobs (MVP 15 §1)',
  '/tools': 'plan 219: Toolchain section of Settings (MVP 03 §1.1)',
  '/workspace': 'plan 220: Workspace is renamed Files and lives under Agents (MVP 15 §0.1.2)',
}

/** Parked, not deleted, with no successor plan. */
const DEFERRED: Record<string, string> = {
  '/recordings': 'MVP 15 §0.1.5: recordings are deferred, out of the nav, the code parked behind MVP 06, not deleted',
}
```

The rail side is read from `packages/studio/src/components/shell/nav.ts` with `/href: '([^']+)'/g` plus `SETTINGS_HREF`'s literal, the same textual approach the deleted test used, so the script does not have to import a `.tsx` module graph. Success prints `routes ok: <n> in nav, <m> exempt`. Failure prints one line per offence naming the route and the fix, and exits 1.

Wired into `.github/workflows/ci.yml`'s `check` job as `- run: bun run scripts/check-routes.ts`, immediately after plan 204's `- run: bun run scripts/check-design-tokens.ts`.

### 4.11 `app/layout.tsx` and `app/globals.css`

`packages/studio/src/components/shell/theme-boot.ts` (new, complete):

```ts
/**
 * Applied before first paint so a dark-theme reload never flashes light
 * (design handoff, Interactions: persisted in `localStorage` under
 * `enkaku-theme`). Inline, tiny, and dependency-free on purpose: it runs
 * before any bundle, which is the whole point of it.
 *
 * It sets nothing when there is no stored choice, `palette.css`'s
 * `@media (prefers-color-scheme: dark)` block already handles that case
 * (plan 204 §3.3), and writing an attribute here would defeat it.
 */
export const THEME_BOOT =
  "try{var t=localStorage.getItem('enkaku-theme');if(t==='dark'||t==='light'){document.documentElement.setAttribute('data-theme',t)}}catch(e){}"
```

`packages/studio/src/app/layout.tsx` (rewritten, complete, starting from plan 204 §4.4's version, which already dropped `fonts.ts`):

```tsx
import type { ReactNode } from 'react'
import { Toaster, TooltipProvider } from '@enkaku/ui'
import { AuthGate } from '@/components/layout/AuthGate'
import { THEME_BOOT } from '@/components/shell/theme-boot'
import '@fontsource-variable/geist/wght.css'
import '@fontsource-variable/geist-mono/wght.css'
import './globals.css'

export const metadata = {
  title: 'Enkaku Studio',
  description: 'Android device farm, remote control and automation',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // `suppressHydrationWarning` because the boot script below writes
    // `data-theme` on this element before React hydrates.
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* eslint-disable-next-line react/no-danger -- a fixed string constant, no interpolation */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body>
        <TooltipProvider delayDuration={200}>
          {/* Every route is gated behind the core's own auth state (plan 09
              §4.14), `AuthGate` renders `/login` or `/setup` standalone when
              unauthenticated, and only wraps `children` in `AppShell` once
              there is a session (or local mode's implicit admin). */}
          <AuthGate>{children}</AuthGate>
        </TooltipProvider>
        <Toaster position="bottom-right" richColors closeButton />
      </body>
    </html>
  )
}
```

`packages/studio/src/app/globals.css`: only the `@layer base` block changes. Lines 50–95 become:

```css
@layer base {
  * {
    border-color: var(--border);
  }

  /*
   * The palette follows the attribute, so `color-scheme` has to as well: with
   * no explicit choice the page follows the system preference exactly the way
   * `palette.css`'s media block does (plan 204 §3.3), and an explicit choice
   * wins in both directions. The prototype's flat `color-scheme: dark` is
   * gone with the prototype's single theme.
   */
  html {
    color-scheme: light dark;
  }
  html[data-theme='light'] {
    color-scheme: light;
  }
  html[data-theme='dark'] {
    color-scheme: dark;
  }

  /*
   * The handoff's root, verbatim: `background: var(--bg)` with the shell's own
   * `font-family: 'Geist'`, `font-size: 13px`, `color: var(--text)`. The
   * prototype Studio's dot-grid `radial-gradient` is deleted; the handoff's
   * page is a flat surface, and the gradient was built out of a block-D token
   * (`--color-fg`) that goes with the last old screen.
   */
  body {
    background-color: var(--bg);
    color: var(--text);
    font-family: var(--font-sans);
    font-size: 13px;
    -webkit-font-smoothing: antialiased;
  }

  :focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
    border-radius: 3px;
  }

  ::selection {
    background: var(--accent);
    color: var(--on-accent);
  }

  @media (prefers-reduced-motion: reduce) {
    *,
    *::before,
    *::after {
      animation-duration: 0.01ms !important;
      transition-duration: 0.01ms !important;
    }
  }
}
```

The `@layer components` block (lines 97–181: `.status-rail`, `.rack-label`, `.readout`) is **not touched**. Those three classes are used by the screens plans 214–220 still have to replace; deleting them here would unstyle every one of them for the whole of wave 3. The last of those plans deletes the block (§10.2).

### 4.12 One addition to `packages/ui/src/icons.ts`

After plan 204's "Group 2", append:

```ts
/**
 * Group 3: names added after the handoff was drawn, each with the reason.
 * A name belongs here only when a screen the handoff does not draw needs it.
 *
 * - `RobotIcon` for the Agents rail entry (MVP 03 §1; the handoff draws no
 *   Agents item because MVP 15 §4.1 left it open). Plan 213 §3.4.
 */
export { RobotIcon } from '@phosphor-icons/react'
```

`packages/ui/src/index.ts` already re-exports `./icons` (plan 204 §4.5), so nothing else changes.

## 5. Implementation steps

Read every file before editing it and match on the quoted content, not on the line number (plan 200 §2.2). Steps 213.1–213.4 may be done in any order; 213.5 onward depend on them.

### 213.1 The icon and the two shell utilities

- Files created: `packages/studio/src/lib/overlays.ts` (§4.9).
- Files changed: `packages/ui/src/icons.ts` (§4.12, append group 3 after the group 2 block ending `} from '@phosphor-icons/react'`).
- Files deleted: none.
- Test file: none, Studio and `@enkaku/ui` have zero tests (plan 200 §8.3).
- Verifiable result: `bun run typecheck` clean; `bun run scripts/check-design-tokens.ts` prints `design tokens ok` (G13); `rg -n "RobotIcon" packages/ui/src/icons.ts` → one line.
- Do not: import `@phosphor-icons/react` from a Studio shell file. `packages/ui/src/icons.ts` is the one place the set is listed (plan 204 §3.7) and this is the first screen built on it.

### 213.2 The pushed store

- Files created: `packages/studio/src/lib/shell-state.ts` (§4.3: the interfaces exactly as written, plus the implementation the seven rules describe).
- Files changed: none.
- Files deleted: none.
- Test file: none.
- Verifiable result: `bun run typecheck` clean; §10.3 `GREP_213_POLL` → empty.
- Do not: add a `setInterval`, a `setTimeout` that refetches, or a `job.status` trigger that re-reads a list. Do not derive `running` from `job.status`; it comes from the activity lists (§4.3 rule 4), which is what makes that half exact.

### 213.3 The nav data and the route script

- Files created: `packages/studio/src/components/shell/nav.ts` (§4.4), `scripts/check-routes.ts` (§4.10).
- Files changed: `.github/workflows/ci.yml` (add `- run: bun run scripts/check-routes.ts` directly after plan 204's `- run: bun run scripts/check-design-tokens.ts` in the `check` job).
- Files deleted: none.
- Test file: none.
- Verifiable result: `bun run scripts/check-routes.ts` exits 1 until step 213.5 creates the file it reads, then 0; §7.2 ROUTE-PLANT passes after 213.5.
- Do not: put the route rule inside `scripts/check-design-tokens.ts` (§3.7). Do not add a route to `NOT_IN_NAV_BY_DESIGN` when a later plan will delete it, that is what `PENDING_REMOVAL` is for, and the difference is whether the row is a permanent exemption or a debt with an owner.

### 213.4 The theme boot and the stylesheet

- Files created: `packages/studio/src/components/shell/theme-boot.ts` (§4.11), `packages/studio/src/components/shell/ThemeToggle.tsx` (§4.6).
- Files changed: `packages/studio/src/app/layout.tsx` (§4.11), `packages/studio/src/app/globals.css` (§4.11: replace the `@layer base` block, lines 50–95, with the block given there).
- Files deleted: none.
- Test file: none.
- Verifiable result: `bun run typecheck` clean; `rg -n "color-scheme: dark;" packages/studio/src/app/globals.css` → one line, inside `html[data-theme='dark']`; `rg -n "radial-gradient" packages/studio/src/app/globals.css` → empty.
- Do not: touch the `@layer components` block (`.status-rail`, `.rack-label`, `.readout`), plans 214–220 still render against it (§4.11). Do not store the theme through `lib/prefs.ts`: the boot script must read a bare key with a bare value.

### 213.5 The shell itself

- Files created: `packages/studio/src/components/shell/AppShell.tsx`, `Rail.tsx`, `StatusBar.tsx`, `PagePanel.tsx`, `AvatarMenu.tsx` (§4.5–§4.8, verbatim).
- Files changed: `packages/studio/src/components/layout/AuthGate.tsx`. Line 5 `import { AppShell } from './AppShell'` becomes `import { AppShell } from '@/components/shell/AppShell'`. Nothing else in that file changes: the auth state machine, the `<Suspense>` boundary and the `FullScreenLoading` fallback all stay. (`FullScreenLoading` at `:21-27` names `bg-bg` and `text-fg-subtle`; leave both, `bg-bg` resolves through block D until the last wave-3 plan, and this is a one-frame spinner.)
- Files deleted: `packages/studio/src/components/layout/AppShell.tsx`.
- Test file: none.
- Verifiable result: `bun run typecheck` clean; `bun run scripts/check-routes.ts` prints `routes ok: 6 in nav, 11 exempt` (five `NAV` entries plus `SETTINGS_HREF`; two `NOT_IN_NAV_BY_DESIGN`, eight `PENDING_REMOVAL`, one `DEFERRED`); §10.3 `GREP_213_COLOUR` → empty.
- Do not: keep a collapse toggle, a mobile `<Sheet>`, a `Brand` mark, a per-item count badge, or a page title above the panel. Do not re-add `TooltipProvider` inside `AppShell`, `app/layout.tsx` already supplies one and the rail uses `title`, not radix tooltips (the handoff's own markup uses `title`).

### 213.6 The Alerts button

- Files created: none.
- Files changed: `packages/studio/src/components/NotificationBell.tsx`, replace `import { Bell } from 'lucide-react'` (`:5`) with `BellIcon` from `@enkaku/ui`; rewrite the trigger (`:88-99`) as the 32×32 handoff button of §4.7 with the 6 px danger dot and the count moved into `aria-label`/`title`; re-skin the popover per plan 204 §4.6's rewrite table (`w-80 p-0` stays; `border-b` → `border-b border-line`; `hover:bg-surface-2/60` → `hover:bg-muted`; `bg-surface-2/30` → `bg-muted-2`; `text-fg-muted` → `text-faint`; `text-fg-subtle` → `text-faint-2`; `bg-led-danger`/`bg-led-warn`/`bg-led-ok` → `bg-danger`/`bg-warn`/`bg-ok`; `readout` → `font-mono`; `text-[13px]` → `text-row`; `text-[12.5px]` → `text-body`; `text-[11.5px]` → `text-meta`; `text-[10.5px]` → `text-badge`).
- Files deleted: none.
- Test file: none.
- Verifiable result: `bun run typecheck` clean; `rg -n "lucide-react" packages/studio/src/components/NotificationBell.tsx` → empty.
- Do not: change what the bell fetches or when. It is already push-driven (`:41-45` reloads on `notification.created`) and it is not part of this plan's polling work.

### 213.7 Deletions

- Files created: none.
- Files changed: `packages/studio/src/lib/prefs.ts`, delete the `sidebarCollapsed: z.boolean().default(false),` field at `:82` and its doc comment at `:73-81`; in `workflowEditorView`'s comment (`:83-89`) replace "it belongs beside `sidebarCollapsed` above" with "it belongs beside `tileSize` above".
- Files deleted: `packages/studio/src/components/operations/OperationTray.tsx`, `packages/studio/src/components/ProvisioningBanner.tsx`, `packages/studio/src/components/layout/AdbServerBanner.tsx` (plan 201 already deleted the three matching `*.test.tsx`).
- Test file: none.
- Verifiable result: §10.3 `GREP_213_TRAY` → empty; `rg -n "sidebarCollapsed" packages/studio/src` → empty; §10.3 `GREP_213_OPERATIONS` → exactly the four lines §10.2 names; `bun run typecheck` clean.
- Do not: delete `packages/studio/src/lib/operations.ts`, `components/operations/ReattachBanner.tsx` or `components/operations/TransferProgressBar.tsx`. Four bulk dialogs import them and plan 216 owns all seven files (§3.6). Do not delete `components/operations/` as a directory, two files stay in it.

### 213.8 Final verification

- Commands, one at a time, never concurrently: `bun run typecheck`; `bun run scripts/check-design-tokens.ts`; `bun run scripts/check-routes.ts`; §7.2 ROUTE-PLANT; every §10.3 grep; `ps -Ao pid=,command= | grep -i "[o]penpf"` → nothing but your shell.
- Run the owner smoke (§7.3) if the owner is available; otherwise leave G2, G5, G7 and G8 as `owner` and say so in §11.
- Update the `> Status:` line and write §11; `bash scripts/check-plan-status.sh` passes.

## 6. Acceptance criteria

1. G1, G3, G4, G6, G9–G15 checked; G2, G5, G7, G8 checked or recorded as `owner` with the smoke step that is outstanding.
2. `bun run typecheck` prints `OK` for every package, `studio` included.
3. `bun run scripts/check-routes.ts` prints `routes ok: 6 in nav, 11 exempt`, and `bun run scripts/check-design-tokens.ts` prints `design tokens ok`.
4. Every §10.3 grep prints exactly what its row says (nothing, or the four named lines).
5. `git diff --stat mvp -- packages/studio/src` lists only: the eight new `components/shell/` files, the two new `lib/` files, `app/layout.tsx`, `app/globals.css`, `components/layout/AuthGate.tsx`, `components/NotificationBell.tsx`, `lib/prefs.ts`, and the four deletions.
6. `git diff --stat -- plugins packages/core/packs` is empty: no plugin version moved and no pack was rebuilt.
7. `packages/ui` shows exactly one changed file (`src/icons.ts`) and one added export.

## 7. Test plan

Studio has zero tests and none is written here (plan 200 §8.3). Verification is a typecheck, two scripts, and one owner smoke.

### 7.1 Commands

```bash
bun run typecheck
bun run scripts/check-design-tokens.ts
bun run scripts/check-routes.ts
```

Never `bun test`. No backend module is touched, so no backend test file is in scope; if a change turns out to require one, that is a discrepancy for §11, not a reason to run a suite.

### 7.2 The route script proves itself (ROUTE-PLANT)

```bash
mkdir -p packages/studio/src/app/zzz-orphan
printf 'export default function Orphan() { return null }\n' > packages/studio/src/app/zzz-orphan/page.tsx
bun run scripts/check-routes.ts; echo "exit=$?"     # expected: a line naming /zzz-orphan, exit=1
rm -rf packages/studio/src/app/zzz-orphan
bun run scripts/check-routes.ts; echo "exit=$?"     # expected: routes ok: 6 in nav, 11 exempt, exit=0
```

And the stale-exemption half:

```bash
git mv packages/studio/src/app/tools /tmp/plan213-tools-probe
bun run scripts/check-routes.ts; echo "exit=$?"     # expected: a line saying /tools is listed in PENDING_REMOVAL but does not exist, exit=1
git mv /tmp/plan213-tools-probe packages/studio/src/app/tools
```

### 7.3 Owner smoke (no device needed)

```bash
bun run dev            # core on :7700, one terminal
bun run dev:studio     # :3001, another terminal
```

Open `http://localhost:3001` beside `docs/mvp/design_handoff_enkaku_openpf/README.md` lines 36–74.

1. **Frame.** DevTools element picker on the root `<div>`: computed `height` equals the viewport height, `display: flex`, `gap: 10px`, `padding: 10px`, `background-color` equals `--bg`. The rail measures 60 px wide with a 16 px radius; the status bar 44 px tall with a 14 px radius; the page panel has a 16 px radius and `overflow: hidden`. There is no title, no banner and no floating tray anywhere on the page.
2. **Rail.** Five icons top to bottom: Devices, Scripts & workflows, Jobs, Agents, Plugins. Each is 36×36 with a 10 px radius and a 17 px glyph. The current one is `--accent-soft` on `--accent`; the rest are `--faint` and turn `--muted-2`/`--text` on hover. Hovering shows the label as a native tooltip. Below the spacer: the moon (light) or sun (dark) with the title "Switch to dark mode"/"Switch to light mode", the gear, and a 30×30 round chip in `--avatar-bg`/`--avatar-fg` with two 11 px semibold initials.
3. **Status bar.** Left to right: a 7 px green dot pulsing on a 2.6 s cycle, "System OK" at 12 px `--text-3`; a 1 px × 18 px divider; `Devices n/m` with the value in 12.5 px/600 `--accent` and `Jobs n/m` with its value in `--text`; a divider; one bell button, 32×32, with a 6 px red dot only when there are unread notifications; a divider; the clock in Geist Mono 12 px `--text-3`, advancing once a second. **There is no terminal icon.**
4. **Theme.** Click the toggle: the whole page flips, `document.documentElement.dataset.theme` reads the new value, and `localStorage.getItem('enkaku-theme')` matches. Reload: the page comes back in the chosen theme with no light flash before paint (watch the first frame; record a screen capture if unsure). Clear the key, set the OS to dark, reload: the page is dark with no `data-theme` attribute set.
5. **No polling (G6, G7).** Open the network tab, filter to XHR/Fetch, reload, and let the Devices page sit untouched for 120 s. Expect exactly four requests after load: `/api/devices` (one or more pages), `/api/jobs?status=queued&limit=1`, `/api/health`, `/api/plugins/ui`, and nothing further. Stop the core: the dot turns red and the sentence reads "Core offline". Start it again: the dot returns to green and exactly the same four requests fire once.
6. **Plugin group (G5).** With `proxy-manager` active, the rail shows a 1 px separator and its entries below the five static icons; the five static icons have not moved. Deactivate it on the Plugins page and navigate anywhere: the group and the separator are gone. Stop the core and reload: the rail still shows exactly five static icons and no separator.
7. **Counters.** Unplug or disconnect one device: `Devices n/m` decrements `n` within a second, with no network request. Enqueue a job from the Plugins page: `Jobs n/m` increments the total, then moves one from queued to running when it starts, then returns to `0/0` when it finishes.
8. **Escape and outside click.** Open the avatar popover, press Escape: it closes. Open it and click on the page panel: it closes.

Stop both processes; `ps -Ao pid=,command= | grep -i "[o]penpf"` → nothing.

Device-gated tests: none in this plan.

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| The old page bodies look wrong inside the new shell for the whole of wave 3 | Expected and bounded (§3.8). The screens keep resolving against `theme.css` block D; only the frame changes. §9 Q4 puts the merge timing to the CTO. |
| The queued-job counter drifts | Bounded to jobs queued before mount that are cancelled without running, repaired by `seed()` on every reconnect (§4.3 rule 5), and stated in the code comment. §9 Q3 proposes the core-side fix for plan 211. |
| Deleting `ProvisioningBanner` loses first-run visibility | Its two streams drive the health dot instead (§4.3 rule 6) and its `PHASE_LABEL` wording is carried over verbatim. §9 Q2 asks whether the dot is enough or the detail needs a home. |
| A later screen installs its own `document` Escape listener and the tiering stops working | `lib/overlays.ts` is the shell's contract for plans 214–220; a second listener is a review failure. The prototype's own behaviour depends on there being one (`Enkaku Device List.dc.html:1038-1044`). |
| `StatusDot`'s state names read as device states in the status bar | Called out at the point of use (§4.7). If plan 214 finds it confusing, widen `StatusDotState`; do not add a second dot component. |
| Plan 207 has already edited two `NAV` rows in the file this plan deletes | Harmless: 207 merges first (plan 200 §8.1) and this plan deletes the whole file. The executor records the conflict resolution in §11, not a revert. |
| `h-screen` (`100vh`) is wrong on a mobile browser with a collapsing URL bar | Accepted: the handoff says `100vh` and designed no mobile layout. Changing it is a design decision, not an implementation one. |
| Adding `RobotIcon` breaks plan 204's token script | The script asserts presence, not exclusivity; G13 runs it and proves this. |
| `NotificationBell`'s unread count stops being visible as a number | The count moves into `title` and `aria-label`, and the handoff's design is a dot. A hover and a screen reader both still get the number. |

## 9. Open questions

1. **Q1, Agents in the rail.** MVP 15 §4.1 and MVP 16 §4.1: a fifth static icon, or the first entry of the dynamic plugin menu. This plan ships `AGENTS_IN_RAIL = true` with the row present (§3.5). If the answer is "under the plugin group", the change is that one constant plus a plugin declaring the nav entry; no shell file is edited. Decider: CEO.
2. **Q2, where provisioning and adb-restart detail goes.** `ProvisioningBanner` showed a per-tool phase and a percentage; `AdbServerBanner` showed a phase and a reason. The handoff's status bar has one sentence beside the dot, which this plan uses (§4.3 rule 6). Is that enough for a first run downloading three tools over a slow link, or does the detail need a home, a toast, a popover on the dot, or a Settings → Toolchain live section (plan 219)? Decider: CEO. Nothing in this plan blocks on it: the dot ships either way.
3. **Q3, an exact queued-job count.** The shell seeds `queued` from one list read and maintains it from `job.status`, which cannot distinguish a queued job cancelled before it ran from a running one (§4.3 rule 5). The clean fix is a core-side counter, either a `job.counts` broadcast on every queue change, or `total` on a cheap `GET /api/jobs/counts`. Should plan 211 (jobs and runs) add it? Decider: CTO. Until it does, the drift is repaired on reconnect and the plan is complete without it.
4. **Q4, when this plan merges to `mvp`.** Plan 200 §8's schedule puts it in stage 3, alongside 206 and 207 and long before the screens in stages 5–7. MVP 16 §5 item 5 wants an internal alpha on the owner's farm after wave 2, "testable through the old Studio plus the new activity list", which this plan's frame changes. Either the alpha ships with the handoff shell around prototype page bodies (§3.8), or this plan's merge is held until stage 5 beside plan 214. Decider: CTO. Execution is identical either way.
5. **Q5, the avatar in local mode.** The handoff always draws the chip, and local mode has no session. This plan draws `LA` / "Local admin" with a popover that says why (§4.6). If the chip should instead be hidden in local mode, say so and the `AvatarMenu` returns `null` when `authMode !== 'server'`, a two-line change. Decider: CEO (a design call).

## 10. Removed

### 10.1 Removed by this plan

| What | Where it was | Proof |
|---|---|---|
| The 14-item sidebar, `NavItem`, `NAV`, `Counts`, the four-endpoint counts effect, `SidebarBody`, `Brand`, the collapse rail, the mobile `<Sheet>` | `packages/studio/src/components/layout/AppShell.tsx` (796 lines) | `test ! -e packages/studio/src/components/layout/AppShell.tsx` → exit 0 |
| The sidebar collapse preference | `packages/studio/src/lib/prefs.ts:73-82` | `rg -n "sidebarCollapsed" packages/studio/src` → empty |
| `OperationTray` and its mount | `packages/studio/src/components/operations/OperationTray.tsx`, `AppShell.tsx:534` | §10.3 `GREP_213_TRAY` → empty |
| `ProvisioningBanner` and its mount | `packages/studio/src/components/ProvisioningBanner.tsx`, `AppShell.tsx:519` | §10.3 `GREP_213_TRAY` → empty |
| `AdbServerBanner` and its mount | `packages/studio/src/components/layout/AdbServerBanner.tsx`, `AppShell.tsx:522` | §10.3 `GREP_213_TRAY` → empty |
| The per-item count badges and the failed-plugin warning badge in the nav | `AppShell.tsx:625-654` | `rg -n "failedPlugins" packages/studio/src` → only `lib/api.ts`'s type and `app/nodes/page.tsx`, never a shell file |
| The `/api/scripts` and `/api/jobs?limit=200` reads the shell made on every device and job event | `AppShell.tsx:258-259` | `rg -n "api/scripts" packages/studio/src/components/shell packages/studio/src/lib/shell-state.ts` → empty |
| The prototype dot-grid page background and the flat `color-scheme: dark` | `packages/studio/src/app/globals.css:56`, `:67-68` | `rg -n "radial-gradient" packages/studio/src/app/globals.css` → empty; `rg -n "color-scheme: dark" packages/studio/src/app/globals.css` → exactly one line, inside `html[data-theme='dark']` |
| `lucide-react` in the Alerts button | `packages/studio/src/components/NotificationBell.tsx:5` | `rg -n "lucide-react" packages/studio/src/components/NotificationBell.tsx packages/studio/src/components/shell` → empty |
| The `/scripts` and `/dev` rows of the orphan-route exemption list | `AppShell.test.tsx:420-447` (file already deleted by plan 201) | `scripts/check-routes.ts`'s `NOT_IN_NAV_BY_DESIGN` holds exactly `/login` and `/setup` |
| The word "console" anywhere in the shell (MVP 15 §0.1.4) | the handoff's status-bar group 3 | §10.3 `GREP_213_VOCAB` → empty |
| Forbidden vocabulary (plan 200 §2.4) in this plan's new files | `components/shell/*`, `lib/shell-state.ts`, `lib/overlays.ts`, `scripts/check-routes.ts` | §10.3 `GREP_213_VOCAB` → empty |

### 10.2 Deletions this plan owes to a later one (owners, not proofs)

| What | Last consumer today | Deleted by |
|---|---|---|
| `packages/studio/src/lib/operations.ts` (735 lines) and its four polling endpoints, `components/operations/ReattachBanner.tsx`, `components/operations/TransferProgressBar.tsx` | `BulkPrepDialog.tsx:43`, `BulkTransferDialog.tsx:30`, `InstallBatchDialog.tsx:30`, `network/BulkProxyDialog.tsx` (§3.6) | plan 216, with those four dialogs |
| `app/scripts/page.tsx`'s redirect to `/plugins` (§3.9) | the rail's Scripts & workflows entry lands on it | plan 217 |
| `app/device/`, `app/groups/`, `app/nodes/`, `app/workflows/`, `app/schedules/`, `app/batches/`, `app/tools/`, `app/workspace/`, `app/agents/thread/` | `scripts/check-routes.ts`'s `PENDING_REMOVAL` (§4.10) names the owning plan for each | 214, 215, 217, 218, 219, 220 |
| `globals.css`'s `@layer components` block (`.status-rail`, `.rack-label`, `.readout`) | every screen plans 214–220 replace | the last of plans 214–220 |
| `theme.css` block D | the same screens (plan 204 §10.2) | the same plan |

### 10.3 The greps

Fenced, not tabled: a regex alternation cannot carry an unescaped pipe inside a Markdown table cell.

```bash
# GREP_213_TRAY: the tray and the two banners, gone
rg -n -e "OperationTray" -e "ProvisioningBanner" -e "AdbServerBanner" packages/studio/src

# GREP_213_OPERATIONS: `lib/operations` and `components/operations` have exactly four
# importers left, all of them plan 216's (§3.6). Expected output, and nothing else:
#   components/BulkPrepDialog.tsx, components/BulkTransferDialog.tsx,
#   components/InstallBatchDialog.tsx, components/network/BulkProxyDialog.tsx
#   (plus the three surviving files inside components/operations/ and lib/operations.ts itself)
rg -l -e "lib/operations" -e "components/operations" packages/studio/src

# GREP_213_POLL: nothing in the shell or its store runs on a timer
rg -n -e "setInterval" -e "setTimeout" packages/studio/src/components/shell packages/studio/src/lib/shell-state.ts

# GREP_213_COLOUR: no v3 bracket colour form, no `dark:` variant, no hex literal
rg -n -e "\[--color" -e "\bdark:" -e "#[0-9a-fA-F]{3,8}\b" packages/studio/src/components/shell packages/studio/src/lib/shell-state.ts packages/studio/src/lib/overlays.ts

# GREP_213_VOCAB: plan 200 §2.4's forbidden words, plus "console" (MVP 15 §0.1.4)
rg -n -i -e "\blease" -e "\bcluster" -e "\bholder" -e "\bassist" -e "co-control" -e "\bconsole\b" -e "\bwall\b" -e "sidebar" packages/studio/src/components/shell packages/studio/src/lib/shell-state.ts packages/studio/src/lib/overlays.ts scripts/check-routes.ts

# GREP_213_SHELL_IMPORT: nothing imports the deleted shell path
rg -n "components/layout/AppShell" packages plugins scripts
```

## 11. Handoff report

- **Checklist**: G1 ✅ G2 ⏳ owner G3 ✅ G4 ✅ (13 exempt, not 11 — see discrepancies) G5 ⏳ owner G6 ✅ software half (grep clean; 120 s network-tab half is owner) G7 ⏳ owner G8 ⏳ owner G9 ✅ G10 ✅ G11 ✅ G12 ✅ G13 ✅ with a caveat (pre-existing, unrelated failure — see discrepancies) G14 ✅ with a documented, justified residue G15 ✅ (6 lines, not 4 — matches §10.2's fuller list)
- **Commits**: (this plan's changes are committed together in one commit on this branch; see the commit that follows this report in the log)
- **Typecheck**: clean — `bun run typecheck` prints `OK` for all 20 packages (protocol, ui, adb, toolchain, drivers, scrcpy, sdk, session, harness, core, node, studio, probe-server, networking, proxy-manager, tiktok-automation-pack, mikrotik-routing, google-automation-pack, youtube-automation-pack, examples).
- **Tests run**: none. This plan touches no backend module; Studio and `@enkaku/ui` have zero tests by policy (plan 200 §8.3). Verification is `bun run typecheck`, `bun run build:studio`, and the greps/scripts below, exactly as plan §7.1 prescribes.
- **Removed, proven**:
  - `GREP_213_TRAY` (`rg -n -e "OperationTray" -e "ProvisioningBanner" -e "AdbServerBanner" packages/studio/src`) → empty.
  - `rg -n "sidebarCollapsed" packages/studio/src` → empty.
  - `GREP_213_POLL` (`rg -n -e "setInterval" -e "setTimeout" packages/studio/src/components/shell packages/studio/src/lib/shell-state.ts`) → empty.
  - `GREP_213_COLOUR` → empty.
  - `GREP_213_OPERATIONS` (`rg -l -e "lib/operations" -e "components/operations" packages/studio/src`) → 6 lines: `components/BulkPrepDialog.tsx`, `components/BulkTransferDialog.tsx`, `components/InstallBatchDialog.tsx`, `components/network/BulkProxyDialog.tsx`, `components/operations/ReattachBanner.tsx`, `components/operations/TransferProgressBar.tsx` — all six are plan 216's per §10.2's own fuller list (not `lib/operations.ts` itself, since its self-citing comments were reworded — see discrepancies).
  - `GREP_213_VOCAB` → 10 lines, all in `scripts/check-routes.ts`, all justified (see discrepancies).
  - `GREP_213_SHELL_IMPORT` (`rg -n "components/layout/AppShell" packages plugins scripts`) → 2 lines, both pre-existing comments in `packages/core/src/api/plugins.ts` and `plugins-route-parity.test.ts`, neither touched or owned by this plan (see discrepancies).
  - `test ! -e packages/studio/src/components/layout/AppShell.tsx` → exit 0 (and the three deleted files: `ProvisioningBanner.tsx`, `layout/AdbServerBanner.tsx`, `operations/OperationTray.tsx`).
  - `bun run scripts/check-routes.ts` → `routes ok: 6 in nav, 13 exempt`.
  - §7.2 ROUTE-PLANT: planting `app/zzz-orphan/page.tsx` → `FAIL: /zzz-orphan has a page.tsx but no NAV entry and no exemption...`, exit 1; removing it → `routes ok: 6 in nav, 13 exempt`, exit 0. Stale-exemption half (moved `app/tools` aside, since `git mv` outside the worktree is refused by the sandbox): → `FAIL: /tools is listed in PENDING_REMOVAL but does not exist...`, exit 1; restored → exit 0.
  - `bun run build:studio` → succeeds, all 34 routes prerendered as static content, no server/client boundary errors.
- **Discrepancies between plan and code**:
  1. **The header's own premise is false in this execution: plan 207 has not merged.** The plan's header states "plan 207 has already deleted `app/console/` and `app/topology/`, renamed `app/clusters/` to `app/groups/`". In this worktree only plans 201–205 have landed on `mvp`; `docs/plans/207-...md` is still `> Status: draft`, and `app/console/`, `app/topology/`, `app/clusters/` all still exist on disk exactly as before. Per plan 200 §2.2 (the file wins for facts), `scripts/check-routes.ts`'s `PENDING_REMOVAL` list is written against the ACTUAL tree: it carries `/clusters` (not `/groups`, which does not exist yet), `/console` and `/topology`, each owned by plan 207, instead of the plan's drafted list (which had `/groups` and omitted the other two). This raises the exempt count from the plan's assumed 11 to 13 (G4, G0 acceptance §6.3). `scripts/check-routes.ts`'s own header comment records this in full, including the update plan 207's own executor should make when it lands.
  2. **`bg-bg` is not usable in `AppShell.tsx` because of a pre-existing token collision.** `packages/ui/src/theme.css`'s block D (plan 204 §3.5/§9 Q1, kept for the ~30 still-live prototype screens) separately declares its own `--color-bg`. Verified empirically by compiling `@enkaku/ui/theme.css` in isolation with `@tailwindcss/postcss`: only ONE declaration of `--color-bg` survives in the merged theme (the block D dark `oklch(...)` value), never the handoff's `var(--bg)` mapping — so the `bg-bg` Tailwind utility resolves to the fixed prototype colour everywhere in the workspace today, not to the handoff's light/dark background. (`FullScreenLoading` in `AuthGate.tsx` already accepted this for its one-frame spinner per the plan's own step 213.5 note — but the shell's own ROOT background is not a one-frame incidental, it is the thing G2's owner smoke checks pixel-for-pixel.) Fixed in `AppShell.tsx` by setting `style={{ backgroundColor: 'var(--bg)' }}` directly instead of the `bg-bg` class, with a code comment explaining why. No other handoff colour name used anywhere in this plan's files collides with a block D name (checked against block D's full property list).
  3. **`AvatarMenu.tsx` §4.6's own code block does not typecheck.** `const local = authMode !== 'server' || !user; const label = local ? 'Local admin' : user.email` does not let TypeScript narrow `user` to non-null in the ternary's false branch (plan 200 §2.6: a plan's code block may have this class of defect). Fixed by deriving one nullable `const serverUser = authMode === 'server' ? user : null` and testing `serverUser` directly wherever `user.email`/`user.role` was read, which narrows correctly with no `as`-cast.
  4. **`job.status`'s payload field is `jobId`, not `id`.** §4.3 rule 5 describes the payload as `{ id, status }`; `JobInfoSchema` (`packages/protocol/src/messages/job.ts`) names the field `jobId`. Implemented against the real schema (`const { jobId, status } = m.payload`).
  5. **G9's grep (`GREP_213_TRAY`) is defined with no scope narrower than all of `packages/studio/src`, and several PRE-EXISTING doc comments — plus two of this plan's own new files' first-draft comments — named the three deleted components in prose.** Fixed by rewording every hit rather than leaving the grep dirty: two of my own new files (`lib/shell-state.ts`, `components/shell/StatusBar.tsx`) had citations like `` `ProvisioningBanner.tsx:33-38` ``, and two files this plan does not otherwise own (`lib/operations.ts`, `components/operations/TransferProgressBar.tsx`) had stale prose describing `OperationTray` as still mounting things — all reworded to describe the same facts without the banned identifiers, no behavioural change. This is also why `lib/operations.ts` and `TransferProgressBar.tsx` appear in `git diff --stat` against files §6 acceptance criterion 5 does not list them; recorded here rather than silently left non-conforming.
  6. **The same problem recurred for `GREP_213_SHELL_IMPORT` and `GREP_213_VOCAB` inside this plan's own new files** (citations of `components/layout/AppShell.tsx:NNN`, and the words "sidebar"/"Console" used descriptively). All reworded within `components/shell/nav.ts`, `Rail.tsx`, `AppShell.tsx`, `StatusBar.tsx`, `scripts/check-routes.ts`. What remains in `GREP_213_VOCAB`'s output (10 lines, all in `check-routes.ts`) is two irreducible categories: (a) the JS builtin `console.log`/`console.error` calls the script needs to report its own result, exactly like the sibling `check-design-tokens.ts` (plan 204) already does outside this grep's scan paths; (b) literal citations of the real, currently-existing `/clusters` and `/console` route names, required for the route-exemption tracking in discrepancy 1 above to function and be honest about the actual tree. Neither is a reintroduction of the deprecated CONCEPTS the vocabulary rule targets (plan 200 §2.4's own stated purpose).
  7. **`scripts/check-design-tokens.ts`'s exact-count assertion contradicted this plan's own §3.4, which said the script "asserts presence, not exclusivity".** The script actually asserts `exportedIconNames.length !== 62` as a hard failure. Fixed by widening the assertion to `62 + GROUP_3.length` alongside adding `RobotIcon`, so G13's own intent (adding the icon does not break the script) holds — and separately discovering the pre-existing, unrelated `setCoreBase` failure below.
  8. **`scripts/check-design-tokens.ts` currently fails for a reason that predates this plan and is not caused by it.** `REQUIRED_BARREL` (plan 204) still requires `@enkaku/ui` to export `setCoreBase`; `check-dead-code.sh`'s `studio-exports` row (plan 201) requires that same name to be GONE from `packages/studio` and `packages/ui`. Verified by running the exact pre-213 committed copy of `check-design-tokens.ts` against the current tree: it fails identically, with one fewer icon-related note (this plan's own icon-count fix is proven not to be the cause). Not fixed here — `REQUIRED_BARREL` and `check-dead-code.sh`'s list are both plan 204/201 deliverables, outside this plan's `> Ships:` line and file structure (§4.2), and this is exactly the class of cross-plan contradiction plan 200 §8.5's round-gate process exists to catch. Flagged as a background task (`task_730750b8`) instead of silently patched.
  9. **§10.2's inline comment for `GREP_213_OPERATIONS` (which anticipates the operations/ survivors and `lib/operations.ts` itself appearing in the output) says "the three surviving files"; only two survive** (`ReattachBanner.tsx`, `TransferProgressBar.tsx`) — `OperationTray.tsx`, the third of the original three, is exactly what this plan deletes. A wording slip in the plan, not acted on beyond noting it.
- **Observed, not done**:
  - The owner smoke (§7.3) was not run: no live core/Studio dev pair and no browser session with the handoff README open in this session. G2, G5, G7 and G8 are left `owner` and the checklist above says so per §5 step 213.8's own instruction for exactly this case.
  - `scripts/check-design-tokens.ts` does not print `design tokens ok` today (see discrepancy 8) — flagged as a background task rather than fixed inside this plan's scope.
  - `scripts/check-routes.ts`'s `PENDING_REMOVAL` list will need a real edit when plan 207 merges (discrepancy 1); its own header comment already says exactly what to change.
- **Open questions hit**: none of §9's five open questions blocked a step. Q1 (Agents in the rail) is answered as shipped (`AGENTS_IN_RAIL = true`, one rail, no second variant). Q2–Q5 are unaffected by anything built here.
- **Processes**: `ps -Ao pid=,command= | grep -i "[o]penpf"` → no output (nothing running). No dev server, core, or browser preview was started during this execution.
