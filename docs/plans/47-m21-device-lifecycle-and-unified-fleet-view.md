# Plan 47 — M21 : Device Lifecycle (Forget / Block) and One Fleet View

> Status: implemented — Forget/Block lifecycle service, blocked/deleted-device schema, API routes, and the merged List/Wall fleet page all shipped.
> Ships: packages/core/src/device/lifecycle.ts
> Depends on: Plan 22.0 (`devices.clusterId`), Plan 32 (topology tiles), Plan 42 (the Wall, `TileGrid`), Plan 45 (readiness) if it has landed — none are hard blockers.
> Spec references: §7.5 (device identity is `stableId`), §10.1 (server-authoritative control), §12 (entities), §15 (device lifecycle).

---

## 1. Goals

- A device can be **removed** from the farm. Today there is no way at all — verified: no `DELETE` route, and no code anywhere deletes a `devices` row.
- Removing a device that is physically connected is possible too, via a **block**, because a plain delete cannot work for a connected device (§3.2).
- Job history, artifacts, and the event log are **not** destroyed as a side effect of removing a phone. Deleting history is a separate, explicit, counted choice.
- Devices and Topology become **one page**: same list, different view and grouping, instead of two routes showing the same entities.
- Grouping applies to the table too, not only to tiles — "show me my devices grouped by cluster" should not require switching to a tile view.

## 2. Non-goals

- Un-enrolling a cloud agent, or removing an agent's devices from the control plane. Recorded in §9.
- Bulk-importing or pre-registering devices before they appear.
- Changing `stableId` derivation (spec §7.5). Identity is unchanged; this plan only adds a lifecycle around it.
- Deleting scripts, batches, or schedules that reference a removed device. They keep working; §3.4 explains what they show.

## 3. Context and design decisions

### 3.1 There is no delete, anywhere

`grep` across `packages/core/src` finds no route and no query that removes a `devices` row. The registry only ever inserts (`device-registry.ts:174`, an upsert keyed by `stableId`).

The practical consequence is visible on any farm that has been used for a while. This one currently lists `Test Phone` (a fabricated fixture), `VERIFY123`, and two `serial:127.0.0.1:…` rows left over from earlier testing — all permanently offline, all unremovable, all cluttering every picker, every filter, and the Wall.

### 3.2 A delete cannot work for a connected device, so there are two operations

`device-registry.ts:174` upserts by `stableId` on every `track-devices` event. Delete the row of a device that is plugged in, and it returns within milliseconds — with a fresh `id`, which is worse than not deleting it, because tags and cluster membership are lost while the clutter stays.

So one verb cannot serve both cases, and pretending otherwise would produce exactly that bug:

| Verb | For | Effect |
|---|---|---|
| **Forget** | a device that is not physically present | removes the row, its tags, its cluster membership |
| **Block** | a device that *is* present but should not be managed | the registry skips it on sight; it disappears from the fleet and stays gone |

Forgetting an online device is refused, with the reason and a one-click offer to block instead. That refusal is the whole design working: it says the thing the operator did not know.

### 3.3 Block is keyed by `stableId`, and it is the only thing that survives a replug

`stableId` is the identity (spec §7.5); the adb serial is a transport address. A block list keyed on anything else would be defeated by a different USB port or a switch to `adb-tcp`.

A blocked device is skipped by the registry before probing, so it costs nothing and never appears. It remains visible on a **Blocked devices** list in settings, with when and by whom, and can be unblocked there — a block you cannot find again is indistinguishable from a bug.

### 3.4 History is not collateral damage

`jobs`, `artifacts`, `device_events`, and `audit_log` all reference a device. The tempting move is a cascade delete; it is the wrong default for a QA farm, where "what happened on the phone we retired last month" is a question people genuinely ask.

So forgetting a device removes: the `devices` row, its `device_tags`, and its cluster membership. It leaves: jobs, artifacts, events, audit entries — with their `deviceId` intact but dangling.

Every UI that renders a device reference must therefore tolerate a missing device and show `deleted device (<stableId>)` rather than a blank or a crash. A short `deleted_devices` record (id, stableId, label, deletedAt) makes that label possible without resurrecting the row, and is what makes this design honest rather than merely convenient.

Deleting history is available, explicitly: a second checkbox, which first **shows the counts** ("142 jobs, 38 artifacts, 2,104 events") and requires confirming those numbers. Nobody should discover that number afterwards.

### 3.5 Safety rules

