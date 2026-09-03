# Plan 214 (MVP wave 3): Devices, the table, the Screens grid, groups, discovery, selection, bulk actions

> Status: draft — not started; written 2026-09-03 by the plan author for the MVP series
> Depends on: plan 213 (`components/shell/AppShell.tsx`, `PagePanel`, `lib/overlays.ts` Escape tiering and `[data-menu-root]`, the status-bar counters, `scripts/check-routes.ts` and its `PENDING_REMOVAL` list), plan 207 (`POST /api/actions/<verb>`, `packages/studio/src/lib/actions.ts` `runAction`/`runOnDevice`/`groupResults`, the `groups` table and `/api/groups`, `DeviceInfo.group`), plan 206 (always-on sessions, `E_SESSION_PREPARING`, `LiveView` with no build phase), plan 205 (`DeviceInfo.activities`, `DeviceStatusSchema = offline | online | quarantined`, `device.activity`, `deviceState()` in `packages/protocol/src/activity.ts`), plan 204 (tokens, Phosphor icons, `StatusDot`, `Checkbox`, `Badge`, `Sheet`, `Popover`, `Tabs variant="pill"`). Plan 201 has already deleted every Studio test and `components/topology/`.
> Spec references: `docs/mvp/design_handoff_enkaku_openpf/README.md` section "Screen: Devices" (lines 78 to 226, quoted verbatim in §4.1), "Interactions & Behavior" (448 to 465), "Design Tokens" (486 to 511); `docs/mvp/15-ui-migration.md` §0 (Devices bullet), §0.1 items 3 and 4 (Groups, no Console), §1 (State dot colours row, Device page row, Generic action set row), §3 step 3, §4.3; `docs/mvp/04-device-activity.md` §1.1, §1.2, §3; `docs/mvp/11-always-on.md` §1.2, §1.3, §4; `docs/mvp/07-actions-api.md` §1.1, §1.2, §2; `docs/mvp/03-navigation-and-pages.md` §1, §1.1; `docs/mvp/13-removal-register.md` A.6; `docs/mvp/16-consolidated-plan.md` §1 (Surfaces), §3 (wave 3). External facts: plan 200 §5 row R6 (Phosphor 2.1.10).
> Ships: packages/studio/src/components/devices/DeviceTable.tsx

---

## 0. Goal checklist

Every command runs from the repo root. `GREP_214_*` names are defined once in §10.3 and copied verbatim wherever cited.

| # | Goal | Parameter | Verified by | Done |
|---|---|---|---|---|
| G1 | The Devices screen is the files of §4.4 under `components/devices/` and the old fleet screen is gone | `DevicesScreen.tsx`, `DevicesToolbar.tsx`, `GroupTabs.tsx`, `DeviceTable.tsx`, `ScreensGrid.tsx`, `DeviceScreenCard.tsx`, `BulkPill.tsx`, `ActionMenu.tsx`, `DiscoverySheet.tsx`, `TaskCell.tsx`, `action-set.ts`, `useDeviceSelection.ts`, `useDevices.ts`, `useQueuedJobs.ts`, `useLiveSet.ts` all exist; `app/page.tsx` is under 220 lines | `for f in DevicesScreen.tsx DevicesToolbar.tsx GroupTabs.tsx DeviceTable.tsx ScreensGrid.tsx DeviceScreenCard.tsx BulkPill.tsx ActionMenu.tsx DiscoverySheet.tsx TaskCell.tsx action-set.ts useDeviceSelection.ts useDevices.ts useQueuedJobs.ts useLiveSet.ts; do test -f packages/studio/src/components/devices/$f || echo "missing $f"; done` prints nothing; `wc -l < packages/studio/src/app/page.tsx` is under 220 | [ ] |
| G2 | Every measurement in the handoff's "Screen: Devices" is present | the class strings of §4.6 to §4.13, character for character | owner smoke §7.3, itemised steps 2 to 11, with `README.md` lines 78 to 226 open beside the browser | owner |
| G3 | The table's grid is the handoff's, exactly | `grid-template-columns: 38px 44px 1.3fr 108px 92px 138px 70px 74px 62px 62px 62px 76px 1.1fr`; `min-width: 1324px` | `rg -n "38px_44px_1.3fr_108px_92px_138px_70px_74px_62px_62px_62px_76px_1.1fr" packages/studio/src/components/devices/DeviceTable.tsx` prints exactly two lines (header and row); `rg -n "min-w-\[1324px\]" packages/studio/src/components/devices/DeviceTable.tsx` prints one line | [ ] |
| G4 | The Task column is the activity list and the status dot is `deviceState()` | `TaskCell` reads `device.activities` only, plus `useQueuedJobs` for the queued variant; the dot is `DOT_STATE[deviceState(device)]` | `rg -n "activities" packages/studio/src/components/devices/TaskCell.tsx` prints at least one line; `rg -l "deviceState" packages/studio/src/components/devices` prints exactly one path, `device-state.ts` | [ ] |
| G5 | 100 rows scroll at 60 fps with live task chips and no request on a timer | 0 `setInterval`/`setTimeout` scheduling a fetch anywhere under `components/devices/`; DevTools Performance over a 5 s scroll of 100 rows shows no frame over 16.7 ms | §10.3 `GREP_214_POLL` prints nothing; owner smoke §7.3 step 12 | owner |
| G6 | Selection behaves as the handoff specifies | click deferred 200 ms and cancelled by double-click; marquee threshold 5 px; Shift/Ctrl/Cmd union; Ctrl/Cmd+A over the filtered set, suspended while a `window` overlay is registered or while typing; Escape tiered through `lib/overlays.ts` | owner smoke §7.3 step 13, itemised a to f | owner |
| G7 | Group CRUD works from the tab strip and nowhere else | `POST /api/groups`, `PATCH /api/groups/:id`, `DELETE /api/groups/:id` are called only from `GroupTabs.tsx`; the name is uppercased with spaces turned into dashes | `rg -n "/api/groups" packages/studio/src --glob '!*.test.*'` prints only `components/devices/GroupTabs.tsx` and `components/devices/useDevices.ts`; owner smoke §7.3 step 6 | [ ] |
| G8 | Discovery is a right sheet, and adb visibility is not farm membership | `GET /api/devices/discovered` seeds it, `POST /api/devices/discovered/:stableId/admit` with an empty body adds, `DELETE /api/devices/discovered/:stableId` dismisses; the pill counts only un-added phones | owner smoke §7.3 step 11; `rg -n "discovered" packages/studio/src/components/devices/DiscoverySheet.tsx` prints the three routes | [ ] |
| G9 | The four metric columns have a farm-wide source and no client poll | `DeviceInfo.metrics` plus the `device.metrics` push; one extra `client.exec` per device per `battery.pollIntervalSec` | `bun test packages/protocol/src/device.test.ts` passes the new `describe('DeviceMetricsSchema')`; owner smoke §7.3 step 14 (CPU, Mem, Disk, Uptime are numbers on a live device and an em dash on a disconnected one) | [ ] |
| G10 | `DeviceInfo.model` exists and the Device cell's sub-line uses it | `model: z.string().nullable().default(null)` on `DeviceInfoSchema`; `devices.model` column; written by the registry probe from `probe.model` | `bun test packages/protocol/src/device.test.ts` passes the `model` case; `rg -n "model: probe.model" packages/core/src/registry/device-registry.ts` prints exactly two lines | [ ] |
| G11 | No response body is `as`-cast | `fetchDiscoveredDevices` parses through `DiscoveredDevicesResponseSchema` | `rg -n "as \{ discovered" packages/studio/src/lib/api.ts` prints nothing | [ ] |
| G12 | The old fleet screen's components are gone | `DeviceCard.tsx`, `DiscoveredTray.tsx`, `AdmitDeviceDialog.tsx`, `device/ScanNetworkDialog.tsx`, `wall/useDragSelect.ts`, `wall/SelectionCursorBadge.tsx`, `wall/DeviceContextMenu.tsx`, `hooks/use-bulk-selection.ts` do not exist | §10.1's `test ! -e` line exits 0; §10.3 `GREP_214_OLD` prints nothing | [ ] |
| G13 | The `/groups` route is gone and `check-routes.ts` passes with the pruned list | `app/groups/` absent; `PENDING_REMOVAL` has no `/groups` row | `test ! -e packages/studio/src/app/groups` exits 0; `bun run scripts/check-routes.ts` prints `routes ok: 6 in nav, 10 exempt` | [ ] |
| G14 | No forbidden word from plan 200 §2.4 appears in a file this plan creates | 0 matches | §10.3 `GREP_214_VOCAB` prints nothing | [ ] |
| G15 | No file this plan creates names a colour in the v3 bracket form, a `dark:` variant, or a hex literal | 0 matches | §10.3 `GREP_214_COLOUR` prints nothing | [ ] |
| G16 | The workspace typechecks and the design-token script still passes | 0 errors; `design tokens ok` | `bun run typecheck`; `bun run scripts/check-design-tokens.ts` | [ ] |
| G17 | No plugin version moved and no pack was rebuilt | empty diff | `git diff --stat mvp -- plugins packages/core/packs` prints nothing | [ ] |

## 1. Goals

1. Rebuild the Devices screen as the handoff draws it: a 58 px toolbar over either a 13 column table or a Screens card grid, both inside plan 213's `PagePanel`. Not a restyle of `app/page.tsx`; that file becomes a thin composition and everything it rendered is deleted (`docs/mvp/15-ui-migration.md` §3: "the shell and every control-touching screen are rebuilt on the handoff, not restyled").
2. Groups managed only from the tab strip: create through the dashed plus button's popover, rename and delete through a right-click menu, membership through the `set-group` action (`docs/mvp/15-ui-migration.md` §0.1 item 3).
3. One selection model used identically by both views: deferred click, marquee with a threshold, Ctrl/Cmd+A over the filtered set, tiered Escape through plan 213's overlay registry.
4. One bulk pill opening the generic action set, in the handoff's exact twelve-row order, so acting on one device and acting on twenty are the same menu (`docs/mvp/07-actions-api.md` §1.1).
5. A discovery sheet that states the product rule in the operator's own words: a phone adb can see is not on the farm until someone adds it.
6. Task and status dot driven by the activity push, never by a poll (`docs/mvp/04-device-activity.md` §1.1); the four missing metric columns given one honest farm-wide source.
7. Delete the fleet screen, its card, its tray, its two admission dialogs, its drag-select hook, its context menu, and the `/groups` route, and prune the routes script's list.

## 2. Non-goals

| Not done here | Done by |
|---|---|
| The Device Control window, the cast column, the input model, the host banner | plan 215 |
| The action dialogs behind Install apk, Adb command, Run script, Upload file, Clear cache and Settings, and the `DevicePicker` container | plan 216 |
| Deleting `components/bulk/*` (`OutcomeSummary`, `SkippedGroups`, `BatchResults`, `use-batch-report`): eight files outside this plan still import them (§3.6) | plans 216 and 218 |
| Deleting `components/wall/{Wall,WallTile,TileGrid,TileSkeleton,tile-identity}`: `@enkaku/host`'s `DeviceWallWithPicker` is a published host API a bundled plugin imports (§3.5) | plan 216 |
| Deleting `components/InstallBatchDialog`, `BulkTransferDialog`, `BulkPrepDialog`, `BulkForgetDialog`, `BulkProxyDialog`, `device/BulkCutoverDialog`, `ForgetDeviceDialog`, `DisconnectDeviceDialog`, and `lib/operations.ts` | plan 216 |
| The Scripts, Jobs, Plugins, Settings and Agents screens | plans 217 to 220 |
| A Nodes tab on Devices (`docs/mvp/03` §1.1) | after the MVP: cloud mode is post-MVP (`docs/mvp/16` §1); §9 Q4 asks who owns the route |
| A Console, a log console, a status-bar console toggle | never (`docs/mvp/15` §0.1 item 4) |
| A per-row actions column | never (handoff: "There is **no per-row actions column**") |
| Pagination, a page-size control, a tile-size S/M/L control, grouping by status or tag, a readiness filter, a connection filter | never: the handoff replaces all six with one scroller, four card-width presets, the group tabs and one five-row filter menu (§3.4) |
| Any request on a timer, anywhere on this screen | never (G5) |

## 3. Context and design decisions

### 3.1 What the fleet screen is today

`packages/studio/src/app/page.tsx` is 1929 lines. Verified by reading the file on 2026-09-03:

| Where | Line content |
|---|---|
| `:6` | `import { Download, EthernetPort, Globe, Hash, Inbox, LayoutGrid, List, MoreVertical, Plus, RotateCcwSquare, ScanSearch, Search, SlidersHorizontal, Smartphone, Terminal, Trash2, Upload } from 'lucide-react'` |
| `:25`, `:26`, `:35` | `import { DeviceCard } from '@/components/DeviceCard'`, `import { DiscoveredTray } from '@/components/DiscoveredTray'`, `import { ScanNetworkDialog } from '@/components/device/ScanNetworkDialog'` |
| `:70`, `:72`, `:73`, `:74` | `import { Wall } from '@/components/wall/Wall'`, `SelectionCursorBadge`, `DeviceContextMenu`, `useDragSelect` |
| `:76` | `import { useBulkSelection } from '@/hooks/use-bulk-selection'` |
| `:126-127` | `const PILL =` … `'flex h-9 items-center gap-1.5 rounded-full border border-line bg-surface-2/55 px-3.5 text-[12.5px] shadow-lg backdrop-blur-[18px] backdrop-saturate-[150%]'` |
| `:130`, `:131` | `type View = 'list' \| 'wall'`, `type GroupBy = 'none' \| 'cluster' \| 'status' \| 'tag'` |
| `:133-140` | `const STATUS_ORDER: DeviceStatus[] = ['idle', 'busy', 'manual', 'quarantined', 'offline']` and `STATUS_LABEL` |
| `:186`, `:193`, `:201`, `:210` | the four view/preference states: `view` from `?view` then `readSessionPrefs()`, `group` from `?group`, `tileSize`, `pageSize` |
| `:230` | `const [selectedIds, setSelectedIds] = useState<string[]>([])` |
| `:302`, `:303` | `const [discovered, setDiscovered] = useState<DiscoveredDevice[]>([])`, `const [trayOpen, setTrayOpen] = useState(false)` |
| `:494` | `api('/api/jobs?status=running&limit=50', z.object({ items: z.array(JobInfoSchema) }))` |
| `:519` | `const off = ws.on((m) => {` with branches for `device.added`, `device.removed`, `device.status`, `job.status`, `device.discovered`, `device.battery` (`:554`), `device.unauthorized`, `device.readiness`, `lease.changed` (`:579`), `assist.changed` (`:594`) |
| `:617` | `const offReconnect = ws.onReconnected(() => void load())` |
| `:649` | `const filtered = useMemo(() => {` with seven filters: status, query, tags, cluster, readiness, connection |
| `:701` | `const pushParams = (next: { view?: View; group?: GroupBy }) => {` |
| `:734` | `const focusId = params.get('focus')` |
| `:1409-1446` | `) : view === 'wall' ? (` and the `<Wall …>` element with ten props |
| `:1500-1523` | the ungrouped List grid, `pageDevices.map`, `<DeviceCard …>` |
| `:1534-1571` | the pagination footer, `Showing X-Y of N`, `Per page`, `Prev`/`Next` |
| `:1586-1689` | the selection action bar: twelve buttons, `Wake selected`, `Sleep selected`, `Install on selected`, `Apply labels`, `Set number as wallpaper`, `Run command…`, `Push file…`, `Pull file…`, `Set proxy…`, `Prep settings…`, `Forget selected`, `Clear` |
| `:1695` | `<SelectionCursorBadge active={selectedIds.length > 0} count={selectedIds.length} />` |
| `:1717-1726` | `<DeviceContextMenu …>` |
| `:1737-1747` | `<DiscoveredTray …>` |
| `:1816` | `<ScanNetworkDialog open={scanDialogOpen} …/>` |

