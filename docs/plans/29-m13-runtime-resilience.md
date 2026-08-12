# Plan 29 — M13 : Runtime Resilience and Single-Owner Guarantees

> **STATUS: DRAFT — NEEDS DISCUSSION. DO NOT EXECUTE.**
>
> This document captures a debugging session and a set of proposals. The design
> is **not settled**: §9 lists decisions that a human must make first. An agent
> builder must not implement any part of this plan until the status line above
> says `ready`. If you were told to "work the plans in order", skip this one.
>
> Depends on: Plans 17–21 complete. Independent of the M12 series (Plans 22–28).
> Spec references: §7.2 (app data paths), §10.3 (claim atomicity), §10.4 (adb serialisation), §16 (NFR).
> Ships: none — blocked draft, not executed; nothing is built until the status line above says `ready`.

---

## 1. Goals

*Provisional — subject to the decisions in §9.*

- Two cores can never share one data directory, and the second one says so clearly instead of quietly fighting the first for the same phones.
- A core does not inherit `adb forward` entries left behind by processes that no longer exist.
- A stream that dies for a transient reason recovers by itself, a bounded number of times, before the interface gives up and says so.
- An operator can recover one misbehaving device from the UI without touching any other device or any other tool on the machine.

## 2. Non-goals

- **Restarting the adb server.** Explicitly rejected, permanently — see §3.5.
- Multi-core coordination or clustering of cores. One core owns a data directory; that is the model.
- Recovering from a physically unplugged device beyond what the registry already does.
- Anything in Plans 17–21. Those are complete; this plan only hardens what surrounds them.

## 3. Context: what actually happened

This plan exists because a single afternoon of manual testing produced three distinct failures that all looked identical from the browser (`the scrcpy session ended: socket closed`, or a wake-up panel stuck for ever on *Waiting for the first frame*). Recording the evidence matters more than the proposals, because the proposals may change and the evidence will not.

### 3.1 Already fixed — do not re-implement

These landed during the session and are **not** part of this plan's work:

| Defect | Fix | Guarded by |
|---|---|---|
| Nothing subscribed to `ScrcpySession.onClose`, so a dead session stayed in the manager's cache and served zero frames to every later viewer, silently. | `session.ts` subscribes and routes to `onDisplayError`. | — |
| `SessionManager.acquire` had no in-flight guard: concurrent `stream.start` messages each built a session, orphaning the earlier ones. Measured: three `session opened` lines in 350 ms for one device. | `inFlight: Map<deviceId, Promise<Entry>>`; every caller attaches to one creation. | `packages/session/src/manager.test.ts` — verified to fail when the guard is disabled |
| An orphaned or closing session's late `onDisplayError` tore down whichever entry was current, killing a healthy replacement. | Ownership check against the published session. | same file |
| `RESET_VIDEO` sent on `stream.start` killed the scrcpy server outright. Measured on a moto g06 power: **0 packets and a closed socket with it, 143 packets in five seconds without it.** The identical message 3.8 s later is harmless (+1.36 MB, server logs `Video capture reset` and continues). | Only requested when a cached keyframe proves the encoder has already produced output. | **not yet tested** — see §9.5 |
| The scrcpy server's exit reason was logged at `debug`, so a server that died left no trace at the default level. | Raised to `warn`. | — |

### 3.2 The failure that was not a code defect at all

After all of the above, manual testing still failed identically. The cause was environmental:

- Two compiled `./enkaku` binaries had been running since 00:00, launched from a **previous Claude Code session's scratchpad** (`.../ded2c64f-.../scratchpad/release-test` and `artifact-test`) during portable-binary smoke tests, and never cleaned up. Each held a live connection to the adb server for 16.5 hours.
- A sub-agent's smoke-test core on `:7801` was running concurrently against the same two phones.
- 27 stale `adb forward` entries had accumulated across the day.

A host TCP port maps to exactly one device, and a device's scrcpy socket belongs to whichever process forwarded it last. Several cores against two phones is therefore not "a bit slower" — it is silent, undebuggable cross-talk. This wasted the majority of the session, and neither the product nor the logs said anything about it.

### 3.3 Why a data-directory lock is the highest-value item

Every one of the environmental failures reduces to *more than one core owning the same devices*. The data directory is the natural ownership token: it already holds the database, the toolchain, and the artifacts, and a second core opening the same SQLite file is already wrong for reasons unrelated to adb.

A lock turns a silent, day-long confusion into a one-line refusal at startup.

### 3.4 Why stale forwards must be swept

`adb forward` entries outlive the process that created them. After a crash or a `kill -9` they point at `localabstract` sockets of servers that no longer exist. They are harmless individually and corrosive in bulk: they exhaust the port allocator's assumptions, they make `adb forward --list` unreadable during debugging, and one of them re-bound to a different device is exactly the cross-talk described above.

