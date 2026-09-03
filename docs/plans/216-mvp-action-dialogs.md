# Plan 216 — MVP wave 3 : The action dialogs and the DevicePicker

> Status: draft — not started; written 2026-09-03 by the plan author for the MVP series
> Depends on: plan 214 (the Devices screen: `components/devices/DevicesScreen.tsx`, `BulkPill.tsx`, `ActionMenu.tsx`, the generic action set as data, `useDevices`, and the six rows it ships disabled with `title="Opens a dialog (plan 216)"`), plan 207 (the actions API: `POST /api/actions/<verb>`, `ActionRequestSchema`, `ActionResponseSchema`, `packages/studio/src/lib/actions.ts` with `runAction`/`runOnDevice`/`awaitOperation`/`groupResults`), plan 213 (`AppShell`, `lib/overlays.ts`'s `useOverlay`, `[data-menu-root]`, `scripts/check-routes.ts`), plan 215 (Device Control's Actions tab and its `onAction` prop; it deletes `components/device-popup/` and `app/device/`), plan 205 (`DeviceInfo.activities`, `lib/activity.ts`), plan 204 (tokens, primitives, the Phosphor icon barrel), plan 200 (rules and format).
> Spec references: `docs/mvp/07-actions-api.md` §2 in full and §2.1 with its Visual contract (the picker is the first row of every action modal and popup; one component, one hook, one place); `docs/mvp/15-ui-migration.md` §1 (the DevicePicker row applies to the action dialogs the generic set opens, "which the handoff has not drawn yet"), §2 first bullet ("The action dialogs behind the generic set, each with the DevicePicker container (MVP 07 §2.1) as its first row"), §0.1 items 3 and 4 (Groups, no Console), §1 (Union: `screenshot`, `clear-cache`, `move-group` is `set-group`, Label and Prepare in the overflow); `docs/mvp/04-device-activity.md` §1.3 (the `warn`/`forbid` sentences and `force: true`); `docs/mvp/13-removal-register.md` A.5 (every Studio row copied into §10); `docs/mvp/design_handoff_enkaku_openpf/README.md` "Generic action set", "Bulk actions", "Design Tokens" (quoted verbatim in §4.1); `docs/mvp/14-jobs-and-runs.md` §2 ("Run again" is the same verb with `jobId` set).
> Ships: packages/studio/src/components/target/DevicePicker.tsx

---

## 0. Goal checklist

Every command runs from the repo root. `GREP_216_PICKER`, `GREP_216_DIALOGS` and `GREP_216_VOCAB` are defined once in §10.3 and copied verbatim wherever they are cited.

| # | Goal | Parameter | Verified by | Done |
|---|---|---|---|---|
| G1 | Exactly one `DevicePicker` component and one `useTarget` hook exist in the workspace | 1 file defines each | §10.3 `GREP_216_PICKER` prints exactly `packages/studio/src/components/target/DevicePicker.tsx` and `packages/studio/src/components/target/useTarget.ts`, nothing else | [ ] |
| G2 | Every action dialog renders the picker as its first child, in one shell | `ActionDialog.tsx` is the only file that renders `<DevicePicker`; every verb dialog goes through it | `rg -l "<DevicePicker" packages/studio/src` prints exactly `packages/studio/src/components/actions/ActionDialog.tsx` and `packages/studio/src/components/host/DevicePickerDialog.tsx` | [ ] |
| G3 | The picker container is visually separate from the form and identical in every dialog | picker `bg-panel-2` + `border-b border-line`; form `bg-panel`, no border; collapsed picker container height **54 px** (34 px row + 2 x 10 px padding) | owner smoke §7.3 step 4, itemised per dialog | owner |
| G4 | All fifteen verb dialogs exist and each names exactly one plan-207 verb | 15 entries in `VERB_DIALOGS`, keys a subset of `ACTION_VERBS` | `bun run typecheck` clean (the registry is typed `Record<ActionDialogVerb, VerbDialogSpec<never>>`); `rg -c "verb: '" packages/studio/src/components/actions/verb-dialogs.tsx` prints `15` | [ ] |
| G5 | A `warned` device renders its policy sentence on its own chip and `Continue for N devices` re-sends with `force: true` | the second request body carries `"force":true` | owner smoke §7.3 step 6 | owner |
| G6 | A target on which every device is `forbidden` disables the primary button | button `disabled`, label unchanged | owner smoke §7.3 step 7 | owner |
| G7 | No dialog opens another dialog to pick devices | 0 nested `Dialog` inside a verb dialog | `rg -n "<Dialog" packages/studio/src/components/actions` prints only the lines inside `ActionDialog.tsx` | [ ] |
| G8 | The twelve old action dialogs are deleted | 12 files absent | §10.3 `GREP_216_DIALOGS` prints nothing; the twelve `test ! -e` rows of §10.1 all exit 0 | [ ] |
| G9 | Both old target pickers, `target-preview.ts`, `useTargetSelection.ts`, `lib/operations.ts`, `components/bulk/*` and the five wall files are gone | 0 matches | §10.3 `GREP_216_PICKER` and the `test ! -e` / `test ! -d` rows of §10.1 all exit 0 | [ ] |
| G10 | `scripts/check-routes.ts` has no stale exemption and passes | `/schedules` row pruned | `rg -n "'/schedules'" scripts/check-routes.ts` prints nothing; `bun run scripts/check-routes.ts` exits 0 | [ ] |
| G11 | The plugin device picker is the same component, and the plugin that uses it is renumbered | `mikrotik-routing` at `0.14.0` in all three places | `rg -n "0\.14\.0" plugins/mikrotik-routing/package.json plugins/mikrotik-routing/src/index.ts plugins/mikrotik-routing/src/index.test.ts` prints 3 lines; `bun test plugins/mikrotik-routing/src/index.test.ts` passes | [ ] |
| G12 | Forbidden vocabulary is absent from this plan's new code and copy | 0 matches | §10.3 `GREP_216_VOCAB` prints nothing | [ ] |
| G13 | Typecheck is clean | 0 errors | `bun run typecheck` exits 0 | [ ] |
| G14 | Design tokens: no v3 bracket colour form, no `dark:` variant, no hex literal in the new files | 0 matches | `rg -n -e "\[--color" -e "\bdark:" -e "#[0-9a-fA-F]{3,8}\b" packages/studio/src/components/actions packages/studio/src/components/target` prints nothing | [ ] |

## 1. Goals

1. One `DevicePicker` and one `useTarget`, at `packages/studio/src/components/target/`, replacing the four device-choosing components the product has today (`components/DevicePicker.tsx`, `packages/ui/src/components/device-picker.tsx`, `components/target/TargetPicker.tsx`, `components/command/TargetPicker.tsx`).
2. One `ActionDialog` shell that composes, in this fixed order and nothing between them: the title, the picker container, a divider, the verb's form container, the per-device outcome list, the footer.
3. Fifteen verb dialogs (twelve from the handoff's generic action set, three in the overflow), each naming exactly one plan-207 verb and owning only its own fields.
4. One outcome renderer, `ActionOutcome`, used by every dialog and by anything else that has to show an `ActionResult[]` (it replaces plan 207's placeholder `components/actions/ActionResults.tsx`, which that plan's §4.9 already says "plan 216 replaces it").
5. Every entry point opens the same dialog with the target pre-filled: the Devices bulk pill menu, Device Control's Actions tab and its `[i]` popover's Change button, the Jobs detail "Run again", the Scripts detail and Plugins pages' Run buttons.
6. The deletion of everything the new pair replaces: twelve dialogs, two target pickers, `target-preview.ts`, `useTargetSelection.ts`, `lib/operations.ts` with `components/operations/`, `components/bulk/OutcomeSummary.tsx` / `SkippedGroups.tsx` / `use-batch-report.ts`, and the five `components/wall/` files plan 214 passed on, with `scripts/check-routes.ts` pruned.

## 2. Non-goals

| Not in this plan | Who owns it |
|---|---|
| The Jobs list, the Jobs detail layout, the run picker, `components/bulk/BatchResults.tsx` and `app/batches/detail/` | plan 218. This plan changes exactly one line on the Jobs detail page (the "Run again" handler) and touches nothing else there |
| The Scripts, Workflows and Schedules pages, including the schedule editor that replaces `ScheduleEditorDialog` | plan 217. This plan deletes the old dialog and its orphan `/schedules` route because their only device picker is being deleted (§3.4) |
| The Settings pages | plan 219. The `settings` **verb** dialog here writes a `DeviceSettingsPatch` through `POST /api/actions/settings`; it is not the Settings screen |
| `AdbRestartDialog` and `AppRestartDialog` | plan 219. They are farm-level maintenance confirmations with no target and no verb, and one of them is the audited entry point to `cycle()` (§3.3) |
| `EnrollmentDialog` | plan 219 or 220, once the CEO answers plan 214 §9 Q5 (§9 Q1 here) |
| The Screens view, the device table, the group tab strip, selection | plan 214 |
| Device Control's window, tabs, inspector and files | plan 215 |
| Any new API route or protocol schema | plan 207 shipped all of them. This plan writes no Zod schema and no core file |
| Live video inside a picker | nobody. The Screens view is where a device is chosen by looking at its screen (§3.7) |

## 3. Context and design decisions

### 3.1 The complaint, and that it is literally true today

`docs/mvp/07-actions-api.md` §2.1's Visual contract opens: *"Today the picker sits at the top of some dialogs, at the bottom of others, and sometimes under a line of explanatory text, so it reads as one more form field."* Verified by reading all nine dialogs that render a picker on 2026-09-03:

| Dialog | Picker at | Line and content |
|---|---|---|
| `components/device/BulkCutoverDialog.tsx` | **first element of the body** | `:209` `<TargetPicker selection={targetSelection} devices={pool} allow={TARGET_ALLOW} />` |
| `components/device-popup/AdbCommandDialog.tsx` | **first element of the body** | `:361` `<TargetPicker selection={targetSelection} devices={devices} clusters={clusters} allow={TARGET_ALLOW} singleLabel="Device" devicesLabel="Devices" />` |
| `components/RunScriptDialog.tsx` | after script and version, before params | `:1051` `<TargetPicker selection={targetSelection} devices={devices} clusters={clusters} allow={TARGET_ALLOW} />` |
| `components/InstallBatchDialog.tsx` | below the artifact field | `:227` `<TargetPicker selection={targetSelection} devices={pool} clusters={clusters} allow={TARGET_ALLOW} />` |
| `components/BulkTransferDialog.tsx` | below the artifact and remote path | `:230` `<TargetPicker selection={targetSelection} devices={pool} clusters={clusters} allow={TARGET_ALLOW} />` |
| `components/BulkPrepDialog.tsx` | **last** field of the form | `:399` `<TargetPicker selection={targetSelection} devices={pool} clusters={clusters} allow={TARGET_ALLOW} />` |
| `components/network/BulkProxyDialog.tsx` | **last**, under sixteen route fields | `:491` `<TargetPicker selection={targetSelection} devices={pool} clusters={clusters} allow={TARGET_ALLOW} />` |
| `components/BulkForgetDialog.tsx` | the only body content | `:126` `{!results && <TargetPicker selection={targetSelection} devices={pool} allow={TARGET_ALLOW} />}` |
| `components/ScheduleEditorDialog.tsx` | below every script and agent field, no `TargetPicker` at all | `:704` `<DevicePicker devices={devices} value={deviceIds} onChange={setDeviceIds} multiple />` |

Four positions, two different picker components, and one dialog that uses the raw `DevicePicker` with its own local `type Target = 'cluster' | 'devices'` (`ScheduleEditorDialog.tsx:98`). The picker also renders inside a `<div className="space-y-1.5">` with a `<Label>` above it in `target/TargetPicker.tsx:104-107`, `:116-117` and `:134-135`, which is exactly the "under a line of explanatory text" the contract forbids.

### 3.2 Two target pickers and two device pickers exist, with different semantics

- `components/target/TargetPicker.tsx` (185 lines) plus `useTargetSelection.ts` (189 lines): modes `single | cluster | devices` (`useTargetSelection.ts:13`), a fleet-wide typed confirmation (`:159-160`), and a `SingleDeviceNotice` whose copy names a lease (`TargetPicker.tsx:180-181`, *"A lease can only ever hold one phone"*), a word plan 200 §2.4 forbids.
- `components/command/TargetPicker.tsx` (173 lines) plus `target-preview.ts`: modes `devices | cluster | tags` (`:20`), a preview that names every excluded device (`:139` `data-testid="target-preview"`).
- `components/DevicePicker.tsx` (68 lines): a Studio wrapper injecting `HolderBadge` (`:47`, `:55`) and `DeviceStatusBadge` into `@enkaku/ui`'s picker. `HolderBadge` is deleted by plan 205 with the lease.
- `packages/ui/src/components/device-picker.tsx` (353 lines): the shared list picker, search plus tag chips plus cluster grouping.

The MVP needs exactly one control with the union of what matters: three modes (devices, group, tags), search, per-chip readiness, and per-chip policy sentences. Two of the four are therefore rewritten into one and the other two deleted. `matchesDeviceQuery` and `DeviceName`/`formatDeviceName` in `@enkaku/ui` stay: they are the search predicate and the identity renderer, not the picker.

### 3.3 The brief's sixteen dialogs are twelve here, and why

Reading the sixteen on 2026-09-03 (importers grepped over `packages/studio/src` excluding tests):

| Dialog | What this plan does | Reason |
|---|---|---|
| `InstallBatchDialog`, `BulkTransferDialog`, `BulkPrepDialog`, `BulkForgetDialog`, `device/BulkCutoverDialog`, `network/BulkProxyDialog`, `device/CutoverDialog`, `ForgetDeviceDialog`, `DisconnectDeviceDialog`, `RunScriptDialog`, `ScheduleEditorDialog`, `AskAnAgentDialog` | **deleted** (§10.1) | each is replaced by a verb dialog, or (Schedule, Ask an agent) by a later plan's own surface |
| `AdmitDeviceDialog`, `device/ScanNetworkDialog` | already deleted by plan 214 §10.1 | this plan re-proves them in §10.4 so the wave-3 removal gate is complete |
| `device-popup/AdbCommandDialog` | already deleted by plan 215 §10.1 (it deletes `components/device-popup/` whole) | its replacement is this plan's `adb` verb dialog |
| `AdbRestartDialog`, `AppRestartDialog` | **kept**, handed to plan 219 (§10.2) | neither is an action dialog. Their props are `{ trigger: ReactNode }` (`AdbRestartDialog.tsx:36`, `AppRestartDialog.tsx:52`), they take no device, call no verb, and hit `/api/tools/...`. `AdbRestartDialog`'s own header says it "is the only path to `POST /api/tools/adb/restart`", the audited exception to the `adb kill-server` prohibition `CLAUDE.md` protects. Deleting it would remove that operator path with nothing to replace it. Plan 200 §2.2: the file wins for facts |
| `EnrollmentDialog` | **kept**, §9 Q1 | plan 214 §9 Q5 is open and plan 200 §2.1 forbids deciding it |

So twelve deletions here, three already made, two deferred with owners, one open.

### 3.4 `ScheduleEditorDialog` takes the `/schedules` route with it

`ScheduleEditorDialog.tsx:17` `import { DevicePicker } from '@/components/DevicePicker'` is its only way of choosing devices, and that module is deleted here. Its only importers are `app/schedules/page.tsx:16` and `app/schedules/detail/page.tsx:23`, both of which are routes plan 213's `scripts/check-routes.ts` already lists as debts (`PENDING_REMOVAL`'s `'/schedules': 'plan 217: third tab of Scripts & workflows (MVP 15 §0.1.1)'`). Porting the 927-line editor onto the new picker would be work plan 217 throws away in the same wave. So this plan deletes the dialog and the route directory together and prunes the `/schedules` row, which is what keeps `check-routes.ts` check 2 (a stale exemption is a failure) passing. Plan 217 builds the Schedules tab under `/scripts` with no orphan route left behind. Recorded as a coordination risk in §8.