There is no `?sort` query parameter on this screen today; the brief's mention of one describes a control the handoff does not draw either. Sorting stays out (§9 Q1).

Nothing in that list is kept. `?view` and `?group` survive as concepts with new values (§3.4); everything else is replaced.

### 3.2 The handoff decides the screen; three MVP documents correct it

1. **"Cluster tabs" are group tabs.** `docs/mvp/15-ui-migration.md` §0.1 item 3: "Clusters are renamed Groups everywhere (UI, API, and the `clusters` table and routes, to keep one word). Groups are managed only from the Devices tab strip; there is no dedicated page." Plan 207 already renamed the table, the routes and the Studio identifiers; this plan deletes `app/groups/page.tsx` and moves its CRUD into the strip.
2. **"Task" is the activity list.** `docs/mvp/15-ui-migration.md` §3 step 3: "The `#` column is the device number; Task is the activity list; the status dot uses the handoff's five states."
3. **The fifth dot state is `quarantined`, not `unauthorized`.** The handoff writes "Unauthorized"; the MVP's stored statuses are `offline | online | quarantined` (plan 205 §4.1, `device.ts:50`), and plan 205 §12 puts the mapping in `packages/protocol/src/activity.ts` as `deviceState(info)` returning `'free' | 'controlled' | 'job' | 'offline' | 'warn'`, where `warn` is quarantined. The colour is the handoff's (`var(--warn)`); the word is not. This plan writes **Quarantined** in the filter menu, the tooltip and the card's centre text, and §9 Q2 puts the copy to the CEO.

### 3.3 The five states, one mapping, two components

`deviceState()` returns plan 205's five names; `StatusDot` (plan 204 §4.6) takes five state names of its own, and the two lists differ in exactly one entry (`warn` versus `unauthorized`). Rather than widen either, this plan keeps one three-line map in `components/devices/device-state.ts` and forbids a second (`GREP_214_DEVICE_STATE`). The handoff's own colours resolve as: free `var(--ok)`, controlled `var(--warn-2)`, job `var(--danger)`, offline `var(--faint-2)`, quarantined `var(--warn)`. That is exactly `StatusDot`'s five, so no colour is written by this plan at all.

### 3.4 Six controls become three, on purpose

The old screen carried a status filter, a tag filter, a cluster filter, a readiness filter, a connection filter, a group-by control, a tile-size control and a page-size control. The handoff carries a search popover, a five-row filter menu, a view menu with four card-width presets, and the group tabs. This plan builds the handoff's four and deletes the rest, including the pagination the table replaces with a scroller. `readiness` and `connection` filters have no successor on this screen; the connection is still visible per row (the Endpoint column) and readiness is still visible per device in Device Control's `[i]` popover (plan 215). Recorded here so the loss is a decision, not an oversight.

`?view` survives with new values (`table` and `screens`, replacing `list` and `wall`) and `?group` survives with a group id or `all` (replacing the `GroupBy` axis, which is gone). Card width moves into `localStorage` beside where `tileSize` was.

### 3.5 `components/wall/` is not deleted, and here is why

The brief proposed deleting `components/wall/*` as superseded. Verified 2026-09-03 with `grep -rn "components/wall/" packages/studio/src | grep -v '^./components/wall/'` and `grep -rn "DeviceWallWithPicker" packages/studio/src packages/sdk/src plugins/*/src`:

| File | Line |
|---|---|
| `packages/studio/src/components/host/DeviceWallWithPicker.tsx` | `:6` `import { Wall } from '@/components/wall/Wall'` |
| `packages/studio/src/components/host/index.ts` | `:29` `export { DeviceWallWithPicker, type DeviceWallPickerProps } from './DeviceWallWithPicker'` |
| `plugins/mikrotik-routing/src/ui/parts/groups.tsx` | `:34` `import { DeviceWallWithPicker } from '@enkaku/host'`, used at `:623` |
| `packages/sdk/src/cli/init.ts` | `:506` `export function DeviceWallWithPicker(props: {` (the ambient host types every scaffolded plugin gets) |

`Wall` therefore has a live consumer that is neither this screen nor Studio: a bundled plugin's own UI, through a published host API. Deleting it here would mean rewriting `mikrotik-routing`'s group editor and bumping that plugin, which is neither on this plan's checklist nor in its remit. Plan 200 §2.2 applies: the file wins for facts, the plan wins for intent, and the intent (the fleet screen stops rendering a wall) is satisfied without the deletion. `Wall.tsx`, `WallTile.tsx`, `TileGrid.tsx`, `TileSkeleton.tsx` and `tile-identity.ts` stay; §10.2 hands all five, with `DeviceWallWithPicker`, to plan 216, which owns pickers.

Three wall files **do** go, because `app/page.tsx` is their only importer: `useDragSelect.ts`, `SelectionCursorBadge.tsx`, `DeviceContextMenu.tsx`. The context menu goes because the handoff gives a device row no context menu at all; right-click belongs to the group tab (§4.7) and actions come from the bulk pill or Device Control.

`useLiveSet.ts` **moves** rather than being copied or deleted (§3.9).

`components/DeviceCard.tsx` is deleted, but it exports `explainQuarantine` (`:454`) that `components/wall/WallTile.tsx:11` imports. That function moves to `packages/studio/src/lib/quarantine.ts` and both `WallTile` and this plan's new card import it from there.

### 3.6 `components/bulk/` is not deleted either

Verified 2026-09-03 with `grep -rn "components/bulk/" packages/studio/src | grep -v '^./components/bulk/'`. Eight files outside this plan import it:

| File | Line |
|---|---|
| `app/batches/detail/page.tsx` | `:46-49` `BatchResults`, `OutcomeSummary`, `SkippedGroups`, `batchOutcomeCounts`, `batchOutcomeGroups` |
| `components/BulkPrepDialog.tsx` | `:39-40` |
| `components/InstallBatchDialog.tsx` | `:6-8` |
| `components/network/BulkProxyDialog.tsx` | `:6-7` |
| `components/device-popup/ActionsList.tsx` | `:32-33` |
| `components/BulkTransferDialog.tsx` | `:6-8` |
| `components/device/BulkCutoverDialog.tsx` | `:5-6` |
| `lib/labelling.ts` | `:10-11` (types only) |

Plan 207 §2 assigns the six dialogs to plan 216 and `app/batches/detail/` is plan 218's. Deleting `components/bulk/` here would mean rewriting all eight. This plan removes only its own two importers (`app/page.tsx:37-38`) and §10.2 names the owners. The same rule plan 213 §3.6 applied to `lib/operations.ts`.

### 3.7 The four metric columns have no source today; one is added

The handoff's table has Batt, Temp, CPU, Mem, Disk and Uptime. Verified 2026-09-03:

- **Batt and Temp exist and are already farm-wide.** `DeviceInfoSchema.battery` (`packages/protocol/src/device.ts:214`, `battery: BatteryStateSchema.nullable().default(null)` with the comment "Last battery and temperature reading — carried in the payload so badges show on first load"); `BatteryStateSchema` (`packages/protocol/src/settings.ts:7-16`) carries `level`, `temperatureC`, `status`, `health`, `voltageMv?`, `updatedAt`. The push is `DeviceBatteryMessage` (`packages/protocol/src/messages/enroll.ts:67-70`, `type: z.literal('device.battery')`, payload `{ deviceId, battery }`), broadcast from `packages/core/src/daemon.ts:4272-4273` `onBattery: (deviceId, state) => hub.broadcast({ type: 'device.battery', payload: { deviceId, battery: state } })`, produced by the farm-wide poller `createBatteryMonitor` (`packages/core/src/device/battery.ts:66`) whose cadence is `battery.pollIntervalSec` (`packages/protocol/src/settings.ts:1073`, `min(10).default(60)`).
- **CPU, Mem, Disk and Uptime do not exist in any structured form.** The only place they are read today is the per-device Monitor pane, and it is raw text over a WS stream: `packages/studio/src/components/monitor/MonitorPane.tsx:27-34` lists `MONITOR_KINDS` as `logcat`, `top`, `thermal`, `crash`, `ps`, `meminfo`, `df`, each streaming lines a human reads. There is no numeric field, no farm-wide read and no push.

**Decision: one new field and one new push, produced by the poller that already exists.** `DeviceInfo` gains `metrics: DeviceMetricsSchema.nullable()`, and `device.metrics` carries the same object. The producer is `createBatteryMonitor`'s existing per-device poll body (`battery.ts:79` `pollDevice`), which already runs once per device per `pollIntervalSec` under a bounded concurrency of at most 8 (`battery.ts:120-130`). One extra `client.exec` per device per cycle, never a second timer and never a client-side loop. Metrics are **not persisted**: they are live facts, so the registry keeps them in memory and projects them into `DeviceInfo` exactly the way plan 205 projects activities. §4.2 gives the schema, §4.3 the probe and the parser.

- **Model.** The handoff's Device cell is "status dot (8px) + name (13px/500) over model (11px `var(--faint)`)". `DeviceInfo` has no model field; `devices` has no model column (`packages/core/src/db/schema.ts:12-24`, the columns are `id`, `stableId`, `serial`, `label`, `ownerId`, `androidVersion`, `apiLevel`, `screenW`, `screenH`, `density`). The probe already reads it: `packages/core/src/registry/device-registry.ts:609` `label: probe.model ?? probe.stableId`, and `discovered_devices.label` is documented as "Best-effort `ro.product.model`" (`schema.ts:227`). So a `model` column costs one migration and two lines in the same insert, and without it the handoff's sub-line has nothing to show. §4.2 adds it.

### 3.8 Queued is not an activity, so the queued task chip needs one seed and one push

The handoff's Task pill has four variants, one of which is "queued = `var(--muted-2)`/`var(--dim)`". Plan 205's registry holds an activity for the **life of a run**, not for a queued job (`docs/mvp/04` §1.1: entries are projected from durable rows for jobs that are running). A queued job therefore appears in no activity list.

`useQueuedJobs` (§4.14) seeds once from `GET /api/jobs?status=queued&limit=500` (`JobInfoSchema` carries `jobId`, `deviceId`, `scriptName`, `status` at `packages/protocol/src/messages/job.ts:74-80`) and then follows `job.status` pushes: `status === 'queued'` records the job against its device, any other status forgets it. It reseeds on `ws.onReconnected`. This is the same seed-plus-push shape plan 213 §4.3 rule 5 uses for the status bar's queued counter, including the same bounded drift and the same repair, and it is stated in the code comment for the same reason.

### 3.9 The live-set policy moves rather than being rewritten

`packages/studio/src/components/wall/useLiveSet.ts` (385 lines) already solves the Screens grid's hardest problem: which cards may decode. Verified 2026-09-03: `:42` `export const DWELL_MS = 400`, `:55` `export const RAMP_STEP_MS = 800`, `:123` `export function computeLiveSet(input: LiveSetInput): LiveSetOutput`, `:222` `export function useLiveSet({ devices, maxTiles, rampConcurrency })`, `:285-320` the `IntersectionObserver` with `{ rootMargin: '200px 0px' }` and a per-tile dwell timer, `:266` the `RAMP_STEP_MS` tick.

It is moved to `components/devices/useLiveSet.ts` and `components/wall/Wall.tsx:9` follows, so there is one implementation and it lives with the screen that owns the policy. Two of its rules are edited because plan 206 made them false:

- `:57` `export type BlockedReason = 'asleep' | 'offline' | 'quarantined'` loses `'asleep'`. Its own reason (`:26-29`: "an `asleep` device is a BLOCKED state … There is no way to stream a device without waking it") stopped being true when the wall encoder became always-on (`docs/mvp/11` §1.2: "The wall encoder … runs for the whole session"; §1.1: "A device an operator explicitly puts to sleep stays asleep with its session up; its tile shows a dark screen, not a loading panel").
- `:111` `if (isVisible && d.readiness.actual === 'hot') return 1` goes, and the ranks below it shift up by one. Its reason (`:96-98`: "a hot device's session is already open, so promoting it costs one map lookup … rather than a fresh build") is now true of every online device, so the tier no longer distinguishes anything.

Everything else, including `maxTiles` from `/api/adb/stats` `video.maxTiles` and `rampConcurrency` from `/api/settings` (`Wall.tsx:213-228`), is kept verbatim and read once at mount by `ScreensGrid`.

### 3.10 The generic action set is data here and dialogs in plan 216

