# Plan 118 — M83 : Windows performance and the proxy-manager re-apply gap

> Status: partial — all four investigation/fix steps ran (118.1–118.4); 118.5 (this line) is what's left, and it is done. 118.1 and 118.2 shipped real code (a health-check cache, and a new plugin-side refusal closing a confirmed device-network bug); 118.3 and 118.4 shipped written findings and NO code, because neither investigation found something safe and scoped enough to fix in the same step — both are correct, complete outcomes per §3.1's own "investigate-then-fix" rule, not incomplete work. `partial` rather than `implemented` because §9 carries five real open items (a port-5037-conflict detector, the still-undefined "traffic adb diatur", a fleet-scale question for the owner, a `forward`-protocol/session-lifecycle follow-up, and VPN mode's own copy of 118.2's now-fixed bug) — none of which block what shipped, but none of which are done either.
> Depends on: plan 114 (M79) — the network route lifecycle (`route-service.ts`, `reverse-registry.ts`) 118.2 read in full and confirmed correct; the actual bug was one layer up, entirely inside `plugins/proxy-manager`. Plan 117 (M82) — the `direct` egress-binding feature whose real-hardware validation surfaced everything in this plan.
> Spec references: §7.9 (the network layer), §10.4 (adb server lifecycle, `cycle()`), spec's own device-discovery section (network scan)
> Ships: packages/core/src/daemon.ts (`createAdbServerVersionAccessor`), plugins/proxy-manager/src/service/apply.ts (`E_PROXY_PORT_MISMATCH`, the `bridgePort` guard), plugins/proxy-manager/src/shared.ts, plugins/proxy-manager/src/index.ts

---

## 0. Evidence

### 0.1 Where this plan comes from

While validating plan 117 on the owner's real Windows farm host, the owner reported the whole Studio UI lagging badly — navigation stuttering, `/api/health` taking 3300 ms in the logs — and asked, in their own words, whether Bun itself was the problem and whether the core should be rewritten on Node. It should not be, and it is not (§0.2 below), but the underlying complaints are real and are what this plan is for.

### 0.2 What was actually found, in order, each one checked rather than assumed

1. **The lag's actual root cause: 11 concurrent `adb.exe` processes**, screenshotted from the owner's own Task Manager. The owner runs one other application on the same host — a competitor device-farm tool ("Panda") — that evidently starts its own adb server against the same machine-wide `5037` port Enkaku's adb client also uses. Closing Panda and killing the stray processes fixed the lag immediately, confirmed by the owner. **This is not a Bun defect and this plan does not chase it further** — CLAUDE.md's own rule (`adb kill-server` forbidden everywhere but `cycle()`, because port 5037 is shared with "Android Studio and every other adb consumer on the machine") already names this exact class of conflict. What this plan owes instead is making the farm's OWN adb usage as cheap as possible, so a shared, contended port costs less when something else is also fighting for it — and giving the operator a name for the conflict instead of unexplained lag, if that is feasible without scope creep (§9 Q1).
2. **`GET /api/health` calls `adb.version()` on every single request, uncached** (`packages/core/src/server/http.ts:298`, `packages/core/src/daemon.ts:2367`). `ClientImpl.version()` (`packages/adb/src/client.ts:358`) opens a fresh socket to the adb server, sends `host:version`, reads a status and a block — normally sub-50ms, but a genuine per-request cost with no reason to pay it more than once every few seconds, and the one part of today's slowness that is unambiguously Enkaku's own code rather than an external conflict.
3. **A proxy-manager record's `listen.port` is edited and re-Applied, and the device keeps using the old port** until the operator manually rewrites the device's own Network → Proxy setting. Traced partway: `route-service.ts`'s `assertLockFree` correctly no-ops for a same-engine re-apply (§ its own doc comment) and the caller unconditionally re-persists the new config and calls `applyRoute` either way — no shortcut found there. `reverse-registry.ts`'s `establish()` also looks correct on inspection: it always calls `addReverse(..., opts.hostPort)` with whatever hostPort this call was given, and `adb reverse` is idempotent per device-port, so a second call should simply re-point the mapping. **The one candidate this plan's own earlier work (117.11's supervisor testing) already knows is real**: a proxy-manager BRIDGE that is `Running` does not restart itself when its record is edited — the record is intent, the running listener is state, and only Stop→Start (or Restart) picks up a new `listen.port`. If the operator edits the port and re-Applies WITHOUT restarting the bridge, the device's `adb reverse` is correctly re-pointed at the NEW port — which nothing is listening on, because the bridge is still bound to the OLD one. This is a strong, evidence-backed hypothesis, not a confirmed root cause — step 118.2 confirms it with a live repro before writing a single line of fix.
4. **`POST /api/devices/scan` is already an on-demand endpoint**, not a poller (`packages/core/src/registry/sweep.ts`: `scan: { mode: 'off' | 'on-demand', ... }`, and its own header comment: *"a competitor's 'scan all networks' button, reimplemented"*). USB device tracking (`packages/adb/src/tracker.ts`, `host:track-devices`) is an adb-native long-lived STREAM, not polling, either. Neither matches "busy dari scanning terus-menerus" as described — meaning the owner is very likely observing something else being read as a scan (a per-device readiness/health poll, or Studio calling the scan endpoint automatically somewhere it should not). **Step 118.3 finds the actual mechanism before proposing a button**, because proposing a manual-trigger UI for an endpoint that is already manual-trigger would fix nothing.
5. **`host-adb.ts` spawns `adb.exe` as a real child process** (`Bun.spawn([deps.binaryPath(), ...args], ...)`) for commands outside the lightweight `host:`-prefixed protocol (`adb reverse`, and others). Process creation is measurably more expensive on Windows than POSIX `fork`/`exec` — a well-documented OS-level difference, not a Bun-specific one. This is not proven to be a problem on its own; §118.4 is an audit, not an assumed fix.

