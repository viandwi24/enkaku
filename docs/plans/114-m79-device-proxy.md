# Plan 114 — M79 : the device's own proxy, in two modes that are not equals

> Status: partial — **all ten steps have been built** (114.1 the protocol union, 114.2 `http-proxy.ts`, 114.3 `route-service.ts`, 114.4 `reverse-registry.ts`, 114.5 `reverse-proxy.ts`, 114.6 the mode selector, 114.7 the agent-missing precondition, 114.8 bulk, 114.9 the plugin boundary, 114.10 this documentation sweep) — and the plan is nonetheless **`partial`, not `implemented`**, because acceptance criterion 6 is half unmet and five gaps below are open and named. Rounding this up to `implemented` is exactly what the status vocabulary exists to stop. §0's evidence was checked against the code on 2026-08-18; every hypothesis in §0.3 is still unrun and needs the owner's hardware, because a `settings put` on a live farm device is a real change to a real phone. In particular **H3 has not been run**, and **wireless `adb reverse` is unrun too** — 114.4's re-establish-on-reconnect was built as insurance regardless (§4.3), and nothing in the code, the spec, or this plan claims `adb reverse` works over wireless adb.
>
> 114.3's own corrections to this document, made rather than quietly worked around: §4.2's claim that both new engines are constructed at `guest-agent.ts:2342` is superseded — the route half now lives in `packages/core/src/network/route-service.ts` and `buildEngine` is the one switch. §4.5's `E_ROUTE_LOCK_HELD` is raised by `assertLockFree`, which reverts an incumbent of a *different* engine and refuses the new apply if that revert fails; it is never raised for a re-apply of the same engine. §3.5's `upstream` check for `adb-proxy` is implemented as a host-side TCP dial only — the HTTP `CONNECT` half needs a target host nobody has chosen, and the check's own `detail` says which of the two it performed. `resolveWireConfig` deliberately KEEPS `engine: 'vpn-helper'` on the guest-agent wire object; see that function's doc comment for the two reasons and for when to revisit. And **114.3 did not touch `packages/protocol/src/api/devices.ts`** — `DeviceNetworkStatusResponseSchema.config` is still the SOCKS5 shape and will reject an `adb-proxy` config, which is 114.6's to fix along with Studio's own mirror.
> Depends on: plan 33 (M15) — the `network` driver layer, the `NetworkRoute` contract, and the two adb rungs it designed and never built. Plan 51 (M24b) — named checks and `deriveHealth`. Plan 52 (M24c) — routes belong to the device, and the `network_credentials` store. Plan 54 (M24d) — hold-closed and bounded recovery. Plan 90/106 — the guest agent's provisioning state, and preparation as a per-component registry. Plan 93 (M58) — the fan-out envelope. Plan 104 (M69) — `TargetPicker` and `useTargetSelection`. Plan 103 (M68) — the device popup.
> Deliberately does NOT depend on: plan 112 (M77, the proxy manager plugin). The dependency runs the other way — 112 makes something listen on the farm's own machine, and this plan is what points a phone at it. Nothing here imports from `plugins/`.
> Spec references: §7.9 (the network layer and its three-rung ladder), §7.10 (the guest agent and its membership rule), §8 (the registry), §11.3 (crash containment, never "sandbox"), §19 (Studio screens)
> 114.9's own corrections, made rather than worked around: §3.3's *"`devices.network_route` gains a `setBy` field"* is built, but the **`kind` is not passed alongside the actor — it is READ OFF the actor string.** Plan 109 §4.3 already made `plugin:<name>` the one unambiguous principal namespace, so a second parameter saying which kind it is could only ever disagree with the string it travelled beside; `stampSetBy` calls `pluginNameFromPrincipal`, which moved to `packages/core/src/plugins/principal.ts` so the network layer can read it without importing the capability registry. §3.3's *"the plugin sets a device by calling `PUT /api/devices/:id/network`"* is true of the handler, not of the URL: the plugin reaches `device.network.set`/`.get` (`packages/core/src/capability/device-network.ts`), whose handler calls the extracted BODY of that route — a `fetch` at the same URL from the plugin's screen would run as the *operator* and the device would then report that a person set a route a plugin set. **The lease needed an answer §3.3 does not give**: every network write takes `requireHeldLease` and a plugin never holds one, so the capability uses `admitMember` (plan 93 §3.8's own three-branch policy, imported not re-derived) to take a transient hold and give it back — which is §3.9's bulk rule and §9 Q2's *"skip and name"* applied to the one-device case. And **`DeviceNetworkStatusResponseSchema` still has no `captured` field** even though `route-service.ts` produces one: 114.9 added `setBy` alone, so Studio's *"cleared rather than restored"* wording (§3.6 rule 4, criterion 6) has no data to switch on and is 114.6's residual gap, not this step's.
>
> 114.8's own corrections, made rather than worked around: §3.9's envelope declares `error: z.string().nullable()` while its own classification table gives failures CODES (`E_SETTING_NOT_ACCEPTED`, `E_REVERSE_FAILED`) — the two halves cannot both be honoured, because a free-text message cannot be classified by a client. **`error` is a coded `{ code, message }`, symmetric with `skip`**, and `classifyDeviceNetworkApply` in `packages/protocol/src/api/devices.ts` is the one rule both sides use. §3.9's `route: PersistedNetworkRouteConfigSchema` on the body would have been **actively unsafe**: a Zod object strips unknown keys, so declaring the union there drops a `username` before `assertNoHttpProxyAuth` can refuse it — the body carries `route` unparsed (`z.record`) and the core validates and refuses it twice, once for the whole request and once per device inside the one door. §3.9's *"acquires a transient lease per device"* needed a check §3.9 does not name: `requireHeldLease` only asserts that SOMEBODY holds a manual lease, never who, so the bulk path reads `getHolder()` itself and skips a device held by anyone other than the requesting operator — otherwise §9 Q2's "skip and name" would have been silently violated by the very check meant to enforce it. §3.9's *"the route is saved so it applies when the device returns"* is built through the door rather than beside it: `setRouteFromRequest` takes an `admission: 'bulk'` mode (its ONLY new parameter) so an offline phone still gets `assertLockFree`, the capture and the attributed event, and the "was it saved?" answer is read back off disk rather than guessed from which line threw. Two pre-existing defects were found and one is fixed here: `DeviceReverseProxyNetworkConfigSchema.devicePort` was `z.number().optional()` while the core emits `null` until a reverse exists, so **every rung-2 status response failed Studio's parse in exactly the window criterion 10 says must be reported** — widened to `.nullable().optional()`. The other is left alone as 114.6's: `DeviceNetworkStatusResponseSchema` still has no `captured` field. And **bulk has no Off**: turning a route off is a per-device restore of that phone's own captured values (§3.6), not one shared config, so `POST /network/apply` carries a route to apply and nothing to un-apply — a named gap, not a silent one.
>
> 114.5's own corrections, made rather than worked around: §4.2's sketch gives `createReverseProxyRoute` a `devicePorts: PortAllocator` dep — superseded, because 114.4 put the device-port walk inside `ReverseRegistry.establish` (the host cannot bind-test a device port, so the only collision signal is `adb reverse` failing, and that signal is only visible where the call is made). The engine takes `reverse` + an `allocation` store instead. §7's test line *"a failed `adb reverse` fails the apply and does not leave the setting pointing at a dead port"* covers only half the problem: the mirror case (the reverse establishes, the setting write fails) resolves the OTHER way — the reverse is deliberately left standing, because a read-back mismatch is not proof the phone rejected the value, and tearing the tunnel down would guarantee the dead port that ordering exists to prevent. And §3.5's `reverse` check needed a source §3.5 never named: it reads `ReverseEntry.establishedAt` BEFORE dialling `adb reverse --list`, which is what makes acceptance criterion 10's window report `fail` rather than `unknown` at no adb cost.
>
> 114.10's own record — the documents it changed, the two drifts it found, and the gaps it refused to let read as done. **Changed:** spec §7.9's `adb-proxy`/`adb-reverse-proxy` rows and §7.1's Network row now say shipped instead of *"deferred, not shipped"*, with the advisory property kept verbatim in both — the whole plan turns on HTTP proxy being a hint an app can ignore and VPN not being one, so a status flip that dropped that sentence would have undone the point; `00-overview.md` §9 gained a row for the `engine`/`captured`/`setBy` changes, which are a JSON-shape change inside the existing `devices.network_route` column and **no SQL migration at all**; `docs/plans/109-m74-plugin-runtime.md:5` no longer asserts a removal that never happened (§0.2 — the layer was fully intact, and this plan has since extended it), keeping the scope fence that line actually draws; `docs/plans/33-m15-device-network.md`'s status line and its §5.5 `:0` prescription are corrected; `docs/plans/112-m77-proxy-manager.md` §3.12 is narrowed; and `packages/drivers/README.md` gains both engines with their capability table. **Two drifts found during the build and recorded rather than fixed here**: (1) the Network screen speaks **two vocabularies for one component** — the guest-agent summary row renders `GET /:id/guest-agent`'s `state` (`not-installed | installed | ready | unreachable | outdated | failed | unsupported`) while the VPN precondition immediately below reads `devices.preparation['guest-agent']` (`absent | provisioning | ready | outdated | failed | unsupported`), because that endpoint's handler was never wired onto `AgentProvisioner.status()` (plan 90 step 90.6's own open note). They can legitimately disagree — the badge can read `ready` while the precondition reads `outdated` — and nothing reconciles them; no reconciliation is invented here, because guessing which of two live sources wins is how a screen starts lying confidently. (2) `'guest-agent'` as a component id is **spelled in three places with no shared export**: core's `GUEST_AGENT_COMPONENT_ID` (`packages/core/src/device/preparation/guest-agent-status.ts`), `PreparationPanel`'s `KNOWN_ORDER`/`KNOWN_LABELS`, and `VpnAgentPrecondition`'s own copy of the constant. A typo in Studio silently reads an always-absent key and renders a permanent `absent`. The fix — export the id from `@enkaku/protocol` and have all three import it — is a follow-up, not this step. **Open gaps, none of which may be read as done:**
> - **`DeviceNetworkStatusResponseSchema` has no `captured` field** though `route-service.ts` produces one and persists it, so Studio has nothing to switch on and **§3.6 rule 4 / acceptance criterion 6's *"cleared rather than restored"* sentence is not implemented** — no such string exists anywhere in the tree. This is 114.6's residual, flagged again by 114.8 and 114.9, and it is why this plan is `partial`.
> - **`upstream` is only computed on apply**, for both advisory rungs (`route-service.ts`'s two `runUpstreamCheck` call sites sit inside the apply path, and `handleDeviceOffline` nulls the cached result). `coldObserveAdvisory` re-runs the `reverse` check but not this one — so after a reconnect or a core restart, *"is the farm's bridge listening?"* reads `unknown` at exactly the moment an operator needs it. Reporting `unknown` is honest; it is not useful.
> - **Bulk has no Off.** Turning a route off is a per-device restore of that phone's **own** captured values (§3.6), not one shared config applied to many, so `POST /api/devices/network/apply` carries a route to apply and nothing to un-apply. Clearing across a selection would need a `POST /api/devices/network/clear` sibling with its own report; it does not exist.
> - **A failed reverse re-establish is not retried** until the next device-online transition. `ReverseRegistry.handleDeviceOnline` throws on failure and deliberately leaves `establishedAt: null` so the `reverse` check reports `fail` — visible, never silently retried into a different port — but nothing re-attempts it in between.
> - **H3 (the reverse-registry probe) and wireless `adb reverse` are both unrun.** The reverse rung has only ever been exercised over USB.
>
> Ships: packages/drivers/src/network/adb-proxy/http-proxy.ts, packages/drivers/src/network/adb-proxy/reverse-proxy.ts, packages/core/src/network/reverse-registry.ts, packages/core/src/network/route-service.ts

---

## 0. Evidence

The owner's own words, kept verbatim because the plan turns on a distinction they drew themselves:

> *"kan di …&tab=network sudah ada fitur network proxy, saya rasa keknya kita butuh fitur proxy bawaan, jadi ada 2 proxy bawaan metode yaitu: http proxy, vpn. nah vpn ini yang lewat enkaku guest agent, dia sebagai vpn dan di route. sedangkan kalau http proxy mendukung http proxy aja kan berarti lewat adb."*

Three stated goals:

1. *"device punya fitur bawaan yaitu Network → Proxy"*
2. *"Proxy bisa diaktifkan di device, tapi ada 2 mode, mode vpn route lewat guest agent, atau mode http proxy lewat adb. pastikan ga hanya fitur tapi ui nya juga yah di ui popup device terbaru juga atau support manage multiple device set nya, pastikan handler kaya misal kalau pilih vpn gimana kalau guest agentnya belum ke install dll itu tolong dipikirkan juga"*
3. *"plugin proxy manager membantu handling banyak devices, crud bikin proxy accounts atau proxy url banyak, terus dengan mudah mau set ke bulk device atau specific device, jadi plugin ini ngasih fitur manage yang lebih powerfull"*

### 0.1 Confirmed findings

Every row was checked against the code on 2026-08-18, not taken from the brief. Four of them **correct** the brief, and those are marked.

| # | Finding | Evidence |
|---|---|---|
| **F1** | **There is no adb HTTP-proxy code anywhere in the workspace.** No `settings put global http_proxy`, no `global_http_proxy_host`, no `content insert` equivalent, in `packages/core/src`, `packages/drivers/src`, `packages/adb/src`, `packages/session/src`, `apps/`, or `plugins/`. The only two string matches in the repo are a deferral comment and a Kotlin doc comment arguing against it. | `packages/protocol/src/network.ts:7-9`; `apps/guest-agent/app/src/main/java/dev/enkaku/guestagent/route/RouteVpnService.kt:26` |
| **F2** | **…but the DESIGN exists, is precise, and is published in the spec — the brief is wrong to call this mode "entirely new".** Plan 33 §5 specifies the engine down to the shell strings: *"`adb-proxy`: apply = `settings put global http_proxy host:port`; revert = `settings put global http_proxy :0` (the reliable reset — `delete` alone is not enough on many builds); observe = `settings get global http_proxy`."* Plan 33 §4 declared `NetworkEngineIdSchema = z.enum(['none', 'adb-proxy', 'adb-reverse-proxy', 'vpn-helper'])` and `NetworkConfigSchema.mode = z.enum(['direct', 'http-proxy', 'socks5'])`. Spec §7.9 carries a table row for each, labelled **"deferred, not shipped"**. This plan builds a designed thing; it does not invent one. | `docs/plans/33-m15-device-network.md:207`, `:68`, `:78`; `docs/spec.md:384-390` |
| **F3** | **The shipped enum has exactly two values and the config type is not a union.** `NetworkEngineIdSchema = z.enum(['none', 'vpn-helper'])`; `NetworkStatusSchema.declared` is `Socks5RouteConfigSchema.nullable()`, singular. Any third mode changes both, plus `DeviceNetworkStatusResponseSchema` on the API side and Studio's own hand-written mirror. | `packages/protocol/src/network.ts:11`, `:458-483`; `packages/protocol/src/api/devices.ts:300-319`; `packages/studio/src/lib/api.ts:220` |
| **F4** | **The only network engine is `vpn-helper`**, a SOCKS5 full tunnel through the guest agent. Its contract is `apply(Socks5RouteConfig)` / `observe()` / `revert()`, plus optional `probe()` and `hold()` discovered from `hello().capabilities` rather than assumed. `NetworkRoute` is still declared **locally in the driver**, not in `packages/protocol/src/driver.ts` where the other four layers live — plan 44 §5.6 left that move undone. | `packages/drivers/src/network/guest-agent/vpn-helper.ts:13-32`, `:125` |
| **F5** | **The network layer is not assembled by `DeviceSession`.** Unlike transport/display/input/inspector, no factory in `packages/session/src` builds a network engine. The one construction site is the core's guest-agent API. "A fifth driver layer" is true of the descriptor registry and the interface shape; it is not true of the session assembly. Any claim that a third engine "slots into the existing factory" would be false — there is no factory. | `packages/core/src/api/guest-agent.ts:33`, `:2342`, `:2225`; no `network` wiring anywhere in `packages/session/src` |
| **F6** | **`settings put global http_proxy` carries no credential and cannot be made to.** Android's value is `host:port` with a separate exclusion list; there is no username or password field. Spec §7.9's own table row adds the second half: *"The value is world-readable by every app on the device, so credentials must never be placed in it."* This is why plan 33 named `adb-reverse-proxy` — not `adb-proxy` — as the rung it would recommend once built. | `docs/spec.md:388`; `docs/plans/33-m15-device-network.md:45-49` |
| **F7** | **Capture-then-restore over `settings` is already solved in this repo, and the brief's F5 asymmetry is the exact problem it solved.** `screen-label.ts` reads the prior value, normalises Android's literal string `null` to `''`, writes, **reads back and reports `verified: false` on any mismatch**, and restores the captured value on revert — with a separate "nothing was ever captured" path that falls back to Android's own default. It is a working template for an advisory settings engine, written for `secure` instead of `global`. | `packages/session/src/screen-label.ts:41-45`, `:48-58`, `:68-73`, `:83-90`, `:97-104` |
| **F8** | **A device-scoped settings write needs no session and no lease-bound machinery.** `LabellingService` builds its own `AdbUsbTransport`/`AdbTcpTransport` straight from a `DeviceRow` and calls `transport.exec(...)`. That is the whole substrate an `adb-proxy` engine needs. | `packages/core/src/device/labelling.ts:175-181`, `:283`, `:371`, `:423` |
| **F9** | **`adb reverse` does not exist in the workspace, and `forward` is not where you would expect it either.** `HostAdb` exposes a generic `run(args)` and no per-verb methods; the only `forward` wrapper in the repo lives on `GuestAgentLauncher`, and the only other `forward` call sites are a stale-sweep in the daemon. Nothing anywhere spells `reverse`. Plan 109's H1 nonetheless PASSED on real hardware over USB — a device process dialled `127.0.0.1:<port>` and bytes crossed both ways. **Wireless is deliberately untested** (plan 112 H5 inherits it unrun), so "adb reverse works" is a USB claim, not a general one — the brief's F6 states it more broadly than the evidence supports. | `packages/core/src/device/host-adb.ts:81` (`run`), `:29` (`DEFAULT_RUN_TIMEOUT_MS`); `packages/drivers/src/network/guest-agent/launcher.ts:110-111`, `:292-293`; `packages/core/src/daemon.ts:3221`, `:3237`; `docs/plans/112-m77-proxy-manager.md:49`, `:135` |
| **F10** | **`deriveHealth` gates `ok` behind a passing `egress` check and nothing else can reach it.** `skip` and `unknown` are deliberately distinct: `skip` means the check cannot run at all and is excluded from "every check passed"; `unknown` means it has not run yet. A `fail` always beats "egress hasn't run". The function needs no edit for a new engine — an engine whose `egress` is permanently `skip` lands on `unverified` forever, which is the correct answer. | `packages/protocol/src/network.ts:265-310` |
| **F11** | **`docs/design.md` already states the wording rule this plan turns on**, and cites the network layer as its source: *"A degraded or partial state is never worded as the full one … the same discipline the network layer already applies to `deriveHealth` (`unverified` must never be worded as success) applies to any status word anywhere in Studio."* | `docs/design.md:277` |
| **F12** | **Today's Network tab renders the route form only when the guest agent is `ready`.** With no agent, the tab shows one link to the Agent tab and nothing else — no mode selector, no route form, no explanation of what is unavailable. The brief's F3 says there is no mode selector; the sharper fact is that on an agent-less device there is no proxy UI at all. | `packages/studio/src/components/guest-agent/NetworkPanel.tsx:93`, `:78-92` |
| **F13** | **The Network panel is already reachable from both surfaces** — the device page tab and plan 103's device popup, which registers it as a section of `SettingsPopup`. One component change reaches both; there is no second copy to keep in sync. | `packages/studio/src/app/device/page.tsx:711`, `:869-871`; `packages/studio/src/components/device-popup/SettingsPopup.tsx:16`, `:173-177` |
| **F14** | **Routes are device-scoped and survive everything except an explicit act.** Lease release, expiry, disconnect, reboot and core restart all leave the route alone; on device-online and core-start it is **restored by probing first**, never blindly re-applied. The lease is still required to *write* a route (`requireHeldLease` on every mutating endpoint), which is an admission check, not the route's lifetime. | `docs/spec.md:392`; `packages/core/src/api/guest-agent.ts:2008`, `:2049`, `:2090`, `:2487`, `:2516`, `:2542`, `:2572`, `:2586` |
| **F15** | **Credentials already have a home, and it is not KV.** `network_credentials` (AES-256-GCM, key at `<dataDir>/secrets.key`, `0600`) holds the upstream secret; `Socks5RouteConfig.credentialRef` names a row and `devices.network_route` holds no secret at rest. The store's own header states the honest boundary: *"NOT a KMS … anyone with read access to the data directory can read the key file sitting right beside the database."* | `packages/core/src/network/credential-store.ts:7-23`; `packages/core/src/db/schema.ts:325-338`; `packages/protocol/src/network.ts:228-249`, `:312-331` |
| **F16** | **Plan 112's `secretHint` leak (its F12) does not reach this plan.** That leak is in the KV store's secret path (`secretHint` puts `${first 7}…${last 4}` on the row, readable by anyone holding `plugin.data`). The built-in path writes to `network_credentials`, a different store with no hint field. This plan must not start using KV for a credential, and 112.2 remains 112's fix to make. | `packages/core/src/secrets/store.ts:182-185`; `packages/core/src/kv/store.ts:219`; `docs/plans/112-m77-proxy-manager.md:44`, `:606-607` |
| **F17** | **`settings put global` is not blanket-forbidden.** The high-consequence pattern list blocks exactly one global write, `settings put global adb_enabled`, because it can cut the farm's own transport. `http_proxy` is not on the list and nothing else gates a `global` write. | `packages/protocol/src/command/high-consequence.ts:10-13` |
| **F18** | **The multi-device report shape is settled and written down.** Outcome first; grouped by *exact* reason string; every count expandable to the named devices behind it — *"a number that cannot be expanded into a device list is not a real report — it is a rumour."* The components exist: `OutcomeSummary` (`{ ok, failed, skipped, total }`), `SkippedGroups` (`{ deviceId, label, reason }` grouped by verbatim reason), `TargetPicker` + `useTargetSelection`. | `docs/design.md:135-143`; `packages/studio/src/components/bulk/OutcomeSummary.tsx:18-25`; `packages/studio/src/components/bulk/SkippedGroups.tsx:18-33`; `packages/studio/src/components/target/TargetPicker.tsx:53`; `packages/studio/src/components/target/useTargetSelection.ts:130` |
| **F19** | **A synchronous fleet-wide settings write already has a precedent envelope**, and its doc comment states the three-way split this plan needs: threw before producing a state → `state: null`; produced a bad-but-normal state (`unavailable`) → a reported outcome, not a failure; ok. Studio's adapter from that envelope into `OutcomeSummary`/`SkippedGroups` is thirty lines and already written. | `packages/protocol/src/api/device-label.ts:74-92`; `packages/core/src/api/devices.ts:566-583`; `packages/studio/src/app/page.tsx:279-300` |
| **F20** | **A fast fan-out does not enter plan 107's operation tray, and that is deliberate.** `OperationKind` is a closed union of five (`transfer | job | batch | command-run | preparation`); bulk wake/sleep is explicitly ruled out as *"not long, and already discoverable per-device"*, and bulk labels is flagged as an open gap rather than fixed. | `packages/studio/src/lib/operations.ts:95`, `:97`, `:168`; `docs/plans/107-m72-long-running-operations.md:106-116` |
| **F21** | **Nothing about the network layer has been removed, disabled, or flagged off.** See §0.2 — this is the resolution of the brief's F8 and it needed its own section. | see §0.2 |
| **F22** | **Plan 51 already records a gap in what a passing `egress` check proves**, in its own status block: the agent excludes itself from its own tunnel, so `egress.probe` measures the SOCKS5 upstream rather than the `tun0` datapath other apps use. This matters here because it is the ceiling on what even the *enforcing* mode can honestly claim, and this plan must not accidentally raise it. | `docs/plans/51-m24b-verified-egress-and-fail-closed.md:6` |
| **F23** | **The engine registry advertises capabilities and locks, and Studio renders them.** Every network engine declares `locks: ['network-route']`, which is what makes "two routes at once" structurally impossible rather than merely discouraged. `vpn-helper` declares `['auth', 'enforcing', 'udp', 'probe']`; `none` declares nothing. | `packages/drivers/src/descriptors.ts:132-165`; `docs/plans/33-m15-device-network.md:59` |

### 0.2 The brief's F8, resolved: nothing was removed

The brief says plan 109's header records the owner *"removing that feature temporarily"* about the network/guest-agent layer, and asks whether this plan revives, replaces, or supersedes that. The answer is **none of the three**, and the reason is worth stating precisely rather than assumed away.

The line was real. This is what `docs/plans/109-m74-plugin-runtime.md:5` said until step 114.10 amended it on 2026-08-18 — quoted here because the amendment has to be legible as a change rather than as a line that always read the new way:

> *Deliberately does NOT depend on: the network/guest-agent layer (plans 33/43/44/51/52/54/55). The owner is removing that feature temporarily, and the proxy case in §4.7 is an **illustration of the general problem**, never a dependency. Nothing in this plan reads `Socks5RouteConfig` or the guest agent.*

Read what the sentence is doing: it is a **scope fence** on plan 109. Its subject is why 109 refuses to reach for `Socks5RouteConfig`, and its operative clause is that 109's SOCKS5 example is an illustration. The removal clause is a one-line aside about stated intent — no plan number, no step, no date, no removal target in `00-overview.md` §9's tracked-removals table.

And in the code, on 2026-08-18, **the layer is entirely intact**:

- `packages/drivers/src/network/guest-agent/` is complete (`vpn-helper.ts`, `launcher.ts`, `client.ts`, `index.ts` and four test files), exported from the package barrel at `packages/drivers/src/index.ts:47`, `:51`, `:63`.
- Two `kind: 'network'` descriptors are served through `GET /api/registry` (`packages/drivers/src/descriptors.ts:133-165`).
- Nine HTTP routes are defined and **mounted**: `packages/core/src/daemon.ts:1895` builds them, `:2413` passes them, `packages/core/src/server/http.ts:288` mounts `app.route('/api/devices', deps.guestAgentRoutes)`.
- The daemon's lifecycle hooks are wired (`daemon.ts:1931`, `:1932`, `:1937`, `:3701`), the `device.network` permission is enforced on every write, `devices.network_route` and `network_credentials` are live tables, and `network.applied` / `network.reverted` / `network.recovery.*` still reach the device event log.
- Both Studio surfaces still render it (F13), the guest agent provisioner is constructed at `daemon.ts:1944`, and `guestAgent.provision` defaults to **`auto`**, not `off` (`packages/protocol/src/settings.ts:1399-1445`).
- `git log` over `packages/drivers/src/network`, `packages/core/src/api/guest-agent.ts` and `packages/core/src/device/agent-provisioner.ts` shows no removal, deprecation or disabling commit.

So the removal was stated and never executed. This plan therefore **continues a live subsystem**, and its documentation step amends `109:5` so the two documents stop disagreeing — because a stale aside in a plan header is exactly the drift `00-overview.md` §7 item 6 exists to catch, one level up.

**Done, 2026-08-18, step 114.10.** `109:5` now keeps its scope fence and drops the removal aside, and states in the same line what was checked and where. The same claim had also spread into `docs/plans/112-m77-proxy-manager.md` §3.12 (*"which no plugin can reach and which the owner has temporarily removed"*), which is corrected there too — a second copy of a false statement is how one gets rediscovered as fact after the first is fixed.

One caution the resolution surfaces and this plan must answer rather than dodge: `RouteVpnService.kt:26` is an on-record, reasoned **rejection** of the advisory setting — *"This is the rung `settings put global http_proxy` can never reach. That setting is advisory — an app is free to ignore it."* That comment is correct and stays. This plan does not overturn it; it builds the rung *below* it and labels it as the rung below it. §3.2 is that argument in full.

### 0.3 Hypotheses — every one unrun, each with a probe

**None of these may be run against the owner's live core on :7700 or the device attached to it.** A `settings put` is a real change to a real phone. Each row names a probe for the owner to run on a device that is not in use; the plan is written so that every branch of every answer fails closed.

| # | Hypothesis | Probe | What the answer changes |
|---|---|---|---|
| **H1** | `settings put global http_proxy` **survives a reboot.** It is an ordinary `Settings.Global` row, so it should persist — but the split derived keys (`global_http_proxy_host`/`_port`) are what the framework actually reads, and whether they survive a re-provision on boot is not something we can assert from here. | Set it, `adb reboot`, wait for boot complete, `settings get global http_proxy` and both split keys. | Whether restore-on-reconnect must re-apply or only verify. If it does **not** survive, `adb-proxy` needs the same probe-then-apply loop `vpn-helper` already has (F14), and the plan's promise about reboot changes wording. |
| **H2** | The setting **survives an adb reconnect / replug** untouched. Nothing about adb should touch a settings row. | Set it, unplug for 30 s, replug, read back. | Nothing structural — it is the control case that makes H3 legible. |
| **H3** | **`adb reverse` does not survive a reconnect**, exactly as `adb forward` does not (plan 109 R7). If so, rung 2 must re-establish its reverse on every device-online transition, and until it does the phone's `http_proxy` points at a dead loopback port. | `adb reverse tcp:8899 tcp:9902`, confirm from the device, unplug, replug, `adb reverse --list`. | Whether step 114.4 needs a reverse registry with a reconnect hook (assume yes and build it; the probe can only make it unnecessary, never more necessary). |
| **H4** | **Which real apps on the reference device honour the setting.** WebView and `HttpURLConnection`-family clients are expected to; OkHttp with an explicit `Proxy.NO_PROXY`, a pinned client, or anything on raw sockets is expected not to. | Point `http_proxy` at a bridge the operator controls, then drive Chrome, one WebView app, and one app under test. **Measure at the proxy's own connection log, never on the phone** — the phone cannot tell you what did not go through it. | The exact wording of the mode selector's bypassable sentence, and whether the plan can name any example at all or must stay generic. |
| **H5** | **A VPN route and an `http_proxy` set at the same time do not conflict at the OS level** — both "apply", traffic follows the TUN, and the http setting becomes a stale lie sitting on the device. | On a device with a working `vpn-helper` route, set `http_proxy` to an address that is not listening, and check that traffic still exits through the tunnel. | Confirms (or refutes) the reasoning behind keeping `locks: ['network-route']` and refusing two engines at once. If they *do* conflict destructively, the lock stops being a tidiness rule and becomes a safety one. |
| **H6** | **What a device shows when the upstream is unreachable, per mode.** Expected: in http mode, a honouring client shows a proxy/connection error and a non-honouring client works normally — which is the worst possible signal, because the device looks half-broken and half-fine; in VPN mode with `failClosed` (default `true` since plan 54), the route goes `held` and nothing leaves. | Point each mode at a dead upstream and record what a browser, an app, and `GET /api/devices/:id/network` each report. | The wording of the failure state per mode, and whether http mode needs a farm-side "the upstream did not answer from here" check to give the operator anything at all. |
| **H7** | **The revert asymmetry, made falsifiable.** On a pristine device (`settings get global http_proxy` → `null`), after set-then-restore-captured, does the key read `null` again, or does the framework leave `:0` / an empty string? | Capture on a device that has never had a proxy, apply, revert with the captured value, read all four keys (`http_proxy`, `global_http_proxy_host`, `global_http_proxy_port`, `global_http_proxy_exclusion_list`). | Whether §3.6's "off means the value we found" is achievable exactly, or only approximately — and if only approximately, the UI must say *what* it restored rather than claiming the device is as it was. |
| **H8** | **Setting a proxy does not break adb-over-Wi-Fi.** adb is not an HTTP client, so it should not care — but plan 54 §3 rejected cutting Wi-Fi as a fail-closed mechanism for adjacent reasons, and a farm that loses its own transport to a proxy write has a very bad day. | On a device connected over `adb-tcp`, set `http_proxy` to a dead address and confirm the adb connection survives and `adb shell echo ok` still answers. | If it *does* break, `adb-proxy` must be refused on `adb-tcp` transports, which is a hard capability gate, not a warning. |
| **H9** | **The API floor.** The brief measured this working on Android 15 / API 35 as plain shell (uid 2000, no root). Below which API does it need `WRITE_SECURE_SETTINGS` the shell does not hold? | Run the same set/read-back on the oldest device in the farm and record the API level. | Whether the component declares an SDK floor (plan 106's `unsupported`, an old device is not a broken one) or declares none and reports `unsupported` from a failed read-back. **Until this runs, declare no floor and let the read-back decide** — guessing a floor would strand devices that actually work. |

---

## 1. Goals

What must be true when this plan is done.

1. **A device has a built-in Network → Proxy with three named modes** — `off`, `HTTP proxy`, `VPN` — selectable from the device popup and the device page, on a device that has no guest agent installed and never will.
2. **The mode selector states, at the point of choice and in ordinary words, that HTTP proxy is bypassable and VPN is not.** Not in a docs page, not in a tooltip: in the selector.
3. **HTTP proxy mode never reports `ok`.** `deriveHealth` already guarantees this once `egress` is `skip` for that engine (F10); the plan's job is to not work around it, and to word the resulting status as *"the device has been asked to use this proxy"* rather than *"this device's traffic goes through this proxy"*.
4. **Turning a route off restores the value the farm found**, not a hard-coded `:0`, and reports whether the device actually accepted the restore — `verified: false` is never worded as done.
5. **Choosing VPN on a device with no agent is a precondition with a fix, never an error and never a silent downgrade.** The panel names the agent's actual state from `devices.preparation['guest-agent']`, offers the install inline, and if the operator declines it leaves the mode unsaved — it does not quietly apply the advisory mode instead.
6. **A route can be set across a device set in one action**, through `TargetPicker`, reporting outcome-first grouped-by-reason results in which every count expands to named devices (F18).
7. **`adb reverse` exists**, is re-established on reconnect, and an `adb-reverse-proxy` route can point a phone at a proxy listening on the farm's own machine — the rung where a credential is possible at all, because the credential stays on the host.
8. **No credential is ever written into a device setting.** An operator pasting `http://user:pass@host:8080` into HTTP proxy mode is refused by name, with the refusal naming where credentials do go.
9. **Exactly one route is active per device**, enforced by the existing `network-route` lock rather than by convention.
10. **The plugin boundary is written down and enforced**: the built-in owns the applied state on the device, the plugin owns the catalogue and the listeners, and the plugin sets a device by calling the built-in's own endpoint — never by writing a setting itself.

## 2. Non-goals

| Not done here | Why | Where it belongs |
|---|---|---|
| **Building a proxy server.** No listener, no bridge, no upstream dialler. | Plan 112 built exactly that (its steps 112.5/112.6 are done), and building a second one in the core would be two implementations of the same forty lines. | plan 112 |
| **Per-app routing.** `settings global http_proxy` is device-wide by construction, and the VPN route is a full tunnel. | Unchanged from plan 33 §2 and plan 43 §3. | not planned |
| **HTTPS interception.** | Spec §7.9 rule 6: reading TLS payloads needs a trusted CA, which since Android 7 means a debug build of your own app. The layer routes traffic; it does not decrypt it. | out of scope, permanently |
| **`ctx.device.network.*` in the SDK.** Plan 33 §4.8 designed it and it has never existed. | It is a script-facing surface and this plan is an operator-facing one; adding it here would widen the blast radius for no delivery. | plan 33 §5.5, still open |
| **Moving `NetworkRoute` into `packages/protocol/src/driver.ts`.** Plan 44 §5.6 left it declared locally in the driver (F4). | It is a pure cut-paste with no shape change, and doing it in the same commit as three new engines would make the diff unreadable. Filed in §8. | a follow-up, or plan 33 §5.5 |
| **Off-host binds and listener authentication for the farm's own proxies.** | Plan 112 §3.9 rules the bind to loopback and §9 Q2 asks whether to build listener auth; this plan's rung 2 dials a loopback address and inherits that ruling rather than reopening it. | plan 112 §9 Q2 |
| **Changing what a passing `egress` check proves for the VPN mode.** F22's gap stays exactly as wide as plan 51 recorded it. | Narrowing it means changing the agent's own tunnel-exclusion behaviour, which is an APK change with its own hardware verification. | a successor to plan 51 |
| **A tray entry for the bulk apply.** | F20: a fast fan-out is deliberately not a tray operation, and adding a sixth `OperationKind` for a sub-second settings write is how a tray becomes noise. §3.9 says what happens if it turns out to be slow. | plan 107 §3.5's open gap |

---

## 3. Context and design decisions

### 3.1 The design point this plan turns on

**The two modes are not equals, and presenting them as two interchangeable options would mislead an operator into believing their traffic is captured when it is not.**

`global http_proxy` is a hint. WebView and some HTTP stacks honour it; an app using raw sockets, its own DNS resolver, or a pinned client ignores it completely, and nothing on the device stops it. The whole justification for the guest agent APK — a third language toolchain in this repo (`00-overview.md` line 168 calls it out as the one plan whose cost is as much operational as technical) — is that the advisory rung cannot do this. Plan 43's own acceptance criterion 5 puts it plainly: *"an app that ignores `http_proxy` is nevertheless routed — the property `adb-proxy` cannot provide"* (`docs/plans/43-m15b-guest-agent.md:382`).

So three rules govern every surface this plan touches, and none of them is negotiable for tidiness:

1. **The selector states the difference where the choice is made.** Not "advisory" — that is a word an operator has to already know. In ordinary words: *"Apps can ignore this."* / *"Apps cannot opt out of this."*
2. **"Enabled" in HTTP mode means "the device has been asked to."** The status readout says `asked` and `setting confirmed on the device`, never `routed` and never a bare `on`. F11 is the repo's own rule and it names `deriveHealth` as its source, so this is applying an existing discipline rather than inventing one.
3. **`unverified` is never worded as success, and for HTTP mode it is permanent.** §3.5 works out exactly what verification is possible per mode, and the answer for HTTP mode is: a probe can prove *the proxy works*, and can prove *a client that honours the setting reaches it*. It can never prove *any given app uses it*. The UI says that sentence.

### 3.2 Is HTTP proxy an engine, or something else that happens to share a tab?

**It is an engine — two of them — in the same layer, and the argument is not "it fits the tab" but "it fits the contract, including the parts that are inconvenient".**

The layer's contract is `apply` / `observe` / `revert`, plus a declared capability set and a `network-route` lock (F4, F23). Take each in turn against an adb settings write:

- **`apply(config)`** — `settings put global http_proxy host:port`, then read back and compare. This is not a stretch; it is a closer fit than `vpn-helper`'s own `apply`, which has to walk an install/grant/bootstrap/forward/handshake/start chain before it can claim anything.
- **`observe()`** — `settings get global http_proxy`, reporting **what the device says**, which is a genuinely different fact from what we declared. That distinction is the layer's second rule (spec §7.9 rule 2: *"They diverge (a VPN drops, a reboot clears the setting), and the drift must be visible rather than assumed away"*) — and note that the spec's own example of divergence is *a reboot clearing the setting*. The layer was designed with this engine in mind.
- **`revert()`** — must be idempotent. §3.6's capture-and-restore is idempotent by construction (it re-issues the same captured value every time and consults no "already reverted" flag), copying `restoreLockScreenLabel`'s own stated rule (F7).
- **`capabilities`** — `{ auth: false, enforcing: false, udp: false, probe: false }`. Every field is false, and every one of them is a fact the descriptor should publish rather than a gap to hide. Plan 33 §5 already anticipated exactly this: *"Capabilities are rendered from the descriptor, so `adb-proxy` visibly reports 'advisory — apps may ignore it' rather than implying enforcement"* (`33:192`).
- **`locks: ['network-route']`** — this is the part that makes the answer *yes* rather than *maybe*. If HTTP proxy lived beside the layer as "a different thing on the same tab", nothing structural would stop a device from having a VPN route and an http_proxy set at once, and H5 says that combination produces a device where one of the two settings is a lie. Putting it in the layer means the mutual exclusion is a property of the registry, not of a check somebody remembered to write.

**Where the fit is genuinely poor, and what it costs.** Three places, stated rather than smoothed over:

1. **The config type is not a union today** (F3). `Socks5RouteConfig` is the only shape `declared` can hold, and it has SOCKS-specific fields (`udpMode`, `failClosed`, `expect`, `onGeoFail`, `sessionId`) that mean nothing for a settings write. Making `declared` a discriminated union on `engine` touches `packages/protocol/src/network.ts`, `packages/protocol/src/api/devices.ts`, the whole of `packages/core/src/api/guest-agent.ts`'s route handling, and Studio's hand-written mirror at `packages/studio/src/lib/api.ts:220`. That is real work and step 114.1 pays it up front rather than smuggling an `engine` field onto the SOCKS config and branching on it.
2. **`health` for these engines is `unverified` forever** (§3.5). An engine that structurally cannot reach the layer's own top state is an odd citizen. But the alternative reading is worse: an engine outside the layer would compute its own status word, and that word would not be `deriveHealth`'s. One health vocabulary across every mode is precisely what stops "on" in one mode meaning something different from "on" in another.
3. **There is no session factory to slot into** (F5). "Fifth driver layer" is true of the descriptor registry and the interface; it is not true of `DeviceSession`. So the new engines are constructed where `vpn-helper` already is — in the core, not in a session — and the plan should not claim otherwise. This is a correction to how the layer is usually described in these documents, and step 114.3 is where it becomes visible.

**And a fourth engine, not two.** The owner asked for two modes. But F6 is fatal to the naive reading of "http proxy dengan proxy accounts": Android's setting has no credential field, and the spec forbids putting one there because the value is world-readable on-device. An HTTP proxy with a username and password can only work if the credential stays on the farm and the phone dials loopback — which is `adb-reverse-proxy`, plan 33's second rung, and exactly what plan 112's bridges are for. So:

| id | UI name | what it writes | credential | enforcing |
|---|---|---|---|---|
| `none` | Off | nothing | — | — |
| `adb-proxy` | HTTP proxy → a proxy the phone can reach | `http_proxy <host>:<port>` | **refused** | no |
| `adb-reverse-proxy` | HTTP proxy → a proxy on this farm's machine | `adb reverse` + `http_proxy 127.0.0.1:<devicePort>` | on the host, never on the device | no |
| `vpn-helper` | VPN | nothing on-device except through the agent | `network_credentials` (F15) | **yes** |

The operator sees **two modes** as asked, and inside HTTP proxy answers one further question — *where is the proxy?* — which is a question they have to answer anyway. §9 Q1 puts the alternative (three flat modes) to the owner.

**Engine ids keep plan 33's spelling.** `adb-proxy` and `adb-reverse-proxy` are already published in spec §7.9's table and in plan 33 §4. `docs/design.md`'s *"name things from the user's side"* applies to the UI, which says "HTTP proxy", not to a registry id an operator never types. Renaming them would mean a spec edit that buys nothing.

### 3.3 What "the plugin is the powerful manager" means structurally

The owner's model: the built-in is the mechanism, the plugin is the manager over many devices. Turning that into an ownership rule that two independent codebases can both honour:

| fact | owner | store | who may write it |
|---|---|---|---|
| **the applied route on a device** | the built-in | `devices.network_route` | only `PUT /api/devices/:id/network` and its siblings — one door |
| **the catalogue of proxies** | the plugin | plugin KV (`proxy:<id>`, `proxy-secret:<id>`) | only the plugin |
| **a listener on the farm's machine** | the plugin | nothing — in-memory, by design | only the plugin's supervisor |
| **which proxy an operator intends for a device** | the plugin | its device-scoped `assigned` key | only the plugin |
| **the upstream credential for a VPN route** | the built-in | `network_credentials` | `POST /api/devices/network-credentials` |

Two consequences follow, and both are load-bearing:

- **The plugin never writes a device setting.** It sets a device by calling `PUT /api/devices/:id/network` with `device.network` permission, through the plugin surface, so every route change lands in the same handler, takes the same lease check, writes the same device event with an actor, and obeys the same lock. This is plan 63's *"invoke is the only door"* applied one layer down. A plugin that wrote `settings put` itself would be a second door with a different set of checks behind it, which is how two subsystems end up disagreeing about what a phone is doing.
- **"Both try to set the same device" resolves as last-write-wins with an attributed actor.** `devices.network_route` gains a `setBy` field (`{ kind: 'user' | 'plugin', id: string, at: number }`) and the Network panel says *"set by proxy-manager, 4 minutes ago"* or *"set by you"*. There is no locking between a person and a plugin, because a lock there would produce a device nobody can fix; there is attribution, which is what plan 52 §3.1 chose over teardown for the tenant-isolation problem and for the same reason.

**Consistency with plan 112 §3.5's rule.** That rule is *"state is never persisted, intent always is"* — a running proxy's state lives in memory and is gone when the core restarts, because the listener is gone too; a persisted `running` is a lie the moment it is read. This plan is consistent with it and the check is worth doing explicitly:

- **Persisted here: intent only.** `config` (what was asked for), `enabled` (the on/off intent), `captured` (§3.6 — a fact about the device *before* we touched it, which is not runtime state), `setBy`.
- **Never persisted: observation.** `observed`, `drift`, `checks`, and `health` are all computed per read from a live `observe()`. `deriveHealth` is explicitly a derivation and never a stored column (`packages/protocol/src/network.ts:286-287`).
- The one apparent exception, `exitHistory`, already exists (plan 55) and is an observation **log**, not a current-state cache — it is newest-first, capped, and never read as "the current exit".

And 112 §3.12's standing sentence — *"the farm still cannot make an app use it"* — becomes narrower, not deleted. Its replacement, written into `plugins/proxy-manager/src/shared.ts` so the manifest and the screen cannot drift apart, is: *"assigning a proxy here records intent. Applying it to a device is the device's own Network → Proxy setting, which either asks the device to use this proxy (apps may ignore it) or routes it through the VPN (apps cannot)."*

### 3.4 Guest agent missing when VPN is chosen

The owner asked for this by name, and today's behaviour is that there is no proxy UI at all on an agent-less device (F12) — the tab shows one link and stops.

The design, in the order the operator meets it:

1. **The mode selector always renders, with every mode, on every device.** VPN is never hidden and never removed from the list. A control that cannot be used is genuinely `disabled` with a reason, per `docs/design.md`'s quality floor — hiding it teaches the operator that the farm cannot do it.
2. **Selecting VPN on a device without a ready agent shows a precondition, not an error.** This is plan 59's ruling (*"a precondition is not a failure"* — that plan exists because the inspector reported "take control first" as a red error). The panel reads the real state from `devices.preparation['guest-agent']`, which is authoritative since plan 106 step 106.5, and words each state differently:
   - `absent` → *"This phone does not have the Enkaku guest agent yet. VPN mode needs it."* + **Install**
   - `provisioning` → *"Installing the guest agent…"* + the preparation panel's own live state; the mode stays selected and applies when it finishes
   - `outdated` → *"The installed agent is older than this farm's. Update it to use VPN mode."* + **Update**
   - `failed` → the reason verbatim from the record + **Retry** (which routes to `POST /api/devices/:id/preparation/guest-agent/retry`, clearing the standing bound, rather than to a second retry path)
   - `unsupported` → *"This phone's Android version is below what the agent needs."* No retry button — plan 106's distinction is that an old device is not a broken one, and offering Retry on `unsupported` is how a phone ends up permanently reporting an error nobody can clear.
3. **Install runs through the existing endpoint** (`POST /api/devices/:id/guest-agent`, `packages/core/src/api/guest-agent.ts:1188`), not a new one, and the APK resolves through the three tiers CLAUDE.md fixes — `ENKAKU_GUEST_AGENT_PATH`, then a local Gradle build under `apps/guest-agent/app/build/outputs/apk/`, then the sha256-pinned toolchain artefact. **It is never auto-built.** If no tier resolves, the refusal names all three and which one it checked, because *"the APK is not available"* on its own is unactionable.
4. **If the operator declines, the mode is not saved and nothing is applied.** The panel does **not** fall back to HTTP proxy. A silent downgrade from an enforcing route to an advisory one is precisely the lie §3.1 exists to prevent, and it would be invisible: the tab would read "proxy on" either way. What the panel does instead is offer HTTP proxy as an explicit second choice, with its bypassable sentence attached, requiring a second deliberate click.
5. **Nothing about this gates the device.** Spec §7.10's v0.8 revision is explicit: a phone with no agent still streams, takes input, runs jobs, and answers a shell. It just cannot use one of the three proxy modes, and it says so.

### 3.5 What verification is possible per mode, and what it proves

This is where a feature ships honest or ships a lie. Each check id from plan 51 (F10), against each engine:

| check | `adb-proxy` | `adb-reverse-proxy` | `vpn-helper` (unchanged) |
|---|---|---|---|
| `tunnel` | `skip` — *"this mode establishes no tunnel"* | `skip`, same | the device reports a TUN |
| `setting` **(new)** | `settings get` matches what we wrote | same, and the address is the device-side reverse port | `skip` — the VPN writes no setting |
| `reverse` **(new)** | `skip` | the `adb reverse` entry is live and the host listener answers on it | `skip` |
| `upstream` | the **host** can open a TCP connection to `host:port` and, for an HTTP proxy, gets a well-formed response to a `CONNECT` | the host's own listener is accepting | a SOCKS5 session completes its handshake |
| `egress` | **`skip`, permanently** | **`skip`, permanently** | a probe through the tunnel returns an address |
| `geo` | `skip` (it depends on `egress`) | `skip` | as plan 55 |
| `dns` | `skip` | `skip` | as plan 51 |
| `leak` | `skip` | `skip` | as plan 51 |

Two new check ids widen `RouteCheckIdSchema`. They are additive and every existing reader treats an unknown id as data, not as a branch.

**Why `egress` is permanently `skip` for both HTTP rungs, and why that is the right answer rather than a gap to close later.** An egress probe has to run *on the device* to say anything (plan 51 §3: *"Checking the exit IP from the host proves the proxy works for the host. It says nothing about the device"*). On the device, our only probe vehicles are the shell and the guest agent. The shell has no HTTP client that honours `global http_proxy` — that setting is read by the Android framework's own networking stack, not by a shell binary. The guest agent could be made to run a request through a client configured to honour it, but that would prove one thing only: **that a client which honours the setting can reach the proxy.** It would not prove that any app under test does, because the whole property of an advisory setting is that a client may decline. Reporting that as `egress: pass` would promote `health` to `ok` and would be a false statement about the device.

So `deriveHealth` lands on `unverified` and stays there, with no change to the function (F10). The UI must then say **which** fact is missing rather than only that something is, and for these modes the sentence is fixed and always shown:

> *A proxy is set on this phone. Apps that honour the system proxy will use it; an app with its own networking can ignore it, and nothing here can tell you which did. For traffic an app cannot escape, use VPN mode.*

The `setting` check is what makes the readout useful anyway. `pass` means a real, non-trivial fact: the device accepted the write and reports it back. That is worth showing, and it is not success.

**And what `ok` means in VPN mode is still bounded by F22.** Plan 51's own status block records that the agent excludes itself from its own tunnel, so `egress.probe` measures the SOCKS5 upstream rather than the `tun0` datapath other apps use. This plan does not widen that claim, and the VPN mode's wording keeps whatever plan 51 already says.

### 3.6 Off, and what the device is left as

The brief's F5 is right that the revert is not symmetric, and plan 33 §5's own prescription (`settings put global http_proxy :0`) is exactly the asymmetric one — it leaves the literal string `:0` where a pristine device had `null`. **This plan does not follow that prescription**, and correcting it is one of the plan's outputs.

The design copies `screen-label.ts` (F7), which solved this for `secure` keys:

1. **On the first apply for a device**, before writing anything, read all four keys — `http_proxy`, `global_http_proxy_host`, `global_http_proxy_port`, `global_http_proxy_exclusion_list` — normalising Android's literal `null` to `''`, and persist the result on `devices.network_route` as `captured: { … , at }`. Captured **once**, never overwritten by a later re-apply, so a farm-set value can never become the "original".
2. **Write**, then **read back and compare**. A mismatch is `verified: false` and the route reports `setting: fail` with what the device actually said. It is never reported as applied.
3. **On revert**, re-issue the captured values verbatim. Idempotent: it consults no "already reverted" flag and re-issuing is harmless, which is what makes it safe on a teardown path that may run twice.
4. **If nothing was captured** — a route that predates this plan, or a capture that failed because the device was unreachable — clear all four keys to Android's default and **say so in the UI**: *"This phone had no saved original proxy value, so it was cleared rather than restored."* A sentence, not a silent difference.
5. **H7 is what tells us whether step 3 lands exactly.** Until it runs, the panel reports what it wrote back rather than claiming the device is as it was.

For `adb-reverse-proxy`, revert has a second half: tear down the `adb reverse` entry as well. Order matters — clear the setting **first**, then the reverse, so there is no window where the phone is pointed at a port that has just stopped answering.

### 3.7 Reboot, reconnect, and what the farm promises

The layer's existing rule (F14, spec §7.9 rule 1) is that a route belongs to the device and is **restored by probing first, never blindly re-applied**. That rule extends cleanly, but the three modes have genuinely different physics and the plan states each rather than averaging them:

| event | `adb-proxy` | `adb-reverse-proxy` | `vpn-helper` |
|---|---|---|---|
| lease released / expired | route untouched | untouched | untouched (plan 52) |
| device reboot | **H1** — expected to survive as a settings row; on device-online the farm reads it back and re-applies only if it does not match | the setting survives, **the reverse does not** (H3) — the reverse is re-established, then the setting verified | restored by probing (plan 52/54) |
| adb reconnect / replug | **H2** — expected untouched; verified on device-online anyway | reverse re-established (H3) | as today |
| core restart | nothing on the device changed; the reconcile pass verifies | **the reverse is gone** — every enabled reverse route re-establishes at boot, in the same pass that already restores VPN routes | as today (`reconcileNetworkRoutes`) |
| upstream dies | the phone keeps the setting; honouring clients fail, others do not (**H6**) — `upstream: fail`, `health: degraded` | same, plus `reverse` may still pass, which is the confusing case the report must word carefully | `held`, `failClosed` default `true` (plan 54) |
| device forgotten / agent removed | route cleared and the captured value restored | plus the reverse torn down | as today |

**The promise the farm makes, in one sentence per mode, and it goes in the UI:**

- HTTP proxy → *"This setting stays on the phone across reboots and reconnects. The farm checks it whenever the phone comes back and re-applies it if something changed it."*
- HTTP proxy on this farm's machine → *"…and the tunnel from the phone to this machine is rebuilt every time the phone reconnects or the farm restarts. Between the phone coming back and the tunnel being rebuilt, apps using the proxy will fail to connect."* That last clause is the honest cost of rung 2 and it is not omitted.
- VPN → whatever plan 52/54 already promise, unchanged.

There is one thing the farm must **not** promise: that a route survives a factory reset, a user manually clearing the setting from Android's own UI, or a device-owner policy overwriting it. Drift is what those look like, and drift is already a first-class field (`NetworkStatus.drift`).

### 3.8 Credentials

Three rules, one per rung.

**`adb-proxy` stores no credential and refuses one.** Not "discourages" — refuses, with a coded error, because F6 makes it a device-wide disclosure and spec §7.9 already forbids it in writing. The refusal has two triggers:

- a `username` or `password` field on the request → `E_HTTP_PROXY_NO_AUTH`
- a pasted URL with a userinfo component (`http://user:pass@host:8080`) → the same code, refused **in the paste parser**, before the value reaches a field, because the existing SOCKS form has a paste box (`NetworkRouteForm.tsx:521-527`) and an operator moving between modes will paste the string they already have

The message names the alternative rather than only saying no: *"Android's system proxy setting has no place for a username or password, and every app on the phone can read it. To use a proxy that needs an account, run it on this farm's machine — the phone dials it over the adb connection and the account never reaches the phone."*

**`adb-reverse-proxy` holds no credential either, and this is the elegant part.** The device dials `127.0.0.1:<devicePort>` on its own loopback, tunnelled to a listener on the farm's machine. That listener holds the upstream account — and per plan 112 §3.9 it is bound to loopback and needs no listener-side auth, because a loopback proxy has no network segment to be eavesdropped on. So the built-in path stores **zero proxy passwords for both HTTP rungs**. There is nothing to leak because there is nothing to hold.

The capability descriptor must not over-claim this. `NetworkCapabilitiesSchema.auth` describes what **the engine** supports (`packages/protocol/src/network.ts:33`), and this engine supports none — the credential is somebody else's. So `auth: false` for both HTTP rungs, and the delegation is stated in the descriptor's `displayName` and in the UI, not smuggled into a `true`. Advertising a capability the engine does not have is the exact failure `NetworkCapabilitiesSchema`'s own doc comment exists to prevent.

**`vpn-helper` is unchanged**: `network_credentials`, AES-256-GCM, `credentialRef` on the config, `redactRouteConfig()` on every outbound path, and the honest boundary claim from the store's own header repeated wherever it is shown (F15).

**And nothing here goes near plugin KV**, so F16's `secretHint` leak is not in this plan's path. Worth saying out loud because the temptation exists: if the bulk path ever wanted to remember "which proxy did I assign", the obvious place would be the plugin's KV, and that would inherit 112's F12. It does not — the assignment is the plugin's own record, written by the plugin, and 112.2 is still 112's fix to make.

### 3.9 Bulk, and what partial failure looks like

The owner asked for this twice, so it is a first-class surface rather than a follow-up. It follows the existing grain exactly (F18, F19); the plan's contribution is the classification, not a new pattern.

**Client side.** A `BulkProxyDialog` composed the way every other bulk dialog is: `devices` (the pre-filled default, never a lock) + `allDevices` (the pool) + `clusters` as props; a module-scope `TARGET_ALLOW = ['single', 'cluster', 'devices']`; `useTargetSelection` + `TargetPicker`; `reset()` on `open`, not on every render; the dialog stays open and swaps its body form → report; the footer swaps Cancel/Apply → Close. It reads the resolved count from the hook rather than computing its own — plan 104 §3's rule that the resolved count is always visible rather than revealed at submit.

**Server side.** `POST /api/devices/network/apply`, synchronous, `labels/apply`'s envelope (F19) because a settings write is a sub-second operation and minting a batch for it would put a job row and a tray entry behind something that finishes before the dialog repaints:

```ts
// packages/protocol/src/api/devices.ts
DeviceNetworkApplyBodySchema = z.object({
  deviceIds: z.array(z.string()).min(1),
  route: PersistedNetworkRouteConfigSchema,   // the discriminated union from §4.1
})
DeviceNetworkApplyResultSchema = z.object({
  deviceId: z.string(),
  status: DeviceNetworkStatusResponseSchema.nullable(),  // null only when the call threw before producing one
  skip: z.object({ code: z.string(), message: z.string() }).nullable(),
  error: z.string().nullable(),
})
DeviceNetworkApplyResponseSchema = z.object({ total: z.number().int(), results: z.array(...) })
```

The three-way split is `device-label.ts:74-82`'s, verbatim in intent: **threw** (`status: null`, `error` set) / **reported a normal bad outcome** (`status` present with `checks` saying what failed) / **ok**. A `skip` is a first-class outcome carrying a code and a message, following `CommandMemberSchema`'s own precedent (`packages/protocol/src/command/target.ts:49-50`).

**The classification — this is the part that is specific to this feature, and it is where the plan earns its keep, because these are the cases that actually happen across forty phones:**

| outcome | code | when |
|---|---|---|
| applied | — | write accepted, read-back matched |
| applied, unverified | — | write accepted; this is the normal HTTP-mode terminal state, and it is **not** counted as a failure |
| skipped | `E_DEVICE_OFFLINE` | the device is not reachable; the route is **saved** so it applies when the device returns, and the message says so |
| skipped | `E_DEVICE_HELD` | someone else holds control; §9 Q2 asks whether bulk should take over |
| skipped | `E_AGENT_NOT_READY` | VPN mode chosen, agent `absent`/`failed`/`outdated` on this device — carries the per-device reason verbatim so twenty identical reasons group into one row |
| skipped | `E_UNSUPPORTED` | agent `unsupported` (SDK floor), or H8's answer forbids `adb-proxy` on this transport |
| failed | `E_SETTING_NOT_ACCEPTED` | the write went through and the read-back disagreed — the device declined |
| failed | `E_REVERSE_FAILED` | rung 2 only: `adb reverse` did not establish |
| failed | *(verbatim)* | anything else, message from the thrown error |

**Grouping.** `SkippedGroups` groups by the **exact** reason string and every group expands to named devices. The grouping key here is deliberately the code plus the message, not the code alone: twenty devices whose agent is `failed` for the same reason collapse into one row, and one device that failed for a different reason stays visible instead of being absorbed into a count. That is `docs/design.md:141`'s rule applied to this domain's own variation.

**Leases.** Every network write today is `requireHeldLease` (F14). A bulk apply across forty devices cannot mean the operator holds forty leases. The design: the bulk path **acquires a transient lease per device, serially, and releases it immediately** — which is consistent, because plan 52 made the route device-scoped and left the lease as an admission check rather than the route's lifetime. A device already held by someone else is skipped with `E_DEVICE_HELD`, named in the report, never taken over silently. §9 Q2 asks the owner whether a bulk apply should be able to take over from a person, and recommends no.

**Not a tray operation** (F20). If H-scale measurement later shows a forty-device apply taking long enough to want cancelling — the guest-agent install path in VPN mode is the realistic candidate, since that is an APK push per device — then it mints a batch instead and inherits concurrency, cancel and a tray entry for free. That is the escape hatch, named now so it is not discovered as a surprise.

### 3.10 The panel, rebuilt around a mode

`NetworkRouteForm` today is a SOCKS5 form with a route-status readout (903 lines). It becomes a mode selector with three bodies, and the structural change is that **the mode selector renders before and above everything the agent gates**, so an agent-less device sees a working screen (fixing F12).

```
Network → Proxy
┌─ mode ────────────────────────────────────────────────────────────────┐
│ ( ) Off                                                                │
│ ( ) HTTP proxy    Apps can ignore this. WebView and many HTTP          │
│                   libraries use it; an app with its own networking     │
│                   does not, and nothing on the phone stops it.         │
│ (•) VPN           Apps cannot opt out of this. Needs the Enkaku        │
│                   guest agent installed on the phone.                  │
└────────────────────────────────────────────────────────────────────────┘
```

- **Off** — if a route exists, an explicit *"Turn off"* with the §3.6 restore sentence attached.
- **HTTP proxy** — one further question (*where is the proxy?* → *a proxy the phone can reach* / *a proxy on this farm's machine*), host, port, a paste box that refuses userinfo (§3.8), and no credential fields at all. Underneath, the permanent §3.5 sentence.
- **VPN** — the existing SOCKS5 form unchanged, behind the §3.4 precondition when the agent is not ready.

The route status readout keeps `.readout` monospace and its existing `Row label/value` shape, and gains a `mode` row above `engine`. The one word that changes is the enabled row: in HTTP mode it reads `asked` rather than `yes`, and a second row reads `setting confirmed on the device: yes | no | not checked yet`.

---

## 4. Technical design

### 4.1 The route config becomes a discriminated union

```ts
// packages/protocol/src/network.ts

export const NetworkEngineIdSchema = z.enum(['none', 'adb-proxy', 'adb-reverse-proxy', 'vpn-helper'])

/** Rung 1 (spec §7.9, plan 33 §5). No credential field, deliberately — see §3.8 and `E_HTTP_PROXY_NO_AUTH`. */
export const HttpProxyRouteConfigSchema = z.object({
  engine: z.literal('adb-proxy'),
  host: z.string().min(1).meta({ title: 'Proxy host' }),
  port: z.number().int().min(1).max(65535).meta({ title: 'Proxy port' }),
  /** Written to `global_http_proxy_exclusion_list`. Optional; §9 Q4 asks whether the farm ever needs a default. */
  exclusions: z.array(z.string()).optional(),
})

/** Rung 2. `hostPort` is where the proxy listens ON THE FARM; the device-side port is allocated per device and never chosen by the operator. */
export const ReverseProxyRouteConfigSchema = z.object({
  engine: z.literal('adb-reverse-proxy'),
  hostPort: z.number().int().min(1).max(65535).meta({ title: 'Port on this machine' }),
  exclusions: z.array(z.string()).optional(),
})

/** Unchanged in shape; gains a literal tag so it can join the union. */
export const Socks5RouteConfigSchema = z.object({ engine: z.literal('vpn-helper'), /* …every existing field… */ })

export const NetworkRouteConfigSchema = z.discriminatedUnion('engine', [
  HttpProxyRouteConfigSchema,
  ReverseProxyRouteConfigSchema,
  Socks5RouteConfigSchema,
])
```

**Reading a row that predates this.** `devices.network_route.config` on disk has no `engine` field. `readPersistedRoute` preprocesses: a config with no `engine` is a `vpn-helper` config, tagged on read and rewritten on the next write. This is a migration, not a compatibility shim, and it follows the discipline `failClosed`/`sessionId`/`exitHistory` already established (`packages/protocol/src/network.ts:334-371`) — an absent field means "predates the plan", never a guessed default. `00-overview.md` §9 gains a row.

`PersistedNetworkRouteSchema` gains two fields:

```ts
  /** §3.6. The device's own values before this farm ever wrote one. Captured ONCE, on first apply, never overwritten. */
  captured: z.object({
    httpProxy: z.string(),
    host: z.string(),
    port: z.string(),
    exclusionList: z.string(),
    at: z.number().int(),
  }).optional(),
  /** §3.3. Who set this route — a person, or a plugin. Never absent on a route written after this plan. */
  setBy: z.object({ kind: z.enum(['user', 'plugin']), id: z.string(), at: z.number().int() }).optional(),
```

`RouteCheckIdSchema` widens by two: `'setting'` and `'reverse'` (§3.5). `deriveHealth` is **not** touched.

`NetworkStatusSchema.declared` and `DeviceNetworkStatusResponseSchema.config` both become `NetworkRouteConfigSchema.nullable()`. Studio's hand-written mirror at `packages/studio/src/lib/api.ts:220` is replaced by the protocol type rather than re-typed — plan 72's rule that a response shape is declared once and parsed on both sides.

### 4.2 Two new engines, and where they are constructed

```ts
// packages/drivers/src/network/adb-proxy/http-proxy.ts
export function createHttpProxyRoute(deps: {
  transport: Transport
  deviceId: string
  /** Reads/writes the persisted capture. The engine holds no state of its own. */
  capture: { read(): CapturedProxy | null; write(c: CapturedProxy): void }
  onLog?: (level: 'debug' | 'info' | 'warn', msg: string) => void
}): NetworkRoute
```

`apply` / `observe` / `revert` map onto the four `settings` keys as §3.6 describes, with `probe` and `hold` **absent** — the optionality on `NetworkRoute` (F4) means an engine that cannot probe simply does not define the method, and the caller discovers that rather than assuming it.

```ts
// packages/drivers/src/network/adb-proxy/reverse-proxy.ts
export function createReverseProxyRoute(deps: {
  transport: Transport
  reverse: ReversePort            // §4.3 — establish/tear down, and re-establish on reconnect
  devicePorts: PortAllocator      // the device-side port; the host side is the operator's
  /* …capture, deviceId, onLog as above… */
}): NetworkRoute
```

Both are constructed where `vpn-helper` already is — `packages/core/src/api/guest-agent.ts:2342`'s site becomes an engine switch on `config.engine` (F5: there is no session factory to add them to, and pretending otherwise would be the plan's first false claim). That file is 2610 lines already, so step 114.3 extracts the route-lifecycle half into `packages/core/src/network/` first and moves the existing `vpn-helper` construction with it; adding two more engines to a file that size without splitting it is how the next plan inherits a 3500-line module.

Descriptors join `packages/drivers/src/descriptors.ts` beside the two at `:132-165`, both with `locks: ['network-route']` and every capability `false`, and both with a `displayName` that states the advisory property rather than a neutral name — because `GET /api/registry` serves that string to Studio and a stale or flattering descriptor is visible in the product, which is the mistake DIV-068 already caught once (`descriptors.ts:144-151`).

### 4.3 `adb reverse`, and the registry that survives a reconnect

`HostAdb` has no per-verb methods — only a generic `run(args)` under a bounded deadline (`packages/core/src/device/host-adb.ts:81`, `DEFAULT_RUN_TIMEOUT_MS` at `:29`), and the repo's one `forward` wrapper lives on `GuestAgentLauncher` (F9). So the reverse wrapper does **not** go on `HostAdb`. It goes beside the registry below, as two small functions over `hostAdb.run(['-s', serial, 'reverse', …])` and `run(['-s', serial, 'reverse', '--remove', …])`, matching `launcher.ts:292-293`'s own shape — a reverse is a control-socket round trip, so the ordinary-command deadline is right and no new profile is needed.

Above it, `packages/core/src/network/reverse-registry.ts`: a map of `deviceId → { devicePort, hostPort }`, and a hook on the device-online transition that re-establishes every entry for a device whose route is enabled. This is H3's insurance, built whether or not the probe confirms it — a reverse that turns out to survive costs one redundant idempotent call per reconnect, and one that does not and was assumed to would leave a device silently pointed at nothing.

The device-side port comes from `PortAllocator` (`packages/session/src/port-allocator.ts:19`), which already bind-tests and is already the one thing that allocates per-device ports. Note what it allocates: **host** ports for `adb forward`. A reverse needs a **device**-side port, which the host cannot bind-test — so the registry keeps its own device-port range and treats a failed `adb reverse` as the collision signal, since that is the only signal available. Written down because the asymmetry is easy to miss.

### 4.4 The route lifecycle, per engine

`applyRoute` / `revertNetwork` / `restoreDeviceRoute` / `reconcileNetworkRoutes` (`packages/core/src/api/guest-agent.ts:2008`, `:2049`, `:2090`) become engine-aware. The shape is one dispatch, not four parallel implementations:

```
applyRoute(row, config):
  engine = buildEngine(config.engine, row)      // ← the one switch
  assertLockFree(row, config.engine)            // 'network-route': revert the incumbent first, always
  if first apply for this device: capture()      // §3.6, once
  engine.apply(resolved(config))                 // credentialRef resolved in-memory, never persisted
  checks = runChecks(engine, config.engine)      // §3.5's per-engine table
  persist({ config, enabled: true, captured, setBy })
  record('network.applied', { engine, actor, redacted })
```

`assertLockFree` is what makes the lock real: switching a device from VPN to HTTP proxy **reverts the VPN route first**, in the same request, and a failure to revert refuses the new apply rather than leaving two half-applied routes. Never "apply the new one and hope".

The recovery machinery (plan 54/90: bounded attempts, backoff, `recoveryRearmSec`, `maxRecoveryCyclesPerHour`) stays **VPN-only**. There is nothing to recover in HTTP mode — the setting either reads back or it does not, and retrying a settings write on a backoff would be theatre. `NetworkStatus.recovery` is `null` for the HTTP engines, which is already its "nothing has ever needed recovery" reading (`packages/protocol/src/api/devices.ts:313-318`).

### 4.5 Endpoints

| method | path | change |
|---|---|---|
| `GET` | `/api/devices/:id/network` | unchanged shape; `config` is now the union, `checks` may carry the two new ids |
| `PUT` | `/api/devices/:id/network` | body is the union; refuses `E_HTTP_PROXY_NO_AUTH`, `E_ROUTE_LOCK_HELD`; stamps `setBy` |
| `POST` | `/api/devices/:id/network/enable`, `/disable`, `/retry` | unchanged; `/retry` refuses on the HTTP engines with `E_NOT_SUPPORTED` and a message saying why (there is no recovery loop to clear) |
| `DELETE` | `/api/devices/:id/network` | unchanged; now restores the capture (§3.6) |
| `POST` | **`/api/devices/network/apply`** *(new)* | §3.9's bulk envelope. A **static** route mounted before `/:id`, for the same shadowing reason `/labels/apply` and `/numbers/compact` are (`packages/core/src/api/devices.ts:560-566`) |

All are `requirePermission('device.network')`, which already exists and is already enforced.

### 4.6 Studio

| file | change |
|---|---|
| `components/guest-agent/NetworkRouteForm.tsx` | becomes the mode selector plus three bodies (§3.10); the SOCKS5 half is moved into `VpnRouteFields`, not rewritten |
| `components/guest-agent/NetworkPanel.tsx` | stops gating the whole panel on `status.state === 'ready'` (F12) — that gate moves inside the VPN body as §3.4's precondition |
| `components/guest-agent/HttpProxyFields.tsx` *(new)* | host/port/paste-with-userinfo-refusal, the where-is-the-proxy choice, the permanent §3.5 sentence |
| `components/network/BulkProxyDialog.tsx` *(new)* | §3.9, composing `TargetPicker`/`useTargetSelection`/`OutcomeSummary`/`SkippedGroups` |
| `app/page.tsx` | one entry in the bulk actions menu, taking `devices`/`allDevices`/`clusters` from the existing selection props — there is no selection store to reach for (plan 104's model is lifted local state threaded as props) |
| `lib/api.ts` | the hand-written `NetworkEngineId` mirror at `:220` is deleted in favour of the protocol type |

Both device surfaces get it for free: the panel is registered once in `SettingsPopup` and once as a device-page tab (F13).

---

## 5. Implementation steps

Ordered so nothing is claimed buildable before its substrate exists.

**114.1 — the protocol widens.** `packages/protocol/src/network.ts`: `NetworkEngineIdSchema` grows two ids; `HttpProxyRouteConfigSchema`, `ReverseProxyRouteConfigSchema`, the `engine` literal on `Socks5RouteConfigSchema`, and `NetworkRouteConfigSchema` as the discriminated union; `RouteCheckIdSchema` grows `setting` and `reverse`; `PersistedNetworkRouteSchema` grows `captured` and `setBy`; the read-time migration that tags an untagged config as `vpn-helper`. `packages/protocol/src/api/devices.ts` follows. `deriveHealth` is untouched and a test asserts it. *Result:* every existing consumer typechecks against a union, and a pre-plan row on disk still parses.

**114.2 — the `adb-proxy` engine, host-side, no UI.** `packages/drivers/src/network/adb-proxy/http-proxy.ts`, modelled on `packages/session/src/screen-label.ts` (F7): capture → write → read back → report `verified` → restore-captured on revert, idempotent, with the "nothing was captured" fallback. `probe`/`hold` deliberately undefined. Unit tests against a fake `Transport` covering: the literal `null` normalisation, a write the device declines, a revert with and without a capture, and a double revert. *Result:* an engine that can set and unset a device proxy and has never once claimed a success it did not read back.

**114.3 — the core's route lifecycle becomes engine-aware, and moves out of a 2610-line file.** Extract the route half of `packages/core/src/api/guest-agent.ts` into `packages/core/src/network/route-service.ts`, carrying `vpn-helper`'s existing construction unchanged, then add the `buildEngine` switch, `assertLockFree`, the capture-once rule, and the per-engine `runChecks` table from §3.5. `PUT /:id/network` accepts the union and refuses `E_HTTP_PROXY_NO_AUTH`. *Result:* an `adb-proxy` route can be set and unset through the API, `health` reads `unverified`, and a device already holding a VPN route is reverted before the new one applies.

**114.4 — `adb reverse` exists, and survives a reconnect.** `packages/core/src/network/reverse-registry.ts`: the two `hostAdb.run(['reverse', …])` wrappers (**not** new methods on `HostAdb` — see §4.3 and F9), the map of `deviceId → { devicePort, hostPort }`, its device-online re-establish hook, and its own device-port range. Run **H3** here. *Result:* a host-local listener is reachable from a phone at `127.0.0.1:<port>`, and still is after a replug.

**114.5 — the `adb-reverse-proxy` engine.** `packages/drivers/src/network/adb-proxy/reverse-proxy.ts`, composing 114.2's settings writer with 114.4's reverse. Revert order is setting-then-reverse (§3.6). The `reverse` check. *Result:* a phone can be pointed at a proxy on the farm's machine, and the credential for that proxy never touches the phone.

**114.6 — the mode selector.** `NetworkRouteForm` splits into the selector plus `HttpProxyFields` and `VpnRouteFields`; the paste parser refuses userinfo; the permanent §3.5 sentence renders in HTTP mode; the status readout gains `mode` and `setting confirmed on the device`, and reads `asked` rather than `yes`. Rendered through plan 72's DOM renderer, because a UI step is not verified until its screen has been rendered. *Result:* an operator can choose a mode and read, on the screen, what each one does and does not guarantee.

**114.7 — the agent-missing path.** `NetworkPanel` stops gating the whole panel on `state === 'ready'` (F12); the gate moves inside the VPN body as §3.4's five-state precondition, wired to `devices.preparation['guest-agent']` and to the existing install and preparation-retry endpoints. Declining leaves the mode unsaved and applies nothing. *Result:* a phone with no agent has a working proxy screen, and choosing VPN on it offers the install rather than an error — and never silently downgrades.

**114.8 — bulk.** `POST /api/devices/network/apply` with §3.9's envelope and classification; `BulkProxyDialog` composing the four existing shared components; one entry in the bulk actions menu. A test that forty devices with three distinct failure reasons render as three expandable groups with the failures first. *Result:* a route can be set across a selection, and a partial failure names every device behind every count.

**114.9 — the plugin boundary.** `setBy` is stamped on every write and rendered in the panel; the plugin reaches `PUT /api/devices/:id/network` through the plugin surface with `device.network` permission rather than any second path; `plugins/proxy-manager/src/shared.ts`'s standing caveat is **replaced** with §3.3's narrower sentence, declared once so the manifest and the screen cannot drift, and `index.test.ts` is extended rather than relaxed. *Result:* a proxy assigned in the plugin can be applied to a device through the one door, and the device says who set it.

**114.10 — documentation, and the corrections this plan owes.** Spec §7.9's table rows for `adb-proxy` and `adb-reverse-proxy` change from *"deferred, not shipped"* to shipped, with their advisory property kept verbatim; spec §7.1's Network row follows; `00-overview.md` §9 gains a row for the `captured`/`setBy`/`engine` schema changes. **Amend `docs/plans/109-m74-plugin-runtime.md:5`** so it stops asserting a removal that never happened (§0.2). **Correct `docs/plans/33-m15-device-network.md:207`'s `:0` revert prescription** to point at §3.6, so the next reader does not implement the asymmetric reset. Narrow `docs/plans/112-m77-proxy-manager.md` §3.12's standing sentence. The `packages/drivers` README gains the two engines and their capability table. *Result:* no document in the repo still says this is deferred, and none still says the layer is being removed.

---

## 6. Acceptance criteria

1. A device with **no guest agent installed** shows a working Network → Proxy screen with all three modes visible, and can have an HTTP proxy applied end to end.
2. The mode selector renders, on screen, a sentence stating that HTTP proxy is bypassable and one stating that VPN is not. Asserted by a rendering test against the literal strings, so the wording cannot be quietly softened.
3. `GET /api/devices/:id/network` for an `adb-proxy` route returns `health: 'unverified'` with `egress` in state `skip`. **A test asserts `health` can never be `'ok'` for either HTTP engine, on any combination of check states.**
4. No string anywhere in the HTTP-mode UI reads `routed`, `enabled` alone, `ok`, or `success`. Asserted by a grep test over the component, in the same spirit as plan 51's acceptance criterion 8.
5. Applying a route writes it, reads it back, and reports `setting: fail` with the device's actual value when they disagree — never `applied`.
6. Turning a route off restores the four captured values; on a device with no capture it clears them and **says on screen** that it cleared rather than restored.
7. Switching a device from VPN to HTTP proxy reverts the VPN route first, in the same request; a failed revert refuses the new apply. A device is never observed with two routes.
8. `PUT` with a `username`, a `password`, or a pasted URL carrying userinfo is refused with `E_HTTP_PROXY_NO_AUTH`, and the message names where credentials do go.
9. `POST /api/devices/network/apply` across a mixed set (one offline, one held, one with no agent while VPN is requested, one that works) returns four distinct outcomes; the dialog renders failures first, grouped by exact reason, every count expandable to named devices.
10. `adb reverse` is re-established after a device replug without operator action, and `GET /api/devices/:id/network` reports `reverse: fail` in the window before it is.
11. A plugin can apply a route only through `PUT /api/devices/:id/network`; a grep test asserts no `settings put` string exists anywhere under `plugins/`.
12. The device event log records `network.applied` / `network.reverted` for every mode with an actor and no secret, and the panel shows `setBy`.
13. Spec §7.9 no longer describes these engines as deferred; `docs/plans/109-m74-plugin-runtime.md:5` no longer asserts a removal; `bash scripts/check-plan-status.sh` passes.
14. `bun run typecheck` is clean, and the tests for every file touched pass.

## 7. Test plan

**Unit — `packages/drivers`**
- `http-proxy.test.ts`: `null` normalisation; capture-once (a second apply does not overwrite); write-then-read-back mismatch → `verified: false`; revert with a capture; revert with none; double revert is a no-op; `probe`/`hold` are `undefined`.
- `reverse-proxy.test.ts`: revert order is setting-then-reverse; a failed `adb reverse` fails the apply and does not leave the setting pointing at a dead port.

**Unit — `packages/protocol`**
- `network.test.ts`: the union discriminates; an untagged persisted config reads back as `vpn-helper`; `deriveHealth` is unchanged for every existing input **and** returns `unverified` for the HTTP engines' check set on every permutation.

**Unit — `packages/core`**
- `route-service.test.ts`: `assertLockFree` reverts the incumbent; a failed revert refuses; `setBy` is stamped for both a user and a plugin actor; `/retry` refuses on HTTP engines; `E_HTTP_PROXY_NO_AUTH` on all three triggers.
- `reverse-registry.test.ts`: device-online re-establishes; a device with a disabled route does not.
- `devices.network-apply.test.ts`: the four outcome classes; a thrown call produces `status: null` with an `error`; a normal bad outcome produces a `status` and no `error`.

**Unit — `packages/studio`** (run **only** `packages/studio/src/components/guest-agent/` and `packages/studio/src/components/network/` — never the full suite; CLAUDE.md's rule, and the six-minute incident it records)
- the mode selector renders both sentences verbatim; the forbidden-word grep; the agent-missing precondition for each of the five states, with no Retry on `unsupported`; the bulk report's outcome-first grouping.

**Manual smoke — the owner's, on a device that is not in use.** Every command below changes a real phone.

```bash
# 0. baseline — record it, this is the capture the farm will restore
adb -s <serial> shell settings get global http_proxy
adb -s <serial> shell settings get global global_http_proxy_host
adb -s <serial> shell settings get global global_http_proxy_port

# 1. HTTP proxy, direct
#    Studio → device popup → Settings → Network → HTTP proxy → a proxy the phone can reach
#    host/port → Apply
adb -s <serial> shell settings get global http_proxy        # expect host:port
#    → panel reads: mode HTTP proxy · setting confirmed on the device: yes · health unverified
#    → the bypassable sentence is on screen

# 2. H1/H2 — reboot and replug
adb -s <serial> reboot && adb -s <serial> wait-for-device
adb -s <serial> shell settings get global http_proxy        # H1
#    unplug, wait 30s, replug
adb -s <serial> shell settings get global http_proxy        # H2

# 3. off — the restore, not `:0`
#    → Turn off
adb -s <serial> shell settings get global http_proxy        # expect the step-0 value, verbatim

# 4. HTTP proxy on this farm's machine  (needs a listener; plan 112's bridge on 9902 is the obvious one)
#    → HTTP proxy → a proxy on this farm's machine → port 9902 → Apply
adb -s <serial> reverse --list                              # expect one entry
adb -s <serial> shell settings get global http_proxy        # expect 127.0.0.1:<devicePort>
#    unplug/replug, then re-check `adb reverse --list`      # H3

# 5. VPN on a phone with no agent
#    → uninstall the agent, reload, choose VPN
#    → expect a precondition naming `absent` and an Install button, NOT an error,
#      and NOT a silent fall back to HTTP proxy

# 6. bulk
#    → select 4 devices (one offline, one held by another operator) → Set proxy → HTTP proxy → Apply
#    → expect failures first, grouped by exact reason, every count expandable to names
```

**H4/H5/H6/H7/H8/H9 are run from §0.3's own probe column** and their results written back into this document, comfortable or not, the way plan 112 §0.3 recorded H2's.

## 8. Risks and mitigations

| risk | mitigation |
|---|---|
| **An operator believes HTTP proxy captures their traffic.** The whole plan exists because this is easy to believe and the UI is the only thing standing in the way. | The sentence is in the selector, not a tooltip; `health` is structurally `unverified` (criterion 3, enforced by a test over every permutation); no HTTP-mode string may read `routed`/`ok`/`success` (criterion 4, a grep test). This is defence in three independent places because one wording change would otherwise undo it. |
| **A credential ends up in a device setting anyway**, pasted rather than typed. | The paste parser refuses userinfo before the value reaches a field, and the refusal names the alternative. Refused at the API too, so a client that skips the parser is still refused. |
| **`adb reverse` turns out not to survive something we did not test** (a device sleeping, a doze transition, wireless adb). | The registry re-establishes on device-online regardless, and `reverse: fail` is a visible check rather than a silent dead port. H3 narrows the gap; it does not have to close it for the design to fail safely. |
| **Two half-applied routes after a failed switch.** | `assertLockFree` reverts first and refuses on failure; criterion 7 tests it. |
| **The bulk apply is slower than "synchronous" implies** — realistically when VPN mode triggers per-device APK installs. | Named escape hatch in §3.9: mint a batch and inherit cancel/concurrency/tray. Do not discover it as a hang. |
| **`settings put global` on a device breaks the farm's own transport.** | H8. If it does, `adb-proxy` is refused on `adb-tcp` with `E_UNSUPPORTED` — a hard gate, not a warning. Note `adb_enabled` is already the one global write the repo blocks (F17), so the precedent for a hard gate exists. |
| **The union migration silently mis-tags a stored route.** | An untagged config is `vpn-helper` by construction (it is the only engine that could have written one), asserted by a raw-SQL pre-migration row the way `scripts-kind-migration.test.ts` does. |
| **`packages/core/src/api/guest-agent.ts` grows past readability.** It is 2610 lines before this plan adds two engines. | Step 114.3 extracts first and adds second. This is sequencing, not tidiness — the alternative is a 3500-line module the next plan inherits. |
| **The plugin and a person fight over one device.** | Attribution, not locking (§3.3). A lock produces a device nobody can fix; `setBy` produces a device whose history is legible. |
| **This plan re-opens a settled decision.** `RouteVpnService.kt:26` rejects the advisory rung on record. | It stays rejected *as an equivalent*. This plan builds it as a labelled lesser rung and does not touch that comment. §3.1 and §3.2 are the argument; if the owner disagrees, §9 Q5 is where to say so. |

## 9. Open questions

**Q1 — two modes with a sub-choice, or three flat modes?** The owner asked for two (*http proxy, vpn*). But an HTTP proxy with an account is only possible through rung 2 (F6), so the design shows two modes and asks *where is the proxy?* inside HTTP mode. The alternative is three flat modes, which is more honest about the mechanism and less like what was asked for. **Recommendation: two with a sub-choice**, because the sub-question is one an operator has to answer anyway.

**Q2 — may a bulk apply take over a device someone else holds?** Today every network write requires the lease. §3.9 skips a held device with `E_DEVICE_HELD` and names it. The alternative — bulk takes over, the way plan 71's takeover dialog does with a warning — is faster and more surprising. **Recommendation: skip and name.** A route change on a phone somebody is actively driving is exactly the change they will not notice.

**Q3 — a route and a new tenant.** Plan 52 answered this for VPN: no teardown, ownership plus audit instead. For an advisory setting the case is arguably worse, because a new operator cannot see it from inside an app. Should the mode appear on the Wall tile and the devices list, the way plan 52 put route and health on the list? **Recommendation: yes, one chip, mode only** — a chip per check would be plan 48's tile-density problem again.

**Q4 — does the farm ever need to set `global_http_proxy_exclusion_list` itself?** The schema carries `exclusions` as operator input. Is there any farm-side address that must always be excluded — the core's own host, a probe endpoint — or is that the operator's business entirely? Guessing here would silently exempt traffic somebody wanted proxied.

**Q5 — should `adb-proxy` be refused, or discouraged, when the agent IS ready?** A farm could push operators toward the enforcing rung by hiding the advisory one where the enforcing one is available. **Recommendation: no** — refusing a capability the operator asked for is worse than labelling it, and there are legitimate reasons to want the advisory rung on a device that could run the VPN (testing what an app does when the system proxy is set, for one). But it is the owner's call.

**Q6 — does assigning a proxy in the plugin apply it, or only record intent?** Plan 112's Assignments tab today records intent and says so. Once the built-in exists, an Apply button there is a small step. **Recommendation: explicit Apply, never implicit** — an assignment that silently changes forty phones' networking on save is the wrong default, and 112 §3.5's own intent-versus-state discipline points the same way.

**Q7 — does F22's known gap change what VPN mode may claim, now that a weaker mode sits beside it?** Plan 51 records that the agent excludes itself from its own tunnel, so a passing `egress` check measures the SOCKS5 upstream rather than the datapath other apps use. That was tolerable when VPN was the only mode. With an explicitly-bypassable mode beside it, the contrast invites reading VPN's `ok` as stronger than it is. Should VPN mode's wording narrow too, or is closing the gap in the agent the right answer? This is a question about the APK, not about this plan, but this plan is what makes it visible.

**Q8 — the SDK.** Plan 33 §4.8 designed `ctx.device.network.*` and it has never existed (§2). With three modes instead of one, a script that wants to set a proxy has no path at all. Is that a gap worth closing, and if so does it belong in plan 63's capability registry rather than as a bespoke SDK surface?