The handoff's twelve rows are rendered in full and in order by this plan. Six of the twelve are executable with no dialog at all against plan 207's verbs, because their `ActionRequestSchema` member takes no required parameter (`docs/plans/207-mvp-actions-api-and-groups.md` §4.1): `reconnect` (`:223`), `disconnect` (`:224`), `sleep` (`:222`), `screenshot` (`:248`), `forget` (`:232`, `deleteHistory` defaulted, gated behind `@enkaku/ui`'s `ConfirmDialog`), and `set-group` (`:243`, whose one parameter is a group id this screen already has, so Move group opens a submenu of group names rather than a dialog).

Six need a form and are plan 216's: `install` (`artifactId`), `adb` (`cmd`), `run-script` (`scriptId`), `push` (`artifactId` and `remotePath`, drawn as "Upload file"), `clear-cache` (`package`), `settings` (a settings patch). Between this plan and plan 216 those six rows render `aria-disabled` in `text-faint-2` with `title="Opens a dialog (plan 216)"`. That is a bounded interim of one stage (plan 200 §8: 214 is stage 5, 216 is stage 6), it is visible rather than silent, and it is the same shape plan 213 §3.8 accepted for the page bodies. It is not a shim: no code path is added that plan 216 has to remove, only a `needsDialog` flag that becomes the trigger for the dialog it names.

## 4. Technical design

### 4.1 The handoff, verbatim

From `docs/mvp/design_handoff_enkaku_openpf/README.md`, lines 80 to 226, with the handoff's own punctuation. This is the specification for §4.6 to §4.13.

> **Toolbar** — `height: 58px`, `padding: 0 12px`, `border-bottom: 1px solid var(--line)`, `gap: 10px`.
>
> *Left — cluster tabs:* a pill container that shrinks to its content (`flex: 0 1 auto`, `padding: 4px`,
> `background: var(--muted)`, `border-radius: 999px`, `gap: 4px`, horizontal scroll when needed).
> Each tab: `padding: 7px 14px`, `border-radius: 999px`, 12.5px; active = `background: var(--panel)`,
> `box-shadow: 0 1px 3px #00000014`, weight 600; idle = `color: var(--dim)`. Each tab shows its device
> count after the label (11px, `var(--faint)`, `margin-left: 7px`). First tab is **All**; the rest come
> from the cluster list (Farm A, Farm B, Farm C, Rack 01, Rack 02).
>
> Immediately right of the container: **add-group button** — 30×30 circle, `border: 1px dashed
> var(--border-3)`, `ph-plus` 14px; hover turns accent. Opens a small popover (224px, `top: 40px`,
> right-aligned) titled "New group" with a text input, **Create** (accent) and **Cancel** buttons;
> Enter submits, Escape cancels. Names are uppercased and spaces become dashes (`Farm D` → `FARM-D`).
>
> **Right-click a cluster tab** (not All) opens a 188px dropdown at that tab's x-offset with
> **Rename group** (`ph-pencil-simple`) and **Delete group** (`ph-trash`, `var(--danger)`). Rename opens
> the same popover pre-filled; delete removes the cluster and falls back to All if it was active.
>
> *Right — controls:*
> - **Discovered (N)** pill: `padding: 7px 13px`, `border-radius: 999px`, `border: 1px solid
>   var(--border-2)`, `background: var(--panel-2)`, `ph-tray-arrow-down` + label. Opens the discovery sheet.
> - Icon buttons, 32×32, `border-radius: 10px`, idle `color: var(--faint)`, hover
>   `background: var(--muted-2)`; active (menu open or filter applied) = `background: var(--accent-soft)`,
>   `color: var(--accent)`:
>   - **Search** (`ph-magnifying-glass`) → 300px popover with a `var(--muted)` input
>     ("serial, label, model, task"), a match count and **Clear**. Matches name, serial, model, group, task.
>   - **Filter** (`ph-funnel`) → 216px menu: All, Free, Running job, Unauthorized, Disconnected, each with
>     a status dot, count, and a `ph-check` on the active one.
>   - **View** (`ph-rows` / `ph-squares-four`) → 200px menu with **Table** and **Screens**; when Screens is
>     active the menu also shows a **Card width** control (label + px value) with presets S 112 / M 146 /
>     L 190 / XL 240.
>   - **Rescan** (`ph-arrows-clockwise`): spins (`enkakuSpin`, 0.9s) for 1400ms.
>
> All popovers close on outside click (`[data-menu-root]` containment test) and on Escape.
>
> ### Table view
> Horizontal scroller, `min-width: 1324px`. Sticky header row: `height: 38px`,
> `background: var(--panel-2)`, `border-bottom: 1px solid var(--line)`, 11px `var(--faint)` labels.
>
> Grid columns:
> `38px 44px 1.3fr 108px 92px 138px 70px 74px 62px 62px 62px 76px 1.1fr`
> → checkbox · **#** · Device · Serial · OS · Endpoint · Batt · Temp · CPU · Mem · Disk · Uptime · Task.
>
> Rows: `height: 54px`, `border-bottom: 1px solid var(--muted-2)`, hover `background: var(--hover)`.
> Selected row: `background: var(--accent-soft)` + `box-shadow: inset 2px 0 0 var(--accent)`.
> Disconnected rows render at `opacity: 0.6` and show `—` for every metric.
>
> - **Checkbox**: 16×16, `border-radius: 5px`, `border: 1.5px solid var(--border-3)`; checked =
>   `background: var(--accent)`, white `ph-check`. Header checkbox selects/clears all filtered rows.
> - **#**: system row number, `Geist Mono` 11.5px `var(--faint)`, zero-padded (01, 02 …), follows the
>   filtered order.
> - **Device**: status dot (8px) + name (13px/500) over model (11px `var(--faint)`).
> - **Serial / Endpoint**: `Geist Mono` 12px.
> - **Batt**: value only (no progress bars anywhere in the table), colored `<20% var(--danger)`,
>   `<45% var(--warn)`, else `var(--accent)`.
> - **Temp**: `var(--danger)` above 42°, else `var(--text-3)`.
> - **Task**: pill, `padding: 3px 9px`, `border-radius: 999px`, 11.5px —
>   script running = `var(--accent-soft)`/`var(--accent)`; system action = `var(--warn-soft)`/`var(--warn)`;
>   queued = `var(--muted-2)`/`var(--dim)`; idle = plain `var(--faint-2)` text, no pill.
>
> There is **no per-row actions column** — actions come from selection (see Bulk actions) or Device Control.
>
> ### Screens view (card grid)
> `display: grid; grid-template-columns: repeat(auto-fill, minmax(<cardWidth>px, 1fr)); gap: 12px;
> padding: 14px`, `user-select: none`.
>
> Card: `padding: 6px`, `border-radius: 16px`, `border: 1px solid var(--line-2)`; selected =
> `border-color: var(--accent)`, `background: var(--accent-soft)`. **No checkbox** — the card itself is
> the selection target.
>
> Inside: a 9:19.5 screen box, `border-radius: 12px`. Live devices get a flat `var(--muted-2)` surface
> (placeholder for the real Android cast); non-live get a 135° 6px stripe pattern at `opacity: 0.7`.
> Overlays:
> - Top, centered, over a `linear-gradient(to bottom, var(--panel-a), transparent)`: device name
>   (12px/500) and serial (`Geist Mono` 10px `var(--faint)`).
> - Center text **only when not live**: "Disconnected" or "Unauthorized" (11px; unauthorized in `var(--warn)`).
>   A connected device shows no center text — the cast fills the box.
> - Bottom-left **state dot**: 9px circle, `box-shadow: 0 0 0 3px var(--panel-a)`. Green `var(--ok)` = free,
>   amber `var(--warn-2)` = someone is controlling it, red `var(--danger)` = a job is running,
>   grey `var(--faint-2)` = disconnected, `var(--warn)` = unauthorized. **Hover the dot** for a dark
>   tooltip (`var(--tooltip-bg)`/`var(--tooltip-fg)`, `border-radius: 8px`, 10px) naming the reason:
>   "Job · tiktok_warmup.py", "Controlled by rz@studio", "Free · idle", "Last seen 12m ago".
> - No percentages anywhere on the card.
>
> The same state mapping drives the table's status dot, so table and grid never disagree.
>
> ### Selection
> Identical in both views:
> - **Single click** toggles select/unselect. The click handler is deferred 200ms and cancelled by a
>   double-click so double-clicking never leaves a stray selection.
> - **Marquee drag** anywhere in the list area draws a `1px solid var(--accent)` /
>   `var(--accent-a1)` box (`border-radius: 6px`) and selects every intersecting row/card. Holding
>   **Shift / Ctrl / Cmd** unions with the existing selection; otherwise it replaces it. A 5px threshold
>   distinguishes a drag from a click.
> - **Ctrl/Cmd + A** selects everything currently filtered (ignored while Device Control is open or while
>   typing in an input).
> - **Escape** is tiered: close any open popup/menu first; if nothing is open, clear the selection.
>
> ### Bulk actions (floating, bottom-right of the panel)
> Appears only when something is selected: a pill — `height: 40px`, `padding: 0 16px`,
> `border-radius: 999px`, `background: var(--accent)`, `color: var(--on-accent)`,
> `box-shadow: 0 10px 24px var(--accent-a3)` — reading "**N selected**" with a caret. It is
> **click-to-open**, not always-expanded. Beside it, a 40×40 circular `ph-x` button
> (`background: var(--panel)`, `border: 1px solid var(--border-2)`; hover turns `var(--danger)`) clears
> the selection.
>
> Opening it reveals a 226px menu above the pill (`border-radius: 14px`,
> `box-shadow: 0 20px 50px #00000026`) headed "Bulk action" + **Clear**, listing the **generic action set**.
>
> ### Generic action set (one list, used everywhere)
> The same twelve actions appear in the bulk menu and in Device Control → Actions, so selecting one
> device and selecting twenty behave identically:
>
> `Reconnect` (`ph-arrows-clockwise`) · `Disconnect` (`ph-plugs`) · `Install apk` (`ph-download-simple`) ·
> `Adb command` (`ph-terminal`) · `Run script` (`ph-play`) · `Screenshot` (`ph-camera`) ·
> `Sleep` (`ph-moon`) · `Move group` (`ph-folder-simple`) · `Upload file` (`ph-upload-simple`) ·
> `Clear cache` (`ph-broom`) · `Settings` (`ph-gear`) · `Forget` (`ph-trash`, `var(--danger)`).
>
> Rows: `padding: 9px 10px`, `border-radius: 10px`, 13px, hover `background: var(--muted)`.
>
> ### Discovery sheet (right sheet)
> Opened by the Discovered pill. `position: fixed; inset: 0` scrim `var(--scrim)`; panel
> `width: 452px; height: 100%`, `background: var(--panel)`, `border-left: 1px solid var(--border)`,
> slides in from the right. Clicking the scrim or ✕ closes it.
>
> - Title "Discovered" (16px/600) and body copy: *"Phones adb can see that are not part of the farm. Add
>   one to make it schedulable, or dismiss it — a dismissed phone is not blocked, it just comes back here
>   the next time it connects."*
> - Row above the divider: "Missing a phone? Rescan checks adb directly, right now." + **Rescan** button
>   (shares the toolbar's spin state).
> - One card per phone: `border: 1px solid var(--border-2)`, `border-radius: 14px`, `padding: 12px 13px 13px`
>   — model (13px/600), endpoint (`Geist Mono` 11.5px `var(--dim)`), "Android 10 · waiting since 13d ago"
>   (11.5px `var(--faint)`), a ✕ dismiss button top-right, and **Add to farm** bottom-right
>   (`padding: 8px 13px`, `border-radius: 10px`, `background: var(--muted)`, `border: 1px solid
>   var(--border-2)`) which becomes a non-interactive "Added" chip in `var(--accent-soft)`/`var(--accent)`.
> - The pill's counter only counts phones still un-added. Empty state: *"Nothing waiting — every phone adb
>   can see is already on the farm."*
>
> **Important product rule:** a phone visible to ADB is **not** automatically on the farm. It appears in
> discovery and must be explicitly added before it can be scheduled.

Two values the README does not state come from `docs/mvp/15-ui-migration.md` §0 and §3 step 3 rather than being invented: the `#` column is the device number (`DeviceInfo.number`), and the Task column is the activity list.

### 4.2 Protocol changes

`packages/protocol/src/device.ts`, appended after `DeviceInfoSchema`:

```ts
/**
 * Live host-side metrics for one device (plan 214 §3.7). NOT persisted: these
 * are facts about a phone that is plugged in right now, sampled by the poller
 * that already reads `dumpsys battery` (`packages/core/src/device/battery.ts`)
 * and projected into `DeviceInfo` the way plan 205 projects activities. A
 * device with no sample yet, or one that is offline, carries `null` here and
 * every metric column renders an em dash, which is the handoff's own rule for
 * a disconnected row.
 *
 * Every field is independently nullable because they are independently
 * knowable: `/proc/stat` needs two samples before a percentage exists, and an
 * OEM that refuses `df /data` still answers `/proc/uptime`.
 */
export const DeviceMetricsSchema = z.object({
  /** Whole-device CPU over the interval between the last two samples. `null` on the first sample. */
  cpuPercent: z.number().min(0).max(100).nullable(),
  /** `(MemTotal - MemAvailable) / MemTotal`, from `/proc/meminfo`. */
  memPercent: z.number().min(0).max(100).nullable(),
  /** `df /data`'s use percentage. */
  diskPercent: z.number().min(0).max(100).nullable(),
  /** `/proc/uptime`'s first field, truncated to seconds. */
  uptimeSec: z.number().int().min(0).nullable(),
  /** Unix epoch seconds. */
  updatedAt: z.number().int(),
})
export type DeviceMetrics = z.infer<typeof DeviceMetricsSchema>

/** One device's metrics sample (plan 214 §4.3). Broadcast, no subscribe message. */
export const DeviceMetricsMessage = z.object({
  type: z.literal('device.metrics'),
  payload: z.object({ deviceId: z.string(), metrics: DeviceMetricsSchema }),
})
export type DeviceMetricsEvent = z.infer<typeof DeviceMetricsMessage>
```

Two fields are added to `DeviceInfoSchema`, both defaulted so an older core still parses:

```ts
  /**
   * `ro.product.model` as the registry probe read it (plan 214 §3.7).
   * The handoff's Device cell is a name over a model, and `label` is the
   * operator's name for the phone, which on a renamed device is not the
   * model at all. Null for a row admitted before this column existed and
   * never probed since.
   */
  model: z.string().nullable().default(null),
  /** Live metrics, or null when nothing has been sampled (plan 214 §4.2). */
  metrics: DeviceMetricsSchema.nullable().default(null),
```

`packages/protocol/src/index.ts`: export everything from `./device` as it already does, and add `DeviceMetricsMessage` to `ServerMessageSchema`'s union beside `DeviceBatteryMessage`.

`packages/protocol/src/api/devices.ts`, new, so Studio stops casting (G11):

```ts
/** `GET /api/devices/discovered` (plan 56 §4.3), longest-waiting first. */
export const DiscoveredDeviceSchema = z.object({
  stableId: z.string(),
  serial: z.string(),
  /** `ro.product.model` when the probe could read it. */
  label: z.string().nullable(),
  androidVersion: z.string().nullable(),
  /** Unix seconds. */
  firstSeen: z.number().int().nullable(),
  lastSeen: z.number().int().nullable(),
})
export type DiscoveredDeviceInfo = z.infer<typeof DiscoveredDeviceSchema>
export const DiscoveredDevicesResponseSchema = z.object({ discovered: z.array(DiscoveredDeviceSchema) })
```

### 4.3 Core: the metrics sampler and the model column

**Schema.** `packages/core/src/db/schema.ts`, in `devices`, directly after `label: text('label').notNull(),` (`:16`):

```ts
    /** Best-effort `ro.product.model` from the registry probe (plan 214 §3.7) — the handoff's Device cell shows it under the name. Null until a probe has seen this device. */
    model: text('model'),
```

The migration is generated with `bun run --cwd packages/core db:generate` and never hand-written. It is a plain `ALTER TABLE devices ADD COLUMN model text;`, with no backfill: the next probe fills every device that is plugged in, and a device that is never seen again honestly has no model.

**Writer.** `packages/core/src/registry/device-registry.ts`, in the enrolment upsert: add `model: probe.model ?? null,` to the `.values({ … })` object beside `label: probe.model ?? probe.stableId,` (`:609`) and to the `.onConflictDoUpdate({ set: { … } })` object beside `androidVersion: probe.androidVersion,` (`:625`). Both, so a device admitted before this column gets it on its next sighting.

**Reader.** `rowToDeviceInfo` (`packages/core/src/registry/device-registry.ts:346`) gains `model: row.model ?? null,` beside `label: row.label,` (`:351`) and one new trailing parameter, defaulted the way `number` is (`:345` `number: number | null = null,`):

```ts
  /**
   * Live metrics (plan 214 §4.2), read from the sampler's in-memory map,
   * never from a column, because there is no column: a metric is a fact
   * about a phone that is plugged in now. Defaulted to `null` so every
   * existing caller keeps parsing exactly as before.
   */
  metrics: DeviceMetrics | null = null,
```

`packages/core/src/api/devices.ts`'s `infoWithTags` helper passes `deps.metricsOf?.(row.id) ?? null`, and `createDeviceRoutes`'s deps gain `metricsOf?: (deviceId: string) => DeviceMetrics | null`.

**Sampler.** `packages/core/src/device/metrics.ts` (new):

```ts
import type { DeviceMetrics } from '@enkaku/protocol'

/**
 * One shell round trip per device per poll (plan 214 §3.7). Deliberately four
 * `/proc` reads and one `df` in a single `exec` rather than four execs: the
 * poller runs on every online device every `battery.pollIntervalSec`, and on a
 * 100 device farm the difference is 100 adb round trips per minute against
 * 400. `top` is not used at all: it costs a sampling delay on the phone, and
 * two `/proc/stat` reads a minute apart answer the same question for free.
 */
export const METRICS_PROBE =
  "echo __UP; cat /proc/uptime; echo __MEM; grep -E '^Mem(Total|Available):' /proc/meminfo; echo __CPU; grep -E '^cpu ' /proc/stat; echo __DF; df /data"

/** The `/proc/stat` counters one sample carries, kept per device so the next sample can difference them. */
export interface CpuSample {
  idle: number
  total: number
}

export interface ParsedMetrics {
  metrics: DeviceMetrics
  /** Carry into the next call for this device; `null` when `/proc/stat` was unreadable. */
  cpu: CpuSample | null
}

/**
 * Pure, so it is provable without a phone. `prev` is the previous call's
 * `cpu`; with no previous sample `cpuPercent` is `null` rather than a guess.
 * Every field independently degrades to `null` when its source line is
 * missing, which is what an OEM that refuses one of these reads produces.
 */
export declare function parseDeviceMetrics(raw: string, prev: CpuSample | null, nowSec: number): ParsedMetrics
```

Rules the implementation follows, exactly:

1. Split on the four markers `__UP`, `__MEM`, `__CPU`, `__DF`; a missing marker leaves that section empty and its field `null`.
2. `uptimeSec` is `Math.floor(Number(firstToken))` of the `__UP` section, `null` when it is not finite.
3. `memPercent` needs both `MemTotal` and `MemAvailable`; it is `((total - available) / total) * 100`, rounded to one decimal, clamped to `[0, 100]`.
4. `cpu` is `{ idle: idle + iowait, total: sum of every field }` from the `cpu ` line. `cpuPercent` is `100 * (1 - (idle - prev.idle) / (total - prev.total))`, rounded to one decimal, clamped to `[0, 100]`; `null` when `prev` is null or `total - prev.total <= 0` (a reboot resets the counters).
5. `diskPercent` is the token ending in `%` on the last non-empty line of the `__DF` section, parsed as an integer; `null` when absent.
6. `updatedAt` is `nowSec`.
7. Never throw. A malformed section yields `null` for its field and nothing else.

**Wiring.** `packages/core/src/device/battery.ts`:

- `createBatteryMonitor`'s deps gain `onMetrics: (deviceId: string, metrics: DeviceMetrics) => void`.
- The module keeps `const cpuPrev = new Map<string, CpuSample>()` and `const latest = new Map<string, DeviceMetrics>()`.
- `pollDevice` (`:79`), after the existing `dumpsys battery` block and inside the same `try`, runs `const { stdout } = await client.exec(row.serial, METRICS_PROBE, { profile: 'battery' })`, then `const { metrics, cpu } = parseDeviceMetrics(stdout, cpuPrev.get(row.id) ?? null, Math.floor(Date.now() / 1000))`, stores `cpu` and `metrics`, and calls `deps.onMetrics(row.id, metrics)`. The `battery` profile is reused deliberately: the same cadence, the same 8 second ceiling, and the same slice of the adb semaphore budget the poll already holds.
- The returned object gains `metricsOf(deviceId: string): DeviceMetrics | null` reading `latest`, and drops a device's entry from both maps when the poll finds it offline, so a disconnected row shows em dashes rather than a stale number.

`packages/core/src/daemon.ts:4266-4275`: add `onMetrics: (deviceId, metrics) => hub.broadcast({ type: 'device.metrics', payload: { deviceId, metrics } }),` beside the existing `onBattery` line, and pass `metricsOf: (id) => battery?.metricsOf(id) ?? null` into `createDeviceRoutes`.

### 4.4 File structure

```
packages/studio/src/
  app/
    page.tsx                              CHANGED  (rewritten: a Suspense boundary around DevicesScreen)
    groups/page.tsx                       DELETED
  components/
    devices/
      DevicesScreen.tsx                   NEW  the composition inside plan 213's PagePanel
      DevicesToolbar.tsx                  NEW  the 58px toolbar: group tabs, Discovered pill, four icon buttons
      GroupTabs.tsx                       NEW  the pill container, the add popover, the right-click menu
      DeviceTable.tsx                     NEW  the 13 column grid, sticky header, 54px rows   (Ships)
      TaskCell.tsx                        NEW  the four-variant task chip
      ScreensGrid.tsx                     NEW  the auto-fill card grid and the live-set wiring
      DeviceScreenCard.tsx                NEW  one 9:19.5 card
      BulkPill.tsx                        NEW  the floating pill, the clear button, the 226px menu
      ActionMenu.tsx                      NEW  the generic action set, rendered from action-set.ts
      DiscoverySheet.tsx                  NEW  the 452px right sheet
      action-set.ts                       NEW  the twelve rows as data
      device-state.ts                     NEW  deviceState -> StatusDot state, and the dot tooltip sentence
      useDevices.ts                       NEW  the device list: one seed, then pushes
      useQueuedJobs.ts                    NEW  queued jobs per device: one seed, then pushes
      useDeviceSelection.ts               NEW  deferred click, marquee, Ctrl+A, Escape tier
      useLiveSet.ts                       MOVED from components/wall/useLiveSet.ts, edited (§3.9)
    wall/
      useLiveSet.ts                       DELETED (moved)
      useDragSelect.ts                    DELETED
      SelectionCursorBadge.tsx            DELETED
      DeviceContextMenu.tsx               DELETED
      Wall.tsx                            CHANGED  (import path only)
      WallTile.tsx                        CHANGED  (explainQuarantine import only)
    DeviceCard.tsx                        DELETED
    DiscoveredTray.tsx                    DELETED
    AdmitDeviceDialog.tsx                 DELETED
    ClusterEditorDialog.tsx               DELETED  (renamed GroupEditorDialog.tsx by plan 207)
    ClusterMembersDialog.tsx              DELETED  (renamed GroupMembersDialog.tsx by plan 207)
    device/ScanNetworkDialog.tsx          DELETED
  hooks/use-bulk-selection.ts             DELETED
  lib/
    api.ts                                CHANGED  (fetchDiscoveredDevices parses; DiscoveredDevice re-exported from protocol)
    prefs.ts                              CHANGED  (tileSize, pageSize and the session view replaced)
    quarantine.ts                         NEW      (explainQuarantine, moved out of DeviceCard)
    overlays.ts                           CHANGED  (one new export, hasOverlay)
packages/protocol/src/
  device.ts                               CHANGED  (§4.2)
  device.test.ts                          CHANGED  (§7.1)
  api/devices.ts                          CHANGED  (§4.2)
  index.ts                                CHANGED  (ServerMessageSchema)
packages/core/src/
  db/schema.ts                            CHANGED  (devices.model)
  drizzle/NNNN_device_model.sql           NEW      (generated)
  device/metrics.ts                       NEW      (§4.3)
  device/battery.ts                       CHANGED  (§4.3)
  registry/device-registry.ts             CHANGED  (§4.3)
  api/devices.ts                          CHANGED  (metricsOf dep)
  daemon.ts                               CHANGED  (onMetrics, metricsOf)
scripts/check-routes.ts                   CHANGED  (§4.16)
```

### 4.5 `components/devices/device-state.ts` (new, complete)

```ts
import { deviceState, type DeviceInfo } from '@enkaku/protocol'
import type { StatusDotState } from '@enkaku/ui'
import { relativeTime } from '@enkaku/ui'

/**
 * The one mapping between plan 205's `deviceState()` (`free | controlled |
 * job | offline | warn`) and plan 204's `StatusDot` (`free | controlled |
 * job | offline | unauthorized`). The two lists differ in exactly one entry,
 * and the difference is a word, not a colour: the handoff calls the amber
 * state "unauthorized" (README, Screens view), the MVP's stored status is
 * `quarantined` (plan 205 §4.1), and `var(--warn)` is what both mean.
 *
 * There is deliberately no second copy of this map anywhere; a screen that
 * needs a dot imports from here (plan 214 §3.3).
 */
export const DOT_STATE: Record<ReturnType<typeof deviceState>, StatusDotState> = {
  free: 'free',
  controlled: 'controlled',
  job: 'job',
  offline: 'offline',
  warn: 'unauthorized',
}

export function dotStateOf(device: DeviceInfo): StatusDotState {
  return DOT_STATE[deviceState(device)]
}

/**
 * The dot's hover tooltip, in the handoff's own four shapes ("Job ·
 * tiktok_warmup.py", "Controlled by rz@studio", "Free · idle", "Last seen 12m
 * ago"). Built from the activity list, so it can never disagree with the Task
 * cell beside it.
 */
export function dotTooltipOf(device: DeviceInfo): string {
  if (device.status === 'offline') return `Last seen ${relativeTime(device.lastSeen)}`
  if (device.status === 'quarantined') return device.quarantineReason ? `Quarantined · ${device.quarantineReason}` : 'Quarantined'
  const job = device.activities.find((a) => a.kind === 'job' || a.kind === 'workflow-job')
  if (job) return `Job · ${job.label}`
  const control = device.activities.find((a) => a.kind === 'control')
  if (control) return `Controlled by ${control.actor.label}`
  const other = device.activities[0]
  if (other) return other.label
  return 'Free · idle'
}
```

### 4.6 `components/devices/DevicesToolbar.tsx` (new)

The handoff's 58 px toolbar. Root: `flex h-[58px] flex-none items-center gap-[10px] border-b border-line px-3`. The left half is `<GroupTabs />` (§4.7), then `<div className="flex-1" />`, then the right controls.

The Discovered pill, exactly the handoff's values:

```tsx
<button
  type="button"
  onClick={onOpenDiscovery}
  className="flex flex-none items-center gap-1.5 rounded-pill border border-border-2 bg-panel-2 px-[13px] py-[7px] text-body text-text-2 hover:bg-muted"
>
  <TrayArrowDownIcon className="size-4" aria-hidden />
  Discovered ({pendingCount})
</button>
```

`pendingCount` counts only un-added phones (§4.13). The pill is rendered only when `pendingCount > 0`; a farm with nothing waiting shows no pill, matching the sheet's own empty-state sentence being a fallback rather than a destination.

The four icon buttons share one class trio, and `active` is the handoff's "menu open or filter applied":

```tsx
const ICON_BTN = 'flex size-8 flex-none items-center justify-center rounded-button transition-colors'
const ICON_IDLE = 'text-faint hover:bg-muted-2 hover:text-text'
const ICON_ACTIVE = 'bg-accent-soft text-accent'
```

| Button | Icon | Active when | Popover |
|---|---|---|---|
| Search | `MagnifyingGlassIcon` | the popover is open, or `query !== ''` | 300 px |
| Filter | `FunnelIcon` | the menu is open, or `filter !== 'all'` | 216 px |
| View | `RowsIcon` when `view === 'table'`, `SquaresFourIcon` when `view === 'screens'` | the menu is open | 200 px |
| Rescan | `ArrowsClockwiseIcon` | never | none; `animate-enkaku-spin` for 1400 ms |

Each popover wrapper carries `data-menu-root="1"` and calls plan 213's `useOverlay('menu', open, close)`, which is what makes Escape and the outside click work with no listener of this screen's own (plan 213 §4.9 rule 5).

**Search popover**, 300 px: an `Input variant="search"` with `placeholder="serial, label, model, task"`, and under it a row reading `` `${matchCount} match${matchCount === 1 ? '' : 'es'}` `` in `text-meta text-faint` with a `Clear` button in `text-meta text-accent`. The predicate matches name, serial, model, group and task, and is one exported function so the count and the list cannot disagree:

```ts
export function matchesDevice(d: DeviceInfo, q: string, task: string): boolean {
  const needle = q.trim().toLowerCase()
  if (!needle) return true
  return (
    matchesDeviceQuery(d, needle) ||
    d.serial.toLowerCase().includes(needle) ||
    (d.model ?? '').toLowerCase().includes(needle) ||
    (d.group?.name ?? '').toLowerCase().includes(needle) ||
    task.toLowerCase().includes(needle)
  )
}
```

`matchesDeviceQuery` is `@enkaku/ui`'s existing four-way predicate over number, label, stableId and tag (`packages/ui/src/lib/device-name.ts:141`), so this box and every picker in the product keep agreeing about what a query means.

**Filter menu**, 216 px, five rows, each a `StatusDot` plus a label plus a count plus a `CheckIcon` on the active one. Row classes: `flex w-full items-center gap-2 rounded-button px-[10px] py-[9px] text-row hover:bg-muted`.

| Row | Predicate | Dot |
|---|---|---|
| All | everything | none |
| Free | `deviceState(d) === 'free'` | `free` |
| Running job | `deviceState(d) === 'job'` | `job` |
| Quarantined | `d.status === 'quarantined'` | `unauthorized` |
| Disconnected | `d.status === 'offline'` | `offline` |

The handoff's fourth row reads "Unauthorized"; §3.2 item 3 and §9 Q2 explain the word. The handoff has no "Controlled" row and this plan adds none.

**View menu**, 200 px: two rows, Table and Screens, each with the same row classes and a `CheckIcon` on the active one. When `view === 'screens'` the menu also renders a Card width block: a `text-meta text-faint` label reading `Card width` with the current value in `font-mono` beside it, then four buttons S, M, L, XL mapping to 112, 146, 190 and 240 px. The mapping is one exported constant:

```ts
export const CARD_WIDTH_PX = { s: 112, m: 146, l: 190, xl: 240 } as const
export type CardWidth = keyof typeof CARD_WIDTH_PX
```

**Rescan**: `POST /api/devices/rescan` through `api('/api/devices/rescan', ReconcileReportSchema, { method: 'POST' })`. The spin is a single state the toolbar owns and the discovery sheet reads, so both buttons spin together as the handoff requires:

```ts
const RESCAN_SPIN_MS = 1400
```

The button carries `animate-enkaku-spin` on its icon while `spinning`, and `spinning` is cleared by one `setTimeout(…, RESCAN_SPIN_MS)`. That timer schedules no fetch and is exempt from G5 by name: `GREP_214_POLL` matches `setTimeout`/`setInterval` only in the same statement as `fetch` or `api(`.

### 4.7 `components/devices/GroupTabs.tsx` (new)

The container is plan 204's `TabsList variant="pill"` shape, written directly rather than through Radix because the tabs also take a right-click and a per-tab count:

```tsx
<div className="flex min-w-0 flex-[0_1_auto] items-center gap-1 overflow-x-auto rounded-pill bg-muted p-1">
  {tabs.map((t) => (
    <button
      key={t.id}
      type="button"
      onClick={() => onSelect(t.id)}
      onContextMenu={(e) => t.id !== 'all' && openTabMenu(e, t)}
      className={cn(
        'flex flex-none items-center rounded-pill px-[14px] py-[7px] text-body transition-colors',
        t.id === active ? 'bg-panel font-semibold text-text shadow-active-pill' : 'text-dim hover:text-text',
      )}
    >
      {t.name}
      <span className="ml-[7px] text-label text-faint">{t.count}</span>
    </button>
  ))}
</div>
```

`tabs[0]` is always `{ id: 'all', name: 'All', count: devices.length }`; the rest come from `GET /api/groups` with `count` computed from the loaded device list (`devices.filter((d) => d.group?.id === g.id).length`), never from the server's `deviceCount`, so the number beside a tab always equals the number of rows clicking it produces.

The add button, immediately right of the container:

```tsx
<button
  type="button"
  onClick={() => openForm({ mode: 'new' })}
  aria-label="New group"
  className="flex size-[30px] flex-none items-center justify-center rounded-pill border border-dashed border-border-3 text-faint transition-colors hover:border-accent hover:text-accent"
>
  <PlusIcon className="size-[14px]" aria-hidden />
</button>
```

**The form popover**, 224 px, `top: 40px`, right-aligned, inside a `data-menu-root="1"` wrapper with `useOverlay('menu', formOpen, closeForm)`:

- Title `New group` or `Rename group`, `text-body font-semibold text-text`.
- One `Input` autofocused, `value={draft}`, `onKeyDown`: `Enter` submits, `Escape` closes (the overlay registry also closes it, and both paths call the same `closeForm`).
- Footer: `Create` (or `Save`), `Button variant="default" size="sm"`, and `Cancel`, `Button variant="ghost" size="sm"`.
- The name transform is one exported pure function, because it is the handoff's rule and it has to be identical on create and rename:

```ts
/** `Farm D` -> `FARM-D` (design handoff, Devices toolbar). Collapses runs of whitespace, then uppercases. */
export function normaliseGroupName(raw: string): string {
  return raw.trim().replace(/\s+/g, '-').toUpperCase()
}
```

- Submit calls `POST /api/groups` with `{ name: normaliseGroupName(draft) }` (new) or `PATCH /api/groups/:id` with the same body (rename), both through `api(…, GroupResponseSchema, …)`. An empty normalised name disables the primary button rather than sending.

**The tab context menu**, 188 px, positioned at the tab's own x offset (`e.currentTarget.getBoundingClientRect().left` relative to the toolbar), two rows using the same row classes as the filter menu:

- `Rename group`, `PencilSimpleIcon`, opens the form pre-filled.
- `Delete group`, `TrashIcon`, `text-danger`, calls `DELETE /api/groups/:id`; on success, if the deleted group was active the strip falls back to `all`, and the device list is reloaded so the freed devices lose their group chip.

Deleting through `ConfirmDialog` is deliberately not used: the core's own route unassigns members and leaves every device standing (`packages/core/src/api/clusters.ts:162-170`, "Deleting a cluster unassigns its members in the same transaction"), so the act is reversible by recreating the group, and the handoff draws no confirmation.

### 4.8 `components/devices/DeviceTable.tsx` (new, Ships)

The handoff specifies a CSS grid with two `fr` columns. Plan 204 §4.6 re-skinned the `Table` primitive to exactly this design (38 px header on `bg-panel-2`, `text-label text-faint` labels, `border-b border-muted-2` rows, `hover:bg-hover`, `data-[state=selected]:bg-accent-soft data-[state=selected]:shadow-selected-row`), but a real `<table>` cannot take `grid-template-columns`, and forcing `display: grid` onto one throws away the semantics that were the reason to use it. This component therefore uses `div`s with `role="table"`, `role="row"`, `role="columnheader"` and `role="cell"`, and **reuses plan 204's class strings verbatim** so the two can never disagree.

```tsx
/** The handoff's grid, character for character. Two `fr` columns, so it cannot be a `<table>` (plan 214 §4.8). */
const COLS =
  'grid grid-cols-[38px_44px_1.3fr_108px_92px_138px_70px_74px_62px_62px_62px_76px_1.1fr] items-center'

const HEAD = 'px-2 text-left text-label font-medium text-faint'
const CELL = 'px-2 text-body'
const MONO = 'px-2 font-mono text-[12px] text-text-3'
```

Root: `<div className="min-h-0 flex-1 overflow-auto">` with an inner `<div role="table" className="min-w-[1324px]">`.

Header: `<div role="row" className={cn(COLS, 'sticky top-0 z-10 h-[38px] border-b border-line bg-panel-2')}>` holding the header checkbox and the twelve labels `#`, `Device`, `Serial`, `OS`, `Endpoint`, `Batt`, `Temp`, `CPU`, `Mem`, `Disk`, `Uptime`, `Task`. The header checkbox is plan 204's `Checkbox`, `checked` when every filtered id is selected, `indeterminate` styling not drawn (the handoff draws none), and `onCheckedChange` selecting or clearing all filtered rows.

Row:

```tsx
<div
  role="row"
  data-device-id={device.id}
  data-state={selected ? 'selected' : undefined}
  onMouseDown={onRowMouseDown}
  className={cn(
    COLS,
    'h-[54px] border-b border-muted-2 transition-colors hover:bg-hover select-none',
    selected && 'bg-accent-soft shadow-selected-row',
    device.status === 'offline' && 'opacity-60',
  )}
>
```

`data-device-id` is what the marquee's DOM hit test reads (§4.11), the same technique the deleted `useDragSelect` used (`useDragSelect.ts:96` `container.querySelectorAll<HTMLElement>('[data-device-id]')`).

Cells, in order:

1. **Checkbox**, `size-4 rounded-check border-[1.5px] border-border-3` from plan 204's `Checkbox`, wrapped in a `div` with `onClick={(e) => e.stopPropagation()}` so ticking a box never runs the deferred row click.
2. **`#`**: `<span className="px-2 font-mono text-[11.5px] text-faint">{String(index + 1).padStart(2, '0')}</span>`. The handoff says "system row number … follows the filtered order", so it is the row index in the filtered list, zero padded, not `device.number`. `device.number` is the phone's own number and appears in the Device cell through `formatDeviceName`.
3. **Device**: `StatusDot` at `size-2` (the handoff's 8 px, which is `StatusDot`'s `ring={false}` default) with `title={dotTooltipOf(device)}`, then a two-line block: `<span className="truncate text-row font-medium text-text">{formatDeviceName(device.number, device.label)}</span>` over `<span className="truncate text-label text-faint">{device.model ?? device.stableId}</span>`.
4. **Serial**: `MONO`, `device.serial`.
5. **OS**: `CELL text-text-3`, `device.androidVersion ?? '—'`.
6. **Endpoint**: `MONO`, `device.connection.address ? \`${device.connection.address}:${device.connection.port ?? ''}\` : connectionBadge(device.connection)`. A USB device has no address, and the badge (`USB`, `OTG`, `WI-FI`, `TCP`; `packages/protocol/src/device.ts:36`) is the honest answer rather than an em dash.
7. **Batt**: `metricCell`, value `` `${device.battery.level}%` ``, colour by the handoff's thresholds:

```tsx
const battClass = (level: number) => (level < 20 ? 'text-danger' : level < 45 ? 'text-warn' : 'text-accent')
```

   No progress bar, anywhere, ever: the handoff says so twice.
8. **Temp**: `` `${device.battery.temperatureC.toFixed(0)}°` ``, `device.battery.temperatureC > 42 ? 'text-danger' : 'text-text-3'`.
9. **CPU / Mem / Disk**: `device.metrics?.cpuPercent`, `memPercent`, `diskPercent`, each rendered as a rounded integer with `%`, `text-text-3`.
10. **Uptime**: `formatUptime(device.metrics?.uptimeSec)`, a local pure helper producing `4d 2h`, `2h 13m`, `41m`, in `font-mono text-[12px] text-text-3`.
11. **Task**: `<TaskCell device={device} queued={queuedFor(device.id)} />` (§4.9).

Every metric cell goes through one helper so the disconnected rule is written once:

```tsx
/** The handoff: "Disconnected rows render at `opacity: 0.6` and show `—` for every metric." */
function Metric({ value, className }: { value: string | null; className?: string }) {
  return <span className={cn('px-2 text-body', value === null ? 'text-faint-2' : className)}>{value ?? '—'}</span>
}
```

and the caller passes `null` for every metric when `device.status === 'offline'`, regardless of what the last sample said.

The row list is **not** virtualised. 100 rows of 54 px is 5400 px of DOM, thirteen spans each; the measured cost of a virtualiser here would be a scroll listener plus a re-render per frame, which is the opposite of G5's goal. If the owner's farm passes 400 devices this decision is revisited, and §8 records the trigger.

### 4.9 `components/devices/TaskCell.tsx` (new, complete shape)

```tsx
import { Badge } from '@enkaku/ui'
import type { DeviceActivity, DeviceInfo } from '@enkaku/protocol'

/**
 * The handoff's four Task variants (README, Table view), driven by the
 * activity list (MVP 15 §3 step 3: "Task is the activity list"):
 *
 *   script running -> `var(--accent-soft)`/`var(--accent)`   Badge variant="default"
 *   system action  -> `var(--warn-soft)`/`var(--warn)`       Badge variant="warn"
 *   queued         -> `var(--muted-2)`/`var(--dim)`          Badge variant="secondary"
 *   idle           -> plain `var(--faint-2)` text, no pill   Badge variant="ghost"
 *
 * `control` is deliberately NOT a Task: someone driving a phone is expressed
 * by the amber status dot (plan 214 §4.5), and showing it twice would make a
 * controlled idle device read as busy.
 */
const SCRIPT_KINDS = new Set<DeviceActivity['kind']>(['job', 'workflow-job'])

export function taskLabelOf(device: Pick<DeviceInfo, 'activities'>, queued: number): string {
  const script = device.activities.find((a) => SCRIPT_KINDS.has(a.kind))
  if (script) return script.label
  const system = device.activities.find((a) => a.kind !== 'control')
  if (system) return system.label
  if (queued > 0) return `Queued (${queued})`
  return 'Idle'
}

export function TaskCell({ device, queued }: { device: DeviceInfo; queued: number }) {
  const script = device.activities.find((a) => SCRIPT_KINDS.has(a.kind))
  const system = device.activities.find((a) => a.kind !== 'control')
  const variant = script ? 'default' : system ? 'warn' : queued > 0 ? 'secondary' : 'ghost'
  return (
    <span className="min-w-0 px-2">
      <Badge variant={variant} className="max-w-full truncate">
        {taskLabelOf(device, queued)}
      </Badge>
    </span>
  )
}
```

`Badge`'s base is plan 204 §4.6's `rounded-pill px-[9px] py-[3px] text-meta font-medium`, which is the handoff's `padding: 3px 9px`, `border-radius: 999px`, 11.5px, and its `ghost` variant is `bg-transparent px-0 py-0 text-faint-2`, which is the handoff's "idle = plain `var(--faint-2)` text, no pill". No class is written here at all; that is the point of plan 204.

`taskLabelOf` is exported because the search predicate matches "task" (§4.6) and the two must agree.

### 4.10 `components/devices/ScreensGrid.tsx` and `DeviceScreenCard.tsx` (new)

Grid root, the handoff's own three declarations:

```tsx
<div
  className="min-h-0 flex-1 select-none overflow-auto p-[14px]"
  onMouseDown={selection.onMarqueeMouseDown}
>
  <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${CARD_WIDTH_PX[cardWidth]}px, 1fr))` }}>