### 0.3 What this plan explicitly does NOT chase

- **Panda's own adb server conflict.** External application, not this codebase's to fix. §9 Q1 is the only place it reappears, as an optional detection/warning.
- **Rewriting the core on Node.** `docs/plans/00-overview.md` §3 names Bun + Hono as an immutable stack decision. Nothing found in this investigation implicates Bun's runtime itself — every slow thing traced back to either an external process conflict or an uncached/unrestarted piece of THIS codebase's own logic, both fixable without touching the runtime.
- **"traffic adb diatur"** — the owner's own phrase, and this plan does not guess at it. Raised once in §9 Q2 as an open question the owner needs to answer before it becomes a step; nothing here is built against a guessed reading of it.

---

## 1. Goals

1. `/api/health` never pays a live adb round-trip more than once per a short, bounded interval.
2. A proxy-manager record whose port changed and was re-Applied reaches a device that actually has something listening on the new port — automatically, without the operator needing to know to restart the bridge first.
3. Whatever the operator is actually seeing when they say "busy dari scanning" is identified with a live repro, and is either already correct behaviour (in which case the finding is written down, not silently dropped) or is fixed at its real source.
4. An audit, not a rewrite: is `host-adb.ts`'s subprocess-spawn path being hit more than it needs to be, on a path an operator's own click can trigger, and can the ones proxy-manager itself sits on (`adb reverse` on every Apply) be made to matter less on Windows.

## 2. Non-goals

- Anything to do with Panda, or with detecting/coexisting with an arbitrary second adb consumer beyond a named warning (§9 Q1).
- A runtime change (Bun → Node, or anything else touching `00-overview.md` §3's immutable decisions).
- A UI redesign of the Devices page or the network-scan flow beyond what step 118.3's own finding turns out to require.
- Fixing "traffic adb diatur" — excluded until the owner defines it (§9 Q2).

---

## 3. Context and design decisions

### 3.1 Investigate-then-fix, not fix-then-hope

Two of today's four items (118.2, 118.3) start from a real but UNCONFIRMED hypothesis. This plan's own template forbids writing the fix before the repro, on the same grounds 117's own steps repeatedly proved out today: a confident-sounding fix for an unconfirmed mechanism cost real time more than once this session (the DNS test's wrong loopback assumption, the `Bun.write` race that turned out not to be the race). Steps 118.2 and 118.3 are each written as "confirm, then fix" — a worker that cannot reproduce the reported symptom reports that, in writing, rather than shipping a fix for a guess.

### 3.2 Where each fix belongs

