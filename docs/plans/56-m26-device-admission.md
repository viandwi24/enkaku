# Plan 56 — M26 : Device Admission (a farm you opt into, not out of)

> Status: implemented — admission table, `classify`/`admitDevice`, registry routing, the tray API, the Studio tray, the forget-returns-to-tray change, and §3.6's route teardown. Verified end to end on a moto g06 power (§7).
> Ships: packages/core/src/registry/admission.ts
> Depends on: Plan 01 (the registry: tracker → probe → upsert), Plan 47 (forget/block lifecycle, `blocked_devices`).
> Spec references: §7.5 (stable identity), §10.1 (server-authoritative), Plan 18 (the device event log).

---

## 1. Goals

- A phone that connects to adb does **not** join the farm. It appears in a **Discovered** tray and waits.
- Admission is a deliberate act: an operator names the device and adds it, or leaves it alone.
- Removing a connected device from the farm stops requiring a block — it returns to Discovered.
- Nothing already in the farm changes. Existing devices stay admitted, with no migration of their rows.

## 2. Non-goals

- Replacing the block list. Block stays the outer layer: a blocked `stableId` never reaches the tray.
- Auto-admission rules (by model, by serial prefix, by cluster). Deliberate means deliberate; a rule that admits devices is the thing this plan removes.
- A setting to turn admission off. Decided with the operator: **always manual**, in every mode. One behaviour, nothing to explain, nothing to test twice.
- Changing enrollment itself (USB authorisation, wireless pairing). Those still bring a device to adb; this plan governs what happens next.

## 3. Context and design decisions

### 3.1 The farm is currently a denylist, and that is the defect

Today the registry does tracker → probe → **upsert into `devices`** (plan 01 §4.5). Every phone the adb server sees becomes a farm device: schedulable, leasable, listed. The only way to say no is to react afterwards.

That is backwards for a farm running on a workstation. The same adb server serves Android Studio, so a developer's personal phone, a colleague's phone plugged in to charge, and a phone under test for something unrelated all join a device farm that can hand them to a job.

Reported by the operator, in their own words: *"yang konek ke adb ga boleh langsung ke register dan masuk devices list kita."*

### 3.2 The trap this also removes

Plan 47 §3.2 refuses to forget a connected device and offers a **block** instead. That is correct given today's model — a plain delete cannot work, because the registry would re-add the device on its next event.

But it forces an operator who only wants a device *out of the farm* to declare it *permanently unwelcome*. The operator hit exactly this: they blocked in order to delete, the block outlived the device row (it is keyed on `stableId`, plan 47 §3.3), and the phone could not come back. Nothing was broken; the only path offered was heavier than the intent.

With admission, "remove from farm" on a connected device has an honest destination: the Discovered tray. Block remains for "never again", which is a different sentence.

### 3.3 A separate table, not a device status

A discovered device could be a sixth `DeviceStatus`. It should not be.

`devices` rows are farm members: the scheduler picks from them, the lease manager leases them, the wall renders them, clusters contain them, topology draws them. Adding a status means every one of those paths must remember to exclude it — a filter that has to be right in a dozen places and can only ever be wrong once.

So admission mirrors `blocked_devices` (plan 47 §3.3): a table keyed on `stableId`, holding no device row at all.

| Consequence | Result |
|---|---|
| Scheduler, leases, wall, clusters, topology | **unchanged** — they query `devices`, which now only ever contains admitted devices |
| Existing devices | admitted by construction; no migration rewrites them |
| A discovered device | cannot be leased or scheduled, because there is nothing to lease |

### 3.4 An unadmitted phone is still probed, and that is worth saying out loud

To show anything more useful than a serial number, the registry must probe: `ro.product.model`, `ro.build.version.release`, and the `stableId` resolution itself (spec §7.5). So a phone that has **not** been admitted does receive a handful of read-only `getprop` calls.

That is judged acceptable — adb access was already granted by the operator through the USB authorisation dialog, and without it the tray would ask someone to admit `ZP2222RMBS` with no way to tell which phone that is. It is recorded here rather than left for someone to discover, because "we ran commands on a device you never added" is a reasonable thing to object to.

Nothing else runs: no scrcpy, no guest agent, no ui-server, no network route.

### 3.5 Dismiss is not block

The tray offers **Add to farm** and **Dismiss**. Dismiss removes the entry; the device reappears the next time it connects.

That is deliberate. A dismissal that silently persisted would be a block wearing a lighter word, and an operator who wants "never again" has a control that says so. The tray showing the same phone again after a reconnect is the honest behaviour, not an oversight.

### 3.6 Removing a device hands the phone its network back

Making `forget` work on a connected device (§3.2) exposed something that had never been reachable before: **`lifecycle.ts` has no idea the network layer exists.** Not a stale reference to it — zero references. It deleted the device row and forgot, leaving whatever we had started on the phone still running.

Found by testing this plan on hardware, not by reading. A `vpn-helper` route was left on a moto g06 for 75 minutes: the tunnel held every packet closed while the core had no record that the device, let alone the route, had ever existed. The phone looked broken and nothing in Enkaku admitted responsibility. It took `dumpsys connectivity` to find; an operator never would.

