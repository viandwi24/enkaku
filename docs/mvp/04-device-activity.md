# MVP 04 — Device activity replaces leases and control

> Status: decided in direction (CEO, 2026-09-03); model proposed here. §5 point 1 decided the same day: control over control is allow, marker only, no dialog.
> Complaint as reported: after repeated use, the control and lease features get in the way. Replace them with a marker ("someone is controlling", "last controlled N seconds ago") and a per-device state that has many types at once (a job running, an APK installing, and so on), as an array, with guards that warn or forbid when a new action conflicts.
> Related: `docs/spec.md` §10.1, §10.2, §10.5, §7.11; `docs/plans/04`, `71`, `91`, `105`, `106`, `107`; `packages/core/src/lease/`, `packages/core/src/device/state-machine.ts`, `packages/studio/src/components/device-popup/ControlState.tsx`, `packages/studio/src/lib/operations.ts`.

---

## 0. What exists today, and why the decision is right

### 0.1 A lease is not what makes a device busy

There is no leases table. A lease is an entry in `const leases = new Map<string, Lease>()` (`packages/core/src/lease/lease-manager.ts:250`) with `type: 'manual' | 'job'`, a holder id, and an expiry. What makes a device busy is `devices.status` driven by a CAS state machine (`packages/core/src/device/state-machine.ts:22-31`):

```
DEVICE_CONNECTED: { offline: 'idle' }
MANUAL_ACQUIRED:  { idle: 'manual' }
JOB_CLAIMED:      { idle: 'busy' }
```

`manual` and `busy` are only reachable from `idle`, so one person driving and one job running are structurally mutually exclusive. That single slot is the constraint the CEO's array relaxes.

### 0.2 Three authorisation objects and a serialiser guard one slot

1. The lease (`lease-manager.ts`): acquire, release, takeover, idle reaper (300 s), quiet period after release that delays queued jobs (`queue/scheduler.ts:85-100`).
2. The co-control grant, "Assist" (`lease/co-control.ts`): a third object whose own doc comment says it is "not a lease variant"; TTL 300 s, one per device.
3. Mirror grants (`mirror/group.ts:283-300`): each member resolved as lease or assist.
4. The input arbiter (`packages/session/src/input-arbiter.ts`): three FIFO lanes with priority `assist < lease < job = agent`. This one is serialisation, not authorisation, and stays.

`checkInputAllowed` (`lease-manager.ts:429-449`) is consulted by twelve surfaces: input, shell, inspect, clipboard, recording start/stop/cancel, transfer, adb endpoint, identity writes, route writes, and the capability invoke pipeline (`capability/invoke.ts:98-110`, which refuses `E_NEEDS_LEASE` and never acquires). Every capability declares `lease: 'none' | 'control'` (`capability/types.ts:59`).

### 0.3 Studio carries the cost

`ControlState.tsx` (522 lines) computes six states with one primary action each, and its header quotes the owner's own complaint about take-control and assist colliding. Around it: `TakeControlDialog`, `AssistDialog`, `HolderBadge`, the lease banner in `ScreenCard`, handlers in `DevicePopup`, `DeviceHeader`, `WallTile`, `DeviceContextMenu`, `DeviceCard`, `DevicePicker`, and the legacy device page. Wire messages: `lease.acquire/acquired/released/changed/revoked`, `assist.start/stop/started/stopped/changed`.

### 0.4 Activity is already tracked, six times, uncoordinated

| Axis | Where | Shape |
|---|---|---|
| `status` | `devices.status` | single slot: offline, idle, manual, busy, quarantined |
| `heldBy` | in-memory lease map | one holder |
| `assistedBy` | in-memory grants | **already an array** |
| `readiness` | `devices.desiredReadiness` | desired, actual, blocked |
| `preparation` | `devices.preparation` JSON | open map keyed by component id (only `ui-server` registered) |
| transfers | in-memory registry behind `GET /api/transfers` | farm-wide, lost on restart |

Studio then re-aggregates five kinds client-side by polling four endpoints every 5 s (`packages/studio/src/lib/operations.ts:95, 532`) because no server-side per-device activity registry exists. Its own comment records that preparation has no farm-wide signal at all.

## 1. The model

### 1.1 One activity list per device

```ts
type DeviceActivity = {
  id: string
  kind: 'control' | 'job' | 'workflow-job' | 'install' | 'transfer' | 'prep'
      | 'command' | 'agent' | 'network-apply' | 'wake'     // open, plugins may add
  label: string                 // human sentence, never an id
  actor: { kind: 'user' | 'agent' | 'system' | 'plugin'; id: string; label: string }
  startedAt: number             // unix seconds
  updatedAt: number             // last heartbeat or last input
  href?: string                 // where to look (job detail, transfer, plugin view)
  meta?: Record<string, unknown>
}
```

Served as `DeviceInfo.activities: DeviceActivity[]` and pushed as `device.activity` (added, updated, ended). Persistence: entries that already have a durable row (jobs, transfers, preparation) are **projected** from that row; `control`, `command`, and `wake` are in-memory and rebuilt empty on restart, which is correct because they cannot survive a restart anyway.

`devices.status` shrinks to what is physically true: `offline | online | quarantined`. "busy" and "controlled" become derived views over the list, never stored.

### 1.2 Control is a marker, not a permission

The first input from a client creates or refreshes a `control` activity carrying the user and `updatedAt`. No acquire, no release, no takeover, no assist, no grant. The entry ends after `controlIdleSec` (default 30) without input. The wall tile, card, and header show "Controlled by Rani" while live and "Last controlled 12 s ago by Rani" for a short tail (default 120 s), then nothing.