118.1 (health caching) and 118.2 (port re-apply) are Core (`packages/core`), not `plugins/proxy-manager` — this plan does not relitigate the plugin/Core boundary plan 117 drew; it simply owns work on the Core side of it, explicitly, because the symptom crosses it (a proxy-manager Apply calling into Core's `device.network.set`).

---

## 4. Technical design

### 4.1 Health check caching (118.1)

`adbServerVersion` in `daemon.ts` becomes a simple TTL cache (5s is generous relative to how often a health poller realistically calls this, and short enough that a genuine adb-server restart is reflected within one poll cycle either way):

```ts
let cachedVersion: { value: string | null; at: number } | null = null
const VERSION_CACHE_MS = 5_000
adbServerVersion: async () => {
  if (!adb) return null
  if (cachedVersion && Date.now() - cachedVersion.at < VERSION_CACHE_MS) return cachedVersion.value
  const value = await adb.version().catch(() => null)
  cachedVersion = { value, at: Date.now() }
  return value
},
```

No new dependency, no new file — a closure-scoped cache exactly where the uncached call already lives.

### 4.2 The port re-apply gap (118.2)

**Confirm first.** Reproduce on a real (or harness-simulated) device: start a `direct`-or-vendor HTTP-mode record on port A, Apply to a device, confirm it works, edit the record's `listen.port` to B WITHOUT stopping the bridge, Apply again, and observe whether the device's `adb reverse` now points at B (per `reverse-registry.ts`, it should) while the bridge itself is still listening on A (nothing else in the code changes that). If this reproduces the reported symptom exactly, proceed to the fix below; if it does NOT reproduce it, the hypothesis in §0.2 item 3 is wrong and this step becomes a fresh investigation instead, written up rather than forced.

**The fix, if confirmed:** `plugins/proxy-manager/src/service/apply.ts`'s `applyAssignment`, for HTTP mode, currently reads `record.listen.port` and hands it to `device.network.set` without checking whether the record's own BRIDGE is actually listening on that port right now. It should refuse — naming the mismatch — rather than send a route to a port nothing serves: `E_PROXY_NOT_RUNNING` already exists for "record not enabled"; a new, narrower precondition (`E_PROXY_PORT_MISMATCH` or reuse of the existing code with a clearer message) covers "record enabled, but its live listener is on a different port than what would be Applied" — read the supervisor's own `runtimeOf(id).port` and compare against `record.listen.port` before calling `routeForRecord`. This is a plugin-side guard, not a Core change: Core's re-apply behaviour is already correct (§0.2 item 3), the gap is that proxy-manager can ask it to apply a route to a port that is stale on THIS side of the boundary.

### 4.3 The "busy while scanning" report (118.3) — FOUND, written up

**118.3 is done as a finding; no code changed.** Every automatic/recurring mechanism in the codebase was read in full and traced against what actually sets a device's rendered status to `'busy'`. None of them are the cause — the literal `'busy'` chip an operator sees is set by exactly one code path, and it is not a scan.

**What was checked, and ruled out, one at a time:**

1. **`POST /api/devices/scan`** (`packages/core/src/registry/sweep.ts`) and **`POST /api/devices/rescan`** — exhaustively grepped across `packages/studio/src` for every call site. Both are wired to exactly one thing each: an explicit button click (`packages/studio/src/lib/network-scan.ts`'s `useNetworkScan().scan`, called only from `FarmNetworksEditor.tsx`'s "Scan network" button and `ScanNetworkDialog.tsx`'s "Scan all" button; `DiscoveredTray.tsx`'s "Rescan" button for `/rescan`). No `useEffect` on mount, no `setInterval`, no WS-triggered auto-call anywhere in Studio calls either endpoint. Confirmed clean.
2. **USB `host:track-devices`** (`packages/adb/src/tracker.ts`) — a genuine long-lived adb-native stream (the adb server pushes connect/disconnect over one persistent connection); not a poll, confirmed by reading the file.
3. **`packages/core/src/device/health.ts`'s `probeOnce`** (the plan's own named candidate) — real `setInterval`, default `probeIntervalSec` 60s, but it only iterates devices whose `status === 'quarantined'` AND whose `quarantineReason` starts with `'adb:'` (line 88-93). In normal operation this set is empty or tiny — it cannot explain "dozens of devices" appearing busy, and even when it fires it never touches `devices.status` for a non-quarantined device; a successful probe only clears a quarantine (`UNQUARANTINE`), it never sets `'busy'`.
4. **`packages/core/src/device/battery.ts`'s `pollOnce`** — the one genuine fleet-wide automatic poll in the codebase: real `setInterval`, default `pollIntervalSec` 60s, and it DOES iterate every device with `status !== 'offline'` (line 127) — i.e. the whole active fleet, every minute, bounded to 8 concurrent `dumpsys battery` execs. This is a real, unconditional, recurring background adb load across "dozens of USB-attached devices" and is the closest thing in the codebase to what the owner describes as "terus terusan". **But it is not the mechanism**: `pollDevice` (line 79-110) only ever writes `devices.battery` and, on overheat, `quarantineReason` — it never writes `devices.status = 'busy'` and has no code path that could.
5. **Studio's Devices page itself** (`packages/studio/src/app/page.tsx`) — `GET /api/devices` is fetched exactly once on mount (line 419-420's `useEffect`) plus once more on specific WS events (`device.added`, `device.status`, etc.) — the "fetch once, then subscribe" pattern CLAUDE.md requires. No polling of the device list was found.
6. **Device preparation** (`packages/core/src/device/preparation/runner.ts`) — can indeed run automatically on admission/reconnect (confirmed via `packages/studio/src/lib/use-preparation.ts`'s own doc comment), but grepped for any `states.apply(...)`/status write and found none — a preparation pass never claims the device through the job/state machine, so it cannot be the source of `'busy'` either.

**The actual mechanism, confirmed by reading the state machine and its one production caller:**

`packages/core/src/device/state-machine.ts:27` — `JOB_CLAIMED: { idle: 'busy' }` is the ONLY transition in the entire table (`TRANSITIONS`, lines 22-31) that produces `'busy'`. Its one production call site is `packages/core/src/queue/job-store.ts:585`:
```ts
tx.run(sql`UPDATE devices SET status = 'busy' WHERE id = ${deviceId} AND status = 'idle'`)
```
— reached only when a device successfully claims a row from the real `jobs` table (a script run, a command run, or a batch/schedule dispatch). Every other call site of `states.apply(..., 'JOB_CLAIMED')` in the repo is in a test file. There is no scan, sweep, discovery, health-probe, battery-poll, readiness-reconcile, or preparation code path anywhere that sets `devices.status` to `'busy'`.

**Conclusion:** "busy dari scanning network atau list devices" does not correspond to any scanning or discovery mechanism in this codebase — both candidate scan endpoints are already button-gated exactly as the owner asked, and the only fleet-wide *automatic* poll that exists (`battery.ts`) never touches device status. What the owner is very likely seeing is REAL job-queue activity — actual scripts/commands/batches (very plausibly the newly-shipped Workflows/Schedules feature, `feat: workflow & recordings`, landed just before this report) claiming devices and correctly showing them as `'busy'` while they run. On a large fleet, frequent legitimate job churn across "dozens of devices" can look and feel like continuous background activity to an operator, and get described with the same word ("scanning") used for the competitor's tool, even though the two are functionally unrelated. This is a correct, working state machine doing its job, not a bug — there is nothing here to fix without knowing whether the owner has schedules/workflows configured against a large slice of the fleet (see the new open question, §9 Q3).

No manual-trigger UI is proposed: the only genuinely "manual trigger vs. automatic" endpoints already work exactly that way (item 1 above), so building the button the owner asked for on top of `/api/devices/scan` would fix nothing, per the plan's own warning in §0.2 item 4.

### 4.4 The `host-adb.ts` subprocess audit (118.4) — DONE, audit only

List every call site of `hostAdb.run(...)`/`Bun.spawn([deps.binaryPath(), ...])` reachable from a path an operator's ordinary use of the farm hits repeatedly (Apply, device readiness, bulk operations) — not from a one-off action. For each, note whether it could instead go through the lightweight `host:`-prefixed socket protocol `packages/adb/src/client.ts` already implements (no process spawn) — `adb reverse` specifically has no `host:` equivalent (it's a real client-side operation, not a query the server answers directly), so it may turn out nothing here is fixable without touching adb's own protocol — an audit that concludes "nothing to change, here is why" is a valid, complete result of this step, not a failure to find something.