**The two events must stay different, and only one of them is ours to change.**

| Event | Behaviour | Owner |
|---|---|---|
| Core crashes, disconnects, goes quiet | **Hold the route closed** | the device's dead-man's switch (plan 54) — untouched |
| An operator removes the device | Tear the route down cleanly | this plan |

The first is not a bug to fix. Tearing a tunnel down when contact is lost would drop traffic back to the real connection, which is precisely the leak plan 54 exists to prevent. It is also verified: on hardware, with a route up and the core silent, the agent logged `no contact from the farm for 94237ms — holding the route closed`, and the device answered a ping with 100% packet loss while `tun0` still held the default route. Nothing in this plan touches `DeadMansSwitch.kt`, `handleFailure`, or `failClosed`.

So `forget` and `block` call `GuestAgentRoutesHandle.revertNetwork`, whose own contract already says it is "for an operator's explicit act — never automatically on lease release/expiry/disconnect". The semantics were right; only the wiring was missing.

**Ordering is the fix.** The route comes down while the device row still exists, because everything that knows how to reach the phone is keyed on it. Deleting the row first is what stranded the tunnel.

**A failed teardown does not abort the removal.** Refusing would rebuild the trap §3.2 removed — an operator unable to get a device out of the farm. And the failure mode is safe on its own: a route that could not be torn down stays held closed, so the phone blocks traffic rather than leaking it. It is recorded as `network.orphaned` so the state is answerable later rather than invisible. Blocked-and-noisy is acceptable; leaking quietly is not.

What this cannot cover is the reason the orphan detector in §9 matters: a core killed mid-route, a reset database, or a phone that was offline when it was forgotten all produce the same orphan with no removal to hook onto.

## 4. Technical design

### 4.1 Schema

`packages/core/src/db/schema.ts`, a new table beside `blockedDevices`:

```ts
export const discoveredDevices = sqliteTable('discovered_devices', {
  stableId: text('stable_id').primaryKey(),
  /** Transport address at last sight — informational; identity is stableId (spec §7.5). */
  serial: text('serial').notNull(),
  /** Best-effort label from the probe (`ro.product.model`), so the tray is readable. */
  label: text('label'),
  androidVersion: text('android_version'),
  firstSeen: integer('first_seen', { mode: 'timestamp' }).notNull(),
  lastSeen: integer('last_seen', { mode: 'timestamp' }).notNull(),
})
```

Migration adds the table only. No existing row is read or rewritten — §3.3's grandfathering is structural, not a data step.

### 4.2 The registry decision

`packages/core/src/registry/admission.ts` (the artefact this plan ships) holds one function, so the branch exists in exactly one place:

```ts
export type Admission = 'blocked' | 'admitted' | 'discovered'

export function classify(db: Db, stableId: string): Admission
```

`device-registry.ts` consults it after the probe resolves `stableId`:

- `blocked` → skip, exactly as today (plan 47 §3.4).
- `admitted` → the current path, unchanged: upsert `devices`, broadcast `device.added` / status.
- `discovered` → upsert `discovered_devices`, broadcast `device.discovered`. **No `devices` row is written.**

On disconnect, a discovered device's `lastSeen` is left as it was and the entry stays — the tray is a list of phones seen, not phones currently plugged in, and a phone that vanished mid-decision should not disappear from the operator's queue.

### 4.3 API

`packages/core/src/api/devices.ts`, alongside the existing `/blocked` routes:

| Route | Permission | Behaviour |
|---|---|---|
| `GET /api/devices/discovered` | `device.settings` | the tray |
| `POST /api/devices/discovered/:stableId/admit` | `device.settings` | body `{ label?, clusterId?, tags? }` → creates the `devices` row, deletes the discovered row, broadcasts `device.added` |
| `DELETE /api/devices/discovered/:stableId` | `device.settings` | dismiss (§3.5) |

Admission is idempotent against a race: if a `devices` row for that `stableId` already exists, the discovered row is deleted and the call succeeds rather than erroring — two operators pressing Add at once is not a failure.

`POST /:id/forget` (plan 47) gains the case its refusal used to cover: a **connected** device is now removable, and lands back in `discovered_devices` instead of being refused with an offer to block. The refusal text and its one-click block offer are deleted, not reworded.

### 4.4 Events

Recorded on the Plan 18 main stream, with the actor: `device.discovered` (actor `null` — the system saw it), `device.admitted`, `device.dismissed`. Admitting a phone into a shared farm is exactly the kind of act that should be answerable later, which is the same argument plan 47 §4.4 makes for block.

### 4.5 Studio

- The fleet page grows a **Discovered (n)** entry point. It is not a tab competing with List/Wall — an empty tray should cost nothing visually, so it appears only when `n > 0`.
- The wizard is one dialog: model and Android version shown as read-only facts, then label (prefilled from the probe), cluster, and tags. **Add to farm** and **Dismiss**.
- `device.discovered` over WS updates the count live, the same way the fleet list already updates.

## 5. Implementation steps

