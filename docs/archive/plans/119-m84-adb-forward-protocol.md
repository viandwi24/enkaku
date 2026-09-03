# Plan 119 — M84 : the `forward` trio, off the process-spawn path

> Status: implemented — 119.1-119.5 all done. One gap named per acceptance criterion 5: `forward`'s and `killForward`'s SUCCESS wire shape (§4.1) is inferred by analogy, not independently verified against a real device — no device was attached when 119.1 ran. `listForward`'s empty-body case and all three FAIL cases were verified live; the per-serial ADD/LIST-with-entries success shapes were not. See the doc comments on `forward`/`listForward`/`killForward` in `packages/adb/src/client.ts` for the exact evidence each shape rests on.
> Depends on: plan 118 (M83) — §9 Q4 named this exact gap (`guest-agent/launcher.ts`'s `hello()` spawning 3 `adb.exe` processes per device reconnect purely for a liveness probe) as the strongest performance finding of that plan's audit, sized beyond one audit step. This plan is that follow-up, not a reopening of 118 — 118's own status stays as it shipped. §9 Q4 is now closed, pointing here.
> Spec references: §7.9 (network layer), §7.10 (guest agent), §11.3 (crash containment)
> Ships: packages/adb/src/client.ts

`forward`/`listForward`/`killForward` + `parseListForwardBlock`, covered by a fake-adb-server suite in `client.test.ts`. Also touched: both launchers (`packages/drivers/src/network/guest-agent/launcher.ts`, `packages/drivers/src/inspector/ui-server/launcher.ts`), swapped off `adb.exe` spawns for the forward/list/remove trio, and the dependency threading this required across `packages/core/src/daemon.ts`, `packages/core/src/api/guest-agent.ts`, `packages/core/src/device/agent-provisioner.ts`, `packages/session/src/inspector-factory.ts`, `packages/core/src/device/preparation/ui-server-component.ts`, and `packages/node/src/hosts.ts`.

---

## 0. Evidence

### 0.1 Where this comes from

The owner's own words, after plan 118 shipped: *"biar ga bikin trafficnya macet, karena ketika saya test tadi tiba tiba adb dan remote device jadi lemot saya gatau kenapa... siapa tau ada yang bisa kita efisien dan optimisasikan."* Plan 118 §4.4's audit already found the concrete mechanism this describes: `packages/core/src/device/preparation` → `agentProvisioner.ensure()` runs on every `onDeviceReady` (admission AND every reconnect) whenever `guestAgent.provision` is `'auto'` — the default — and unconditionally calls `hello()`. `packages/core/src/api/guest-agent.ts`'s `withEphemeralSession` builds a fresh session, uses it, and closes it again for a route-less device (the common case, since the network layer defaults to `none`), and `hello()`'s own path through `guest-agent/launcher.ts`'s `forward()`/`removeForward()` spawns `adb.exe` three separate times (`forward`, `forward --list`, `forward --remove`) to do it. A burst of reconnects — the exact shape of what happens after an adb-server hiccup or a USB re-enumeration — multiplies this into dozens of process spawns in a short window, and process creation is measurably more expensive on Windows than POSIX `fork`/`exec`.

### 0.2 What was verified live, against a real adb server, before this plan committed to a design

Measured against the dev machine's own running adb server (`127.0.0.1:5037`), using `packages/adb/src/socket.ts`'s own `AdbSocket` class — not assumed from memory, not copied from documentation unread:

```
host:list-forward        → OKAY, body "" (no forwards active) — a real, recognised host: service
host:killforward:tcp:19999            → FAIL, empty reason (no such forward — same as `adb forward --remove` on a nonexistent one)
host-serial:X:forward:tcp:A;tcp:B     → FAIL, empty reason (no such device X — correctly rejected, not "unknown command")
host:killforward-all                  → OKAY, no body at all — an ACTION reply, not a query reply
```

Two things this settles: (1) these `host:`-prefixed forward-management services are real and already implemented by the adb server this farm already talks to — not a protocol this plan would be inventing; (2) **response shape is not uniform** — `host:version`-style calls are `OKAY` + a length-prefixed body, but `host:killforward-all` is bare `OKAY` with nothing following. `packages/adb/src/client.ts`'s new methods (§4.1) must not assume every `OKAY` is followed by a block, and must be told which shape each new service uses rather than guessing.

**Not verified live**: the ADD (`host-serial:<serial>:forward:<local>;<remote>`) and LIST-with-entries response format, because no device was attached to this dev machine at the time. `list-forward`'s per-line format is inferred from `packages/drivers/src/network/guest-agent/launcher.ts`'s EXISTING parsing of `adb forward --list`'s plain-text CLI output (`line.trim().split(/\s+/)` → `[serial, local, remote]`) — the CLI's own `--list` output is itself a thin formatter over this exact host: service, so the two should agree, but "should" is not "measured, on this repo's own evidence standard." **Step 119.1 verifies both against a real device before anything downstream depends on the shape being right** — this plan does not skip the discipline plan 117/118 both used just because no phone happened to be plugged in during the owner's own research pass.

### 0.3 Why this is a protocol extension, not a session-lifecycle redesign

Plan 118 §4.4 named two independent angles for this same finding: extending the client protocol (this plan), or changing `withEphemeralSession`'s open-then-immediately-close lifecycle. This plan takes the FIRST one only. Reasoning: a protocol extension is a same-behavior, cheaper-mechanism swap — the three commands `hello()` already issues keep meaning exactly what they mean today, just without a process spawn each. A session-lifecycle change alters WHEN sessions open and close, which touches concurrency assumptions this plan's author has not audited and is a materially bigger, riskier change for the same reported symptom. If the protocol swap alone does not resolve enough of the "sudden lag," a lifecycle change is a legitimate follow-up — not folded in here.

---

## 1. Goals

1. `packages/adb/src/client.ts` gains `forward`, `listForward`, and `killForward` methods that talk to the adb server directly over the existing `host:`-protocol socket — no `Bun.spawn` of `adb.exe` for any of the three.
2. `packages/drivers/src/network/guest-agent/launcher.ts`'s `forward()`/`removeForward()` (the ones `hello()` calls on every reconnect) use the new client methods instead of `hostAdb.run(...)`.
3. `packages/drivers/src/inspector/ui-server/launcher.ts`'s `forward()`/`removeForward()` — the OTHER call site plan 118 §4.4 flagged as the same "candidate for one" — get the same swap, since it is the identical trio for the identical reason.
4. The existing safety property (`forward()` verifies the resulting mapping actually belongs to the device that asked for it, refusing a stolen/rebound port — plan 44 §4.4) is preserved exactly, not weakened for the sake of the swap.

## 2. Non-goals

- `withEphemeralSession`'s open-close lifecycle (§0.3) — a separate, larger follow-up if this alone is not enough.
- Any OTHER `hostAdb.run(...)` call site plan 118 §4.4 already marked "no lightweight alternative exists" (`adb reverse`, `tcpip`, install/uninstall) — none of those have a `host:`-protocol equivalent and this plan does not re-litigate that finding.
- Detecting or warning about a second adb consumer on the shared port (plan 118 §9 Q1) — unrelated to this plan's mechanism.

---

## 3. Context and design decisions

### 3.1 One client method per verified wire shape, not a generic "run a host: command"

`client.ts`'s existing methods (`version()`, `listDevices()`, `reconnectOffline()`) are each a small, named, single-purpose method — not a generic `hostCommand(cmd: string)` escape hatch. This plan keeps that shape: `forward()`, `listForward()`, `killForward()` are three named methods, each knowing its OWN response shape (§0.2's finding that this is NOT uniform is exactly why a generic helper would be the wrong abstraction here — it would have to take a "does this one have a body" flag, which is just three methods wearing a trench coat).

