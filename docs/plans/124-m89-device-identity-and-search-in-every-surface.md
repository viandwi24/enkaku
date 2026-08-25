# Plan 124 — M89 : The device number in every surface, and a search box in every device list

> Status: implemented — steps 124.1–124.9 all land, 2026-08-25. `formatDeviceName`/`DeviceName`/`Combobox` ship in `@enkaku/ui`; the number reaches every surface §4.4 catalogued, in Studio and in both plugin UIs; searchable comboboxes and table filters replace the fleet-sized `Select`s; **Set number as wallpaper** is one press from the device popup and from the selection toolbar, reporting `partial`/`unavailable` verbatim; and `applyLabelsToSelected` no longer counts a `mode: 'off'` device as a success. **Two things this plan changed beyond its own §4.4 catalogue, both found during execution and both real defects**: the devices page's own search box — the most-used search in the product — could not find `#7` at all, and `AdbRestartReport.reattachFailed` had no number on the wire (a payload §3.7 missed by conflating it with the adb pool stats). Both fixed, both with regression tests. **Not verified on hardware**: no device was attached, so the wallpaper action's `partial`/`unavailable` branches remain as unproven as plan 89 §5 step 89.10 left them — the code fails closed and never reports a state it did not receive, but that a real OEM skin accepts the write is still untested. §9 Q3 (a `search` prop on `PaginatedTable` for the six paginated list pages that name no device) is deliberately left open.
> Depends on: plan 89 (M54) — which built `device_numbers`, `DeviceInfo.number`, `formatDeviceLabel()`, the physical-labelling service and the guest agent's `screen-label` facet. **Every mechanism this plan needs already exists; plan 89's own step 89.3 ("the number and the name in Studio") is simply not true of most of the UI.** Plan 111 (M76) for the plugin React UI surface, plan 103 (M68) for the device popup's `ActionsList`, plan 122 (M87) for the Mikrotik plugin.
> Spec references: §7.5 (device identity, `device_numbers`), §19 Dashboard and Device detail rows (which already claim "every list, tile, card, header, and picker" renders the number), §7.5's "Physical labelling" paragraph.
> Ships: packages/ui/src/lib/device-name.ts

An operator standing in front of a rack of 45 physically identical phones cannot use a UI that names devices `SM-F721U1, SM-F721U1, SM-F721U1`. The number exists precisely so that they can. Today it reaches four render sites out of roughly seventy, no plugin table shows it at all, and the one dropdown that lists the whole fleet — Mikrotik → Groups → "Add a device…" — is an unsearchable Radix `Select` showing bare labels.

---

## 0. Evidence

Four read-only sweeps of `packages/studio/src`, `packages/ui/src`, `plugins/*/src/ui` and `packages/core/packs/*-ui`, 2026-08-25.

### 0.1 The number reaches four places

`formatDeviceLabel(number, label)` exists — `packages/core/src/registry/device-number.ts:93`, `number === null ? label : '#' + number + ' ' + label` — and is used **server-side only** (`api/devices.ts:1412`, `:1556`). There is no Studio-side equivalent, so every web surface hand-composes, and the rule drifted.

Correct today: `DevicePicker.tsx:227`, `DeviceCard.tsx:141`, `wall/WallTile.tsx:358`, `device/DeviceHeader.tsx:372`.

Wrong today: ~70 render sites, catalogued in §4.2. Highlights, because they are the ones an operator hits hourly:

- `wall/DeviceContextMenu.tsx:189` — the right-click menu header and its `aria-label`.
- `device-popup/DevicePopup.tsx:353` — the focused-control panel header.
- `ForgetDeviceDialog.tsx:118` — `Forget {device.label}?`, the single most destructive confirm in the product, naming one of three identically-labelled phones.
- `operations/OperationTray.tsx:99` — the farm-wide tray, visible on every screen.
- `topology/DeviceTile.tsx:56` — the fleet map, whose sibling `WallTile` gets it right.
- `AdmitDeviceDialog.tsx:157-158` — the two halves of ONE ternary disagree: the success branch says `Added as #7 Galaxy A15`, the fallback says `Galaxy A15 added to the farm`.

### 0.2 One device dropdown in the whole repo bypasses `DevicePicker`, and it is the worst one

`plugins/mikrotik-routing/src/ui/parts/groups.tsx:266-275` — the "Add a device…" `Select` inside the group editor. Every enrolled device, `{d.label || d.stableId}`, `w-56`, no search, no number. Radix `Select` has no type-ahead filtering, only single-keystroke jump. On the owner's own farm this is a 45-item scroll hunt through repeated model names.

It is not only a JSX problem: `FleetDeviceRowSchema` (`plugins/mikrotik-routing/src/ui/parts/api.ts:300`) has no `number` field, and the server that builds those rows (`service/apply.ts:181`) reads a real `DeviceInfo` and drops `number` on the floor. The number is not on the wire.

Everything else in Studio that *selects* a device correctly routes through `DevicePicker` (which has both a search box and the number). The remaining offenders are full-fleet **tables and checkbox lists** that list every device with neither.

### 0.3 The searchable primitive is already in the repo, in the wrong package

`packages/ui/package.json` depends on `cmdk ^1.1.1`; `packages/ui/src/components/command.tsx` exports the full `Command`/`CommandInput`/`CommandList`/`CommandItem` set and `popover.tsx` exports `Popover`/`PopoverContent`. There is exactly one consumer in the entire repo — `packages/studio/src/components/agent/ModelCombobox.tsx`, whose own header says it replaced a `<Select>` over a `.map()` because "a connector can return dozens of model ids, and a native select over that is a scroll hunt with no way to type-to-find."

