# Plan 44 — M15v : first working proxy, end to end

> Status: implemented — a SOCKS5 full-tunnel route with username/password can be applied to a device through the core API and carries real traffic, verified on Android 15 hardware; the token-rotation and dead-man's-switch fixes in §8b are in the tree.
> Ships: packages/drivers/src/network/guest-agent/vpn-helper.ts
> **Type:** a **delivery slice**, not a milestone. It does not add scope — it selects the minimum subset of Plan 33 and Plan 43 that makes one concrete thing work, and defers everything else in both.
> **Consumes:** Plan 33 §5.1–5.4, §5.6–5.8, §5.11 · Plan 43 §5.4, §5.5 (partly), §5.8, §5.8b
> **Spec references:** §7.9 (network layer), §7.10 (first-party agent), §17 (positioning).
> **Research:** `docs/research/android-guest-agent.md`.

---

## 0. Why this document exists

Work on the proxy feature was spread across two large plans, and roughly 70% of the device-side APK got built while the host side stayed at zero. The result compiles, and does nothing a user can reach. That is a direction problem, not an engineering one, and this document exists to fix it: **one goal, one ordered path, everything else explicitly deferred.**

The goal is a single sentence, and everything below is judged against it:

> **An operator opens Studio, points a device at a SOCKS5 proxy with a username and password, and the device's traffic — all of it — leaves through that proxy.**

Anything that does not move that sentence forward is out of scope here, however worthwhile it is elsewhere.

## 1. Goals

1. A device page (or a Guest Agents view — §4.6) in Studio accepts a SOCKS5 upstream: host, port, username, password.
2. Pressing apply installs the agent if needed, brings the route up, and shows a status that reflects the **device's** answer rather than the request that was sent.
3. All device traffic leaves via the proxy — a full tunnel, not an advisory `http_proxy` setting an app can ignore.
4. Releasing the lease tears the route down. So does lease expiry and the device going offline.
5. The whole flow is driven from the browser. No terminal.

## 2. Non-goals — deferred deliberately, each with its home

Naming these is half the point of this document. None of it blocks the goal.

| Deferred | Why it can wait | Lives in |
|---|---|---|
| `adb-proxy` and `adb-reverse-proxy` engines | Different rungs of the ladder; the goal is the enforcing VPN route | Plan 33 §5.5 |
| `ctx.device.network.*` in the SDK | Script API; the goal is a manual UI test | Plan 33 §5.10 |
| Dead-config guard test | Quality gate, not a blocker — but see §8 | Plan 33 §5.9 |
| Toolchain manifest entry for the APK | `ENKAKU_GUEST_AGENT_PATH` already resolves a local build | Plan 43 §5.5 |
| Per-release pinning smoke test | Needed before shipping, not before proving | Plan 43 §5.10 |
| CI, release signing, published artifact | Same | Plan 43 §5.11 |
| Egress probe (`probe()`) | Needs a socket protected out of our own tunnel; status without it is `unverified`, which is honest | Plan 43, later |
| Bulk install, fleet column, filters | One device is enough to prove the path | Plan 43 §4.5 |

## 3. Where things actually stand

*This section described the state before work began; it is kept because the reasoning behind the ordering still holds.* At that point there were **zero** references to a network route, a VPN helper, or the guest agent anywhere in TypeScript, `EngineDescriptorSchema.kind` was still the four original kinds, and `packages/drivers/src/network/` did not exist.