### 3.5 There is no device row context menu in the MVP

The brief names one as an entry point. There is none: plan 214 §3.5 deletes `components/wall/DeviceContextMenu.tsx` "because the handoff gives a device row no context menu at all; right-click belongs to the group tab and actions come from the bulk pill or Device Control", and the handoff's own Interactions table maps a device row's click to selection and its double-click to Device Control. The single-device entry point is therefore the bulk pill with one row selected, plus Device Control's Actions tab, which is exactly the handoff's promise that "selecting one device and selecting twenty behave identically". §4.9 lists the five real entry points.

### 3.6 All twelve rows open a dialog, including the six plan 214 executes directly

Plan 214 §3.10 ships six rows executing `runAction` with no dialog (`reconnect`, `disconnect`, `sleep`, `screenshot`, `forget`, `set-group` through a nested group submenu) because their verbs need no parameter. MVP 07 §2.1 is unconditional in the other direction: *"The picker is the first row of every action modal and popup, always, in the same place, above the verb's own fields"*, and *"The same container, at the same position, with the same height when collapsed, in every action modal and popup."* A verb with no fields still needs the row, because the row is what lets the operator change the target without going back to the list, and because "the same container at the same position in every modal" is false the moment six of twelve open no modal at all.

So this plan converts all twelve to dialogs, deletes `ActionSetItem.needsDialog` and `ActionSetItem.submenu`, and deletes the group submenu plan 214 built. Nothing plan 214 wrote has to be unpicked beyond those two flags: its `ActionMenu` already calls one handler per row.

### 3.7 The wall picker becomes the device picker, and the plugin is renumbered

Plan 214 §3.5 kept `components/wall/{Wall,WallTile,TileGrid,TileSkeleton,tile-identity}` alive for one consumer: `components/host/DeviceWallWithPicker.tsx:6` `import { Wall } from '@/components/wall/Wall'`, exported at `components/host/index.ts:29` and imported by `plugins/mikrotik-routing/src/ui/parts/groups.tsx:34`, used at `:623`. Plan 214 §10.2 hands all five files plus the host component "to plan 216, which owns pickers".

This plan replaces `DeviceWallWithPicker` with `DevicePickerDialog`, the same `DevicePicker` in a dialog, keeping the prop shape byte for byte (`open`, `onOpenChange`, `value`, `onConfirm`, `filter?`, `title?`) so the plugin's call site changes only the component name. The live-tile picker is not reimplemented: MVP 07 §2.1's "one component, one hook, one place" is the whole point of this plan, and the Screens view (plan 214) is where the farm is read by looking at screens. The plugin's button label is unchanged ("Add devices…", `groups.tsx:579-580`); only its two comments and the import move.

Per `CLAUDE.md`, editing `plugins/*/src/` means bumping the plugin: `plugins/mikrotik-routing/package.json:3` `"version": "0.13.0"`, `src/index.ts:429` `version: '0.13.0'` and `src/index.test.ts:19` `expect(plugin.version).toBe('0.13.0')` all become `0.14.0`, with a changelog entry in `src/index.ts`'s block beside the previous bumps and a `bun run build:packs` afterwards. Minor, not patch: an operator meets the change the moment they open the group editor, exactly as that file's own `0.7.0 → 0.8.0` row argues. The seeded version is staged, not activated; the release note has to say so.

### 3.8 The generic action set exists twice in the two plans this one sits between

Plan 214 §4.12 ships `packages/studio/src/components/devices/action-set.ts` with `GENERIC_ACTION_SET`, saying "Plan 215 imports this exact array". Plan 215 §4.10 ships `packages/studio/src/lib/generic-actions.ts` with `GENERIC_ACTIONS`, and its §10.2 deletes "a second copy of the generic action set | plan 214's bulk-pill menu". They are the same twelve rows in the same order with the same icons. Plan 200 §8.1 merges within a stage by plan number, so plan 215 lands before this plan and `lib/generic-actions.ts` is what survives.

This plan does not choose: step 216.9 greps for whichever file exists, keeps exactly one, points every consumer at it, and reports the outcome. If both survive the merge, the one under `lib/` is kept (plan 215 is the later authority) and the other is deleted. G2's grep and plan 215's own `rg -n "Install apk"` proof both then hold.

### 3.9 What plan 207 already built, so this plan writes no request code

`packages/studio/src/lib/actions.ts` (plan 207 §4.9) exports `runAction(verb, target, params, opts?)`, `runOnDevice`, `fetchOperation`, `awaitOperation(id, opts?)`, `groupResults(results)` and `ActionRefusedError`. `packages/protocol/src/actions.ts` (plan 207 §4.1) exports `TargetSchema` (`{ deviceIds } | { groupId } | { tags }`), `ACTION_VERBS` (25 verbs), `ActionRequestSchema`, `ActionResultSchema` with `status: 'accepted' | 'skipped' | 'forbidden' | 'warned' | 'done' | 'failed'`, `message`, `code`, `activityId`, `jobId`, `batchId`, `detail`, and `ActionResponseSchema` with `operationId`, `verb`, `results`. The `force` flag is on `CommonSchema` (`actions.ts:188` `force: z.boolean().default(false)`) and plan 207 §4.3 step 4 is explicit that a `warn` becomes `{ status: 'warned', message }` "unless `request.force`". Everything this plan needs on the wire exists.

### 3.10 Where the picker's devices come from

Plan 214's `useDevices()` lives in `components/devices/useDevices.ts` and is the Devices screen's own seed-plus-push store; a dialog opened from `/jobs` or `/plugins` cannot use it. So `ActionDialogHost` (§4.8) fetches its own copy the first time a dialog opens (`fetchDevices()` from `lib/api.ts:107` and `fetchAllPages<GroupInfo>('/api/groups')`) and follows `device.activity` / `device.status` / `device.added` / `device.removed` only while a dialog is open, using plan 205's `applyActivityEvent` from `lib/activity.ts`. A page that never opens an action dialog issues no request, and nothing polls: plan 214's `GREP_214_POLL` rule holds here too.

### 3.11 Resolution semantics the picker's count must match

The count beside a group or a tag set is a client-side preview of what `resolveActionTarget` (plan 207 §4.5, renamed from `packages/core/src/clusters/resolve.ts`) will do. Read on 2026-09-03, `resolve.ts:41` `taggedIds = rows.filter((r) => target.tags.every((t) => (tagMap.get(r.id) ?? []).includes(t)))` (tags are **AND**, a device must carry every tag) and `resolve.ts:19-22` `if (row.status === 'offline') return 'offline'` / `if (row.status === 'quarantined') return 'quarantined'` (usable is neither offline nor quarantined). The picker uses exactly those two rules, and §4.3 states them in the code comment so a future change to one is visibly a change to both.

## 4. Technical design

### 4.1 The handoff, verbatim

From `docs/mvp/design_handoff_enkaku_openpf/README.md`, "Generic action set (one list, used everywhere)" (lines 189-198):