That reasoning is a farm of 45 modems and 100 phones, word for word. But `ModelCombobox` lives in `packages/studio`, and a plugin UI can only import `@enkaku/ui` — which is why the Mikrotik and Proxy Manager tabs could not have used it even if someone had thought to.

### 0.4 The black wallpaper already works. It takes six clicks and two nested dialogs.

`apps/guest-agent/.../label/LabelRenderer.kt:55` draws `Color.BLACK` and centres the number; `WallpaperFacet.kt:88,92` sets it on `FLAG_SYSTEM` and `FLAG_LOCK`. `LabellingService` (`packages/core/src/device/labelling.ts`) and four REST routes drive it. None of that is missing.

What is missing is the way in. Today: device tile → popup → **Settings** row → the *tenth* section of the settings dialog's left nav → change `mode` to Wallpaper → **Save changes** → *then* **Re-apply label** (which is `disabled` while `dirty`, so the two presses cannot be merged). `ActionsList.tsx:208-219` and `wall/DeviceContextMenu.tsx:104` both record, in their own comments, that no labelling row exists.

And the fleet-wide button is a trap: `applyLabelsToSelected` (`app/page.tsx:332`) applies **each device's own current mode**. On a farm where every device is `mode: 'off'` — the default — pressing "Apply labels" on 45 selected phones writes nothing, changes nothing, and reports 45 × `ok`.

### 0.5 What the plugin host already gives away for free

`GET /api/plugins/:name/data/scan` already LEFT JOINs `device_numbers` and returns `number` on every row (`packages/core/src/api/plugins.ts:600-631`, `PluginDataScanRowSchema` in `packages/protocol/src/api/plugins.ts:583`). `$device.number` is an allowlisted binding for declarative plugin views. Proxy Manager simply does not parse the field (`plugins/proxy-manager/src/ui/parts/api.ts:96`), and the TikTok pack's device column asks for `$device.label` (`plugins/tiktok-automation-pack/src/index.ts:847`).

---

## 1. Goals

1. **No device is ever named without its number.** Every text label, dialog title, toast, table cell, tile, `aria-label` and joined list in the web UI renders `#7 Galaxy A15` (or the two-part visual form) wherever `number` is known — including plugin UIs. A device with `number === null` renders the bare label, unchanged.
2. **One formatter, one component, one package.** `formatDeviceName()` and `<DeviceName>` live in `@enkaku/ui` and are the only way any surface composes a device name. Studio and every plugin import the same two symbols.
3. **Every control that picks a device from more than a handful offers a search box**, matching number (`7` and `#7`), label and stableId — the same four-way match `DevicePicker` already implements.
4. **Setting the number as a black wallpaper is one action**, from the device popup for one device and from the selection toolbar for many — and it reports what actually happened (`applied` / `partial` / `unavailable`), never a flattened success.
5. **"Apply labels" stops lying** — a device whose mode is `off` is reported as skipped with a reason, not counted as `ok`.
6. The rule is mechanically defended, so it does not drift a third time.

## 2. Non-goals

- **Wall virtualization.** `app/page.tsx:1293` bypasses pagination when the Wall is grouped, rendering every filtered tile. Real, separate, performance work — not this plan.
- **Renumbering, number allocation, or any change to `device_numbers`.** Plan 89 owns that and it is correct.
- **The guest agent, the renderer, or the labelling service.** Not one line. §0.4 — the mechanism works; this plan only builds the way in.
- **Server-side keyset search.** Every search box here filters the already-loaded set, client-side, matching what `app/page.tsx` and `DevicePicker` already do.
- **Restyling anything.** No token changes, no layout redesign.

## 3. Context and design decisions

### 3.1 The number composes; it never enters the label

Plan 89 §3.3's rule stands, and this plan is the enforcement of it. `formatDeviceName` produces a *presentation* string; nothing writes `#7` into `devices.label`, and nothing parses it back out. The visual form keeps them in two spans so the number can be dimmed, exactly as `DevicePicker.tsx:227` already does.

### 3.2 Two symbols, because there are two contexts

`formatDeviceName(number, label)` → `'#7 Galaxy A15'` — for toasts, `aria-label`s, dialog titles, `.join(', ')` lists, `<title>`s, and anywhere else that needs a `string`.

`<DeviceName number={n} label={l} />` → `<span class="readout … text-fg-subtle">#7</span><span>Galaxy A15</span>` — for table cells, list rows and tiles, where the number should read as a quiet identifier beside the name.

Both in `@enkaku/ui`, because plugins cannot reach `packages/studio`. `formatDeviceName` deliberately mirrors the core's existing `formatDeviceLabel` character for character; a test asserts the two agree.

### 3.3 A search box below ten items is noise; above ten it is the whole feature

The threshold this plan uses: **a control that can list more entries than a farm has clusters gets a search box.** In practice that means every list of devices, every list of proxies, and every list of scripts. It does not mean the cluster pickers, the connection-medium selects, or a schema-form enum of four values.

Where the list is a `Select` over a growing set, it becomes the new shared `Combobox`. Where the list is a table or a checkbox column, it gets a plain `Input` above it filtering rows client-side, with a live count — the pattern `plugins/proxy-manager/src/ui/parts/catalogue.tsx:591` already uses.

### 3.4 `Combobox` is `ModelCombobox`, generalised and moved