| Layer | Then | Now |
|---|---|---|
| APK — scaffold, native tunnel engine (3 ABIs, 16 KB aligned) | ✅ done | ✅ done |
| APK — control channel, `RouteVpnService`, `route.start/stop/status` | 🟡 never run on a device | ✅ **proven on Android 15** (§5.1) |
| Protocol contract | ❌ nothing | ✅ done (§5.2) |
| Host: agent launcher | ❌ nothing | ✅ done (§5.5) |
| Host: client + `vpn-helper` engine | ❌ nothing | ✅ done (§5.5, §5.6) |
| Registry — the fifth `network` kind | ❌ nothing | ✅ done (§5.3) |
| Core API + permission + event log | ❌ nothing | ✅ done (§5.8) |
| Lease revert wiring | ❌ nothing | 🟡 2 of 4 sites; TODOs at the other two in `ws-handlers.ts` |
| Studio — Guest Agents page | ❌ nothing | ✅ done (§5.9) |
| Settings persistence + read seam | ❌ nothing | ❌ still in memory only (§5.4 deferred) |

The device end being the riskiest half is why §5 began by proving it rather than building on top of it — and that judgement paid off: every `@hide` behaviour the design leans on turned out to hold, so nothing has to be redesigned.

## 4. Technical design

### 4.1 Prove the device first (the gate)

Three platform behaviours this design leans on have never been executed: `appops set ACTIVATE_VPN allow` actually suppressing the consent dialog, `VpnService.establish()` returning a usable descriptor, and `adb forward localabstract:` reaching the agent's socket. Each is documented in the research with a source, and each is `@hide` or otherwise unguaranteed.

If any fails, the host-side design changes. Building nine host-side pieces on top of an unproven device would be building on sand, so §5.1 is a manual bring-up with no code, and **the slice stops there if it fails.**

### 4.2 Protocol — one new file, plus a small edit

`packages/protocol/src/guest-agent.ts` (new) mirrors the Kotlin side exactly: `GUEST_AGENT_SOCKET`, `GUEST_AGENT_PROTOCOL = 1`, the request union (`hello`, `ping`, `route.start`, `route.stop`, `route.status`), the response envelope `{ id?, ok, result | error: { code, message } }`, and the error codes (`E_UNAUTHORISED`, `E_BAD_REQUEST`, `E_UNKNOWN_METHOD`, `E_NOT_PAIRED`, `E_NOT_PREPARED`).

`packages/protocol/src/network.ts` (new) carries `NetworkConfig` / `NetworkStatus` from Plan 33 §4.1, reduced to what a SOCKS5 route needs. `credentialRef` stays in the schema but §4.5 explains why it is not yet resolved.

### 4.3 Registry — the fifth kind

The four edits Plan 33 §4.3 lists: `kind` gains `'network'`, `RegistryResponseSchema` gains `networks`, `EngineSelection` gains `network`, and the validator loop gains the tuple. Plus `descriptors.ts` (`none`, `vpn-helper`) and Studio's `KEY_MAP`.

`vpn-helper` advertises `{ auth: true, enforcing: true, udp: true, probe: false }` — `probe: false` until the egress probe exists, because claiming a capability we do not have is the failure mode the registry exists to prevent.

### 4.4 Host side of the agent

`packages/drivers/src/network/guest-agent/`, mirroring `packages/drivers/src/inspector/ui-server/` file for file:

- `launcher.ts` — `isInstalled()` via `cmd package path` (**not** `pm list packages`, whose filter is a substring match), `ensureInstalled()` via `adb install -r -g`, then `appops set … ACTIVATE_VPN allow`, then `am start … --es token <t>` to clear the stopped state, then `adb forward localabstract:enkaku-guest-agent` **followed by the `forward --list` ownership check copied verbatim from `ui-server/launcher.ts:57-71`** — a host port silently rebound to another device would route the wrong phone.
- `client.ts` — newline-delimited JSON over the forwarded socket, request/response by `id`, `hello` first with a protocol-version check that refuses a mismatch rather than degrading.
- `vpn-helper.ts` — the `NetworkRoute`: `apply` = ensure everything then `route.start`; `observe` = `route.status`; `revert` = `route.stop` then remove the forward, idempotent and tolerant of an already-gone device.

### 4.5 Credentials, for now

Plan 33 §9 Q2 (where credentials live) is still unanswered, and answering it properly means a store, a UI, and a redaction path. For this slice the operator types the upstream into the form and it travels to the agent for the lifetime of the route only.