### 3.2 `forward`/`killForward` need a serial; `client.ts` is currently host-wide

Every existing `client.ts` method operates on the adb server generally (`version`) or already takes a serial where the protocol needs one (check `tcpip`'s own signature for the established pattern — read it before writing the new methods, so the parameter shape matches house style exactly rather than inventing a new convention).

---

## 4. Technical design

### 4.1 `packages/adb/src/client.ts` — three new methods

```ts
/** host-serial:<serial>:forward:<local>;<remote> — OKAY with no body (verified live, §0.2). */
async forward(serial: string, local: string, remote: string): Promise<void>

/** host:list-forward — OKAY + a length-prefixed body, one "serial local remote" line per active forward (verified live for the empty case; format for non-empty verified in step 119.1 against a real device before this ships). */
async listForward(): Promise<{ serial: string; local: string; remote: string }[]>

/** host-serial:<serial>:killforward:<local> — OKAY with no body (verified live for host:killforward-all's bare-OKAY shape; the per-serial/per-local form's exact shape is step 119.1's to confirm before this ships, since only the ALL and the generic no-such-forward forms were reachable without a device). */
async killForward(serial: string, local: string): Promise<void>
```

A FAIL response for any of the three throws `AdbError('E_ADB_FAIL', <reason>)`, matching every existing method's error shape — `readStatus()` already does this uniformly (§0.2's own repro used it unmodified).

