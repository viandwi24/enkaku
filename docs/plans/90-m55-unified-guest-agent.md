# Plan 90 — M55 : One Agent On Every Phone

> Status: partial — all eight steps (90.1–90.8) are implemented and tested in software (`bash scripts/typecheck.sh`, `bun test`, `bun run --cwd packages/studio test` all green against the working tree this status describes); 90.8 (documentation) closes the plan's remaining checklist item. What is left, in full, is hardware confirmation — nothing left is a design question or an unbuilt mechanism — tracked in one consolidated table at the end of §5 (gathering this plan's own H-90.3/H-90.5/H-90.6/H3 rows, plan 88's H1/H3/H6, and the M61 hotfix pass's H-96.9a/b). Per-step detail — step 90.1 (the APK earns mandatory install: Compose removed, R8 on with keep rules verified against a real R8 pass, `versionCode` release-driven, `release.yml` builds/signs/publishes, the toolchain manifest and `entrypoints.ts` wired) done and locally measured 2026-08-13 (release APK ~1.1 MB unsigned, replacing 21.7 MB — see §5's 90.1 and acceptance criteria 1/3); `ENKAKU_TEST_DEVICE=1 bun run smoke:guest-agent` and a real signed CI release both pending — owner to run, exact commands and outcome tables in 90.1 and acceptance criteria 1/2. Step 90.2 (capability negotiation, version-skew rule) done, verified with `bash scripts/typecheck.sh` and the tests below; other steps show signs of concurrent in-progress work in this tree (e.g. `recovery`/`mediaScan`/`textInput` fields already appearing in files this step does not own) but their completion is not certified here. Step 90.7 (media provisioning without an APK facet, plus the two §3.5 monitor corrections) is done and tested in software — `mediaScan` on `push` (`scan_file` then `scan_volume`, reported end to end through the API response, the SDK, and the rendered Files panel with Pictures/Movies/Downloads/custom presets), `meminfo`'s `package` option (with its own `monitor.oneshot` wire field, since none existed before), and `crash` added to Studio's Monitor picker; `bash scripts/typecheck.sh`, `bun test` (3274 pass), and `bun run --cwd packages/studio test` (631 pass) are all green, and `bun run --cwd packages/studio build` succeeds. H3 (does `content call --method scan_file` actually work as the shell user on a real Android 10+ device) is explicitly **pending — owner to run**; see 90.7's own status note for the exact commands and outcome table. Step 90.4 (route recovery that knows the device came back — fixes F13–F20, answers plan 54 §9 Q2) is done and tested in software (2026-08-13): `handleDeviceOffline` stamps `offlineAt` without deleting the recovery state; `restoreDeviceRoute`'s enabled branch calls the new `resetRecoveryOnReconnect`, which resets `attempts`/`exhausted` only when `offlineAt > exhaustedAt` and is bounded by a new hourly-decaying `reconnectCycles` breaker (`guestAgent.maxRecoveryCyclesPerHour`, one `warn` on engagement); `RECOVERY_REARM_S` now reads `guestAgent.recoveryRearmSec` (default 120, replacing the old `max(lastBackoff*5,60)` derivation, F15); `POST /:id/network/retry` is the lease-gated, honest disable/enable equivalent (F17); `GET /:id/network` gains a `recovery` block; `network.recovery.exhausted`/`network.recovery.recovered` are new device event kinds; plan 54 §9 Q2 is answered in place in that plan's own §9. All proven through the real `handleDeviceOffline`/`restoreDeviceRoute`/HTTP-route handlers under a faked clock, asserted from `GET /:id/network`'s JSON body and the device event log — never from internal state directly; see 90.4's own status note for what remains **pending — owner to run** on real hardware (the literal "physically replug the device" half of its verifiable result) and the exact commands/outcome table. `bash scripts/typecheck.sh`, `bun test` (3274 pass), `bun run --cwd packages/studio test` (631 pass), and `bun run --cwd packages/studio build` are all green as of this step. **Task A (sole ownership of `packages/protocol/src/settings.ts`'s `guestAgent` block)** is also done: the whole `guestAgent` farm-settings block (`provision`/`maxRecoveryCyclesPerHour`/`recoveryRearmSec`) and `DeviceSettings.prep.textInput` were written in one pass per this step's own mandate, covering steps 90.3 and 90.5's keys too so they need not touch this file; both are registered in Studio (`guestAgent` gets its own "Guest agent" tab in `farmSections.ts`, `prep.textInput` renders automatically inside the existing "Before a job runs" section via `deviceSections()`'s schema-derived grouping) — `farmSections.test.ts` and `deviceSections.test.ts` both pass. **Honesty note:** `guestAgent.provision` is inert until step 90.3's `AgentProvisioner` lands (not this step's work), and `prep.textInput` is inert until step 90.5's `text-input.ts`/`session.ts` wiring lands — both are real settings today, with no reader yet, by this step's own explicit design (three steps, one schema block, written once). `maxRecoveryCyclesPerHour`/`recoveryRearmSec` ARE wired end to end inside `guest-agent.ts`, but `daemon.ts`'s call to `createGuestAgentRoutes` was NOT updated to pass a `guestAgentSettings` getter reading `settingsStore.get().guestAgent` — that file was outside this step's file allowlist (owned by concurrent work and already carrying uncommitted changes) and touching it was explicitly forbidden by this step's own instructions. Until that one-line wiring lands, an operator changing these two settings in Studio has no effect on a running core; the getter defaults to the schema's own defaults, so behaviour is correct but not yet configurable in production. This is flagged, not silently shipped. **Step 90.3 (provisioning: one agent on every phone — fixes F7, F9, F10) is done and tested in software, 2026-08-13.** `packages/core/src/device/agent-provisioner.ts` (new, this step's own `Ships:` artefact) implements `AgentProvisioner` per §4.3: `ensure()`/`status()`/`ensureAll()`/`remove()`, backed by `devices.agent` (new JSON column, migration `0043_silly_living_mummy.sql`, Zod-validated on every read via `AgentStatusSchema` — `packages/protocol/src/device.ts`, which also gains `AgentStateSchema` and `DeviceInfoSchema.agent`). `packages/drivers/src/network/guest-agent/launcher.ts`'s `ensureInstalled()` is rewritten exactly per F8/F7: `verifyDeviceArtifact` (the identical function `ui-server/launcher.ts` uses, imported not duplicated) replaces the old presence-only `cmd package path` check, with the one-repair-then-degrade rule and a new `opts.force` that skips straight to the repair cycle (R1's seam); `hostAdb` widened to carry `{lane, serial}` so installs ride plan 85's bounded install lane (F12) — proven end to end with the REAL launcher in one test asserting the install call carries `{lane:'install', serial}`, not merely asserted against a fake. `packages/protocol/src/messages/device-event.ts` gains `device.agent` (one event per state TRANSITION, never per verification pass — a clean reconnect that changes nothing emits none, proven by test) and, in the same pass on step 90.5's behalf per this step's own instruction, `clipboard.overwritten`. All four hooks from §3.8's table are wired in `daemon.ts`: admission and reconnect both converge on the SAME `onDeviceReady` callback `restoreNetworkRoute` already uses (traced through the actual call graph: `onAdmitted → registry.admitted() → onOnline() → onDeviceReady`, so a freshly-admitted, already-connected phone needs no second hook); core boot builds `agentProvisioner` right after `guestAgent` (reusing `guestAgent.withGuestAgentClient` for `hello()` — plan 44 §8b's "Bug 1" fix, never a second independent bootstrap) and fires `ensureAll()` fire-and-forget, mirroring where `reconcileNetworkRoutes()` self-invokes but sweeping EVERY admitted device, not only routed ones; the two §4.7 endpoints are `POST /api/devices/:id/guest-agent` (existing, now ALSO fires `agentProvisioner.ensure({force:true})` as a tolerated side effect via a `agentProvisionerRef` forward-ref, same idiom as `onAdmitted`/`rescan` elsewhere in that file) and a brand-new `POST /api/guest-agent/provision` / `GET /api/guest-agent/summary` pair (`createAgentProvisionerRoutes`, mounted at `/api/guest-agent` — a new prefix, wired through `server/http.ts`'s `AppDeps`/`createApp`, a small necessary addition outside this step's original file list, flagged here). Failure policy (§3.8's load-bearing decision) is asserted by test, not merely claimed: a `failed` agent leaves `devices.status`/`quarantineReason` byte-for-byte untouched, including when the device was ALREADY quarantined for an unrelated reason (thermal) — the failure never rides along. Retries are bounded (3 attempts, `[5,20,60]`s cooldown between AUTOMATIC calls, then silent until an explicit `force:true` gives a fresh budget — proven by test); `guestAgent.provision: 'off'`/`'manual'` make every automatic hook a true no-op (zero adb calls, asserted) while `force:true` still works (criterion 8); R1 (a live protocol mismatch `hello()` catches via `GUEST_AGENT_REPAIRABLE_ERROR_CODES`, the seam 90.2 built specifically for this step) forces exactly one reinstall-and-re-hello, never a second attempt (proven, both the repair-succeeds and repair-still-fails paths). The toolchain manifest's placeholder `sha256`/`versionCode` for `guest-agent` (90.1's own honesty note — tier 3 fails closed with `E_CHECKSUM_MISSING` today) is exercised directly: a launcher whose `ensureInstalled()` throws that shape of error reports `state: 'failed'` with the verbatim message, never a crash, never touching `DeviceStatus` — the exact case this brief asked to be covered. **Step 90.5 (the keyboard, and text that is not ASCII-only — fixes F21, F23–F26) is done and tested in software (2026-08-13):** `packages/session/src/text-input.ts` (new) — `resolveTextRoute`'s full four-rung ladder plus `applyTextInput`, the `orientation.ts`-shaped device-scoped setting — is unit-tested exhaustively (`text-input.test.ts`, 21 tests) including the F25 fix itself (forcing `adb-input` on non-ASCII text produces a named precondition, `E_TEXT_UNICODE_UNSUPPORTED`/`install-agent`, never a driver throw); `session.ts` wires `applyTextInput()` beside `applyRotation()` and exposes `DeviceSession.textInput` (`session.test.ts`, +7 tests); `ws-handlers.ts`'s `input.text` now routes through the resolver, replies `input.text.result` with `via`, or refuses with the named precondition — proven against the REAL `createWsMessageHandler` (`ws-handlers-text.test.ts`, new, 6 tests); `device-executor.ts`'s `type()` does the same for scripts and `ScriptTypeResult` (SDK, `packages/sdk/src/types.ts`) gains `via`/`clobberedClipboard`; `descriptors.ts` renames the decorative `text` capability to `text-unicode` on both scrcpy engines (F25); `LiveView.tsx` accepts any printable code point (`[...key].length === 1`, code-point aware, fixing the astral-character/emoji gap `key.length` had) and lets the paste chord through to `clipboard.set(..., {paste:true})` instead of returning early on any modifier key. On the Kotlin side, `input/EnkakuIme.kt` + `input/TextFacet.kt` implement the `BIND_INPUT_METHOD` service, its manifest wiring, and `ControlService.kt`'s `text.commit`/`text.status` branches. **An honest architectural finding, not a defect:** rung 3 (`clipboard`) is fully implemented end to end but is never actually selected by `resolveTextRoute` given this step's exact signature — it is structurally dominated by rung 2 (both need a scrcpy control socket; rung 2 has no side effect) in every input combination this codebase can produce; recorded in 90.5's own status note rather than shipped silently. **(Revisited and confirmed, 2026-08-13 — see the dedicated paragraph below the deviation note, and `docs/plans/96-m61-hotfixes.md` §96.7: this is not a case of "no engine happens to have that shape yet," it cannot happen in this architecture at all, and removal of rung 3 plus `clipboard.overwritten` is now the recorded recommendation.)** **The literal typing-on-hardware and `SIGKILL`-mid-session checks are pending — owner to run** (H-90.5a/H-90.5b, exact commands and outcome tables in 90.5's own status note). **Task B (the screen-label facet — no step in this plan assigned it) is also done on the device side:** `label/LabelRenderer.kt` and `label/WallpaperFacet.kt` (new) implement plan 89 §4.5's five behavioural requirements exactly, `ControlService.kt` gains the `label.apply`/`label.status`/`label.clear` branches (including the `JSONObject.NULL` handling `.nullable()` — not `.optional()` — result fields need, the first on this wire), and `AndroidManifest.xml` gains the plain `SET_WALLPAPER` permission — a new "90.5+" checklist block records this gap and its resolution explicitly, since neither plan 89 nor plan 90's own numbered steps ever assigned it (plan 89 §4.2/§4.5 states the contract and says "not the guest agent's Kotlin side. Plan 90 owns the APK"; plan 90's §5 step list never built it; step 90.2 already advertises `'screen-label'` in `Protocol.CAPABILITIES`, so leaving this unbuilt would have shipped exactly the hazard CLAUDE.md's `vpn-helper` rule warns against). `packages/core/src/device/labelling.ts` (plan 89 §4.6, the host-side caller) is explicitly NOT built here — outside this step's file allowlist — so criterion 17 is only partially satisfiable until that lands. **Files outside this step's own allowlist that needed a small, additive touch to make the above real, all noted in 90.5's status note:** `packages/session/src/types.ts`/`manager.ts` and `packages/core/src/session/adapters.ts` (threading `textInput`/`withGuestAgentClient` the same way `rotation`/`keepAwake` already thread through those exact files), `packages/protocol/src/index.ts` (re-exporting `TextInputModeSchema` and adding `InputTextResultMessage`/`ErrorMessage.action`, none of which touch the three protocol files this step was told not to edit), `packages/sdk/src/types.ts` + `index.ts` (the public `ScriptTypeResult` type), and five pre-existing core test fixtures that constructed a literal `DeviceSession` object and needed the new required `textInput` field added (`presence.test.ts`, `ws-handlers-{clipboard,inspect,monitor,shell,video}.test.ts`) plus `plugins/networking/src/index.ts`'s own narrower `Ctx.device.type` signature (widened to `Promise<unknown>`, since it never reads the return value) — all broken by this step's own `DeviceApi.type()`/`DeviceSession.textInput` changes and therefore this step's own responsibility to fix, never a file `daemon.ts`-forbidden. **`daemon.ts` itself was NOT touched** (forbidden, owned by concurrent work): `CreateSessionDeps.withGuestAgentClient` and `SessionManagerDeps.withGuestAgentClient` are real, fully-consumed dependencies, but nothing in `daemon.ts` constructs a value for them yet, so every build today runs with `agentCapabilities: null` for text input (the same honest "no agent installed" reading, never a crash) until that one remaining wire lands — flagged here exactly as step 90.4 flagged its own analogous `daemon.ts` gap, not silently shipped. `bash scripts/typecheck.sh`, `bun test`, `bun run --cwd packages/studio test`, and `bun run --cwd packages/studio build` are all green as of this step (see its own status note for the exact figures). **Closed 2026-08-13 by the M61 hotfix pass (`docs/plans/96-m61-hotfixes.md` §96.6):** `daemon.ts`'s `createSessionManager({...})` now passes `withGuestAgentClient: (deviceId) => (fn) => guestAgent.withGuestAgentClient(deviceId, fn)` — the exact one-line wire this paragraph flagged as missing, reusing the same per-device session `deviceIdentity`/the agent provisioner's `hello` already share (plan 44 §8b's "Bug 1"). Rung 1 (`agent-ime`) is reachable in production from this point on; `packages/core/src/daemon-wiring.test.ts` gained a case proving the real object literal, not just the resolver helper, carries the accessor. See §96.6 for the full account. **Step 90.6 (the agent is visible — fixes F10, F11, F20's operator half) is done and tested in software, 2026-08-13:** `packages/studio/src/components/guest-agent/AgentPanel.tsx` (new) is the device page's Agent tab, rendering `state`/`appVersion`/`androidSdkInt`/`reason`/the capability list as four named facets ("Network route"/"Screen label"/"Keyboard"/"Location", never raw wire strings)/`checkedAt`, with one primary action per state (Install/Retry/Update agent) plus Remove; `NetworkPanel.tsx` lost its whole install/repair/uninstall block, replaced by a one-line summary linking to the new tab; `NetworkRouteForm.tsx` renders step 90.4's `recovery` block in both places this step named (the toggle banner, and the status panel) with a **Retry now** button wired to `POST /:id/network/retry`; `DeviceHeader.tsx` gained an `agentVersion` prop rendered in its existing `ⓘ` popover plus a chip in its meta row; a new shared `AgentAlertChip` (quiet for `ready`/`absent`, a chip only for `failed`/`outdated`) is used by `DeviceHeader.tsx`, `DeviceCard.tsx`, and `WallTile.tsx`; Settings' `guest-agent` tab gained a `GuestAgentSummarySection` (fleet counts + **Provision all**). The step's own explicit "one thing you MUST do" — widening `GuestAgentStatusResponseSchema.state` to carry `outdated`/`failed` and updating every Studio branch — is done as an ADDITIVE widen (seven values, not a replacement of the pre-plan-90 five), proven both ways: `packages/protocol/src/api/devices.test.ts` (new, 10 tests) proves the schema parses `outdated`/`failed` (and still parses the old five, and still rejects a stranger); `AgentPanel.test.tsx`/`NetworkPanel.test.tsx` prove both states render, through `api()`'s real validated path, never a bare cast. `bash scripts/typecheck.sh` (15/15), `bun test` (3363 pass, 0 fail), `bun run --cwd packages/studio test` (655 pass, 0 fail, up from 631), and `bun run --cwd packages/studio build` are all green. **Two honest gaps flagged, not silently worked around, both outside this step's file allowlist:** (1) `DeviceInfoSchema.agent` — the coarse field every fleet-card/wall/header chip reads — has no producer; `packages/core/src/registry/device-registry.ts`'s `rowToDeviceInfo()` never sets it, so it reads `'absent'` (via the schema's own default) on every real device regardless of its actual provisioning state, until that one-line wire lands; (2) `GET /:id/guest-agent`'s handler (`packages/core/src/api/guest-agent.ts`) is not wired onto `AgentProvisioner.status()`, so the schema's new `versionCode`/`checkedAt`/`attempts`/`nextAttemptAt` fields — declared, and rendered honestly as `—` where shown at all — have no live producer yet either. See 90.6's own status note for the exact reasoning, the one-line fix each needs, and H-90.6a (**pending — owner to run**: confirming all of the above against a real core and a real device).

**Rung 3 (`clipboard`), revisited 2026-08-13 by the M61 hotfix pass (`docs/plans/96-m61-hotfixes.md` §96.7):** the "honest architectural finding" recorded below this paragraph — that `resolveTextRoute` never selects `clipboard` given this step's signature — was investigated further and confirmed to be stronger than "dormant, pending a future engine": `hasScrcpyControl` is provably identical to `scrcpy !== null` in `session.ts`, which gates BOTH rung 2's INJECT_TEXT path and rung 3's clipboard-paste path on the exact same boolean, and every scrcpy input engine that boolean can ever be true for already declares `text-unicode` (a fact of the version-locked scrcpy-server protocol, not a per-engine choice this repo makes) — so "a control socket with ASCII-only text," the shape rung 3 exists for, cannot occur in this codebase's architecture at all, not merely "does not happen to occur today." `text-input.ts` now carries this derivation inline and `text-input.test.ts` pins it with an exhaustive test over the resolver's whole input space. Recommendation, not yet acted on: remove the `'clipboard'` rung, its branches in `ws-handlers.ts`/`device-executor.ts`, `clipboard.overwritten`, and the clipboard-precondition surfacing in `LiveView.tsx` — all four are currently dead code/a dead event in every wired build. See §96.7 for the full account; none of those four files were touched by the M61 pass (all held by concurrent workers).

**Done 2026-08-13 by the next M61 hotfix pass** (`docs/plans/96-m61-hotfixes.md` §96.8), which held every one of the four files listed above: the `'clipboard'` rung, its `ws-handlers.ts`/`device-executor.ts` branches, `clipboard.overwritten`, and the clipboard-paste-specific handling in `LiveView.tsx` (the paste chord's own `clipboard.set(..., {paste: true})` path is untouched — it is a real, separate, operator-facing feature, not part of this ladder) are all removed. §3.3 below is rewritten to describe the resulting three-rung ladder and to record why a fourth rung was designed and could never work, so a future reader does not re-add it. See §96.8 for the full account.

**One deliberate, documented deviation from §4.7's literal text**, found while implementing, not assumed going in: §4.7 says `GET /:id/guest-agent` is "extended" and its `state` "becomes the §3.8 enum". Doing that literally would have changed `GuestAgentStatusResponseSchema` (`packages/protocol/src/api/devices.ts`) — a STRICT Zod enum still reading the pre-plan-90 five values (`'not-installed'|'installed'|'ready'|'unreachable'|'unsupported'`) that Studio's `NetworkPanel.tsx` already parses `api()`-style (plan 72's contract: a response a client cannot parse is a thrown error, not a stale label) and renders Install/Repair branches against by exact string. Shipping the six-value enum on that endpoint today — before step 90.6 replaces `NetworkPanel`'s agent block with the dedicated `AgentPanel` §90.6 itself specifies — would make Studio's Network tab throw client-side the first time any device reads `outdated`/`failed`/`provisioning`, which is likely on any farm with even one imperfect install. `GET/POST/DELETE /:id/guest-agent` are therefore left with their EXACT pre-plan-90 response shape (verified unaffected: `installAndProbe`/`statusOf` never call the rewritten parts of `ensureInstalled()`'s new signature in a way that changes their own return type). `POST` additionally, and only as a side effect never surfaced in the response body, now also runs `agentProvisioner.ensure({force:true})` so `devices.agent`/the fleet summary stay in sync with an operator's explicit click. This is recorded as the honest scope boundary it is, not silently shipped: 90.6 is the step that should migrate this endpoint's shape, together with the UI that stops depending on the old one, in the same pass — exactly the discipline 00-overview §4.3 asks for ("migrate every call site in the same commit"), which a shape change here alone could not do without touching `NetworkPanel.tsx` (a file explicitly held by a concurrent worker for this step, per this step's own instructions).

**The two producer gaps step 90.6 flagged at the bottom of its own status
note above — `DeviceInfoSchema.agent` having no reader in
`rowToDeviceInfo()`, and `GET /:id/guest-agent` never being wired onto
`AgentProvisioner.status()` — are closed 2026-08-13 by the M61 hotfix pass
(`docs/plans/96-m61-hotfixes.md` §96.9).** `packages/core/src/registry/
device-registry.ts` gained an exported `deriveAgentState()` that reads
`row.agent` (Zod-validated via `AgentStatusSchema`, defaulting to `'absent'`
on `null`/corrupt data) and `rowToDeviceInfo()` now sets `agent:
deriveAgentState(row)` — with no new function parameter and no per-call-site
threading, since `agent` lives on the row itself rather than coming from an
external manager the way `heldBy`/`readiness`/`networks` do, so every
existing caller (`listDevicesWithTags`, `daemon.ts`, `capability/context.ts`,
`api/topology.ts`, `api/clusters.ts`, `api/devices.ts`) picks it up
automatically. `packages/core/src/api/guest-agent.ts`'s `GET
/:id/guest-agent` now calls `deps.agentProvisioner.status(deviceId)` when
that (new, optional) dep method is wired, mapping the result additively onto
the SAME response shape this deviation note describes — `outdated`/`failed`
join the pre-plan-90 five rather than replacing them, and
`versionCode`/`checkedAt`/`attempts`/`nextAttemptAt` (declared by step 90.6,
producer-less until now) are populated. `DELETE` was also wired to
`agentProvisioner.remove()` so an uninstall clears the persisted row instead
of leaving `GET` reporting a stale state afterward. `daemon.ts`'s
`createGuestAgentRoutes({...})` call threads both new methods through the
same `agentProvisionerRef` forward-ref `ensure` already used, proven present
in the real source text by two new `daemon-wiring.test.ts` assertions. Proven
from the real HTTP routes, not the helpers in isolation: new tests in
`packages/core/src/api/devices.test.ts` (a device whose `devices.agent`
column says `ready` carries `agent: 'ready'` on `GET /` and `GET /:id`) and
`packages/core/src/api/guest-agent.test.ts` (`GET /:id/guest-agent` reports
`outdated`/`failed` with the new fields populated, and stops reporting a
stale `ready` after `DELETE`). See §96.9 for the full account, including a
workspace-guard interaction it also records: the R2 guard (step 90.2, no
source file may compare `appVersion`) treats a bare `!== null` presence
check the same as a real version comparison, so the mapping function uses
`?? undefined` instead.

Verified: `bash scripts/typecheck.sh` — every package OK except two pre-existing, concurrent-work failures this step's diff does not touch and did not introduce (`core`'s six `ws-handlers*.test.ts`/`presence.test.ts` files missing `DeviceSession.textInput`, and `studio`/`networking` failing on `LiveView.tsx`/`plugins/networking`'s `ctx.device.type()` return type — both trace to step 90.5's in-flight, uncommitted `packages/session/**` changes, confirmed by `git diff --stat` showing those exact files already modified before this step began, and this step's own file allowlist explicitly forbids `packages/session/**`/`LiveView.tsx`). `bun test`: 3319 pass, 0 fail (up from the 3282 baseline measured before this step — the +37 are this step's own new tests: `agent-provisioner.test.ts` 30, `daemon-wiring.test.ts` 5, two added to `api/guest-agent.test.ts`, nine added to `protocol/src/device.test.ts`... nine of those are net-new assertions inside a file also counted once). `bun run --cwd packages/studio test` and `build`: **not yet re-run after this step's edits** — see the plan-wide run at the end of this pass for the actual numbers, since studio's failure above is unrelated to this step's own files (none of `agent-provisioner.ts`, `launcher.ts`, `schema.ts`, `device.ts`, `device-event.ts`, `daemon.ts`, `api/guest-agent.ts`, `api/clusters.ts` are consumed by the failing studio/networking files).

**Pending — owner to run**, hardware-honesty rule: everything above is proven through real handlers under fakes (the launcher's `hostAdb`/`exec`, `hello()`, the clock) — never against a physical phone, per this run's explicit prohibition. What is NOT observed here:

| # | Claim | Exact command | What confirms it |
|---|---|---|---|
| H-90.3a | Admitting a device with no network route configured anywhere in the farm installs the agent and reaches `ready` (acceptance criterion 4) | `bun run dev`, enrol a phone over USB with no route ever configured, `curl -s http://localhost:7700/api/devices/<id>` (repeat until `agent` reads `ready`), then `curl -s http://localhost:7700/api/guest-agent/summary` | `agent: "ready"` on the device list within a few seconds of admission; `summary.byState.ready` includes it |
| H-90.3b | A reconnect (unplug/replug) runs one verification pass, installs nothing, logs nothing beyond a debug line | With H-90.3a's phone already `ready`, unplug and replug; watch the core's log for any `installing the guest agent` line | **Absence** of an install log line; `GET /api/guest-agent/summary` unchanged |
| H-90.3c | 20 devices at once never exceed `adb.maxInstallConcurrent` concurrent installs, and never two on one device | `GET /api/adb/stats` at 1 Hz while admitting/booting with 20 phones already plugged in (this is §7.3's own ladder — not a new measurement, cited here so 90.3's own acceptance criterion 9 has an explicit pointer) | peak `installsRunning` ≤ the configured cap throughout |

This mirrors 90.4/90.7's own precedent exactly: the code and its unit tests do not branch on an assumption about real hardware timing, so a pass or fail here does not change what shipped, only what is *confirmed*.

**90.8 (Documentation) is done, 2026-08-13 — this plan's last step.** Every
reference document its own checklist named is updated: `apps/guest-agent/
README.md`, `packages/core/README.md`, `packages/drivers/README.md`,
`docs/spec.md` (§7.9, §7.10, §11.3, §19), `docs/guide/install.md`,
`docs/plans/89-m54-…md` §4.5 (marked **partly** honoured, not fully — the
device side shipped under 90.5+, the host side has not), and
`docs/plans/00-overview.md` §9. See 90.8's own status note, directly above
its checklist, for what each file gained and for the one new artefact this
step added: a single consolidated hardware-pending table gathering every
`pending — owner to run` row this plan (and plan 88, and the M61 hotfix
pass's §96.9) had scattered across individual steps, cross-referenced rather
than duplicated. **With 90.8 done, every one of this plan's eight steps is
implemented and tested in software.** What remains, in full, is hardware
confirmation — nothing left is a design question or an unbuilt mechanism.
The plan's own hardware-honesty rule held throughout: no step's code or
tests branch on an assumption about real-device timing, so every row in the
consolidated table is a *confirmation* to run, not a *precondition* for
anything already shipped. See the end of this document for the final
`bun run spec:check` / `check-plan-status.sh` / `typecheck.sh` / `bun test` /
studio-test figures this documentation pass measured.
> Ships: packages/core/src/device/agent-provisioner.ts
> Depends on: Plan 43 (the APK itself), Plan 44 (the control channel and the three-tier APK resolution), Plan 51 (verified egress, fail-closed), Plan 52 (device-scoped routes), Plan 54 (bounded route recovery — this plan fixes its §9 Q2), Plan 41 (on-device artefact verification, the pattern this plan copies), Plan 59 (a precondition is not a failure), Plan 85 (`adb.maxInstallConcurrent`, the install lane this plan's provisioning runs on). None of them needs to change first.
> Blocks: Plan 89 §4.5 — `screen-label` and a first-class, independently-installed agent are a hard prerequisite for its tier 1.
> Spec references: §7.2 (Toolchain Manager), §7.4 (the `ui-server` install pattern), §7.9 (the network layer's rules), §7.10 (**"the agent is scoped as a general on-device helper with negotiated capabilities, not a proxy shim"** — this plan is that sentence being cashed), §9 (input engines), §11.3 (trust model), §16 (NFR targets)

---

## 0. Evidence

Written from the code and from one measured APK, not from the feature list of
a competitor. Every claim below is **CONFIRMED** (a file and a line says so, or
a command was run and its output recorded) or **HYPOTHESIS** (a mechanism that
fits but has not been observed, which §5 therefore *measures* before it acts).

Two external documents inform the scope and are cited as such, never as
evidence about this codebase: the Panda feature inventory
(`compete-1-panda.md`) and the Enkaku-vs-Panda gap map (`compete-3-gapmap.md`).

### 0.1 Confirmed findings

#### The APK — the thing that has to be installed everywhere

| # | Finding | Evidence |
|---|---------|----------|
| **F1** | The release APK is **21.7 MB**, and **21.3 MB of it is dex** — `classes.dex` 14.1 MB plus `classes2.dex` 7.1 MB. All three native ABIs of `libhev-socks5-tunnel.so` together are **849 KB**. The tunnel is 4% of the payload; the UI framework is 98% of it. | `unzip -l apps/guest-agent/app/build/outputs/apk/release/app-release-unsigned.apk` |
| **F2** | **R8 is off.** `isMinifyEnabled = false`, with `proguardFiles(...)` configured on the very next line and therefore never applied. | `apps/guest-agent/app/build.gradle.kts:50-51` |
| **F3** | The dex is Jetpack Compose: the Compose BOM, `material3`, `activity-compose`, `lifecycle-runtime-compose` and `lifecycle-viewmodel-compose` are all `implementation` dependencies, and `buildFeatures { compose = true }` is on. They exist for **one static screen with three `Text()` calls and no controls** — the README's own words: *"has no user-facing controls — the single screen exists so a human holding the phone can tell what it is."* | `apps/guest-agent/app/build.gradle.kts:59`, `:77-93`; `apps/guest-agent/app/src/main/java/dev/enkaku/guestagent/StatusActivity.kt` (66 lines); `apps/guest-agent/README.md:3` |
| **F4** | `.github/workflows/release.yml` **does not build the APK** — zero matches for `apk`, `guest`, or `android` in the whole file. CI's `android` job is debug-only and path-conditional. Known and named as a gap by plan 43 §5.11. | `.github/workflows/release.yml`; `.github/workflows/ci.yml:131-132` |
| **F5** | **There is no `guest-agent` entry in the toolchain manifest.** It has exactly four tools: `adb`, `scrcpy-server`, `ui-server`, `ui-server-test`. So tier 3 of the README's three-tier resolution cannot fire — `resolveToolPath('guest-agent')` throws `E_TOOL_NOT_PROVISIONED`. The code says so itself. | `packages/toolchain/manifest/enkaku-tools.json`; `packages/core/src/api/guest-agent.ts:627-629` |
| **F6** | Only `ui-server` carries a `deviceArtifact` expectation, so `deviceArtifactExpectation()` returns `null` for every other tool — a legitimate "skip verification" answer, which for the guest agent means *always* skip. | `packages/toolchain/manifest/enkaku-tools.json:96-99`; `packages/toolchain/src/manager.ts:158-165` |

#### Provisioning — how the agent actually reaches a phone today

| # | Finding | Evidence |
|---|---------|----------|
| **F7** | The guest agent's `ensureInstalled()` checks **presence only** (`cmd package path <pkg>`) and never version or signature. An agent one release out of date is indistinguishable from a current one, forever. | `packages/drivers/src/network/guest-agent/launcher.ts:69-98` |
| **F8** | `ui-server` proves the opposite pattern already works on this codebase: verify → install → on mismatch uninstall, reinstall, re-verify **once** → still wrong, degrade visibly. Run at **every session start**. | `packages/drivers/src/inspector/ui-server/launcher.ts:167-222`, `:227-228`; `packages/session/src/inspector-factory.ts:66-88` |
| **F9** | **Install is a side effect of enabling a proxy.** `vpn-helper.apply()` calls `ensureInstalled()` as its first step; the only other route in is the operator pressing **Install** in the Network tab. `createSession` installs nothing. A farm that never configures a proxy has **no agent on any phone** — which is exactly what plan 89 §4.5 (F17) names as its blocker. | `packages/drivers/src/network/guest-agent/vpn-helper.ts:134-136`; `packages/core/src/api/guest-agent.ts:1009`; `packages/studio/src/components/guest-agent/NetworkPanel.tsx:144-153`; `packages/session/src/session.ts:151-287`; `docs/plans/89-m54-device-identity-and-physical-labelling.md` §4.5 |
| **F10** | The agent's state is **invisible outside the device page's Network tab** — no chip on the device header, the fleet card, or the wall tile. | `packages/studio/src/components/device/DeviceHeader.tsx:183-252`; `packages/studio/src/components/DeviceCard.tsx`; `packages/studio/src/components/wall/WallTile.tsx` |
| **F11** | `GET /api/devices/:id/guest-agent` already returns `appVersion`, `androidSdkInt` and `capabilities` — and Studio **renders none of them**, only `state` and `reason`. | `packages/core/src/api/guest-agent.ts:70-78`, `:979`; `packages/studio/src/components/guest-agent/NetworkPanel.tsx:131-189` |
| **F12** | Plan 85 already bounds installs farm-wide (`adb.maxInstallConcurrent`, default 2) and serialises them per device through `lane: 'install'`, precisely so a fleet-wide attach cannot saturate one USB tree. Any mandatory install must ride that lane. | `docs/plans/85-m50-windows-fleet-scale.md:313-315`; `packages/core/src/device/host-adb.ts` |

#### The reconnect defect — verified line by line, and the received account needs one correction

| # | Finding | Evidence |
|---|---------|----------|
| **F13** | Automatic recovery exists and is architecturally right: probe first, apply only when the device reports no route, confirm `observed.up` rather than trusting the absence of a throw. | `packages/core/src/api/guest-agent.ts:1190-1285` |
| **F14** | It is bounded to **3 attempts** on a `[5, 20, 60]` s schedule, and each attempt pays up to an 8 s settle wait inside `apply()`. | `guest-agent.ts:1141-1143`; `packages/drivers/src/network/guest-agent/vpn-helper.ts:119`, `:148-160` |
| **F15** | Once exhausted it stays exhausted for `RECOVERY_REARM_S` = `max(lastBackoff * 5, 60)` = **300 s** with the default schedule. That number is a **derivation, not a decision**: nobody chose five minutes; it fell out of multiplying the last backoff step by five. | `guest-agent.ts:1176` |
| **F16** | **`restoreDeviceRoute` — the reconnect path — does contain a `resetRecovery` call, and it is on the wrong branch.** It fires only in the `!persisted?.enabled` early return (`:1686-1689`), i.e. when the route is switched **off**. For an enabled route — the reconnect case — control falls straight through to `maybeRecoverRoute` (`:1697-1698`), whose very first substantive check is `r.exhausted` (`:1211-1222`). `heartbeatTick` has the identical shape: reset on the disabled branch only (`:1776-1779`). `handleDeviceOffline` never touches `recoveryByDevice` at all (`:1718-1739`), and the map is documented as deliberately outliving the entry objects a cold probe replaces (`:1136-1143`). **The received root cause is correct; a reader grepping `resetRecovery` inside `restoreDeviceRoute` would wrongly conclude it was already fixed.** | `packages/core/src/api/guest-agent.ts:1136-1143`, `:1211-1222`, `:1686-1698`, `:1718-1739`, `:1776-1779` |
| **F17** | The manual toggle works because it takes a different path entirely: `POST /:id/network/disable` → `revertNetwork` → `resetRecovery`; `POST /:id/network/enable` → `applyRoute` **directly**, never through `maybeRecoverRoute`'s gate. The operator's workaround is not luck — it is the only code path that clears the counter. | `guest-agent.ts:2160-2184` (enable), `:2186-2206` (disable) |
| **F18** | The trip condition is **any adb-visible gap over 90 s**, not "the route broke": `heartbeatTick` skips `status === 'offline'` devices, so a USB re-enumeration starves the on-device dead-man's switch exactly like a dead core would. A blip therefore costs a full hold-and-recover cycle even when the upstream never failed. | `guest-agent.ts:1780`; `apps/guest-agent/app/src/main/java/dev/enkaku/guestagent/route/DeadMansSwitch.kt:75` |
| **F19** | Plan 54 asked this exact question in its own §9 and shipped the answer "persist". This plan is the revision, not a discovery. | `docs/plans/54-m24d-fail-closed-and-route-recovery.md:135-139` |
| **F20** | The only operator-visible artefact of exhaustion is a static string on the route form. There is no countdown, no attempt number, and no event — so "why was this device dark for four minutes" is unanswerable after the fact. | `guest-agent.ts:1259`; `packages/studio/src/components/guest-agent/NetworkRouteForm.tsx:183-191`, `:770-773` |

#### Text input — what Enkaku genuinely cannot type

| # | Finding | Evidence |
|---|---------|----------|
| **F21** | `adb-input` **hard-rejects** anything outside `\x20-\x7e` with `INPUT_TEXT_UNSUPPORTED`, and honestly declares itself `text-ascii`. | `packages/drivers/src/input/escape.ts:8-18`; `packages/drivers/src/descriptors.ts:55` |
| **F22** | scrcpy's text path is UTF-8 `INJECT_TEXT` (control type 1, `[u8][u32BE byteLen][utf8]`) on **both** engines. `ScrcpyUhidInput extends ScrcpySdkInput` and overrides only `tap`/`swipe`/`gesture` — UHID does **not** synthesise scancodes for text, and there is no HID keyboard descriptor anywhere (`packages/scrcpy/src/hid/` holds `pointer.ts` alone). | `packages/scrcpy/src/version.ts:32`; `packages/scrcpy/src/control/messages.ts:21-29`; `packages/drivers/src/input/scrcpy-input.ts:80-82`, `:110-124`, `:131-138` |
| **F23** | **The binding constraint is Studio, not the engine.** `LiveView`'s canvas handler gates on `key.length === 1 && key >= ' ' && key <= '~'`. A CJK character or an emoji matches neither that branch nor the keycode branch, so it is **dropped silently** — no message, no error, no log. Modifier chords return early one line above, so Cmd/Ctrl+V never reaches anything either. | `packages/studio/src/components/LiveView.tsx:386`, `:389`, `:396-401` |
| **F24** | A unicode path already exists and is **not wired to anything**: `SET_CLIPBOARD` carries a `paste: boolean` that "immediately pastes into the focused field", and its encoder is the one place in the repo with a non-ASCII test (`'héllo 世界'`). Studio exposes it only as a manual popover; nothing uses it as a text fallback. The adb shim ignores `paste` outright. | `packages/scrcpy/src/control/messages.ts:138-157`; `packages/scrcpy/src/control/messages.test.ts:76-89`; `packages/studio/src/components/device/ClipboardButton.tsx:108-128`; `packages/session/src/session.ts:329-339` |
| **F25** | `'text-ascii'` appears **exactly once in the repository** — its own declaration. `EngineDescriptor.capabilities` is an untyped `z.array(z.string())` consulted only to satisfy other engines' `requires`, so the ASCII/unicode distinction is decorative: a CJK `input.text` is forwarded to the driver and dies there as a runtime error, never refused as an unmet capability. | `packages/drivers/src/descriptors.ts:55`; `packages/protocol/src/registry.ts:8`, `:97-108`; `packages/core/src/server/ws-handlers.ts:1217-1227` |
| **F26** | `ui-server`'s `setText` is unicode-clean (JSON-RPC, no shell escaping) but reachable only when the last tap was **selector-based** *and* the timing profile is `instant` — the default profile is `natural`, and a point-tap sets `lastTarget = null`. It is not exposed over WS at all. A shipped plugin already hit this and silently fell back to `input text`, which **appends** instead of replacing. | `packages/drivers/src/inspector/ui-server/client.ts:173-175`; `packages/session/src/device-executor.ts:148`, `:176`, `:214-241`; `packages/protocol/src/settings.ts:64-66`; `plugins/networking/src/index.ts:392-397` |
| **F27** | There is **no IME anywhere** — zero `ime set`, `ime enable`, or `default_input_method` writes. The single hit is a *read* in `reset.ts`, used to build a kill allowlist so an aggressive session reset does not force-stop the active keyboard. That allowlist would protect an Enkaku IME for free. | `packages/session/src/reset.ts:150`, `:160`, `:166-167` |
| **F28** | Competitor evidence, for calibration only: Panda ships **one** assistant package (`com.panda.assistant`) whose keyboard is an IME *component of that same package* (`com.panda.assistant/.keyboard.XwIME`). Its docs contain no monitoring, gallery, or tunnel APK anywhere; the "gallery/settings" entries visible in its UI are stock Android destinations surfaced through a shortcut panel. One app with several facets is the shape that is actually in the field. | `compete-1-panda.md` §2, §12 |

#### Media — what "gallery" would concretely mean

| # | Finding | Evidence |
|---|---------|----------|
| **F29** | `push` streams bytes over the raw adb `sync:` service to a caller-supplied absolute path and then **stops**. There is no follow-up command of any kind. | `packages/core/src/device/transfer.ts:176-202`; `packages/adb/src/transport/sync.ts:263-288` |
| **F30** | **Nothing anywhere triggers a MediaStore scan.** An exhaustive scoped grep for `MEDIA_SCANNER`, `MediaStore`, `MediaScannerConnection`, `cmd media`, `content call`, `scan_volume`, `scan_file` across `packages/ apps/ plugins/ docs/ scripts/` returns zero hits. A pushed image is invisible to any picker until the OS happens to rescan. | repo-wide search |
| **F31** | There is no notion of a media directory or a media type: zero occurrences of `DCIM`, `Pictures`, `Movies`, `Download`, or `/storage/emulated` in `packages/` or `plugins/`. `validateRemotePath` is a charset-and-traversal check that says outright it is **not** a sandbox. | `packages/core/src/device/path-validate.ts:12`, `:15-34` |
| **F32** | No shipped plugin needs a file on the device. `tiktok-automation-pack` watches, searches and switches accounts; `networking` reads a network-info app. Neither uploads or posts content. | `plugins/tiktok-automation-pack/src/index.ts:267`, `src/search-follow.ts:315`, `src/switch-account.ts:358`; `plugins/networking/src/index.ts` |

#### Monitoring — what the host can already see

| # | Finding | Evidence |
|---|---------|----------|
| **F33** | The host already streams `logcat`, `top -b -d 2`, a `dumpsys thermalservice`+`dumpsys battery` loop and a `logcat -b crash,main` crash feed, and one-shots `ps -A`, `dumpsys meminfo` and `df -h`, all through one hub that dedupes identical commands. | `packages/core/src/device/monitors.ts:19-69`; `packages/core/src/device/monitor-hub.ts:61-63`, `:144-146`, `:284` |
| **F34** | It parses crashes and ANRs into structured events (`AndroidRuntime`/`FATAL EXCEPTION`, `ActivityManager`/`ANR in`), attributes them to a job when a job lease is held, rate-limits them, and resubscribes with backoff. | `packages/core/src/device/crash-parser.ts:107-109`, `:193-215`; `packages/core/src/device/crash-watcher.ts:157-171`, `:189-194`, `:210-239` |
| **F35** | It samples `dumpsys battery` every 60 s and quarantines above 45 °C; it counts consecutive adb failures and quarantines at 3, then probes for recovery every 60 s. | `packages/core/src/device/battery.ts:82`, `:88-106`; `packages/core/src/device/health.ts:63-75`, `:85-110`; `packages/protocol/src/settings.ts:587-589`, `:810-828` |
| **F36** | `GET /api/adb/stats` reports queue depth, exec p50/p95, per-outcome counters, consecutive failures, stream-lane occupancy, WS transport buffering and host-adb process counts. There are ~40 device-event kinds on two retention streams. | `packages/core/src/api/adb-stats.ts:61-108`; `packages/protocol/src/messages/device-event.ts:15-50`; `packages/core/src/events/recorder.ts:28-87` |
| **F37** | **The agent's only channel to the host is `adb forward localabstract:enkaku-guest-agent`** — the same adb transport that already carries logcat. An on-device monitor can therefore report *nothing* when adb is down, and everything it could report while adb is up is already reachable from the shell. | `apps/guest-agent/.../control/Protocol.kt:18`; `packages/drivers/src/network/guest-agent/launcher.ts:159` |

#### Capability negotiation and permissions — what already works

| # | Finding | Evidence |
|---|---------|----------|
| **F38** | Capability negotiation is **already built and already used**. `hello` returns `protocol`, `appVersion`, `androidSdkInt` and `capabilities`; the host gates `egress.probe` on `egress-probe` and `route.hold` on `route-hold` rather than discovering support from a failed call. | `apps/guest-agent/.../control/ControlService.kt:170-176`; `apps/guest-agent/.../control/Protocol.kt:38-39`; `packages/protocol/src/guest-agent.ts:45`, `:163-168`; `packages/core/src/api/guest-agent.ts:1436`; `packages/drivers/src/network/guest-agent/vpn-helper.ts:191`, `:202` |
| **F39** | The protocol **major** is a hard gate: a mismatch throws and is deliberately not retried, because "a different protocol version will not fix itself". | `packages/drivers/src/network/guest-agent/client.ts:272-280` |
| **F40** | Every permission the agent needs today is grantable with no human tap: install-time normals in the manifest, runtime permissions via `install -r -g`, `ACTIVATE_VPN` via `appops set` **with a readback** because it is `@hide`, and `android:mock_location` the same way. | `apps/guest-agent/app/src/main/AndroidManifest.xml:12-23`; `packages/drivers/src/network/guest-agent/launcher.ts:97`, `:121-131`; `apps/guest-agent/.../control/ControlService.kt:291` |
| **F41** | A stale comment in the protocol package claims *"no build advertises `egress-probe` today"*, while `Protocol.kt` has advertised it since plan 51. Small, but this file is the contract both sides read. | `packages/protocol/src/guest-agent.ts:35-39` vs `apps/guest-agent/.../control/Protocol.kt:38-39` |
| **F42** | Plan 89 §4.5 states the contract it needs from this plan in full: a `screen-label` capability in `Protocol.CAPABILITIES` and its Zod mirror, a `SET_WALLPAPER` install-time permission (explicitly **no** appops step), and three verbs `label.apply` / `label.status` / `label.clear` with five behavioural requirements. | `docs/plans/89-m54-device-identity-and-physical-labelling.md` §4.5 |
| **F43** | Competitor evidence: Panda's accessibility mode needs a **human to re-tap an on-screen prompt after every reboot**, warned four separate times in its own manual, and the same is true of its Safe Mode. A farm product marketed on unattended scale documents this as an operational weakness. | `compete-1-panda.md` §1b, §1c, §11 |

### 0.2 Hypotheses (measure before acting)

| # | Hypothesis | Why it fits | How §5 tests it |
|---|-----------|-------------|-----------------|
| **H1** | Dropping Compose and enabling R8 brings the release APK **under 3 MB**. | F1/F2/F3: dex is 98% of the payload, the app draws three `Text()` calls, the native tunnel is 849 KB, and shrinking is switched off. | 90.1 builds it and records the measured number. Acceptance criterion 1 is a **measured size**, not a target — if it lands at 6 MB, that is the answer and the ladder in §7.3 is read against it. |
| **H2** | Mandatory install's dominant cost at fleet scale is APK size × device count over a shared USB tree, not per-device handshake time. | F12 bounds installs to 2 concurrent farm-wide; 20 × 21.7 MB at that bound is minutes, 20 × 2 MB is seconds. | §7.3's provisioning ladder records wall-clock time-to-all-provisioned at 5/10/20 devices, before and after 90.1. |
| **H3** | `content call --uri content://media --method scan_file --arg <path>` works as the shell user on Android 10+; `scan_volume --arg external_primary` is the whole-volume fallback. | `MediaStore` has exposed both call methods since API 29, and `MEDIA_SCANNER_SCAN_FILE` was deprecated at the same API level. | 90.7 tries `scan_file` first, falls back to `scan_volume`, and **reports which one answered** in the transfer result, so the field answer is recorded rather than assumed. Device-gated test in §7.2. |
| **H4** | Setting the default IME with `ime set` at session start and restoring it at session close leaves no device wedged, including after a core kill mid-session. | `ime set` writes `secure default_input_method` — the same shape `accelerometer_rotation` uses, and `orientation.ts` already proves the read-first/restore-after/idempotent pattern on this exact class of setting. | 90.5's unit tests cover apply/revert/double-revert; §7.2 covers a deliberate `SIGKILL` mid-session and asserts the next session start normalises it. |
| **H5** | The reported "held or dead after a reconnect, fixed by toggling" is F16 and **not** a second, separate defect. | F16 + F17 + F18 predict exactly the reported symptom, including why the toggle specifically is what works. | 90.4 adds a regression test that reproduces the sequence, plus a `network.recovery.*` event pair. If the symptom survives 90.4 in the field, the hypothesis is dead and §9 Q3 takes over. |
| **H6** | `adb install` uses a session-based installer and may therefore *not* trip Android 13+'s restricted-settings block on accessibility services. | The block keys off non-session-based installers; modern adb installs via `pm install-create/write/commit`. | **Not tested by this plan** — accessibility is deferred (§2). Recorded in §9 Q1 so the deferral is priced rather than forgotten. |

### 0.3 What the owner's report maps to

```
"guest agent jadi kewajiban install, bukan seperti sekarang yang install
  hanya di panel network/proxy"                          → F9 (install is a side effect
                                                            of applying a route), F10, F11
"harusnya bisa otomatis deteksi pas reconnect"           → F7 (presence-only check, no
                                                            version/signature), F8 (the
                                                            pattern that already exists)
network route "held or dead" after a reconnect, fixed
  by toggling the route off and on                       → F16 (the bound is never reset
                                                            on reconnect), F17 (why the
                                                            toggle is what works), F18
                                                            (why a USB blip trips it at all)
"kenapa tidak kita jadikan satu app saja"                → F28 (one package, several
                                                            facets, is the shape in the
                                                            field), spec §7.10
"apa gunanya ada virtual keyboard?"                      → F21, F23 (Studio drops CJK
                                                            silently), F25 (the capability
                                                            distinction is decorative)
"gallery juga buat apa?"                                 → F29, F30, F31 — and the answer
                                                            is that it needs no APK (§3.4)
plan 89 cannot ship its tier 1                           → F9, F42
```

---

## 1. Goals

- **Every admitted phone carries the agent, as a matter of course.** Not
  because someone configured a proxy, not because someone opened a tab —
  because it was admitted to the farm. Installed at admission, re-verified on
  every reconnect, repaired when it drifts, exactly the way `ui-server`
  already behaves (F8).
- **An agent that fails to install never costs a device.** A phone with no
  agent still streams video, takes input, runs jobs, and answers a shell. Only
  the facets that genuinely need the agent say so, and they say it as a
  precondition with an action, never as a red error (plan 59).
- **One app, four facets, one install.** The route it already carries, the
  screen label plan 89 needs, the text input Enkaku cannot otherwise type, and
  the location it already sets — in one package, negotiated by capability, not
  four APKs and four provisioning stories.
- **The APK earns the right to be mandatory.** It is 21.7 MB today for a
  849 KB tunnel (F1). Before this plan installs it on twenty phones by default,
  it stops carrying a UI framework it does not use.
- **A device that reconnects gets a fresh chance.** The recovery bound exists
  to stop hammering a dead proxy; it must not survive the one event that
  changes the premise. And an operator watching a route recover sees a
  countdown and an attempt number, not a static sentence — with a **Retry now**
  action that does honestly what disable-then-enable does by accident (F17).
- **Non-ASCII text can be typed, from Studio and from a script**, on any input
  engine, without clobbering the device clipboard — and where it genuinely
  cannot be, the product says which path is missing instead of dropping the
  keystroke on the floor (F23).
- **Files land where a picker can find them.** One command after a push, no
  APK, no on-device gallery (§3.4).
- **Version skew is a designed rule, not an accident.** Protocol major gates
  the conversation, capabilities gate features, `versionCode` decides whether
  to upgrade, and nothing anywhere compares a version string.
- **The agent is visible.** Its state, its version, and what it can do appear
  on the device page and on the fleet, and a farm-wide summary answers "are all
  my phones on the current agent" in one glance.

## 2. Non-goals

- **Not accessibility mode.** Deferred by the owner. Nothing here is designed
  for it; §9 Q1 records only what leaving room costs and what F43/H6 say about
  the price of building it later.
- **Not a screencast or capture path.** Display stays scrcpy (spec §9, §7.6).
  The agent never carries a frame.
- **Not absorbing `ui-server`.** "One app" means one *first-party* app. The
  inspector's APK is openatx's `com.github.uiautomator`, a third-party package
  Enkaku downloads and verifies but does not author (F6, spec §7.4) — merging
  it would mean forking it, which is the same mistake spec §7.6 forbids for
  scrcpy-server. Two on-device packages remain the right answer: ours, and one
  we did not write.
- **Not an on-device monitoring agent.** §3.5 argues why, from F37 rather than
  from taste. This is a deliberate rejection with reasoning, not an omission.
- **Not a gallery app.** §3.4 argues why, and builds the thing that was
  actually wanted instead.
- **Not root, Magisk, or a system app.** Every mechanism here works on a stock
  locked device with adb, or it is not in this plan.
- **Not a change to fail-closed policy or the 90 s dead-man's switch** (plans
  51, 54). §3.7 explains why the trip condition stays and the *recovery* is what
  gets fixed.
- **Not the wallpaper rendering, the numbering scheme, or the labelling
  service.** Plan 89 owns all three. This plan ships the on-device verbs and
  the capability it asked for (F42), and nothing above them.
- **Not multi-device input fan-out** (plan 91) — but §3.3's text ladder is
  written so a fan-out sits on top of it without a second design.
- **Not video quality controls** (plan 92), **not the command console**
  (plan 93), **not the recorder** (plan 94).
- **Not `adb kill-server`.** Forbidden repo-wide outside the Toolchain
  Manager's swap flow; nothing here goes near it.

## 3. Context and design decisions

### 3.1 One app, four facets — and the rule that decides membership

The owner's instruction was not "list the components", it was *"rangkai
hubungan"* — design the relationships. So the first decision is the
**membership rule**, and everything else follows from applying it:

> **A capability belongs in the guest agent only if it needs to run as an
> ordinary Android app.** If the adb shell user can do it, the host does it —
> because the host can do it on a phone with no agent, on a phone whose agent
> is a version behind, and on a phone whose agent just failed to install.

That rule is not aesthetic. It is forced by F37: the agent's only channel to
the host is `adb forward` over the same adb transport the shell already uses.
An agent facet can therefore never reach *further* than the shell — only
*differently*. So the only things worth putting in the app are the ones where
"differently" is the entire point: a system API that has no shell equivalent
(`VpnService`, `InputMethodService`, `WallpaperManager`, the mock-location
provider), or a piece of state that must survive the host going away
(the dead-man's switch).

Applying it:

| Candidate | What it needs that adb alone cannot do | What it costs | Verdict |
|---|---|---|---|
| **Route** (`socks5-route`, `vpn-status`, `egress-probe`, `route-hold`) | `VpnService` is the only enforcing rung — an app under test cannot opt out, which `settings put global http_proxy` can never provide (spec §7.9). Nothing in the shell establishes a TUN. | 849 KB of native library; the `ACTIVATE_VPN` appop; a foreground service | **KEEP** — it is why the app exists |
| **Screen label** (`screen-label`) | `WallpaperManager.setBitmap` has no shell equivalent that composes and writes an image. `wallpaper` is not an `adb shell` command on stock Android. | one install-time permission, no appop (F42) | **BUILD** — plan 89 asked, and the rule agrees |
| **Text input** (`text-input`) | Only an `InputMethodService` can commit arbitrary Unicode into whatever field has focus, on any engine, without touching the clipboard. §3.2 makes the case in full. | an IME service; a default-IME swap that must be reverted; ~30 KB | **BUILD** — with §3.3's ladder, and only alongside the Studio fix |
| **Mock location** (`mock-location`) | The test-provider API needs an app registered as the device's mock-location provider; the shell cannot inject a fix. | already shipped | **KEEP** — already built (plan 58) |
| **Gallery / media** | Nothing. Bytes reach the device over `sync:`; MediaStore is told by a `content call` the shell can issue; the picker looks at a path. §3.4. | an APK facet plus `READ_MEDIA_*` and probably `MANAGE_EXTERNAL_STORAGE`, to duplicate a host code path | **REJECT** — build the host-side scan instead |
| **Monitoring** | Nothing, and structurally so: F37 means it can report only when adb is up, and everything reachable while adb is up is already streamed (F33–F36). §3.5. | a second telemetry pipe, a second retention story, a second thing to version | **REJECT** |
| **Screencast assistant** | Accessibility-based control, i.e. the deferred mode | see §9 Q1 | **DEFER** — owner's decision; no room is reserved and §9 prices that |

Four facets ship. Two candidates are rejected with reasons. That is the
answer to *"kenapa tidak kita jadikan satu app saja"*: yes — one app, but not
one app that absorbs everything it *could*.

**The relationship that makes this more than a bundle.** These facets are not
four features stapled together; they share three things that only work once:

1. **One provisioning story.** One install, one appop pass, one bootstrap, one
   `hello`. Adding a fifth facet later costs one capability string, not a new
   APK, a new pin, a new install path, and a new failure mode. This is spec
   §7.10's stated intent — *"provisioning cost is per-app rather than
   per-feature"* — and it is the whole economic argument for the unified app.
2. **One authenticated channel with one lifetime.** The token, the `adb
   forward`, and the port are already shared by every caller through
   `withEphemeralSession` (`guest-agent.ts:940-953`), which exists precisely
   because a second caller minting its own token rotates the live route's token
   out from under it. A separate keyboard APK would need its own channel, its
   own token, its own port from the same allocator — and would reintroduce that
   bug class from scratch.
3. **One honest state.** `hello().capabilities` already tells the host what
   this build can do (F38). Adding facets to that list means the fleet page can
   answer "which of my phones can be labelled" and "which can type Japanese"
   from data the agent already sends — instead of four independent
   is-it-installed probes.

**And one relationship that runs the other way, which is why this plan exists
at all:** the route facet is currently the *only* thing that installs the
agent (F9). Every other facet is therefore hostage to whether an operator
configured a proxy. Plan 89 named this as its blocker in writing (F42). Making
install unconditional is not a convenience — it is the edge that connects the
other three facets to reality.

### 3.2 Why a farm ships a keyboard

The honest starting point is that the received explanation is half wrong for
this codebase. "adb cannot type non-ASCII" is true of `adb-input` (F21) and
false of scrcpy, whose `INJECT_TEXT` carries UTF-8 on both engines (F22).
Enkaku's real problem is narrower and more embarrassing:

- **Studio drops the character before any engine sees it** (F23). A CJK or
  emoji keypress on the canvas matches neither branch of the handler and is
  discarded — silently, with no message. On `scrcpy-uhid`, where the wire would
  have carried it fine, the operator still cannot type it.
- **The one unicode path that is wired end-to-end is a manual popover** (F24).
  Clipboard-with-paste works, is the only non-ASCII-tested encoder in the repo,
  and nothing calls it as a fallback.
- **The capability that would express the difference is decorative** (F25).
  `text-ascii` is declared once and read never, so a CJK `input.text` is
  forwarded to a driver that throws instead of being refused as an unmet
  precondition.

So the first thing to say plainly: **most of the value here is host-side and
costs almost nothing.** Fixing F23 and wiring F24 is a day of work and covers
an operator pasting a Japanese caption into a focused field. If this plan did
only that, it would be a real improvement.

**Then why build the IME at all?** Because clipboard-paste has four specific
failures, and a farm hits all four:

1. **It clobbers the device clipboard.** That is observable state inside the
   app under automation. A script that types a caption and then reads the
   clipboard gets its own caption back. For a farm running unattended jobs, a
   text-input mechanism with a side effect on device state is not a text-input
   mechanism, it is a bug waiting for a schedule.
2. **It needs a paste-capable focused field.** OTP fields, many password
   fields, and custom-drawn inputs refuse paste. `INJECT_TEXT` and an IME both
   go through the input connection instead.
3. **It cannot do per-character timing.** Plan 40 built input realism, and
   `typeText`'s `perCharMs` range (`device-args.ts:59-65`) is real. A single
   paste is one event; an IME can commit code point by code point, so realism
   and unicode stop being mutually exclusive.
4. **It needs scrcpy.** The adb shim ignores `paste` outright
   (`session.ts:336-338`), so on a device that fell back to `adb-input` there
   is no unicode path at all — and that fallback is exactly the degraded state
   where an operator most needs to type something.

An `InputMethodService` has none of those four properties. It commits through
`InputConnection`, so it works on any field the platform will let anything type
into; it touches no clipboard; it can commit one code point at a time or the
whole string; and it is entirely independent of which display or input engine
is live, because it is not on that path at all.

**And it is genuinely cheap to reach.** `adb shell ime enable <id>` followed by
`ime set <id>` switches the default keyboard with **no user tap** — the same
class of no-consent-dialog mechanism as `appops set ACTIVATE_VPN allow`, and
unlike accessibility, which Android 13+ blocks for sideloaded apps behind a
manual "Allow restricted settings" tap (F43, §9 Q1). The IME needs **no
permission at all**: an `InputMethodService` is granted `BIND_INPUT_METHOD` by
the system, exactly as `RouteVpnService` is granted `BIND_VPN_SERVICE` today.

**The cost, stated honestly.** Switching the default IME is device-visible
state, so it obeys the same discipline `keepAwake` and `rotation` already do:
read the previous value, apply at session start, restore at session close,
idempotent on double-revert (`packages/session/src/orientation.ts` is the
template). Two extra shell calls per session. And a human physically holding
the phone during a session sees the Enkaku keyboard instead of theirs — which
is why §4.4 gives that keyboard a visible one-line view saying what it is, with
a tap target that opens the system keyboard picker. A dead keyboard with no
explanation is the kind of half-feature this plan exists to avoid.

One inherited detail that happens to be free: `reset.ts` already reads
`secure default_input_method` to build a kill allowlist so an aggressive
session reset does not force-stop the active keyboard (F27). Once the agent
*is* the keyboard, that allowlist protects the agent's process for free.

**Verdict: BUILD** — as one service in the existing package, gated on a
`text-input` capability, with the host-side ladder in §3.3, and **only
together with the Studio fix**, because an IME behind a client that discards
the characters is not a feature.

### 3.3 The text ladder — three rungs, and the product says which one it is on

Adding an IME without deciding what beats what would leave several unicode
paths and no rule. The routing is fixed, evaluated per call, and reported:

| Rung | Path | Unicode | Per-char timing | Side effects | Needs |
|---|---|---|---|---|---|
| 1 | **`agent-ime`** — `text.commit` over the control channel | ✓ | ✓ | none | agent with `text-input`, and the IME current |
| 2 | **`scrcpy INJECT_TEXT`** | ✓ (UTF-8 on the wire) | ✓ (per code point) | none | a scrcpy control socket |
| 3 | **`adb-input`** | ✗ (ASCII only) | ✓ | none | nothing |

Rules that make this a ladder rather than a pile:

- **Rung 3 refuses instead of throwing.** Today a CJK string reaches
  `AdbInput.text()` and dies as `INPUT_TEXT_UNSUPPORTED` from inside a driver
  (F25). Instead, the WS handler and the script executor check the resolved
  rung's declared capability first and answer with a named precondition —
  *"this device's input engine can only type ASCII; install the guest agent to
  type Japanese"* — with the action attached. Plan 59's rule, applied to the
  one place in the repo where a capability string existed and was never read.
- **`text-ascii` vs `text` stops being decorative.** F25 gets fixed as a side
  effect: the descriptor capability becomes the thing the resolver reads, and
  a new `text-unicode` capability is what the scrcpy-based rung (rung 2)
  advertises, replacing the undifferentiated `text` those engines used to
  declare.
- **The rung is reported, not inferred.** `input.text`'s reply and the script
  `type()` result both carry `via: 'agent-ime' | 'scrcpy-text' | 'adb-ascii'`,
  so a plugin author debugging "my text appended instead of replacing" (F26 —
  a real, shipped instance of exactly this) can see which path ran.
- **Fan-out sits on top unchanged.** Plan 91's mirror input resolves a rung per
  device and sends N commits; nothing in this ladder assumes one device.

**A fourth rung was designed here, built, and then removed — recorded so
nobody re-adds it believing it was merely never gotten to.** The original
design (below, kept for the historical record rather than edited away) added
a `clipboard paste` rung between what are now rungs 2 and 3:

| Rung | Path | Unicode | Per-char timing | Side effects | Needs |
|---|---|---|---|---|---|
| — | **`clipboard paste`** | ✓ | ✗ | **overwrites the device clipboard** | a scrcpy control socket, and a paste-capable focused field |

The reasoning at design time was real: a paste-capable field that refuses
`INJECT_TEXT` for some reason would still accept a paste, so the rung looked
like a legitimate third fallback before the ASCII-only floor. It was fully
built end to end — a `clipboard.overwritten` device event, a real branch in
both `ws-handlers.ts` and `device-executor.ts`, `TextRouteDecision
.clobbersClipboard` to flag the side effect — and it was never once reachable
in a running build. Step 90.5's own status note found this and recorded it
honestly rather than shipping it silently; the M61 hotfix pass
(`docs/plans/96-m61-hotfixes.md` §96.6, §96.7) then investigated *why*,
confirmed it was not "dormant, waiting for the right engine" but
architecturally impossible, and §96.8 removed it. The proof, in short: this
plan's own resolver gates that rung on `hasScrcpyControl` — a scrcpy control
socket — exactly like rung 2, and `session.ts` proves that boolean is exactly
`scrcpy !== null` at every call site. The clipboard-paste rung's *own*
`session.clipboard`'s `paste`-capable branch is gated on that literal same
`scrcpy` value, and every engine that value can be true for (`scrcpy-uhid`,
`scrcpy-sdk`) already declares `text-unicode` — a fact of the version-locked
scrcpy-server wire protocol (CLAUDE.md: never fork the Java side), not a
per-engine choice this repo makes. So "a scrcpy control socket whose text
injection is ASCII-only" — the shape the clipboard rung existed to catch —
has no possible instance here: a control socket and unicode `INJECT_TEXT` are
the same boolean, not two independent facts some future engine could pull
apart. So the clipboard rung's own stated precondition (a scrcpy control
socket) either coincided with rung 2's — which wins first and has no side
effect, so it always pre-empted the clipboard rung — or was absent, in which
case the clipboard rung's own precondition failed too and rung 3 (which needs
no control socket at all) served plain ASCII text instead. Either way the
clipboard rung was strictly dominated on every input this codebase can
produce. **Do not re-add it** without first widening `resolveTextRoute`'s
signature with a fact that can actually separate "ASCII-only control socket"
from "unicode control socket" — none exists today, and inventing one would
mean forking scrcpy-server itself.

### 3.4 There is no gallery facet, because "gallery" is not an app

Take the request literally and it decomposes into three steps:

1. **Get the bytes onto the phone.** `push` already does this, over the raw adb
   `sync:` service, artifact-sourced, size-capped, on the streaming lane (F29).
   Nothing missing.
2. **Put them where a picker looks.** That is a *path* — `/sdcard/Pictures/…`,
   `/sdcard/DCIM/Camera/…`, `/sdcard/Movies/…`. The adb shell user writes there
   freely; scoped storage restricts *apps*, not the shell. Nothing missing
   except that Enkaku has no notion these paths are special (F31).
3. **Tell MediaStore.** This is the only genuinely missing step (F30), and it
   is **one shell command**: `content call --uri content://media --method
   scan_file --arg <path>` (H3), with `scan_volume --arg external_primary` as
   the whole-volume fallback. `MEDIA_SCANNER_SCAN_FILE` was deprecated at API
   29 and is unreliable on Android 11+, so the broadcast is not the answer.

**Nothing in that list needs an APK.** An on-device gallery facet would need
`READ_MEDIA_IMAGES`/`READ_MEDIA_VIDEO` (runtime, so `-g` covers them) and, for
anything general-purpose, `MANAGE_EXTERNAL_STORAGE` — a special access the
platform actively discourages and which Play policy treats as exceptional. It
would carry a second copy of a file-writing path the host already owns and
tests. And it would fail on exactly the devices where the agent failed to
install, which is the population the host path serves without complaint.

The membership rule from §3.1 answers this in one line: the shell can do all
three steps, so the host does all three steps.

**Verdict: REJECT the facet. BUILD the missing step**, host-side, as part of
`push`:

- `POST /:id/push` gains `mediaScan?: 'auto' | 'always' | 'never'`, default
  `'auto'` — scan when the resolved remote path sits under a known media root
  (`/sdcard/{DCIM,Pictures,Movies,Music,Download}` and their
  `/storage/emulated/0` spellings), skip otherwise. An operator pushing an APK
  to `/data/local/tmp` pays nothing.
- The result reports `mediaScan: { ran: boolean; method: 'scan_file' |
  'scan_volume' | null; ms: number }` — because H3 is a hypothesis and this is
  how it gets settled in the field rather than in a comment.
- Studio's Files panel gets destination presets (Pictures / Movies / Downloads
  / custom), so the operator does not have to know that `/sdcard/Pictures` is
  the right answer. That is the whole of "gallery" as a farm operator
  experiences it: pick a file, pick where it goes, and have the phone's picker
  show it.
- **A failed scan never fails the push.** The bytes are on the device either
  way; the result says the scan did not run and why.

This is roughly forty lines and no new on-device surface. Refusing to build the
app is the design decision; building the scan is what makes the refusal
honest rather than a dodge.

### 3.5 There is no monitoring facet, and this one is structural

Enkaku's host-side observation is not thin. It streams `logcat`, `top`,
thermal and a dedicated crash feed; it one-shots `ps`, `meminfo` and `df`; it
parses crashes and ANRs into attributed events; it samples battery every 60 s
and quarantines on temperature; it counts adb failures and quarantines on
those; it reports queue depth, exec percentiles, lane occupancy and WS
buffering; and it writes ~40 kinds of device event across two retention
streams (F33–F36).

The question is therefore not "does Enkaku monitor" but "what could an
on-device process see that the host cannot". Three candidate answers, all of
which fail:

- **"It could survive a disconnect and buffer."** It could not report the
  buffer. The agent's only channel is `adb forward` over the same transport
  logcat uses (F37) — when adb is down the agent is unreachable by
  construction. And the platform already solves this better: logcat is a device
  ring buffer, so reconnecting with `logcat -T <timestamp>` recovers the gap
  with no app at all.
- **"It could report things `dumpsys` cannot."** Every candidate is a shell
  command: `dumpsys meminfo <pkg>`, `dumpsys netstats`, `dumpsys batterystats`,
  `dumpsys procstats`, `/proc`. That the host currently runs `dumpsys meminfo`
  with no package argument (F33) is a *host-side* gap worth ten lines, not an
  argument for an APK.
- **"It could watch continuously and cheaply."** A resident on-device sampler
  costs CPU and battery on every phone in the farm, forever, to produce data
  the host can pull on demand — and it can only deliver that data over the
  channel it is trying to economise on.

The general rule this yields, worth writing down because it will be tested
again by the next capability someone proposes:

> **The agent reports what only the agent knows.** Its own route state, its own
> dead-man's-switch verdict, its own IPv6-leak assertion, its own applied
> label, its own probe measured from inside its own tunnel. It never becomes a
> second telemetry pipe for facts the shell already exposes.

Everything the agent reports today already obeys that rule — `route.status`
returns `prepared`/`state`/`upstream`/`ipv6Blocked`, and `egress.probe`
measures a leg the host structurally cannot measure because it is not inside
the tunnel (`ControlService.kt:214-264`). That is the shape a future facet must
match.

**Verdict: REJECT.** With two host-side corrections adopted here because they
are the real content of the request and cost almost nothing: `monitor` gains
an optional `package` option so `meminfo` can be scoped to one app, and the
`crash` kind becomes selectable in Studio's Monitor picker, which today lists
six of the seven kinds and omits the one the crash watcher uses.

### 3.6 The route keeps its shape; the label joins it on the same terms

The route facet is the app's reason to exist and is not redesigned here. Two
things must not regress and are therefore stated as constraints on every step
below:

- **A route outlives everything except an explicit act** (spec §7.9 rule 1) —
  lease release, idle expiry, client disconnect, device reboot, core restart.
  This is precisely why provisioning is **not** a session step (§3.8): a route
  must work on a device with no session, so the thing that installs the agent
  cannot be the thing that opens a session.
- **`apply()` is not a success signal** (spec §7.9 rule 3). The route reports
  `unverified` until an egress check passes, and this plan adds no path that
  reports otherwise.

**Plan 89's contract is honoured as written** (F42), with no deviations:

- `'screen-label'` joins `Protocol.CAPABILITIES`
  (`apps/guest-agent/.../control/Protocol.kt:38-39`) and its Zod mirror
  (`packages/protocol/src/guest-agent.ts:45`).
- `<uses-permission android:name="android.permission.SET_WALLPAPER" />` goes in
  the manifest. It is a normal install-time permission, so `adb install -r -g`
  already covers it and **no appops step is added** — unlike `ACTIVATE_VPN`
  and `android:mock_location`, which both needed one (F40).
- Three verbs — `label.apply`, `label.status`, `label.clear` — in the existing
  NDJSON request/response shape, with the exact field sets plan 89 §4.5
  specifies, and all five behavioural requirements: `applied` reports what
  *took* (so an OEM skin swallowing the lock screen produces `['home']` and the
  core can say `partial`); an unchanged fingerprint is a cheap no-op that still
  returns live ids; the original wallpaper is captured once and
  `originalCaptured` is reported honestly rather than optimistically;
  `label.clear` is idempotent and consults no "already cleared" flag; and
  `rendererVersion` is an integer the agent owns, bumped whenever the drawing
  changes.

One integration note plan 89 could not know: because §3.8 makes install
unconditional, plan 89's tier-1 availability is now a function of the
**provisioning** state, not of whether a proxy exists. Its `unavailable` case
narrows to "the agent genuinely is not on this phone", which is now a visible,
explained, repairable condition rather than the default state of every device
in a farm that never configured a proxy.

### 3.7 The recovery bound must know *why* the route went down

F16 is confirmed, and it deserves precise wording because the code is one
`resetRecovery` call away from looking correct: **`restoreDeviceRoute` does
reset the counter — on the branch where the route is switched off.** On the
enabled branch, which is the reconnect case, it falls through to
`maybeRecoverRoute`, whose first substantive check is `r.exhausted`. So the
counter survives every reconnect, `handleDeviceOffline` never touches it, and
the only thing that clears it early is the operator's toggle (F17).

Combined with F18 — the dead-man's switch trips on *any* adb gap over 90 s,
because `heartbeatTick` skips offline devices — the full failure is:

```
t+0     USB re-enumerates. Device goes offline. Route was fine.
t+90    On-device switch trips. Route → held. Traffic stops.
t+95    Device reconnects. restoreDeviceRoute → maybeRecoverRoute.
t+100   attempt 1 fails (upstream still settling, or the probe is unlucky).
t+120   attempt 2 fails.
t+180   attempt 3 fails. exhausted = true, exhaustedAt = now.
t+180   Log warns once. Studio shows a static sentence. No countdown.
t+185   Device reconnects again — no effect: exhausted is checked first.
t+480   Re-arm finally elapses (RECOVERY_REARM_S = 300).
        …unless the operator toggles the route, which resets it instantly.
```

Five minutes of a dark route because a cable wiggled, and a number nobody
chose (F15).

**The fix is not "reset unconditionally".** Plan 54 §9 Q2's fear is real and
specific: a device flapping every 30 s against a genuinely dead proxy would
retry forever and hide a permanent failure behind an infinite loop. So the
design distinguishes the two cases the current code conflates:

1. **The counter resets when the premise changed.** A device that was
   *actually offline* since the bound was reached is new information — the most
   likely cause of the hold (F18) is now gone. `handleDeviceOffline` stamps
   `offlineAt` on the recovery state (it must **not** delete the state; the
   state is what stops a flapper). `restoreDeviceRoute`, on the enabled branch,
   clears `attempts`/`exhausted` **only when `offlineAt > exhaustedAt`** — i.e.
   only when a genuine disconnect happened after the give-up, never merely
   because a heartbeat ran.
2. **A second, coarser breaker catches the flapper.** Each such reset
   increments `reconnectCycles`, which decays hourly. Past
   `guestAgent.maxRecoveryCyclesPerHour` (default 4), resets stop and the plain
   re-arm clock takes over, with one `warn` naming the count. This is the same
   circuit-breaker shape plan 85 §3.5 already established for the ui-server
   watchdog — a repo pattern, not a new invention.
3. **The re-arm becomes a decision.** `RECOVERY_REARM_S` stops being
   `max(lastBackoff * 5, 60)` and becomes `guestAgent.recoveryRearmSec`,
   default **120**. Two minutes is long enough not to hammer a dead proxy on
   the 20 s heartbeat and short enough that an operator does not reach for the
   toggle. The old value was a coincidence of arithmetic; this one is a number
   someone can argue with.
4. **The operator gets the honest version of their workaround.** `POST
   /:id/network/retry` clears the counter and applies once, immediately —
   exactly what disable-then-enable achieves by accident, without the teardown
   round trip, and without the misleading UI state of "the route is off". It is
   lease-gated like every other network write.
5. **Recovery becomes visible.** The route status gains `recovery: { attempts,
   maxAttempts, nextAttemptAt, exhausted, reconnectCycles }`, so Studio renders
   *"not routed — retrying in 14 s (attempt 2 of 3)"* and, when exhausted,
   *"gave up after 3 attempts; retrying in 1m 47s"* next to a **Retry now**
   button. Two new main-stream events, `network.recovery.exhausted` and
   `network.recovery.recovered`, mean the Logs tab can answer "why was this
   device dark" after the fact — which today it cannot (F20).

**What deliberately does not change:** the 90 s dead-man's switch and the
fail-closed policy. The switch exists for the case where the *host* is what
died, and lengthening it to dodge F18 would trade a recoverable stall for a
device that keeps routing to a farm that no longer exists. The right response
to a trip caused by a blip is to recover from it quickly and visibly, which is
what the five changes above do.

### 3.8 Provisioning: the agent is a device property, not a session step

`ui-server` installs at **session start** because that is exactly its lifetime
— it serves the inspector, and there is no inspector without a session (F8).
Copying that hook for the guest agent would be wrong, and the reason is spec
§7.9 rule 1: a route must survive with **no session at all**. A device sitting
idle with a proxy applied has no session, so a session-scoped installer would
never run on the population that needs the agent most.

**Decision.** A `AgentProvisioner` owns the agent's presence on a device, and
runs at four moments, all of which already exist as hooks:

| Moment | Existing hook | Why |
|---|---|---|
| **Admission** | `POST /api/devices/discovered/:stableId/admit` → `onAdmitted` (`packages/core/src/api/devices.ts:260-283`, `registry/device-registry.ts:510-527`) | The one moment a phone becomes ours. This is what makes install *"kewajiban"* rather than incidental. |
| **Device online** | `onDeviceReady` (`packages/core/src/daemon.ts:2173-2181`) — already the reconnect hook `restoreDeviceRoute` uses | This is *"otomatis deteksi pas reconnect"*, on the hook that already fires for exactly this purpose |
| **Core boot** | beside `reconcileNetworkRoutes()` (`guest-agent.ts:1745-1760`), but for **every admitted device**, not only routed ones | A core upgrade carrying a new pinned APK must reach phones that never disconnect |
| **On demand** | `POST /api/devices/:id/guest-agent` (exists) and a new fleet-wide `POST /api/guest-agent/provision` | The button a human reaches for, and the fleet-wide equivalent |

**What it does on each pass** — the `ui-server` algorithm (F8), not a new one:
verify → if absent, install → if `version_mismatch` or `signature_mismatch`,
uninstall, reinstall, re-verify **once** → if still wrong, stop, report, and do
not loop. `unreadable` skips verification for this pass rather than failing,
because `dumpsys package` output is not stable across OEMs (the same rule
`verify.ts` already applies). Verification becomes possible at all only because
90.1 adds the `deviceArtifact` expectation the manifest lacks today (F6).

**What it costs and how that is bounded.** Every install goes through plan 85's
`lane: 'install'` (F12) — `adb.maxInstallConcurrent` farm-wide, serialised per
device — so twenty phones coming online at once queue instead of saturating one
USB tree. A new `guestAgent.provision: 'auto' | 'manual' | 'off'` (default
`'auto'`) lets an operator on a slow hub take manual control, and `'off'`
returns exactly today's behaviour for anyone who wants it.

**When it fails, the device still works.** This is the load-bearing decision.

> A failed agent install **never** blocks, quarantines, or holds back a device.

Quarantine means "do not schedule work here", and the two reasons that exist
today — `adb:unreachable` and `thermal:` — both genuinely mean that (F35). An
APK that would not install says nothing about whether the phone can stream
video, take input, run a job, or answer a shell. Blocking a device for it would
be a catastrophic overreaction to a flaky USB write, and it would make the
farm *less* available than before this plan.

Instead, provisioning state becomes a first-class, visible device property:

```
absent | provisioning | ready | outdated | failed | unsupported
```

`unsupported` is the existing API-level floor (`MIN_SUPPORTED_SDK = 29`,
`guest-agent.ts:64`) and is terminal-by-design, not a failure. `failed` carries
the verbatim reason and a **Retry** action. Facets that need the agent report a
precondition at their own call site — the route already does this well, and
plan 89's `unavailable`, the text ladder's rung-4 refusal, and mock location
all join it. Plan 59's rule, applied consistently: *a precondition the operator
can satisfy is not an error.*

**Retry policy for `failed`.** Bounded and quiet: three attempts with the same
`[5, 20, 60]`-shaped backoff the route recovery uses, then stop until the next
device-online transition or an explicit retry. A farm of twenty phones with a
bad APK path must produce twenty log lines, not an install storm.

### 3.9 The version-skew rule

One app doing four jobs is one app that can be a version behind on any of them.
Three of the four mechanisms already exist (F38, F39); what is missing is the
rule that says which one answers which question. Four rules:

**R1 — Protocol major gates the conversation, and now also triggers a repair.**
`client.hello()` already refuses a mismatched `GUEST_AGENT_PROTOCOL` and
deliberately does not retry, "a different protocol version will not fix
itself" (F39). That reasoning was correct when nothing knew which APK was
right. Once the manifest pins one (90.1), it *can* fix itself: a protocol
mismatch marks the device `outdated` and hands it to the provisioner, which
reinstalls the pinned build **once** and re-handshakes. Still refuses to talk
across the mismatch; no longer a dead end.

**R2 — Capabilities gate features. Versions never do.** No host code compares
`appVersion` — not with `>=`, not with `startsWith`, not at all. It is a
display and diagnostic field (F11 makes it visible for the first time).
Everything conditional keys on `hello().capabilities`, exactly as
`egress-probe` and `route-hold` already do (F38). This is what lets a farm run
mixed agent versions without a matrix.

**R3 — A capability string is append-only and immutable in meaning.** Once
shipped, a name is never removed from the enum and never repurposed. Dropping a
facet means builds stop *advertising* the string; the host must already handle
its absence, for every capability, always. The Zod enum
(`packages/protocol/src/guest-agent.ts:45`) is therefore a growing list and the
one place a new facet is registered — and it must stop lying about what builds
advertise (F41 is fixed in the same step).

**R4 — `versionCode` decides whether to upgrade, never whether to talk.** The
manifest's `deviceArtifact.versionCode` is the expectation
`verifyDeviceArtifact` compares against, and a mismatch triggers exactly one
repair before degrading visibly — the `ui-server` rule, unchanged (F8). It
never gates a method call; a device that talks fine on an old build keeps
working while the upgrade is pending.

**What the operator sees when skew bites.** Never a stack trace, never
`E_UNKNOWN_METHOD` in a toast. A facet whose capability is missing renders as:

> **Screen label needs a newer agent** — this device has 1.0.0; labelling
> arrived in 1.2.0. **Update agent**

with the button wired to the provisioner. That sentence needs `appVersion` and
`capabilities` on screen, which is F11's fix, which is why 90.6 exists.

**A guard against R2 rotting.** `packages/core` and `packages/drivers` get a
unit test asserting that no source file compares `appVersion` — cheap, and it
fails the first time someone reaches for the obvious wrong tool.

### 3.10 Permissions, in full

Being explicit here is the difference between a plan and a surprise on device
number seven. Every row is what the *host* must do; nothing below needs a human
to touch a phone.

| Facet | Permission / op | Kind | How it is granted | Tap needed? |
|---|---|---|---|---|
| Control channel | none | — | `localabstract` socket via `adb forward`; needs no permission by design (`Protocol.kt:14-17`) | **No** |
| All | `INTERNET`, `ACCESS_NETWORK_STATE`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_SPECIAL_USE`, `RECEIVE_BOOT_COMPLETED` | normal, install-time | granted at install (`AndroidManifest.xml:12-22`) | **No** |
| All | `POST_NOTIFICATIONS` | runtime (API 33+) | `adb install -r -g` (`launcher.ts:97`) | **No** |
| Route | `ACTIVATE_VPN` | **app op**, `@hide`/`@SystemApi` | `appops set <pkg> ACTIVATE_VPN allow`, **read back** because it is undocumented and could change (`launcher.ts:121-131`) | **No** |
| Route | `BIND_VPN_SERVICE` | service attribute | held by the system, declared on the service (`AndroidManifest.xml:89`) | **No** |
| Mock location | `android:mock_location` | app op | `appops set <pkg> android:mock_location allow` (`ControlService.kt:291`) | **No** |
| **Screen label** | `SET_WALLPAPER` | **normal, install-time** | granted at install — **no appops step** (plan 89 §4.5, F42) | **No** |
| **Text input** | **none** | — | `BIND_INPUT_METHOD` is held by the system, declared on the service. Activation is `ime enable <id>` then `ime set <id>` — shell commands, no consent dialog | **No** |
| *(Accessibility — deferred)* | `BIND_ACCESSIBILITY_SERVICE` + `secure enabled_accessibility_services` | restricted setting | Android 13+ blocks this for sideloaded apps behind a manual **"Allow restricted settings"** tap per device (F43); H6 records the one thing that might exempt an `adb install` | **Yes, probably** |

Two conclusions worth drawing from the table rather than leaving implicit:

- **Every facet this plan ships is unattended-grantable.** That is not luck; it
  is the selection criterion. A facet requiring a human to tap a phone is a
  facet that does not work in a farm, which is precisely the operational
  weakness the competitor's own documentation warns about four times (F43).
- **The deferred accessibility mode is the one that breaks that property**, and
  it breaks it per device and again after some reboots. §9 Q1 prices it.

### 3.11 The APK has to earn the right to be mandatory

Installing 21.7 MB on every phone in a farm, by default, would be an
irresponsible thing to ship — and 21.3 MB of it is a UI framework drawing three
lines of text (F1, F3), with shrinking switched off (F2). At plan 85's install
bound of 2 concurrent, twenty phones is minutes of saturated USB before a
single one is useful. This is not a "nice cleanup"; it is the precondition that
makes §3.8 defensible, which is why it is step **90.1** and not step 90.8.

**Decision.** `StatusActivity` is rewritten as a plain `Activity` with a
hand-written layout — three `TextView`s and a button, which is exactly what it
draws today — and the entire Compose dependency set, `buildFeatures.compose`,
and the Compose compiler plugin come out. `isMinifyEnabled = true` turns on R8,
with keep rules for the JNI peer (`Tun2Socks` is resolved by name at load time
via `FindClass(PKGNAME "/" CLSNAME)` and **renaming or stripping it breaks the
native library with no compile error** — README's own warning), the four
manifest-declared components, and the new IME service.

H1 says this lands under 3 MB. The acceptance criterion is the **measured**
number, recorded in the plan, not the target — because F1 is a measurement and
its replacement should be one too.

Two things this buys beyond size, both of which matter more at twenty devices
than at one:

- **Install time falls roughly with size**, so §3.8's provisioning pass stops
  being a fleet-wide stall (H2, measured by §7.3's ladder).
- **Storage on the phone.** Twenty farm devices each carrying an extra 20 MB
  for a status screen is a real cost on the cheap hardware this product targets
  (spec §16).

And one thing it does not buy, stated so nobody assumes it: the native tunnel
stays. All three ABIs together are 849 KB, and dropping one to save 200 KB
would trade emulator or redroid support (`build.gradle.kts:38`) for nothing
worth having.

**The build and release gap closes in the same step**, because a pinned APK
that CI never builds is a pin on a file that does not exist: `release.yml`
gains an APK build and publish, the manifest gains a `guest-agent` entry with
`sha256` and a `deviceArtifact` (`packageName`, `versionCode`,
`signatureSha256`), and `versionCode` starts incrementing — it has been `1`
since the app was scaffolded (`build.gradle.kts:17`), which is fine while
nothing verifies it and useless the moment something does.

## 4. Technical design

### 4.1 Protocol (`packages/protocol/src/guest-agent.ts` + `Protocol.kt`)

Both sides change together, always — that rule is already written on both files
and is unchanged here.

```ts
// GUEST_AGENT_PROTOCOL stays 1. Every addition below is a NEW method plus a
// NEW capability, which is exactly the case the capability list exists for
// (R3): an older build answers E_UNKNOWN_METHOD, and the host never asks
// because it gated on the capability first.

export const GuestAgentCapabilitySchema = z.enum([
  'socks5-route', 'vpn-status', 'egress-probe', 'route-hold', 'mock-location',
  'screen-label',   // plan 89 §4.5 — label.apply / label.status / label.clear
  'text-input',     // plan 90 §3.2 — text.commit / text.status
])
```

Also in this file, the stale comment claiming no build advertises
`egress-probe` (F41) is corrected — it has been advertised since plan 51, and
this file is the contract both sides read.

**New methods.** `label.*` is plan 89 §4.5's shape, reproduced field for field
(§3.6); `text.*` is new here:

```ts
// → text.commit
{ method: 'text.commit', id, token, params: {
    text: string,                 // any Unicode; the agent never re-escapes
    perCharMs?: [number, number], // absent = commit the whole string at once
} }
// ← result
{ committed: number,              // code points actually committed
  ime: 'current' | 'not-current' }// honest: an IME that is not current commits nothing

// → text.status  (params: {})
// ← result
{ ime: 'current' | 'enabled' | 'disabled',
  id: string,                     // 'dev.enkaku.guestagent/.input.EnkakuIme'
  connected: boolean }            // is an InputConnection live right now
```

`text.commit` returning `ime: 'not-current'` rather than throwing is
deliberate: it is a precondition the host can fix (`ime set`), and §3.3's
resolver reads it to fall down the ladder rather than fail the call.

### 4.2 The app (`apps/guest-agent/app/src/main/java/dev/enkaku/guestagent/`)

```
control/       ControlService.kt, Pairing.kt, Protocol.kt      (unchanged shape)
route/         …                                              (unchanged)
identity/      MockLocation.kt                                 (unchanged)
label/         LabelRenderer.kt, WallpaperFacet.kt             NEW — plan 89's verbs
input/         EnkakuIme.kt, TextFacet.kt                      NEW — the IME
StatusActivity.kt                                              REWRITTEN, no Compose
```

`ControlService.handle()` gains two `when` branches, in the same shape as the
existing ones: validate on the wire (never trust the socket even though the
host's Zod already bounds it — the same reasoning `route.start`'s port check
and `location.set`'s lat/lng re-validation already use), then delegate to the
facet.

**`EnkakuIme : InputMethodService`.**

- Commits through `currentInputConnection.commitText`, one code point at a time
  when `perCharMs` is present (so plan 40's realism survives), whole-string
  otherwise.
- `onCreateInputView` returns a **visible one-line view**: *"Enkaku input —
  driven by the farm host"* plus a **Switch keyboard** button calling
  `InputMethodManager.showInputMethodPicker()`. §3.2's reasoning: a human
  holding the phone must never meet a keyboard with no keys and no explanation.
- Holds no state the host cares about beyond "am I current" and "is there a
  connection", both reported by `text.status`.

`TextFacet` is what `ControlService` calls; it hands work to the live
`EnkakuIme` instance through a static weak reference, and answers
`ime: 'not-current'` when there is none — no queueing, no waiting.

### 4.3 The provisioner (`packages/core/src/device/agent-provisioner.ts`, **new** — the plan's `Ships:` artefact)

```ts
export type AgentState =
  | 'absent' | 'provisioning' | 'ready' | 'outdated' | 'failed' | 'unsupported'

export interface AgentStatus {
  state: AgentState
  appVersion: string | null
  versionCode: number | null
  androidSdkInt: number | null
  capabilities: GuestAgentCapability[]
  /** Verbatim, for `failed`/`unsupported`. Never a summarised one. */
  reason: string | null
  /** Unix seconds of the last completed pass. */
  checkedAt: number | null
  /** Bounded retry bookkeeping, mirroring the route recovery's shape. */
  attempts: number
  nextAttemptAt: number | null
}

export interface AgentProvisioner {
  /** Verify → install → repair once → degrade. Idempotent; safe to call on every hook. */
  ensure(deviceId: string, opts?: { force?: boolean }): Promise<AgentStatus>
  /** Cached row when offline, live when online — and the result says which. */
  status(deviceId: string): Promise<AgentStatus>
  /** Fleet-wide, bounded by the install lane. Returns a per-device report. */
  ensureAll(opts?: { force?: boolean }): Promise<AgentProvisionReport>
  /** Uninstall + clear the row. Route/label teardown happens first, by the existing paths. */
  remove(deviceId: string, actor: string | null): Promise<AgentStatus>
}
```

- Installs run through the plan 85 host-adb helper with `lane: 'install'` and
  `serial`, so `adb.maxInstallConcurrent` bounds the farm and per-device
  serialisation bounds the phone (F12).
- Verification is `verifyDeviceArtifact` — the identical function `ui-server`
  uses (`packages/drivers/src/inspector/ui-server/verify.ts:45`) — against the
  manifest expectation 90.1 adds. `unreadable` skips this pass; it never fails
  one.
- One `device.agent` main-stream event per state change, so the Logs tab
  records what was installed, when, and why a pass failed.
- `deviceState.agent` is persisted on the `devices` row (a JSON column,
  Zod-validated on read like every other JSON column) so `status()` can answer
  for an offline phone and the fleet page can render without twenty probes.

The launcher gains the one method its own doc comment says it deliberately
lacks: `installedVersion()` is still not read from `dumpsys` output — it comes
from `hello().appVersion` for display and from `verifyDeviceArtifact` for
decisions, which is exactly what that comment recommends.

### 4.4 Settings (`packages/protocol/src/settings.ts`)

A new farm block, in the `discovery`/`monitor` house style:

```ts
guestAgent: z.object({
  provision: z.enum(['auto', 'manual', 'off']).default('auto')
    .describe('Install and keep the on-device agent up to date on every admitted device. "manual" only installs when asked; "off" disables it entirely.')
    .meta({ title: 'Provision the guest agent' }),
  maxRecoveryCyclesPerHour: z.number().int().min(1).max(20).default(4)
    .describe('How many times a reconnect may reset a network route’s recovery budget within an hour before the slow retry clock takes over.')
    .meta({ title: 'Recovery resets per hour' }),
  recoveryRearmSec: z.number().int().min(30).max(3600).default(120)
    .describe('How long automatic network-route recovery waits after giving up before trying again.')
    .meta({ title: 'Recovery re-arm (s)' }),
}).default({ provision: 'auto', maxRecoveryCyclesPerHour: 4, recoveryRearmSec: 120 }),
```

`DeviceSettings.prep` gains one field, beside `rotation` and `keepAwake`:

```ts
textInput: TextInputModeSchema.default('auto')
  .describe('Use the guest agent’s keyboard while a session is open, so non-ASCII text can be typed.')
  .meta({ title: 'Text input' }),
// export const TextInputModeSchema = z.enum(['auto', 'agent', 'device'])
//   auto   — use the agent's IME when it advertises `text-input`, otherwise the device's
//   agent  — always; report a precondition when unavailable
//   device — never switch the IME (today's behaviour, exactly)
```

`transfer` gains nothing; `mediaScan` is a per-request field (§4.6), because it
is a property of the file being pushed, not of the farm.

### 4.5 Text routing (`packages/session/src/text-input.ts`, new)

One resolver, one place, used by the WS handler, the script executor, and
(later) plan 91's fan-out:

```ts
// A fourth value, 'clipboard', was designed and built here and then removed as
// architecturally unreachable — see §3.3's own note and docs/plans/96-m61-hotfixes.md §96.7, §96.8.
export type TextRung = 'agent-ime' | 'scrcpy-text' | 'adb-ascii'

export interface TextRouteDecision {
  rung: TextRung
  /** Always false today — no remaining rung has a clipboard side effect; kept as a boolean rather than deleted (§96.8). */
  clobbersClipboard: boolean
  /** Set when NO rung can carry this string — the precondition, phrased for a human. */
  unmet: { code: string; message: string; action?: 'install-agent' | 'update-agent' } | null
}

export function resolveTextRoute(input: {
  text: string
  agentCapabilities: GuestAgentCapability[] | null
  imeCurrent: boolean
  hasScrcpyControl: boolean
  prefer: TextInputMode
}): TextRouteDecision
```

The rung is attached to `input.text`'s reply and to the script `type()` result
as `via`, so F26's class of confusion is debuggable. `ScriptTypeResult` gains
`via` and `clobberedClipboard`.

**Session lifecycle.** `applyTextInput()` sits beside `applyRotation()` in
`createSession` (`packages/session/src/session.ts:240`), reads the current
`secure default_input_method`, runs `ime enable` + `ime set`, and returns a
revert thunk called next to the rotation revert on close — read first, restore
after, idempotent when called twice. `orientation.ts` is the template, verbatim
in shape.

### 4.6 Media scan (`packages/core/src/device/transfer.ts`)

```ts
// POST /:id/push body gains:
mediaScan: z.enum(['auto', 'always', 'never']).default('auto')

// PushResult gains:
mediaScan: { ran: boolean; method: 'scan_file' | 'scan_volume' | null; ms: number; error?: string }
```

`auto` scans when the resolved remote path is under a media root:

```ts
const MEDIA_ROOTS = ['/sdcard/DCIM', '/sdcard/Pictures', '/sdcard/Movies',
                     '/sdcard/Music', '/sdcard/Download',
                     '/storage/emulated/0/DCIM', /* …the same five */]
```

The command, in order, first one that exits 0 wins (H3):

```
content call --uri content://media --method scan_file  --arg <path>
content call --uri content://media --method scan_volume --arg external_primary
```

Failure is recorded in the result and never fails the push — the bytes landed
regardless. The `profile` is `appLifecycle`; a whole-volume scan on a full
`/sdcard` is not instant, which is another reason `scan_file` is tried first.

### 4.7 API surface

| Method | Path | Permission | Notes |
|---|---|---|---|
| `GET` | `/api/devices/:id/guest-agent` | `device.view` | **extended**: `versionCode`, `checkedAt`, `attempts`, `nextAttemptAt`; `state` becomes the §3.8 enum |
| `POST` | `/api/devices/:id/guest-agent` | `device.network` | unchanged verb, now delegates to `AgentProvisioner.ensure({ force: true })` |
| `DELETE` | `/api/devices/:id/guest-agent` | `device.network` | unchanged |
| `POST` | `/api/guest-agent/provision` | `device.admin` | **new** — fleet-wide, returns `AgentProvisionReport` |
| `GET` | `/api/guest-agent/summary` | `device.view` | **new** — `{ total, byState, byVersion }` for the Settings surface |
| `POST` | `/api/devices/:id/network/retry` | `device.network` | **new** — §3.7 rule 4; lease-gated like `enable` |
| `POST` | `/api/devices/:id/push` | unchanged | body gains `mediaScan` |

`GET /api/devices/:id/network` gains the `recovery` block (§3.7 rule 5).
`DeviceInfoSchema` (`packages/protocol/src/device.ts:34-86`) gains one field —
`agent: AgentState` — so the fleet list and the wall can render a chip without
a second request. Nothing else on that schema changes; it is deliberately the
narrow one.

### 4.8 Build and release

- `apps/guest-agent/app/build.gradle.kts`: Compose out, `isMinifyEnabled =
  true`, keep rules for `Tun2Socks` (JNI-resolved by name — non-negotiable),
  the four manifest components, and `EnkakuIme`.
- `versionCode` becomes the single source the manifest pins, incremented per
  release; `versionName` tracks the core's version.
- `.github/workflows/release.yml`: build the release APK on a `v*` tag, sign it
  with the CI keystore secret, publish it as a release asset, and print its
  sha256 and size. **The workflow fails if the APK exceeds a declared size
  budget**, so F1 cannot silently come back.
- `packages/toolchain/manifest/enkaku-tools.json`: a `guest-agent` entry —
  `format: 'raw'`, `swappable: false` (it is version-locked to the core exactly
  as `scrcpy-server` is, and for the same reason: the wire contract is shared),
  one `*` platform artefact, and a `deviceArtifact` with `packageName`,
  `versionCode`, and `signatureSha256`.

## 5. Implementation steps

Ordered by dependency, not by urgency. 90.1 is first because §3.11 makes it the
precondition for everything after it; 90.2 is second because 90.3 and 90.5 both
need the capability enum and the version rule to exist before they add to them.

### 90.1 — The APK earns mandatory install (fixes F1, F2, F3, F4, F5, F6)

> **Status: implemented and locally verified 2026-08-13.** JDK 17 (Homebrew
> keg) and the Android SDK (platform 36, build-tools 36.0.0, NDK
> 29.0.14206865) were both present in this environment, so `bun run
> build:guest-agent` was actually run rather than estimated — see the measured
> numbers below. What is **not** verified here, because it needs a real phone:
> `ENKAKU_TEST_DEVICE=1 bun run smoke:guest-agent` (pending — owner to run,
> exact command in the Verifiable result below). What is **not** verified
> anywhere yet, because it needs a production signing identity nobody but the
> repo owner should mint: a real, published, signed CI release — see the
> "Signing" note under `packages/toolchain/manifest/enkaku-tools.json` below.

- [x] `apps/guest-agent/.../StatusActivity.kt`: rewrite as a plain `Activity`
      with an XML layout — three `TextView`s (title, state line, explanation)
      and a **Switch keyboard** button. Delete `theme/Color.kt`,
      `theme/Theme.kt`, `theme/Type.kt`.
      Done: `StatusActivity.kt` now extends `android.app.Activity` (matching
      `BootstrapActivity`'s existing style) and inflates
      `res/layout/activity_status.xml` — a `title`/`state_line`/`explanation`
      `TextView` plus a `switch_keyboard_button` `Button`. The button checks
      `InputMethodManager.enabledInputMethodList` for
      `dev.enkaku.guestagent/.input.EnkakuIme` before calling
      `showInputMethodPicker()`; when the IME is absent (true on every build
      until 90.5 lands) it shows a `Toast` saying so instead of opening a
      picker with nothing useful in it. The three `theme/*.kt` files are
      deleted.
- [x] `app/build.gradle.kts`: remove the Compose BOM and every Compose /
      `*-compose` dependency, `buildFeatures.compose`, and the
      `compose-compiler` plugin. Set `isMinifyEnabled = true`.
      Done, plus a `signingConfigs { create("release") { ... } }` block gated
      on `ENKAKU_GUEST_AGENT_KEYSTORE_PATH` being set (§4.8: "sign it with the
      CI keystore secret") — unset locally, so `bun run build:guest-agent`
      still needs no secrets and produces the same unsigned artifact it always
      has. The root `build.gradle.kts` and `gradle/libs.versions.toml` also
      lost their now-unused `compose-compiler` plugin/version entries.
- [x] `app/proguard-rules.pro`: keep `dev.enkaku.guestagent.route.Tun2Socks`
      and its three native methods (**JNI resolves it by name at load time with
      no compile-time reference — stripping or renaming it breaks the library
      silently**), the four manifest-declared components, and
      `dev.enkaku.guestagent.input.EnkakuIme`.
      Done (the file did not exist before — `isMinifyEnabled` was `false`, so
      it was never read). Verified, not assumed: `unzip -p
      app-release-unsigned.apk classes.dex | strings | grep -i tun2socks`
      after a real R8 pass still shows `Tun2Socks`, `TProxyStartService`,
      `TProxyStopService`, `TProxyGetStats`, `BootstrapActivity`,
      `StatusActivity`, `ControlService`, `RouteVpnService` and `BootReceiver`
      by their exact names — R8 kept them, it did not just fail to find
      anything to strip.
- [x] `build.gradle.kts`: `versionCode` becomes release-driven, no longer `1`.
      Done: `versionCode`/`versionName` now read
      `ENKAKU_GUEST_AGENT_VERSION_CODE`/`_VERSION_NAME`, falling back to `1`/
      `"dev"` when unset (every local build). Verified both ends: unset →
      `aapt2 dump badging` reports `versionCode='1' versionName='dev'`; with
      `ENKAKU_GUEST_AGENT_VERSION_CODE=1008 ENKAKU_GUEST_AGENT_VERSION_NAME=0.1.8`
      set → reports `versionCode='1008' versionName='0.1.8'`.
- [x] `.github/workflows/release.yml`: build, sign, publish the APK on a `v*`
      tag; print sha256 and size; **fail the job above a declared size budget**.
      Done: a new `build-guest-agent` job (independent of `build-nix`/
      `build-darwin` — a separate toolchain) derives `versionCode`/`versionName`
      from `github.ref_name`, decodes `secrets.GUEST_AGENT_KEYSTORE_BASE64`,
      builds and signs, prints size and sha256, fails above a 4 MiB budget, and
      uploads the APK as an artifact. `publish` now `needs: [smoke,
      build-guest-agent]` and attaches `guest-agent.apk` to the GitHub Release
      alongside the core binaries. **Not run in real CI** (no push access to
      trigger it, and the four keystore secrets do not exist as repo secrets
      yet) — validated instead with `python3 -c "import yaml; yaml.safe_load(...)"`
      (parses) and `bash -n` on every embedded shell step (no syntax errors),
      plus the same versionCode-derivation logic exercised directly in a shell
      for both a real tag (`v0.1.8` → `1008`) and a non-tag ref (`main` → `0`,
      the `workflow_dispatch`-off-a-branch case named in the workflow's own
      header comment).
- [x] `packages/toolchain/manifest/enkaku-tools.json`: the `guest-agent` entry
      with `sha256` and a full `deviceArtifact` (§4.8).
      Done, `swappable: false` like `scrcpy-server` (§4.8's stated reason: the
      wire contract is shared with the core). **Honesty note, not an
      oversight:** `version`, the download `sha256`/`url`, and
      `deviceArtifact.versionCode` are `TODO-*`/`0` sentinels — the schema's
      own designed "parses but `manager.install()` refuses it"
      escape hatch (`ToolArtifactSchema`'s comment in
      `packages/toolchain/src/types.ts`) — because no signed release has
      actually been published; a fabricated-but-real-looking hash here would
      be strictly worse than a sentinel, since `downloadVerified` would then
      throw a confusing `E_CHECKSUM_MISMATCH` against whatever a real release
      actually hashes to, instead of `install()`'s clear, immediate
      `E_CHECKSUM_MISSING`. `deviceArtifact.signatureSha256`, by contrast, IS a
      real, freshly-generated value: `BAA2B36DD52BE50EAE2036404E130065EBF3836D904A6137D740FBE378EDB32F`,
      the certificate SHA-256 of a bootstrap keystore generated for this step
      (`keytool -genkeypair`, `apksigner verify --print-certs` to read the
      digest back) and confirmed by actually building AND signing a release
      APK with it end to end. This keystore is **not** committed anywhere and
      is not a production identity — it exists only so
      `deviceArtifactExpectation('guest-agent')` returns a real, correctly
      shaped `signatureSha256` (acceptance criterion 3) rather than an omitted
      field or a fabricated one. The repo owner must either (a) adopt this
      exact keystore as `GUEST_AGENT_KEYSTORE_BASE64` in CI (file handed off
      out of band, not printed in this document), or (b) generate their own
      and update `signatureSha256` here to match it — see
      `apps/guest-agent/README.md`'s "Signing" section, updated in this step
      with the full how-to. Shipping a real signed release with **either**
      keystore's hash NOT matching this field would make every device
      installation report `signature_mismatch` forever, so this is a hard
      prerequisite for turning on verification, not a formality.
- [x] `packages/toolchain/src/entrypoints.ts`: the `guest-agent` case, so
      `resolveToolPath` stops throwing `E_TOOL_UNKNOWN_ENTRYPOINT`.
      Done — `'guest-agent' → 'guest-agent.apk'`, matching the README's
      documented `<dataDir>/tools/guest-agent/<version>/guest-agent.apk` path.
- **Verifiable result:** `bun run build:guest-agent` produces a release APK
  whose measured size is recorded in this plan's acceptance criterion 1, the
  smoke test (`ENKAKU_TEST_DEVICE=1 bun run smoke:guest-agent`) passes all
  fifteen stages against the shrunk build, and `resolveToolPath('guest-agent')`
  resolves on a machine with no `apps/` directory beside the binary.
  **`bun run build:guest-agent`: done, measured (see acceptance criterion 1
  below).** `resolveToolPath('guest-agent')`: done, proven through the real
  `ToolchainManager` (not a stub) in
  `packages/toolchain/src/manager.test.ts`'s new `guest-agent (plan 90 §90.1 —
  fixes F5, F6)` describe block, against a bare OS tmpdir with no `apps/`
  anywhere near it. `ENKAKU_TEST_DEVICE=1 bun run smoke:guest-agent`:
  **pending — owner to run, on a physical phone.** Exact command:
  `ENKAKU_GUEST_AGENT_PATH=$PWD/apps/guest-agent/app/build/outputs/apk/release/app-release-unsigned.apk
  ENKAKU_TEST_DEVICE=1 bun run smoke:guest-agent -- --serial <SERIAL>` (point
  it at the shrunk local build explicitly — tier 2 would otherwise pick it up
  automatically, but being explicit here is worth one line). Outcome table to
  fill in:

  | Stage | Result |
  |---|---|
  | 1–15 (existing stages, against the shrunk build) | _(unfilled — needs hardware)_ |

  A pass here settles the part of H1/§3.11 that only a real device can answer:
  that R8 plus the new keep rules did not silently break anything at runtime —
  the static `strings`-on-`classes.dex` check above proves the *names*
  survived, not that the app still behaves correctly on a phone.

### 90.2 — Capability negotiation and the version-skew rule (fixes F38 gaps, F41; implements §3.9)

- [x] `Protocol.kt` and `packages/protocol/src/guest-agent.ts`: add
      `'screen-label'` and `'text-input'` to the capability list and its Zod
      mirror; correct the stale `egress-probe` comment (F41).
- [x] `packages/protocol/src/guest-agent.ts`: `TextCommitRequest/Result`,
      `TextStatusRequest/Result`, and plan 89 §4.5's three `label.*` shapes.
- [x] `packages/drivers/src/network/guest-agent/client.ts`: `textCommit`,
      `textStatus`, `labelApply`, `labelStatus`, `labelClear` — each present on
      the client always and **gated by the caller on `hello().capabilities`**,
      the pattern `probe`/`hold` already follow.
- [x] R1: a protocol-major mismatch stops being terminal — it marks the device
      `outdated` and hands it to the provisioner (90.3) for exactly one
      reinstall and re-handshake. Scoped to this step's ownership: `client.ts`
      still refuses to retry across the mismatch (unchanged), and now exports
      `GUEST_AGENT_REPAIRABLE_ERROR_CODES` — the seam a future
      `AgentProvisioner.ensure()` (90.3, not yet built, and outside this
      step's file ownership) is expected to check before treating the device
      as `outdated` and running one reinstall + re-`hello()`. The state and
      the wiring live in 90.3, not here.
- [x] R2 guard: a unit test asserting no source file in `packages/core` or
      `packages/drivers` compares `appVersion`
      (`packages/drivers/src/network/guest-agent/version-skew-guard.test.ts`).
      Proven to actually fire: a scratch file with `appVersion >= '1.2.0'` (and
      two other comparison shapes) was added under `packages/core/src/device/`,
      confirmed to fail the guard with the offending file and snippet named,
      then removed and confirmed green again.
- **Verifiable result:** a build advertising only the pre-plan-90 capability
  set is driven by a current host with no errors and no thrown
  `E_UNKNOWN_METHOD` — every new facet reports `unavailable` with a named
  reason instead. Proven against the real client in
  `client.test.ts`'s `'a build advertising only the pre-plan-90 capability
  set never throws E_UNKNOWN_METHOD when the host gates on
  hello().capabilities first'`.

### 90.3 — Provisioning: one agent on every phone (fixes F7, F9, F10; implements §3.8)

> **Status: implemented and tested in software, 2026-08-13.** See the plan's
> own top status line for the full account (what shipped, the one deliberate
> deviation from §4.7's literal text on `GET/POST/DELETE /:id/guest-agent`'s
> response shape, and the hardware-honesty pending table, H-90.3a/b/c).

- [x] `packages/core/src/device/agent-provisioner.ts`: new, per §4.3.
- [x] `packages/drivers/src/network/guest-agent/launcher.ts`: `ensureInstalled`
      switches from presence-only (`cmd package path`) to
      `verifyDeviceArtifact` with the one-repair-then-degrade rule, mirroring
      `ui-server/launcher.ts:167-222`.
      Done, plus `opts.force` (a new, small addition beyond a pure mirror) —
      R1's seam needs a way to skip the fast "already matches" path and go
      straight to uninstall/reinstall/reverify, since a live protocol
      mismatch caught by `hello()` is a fact the on-device artifact check
      alone cannot see. `isInstalled()` is deliberately untouched (still
      presence-only) — it is what the pre-plan-90 GET/POST/DELETE endpoints
      call, which this step leaves alone (see the deviation note above).
- [x] `packages/core/src/db/schema.ts` + a Drizzle migration: `devices.agent`
      JSON column, Zod-validated on read.
      Done — migration `0043_silly_living_mummy.sql`
      (`ALTER TABLE devices ADD agent text;`), read through
      `AgentStatusSchema.safeParse` with a `DEFAULT_AGENT_STATUS` fallback on
      a corrupt/pre-migration row (never a 500), the same discipline
      `readPersistedRoute` already uses for `network_route`.
- [x] Wire the four hooks: `onAdmitted`, `onDeviceReady`, core boot beside
      `reconcileNetworkRoutes`, and the two endpoints from §4.7.
      Done — traced through the real call graph rather than assumed:
      `onAdmitted` (`api/devices.ts`'s admit route) → `registry.admitted()` →
      (when the phone is connected right now) `onOnline()` → the SAME
      `onDeviceReady` callback `restoreNetworkRoute` already uses, so one
      wire in `daemon.ts`'s `onDeviceReady` covers both the "admission" and
      "device online" rows of §3.8's table — confirmed by reading
      `registry/device-registry.ts`'s `admitted()`/`onOnline()` line by line,
      not assumed from the table's own two-row shape. Core boot builds
      `agentProvisioner` right after `guestAgent` (needs
      `guestAgent.withGuestAgentClient`) and fires `ensureAll()`
      fire-and-forget for every device row, not only routed ones. The two
      §4.7 endpoints: `POST /:id/guest-agent` (existing) now also fires
      `agentProvisioner.ensure({force:true})` as a tolerated side effect
      (via an `agentProvisionerRef` forward-ref into `GuestAgentRoutesDeps`,
      same idiom as `onAdmitted`/`rescan`), and a new
      `POST /api/guest-agent/provision` / `GET /api/guest-agent/summary`
      pair (`createAgentProvisionerRoutes`, its own Hono app mounted at
      `/api/guest-agent` — NOT `/api/devices` — via `server/http.ts`, a
      necessary small addition outside this step's original file list,
      flagged in the top status line).
- [x] `packages/protocol/src/settings.ts`: the `guestAgent` block (§4.4).
      Already done by step 90.4 on this step's behalf (see that step's own
      status note) — nothing to add here.
- [x] `packages/protocol/src/device.ts`: `agent: AgentState` on
      `DeviceInfoSchema`.
      Done, alongside the new `AgentStateSchema`/`AgentStatusSchema`/
      `DEFAULT_AGENT_STATUS` this same file now exports (the canonical, Zod
      source of truth `agent-provisioner.ts` and `devices.agent`'s
      validation both import — never a second, hand-rolled interface).
- [x] `device.agent` event kind in `packages/protocol/src/messages/device-event.ts`.
      Done, one event per state TRANSITION only (a clean reconnect that
      changes nothing emits none — proven by test). `clipboard.overwritten`
      added in the SAME pass, on step 90.5's behalf, per this step's own
      instruction not to make 90.5 touch this single-owner file.
- [x] Failure policy: bounded retries, verbatim reason, **no quarantine, no
      block, no scheduling change** — assert it with a test that a `failed`
      agent leaves `DeviceStatus` untouched.
      Done — `packages/core/src/device/agent-provisioner.test.ts` asserts
      `devices.status`/`quarantineReason` are byte-for-byte unchanged after a
      failure, including when the device was ALREADY quarantined for an
      unrelated (thermal) reason, so a failing agent install cannot even
      accidentally ride along on an existing quarantine. Bounded retries:
      `[5, 20, 60]`s cooldown between AUTOMATIC calls, three attempts, then
      silent until an explicit `force:true` — proven, including that force
      gives a genuinely fresh budget rather than continuing an exhausted one
      (mirroring `POST .../network/retry`'s "honest version of the
      workaround" reasoning, §3.7 rule 4).
- **Verifiable result:** admit a phone with `guestAgent.provision: 'auto'` and
  no network route configured anywhere in the farm; the agent is installed,
  `hello` answers, and `GET /api/devices/:id/guest-agent` reports `ready` with
  a version and a capability list. Unplug and replug it: one verification pass
  runs, installs nothing, and logs nothing beyond a debug line. Set
  `ENKAKU_GUEST_AGENT_PATH` to a corrupt file: the device reports `failed` with
  the real reason, and still opens a session, streams video, and runs a job.
  **Proven in software** through `AgentProvisioner.ensure()`/`status()`/
  `ensureAll()` directly (`agent-provisioner.test.ts`, 30 tests) — `ready`
  with a real `appVersion`/`androidSdkInt`/`capabilities` list from a fake
  `hello()`, a clean reconnect emitting no event, and an `E_CHECKSUM_MISSING`-
  shaped launcher failure reported as `failed` with the verbatim message
  while `devices.status` stays untouched. **NOT proven against the literal
  `GET /api/devices/:id/guest-agent` endpoint named above** — that endpoint
  deliberately keeps its pre-plan-90 response shape (see the deviation note
  in the plan's top status line); the equivalent proof for it is
  `DeviceInfo.agent` and `GET /api/guest-agent/summary`, both exercised by
  test. The literal "unplug and replug a real phone" half is
  **pending — owner to run** — H-90.3a/b/c in the top status line give the
  exact commands.

  **Closed 2026-08-13 by the M61 hotfix pass (`docs/plans/96-m61-hotfixes.md`
  §96.9):** `DeviceInfo.agent` — this step's own producer,
  `packages/protocol/src/device.ts`'s `AgentStateSchema` field — had no
  READER: `rowToDeviceInfo()` in `packages/core/src/registry/device-registry.ts`
  never read `row.agent` back off the `devices.agent` column this step
  writes to, so every list/broadcast/detail response defaulted to `'absent'`
  regardless of what this step's own `AgentProvisioner` had computed and
  persisted. A new `deriveAgentState()` closes it — Zod-validated off
  `row.agent`, reached by every caller automatically since `agent` is a
  column already on every `DeviceRow`, not an accessor a caller could forget
  to thread. Additionally, `GET /api/devices/:id/guest-agent` (left on its
  pre-plan-90 shape by this step's own deliberate deviation, above) is now
  ALSO wired to `AgentProvisioner.status()` when the endpoint's dep is
  present — additively, per step 90.6's own "do not narrow" instruction — so
  the "NOT proven against the literal endpoint" line above is no longer the
  honest state of the world for a build with that wiring in place; see §96.9
  for the full account, including the new surface-level tests in
  `api/devices.test.ts` and `api/guest-agent.test.ts` that replace the
  helper-only proof this step originally shipped.

### 90.4 — Route recovery that knows the device came back (fixes F13–F20; answers plan 54 §9 Q2)

- [x] `packages/core/src/api/guest-agent.ts`: `handleDeviceOffline` stamps
      `offlineAt` on the recovery state instead of leaving it untouched (and
      still does **not** delete it).
- [x] `restoreDeviceRoute`'s **enabled** branch calls
      `resetRecoveryOnReconnect(deviceId)`, which clears `attempts`/`exhausted`
      only when `offlineAt > exhaustedAt`, and increments `reconnectCycles`.
- [x] The hourly-decaying `reconnectCycles` breaker at
      `guestAgent.maxRecoveryCyclesPerHour`, with one `warn` when it engages.
- [x] `RECOVERY_REARM_S` → `guestAgent.recoveryRearmSec` (default 120).
- [x] `POST /api/devices/:id/network/retry` — lease-gated, resets and applies
      once.
- [x] `recovery` block on the network status; `network.recovery.exhausted` and
      `network.recovery.recovered` event kinds.
- [x] `docs/plans/54-m24d-fail-closed-and-route-recovery.md` §9 Q2: record that
      it is answered here, with the answer.
- **Verifiable result — split, per this plan's own hardware-honesty rule:**
  - **Implemented and tested (2026-08-13), through the real handlers, never
    an internal-only call:** `packages/core/src/api/guest-agent.test.ts`'s new
    `describe('plan 90 §3.7 — ...')` block drives `handleDeviceOffline` and
    `restoreDeviceRoute` exactly as `daemon.ts`'s hooks would, under a faked
    `Date.now()` (real clocks are the wrong tool for a sub-second, deterministic
    test — see `withFakeClock`'s own doc comment) and asserts every claim from
    `GET /:id/network`'s JSON body and the recorded device event log, never
    from `recoveryByDevice` directly (this test file cannot reach it in any
    case — it is a closure-private map):
    - A bare `restoreDeviceRoute` call after exhaustion — no offline event in
      between — makes **no** further attempt (F16's wrong-branch reset, left
      exactly where it was, does not fire here either).
    - `handleDeviceOffline` then `restoreDeviceRoute` **does** reset the bound
      and applies again immediately (`recovery.exhausted` flips back to
      `false`, `recovery.attempts` back to 1 — a fresh budget, not attempt 4
      of 3).
    - `network.recovery.exhausted` and `network.recovery.recovered` both land
      on the device event log.
    - Six simulated replugs inside one fake hour engage the
      `reconnectCycles` breaker on the fifth (`recovery.reconnectCycles`
      caps at the configured 4 and climbs no further), and the breaker's
      `warn` is logged **exactly once**, not once per refused reset.
    - `POST /:id/network/retry` clears an exhausted bound and applies once
      immediately, refuses with no held lease or no enabled route, and never
      leaves the misleading "route is off" state disable-then-enable passes
      through.
  - **Pending — owner to run.** The plan's own words — "then physically
    replug the device" — are a literal instruction to disconnect real
    hardware, which this run forbade outright. What is asserted above is the
    host-side state machine end to end; what is NOT yet observed is a real
    Android device's adb transport actually dropping to `offline` and back
    (the trigger `daemon.ts`'s `onDeviceReady`/`handleDeviceOffline` hooks
    fire from), and a real on-device dead-man's-switch trip (F18) producing
    the `held` state this recovery is applying against. Exact steps, against
    a phone already enrolled with a working (or deliberately misconfigured)
    SOCKS5 route:

    ```bash
    # 0. Core running locally with the phone enrolled over USB (bun run dev),
    #    a route configured and enabled on it (Studio's Network tab), and
    #    guestAgent.maxRecoveryCyclesPerHour left at its default (4) so "the
    #    fifth replug" below matches this plan's own wording exactly.

    # 1. Point the route at an upstream that will never answer, so recovery
    #    is guaranteed to exhaust rather than race a real proxy's own
    #    latency (e.g. 203.0.113.1:1080 — TEST-NET-3, guaranteed unreachable).
    #    Confirm exhaustion from the API, not the UI:
    curl -s http://localhost:7700/api/devices/<id>/network | python3 -m json.tool
    #    Expect, within a few tens of seconds: recovery.exhausted == true,
    #    recovery.attempts == 3.

    # 2. Physically unplug the USB cable, wait for the device to read
    #    `offline` in Studio's device list (or `GET /api/devices/<id>` —
    #    `status: "offline"`), then replug it.

    # 3. Watch the log for the reconnect reset and the recovered/attempt
    #    line, and re-poll network status:
    curl -s http://localhost:7700/api/devices/<id>/network | python3 -m json.tool
    #    Expect: recovery.exhausted == false shortly after reconnect (a
    #    fresh attempt), NOT a wait for recoveryRearmSec (120s default) to
    #    elapse — that is the whole point of this step over the pre-90.4
    #    behaviour, which left `enabled: true, up: false` until an operator
    #    opened the UI and toggled the route.

    # 4. Repeat step 2 (unplug/replug) six times within an hour, reading
    #    recovery.reconnectCycles after each — and grep the core's log for
    #    "reconnect-cycle breaker is engaged":
    grep "reconnect-cycle breaker is engaged" <core log>
    ```

    | Reading | Verdict / effect |
    |---|---|
    | Step 3's `recovery.exhausted` reads `false` and traffic resumes within roughly one heartbeat (≤20s) of the replug, well under `recoveryRearmSec` | The fix holds on real hardware — F16 is closed, plan 54 §9 Q2's answer stands. |
    | Step 3's `recovery.exhausted` stays `true` past a heartbeat or two | H5 (§0.2) does not fully hold — the next suspect is the on-device side named in §9 Q3 (`route.start` arriving mid-teardown, or `RouteVpnService.handleFailure` reaching a state `route.start` does not clear), which is explicitly out of this step's scope and belongs in its own plan. |
    | Step 4's `recovery.reconnectCycles` caps at 4 and the breaker log line appears exactly once across the six replugs | The breaker holds on real hardware exactly as the faked-clock test predicts. |
    | Step 4's `reconnectCycles` climbs past 4, or the breaker line repeats | The breaker's `breakerWarned` bookkeeping or the rolling-window filter has a real-clock edge case the faked-clock test did not reproduce — worth a follow-up with the exact wall-clock deltas recorded. |

    This mirrors plan 88's H1/H3 rows exactly: the code and its unit tests
    land regardless of this outcome, because the implementation does not
    branch on an assumption about real hardware timing — it reacts to
    `status === 'offline'`/`'online'` transitions the daemon already reports
    today, the same hook `restoreDeviceRoute` used before this plan.

### 90.5 — The keyboard, and text that is not ASCII-only (fixes F21, F23, F24, F25, F26; implements §3.2, §3.3)

- [x] `apps/guest-agent/.../input/EnkakuIme.kt` +
      `input/TextFacet.kt`; the `<service>` with `BIND_INPUT_METHOD` and its
      `res/xml/method.xml`; the visible one-line view with the keyboard-picker
      button (§4.2).
- [x] `ControlService.kt`: `text.commit` / `text.status` branches, with wire
      re-validation in the house style.
- [x] `packages/session/src/text-input.ts`: `resolveTextRoute` (§4.5).
- [x] `packages/session/src/session.ts`: `applyTextInput()` beside
      `applyRotation()` (`:240`) and its revert beside the rotation revert —
      read first, restore after, idempotent.
- [x] `packages/protocol/src/settings.ts`: `DeviceSettings.prep.textInput` —
      already landed by step 90.4's Task A (its own status note above); this
      step only reads it.
- [x] `packages/drivers/src/descriptors.ts`: `text-unicode` on the engines that
      have it; `text-ascii` becomes a capability the resolver **reads** (F25).
- [x] `packages/core/src/server/ws-handlers.ts` + `device-executor.ts`: route
      through the resolver, return `via`, and refuse with a named precondition
      (plan 59) rather than letting `INPUT_TEXT_UNSUPPORTED` escape a driver.
- [x] `packages/studio/src/components/LiveView.tsx:386-401`: accept any
      printable code point; stop dropping non-ASCII silently; surface the
      precondition inline when the resolved rung is ASCII-only. Allow the paste
      chord through to the clipboard path instead of returning early.
- [x] `clipboard.overwritten` event when rung 3 is used — step 90.3 landed the
      event kind in `packages/protocol/src/messages/device-event.ts` on this
      step's behalf (that file's single-owner rule) while this step was in
      progress; the recorder call in `ws-handlers.ts` was wired the moment it
      appeared.
- **Status (2026-08-13), done and tested in software.** `resolveTextRoute`'s
  full ladder is unit-tested directly (`packages/session/src/text-input.test.ts`,
  21 tests): every rung (`agent-ime`, `scrcpy-text`, `adb-ascii`), `prefer`'s
  three modes including the `'agent'` mode's two distinct precondition
  messages (`E_TEXT_AGENT_UNAVAILABLE` vs `E_TEXT_AGENT_IME_NOT_CURRENT`), and
  the **F25 fix itself**: forcing `adb-input` on non-ASCII text
  (`hasScrcpyControl: false`) produces `unmet: { code: 'E_TEXT_UNICODE_UNSUPPORTED',
  action: 'install-agent' }` rather than ever reaching a driver. `applyTextInput`
  is unit-tested for the `orientation.ts` contract this step's brief demanded:
  read-first, idempotent double-revert, an unreadable prior value left
  untouched rather than guessed, and a failed shell command swallowed
  (`text-input.test.ts`'s second `describe` block, 10 tests). `session.test.ts`
  gains a `createSession — text-input keyboard` block (7 tests) proving the
  wiring itself: `mode: 'device'` never touches the IME even with a capable
  agent wired; a wired, capable agent gets `ime enable`/`ime set` at session
  start; `close()`'s restore is idempotent across two calls; and
  `DeviceSession.textInput.commitViaAgent` both throws
  `E_TEXT_AGENT_UNAVAILABLE` with no client wired and calls the real
  `GuestAgentClient.textCommit` when one is. `packages/core/src/server/
  ws-handlers-text.test.ts` (new, 6 tests) proves the WS-level wiring against
  the REAL `createWsMessageHandler`: rung 1 calls `commitViaAgent` and never
  touches the driver; rung 2 and rung 4 call the driver and report the right
  `via`; the F25 precondition refuses over the wire with `E_TEXT_UNICODE_UNSUPPORTED`
  and `action: 'install-agent'` while the driver's `text()` is never called;
  no lease refuses before the resolver runs at all; `prefer: 'device'` skips a
  usable agent end to end.
  **An honest architectural finding, not a defect left unfixed:** rung 3
  (`clipboard`) is fully implemented — `ws-handlers.ts` and
  `device-executor.ts` both have a real branch for it, `clobbersClipboard`
  and the `clipboard.overwritten` event are wired — but `resolveTextRoute`
  never actually SELECTS it given this step's exact 5-field signature. Rung 2
  and rung 3 share an identical structural precondition
  (`hasScrcpyControl` — a scrcpy control socket), rung 2 has no side effect
  and rung 3 does, so rung 2 always wins whenever both are structurally
  available; and rung 3's OWN precondition additionally needs "a paste-capable
  focused field", a fact this resolver has no parameter to receive and could
  not act on differently even if it did (no live per-field feedback loop
  exists). The four-rung table (§3.3) is honoured exactly as written — "used
  only when rungs 1–2 are unavailable" is a true, checked implication in the
  code — it is simply never satisfied by any input this codebase can produce
  today, given that `adb-input` (the one engine with no scrcpy control socket)
  cannot reach the clipboard's `paste` flag either (F24). Recorded here rather
  than silently shipping an unreachable branch with no note.
  **Kotlin-side hardware verification and the `SIGKILL` revert claim are
  pending — owner to run**, exact commands and an outcome table below (mirrors
  plan 88's H1/H3 style), since this session must never run anything against a
  physical device.

  **H-90.5a — typing on a real phone (settles smoke stage 17, criteria 14–15).**
  Prerequisites: the guest agent installed and `ready` on an enrolled device
  (`agent-provisioner`, step 90.3); a session open on it from Studio;
  `prep.textInput: 'auto'` (the default). **Updated 2026-08-13:** before the
  M61 hotfix pass (`docs/plans/96-m61-hotfixes.md` §96.6), step 1 below could
  never have reached `via: 'agent-ime'` on ANY build, on ANY device, no
  matter how correctly the phone/agent behaved — `daemon.ts` never passed
  `withGuestAgentClient` into `createSessionManager`, so every session's
  `agentCapabilities` read `null` regardless of hardware. §96.6 fixed that
  production wiring gap; the checks below are unchanged and, as of that fix,
  are finally capable of exercising the real path they were written to
  exercise. Still not run against a physical device by this pass, per the
  hardware-honesty rule.

  ```bash
  # 0. Core running locally (bun run dev), the device enrolled and showing
  #    ready in the Network/Agent panel, a manual session open in Studio.

  # 1. Click into a text field on the device (e.g. a Notes app, or any app's
  #    search box) so it has focus, then type into Studio's canvas:
  #      こんにちは 👋
  # 2. Read what actually landed and via what path:
  .dev-data/tools/adb/*/platform-tools/adb -s <serial> shell \
    dumpsys input_method | grep -i 'mCurMethodId'
  #    Expect: dev.enkaku.guestagent/.input.EnkakuIme
  # Studio's own reply already reports `via` per keystroke burst — read the
  # Network tab (or the browser devtools WS frame log) for `input.text.result`.

  # 3. Confirm the clipboard was NOT touched (rung 1 has no side effect):
  adb -s <serial> shell cmd clipboard get-primary-clip 2>/dev/null || true
  #    (or: paste into a second field by hand and confirm it is NOT
  #    "こんにちは 👋" — the clipboard should hold whatever it held before.)

  # 4. Uninstall the agent (Studio's Network/Agent panel "Remove", or
  #    `adb uninstall dev.enkaku.guestagent`) and repeat step 1. Expect the
  #    same string to still land, `via: 'scrcpy-text'` this time.

  # 5. Force the ASCII-only fallback: set DeviceSettings.engines.input to
  #    adb-input for this device (Settings → Engines) and repeat step 1 with
  #    a non-ASCII string. Expect Studio's inline banner (not a dropped
  #    keystroke) naming the missing path and suggesting the agent install.
  ```

  | Outcome | Reading |
  |---|---|
  | Step 1–3 all as expected | H4/criterion 14 confirmed — the agent path is real, unicode, and side-effect-free on real hardware, not only against a faked `GuestAgentClientRunner`. |
  | Step 1 lands the text but `mCurMethodId` is NOT the Enkaku IME | `ime set` did not take on this OEM/Android build — `session.textInput.imeCurrent` should have read `false` and the resolver should have fallen to rung 2; if the text still landed via `via: 'agent-ime'` this is a real bug in the read-back logic, not a hardware quirk, and should be filed against `applyTextInput`. |
  | Step 4 fails to type anything | `hasScrcpyControl` was true but rung 2 did not actually deliver — check whether this device's scrcpy session genuinely has a live control socket; this would be the first real evidence against F22's "unicode-clean on both engines" claim. |
  | Step 5 drops the keystroke instead of showing the banner | A real defect in the LiveView wiring — file against `LiveView.tsx`'s `flushText`/`ws.request` error handling. |

  **H-90.5b — the `SIGKILL` mid-session revert (settles smoke stage 18, criterion 16).**

  ```bash
  # 0. Core running locally, a session open on an enrolled device with the
  #    agent's IME confirmed active (H-90.5a step 2).
  ps -Ao pid=,command= | grep -i "[o]penpf"   # find the core's own pid
  kill -9 <core-pid>                          # SIGKILL, not a normal stop
  bun run dev                                 # restart the core fresh
  # 1. Open a NEW session on the same device and check its default IME
  #    BEFORE this new session applies anything:
  adb -s <serial> shell settings get secure default_input_method
  #    Expect: still the Enkaku IME (dev.enkaku.guestagent/.input.EnkakuIme)
  #    — the kill really did skip the revert, exactly as predicted.
  # 2. Confirm the device is NOT wedged: tap the "Switch keyboard" button on
  #    the Enkaku keyboard's own visible strip (or StatusActivity's button)
  #    and confirm the system picker opens and the human's own keyboard is
  #    selectable — this is H4's actual claim ("no device is left wedged"),
  #    separate from whether the ORIGINAL IME is auto-restored.
  # 3. Close the new session normally and check default_input_method again —
  #    it restores to whatever THIS session captured as "previous" (the
  #    Enkaku IME itself, since step 1 found it already switched) — a known,
  #    accepted limitation shared by every prep-scoped setting in this
  #    codebase (rotation, farm-tag): a value never reverted before a second
  #    apply captures the ALREADY-SWITCHED value as "prior", not the
  #    original. Recovering the TRUE original after a kill would need a
  #    device-scoped (not session-scoped) memory of it, which prep.rotation
  #    does not have either — out of this step's scope.
  ```

  | Outcome | Reading |
  |---|---|
  | Step 1 shows the Enkaku IME still active, step 2's picker opens and the human's keyboard is selectable | H4 confirmed as this step actually promises: no device is left wedged, even though the exact original IME is not auto-recovered after a kill (see step 3's note) — matches every other prep-scoped setting's existing, accepted contract. |
  | Step 2's picker does NOT open, or the human's own keyboard is missing from it | A real defect — `EnkakuIme`'s manifest/`BIND_INPUT_METHOD` wiring or `StatusActivity`'s enabled-list check needs investigation; this would be the one true "wedged" failure mode this step exists to prevent. |

  **H-90.5c — the label facets (Task B, no step in this plan assigned them —
  see the new checklist block below). Pending — owner to run**, same
  discipline: `adb shell am startservice` cannot reach `label.apply` directly
  (it is behind the pairing-token-gated control socket, same as every other
  method) — drive it through a real `GuestAgentClient.labelApply(...)` call
  from a short Bun script using `packages/drivers/src/network/guest-agent/
  client.ts`'s `createGuestAgentClient`, against the `adb forward` port the
  provisioner already opens. Confirm: the wallpaper renders solid black with
  the name centred above the number, both centred as a block, legible from a
  metre away; a second `label.apply` with the same fingerprint is a no-op that
  still returns live `wallpaperId`s; `label.clear` restores the original
  wallpaper (or the system default if `originalCaptured` was `false`).

### 90.5+ — The screen-label facet (Task B — a gap in this plan, not a numbered step)

**No step in §5 assigned this facet.** Plan 89 §4.2 line 844 lists
`label/LabelRenderer.kt` and `WallpaperFacet.kt` as NEW app files it depends
on; plan 89's acceptance criterion 17 requires `label.apply`/`label.status`/
`label.clear` to work; plan 89 line 121 says explicitly *"Not the guest
agent's Kotlin side. Plan 90 owns the APK."* — yet steps 90.1–90.8 above never
build them, and step 90.2 already added `'screen-label'` to `Protocol.CAPABILITIES`
(`Protocol.kt`'s own doc comment on that list said so plainly: *"the facet
that actually backs these methods... [is] NOT built yet, and plan 90's own §5
step list... does not currently assign them to a numbered step at all"*).
Each plan assumed the other built it. This block exists because step 90.5 is
the only worker who holds `ControlService.kt` and can add these branches
without colliding with a concurrent worker, and because shipping a release
with `screen-label` advertised and nothing behind it is exactly the hazard
`CLAUDE.md`'s `vpn-helper` rule warns against — a capability nothing on the
device answers.

- [x] `apps/guest-agent/.../label/LabelRenderer.kt` — draws the label bitmap
      on-device per plan 89 §4.4's geometry (solid black, white text, the
      device name centred above the number, both lines centred as a block;
      cap-height fractions of the panel's short edge, not dp; a centre-safe
      0.8 square so one bitmap serves both orientations; ellipsised to fit;
      `showName: false` — a `null` name — raises the number to 32%).
- [x] `apps/guest-agent/.../label/WallpaperFacet.kt` — applies it through
      `WallpaperManager`, implementing plan 89 §4.5's five behavioural
      requirements: `applied` reports what actually took (`home`/`lock`
      independently, so an OEM that swallows the lock screen produces
      `['home']`); an unchanged fingerprint is a cheap no-op that still
      returns live `wallpaperId`s; the original wallpaper is captured once,
      honestly (`originalCaptured` is never an optimistic `true`); `label.clear`
      is idempotent, consulting no "already cleared" flag; `rendererVersion`
      is an integer this object owns (`RENDERER_VERSION = 1`).
- [x] `ControlService.kt`: `label.apply` / `label.status` / `label.clear`
      branches against step 90.2's protocol shapes, with the same wire
      re-validation discipline as every other branch, plus the
      `JSONObject.NULL` handling `.nullable()` result fields need (the first
      ones on this wire that are genuinely nullable rather than optional —
      `org.json.JSONObject.put(key, null)` silently REMOVES the key instead
      of emitting a JSON `null`, which every other branch on this file
      sidesteps by using `.optional()` fields instead).
- [x] `AndroidManifest.xml`: `<uses-permission android:name=
      "android.permission.SET_WALLPAPER" />` — a normal, install-time
      permission; no `appops` step, unlike `ACTIVATE_VPN`/`mock_location`.
- **Design, exactly as specified — nothing invented.** Solid black wallpaper,
  `<DEVICE_NAME>` and the device number centred, on two lines — matches plan
  89 §4.4's layout precisely (name line above, number line below, both
  centred).
- **What this block does NOT include**, and whose absence is the reason
  criterion 17 (plan 90 §6) is only partially satisfiable from software: the
  HOST-side caller. Plan 89 §4.6's `LabellingService`
  (`packages/core/src/device/labelling.ts`) — the piece that computes the
  fingerprint, calls `GuestAgentClient.labelApply` at the right moments
  (reconnect, rename, an explicit action), and renders the Studio side — was
  never in this step's file allowlist and is not built here. The device-side
  contract plan 89 §4.5 asked for is complete and real; nothing on the host
  calls it yet. This is the SAME shape of gap plan 89 §4.5 itself named for
  the agent as a whole before step 90.3 closed it ("a farm that never
  configures a proxy has no agent on any phone") — here it is one facet
  short of a caller, not the whole agent.
- **Verifiable result (device-side only):** a `GuestAgentClient.labelApply({
  fingerprint, number: '7', name: 'Pixel 5', surfaces: ['home', 'lock'] })`
  call renders and sets a solid-black wallpaper reading "Pixel 5" above "7",
  both centred; a second call with the same fingerprint is a no-op that still
  reports live `wallpaperId`s; `label.status` reports `matchesOurs: true`
  until something else changes the wallpaper; `label.clear` restores the
  captured original (or the system default) and is safe to call twice.
  **Pending — owner to run** — H-90.5c above has the exact commands.

### 90.6 — The agent is visible (fixes F10, F11, F20; implements §3.9's operator half)

> **Status: implemented and tested in software, 2026-08-13.** All six items
> below are done; `bash scripts/typecheck.sh` (15/15), `bun test` (3363
> pass, 0 fail — includes ten new tests in `packages/protocol/src/api/
> devices.test.ts`), `bun run --cwd packages/studio test` (655 pass, 0 fail,
> up from the 631 baseline — +24 net new/rewritten tests across
> `AgentPanel.test.tsx` (new, 6), `NetworkPanel.test.tsx` (rewritten for the
> panel's new shape, 5), `NetworkRouteForm.test.tsx` (+3 recovery tests),
> `DeviceCard.test.tsx` (+4), `WallTile.test.tsx` (new, 4), `DeviceHeader.
> test.tsx` (+6), `settings/page.test.tsx` (+2)), and `bun run --cwd
> packages/studio build` are all green.
>
> **The one thing this step was told it MUST do** — widen
> `GuestAgentStatusResponseSchema.state` (`packages/protocol/src/api/
> devices.ts`) to carry `outdated`/`failed` alongside the pre-plan-90 five,
> and update every Studio branch that reads it — is done as an additive
> widen (seven values total, not a replacement of the five): the endpoint
> behind `GET /:id/guest-agent` (`packages/core/src/api/guest-agent.ts`,
> outside this step's file allowlist — see below) still emits only the
> pre-plan-90 five, so replacing the enum outright would have made every
> live response fail its own schema. `AgentStateBadge.tsx`'s `LABEL`/`TONE`
> records (the exhaustive `Record<GuestAgentState, string>` that forced this
> at the type level) gained `outdated`/`failed` entries; `AgentPanel.tsx`
> and `NetworkPanel.tsx` both render every one of the seven states, proven
> against the real schema — not a hand-rolled fixture — via
> `renderWithApi`. `packages/protocol/src/api/devices.test.ts` (new) proves
> the PARSE half (a response carrying `outdated` and one carrying `failed`
> both `.parse()` successfully, plus the pre-plan-90 five still do and an
> unrecognised value still does not); `AgentPanel.test.tsx` and
> `NetworkPanel.test.tsx` prove the RENDER half against those same two
> states, end to end through `api()`'s real `.safeParse()` — never a bare
> cast.
>
> Also added to the same schema, matching §4.7's stated shape:
> `versionCode`/`checkedAt`/`attempts`/`nextAttemptAt`, all optional (no
> producer on this endpoint yet, see the honesty note below); `recovery`
> on `DeviceNetworkStatusResponseSchema` (step 90.4 already computes and
> returns this field from `currentNetworkStatus()` — core's actual JSON
> response already carries it — but never declared it on the protocol
> schema Studio parses against, so it was invisible to any caller using
> `api()`'s validated path); and two new schemas,
> `AgentProvisionReportSchema`/`GuestAgentSummaryResponseSchema`, for the
> fleet-wide endpoints 90.3 shipped with no declared response shape.
>
> - [x] `packages/studio/src/components/guest-agent/AgentPanel.tsx` (new): the
>       device page's **Agent** tab, beside **Network**. Renders `state`
>       (`AgentStateBadge`), `appVersion`, `androidSdkInt`, `reason`, the
>       capability list grouped into the four named facets ("Network route" ←
>       `socks5-route`/`vpn-status`/`egress-probe`/`route-hold`, "Screen
>       label" ← `screen-label`, "Keyboard" ← `text-input`, "Location" ←
>       `mock-location`, deduped and in that fixed order — never the raw
>       wire strings, proven by test), `checkedAt` (rendered `—` today, see
>       the honesty note), and one primary action per state: Install
>       (`not-installed`), Retry (`installed`/`unreachable`/`failed`),
>       Update agent (`outdated`), none (`ready`/`unsupported`) — plus Remove
>       (uninstall) whenever a package might actually be on the device.
>       Fetches/mutates through `api()` + `GuestAgentStatusResponseSchema`
>       (validated), not the old unvalidated `fetchGuestAgentStatus` cast —
>       polls every 4s while an install/repair/retry/update is in flight,
>       the same "a dying request is not a failed operation" discipline the
>       old `NetworkPanel` block used, moved here with it.
> - [x] `NetworkPanel.tsx`: the whole install/repair/uninstall block is gone;
>       replaced by a one-line `next/link` summary (state badge + "Install,
>       update, or view capabilities in the Agent tab →") to
>       `/device?id=...&tab=agent`. Still fetches `GET .../guest-agent` once
>       (via the existing `fetchGuestAgentStatus`) — needed to gate whether
>       `NetworkRouteForm` renders (`state === 'ready'`), which is this
>       panel's own concern, not agent lifecycle. `deviceLabel` prop dropped
>       (nothing left in this file reads it); the one call site
>       (`app/device/page.tsx`) updated in the same pass.
> - [x] `NetworkRouteForm.tsx`: a `describeRecovery()` helper (reusing
>       `duration()` from `lib/format.ts` as a countdown formatter — the same
>       function already used for elapsed time, reused rather than
>       reimplemented, matching the *"retrying in 14s (attempt 2 of 3)"* /
>       *"gave up after 3 attempts — retrying in 1m 47s"* shapes) renders in
>       TWO places, both cited by this step: inline in the on/off toggle
>       banner (a short line + a compact **Retry now** button, shown only
>       while `recovery.attempts > 0`) and as a full breakdown in the route
>       status panel (attempts/maxAttempts/exhausted/nextAttemptAt/
>       reconnectCycles, plus its own **Retry now**, shown whenever
>       `recovery !== null`). Both call the new `retryNetworkRoute()`
>       (`lib/api.ts`) → `POST /:id/network/retry` — the endpoint step 90.4
>       already built and this step had not yet wired into Studio. Ticks
>       live via `useNow()`, the same shared-interval pattern every other
>       countdown in Studio already uses.
> - [x] `DeviceHeader.tsx`: an `agentVersion?: string | null` prop (fetched
>       once at the page level via the existing `fetchGuestAgentStatus`,
>       since this component keeps no hooks of its own) renders as a
>       `Row` inside the existing `ⓘ` "this device" popover — the file's own
>       placement rule for looked-up facts, followed rather than invented.
>       An `AgentAlertChip` (new, see below) sits in the always-visible meta
>       row beside the inspector-fallback badge, reading `device.agent`
>       directly (the coarse `AgentState` field `DeviceInfoSchema` already
>       carries) — quiet for `ready`/`absent`/`provisioning`/`unsupported`,
>       the identical restraint `inspectorFallback` already practises on
>       this exact row.
> - [x] `packages/studio/src/components/guest-agent/AgentAlertChip.tsx` (new,
>       shared): the one place `failed`/`outdated` become a small warning
>       chip; `ready`/`absent`/anything else renders nothing. Used by
>       `DeviceHeader.tsx`, `DeviceCard.tsx`, and `WallTile.tsx` — one
>       component, one rule, instead of three copies that could drift.
> - [x] `DeviceCard.tsx` / `WallTile.tsx`: `<AgentAlertChip agent={device.agent
>       ?? 'absent'} />` — a chip only for `failed`/`outdated`; `ready` and
>       `absent` stay quiet, proven by test (a healthy fleet's cards/tiles
>       render no agent chip at all).
> - [x] `packages/studio/src/app/settings/page.tsx`: `GuestAgentSummarySection`
>       (new), wired into the `guest-agent` tab `farmSections.ts` already
>       reserved for this (that file's own comment named this step by
>       number). Renders `GET /api/guest-agent/summary` as *"{N} of {M}
>       devices on {version}"* (the modal version, `unknown` excluded from
>       the pick) plus a breakdown chip row for every non-zero state in a
>       fixed order (ready, outdated, failed, installing, never
>       provisioned, unsupported), and a **Provision all** button →
>       `POST /api/guest-agent/provision` (`AgentProvisionReportSchema`),
>       re-loading the summary on success.
>
> **An honest, load-bearing gap this step found and could not close, flagged
> rather than worked around:** `DeviceInfoSchema.agent` (the coarse field
> `AgentAlertChip` reads on `DeviceCard`/`WallTile`/`DeviceHeader`) has a
> real schema slot but **no producer**. `packages/core/src/registry/
> device-registry.ts`'s `rowToDeviceInfo()` — the one function that turns a
> `devices` row into the JSON every list/broadcast actually sends — never
> reads `row.agent` and never sets the `agent` field on the object it hands
> to `DeviceInfoSchema.parse()`, so the schema's own `.default('absent')`
> fires on literally every device, on every real request, regardless of
> what `AgentProvisioner` actually computed and persisted. The chips this
> step built are correctly wired (proven by test: given `agent: 'failed'`,
> a chip renders) and will start telling the truth the moment that one-line
> read lands — but until it does, no device anywhere will ever show a
> `failed`/`outdated` chip on the fleet card, the wall, or the device
> header, no matter what state the agent is genuinely in. `device-
> registry.ts` was outside this step's file allowlist (not listed among the
> files this step owns, and already carrying an unrelated 231-line diff
> from concurrent work — confirmed by `git diff --stat` — at the time this
> step ran), so it was not touched, per this step's own explicit
> instruction to stop and report rather than reach for a file outside its
> list. **The fix is one line**: `rowToDeviceInfo()` needs an `agent:
> AgentState` parameter (the exact same shape `heldBy`/`readiness` already
> use) threaded from `row.agent` (Zod-validated the same way
> `agent-provisioner.ts`'s own `readCached()` already does it), and its
> callers need to pass it.
>
> **A second, smaller honest gap, already flagged in the widened schema's
> own doc comment:** `versionCode`/`checkedAt`/`attempts`/`nextAttemptAt` on
> `GuestAgentStatusResponseSchema` have no producer either, for the same
> reason `state` could only be additively widened — `GET /:id/guest-agent`'s
> handler (`packages/core/src/api/guest-agent.ts`'s `statusOf`/
> `installAndProbe`) is independent of `AgentProvisioner` and was not, and
> could not be, rewired here (same file-allowlist boundary). `AgentPanel`
> renders `checkedAt` as `—` — the same "no data" convention every other
> looked-up fact in this codebase already uses (`DeviceHeader`'s popover),
> never a fake timestamp — and does not render `versionCode`/`attempts`/
> `nextAttemptAt` at all, since this step's own instructions were explicit
> that a field with no producer should not get a permanent placeholder.
> Migrating that endpoint's handler onto `AgentProvisioner.status()` (which
> already has every one of these fields, persisted, right now) is the
> follow-up this gap and the one above both point at — one file,
> `packages/core/src/api/guest-agent.ts`, currently held by concurrent work.
>
> **Pending — owner to run** (hardware honesty — nothing above needed a
> physical device to build or verify; the code and its tests never branch
> on real-hardware timing, only on API response shapes, so this is a
> confirmation, not a prerequisite):
>
> | # | Claim | Exact command | What confirms it |
> |---|---|---|---|
> | H-90.6a | The Agent tab, the Network tab's one-line summary, `DeviceHeader`'s chip/popover version, and the fleet card/wall/Settings chips all render correctly against a REAL core and a real (or simulated-absent) agent — not just the mocked `renderWithApi` fixtures this step's tests use | `bun run dev` and `bun run dev:studio`, enrol a phone, open `/device?id=<id>` and click the **Agent** tab; separately open `/settings?tab=guest-agent` | The Agent tab shows a real `state`/`appVersion`/capabilities (once `ready`); the Network tab shows the one-line summary linking there; the device header's `ⓘ` popover shows the agent version; the Settings page's fleet summary shows real counts. (The `device.agent`-driven chips on the fleet card/wall/header will read `absent` regardless of real state until the `device-registry.ts` gap above is closed — expected, not a defect in this step.) |
>
> **Both gaps above closed 2026-08-13 by the M61 hotfix pass
> (`docs/plans/96-m61-hotfixes.md` §96.9).** `rowToDeviceInfo()` now sets
> `agent: deriveAgentState(row)`, reached by every list/broadcast/detail
> caller with no per-call-site threading needed (the field lives on the row
> itself, unlike `heldBy`/`readiness`, so there is no accessor a future
> caller can forget to pass — a stronger fix than the "one line" this step
> predicted, structurally closing the exact class of defect §96.5 needed
> three separate call-site patches for). `GET /:id/guest-agent` is now wired
> to `AgentProvisioner.status()` when `deps.agentProvisioner.status` is
> present, mapped additively onto the endpoint's existing response shape —
> `outdated`/`failed` and `versionCode`/`checkedAt`/`attempts`/
> `nextAttemptAt` all have a live producer through that endpoint now, and
> `DELETE` was also wired to `agentProvisioner.remove()` so the row cannot go
> stale after an uninstall. The `AgentPanel`/`AgentAlertChip`/fleet-card/wall
> code THIS step built required zero changes — exactly as this step's own
> gap note predicted ("will start telling the truth the moment that one-line
> read lands"). H-90.6a above is still genuinely pending (nothing in §96.9
> touched `packages/studio/**` — a concurrent worker held it during that
> pass), but the note in its own right-hand column about the fleet-card/wall
> chips reading `absent` regardless of real state is no longer accurate as of
> this closure: run H-90.6a again to confirm the chips now track reality.
> See §96.9 for the full account, including surface-level tests against the
> real HTTP routes for both gaps.

- **Verifiable result:** an operator can answer "which of my phones can be
  labelled" and "why is this route not up" from the fleet page and the device
  page, without opening a log.

### 90.7 — Media provisioning, without an APK facet (fixes F30, F31; implements §3.4)

- [x] `packages/core/src/device/transfer.ts`: `mediaScan` on the push path per
      §4.6, `scan_file` then `scan_volume`, result reports which ran.
- [x] `packages/core/src/api/transfer.ts`: the request field and the extended
      result.
- [x] `packages/session/src/device-executor.ts` + the SDK: `ctx.device.push`
      gains `mediaScan`, defaulting to `'auto'`.
- [x] `packages/studio/src/components/FilesPanel.tsx`: destination presets
      (Pictures / Movies / Downloads / custom) and a line in the result saying
      whether the media library was told.
- [x] Two host-side monitoring corrections adopted from §3.5: `monitor`'s
      `meminfo` gains an optional `package` option, and `crash` becomes
      selectable in Studio's Monitor picker.
- **Verifiable result:** push a JPEG to `/sdcard/Pictures/`, then open the
  device's photo picker from any app — the image is there without a reboot.
  The push result names the method that worked, settling H3 in the field.

  **Status: implemented and tested in software; the hardware half —
  actually settling H3 — is pending, owner to run.** Everything short of a
  real phone is done and proven: `packages/core/src/device/transfer.ts`'s
  `push()` now returns `{ mediaScan: { ran, method, ms, error? } }`, tries
  `content call --method scan_file` then `scan_volume` (first exit-0 wins),
  and never throws on a scan failure — the bytes are already on the device
  either way. The full chain is wired end to end and asserted at the
  surface a user/script actually sees, not only at the helper that computes
  it: `POST /:id/push`'s response (`PushResponseSchema`), `ctx.device.push`
  in the SDK (`packages/sdk/src/types.ts`) and the child-process IPC bridge
  (`packages/session/src/runner/child-entry.ts`), the `device.push`
  capability (`packages/core/src/capability/device-files.ts`), and the
  rendered Files panel (`packages/studio/src/components/FilesPanel.tsx`,
  which now shows Pictures/Movies/Downloads/Custom preset buttons and a
  result line naming the scan method or explaining why none ran).

  What is NOT proven here, and cannot be from this environment: whether a
  real Android 10+ device's shell user actually accepts `content call
  --uri content://media --method scan_file` (H3). §7.2's smoke stage 19
  already specifies the exact device check; the commands below are the
  same shape, reproduced so this status line is self-contained.

  **Exact steps for the owner to run**, against a phone already enrolled
  over USB (writes to whichever phone runs them — do not run against a
  phone in active manual use):

  ```bash
  # 0. Core running locally with the phone enrolled over USB (bun run dev).

  # 1. Push a JPEG into Pictures from Studio's Files tab (destination preset
  #    "Pictures"), or directly:
  curl -sS -X POST http://localhost:7700/api/artifacts \
    -F file=@/path/to/local/photo.jpg -F label=photo.jpg
  # -> note the returned artifact id
  curl -sS -X POST http://localhost:7700/api/devices/<deviceId>/push \
    -H 'content-type: application/json' \
    -d '{"artifactId":"<artifactId>","remotePath":"/sdcard/Pictures/photo.jpg","clientId":"<wsClientId>"}'
  # -> the response body's result.mediaScan names which method ran:
  #    { "ran": true, "method": "scan_file", "ms": <n> }   — H3 confirmed
  #    { "ran": true, "method": "scan_volume", "ms": <n> } — scan_file failed, fallback answered
  #    { "ran": false, "method": null, "error": "..." }    — both failed; read `error`

  # 2. Read-only cross-check — did MediaStore actually index it:
  .dev-data/tools/adb/*/platform-tools/adb -s <serial> shell \
    content query --uri content://media/external/images/media \
    --projection _data --where "_data='/sdcard/Pictures/photo.jpg'"
  # A row naming the path confirms the scan worked regardless of which
  # method the API response reported.

  # 3. Open any app with a photo/file picker on the device (e.g. the stock
  #    Gallery, or a messaging app's attach-photo flow) — with NO reboot in
  #    between, the pushed photo should already be visible.
  ```

  **What each outcome means:**

  | Reading | Verdict / effect |
  |---|---|
  | `result.mediaScan` reports `{ ran: true, method: 'scan_file' }` and step 2's `content query` returns a row | H3 confirmed as written — `scan_file` works as the shell user with no root, exactly as `MediaStore`'s public API since Android 10 predicts. No code change needed. |
  | `result.mediaScan` reports `{ ran: true, method: 'scan_volume' }` | `scan_file` failed on this OEM/API level but the documented fallback caught it — the two-method design (§4.6) is doing its job. Worth naming the OEM/API level in a follow-up note so a pattern across devices can be seen later. |
  | `result.mediaScan` reports `{ ran: false, error: '...' }` but step 2's `content query` still finds the row, or step 3's picker shows the photo anyway | Both `content call` methods failed on this device/API level for a reason unrelated to whether the file is indexed (e.g. a permission or `content call` argument-parsing quirk) — the `error` string is the next debugging lead; still degrades honestly rather than lying about success. |
  | `result.mediaScan.ran` is `false` AND step 2 finds no row AND step 3's picker never shows the photo | Neither method worked on this device — H3 does not hold there. The push itself still succeeded (the bytes are on disk, confirmed by `adb shell ls /sdcard/Pictures/photo.jpg`); only the "tell MediaStore" step needs a device-specific investigation, which is exactly the scope §3.4 draws around this feature. |

### 90.8 — Documentation

> **Status: done, 2026-08-13.** Every fact below was re-verified against the
> shipped code (not trusted from earlier status notes) before being written
> down, because several were stale by the time this step ran — the plan's own
> §5 checklist items above were themselves imprecise on three points, corrected
> here rather than copied: the text ladder has **three** rungs, not four
> (§3.3, §96.7, §96.8 already record this — the checklist item above still
> said "four hooks" for the provisioner, which is correct, but did not warn a
> reader that the *text ladder* is three, a different number in a nearby
> section of this same document); the measured APK size is **1,119,121 bytes**
> (acceptance criterion 1), not the "under 3 MB" prediction; and the
> guest-agent status enum is **seven** values (§4.7's own text says "becomes
> the §3.8 enum", which undersold the additive widen — corrected in the
> deviation note below the top status line, and documented as shipped, not as
> designed, in every file below).

- [x] `apps/guest-agent/README.md`: a new "One app, four facets" section
      (§3.1's table and membership rule), a new "Text input (the keyboard)"
      section (the exact `ime enable`/`ime set` activation commands and the
      read-first/restore-after/idempotent revert contract, matching
      `applyTextInput`'s real behaviour), a new "Screen label" section (the
      device-side contract, and the honest note that plan 89's host-side
      caller does not exist yet), a strengthened Tun2Socks keep-rule paragraph
      naming the exact failure mode (compiles, links, installs — fails only
      when the native library loads **on the phone**, with no compiler error),
      and a two-tag-round procedure plus a provisional-`signatureSha256`
      warning added to "Signing". The APK size was already recorded here by
      step 90.1's own pass; left as-is (1.1 MB / ~1.1 MiB, matching acceptance
      criterion 1's measured 1,119,121 bytes).
- [x] `packages/core/README.md`: the "Guest agent and the device network
      route" section corrected (the endpoint's state enum is additively seven
      values once `AgentProvisioner.status()` is wired — which it is, in
      production, confirmed by reading `daemon.ts`'s real
      `createGuestAgentRoutes({...})` call rather than trusting an earlier
      status note that flagged this as an open gap; `vpn-helper`'s probe claim
      corrected the same way `packages/drivers/README.md` was); two new
      sections, "The agent is a device property, not a session step" (the
      provisioner, its four hooks, the failure policy, the three new
      endpoints, and the `guestAgent` settings block) and "Route recovery that
      knows the device came back" (§3.7's fix, the two-part reset rule, the
      breaker, the new device events).
- [x] `packages/drivers/README.md`: the stale "`vpn-helper` does not advertise
      `probe`" paragraph corrected (it has, since plan 51 — the same stale
      claim `CLAUDE.md` and `descriptors.ts`'s own comment already had fixed;
      this README was the one place still carrying it, found by re-reading the
      actual `capabilities` array in `descriptors.ts` rather than trusting the
      README's own prose); a new "Text input: a three-rung ladder, and how to
      read `via`" section with the rung table, the `text-ascii`/`text-unicode`
      capability-gating rule, and the fourth-rung removal recorded as
      history (cross-referencing §96.7/§96.8) so a future reader does not
      re-add it believing it was merely never gotten to.
- [x] `docs/spec.md`: §7.9 gains a new numbered sub-point under rule 1 (the
      recovery bound, the breaker, the `recovery` block, the `retry`
      endpoint); §7.10 gains a "v0.8 revision" paragraph (mandatory
      provisioning, the failure policy) plus the four-facet table and the
      membership rule verbatim; §11.3's transfer bullet gains `mediaScan`
      inline; §19's Device-detail row gains the **Agent** tab, with one
      sentence on what it renders. Per Definition of Done item 8: the `retry`
      endpoint, the `recovery` block, the facet capabilities, `mediaScan`, and
      the Agent screen are now all in spec.md directly — no `DIV-` row was
      needed for those. `POST /api/guest-agent/provision`/`GET .../summary`
      and the `devices.agent` table column are the two DoD-8 artefacts NOT
      individually described in spec.md (spec does not enumerate endpoint
      lists exhaustively outside §7.7/§8, nor table columns anywhere, per
      `docs/spec-divergences.md`'s own "What is NOT diverging" precedent) —
      recorded instead in `docs/plans/00-overview.md` §9 (the column) and in
      this plan's own §4.7 (the endpoints), which is where every other plan's
      endpoint additions already live.
- [x] `docs/guide/install.md`: a new "The guest agent" section — what
      `failed` means and why it never costs a device, why a fresh install
      from a released binary fails closed today (`E_CHECKSUM_MISSING`, tier 3
      not live yet) and the two workarounds, how to force a retry, and the
      farm-wide `guestAgent.provision` off-switch.
- [x] `docs/plans/89-m54-…md` §4.5: a status note added directly above the
      contract, naming plan 90's "90.5+" step as the one that honoured it on
      the device side, and stating plainly that §4.6's host-side
      `LabellingService` does not exist and this plan's own status line is
      correctly still `not started` — **partly honoured, not fully**, per
      this step's own instruction.
- [x] `docs/plans/00-overview.md` §9: a new row for `devices.agent`
      (migration `0043_silly_living_mummy.sql`), explicitly marked as a plain
      additive column rather than a compatibility window (there is nothing to
      remove later), recorded here anyway because this is where a reader
      already looks for "what changed about the schema and why."

**Consolidated hardware-pending table**, gathering every *pending — owner to
run* note this plan and its neighbours accumulated (plan 88's H1/H3/H6, this
plan's own H-90.3a/b/c and H-90.5a/b/c and 90.4's un-lettered pending block
and 90.7's H3, and the M61 hotfix pass's H-96.9a/b) into the single list the
task that produced this documentation pass asked for, so an owner sitting
down with real hardware has one list to work through top to bottom instead of
six. **Every per-step note above stays exactly where it is — this table adds
a cross-reference, it does not replace any of them.** None of these were run
by this documentation pass; the prohibition against touching a physical
device applied throughout, exactly as it applied to every step that first
wrote these rows.

| # | Source | Claim | Exact command | Outcome |
|---|---|---|---|---|
| 1 | Plan 88 H1 (`88-m53-…md` §0.2) | `tcpip:<port>` works as a device service over `openRaw`, so enabling TCP mode needs no adb CLI spawn | See step 88.5's own checklist entry for the exact commands (writes to the phone's TCP-listener state) | _(unfilled)_ |
| 2 | Plan 88 H3 (`88-m53-…md` §0.2) | `persist.adb.tcp.port` does not survive a reboot without root; the wizard reports `persistSurvivesReboot` rather than promising it | See step 88.5's own checklist entry for the exact commands (a real write + reboot cycle) | _(unfilled)_ |
| 3 | Plan 88 H6 (`88-m53-…md` §0.2) | A device on `adb-tcp` cannot be re-opened from Studio after its session closes, until `Transport.disconnect` no longer drops the farm's transport | Set a device's transport to `adb-tcp`, open a session from Studio, close it, `adb devices`, then try to re-open | _(unfilled)_ |
| 4 | Plan 90 H-90.3a (top status line) | Admitting a device with no route configured anywhere installs the agent and reaches `ready` (acceptance criterion 4) | `bun run dev`, enrol a phone over USB with no route ever configured, `curl -s http://localhost:7700/api/devices/<id>` (repeat until `agent` reads `ready`), then `curl -s http://localhost:7700/api/guest-agent/summary` | _(unfilled)_ |
| 5 | Plan 90 H-90.3b (top status line) | A reconnect runs one verification pass, installs nothing, logs nothing beyond a debug line | With #4's phone already `ready`, unplug and replug; watch the core's log for any `installing the guest agent` line | _(unfilled)_ |
| 6 | Plan 90 H-90.3c (top status line) | 20 devices at once never exceed `adb.maxInstallConcurrent` concurrent installs, never two on one device | `GET /api/adb/stats` at 1 Hz while admitting/booting with 20 phones already plugged in (§7.3's own ladder) | _(unfilled)_ |
| 7 | Plan 90, step 90.4's own status note | Exhausting the recovery bound, then physically replugging, restarts recovery within one heartbeat without the operator touching the toggle (acceptance criterion 10) | Full 4-step script (point the route at an unreachable upstream, confirm exhaustion via `GET .../network`, unplug/replug, re-poll) in 90.4's own status note | _(unfilled)_ |
| 8 | Plan 90, step 90.4's own status note | Six replugs inside an hour engage the `reconnectCycles` breaker on the fifth, log it once, and fall back to the re-arm clock (acceptance criterion 11) | Repeat the unplug/replug six times within an hour, `grep "reconnect-cycle breaker is engaged" <core log>` — same note as row 7 | _(unfilled)_ |
| 9 | Plan 90 H-90.5a (§90.5's status note) | `こんにちは 👋` typed from Studio reaches a focused field via `agent-ime` with the clipboard unchanged; removing the agent falls to `scrcpy-text`; forcing `adb-input` shows the inline precondition (criteria 14–15, smoke stage 17) | Five-step script (type into a focused field, read `dumpsys input_method`, check the clipboard, uninstall and repeat, force ASCII-only and repeat) in 90.5's own status note | _(unfilled)_ |
| 10 | Plan 90 H-90.5b (§90.5's status note) | `SIGKILL`-ing the core mid-session leaves the device un-wedged (the picker still opens) even though the exact pre-session IME is not auto-recovered (criterion 16, smoke stage 18) | `kill -9 <core-pid>`, restart, check `default_input_method`, confirm the picker opens, close normally and recheck — full script in 90.5's own status note | _(unfilled)_ |
| 11 | Plan 90 H-90.5c (§90.5's status note, cross-referenced from §90.5+) | The label facets render correctly on a real phone: legible from a metre away, a repeat `label.apply` is a no-op, `label.clear` restores the original wallpaper | A short Bun script calling `createGuestAgentClient`'s `labelApply`/`labelStatus`/`labelClear` directly (no host caller exists yet — see plan 89 §4.5's status note) | _(unfilled)_ |
| 12 | Plan 90, step 90.6's own status note (H-90.6a) | The Agent tab, the Network tab's summary, the header popover, and the fleet/wall/Settings chips all render correctly against a real core and a real agent | `bun run dev` + `bun run dev:studio`, enrol a phone, open `/device?id=<id>` → **Agent** tab, and `/settings?tab=guest-agent` | _(unfilled)_ |
| 13 | Plan 90 H3 / step 90.7's own status note | `content call --method scan_file` (falling back to `scan_volume`) actually indexes a pushed file into `MediaStore` as the shell user on a real Android 10+ device | Push a JPEG to `/sdcard/Pictures/`, read `result.mediaScan`, cross-check with `content query`, open a picker app — full script in 90.7's own status note | _(unfilled)_ |
| 14 | Plan 90, step 90.1's own status note | `ENKAKU_TEST_DEVICE=1 bun run smoke:guest-agent` passes all fifteen existing stages against the shrunk, R8'd APK (acceptance criterion 2's sibling — H1's runtime half) | `ENKAKU_GUEST_AGENT_PATH=$PWD/apps/guest-agent/app/build/outputs/apk/release/app-release-unsigned.apk ENKAKU_TEST_DEVICE=1 bun run smoke:guest-agent -- --serial <SERIAL>` | _(unfilled)_ |
| 15 | Plan 90, acceptance criterion 2 / `apps/guest-agent/README.md` "Signing" | A real, signed CI release: `build-guest-agent` builds, the printed sha256 matches `SHA256SUMS.txt`, and the two-tag-round manifest update (README §"How the APK reaches a device") produces a working tier-3 resolution | Once the four `GUEST_AGENT_KEYSTORE_*` secrets exist: push a `v*` tag, read the printed sha256, update the manifest, push a second tag — exact steps in `apps/guest-agent/README.md` | _(unfilled)_ |
| 16 | M61 hotfix pass, H-96.9a (`96-m61-hotfixes.md` §96.9) | A real device shows the correct chip on the fleet card/wall/header, and `GET /api/devices/:id/guest-agent` reports `ready` with a real `versionCode`/`checkedAt` once installed | `bun run dev` + `bun run dev:studio`, enrol a phone with `guestAgent.provision: 'auto'`, watch the header chip, `curl -s localhost:7700/api/devices/<id>/guest-agent \| jq` | _(unfilled)_ |
| 17 | M61 hotfix pass, H-96.9b (`96-m61-hotfixes.md` §96.9) | With no `ENKAKU_GUEST_AGENT_PATH` and no local Gradle build, a device reads `failed` with the verbatim `E_CHECKSUM_MISSING` reason (never `absent`, never a 500), and still streams/inputs/runs jobs | Same dev boot as row 16 with neither env var nor a local build present, enrol a phone, open the Agent tab | _(unfilled)_ |

Rows 1–3 predate this plan (plan 88) and are included only because the task
that produced this consolidation explicitly named them as part of the same
hardware session an owner would reasonably batch together — they do not
block any plan-90 acceptance criterion. Rows 4–17 are this plan's own. None
of the code above branches on any of these outcomes: every row is a
confirmation of behaviour already proven against fakes, per this plan's own
"code lands either way" precedent (§0.2, H1).

## 6. Acceptance criteria

1. **The release APK's measured size is recorded here**, alongside the 21.7 MB
   it replaces, and `release.yml` fails above the declared budget. (H1 predicts
   under 3 MB; the criterion is the measurement, not the prediction.)
   **MEASURED 2026-08-13, `bun run build:guest-agent` (unsigned local build,
   toolchain present: JDK 17 + Android SDK platform 36 + NDK 29.0.14206865):
   1,119,121 bytes (~1.07 MiB / ~1.1 MB), sha256
   `4cd3d7d57f2e858a6997571abaa707e096e596645461d5eb3e569069b74c662c`** — down
   from 21.7 MB (H1 confirmed, well under its 3 MB prediction). `classes.dex`
   is 103,152 bytes (down from 14.1 MB + 7.1 MB = ~21.2 MB); the native tunnel
   library is unchanged at 849,100 bytes across `arm64-v8a`/`armeabi-v7a`/
   `x86_64` (322,944 + 199,660 + 326,496), confirming the size drop is entirely
   the Compose removal (F1/F3) and not an accidental change to the one part of
   the payload this plan explicitly keeps (§3.11: "the native tunnel stays").
   `release.yml`'s size gate is set to 4 MiB — see 90.1's own note on that
   number. **Also verified with real signing**, not just unsigned: building
   with a freshly generated bootstrap keystore (`ENKAKU_GUEST_AGENT_KEYSTORE_PATH`
   etc. set) produced `app-release.apk` (Gradle's signed-artifact name,
   confirming the new `signingConfigs` wiring actually takes effect rather than
   silently falling through to unsigned), verified with `apksigner verify
   --print-certs`.
2. `bun run build:guest-agent` produces a signed release APK in CI on a `v*`
   tag, published as a release asset with its sha256 printed.
   **The workflow is written and YAML/shell-syntax-checked (`python3 -c
   "import yaml; yaml.safe_load(...)"`, `bash -n` on every embedded step); the
   versionCode-derivation logic was additionally exercised directly in a shell
   for both a real tag and a non-tag ref. NOT run in real CI** — this repo has
   no push access to trigger a tag, and the four keystore secrets
   (`GUEST_AGENT_KEYSTORE_BASE64` and its three passwords/alias) do not exist
   as GitHub repo secrets yet; see 90.1's own status note and
   `apps/guest-agent/README.md`'s "Signing" section for the owner's next step.
   **Pending — owner to run**, once those secrets exist: push a `v*` tag and
   confirm the `build-guest-agent` job's printed sha256 matches
   `SHA256SUMS.txt` in the published release.
3. `resolveToolPath('guest-agent')` resolves from the manifest on a host with
   no `apps/` directory, and `deviceArtifactExpectation('guest-agent')` returns
   a `versionCode` and a `signatureSha256`.
   **PASSES, proven through the real `ToolchainManager` functions (not a
   stub)** — `packages/toolchain/src/manager.test.ts`'s `guest-agent (plan 90
   §90.1 — fixes F5, F6)` describe block, run against a bare OS tmpdir with no
   `apps/` directory anywhere near it. `signatureSha256` is the bootstrap
   keystore's real certificate hash (see criterion 1 and 90.1's own status
   note) — real in shape and in origin, but not yet the production signing
   identity a real release will use.
4. Admitting a device with **no network route configured anywhere in the farm**
   installs the agent and reaches `ready`. This is the criterion plan 89 §4.5
   is blocked on.
   **PASSES in software** (`agent-provisioner.test.ts`) — `ensure()` on a
   freshly-seeded device (no route ever applied) reaches `state: 'ready'`
   with a real `appVersion`/`androidSdkInt`/`capabilities` list from
   `hello()`. **Pending — owner to run** the literal admission on real
   hardware: H-90.3a, top status line.
5. A device that reconnects runs exactly one verification pass, installs
   nothing when the APK already matches, and emits no `install` line.
   **PASSES in software** — a second `ensure()` call after a device is
   already `ready` installs nothing and emits no `device.agent` event at
   all (not merely no `install` line). **Pending — owner to run** the
   literal unplug/replug: H-90.3b.
6. A device whose agent version does not match the manifest is repaired
   **once**; still mismatched, it reports `outdated` with the observed version
   and stops — no loop.
   **PASSES**, proven at both layers: `launcher.test.ts` proves the
   launcher's own repair-once cycle against `verifyDeviceArtifact`;
   `agent-provisioner.test.ts` proves the provisioner reports `outdated`
   with the observed `versionCode` and does not retry it via the
   bounded-retry ladder (that ladder is for transient failures, not a
   confirmed wrong build).
7. A device whose agent cannot be installed reports `failed` with the verbatim
   reason, is **not** quarantined, and still opens a session, streams video,
   takes input, runs a job, and answers a shell.
   **PASSES** for the two claims a device-provisioner test can make
   directly: `failed` carries the verbatim reason (including the
   toolchain's real `E_CHECKSUM_MISSING`-shaped message, plan 90's own
   hardware-honesty note), and `devices.status`/`quarantineReason` are
   provably untouched, including when already quarantined for an unrelated
   reason. "Still opens a session, streams video..." is unaffected by
   construction, not newly tested here: nothing in this step's code sits on
   the session/video/input/job/shell path — `AgentProvisioner` only ever
   reads/writes `devices.agent`, never `devices.status`, and no session or
   driver code calls into it.
8. `guestAgent.provision: 'off'` reproduces today's behaviour exactly: install
   happens only via the route path or the explicit endpoint.
   **PASSES** — `'off'`/`'manual'` make every AUTOMATIC hook a true no-op
   (zero `hostAdb`/`exec` calls, asserted), while an explicit `force:true`
   (the per-device POST, or the new fleet-wide endpoint) still runs — proven
   for both.
9. Twenty devices coming online at once never exceed `adb.maxInstallConcurrent`
   concurrent installs, and never two on one device.
   **The wiring is proven** — installs ride the real `createGuestAgentLauncher`
   end to end, with `hostAdb` calls carrying `{lane:'install', serial}`
   (asserted against the REAL launcher, not a fake, in
   `agent-provisioner.test.ts`), which is what makes host-adb's own
   `adb.maxInstallConcurrent` semaphore (plan 85, already tested there) the
   thing that bounds this — deliberately not a second concurrency mechanism
   (§3.8's own rule). **The 20-device number itself is pending — owner to
   run**: H-90.3c / §7.3's ladder.
10. **After exhausting the recovery bound, physically replugging the device
    restarts recovery within one heartbeat**, and the route comes back without
    an operator touching the toggle.
11. Six replugs inside an hour engage the `reconnectCycles` breaker on the
    fifth, log it once, and fall back to the re-arm clock — no infinite retry.
12. `POST /:id/network/retry` clears the counter and applies once; the route
    form shows an attempt number and a live countdown, never only a static
    sentence.
13. `network.recovery.exhausted` and `network.recovery.recovered` appear on the
    device event log, so a past outage is explainable after the fact.
14. `こんにちは 👋` typed from Studio reaches a focused field with `via:
    'agent-ime'` and **the device clipboard unchanged**.
    **PASSES in software** — `ws-handlers-text.test.ts`'s `rung 1 (agent-ime)`
    case drives the real `createWsMessageHandler` end to end with a fake
    session reporting a usable agent: `commitViaAgent` is called (never the
    raw driver), `input.text.result` reports `via: 'agent-ime'`, and
    `clobberedClipboard: false`. **Pending — owner to run** on real hardware:
    step 90.5's status note, H-90.5a, has the exact commands and an outcome
    table.
15. With the agent removed, the same string still arrives with `via:
    'scrcpy-text'`. With scrcpy unavailable too, Studio names the missing path
    and offers to install the agent — it never drops the keystroke silently.
    **PASSES in software** — the F25 fix itself: `text-input.test.ts`'s
    `resolveTextRoute` suite proves forcing `adb-input` on non-ASCII text
    (no scrcpy control socket, no agent) returns `unmet:
    { code: 'E_TEXT_UNICODE_UNSUPPORTED', action: 'install-agent' }` rather
    than a silently dropped keystroke; `ws-handlers-text.test.ts` proves the
    SAME refusal over the real WS handler, with the driver's `text()` never
    called at all. `LiveView.tsx`'s `onKeyDown`/`flushText` were rewritten to
    show that refusal inline (`textInputNotice`) instead of dropping the
    keystroke client-side, verified by `bun run --cwd packages/studio build`
    and `... test`; no dedicated component test exists for `LiveView.tsx`
    (none existed before this step either). **Pending — owner to run** on
    real hardware: H-90.5a.
16. Closing a session restores the device's previous default IME, and it is
    still restored after the core is `SIGKILL`ed mid-session and restarted.
    **PASSES in software for the part software can prove**:
    `text-input.test.ts`'s `applyTextInput` suite proves idempotent
    double-revert issues the identical restore command twice, an unreadable
    prior value is left untouched rather than guessed, and a failing shell
    command is swallowed; `session.test.ts` proves `createSession`/`close()`
    wire this correctly end to end, including that a second `close()` call
    is safe. **The literal `SIGKILL` claim needs a real core process and a
    real phone — pending — owner to run**: H-90.5b, which also states plainly
    what "restored" can and cannot mean after a kill (the device is never
    left wedged — a working keyboard with a manual escape hatch — but the
    TRUE pre-session-ever IME is not recovered across a kill, the same
    accepted limitation `prep.rotation`/`prep.tagTraffic` already have).
17. `screen-label` is advertised, and `label.apply` / `label.status` /
    `label.clear` satisfy plan 89 §4.5's five behavioural requirements —
    including `applied: ['home']` on an OEM that swallows the lock screen.
    **Partially satisfiable from this step alone.** The device-side contract
    is complete: `LabelRenderer.kt`/`WallpaperFacet.kt`/`ControlService.kt`'s
    three branches implement all five requirements (§5's new "90.5+" block
    above), built because no step in this plan assigned them and 90.5 is the
    only worker holding `ControlService.kt`. What this criterion cannot fully
    verify from software is the OTHER half: `packages/core/src/device/
    labelling.ts` (plan 89 §4.6), the host-side caller, was outside this
    step's file allowlist and is not built here — there is a real device-side
    facet with no host caller yet, the same shape of gap plan 89 §4.5 named
    for the whole agent before step 90.3's provisioner closed it.
    **Pending — owner to run**: H-90.5c.
18. A host running this plan's code against an agent build that predates it
    produces **no** thrown `E_UNKNOWN_METHOD`: every new facet reports
    `unavailable` with a named reason and an action.
19. No source file in `packages/core` or `packages/drivers` compares
    `appVersion` (asserted by test).
20. A JPEG pushed to `/sdcard/Pictures/` appears in the device's photo picker
    with no reboot, and the push result names which scan method worked.
21. A push to `/data/local/tmp` runs no scan and pays nothing for it.
22. `bun run typecheck`, `bun test`, and `bun run --cwd packages/studio test`
    are green. `bash scripts/check-plan-status.sh` passes.

## 7. Test plan

### 7.1 Unit tests

| Area | File | What it must prove |
|---|---|---|
| capability enum | `packages/protocol/src/guest-agent.test.ts` | `screen-label`/`text-input` parse; an unknown capability from a future build is rejected by the enum without failing the whole `hello` |
| version rule R1 | `packages/drivers/src/network/guest-agent/client.test.ts` | a protocol mismatch throws the coded error and is not retried; the error carries both versions |
| version rule R2 | `packages/core/src/agent-version-guard.test.ts` | no source file compares `appVersion` |
| provisioner | `packages/core/src/device/agent-provisioner.test.ts` | absent → install; mismatch → repair once → `outdated`; `unreadable` → skip, not fail; `failed` never changes `DeviceStatus`; retries are bounded; `provision: 'off'` is a no-op; the install lane bounds concurrency |
| launcher verify | `packages/drivers/src/network/guest-agent/launcher.test.ts` | `verifyDeviceArtifact` replaces the presence check; one repair attempt, then throw |
| recovery reset | `packages/core/src/api/guest-agent.test.ts` | **the regression test for F16**: exhaust the bound, go offline, come back → attempts cleared, one apply. Come back *without* having gone offline → bound still held. Breaker engages at `maxRecoveryCyclesPerHour` and decays after an hour |
| retry endpoint | `packages/core/src/api/guest-agent.test.ts` | resets and applies once; refuses without a lease |
| text routing | `packages/session/src/text-input.test.ts` | the full rung table: each of the three rungs chosen for the right inputs; the ladder never produces a rung outside its own declared set (the pin a since-removed fourth, clipboard-paste, rung used to need — §3.3, `docs/plans/96-m61-hotfixes.md` §96.7, §96.8); `unmet` carries an action; ASCII strings never escalate past rung 3 unnecessarily |
| IME session lifecycle | `packages/session/src/text-input.test.ts` | apply captures the previous IME, revert restores it, double-revert is a no-op, revert with no apply is a no-op |
| descriptor capabilities | `packages/drivers/src/descriptors.test.ts` | `text-ascii`/`text-unicode` are read by the resolver, not merely declared (F25) |
| escape guard | `packages/drivers/src/input/escape.test.ts` | **new file** — plan 03 asked for it and it was never written; the ASCII rejection is currently untested |
| media scan | `packages/core/src/device/transfer.test.ts` | `auto` scans under a media root and skips elsewhere; `never` never scans; a failed scan does not fail the push; the result names the method |
| settings | `packages/protocol/src/settings.test.ts` | the `guestAgent` block's defaults; `prep.textInput` defaults to `auto`; a stored row without it parses |
| Studio text gate | `packages/studio/src/components/LiveView.test.tsx` | a CJK keypress produces an `input.text`, not silence; the ASCII-only precondition renders |
| agent panel | `packages/studio/src/components/guest-agent/AgentPanel.test.tsx` | each state renders its one primary action; capabilities render as named facets |
| recovery UI | `packages/studio/src/components/guest-agent/NetworkRouteForm.test.tsx` | a countdown and an attempt number render; **Retry now** is present when exhausted |

### 7.2 Device smoke (`ENKAKU_TEST_DEVICE=1`)

`scripts/smoke-guest-agent.ts` is already the real test suite for this app
(fifteen stages) and gains five more, in its existing style — each asserting on
what the device reports, not on what the host asked for:

| Stage | Asserts |
|---|---|
| **16 — shrunk build** | all fifteen existing stages pass against the R8'd, Compose-free APK; the JNI peer resolves (this is what a broken keep rule would break, silently) |
| **17 — IME** | `ime enable`/`ime set` take with no tap; `text.status` reports `current`; `text.commit` with `こんにちは 👋` lands in a focused field; the clipboard is unchanged; revert restores the original IME |
| **18 — IME crash safety** | `SIGKILL` the core mid-session; the next session start normalises the IME (settles **H4**) |
| **19 — media scan** | push a JPEG to `/sdcard/Pictures/`, run the scan, then query `content query --uri content://media/external/images/media` for the path. **Records which of `scan_file`/`scan_volume` answered — this is what settles H3** |
| **20 — label verbs** | `label.apply` → `label.status` round-trips a fingerprint; `applied` reports what took; `label.clear` twice is idempotent (plan 89 §4.5's five requirements) |

### 7.3 The provisioning ladder — 5 → 10 → 20 (settles H2)

Run on real hardware with the release binary, one rung at a time, **with every
device already plugged in before the core starts** — that is the condition
mandatory provisioning has to survive. Do not advance a rung until the previous
one is green. An empty cell is a failed rung, not a skipped one.

| Measurement | How | 5 | 10 | 20 |
|---|---|---|---|---|
| APK size, before / after 90.1 | `ls -l` | 21.7 MB / ? | — | — |
| time to all devices `ready`, **before** 90.1 | stopwatch from boot | | | |
| time to all devices `ready`, **after** 90.1 | same | | | |
| peak `hostAdb.installsRunning` | `/api/adb/stats` at 1 Hz | ≤2 | ≤2 | ≤2 |
| devices reaching `ready` | `/api/guest-agent/summary` | all | all | all |
| devices reaching `failed` | same | **0** | **0** | **0** |
| install lines in the log on a **clean reconnect** | log grep | **0** | **0** | **0** |
| `E_ADB_STREAM_LIMIT` during provisioning | log grep | **0** | **0** | **0** |
| session open time, agent installed vs not | stopwatch | | | |

The before/after rows are the point: they are what turns H2 into a number, and
they are the evidence that mandatory install did not make the farm slower to
come up. If the "after" column at 20 devices is still measured in minutes, the
size budget in 90.1 is wrong and §9 Q4 takes over.

### 7.4 Regression watch

- `guestAgent.provision: 'off'` reproduces pre-plan-90 behaviour exactly,
  including that applying a route still installs the agent.
- A device with **no** agent behaves exactly as it does today for video, input,
  jobs, shell, transfer, and the inspector. Nothing new is on the critical path
  of a session.
- `prep.textInput: 'device'` never touches `default_input_method`.
- `mediaScan: 'never'` issues no extra shell command.
- The existing fifteen smoke stages are unchanged in meaning — the tunnel is
  the facet most at risk from an unrelated regression, and it is also the one
  the farm most depends on.

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| **R8 strips something JNI resolves by name and the tunnel breaks with no compile error** — the single highest-consequence change in this plan. | Explicit keep rules for `Tun2Socks` and its three native methods; smoke stage 16 exercises a real route through the shrunk build, so a broken keep rule fails CI-adjacent verification rather than a customer's farm. The README already carries this warning; 90.8 extends it from "never rename" to "never rename **or strip**". |
| Mandatory install turns a fleet cold start into a USB stall. | This is why 90.1 precedes 90.3. Installs ride plan 85's bounded lane; §7.3 measures before/after at three rungs; `provision: 'manual'` is a real escape hatch, not a theoretical one. |
| A device is bricked-for-farm-purposes by a failed install. | Explicitly forbidden: no quarantine, no block, no scheduling change, asserted by a test (criterion 7). The worst case is a device that cannot route, label, or type Japanese — and says so. |
| Switching the default IME leaves a phone unusable by a human. | Applied only for the session's lifetime, reverted on close with the `orientation.ts` read-first/restore-after pattern; normalised again at the next session start if the core died; the IME itself renders a visible line and a keyboard-picker button rather than an empty bar. Smoke stage 18 covers the kill case. |
| The IME becomes a text-entry side channel nobody expected — typed text is device state. | It changes nothing about who may type: `input.text` is already lease-gated and already audited on the `input` event stream (`logInputText` off by default). The IME is a transport swap, not a new authority. |
| An operator's own keyboard preference is silently overwritten farm-wide. | `prep.textInput` defaults to `'auto'`, which only engages when the agent advertises `text-input`; `'device'` is one setting away and is exactly today's behaviour. |
| Resetting the recovery bound on reconnect hides a permanent upstream failure behind a loop — **plan 54 §9 Q2's stated fear.** | The reset is conditional on a *genuine* offline transition (`offlineAt > exhaustedAt`), not on any tick; and the `reconnectCycles` breaker bounds it per hour. A dead proxy plus a flapping cable converges on the slow clock, with a `warn` naming the count. |
| `RECOVERY_REARM_S` 300 → 120 s makes a dead proxy get hit more often. | Twice as often on a clock that was never chosen (F15). It is now a setting with a stated default; §7.3's log-line counts show the real cost. |
| Two facets in one process mean an IME crash takes the route down with it. | They already share a process with the route today — `ControlService` and `RouteVpnService` are one app. The IME adds a service, not a process boundary. The real mitigation is that the route's state lives in `RouteState`/`RouteVpnService` and survives `ControlService` restarts, which is existing, tested behaviour. |
| `content call` differs across OEMs and API levels (H3). | Two methods tried in order, the working one recorded in the result, and a failed scan never fails the push. The field answer accumulates in smoke stage 19 rather than in an assumption. |
| The manifest pin and the built APK drift, so every device reports `outdated` forever. | `release.yml` prints the sha256 and `versionCode` it published; a mismatch shows up as a fleet-wide `outdated` on the Settings summary, which is a loud, one-glance failure rather than a silent one. `unreadable` never counts as a mismatch. |
| Adding `agent` to `DeviceInfoSchema` grows the fleet payload for every device. | One short enum string. The version and capability list stay on the per-device endpoint, which is why the chip renders `failed`/`outdated` only. |
| **This plan quietly becomes "the app that absorbs everything".** | §3.1's membership rule is written down precisely so the next proposal has to pass it, and §3.4/§3.5 are two rejections with reasoning already on the record. A future facet that cannot answer "what does this need that the shell cannot do" does not ship. |

## 9. Open questions

1. **Does the unified app leave room for accessibility mode, and what does
   that cost now?** The owner deferred it, so nothing here is designed for it —
   and the honest answer is that **it costs nothing now and should stay that
   way.** An `AccessibilityService` is one more `<service>` in the same package
   whenever it is wanted; the capability enum is append-only (R3) and would
   take one string; the control channel needs no change. What is *not* free is
   the operational property §3.10 protects: accessibility is the one candidate
   that cannot be granted unattended. Android 13+ blocks a sideloaded app's
   accessibility service behind a manual per-device **"Allow restricted
   settings"** tap (F43), and the competitor's own manual warns four separate
   times that box-farm operators must re-tap after every reboot. **H6** notes
   the one thing that might exempt an `adb install` — that modern adb uses a
   session-based installer, which is the discriminator the restriction keys on
   — and settling it costs one afternoon on one Android 14 phone. That
   experiment is worth running *before* anyone commits to the feature, not
   after, because the answer decides whether accessibility is a farm feature or
   a demo feature. Reserving nothing today is the right call either way.
2. **Should the agent be installed on `discovered` devices, or only on
   `admitted` ones?** This plan says admitted, because a discovered device is
   one the operator has not accepted yet and writing an APK to it presumes the
   answer. But an operator evaluating a phone might reasonably want its
   capabilities visible *before* admitting it. Installing on discovery would
   also make the Discovered tray considerably more useful. This is a product
   call about what "discovered" means, not a technical one.
3. **If H5 is wrong and the route still goes "held or dead" after 90.4**, the
   next suspect is the on-device side: a `route.start` arriving while the TUN
   is mid-teardown, or `RouteVpnService.handleFailure` reaching a state
   `route.start` does not clear. `RouteVpnService.kt:144-152` looks correct
   (a fresh start tears down a stale TUN first), so confirming this needs an
   on-device trace across a real reconnect and belongs in its own plan.
4. **What is the right APK size budget?** 90.1 sets one and `release.yml`
   enforces it, but the number should come from §7.3's 20-device rung rather
   than from taste. If provisioning twenty phones after 90.1 is still measured
   in minutes, the budget is wrong and the next lever is per-ABI splits — which
   trades one universal artefact for three, and therefore trades manifest
   simplicity for install time. Not worth doing speculatively.
5. **Should `text-input` also back `ui-server`'s `setText`?** F26 shows the
   inspector's set-text path is reachable only under `instant` timing after a
   selector-based tap, and a shipped plugin already fell through it to `input
   text`, which appends. Routing `setText` through the IME would make it
   unconditional and unicode-clean. It is out of scope here because it changes
   inspector semantics, not input transport — but it is the obvious next
   question once the ladder exists.
6. **Does the farm want a per-device agent version, or one version farm-wide?**
   This plan assumes one: the manifest pins a build and every device converges
   on it, exactly like `scrcpy-server` (`swappable: false`). A farm mixing
   Android 10 and Android 15 phones might eventually want two. Nothing here
   forecloses it — `ToolVersion` already supports multiple versions with
   `compatibleCoreRange` — but nothing here builds it either.