| Situation | Forget | Block |
|---|---|---|
| device `busy` (a job is running) | refused | refused |
| an active manual lease | refused | refused |
| device online, idle | refused — "still connected; block it instead" | allowed |
| device offline | allowed | allowed |
| device quarantined, offline | allowed | allowed |

All enforced server-side (spec §10.1) and recorded on the Plan 18 main stream as `device.forgotten` / `device.blocked` / `device.unblocked`, with the actor. Removing a phone from a shared farm is exactly the kind of act that should be answerable later.

### 3.6 Topology is not a page, it is a grouping

`packages/studio/src/app/topology/page.tsx` and the devices list render the same entities from the same data. Plan 42 already unified the *component* — `TileGrid` is shared — so what remains duplicated is only the navigation, which forces an operator to decide "which page shows this?" for information that lives in both.

Two orthogonal controls replace the two pages:

- **View**: `list` (table) or `wall` (live tiles, Plan 42)
- **Group by**: `none`, `cluster`, `status`, or `tag`

Topology becomes `view=wall&group=cluster`. The old `/topology` route redirects there, so existing links keep working.

The gain is not only tidiness: grouping now applies to the table as well, which topology never offered — a grouped table is what someone auditing a rack actually wants, and today they cannot have it.

## 4. Technical design

### 4.1 Schema

```ts
/** A device deliberately excluded from the farm (plan 47 §3.3), keyed by identity. */
export const blockedDevices = sqliteTable('blocked_devices', {
  stableId: text('stable_id').primaryKey(),
  label: text('label'),
  reason: text('reason'),
  blockedAt: integer('blocked_at', { mode: 'timestamp' }).notNull(),
  blockedBy: text('blocked_by'),
})

/** Just enough to label a dangling reference (plan 47 §3.4). */
export const deletedDevices = sqliteTable('deleted_devices', {
  id: text('id').primaryKey(),          // the old devices.id
  stableId: text('stable_id').notNull(),
  label: text('label'),
  deletedAt: integer('deleted_at', { mode: 'timestamp' }).notNull(),
})
```

### 4.2 Registry

`device-registry.ts` consults `blockedDevices` **before** probing a newly seen serial: a blocked `stableId` is skipped, logged once at `debug`, and never inserted. Blocking is therefore free at steady state.

The block check happens after `stableId` is known, which means one probe per appearance — unavoidable, since the serial alone cannot identify the device.

### 4.3 Service — `packages/core/src/device/lifecycle.ts` (new)

```ts
export interface DeviceLifecycle {
  forget(deviceId: string, opts: { deleteHistory: boolean; actor: Actor }): Promise<ForgetResult>
  /** Counts shown before confirming (§3.4) — never destructive. */
  historyCounts(deviceId: string): Promise<{ jobs: number; artifacts: number; events: number }>
  block(deviceId: string, opts: { reason?: string; actor: Actor }): Promise<void>
  unblock(stableId: string, actor: Actor): Promise<void>
  listBlocked(): Promise<BlockedDevice[]>
}
```

`forget` runs in one transaction: check the §3.5 rules → write `deletedDevices` → delete `device_tags` → clear cluster membership → delete the `devices` row → optionally delete history → record the event.

`block` forgets **and** blocks in the same transaction, since a blocked device that stayed in the list would be the confusing half-state.

### 4.4 API

```
DELETE /api/devices/:id                 ?deleteHistory=true|false
GET    /api/devices/:id/history-counts
POST   /api/devices/:id/block           { reason? }
GET    /api/devices/blocked
DELETE /api/devices/blocked/:stableId
```

All require `device.settings` (the permission cluster and tag mutations already use, wired by Plan 34) and enforce §3.5 server-side.

### 4.5 Studio

**One fleet page** (`packages/studio/src/app/page.tsx`): a `view` control (List | Wall) and a `group` control (None | Cluster | Status | Tag), both in the query string so a view is linkable. `/topology` becomes a redirect.

**Removal**: a per-device action in the table row menu and on the device page. The dialog states plainly what will happen — what is removed, what is kept — and when "also delete history" is ticked it shows the counts from §4.3 before the confirm button enables. A refusal (§3.5) shows the reason and, for the online case, a "Block instead" button.

**Bulk**: multi-select gains **Forget selected**, which is the operation this farm needs today for its four dead rows. The dialog lists exactly which devices will be removed and skips those the rules refuse, naming them.

**Blocked devices**: a section in farm Settings listing blocked entries with when, by whom, and reason, and an Unblock action.