Two things must hold even so, because they are cheap now and expensive to retrofit: the password is **never** written to the device event log, the `jobs` table, or any API response — `getConfig()` returns it redacted — and `redactShellCommand`'s `CREDENTIAL_FLAG_RE` (`packages/core/src/device/redact.ts:23`) is extended to cover userinfo in a URL (`socks5://user:pass@host`), which it does not today.

### 4.6 Studio

A **Network tab on the device detail page** — not a top-level view. Everything per-device lives on that page, which already carries a tab strip (Control, Jobs, Monitor, Crashes, Terminal, Files, Logs, Settings); a separate top-level page was built first and was wrong, because it split one device's concerns across two places and ignored the established pattern.

The tab shows agent state (`not-installed` / `installed` / `ready` / `unreachable` / `unsupported`) with the one action that state allows, and — when `ready` — the route form and its live status. It is gated on holding control exactly as the Files tab is, rendering its controls disabled with one explanatory line rather than hiding the panel, so "Take control" takes effect without a tab switch.

`installed` and `ready` stay distinct, for the same reason declared and observed stay distinct: a package being present says nothing about whether it can be driven, and collapsing them reports a broken device as healthy.

Status shows what the device reported and, when it disagrees with what was requested, says so rather than hiding it.

## 5. Implementation steps

**5.1 Device bring-up — the gate. ✅ PASSED.** Executed on a Motorola moto g06 power, **Android 15 (API 35), arm64-v8a**, against the locally built debug APK. Every behaviour the design leans on is now proven rather than assumed:

  | Behaviour | Result |
  |---|---|
  | `appops set … ACTIVATE_VPN allow` (`@hide`, undocumented) | `appops get` → `ACTIVATE_VPN: allow` |
  | It really suppresses the consent dialog | `route.status` → `prepared: true`, and no UI ever appeared |
  | `specialUse` foreground service accepted at runtime | `dumpsys` → `isForeground=true types=0x40000000` (= `FOREGROUND_SERVICE_TYPE_SPECIAL_USE`) |
  | `adb forward localabstract:` reaches an ordinary app's socket | handshake succeeded over `tcp:27400` |
  | Token auth | a wrong token → `E_UNAUTHORISED`; correct token → served |
  | `VpnService.establish()` | `tun0`, `198.18.0.1/32`, MTU 8500, `Routes: 0.0.0.0/0 → tun0` — a real full tunnel |
  | SOCKS5 with username/password, hostname upstream | route came up against a real provider; `stats: [31, 2123, 14, 608]` |
  | **Traffic genuinely flows through the proxy** | `dumpsys connectivity` → `VPN CONNECTED … IS_VALIDATED` — Android's own connectivity validation passed *through the tunnel* |
  | Our own app excluded from its own tunnel | `Uids: {0-10241, 10243-20241, 20243-99999}` — the gap at `10242` is the agent's uid |
  | `bypassable=false` | apps cannot opt out, which is the entire justification for the APK |
  | Teardown, called twice | `up: false` both times, no error; the VPN disappears from `dumpsys connectivity` |

  Two practical corrections learned here: `adb forward` takes **two** arguments (`<local> <remote>`), and `cmd package path` is the right installed-check because `pm list packages <pkg>` filters by **substring**. Not answered: whether `systemExempted` would also have been accepted (Plan 43 §4.4) — `specialUse` worked, so the question was never forced.

**5.2 Protocol. ✅ DONE.** `packages/protocol/src/guest-agent.ts` (socket name, protocol version, capability enum, the request union discriminated on `method`, per-method result schemas, the `{ok}`-discriminated response envelope, error codes) and `packages/protocol/src/network.ts` (`NetworkEngineId` = `none | vpn-helper` only — the deferred engines are deliberately absent, `Socks5RouteConfig`, `NetworkCapabilities`, `NetworkStatus`, and `redactRouteConfig()`). Schemas were written against the **captured frames from 5.1**, not against a guess, and `guest-agent.test.ts` asserts those exact frames parse plus eight malformed ones are rejected. `health` cannot reach `ok` from a successful apply alone — only a probe can promote it, and the schema comment says so. 22 tests pass, `protocol` typechecks clean.