### 4.2 The two launcher call sites

`guest-agent/launcher.ts`'s `forward(localPort)`:
```ts
await client.forward(deps.serial, `tcp:${localPort}`, `localabstract:${GUEST_AGENT_SOCKET}`)
const list = await client.listForward()
const owner = list.find((f) => f.local === `tcp:${localPort}`)
if (!owner || owner.serial !== deps.serial) {
  throw new Error(`tcp:${localPort} is bound to ${owner?.serial ?? 'nothing'}, not to ${deps.serial} — refusing to drive another device's guest agent`)
}
```
Same ownership-verification property as today, same error message shape — only the mechanism underneath changed. `removeForward` becomes `client.killForward(deps.serial, \`tcp:${localPort}\`).catch(() => undefined)`, matching the existing tolerate-failure behaviour exactly (a remove that fails because the forward is already gone is not an error worth surfacing, today or after this plan).

`ui-server/launcher.ts`'s equivalent pair gets the identical treatment — it is described in plan 118 §4.4 as "copied verbatim... per plan 44 §4.4" from the same origin as the guest-agent one, so the swap is symmetric.

Both launchers need a way to reach an `AdbClient` instance (or the specific three methods) — check how `deps.hostAdb` is currently threaded into each launcher's deps and add the client alongside it, following the existing dependency-injection shape rather than reaching for a module-level singleton.

---

## 5. Implementation steps

**119.1 — verify the unverified wire shapes against a real device, then build `client.ts`'s three methods.** Check `adb devices` for a real attached device first; if one exists, exercise `host-serial:<serial>:forward:tcp:<free-port>;tcp:<free-port>`, then `host:list-forward` (confirm the per-line format), then `host-serial:<serial>:killforward:tcp:<port>` and `host:killforward:tcp:<port>`, exactly as §0.2 did for the shapes that WERE reachable without one — write down what was found, the same evidence-first discipline. If no device is available in this environment either, build the three methods from §0.2's confirmed shapes plus the CLI-output-derived list format, and say so plainly in the report rather than silently treating it as verified. Then implement `forward`/`listForward`/`killForward` in `client.ts`, matching the existing method style (read `tcpip()` first for the closest existing precedent of a serial-scoped method). *Result:* three new, independently testable client methods, each backed by either a live-verified wire shape or an explicitly flagged inference. **DONE** — no device was attached in this environment either (`adb devices` returned empty), so `forward`/`killForward` ship with their SUCCESS shape inferred by analogy with `host:killforward-all`'s live-verified bare-OKAY reply, and `listForward`'s per-line parse is inferred from the CLI-output-derived format; the gap is named in-line in each method's doc comment in `client.ts`, per acceptance criterion 5, not silently treated as closed.

**119.2 — a fake-adb-server test suite for the three new methods.** Following `client.test.ts`'s own established pattern (`describe('AdbClient.listDevices — host:devices-l ...')` et al., built on `Bun.listen` — no real hardware). Cover: a successful forward, a successful list with one and with multiple entries, a successful killForward, and a FAIL response for each (reusing whatever `readStatus`'s FAIL-with-empty-reason shape §0.2 measured). *Result:* the three methods are proven correct without needing a phone attached to CI or to a future contributor's machine. **DONE** — 9 new tests via a `fakeForwardServer` (`Bun.listen`-based), including two tests specifically proving the asymmetric response-shape handling (bare-OKAY vs OKAY+body) is correct.

