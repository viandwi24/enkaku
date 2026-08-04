# Plan 54 — M24d : Fail closed, and a route that actually comes back

> Status: implemented — the agent's `held` state (TUN stays up, forwarding stops) replaces tear-down on failure, and `maybeRecoverRoute` in the core applies a bounded 5s/20s/60s backoff shared by `restoreDeviceRoute` and the heartbeat, per §4.2's "one owner, one counter".
> Ships: apps/guest-agent/app/src/main/java/dev/enkaku/guestagent/route/RouteVpnService.kt
> **Depends on:** Plan 51 (the checks it reports through), Plan 52 (the persistence it recovers).
> **Spec references:** §7.9 (network layer).
> **Amends:** Plan 52 §5.3 (restore was specified correctly and implemented incompletely) and Plan 43's dead-man's switch (its teardown is backwards).

---

## 0. Two defects, both found by an operator using the feature

**The dead-man's switch causes the leak it exists to prevent.** It was added so a device could not be left routed by a farm that had vanished. It does that by calling `RouteVpnService.stop()` — which tears the TUN down, at which point every packet leaves on the device's real address. The device stops being stranded and starts being *exposed*, silently, which is the worse of the two failures and the exact one the route was configured to avoid.

**A route never comes back.** Pull the USB cable or restart the core, and the switch tears the route down after ninety seconds. On reconnect the core probes, sees `up: false`, records drift — and stops. `restoreDeviceRoute` only calls `coldProbe`; nothing re-applies. The operator is left with `enabled: yes` and `up (device): no` forever, and the only way out is to open the device page and press apply. Plan 52 §3.2 called for "probe first… and only apply when the device reports no route"; the probe half shipped and the apply half did not.

Both are small fixes. Neither needs a second device, new Android APIs, or the unverified always-on mechanism.

## 1. Goals

1. When the tunnel cannot carry traffic, the device **sends nothing** rather than falling back to its real address.
2. A route that was enabled comes back on its own after a USB disconnect, a device reboot, or a core restart — without anyone opening the UI.
3. Recovery is bounded and visible: it does not retry forever in silence, and the UI says what happened.
4. `failClosed` becomes a real per-device setting rather than the inert field Plan 51 left behind.

## 2. Non-goals

- **Android always-on VPN / lockdown.** Still gated on Plan 51 §5.1, which is unverified. §3.3 explains why this plan does not need it.
- Cutting Wi-Fi as a fallback (§3.3 weighs it and rejects it).
- Rotating or replacing an upstream that keeps failing — detect, report, recover the *same* route; the operator decides the rest.
- The remaining `skip` checks (`geo`, `dns`, `leak`) — Plan 51 §5.3/§5.7.

## 3. Context and design decisions

### 3.1 Hold the tunnel closed instead of tearing it down

The fix is one callback. `DeadMansSwitch { RouteVpnService.stop(this) }` becomes a call that stops the *forwarding* while leaving the `VpnService` established with `0.0.0.0/0 → tun0`. Packets keep entering the TUN and go nowhere.

That is fail-closed with no Android API, no reboot, no device-owner, and no `@hide` behaviour — the interface we already own simply stops moving bytes. It is also strictly better than the alternatives considered below, because there is no window at all: the tunnel never stops being the default route, so there is no moment in which traffic can escape.

The same reasoning applies to every other path that currently tears down on failure: an upstream that stops answering, a tunnel thread that dies. Failure should mean *closed*, not *open*.

### 3.2 Recovery has to actually apply

`restoreDeviceRoute` becomes: probe; if the device reports a route already up, leave it alone and record that; if it reports none and the stored config is enabled, **apply it**. That is what Plan 52 §3.2 asked for.

The reason the original rule said "probe first" was to avoid resurrecting a route whose upstream had since expired, producing a device that looks routed and carries nothing. That concern is now covered from the other side: Plan 51's checks make a dead upstream visible as `upstream: fail`, so applying and failing is diagnosable rather than silent. Probing first still matters — it avoids pointlessly re-applying a healthy route — but it can no longer be the whole behaviour.

**Bound it.** A device whose upstream is genuinely dead must not spin: retry with backoff, give up after a small number of attempts, and leave the route enabled with a check that says why. Silent infinite retry against a broken proxy is its own failure mode.

### 3.3 Why not Wi-Fi, and why not lockdown — yet

Cutting Wi-Fi when the route drops does work, and it was the operator's own suggestion. It is rejected as the primary mechanism for two reasons: it removes *all* connectivity, including adb-over-Wi-Fi, which can strand a wireless device beyond reach; and it is coarse — it punishes the device for a proxy's failure rather than simply refusing to leak. Keeping the TUN closed achieves the same protection without either cost.

Android's always-on + lockdown remains the strongest guarantee, because it survives the agent being killed and it survives a reboot — things §3.1 cannot promise, since a dead app takes its TUN with it. It stays out of scope only because its adb route is unverified (Plan 51 §5.1). When that gate is settled, lockdown becomes a *second* layer under this one, not a replacement.

