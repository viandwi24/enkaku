# Plan 23 — M12b : adb Concurrency Scaling and Device Health

> Status: draft
> Depends on: **Plan 22.1** (deadlines and coded errors are the input signal for health). Blocks Plans 24–28 only softly — they work without it, but a 20-device farm will be throughput-bound until this lands.
> Spec references: §10.4 (adb serialisation — **this plan amends it**), §15.2 (battery and thermal quarantine), §16 (NFR).

---

## 1. Goals

- adb concurrency scales with the number of devices instead of being a constant sized for a demo.
- A farm of 20+ devices polls battery and temperature on schedule, without one slow device delaying the rest.
- Repeated adb failures on one device mark it unhealthy and take it out of the scheduler pool, automatically, with automatic recovery when it comes back.
- Every threshold in this plan is a farm setting with a working default, editable from Studio without a restart.
- Queue depth, latency, and failure counts are observable through an API instead of inferred from symptoms.
- `docs/spec.md` §10.4 and `docs/plans/00-overview.md` §3 are amended to match, in the same commit as the code.

## 2. Non-goals

- Anything user-facing beyond the settings form and one debug panel. No new device features.
- Streaming commands — Plan 24.
- Changing the per-device serialisation rule. One device still runs one adb command at a time; only the **global** cap changes.
- Per-tenant or per-user quotas.

## 3. Context and design decisions

### 3.1 The global cap is a farm-wide ceiling, not a per-device one

`packages/adb/src/client.ts:34` clamps the shared semaphore to `min(8, max(1, maxConcurrent ?? 6))`. That number is the total number of adb commands in flight **across the entire farm**.

At the target scale — 10 devices in testing, 20+ in production — this binds well before anything else does. One battery poll cycle alone is one command per device; with 20 devices and 6 slots that is four serialised waves before a single job or manual action gets a turn.

The per-device chain in `PerDeviceQueue` is what actually protects a device from concurrent commands. The global semaphore protects the *host* (USB bandwidth, adb server threads, CPU). Those are different limits and only the second should scale with fleet size.

### 3.2 The scaling rule

```
auto = min(24, max(6, ceil(deviceCount * 0.75)))
```