### 1.3 Guards are a policy table, not a lock

Before starting activity X on a device whose list holds Y, the core evaluates a policy and answers `allow | warn | forbid` with a sentence. Defaults:

| Starting → over existing ↓ | job / workflow-job | install | control (fresh input) | command | prep |
|---|---|---|---|---|---|
| job / workflow-job | forbid (queue behind it) | forbid | allow | warn | warn |
| install | forbid | forbid | allow | warn | warn |
| control | warn ("a job is running; your taps will interfere") | warn | **allow**, marker only | allow | allow |
| command (adb console) | warn | warn | allow | allow | allow |
| transfer | allow | forbid | allow | allow | allow |
| wake / network-apply | forbid while a job runs | forbid | allow | allow | allow |

`warn` returns the sentence to the caller; Studio shows it once and proceeds on confirmation; a script or agent caller may pass `force: true` after reading it. `forbid` returns `E_DEVICE_CONFLICT` with the conflicting activity. Two rows are farm settings: `control over control` (default `allow`; `warn` or `forbid` for farms that need exclusivity) and `control idle seconds`.

**Why control over control defaults to allow (CEO, 2026-09-03).** In field use the lease repeatedly showed a device as controlled by a user who had already disconnected: a lease is released only when the core observes the WS close (`ws-handlers.ts:2584`) or after the 300 s idle reaper, so a close the core never sees leaves a five-minute ghost holder. A marker that lives only from the last input has no release step to miss. Panda and similar tools let several operators touch one device with no warning at all, and that is what the CEO observed to be safe in practice.

~~The scheduler's quiet period after a manual release is replaced by the same table: a queued job whose device has a fresh `control` entry waits until the entry ends or `maxWaitSec` elapses.~~

**Struck by the CEO on 2026-09-04, on hardware.** A job sat queued purely because a person had the device open in Device Control — which is the lease this whole document exists to remove, wearing a different name. There is no wait. The model is the state dot and nothing else: **green** free, **amber** a person is driving, **red** the system is (today that means a job). Amber never blocks anything. The only exclusion left is job-over-job, and it lives in the SQL claim, not in a gate. A person may take over a device a job is driving — that is help, not interference — so `control` over `job` is `allow` with no sentence to dismiss (§2's table row updated).

### 1.4 What stays underneath

- The **job heartbeat** (`jobs.leaseExpiresAt`, renewed by the runner, reaped on expiry) stays as job liveness detection. It is renamed `heartbeatExpiresAt`; the word lease leaves the product.
- The **input arbiter** stays. Its sources become `{ kind: 'user' | 'job' | 'agent' }`; the `assist` lane and the `lease` lane collapse into `user`.
- **Readiness** stays as its own axis; `wake` appears in the list while it runs.
- **Preparation** keeps its durable map and projects each in-progress component as a `prep` activity, which also gives Studio the farm-wide signal `operations.ts` says is missing.
- **Mirror** is a client-side fan-out of `input.*` from Device Control's host banner (MVP 15); the server holds no mirror object, each member simply gets a `control` marker.
- **Capabilities** replace `lease: 'none' | 'control'` with `activity?: { kind, exclusiveWith?: kind[] }`; the invoke pipeline consults the policy table instead of `checkInputAllowed`.

## 2. Removed

Deleted in the same plan that lands §1, with a grep gate of zero references before merge:

- `packages/core/src/lease/` (lease-manager, co-control), `device/state-machine.ts`'s `manual`/`busy` transitions, the quiet-period gate in `queue/scheduler.ts`.
- Messages `lease.*`, `assist.*`, `mirror` grant semantics in `@enkaku/protocol`; `DeviceInfo.heldBy`, `assistedBy`; `LeaseHolder`.
- `checkInputAllowed` and its twelve call sites; `capability.lease`; `E_NEEDS_LEASE`, `E_DEVICE_HELD`, `E_LEASE_REVOKED`.
- Studio: `ControlState.tsx`, `TakeControlDialog`, `AssistDialog`, `HolderBadge`, the lease banner in `ScreenCard`, all `lease.*`/`assist.*` handlers, the `control.assist.started` log rendering.
- Settings: co-control mode, grant TTL, max concurrent per device, manual idle timeout, quiet period. Replaced by the two rows in §1.3.
- Spec: §10.1 rewritten, §10.2 reduced to the heartbeat, §10.5 deleted, §7.11 extended with the projection rule.

## 3. What the user sees

- Wall tile and device header: a stacked activity strip. "Running tiktok/login (job #482)", "Installing app.apk 40 %", "Controlled by Rani". Nothing when idle.
- Tapping a device with a running job: one inline warning, then taps go through. No dialog, no button, no role check beyond `device.input`.
- Starting a job from Studio on a device with a running job: the Run dialog shows the conflict per device and offers "queue after" or "skip".
- Jobs page and operation tray read the same list, so the 5 s polling aggregator in Studio is deleted.

## 4. Cost

This is a rebuild of the device-state layer, not a revision: new module, callers moved, old module deleted. Roughly one sprint core plus one sprint Studio, plus the spec rewrite. Migrations: `devices.status` value set shrinks (existing `manual`/`busy` rows map to `online`), `jobs.lease_expires_at` renamed.

## 5. Open points

1. Decided: `control over control` is allow with a visible marker; warn and forbid stay available as settings.
2. Whether `agent` runs get their own kind or are `control` with `actor.kind = 'agent'`. Proposed: own kind, because an agent run is long and should be visible as such.
3. Plugins adding activity kinds: allowed through the capability broker with `<plugin>/<kind>` naming, or deferred. Proposed: deferred until a plugin needs it.