**5.3 Registry.** §4.3. → `GET /api/registry` returns `networks` with `none` and `vpn-helper`.

**5.4 Settings, migration, read seam.** `DeviceSettingsSchema.engines.network` plus the route config; the `network` column; **and the same commit extends `DeviceSnapshot` (`packages/session/src/types.ts`) and `createDbDeviceSource` (`packages/core/src/session/adapters.ts`)** so the setting is read, not merely stored. → a unit test asserts the snapshot carries what was saved.

**5.5 Agent launcher and client. 🟡 LAUNCHER DONE, CLIENT NEXT.** `packages/drivers/src/network/guest-agent/launcher.ts` mirrors `ui-server/launcher.ts`, including its host-port ownership check verbatim. It uses `cmd package path` rather than the substring-matching `pm list packages`, and `ensurePreGranted()` **reads the app-op back and throws if it did not take** — because that behaviour is `@hide` and could change in any Android release, so silence there would be the worst outcome. 15 tests pass with injected fakes. Still to write: `client.ts` (newline-delimited JSON over the forwarded socket, `hello` first with a version check that refuses a mismatch).

**5.6 The `vpn-helper` engine.** §4.4. → applying it from a test harness brings a route up.

**5.7 Session and lease wiring.** Apply at session start (`session.ts:170-188`); revert in `close()` and at the four sites Plan 33 §4.5 names. → killing a job mid-run leaves no VPN up.

**5.8 API and permissions.** `GET/PUT/DELETE /api/devices/:id/network` plus the agent status endpoint; `device.network` in `acl.ts`, granted to operators; lease-gated via `checkInputAllowed`; every change recorded to the device event log with the secret redacted.

**5.9 Studio.** §4.6.

**5.10 Manual verification.** §7.

## 6. Acceptance criteria

1. A device with no agent shows `not-installed`; Install makes it `ready` without touching a terminal.
2. Applying a SOCKS5 upstream with a username and password brings the route up, reported by the device.
3. The device's public IP, checked from the device, is the proxy's — **and an app that ignores `http_proxy` is routed too**, which is the property that justifies the whole APK.
4. UDP and DNS traverse the tunnel.
5. Turning the VPN off from Android Settings makes the status report the disagreement within one poll, rather than continuing to claim a route.
6. Releasing the lease tears the route down; so does expiry via the reaper and the device going offline.
7. Revert called twice on an already-clean device does not throw.
8. No password appears in the device event log, the `jobs` table, any API response, or Studio.
9. A protocol-version mismatch produces a coded error, not a silent degradation.
10. `bun run typecheck` clean and `bun test` green.

## 7. Test plan

**Unit** — protocol codec round-trip; version-mismatch refusal; `revert()` idempotency; the ownership check rejecting a `forward --list` that names another serial; the extended credential redaction against `socks5://user:pass@host`.

**Manual, one device, one browser** — the whole point of the slice:

```bash
# Local APK, no release needed
ENKAKU_GUEST_AGENT_PATH=$PWD/apps/guest-agent/app/build/outputs/apk/debug/app-debug.apk bun run dev
```