```

`gap-3` is 12 px and `p-[14px]` is the handoff's padding. The one inline `style` in this plan is the card width, because it is a runtime number and Tailwind cannot emit a class for a value the operator picks.

`ScreensGrid` calls the moved `useLiveSet({ devices: filtered, maxTiles, rampConcurrency })` and reads `maxTiles` and `rampConcurrency` once at mount exactly as `Wall.tsx:213-228` does today (`/api/adb/stats` `video.maxTiles`, falling back to 8; `/api/settings` `wall.rampConcurrency`, falling back to 2). Two reads at mount, no timer.

The card:

```tsx
<div
  data-device-id={device.id}
  ref={tileRef(device.id)}
  className={cn(
    'rounded-panel border p-[6px] transition-colors',
    selected ? 'border-accent bg-accent-soft' : 'border-line-2',
  )}
>
  <div className="relative aspect-[9/19.5] overflow-hidden rounded-inner bg-muted-2">
    {live ? (
      <LiveView deviceId={device.id} inputEnabled={false} quality="wall" compact />
    ) : (
      <div className="absolute inset-0 opacity-70" style={STRIPE} />
    )}
    <div className="pointer-events-none absolute inset-x-0 top-0 flex flex-col items-center gap-0.5 bg-gradient-to-b from-panel-a to-transparent px-1 pt-1.5 pb-3">
      <span className="max-w-full truncate text-[12px] font-medium text-text">{formatDeviceName(device.number, device.label)}</span>
      <span className="max-w-full truncate font-mono text-tip text-faint">{device.serial}</span>
    </div>
    {!live && (
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <span className={cn('text-label', device.status === 'quarantined' ? 'text-warn' : 'text-faint-2')}>
          {device.status === 'quarantined' ? 'Quarantined' : 'Disconnected'}
        </span>
      </div>
    )}
    <StatusDot
      ring
      state={dotStateOf(device)}
      title={dotTooltipOf(device)}
      className="absolute bottom-1.5 left-1.5"
    />
  </div>