> The same twelve actions appear in the bulk menu and in Device Control → Actions, so
> selecting one device and selecting twenty behave identically:
>
> `Reconnect` (`ph-arrows-clockwise`) · `Disconnect` (`ph-plugs`) · `Install apk` (`ph-download-simple`) ·
> `Adb command` (`ph-terminal`) · `Run script` (`ph-play`) · `Screenshot` (`ph-camera`) ·
> `Sleep` (`ph-moon`) · `Move group` (`ph-folder-simple`) · `Upload file` (`ph-upload-simple`) ·
> `Clear cache` (`ph-broom`) · `Settings` (`ph-gear`) · `Forget` (`ph-trash`, `var(--danger)`).
>
> Rows: `padding: 9px 10px`, `border-radius: 10px`, 13px, hover `background: var(--muted)`.

From "Bulk actions (floating, bottom-right of the panel)" (lines 178-187), the one measurement this plan borrows for the overflow section:

> Opening it reveals a 226px menu above the pill (`border-radius: 14px`,
> `box-shadow: 0 20px 50px #00000026`) headed "Bulk action" + **Clear**, listing the **generic action set**.

From "Design Tokens" (lines 486-525), the values every measurement below is derived from:

> **Typography** — `Geist` (400/500/600/700) for UI, `Geist Mono` (400/500) for serials, endpoints,
> paths, versions, script names, timestamps and numeric readouts. Scale: 19px/600 settings section titles,
> 16px/600 sheet titles, 15px/600 page and job titles, 14px/600 device name in Device Control,
> 13px/500-600 row titles and buttons, 12.5px body and controls, 11.5px meta, 11px column labels and
> hints, 10.5px badges, 10px tooltips and frame captions.
>
> **Spacing** — 10px shell gap and padding; 12–14px panel padding; 6/8/10/12/14px gaps.
> **Radii** — 16px page panels, 18px floating window and cast, 14px cards/sheets/status bar, 12px inner
> cards, 10px buttons and rows, 9px settings inputs and nav items, 8px small buttons, 7px compact chips,
> 5px checkboxes, 999px pills.
> **Shadows** — `0 1px 3px #00000014` (active pill), `0 8px 24px #00000014` (cast),
> `0 10px 24px var(--accent-a3)` (bulk pill), `0 16px 40px #0000001f` (popovers),
> `0 20px 50px #00000024` (console/menus), `0 30px 80px #00000033` (Device Control).

`docs/mvp/15-ui-migration.md` §2 says the action dialogs are what the handoff has not drawn, so every measurement in §4.2 to §4.5 is derived from an element the handoff **does** draw, and each says which:

| New element | Borrowed from | Handoff value |
|---|---|---|
| Dialog surface | plan 204 §4.6's re-skinned `DialogContent` | `rounded-window border border-border-2 bg-panel shadow-window` |
| Dialog padding | "12–14px panel padding" | `14px` horizontal on every band |
| Picker container fill | the Devices table header (`bg-panel-2`, the only second surface the handoff paints inside a panel) | `var(--panel-2)` |
| Picker/form divider | the Devices toolbar's `border-bottom: 1px solid var(--line)` | `border-line` |
| Collapsed picker row | the handoff's input/button height (`padding: 9px 12px` at 12.5px = 34px, plan 204 §4.6 "the height is fixed rather than padded") | `h-[34px]` |
| Mode segmented control | Device Control's compact tabs | `TabsList variant="compact"`, `padding: 4px 10px`, `radius 7`, `12px` |
| Device chip | "7px compact chips" plus the badge step | `rounded-chip`, `text-meta` (11.5px) |
| Outcome row | the generic action set's row metrics | `px-[10px] py-[9px]`, `rounded-button`, `text-row` |
| Overflow section width inside the dialog | the bulk menu's 226px | not used: the overflow lives in the bulk menu itself, which plan 214 already sizes at `w-[226px]` |

### 4.2 `packages/studio/src/components/target/DevicePicker.tsx` (new, the shipped artefact)

```tsx
'use client'

import { useMemo, useState } from 'react'
import type { ActionResult, DeviceInfo, GroupInfo } from '@enkaku/protocol'
import {
  Badge,
  CaretDownIcon,
  CheckIcon,
  DeviceName,
  Input,
  MagnifyingGlassIcon,
  StatusDot,
  Tabs,
  TabsList,
  TabsTrigger,
  XIcon,
  cn,
  matchesDeviceQuery,
} from '@enkaku/ui'
import { deviceState } from '@/components/devices/device-state'
import type { TargetState } from './useTarget'

/**
 * The device picker (MVP 07 §2.1). One component, one hook, one place.
 *
 * The visual contract, quoted from `docs/mvp/07-actions-api.md` §2.1 because
 * every class below exists to satisfy one of its clauses:
 *
 *   "The picker is its OWN container, visually distinct from the form: its
 *    own surface colour and border, full width, flush under the modal title,
 *    with nothing between the title and the picker. No helper text, no
 *    description, no section heading above it."
 *   "The form for the verb starts BELOW a clear divider in a separate
 *    container. The two never share a background or a border."
 *   "The picker's collapsed state is a single line ('3 devices', 'Group A ·
 *    12 devices'); expanding it grows the picker container, never the form."
 *   "The same container, at the same position, with the same height when
 *    collapsed, in every action modal and popup."
 *
 * So: `bg-panel-2` (the form is `bg-panel`), `border-b border-line` and no
 * other border, `w-full`, `px-[14px] py-[10px]`, and a collapsed row that is
 * exactly `h-[34px]` tall, giving every dialog the identical 54px collapsed
 * band. This component renders NO label and NO helper text of its own: the
 * contract forbids anything above it, and a heading inside it would be the
 * same defect one level down.
 *
 * It never opens a dialog. Editing the target happens in place, and the
 * verb's fields below keep their values while it happens (that is why the
 * state lives in `useTarget`, held by `ActionDialog`, not here).
 */
export function DevicePicker({ state, className }: { state: TargetState; className?: string }) {
  const [expanded, setExpanded] = useState(false)
  const [query, setQuery] = useState('')

  return (
    <div data-slot="device-picker" className={cn('w-full border-b border-line bg-panel-2 px-[14px] py-[10px]', className)}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex h-[34px] w-full items-center gap-2 rounded-button text-left text-body text-text"
      >
        <span className="min-w-0 flex-1 truncate">{state.summary}</span>
        {state.warnedIds.length > 0 && <Badge variant="warn">{state.warnedIds.length} warned</Badge>}
        {state.forbiddenIds.length > 0 && <Badge variant="destructive">{state.forbiddenIds.length} blocked</Badge>}
        <CaretDownIcon className={cn('size-3.5 shrink-0 text-faint transition-transform', expanded && 'rotate-180')} aria-hidden />
      </button>

      {expanded && (
        <div className="mt-2 space-y-2">
          <Tabs value={state.mode} onValueChange={(v) => state.setMode(v as TargetState['mode'])}>
            <TabsList variant="compact">
              <TabsTrigger value="devices">Devices</TabsTrigger>
              <TabsTrigger value="group">Group</TabsTrigger>
              <TabsTrigger value="tags">Tags</TabsTrigger>
            </TabsList>
          </Tabs>

          {state.mode === 'devices' && <DeviceMode state={state} query={query} setQuery={setQuery} />}
          {state.mode === 'group' && <GroupMode state={state} />}
          {state.mode === 'tags' && <TagMode state={state} />}
        </div>
      )}

      {/* The chips are OUTSIDE the expanded block on purpose: a warned or
          forbidden sentence must stay readable after the request came back
          and the operator collapsed the picker again (MVP 07 §2.1, "After
          the first request, `warned` and `forbidden` sentences render inline
          on the same chips"). */}
      {(expanded || state.warnedIds.length > 0 || state.forbiddenIds.length > 0) && state.chips.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {state.chips.map((chip) => (
            <Chip key={chip.device.id} chip={chip} state={state} />
          ))}
        </div>
      )}
    </div>
  )
}

function Chip({ chip, state }: { chip: TargetState['chips'][number]; state: TargetState }) {
  const { device, result } = chip
  const tone =
    result?.status === 'forbidden'
      ? 'border-danger/40 bg-danger-soft'
      : result?.status === 'warned'
        ? 'border-warn/40 bg-warn-soft'
        : 'border-border-2 bg-panel'
  return (
    <span className={cn('inline-flex max-w-full flex-col gap-0.5 rounded-chip border px-2 py-1', tone)}>
      <span className="flex items-center gap-1.5">
        <StatusDot state={deviceState(device)} title={activitySentence(device)} />
        <DeviceName number={device.number} label={device.label} className="text-meta" />
        {device.activities.length > 0 && <span className="truncate text-tip text-faint">{device.activities[0]?.label}</span>}
        {state.mode === 'devices' && !state.locked && (
          <button type="button" onClick={() => state.toggleDevice(device.id)} aria-label={`Remove ${device.label}`} className="text-faint hover:text-text">
            <XIcon className="size-3" aria-hidden />
          </button>
        )}
      </span>
      {result?.message && (
        <span className={cn('text-tip', result.status === 'forbidden' ? 'text-danger' : 'text-warn')}>{result.message}</span>
      )}
    </span>
  )
}

/** The list of every device, with the search box the handoff gives the toolbar (`Input variant="search"`). */
function DeviceMode({ state, query, setQuery }: { state: TargetState; query: string; setQuery: (q: string) => void }) {
  const filtered = useMemo(() => state.devices.filter((d) => matchesDeviceQuery(d, query)), [state.devices, query])
  return (
    <>
      <div className="relative">
        <MagnifyingGlassIcon className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-faint" aria-hidden />
        <Input variant="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search number, label, stable id, or tag" aria-label="Search devices" className="pl-8" />
      </div>
      <div role="listbox" aria-multiselectable={!state.locked} className="max-h-[240px] space-y-0.5 overflow-y-auto">
        {filtered.length === 0 ? (
          <p className="px-2 py-3 text-center text-meta text-faint">No device matches.</p>
        ) : (
          filtered.map((d) => {
            const selected = state.deviceIds.includes(d.id)
            return (
              <button
                key={d.id}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => state.toggleDevice(d.id)}
                className={cn('flex w-full items-center gap-2.5 rounded-button px-[10px] py-[9px] text-row transition-colors', selected ? 'bg-accent-soft text-accent' : 'text-text hover:bg-muted')}
              >
                <span className={cn('flex size-4 shrink-0 items-center justify-center rounded-check border-[1.5px]', selected ? 'border-accent bg-accent text-on-accent' : 'border-border-3')} aria-hidden>
                  {selected && <CheckIcon weight="bold" className="size-3" />}
                </span>
                <StatusDot state={deviceState(d)} />
                <DeviceName number={d.number} label={d.label} className="min-w-0 flex-1" />
                {d.activities.length > 0 && <span className="truncate text-meta text-faint">{d.activities[0]?.label}</span>}
              </button>
            )
          })
        )}
      </div>
    </>
  )
}

/** One row per group, single choice, with its resolved usable count (§3.11). */
function GroupMode({ state }: { state: TargetState }) { /* rows: `${g.name}` + `${g.usableCount} now`, radio semantics, same row classes as DeviceMode */ }

/** Every tag on the farm as a toggle chip; AND semantics, stated in the copy (§3.11). */
function TagMode({ state }: { state: TargetState }) { /* chips `rounded-pill px-2 py-0.5 text-label`, active `bg-accent-soft text-accent border-accent` */ }

/** The first activity's label, or the state word, for the dot's tooltip. */
function activitySentence(d: DeviceInfo): string { /* d.activities[0]?.label ?? d.status */ }
```

