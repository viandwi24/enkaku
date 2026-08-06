# Plan 71 — M36 : Who Holds This Device

> Status: implemented — `LeaseHolderSchema`/`DeviceInfo.heldBy` (`packages/protocol/src/device.ts`), `lease.changed`'s `heldBy` replacing `held`, `lease.revoked.takenBy`, and the new `job.waiting` broadcast (`packages/protocol/src/messages/job.ts`); `FarmSettings.job` gains exactly `quietPeriodSec`/`maxWaitSec` (`packages/protocol/src/settings.ts`), nothing else in that object touched. `packages/core/src/lease/lease-manager.ts` gained `toHolder`/`ResolveLabel` (injected — the lease manager still never learns about users, agents, or jobs) and `acquireManual`'s `{ takeOverFrom }`: compare-and-swap against the CURRENT holder, `device_busy_job` unconditional for a job, and a synchronous revoke-then-acquire with no `await` anywhere between reading the old holder and writing the new one — criterion 9 is proven, not asserted, by `lease-manager.test.ts`'s atomicity test (a "concurrent" plain `acquireManual` issued the instant a takeover returns is refused, naming the NEW holder, never a stale or absent one). `daemon.ts`'s `resolveLeaseLabel` closure (user email / agent name / `script@version`, falling back to `'a signed-out client'`/`'a deleted agent'`/`'a deleted job'` — never empty, never a raw id) and its `onManualTakenOver` hook (broadcasts `lease.revoked` with the taker, records a `device.control` audit entry with device/from/to/actor, and releases the terminal/adb-endpoint/network-independent side effects) were already wired by the interrupted attempt and are unchanged. The quiet-period wait (§3.7) lives in `packages/core/src/queue/scheduler.ts` (also inherited, previously untested): `computeQuietBlocked` excludes a device from `claimNext` while `now - lastManualReleaseAt < quietPeriodSec`, capped per-device from the FIRST tick it was observed blocked (not reset by a brief reacquire) so a job never waits past `maxWaitSec`, broadcasting `job.waiting` (visible, with the holder and remaining seconds) the whole time — `scheduler.test.ts` is new and covers all of §3.7 including the cap. **What the interrupted attempt left half-done, finished here:** (1) `heldBy` was defined on the wire but never actually POPULATED — `rowToDeviceInfo`/`listDevicesWithTags` (`registry/device-registry.ts`) always defaulted it to `null`; every call site that builds a `DeviceInfo` (`api/devices.ts`'s list/single/`infoWithTags`, `api/topology.ts`, `api/clusters.ts`'s `/:id/devices`, `capability/context.ts`'s `listDevices`/`getDevice`) now threads a `heldByOf`/`leases.getHolder` accessor through, wired from `daemon.ts` — this is criterion 1 and 2's actual mechanism, not just the schema. `packages/node/src/index.ts`'s `DeviceInfo` literal (the one true blocker `bun run typecheck` was failing on) sets `heldBy: null` — a node reports device identity only, never lease state. (2) The agent side of §3.5 — an agent's in-flight step failing with a distinct `E_LEASE_REVOKED` error `tool_result`, and never re-acquiring — did not exist; `agent/loop/run.ts` gained `lostLeaseDeviceIds` (once a device lands there it stays there for the rest of the run — `ensureControlLease` refuses to touch it again) and `checkLeaseRevoked`, called before every control-lease capability invocation, which detects "we held this device and no longer do" and appends the error result WITHOUT ever calling `invoke()` for that call — proven end to end in `run.test.ts` (a real takeover mid-run, via the fake provider's own turn function as the synchronisation point, asserts the exact tool_result, that the run reaches `succeeded`, and that the human's lease is completely undisturbed at the end). (3) `packages/studio/src/lib/agent-holders.ts` and `components/agent/AgentHolderBadge.tsx` (Plan 69's polling workaround) still existed, still imported by `DeviceCard.tsx`, `wall/WallTile.tsx`, `wall/Wall.tsx` and `app/page.tsx` — deleted, and all four rewired to read `DeviceInfo.heldBy` directly through the already-built `HolderBadge`/`TakeControlDialog` (which the interrupted attempt HAD already finished, correctly, including the two-consequence confirmation text and the stale-takeover re-ask — criterion 13, 8). The fleet page (`app/page.tsx`) also gained a `lease.changed` WS handler: an ordinary acquire/release flips `status` (idle↔manual), which already triggered a full reload, but a TAKEOVER does not change `status` at all — without this, a displaced holder's card would keep showing the OLD holder until something unrelated happened to reload the list. (4) `DeviceHeader.tsx` had grown its own `useState` for the takeover dialog, silently breaking the file's own stated contract ("no hooks of its own... callable directly") that `DeviceHeader.test.tsx` depends on literally — 9 of 11 tests were failing on "Invalid hook call" before this fix. Lifted to the caller (`app/device/page.tsx`) as `takeOverOpen`/`onTakeOverOpenChange` props; `DeviceHeader.test.tsx`'s `render()` helper updated for the new `heldBy`/`onControlTaken`/`takeOverOpen` props (replacing the stale `heldByOther: boolean`). (5) `job.waiting` was broadcast by the scheduler and read by nothing — Studio never rendered the quiet-period wait at all, which is criterion 11's own explicit requirement ("the wait is visible... a silent wait is indistinguishable from a hang"). `app/jobs/detail/page.tsx` now subscribes and shows a banner (holder badge plus remaining seconds) on every tab while `job.status === 'queued'` and a wait is active. (6) `DevicePicker.tsx` (named explicitly in §4.5 as a `HolderBadge` consumer) had none — added; a `manual`/`busy` device is still pickable for a job (it just queues behind the quiet period), so who holds it now is worth showing there too. New tests: `lease/lease-manager.test.ts` (19 — `toHolder` for all three kinds, unresolvable-id fallback text, CAS success/failure, job refusal, the atomicity test, the audit-hook payload, `lastManualReleaseAt`/`lastManualHolder`), `queue/scheduler.test.ts` (6 — quiet/not-quiet/never-held/cap-expires/keeps-its-place/no-quiet-dependency), plus one integration test in `agent/loop/run.test.ts` and two in `api/devices.test.ts`. `bun run typecheck` is clean across all 11 packages; `bun test` is 2175 pass / 0 fail (baseline 2147 + 28 new, zero regressions). No real Anthropic API call anywhere — the new agent-loop test uses `agent/provider/fake.ts` exclusively. **Not done:** the manual smoke test script (§7) was not run against a live `bun run dev` + `bun run dev:studio` browser session (no device, no Anthropic key in this environment, matching every prior plan in this series) — verified instead via the automated suite above and reading every acceptance criterion against the actual code path it depends on.
> Ships: packages/core/src/lease/lease-manager.ts
> Depends on: Plans 31 (viewer presence), 66 (agent runs acquire leases), 67 (a tree is one holder), 69 (the polling workaround this deletes).
> Spec references: §10.1 (server-authoritative control), §10.2 (leases).

---

## 1. Goals

- A device says **who** holds it — a person, an agent, or a job — not merely that it is held.
- Control can be **taken over** from a person or an agent, deliberately, with a warning that names what will be lost, and never by accident.
- A **job's** hold is never takeable. It is waited out.
- A job **waits for the device to be quiet** before claiming it, instead of interrupting whatever is mid-gesture.
- Plan 69's three polling workarounds for "which phone is an agent driving" are **deleted**, not layered over.

## 2. Non-goals

- Changing the `DeviceStatus` enum. `idle | manual | busy | offline | quarantined` stays; holder identity is a new, separate field. Widening the enum to `manual-by-agent` would break every existing consumer for information that belongs beside it, not inside it.
- Queueing manual control ("put me next in line"). §9.1.
- Changing job scheduling, priority, or batching (Plans 20, 21).
- Multi-holder or read-only control.

## 3. Context and design decisions

### 3.1 The system knows who holds a device and never says so

`LeaseManager` has it: `Lease` carries `holder`, `holderUserId`, and `type`. But nothing propagates it.

- `DeviceInfoSchema` (`packages/protocol/src/device.ts:12`) has `status` and no holder field at all.
- `lease.changed` (`packages/protocol/src/messages/job.ts:174-180`) carries `{deviceId, held, expiresAt}` — **held is a boolean**.
- The device page reconstructs a holder from `viewers` (`app/device/page.tsx:119`), which is built from live WS connections only.

An agent run is not a WS connection. So an agent driving a phone is invisible to every existing surface, and Plan 69 had to reach for `GET /runs/:id/tree`'s `drivingDeviceIds` and poll it every fifteen seconds — per agent, per recent thread. That workaround is in `packages/studio/src/lib/agent-holders.ts` and it exists solely because this field is missing.

One field fixes the badge, the takeover warning, the wall, and deletes the polling.

### 3.2 `heldBy` — the shape

```ts
export const LeaseHolderSchema = z.object({
  kind: z.enum(['user', 'agent', 'job']),
  /** clientId for a user, agentId for an agent, jobId for a job. */
  id: z.string(),
  /** For display: a username, an agent's name, a script's `name@version`. */
  label: z.string(),
  /** Agent only — the ROOT run, so a whole tree reads as one holder (plan 67 §3.7). */
  runId: z.string().nullable(),
  /** Whether this hold can be taken over at all (§3.4). */
  takeable: z.boolean(),
  acquiredAt: z.number(),
  expiresAt: z.number().nullable(),
})
```

`DeviceInfo.heldBy` is this or `null`. `lease.changed` carries it in place of the `held` boolean — `held` becomes `heldBy !== null`, so nothing is lost and the wire stops carrying a fact that was never sufficient.

`takeable` is computed by the server and sent, rather than left for each client to derive from `kind`. A client that derives it will eventually derive it differently from another client, and the two will disagree about whether a button should exist.

### 3.3 Labels are resolved server-side

`label` has to come from somewhere that knows what a `clientId` or an `agentId` means. That is the core, not Studio: Studio would need the user list, the agent list, and the job/script join just to draw a badge, and would get it wrong for a holder it cannot see.

The lease manager gains a `resolveLabel(kind, id)` dependency, injected — it does not learn about users, agents, or jobs directly. A label that cannot be resolved falls back to a truthful, non-empty string (`'a signed-out client'`, `'a deleted agent'`), never an empty string and never the raw id, which reads like a bug to anyone looking at it.

### 3.4 What may be taken over, and what may not

| Holder | Takeable | Why |
|---|---|---|
| a person | **yes**, with confirmation | a colleague who walked away should not lock a phone until their lease expires |
| an agent | **yes**, with confirmation | an operator must always be able to take a phone back from automation — this is the emergency stop, and it must never be blocked |
| a job | **no** | a job mid-script cannot be interrupted coherently; the device is genuinely in use and the answer is to wait or cancel the job |

`acquireManual` currently throws `device_busy` for both `manual` and `busy` (`lease-manager.ts:78-82`), which is why no confirmation dialog could be built — the capability does not exist. It gains an explicit second argument:

```ts
acquireManual(deviceId, clientId, userId, opts?: { takeOverFrom?: string })
```

`takeOverFrom` is the id of the holder the caller **believes** holds it. If the current holder is someone else by the time the request lands, the takeover is refused — so a stale confirmation dialog cannot displace a third party who acquired the device in the two seconds since it was drawn. This is compare-and-swap, and it is the same reasoning as Plan 64 §3.4's `ifMatch`.

A takeover of a job lease is refused unconditionally, whatever is passed.

### 3.5 The displaced holder is told, and it is recorded

Losing control silently is worse than not losing it. On a successful takeover:

- the displaced holder receives `lease.revoked` with the reason and the **name** of who took it (the message exists; it gains the taker);
- an agent run whose lease is taken has its current step fail with `E_LEASE_REVOKED` — an error `tool_result`, so the run continues and can report honestly that it lost the device rather than dying confusingly;
- an audit entry records device, from, to, and actor. A takeover is exactly the action someone will ask about later.

An agent that loses its lease does **not** silently re-acquire it. Re-acquiring would produce two parties fighting over one phone, each thinking it won. It reports and stops using that device.

### 3.6 The confirmation must state the consequence, not ask a question

A dialog reading "Take control?" tells the operator nothing they did not know. It states what will happen:

> **Take control from Rina?**
> Rina is controlling this device now. Taking control will interrupt what they are doing, and any gesture in progress may leave the app in an unexpected state.

and for an agent:

> **Take control from *checkout-bot*?**
> The agent is running *"verify the checkout flow"* and is using this device now. Taking control stops its work on this phone; the run continues and will report that it lost the device.

Two different consequences, so two different texts. The button stays **enabled and visible** in both cases — the current disabled button is the actual defect, because it presents an operator's own phone as unavailable to them.

For a job, the button is genuinely disabled and names the job and its script, with a link to it and to Cancel. That is the one case where the operator's route is elsewhere.

### 3.7 A job waits for the device to be quiet

Today a job claims the device the moment its turn arrives. If a person is mid-gesture, the job wins and the person's action lands somewhere unpredictable — or worse, half-lands.

A job's acquisition becomes: **wait until no manual lease has been held for `quietPeriodSec` (default 10), up to `maxWaitSec` (default 120).** If the wait expires, the job's normal behaviour applies — it is not silently dropped.

Two things this deliberately is not:

- It is not a hold that a person can extend forever. The cap bounds it, and the job then proceeds; a farm where one person can starve the queue is a farm with a different problem.
- It is not queue reordering. The job keeps its place; it waits inside its own turn.

The wait is **visible**: the job shows `waiting for the device to be free` with who holds it and how long is left, rather than looking stuck. A silent wait is indistinguishable from a hang.

### 3.8 The wall and the device page read one field

`WallTile`, `DeviceCard`, and `DeviceHeader` render `heldBy` directly — an avatar or icon per kind, the label, and a link (agent → its run; job → the job). `packages/studio/src/lib/agent-holders.ts` and its polling are **deleted**.

## 4. Technical design

### 4.1 Protocol

`LeaseHolderSchema` (§3.2) in `packages/protocol/src/device.ts`; `DeviceInfoSchema.heldBy`; `LeaseChangedMessage.payload.heldBy` replacing `held`; `LeaseRevokedMessage.payload.takenBy` (nullable — an expiry has no taker) and `reason: 'taken-over' | 'expired' | 'released' | 'device-offline'`.

`LeaseAcquireMessage` gains `takeOverFrom?: string`.

### 4.2 `lease-manager.ts`

- `resolveLabel` injected (§3.3); `toHolder(lease): LeaseHolder`.
- `acquireManual(..., { takeOverFrom })`: compare-and-swap against the current holder (§3.4), refuse on a job unconditionally, revoke-then-acquire atomically so no window exists in which the device is unheld and a third party can slip in.
- `acquireJob` gains the quiet-period wait (§3.7) with its two settings.
- New errors: `device_held_by_other` (takeover not requested), `lease_holder_changed` (the CAS failed — the message names who holds it *now*), `device_busy_job` (a job holds it), `lease_wait_timeout`.

### 4.3 Settings

`FarmSettings.job` gains `quietPeriodSec` (default 10) and `maxWaitSec` (default 120), both with `.describe()` copy explaining the trade so the settings page needs no separate prose.

### 4.4 Core plumbing

Every place that builds a `DeviceInfo` — `registry/device-registry.ts`, `api/devices.ts`, the daemon's broadcast — includes `heldBy`. A single helper produces it, so a surface cannot ship a device object without one.

The agent runner's lease acquisition (Plan 66/67) passes `kind: 'agent'` with the root run id, so a tree reads as one holder exactly as Plan 67 §3.7 intends.

### 4.5 Studio

- `HolderBadge` — one component, three kinds, used by `DeviceHeader`, `DeviceCard`, `WallTile`, and the device picker.
- `TakeControlDialog` — §3.6's two texts, sending `takeOverFrom`; on `lease_holder_changed` it re-reads and re-asks rather than failing, because the honest response to "someone else got there first" is to show who.
- The job-held case: disabled, named, linked.
- Delete `lib/agent-holders.ts`.

## 5. Implementation steps

**71.1 — `LeaseHolderSchema`, `toHolder`, `resolveLabel`** (§3.2, §3.3). Pure; the fallback labels are part of it.

**71.2 — `heldBy` everywhere a `DeviceInfo` is built** (§4.4), and on `lease.changed`.

**71.3 — Takeover** (§3.4, §3.5): CAS, job refusal, atomic revoke-then-acquire, `lease.revoked` with the taker, the audit entry, and the agent's `E_LEASE_REVOKED` tool result.

**71.4 — Quiet-period wait for jobs** (§3.7) plus its settings and its visible waiting state.

**71.5 — `HolderBadge` and `TakeControlDialog`** (§4.5).

**71.6 — Delete the polling workaround** (§3.8).

## 6. Acceptance criteria

1. `GET /api/devices` and `/ws`'s `lease.changed` both carry `heldBy` with kind, id, label, `takeable`, and (for an agent) the root run id.
2. A device driven by an agent shows the agent's name on the device page, the device card, and the wall tile — **without polling**.
3. `packages/studio/src/lib/agent-holders.ts` no longer exists and nothing imports it.
4. Taking control from a person succeeds when `takeOverFrom` matches, and the displaced holder receives `lease.revoked` naming the taker.
5. Taking control from an agent succeeds, the agent's in-flight step fails with `E_LEASE_REVOKED` as an **error tool result**, and the run **continues** and can report the loss.
6. An agent that loses its lease does not re-acquire it automatically.
7. Taking control from a **job** is refused whatever is passed; the UI's button is disabled and names the job and script.
8. A stale takeover — the holder changed since the dialog was drawn — is refused with `lease_holder_changed` naming the current holder; the dialog re-asks rather than failing.
9. There is no moment during a takeover in which the device is unheld and a third party can acquire it.
10. Every takeover is audited with device, from, to, and actor.
11. A job whose device has just been used manually waits up to `maxWaitSec` for a `quietPeriodSec` gap, then proceeds; the wait is visible with the holder and the remaining time.
12. A job never waits past `maxWaitSec`.
13. Confirmation text differs for a person and for an agent, and states the consequence rather than asking a bare question.
14. A holder whose label cannot be resolved renders a truthful phrase, never an empty string and never a raw id.
15. `bun run typecheck` passes; `bun test` is green.

## 7. Test plan

**Unit — `toHolder`/`resolveLabel`:** all three kinds; an unresolvable id for each; `takeable` computed server-side per kind.

**Unit — takeover:** CAS success; CAS failure naming the current holder; job refusal; atomicity (a concurrent plain `acquireManual` during a takeover must lose, not interleave); `lease.revoked` carrying the taker; the audit row.

**Unit — quiet period:** a manual lease released 2s ago delays a job; released 15s ago does not; the cap expires and the job proceeds; the waiting state is observable throughout.

**Integration:** an agent run holding a device, taken over by a person — assert the tool result is an error, the run continues, the run does not re-acquire, and the agent's own subsequent step reports the loss.

**Manual smoke:**
```bash
bun run dev && bun run dev:studio
# 1. control a device in tab A; open it in tab B → button enabled, dialog names the tab-A user
# 2. confirm → A is told it lost control and by whom
# 3. an agent drives a device → the wall tile names the agent, live, with no 15s lag
# 4. take it from the agent → the transcript shows the lost-device tool result and the run continues
# 5. run a job → take control is disabled, names the job, links to it
# 6. use a device manually, then start a job → the job shows it is waiting, then runs
```

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Takeover becomes casual and colleagues interrupt each other. | It is a deliberate two-step with named consequences (§3.6), and every one is audited (§6.10). Making it *possible* is the point — the current lockout is the worse failure. |
| A takeover race leaves the device unheld or double-held. | Revoke and acquire are atomic (§4.2), CAS refuses a stale attempt (§3.4), and criterion 9 tests the window directly rather than assuming it. |
| An agent silently keeps working on a phone it no longer holds. | Its step fails with a distinct code (§3.5), it does not re-acquire (§6.6), and Plan 63's `invoke` would refuse it anyway — the lease check is not the agent's to skip. |
| The quiet period makes jobs feel unreliable. | It is capped, visible, and defaulted low (10s within a 120s cap). The alternative — a job stamping on a person mid-gesture — is the failure it exists to prevent. |
| `heldBy` on every device object grows the broadcast. | It is one small object on a device that is already carrying battery, readiness, and route state, and it *replaces* three polling loops. Net traffic falls. |

## 9. Open questions

1. Queueing manual control — "take it when they are done". Natural once holders are legible, and it needs a fairness policy nobody has asked for yet.
2. Should an operator be able to take control from an agent **and pause the run** in one action, rather than letting it continue and report? Two reasonable intents; the safer default ships here.
3. Should the quiet period apply to an *agent* acquiring a device, not only a job? Probably yes for the same reason, but an agent's acquisition is per-step and much shorter, so it needs measurement before a number.