- 4 devices → 6 (unchanged from today, so small setups see no behaviour change)
- 10 devices → 8 (the old ceiling, reached exactly at the plan's stated test scale)
- 20 devices → 15
- 32+ devices → 24 (capped; beyond this the host, not the semaphore, is the limit)

The cap of 24 is deliberate: the adb server itself becomes the bottleneck somewhere above this on typical hosts, and an unbounded formula would just move the failure from "slow" to "adb server refuses connections". A farm that needs more should run a second core, which is what the cloud agent model already provides.

`deviceCount` is the number of devices that are **not offline** — an unplugged phone should not reserve capacity.

### 3.3 This contradicts the spec, so the spec changes

`docs/spec.md` §10.4 and `00-overview.md` §3 both state "a loose global semaphore (6–8)". Per `00-overview.md` §1, the spec wins over a plan — so this plan does not quietly exceed it. Step 23.6 amends both documents to describe the scaling rule with the constant as its floor. That edit is part of this plan's Definition of Done, not a follow-up.

### 3.4 Battery polling is sequential across devices — that is a latent bug

`packages/core/src/device/battery.ts:82-86` loops devices with `await` inside. One device that takes the full `battery` timeout (8 s after Plan 22.1) delays the poll of every device behind it. With 20 devices and a couple of slow ones, the thermal check — the thing protecting against swollen batteries on a 24/7 rack — drifts far past its configured interval.

Bounded parallelism fixes it: run the poll with a concurrency cap of its own (`min(8, maxConcurrent)`), so the cycle takes as long as the slowest device rather than the sum of all of them. The per-device queue still serialises against other traffic to that device.

### 3.5 Health: reuse `quarantined`, do not invent a status

The state machine already has `quarantined` plus `quarantineReason`, and Studio already renders it. Adding an `unhealthy` status would mean touching the state machine, the protocol, every badge, and every filter, to express something the existing status already means: *not eligible for scheduling, with a reason*.

The one real difference is recovery. Thermal quarantine is released by a human on purpose (`unquarantine`, `battery.ts:128`) because a hot phone needs looking at. An adb failure is usually transient — a USB re-enumeration, a device reboot — and should recover on its own.

So: **reason-prefixed recovery.** Quarantines with a reason starting `adb:` are probed periodically and released automatically on success. Everything else stays manual, exactly as today.

### 3.6 What counts as a health failure

Only errors that indicate *the device is not answering*:

| Error (Plan 22.1 §4.2) | Counts? | Why |
|---|---|---|
| `E_ADB_TIMEOUT` | yes | the device did not answer in its budget |
| `E_ADB_CONNECT_TIMEOUT`, `E_ADB_HANDSHAKE_TIMEOUT` | yes | transport is not usable |
| `E_ADB_BUSY` | **no** | this is load, not the device — §3.1 of Plan 22.1 split these clocks precisely so this distinction exists |
| `E_ADB_OUTPUT_LIMIT`, `E_ADB_ABORTED`, `E_ADB_BAD_TIMEOUT` | no | caller-side outcomes |
| `E_ADB_FAIL` (a shell error) | no | the device answered; the command failed |

Any success resets the counter to zero. The counter is in memory only — a core restart re-probes everything anyway.

## 4. Technical design

### 4.1 Farm settings — `packages/protocol/src/settings.ts`

Added to `FarmSettingsSchema`, following the existing `.describe(...).meta({ title })` pattern so the schema-driven form renderer picks them up with no UI code:

```ts
adb: z
  .object({
    maxConcurrent: z.number().int().min(0).max(24).default(0)
      .describe('Total adb commands in flight across the farm. 0 = scale automatically with device count.')
      .meta({ title: 'Max concurrent adb commands' }),
    execTimeoutMs: z.number().int().min(1_000).max(120_000).default(15_000)
      .describe('Default execution budget for a single adb command.')
      .meta({ title: 'adb command timeout (ms)' }),
    maxQueueDepth: z.number().int().min(4).max(256).default(32)
      .describe('Pending adb commands allowed per device before new ones are rejected.')
      .meta({ title: 'Max queue depth per device' }),
  })
  .default({}),

health: z
  .object({
    consecutiveFailures: z.number().int().min(1).max(20).default(3)
      .describe('Consecutive adb timeouts before a device is quarantined as unreachable.')
      .meta({ title: 'Failures before quarantine' }),
    autoQuarantine: z.boolean().default(true)
      .describe('Quarantine a device automatically when it stops answering adb.')
      .meta({ title: 'Auto-quarantine unreachable devices' }),
    probeIntervalSec: z.number().int().min(10).max(3600).default(60)
      .describe('How often a device quarantined for adb failures is re-probed.')
      .meta({ title: 'Recovery probe interval (s)' }),
  })
  .default({}),
```

No migration: `farm_settings` is a single JSON row (`schema.ts:197`), and the Zod defaults fill in for existing rows.

### 4.2 Resizable semaphore — `packages/adb/src/queue.ts`

```ts
export class Semaphore {
  resize(max: number): void   // raising it wakes queued waiters immediately;
                              // lowering it never revokes a slot already held
  get max(): number
  get inFlight(): number
  get waiting(): number
}
```

`AdbClient` gains `setMaxConcurrent(n: number)` and `stats()`.

### 4.3 Autoscaler — `packages/core/src/device/adb-scaling.ts` (new)

```ts
export function computeAutoConcurrency(nonOfflineDeviceCount: number): number {
  return Math.min(24, Math.max(6, Math.ceil(nonOfflineDeviceCount * 0.75)))
}
```

Recomputed when the device registry sees a device appear, disappear, or change status, and when `adb.maxConcurrent` changes in settings. A non-zero setting wins over the formula. Every change is logged once at `info` — this number silently changing is exactly the kind of thing that makes later performance reports unreadable.

### 4.4 Health tracker — `packages/core/src/device/health.ts` (new)

```ts
export interface DeviceHealth {
  /** Fed from AdbClient.onMetric (Plan 22.1 §22.6). */
  note(serial: string, outcome: 'ok' | 'timeout' | 'busy' | 'error', code?: string): void
  consecutiveFailures(deviceId: string): number
  start(): void   // starts the recovery prober
  stop(): void
}
```

Behaviour:

1. `note()` maps serial → deviceId through the registry, increments on the codes in §3.6, resets to 0 on `ok`.
2. On reaching `health.consecutiveFailures` and with `autoQuarantine` on: `states.apply(deviceId, 'QUARANTINE')`, set `quarantineReason = 'adb:unreachable'`, record a `device_events` main-stream event `device.unhealthy` (Plan 18 recorder), and broadcast the device update.
3. If `states.apply` is refused (the device is busy with a job), log and retry on the next failure — identical to how thermal quarantine already behaves (`battery.ts:105`).
4. The prober runs every `probeIntervalSec`: for each device quarantined with a reason starting `adb:`, run one `getprop ro.serialno` with the `probe` profile. On success → `UNQUARANTINE`, clear the reason, record `device.recovered`. On failure → leave it.

### 4.5 Parallel battery polling — `packages/core/src/device/battery.ts`

Replace the sequential loop with bounded parallelism:

```ts
const limit = Math.max(1, Math.min(8, client.stats().maxConcurrent))
await mapWithConcurrency(rows, limit, async (row) => { /* existing per-device body */ })
```

`mapWithConcurrency` goes in `packages/core/src/util/concurrency.ts` (new, ~20 lines, unit-tested). Each device's failure stays isolated in its own `catch`, exactly as now — one device failing must never abort the cycle.

### 4.6 Stats endpoint — `packages/core/src/api/adb-stats.ts` (new)

`GET /api/adb/stats` (permission: `device.view`):

```jsonc
{
  "global": { "maxConcurrent": 15, "auto": true, "inFlight": 3, "waiting": 0 },
  "devices": [
    { "deviceId": "…", "label": "moto g06 power", "queueDepth": 1,
      "execMsP50": 42, "execMsP95": 310,
      "counts": { "ok": 1841, "timeout": 2, "busy": 0, "error": 5 },
      "consecutiveFailures": 0 }
  ]
}
```

Latency percentiles come from a small fixed-size ring (last 128 samples per device) held in memory — no new table, no retention policy, and it costs nothing when nobody looks.

Studio surfaces this on the existing settings page as a collapsed "adb diagnostics" panel: a table plus the global counters, polled while open. Read-only.

## 5. Implementation steps

**23.1 — Settings schema**
- Add the `adb` and `health` blocks (§4.1) to `FarmSettingsSchema`; add tests asserting defaults apply to a settings row that predates them.
- Result: the Studio settings form renders the new fields with no UI change (schema-driven renderer).

**23.2 — Resizable semaphore and client stats**
- `Semaphore.resize` / `max` / `inFlight` / `waiting`; `AdbClient.setMaxConcurrent` / `stats()` (§4.2).
- Result: `queue.test.ts` covers raising the limit waking waiters, and lowering it not revoking held slots.

**23.3 — Autoscaler**
- Add `packages/core/src/device/adb-scaling.ts`; wire recomputation into the device registry's change path and the settings-change path in `daemon.ts`.
- Result: plugging in devices changes the logged concurrency; setting `adb.maxConcurrent` to a non-zero value pins it.

**23.4 — Parallel battery poll**
- Add `packages/core/src/util/concurrency.ts` with `mapWithConcurrency`; rewrite `pollOnce` (§4.5).
- Result: with N devices where one is artificially slow, the cycle finishes in roughly the slowest device's time, not the sum.

**23.5 — Health tracker and recovery prober**
- Add `packages/core/src/device/health.ts`; subscribe it to `AdbClient.onMetric`; start/stop it in `daemon.ts` next to the battery monitor.
- Record `device.unhealthy` and `device.recovered` on the Plan 18 main stream.
- Result: a device that stops answering is quarantined with reason `adb:unreachable` after the configured failures, and un-quarantines by itself once it answers.

**23.6 — Amend the spec and the overview** *(do not skip; §3.3)*
- `docs/spec.md` §10.4: replace "a loose global semaphore (6–8)" with the scaling rule, stating 6 as the floor and 24 as the ceiling, and noting the per-device serialisation is unchanged.
- `docs/plans/00-overview.md` §3, the "adb serialisation" row: same change, referencing this plan.

**23.7 — Stats endpoint and diagnostics panel**
- Add `packages/core/src/api/adb-stats.ts` and mount it; add the collapsed panel to the Studio settings page.
- Result: `curl localhost:7700/api/adb/stats` returns live figures.

## 6. Acceptance criteria

1. With 1–4 devices the effective concurrency is 6 — identical to today. With 20 devices it is 15. Setting `adb.maxConcurrent` to a non-zero value overrides both.
2. Changing `adb.maxConcurrent` in Studio takes effect without restarting the core.
3. A battery poll cycle over N devices, one of which times out, completes in approximately one timeout — not N.
4. A device that stops answering adb is quarantined with reason `adb:unreachable` after `health.consecutiveFailures`, is skipped by the scheduler, and emits `device.unhealthy`.
5. That device is un-quarantined automatically within one `probeIntervalSec` of becoming reachable, and emits `device.recovered`.
6. A thermally quarantined device is **not** auto-released — existing behaviour is preserved exactly.
7. `E_ADB_BUSY` never contributes to the health counter (verified by unit test).
8. `GET /api/adb/stats` reports per-device queue depth, p50/p95, outcome counts, and the global semaphore state.
9. `docs/spec.md` §10.4 and `00-overview.md` §3 describe the implemented rule.
10. `bun run typecheck` passes; `bun test` is green.

## 7. Test plan

**Unit (no device):**
- `adb-scaling.test.ts` — the formula at 0, 1, 4, 10, 20, 32, 100 devices.
- `concurrency.test.ts` — `mapWithConcurrency` respects the limit, preserves order, isolates rejections.
- `health.test.ts` — counting only the right codes; reset on success; the quarantine threshold; refusal while busy retried later; the prober releasing only `adb:`-prefixed reasons.
- `queue.test.ts` — `resize` behaviour.
- `settings.test.ts` — defaults applied to a legacy settings row.

**Manual smoke (`ENKAKU_TEST_DEVICE=1`):**
```bash
bun run dev
# 1. note the logged concurrency with one device (expect 6)
# 2. GET /api/adb/stats → global + per-device figures present
# 3. unplug the device mid-session; after ~3 failed polls it is quarantined
#    with reason adb:unreachable and disappears from the schedulable pool
# 4. plug it back in; within one probe interval it returns to idle by itself
# 5. set adb.maxConcurrent = 12 in Studio; the log reports the change with no restart
```

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Higher concurrency overloads the adb server on a modest host and makes everything worse. | The ceiling is 24 and the formula is sub-linear (0.75×). `adb.maxConcurrent` lets an operator pin a lower value immediately, and `/api/adb/stats` shows whether waiting is rising. |
| Auto-quarantine fires during a transient USB blip and pulls a healthy device out mid-shift. | Default of 3 consecutive failures, only on timeout-class errors, with automatic recovery on the next successful probe. `autoQuarantine: false` disables the action while keeping the counters. |
| Reusing `quarantined` conflates "too hot" with "not answering" in the UI. | The reason string is already displayed; `adb:unreachable` versus `thermal:41.2C` reads clearly, and the recovery rule keys off the prefix rather than guessing. |
| Parallel battery polling multiplies load at the moment the farm is already busy. | Its concurrency cap is separate and never exceeds 8, and each command carries the 8 s `battery` profile from Plan 22.1. |
| The spec amendment is forgotten and the code silently contradicts §10.4. | It is step 23.6 with its own acceptance criterion (§6.9). |

## 9. Open questions

1. Should the autoscaler count devices or *active sessions*? Counting devices is simpler and errs high; if idle-but-online devices turn out to inflate the number unhelpfully, switch to sessions in a follow-up.
2. Is 0.75 the right coefficient? It is a starting point chosen to hit the old ceiling (8) at the stated test scale of 10 devices. `/api/adb/stats` is the instrument for revising it with evidence.
3. Should `device.unhealthy` also notify (webhook/email)? Deferred — there is no notification subsystem yet.