`GroupMode`, `TagMode` and `activitySentence` are written out by the executor from the two sentences above them; every class they may use is already named in this file.

Two clauses of the contract that are properties of the **caller**, not of this file, and are asserted in §4.4: the picker is the first child of the dialog body, and nothing renders between the title and it.

### 4.3 `packages/studio/src/components/target/useTarget.ts` (new)

```ts
'use client'

import { useCallback, useMemo, useState } from 'react'
import type { ActionResult, DeviceInfo, GroupInfo, Target } from '@enkaku/protocol'

/** MVP 07 §2.1: "Three modes, one control: devices (chips with search over label, number, tag, group), group (one select), tags (multi-select)." */
export type TargetMode = 'devices' | 'group' | 'tags'

/**
 * What the entry point knows. MVP 07 §2.1: "Pre-filled from context. Opened
 * from one device, it shows that one device selected. Opened from a
 * selection, it shows the selection. Opened from a group chip, it shows the
 * group with its resolved member count. Opened from the Jobs page 'Run
 * again', it shows the batch's original target." It is a starting point and
 * never a lock: every field stays editable in place.
 */
export interface TargetContext {
  deviceIds?: readonly string[]
  groupId?: string | null
  tags?: readonly string[]
}

export interface TargetChip {
  device: DeviceInfo
  /** The device's row from the last `ActionResponse`, or null before the first request. */
  result: ActionResult | null
}

export interface TargetState {
  mode: TargetMode
  setMode: (m: TargetMode) => void
  /** The whole pool, unfiltered: an unusable device stays visible with its reason, never silently removed. */
  devices: DeviceInfo[]
  groups: GroupInfo[]
  deviceIds: string[]
  toggleDevice: (id: string) => void
  groupId: string | null
  setGroupId: (id: string | null) => void
  tags: string[]
  toggleTag: (tag: string) => void
  /** MVP 07 §1.1's body, or null when nothing is chosen. */
  target: Target | null
  /** The ids this target resolves to right now, by §3.11's two rules. */
  resolvedIds: string[]
  /** `resolvedIds.length`. */
  count: number
  /** The collapsed line: `3 devices`, `Team A · 12 devices`, `tag:warm · 7 devices`, `No devices chosen`. */
  summary: string
  /** One chip per resolved device, with its last result. */
  chips: TargetChip[]
  /** `maxTargets: 1`: the picker still renders, one chip only, switchable. */
  locked: boolean
  warnedIds: string[]
  forbiddenIds: string[]
  /** True when at least one device came back `warned` and none has been forced yet: the primary button becomes "Continue for N devices". */
  needsForce: boolean
  /** True when every resolved device came back `forbidden`: the primary button is disabled. */
  allForbidden: boolean
  /** Stores one response's rows against their devices. */
  applyResults: (results: readonly ActionResult[]) => void
  /** Drops every stored row. Called whenever the target itself changes, so a stale sentence can never survive a retarget. */
  clearResults: () => void
  reset: (ctx: TargetContext) => void
}

export function useTarget(opts: {
  devices: DeviceInfo[]
  groups: GroupInfo[]
  initial: TargetContext
  /** A plugin verb may declare `maxTargets: 1` (MVP 07 §2.1). No MVP verb does. */
  maxTargets?: number
}): TargetState
```

Rules the implementation follows, exactly:

1. **Initial mode.** `initial.deviceIds?.length` picks `devices`; else `initial.groupId` picks `group`; else `initial.tags?.length` picks `tags`; else `devices` with an empty list.
2. **`resolvedIds`.** `devices` mode: `deviceIds` in the order chosen, filtered to ids still present in `devices`. `group` mode: `devices.filter((d) => d.group?.id === groupId)`. `tags` mode: `devices.filter((d) => tags.every((t) => d.tags.includes(t)))` (AND, matching `packages/core/src/clusters/resolve.ts:41`). In all three, an `offline` or `quarantined` device stays in `resolvedIds` and in the chip list; only the summary's count excludes it, because plan 207 §4.3 step 4 reports it as `skipped` rather than refusing the request (`resolve.ts:19-22`).
3. **`summary`.** `devices`: `${usable} device(s)` where `usable` excludes offline and quarantined, plus ` · ${n} unavailable` when any are. `group`: `${group.name} · ${usable} device(s)`. `tags`: `${tags.join(' + ')} · ${usable} device(s)`. Empty in any mode: `No devices chosen`.
4. **`toggleDevice` under `locked`.** With `maxTargets === 1`, `toggleDevice(id)` **replaces** the selection rather than adding to it, so the row is "locked to one chip but switchable to a different device" (MVP 07 §2.1).
5. **Every mutation calls `clearResults()` first.** A sentence that came back for one target must never be read as belonging to the next one.
6. `applyResults` keys by `deviceId` and keeps only `warned`, `forbidden`, `skipped` and `failed` rows; `accepted` and `done` rows clear that device's chip tone (the outcome list below shows them instead).
7. `needsForce` is `warnedIds.length > 0`; `allForbidden` is `resolvedIds.length > 0 && forbiddenIds.length === resolvedIds.length`.
8. Nothing in this file fetches, and nothing reads `window`.

### 4.4 `packages/studio/src/components/actions/ActionDialog.tsx` (new)

The one shell. It is the only file in the workspace that renders `<DevicePicker>` inside a dialog, which is what makes "the same container at the same position in every modal" a structural fact rather than a convention.

```tsx
export function ActionDialog({ spec, ctx, devices, groups, onClose }: {
  spec: VerbDialogSpec<unknown>
  ctx: TargetContext
  devices: DeviceInfo[]
  groups: GroupInfo[]
  onClose: () => void
}) {
  const target = useTarget({ devices, groups, initial: ctx, maxTargets: spec.maxTargets })
  const [value, setValue] = useState(spec.initial)
  const [results, setResults] = useState<ActionResult[] | null>(null)
  const [busy, setBusy] = useState(false)
  useOverlay('window', true, onClose)   // §4.4 rule 4
  ...
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      {/* `p-0 gap-0`: `DialogContent`'s own `p-6 gap-4` would put 24px of
          padding and a 16px gap between the title and the picker, and MVP 07
          §2.1 says "flush under the modal title, with nothing between the
          title and the picker". Every band below sets its own padding. */}
      <DialogContent className="w-full gap-0 p-0 sm:max-w-[520px]" onEscapeKeyDown={(e) => e.preventDefault()}>
        <DialogHeader className="px-[14px] pt-[14px] pb-[10px]">
          <DialogTitle>{spec.title(target.count)}</DialogTitle>
        </DialogHeader>

        {/* 1. The picker. Its own container, its own surface, full width, and
               the FIRST child after the title in every single dialog. */}
        <DevicePicker state={target} />

        {/* 2. The form. A separate container, below the picker's own
               `border-b border-line` divider, on `bg-panel`, with no border
               of its own: "The two never share a background or a border." */}
        <div className="max-h-[46dvh] space-y-3 overflow-y-auto bg-panel px-[14px] py-3">
          {spec.Fields ? <spec.Fields value={value} onChange={setValue} target={target} /> : <p className="text-body text-dim">{spec.note}</p>}
          {results && <ActionOutcome results={results} devices={devices} />}
        </div>

        <DialogFooter className="border-t border-line px-[14px] py-3">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            variant={spec.destructive ? 'destructive' : 'default'}
            disabled={busy || target.count === 0 || target.allForbidden || !spec.canSubmit(value)}
            onClick={() => void submit(target.needsForce)}
          >
            {label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

`label` and `submit`, complete:

```ts
const label = busy
  ? 'Working…'
  : target.needsForce
    ? `Continue for ${target.warnedIds.length} device${target.warnedIds.length === 1 ? '' : 's'}`
    : spec.submitLabel(target.count)

async function submit(force: boolean) {
  if (!target.target) return
  setBusy(true)
  try {
    const params = await spec.toParams(value)
    const res = await runAction(spec.verb, target.target, params as never, { force })
    // An async verb (plan 207 §4.2's `mode: 'async'` rows) answers `accepted`
    // and settles on the operation; a sync one is already final.
    let final = res.results
    target.applyResults(final)
    setResults(final)
    if (final.some((r) => r.status === 'accepted')) {
      final = (await awaitOperation(res.operationId)).results
      target.applyResults(final)
      setResults(final)
    }
    const grouped = groupResults(final)
    spec.onDone?.(res, grouped)
    if (grouped.failed.length === 0 && grouped.forbidden.length === 0 && grouped.warned.length === 0) onClose()
  } catch (err) {
    toast.error(describeApiError(err))
  } finally {
    setBusy(false)
  }
}
```

Four properties the executor must not weaken:

1. **`force` is never sticky.** It is passed only on the click that says "Continue for N devices", derived from `target.needsForce` at click time. A dialog reopened for a new target starts unforced, because `useTarget`'s `clearResults` ran.
2. **The dialog stays open on a mixed result.** Closing on the success half would hide the sentences the operator has to read. It closes only when nothing failed, was forbidden or was warned.
3. **The picker never disappears while results are showing.** The chips are where the per-device sentences live.
4. **Exactly one thing closes the dialog on Escape.** `DialogContent` takes `onEscapeKeyDown={(e) => e.preventDefault()}` so Radix's own `DismissableLayer` does not close it, and `useOverlay('window', true, onClose)` (plan 213 §4.9) does instead. Two consequences follow for free and are the reason for the tier: plan 213's tiering never clears the device selection on the same keypress that closes a dialog, and plan 214 §4.11 rule 4's Ctrl/Cmd+A suspension (`hasOverlay('window')`) is already true while a dialog is open. Do not register at tier `menu`: a popover opened **inside** the dialog registers there and must close first.

### 4.5 `packages/studio/src/components/actions/ActionOutcome.tsx` (new)

One renderer for `ActionResult[]`, used by every dialog. It replaces plan 207 §4.9's placeholder `components/actions/ActionResults.tsx`, whose own comment says "No design investment: plan 216 replaces it with the handoff's chips."

```tsx
export function ActionOutcome({ results, devices, className }: { results: readonly ActionResult[]; devices: readonly DeviceInfo[]; className?: string })
```

- A summary line first, `text-meta text-faint`: `${done} done · ${failed + forbidden} refused · ${skipped} skipped (${settled}/${results.length})`, built from `groupResults` (plan 207 §4.9).
- Then one row per result, in the response's order, at the handoff's action-row metrics: `flex w-full items-start gap-2.5 rounded-button px-[10px] py-[9px] text-row`.
- Each row: a `StatusDot` for the device's live state, `<DeviceName number label />`, a `Badge` for the result status, and `result.message` on a second line in `text-meta` (`text-danger` for `failed`/`forbidden`, `text-warn` for `warned`, `text-faint` otherwise).
- Status to `Badge` variant: `done` → `default`, `accepted` → `secondary`, `skipped` → `ghost`, `warned` → `warn`, `forbidden` and `failed` → `destructive`.
- `jobId` renders as a `next/link` to `/jobs/detail?id=${jobId}`; `detail.artifactId` renders as a link to `${coreBase()}/api/artifacts/${id}/download` (the screenshot and pull cases). No other `detail` shape is inspected here: a verb that wants more renders it in its own `Fields` component.
- The list is capped at 50 rows with a `… and ${n} more` line, so a 500-device target cannot make the dialog unusable.

### 4.6 `packages/studio/src/components/actions/verb-dialogs.tsx` (new): the fifteen dialogs

```ts
export interface VerbDialogSpec<P> {
  verb: ActionVerb
  /** The dialog title. `n` is the resolved target count. */
  title: (n: number) => string
  submitLabel: (n: number) => string
  destructive?: boolean
  /** Plugins may declare 1 (MVP 07 §2.1). No MVP verb does. */
  maxTargets?: number
  /** The initial draft. */
  initial: P
  /** The fields under the divider, or null for a verb with no parameters. */
  Fields: React.ComponentType<{ value: P; onChange: (next: P) => void; target: TargetState }> | null
  /** Rendered in the form container when `Fields` is null: one sentence saying what will happen. */
  note?: string
  /** Blocks submit while false. */
  canSubmit: (value: P) => boolean
  /** The plan-207 request params. May upload an artifact first, which is why it is async. */
  toParams: (value: P) => Promise<Record<string, unknown>>
  onDone?: (res: ActionResponse, grouped: ReturnType<typeof groupResults>) => void
}