Then in Studio: install the agent onto the device, apply a SOCKS5 upstream of the form `socks5://<user>:<pass>@<host>:<port>` (use a scratch credential — never a production one, and never paste it into a document or a chat), and confirm from the device that its public IP is the proxy's. Then release the lease and confirm the route is gone.

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| **The device gate fails** — `establish()` returns null, or `appops` does not suppress the dialog | §5.1 runs first and stops the slice; the documented fallback is tapping the consent dialog with the farm's own input engine |
| **Merge conflicts with the M17 series** — 5.3, 5.4, 5.7 and 5.8 touch `registry.ts`, `settings.ts`, `daemon.ts`, `ws-handlers.ts`, which other builders hold | Do 5.2, 5.5 and 5.6 first — they are almost entirely new files. Take the shared-file steps when those builders are clear |
| **Dead config** — a setting saved but never read; the repo already has two, and Plan 34 exists partly to repair them | 5.4 wires the read seam **in the same commit** as the schema, never after |
| A route leaks past its lease | 5.7's four revert sites, plus idempotent `revert()` |
| Credentials leak into logs or job rows | §4.5; acceptance criterion 8 is a grep |
| Scope creep back to the full plans | §2 is the contract — anything not there goes back to Plan 33 or 43 |

## 8a. The bug that cost a whole session: no `INTERNET` permission

The agent shipped without `android.permission.INTERNET`. The manifest even said why — the control channel is an abstract-namespace unix socket and genuinely needs nothing — and then promised *"the VPN route adds what it needs when it lands."* It landed; the permission never followed.

Without it the tunnel could not open a socket to the SOCKS5 upstream, or even resolve its hostname. Every session died at `socks5 client resolve` — **206 out of 206** in one capture — while the TUN itself came up perfectly, so the device reported `up: true` and Studio showed a healthy route that carried nothing.

**It presented as four different bugs**, and each plausible-looking symptom pulled the investigation somewhere else: `ERR_CONNECTION_RESET` (blamed on MTU), a browser that could not resolve names (blamed on DNS-over-UDP through a TCP-only proxy), `ERR_QUIC_PROTOCOL_ERROR` (blamed on QUIC), and finally `ERR_SOCKET_NOT_CONNECTED`. Three of those wrong guesses produced code changes.

What actually found it was one line of `adb logcat --pid=<agent>`. Two lessons worth keeping: **a manifest comment that promises a future change is a promise nobody is tracking**, and when a component fails in several unrelated-looking ways at once, stop reasoning from symptoms and read its logs.

Two changes made while chasing the wrong causes are still in the tree and should be re-evaluated now that the real cause is known: the TUN MTU was lowered from hev's default 8500 to 1400, and `mapdns` was added. Both may still be right — a TCP-only upstream genuinely cannot carry DNS over UDP, and the browser-leak test confirms `mapdns` is what keeps DNS from leaking to the real ISP — but neither was justified by the reason given at the time.

## 8b. Defects found by actually running it

Three were found during device bring-up and three more during end-to-end integration. The integration ones are the interesting half: none would have been caught by unit tests, because each was a platform behaviour rather than a logic error.

**Fixed:**

- **The token never rotated (`E_UNAUTHORISED` on every operation after the first).** The host re-bootstraps with a fresh token per operation, but under the default `standard` launch mode an `am start` aimed at an activity already on top merely brings its task forward — **neither `onCreate` nor `onNewIntent` runs** — so the first token stuck forever and every later one was silently dropped. The agent answered `E_UNAUTHORISED` while looking perfectly healthy. Fixed with `android:launchMode="singleTop"` plus an `onNewIntent` override that hands the new token to the service. Both halves are required; either alone does nothing.

**✅ Fixed — a route no longer outlives the farm:**

- **Dead-man's switch on the device.** `DeadMansSwitch` (in the agent) tears the route down when the control channel has been silent for 90 seconds, and the core heartbeats every 20 seconds while a route is enabled — four missed beats of slack, enough to ride out a slow adb queue without being so long that a stranded device stays stranded. Any authorised request counts as contact, so the heartbeat is the floor rather than a special case. It only arms while a route is actually up: with no route there is nothing to strand, and firing then would tear down something nobody asked us to touch.

  It has to live on the device for the reason the incident showed — **the host may be the thing that died**, and a dead process runs no cleanup. Host-side lease teardown stays the normal path; this is the backstop for when there is no host left to run it.