Not a new invention: the same `Popover` + `cmdk` composition, the same `Check` mark, the same `<Command defaultValue={value}>` trick that pre-highlights the current selection instead of the first row, the same "the current value is always shown even if it is no longer in `options`" rule (`ModelCombobox.tsx:29-31`) — which matters more here than there, because a Mikrotik group can name a device that has since been forgotten.

`ModelCombobox` is then reduced to a thin wrapper over it, or deleted in favour of a direct `Combobox` call, whichever is smaller at the time. Its own tests must keep passing either way.

### 3.5 One click means two requests, and the second one is the truthful one

`PATCH /api/devices/:id` replaces the whole `settings` blob — there is no per-key patch — so "Set number as wallpaper" is necessarily:

1. `PATCH /api/devices/:id` with `{ settings: { ...settings, labelling: { ...labelling, mode: 'wallpaper' } } }` (read-modify-write against the `device.settings` the popup already holds, the pattern `AdmitDeviceDialog.tsx:137-149` uses).
2. `POST /api/devices/:id/label/apply` → `DeviceLabelStateSchema`.

The toast reports step 2's `state` **verbatim**: `applied` is a success toast, `partial` is a warning naming which surface took, `unavailable` is an error naming the reason. This is plan 89 §3.5's "two tiers, no silent fallback" applied to the action that triggers it — a row that says "Done" over an `unavailable` result would be worse than no row at all.

The action is *not* a toggle. Turning the label off stays where it is (Settings → Labelling → Clear), because clearing is destructive on Android versions that cannot restore the original wallpaper, and that dialog already says so.

### 3.6 The action list has a row budget, and this plan spends one

`ActionsList.tsx:56-62` states the list must fit without scrolling, and "anything that grows this list has to displace something, not append to it". This plan appends one row and pays for it by checking the fit rather than by assuming it: at the popup's fixed height, USB goes 13 → 14 rows. If 14 does not fit, **"Open full device page" moves out of the list and becomes an icon button in the popup header** — it is navigation, not an action, and it is the only row in the list that does nothing to the device.

### 3.7 Where the number is not on the wire, put it on the wire — narrowly

Five payloads name a device and carry no number. Each gets one nullable field, never a widened object:

| Payload | Where built | Note |
|---|---|---|
| `DeviceRef` (`GET /api/devices/refs`) | `core/src/api/devices.ts:381` | Feeds `deviceRefLabel` (`studio/src/lib/api.ts:97`), which its own comment calls "the one place this formatting rule lives" — it is, and it is missing the number |
| `MirrorMember` | `core/src/server/ws-handlers.ts:777` | Wrap `deviceLabelOf` in `formatDeviceLabel(lookupDeviceNumber(...), label)` |
| Batch artifact `deviceLabel` | `core/src/api/batches.ts:681` | Same wrap. **Do not** change the ZIP filename path at `batches.ts:943` — a `#` in a filename is a new problem |
| Adb pool stats `devices[].label` | `core/src/api/adb-stats.ts:193` | Same wrap |
| Mikrotik `FleetDeviceRow` | `plugins/mikrotik-routing/src/service/apply.ts:181` | `number: device.number` — the `DeviceInfo` is right there |

Proxy Manager needs **no** server change (§0.5) — only `number: z.number().int().nullable()` on its own `ScanRowSchema`.

### 3.8 Defending the rule mechanically

`packages/studio/src/design-rules.test.ts` already forbids `bg-[--color-…]`, bare `<a href>` and per-device `backdrop-filter` by regex over the source. This plan adds one more check of the same kind: a curated list of files that are known to name devices must each import `formatDeviceName` or `DeviceName` from `@enkaku/ui`. It cannot prove every render site is correct, and it is not claimed to — it stops the specific regression of a device-naming file silently losing its import during a refactor. `docs/design.md` carries the prose rule beside it.

## 4. Technical design

### 4.1 `packages/ui/src/lib/device-name.ts` (new — the plan's `Ships:` artefact)

```ts
/** `#7 Galaxy A15`, or the bare label when the device has no number. Mirrors
 *  `formatDeviceLabel` in packages/core/src/registry/device-number.ts. */
export function formatDeviceName(number: number | null | undefined, label: string): string

/** `#7 Galaxy A15 (R5CW…)` — for a disambiguating context (a combobox row's
 *  keywords, a search index). Never a dialog title. */
export function deviceSearchTerms(d: { number?: number | null; label: string; stableId: string; tags?: readonly string[] }): string[]

/** True when `query` matches the device by number (`7` or `#7`), label,
 *  stableId, or a tag — the same predicate DevicePicker.tsx:73-88 implements. */
export function matchesDeviceQuery(d: {...}, query: string): boolean
```

`DevicePicker` is refactored to call `matchesDeviceQuery` rather than keeping its own copy, so the four-way match has one definition.

### 4.2 `packages/ui/src/components/device-name.tsx` (new)

```tsx
export function DeviceName({ number, label, className, numberClassName }: {
  number: number | null | undefined
  label: string
  className?: string
  numberClassName?: string
}): JSX.Element
```

Renders nothing for the number when it is `null`/`undefined`. Default number styling matches `DevicePicker.tsx:227` (`readout text-[11px] text-fg-subtle`, `aria-hidden` false — the number is read aloud, it is identity).

### 4.3 `packages/ui/src/components/combobox.tsx` (new)

```tsx
export type ComboboxOption = {
  value: string
  label: string
  /** Extra strings the filter matches — device number, stableId, tags. */
  keywords?: string[]
  /** Rendered under the label, dimmed. */
  hint?: string
  disabled?: boolean
  disabledReason?: string
}