export const VERB_DIALOGS = { ... } satisfies Record<string, VerbDialogSpec<never>>
export type ActionDialogVerb = keyof typeof VERB_DIALOGS
```

The twelve of the generic action set, in the handoff's order, then the three of the overflow:

| # | Menu label | `verb` (plan 207 §4.1) | Fields under the divider | Submit label | Notes |
|---|---|---|---|---|---|
| 1 | Reconnect | `reconnect` | none | `Reconnect ${n} device(s)` | note: `Re-attaches each device over its remembered address. An offline device is retried, not skipped.` (`VERBS.reconnect.offline === 'allow'`, plan 207 §4.2) |
| 2 | Disconnect | `disconnect` | none | `Disconnect ${n} device(s)` | a running job returns `warned`; the sentence is plan 207 §4.2's `${n} running job(s) on ${label} (${names}) would fail if disconnected now`, and `Continue for N devices` is the acknowledgement |
| 3 | Install apk | `install` | `ArtifactPicker accept=".apk"` (`components/ArtifactPicker.tsx:43`), then three `Checkbox` rows: `Reinstall, keeping data`, `Grant every requested permission`, `Allow a downgrade` | `Install on ${n} device(s)` | `toParams` calls `uploadArtifactSource(source)` (`ArtifactPicker.tsx:135`) and returns `{ artifactId, reinstall, grantPermissions, allowDowngrade }` |
| 4 | Adb command | `adb` | one `Input mono` labelled `Command`, `maxLength={4096}`; below it, an advisory line in `text-warn text-meta` when `isHighConsequence(cmd).hit` is true, naming `.pattern` (`packages/protocol/src/command/high-consequence.ts:30`, `export function isHighConsequence(cmd: string): { hit: true; pattern: string } \| { hit: false }`, kept by plan 207 §4.1). It warns, it never blocks | `Run on ${n} device(s)` | the outcome list shows `detail.stdout`/`detail.stderr` under each row, in `font-mono text-[11px]`, capped at 2000 characters per device with a `… truncated` marker |
| 5 | Run script | `run-script` | a `Select` of `GET /api/scripts` rows grouped by plugin (skipped when `ctx.scriptId` is pre-filled and the caller passed `lockScript`), then `SchemaForm` over the row's `paramsSchema`, then `Concurrency` and `Order` `Select`s | `Run on ${n} device(s)` | §4.7 |
| 6 | Screenshot | `screenshot` | none | `Capture ${n} screenshot(s)` | each `done` row's `detail.artifactId` becomes a download link in `ActionOutcome` |
| 7 | Sleep | `sleep` | none | `Sleep ${n} device(s)` | note: `The session stays up; the screen goes dark and the tile shows it asleep.` (MVP 11 §1.1) |
| 8 | Move group | `set-group` | one `Select` of every group plus a `No group` option writing `null` | `Move ${n} device(s)` | replaces plan 214 §4.12's nested submenu (§3.6) |
| 9 | Upload file | `push` | `ArtifactPicker` (no `accept`), then `Input mono` labelled `Remote path` (default `/sdcard/Download/`), then a `Select` labelled `Media scan` with `auto`/`always`/`never` | `Upload to ${n} device(s)` | `toParams` uploads and returns `{ artifactId, remotePath, mediaScan }` |
| 10 | Clear cache | `clear-cache` | one `Input mono` labelled `Package`, `maxLength={256}` | `Clear cache on ${n} device(s)` | a non-zero exit maps to `failed` server-side (plan 207 §4.2) |
| 11 | Settings | `settings` | `SchemaForm` over `GET /api/settings`'s `deviceSchema`, seeded from the single selected device's `settings` when exactly one is chosen and from `{}` otherwise | `Apply to ${n} device(s)` | §4.8 |
| 12 | Forget | `forget` | one `Checkbox` labelled `Also delete history` | `Forget ${n} device(s)` | `destructive: true`. Description line in the form container: `Their history stays unless you tick the box. A phone that reconnects appears in Discovered again.` (plan 214 §4.12's own copy) |
| 13 | Prepare | `prepare` | one `Checkbox` labelled `Re-check components that already passed` writing `forceRecheck` | `Prepare ${n} device(s)` | overflow (MVP 15 §1: "Label and Prepare become actions in the overflow of the same menu, not in the first twelve") |
| 14 | Label | `set-label` | none | `Label ${n} device(s)` | overflow. note: `Writes the device number onto each phone's own screen, using the farm labelling mode.` |
| 15 | Network | `set-network` | a `Select` labelled `Change` with `Enable`, `Disable`, `Retry`, `Clear` writing `op` | `Apply to ${n} device(s)` | overflow. `op: 'set'` is **not** offered: composing a route belongs to the proxy-manager and mikrotik-routing plugin views (MVP 15 §1), and this dialog is the farm-wide arm/disarm the old `BulkProxyDialog` buried under sixteen fields |

Every `verb` above is a member of `ACTION_VERBS` (`packages/protocol/src/actions.ts:129-155`) and every parameter name matches its `ActionRequestSchema` member (`:192-251`), which is what makes `toParams`'s return typecheck against `ActionParams<V>`.

### 4.7 The Run script dialog, in detail

It is the only dialog with a nested schema-driven form, and it is what `RunScriptDialog.tsx` (1200 lines) reduces to.

