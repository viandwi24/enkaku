# Plan 19 — M11c : Tags, Labels, and the Device Picker

> Status: implemented (2026-08-02)
> Depends on: Plans 01–16 complete. **Blocks Plan 20** (clusters target devices by tag).
> Spec references: §7.5 (device identity), §12 (entities), §13 (protocol).

---

## 1. Goals

- A device carries any number of **tags** (`pool:smoke`, `region:jkt`, `android:15`), editable from the UI and the API.
- Every place that picks a device shows enough to tell two identical phones apart, and never presents a name alone.
- The picker can select **by tag**, not only by clicking individual devices.
- Devices that cannot take the job stay visible **with the reason**, instead of silently vanishing from the list.
- The devices list can filter and group by tag.

## 2. Non-goals

- Clusters, batch runs, execution order — Plan 20. Tags are the substrate those are built on; this plan stops at tags.
- Schedules — Plan 21.
- Per-tag permissions or ownership. `devices.ownerId` and the Plan 09 ACL stay as they are.
- Auto-tagging from device properties. Recorded as an open question.

## 3. Context and design decisions

### 3.1 Why tags and not a cluster column

The obvious move is a `clusterId` column on `devices`. It is also the wrong one: a device belongs to exactly one cluster, so the moment you want "all Android 15 phones" *and* "the smoke-test pool" you are duplicating devices or inventing a second column.

Tags are many-to-many and compose. A cluster (Plan 20) then becomes a **saved selector over tags**, not a physical grouping, and a device joins a cluster by acquiring a tag rather than by being moved.

The `key:value` convention (`pool:smoke`) is a convention, not a schema: tags are opaque strings, and the UI merely renders anything before the first `:` as a dimmed prefix. Encoding structure in the schema would force a migration the first time someone wants a third level.

### 3.2 Why the current picker is not good enough

`packages/studio/src/components/RunScriptDialog.tsx` renders a `Select` of device labels. On this farm two physically distinct phones both report `moto g06 power`, so the list reads:

```
moto g06 power
moto g06 power
```

There is no way to tell which is which, and the wrong pick is silent and destructive — the job runs on someone else's phone. The picker must show the `stableId` (the real identity per spec §7.5) alongside the label, plus status and tags.

The same component also filters out unusable devices entirely (`status !== 'offline' && status !== 'quarantined'`). That hides information: a person looking for a device they know exists concludes it was deleted. Show it, disabled, with the reason.

### 3.3 Normalised tags, not a JSON column

Tags could live in a JSON array on `devices`. Filtering "every device with tag X" would then mean scanning and parsing every row, and Plan 20 does exactly that on every batch dispatch.

A join table costs one migration and makes the query an index lookup:

```sql
SELECT device_id FROM device_tags WHERE tag = ?
```

### 3.4 Tag hygiene

Free-form strings rot: `Pool:Smoke`, `pool:smoke`, `pool: smoke` become three tags. Normalise on write — trim, lowercase, collapse internal whitespace, reject anything outside `[a-z0-9:._-]` — and surface existing tags as suggestions in the editor so people reuse rather than reinvent.

## 4. Technical design

### 4.1 Schema

`packages/core/src/db/schema.ts`:

```ts
export const deviceTags = sqliteTable(
  'device_tags',
  {
    deviceId: text('device_id').notNull(),
    /** Normalised on write (Plan 19 §3.4): lowercase, trimmed, [a-z0-9:._-]. */
    tag: text('tag').notNull(),
    at: integer('at', { mode: 'timestamp' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.deviceId, t.tag] }),
    // Plan 20 resolves clusters with this one.
    index('idx_device_tags_tag').on(t.tag),
  ],
)
```

`devices` is unchanged. Deleting a device must delete its tag rows — do it in the same transaction as the device delete rather than relying on a foreign key, matching how the rest of the schema handles cleanup.

### 4.2 Protocol

`packages/protocol/src/device.ts` — `DeviceInfoSchema` gains:

```ts
/** Sorted, normalised. Empty array rather than null, so callers need no guard. */
tags: z.array(z.string()).default([]),
```

Every producer of `DeviceInfo` must fill it: `rowToDeviceInfo` in `packages/core/src/registry/device-registry.ts` and the remote-device path in `packages/core/src/tunnel/registry.ts`. A device from an agent carries the tags the control plane holds for it, not the agent's.

Tag normalisation lives in the protocol package so the core and Studio cannot disagree:

```ts
// packages/protocol/src/tags.ts
export const TagSchema = z.string().transform(normaliseTag).pipe(z.string().regex(/^[a-z0-9][a-z0-9:._-]{0,63}$/))
export function normaliseTag(raw: string): string
```

### 4.3 API

```
GET    /api/tags                      → { tags: { tag: string; count: number }[] }
PUT    /api/devices/:id/tags          body { tags: string[] }  → { tags: string[] }
GET    /api/devices?tag=<t>&tag=<u>   → devices carrying ALL listed tags
```

`PUT` replaces the whole set in one transaction — simpler to reason about than add/remove endpoints, and it makes the editor a plain form. It writes an `audit_log` entry (`device.settings`, target the device, meta the tag diff).

`GET /api/devices` keeps its existing shape; `tag` is an additive optional filter, repeatable and ANDed. AND rather than OR because the common farm query is a narrowing one ("smoke pool **and** Android 15").

### 4.4 Studio: the picker

New shared component `packages/studio/src/components/DevicePicker.tsx`, replacing the `Select` inside `RunScriptDialog` and used anywhere a device is chosen:

```tsx
<DevicePicker
  devices={devices}
  value={deviceId}
  onChange={setDeviceId}
  /** Plan 20 switches this on for batches. */
  multiple={false}
/>
```

Each row shows: label · `stableId` (in the `readout` monospace style) · status badge · tags. A search box filters across label, stableId and tags at once — one field, because a person searching does not first classify what they are searching by.

Unavailable devices render disabled with the reason from the existing `UNAVAILABLE_REASON` map in `packages/studio/src/app/device/page.tsx` — move that map to the shared component so the device page and the picker cannot drift apart.

Selecting by tag: a row of tag chips above the list; clicking one filters, and with `multiple` it selects every matching device at once.

### 4.5 Studio: tag editing and the devices list

- Device page → Settings tab gains a **Tags** field: a token input with suggestions from `GET /api/tags`, showing the normalised form as you type so the transformation is never a surprise.
- `/` (the devices list) gains a tag filter bar and an optional **Group by tag** toggle. Grouping is a view concern; the data is unchanged.

## 5. Implementation steps

### 19.1 Protocol and normalisation
- [ ] `packages/protocol/src/tags.ts` with `normaliseTag` and `TagSchema`; export from `index.ts`.
- [ ] Add `tags` to `DeviceInfoSchema`.
- [ ] Unit tests: `' Pool: Smoke '` → `pool:smoke`; `'has space'` → `has-space` or rejected (pick one and test it); over-long and out-of-charset input rejected.
- Result: typecheck green; the rule lives in exactly one file.

### 19.2 Schema and migration
- [ ] Add `deviceTags`; `bun run --cwd packages/core db:generate`; commit the SQL.
- [ ] Delete tag rows in the device-delete transaction.
- Result: `.schema device_tags` shows the composite primary key and the tag index.

### 19.3 Core: reads and writes
- [ ] Load tags in `rowToDeviceInfo` (one grouped query for a list, not N+1).
- [ ] `GET /api/tags`, `PUT /api/devices/:id/tags`, and the `tag` filter on `GET /api/devices`.
- [ ] `audit_log` entry on tag change.
- Result: `curl -X PUT .../tags -d '{"tags":["pool:smoke"]}'` returns the normalised set; `GET /api/devices?tag=pool:smoke` returns only that device.

