# Plan 123 — M88 : `direct` egress binding — probe the capability, never guess the platform

> Status: implemented — 123.1–123.5 all land. The bind decision is now measured once per boot (`bindIsEffective()`, `service/bind-probe.ts`) rather than guessed from `process.platform`; `createUpstream` takes the existing `gost` hop, on any platform, whenever the probe finds the bind ineffective and `gost` is reachable, and raises the precondition `E_PROXY_BIND_INEFFECTIVE` when it is not. **Operational consequence, stated plainly rather than left for someone to discover on a live farm**: `gost` provisioning is still Windows-only by construction (`gost-provision.ts` refuses every other platform by name, unchanged by this plan). So on Linux and macOS, every `direct` record with a non-empty `bindAddress` whose bind the probe finds ineffective — which §0 measured is the case on every platform tested — now **refuses to start**, naming `E_PROXY_BIND_INEFFECTIVE` and the §6 workaround, instead of silently mis-egressing the way it did before this plan. That is correct and intended (§3.3: a loud, recoverable refusal beats a silent wrong answer), but it is an immediate, visible change on any Linux/macOS farm already running `direct` records with a bind — including the owner's own 45-modem farm this plan was opened from. §9 Q4, whether to widen `gost` provisioning to Linux/macOS so the refusal is followed by a working alternative rather than only a documented one, is deliberately left open here for the owner to decide.
> Depends on: plan 117 (M82) — which built `direct`/`bindAddress` and, in §12, recorded the `localAddress` failure as a **Windows** finding, gating the `gost` workaround on `process.platform === 'win32'`. That gate is the bug this plan fixes; the `gost` mechanism behind it is correct and is reused untouched. Plan 121 (M86) for `E_PROXY_*` problem-code vocabulary and the precondition-vs-refusal distinction.
> Spec references: none directly — `proxy-manager` is a plugin, outside spec.md's core surface (same note plans 117 and 121 carry).
> Ships: plugins/proxy-manager/src/service/bind-probe.ts

