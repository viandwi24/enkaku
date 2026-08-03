# Plan 45 — M19 : Device Readiness as a First-Class State

> Status: draft
> Depends on: Plan 17 (`keepAwake`, `standbyScreenOff`, session phases), Plan 42 (idle session TTL, quality profiles, the Wall). Independent of Plans 40 and 41.
> Spec references: §7 (engines and sessions), §10.1 (server-authoritative control), §10.2 (leases), §12 (entities), §15 (device lifecycle).

---

## 1. Goals

- A device's **readiness** — asleep, awake, or hot — is a real, visible, first-class state, separate from its availability status.
- Readiness can be driven **on purpose**: a Wake or Sleep action, without opening a video stream first.
- A device held `hot` opens instantly: no `connecting → waking → starting-video → waiting-frame` sequence.
- The Wall, the devices list, and topology all show readiness, and the Wall can change it in place.
- What the operator asked for and what is actually true are reported **separately**, so a tile never shows a state that is not real.
- The cost is bounded: a farm-wide cap on how many devices may be hot, with a stated default and a clear reason for it.
- Anything that needs the device — taking control, a job, the adb endpoint — **wakes it automatically first**, then proceeds. Nobody has to remember to warm a device before using it.
- After a period with no activity, a device returns to the readiness its operator asked for, on **one** timer shared with Plan 42's session TTL — never two competing ones.

## 2. Non-goals

- Changing `DeviceStatus`. §3.1 explains why merging readiness into it would be a mistake.
- Waking a device that is locked with a PIN, pattern, or password. That cannot be done over adb (`session.ts:169` already documents it) and this plan does not pretend otherwise.
- Per-device power scheduling ("wake this rack at 09:00"). Plan 21's schedules are the natural home; recorded in §9.
- Cloud/agent parity. Local devices first; §9 records the gap honestly.

## 3. Context and design decisions

### 3.1 Readiness is a second axis, not another value on the first

The codebase has two enums, and neither answers "is this device ready right now":

```
DeviceStatus  = offline | idle | manual | busy | quarantined      ← ownership and availability
SessionPhase  = connecting | waking | starting-video | waiting-frame | ready   ← this session's startup
```

`SessionPhase` only exists while a stream is starting. That is exactly why waking cannot be triggered on purpose today: waking is not a state a device has, it is a step inside `stream.start`.

The tempting fix is to add `asleep`/`awake` to `DeviceStatus`. That would be a mistake. `DeviceStatus` feeds the scheduler — `idle` there means *eligible for a job*, and the state machine literally reads `JOB_CLAIMED: { idle: 'busy' }`. Overloading it makes every `status === 'idle'` check ambiguous, and the ambiguity would be cheap to introduce and expensive to remove.

So: a **separate, orthogonal `readiness` field**. A device can be `idle` + `hot` (available and warm), or `busy` + `hot` (running a job, obviously warm), or `idle` + `asleep` (available but cold). Both axes stay meaningful.

### 3.2 Three levels, and what each actually costs

| readiness | What is true on the device | Cost | Opening it |
|---|---|---|---|
| `asleep` | screen off, no session, nothing running | none | the full sequence |
| `awake` | screen kept awake (`svc power stayon`), keyguard nudged, **no** session | one adb command, plus panel power | skips `waking` |
| `hot` | scrcpy session alive, encoder producing frames | **real**: continuous H.264 encoding on the device | instant — one keyframe request |

`hot` is not free and the plan says so plainly: a continuously running encoder is CPU and battery, and this farm already auto-quarantines on temperature (Plan 23) for related reasons. Twenty devices held hot means twenty encoders that never stop.

`awake` is cheap in CPU but lights the panel, which costs OLED lifetime on a rack. `standbyScreenOff` (Plan 17 §3.5) exists precisely for this: the panel goes dark while the encoder keeps producing. **A hot device on a rack should normally also be `standbyScreenOff`**, and the UI should suggest it rather than leaving the operator to discover burn-in.

### 3.3 Desired and actual, reported separately

The moment a tile can both show readiness and change it, a single field starts lying: press Wake and the tile would claim `hot` while scrcpy is still pushing its jar.

So readiness has two halves:

- **desired** — what the operator (or a policy) asked for. Persisted on the device row. Survives restarts.
- **actual** — what is true right now, derived from live session state. Never persisted.

`actual` moves toward `desired` and may lag, fail, or be pre-empted. When they differ the UI shows the transition; when `actual` cannot reach `desired` (the device went offline, the hot budget is full) the reason is reported rather than hidden. This is the same spec-versus-status split that keeps every other reconciling system honest.