**Traced from `host-adb.ts`'s spawn wrapper outward across `packages/core/src` and `packages/drivers/src`, filtered to sites an operator's ordinary, repeated use of the farm actually reaches:**

| Call site | Command(s) | Trigger / frequency | Verdict |
|---|---|---|---|
| `reverse-registry.ts` `addReverse`/`removeReverse`, wired from proxy-manager's Apply and `daemon.ts`'s `onDeviceReady` | `adb -s <serial> reverse tcp:<a> tcp:<b>` / `reverse --remove` | Every proxy-manager Apply on `adb-reverse-proxy`; every reconnect with one enabled | **No lightweight alternative exists.** `client.ts` today implements only `host:version`/`host:devices-l`/`host:reconnect-offline` — all answered by the adb server from its own state. `reverse` lives in the device's own `adbd` and structurally needs a transport round trip. |
| Same registry's `verify()` via `observeAdvisoryThrottled` | `adb -s <serial> reverse --list` | Studio's Network panel poll, throttled to 10s | No lightweight alternative — and already bounded to a cost comparable to 118.1's own health cache. |
| `daemon.ts` boot-time forward/reverse cleanup | `forward --list`, `reverse --list` per stale entry | Once per core boot | Already infrequent enough not to matter. |
| `registry/cutover.ts`'s `enableTcp` fallback | `-s <serial> tcpip <port>` | Only when the non-spawn `tcpip()` path fails, during the explicit USB→wireless cutover wizard | Already infrequent enough not to matter — rare, and a fallback of a fallback. |
| `ui-server/launcher.ts` `forward()`/`removeForward()` | `forward`, `forward --list`, `forward --remove` | Once per inspector session open/close | **Candidate for one** — adb's `forward` table is host-server bookkeeping (`host:list-forward`/`host:killforward` exist in the protocol), unlike `reverse`. Not implemented here. |
| `guest-agent/launcher.ts` `forward()`/`removeForward()`, reached via `agentProvisioner.ensure()` → `hello()` → `withEphemeralSession` | Same trio | **Every device reconnect/admission** when `guestAgent.provision` is `'auto'` (the default) and no network route is applied — the common case | **The strongest finding.** `withEphemeralSession`'s own doc comment: a session with no active route is "built, used, and closed again" — 3 `adb.exe` spawns per reconnect purely for a liveness probe, even when nothing changed. Candidate for one on two axes: the `forward` trio itself, and separately `withEphemeralSession`'s open-then-immediately-close lifecycle. Neither implemented — a session-lifecycle change is out of an audit step's scope. |
| `grant-fallback.ts`, guest-agent uninstall | install/uninstall commands | Explicit, one-off operator action only | Already infrequent enough not to matter. |
| `api/devices.ts` bulk `POST /prep/apply` | — | Bulk settings apply | **Not a `host-adb.ts` call site at all** — confirmed by grep (zero matches). Writes `devices.settings` directly / goes through `SessionManager`, never spawns adb. Flagged as a candidate by the plan, checked, turned out to be a non-finding — recorded rather than dropped. |