Also touched: `plugins/proxy-manager/src/service/upstream.ts` (the measured gate), `plugins/proxy-manager/src/shared.ts` (`E_PROXY_BIND_INEFFECTIVE` in `PROXY_PROBLEM_CODES`), `plugins/proxy-manager/src/service/errors.ts` (the same code in the dialler's own vocabulary), `plugins/proxy-manager/src/service/supervisor.ts` (the precondition re-check), `plugins/proxy-manager/src/service/logbook.ts` and `service/listener.ts` (`egressAddress`, the `bind-mismatch` warning), `plugins/proxy-manager/src/service/dial-direct.ts` and `plugins/proxy-manager/src/ui/parts/upstream-fields.tsx` (the `E_PROXY_DNS_EGRESS_FAILED` hint and field description, step 123.5), plus the doc updates step 123.5 made: `docs/feat/plugin-proxy-manager.md` §8, `docs/plans/117-m82-egress-binding.md` §12, and `docs/plans/00-overview.md` §9.

`net.connect({ localAddress })` is silently ignored by Bun on **every platform tested, not just Windows**. Every `direct` record with a `bindAddress` therefore egresses from the host's default address while reporting `running`, logging `upstream-connected`, and serving traffic normally. Nothing in the product says otherwise.

---

## 0. Evidence

### 0.1 The field report

From the owner's own 45-modem farm, 2026-08-21 (`refs/tmp-bug-proxy-mikrotik.md`), pack version 0.9.0, Ubuntu 24.04, Enkaku from a binary release with the bundled Bun. A record with `bindAddress: 192.168.50.11` egressed from the office link (`118.99.123.20`) instead of that modem (`114.5.110.42`), while `curl --interface 192.168.50.11` from the same host in the same second egressed correctly.

The decisive measurement in that report is a packet capture on the router port facing the host: **zero packets**. That rules out every router-side explanation at once — the routing rule, the routing table, the NAT rule, rule ordering. The connection never left through that interface, so its source address was never `192.168.50.11`. The bind is not being applied at the socket.

### 0.2 Reproduced here, and it is broader than the report claims

Run on this machine before accepting the report's diagnosis — **macOS 15 (darwin), Bun 1.3.14** (revision `0d9b296af33f2b851fcbf4df3e9ec89751734ba4`), an ordinary `node:net` client and a `net.createServer` listener, with the **server's** view of `remoteAddress` as ground truth for the source address:

| Case | asked `localAddress` | `socket.localAddress` at `connect` | server saw source |
|---|---|---|---|
| dest LAN, bind that same LAN addr | `192.168.193.117` | `192.168.193.117` | `192.168.193.117` |
| dest **loopback**, bind LAN addr | `192.168.193.117` | `127.0.0.1` | `127.0.0.1` |
| dest LAN, bind **loopback** | `127.0.0.1` | `192.168.193.117` | `192.168.193.117` |
| dest loopback, bind **`10.99.99.99`** — an address this host does not hold | `10.99.99.99` | `127.0.0.1` | `127.0.0.1` |

Two conclusions, and the second is the one that settles it:

1. **The two mismatch rows show the option being ignored outright** — asked for LAN, got loopback; asked for loopback, got LAN. The kernel picked a source by route, as if no bind had been requested.
2. **The bogus-address row is the smoking gun.** A real `bind()` to an address the host does not own **always** fails with `EADDRNOTAVAIL` — that is not platform-specific, it is what the syscall does. It did not fail. It connected, from `127.0.0.1`. **So `bind()` is never being called at all**; the option is dropped before it reaches the syscall.

This is macOS. The report is Linux. Plan 117 §12 recorded Windows. `process.platform === 'win32'` is therefore not a narrow gate — it is the wrong *kind* of gate: it encodes a guess about where the bug lives instead of a check of whether the bind works.

### 0.3 A correction to the report's own proposal, found by testing it

`refs/tmp-bug-proxy-mikrotik.md` §5.2 proposes probing by comparing `socket.localAddress` to the requested address. A first pass here read that property **after close** and found it empty, which looked like the proposal was unimplementable. That was a measurement error, not a finding: read inside the `connect` event, while the socket is live, **`socket.localAddress` is populated and accurate** — it matched the server's independent view in all four rows above, including both mismatches. The report's proposal is sound. Recorded because the wrong conclusion was reached first and the correction is the useful part.

### 0.4 Why nothing caught this

Straight from the report's §2.2, all three confirmed against the code:

- `dial-direct.ts` never reads `socket.localAddress`, so the process cannot tell a correctly-bound socket from a wrongly-bound one.
- The egress probe (`service/probe.ts`) dials **through the record's own `Upstream`** — exactly the right design — but with `ENKAKU_NETWORK_PROBE_URL` unset it returns the `skip` shape *without dialling*. On this farm it was unset, so every record read `unverified` and the mismatch was never measured. (Plan 121 §4.2 leans on this same skip shape for failover confirmation, which is worth re-reading in this light — §9 Q2.)
- No log line records the observed egress address, so a correct-looking log is fully compatible with a wrong egress.

Net effect, in the report's own words: *"a 45-record pool could be built, started and assigned, with every record egressing from the same address, and the product would report success throughout."*

## 1. Goals

1. Decide whether to use the native bind or the `gost` hop **per host, by measurement**, never by platform name.
2. A record whose bind provably does not work and has no available workaround **does not start**, and says why.
3. The observed egress address is visible in the logs, so this class of failure is greppable rather than requiring a packet capture.
4. `E_PROXY_DNS_EGRESS_FAILED` tells an operator which of its two fixes applies.
5. A future Bun release that fixes `localAddress` is picked up automatically, leaving no permanent workaround behind.

## 2. Non-goals

- Changing the `gost` runtime, its provisioning, or its config generation (plan 117 §8). The mechanism is correct, tested and already provisioned; **only its gate is wrong.**
- Reporting the bug upstream to Bun. Worth doing, but it is not a change to this repo and must not block the fix.
- Making `resolveThroughEgress` work on a default-route-only path. That is topological, not a defect (§0.1's report §4 says so, and plan 117 §8 already recorded the same shape) — this plan only makes the existing knowledge reach the screen.
- Auditing every other `net.connect` in the workspace for the same assumption. Worth a follow-up sweep; named in §9 Q3 rather than silently folded in.
- Unit tests for Studio/plugin-UI code — standing owner instruction, carried forward.

## 3. Context and design decisions

### 3.1 The probe must make "honoured" and "ignored" produce different outcomes — which is harder than it looks

The obvious probe is the one that does not work: *bind to the record's own `bindAddress`, connect to a listener on that same address, compare*. If the bind is honoured the source is `bindAddress`; if it is ignored, the route to a **local** address selects that same local address anyway. Both paths produce the same answer, so the probe **false-passes** exactly on the hosts it exists to protect.

The discriminator that does work is the one §0.2's fourth row already demonstrated: **bind to an address the host does not hold.**

```
honoured → bind() fails → EADDRNOTAVAIL (or EINVAL) → the connect never happens
ignored  → the option is dropped → the connect succeeds normally
```

So the probe **passes when the connection fails**, which reads backwards and must be commented as such where it lives. It needs no internet — a loopback listener the plugin starts itself is enough — and no privileges.

The probe address comes from **RFC 5737 TEST-NET-1 (`192.0.2.0/24`)**, reserved for documentation and guaranteed unroutable, cross-checked against `os.networkInterfaces()` at probe time so that a host which somehow holds one still gets a correct answer rather than a false pass. Plan 119's own DNS tests already use this range for the same "guaranteed unassigned everywhere" reason.

### 3.2 Cached per boot, not per record

The answer cannot change without a restart — it is a property of the runtime, not of a record or an address. Probed once, lazily, on the first `direct` record that actually asks for a bind; cached for the process lifetime. A farm with 45 `direct` records pays for one probe, not 45.

### 3.3 Not starting is the correct behaviour, and this is the sharpest case for it

The pack's existing standard is that `unverified` is never worded as success (plan 117 §3.7). Here it is stronger: **a bridge whose bind does not work is not a degraded bridge, it is the wrong bridge.** It will faithfully carry a device's traffic out of an address the operator did not choose, for as long as nobody looks. Serving that silently is the one outcome that must not happen, so the row does not start.

`E_PROXY_BIND_INEFFECTIVE` is a **precondition**, not a refusal, by the pack's own definition: nothing about the record is wrong, and the fact can change (a runtime upgrade, a provisioned `gost`).

### 3.4 Observability is the cheap half, and would have caught this in minutes

Both changes in the report's §5.4 are correct and small. `socket.localAddress` is an address of the host itself — not a destination, not a credential — so it clears the pack's own log-field discipline. A `warn` **once per start** (not per connection) when the observed source differs from `bindAddress` is enough to be noticed and not enough to flood.

This matters beyond this bug: it is the difference between "a packet capture on the router proved it" and "grep the log".

## 4. Technical design

### 4.1 `bindIsEffective(): Promise<boolean>` — new, in `plugins/proxy-manager/src/service/`

Per §3.1: pick a TEST-NET-1 address this host does not hold, start a loopback listener, `net.connect({ host: '127.0.0.1', port, localAddress: probeAddr })`, and answer **`true` when the connect fails with an address error**, `false` when it succeeds. Bounded by a short timeout; every unexpected outcome (a different errno, a timeout) resolves `false` **only if that is the safe direction** — see §9 Q1, which asks whether an inconclusive probe should instead be a precondition of its own rather than silently choosing either branch.

Cached per process (§3.2), with the cache injectable/resettable for tests.

### 4.2 The gate in `createUpstream` (`service/upstream.ts`)

Today, from plan 117:

```
direct → win32 && bindAddress ? gost hop : native direct
```

Becomes, with the `gost` branch itself unchanged:

```
direct, no bindAddress            → native direct              (nothing to bind; unaffected)
direct, bindAddress, bind works   → native direct              (as today, now measured)
direct, bindAddress, bind broken,
        gost available            → gost hop, ON ANY PLATFORM  (the existing mechanism, new gate)
direct, bindAddress, bind broken,
        no gost available         → E_PROXY_BIND_INEFFECTIVE   (precondition; the record does not start)
```

`gost` provisioning is currently Windows-only by construction (`gost-provision.ts` refuses other platforms by name, and pins a `windows_amd64` artifact). **Making it available on Linux/macOS is a real, separate piece of work** — a per-platform artifact table with its own sha256 per build — and this plan must not pretend otherwise: see §5 step 123.3 and §9 Q4 for exactly how far this goes.

### 4.3 `E_PROXY_BIND_INEFFECTIVE`

A new entry in `PROXY_PROBLEM_CODES` (`shared.ts`), raised as a **precondition** so the record does not start. Its message names all three facts an operator needs: that the host does hold the address, that the runtime ignored the bind, and what to do (the §6 external-binder workaround, or a runtime upgrade). It must not read like the address is wrong — that is the wrong diagnosis and would send the operator to the router.

### 4.4 `egressAddress` on `upstream-connected`, plus a once-per-start warning

`listener.ts` already logs `upstream-connected` at the moment the dial resolves — the exact point where `socket.localAddress` is live and accurate (§0.3). Add it as a field. `logbook.test.ts`'s field allowlist is extended **deliberately**, as its own assertion, not incidentally.

Separately, on the first connection of a record whose observed source differs from its configured `bindAddress`, a single `warn` naming both. Once per start, per record.

### 4.5 `E_PROXY_DNS_EGRESS_FAILED` guidance

Attach a hint naming the two fixes, and state the condition in `resolveThroughEgress`'s own field description in the UI: *if the bind address's path carries only a default route, name a public resolver reachable through it, or turn this off — the lookup will then leave by a different path than the connection, which is worth knowing.* The trade-off is real and belongs to the operator; for most farm work leaving by a different path is fine, for anything geo-sensitive it is not.

## 5. Implementation steps

**123.1 — `bindIsEffective()` and its tests. DONE.** `src/service/bind-probe.ts` — `pickBindProbeAddress()` walks TEST-NET-1 `.1`→`.254`, skipping any address `os.networkInterfaces()` says this host already holds (so a host that owns one still gets a correct answer, never a false pass), and `probeOnce()` starts its own loopback listener and dials it with `localAddress: probeAddr`. `EADDRNOTAVAIL`/`EINVAL` ⇒ **`true`** (bind was attempted and rejected — the inversion §3.1 warns about, commented as such at the site); a successful connect from an address the host does not hold ⇒ **`false`**; anything else, including the 500 ms timeout, ⇒ `false`, taking §9 Q1's proposed safe direction. Cached per process behind one shared `Promise`, with `resetBindProbeCacheForTests()`.

**Measured on this runtime: `false`.** Bun 1.3.14 (`0d9b296af33f2b851fcbf4df3e9ec89751734ba4`), darwin — matching §0.2 exactly.

**The test is written so a future Bun fix does not read as a regression**, which §5's own wording asked for and is the subtlest part of this step: the primary test re-measures the discriminator *from scratch inside the test file* (not by calling the module under test) and asserts `bindIsEffective()` agrees with that live measurement. If Bun ever honours `localAddress`, both sides flip to `true` together and the test still passes. Today's observed `false` is recorded in a comment as documentation, never as a pinned contract. The worker also flagged honestly what it could **not** test: the "honoured ⇒ true" branch cannot be deterministically forced on a runtime that never calls `bind()`, because faking a raw socket error would mean faking the very thing under test — so the reality-comparison covers it, and the gap is stated rather than papered over.

Two deviations, both sound: a test-only `target?: {host, port}` seam on `BindProbeDeps` (never set in production, so the real probe always starts its own loopback listener and needs no internet), and `pickBindProbeAddress` exported so the address cross-check is unit-testable directly rather than only through network behaviour. *Result:* the question "does binding work here" is answerable, cheaply and correctly, without asking what platform this is. *Verification:* `bun test src/service/bind-probe.test.ts` — 8 pass, 0 fail, 13 expect() calls, including the cache-probes-exactly-once assertion (3 concurrent + 1 sequential call ⇒ one probe) and the timeout path. `bun run typecheck` clean.

**123.2 — rewire the gate. DONE.** `upstream.ts`'s `process.platform === 'win32' && bindAddress.length > 0` is gone (criterion 1: `grep -rn "platform === 'win32'" plugins/proxy-manager/src/service/upstream.ts` returns nothing), replaced by §4.2's four rows measured through `bindIsEffective()`. The gost sequence itself is unchanged.

**"gost available" is expressed by attempting, not pre-checking — and that is a better answer than the plan asked for.** A platform pre-check would have made criterion 2's test impossible *and* would have reintroduced exactly the kind of guess this whole plan exists to delete. Instead the gost branch is attempted unconditionally whenever the bind is broken, on any platform; `upstream.ts` catches **only** `E_PROXY_GOST_UNSUPPORTED_PLATFORM` (thrown by the untouched `gost-provision.ts`, which is the one place still refusing by platform name) and converts that to `E_PROXY_BIND_INEFFECTIVE`. **Any other gost failure propagates unconverted**, so a genuine, actionable Windows provisioning error is never buried behind the wrong diagnosis — asserted by its own test. This is the same measure-don't-guess discipline applied one level down, and it is worth keeping.

Two test-only seams on `createUpstream`'s `opts` (`checkBindEffective`, `buildGostRuntime`, both defaulting to the real implementations) plus `resetGostRuntimeForTests()` mirroring `bind-probe.ts`'s own reset. The seams are necessary rather than convenient: the real probe **cannot** be made to report "bind works" on this runtime (`bind-probe.ts`'s own header explains why), so the honoured-branch row is otherwise untestable.

Left for 123.3, marked in two places (a comment on the code in `errors.ts` and one at the throw site in `upstream.ts`): the throw is currently a **dial-time `ProxyError`** surfacing through `supervisor.ts`'s existing catch as `state: 'failed'` — a refusal after attempting to start, not the precondition §3.3/§4.3 call for, and the message is a minimal placeholder rather than the operator-facing text §4.3 specifies. *Result:* the workaround is reachable wherever it is needed, and unreachable where it is not. *Verification:* `bun test src/service/upstream.test.ts src/service/bind-probe.test.ts` — 14 pass, 0 fail, 30 expect() calls. Criterion 2 asserted directly (`process.platform` stubbed to `'linux'`, gost hop taken); criterion 4 asserted with a spy that fails the test if the probe is called at all and a gost builder that throws if invoked (empty `bindAddress` ⇒ neither happens); criterion 5 asserted by five `createUpstream` calls producing exactly one probe. `bun run typecheck` clean.

**123.3 — `E_PROXY_BIND_INEFFECTIVE` as a precondition. DONE.** Added to `PROXY_PROBLEM_CODES` (`shared.ts`) following plan 121's `E_PROXY_PORT_MISMATCH` precedent exactly, and evaluated inside `validateProxyRecord` — the pack's single "may this record run" function, so this behaves like its peers rather than as a special case. The context field `bindWorkaroundUnavailable?: boolean` is **three-valued**, matching the shape `hostAddresses` (`E_PROXY_BIND_ADDRESS_UNAVAILABLE`) and `hasListenerAuth` (`E_PROXY_LISTENER_AUTH_MISSING`) already use: `undefined` means nobody looked, and is never a refusal the code cannot justify.

**The mechanism differs from its peers in one honest way, and the worker reasoned it rather than forcing the pattern:** the other preconditions read their fact eagerly before validating, but "does the bind work AND is a workaround available" can only be answered by actually attempting the upstream build (a real socket probe plus a real gost attempt). So `startLocked` catches the specific `ProxyError` from `createUpstream` and **re-validates** with the fact filled in, exiting through the identical `problems` → `setState('failed')` → `say('start-refused')` path every other precondition uses. The listener is never opened — the throw happens before any `createHttpListener`/`createSocks5Listener` call — and the event is `start-refused`/`warn`, never `start-failed`/`error`.

**The operator-facing message, verbatim**, which matters as much as the mechanism (§4.3):

> This host does hold `<bindAddress>` — that part is fine. The runtime this build is running on silently ignores the bind when it dials out (a known upstream limitation, not a bug in this record), so a "direct" upstream would egress from this machine's default address instead, without saying so. No local gost workaround is available to cover that on this platform yet. Until a runtime upgrade fixes this, point this record's upstream at a local SOCKS5 or HTTP proxy that IS known to honour the bind — for example gost or 3proxy, bound to `<bindAddress>` on a loopback port — instead of "direct".

It opens by ruling out the wrong diagnosis explicitly. That is deliberate: the original reporter lost time on the router side before a packet capture settled it, and a message that reads like "the address is wrong" would send the next person the same way.

**The behaviour change, stated plainly because it is immediately visible on a live farm:** `gost` provisioning remains Windows-only, so on Linux/macOS **every `direct` record with a non-empty `bindAddress` now refuses to start** rather than silently mis-egressing. Correct per §3.3 — a loud refusal is recoverable, a silent wrong egress is not — and §9 Q4 (whether to widen `gost` to those platforms) is still open and belongs to the owner. *Result:* the silent-wrong-egress failure mode is gone; what replaces it is a loud, accurate refusal with a documented way forward. *Verification:* `bun test src/record.test.ts src/service/supervisor.test.ts src/service/upstream.test.ts src/service/errors.test.ts` — 108 pass, 0 fail, 355 expect() calls. Criterion 4 is asserted twice over: at the validator (empty `bindAddress` raises nothing even with `bindWorkaroundUnavailable: true`) and at the supervisor (zero probe calls, reaches `running`). A `beforeEach(resetGostRuntimeForTests())` was added after the worker found the module-level `gostRuntime` singleton leaking a fake runtime between tests — a real cross-test contamination caught rather than lived with.

**One repo-wide guard fired during the combined verification and was fixed:** plan 117's acceptance criterion 12 (`grep -ri "mikrotik\|vlan\|modem"` over `plugins/proxy-manager/src` must return nothing — the vendor-neutrality fence) failed, because this step's new tests used `'modem-1'` as a record id. Renamed to `'egress-1'`. The fence worked exactly as designed, on the exact plan most likely to trip it.

**123.4 — observability. DONE.** `logbook.ts`: `egressAddress` added to the `upstream-connected` event, plus a new `bind-mismatch` event (`warn`) naming both addresses. `egressAddress` renders **unconditionally**, deliberately not gated behind `logDestinations` — it is the host's own address, not a destination — and `logbook.ts` gained its own doc section explaining why these two fields clear the pack's field discipline rather than leaving a future reader to wonder.

`listener.ts`: `ListenerOptions.bindAddress?`, and `upstream.localAddress` read inside the dial-resolution callback — **the same point `upstream-connected` already fires**, which §0.3 established empirically is where the property is live and accurate. The once-per-start guard is a `warnedBindMismatch` closure flag declared inside `createListener` alongside `nextConnId`/`destroyed`; since `startLocked` calls `createListener` fresh on every start and `stopLocked` drops the old listener entirely, **it resets on restart by construction** — no extra plumbing, the same "fresh per run" shape plan 121's `FailoverController` uses. The check short-circuits on `!opts.bindAddress` first, so the common no-bind case pays one falsy test and nothing more (criterion 4). `supervisor.ts` passes `entry.record.upstream.bindAddress` — the **primary** upstream's own bind, matching the existing scope of `upstreamHost`/`upstreamPort` on the `listening` event and deliberately not entangled with plan 121's active-upstream failover tracking.

`logbook.test.ts`'s field allowlist gained `egressAddress`/`bindAddress` **as a deliberate, commented assertion** (criterion 6), not an incidental pass-through.

**One test-fixture finding worth recording, because it is the same trap §0.3 documents:** the pre-existing `fakeUpstream` helper resolves *before* the TCP handshake completes, so `socket.localAddress` reads empty through it. The worker added `fakeUpstreamAwaitingConnect`, which waits for the real `connect` event as `dial-direct.ts` actually behaves. Test-only; no production dial behaviour changed. Had this not been noticed, the new field would have been "tested" against a fixture that could never populate it. *Result:* this class of failure becomes greppable instead of requiring a packet capture on the router. *Verification:* `bun test src/service/logbook.test.ts src/service/listener.test.ts` — 25 pass, 0 fail, 212 expect() calls, covering the field's presence, no-`bindAddress`-never-warns across multiple connections, mismatch warning **exactly once** across many connections in one start, and a fresh listener warning again (proving the reset). `bun test src/service/supervisor.test.ts` — 31 pass, unaffected. `bun run typecheck` clean across all 18 packages.

**123.5 — the DNS hint, and docs. DONE.** §4.5's hint is now attached at both places an operator meets it: `service/dial-direct.ts`'s `resolveThroughBind` catch appends, after the existing "not retried through the host's default resolver" sentence the test pins, the two fixes — turn `resolveThroughEgress` off for the record, or point the host's resolver at a public address reachable through `bindAddress`'s own path — naming the record's actual `bindAddress` rather than speaking generically. `ui/parts/upstream-fields.tsx`'s `resolveThroughEgress` field description (the one component both the primary-upstream editor and the fallback-upstream editor render through, so the sentence appears in both places without a second copy) gained the same condition plus the trade-off stated rather than hidden: off, DNS leaves by the host's ordinary link while the connection still leaves from the bound address — fine for most farm work, not for anything geo-sensitive.

`docs/feat/plugin-proxy-manager.md` §8 is corrected, not merely appended to: its header and opening paragraph now record that the finding reproduces on macOS and was reported from Ubuntu, keep the original 2026-08-19 Windows measurement as what it was (accurate, just not the whole truth), and explain why the gate moved from a platform check to a capability probe; the bullet list and the "Two honest limits" section are reworded to describe the measured gate rather than a `win32`-only one, and the Toolchain Manager bullet is corrected to say the *provisioning* is Windows-only today, not the bug.

**A gap found rather than silently worked around**: the task named `docs/plans/117-m82-egress-binding.md` §12 as "the original Windows finding," but that plan document has no §12 (nor any section past §9) — `grep -ni gost docs/plans/117-m82-egress-binding.md` returned nothing before this step, even though `docs/feat/plugin-proxy-manager.md` and several source-code comments (`gost-runtime.ts`, `errors.ts`, `upstream.ts`, `shared.ts`) all cite "plan 117 §12" as an established record. The finding was real and was built (`gost-provision.ts`/`gost-runtime.ts` exist and work), it was simply never written back into plan 117's own document in the one commit that shipped it. Rather than leave the citation dangling or silently invent new facts, a `## 12. The Windows \`gost\` workaround` section was added to plan 117 reconstructing the historical record from what already existed in `docs/feat/plugin-proxy-manager.md`'s pre-correction text and the code comments (no new claims), followed by a **correction paragraph, clearly separated from the historical record rather than merged into it**, pointing at this plan for the fixed gate — matching the task's "do not rewrite, add a pointer" instruction as closely as a genuinely missing section allows.

`docs/plans/00-overview.md` §9 gained a row for `E_PROXY_BIND_INEFFECTIVE`, appended after the existing Plan 121 §4.2 row (chronological order, matching how every other row in that table is appended) rather than between the two Plan 121 rows, which would have broken "the row above" cross-references inside the second one. Matches Plan 118's own row shape: no SQL migration, a new coded refusal, what changed and why.

This plan's own `> Status:`/`> Ships:` lines are updated: `Ships:` is the single literal path `plugins/proxy-manager/src/service/bind-probe.ts` (the trap plans 119 and 121 both hit, avoided here), with the fuller artefact list moved to prose beneath it; `Status:` states the operational consequence plainly — `gost` is still Windows-only by construction, so every `direct` record with a bind on Linux/macOS now refuses to start with `E_PROXY_BIND_INEFFECTIVE` rather than silently mis-egressing, and §9 Q4 (widening `gost` to Linux/macOS) is left open for the owner rather than decided here. `bash scripts/check-plan-status.sh` passes (exit 0); plan 123 appears in neither the mismatch, undeclared, nor none lists, counted among the plans whose declared artefact and status agree. *Result:* the knowledge that existed only in the design record — the DNS hint, the corrected Windows claim, the missing plan-117 section, the new problem code's own row — reaches the operator's screen and the next reader of these documents, instead of staying inside a comment only this pass read.

*Verification:* `bun test ./plugins/proxy-manager/src/service/dial-direct.test.ts` — 10 pass, 0 fail, 16 expect() calls (unaffected by the message-text change; the pinned substring is a prefix of the new message, not the whole of it). `bun run typecheck` clean across all 18 packages. No `src/ui/**` unit tests were added, per the standing owner instruction — `upstream-fields.tsx`'s change was verified by typecheck and by reading the rendered string, not by a new test file.

## 6. Acceptance criteria

1. The bind decision is made by measurement; `grep -rn "platform === 'win32'" plugins/proxy-manager/src/service/upstream.ts` returns nothing.
2. With the probe stubbed "bind broken" and `gost` available, a `direct` record with a `bindAddress` takes the `gost` hop **on a non-Windows platform** — asserted by a test, since this is the change's whole purpose.
3. With the probe stubbed "bind broken" and no `gost`, the record **does not start** and carries `E_PROXY_BIND_INEFFECTIVE`.
4. A `direct` record with an **empty** `bindAddress` is completely unaffected — no probe, no gost, no precondition. (Nothing to bind; this is the common case and must not regress.)
5. The probe runs at most once per process no matter how many records ask.
6. `upstream-connected` carries `egressAddress`, and `logbook.test.ts`'s allowlist assertion was updated deliberately, not incidentally.
7. A record whose observed source differs from `bindAddress` logs exactly one `warn` per start, not one per connection.
8. `bun run typecheck` clean; every touched file's own test passes, run scoped and sequential (CLAUDE.md's hard rule). `plugins/proxy-manager` has its own `bun run --cwd plugins/proxy-manager test`.
9. No plugin-UI unit tests were added (standing instruction).

## 7. Test plan

- 123.1: `service/bind-probe.test.ts` (new) — see the step's own note on writing the assertion so it survives a future Bun fix instead of pinning today's brokenness as the expected answer.
- 123.2: `service/upstream.test.ts` — the four-row table, probe stubbed both ways, platform stubbed to a non-Windows value for criterion 2.
- 123.3: `service/supervisor.test.ts` — a record carrying the precondition does not reach `running`.
- 123.4: `service/logbook.test.ts` (allowlist) and `service/listener.test.ts` (the field is emitted; the warn fires once, not per connection).
- Not automatable here, and named rather than implied: **the real fix can only be confirmed on the owner's own Linux farm** — a `direct` record either taking the gost hop or refusing to start, and `curl -x socks5h://127.0.0.1:<port> ifconfig.me` returning the modem's address rather than the office link. §0.1's own report closes with exactly this check and calls it routine regardless of the bug.

## 8. Risks

| Risk | Mitigation |
|---|---|
| The probe itself is wrong and false-passes, leaving the silent mis-egress in place | §3.1 names the specific false-pass shape (probing against the bind address itself) and rejects it; the chosen discriminator is the one §0.2 empirically demonstrated, not a theory |
| 123.3 makes every Linux `direct` record stop starting — a visible, immediate behaviour change on the owner's live farm | Deliberate and correct (§3.3), but must not be a surprise: the message carries the workaround, the plan's status says so, and §9 Q4 asks whether provisioning `gost` on Linux should land in the same pass to avoid a gap between "stops mis-egressing" and "works again" |
| A future Bun fixes `localAddress` and the probe's test pins today's brokenness as expected | 123.1's own note requires the assertion be written as "the two branches are distinguishable", not "the answer is false" |
| `gost` on Linux/macOS is real work (per-platform artifacts + sha256 each) being underestimated as "just widen the gate" | §4.2 and §5 both state it explicitly rather than letting it hide inside a step |

## 9. Open questions

1. **What should an *inconclusive* probe do** — a timeout, or an error that is neither success nor an address error? Choosing "bind works" risks the silent mis-egress this plan exists to kill; choosing "bind broken" could refuse to start a record on a host where binding was fine. Proposed: treat inconclusive as **broken**, because §3.3's asymmetry holds — a loud refusal is recoverable, a silent wrong egress is not — but this is a judgement worth the owner's explicit agreement rather than a default buried in code.
2. **Plan 121's failover leans on the same `skip` shape** that hid this bug: with `ENKAKU_NETWORK_PROBE_URL` unset, a confirmation probe returns `{ ok: false, error: PROXY_PROBE_SKIP_REASON }` and 121.3 treats that as a *failed confirmation*, so a farm with no probe endpoint fails over on the first streak without ever measuring anything. That was a documented interpretation of a case §4.2 left silent — but this bug is evidence that "unmeasurable" being indistinguishable from "measured and bad" has real teeth. Worth revisiting deliberately.
3. **Is `net.connect({ localAddress })` assumed anywhere else in the workspace?** A sweep would say. Not folded into this plan, because the answer might be "nowhere" and a plan should not carry a step that might be empty.
4. **Should `gost` provisioning widen to Linux/macOS in this same pass?** Without it, 123.3's correct refusal leaves the owner's Linux farm with no working `direct` records at all until they set up the §6 external binders by hand. With it, this plan grows a per-platform artifact table and three more sha256 pins. Proposed: ship the refusal first (it stops the silent damage immediately, which is the urgent half) and decide the widening once the owner has seen the refusal on their own farm — but this is exactly the kind of call that belongs to them, not to me.