### 3.4 Who may wake, and who may sleep

Waking is additive; sleeping takes something away from someone. They are not symmetric, and the rules follow from that:

> **Amended by Plan 49 §3.1/§4.1.** The Sleep row below originally read "**and** either you hold the lease or nobody is viewing" / "another operator is watching or holds the lease". That rule shipped as a viewer count check (`deps.viewersOf(deviceId).length > 0`), and it was self-defeating: the Wall tile is itself a viewer, so opening the Wall — the one screen whose entire purpose is managing many devices at once — made every Sleep button on it refuse, reporting that "a person is watching this device" about the operator pressing the button. Watching is passive and trivially recoverable (a black rectangle, one click to wake again); only **active use** — a running job, or another operator's manual lease — costs someone real work if interrupted. The table below reflects the rule Plan 49 actually implemented; the struck-through text is left visible so the correction has a paper trail.

| Action | Allowed when | Refused when |
|---|---|---|
| **Wake** (`asleep → awake → hot`) | `device.view` permission; device `idle`, `manual`, or `busy` | device `offline` or `quarantined` |
| **Sleep** (`hot`/`awake` → `asleep`) | `device.view`; **and** no job running; **and** ~~either you hold the lease or nobody is viewing~~ **no one else holds the manual lease** (holding it yourself never blocks your own sleep) | a job is running; ~~another operator is watching or holds the lease~~ **another operator holds the manual lease** — watching never blocks it |

A quarantined device is deliberately excluded: it was pulled from the pool for a reason (thermal, or `adb:unreachable` from Plan 23), and warming it fights the mechanism that protects it.

Refusals carry the reason — "a job is running", "2 people are watching this device" — because a disabled button with no explanation is the thing operators file bugs about.

Enforcement is server-side, as spec §10.1 requires. The Wall disabling a control is a convenience, never the gate.

### 3.5 The hot budget, and why 8

`hot` is capped farm-wide by `readiness.maxHot`, default **8**.

Eight is chosen to line up with what Plan 42 already established: `wall.maxTiles` defaults to 8 and `session.maxIdleSessions` defaults to 8. So one page of the Wall is, by default, exactly the set of devices that can be hot — the thing you are looking at is the thing that is warm. Three unrelated numbers pulling in the same direction would be a coincidence nobody could reason about.

When the cap is reached, a further Wake is accepted as `desired: hot` but reported `actual: awake` with the reason `hot_budget_full`, and the least-recently-used hot device is **not** silently evicted — a device someone deliberately warmed should not go cold because a colleague warmed another. The operator sees the queue and can sleep something.

### 3.6 Auto-wake on demand, without changing intent

Anything that needs the device must not fail — or make the operator wait for a manual step — because the device happened to be asleep. So every acquisition path first ensures readiness, then proceeds:

```
stream.start / lease.acquire / job claim / adb endpoint open / transfer
    → readiness.hold(deviceId, reason)      // wakes if asleep, no-op if already awake or hot
    → the existing work
    → readiness.release(holdId)             // when the viewer leaves, the job ends, …
```

The `waking` session phase (Plan 17) stays exactly what the operator sees while that happens — so this is not a new UI concept, it is the same one, now reachable on purpose too.

**The critical rule: a hold never changes `desired`.** If a device's `desired` is `asleep` and a job wakes it, `desired` stays `asleep`, and the device returns there when the job ends. Without that rule, every job would permanently warm the fleet, and after a busy afternoon every device on the rack would be hot with nobody having asked for it.

So there are two distinct things, and conflating them is the mistake this section exists to prevent:

- **`desired`** — a standing intent, set by a human or a policy, persisted.
- **a hold** — a transient "something is using this right now", ref-counted, never persisted.

`actual` is driven by whichever is higher.

### 3.7 Inactivity returns a device to `desired`, on one timer

When the last hold is released, a timer starts. When it fires with no new hold, the device reconciles back to `desired`.

Two things follow, and both matter:

**`desired` is the floor, not something inactivity overrides.** A device an operator deliberately set to `hot` stays hot; inactivity does not quietly undo an explicit instruction. A device left at the default `asleep` goes back to sleep after use — which is the behaviour that was asked for. If an operator wants everything to sleep eventually, they leave `desired` at its default, which is exactly what a fresh install does.

**One timer, not two.** Plan 42 already added `session.idleTtlSec`, default **300 seconds** — the same five minutes, for the same idea, on the same resource. Adding a second readiness timer would mean two independent clocks racing to close one session, which is a bug factory: whichever fires first wins, and the losing timer's state is stale. So the readiness hold **is** a Plan 42 session subscriber, and `session.idleTtlSec` is the single inactivity clock. Readiness does not introduce a timer of its own.