State that limit honestly in the UI: this protects a live agent whose upstream failed; it does not protect against the agent being force-stopped.

## 4. Technical design

### 4.1 Agent: a held-closed state

`RouteVpnService` gains an explicit state rather than up/down:

| State | TUN | Forwarding | Meaning |
|---|---|---|---|
| `up` | established | running | working |
| `held` | **established** | stopped | fail-closed — traffic is being dropped on purpose |
| `down` | closed | — | no route configured |

`DeadMansSwitch`, a dead tunnel thread, and an upstream that stops answering all move `up → held`, never `up → down`. Only an explicit host instruction (`route.stop`) or the operator removing the route reaches `down`.

`route.status` reports the state, so the host can tell "not carrying traffic because it broke" from "not routed at all" — today both read `up: false`, which is why the UI cannot explain itself.

Add `held` to the status result and to `RouteStatusResultSchema`. Keep `up` for compatibility, computed as `state === 'up'`.

### 4.2 The host

`restoreDeviceRoute` per §3.2: probe → apply when the device reports no route and the config is enabled → bounded retry with backoff (suggest 3 attempts, 5s/20s/60s) → on exhaustion leave the route enabled and record a check explaining it.

The heartbeat gains the same recovery: a device that drops to `held` or `down` while enabled is a candidate for one recovery attempt, subject to the same bound. Do not let the heartbeat and the restore path retry independently — one owner, one counter.

`failClosed` (already in the schema, inert) becomes real: when true the agent is told to hold closed on failure; when false it may tear down, preserving today's behaviour for anyone debugging by hand. **Default it on for new routes** — the safe default is the one that does not leak — and say so in the UI.

### 4.3 What the operator sees

A `held` route is not healthy and must not look it: `tunnel: pass`, `upstream: fail`, and a plain sentence saying traffic is being blocked deliberately rather than leaking. The distinction between "blocked on purpose" and "broken" is the whole point of the state.

## 5. Implementation steps

**5.1 Agent state machine.** §4.1 in `RouteVpnService` — introduce `held`, stop forwarding without closing the TUN, and route every failure path to it. Verify the TUN survives by inspecting `ip addr show tun0` after forcing a failure.

**5.2 Dead-man's switch.** Point it at hold-closed rather than `stop()`. Update its doc comment — it currently describes the behaviour this plan reverses.

**5.3 Protocol.** `held` in the status result; `up` stays, derived. A test with a realistic `held` frame.

**5.4 Restore actually applies.** §4.2, with the bound and the backoff.

**5.5 Heartbeat recovery.** Same owner, same counter, no double retry.

**5.6 `failClosed` becomes real.** Wire the setting through to the agent; default on for new routes.

**5.7 Studio.** Render `held` as its own state with an honest sentence; make the default and its consequence legible where the route is configured.

**5.8 Smoke test.** Extend Plan 50: force an upstream failure and assert the device sends nothing **and** `tun0` still exists; then restore connectivity and assert the route recovers without UI interaction.

## 6. Acceptance criteria

1. Killing the upstream leaves the device unable to reach the internet — verified from the device, not inferred.
2. `tun0` still exists in that state; the route reads `held`, not `down`.
3. Pulling USB and reconnecting brings the route back with no human action.
4. Restarting the core does the same.
5. A permanently dead upstream stops retrying after the bound and says why; it does not spin.
6. A device that still has its route running is **not** re-applied — the log says it was probed and left alone.
7. `failClosed: false` preserves today's tear-down behaviour.
8. Studio distinguishes `held` from `down`, and neither reads as healthy.
9. `bun run typecheck` clean, `bun test` green, Plan 50's smoke test passes with the new stages.

## 7. Test plan

**Unit** — the state machine's transitions, especially that no failure path reaches `down`; restore decision table including the retry bound; `held` status parsing; health derivation with a `held` route (must not be `ok`).

**Device** — force an upstream failure and confirm from the device that nothing gets out while `tun0` remains; pull and re-attach USB and confirm unattended recovery; restart the core and confirm the same; point at a dead upstream and confirm the retry bound holds.

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| A held route looks like a working one | §4.3 — `upstream: fail` and explicit copy; health can never be `ok` while held |
| Recovery masks a genuinely broken upstream | Bounded retries, then a check that names the failure |
| Held-closed is mistaken for full protection | The UI states the limit: it protects a live agent, not a force-stopped one |
| The agent is killed and the TUN dies with it | Acknowledged and out of scope; Android lockdown is the answer, gated on Plan 51 §5.1 |
| Two retry loops fight | One owner, one counter (§4.2) |

## 9. Open questions

1. Should `held` expire? A device held closed for hours with a dead proxy is protected but useless — at some point an operator wants to be told rather than left with a quiet brick.
2. Should the bound reset when the device reconnects, or persist across reconnects? Resetting is friendlier and risks a reconnect loop hiding a permanent failure.
3. Does a held route still count as "routed" for fleet filters and counts? It is not leaking, but it is not working either.