- Script source: `fetchAllPages('/api/scripts', undefined, ScriptListItemSchema)` (plan 210 §4's `ScriptListItemSchema` carries `id`, `name` as `<plugin>/<script>`, `plugin`, `paramsSchema`, `hasResult`, `lastRun`). Fetched once when the dialog opens.
- Version pickers, "float on latest", param sets and the runtime override section are **not** carried over: MVP 03 §2 (restated in MVP 15 §1) removes script versions entirely, and `ScriptListItem` has no version field to pick.
- Params: `<SchemaForm schema={row.paramsSchema} value={params} onChange={setParams} onCanSubmitChange={setFormOk} />` from `components/schema-form/SchemaForm.tsx:152`, with **no** `onSubmit` prop so it renders no submit bar of its own; the dialog footer is the only button. `canSubmit` is `Boolean(scriptId) && formOk`.
- `Concurrency` (`0` meaning unlimited, then 1, 2, 4, 8) and `Order` (`as-listed`, `random`) map to `ActionRequestSchema`'s `concurrency` and `order` (`actions.ts:199-200`).
- `pacing` is not offered. `RunScriptDialog`'s repeat block existed to build a batch; plan 207 §1.2 makes every `run-script` a batch already, and a repeat control with no design in the handoff is not something this plan invents. Recorded in §11's "Observed, not done" for plan 217.
- The job-or-batch branch is not reintroduced. Plan 207 §4.9 already replaced `RunScriptDialog.tsx:829` `const useBatch = target !== 'single' || pacingActive` with one `runAction('run-script', …)` call; this dialog has no equivalent line and `rg -n "useBatch" packages/studio/src` must print nothing (§10.1).
- `onDone` navigates when the response names exactly one job: `results[0]?.jobId` present and `results.length === 1` pushes `/jobs/detail?id=${jobId}`; otherwise the outcome list stays, one row per device, each linking to its own job.
- "Run again" (MVP 14 §2) opens this dialog with `ctx` set from the job's target and `jobId` added to the params. `ActionRequestSchema`'s `run-script` member as written in plan 207 §4.1 carries no `jobId` field; §9 Q2 records that gap rather than inventing the field.

### 4.8 The Settings verb dialog

- Schema: `api('/api/settings', SettingsResponseSchema)` and read `deviceSchema`, which is `JsonSchemaNodeSchema` in the protocol (`packages/protocol/src/api/settings.ts:9`) and `z.toJSONSchema(DeviceSettingsSchema)` in the core (`packages/core/src/api/settings.ts:23`). No `as`-cast: `SettingsPopup.tsx:110`'s `b.deviceSchema as JsonSchemaNode` was redundant and is not carried over.
- Seed: with exactly one device resolved, `structuredClone(device.settings)`; otherwise `{}`, so a bulk apply writes only what the operator touches.
- Submit: `toParams` diffs the draft against the seed block by block and key by key and sends `{ settings: patch }`, where `patch` is a `DeviceSettingsPatch` (plan 207 §4.1's two-level partial, `actions.ts:175-183`). Never a spread of the whole object: plan 207 §4.2's `settings` row merges "only keys present in the patch, never a spread", and sending everything would overwrite each device's own values with the seed device's.
- `canSubmit` is `Object.keys(patch).length > 0`, computed on every change.
- The old `BulkPrepDialog`'s five per-key include switches are gone: an untouched field is simply absent from the patch, which is the same guarantee with no extra control. Its consequence sentence survives as the dialog's own line: `${k} setting(s) will be written to ${n} device(s). Nothing else changes.`

### 4.9 The host, the context, and the five entry points

`packages/studio/src/components/actions/ActionDialogHost.tsx` (new):

```tsx
/** Mounted ONCE, by `AppShell`. Every screen opens a dialog through `useActionDialogs()`. */
export function ActionDialogHost(): JSX.Element | null

export interface ActionDialogApi {
  /** Opens the dialog for `verb` with the target pre-filled. `prefill` seeds the verb's own draft (a script id, a package name). */
  open: (verb: ActionDialogVerb, ctx: TargetContext, prefill?: Record<string, unknown>) => void
}
export function useActionDialogs(): ActionDialogApi
```

- A module-level store (the same shape as plan 213's `lib/overlays.ts` registry: one `Map`, one subscriber list, no React context needed above `AppShell`), so `useActionDialogs()` works from any depth without a provider.
- On the first `open` of a session it fetches `fetchDevices()` and `fetchAllPages<GroupInfo>('/api/groups')`; while a dialog is open it subscribes to `ws.on` and merges `device.activity` through `applyActivityEvent` (plan 205 §4.11), `device.status`, `device.added` and `device.removed`. It unsubscribes on close. It never polls (§3.10).
- It renders at most one `<ActionDialog>`: opening a second verb replaces the first. That is what "no dialog opens another dialog" means in practice (G7).

Entry points, each a one-line handler:

| Entry point | File | Call |
|---|---|---|
| Devices bulk pill menu | plan 214's `components/devices/DevicesScreen.tsx` (the handler it passes to `BulkPill`/`ActionMenu`) | `open(verb, { deviceIds: [...selected] })` |
| Device Control Actions tab | plan 215's `DeviceControl` `onAction` prop, wired in `DevicesScreen` | `open(verb, { deviceIds: [focusId] })` |
| Device Control `[i]` popover Change button | the same `onAction('settings')` (plan 215 §4.9) | `open('settings', { deviceIds: [focusId] })` |
| Jobs detail "Run again" | `packages/studio/src/app/jobs/detail/page.tsx` | `open('run-script', targetOf(job), { scriptId: job.scriptId, params: job.params })` |
| Scripts detail and Plugins Run buttons | `app/scripts/detail/page.tsx:38`, `app/plugins/page.tsx:42` (today's `RunScriptDialog` importers) | `open('run-script', {}, { scriptId: row.id })` |

The group tab strip's own chip is **not** an entry point: plan 214 gives a group tab a right-click menu of Rename and Delete only, and a group is targeted by switching the picker to its Group mode.

### 4.10 `packages/studio/src/components/host/DevicePickerDialog.tsx` (new), replacing `DeviceWallWithPicker`

Same props, same behaviour, one control instead of a wall of live tiles (§3.7):

```tsx
export interface DevicePickerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Ids already chosen, shown selected and returned unchanged unless deselected. */
  value: string[]
  onConfirm: (ids: string[]) => void
  /** Optional filter, e.g. the plugin's own "not already assigned" rule. */
  filter?: (device: DeviceInfo) => boolean
  title?: string
}
export function DevicePickerDialog(props: DevicePickerDialogProps): JSX.Element
```

It fetches `fetchDevices()` itself on each open (exactly as `DeviceWallWithPicker.tsx:48-63` does, and for the same reason: a plugin passes no device list), drives one `useTarget({ devices, groups: [], initial: { deviceIds: value } })`, renders `<DevicePicker state={target} />` always expanded, and confirms with `Add ${n} device${n === 1 ? '' : 's'}` (`DeviceWallWithPicker.tsx:106`'s own label, kept). `components/host/index.ts:29` exports it in place of the old pair; `plugins/mikrotik-routing/src/enkaku-host.d.ts`'s `declare module '@enkaku/host'` block and `packages/sdk/src/cli/init.ts`'s `hostTypes()` scaffold (`:496-514`) are updated by hand, as both files' own comments instruct.

### 4.11 File structure

```
packages/studio/src/
  components/
    target/
      DevicePicker.tsx                NEW  §4.2 (Ships)
      useTarget.ts                    NEW  §4.3
      TargetPicker.tsx                DELETED
      useTargetSelection.ts           DELETED
    actions/
      ActionDialog.tsx                NEW  §4.4
      ActionOutcome.tsx               NEW  §4.5
      ActionDialogHost.tsx            NEW  §4.9
      verb-dialogs.tsx                NEW  §4.6 (the registry and the six field components)
      ActionResults.tsx               DELETED (plan 207's placeholder)
    host/
      DevicePickerDialog.tsx          NEW  §4.10
      DeviceWallWithPicker.tsx        DELETED
      index.ts                        CHANGED (one export, renamed)
    wall/                             DELETED (Wall, WallTile, TileGrid, TileSkeleton, tile-identity)
    bulk/
      OutcomeSummary.tsx              DELETED
      SkippedGroups.tsx               DELETED
      use-batch-report.ts             DELETED
      BatchResults.tsx                kept (plan 218 owns it)
    operations/                       DELETED (ReattachBanner, TransferProgressBar)
    command/                          DELETED (whatever plan 207 left: TargetPicker, target-preview)
    devices/action-set.ts             CHANGED or DELETED (§3.8)
    DevicePicker.tsx                  DELETED
    InstallBatchDialog.tsx            DELETED
    BulkTransferDialog.tsx            DELETED
    BulkPrepDialog.tsx                DELETED
    BulkForgetDialog.tsx              DELETED
    ForgetDeviceDialog.tsx            DELETED
    DisconnectDeviceDialog.tsx        DELETED
    RunScriptDialog.tsx               DELETED
    ScheduleEditorDialog.tsx          DELETED
    AskAnAgentDialog.tsx              DELETED
    device/BulkCutoverDialog.tsx      DELETED
    device/CutoverDialog.tsx          DELETED
    network/BulkProxyDialog.tsx       DELETED
    shell/AppShell.tsx                CHANGED (mount ActionDialogHost, one line)
  lib/
    operations.ts                     DELETED
    labelling.ts                      DELETED (§5 step 216.8)
  app/
    schedules/                        DELETED (§3.4)
    jobs/detail/page.tsx              CHANGED (Run again)
    scripts/detail/page.tsx           CHANGED (Run button)
    plugins/page.tsx                  CHANGED (Run button)
packages/ui/src/
  components/device-picker.tsx        DELETED
  components/device-picker.test.tsx   DELETED (if plan 201 left it)
  index.ts                            CHANGED (drop the device-picker export)
packages/sdk/src/cli/init.ts          CHANGED (hostTypes: DevicePickerDialog)
plugins/mikrotik-routing/
  src/ui/parts/groups.tsx             CHANGED
  src/enkaku-host.d.ts                CHANGED
  src/index.ts                        CHANGED (version 0.14.0 + changelog)
  src/index.test.ts                   CHANGED (version assertion)
  package.json                        CHANGED (version 0.14.0)
scripts/check-routes.ts               CHANGED (prune '/schedules')
```

## 5. Implementation steps

Every step: read the file before editing, match on the quoted content, run only what that step names. Steps 216.1 and 216.2 come first; the rest depend on both.

### 216.1 `useTarget`

- Files created: `packages/studio/src/components/target/useTarget.ts` (§4.3, complete, including the eight numbered rules as code).
- Files changed: none.
- Files deleted: none.
- Test file: none (Studio has zero tests, plan 200 §8.3).
- Verifiable result: `bun run typecheck` clean.
- Do not: add a fleet-wide typed confirmation. `useTargetSelection.ts:159-160`'s `fleetWide`/`fleetConfirm` guarded `POST /api/batches`; plan 207's per-device response and the picker's own visible count replace it, and a second confirmation over the button's own count is the "no count without names" problem inverted.

### 216.2 `DevicePicker`

- Files created: `packages/studio/src/components/target/DevicePicker.tsx` (§4.2, complete: `DevicePicker`, `Chip`, `DeviceMode`, `GroupMode`, `TagMode`, `activitySentence`).
- Files changed: none.
- Files deleted: none.
- Test file: none.
- Verifiable result: `bun run typecheck` clean; `rg -n -e "\[--color" -e "\bdark:" -e "#[0-9a-fA-F]{3,8}\b" packages/studio/src/components/target` prints nothing (G14).
- Do not: render a `<Label>`, a heading, or a helper paragraph above the collapsed row. MVP 07 §2.1: "No helper text, no description, no section heading above it." Do not give the container a full `border`; it has exactly one, `border-b border-line`, which is the divider between it and the form.

### 216.3 The shell and the outcome renderer

- Files created: `packages/studio/src/components/actions/ActionDialog.tsx` (§4.4), `packages/studio/src/components/actions/ActionOutcome.tsx` (§4.5).
- Files changed: none.
- Files deleted: `packages/studio/src/components/actions/ActionResults.tsx` (plan 207 §4.9's placeholder; if plan 207 left importers, they are rewritten in this step).
- Test file: none.
- Verifiable result: `bun run typecheck` clean; `rg -n "ActionResults" packages/studio/src` prints nothing.
- Do not: put the picker inside the scrolling form container. The form scrolls (`max-h-[46dvh] overflow-y-auto`); the picker does not, because "the same container at the same position" fails the moment it can scroll out of view.

### 216.4 The fifteen verb dialogs

- Files created: `packages/studio/src/components/actions/verb-dialogs.tsx` (§4.6's registry plus the six field components: install, adb, run-script, push, clear-cache, settings; the other nine have `Fields: null` and a `note`).
- Files changed: none.
- Files deleted: none.
- Test file: none.
- Verifiable result: `bun run typecheck` clean; `rg -c "verb: '" packages/studio/src/components/actions/verb-dialogs.tsx` prints `15` (G4).
- Do not: give `set-network` an `op: 'set'` branch with host, port, UDP and credential fields. `BulkProxyDialog.tsx:292-489` is sixteen controls above its picker and MVP 15 §1 puts route composition in the plugin views. Do not reintroduce `RunScriptDialog`'s version `Select` (`:986`) or its param-set picker (`:1148`): scripts have no version in the MVP (MVP 03 §2).

### 216.5 The host and the entry points

- Files created: `packages/studio/src/components/actions/ActionDialogHost.tsx` (§4.9).
- Files changed: `packages/studio/src/components/shell/AppShell.tsx` (mount `<ActionDialogHost />` beside plan 213's `<Toaster position="bottom-right" richColors closeButton />`, one line, additive per plan 200 §8.1); `packages/studio/src/components/devices/DevicesScreen.tsx` (the bulk-menu handler and Device Control's `onAction` both become `open(verb, …)`); `packages/studio/src/app/jobs/detail/page.tsx`, `packages/studio/src/app/scripts/detail/page.tsx`, `packages/studio/src/app/plugins/page.tsx` (replace the `RunScriptDialog` import and its JSX with `useActionDialogs().open('run-script', …)`).
- Files deleted: none.
- Test file: none.
- Verifiable result: `bun run typecheck` clean; `rg -n "RunScriptDialog" packages/studio/src` prints nothing.
- Do not: mount a second `ActionDialogHost` on a screen. One per document; `AppShell` owns it.

### 216.6 The generic action set, reconciled

- Files created: none.
- Files changed: whichever of `packages/studio/src/lib/generic-actions.ts` and `packages/studio/src/components/devices/action-set.ts` survives the merge (§3.8): delete the `needsDialog` and `submenu` fields from its item type and from every row, and add the three overflow entries behind an `overflow: true` flag, using three icons that are already in plan 204 §4.5's barrel and not already taken by the twelve: `{ verb: 'prepare', label: 'Prepare', icon: PackageIcon, overflow: true }`, `{ verb: 'set-label', label: 'Label', icon: PencilSimpleIcon, overflow: true }`, `{ verb: 'set-network', label: 'Network', icon: BroadcastIcon, overflow: true }`; `components/devices/ActionMenu.tsx` (drop the `aria-disabled` / `title="Opens a dialog (plan 216)"` / `ROW_OFF` branch and the nested group submenu; render the overflow entries under a `border-t border-line` separator).
- Files deleted: the losing copy of the twelve-row list.
- Test file: none.
- Verifiable result: `rg -n "needsDialog\|Opens a dialog" packages/studio/src` prints nothing; `rg -rl "Install apk" packages/studio/src` prints exactly one file.
- Do not: keep both lists "until 217". Two copies of the same twelve rows is the defect both plan 214 §4.12 and plan 215 §10.2 exist to prevent.

### 216.7 The plugin picker and the plugin bump

- Files created: `packages/studio/src/components/host/DevicePickerDialog.tsx` (§4.10).
- Files changed: `packages/studio/src/components/host/index.ts` (`:29` becomes `export { DevicePickerDialog, type DevicePickerDialogProps } from './DevicePickerDialog'`); `packages/sdk/src/cli/init.ts` (`:496-514`'s `declare module '@enkaku/host'` block); `plugins/mikrotik-routing/src/enkaku-host.d.ts` (the same block); `plugins/mikrotik-routing/src/ui/parts/groups.tsx` (`:34` `import { DeviceWallWithPicker } from '@enkaku/host'` becomes `import { DevicePickerDialog } from '@enkaku/host'`; `:623-630` the element; `:430`/`:448`/`:624-625` rename `wallOpen`/`setWallOpen` to `pickerOpen`/`setPickerOpen`; the comments at `:161`, `:182`, `:422-427`, `:431`, `:459-461` and `:583-587` that say "wall picker" are reworded, and the owner's verbatim quote at `:601-610` is **moved**, unchanged, into the `0.13.0 → 0.14.0` changelog entry in `src/index.ts` rather than deleted, so the design history survives where changelog entries live); `plugins/mikrotik-routing/package.json:3`, `plugins/mikrotik-routing/src/index.ts:429` and the changelog block above it, `plugins/mikrotik-routing/src/index.test.ts:19` (all three `0.13.0` → `0.14.0`).
- Files deleted: `packages/studio/src/components/host/DeviceWallWithPicker.tsx`.
- Test file: `plugins/mikrotik-routing/src/index.test.ts`.
- Verifiable result: `bun test plugins/mikrotik-routing/src/index.test.ts` passes; then `bun run build:packs`; `rg -n "DeviceWallWithPicker" packages plugins` prints nothing.
- Do not: rebuild the packs without bumping the version. `CLAUDE.md`: `seedEmbeddedPacks` keys on `${name}@${version}` and a rebuilt bundle at an unchanged version never reaches a farm that has already run. Do not forget that the seeded version is staged, not activated: say so in §11.

### 216.8 The deletions

- Files created: none.
- Files changed: `packages/ui/src/index.ts` (delete `:32` `export * from './components/device-picker'`); `scripts/check-routes.ts` (delete the `'/schedules'` row of `PENDING_REMOVAL`, whose text plan 213 §4.10 gives as `'plan 217: third tab of Scripts & workflows (MVP 15 §0.1.1)'`).
- Files deleted, in this order so each `rg` proof can be run as it lands:
  1. `components/InstallBatchDialog.tsx`, `components/BulkTransferDialog.tsx`, `components/BulkPrepDialog.tsx`, `components/BulkForgetDialog.tsx`, `components/device/BulkCutoverDialog.tsx`, `components/network/BulkProxyDialog.tsx`, `components/device/CutoverDialog.tsx`, `components/ForgetDeviceDialog.tsx`, `components/DisconnectDeviceDialog.tsx`, `components/RunScriptDialog.tsx`, `components/AskAnAgentDialog.tsx`.
  2. `components/ScheduleEditorDialog.tsx` and `app/schedules/` (whole directory, `page.tsx` and `detail/page.tsx`).
  3. `components/target/TargetPicker.tsx`, `components/target/useTargetSelection.ts`, `components/command/` (whatever plan 207 left of it), `components/DevicePicker.tsx`, `packages/ui/src/components/device-picker.tsx`.
  4. `lib/operations.ts`, `components/operations/ReattachBanner.tsx`, `components/operations/TransferProgressBar.tsx` and the now-empty `components/operations/` directory.
  5. `components/bulk/OutcomeSummary.tsx`, `components/bulk/SkippedGroups.tsx`, `components/bulk/use-batch-report.ts` (leaving `BatchResults.tsx` for plan 218).
  6. `lib/labelling.ts` (its only two importers, `app/page.tsx:81` and `components/device-popup/ActionsList.tsx:57`, are deleted by plans 214 and 215; the `set-label` dialog calls `runAction` directly and needs none of `summariseLabelApply`, `setWallpaperLabelMode` or `setNumberAsWallpaper`). If `rg -n "lib/labelling" packages/studio/src` still shows an importer, keep the file, delete only `summariseLabelApply` and its two `components/bulk` type imports, and say so in §11.
  7. `components/wall/Wall.tsx`, `WallTile.tsx`, `TileGrid.tsx`, `TileSkeleton.tsx`, `tile-identity.ts` and the now-empty `components/wall/` directory.
- Test file: none.
- Verifiable result: every row of §10.1 passes; `bun run typecheck` clean; `bun run scripts/check-routes.ts` exits 0 (G10).
- Do not: delete `components/bulk/BatchResults.tsx` (plan 218's), `components/ArtifactPicker.tsx` (the install and upload dialogs use it), `packages/ui/src/lib/device-name.ts` or `components/device-name.tsx` (`matchesDeviceQuery` and `DeviceName` are what the new picker searches and renders with), or `components/AdbRestartDialog.tsx` / `AppRestartDialog.tsx` / `EnrollmentDialog.tsx` (§3.3).

### 216.9 Sweep and report

- Files created: none.
- Files changed: whatever `bun run typecheck` names.
- Files deleted: none.
- Test file: none.
- Verifiable result: `bun run typecheck` clean; every §10 grep run once and pasted into §11; `ps -Ao pid=,command= | grep -i "[o]penpf"` shows nothing.
- Do not: run `bun test` bare, or two test invocations at once (`CLAUDE.md`).

## 6. Acceptance criteria

1. `packages/studio/src/components/target/DevicePicker.tsx` and `useTarget.ts` exist; no other file in the workspace defines a component named `DevicePicker` or a hook named `useTarget` (G1, G9).
2. `ActionDialog.tsx` is the only dialog file that renders the picker, and it renders it as the immediate next child after `DialogHeader`, with `DialogContent` carrying `p-0 gap-0` so nothing sits between them (G2, G3).
3. The picker container is `bg-panel-2` with `border-b border-line`; the form container is `bg-panel` with no border; collapsed, the picker band is 54 px in every dialog (G3, owner).
4. Fifteen verb dialogs exist, each naming one `ACTION_VERBS` member, with the twelve of the handoff's generic action set in its order plus Prepare, Label and Network in the overflow (G4).
5. A `warned` device shows its policy sentence on its own chip; the primary button reads `Continue for N devices` and the second request carries `force: true` (G5, owner).
6. A target whose every device came back `forbidden` disables the primary button (G6, owner).
7. No verb dialog opens another dialog for any reason (G7).
8. The twelve dialogs, both old target pickers, `target-preview.ts`, `useTargetSelection.ts`, `components/DevicePicker.tsx`, `@enkaku/ui`'s `device-picker.tsx`, `lib/operations.ts` with `components/operations/`, three `components/bulk/` files and the five `components/wall/` files are gone, with `check-routes.ts` pruned (G8, G9, G10).
9. `mikrotik-routing` is at `0.14.0` in all three places, its group editor uses `DevicePickerDialog`, and `bun run build:packs` has been run (G11).
10. `bun run typecheck` is clean and the vocabulary and token greps print nothing (G12, G13, G14).

## 7. Test plan

Studio and `@enkaku/ui` have zero tests (plan 200 §8.3). This plan writes none and adds none to §7. Nothing in it belongs on the backend critical list of §8.3: it introduces no schema, no route, no migration and no queue behaviour.

### 7.1 Commands, one at a time, never concurrently

```bash
bun run typecheck
bun test plugins/mikrotik-routing/src/index.test.ts     # the only test file this plan touches
bun run scripts/check-routes.ts
bun run scripts/check-design-tokens.ts                  # plan 204's token gate
bun run build:packs
```

### 7.2 The removal greps

Every command in §10.1's Proof column, plus §10.3's three named greps, run once from the repo root. Any output blocks the plan.

### 7.3 Owner smoke, on the farm, at the wave-3 gate

Run `bun run dev` and `bun run dev:studio`, open `http://localhost:3001`, and follow these in order. Steps 4 and 5 are the itemised per-dialog check G3 names.

1. **The bulk menu.** Select three devices. Open the pill's 226 px menu: twelve rows in the handoff's order, none disabled, none carrying `Opens a dialog (plan 216)`, `Move group` opening no submenu, then a `border-t` and three more rows (Prepare, Label, Network).
2. **Pre-fill from a selection.** Click `Run script`. The dialog opens with the picker collapsed reading `3 devices` and the script field empty below the divider.
3. **Edit in place.** Choose a script, fill two parameters, then expand the picker, switch to `Group`, pick a group, collapse it. The summary reads `<group> · N devices` and **both parameter values are still there**. Switch back to `Devices`: the three original chips are gone (the mode changed the target), the parameters are still there.
4. **The container, per dialog.** Open each of the fifteen dialogs in turn from the bulk menu with one device selected. For each: the picker is the first thing under the title with no text between them; its background is visibly different from the form's; there is one horizontal rule between them; collapsed, the band measures 54 px in the browser inspector. Tick each of the fifteen off by name.
5. **The same container from Device Control.** Double-click a device to open Device Control, go to the Actions tab, click `Install apk`. The same dialog, the same picker band at the same height, pre-filled with that one device.
6. **Warn and force.** With a script running on device A, select A and B and run `Adb command` with `getprop ro.serialno`. A comes back `warned` with the policy sentence on its chip; the button reads `Continue for 1 device`. Click it: the request goes out with `force: true` (check the Network tab) and A runs.
7. **Forbidden only.** With a script running on A, select only A and run `Install apk`. Every result is `forbidden` with `E_DEVICE_CONFLICT`; the button is disabled and stays disabled while that target is chosen.
8. **The outcome list.** Run `Screenshot` on three devices: three rows, each with a status badge and a download link.
9. **Run again.** Open a finished job on the Jobs detail page and click `Run again`: the Run script dialog opens with the job's target pre-filled and its parameters seeded.
10. **The plugin picker.** Open the mikrotik-routing group editor, click `Add devices…`, tick three devices, confirm: three entries appear. (Only after the operator activates `mikrotik-routing@0.14.0` on the Plugins page: the seeded version is staged, not activated.)
11. **Escape.** With a dialog open, press Escape once: the dialog closes and the device selection underneath is untouched (plan 213's tiering).

No step needs a physical device beyond the farm the owner already runs; nothing here is gated behind `ENKAKU_TEST_DEVICE=1`.

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Plans 215, 216, 217 and 218 are all stage 6 and this plan edits files 214 and 215 created | Plan 200 §8.1 merges within a stage by number, so 214 and 215 are already on `mvp` when this starts. Step 216.6 greps for whichever action-set file survived rather than assuming (§3.8), and step 216.5's `AppShell` edit is one additive line |
| Deleting `app/schedules/` takes a route plan 217 was told it owned | The route is already a `PENDING_REMOVAL` debt with 217 named; this plan removes the debt early because its dialog's only picker is going. 217 then builds the Schedules tab under `/scripts` with nothing to unpick. Flagged to the CTO in §11 |
| Deleting `RunScriptDialog` removes the runtime override section and the repeat/pacing controls with no replacement | Both are outside the handoff's design and outside MVP 07's verb list. `pacing` stays in `ActionRequestSchema` (plan 207 §4.1) so nothing on the server regresses; the control is recorded in §11's "Observed, not done" for plan 217 |
| The plugin loses the live-tile picker the owner asked for by name (plan 129 §0.4) | Stated openly, not silently: §3.7 and the changelog entry both say the Screens view is now where a device is chosen by looking at its screen. If the owner disagrees, the wall files are one revert away and `DevicePickerDialog`'s props are the old ones |
| `ActionDialogHost` fetching its own device list drifts from the Devices screen's | It re-fetches on every first open of a session and follows the same push messages through the same `applyActivityEvent`; a stale row costs one wrong chip label, never a wrong target, because the target is ids and the server resolves them again |
| A 500-device target makes the outcome list unusable | `ActionOutcome` caps at 50 rows with a `… and N more` line (§4.5) |
| Fifteen dialogs is more surface than the handoff drew | Twelve are the handoff's own list and nine of the fifteen have no fields at all: their whole body is one sentence. The registry is one file |

## 9. Open questions

1. **`EnrollmentDialog`.** Plan 214 §9 Q5 asks whether the unauthorized-phone dialog becomes a card in the discovery sheet, a status-bar alert, or stays a dialog on the Devices screen. Plan 200 §2.1 forbids deciding it here, so this plan leaves the file and its mount alone and §10.2 hands it to plan 219 or 220. Decider: CEO. Nothing else in this plan depends on the answer.
2. **`jobId` on `run-script`.** MVP 14 §2 says "Run again ... is the same verb ... with `jobId` set, which tells the core to add a run instead of creating a job", and plan 215 §4.12 already writes `runAction('run-script', { deviceIds: [deviceId] }, { jobId })`. Plan 207 §4.1's `run-script` member has no `jobId` field (`actions.ts:194-204`), so that call does not typecheck as written. Until the field exists, the Jobs "Run again" entry point in §4.9 opens the dialog with the job's target and parameters pre-filled and creates a **new** job. Decider: whoever owns runs, plan 211 or 218. Everything else in §4.7 executes either way.
3. **Whether `set-network` needs a route composer at all.** §4.6 row 15 offers only enable, disable, retry and clear, on the reading that route composition belongs to the proxy-manager and mikrotik-routing views (MVP 15 §1). If an operator with neither plugin installed must still set a proxy, this dialog needs the `op: 'set'` fields back. Decider: CEO.

## 10. Removed

### 10.1 Removed by this plan

| What | Where it was | Proof |
|---|---|---|
| The install-batch dialog | `packages/studio/src/components/InstallBatchDialog.tsx` (305 lines) | `test ! -e packages/studio/src/components/InstallBatchDialog.tsx` exits 0 |
| The bulk push/pull dialog | `packages/studio/src/components/BulkTransferDialog.tsx` (305 lines) | `test ! -e packages/studio/src/components/BulkTransferDialog.tsx` exits 0 |
| The bulk prep dialog and its five include switches | `packages/studio/src/components/BulkPrepDialog.tsx` (579 lines) | `test ! -e packages/studio/src/components/BulkPrepDialog.tsx` exits 0 |
| The bulk forget dialog | `packages/studio/src/components/BulkForgetDialog.tsx` (170 lines) | `test ! -e packages/studio/src/components/BulkForgetDialog.tsx` exits 0 |
| The bulk cutover dialog | `packages/studio/src/components/device/BulkCutoverDialog.tsx` (278 lines) | `test ! -e packages/studio/src/components/device/BulkCutoverDialog.tsx` exits 0 |
| The bulk proxy dialog and its sixteen route fields | `packages/studio/src/components/network/BulkProxyDialog.tsx` (528 lines) | `test ! -e packages/studio/src/components/network/BulkProxyDialog.tsx` exits 0 |
| The single-device cutover dialog | `packages/studio/src/components/device/CutoverDialog.tsx` (335 lines) | `test ! -e packages/studio/src/components/device/CutoverDialog.tsx` exits 0 |
| The single-device forget dialog | `packages/studio/src/components/ForgetDeviceDialog.tsx` (186 lines) | `test ! -e packages/studio/src/components/ForgetDeviceDialog.tsx` exits 0 |
| The single-device disconnect dialog | `packages/studio/src/components/DisconnectDeviceDialog.tsx` (152 lines) | `test ! -e packages/studio/src/components/DisconnectDeviceDialog.tsx` exits 0 |
| The run-script dialog, with `useBatch`, the version select and the param-set picker | `packages/studio/src/components/RunScriptDialog.tsx` (1200 lines; `:829` `const useBatch = target !== 'single' \|\| pacingActive`) | `test ! -e packages/studio/src/components/RunScriptDialog.tsx` exits 0; `rg -n "useBatch" packages/studio/src` prints nothing |
| The schedule editor dialog and the `/schedules` route (§3.4) | `packages/studio/src/components/ScheduleEditorDialog.tsx` (927 lines), `packages/studio/src/app/schedules/` | `test ! -e packages/studio/src/components/ScheduleEditorDialog.tsx && test ! -d packages/studio/src/app/schedules` exits 0 |
| The ask-an-agent dialog (zero importers after plan 215 deletes `DeviceHeader.tsx` and `device-popup/`) | `packages/studio/src/components/AskAnAgentDialog.tsx` (170 lines) | `test ! -e packages/studio/src/components/AskAnAgentDialog.tsx` exits 0 |
| Both old target pickers and their models | `packages/studio/src/components/target/TargetPicker.tsx`, `useTargetSelection.ts`, `packages/studio/src/components/command/` | §10.3 `GREP_216_PICKER` prints only the two new files; `test ! -d packages/studio/src/components/command` exits 0 |
| The Studio device-picker wrapper and the shared list picker | `packages/studio/src/components/DevicePicker.tsx`, `packages/ui/src/components/device-picker.tsx` | `test ! -e packages/studio/src/components/DevicePicker.tsx && test ! -e packages/ui/src/components/device-picker.tsx` exits 0 |
| The client-side operations aggregator and its two banners | `packages/studio/src/lib/operations.ts` (735 lines), `packages/studio/src/components/operations/ReattachBanner.tsx`, `TransferProgressBar.tsx` | `test ! -e packages/studio/src/lib/operations.ts && test ! -d packages/studio/src/components/operations` exits 0 |
| The batch report helpers | `packages/studio/src/components/bulk/OutcomeSummary.tsx`, `SkippedGroups.tsx`, `use-batch-report.ts` | `rg -n "OutcomeSummary\|SkippedGroups\|useBatchReport\|batchOutcomeCounts\|batchOutcomeGroups" packages/studio/src` prints nothing |
| The labelling helper module | `packages/studio/src/lib/labelling.ts` | `test ! -e packages/studio/src/lib/labelling.ts` exits 0 (or the reduced-file note of step 216.8) |
| The five wall files and the live-tile plugin picker | `packages/studio/src/components/wall/`, `packages/studio/src/components/host/DeviceWallWithPicker.tsx` | `test ! -d packages/studio/src/components/wall` exits 0; `rg -n "DeviceWallWithPicker" packages plugins` prints nothing |
| Plan 207's placeholder outcome list | `packages/studio/src/components/actions/ActionResults.tsx` | `rg -n "ActionResults" packages/studio/src` prints nothing |
| The `needsDialog` interim and its title | plan 214 §4.12's `ActionSetItem.needsDialog`, `ActionMenu.tsx`'s `ROW_OFF` branch | `rg -n "needsDialog\|Opens a dialog" packages/studio/src` prints nothing |
| The second copy of the generic action set (§3.8) | `packages/studio/src/components/devices/action-set.ts` or `packages/studio/src/lib/generic-actions.ts` | `rg -l "Install apk" packages/studio/src` prints exactly one path |
| The `/schedules` row of `PENDING_REMOVAL` | `scripts/check-routes.ts` | `rg -n "'/schedules'" scripts/check-routes.ts` prints nothing; `bun run scripts/check-routes.ts` exits 0 |
| Forbidden vocabulary in this plan's new files and copy | `components/target/`, `components/actions/`, `components/host/` | §10.3 `GREP_216_VOCAB` prints nothing |

### 10.2 Deletions this plan owes to a later one (owners, not proofs)

| What | Last consumer today | Deleted by |
|---|---|---|
| `components/AdbRestartDialog.tsx`, `AdbServerCard.tsx`, `AppRestartDialog.tsx`, `AppRestartCard.tsx` | `app/tools/page.tsx:8-9`. `AdbRestartDialog` is the audited entry point to `cycle()` (§3.3); it must be rebuilt on the Settings Toolchain section, never simply removed | plan 219 |
| `components/EnrollmentDialog.tsx` | plan 214's Devices screen (§9 Q1) | plan 219 or 220, once the CEO answers plan 214 §9 Q5 |
| `components/bulk/BatchResults.tsx` and the now-single-file `components/bulk/` directory | `app/batches/detail/page.tsx:46` | plan 218 |
| `app/nodes/` | `scripts/check-routes.ts`'s `PENDING_REMOVAL` | plan 224, unless a cloud plan claims it |
| `theme.css` block D and `globals.css`'s `@layer components` block | the screens plans 217 to 220 replace | the last of plans 217 to 220 |

### 10.3 The greps

Fenced, not tabled: a regex alternation cannot carry an unescaped pipe inside a Markdown table cell.

```bash
# GREP_216_PICKER: exactly one picker and one target hook define themselves in the tree.
# The `\b` matters: without it, `export function DevicePickerDialog` in the host wrapper
# (§4.10) matches the first pattern and the grep prints three files instead of two.
# Expected output, and nothing else:
#   packages/studio/src/components/target/DevicePicker.tsx
#   packages/studio/src/components/target/useTarget.ts
rg -l -e "export function DevicePicker\b" -e "export function useTarget\b" packages plugins

# and neither of the deleted models is referenced anywhere:
rg -n -e "useTargetSelection" -e "computeDefaultTarget" -e "target-preview" -e "computeTargetPreview" \
      -e "SingleDeviceNotice" -e "components/command/TargetPicker" packages plugins scripts

# GREP_216_DIALOGS: the twelve deleted dialogs have no reference left anywhere.
rg -n -e "InstallBatchDialog" -e "BulkTransferDialog" -e "BulkPrepDialog" -e "BulkForgetDialog" \
      -e "BulkCutoverDialog" -e "BulkProxyDialog" -e "CutoverDialog" -e "ForgetDeviceDialog" \
      -e "DisconnectDeviceDialog" -e "RunScriptDialog" -e "ScheduleEditorDialog" -e "AskAnAgentDialog" \
      -e "AdbCommandDialog" -e "AdmitDeviceDialog" -e "ScanNetworkDialog" \
      packages plugins scripts

# GREP_216_VOCAB: plan 200 §2.4's forbidden words, plus "console" (MVP 15 §0.1.4), "wall" and
# "bulk twin", in this plan's own new directories. `wall` has no allowed use in them at all: the
# video profile name (`quality="wall"`) belongs to plan 214's Screens card and plan 215's cast,
# neither of which is in these paths. Expected output: nothing.
rg -n -i -e "\blease" -e "\bcluster" -e "\bholder" -e "\bassist" -e "co-control" -e "\bgrant\b" \
      -e "\bconsole\b" -e "\bwall\b" -e "bulk twin" -e "per-device route" -e "device popup" \
      packages/studio/src/components/target packages/studio/src/components/actions \
      packages/studio/src/components/host

# The plugin file is checked NARROWLY, not by the vocabulary list. `groups.tsx` carries the
# owner's own verbatim Indonesian request at `:601-610` ("...kaya walls gitu..."), a design-history
# record step 216.7 MOVES into `src/index.ts`'s changelog block rather than deletes; a blanket
# `\bwall\b` over that file would demand erasing it. What must be gone is the identifier, the
# import and the working comments. Expected output: nothing.
rg -n -e "DeviceWallWithPicker" -e "wallOpen" -e "wall picker" plugins/mikrotik-routing/src
```

### 10.4 Re-proved here, deleted by a sibling plan

These rows belong to the wave-3 removal gate (plan 200 §6) and are re-run from this plan because MVP 13 A.5 lists them beside the twelve above. Each is expected to already pass when this plan starts.

| What | Deleted by | Proof |
|---|---|---|
| `AdmitDeviceDialog`, `device/ScanNetworkDialog` | plan 214 §10.1 | `test ! -e packages/studio/src/components/AdmitDeviceDialog.tsx && test ! -e packages/studio/src/components/device/ScanNetworkDialog.tsx` exits 0 |
| `device-popup/AdbCommandDialog` with `ConfirmFanout` and `RunReport` | plan 215 §10.1 | `test ! -d packages/studio/src/components/device-popup` exits 0 |
| `components/command/target-preview.ts` and `components/command/TargetPicker.tsx` | plan 207 §4.11 lists `components/command/` as deleted; if any file survives, this plan deletes it (step 216.8) | `test ! -d packages/studio/src/components/command` exits 0 |

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