</div>
```

- `rounded-panel` is 16 px (the card) and `rounded-inner` is 12 px (the screen box), both plan 204 names.
- `StatusDot ring` is plan 204's `size-[9px] shadow-dot-ring`, which is the handoff's "9px circle, `box-shadow: 0 0 0 3px var(--panel-a)`".
- The tooltip is the native `title` the `StatusDot` prop already sets, not a Radix tooltip: the handoff draws a dark tooltip on hover, plan 204's `TooltipContent` supplies exactly those tokens, and a Radix tooltip per card on a 100 card grid is a per-device cost this screen may not pay. §9 Q3 puts the trade to the CEO; the sentence is identical either way.
- `STRIPE` is one module constant, the handoff's own pattern:

```ts
/** The handoff's "135° 6px stripe pattern at `opacity: 0.7`" for a screen that is not live. */
const STRIPE: CSSProperties = {
  backgroundImage: 'repeating-linear-gradient(135deg, var(--muted-2) 0 3px, var(--panel-2) 3px 6px)',
}
```

  It is a `style` rather than a class because it names two palette variables inside one gradient, which the v4 utility form cannot express; it names the variables, never a hex, so `GREP_214_COLOUR` still passes.
- `live` is `liveSet.live.has(device.id) && device.status === 'online'`. Under always-on sessions there is no build phase to draw: `LiveView` after plan 206 §4.9 shows one sentence from the activity list while it has no frames and retries by itself, so this card has no loading state of its own. That is `docs/mvp/11` §4's first acceptance line, and it is why the handoff's card has only two states.
- No percentages anywhere on the card, per the handoff.

### 4.11 `components/devices/useDeviceSelection.ts` (new)

```ts
'use client'

/**
 * The handoff's selection model (README, Selection), identical in both views.
 * One hook, because the table and the grid must produce the same set from the
 * same gestures, and the old screen's split between a click handler in
 * `app/page.tsx` and a drag hook in `components/wall/useDragSelect.ts` is what
 * let a plain drag clear the selection on mousedown before it had moved at all
 * (`useDragSelect.ts:158` `if (!additive) onSelect([])`).
 */

/** "The click handler is deferred 200ms and cancelled by a double-click." */
export const CLICK_DEFER_MS = 200
/** "A 5px threshold distinguishes a drag from a click." */
export const DRAG_THRESHOLD_PX = 5

export interface DeviceSelection {
  selected: ReadonlySet<string>
  /** Replaces the whole set. */
  set: (ids: string[]) => void
  clear: () => void
  /** Row/card `onMouseDown`: starts the deferred toggle and the potential marquee. */
  onItemMouseDown: (id: string, e: React.MouseEvent) => void
  /** Row/card `onDoubleClick`: cancels the pending toggle and calls `onOpenControl`. */
  onItemDoubleClick: (id: string) => void
  /** The scroller's `onMouseDown`: starts a marquee when the target is not inside a `[data-device-id]`. */
  onMarqueeMouseDown: (e: React.MouseEvent) => void
  /** The overlay rectangle, or null. */
  rect: { left: number; top: number; width: number; height: number } | null
}

