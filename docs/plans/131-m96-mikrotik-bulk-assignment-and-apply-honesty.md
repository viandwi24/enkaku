# Plan 131 — M96 : Assigning twenty devices without twenty clicks, and an apply that does what it says

> Status: implemented (software) — **131.1–131.7 all land.** Opened 2026-08-26 from the owner's own use of the MikroTik routing plugin on a 20-device farm: five complaints from one afternoon, four additive and one a correction. **Bulk by number**: `buildPairings` pairs an inclusive device-NUMBER range positionally against the path list from a start index, used by both the Assignments tab and the group editor, with a mandatory preview in which every anomaly is a visible row and none is dropped. **Selection** with a bulk bar whose count matches the filtered scope. **The scroll bug is fixed and its cause was exactly what the owner guessed** — `if (loading) return <LoadingRows />` unmounted the whole table on every write. **Applying over a down path is a decision instead of a dead end**: `skip` stays the default, the warning stays, and one explicit never-primary action forces the rows — in the PLANNER, so the preview shows the real `create`/`update` before it happens, which keeps plan 122 §4.5's "never applied *silently*" intact rather than overturning it. `mikrotik-routing@0.10.0` builds. **NOT verified on the farm**: §7 names what needs a real fleet — a scroll at row 30, a genuinely down modem, and 20 devices against 20 paths. **Three defects were found by the workers implementing this**, §10 — including a backend that did not exist and that this plan had allocated to nobody, found by a worker that then refused to fake it.
> Depends on: plan 122 (M87, the plugin itself — §3.2 the local-exception refusal, §4.3 `resolveTarget`, §4.4 "plan, then apply — never write blind", §4.5 path health), plan 124 (§0.2, this pack's device selector), plan 129 (§3.4, `@enkaku/host` and the wall picker the group editor now uses).
> Spec references: §11.6 (plugin screens, tier C).
> Ships: plugins/mikrotik-routing/src/ui/parts/bulk-builder.tsx

---

## 0. Evidence

All five reported by the owner, 2026-08-26, from operating the plugin on their own farm.

### 0.1 Assigning is one device at a time

The Assignments tab assigns a single device to a single path per interaction. On a 20-device farm being pointed at 20 modems that is 20 separate operations, each of which — see §0.3 — also loses the operator's place in the table.

What was asked for, verbatim: *"bulk incremental assign devices … jadi konsepnya kaya builder gitu misalnya tulis device number berapa dan sampai berapa, berarti pakai index dari number device dan untuk routingnya pakai index dari path"* — a range of device **numbers**, paired positionally against a range of **path indices**. And the same builder in the group editor.

### 0.2 There is no bulk selection

The table has no checkboxes and no selection state (`assignments.tsx` — `manualDrafts`, `busy`, `writeError`, `applyOpen`, `query`, and nothing else). Every operation is per-row, so there is nothing to act on in bulk even once a builder exists.

### 0.3 Every assign scrolls you back to the top — and here is exactly why

`assignments.tsx:365`:

```ts
if (loading) return <LoadingRows />
```

`assignPath` writes, then calls `reload()`. `useLoader` sets `loading: true`, this early return **replaces the entire table with a skeleton**, and React unmounts every row. When the data returns the table mounts fresh, with no scroll anchor to restore — so the viewport snaps to the top.

The owner's own diagnosis was right: *"entah karena componentnya yang force re-render atau gimana"*. It is a full unmount, on every single write, by construction.

### 0.4 `skip` on a down path is deliberate — and it is still the wrong experience

Reported as: assign to modem1 (up) → fine; change to modem2 (down) → apply says `skip`, *"aneh aja gitu"*.

It is not a malfunction. `planner.ts` produces `skip` with `reason: 'path-down'`, and plan 122 §4.5 states the rule: *"An assignment pointing at a down path appears in the plan as `skip` and in the UI as a warning — **never applied silently**, because a rule pointing at a dead path is a device with no internet, and that should never be a surprise."*

**The operative word is "silently".** The rule forbids a *surprise*, not the write. What is missing is the other half: an operator who has read the warning, understands the modem is down, and wants the rule written anyway — because the modem will come back and they do not want to remember to return — has no way to say so. Today the assignment simply never lands, and the UI word for that is `skip`, which reads like a failure rather than a decision awaiting one.

So §4.5 is kept, and completed.

---

## 1. Goals

1. A range of device numbers can be paired against a range of path indices in one operation, in both the Assignments tab and the group editor.
2. Nothing is written from the builder without a preview first — the plugin's own §4.4 rule ("plan, then apply — never write blind") applies to the builder exactly as it does to apply.
3. Rows can be selected and acted on in bulk.
4. Writing an assignment never costs the operator their place in the table.
5. An assignment onto a `down` path can be applied **deliberately and visibly**, and is still never applied silently.

## 2. Non-goals

- Changing what `skip` means in the planner, or removing `path-down` as a reason. §4.5 stands; §3.4 adds a decision beside it.
- `failoverPolicy: 'substitute'` (plan 122 §4.5's optional half). Not built here.
- Reworking the apply dialog's plan preview. It is the right shape; §3.4 adds one action to it.
- A general table-selection component for the whole product. This is the plugin's own table.

## 3. Context and design decisions

### 3.1 The builder pairs two ordered lists, and says so

Devices are ordered by their **number** (`#1`, `#2`, …) — the farm's own stable handle, and the one the owner thinks in. Paths are ordered as the Paths tab lists them, addressed by **index**. The builder takes a device number range and a starting path index, pairs them positionally, and shows the resulting pairs before anything is written.

Two cases the operator must be told about rather than left to discover:

- **More devices than paths from the start index.** Either wrap round-robin or stop at the end of the list. Whichever is chosen, the preview shows the actual pairs, so the behaviour is visible rather than described.
- **A device number in the range that does not exist**, or that already has an assignment. Both appear in the preview, marked, and are never silently dropped.

The preview is the feature. A builder that writes twenty rules on a typed range without showing its work is exactly what §4.4 forbids for the router, applied to the database instead.

### 3.2 Selection is per-row and the bulk bar states its scope

Checkboxes on the rows, a select-all that selects **the filtered rows** (the search box is already there), and a bulk bar naming exactly how many rows it will affect. `docs/design.md`'s rule — a filter must not lie about its scope — is the one that matters here: "Assign 20 devices" when the filter shows 6 is the failure mode.

### 3.3 A refresh is not a load

Fixed by distinguishing the two: the skeleton is for the **first** load, when there is nothing to show. A revalidation keeps the current rows mounted and marks them stale (a subtle busy affordance), so React never unmounts the table and the browser keeps the scroll position by itself.

This is not a scroll-restoration feature. It is the removal of a full unmount that should never have been on the refresh path.

### 3.4 Applying to a down path is a decision, not a default

The plan preview keeps reporting `skip` / `path-down` exactly as it does today, and it keeps being the default. What is added is one explicit action beside it — apply the down-path rows anyway — which:

- names how many rows it will write and which paths are down,
- is never pre-selected, never the primary button, and never reachable without the warning having been rendered first,
- records that the operator chose it, so a rule written onto a dead path is attributable afterwards rather than mysterious.

This satisfies §4.5's actual requirement (never *silently*) while removing the dead end. A `skip` the operator cannot act on is not a warning, it is an obstacle.

The word `skip` also stops being the last thing the UI says: a skipped row states what it is waiting for and what the operator can do about it.

### 3.5 What must keep working

- The planner's five row kinds and three skip reasons, unchanged (§2).
- §3.2's local-exception refusal — a builder cannot bypass it; it produces assignments, and apply still refuses on its own terms.
- The per-row assign, manual LAN IP entry, and unassign paths already in the table.
- The wall picker plan 129 put in the group editor.

---

## 4. Technical design

### 4.1 `bulk-builder.tsx` (new, shared by both tabs)

```ts
interface BulkPairing {
  /** Inclusive device-number range, as typed. */
  fromNumber: number
  toNumber: number
  /** Index into the ordered path list where pairing starts. */
  pathStartIndex: number
  /** What happens when devices outrun the path list. */
  overflow: 'wrap' | 'stop'
}

interface PairingRow {
  deviceNumber: number
  deviceId: string | null      // null = no device carries this number
  pathId: string | null        // null = ran out of paths under 'stop'
  pathLabel: string | null
  note: 'ok' | 'no-such-device' | 'already-assigned' | 'no-path'
}

/** Pure. The preview renders exactly what this returns; the writer consumes the same rows. */
export function buildPairings(input: BulkPairing, devices: FleetDeviceRow[], paths: Path[]): PairingRow[]
```

Pure and unit-tested first; the two call sites (Assignments, group editor) render the same preview from it.

### 4.2 Selection state (Assignments)

`selectedIds: Set<string>`, cleared when the filter changes (a selection that survives a filter change is a selection whose scope the operator can no longer see). Bulk actions: assign to one path, clear assignment, and add to a group.

### 4.3 The loader

`useLoader`'s consumers get `data` alongside `loading`; the early return becomes:

```ts
if (loading && !data) return <LoadingRows />   // first load only
```

with a stale marker while `loading && data`.

### 4.4 Apply-anyway

`ApplyDialog` gains a secondary action, enabled only when the plan contains `skip`/`path-down` rows, that re-runs apply with those rows included. The plan preview is re-rendered first, so the operator sees the rows they are about to force at the moment they force them.

---

## 5. Implementation steps

### 131.1 — `buildPairings`, pure and tested
- `plugins/mikrotik-routing/src/ui/parts/bulk-builder.tsx` (the pure function may live beside it or in `bits.tsx` — follow the file's own conventions).
- Tests: an exact-length range pairs 1:1; more devices than paths wraps or stops per `overflow`; a missing device number is `no-such-device` and never dropped; an already-assigned device is marked, not skipped; an inverted range (`to < from`) is rejected rather than silently swapped.
- **Result:** `cd plugins/mikrotik-routing && bun test src/` green.

### 131.2 — The builder in the Assignments tab
- Range inputs, path start index, overflow choice, the preview table, and a commit that writes only what the preview showed.
- **Result:** same command green.

### 131.3 — The builder in the group editor
- The same component, writing group entries instead of assignments.

### 131.4 — Selection and bulk actions
- Per §3.2 and §4.2, including the scope-honest bulk bar.

### 131.5 — A refresh stops unmounting the table
- Per §3.3 and §4.3. **This is the one an operator feels on every single write**, and it is three lines.
- Tests: a revalidation with data present keeps the rows mounted (assert the rows are still in the DOM while `loading` is true); a first load still shows the skeleton.

### 131.6 — Apply anyway, deliberately
- Per §3.4 and §4.4, plus the skipped-row copy.
- Tests: the action is absent when no row is `path-down`; present and non-primary when some are; it names the count; the default apply still skips them.

### 131.7 — Ship it
- **Bump `0.9.0 → 0.10.0` in all three sites** (`package.json`, `src/index.ts`'s `version:`, `src/index.test.ts`), add the changelog row, run `bun run build:packs`, confirm it emits `mikrotik-routing@0.10.0`. Minor, not patch: an operator meets every one of these the moment they open the tab. Without the bump `seedEmbeddedPacks` skips the pack and none of it reaches the farm — the failure mode this pack's own changelog already records twice.
- `docs/spec.md` if the plugin's described surface changes; update this plan's status line; `bash scripts/check-plan-status.sh` passes.

## 6. Acceptance criteria

1. A device-number range and a path start index produce a previewed pairing, and nothing is written before the preview is shown.
2. Every anomaly — missing number, already assigned, ran out of paths — is visible in that preview.
3. The same builder works in the group editor.
4. Rows can be selected; the bulk bar states a count that matches the filtered scope.
5. Assigning a path does not change the scroll position, and the table is never unmounted on a refresh.
6. A `path-down` row can be applied through an explicit, non-default action that names what it will write; the default apply still skips it.
7. `mikrotik-routing` is at 0.10.0 in all three sites with a changelog row, and `build:packs` emits it.
8. `bun run typecheck` passes; the plugin's tests pass; no process left running.

## 7. Test plan

Unit tests per step. **Needs the farm:** criterion 5 judged by actually assigning a device at row 30 and watching the scroll (the symptom that opened this plan); criterion 6 against a genuinely down modem; criterion 1 against 20 real devices and 20 real paths.

## 8. Risks and mitigations

| # | Risk | Mitigation |
|---|---|---|
| R1 | The builder writes twenty wrong assignments quickly. | The preview is mandatory and shows every pair (§3.1). Speed without a preview is the risk; with one it is the feature. |
| R2 | "Apply anyway" becomes the habitual button and §4.5's protection erodes. | Never primary, never pre-selected, only reachable after the warning renders, and attributable afterwards (§3.4). |
| R3 | Keeping stale rows mounted shows data that has just changed. | A stale marker while revalidating; the window is one request. Against it: a full unmount on every write, which is the current behaviour. |
| R4 | Selection surviving a filter change acts on invisible rows. | Cleared on filter change (§4.2). |

## 9. Open questions

1. **Wrap or stop, as the default** when devices outrun paths? §3.1 requires the preview either way; which is the less surprising default is a judgment the implementer should make from the owner's actual fleet shape (20 devices, ~22 paths) and state.
2. **Should the builder offer a stride** (every Nth path) rather than consecutive indices? Not built; the reported need is consecutive.
4. **Can two devices share a farm number?** §10 item 3 — `buildPairings` assumes not. If plan 89's allocator can produce a duplicate, the builder needs a `duplicate-number` anomaly rather than silently misreporting one of the pair as missing.

5. **Should "apply anyway" be per-row or all-down-rows-at-once?** §4.4 assumes the latter; per-row is more precise and more clicks.

## 10. Notes recorded during execution

1. **`overflow` has no default in `buildPairings`, deliberately, and `stop` is the recommendation.** 131.1's worker made the field required and pushed the choice to whichever step builds the control, with the reasoning on record: on a 20-device / ~22-path fleet the two modes barely differ, but where they do, `wrap` silently repoints a later device onto a path an earlier device already holds — two devices on one egress with no signal. `stop` leaves the excess numbers visibly `no-path` in the preview, which is a fact the operator can act on (shorten the range, add paths) rather than a silent double-assignment.

2. **`useLoader` already returned `data` alongside `loading`** — §4.3 assumed it and was right, so no shared hook was reshaped. The fix really was the one early return.

3. **`buildPairings` trusts `FleetDeviceRow.number` to be unique.** It looks devices up through a `Map` keyed on the number, so two devices sharing one would let the second overwrite the first and the earlier number would then read as `no-such-device` — a misreport, not a detected anomaly. 131.1's worker flagged it rather than inventing a fifth `PairingNote` value on its own initiative, which was the right call: the anomaly vocabulary is a UI contract, not an implementation detail. Whether the number allocator (plan 89) can ever produce a duplicate is not settled here. §9 Q4.

4. **`@enkaku/host` makes a plugin UI module untestable by static import — a consequence of plan 129 §3.4 that nobody anticipated.** `groups.tsx` statically imports `DeviceWallWithPicker` from `@enkaku/host`, which is never a real package on disk: it exists only as an ambient `.d.ts` and is resolved in the browser through Studio's import map. So `import './groups'` at the top of a test file fails **module resolution**, before a single line of test code runs — 131.3's worker verified this against a throwaway repro rather than guessing. The way through is `mock.module('@enkaku/host', …)` followed by a **dynamic** `await import('./groups')`, because `mock.module` only has to run before the importing module is *evaluated*, not before the graph resolves. `@enkaku/ui` needs none of this — it is a real workspace package.

    This is a tax on every future tier-C plugin that uses a host component, and it is not written down anywhere plan 129 put it. Worth a line in that plan's own docs, or in the SDK scaffold, before the next author rediscovers it the hard way.

5. **The duplicate-number ambiguity from item 3 is now surfaced, cheaply and honestly.** `duplicatedDeviceNumbers(devices)` counts over the array already in hand (O(n), no extra fetch), and the preview marks any row whose number is shared with "ambiguous, resolved to one of them". It deliberately does **not** claim which device won `buildPairings`'s `Map` lookup — that information is gone by the time the function returns — but the operator is told the number is ambiguous instead of being left to wonder why a device they expected reads as `no-such-device`. A surfacing, not a fix, and labelled as such.

6. **The group editor keeps both ways in.** The wall picker (plan 129) is for choosing by looking; the builder is for "devices 1 through 20 onto paths from index 3". `planBulkGroupEntries` reuses `addEntry`'s exact record shape — including the `lan.state === 'resolved'` fallback to `EMPTY_LAN` — rather than becoming a second way to build the same row, and a test asserts the two shapes match. One local anomaly was added for this call site alone (`alreadyInGroup`), because `buildPairings` cannot see a particular group's current entries; it is additive and does not touch the shared vocabulary.

7. **131.6's backend did not exist, and the plan allocated it to nobody.** §4.4 said the apply-anyway action "re-runs apply with those rows included" — but `executePlan` skipped `skip` rows unconditionally ("never touched, by construction") and the `/apply` route read no request body at all, so there was no parameter through which a client could force anything. 131.2/131.4/131.6's worker found this by reading `apply.ts` and `apply-routes.ts` in full, built the whole front end honestly rather than faking it, and added `rowsStillUnwritten` so the UI reported that the rows **still had not landed** instead of claiming a success it had not got. That was the right call at its scope boundary, and it is the difference between a feature that looks done and one that is.

    The missing half was built by the coordinator: `forceDownPaths` threaded through `runApply` → the route (parsed defensively, a malformed body forcing nothing) → `ApplyDeps` → `buildPlan`.

8. **The forcing belongs in the planner, not the executor — and that is the whole point.** Putting it in `executePlan` would have left the preview saying `skip` while the write happened anyway: plan 122 §4.5's silent surprise, reached from the opposite direction. In the planner, a forced entry skips only the health check and falls through to `resolveTarget` like any other, so it becomes the real `create`/`update` it will be, flagged `forcedOverDownPath`. The operator sees the actual write in the preview before it happens, which is §4.4's guarantee preserved rather than sidestepped. `path-missing` and `duplicate` are deliberately not forceable — a routing table that does not exist cannot be written to, and §4.3 refuses a duplicate rather than guessing. Six planner tests cover this, and the `overDownPath` guard was mutation-tested (loosened → 1 failure → restored).

9. **The flag means "written over a dead path", not "was in the forced set".** A healthy path whose endpoint happens to appear in the set gets no flag — asserted by its own test, because a flag that fires on intent rather than on fact would make the audit trail lie.