**119.3 — swap `guest-agent/launcher.ts`.** Per §4.2. The existing ownership-verification safety check is preserved, not weakened. *Result:* `hello()`'s reconnect path no longer spawns `adb.exe` at all for its forward/list/remove trio. **DONE** — `forward()`/`removeForward()` now call `deps.adb.forward`/`listForward`/`killForward`. `GuestAgentLauncherDeps` gained an `adb: Pick<AdbClient, 'forward' | 'listForward' | 'killForward'>` field; since `AdbClient` is not constructed until partway through `daemon.ts`'s `start()` (well after both `createGuestAgentRoutes` and `createAgentProvisioner` are built), the dep is threaded as a lazy, `E_ADB_UNAVAILABLE`-throwing facade (`guestAgentAdbForward`) built beside the existing `guestAgentExec` closure, the same "reads the outer `adb` fresh, not ready yet ⇒ coded refusal" pattern that closure already uses — not a module-level singleton. `GuestAgentRoutesDeps` (`packages/core/src/api/guest-agent.ts`) and `AgentProvisionerDeps` (`packages/core/src/device/agent-provisioner.ts`) both gained the same `adb` field and pass it straight through to `createGuestAgentLauncher`. The ownership-refusal test already existed (`launcher.test.ts`'s "throws when `forward --list` names a different serial as owner") and was re-pointed at the new `adb.listForward` mock rather than `hostAdb`'s CLI text; a companion assertion (`hostAdbCalls` has length 0 after `forward()`) was added to the happy-path test for acceptance criterion 3.

**119.4 — swap `ui-server/launcher.ts`.** Per §4.2, symmetric to 119.3. *Result:* the inspector's own forward lifecycle gets the same reduction. **DONE** — `UiServerLauncherDeps` gained `forward`/`listForward`/`killForward` as three separate function fields (not one `Pick<AdbClient,...>` object, a deliberate difference from 119.3's approach, since this launcher's constructor already takes individual function deps rather than a client object); the ownership-check message and failure-tolerance are preserved byte-for-byte. Threaded through `InspectorFactoryDeps` (`packages/session/src/inspector-factory.ts`), `daemon.ts` (bound directly to the already-in-scope `adbClient` alias), a second, previously-unnoticed call site in `packages/core/src/device/preparation/ui-server-component.ts` (given throwing stubs, following that file's existing idiom for its proven-unreachable `execStream` field), and the remote node's own `AdbClient` in `packages/node/src/hosts.ts`.

**119.5 — documentation.** This plan's `> Status:`/`Ships:` updated; plan 118 §9 Q4 marked closed, pointing here. **DONE.**

---

## 6. Acceptance criteria

1. `client.ts`'s three new methods are each covered by a fake-server test (success and FAIL), with no real device required to run the suite.
2. `guest-agent/launcher.ts`'s `forward()` still refuses a stolen/rebound port with the same named error — asserted by a test, not merely preserved by inspection.
3. Neither launcher's `forward()`/`removeForward()` calls `hostAdb.run(...)`/spawns `adb.exe` any longer — asserted by a grep-style test or by construction (the dependency is removed from what the launcher is given), not merely by reading the diff.
4. `bun run typecheck` is clean; every touched file's own test file passes, run scoped and sequential (CLAUDE.md's hard rule — never a bare full-suite run, never two invocations at once).
5. If 119.1 could not verify the ADD/LIST-with-entries shape against a real device, that gap is named explicitly in the plan's own status line, not silently treated as closed.

## 7. Test plan

- 119.1/119.2: `packages/adb/src/client.test.ts`, extended with the three new describe blocks, fake-server-backed.
- 119.3: `packages/drivers/src/network/guest-agent/launcher.test.ts` — the existing ownership-check test (if one exists) re-pointed at the new mechanism; a new one added if it doesn't.
- 119.4: `packages/drivers/src/inspector/ui-server/launcher.test.ts`, same treatment.

Every run scoped to the file(s) touched, sequential, never a bare `bun test`.

---

## 8. Risks

| Risk | Mitigation |
|---|---|
| The live-verified shapes (§0.2) don't generalise to the ADD/LIST-with-entries case, discovered only once a device is available | 119.1 is explicitly gated on checking for a device first and naming the gap if none is available — no method ships on an unverified assumption dressed as a verified one |
| The ownership-verification safety check (stolen/rebound port) gets subtly weakened in the swap | 119.3's own acceptance criterion (§6.2) requires a test asserting the refusal still fires, not just a read-through of the diff |
| A device farm with adb server versions old enough to lack one of these host: services | Not investigated in this plan — if it becomes a real report, the existing spawn-based path is the natural fallback, not something this plan needs to design preemptively for a farm the owner has not reported having |

## 9. Open questions

1. Should `withEphemeralSession`'s lifecycle change (§0.3, deferred here) be its own future plan once this one's real-world effect is measured? Proposed: yes, only if the owner still reports lag after this ships — no sense designing a bigger change against a symptom this smaller one may already resolve.