export declare function useDeviceSelection(opts: {
  /** The filtered ids, in view order. Ctrl/Cmd+A selects exactly this. */
  filteredIds: readonly string[]
  /** The element `[data-device-id]` wrappers are searched inside. */
  containerRef: React.RefObject<HTMLElement | null>
  /** Double-click target. Undefined until plan 215 supplies the window. */
  onOpenControl?: (deviceId: string) => void
}): DeviceSelection
```

Rules the implementation follows, exactly:

1. **Deferred toggle.** `onItemMouseDown` with the primary button stores `{ id, x, y }` and arms `setTimeout(toggle, CLICK_DEFER_MS)`. `onItemDoubleClick` clears that timer before it fires and calls `onOpenControl?.(id)`; that is what "double-clicking never leaves a stray selection" means. A `mousemove` past `DRAG_THRESHOLD_PX` before the timer fires also clears it and promotes the gesture to a marquee.
2. **Marquee.** Started either by rule 1's promotion or by `onMarqueeMouseDown` on empty space. The rectangle is not drawn and no id changes until the pointer has moved more than `DRAG_THRESHOLD_PX` from the origin: unlike the deleted hook, a plain click on empty space therefore does **not** clear the selection on mousedown. Once past the threshold, on every `mousemove` the hook reads `containerRef.current.querySelectorAll('[data-device-id]')`, intersects each `getBoundingClientRect()` with the rectangle, and calls `set([...base, ...covered])`, where `base` is the selection as it was at mousedown when `shiftKey || metaKey || ctrlKey`, and `[]` otherwise. Shift joins Ctrl and Cmd here; the old hook honoured only Ctrl and Cmd (`useDragSelect.ts:148` `const additive = e.metaKey || e.ctrlKey`), and the handoff names all three.
3. **The overlay.** `rect` is rendered by the caller as `<div className="pointer-events-none fixed z-50 rounded-[6px] border border-accent bg-accent-a1" style={rect} />`, the handoff's "1px solid `var(--accent)` / `var(--accent-a1)` box (`border-radius: 6px`)".
4. **Ctrl/Cmd+A.** One `keydown` listener on `document`, added by this hook. It calls `set([...filteredIds])` and `preventDefault()` **only** when `(e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a'` and neither of two suspensions applies: the active element is an `input`, `textarea` or `[contenteditable]`, or `hasOverlay('window')` is true. The second is the handoff's "ignored while Device Control is open", expressed through plan 213's registry so that plan 215 needs no edit here (§4.15).
5. **Escape** is not handled by this hook at all. The caller registers `useOverlay('selection', selected.size > 0, clear)` and plan 213's tiering does the rest: a menu closes first, a window second, the selection last. Adding a `keydown` for Escape here would be the second listener plan 213 §8's risk table forbids.
6. Every listener is removed on unmount; nothing in this file fetches.

### 4.12 `components/devices/BulkPill.tsx`, `action-set.ts` and `ActionMenu.tsx` (new)

`action-set.ts`, the twelve rows as data, in the handoff's exact order:

```ts
import {
  ArrowsClockwiseIcon, BroomIcon, CameraIcon, DownloadSimpleIcon, FolderSimpleIcon, GearIcon,
  MoonIcon, PlayIcon, PlugsIcon, TerminalIcon, TrashIcon, UploadSimpleIcon, type Icon,
} from '@enkaku/ui'
import type { ActionVerb } from '@enkaku/protocol'

export interface ActionSetItem {
  verb: ActionVerb
  label: string
  icon: Icon
  /** `Forget` only: rendered in `var(--danger)` (design handoff). */
  danger?: boolean
  /**
   * The verb needs parameters this screen does not have, so it opens a dialog
   * plan 216 owns (plan 214 §3.10). Until that plan lands the row is rendered
   * disabled with a title naming it, which is visible rather than silent.
   */
  needsDialog?: boolean
  /** `set-group` only: this screen already knows every group, so it opens a submenu rather than a dialog. */
  submenu?: 'group'
}

/**
 * The generic action set (design handoff, "Generic action set (one list, used
 * everywhere)"): the same twelve rows in the bulk menu and in Device Control
 * -> Actions, "so selecting one device and selecting twenty behave
 * identically". Plan 215 imports this exact array; a second list anywhere is
 * the defect this file exists to prevent.
 */
export const GENERIC_ACTION_SET: readonly ActionSetItem[] = [
  { verb: 'reconnect', label: 'Reconnect', icon: ArrowsClockwiseIcon },
  { verb: 'disconnect', label: 'Disconnect', icon: PlugsIcon },
  { verb: 'install', label: 'Install apk', icon: DownloadSimpleIcon, needsDialog: true },
  { verb: 'adb', label: 'Adb command', icon: TerminalIcon, needsDialog: true },
  { verb: 'run-script', label: 'Run script', icon: PlayIcon, needsDialog: true },
  { verb: 'screenshot', label: 'Screenshot', icon: CameraIcon },
  { verb: 'sleep', label: 'Sleep', icon: MoonIcon },
  { verb: 'set-group', label: 'Move group', icon: FolderSimpleIcon, submenu: 'group' },
  { verb: 'push', label: 'Upload file', icon: UploadSimpleIcon, needsDialog: true },
  { verb: 'clear-cache', label: 'Clear cache', icon: BroomIcon, needsDialog: true },
  { verb: 'settings', label: 'Settings', icon: GearIcon, needsDialog: true },
  { verb: 'forget', label: 'Forget', icon: TrashIcon, danger: true },
]
```

`ActionMenu.tsx` renders that array with the handoff's row measurements and nothing else:

```tsx
const ROW = 'flex w-full items-center gap-2.5 rounded-button px-[10px] py-[9px] text-row transition-colors'
const ROW_IDLE = 'text-text hover:bg-muted'
const ROW_DANGER = 'text-danger hover:bg-muted'
const ROW_OFF = 'cursor-not-allowed text-faint-2'
```

A `needsDialog` row is `aria-disabled` with `title="Opens a dialog (plan 216)"` and `ROW_OFF`. The `set-group` row opens a nested 226 px menu of `All groups` entries plus `No group`, each calling `runAction('set-group', target, { groupId })` with `null` for the last one.

`BulkPill.tsx`, exactly the handoff's floating pair, positioned against `PagePanel`'s `relative`:

```tsx
<div className="absolute right-[14px] bottom-[14px] z-30 flex items-center gap-2" data-menu-root="1">
  {open && <ActionMenu … className="absolute right-0 bottom-[52px] w-[226px] rounded-card bg-panel p-1 shadow-menu" />}
  <button
    type="button"
    onClick={() => setOpen((v) => !v)}
    className="flex h-10 items-center gap-2 rounded-pill bg-accent px-4 text-body font-medium text-on-accent shadow-bulk-pill"
  >
    {count} selected
    <CaretDownIcon className="size-3.5" aria-hidden />
  </button>
  <button
    type="button"
    onClick={onClear}
    aria-label="Clear selection"
    className="flex size-10 items-center justify-center rounded-pill border border-border-2 bg-panel text-faint transition-colors hover:border-danger hover:text-danger"
  >
    <XIcon className="size-4" aria-hidden />
  </button>
</div>
```

`shadow-bulk-pill` is plan 204's `0 10px 24px var(--accent-a3)` and `shadow-menu` is `0 20px 50px #00000024`; the handoff writes `#00000026` for this one menu, and plan 204 §4.3 already normalised the two to one token. The menu's header row is `Bulk action` in `text-meta text-faint` with a `Clear` button in `text-meta text-accent` on the right.

Executing a row: `runAction(verb, target, params)` from `packages/studio/src/lib/actions.ts` (plan 207 §4.9), where `target` is `{ deviceIds: [...selected] }`. The outcome is one `toast` built from `groupResults(res.results)`: `` `${done.length} done, ${failed.length + forbidden.length} refused` `` on a mixed result, `toast.success` when nothing failed. `forget` is wrapped in `@enkaku/ui`'s `ConfirmDialog` with the title `Forget N devices?` and the description `Their history stays. A phone that reconnects appears in Discovered again.` The selection is cleared after a `forget` and kept after everything else, because a partial failure leaves the operator with devices to go and look at.

### 4.13 `components/devices/DiscoverySheet.tsx` (new)

Plan 204's `Sheet` already carries the handoff's measurements: `SheetOverlay` is `bg-scrim`, `SheetContent side="right"` is `w-[452px]` on `bg-panel` with `border-l border-border`, `SheetTitle` is `text-sheet font-semibold`. So this file writes no width and no scrim.

Content, in order:

1. `SheetTitle`: `Discovered`.
2. `SheetDescription`, verbatim: `Phones adb can see that are not part of the farm. Add one to make it schedulable, or dismiss it — a dismissed phone is not blocked, it just comes back here the next time it connects.`
3. The rescan row above a `border-b border-line` divider: `Missing a phone? Rescan checks adb directly, right now.` in `text-meta text-faint`, and a `Button variant="outline" size="sm"` labelled `Rescan` whose icon spins from the toolbar's shared `spinning` state.
4. One card per phone:

```tsx
<div className="relative rounded-card border border-border-2 px-[13px] pt-3 pb-[13px]">
  <p className="text-row font-semibold text-text">{d.label ?? d.stableId}</p>
  <p className="mt-0.5 font-mono text-meta text-dim">{d.serial}</p>
  <p className="mt-1 text-meta text-faint">
    {d.androidVersion ? `Android ${d.androidVersion} · ` : ''}waiting since {relativeTime(d.firstSeen)}
  </p>
  <button type="button" onClick={() => dismiss(d)} aria-label="Dismiss" className="absolute top-2 right-2 text-faint hover:text-text">
    <XIcon className="size-4" aria-hidden />
  </button>
  <div className="mt-2 flex justify-end">
    {added.has(d.stableId) ? (
      <span className="rounded-button bg-accent-soft px-[13px] py-2 text-body text-accent">Added</span>
    ) : (
      <Button variant="outline" size="default" onClick={() => add(d)}>Add to farm</Button>
    )}
  </div>
</div>
```

   `Button variant="outline"` is plan 204's `border border-border-2 bg-muted text-text`, which is the handoff's own `background: var(--muted)`, `border: 1px solid var(--border-2)`; `size="default"` is `h-[34px] px-[13px]`, which is its `padding: 8px 13px` at 13 px text.
5. Empty state, verbatim: `Nothing waiting — every phone adb can see is already on the farm.`

Behaviour:

- `add` is `POST /api/devices/discovered/${encodeURIComponent(stableId)}/admit` with **no body**. The route already treats a bodyless call as "admit with the probed label" (`packages/core/src/api/devices.ts:461`, `const body = AdmitDeviceBodySchema.parse(await c.req.json().catch(() => ({})))`), which is exactly the handoff's one-button card. The label, group and labelling choices the deleted `AdmitDeviceDialog` collected are all editable afterwards, and the handoff draws none of them.
- `dismiss` is `DELETE /api/devices/discovered/${encodeURIComponent(stableId)}`.
- `added` is local component state (the handoff's `discAdded`), so the button becomes a non-interactive `Added` chip for the rest of the session even though the row also disappears from the next `device.discovered` snapshot.
- The pill's count is `discovered.filter((d) => !added.has(d.stableId)).length`, computed in `DevicesScreen` and passed to both the toolbar and the sheet, so the two can never disagree.

### 4.14 `useDevices.ts` and `useQueuedJobs.ts` (new)

`useDevices` replaces the old screen's `load()` plus ten WS branches with one seed and five pushes. Nothing else on this screen fetches a device.

```ts
export interface DevicesState {
  devices: DeviceInfo[] | null
  groups: GroupInfo[]
  discovered: DiscoveredDeviceInfo[]
  error: string | null
  /** For the discovery sheet and the group strip after a mutation. */
  reload: () => void
}
export declare function useDevices(): DevicesState
```

Rules:

1. **Seed, exactly three requests, at mount and on `ws.onReconnected` and nowhere else**: `fetchDevices()` (`packages/studio/src/lib/api.ts:107`), `fetchAllPages<GroupInfo>('/api/groups')`, `fetchDiscoveredDevices()`. Each has its own `.catch`; a failed read leaves that slice where it was.
2. **Pushes**, merged in place, never triggering a refetch:
   - `device.added`: append `payload` and drop any discovered row with the same `stableId`.
   - `device.removed`: drop by `payload.id`.
   - `device.status`: patch `status` (and `quarantineReason` when the payload carries it) on the matching id.
   - `device.activity`: `applyActivityEvent(device, payload)` from plan 205's `packages/studio/src/lib/activity.ts`.
   - `device.battery`: patch `battery`.
   - `device.metrics`: patch `metrics`.
   - `device.discovered`: `reload()`'s discovered third only, because that payload carries no `firstSeen` (the same reason `app/page.tsx:549-553` gives today).
3. `reload()` re-runs the three seed reads; it is called by the group menu after a create, rename or delete, and by the discovery sheet after an admit. It is never called from a timer and never from `job.status`.
4. No `as`-cast anywhere: `fetchDevices` returns `DeviceInfo[]` already, `/api/groups` goes through `fetchAllPages` with `GroupInfoSchema`, discovered goes through `DiscoveredDevicesResponseSchema` (§4.2).

`useQueuedJobs` (§3.8):

```ts
/** deviceId -> how many queued jobs it has. Seeded once, then follows `job.status`. */
export declare function useQueuedJobs(): { queuedFor: (deviceId: string) => number }
```

Seed: `api('/api/jobs?status=queued&limit=500', z.object({ items: z.array(JobInfoSchema) }))`, building `Map<jobId, deviceId>`. On `job.status`: `payload.status === 'queued'` sets `jobId -> deviceId`, anything else deletes `jobId`. Reseed on `ws.onReconnected`. The bounded drift, stated in the file's own comment: a job queued before mount that is cancelled without ever running is only forgotten on the next reconnect, exactly as plan 213 §4.3 rule 5 describes for the status bar, and the repair is the same.

### 4.15 One export added to plan 213's `lib/overlays.ts`

```ts
/**
 * Whether any overlay of this tier is registered. Read by the Devices screen
 * so Ctrl/Cmd+A can be "ignored while Device Control is open" (design
 * handoff, Selection) without this screen knowing that Device Control exists:
 * plan 215's window registers at tier `window` and the suspension starts
 * working with no edit here or there.
 */
export declare function hasOverlay(tier: OverlayTier): boolean
```

This is the only edit this plan makes to a plan 213 file, and it adds a read to the registry that file already maintains.

### 4.16 `scripts/check-routes.ts`, pruned

Two edits to plan 213 §4.10's `PENDING_REMOVAL`:

- Delete the `/groups` row entirely (`'/groups': 'plan 214: groups are managed from the Devices tab strip; no dedicated page (MVP 15 §0.1.3)'`). The route is deleted by this plan, and the script fails on a listed route that no longer exists, so leaving it would break the build.
- Re-word the `/nodes` row's owner, because this plan does not build a Nodes tab and no wave-3 plan does: `'/nodes': 'post-MVP: cloud mode lands after the MVP (MVP 16 §1), so the Nodes tab MVP 03 §1.1 sketches has no owner in waves 3 to 5; plan 224 deletes the route with the packaging pass unless a cloud plan claims it first'`. §9 Q4 asks the CTO to confirm.

After both edits the script prints `routes ok: 6 in nav, 10 exempt` (five `NAV` entries plus `SETTINGS_HREF`; two `NOT_IN_NAV_BY_DESIGN`, seven `PENDING_REMOVAL`, one `DEFERRED`).

### 4.17 `app/page.tsx` after this plan

```tsx
'use client'

import { Suspense } from 'react'
import { LoadingRows } from '@enkaku/ui'
import { DevicesScreen } from '@/components/devices/DevicesScreen'

/**
 * The landing page (MVP 03 §1.2: "the landing page stays Devices"). Every
 * piece of state, every fetch and every gesture lives in
 * `components/devices/`; this file exists only to satisfy Next's route
 * convention and to supply the `<Suspense>` boundary a static export needs
 * before it will prerender a `useSearchParams()` caller (the same boundary
 * the 1929 line version it replaces used at its own `:1923-1928`).
 */
export default function DevicesPage() {
  return (
    <Suspense fallback={<div className="p-[14px]"><LoadingRows rows={6} /></div>}>
      <DevicesScreen />
    </Suspense>
  )
}
```

`DevicesScreen` owns: `useDevices`, `useQueuedJobs`, `useDeviceSelection`, the `?view` and `?group` query parameters, `query`, `filter`, `cardWidth`, the discovery sheet's open state, and the `filtered` memo. It renders, in order, `<DevicesToolbar>`, then `<DeviceTable>` or `<ScreensGrid>`, then `<BulkPill>` when the selection is non-empty, then `<DiscoverySheet>`, then `<EnrollmentDialog>` (§8: kept, undrawn by the handoff, because it is the only surface that tells an operator a phone is waiting for its adb prompt), then the marquee overlay rectangle.

## 5. Implementation steps

Read every file before editing it and match on the quoted content, not on the line number (plan 200 §2.2). Steps 214.1 to 214.3 are backend and may be done in any order; 214.4 onward depend on 214.1.

### 214.1 Protocol: metrics, model, discovered

- Files created: none.
- Files changed: `packages/protocol/src/device.ts` (§4.2: `DeviceMetricsSchema`, `DeviceMetricsMessage`, and the two new `DeviceInfoSchema` fields inserted after `number` at `:296`), `packages/protocol/src/api/devices.ts` (§4.2: `DiscoveredDeviceSchema`, `DiscoveredDevicesResponseSchema`), `packages/protocol/src/index.ts` (add `DeviceMetricsMessage` to `ServerMessageSchema` beside `DeviceBatteryMessage`).
- Files deleted: none.
- Test file: `packages/protocol/src/device.test.ts` (protocol Zod schemas are on plan 200 §8.3's critical list). Add one `describe('DeviceMetricsSchema')`: every field nullable, `cpuPercent` rejects 101 and -1, `updatedAt` must be an integer, `DeviceMetricsMessage` round-trips; and extend the `DeviceInfoSchema` describe with `model` and `metrics` defaulting to `null` when absent.
- Verifiable result: `bun test packages/protocol/src/device.test.ts` passes; `bun run typecheck` clean.
- Do not: persist metrics in a column, add a `metrics` field to any Drizzle table, or make any field non-nullable. A phone that refuses one `/proc` read must still report the other three.

### 214.2 Core: the `model` column and its migration

- Files created: `packages/core/drizzle/NNNN_device_model.sql` (generated).
- Files changed: `packages/core/src/db/schema.ts` (§4.3), `packages/core/src/registry/device-registry.ts` (the two `model: probe.model ?? null,` lines and `model: row.model ?? null,` in `rowToDeviceInfo`).
- Files deleted: none.
- Test file: none. This is one nullable column with no backfill; plan 200 §8.3 puts a migration test on the critical list only when it rewrites rows, and this one rewrites none.
- Verifiable result: `bun run --cwd packages/core db:generate` produces exactly one `ALTER TABLE \`devices\` ADD \`model\` text;` statement and one journal entry; `bun run typecheck` clean; `rg -n "model: probe.model" packages/core/src/registry/device-registry.ts` prints exactly two lines.
- Do not: hand-write the migration. Do not backfill `model` from `label`: a renamed device's label is not its model, and writing one into the other is how the two stop meaning different things.

### 214.3 Core: the metrics sampler

- Files created: `packages/core/src/device/metrics.ts` (§4.3).
- Files changed: `packages/core/src/device/battery.ts` (the `onMetrics` dep, the two maps, the extra `exec` inside `pollDevice`'s existing `try`, the `metricsOf` return member), `packages/core/src/registry/device-registry.ts` (`rowToDeviceInfo`'s new trailing `metrics` parameter), `packages/core/src/api/devices.ts` (`metricsOf` dep threaded into `infoWithTags`), `packages/core/src/daemon.ts:4266-4275` (the `onMetrics` broadcast and the `metricsOf` dep).
- Files deleted: none.
- Test file: none. `parseDeviceMetrics` is a text parser and plan 200 §8.3's critical list does not cover it; its output shape is already pinned by `DeviceMetricsSchema`'s test in 214.1, and its arithmetic is verified by the owner smoke (§7.3 step 14) against `adb shell top` on a real phone. Recorded as a deliberate gap, not an oversight.
- Verifiable result: `bun run typecheck` clean; `rg -n "METRICS_PROBE" packages/core/src` prints exactly two lines (`device/metrics.ts` and `device/battery.ts`); `rg -n "setInterval" packages/core/src/device/metrics.ts` prints nothing.
- Do not: add a second timer. Do not use `top`: it blocks on the phone for its own sampling interval, and two `/proc/stat` reads a minute apart answer the same question for nothing. Do not let a parse failure throw: `pollDevice`'s `catch` would then swallow the battery reading too.

### 214.4 The moved live-set and the moved quarantine helper

- Files created: `packages/studio/src/lib/quarantine.ts` (`explainQuarantine`, moved verbatim from `components/DeviceCard.tsx:454` with its doc comment).
- Files changed: `packages/studio/src/components/wall/Wall.tsx:9` (`import { useLiveSet } from './useLiveSet'` becomes `from '@/components/devices/useLiveSet'`), `packages/studio/src/components/wall/WallTile.tsx:11` (`import { explainQuarantine } from '@/components/DeviceCard'` becomes `from '@/lib/quarantine'`).
- Files moved: `git mv packages/studio/src/components/wall/useLiveSet.ts packages/studio/src/components/devices/useLiveSet.ts`, then the two edits of §3.9 (drop `'asleep'` from `BlockedReason` and its eligibility branch; delete the `hot` rank tier at `:111` and renumber the comment block at `:93-107`), then reword every comment in the moved file that says "the Wall" or "`Wall.tsx`" to name the Screens grid and, where it still means the plugin picker, "the picker's grid" (plan 200 §2.4: `wall` survives only as the video profile name in code, and this file is now under `components/devices/`, which `GREP_214_VOCAB` covers). The three occurrences to reword are its module comment at `:7`, the `useLiveSet` doc comment at `:216-220`, and the `maxTiles` note at `:34-38`.
- Files deleted: none.
- Test file: none (Studio has zero tests, plan 200 §8.3; `useLiveSet.test.ts` was deleted by plan 201).
- Verifiable result: `bun run typecheck` clean; `rg -n "'asleep'" packages/studio/src/components/devices/useLiveSet.ts` prints nothing; `rg -n "components/wall/useLiveSet" packages/studio/src` prints nothing.
- Do not: copy the file. Two live-set policies would drift, and the plugin picker that still renders `Wall` deserves the same fix.

### 214.5 The data hooks

- Files created: `packages/studio/src/components/devices/useDevices.ts` (§4.14), `useQueuedJobs.ts` (§4.14), `device-state.ts` (§4.5).
- Files changed: `packages/studio/src/lib/api.ts` (`fetchDiscoveredDevices` parses through `DiscoveredDevicesResponseSchema`; the local `DiscoveredDevice` interface at `:191-201` is deleted and `DiscoveredDeviceInfo` is re-exported from `@enkaku/protocol`), `packages/studio/src/lib/overlays.ts` (§4.15, add `hasOverlay`).
- Files deleted: none.
- Test file: none.
- Verifiable result: `bun run typecheck` clean; §10.3 `GREP_214_POLL` prints nothing; `rg -n "as \{ discovered" packages/studio/src/lib/api.ts` prints nothing.
- Do not: add a `setInterval`, or refetch the device list on `job.status`. Do not derive the running task from `job.status`; it comes from the activity list, which is what makes it exact.

### 214.6 The toolbar and the group strip

- Files created: `packages/studio/src/components/devices/DevicesToolbar.tsx` (§4.6), `GroupTabs.tsx` (§4.7).
- Files changed: none.
- Files deleted: none.
- Test file: none.
- Verifiable result: `bun run typecheck` clean; §10.3 `GREP_214_COLOUR` prints nothing.
- Do not: build a sixth filter, a sort control, a group-by control, or a page-size control. Do not put group CRUD anywhere but this file (G7).

### 214.7 The table

- Files created: `packages/studio/src/components/devices/DeviceTable.tsx` (§4.8), `TaskCell.tsx` (§4.9).
- Files changed: none.
- Files deleted: none.
- Test file: none.
- Verifiable result: `bun run typecheck` clean; G3's two greps.
- Do not: add a per-row actions column, a progress bar in Batt, or a `<table>` element. Do not virtualise the rows (§4.8 states the trigger for revisiting it).

### 214.8 The Screens grid

- Files created: `packages/studio/src/components/devices/ScreensGrid.tsx`, `DeviceScreenCard.tsx` (§4.10).
- Files changed: none.
- Files deleted: none.
- Test file: none.
- Verifiable result: `bun run typecheck` clean; `rg -n "aspect-\[9/19.5\]" packages/studio/src/components/devices/DeviceScreenCard.tsx` prints one line.
- Do not: put a checkbox on a card (the card is the target), a percentage anywhere on it, or a build-phase panel: plan 206 removed the phase list and `LiveView` handles `E_SESSION_PREPARING` itself.

### 214.9 Selection, the bulk pill and the action set

- Files created: `packages/studio/src/components/devices/useDeviceSelection.ts` (§4.11), `action-set.ts`, `ActionMenu.tsx`, `BulkPill.tsx` (§4.12).
- Files changed: none.
- Files deleted: none.
- Test file: none.
- Verifiable result: `bun run typecheck` clean; `rg -n "GENERIC_ACTION_SET" packages/studio/src` prints exactly the definition and its importers.
- Do not: add an Escape listener (plan 213's `lib/overlays.ts` owns it). Do not build any of the six dialogs plan 216 owns; render their rows disabled with the stated title. Do not clear the selection on a plain mousedown before the 5 px threshold.

### 214.10 The discovery sheet

- Files created: `packages/studio/src/components/devices/DiscoverySheet.tsx` (§4.13).
- Files changed: none.
- Files deleted: none.
- Test file: none.
- Verifiable result: `bun run typecheck` clean; the three route strings appear in the file (G8).
- Do not: collect a label, a group or a labelling choice on admit; the handoff's card is one button, and all three are editable afterwards. Do not present a dismissal as a block.

### 214.11 The screen, the page, and the deletions

- Files created: `packages/studio/src/components/devices/DevicesScreen.tsx` (§4.17).
- Files changed: `packages/studio/src/app/page.tsx` (rewritten as §4.17), `packages/studio/src/lib/prefs.ts` (delete `tileSize` at `:73`, `pageSize` at `:115-118`, `TILE_SIZE_PX` at `:125`, `PAGE_SIZE_OPTIONS` at `:128`, and `SessionPrefsSchema.view` at `:33`; add `cardWidth: z.enum(['s', 'm', 'l', 'xl']).default('m')` to `LocalPrefsSchema` and `devicesView: z.enum(['table', 'screens']).optional()` to `SessionPrefsSchema`; rewrite the module comment's `view` paragraph to name the new values), `scripts/check-routes.ts` (§4.16).
- Files deleted: `packages/studio/src/components/DeviceCard.tsx`, `packages/studio/src/components/DiscoveredTray.tsx`, `packages/studio/src/components/AdmitDeviceDialog.tsx`, `packages/studio/src/components/device/ScanNetworkDialog.tsx`, `packages/studio/src/components/wall/useDragSelect.ts`, `packages/studio/src/components/wall/SelectionCursorBadge.tsx`, `packages/studio/src/components/wall/DeviceContextMenu.tsx`, `packages/studio/src/hooks/use-bulk-selection.ts`, `packages/studio/src/app/groups/`, `packages/studio/src/components/GroupEditorDialog.tsx`, `packages/studio/src/components/GroupMembersDialog.tsx`.
- Test file: none.
- Verifiable result: `bun run typecheck` clean; `bun run scripts/check-routes.ts` prints `routes ok: 6 in nav, 10 exempt`; §10.3 `GREP_214_OLD` prints nothing; `wc -l < packages/studio/src/app/page.tsx` is under 220.
- Do not: delete `components/bulk/`, `components/wall/{Wall,WallTile,TileGrid,TileSkeleton,tile-identity}`, `components/host/DeviceWallWithPicker.tsx`, `lib/operations.ts`, `components/EnrollmentDialog.tsx`, `components/layout/PageHeader.tsx`, or any of the six `Bulk*Dialog` files. Each has a live importer outside this plan (§3.5, §3.6, §2). Do not add a `/groups` redirect page.

### 214.12 Final verification

- Commands, one at a time, never concurrently: `bun run typecheck`; `bun test packages/protocol/src/device.test.ts`; `bun run scripts/check-design-tokens.ts`; `bun run scripts/check-routes.ts`; every §10.3 grep; `git diff --stat mvp -- plugins packages/core/packs` (expected empty); `ps -Ao pid=,command= | grep -i "[o]penpf"` prints nothing but your shell.
- Run the owner smoke (§7.3) if the owner is available; otherwise leave G2, G5, G6 and the metric half of G9 as `owner` and say so in §11.
- Update the `> Status:` line and write §11; `bash scripts/check-plan-status.sh` passes.

## 6. Acceptance criteria

1. G1, G3, G4, G7 to G17 checked; G2, G5, G6 checked or recorded as `owner` with the outstanding smoke step named.
2. `bun run typecheck` prints `OK` for every package.
3. `bun test packages/protocol/src/device.test.ts` passes, and it is the only `bun test` this plan runs.
4. `bun run scripts/check-routes.ts` prints `routes ok: 6 in nav, 10 exempt`; `bun run scripts/check-design-tokens.ts` prints `design tokens ok`.
5. Every §10.3 grep prints exactly what its row says.
6. `git diff --stat mvp -- plugins packages/core/packs` is empty.
7. `git diff --stat mvp -- packages/studio/src` lists only: the fifteen new `components/devices/` files, `lib/quarantine.ts`, the edits to `app/page.tsx`, `lib/api.ts`, `lib/prefs.ts`, `lib/overlays.ts`, `components/wall/Wall.tsx`, `components/wall/WallTile.tsx`, and the eleven deletions of step 214.11.
8. Opening `/` on a farm with no devices shows the toolbar, the All tab reading `0`, and an empty state; opening it with devices shows the table by default with no request after the three seeds.

## 7. Test plan

Studio has zero tests and none is written here (plan 200 §8.3). Backend verification is one protocol test; UI verification is a typecheck, two scripts, and one itemised owner smoke.

### 7.1 Commands

```bash
bun run typecheck
bun test packages/protocol/src/device.test.ts
bun run scripts/check-design-tokens.ts
bun run scripts/check-routes.ts
```

Never a bare `bun test`, never `bun run --cwd packages/studio test`. No other backend module's behaviour changes, so no other test file is in scope; if a change turns out to require one, that is a discrepancy for §11, not a reason to run a suite.

### 7.2 The route script proves itself

```bash
bun run scripts/check-routes.ts; echo "exit=$?"     # expected: routes ok: 6 in nav, 10 exempt, exit=0
mkdir -p packages/studio/src/app/groups && printf 'export default function G() { return null }\n' > packages/studio/src/app/groups/page.tsx
bun run scripts/check-routes.ts; echo "exit=$?"     # expected: a line naming /groups as an orphan, exit=1
rm -rf packages/studio/src/app/groups
```

### 7.3 Owner smoke, numbered, with the handoff open

```bash
bun run dev            # core on :7700, one terminal
bun run dev:studio     # :3001, another terminal
```

Open `http://localhost:3001` beside `docs/mvp/design_handoff_enkaku_openpf/README.md` lines 78 to 226. Steps 12 and 14 need the owner's farm; the rest need one device.

1. **Frame.** The screen sits inside plan 213's page panel: no page title, no banner, no floating tray.
2. **Toolbar.** DevTools on the toolbar root: computed `height` 58 px, `padding` `0 12px`, a 1 px bottom border in `--line`, `gap` 10 px.
3. **Group tabs.** The pill container is `--muted` at `border-radius: 999px` with `padding: 4px` and `gap: 4px`, and shrinks to its content. Each tab is `padding: 7px 14px` at 12.5 px; the active one is `--panel` with `box-shadow: 0 1px 3px #00000014` and weight 600; the rest are `--dim`. Each count is 11 px `--faint` with `margin-left: 7px`. The first tab is All.
4. **Add group.** The dashed circle is 30 x 30 with a 1 px dashed `--border-3` border and a 14 px plus, and turns accent on hover. Click it: a 224 px popover, right-aligned, 40 px below the toolbar top, titled "New group". Type `Farm D`, press Enter: a tab appears reading `FARM-D`. Reopen it, type a name, press Escape: it closes and creates nothing.
5. **Group menu.** Right-click `FARM-D`: a 188 px dropdown at that tab's x offset with Rename group and Delete group, the second in `--danger`. Rename opens the same popover pre-filled. Delete removes the tab; if it was active the strip falls back to All and every device is listed again.
6. **Move group.** Select two devices, open the bulk pill, choose Move group, pick `FARM-D`: both rows' group changes and the tab's count goes to 2. Choose No group: it goes back to 0.
7. **Discovered.** With a phone adb can see but the farm does not own, the pill reads `Discovered (1)` at `padding: 7px 13px` on `--panel-2` with a 1 px `--border-2` border and a 999 px radius.
8. **Icon buttons.** The four are 32 x 32 at a 10 px radius, `--faint` idle, `--muted-2` on hover, and `--accent-soft`/`--accent` while their menu is open. Search opens a 300 px popover whose input placeholder is exactly `serial, label, model, task` and whose match count changes as you type. Filter opens a 216 px menu with five rows, each carrying a dot, a count, and a check on the active one. View opens a 200 px menu with Table and Screens, and with Screens active it also shows Card width with S, M, L, XL. Rescan spins for about 1.4 s.
9. **Table.** DevTools on the header row: `height` 38 px, `background` `--panel-2`, labels 11 px `--faint`; the computed `grid-template-columns` is `38px 44px 1.3fr 108px 92px 138px 70px 74px 62px 62px 62px 76px 1.1fr` and the scroller's inner width is at least 1324 px. A row is 54 px with a 1 px `--muted-2` bottom border and turns `--hover` on hover. The `#` is zero-padded mono 11.5 px in `--faint` and follows the filtered order. The Device cell is an 8 px dot, a 13 px medium name, and an 11 px `--faint` model beneath. Serial and Endpoint are Geist Mono 12 px. Batt shows a value with no bar, red under 20, amber under 45, accent above. Temp is red above 42. There is no actions column.
10. **Selected and disconnected rows.** Tick a checkbox: the row is `--accent-soft` with `inset 2px 0 0 var(--accent)`. Unplug a device: its row drops to `opacity: 0.6` and every metric cell reads an em dash.
11. **Discovery sheet.** Click the pill: a scrim in `--scrim` and a 452 px panel sliding from the right, titled Discovered at 16 px/600, with the body copy verbatim, the Rescan row above the divider, and one card per phone carrying the model, the mono endpoint, the "Android N · waiting since Nd ago" line, an X top-right and Add to farm bottom-right. Press Add to farm: the button becomes a non-interactive Added chip in `--accent-soft`/`--accent`, the pill's count drops by one, and the phone appears in the table. Dismiss another: it leaves the sheet, and unplugging and replugging brings it back.
12. **Screens and 60 fps (G5).** Switch to Screens on a farm of 100 devices. Every card is 6 px padded with a 16 px radius and a 1 px `--line-2` border; the screen box is 9:19.5 at a 12 px radius; a live device shows the cast, a disconnected one shows the 135 degree stripes at 0.7 opacity with the centre text "Disconnected"; the top gradient carries the name at 12 px/500 over the mono 10 px serial; the bottom-left dot is 9 px with a 3 px `--panel-a` ring and its hover tooltip names the reason. No percentage appears on any card. Then: open the network tab, leave the page untouched for 120 s, and confirm no request fires. Record a 5 s Performance profile while scrolling the table with 100 rows and confirm no frame exceeds 16.7 ms.
13. **Selection (G6).** a) Click a row once: it selects after about 200 ms. b) Double-click it: nothing stays selected and Device Control does not open yet (plan 215). c) Press and drag from empty space by 3 px and release: nothing is selected and nothing is cleared. d) Drag by more than 5 px across four rows: a 1 px accent rectangle with a 6 px radius covers them and all four select; hold Shift and drag over two more: six are selected. e) Press Ctrl/Cmd+A: every filtered row selects; click into the search box and press it again: the browser selects the text instead. f) Press Escape with the filter menu open: the menu closes and the selection stays; press it again: the selection clears.
14. **Metrics (G9).** On a live device, CPU, Mem, Disk and Uptime show numbers within one `battery.pollIntervalSec`. Compare against `adb -s <serial> shell top -n 1 -b | head -5`, `adb -s <serial> shell cat /proc/meminfo | head -3`, `adb -s <serial> shell df /data` and `adb -s <serial> shell cat /proc/uptime`: each column is within a rounding step of the device's own answer. Unplug it: all four become em dashes, and the row does not keep the last number.
15. **Bulk pill.** Select three devices: a 40 px accent pill reading `3 selected` with a caret and a `0 10px 24px var(--accent-a3)` shadow appears at the panel's bottom-right, with a 40 x 40 circular X beside it that turns danger on hover. Click the pill: a 226 px menu opens above it, headed "Bulk action" with a Clear on the right, listing exactly twelve rows in the handoff's order, each `padding: 9px 10px` at a 10 px radius and 13 px, hovering to `--muted`, with Forget in `--danger`. Six rows are live and six read `Opens a dialog (plan 216)` and do not respond.
16. **Actions.** Run Screenshot on the selection: a toast names how many succeeded. Run Sleep: the phones' screens go off. Run Reconnect on a device that has dropped: it comes back. Run Forget on one: a confirmation appears first, and after it the device leaves the table and reappears in Discovered when it next connects.