export function Combobox(props: {
  value: string
  onValueChange(value: string): void
  options: ComboboxOption[]
  placeholder?: string          // trigger text when value is empty
  searchPlaceholder?: string
  emptyText?: string            // default: 'No match.'
  error?: string | null         // replaces the list, never an empty list that looks like "none"
  disabled?: boolean
  align?: 'start' | 'end'
  className?: string
  triggerClassName?: string
  renderOption?(option: ComboboxOption): React.ReactNode
}): JSX.Element
```

Behaviour that is not optional, all inherited from `ModelCombobox`: the current `value` is always present and pre-highlighted even when absent from `options`; `Escape` dismisses and changes nothing; arrow keys navigate; a `disabled` option renders dimmed with its reason and is not selectable.

Both new components are added to `packages/ui/src/index.ts` and to the `REQUIRED` name list in `packages/ui/src/index.test.ts`.

### 4.4 The complete list of surfaces to correct

Grouped by the worker that owns them (§5). Every entry is `file:line` at the time of the sweep — verify before editing, do not trust the line number blindly.

**Group B — device popup, wall, header, cards**
`wall/DeviceContextMenu.tsx:189,235` · `device-popup/DevicePopup.tsx:353,794,823,971,1317` · `device-popup/SettingsPopup.tsx:187,192,288` · `device/DeviceHeader.tsx:399,563,642,649` · `DeviceCard.tsx:178,183` · `topology/DeviceTile.tsx:56` · `guest-agent/AgentAlertDetail.tsx:173,270` (via its `deviceLabel` prop)

**Group C — dialogs, bulk reports, the operations tray**
`ForgetDeviceDialog.tsx:85,104,118` · `DisconnectDeviceDialog.tsx:73,75,77,96` · `device/CutoverDialog.tsx:112,152,212` · `device/BulkCutoverDialog.tsx:148,152,165,168` · `TakeControlDialog.tsx:115,146` · `device/AssistDialog.tsx:92,115` · `AskAnAgentDialog.tsx:59,94,96,140` · `device/PhysicalLabellingPanel.tsx:185` · `BulkForgetDialog.tsx:134` · `ClusterMembersDialog.tsx:110,142` (+ its search box, §4.5) · `RunScriptDialog.tsx:1037` · `BulkPrepDialog.tsx:150` · `BulkTransferDialog.tsx:95` · `InstallBatchDialog.tsx:125` · `network/BulkProxyDialog.tsx:128` · `bulk/SkippedGroups.tsx:18,84,93` · `operations/ReattachBanner.tsx:33` · `operations/OperationTray.tsx:99` + `lib/operations.ts:717`

`NamedOutcome` (`bulk/SkippedGroups.tsx:18`) gains `number: number | null`; that one change fixes every producer above at once, and each producer has `number` in scope.

The four `deviceLabel: string` props (`TakeControlDialog`, `AssistDialog`, `AskAnAgentDialog`, `AgentAlertDetail`) are **not** widened into objects — their callers pass `formatDeviceName(...)`. Callers: `DeviceHeader.tsx:642`, `DevicePopup.tsx:1272,1297`, `ActionsList.tsx:570`, `DeviceContextMenu.tsx:282`, `AgentAlertChip.tsx:112`.

**Group D — pages, jobs, console, schedules, agents**
`JobsList.tsx:80,275` · `app/jobs/page.tsx:40,97` · `app/device/page.tsx:488-491,876,969` · `app/console/page.tsx:310` · `command/RunReport.tsx:160,206,219` · `command/target-preview.ts:87` · `command/TargetPicker.tsx:151,158` · `device-popup/AdbCommandDialog.tsx:321` · `app/schedules/detail/page.tsx:297` · `app/agents/detail/page.tsx:789` (+ its search box, §4.5) · `agent/ContextPanel.tsx:57` · `app/settings/page.tsx:478,997` · `app/batches/detail/page.tsx:204,513` · `lib/api.ts:97` (`deviceRefLabel`) · `AdbRestartDialog.tsx:66`

**Group E — core and protocol plumbing** — the five payloads of §3.7.

**Group F — the wallpaper action** — `device-popup/ActionsList.tsx` (row + the `#31/#32` toasts at `:372,384-388,487`), `app/page.tsx` (the bulk action, the `off`-is-not-`ok` fix at `:332-361`, and its own toasts at `:339,812,820-825,852`), `ReadinessControl.tsx:90`.

**Group G — Mikrotik plugin** — `ui/parts/api.ts:300` · `ui/parts/assignments.tsx:362-372,387` · `ui/parts/groups.tsx:97,266-275,298-320,486,496,509,578` · `ui/parts/settings.tsx:67` · `service/apply.ts:181` · `service/handlers.ts:196`

**Group H — Proxy Manager, TikTok pack, plugin views** — `proxy-manager/ui/parts/api.ts:96` · `proxy-manager/ui/parts/assignments.tsx:361-364,377` · `proxy-manager/ui/parts/logs.tsx:182` · `tiktok-automation-pack/src/index.ts:847` · `studio/components/plugin-view/ActionRunner.tsx:131,214,220,225` · `studio/components/plugin-view/ViewRenderer.tsx:255-290`

### 4.5 The search boxes