### 19.4 Studio: DevicePicker
- [ ] Build `DevicePicker.tsx` per §4.4; move `UNAVAILABLE_REASON` into it.
- [ ] Replace the `Select` in `RunScriptDialog.tsx`.
- Result: two identically labelled phones are distinguishable in the run dialog.

### 19.5 Studio: editing and filtering
- [ ] Tags field on the device Settings tab.
- [ ] Tag filter bar and group-by toggle on the devices list.
- Result: tagging a device from the UI is immediately reflected in the picker and the list filter.

## 6. Acceptance criteria

1. A device can be given, changed, and cleared of tags from the UI, and the change is audited.
2. Tags are normalised identically by the core and Studio — `' Pool: Smoke '` typed in the UI produces the same stored value as the same string sent to the API.
3. The run dialog distinguishes two devices with the same label, using the stableId.
4. Offline and quarantined devices appear in the picker, disabled, with the reason.
5. `GET /api/devices?tag=a&tag=b` returns only devices carrying both.
6. The devices list filters and optionally groups by tag.
7. Loading a list of 50 devices issues one tags query, not 50.
8. `bash scripts/typecheck.sh` and `bun test` are green.

## 7. Test plan

**Unit**
- `packages/protocol/src/tags.test.ts` — normalisation and rejection table.
- `packages/core/src/api/devices.test.ts` — multi-tag AND filtering; tag replacement is atomic; deleting a device removes its tags.

**Manual smoke**

```bash
bun run dev
curl -s -X PUT 127.0.0.1:7700/api/devices/<idA>/tags \
  -H 'content-type: application/json' -d '{"tags":[" Pool: Smoke ","android:15"]}'
#   expect: {"tags":["android:15","pool:smoke"]}
curl -s '127.0.0.1:7700/api/devices?tag=pool:smoke&tag=android:15' | jq '.devices|length'
# open /scripts → Run → the picker shows label · stableId · status · tags
# unplug one device → it stays listed, disabled, "The device is not connected to this farm"
```

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Tag sprawl makes the filter bar useless. | Suggestions from `GET /api/tags` with counts, so the reusable tags are the visible ones. A cleanup view can come later. |
| N+1 queries when listing devices with tags. | One `WHERE device_id IN (…)` query grouped in memory; asserted by the acceptance criterion. |
| Normalisation differs between client and server. | The function lives in `@enkaku/protocol` and both import it; the unit test is the contract. |
| Renaming a tag orphans a Plan 20 cluster that references it. | Out of scope here; Plan 20 must resolve clusters at dispatch time and report "no devices matched" rather than failing silently. Noted in that plan's risks. |

## 9. Open questions

1. Auto-tags derived from device properties (`android:15`, `oem:motorola`) — generated and read-only, or just suggested at enrolment? Proposed: suggest at enrolment, keep all tags user-owned, so nothing fights the user for control of the field.
2. Should tags sync to and from cloud agents (Plan 11) so an agent can pre-tag the devices it brings? Proposed: control plane owns tags; the agent may propose them at enrolment only.
3. **DECIDED (2026-08-02): a device may match many clusters.** The product owner
   was asked whether to restrict a device to at most one cluster and chose to keep
   the many-to-many model. Cluster membership stays a saved selector over tags, not
   exclusive ownership. Do not reintroduce a `clusterId` column on `devices`.
4. Is AND the right default for multi-tag filtering, with OR available via syntax? Proposed: AND only for now — a second semantic needs a UI to express it, and there is no evidence yet that people want OR.
4. §4.1 says a device delete must remove its tag rows "in the same transaction as the device delete." As implemented (M0–M11b), there is no device-delete endpoint or "forget device" feature anywhere in the spec or in any plan — devices only ever go `offline`, never get removed from the registry. `packages/core/src/registry/device-tags.ts` exports `deleteDeviceTags(db, deviceId)` for this, covered by a unit test that simulates the transaction, but nothing calls it yet. Whichever plan eventually adds device deletion must call it inside that transaction, not rely on a foreign key (`device_tags` deliberately has none).