- **Route config now persists** (`devices.networkRoute`), so a core restart no longer forgets the upstream, and `enabled` is stored separately from the config. On boot the core reconciles rather than blindly re-applying: it probes, and reports drift if the device says the route is down.

**Historical — the incident that produced both fixes:**

- **A full tunnel survives the core dying, and nothing on the device can end it.** Found the worst way: a route left applied during testing kept `0.0.0.0/0 → tun0` in place after the core was killed, so the device had WiFi, showed `VALIDATED`, and still could not reach the internet — because every packet was being pushed at an upstream nobody was talking to any more. A second device on the same WiFi, without the agent, was fine, which makes the agent look like the culprit when it is really the orphaned route.

  Killing the core triggers none of the lease-teardown sites, because a killed process runs no cleanup at all — and the two sites still marked TODO in `ws-handlers.ts` would not have helped either. **The device has no way to notice the farm is gone.**

  For a farm this is the difference between an annoyance and an outage: a core crash would blackhole every routed device at once, and recovering them needs adb per device. The honest fix is a **dead-man's switch on the device**: the agent tears its own route down when the control channel has been silent for N seconds. That belongs in the agent, not the host, precisely because the host may be the thing that died. Nothing in any current plan covers it.

**Known, not fixed, and non-blocking:**

- **Cold-start probes under-report.** For a few seconds after `install -r` the app process is restarting and its socket is not yet bound, so `GET /guest-agent` returns `installed` or `unreachable` before settling on `ready`. Self-correcting, and the route works regardless — but the UI will briefly show a device as broken when it is merely starting. The honest fix is for the probe to re-bootstrap once on a failed handshake rather than relying on the client's connect-level retry.
- **`adb forward` entries leak.** Probes allocate and remove a port per call, but failures leave the forward behind — several `tcp:271xx → localabstract:enkaku-guest-agent` entries accumulated during testing. Harmless in dev, untidy in a long-lived farm.
- **`health` drifts between `unverified` and `degraded`** across reads of the same live route, because a `lastError` from an earlier failed apply outlives the failure. Cosmetic, but it undermines the point of reporting health at all.

## 8c. Earlier defects, from device bring-up

Recorded rather than fixed, because each needs an APK rebuild and none blocks the remaining steps. All were found by `scripts/guest-agent.ts`, which is the reproducible form of §5.1.

1. **`route.stop` acknowledges the request, not completion.** It replies `{stopped: true}` immediately while `teardown()` is still joining the tunnel thread, so a status read straight after can still report `up: true` even though Android has already dropped the VPN. The bring-up script works around it by polling, but the honest fix is for `route.stop` either to block until the route is down or to reply with something that does not read as a completion. **This matters for `revert()` in step 5.6** — a lease teardown that trusts the acknowledgement would report success before the route is gone.
2. **`RouteState.markDown` leaves `upstream` populated on the stop path in some orderings**, so a stopped route can still name its old upstream. Cosmetic today, misleading in the UI later.
3. **DNS is hardcoded to `1.1.1.1`** in `RouteVpnService` rather than coming from the route config — see §9 Q4.

## 9. Open questions

1. ~~**Studio placement**~~ — **settled: the device page.** A top-level Guest Agents view was built first and removed; per-device concerns belong on the device detail page, alongside its existing tabs. Fleet-wide views (a column on the devices list, bulk install) remain deferred by §2 and would be a *separate* affordance, not a relocation of this one.
2. **Credential storage** — inherited from Plan 33 §9 Q2 and deferred by §4.5, not solved. It must be answered before this is used with anything but a scratch credential.
3. **Cloud mode** — the agent-side host runs the adb commands, so it should work unchanged, but that is unverified. Confirm against `packages/core/src/tunnel/` before 5.5.
4. **DNS** — `RouteVpnService` currently hardcodes `1.1.1.1`. Should it come from the route config, and should the tunnel's `mapdns` feature be used instead?