**No code changed.** Nothing qualified as small/obvious/low-risk — the one real hot-path finding (guest-agent's `hello()`, 3 spawns per reconnect) needs either a protocol extension to `@enkaku/adb`'s client (the `forward` trio) or a session-lifecycle redesign of `withEphemeralSession`, both real follow-up work sized beyond this audit step. Recorded as §9 Q4.

---

## 5. Implementation steps

**118.1 — health check caching. DONE.** Per §4.1. *Result:* `/api/health` never triggers more than one live adb round-trip per 5 seconds, regardless of poll frequency — a TTL cache extracted into a named, exported `createAdbServerVersionAccessor(getAdb, ttlMs)` in `daemon.ts` (extracted rather than left as an inline closure, per the plan's own §7 allowance, specifically so criterion 1's behavioural test — a fake adb client counting real invocations — could exist at all; `daemon.ts` otherwise has no exported seam a test can drive).

**118.2 — the port re-apply gap: confirm, then fix. DONE — hypothesis CONFIRMED, fixed.** Per §4.2's two-phase description. A real repro (`createSupervisor` + a real HTTP bridge on loopback — not mocked) proved it exactly as hypothesised: editing a record's `listen.port` without restarting its bridge, then re-Applying, sent the STALE new port to `device.network.set` while the bridge kept listening on the old one — Core (`route-service.ts`/`reverse-registry.ts`) did exactly what it was asked and is confirmed not at fault. **Fix, entirely inside `plugins/proxy-manager`:** `ApplyHost` gained an optional `bridgePort(proxyId): number | null` (three-valued — `undefined` means "nobody looked", matching this pack's existing `hasPassword`/`hasListenerAuth` discipline); `applyAssignment`'s HTTP-mode branch now refuses with a new `E_PROXY_PORT_MISMATCH` naming both ports whenever they disagree, including "nothing is listening at all"; `index.ts`'s real handler wires `bridgePort` to the live `supervisor` instance. **Known, deliberate gap, not silently dropped:** VPN mode's `direct`-upstream branch (`directVpnRouteForRecord`) has the identical staleness exposure — it also names `record.listen.port` — but the plan's own wording scoped this guard to HTTP mode specifically, so it was left unguarded rather than pulling scope forward. Recorded as §9 Q5.

**118.3 — the scanning/busy report: find the real mechanism. DONE (finding only, no code change).** Per §4.3. *Result:* the "busy" chip an operator sees is set by exactly one code path — `state-machine.ts`'s `JOB_CLAIMED: { idle: 'busy' }`, applied only in `job-store.ts:585` when a device claims a real queued job. Every scan/discovery/health/battery/readiness/preparation mechanism that runs automatically was read in full and confirmed to never touch `devices.status`. No fix is proposed — there is nothing broken to fix; the likely explanation is real, legitimate job-queue activity (very plausibly the newly-shipped Workflows/Schedules feature) being misread as "scanning". §9 Q3 asks the owner directly whether schedules/workflows are configured against a large slice of the fleet, since that would fully close this out as expected behaviour rather than a defect.

**118.4 — the Windows subprocess-spawn audit. DONE, audit only.** Per §4.4. *Result:* the table in §4.4 above — every repeatedly-hit call site marked "no lightweight alternative exists" or "candidate for one", no code changed. The one hot-path finding (guest-agent's `hello()` liveness probe, 3 `adb.exe` spawns per device reconnect when no route is applied — the common case) is real but sized beyond an audit step; recorded as §9 Q4.

**118.5 — documentation. DONE.** This step. `> Status:`/`Ships:` updated below to reflect what actually shipped (118.1, 118.2 code; 118.3, 118.4 findings) versus what remains open (§9). `docs/plans/00-overview.md` §9 gains a row for 118.2's new `E_PROXY_PORT_MISMATCH` problem code (a real vocabulary addition inside plugin KV/response shape — no SQL migration).

---

## 6. Acceptance criteria

1. `/api/health` called 10 times in under 5 seconds triggers exactly one `adb.version()` call, asserted by a test with a fake adb client counting invocations. **Met** — `daemon-wiring.test.ts`'s new describe block.
2. Either: a proxy-manager record edited (port changed) and re-Applied without an intervening Restart is refused with a named, actionable error naming the mismatch — asserted by a test — OR the plan's own status line documents, in the owner's and the investigator's own words, why 118.2's hypothesis did not hold and what was found instead. **Met, first branch**: `apply.test.ts`'s "plan 118 step 118.2" describe block proves the stale-port apply is now refused with `E_PROXY_PORT_MISMATCH`, plus a control proving a matching port is not refused and a control proving no `bridgePort` degrades to a no-op.
3. 118.3 produces a written finding an operator/future contributor can read to understand what "busy while scanning" actually was — never left as "could not reproduce" with no further detail. **Met**: §4.3 above names the exact code path (`state-machine.ts:27` / `job-store.ts:585`) and rules out every automatic mechanism by file and line.
4. 118.4 produces a written table of `host-adb.ts` call sites with a verdict per site — no silent gaps. **Met**: §4.4's table above, 9 rows, no gaps.
5. `bun run typecheck` is clean and the tests for every file touched pass, scoped per CLAUDE.md's rule (never a bare full-suite run). **Met** — verified across the merged result of all four steps together, not only in each step's own isolated worktree: `bun run typecheck` all packages OK; `bun run --cwd plugins/proxy-manager test` 328 pass, 0 fail; `bun test packages/core/src/daemon-wiring.test.ts` 89 pass, 0 fail.

## 7. Test plan

- 118.1: a unit test around `daemon.ts`'s health deps wiring — 10 rapid calls, 1 underlying `version()` call. **Done**, via the extracted `createAdbServerVersionAccessor`.
- 118.2: the hypothesis confirmed, so a `plugins/proxy-manager` test reproducing "bridge running on port A, record edited to port B, Apply refused" — colocated with `apply.test.ts`. **Done**, plus two controls (matching port not refused; no `bridgePort` supplied degrades to a no-op).
- 118.3 / 118.4: no new automated tests were expected — investigation-and-report steps; any fix that falls out gets its own test scoped to whatever file changed. **Both confirmed: no fix fell out of either, so no new tests were added for them.**

Every step's own test run is scoped to the files it touched, run once, sequentially — never a bare `bun test`, never two invocations at once (CLAUDE.md's hard rule).

---

## 8. Risks

| Risk | Mitigation |
|---|---|
| 118.2's hypothesis is wrong and the real bug is deeper in `route-service.ts`/`reverse-registry.ts` (Core, high blast radius, real devices) | The confirm-first structure means no Core network code is touched until the symptom is reproduced under controlled conditions; if it turns out to be Core after all, that becomes a clearly-scoped follow-up, not a rushed same-session fix in code this plan's author read for the first time today |
| 118.3 finds nothing wrong (the "busy" report was a one-off, e.g. caused by the same Panda/adb-server contention as §0.2 item 1) | A written "found nothing beyond the already-known adb-server contention" is an acceptable, honest result — not every reported symptom has a code-level fix. **This is what happened**: §4.3 found the "busy" chip is exclusively job-queue-driven, not scan/discovery-driven. |
| 118.4's audit tempts a larger refactor of `host-adb.ts` than the audit itself calls for | The step is explicitly scoped to "audit, list, verdict" — any actual refactor is a separate, later plan, not folded in here under time pressure |

## 9. Open questions

1. **Should the farm detect and name a port-5037 conflict** (a second process holding the adb server) rather than leaving it as unexplained lag? Plausible: `adb-server-control.ts` already knows the port is shared; a doctor check or a `/api/health` field naming "adb server PID does not match ours" would turn today's hour of confused troubleshooting into one sentence on screen. Proposed for a later plan, not this one — it is genuinely new surface, not a fix to something broken.
2. **What does "traffic adb diatur" mean?** The owner's own phrase, not defined further in the conversation this plan was written from. Needs the owner's own words before it becomes a step — guessing risks building the wrong thing, exactly as 118.2 warns against for its own hypothesis.
3. **(New, from 118.3) Does the owner have Schedules/Workflows configured against a large slice of the fleet?** §4.3's finding traces every "busy" chip to a real job claim (`job-store.ts:585`). If schedules/workflows are indeed running frequently across many devices, that fully and correctly explains the "busy... terus terusan" report as expected behaviour, not a defect — but this needs the owner's own confirmation (or a quick look at `jobs`/`batches` table volume on their farm) before it can be closed out with certainty. Needs the owner's own answer before any further action is considered here.
4. **CLOSED, by plan 119 (M84).** `@enkaku/adb`'s `client.ts` now has `forward`/`listForward`/`killForward` (plan 119 §4.1), and both launchers that used to spawn `adb.exe` three times per device reconnect (`guest-agent/launcher.ts`, `ui-server/launcher.ts`) now call these instead — plan 119 steps 119.1-119.5, all done. The `withEphemeralSession` lifecycle redesign half of this question was deliberately deferred (plan 119 §0.3, §9 Q1): it is a larger, riskier change, worth pursuing only if the owner still reports lag after the protocol swap alone ships. That half stays open, tracked at plan 119 §9 Q1, not here.
5. **(New, from 118.2) VPN mode's `direct`-upstream branch has the same port-staleness exposure 118.2 just fixed for HTTP mode, and is currently unguarded.** `directVpnRouteForRecord` in `plugins/proxy-manager/src/shared.ts` also names `record.listen.port` as the address the guest agent is told to dial. The plan's own wording scoped 118.2's guard to HTTP mode; extending the same `bridgePort` check to the VPN branch is a small, well-understood follow-up now that the HTTP-mode pattern exists to copy.