### 56.1 Schema and classification
- [x] `discovered_devices` table plus generated migration.
- [x] `admission.ts` with `classify`, and its unit tests: blocked wins over admitted, admitted wins over discovered, unknown → discovered.
- Result: the decision is one function with tests, before anything calls it.

### 56.2 Registry
- [x] `device-registry.ts` routes on `classify`; a discovered device never reaches the `devices` upsert.
- [x] Test: a probe for an unknown `stableId` leaves `devices` empty and writes one `discovered_devices` row.
- Result: connecting a new phone no longer creates a farm device.

### 56.3 API
- [x] The three routes in §4.3, with the idempotent-admit case tested.
- [x] `forget` on a connected device returns it to the tray; the block-instead refusal is removed.
- Result: a device can complete the full round trip — discovered → admitted → forgotten → discovered.

### 56.4 Studio
- [ ] The tray entry point, the wizard, and the live count.
- Result: the flow is usable without curl.

### 56.5 Docs
- [x] `docs/guide/enrollment.md`: both USB and wireless sections end at the tray, not at "the device appears with status idle". That sentence becomes wrong the moment 55.2 lands.
- [x] `docs/spec.md` §7.5 gains admission as a concept, since it changes what a farm device *is*.
- Result: the guide does not describe the old behaviour.

## 6. Acceptance criteria

1. A phone connecting to adb for the first time creates **no** `devices` row and appears in the tray.
2. An admitted phone behaves exactly as devices do today — schedulable, leasable, on the wall.
3. Devices that existed before this plan are unaffected and require no admission.
4. A blocked `stableId` never reaches the tray.
5. Forgetting a connected device returns it to the tray and never demands a block.
6. Dismiss is not persistent: the device reappears on its next connection.
7. An unadmitted device receives no scrcpy, guest-agent, ui-server, or network activity — probe only.
8. `bash scripts/typecheck.sh`, `bun test`, `bun run build:studio` green; `bash scripts/check-plan-status.sh` passes.

## 7. Test plan

**Unit** — `classify` precedence; the registry's three branches; admit idempotency; forget-while-connected round trip.

**Manual smoke** (one device attached)

```bash
bun run dev
# 1. plug in a phone that is not in the farm  → it appears under Discovered, and GET /api/devices does NOT list it
# 2. Add to farm with a label                 → it appears in the fleet list, leasable
# 3. Forget it while still plugged in         → back under Discovered, no block created
# 4. Dismiss, then unplug and replug          → it is back in the tray (§3.5)
```

**Run on a moto g06 power (ZP2222RMBS, Android 15).** All four steps behaved as written. Two defects it found, both introduced by this plan and both fixed:

- `admitDevice` enrolled the device as `offline`, so a phone plugged in at that moment showed `disconnected` on its own card — and stayed that way, because the adb tracker only speaks on change. `DeviceRegistry.admitted()` now brings it online immediately if it is really there.
- The empty fleet state told an operator to plug in a phone that was already plugged in and waiting in the tray.

A third, older defect surfaced in the same run: the enrolment wizard waited on `device.added`, which admission no longer emits on connect, so it span forever while the phone sat in the tray. It now listens for `device.discovered` too.

§3.6's teardown was verified separately, by deliberately stranding a route (`192.0.2.1:1080` — unreachable by design, and `markUp()` does not wait for an upstream, so no real proxy or credential was involved) and then removing the device. See §3.6 for the dead-man's-switch measurements that run produced.

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| An operator upgrades and thinks their farm was wiped. | Existing devices are never touched (§3.3). The tray only ever holds phones that were not already members. |
| The tray becomes noise in a workshop with many phones passing through. | Dismiss is one click and the tray is hidden entirely when empty. If it still hurts, the answer is bulk-admit, not auto-admit. |
| A device is admitted twice by two operators at once. | Admit is idempotent on `stableId` (§4.3). |
| `forget` on a connected device now succeeds where it used to refuse. | That is the point (§3.2), and it is covered by acceptance 5. The destructive option (delete history) keeps its existing confirmation. |

## 9. Open questions

1. **Orphan detection (deferred by the operator, and the real safety net).** §3.6's teardown only covers a removal it can see. A core killed while a route is up, a reset database, or a phone that was offline when it was forgotten all leave the same held-closed tunnel with nothing to hook onto. The core already models `drift` for a route it knows about; what is missing is the inverse — a route on the phone that we have no record of. Without it the symptom is always the one observed here: a phone that blocks everything, and no screen in Enkaku that explains why.
2. Should the tray show a phone that is currently disconnected? Proposed: **yes** — it is a queue of decisions, not a live view, and `lastSeen` says how stale each entry is.
3. Should admission be available over the API to an automation script (a farm that provisions itself)? Proposed: it already is — the routes are ordinary `device.settings` routes. No separate mechanism is needed, and none should be invented.
4. Does the cloud/agent path (plan 11) need the same gate for agent-owned devices? Proposed: yes, and it falls out of §4.2 if the agent's registry uses the same `classify` — but it is unverified here and should be confirmed before that milestone closes.