Stop both processes; `ps -Ao pid=,command= | grep -i "[o]penpf"` prints nothing.

Device-gated tests: none in this plan. Steps 14 and 16 need a physical device and are the owner's.

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Six of the twelve action rows are inert until plan 216 | Stated visibly on the row itself, not silently (§3.10); bounded to one stage of plan 200 §8's schedule; no code is added that 216 must remove. |
| The metrics probe costs one more adb round trip per device per minute | One `exec` per device per cycle inside the poll that already runs, under the same bounded concurrency of 8 (`battery.ts:120-130`) and the same `battery` profile timeout. Measured at the wave gate against the 100 device scale run (plan 223). If it costs too much, `pollIntervalSec` is already the knob. |
| `parseDeviceMetrics` has no test | Deliberate (plan 200 §8.3 does not cover a text parser); its output shape is pinned by the protocol test and its arithmetic by §7.3 step 14 against the phone's own `top`, `df` and `/proc/uptime`. Recorded in §11 as a known gap. |
| The handoff's "Unauthorized" is the MVP's `quarantined` | §3.2 item 3 states the mapping in one place (`device-state.ts`); §9 Q2 puts the word to the CEO. The colour is the handoff's either way. |
| 100 unvirtualised rows are slow | Measured, not assumed: §7.3 step 12 profiles it. §4.8 names the trigger for revisiting (400 devices) so the decision is dated rather than permanent. |
| `components/wall/` is kept and looks like dead code | §3.5 names the live consumer with `path:line` and §10.2 names the owner. `GREP_214_OLD` proves the three files that did go are gone. |
| The queued task chip drifts | Bounded to jobs queued before mount that are cancelled without running, repaired on every reconnect, stated in the file comment; the same bound and repair plan 213 §4.3 rule 5 accepted for the status bar. |
| `EnrollmentDialog` survives undrawn by the handoff | Kept deliberately (§4.17): it is the only surface that tells an operator a phone is waiting for its adb authorisation prompt, and the handoff drew no replacement. §9 Q5 asks where it should live. |
| The subnet sweep loses its Devices entry point with `ScanNetworkDialog` | It keeps one: `components/settings/FarmNetworksEditor.tsx:6` imports `useNetworkScan` from `lib/network-scan.ts:35`, which posts `/api/devices/scan`, and that editor lives on the Settings page plan 219 rebuilds. The handoff's Rescan is `/api/devices/rescan` ("checks adb directly"), a different act, and both survive. |