| Surface | Shape |
|---|---|
| Mikrotik → Groups → "Add a device…" (`groups.tsx:266`) | `Combobox`, options `#N Label`, `hint` = stableId, `keywords` = [number, stableId] |
| Mikrotik → Assignments table (`assignments.tsx:362`) | `Input` above the table, filters rows by `matchesDeviceQuery` + path name, with `N of M devices` |
| Proxy Manager → Assignments table (`assignments.tsx:361`) | Same `Input` + count |
| Proxy Manager → per-row proxy select (`assignments.tsx:377`) | `Combobox` — 200 records × 100 rows today |
| Proxy Manager → logs filter (`logs.tsx:182`) | `Combobox` |
| Mikrotik → path selects (`assignments.tsx:387`, `groups.tsx:309`) | `Combobox` |
| Agents → detail → device grants (`agents/detail/page.tsx:786`) | `Input` above the checkbox list; **"Select all" applies to the filtered set** and says so |
| Cluster members dialog, left pane (`ClusterMembersDialog.tsx:138`) | `Input`; the right pane already has `DevicePicker`, the asymmetry is the bug |
| Plugin view tables (`ViewRenderer.tsx:255`) | Optional `Input` above the table, filtering **loaded rows only** — the empty state must say so, never imply the server was queried |
| Script pickers (`RunScriptDialog.tsx:955`, `workflow/ScriptPicker.tsx:83`, `ScheduleEditorDialog.tsx:473`) | `Combobox`, grouping preserved |
| Param sets (`ParamSetPicker.tsx:158`) | `Combobox` |

### 4.6 The wallpaper action

Row, placed beside Wake/Sleep in `ActionsList`:

```
icon: Hash (lucide)   label: "Set number as wallpaper"
```

Disabled reasons, checked locally before any request, in this order:

| Condition | Reason shown |
|---|---|
| `device.number === null` | `This device has no number assigned yet.` |
| `status === 'offline' \|\| 'quarantined'` | reuse `ActionsList.tsx:344`'s existing `readinessUnreachable` wording |
| `device.agent !== 'ready'` | `The Enkaku guest agent is not installed on this device — the wallpaper label needs it.` |

The coarse `device.agent` check is deliberate: the precise `screen-label` capability lives on `GET /api/devices/:id/guest-agent`, which would cost a request on every popup open (`packages/protocol/src/device.ts:278-285` explains why it is not on `DeviceInfo`). A device whose agent is `ready` but lacks the facet gets an honest `unavailable` from the server, which the toast reports verbatim — never a silent success.

Multi-select (`selectedIds.length > 1`) and the devices-page selection toolbar run the same thing over N devices: `Promise.allSettled` of the PATCH (the shape `bulkSetReadiness`, `ActionsList.tsx:355-370`, already uses), then one `POST /api/devices/labels/apply` with `{ deviceIds }`, then `OutcomeSummary` + `SkippedGroups` grouped by `state` — `applied`, `partial`, `unavailable`, each with its reason. Never a flattened "N failed".