What counts as activity, precisely — a hold exists while any of these is true:

| Hold | Released when |
|---|---|
| a viewer is streaming video | they close the tab or switch away |
| a manual lease is held | released, or its own idle timeout expires |
| a job is running on the device | the job reaches a terminal state |
| a monitor stream is open (Plan 24) | the last subscriber leaves |
| an adb endpoint is open (Plan 27) | closed or its idle timeout expires |
| a transfer is in flight (Plan 39) | it finishes, fails, or is cancelled |

A Wall tile counts as a viewer, so a device shown live on the Wall stays awake while you are watching it — and sleeps five minutes after you navigate away, without anyone having to think about it.

### 3.8 Most of the mechanism already exists

This plan is mostly wiring, not new machinery:

- `keepAwake` and `standbyScreenOff` (Plan 17) already implement `awake`; `session.ts:172` already runs `input keyevent KEYCODE_WAKEUP` and `svc power stayon`. Today that code is reachable only from inside `createSession`.
- Idle session TTL and `maxIdleSessions` (Plan 42) already keep a session alive with no viewer — which *is* `hot`. What is missing is entering that state deliberately instead of only as a leftover from someone streaming.
- Quality profiles (Plan 42) mean a hot device can be held cheaply at `wall` quality and upgraded on demand.

## 4. Technical design

### 4.1 Protocol — `packages/protocol/src/device.ts`

```ts
export const ReadinessSchema = z.enum(['asleep', 'awake', 'hot'])
export type Readiness = z.infer<typeof ReadinessSchema>

export const DeviceReadinessSchema = z.object({
  /** What was asked for; persisted. */
  desired: ReadinessSchema,
  /** What is true now; derived, never stored. */
  actual: ReadinessSchema,
  /** Set when actual cannot reach desired. */
  blocked: z.enum(['offline', 'quarantined', 'hot_budget_full', 'locked', 'error']).nullable().default(null),
  /** Unix seconds the actual level was reached. */
  since: z.number().int(),
})
```

`DeviceInfoSchema` gains `readiness: DeviceReadinessSchema`. Both `desired` and `actual` are always present, so no consumer has to guess.

New WS messages (`packages/protocol/src/messages/device.ts`):

```ts
{ type: 'device.readiness.set', payload: { deviceId, desired: ReadinessSchema } }   // client → server
{ type: 'device.readiness',     payload: { deviceId, readiness: DeviceReadinessSchema } }  // broadcast
```

Broadcast to every subscriber, so the Wall, the devices list, and the device page all move together.

### 4.2 Schema

`devices` gains one nullable column:

```ts
/** The operator's intent (plan 43 §3.3). Null means never set — treated as 'asleep'. */
desiredReadiness: text('desired_readiness'),
```

Nullable and defaulted in code, so every existing row keeps working. `actual` is never stored.

### 4.3 Readiness manager — `packages/core/src/device/readiness.ts` (new)

```ts
export interface ReadinessManager {
  /** Current actual level, derived from live session state. */
  actual(deviceId: string): Readiness
  get(deviceId: string): DeviceReadiness
  /** Apply an operator or policy request. Rejects with a coded error per §3.4. */
  set(deviceId: string, desired: Readiness, actor: { userId: string | null; clientId: string | null }): Promise<DeviceReadiness>
  /** Re-derive and broadcast; called on session, status and device changes. */
  reconcile(deviceId: string): Promise<void>
  /**
   * Ensure the device is at least `awake` and keep it there while the caller
   * needs it (§3.6). Wakes if asleep, no-ops if already awake or hot.
   * NEVER changes `desired` — releasing the last hold returns the device to it.
   */
  hold(deviceId: string, reason: HoldReason): Promise<Hold>
  start(): void
  stop(): void
}

export type HoldReason = 'viewer' | 'lease' | 'job' | 'monitor' | 'adb-endpoint' | 'transfer'
export interface Hold { readonly id: string; release(): void }
```

Derivation of `actual`, in order:

1. device `offline` → `asleep`, `blocked: 'offline'`
2. a live session exists → `hot`
3. the device holds a keep-awake this manager applied → `awake`
4. otherwise → `asleep`

Reconciliation toward `desired`:

- `→ awake`: run the existing wake sequence (`KEYCODE_WAKEUP`, `svc power stayon`, keyguard nudge) through the per-device queue with the `probe` profile. Extract that block out of `session.ts:170-186` into a shared `wakeDevice(session-or-transport)` so there is one implementation, not two.
- `→ hot`: acquire a session at `wall` quality (Plan 42 §4.5) — cheap, and upgraded automatically when someone opens Control.
- `→ asleep`: release the readiness hold; `svc power stayon false`; let Plan 42's idle TTL close the session, or close it immediately when nothing else holds it.

A hot session held by readiness counts as a subscriber for Plan 42's TTL, so the TTL never closes a deliberately hot device out from under the operator.

Pre-emption: a job claiming a device is never blocked by readiness — `busy` simply means the session is in use, and `actual` stays `hot`. A device that goes `offline` or `quarantined` keeps its `desired` and reports `blocked`, so it returns to the requested level by itself when it recovers.

### 4.4 Settings

```ts
readiness: z.object({
  maxHot: z.number().int().min(0).max(64).default(8)
    .describe('How many devices may be held hot (session alive, encoder running) at once. Hot devices open instantly but the encoder costs device CPU and battery.')
    .meta({ title: 'Max hot devices' }),
  defaultDesired: z.enum(['asleep', 'awake', 'hot']).default('asleep')
    .describe('Readiness a newly enrolled device starts at.')
    .meta({ title: 'Default device readiness' }),
}).default({}),
```

### 4.5 API

```
PUT /api/devices/:id/readiness   { desired }  → DeviceReadiness
GET /api/devices/:id/readiness               → DeviceReadiness
```

Both enforce §3.4 server-side and record a `device.readiness` event on the Plan 18 main stream with actor, from, and to — warming or sleeping a rack is exactly the kind of thing that should be answerable later.

### 4.6 Studio

**Wall tiles** (Plan 42 `components/wall/WallTile.tsx`) gain:
- a readiness badge — `hot` / `awake` / `asleep` / `offline`, with `desired ≠ actual` rendered as a transition ("waking…") rather than a flicker between two values;
- an inline Wake / Sleep control, disabled with its reason as a tooltip when §3.4 refuses it;
- for `asleep` devices, a placeholder with the device's label and status instead of a black rectangle, plus the Wake control.

**Devices list** gains a readiness column and a filter (`hot | awake | asleep`), and multi-select gains "Wake selected" / "Sleep selected" — warming a whole cluster is the actual use case, and doing it one tile at a time is the thing that would make an operator write a script.

**Topology** (Plan 32) shows the same badge on its tiles, reusing the Plan 42 `TileGrid`.

Tailwind v4 token classes only (`bg-surface`, `text-fg-muted`), never bracket syntax. Tile navigation uses `next/link`.

## 5. Implementation steps

**43.1 — Protocol and schema.** `ReadinessSchema`, `DeviceReadinessSchema`, the two WS messages, `DeviceInfo.readiness`, the `desired_readiness` column plus migration (`bun run --cwd packages/core db:generate`).

**43.2 — Extract `wakeDevice`.** Lift the wake block out of `session.ts:170-186` into a shared helper used by both `createSession` and the readiness manager. Behaviour must not change for existing sessions — the existing session tests are the guard.

**43.3 — Readiness manager.** `readiness.ts` per §4.3: derivation, reconciliation, the hot budget, pre-emption rules, the readiness hold that counts as a Plan 42 subscriber.

**43.4 — Settings, API, events, broadcast.** §4.4 and §4.5, the `device.readiness` event, and broadcast on every change.

**43.5 — Studio.** Wall badge and controls, devices-list column/filter/bulk actions, topology badge.

**43.6 — Reconcile on the events that matter.** Device connect/disconnect, quarantine/unquarantine, job claim/finish, session open/close — each triggers `reconcile`, so `actual` never goes stale.

**43.7 — Holds on every acquisition path** (§3.6, §3.7). Take a hold in `stream.start`, `lease.acquire`, the job executor host, `MonitorHub.subscribe`, the Plan 27 adb endpoint, and the Plan 39 transfer service; release it on each one's existing teardown path. Wire the hold to Plan 42's session-subscriber counting so `session.idleTtlSec` remains the **only** inactivity clock — do not add a second timer. Result: a job on a sleeping device wakes it, runs, and the device returns to `asleep` five minutes later without anyone touching it, while a device explicitly set `hot` stays hot throughout.

## 6. Acceptance criteria