Sweeping is safe **only** for forwards this product owns. The socket names are recognisable (`localabstract:scrcpy_<scid>`, and the ui-server's device port). Anything else on the adb server belongs to another tool and must be left alone.

### 3.5 Restarting the adb server: rejected, permanently

The request that prompted this plan included "provide a system to restart adb". The answer is no, and it should stay recorded as no.

`adb kill-server` terminates the server on port 5037, which is shared by every adb client on the machine — Android Studio, other terminals, other tools. Killing it disconnects all of them. Spec §10.4 and the repo conventions already forbid it outside the Toolchain Manager's adb version swap, which is the one place a swap is unavoidable and the user has explicitly asked for it.

The legitimate need behind the request — "this one device is wedged, get it back" — is served by `adb reconnect <serial>`, which affects exactly one device and no other client. That is §4.4.

## 4. Proposed design

*Provisional. Read §9 before building any of it.*

### 4.1 Data directory lock

At startup, before opening the database, acquire an exclusive lock on `<dataDir>/enkaku.lock` containing the pid and start time. Release on clean shutdown.

- A live holder → refuse to start with `E_DATA_DIR_IN_USE`, naming the pid and the directory. Not a warning; the process exits.
- A stale file whose pid no longer exists → take it over and log that it did so.
- A stale file whose pid exists but is a *different* program (pid reuse) → same as stale.

Open: whether an escape hatch is offered at all (§9.1).

### 4.2 Stale forward sweep at startup

After the adb subsystem is ready, list forwards and remove those that match this product's socket-name patterns **and** whose target socket no longer exists on the device. Log one summary line, never one per entry.

Open: whether "no longer exists on the device" is worth checking, or whether owning the name is enough (§9.2).

### 4.3 Bounded session auto-recovery

When a session dies from a display error, attempt to rebuild it at most N times with a backoff before surfacing `stream.ended` to viewers. Never retry a device the operator deliberately put to sleep.

Open: N, the backoff, and how "deliberately asleep" is distinguished from "died" (§9.3). This is the item most likely to do harm if guessed at — an unbounded or over-eager retry loop wakes a phone every few seconds forever.

### 4.4 Per-device reconnect action

`POST /api/devices/:id/reconnect` → `adb reconnect <serial>`, then re-probe. Surfaced on the device page. Never `adb reconnect offline` (that touches every device) and never `kill-server`.

## 5. Implementation steps

**Deliberately not written.** Steps get written once §9 is answered; writing them now would invite an agent to build a design that has not been agreed.

## 6. Acceptance criteria

**Deliberately not written.** See §5.

## 7. Test plan

Two regression tests are owed regardless of what this plan becomes, because both defects they cover shipped and were caught by hand:

1. `RESET_VIDEO` is not sent to a session that has produced no keyframe yet (§3.1, currently untested — the reason it is untested is that the WS handler needs roughly nine fakes to drive; extracting the decision into a pure function first is the cheaper route).
2. The startup path refuses a second core on the same data directory — once §9.1 is decided.

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| A lock file left by a hard kill locks the user out of their own farm. | Take over a lock whose pid is dead; that is the common case after `kill -9`. Never require manual file deletion as the normal path. |
| The forward sweep removes an entry belonging to another tool. | Match only this product's own socket-name patterns. When in doubt, leave it. |
| Auto-recovery fights a user who is deliberately putting a device to sleep. | Bounded attempts, and it stays off by default until §9.3 is decided. |
| Adding a "reconnect" button teaches users to reach for restarts instead of reporting bugs. | The button's copy states exactly what it does and what it does not touch. |

## 9. Open questions — must be answered before this plan can be executed

1. **Lock escape hatch.** Should `ENKAKU_FORCE_UNLOCK=1` (or similar) exist for the case where the holder is alive but wedged? It is convenient and it is also exactly how someone ends up running two cores on purpose. Proposal: no escape hatch; kill the other process instead.
2. **Sweep aggressiveness.** Remove every forward matching our socket patterns at startup, or only those whose device-side socket is gone? The first is simple and could disturb a *legitimately running* second core — which §4.1 is supposed to make impossible anyway. Decide §4.1 first.
3. **Auto-recovery policy.** How many attempts, what backoff, and what signal distinguishes "the device was put to sleep on purpose" from "the session died"? Without a crisp answer this feature should not be built at all.
4. **Scope of the reconnect action.** Device page only, or also a bulk action on the devices list? Bulk reconnect is one click away from "reconnect everything", which is close to the behaviour §3.5 rejects.
5. **Testing the `RESET_VIDEO` gate.** Extract the decision into a pure, exported function so it can be tested directly, or build the nine WS-handler fakes? The first is cheaper; the second tests the real path. Recommendation: extract, and note in the code that the extraction exists for testability.
6. **Does any of this belong in the spec?** The single-owner rule (§3.3) is arguably a product invariant, not an implementation detail. If so, `docs/spec.md` should say it and this plan should reference it rather than invent it.