Separately, the existing **"Apply labels"** button keeps its meaning (apply each device's own mode) but stops counting `mode === 'off'` as `ok`: those devices are reported as skipped, reason `labelling is off for this device`.

## 5. Implementation steps

Step 124.1 blocks everything. 124.2–124.8 are independent of each other and are partitioned so that **no two of them edit the same file**.

### 124.1 — The two symbols and the combobox (`@enkaku/ui`) — BLOCKING

- [ ] `packages/ui/src/lib/device-name.ts` — `formatDeviceName`, `deviceSearchTerms`, `matchesDeviceQuery` (§4.1).
- [ ] `packages/ui/src/components/device-name.tsx` — `<DeviceName>` (§4.2).
- [ ] `packages/ui/src/components/combobox.tsx` — `<Combobox>` (§4.3), lifted from `studio/src/components/agent/ModelCombobox.tsx`.
- [ ] Export all three from `packages/ui/src/index.ts`; add their names to `REQUIRED` in `packages/ui/src/index.test.ts`.
- [ ] Tests: `packages/ui/src/lib/device-name.test.ts` (including a case asserting `formatDeviceName` agrees with the core's `formatDeviceLabel` for `null`, `1`, and a label containing `#`), `packages/ui/src/components/combobox.test.tsx` (filter by keyword, current value present when absent from options, Escape changes nothing, disabled option not selectable).
- **Result:** `bun run typecheck` passes and both symbols are importable from `@enkaku/ui` in Studio and in a plugin.

### 124.2 — Popup, wall, header, cards (Group B)
- [ ] Every site in §4.4 Group B renders `<DeviceName>` or `formatDeviceName`.
- [ ] `DevicePicker.tsx` and `DeviceCard.tsx`/`WallTile.tsx` switch to `<DeviceName>` where it is a drop-in; `DevicePicker`'s local filter becomes `matchesDeviceQuery`.
- [ ] Update the colocated `*.test.tsx` for each file touched.

### 124.3 — Dialogs, bulk reports, operations tray (Group C)
- [ ] `NamedOutcome` gains `number: number | null`; `SkippedGroups` renders it; every producer passes it.
- [ ] Every site in §4.4 Group C.
- [ ] `ClusterMembersDialog`'s left pane gains its search `Input` (§4.5).

### 124.4 — Pages, jobs, console, schedules, agents (Group D)
- [ ] Every site in §4.4 Group D.
- [ ] `deviceRefLabel` (`lib/api.ts:97`) composes the number that step 124.5 puts on `DeviceRef`.
- [ ] Agents → detail device grants gains its search `Input`, with "Select all" scoped to the filtered set (§4.5).

### 124.5 — Core and protocol plumbing (Group E)
- [ ] `DeviceRef`, `MirrorMember`, batch artifact `deviceLabel`, adb stats `label` (§3.7) — Zod schema field or `formatDeviceLabel` wrap, whichever the row is.
- [ ] Leave `batches.ts:943`'s ZIP filename path alone, and say so in a comment.
- [ ] Update `packages/core/src/api/devices.test.ts`, `adb-stats` and `ws-handlers` tests for the new shapes.

### 124.6 — The wallpaper action (Group F)
- [ ] `ActionsList.tsx`: the row, its three disabled reasons, the single-device flow, the multi-select flow (§4.6).
- [ ] Verify the popup still fits without scrolling at 14 rows; if not, apply §3.6's displacement and say so in the commit.
- [ ] `app/page.tsx`: the selection-toolbar "Set number as wallpaper" action, and the `off`-is-not-`ok` fix to `applyLabelsToSelected`.
- [ ] Group F's toasts get the number.
- [ ] `ActionsList.test.tsx`'s hard row counts (13 USB / 12 TCP, at `:407` and `:426`) are updated, plus a new test per outcome state asserting `partial` and `unavailable` are never worded as success.

### 124.7 — Mikrotik plugin (Group G)
- [ ] `number` on `FleetDeviceRowSchema` and on the server row (`service/apply.ts:181`).
- [ ] "Add a device…" becomes a `Combobox`; the two path selects too.
- [ ] The assignments table gains its filter `Input` + count.
- [ ] `labelFor` (`groups.tsx:97`) and `service/handlers.ts:196` compose the number.
- [ ] `bun run build:packs` regenerates `packages/core/packs/mikrotik-routing-ui` — **never hand-edit the built pack.**

### 124.8 — Proxy Manager, TikTok pack, plugin views (Group H)
- [ ] `number` on `ScanRowSchema` and `DeviceRow` (no server change needed, §0.5).
- [ ] The assignments table gains its filter `Input` + count; the proxy select and the logs filter become `Combobox`es.
- [ ] `ActionRunner`'s confirm sentence names the device with its number (`rows.ts:26` already carries it).
- [ ] `ViewRenderer` gains the optional table search of §4.5, with the "loaded rows only" empty state.
- [ ] TikTok pack's device column becomes `$device.number` + `$device.label`; `bun run build:packs`.

### 124.9 — The rule, defended and written down
- [ ] `packages/studio/src/design-rules.test.ts` — the curated-file import check of §3.8.
- [ ] `docs/design.md` — two rules: a device is never named without its number; a device list longer than a handful carries a search box matching number, label and stableId.
- [ ] `docs/spec.md` §19 — the Dashboard and Device detail rows already *claim* universal number rendering; amend them to state it is now true across plugins and dialogs, and describe the one-click wallpaper action.
- [ ] `docs/plans/00-overview.md` §2 — **check before writing**: the plan register table stops at plan 120; plans 121, 122 and 123 have no row. Do not backfill three other plans' rows as a side effect of this one. Either add 124's row alone, matching the existing column format, or note in your report that the register is stale from 121 onward and leave it — the owner's call, not a worker's.
- [ ] `docs/guide/physical-labelling.md` — the new one-click path, replacing the six-click walkthrough.
- [ ] This plan's own `> Status:` line.

## 6. Acceptance criteria

1. Searching `7` in any device search box finds `#7`, and so does `#7` — every box, not just `DevicePicker`.
2. Mikrotik → Groups → "Add a device…" is a searchable combobox listing `#N Label` with the stableId as a hint.
3. Mikrotik and Proxy Manager assignment tables show `#N Label` and have a working filter with a live count.
4. No `<Select>` anywhere in the repo has a device as its option, except through `Combobox` or `DevicePicker`.
5. `Forget …?`, `Disconnect …?`, `Take control of …?`, `Settings — …`, the context-menu header, the popup header and the operations tray all name the device with its number.
6. Two devices whose `label` is identical are distinguishable in **every** surface listed in §4.4.
7. A device with `number === null` renders its bare label everywhere, with no stray `#`, no `#null`, and no layout shift.
8. From the device popup, one press applies the black wallpaper carrying the number, on a device whose agent is ready.
9. That press reports `partial` as partial and `unavailable` as unavailable, naming the reason. No state is rounded up.
10. The action is disabled with a stated reason when the device has no number, is offline, or has no guest agent.
11. Selecting N devices and pressing "Set number as wallpaper" sets the mode on all N and applies once, reporting grouped outcomes.
12. "Apply labels" reports `mode: 'off'` devices as skipped, not as ok.
13. `bun run typecheck` passes. Scoped tests pass for every directory touched.
14. `bun run build:packs` has been run and the built packs match their sources.
15. `bash scripts/check-plan-status.sh` passes.

## 7. Test plan

Unit (colocated, run **only** for the directory you touched — CLAUDE.md's rule):

- `packages/ui/src/lib/device-name.test.ts` — `null`, `0`-adjacent, a label already containing `#`, agreement with `formatDeviceLabel`.
- `packages/ui/src/components/combobox.test.tsx` — §4.3's four behaviours.
- Per touched Studio file, its colocated test asserts the rendered string contains `#7`.
- `ActionsList.test.tsx` — row counts, the three disabled reasons, and one test per label state.
- `app/page.test.tsx` — the bulk action, and `off` reported as skipped.
- Plugin tests under `plugins/*/src/ui` for the new schemas and filters.

Manual smoke:

```bash
bun run dev            # core on :7700
bun run dev:studio     # Studio on :3001
```

1. With two devices sharing a label, confirm every surface in §4.4 tells them apart.
2. Mikrotik → Groups → New group → type `7` in "Add a device…" → `#7` is the only match.
3. Device popup → **Set number as wallpaper** → the phone shows a black screen with its number, home and lock.
4. Select 3 devices → the same action → three outcomes, grouped, none rounded up.
5. Release a device's number (`DELETE /api/devices/numbers/:stableId`) → every surface shows the bare label, and the action is disabled with the stated reason.

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| A worker changes a file another worker owns | §5 partitions by file, not by feature; the groups in §4.4 are disjoint |
| Concurrent full test suites cook the machine (CLAUDE.md, 2026-08-17) | Workers run `bun run typecheck` only; the scoped test pass is run once, sequentially, at the end |
| Built packs drift from plugin sources | `bun run build:packs` is an explicit checklist item in 124.7 and 124.8, and criterion 14 |
| `#7` leaks into a filename, a script argument, or a device `label` write | §3.7 names the one ZIP-filename site to leave alone; nothing in this plan writes to `devices.label` |
| A device with no number renders `#null` | Criterion 7; `formatDeviceName` is total and its test covers `null`/`undefined` |
| The 14th action row overflows the popup | §3.6's displacement rule, verified rather than assumed |

## 9. Open questions

1. **Should `ModelCombobox` be deleted outright** in favour of `Combobox`, or kept as a thin wrapper? Left to whoever does 124.1 — smaller diff wins, its tests must stay green either way.
2. **Should the wallpaper action be a toggle** (press again to clear)? Deliberately not built: clearing is destructive on Android versions that cannot restore the original wallpaper, and the existing Clear flow states that. Worth revisiting once §0.4's hardware pass has actually been run.
3. **Should `PaginatedTable` grow the `search` prop** its own comment (`PaginatedTable.tsx:65-69`) already anticipates, and should the six list pages with pagination but no search (clusters, schedules, workflows, nodes, batches, recordings) get one? Out of scope here — none of them names a device — but it is the same class of gap and should be its own small plan.
4. **Should the number appear in the wall tile at large sizes only**, or always? Unchanged by this plan; raised because `WallTile` is the one surface where screen real estate genuinely competes.

---

## 10. Notes recorded during execution (read before starting your step)

**From 124.5 (core/protocol plumbing), landed 2026-08-25:**

- `GET /api/devices/refs` had **no Zod schema at all** — a hand-written inline shape, which is exactly how `number` went missing there. It now answers through `DeviceRefsResponseSchema` (`packages/protocol/src/api/devices.ts`). `packages/studio/src/lib/api.ts:74`'s local `DeviceRef` interface still lacks `number`; the field is on the wire, so **Group D** can compose it in `deviceRefLabel`.
- **`MirrorMember` got a `number` FIELD, not a pre-baked label** — deliberately the opposite of §3.7's table. `DevicePopup.tsx:794`'s `labelFor` falls back to a `DeviceInfo` that already carries `number`, so a pre-baked `label` would have made the natural Group B edit render `#7 #7 Galaxy A15`. **Group B**: compose from `m.number`; `m.label` stays bare.
- **Batch artifacts and adb pool stats DO arrive pre-composed** (`formatDeviceLabel` applied server-side). **Group D**: render `it.deviceLabel` (`app/batches/detail/page.tsx:513`) and `AdbRestartDialog.tsx:66` as-is — do **not** wrap them again.
- The ZIP hazard of §3.7 was real and needed a code change to *avoid* one: `batches.ts:943/946` slugs the device label into archive entry names, so wrapping alone would have silently rewritten every archive path the moment a farm allocated numbers. `CollectedArtifact` now carries an internal-only `rawDeviceLabel` for the two `slugLabel` calls, stripped before the metadata route answers, with a regression test asserting entry names stay byte-identical.
- `mirror.started`/`mirror.changed` now **require** `number` on the wire. Existing `DevicePopup.test.tsx` mirror fixtures bypass Zod (mocked `ws`, `payload?: unknown`) so they still pass — but any new test that feeds a real `ServerMessageSchema.parse` a member without `number` will be rejected.

**From 124.1 (the `@enkaku/ui` foundation), landed 2026-08-25:**

- Shipped: `packages/ui/src/lib/device-name.ts` (`formatDeviceName`, `deviceSearchTerms`, `matchesDeviceQuery`, plus `NamedDevice`/`SearchableDevice` — structural param types, because a Mikrotik `FleetDeviceRow` or a Proxy Manager scan row is not a `DeviceInfo`), `components/device-name.tsx`, `components/combobox.tsx`. 29 tests, all green.
- **`Combobox` has one prop beyond §4.3: `ariaLabel`.** A combobox whose only visible text is its current value has no accessible name otherwise, and it is the only way a test can find it by role + name.
- **`matchesDeviceQuery` lowercases the tag before comparing** — `DevicePicker.tsx:89` lowercased the query but not the tag, so `pool:Smoke` was unfindable by typing `smoke`. Fixed rather than reproduced; a strict superset, nothing that matched before stops matching.
- **`ModelCombobox` was deliberately NOT converted** (§9 Q1 answered): its trigger renders the model id with `readout max-w-40`, and `Combobox`'s trigger does not let a caller style that span. Converting it would either silently restyle the agent composer — which §2 forbids — or need a `renderValue` prop no §4.5 caller wants. The follow-up is one prop plus a ~35-line rewrite; it belongs in 124.9, not in the blocking step.
- `formatDeviceName`'s agreement with the core's `formatDeviceLabel` is tested by **reading the core's source text**, not by importing it — `@enkaku/ui` must not depend on `@enkaku/core`, because a plugin bundles this package's import graph.
- **Two testing traps, passed on:** a failing `expect(node).toBeNull()` inside a retrying `waitFor` serialises a happy-dom element and writes a ~98 MB failure report that looks exactly like a hang — assert on counts (`queryAllByText(...).length`), never on nodes. And cmdk's filter is fuzzy `command-score`, not substring: a nonsense query can still score above zero and fail to produce an empty list.
- `packages/ui`'s own tests must run with `--cwd packages/ui` on ONE named file — the root `bunfig.toml` ignores `packages/ui/**`, and the happy-dom preload lives in that package's own `bunfig.toml`.

**Correction found by 124.4, closed by the coordinator 2026-08-25 — a sixth payload §3.7 missed:**

`AdbRestartReport.reattachFailed` (`packages/protocol/src/api/adb.ts`, built in `packages/core/src/daemon.ts`'s `reattachEndpoints`) is **not** the same object as the adb POOL STATS payload (`api/adb-stats.ts`) that §3.7 listed and 124.5 composed server-side. The two were conflated when 124.4's brief was written, and `AdbRestartDialog.tsx:66` was told to render an already-composed string that was in fact a bare `devices.label` SELECT with no number anywhere on the wire. 124.4 correctly refused to paper over it and reported the gap instead of writing a `formatDeviceName(null, …)` no-op.

Closed the way §3.7 would have: `reattachFailed` rows now carry `number: number | null` as their own field (never a pre-baked label, per the `MirrorMember` lesson above), `reattachEndpoints` populates it with `lookupDeviceNumber` (bounded by the failure count, not the fleet size), and `AdbRestartDialog` composes exactly once. A regression test asserts a two-row report reads `#7 SM-F721U1, SM-F721U1` — the numbered one composed, the numberless one bare, no `#null`.

The lesson worth keeping: **two payloads whose field is spelled `label` are not thereby the same payload.** Check what builds a row before deciding whether it is pre-composed.

**From 124.7 / 124.8 (the two plugin UIs), landed 2026-08-25:**

- **No `Search` icon in either plugin's filter field.** `lucide-react` is not in `UI_EXTERNALS` and is not a dependency of either pack, so importing one icon inlines an icon library into the pack's `index.js` — the call `proxy-manager/src/ui/parts/failover-chip.tsx` had already made. Both filters use the field-plus-count-plus-`aria-label` shape `catalogue.tsx` already had. A plugin UI is not a Studio component and cannot borrow every Studio import.
- **The Mikrotik "unassigned" sentinel changed from `' none'` to `'__unassigned__'`.** `cmdk` trims item values, so under `Combobox` the leading-space sentinel collapses to `none` — and a MikroTik routing table genuinely called `none` is plausible, which would make choosing that path silently *unassign* the device. UI-only, mapped back to `''` before any write.
- **The Mikrotik service half cannot import `formatDeviceName`** (`@enkaku/ui` is React, supplied to the browser bundle only) nor the core's `formatDeviceLabel`. It carries a documented third mirror of the same one-line rule in `shared.ts`, the module both halves already import.
- **`ScanRowSchema.number` is `.default(null)`, not bare `.nullable()`.** A tier-C pack can run against a core older than plan 89's join; without the default a missing key fails the parse and takes the whole Assignments tab down, where the honest degradation is a bare label.
- **The `ViewRenderer` search box is always-on above ten loaded rows, not opt-in per view spec.** `ViewSpecSchema` is `.strict()`, so a `search` flag would be a wire change — protocol, SDK types, `validatePluginSurface` — for a purely client-side convenience, and every already-published pack (including the four embedded in the release binary) would render with no filter until its author republished. Three honesty details came with it: the empty state is titled *"No match in the rows loaded"* and says it does not ask the plugin for more; select-all is scoped to the filtered set and its accessible name says so; and a row hidden by the filter drops out of the selection, so a batch can never run on a device the operator filtered away.
- **The TikTok pack was already correct** — it declares `$device.number` beside `$device.label`. §0.5/§4.4's reading of that file was stale; 124.8's checklist item there is a no-op and the file is untouched.
- **Two more gaps found and left**, both genuinely out of scope: Mikrotik's Rules and Paths tabs have no filter (a real router carries hundreds of rules — §9 Q3's class), and `identity-bridge.ts`'s `DeviceLanAddress.label` stays bare because it is an *addressing* record and every consumer now composes from the row's own `number` instead.

**Two defects this plan found in surfaces its own §4.4 catalogue had missed, both fixed:**

1. **The devices page's own search box could not find a device by number** (`app/page.tsx`'s filter matched label, adb serial and connection address only). Every tile and row on that screen has led with `#7` since plan 89, so an operator reading the number off the phone in their hand and typing it into the most-used search in the product got "no devices". It now runs `matchesDeviceQuery` — the same four-way predicate `DevicePicker` uses — with `serial`/`address` kept beside it as this screen's own additions.
2. `AdbRestartReport.reattachFailed` — see the correction note above.

**The plan register in `docs/plans/00-overview.md` §2 was left alone.** It stops at plan 120; 121, 122 and 123 have no row either. Adding 124 alone would sit oddly, and backfilling four plans' rows is a decision for the owner, not a side effect of this one. `bash scripts/check-plan-status.sh` passes regardless — it reads each plan's own `Status:`/`Ships:` lines, not the register.