1. A device can be woken from the devices list or the Wall **without** opening its video, and reaches `awake` — verified on hardware.
2. A device set `hot` opens with no wake-up sequence: the picture appears on the first keyframe.
3. `desired` and `actual` are reported separately, and a device mid-transition shows the transition rather than claiming the target.
4. `desired` survives a core restart; `actual` is re-derived, never restored from the database.
5. ~~Sleep is refused while a job is running, and refused when another operator is watching or holds the lease — each with its specific reason.~~ **Amended by Plan 49 (§3.1, §4.1):** Sleep is refused while a job is running, and refused when another operator holds the manual lease — each with its specific reason. Watching never blocks it, including from the actor's own Wall tile; holding the lease yourself never blocks your own sleep.
6. Wake is refused for `offline` and `quarantined` devices with the reason.
7. Every refusal is enforced server-side: crafting the WS message directly is refused exactly as the UI would be.
8. With `maxHot` reached, a further Wake keeps `desired: hot`, reports `actual: awake` with `blocked: 'hot_budget_full'`, and evicts nothing.
9. A device that goes offline keeps its `desired` and returns to it automatically on reconnect.
10. Plan 42's idle TTL never closes a session that readiness is deliberately holding hot.
11. A job claiming a hot device is not blocked and does not change `desired`.
12. Every readiness change is recorded on the main stream with actor, from, and to.
13. Wall, devices list, and topology all update from one broadcast, with no page refresh.
14. Taking control of, or running a job on, an `asleep` device wakes it automatically and then proceeds — no manual step, and the `waking` phase is what the operator sees.
15. That automatic wake does **not** change `desired`: after the job ends or the viewer leaves, the device returns to the readiness it had before.
16. A device explicitly set `hot` stays hot through any amount of inactivity — `desired` is a floor, not something the timer overrides.
17. There is exactly **one** inactivity clock: `session.idleTtlSec`. A search of the readiness module finds no second timer, and a device with an open monitor stream, adb endpoint, or in-flight transfer does not sleep while that hold exists.
18. `bun run typecheck` passes; `bun test` is green.

## 7. Test plan

**Unit:** `readiness.test.ts` — derivation order (offline beats everything, session ⇒ hot), the §3.4 permission matrix with each refusal reason, the hot budget accepting desire while reporting `blocked`, no eviction, offline retaining desire, job pre-emption, the readiness hold counting as a Plan 42 subscriber. `wake-device.test.ts` — the extracted helper issues the same commands in the same order as before.

**Manual smoke (`ENKAKU_TEST_DEVICE=1`, two devices):**
```bash
bun run dev && bun run dev:studio
# 1. devices list → Wake a sleeping device → screen wakes, no video opened
# 2. set it hot → open Control → picture is immediate, no wake-up panel
# 3. enqueue a job on it → job runs, readiness stays hot, desired unchanged
# 4. while the job runs → Sleep is refused, with "a job is running"
# 5. second browser watching → Sleep refused with the viewer reason
# 6. unplug the device → blocked: offline, desired kept; replug → returns to hot by itself
# 7. set maxHot=1, wake a second device → desired hot, actual awake, blocked hot_budget_full,
#    and the first device stays hot
# 8. Wall → both tiles show readiness; wake/sleep from a tile works
```

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Devices held hot overheat a rack, which is exactly what Plan 23's thermal quarantine exists to catch. | `maxHot` defaults to 8; quarantined devices refuse to warm (§3.4); a device quarantined while hot drops to `asleep` and keeps `desired`, so it re-warms only after a human releases it. The UI recommends `standbyScreenOff` for hot devices. |
| `actual` drifts from reality and the UI lies. | `actual` is derived on every read and re-derived on every relevant event (§5.6); it is never persisted, so a restart cannot resurrect a stale value. |
| Readiness holds a session that a job or another operator needs. | Readiness never blocks a job; `busy` coexists with `hot`. Sleep is refused rather than yanking a session from a viewer. |
| Merging readiness into `DeviceStatus` later "for simplicity". | §3.1 records the reason it is separate, with the scheduler transition that would break. |
| A PIN-locked device reports `awake` while showing its lock screen. | `blocked: 'locked'` when the keyguard survives the nudge — the honest answer, since adb cannot unlock it. |

## 9. Open questions

1. Should readiness be schedulable ("warm this cluster at 09:00")? Plan 21's schedules are the natural home, and the readiness API is deliberately shaped so a schedule could call it.
2. Cloud/agent devices: the manager is local-only in this plan. Warming an agent-owned device needs the readiness call to cross the tunnel — a small addition on top of Plan 25's RPC, deliberately not here.
3. Should `hot` distinguish "session at `wall` quality" from "session at `control` quality"? Currently both are simply `hot`; if operators start asking which are cheap, split it.