**Dangling references**: job detail, batch reports, and the event log render `deleted device (<stableId>)` from `deletedDevices` instead of a blank.

## 5. Implementation steps

**47.1 — Schema and migration.** `blocked_devices`, `deleted_devices`; `bun run --cwd packages/core db:generate`.

**47.2 — Registry block check** (§4.2), with a test proving a blocked device is never inserted even across repeated appearances.

**47.3 — Lifecycle service** (§4.3): the rule matrix, the transaction, history counts, block/unblock.

**47.4 — API and events** (§4.4), including the audit entries.

**47.5 — Dangling-reference rendering.** Job detail, batch report, event log, device picker.

**47.6 — One fleet page** (§4.5): view × group controls, the `/topology` redirect, grouping applied to the table.

**47.7 — Removal UI**: per-device action, the counts dialog, the block-instead path, bulk forget, the blocked list in settings.

## 6. Acceptance criteria

1. An offline device can be forgotten; it disappears from the list, its tags and cluster membership are gone, and it does not return.
2. Forgetting an online device is refused with the reason, and the dialog offers Block instead.
3. Blocking a connected device removes it from the fleet and it does **not** reappear after a replug or a switch to a different USB port.
4. Unblocking it lets it return on the next connection, with a fresh row.
5. Forget without "delete history" leaves jobs, artifacts, and events intact, and they render `deleted device (<stableId>)`.
6. "Delete history" shows accurate counts before the confirm is enabled, and deletes exactly those rows.
7. Forget and block are both refused while a job is running or a manual lease is held, each with its own reason.
8. Every removal is recorded with the actor on the main stream and in the audit log.
9. Bulk forget removes every eligible selection and names each one it skipped, with why.
10. The fleet page renders both views and all four groupings; grouping works in the table, not only in tiles.
11. `/topology` redirects to the grouped wall view and old links keep working.
12. Rules are enforced server-side: calling the API directly is refused exactly as the UI is.
13. `bun run typecheck` passes; `bun test` is green.

## 7. Test plan

**Unit:** `lifecycle.test.ts` — the §3.5 matrix, transactional forget (a failure part-way leaves nothing half-removed), history counts matching what is deleted, block-implies-forget. `device-registry.test.ts` — a blocked `stableId` is skipped across repeated appearances and after a serial change. Rendering tests for the dangling-reference label.

**Manual smoke (`ENKAKU_TEST_DEVICE=1`, a real device):**
```bash
bun run dev && bun run dev:studio
# 1. forget the four dead rows on this farm (Test Phone, VERIFY123, two serial:127.0.0.1:*)
#    → gone, and still gone after a restart
# 2. try to forget a connected device → refused, "Block instead" offered
# 3. block it → disappears; unplug, replug, try another USB port → still absent
# 4. unblock → returns on reconnect
# 5. run a job, then forget that device without history → job detail still opens and
#    shows "deleted device (<stableId>)"
# 6. forget another with history → counts shown, and those rows are gone afterwards
# 7. fleet page: List × group by cluster, Wall × group by cluster; /topology redirects
```

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Someone deletes a device and loses months of job history they needed. | History is kept by default; deleting it is a separate checkbox that shows the counts first and requires confirming them (§3.4, §6.6). |
| A forgotten device silently returns with a new id, losing its tags and cluster. | Forgetting an online device is refused outright (§3.5); block is the supported path, and it is keyed by `stableId` so a replug or a different port cannot defeat it. |
| A blocked device is forgotten about and someone spends an afternoon wondering why a phone will not appear. | Blocked entries are listed in Settings with when, by whom, and reason; the registry logs a skip at `debug`; and `enkaku doctor` (Plan 41) is the natural place to surface "3 devices are blocked" — recorded in §9. |
| Dangling references crash a page that assumed the device exists. | `deleted_devices` supplies a label, and §5.5 walks every render site; a rendering test covers each. |
| Merging the pages loses something topology did well. | Topology's content is preserved exactly — it becomes `view=wall&group=cluster`, and the old route redirects rather than 404s. |

## 9. Open questions

1. Should `enkaku doctor` report blocked devices? It is the right place; deferred so this plan stays bounded.
2. Cloud/agent devices: forgetting one in the control plane while the agent still reports it would resurrect it on the next `agent.devices`. The block list is the mechanism, but the agent path needs its own pass.
3. Should a forgotten device's artifacts be garbage-collected by the existing retention job even when history is kept? Currently they follow the normal retention rules.