## 9. Open questions

1. **Q1, sorting.** The handoff draws no sort control and the table's `#` is explicitly "system row number … follows the filtered order". The old screen had none either. A 100 device farm may want to sort by battery or uptime. Adding one changes what `#` means. Decider: CEO. This plan ships no sort; nothing in it blocks on the answer.
2. **Q2, the word for the amber state.** The handoff writes "Unauthorized" in the filter menu and the card's centre text; the MVP's stored status is `quarantined` and there is no unauthorized device state (plan 205 §4.1). This plan writes "Quarantined" (§3.2 item 3). If the CEO prefers the handoff's word, it is one constant in `device-state.ts` and two strings; the colour does not move. Decider: CEO.
3. **Q3, the dot tooltip.** The handoff specifies a dark tooltip with `--tooltip-bg`/`--tooltip-fg`, a 8 px radius and 10 px text. This plan uses the native `title` attribute carrying the identical sentence, because a Radix tooltip per card is a per-device cost on a 100 card grid (`docs/design.md`'s rule about anything that scales with device count). Is the styled tooltip worth one Radix instance per visible card, or is the native one acceptable? Decider: CEO.
4. **Q4, who owns `/nodes`.** MVP 03 §1.1 sketches a Nodes tab on Devices "shown only when the core runs as orchestrator"; MVP 16 §1 puts cloud mode after the MVP, so no wave-3 plan builds it. This plan re-points the `PENDING_REMOVAL` row at plan 224 (§4.16). Confirm, or name a different owner. Decider: CTO.
5. **Q5, `EnrollmentDialog`.** The handoff draws no surface for a phone whose adb authorisation prompt has not been accepted, and `device.unauthorized` is a real broadcast the reconciler repeats. This plan keeps the existing dialog mounted on the Devices screen. Should it instead become a card in the discovery sheet, or a status-bar alert? Decider: CEO.
6. **Q6, live cast at every card width.** `docs/mvp/15-ui-migration.md` §4.3: "Whether the Screens view's live cast is the wall encoder from MVP 11 at every card width, or a still for the S preset (proposed: live at every width; the live-set gating already limits decoding to visible cards)." This plan ships the proposal, live at every width, because `useLiveSet`'s budget already caps concurrent decodes independently of card size. Decider: CEO; changing it is one condition in `ScreensGrid`.

## 10. Removed

### 10.1 Removed by this plan

| What | Where it was | Proof |
|---|---|---|
| The 1929 line fleet screen: `PILL`, `View`/`GroupBy`, `STATUS_ORDER`, `STATUS_LABEL`, the seven filters, the pagination, the twelve-button selection bar, the ten WS branches | `packages/studio/src/app/page.tsx` | `test "$(wc -l < packages/studio/src/app/page.tsx)" -lt 220` exits 0 |
| `DeviceCard` | `packages/studio/src/components/DeviceCard.tsx` (462 lines) | `test ! -e packages/studio/src/components/DeviceCard.tsx` exits 0 |
| The discovered tray and the admission wizard | `packages/studio/src/components/DiscoveredTray.tsx`, `AdmitDeviceDialog.tsx` | `test ! -e packages/studio/src/components/DiscoveredTray.tsx && test ! -e packages/studio/src/components/AdmitDeviceDialog.tsx` exits 0 |
| The subnet scan modal on Devices | `packages/studio/src/components/device/ScanNetworkDialog.tsx` | `test ! -e packages/studio/src/components/device/ScanNetworkDialog.tsx` exits 0 |
| The old drag-select hook, the cursor badge, and the device right-click menu | `packages/studio/src/components/wall/useDragSelect.ts`, `SelectionCursorBadge.tsx`, `DeviceContextMenu.tsx` | §10.3 `GREP_214_OLD` prints nothing |
| The bulk-selection hook | `packages/studio/src/hooks/use-bulk-selection.ts` | `test ! -e packages/studio/src/hooks/use-bulk-selection.ts` exits 0 |
| The `/groups` route and its two dialogs (`docs/mvp/13` A.6; `docs/mvp/15` §0.1 item 3) | `packages/studio/src/app/groups/`, `components/GroupEditorDialog.tsx`, `GroupMembersDialog.tsx` | `test ! -e packages/studio/src/app/groups && test ! -e packages/studio/src/components/GroupEditorDialog.tsx && test ! -e packages/studio/src/components/GroupMembersDialog.tsx` exits 0 |
| The `/groups` row of `PENDING_REMOVAL` | `scripts/check-routes.ts` | `rg -n "'/groups'" scripts/check-routes.ts` prints nothing; `bun run scripts/check-routes.ts` prints `routes ok: 6 in nav, 10 exempt` |
| The tile-size and page-size preferences and the `list`/`wall` session view | `packages/studio/src/lib/prefs.ts:33`, `:73`, `:115-118`, `:125`, `:128` | `rg -n "tileSize\|pageSize\|TILE_SIZE_PX\|PAGE_SIZE_OPTIONS" packages/studio/src` prints nothing |
| The `as`-cast of the discovered response | `packages/studio/src/lib/api.ts:207` | `rg -n "as \{ discovered" packages/studio/src/lib/api.ts` prints nothing |
| The live-set's `asleep` blocking and `hot` rank tier (false under `docs/mvp/11` §1.2) | `packages/studio/src/components/wall/useLiveSet.ts:57`, `:111` | `rg -n "'asleep'\|readiness.actual === 'hot'" packages/studio/src/components/devices/useLiveSet.ts` prints nothing |
| Forbidden vocabulary (plan 200 §2.4) in this plan's new files | `components/devices/*`, `lib/quarantine.ts` | §10.3 `GREP_214_VOCAB` prints nothing |

### 10.2 Deletions this plan owes to a later one (owners, not proofs)

| What | Last consumer today | Deleted by |
|---|---|---|
| `components/wall/Wall.tsx`, `WallTile.tsx`, `TileGrid.tsx`, `TileSkeleton.tsx`, `tile-identity.ts`, `components/host/DeviceWallWithPicker.tsx`, `components/host/index.ts:29` | `plugins/mikrotik-routing/src/ui/parts/groups.tsx:34` through `@enkaku/host` (§3.5) | plan 216, with the `DevicePicker` |
| `components/bulk/OutcomeSummary.tsx`, `SkippedGroups.tsx`, `use-batch-report.ts` | six dialogs plan 216 owns, plus `lib/labelling.ts` (§3.6) | plan 216 |
| `components/bulk/BatchResults.tsx` | `app/batches/detail/page.tsx:46` | plan 218 |
| `components/EnrollmentDialog.tsx` | this screen (§9 Q5) | plan 216 or 219, once the CEO answers Q5 |
| `packages/studio/src/lib/operations.ts`, `components/operations/*` | the four bulk dialogs plan 213 §3.6 listed | plan 216 |
| `app/nodes/` | `scripts/check-routes.ts`'s `PENDING_REMOVAL` (§4.16, §9 Q4) | plan 224, unless a cloud plan claims it |
| `globals.css`'s `@layer components` block and `theme.css` block D | the screens plans 215 to 220 replace | the last of plans 215 to 220 |

### 10.3 The greps

Fenced, not tabled: a regex alternation cannot carry an unescaped pipe inside a Markdown table cell.

```bash
# GREP_214_OLD: the deleted fleet-screen modules have no reference left
rg -n -e "components/DeviceCard" -e "DiscoveredTray" -e "AdmitDeviceDialog" -e "ScanNetworkDialog" \
      -e "useDragSelect" -e "SelectionCursorBadge" -e "DeviceContextMenu" -e "use-bulk-selection" \
      -e "GroupEditorDialog" -e "GroupMembersDialog" -e "app/groups" packages/studio/src scripts

# GREP_214_POLL: nothing on this screen fetches on a timer (the 1400ms rescan spin schedules no request)
rg -n -e "setInterval\(.*(fetch|api\()" -e "setTimeout\(.*(fetch|api\()" packages/studio/src/components/devices

# GREP_214_COLOUR: no v3 bracket colour form, no `dark:` variant, no hex literal
rg -n -e "\[--color" -e "\bdark:" -e "#[0-9a-fA-F]{3,8}\b" packages/studio/src/components/devices packages/studio/src/lib/quarantine.ts

# GREP_214_DEVICE_STATE: exactly one FILE maps deviceState() onto a StatusDot state.
# Expected output: one path, `packages/studio/src/components/devices/device-state.ts`.
rg -l "deviceState" packages/studio/src/components/devices

# GREP_214_VOCAB: plan 200 §2.4's forbidden words, plus "console" (MVP 15 §0.1.4) and "wall" in new UI code.
# `wall` has ONE allowed use, named by plan 200 §2.4 itself ("`wall` stays as the video profile name in
# code"): `quality="wall"` on the Screens card's `LiveView`, and the two settings whose keys carry the
# word (`wall.rampConcurrency`, `video.maxTiles`'s sibling). The second `rg` removes exactly those and
# nothing else, so any other occurrence still fails. Expected output: nothing.
rg -n -i -e "\blease" -e "\bcluster" -e "\bholder" -e "\bassist" -e "co-control" -e "\bconsole\b" \
      -e "\bwall\b" -e "\bbulk twin" packages/studio/src/components/devices packages/studio/src/lib/quarantine.ts \
  | rg -v -e "quality=\"wall\"" -e "wall\.rampConcurrency" -e "the video profile name"

# GREP_214_METRICS: the metrics probe lives in exactly two core files and nothing polls it from a browser
rg -n "METRICS_PROBE" packages/core/src packages/studio/src
```

## 11. Handoff report

- **Checklist**:
- **Commits**:
- **Typecheck**:
- **Tests run**:
- **Removed, proven**:
- **Discrepancies between plan and code**:
- **Observed, not done**:
- **Open questions hit**:
- **Processes**:
