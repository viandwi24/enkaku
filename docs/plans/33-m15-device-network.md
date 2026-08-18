# Plan 33 — M15 : Device network layer (proxy / VPN routing)

> Status: partial — the `network` driver-layer kind, registry wiring, lease/device-scoped lifecycle, and the `none`/`vpn-helper` engines shipped, but under Plans 44/51/52/54, not as this plan's own design; the route lifecycle is device-scoped and survives a lease (Plan 52 supersedes this plan's lease-scoped design). **Updated 2026-08-18 by plan 114 step 114.10:** `adb-proxy` and `adb-reverse-proxy` — long deferred, and named as such in this line and in code comments — were **built by plan 114** (`packages/drivers/src/network/adb-proxy/`), with this plan's own engine ids and spelling kept. Two of that plan's corrections land back on this document and are recorded where they belong rather than only here: §5.5's `:0` revert prescription is corrected in place (`:0` is a step, never the terminal state), and §5.6's "assemble the engine in the session factory" was never achievable — there is no network factory in `packages/session`, and plan 114 §3.2 records that the engines are constructed in the core instead. What is still not built from this plan: the `ctx.device.network.*` SDK surface (§4.8), which nothing has ever provided, and which plan 114 §2 deliberately left out of its own scope.
> Ships: packages/protocol/src/network.ts
> **Depends on:** Plan 18 (device event log), Plan 22.1 (adb deadlines), Plan 26 (the permission-gating pattern). Independent of the M13/M14 series.
> **Spec references:** §7 (five driver layers), §7.9 (the network layer), §7.10 (VPN helper profiles), §8 (registry and schema-driven UI), §9.5 (capability locks), §17 (positioning).

---

## 1. Goals

Once this plan is done, all of the following are TRUE:

1. `NetworkRoute` is a fifth driver layer, selectable per device from the Studio dropdown exactly like transport/display/input/inspection, defaulting to `none`.
2. Three engines work against a real device: `none`, `adb-proxy`, `adb-reverse-proxy`. A fourth, `vpn-helper`, is registered as `available: false` with an honest `unavailableReason` and is **not** implemented here.
3. A route is bound to a **lease**, not to a device: applied on acquire, reverted on release, on lease expiry via the reaper, on client disconnect, and when the device goes offline.
4. Studio shows, on the device page, both the requested configuration and the observed state, and shows them as distinct things when they disagree.
5. A script can call `ctx.device.network.getConfig()`, `.status()`, `.setConfig()`, `.reset()`, and `.probe()` — with the core mediating every call, so the per-device queue and the lease still hold.
6. Every change is written to the device event log with credentials redacted, and no raw secret can reach script params, the `jobs` table, artifacts, or the log.
7. `bun run typecheck` passes and `bun test` is green, including a unit test that fails if a network setting is saved but never read (the dead-config guard).

## 2. Non-goals

- **`vpn-helper` implementation.** Descriptor and profile schema only. It needs a verified APK, a Toolchain manifest entry, and a real intent contract — a separate plan (M15b).
- **HTTPS interception / CA installation.** Out of scope permanently; see spec §7.9 rule 6.
- **Proxy pools, rotation, or per-account binding.** Excluded by spec §17. One route per lease.
- **Radio toggles** (`svc wifi`, `svc data`, airplane mode). Adjacent and desirable, but a different capability with a different failure model. M15c.
- **Outbound proxy for the core's own `fetch`** (toolchain downloads, enrollment). A real install-blocker but entirely unrelated code — see §9 Q4.
- **Per-app routing.** `settings global http_proxy` is device-wide by construction.

## 3. Context and design decisions

### 3.1 Why a driver layer and not a script capability

`DeviceApi` (`packages/sdk/src/types.ts:11`) is a closed surface, and `DeviceCallSchema` (`packages/session/src/runner/ipc.ts:12`) is a closed union of nine methods. There is deliberately no `shell` in either — plans 25 and 26 added shell over the WS/API path only, gated behind a *manual* lease, which by construction is unavailable while a job runs. Letting scripts set a proxy by opening a shell would undo that boundary for one feature.

The decisive argument is lifecycle, not policy. `settings global http_proxy` is sticky state that survives the process that set it. A script cannot guarantee its own cleanup: after a timeout kill the runner re-runs `finish()` in a **fresh process** (`00-overview.md` §4, and the SDK contract in `types.ts:69`). Only the lease reaper knows when a session is truly over. A leaked proxy is inherited silently by the next tenant, which is the same class of bug as a leaked `adb forward` port (`packages/scrcpy/src/session.ts:181-208`).

### 3.2 Why `observe()` is separate from `getConfig()`

Declared intent and device reality diverge: a reboot clears the setting, another app changes it, a VPN drops. A farm that cannot see the drift runs a whole suite through the wrong egress and reports success. So the status payload carries both, plus a `drift: boolean`, and Studio renders the disagreement rather than hiding it.

For the same reason `apply()` returning without throwing is reported as `unverified`, not `ok`. Only `probe()` — an actual egress check — can promote it to `ok`.

### 3.3 Why `adb-reverse-proxy` is the recommended engine

It is the only rung that solves authentication without an APK. `adb reverse tcp:<devicePort> tcp:<hostPort>` plus `http_proxy 127.0.0.1:<devicePort>` means the device talks to its own loopback and the host-side proxy holds the upstream credentials.

That also closes a real leak: the `http_proxy` value is world-readable by every app on the device, so any credential placed there is exposed to the whole device. In this engine no credential ever reaches the device.

`adb reverse` is **not implemented anywhere** in the repo today. All forwarding goes through the `adb` CLI binary, not the wire protocol (`packages/adb/src/index.ts` exposes no forward/reverse). This plan adds it via the existing `hostAdb` helper and reuses the ownership-verification pattern from `launcher.ts:55-71` and `scrcpy/src/session.ts:181-208` — a host port must be proven to belong to this device before use, or traffic lands on the wrong phone.

### 3.4 The dead-config hazard is the main risk

`DeviceSettings.timing` and `prep.disableAnimations` are both saved, validated, rendered in the UI, and **read by nothing** (`job-runner.ts:93` never passes `timing`; `DeviceSnapshot` never carries it). The in-code comment at `session.ts:158-161` records the same bug for `keepAwake`. A network setting that saves successfully and does nothing would be worse than absent, because the operator would believe traffic is proxied. Step 5.9 adds a test that fails on exactly that.

### 3.5 Locks

All network engines declare `locks: ['network-route']` (spec §9.5), so `validateEngineSelection` (`packages/protocol/src/registry.ts:50`) rejects any pair. `none` declares no lock.

---

## 4. Technical design

### 4.1 Protocol — `packages/protocol/src/network.ts` (new)

```ts
export const NetworkEngineIdSchema = z.enum(['none', 'adb-proxy', 'adb-reverse-proxy', 'vpn-helper'])

export const NetworkCapabilitiesSchema = z.object({
  auth: z.boolean(),          // upstream credentials supported
  enforcing: z.boolean(),     // apps cannot opt out (VpnService/iptables)
  udp: z.boolean(),           // UDP and DNS carried
  probe: z.boolean(),         // egress verification available
})

export const NetworkConfigSchema = z.object({
  mode: z.enum(['direct', 'http-proxy', 'socks5']).default('direct'),
  host: z.string().min(1).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  credentialRef: z.string().optional(),   // NEVER a raw secret — see §4.6
  bypass: z.array(z.string()).default([]),
}).refine(c => c.mode === 'direct' || (c.host && c.port), { message: 'host and port are required unless mode is direct' })

export const NetworkObservationSchema = z.object({
  raw: z.string().nullable(),        // verbatim `settings get global http_proxy`
  parsed: NetworkConfigSchema.nullable(),
  readAt: z.number().int(),
})

export const NetworkStatusSchema = z.object({
  engine: NetworkEngineIdSchema,
  capabilities: NetworkCapabilitiesSchema,
  declared: NetworkConfigSchema.nullable(),   // what we asked for (lease-scoped)
  observed: NetworkObservationSchema.nullable(),
  drift: z.boolean(),                          // declared ≠ observed
  health: z.enum(['ok', 'unverified', 'degraded', 'unknown']),
  leaseId: z.string().nullable(),
  appliedAt: z.number().int().nullable(),
  lastError: z.object({ code: z.string(), message: z.string() }).nullable(),
})
```

`declared` returned over any boundary has `credentialRef` preserved and no secret material by construction — there is no field to leak.

### 4.2 The engine interface — `packages/protocol/src/driver.ts`

```ts
export interface NetworkRoute {
  id: string
  capabilities: NetworkCapabilities
  apply(cfg: NetworkConfig): Promise<void>
  observe(): Promise<NetworkObservation>
  probe?(): Promise<{ ok: boolean; egressIp?: string; detail?: string }>
  revert(): Promise<void>          // MUST be idempotent
}
```

`revert()` is called from paths that may run twice or after a crash; it must never throw on an already-clean device.

### 4.3 Registry changes

Touch four places, all found by following `kind`:

| File | Change |
|---|---|
| `packages/protocol/src/registry.ts:4` | `kind` enum gains `'network'` |
| `packages/protocol/src/registry.ts:21` | `RegistryResponseSchema` gains `networks` |
| `packages/protocol/src/registry.ts:30` | `EngineSelection` gains `network` |
| `packages/protocol/src/registry.ts:67` | the validator loop gains the `networks` tuple |
| `packages/drivers/src/descriptors.ts:8` | descriptors for `none`, `adb-proxy`, `adb-reverse-proxy`, each with a real `configSchema` |
| `packages/core/src/registry/engines.ts:10` | `vpn-helper` in `PLANNED` with `available: false` |
| `packages/studio/src/components/schema-form/useEnumSource.ts:42` | `KEY_MAP` gains `'registry.networks'` |

### 4.4 Settings and the read seam

`DeviceSettingsSchema` (`packages/protocol/src/settings.ts:83`) gains `engines.network` (with `.meta({ enumSource: 'registry.networks' })`) and a `network` section carrying the default config for the device. Follow the section convention: every field `.default()`, `.describe()`, `.meta({ title })`.

The read seam is `DeviceSnapshot` (`packages/session/src/types.ts:9`), populated by `createDbDeviceSource` (`packages/core/src/session/adapters.ts:9`) — which today projects only `preferredInputMode`, `keepAwake`, `standbyScreenOff`. **Both the engine id and the config must be added there**, or this becomes the third dead setting.

`devices.settings` is JSON (`packages/core/src/db/schema.ts:30`); the engine id is additionally mirrored into a dedicated `network` column beside `transport`/`display`/`input`/`inspection` (`schema.ts:24-27`), because the session builder queries it. One Drizzle migration.

### 4.5 Lifecycle wiring

Apply on session start next to the existing `keepAwake` block (`packages/session/src/session.ts:170-188`); revert in `session.close()` beside the display-power restore (`session.ts:256-265`).

There is no generic per-lease cleanup registry — `packages/core/src/device/adb-endpoint.ts:81-90` documents the convention that cleanup modules own no trigger wires and `daemon.ts` calls them explicitly. So add a fourth explicit call, beside `releaseShellSession` / `adbEndpointManager.close`, in all four sites:

| Site | File |
|---|---|
| lease revoked (idle timeout, quarantine, disconnect) | `packages/core/src/daemon.ts:409-431` (`onManualRevoked`) |
| explicit release | `packages/core/src/server/ws-handlers.ts:500-530` (`case 'lease.release'`) |
| WS close | `packages/core/src/server/ws-handlers.ts:876-901` (`handleClose`) |
| device offline | `packages/core/src/daemon.ts:979` |

### 4.6 Credentials

A credential is stored once, server-side, and referenced by name. `credentialRef` is what travels through run configs, script params, IPC, the event log, and the API. The secret is resolved only inside the engine, on the host that runs the proxy.

`redactShellCommand` (`packages/core/src/device/redact.ts:26`) already masks `--password`-style flags but its `CREDENTIAL_FLAG_RE` (`redact.ts:23`) does **not** cover userinfo embedded in a URL (`http://user:pass@host`). Extend it — a proxy URL is the obvious way this leaks.

### 4.7 REST, WS, and permissions

- `GET /api/devices/:id/network` → `NetworkStatus`
- `PUT /api/devices/:id/network` → apply for the current lease
- `DELETE /api/devices/:id/network` → revert
- `POST /api/devices/:id/network/probe` → run the egress check

Add `'device.network'` to the `Permission` union (`packages/core/src/auth/acl.ts:8`) and to `OPERATOR` (`acl.ts:42`) — an operator running tests legitimately needs it, unlike `device.shell` which is admin-only. Follow the per-message gating pattern the code explicitly nominates for copying at `ws-handlers.ts:583-597` (resolve the role fresh, check before anything else).

Every mutation requires a held lease via `checkInputAllowed` (`packages/core/src/lease/lease-manager.ts:140`), the same gate as input, shell, and the adb endpoint.

### 4.8 The SDK path

Four edits, mirroring how any existing device call travels:

1. `packages/sdk/src/types.ts` — `DeviceApi.network: NetworkApi`
2. `packages/session/src/runner/ipc.ts:12` — `DeviceCallSchema` variants `network.getConfig | network.status | network.setConfig | network.reset | network.probe`
3. `packages/session/src/runner/child-entry.ts:51` — the `deviceApi.network` methods forwarding through `request()`
4. `packages/session/src/device-executor.ts` — branches calling `session.network.*`

The child still never opens adb itself (`ipc.ts:8-9`).

### 4.9 Event log

New `main` kinds: `network.applied`, `network.changed`, `network.reverted`, `network.drift`, `network.probe`. `kind` is a free string so no migration is needed, but the kinds must be added to `MAIN_EVENT_KINDS` (`packages/protocol/src/messages/device-event.ts:15`, documentation only) **and** to Studio's `KIND_LABEL` (`packages/studio/src/components/DeviceLog.tsx:27`), `KIND_TONE` (`:50`) and `summarize()` (`:65`), or they render as raw strings.

### 4.10 Studio

- Device page (`packages/studio/src/app/device/page.tsx`) gains a **Network** card in the Settings tab: engine dropdown (schema-driven, `available:false` disabled with its reason), config form, and a status block showing declared vs observed with an explicit drift warning and a Probe button.
- Farm defaults in `settings/page.tsx` via `FarmSettingsSchema.defaults`.
- Capabilities are rendered from the descriptor, so `adb-proxy` visibly reports "advisory — apps may ignore it" rather than implying enforcement.

---

## 5. Implementation steps

**5.1 Protocol.** Create `packages/protocol/src/network.ts` with the schemas in §4.1; add `NetworkRoute` to `driver.ts`; export from `index.ts:80`. → `bun run typecheck` clean.

**5.2 Registry.** The seven edits in §4.3, including the Studio `KEY_MAP`. → `GET /api/registry` returns `networks` with four entries, `vpn-helper` unavailable.

**5.3 Settings + migration.** `DeviceSettingsSchema.engines.network` and the `network` section; the `network` column; `bun run --cwd packages/core db:generate`. → an existing device loads with `none` and no behaviour change.

**5.4 The read seam.** Extend `DeviceSnapshot` (`packages/session/src/types.ts:9`) and `createDbDeviceSource` (`adapters.ts:9`). → a unit test asserts the snapshot carries the configured engine and config.

**5.5 Engines.** `packages/drivers/src/network/{none,adb-proxy,adb-reverse-proxy}.ts`.
- `adb-proxy`: apply = `settings put global http_proxy host:port`; observe = `settings get global http_proxy`. **Revert: corrected 2026-08-18 by plan 114 step 114.10 — see plan 114 §3.6, and build that, not this line.** This step used to prescribe `settings put global http_proxy :0` on its own, calling it "the reliable reset — `delete` alone is not enough on many builds". Half of that is right and the half matters: 114.2 measured it, and `delete` alone genuinely does not reliably stop the framework using a proxy it has already read, so **`:0` is a step and must not be dropped**. What is wrong is treating it as the *terminal* state — it leaves the literal string `:0` sitting where a pristine device had `null`, which is a value the farm invented and then left behind. The shipped engine (`packages/drivers/src/network/adb-proxy/http-proxy.ts`) therefore does two things this line did not: it **captures** all four `global` keys (`http_proxy`, `global_http_proxy_host`, `global_http_proxy_port`, `global_http_proxy_exclusion_list`) once, before the first write, and restores those verbatim on revert; and where the captured value was empty — or where nothing was ever captured — it writes `:0` **then** `delete`, so the framework sees the value it reliably obeys and the key is nonetheless left genuinely unset afterwards. `:0` is a step, never the terminal state.
- `adb-reverse-proxy`: claim a device-side port, `adb reverse tcp:<devicePort> tcp:<hostPort>` through `hostAdb`, verify ownership via `reverse --list` **before** pointing the device at it, then set `http_proxy 127.0.0.1:<devicePort>`; revert removes both, in the reverse order, tolerating either being already gone.
- Reuse `PortAllocator` (`packages/session/src/port-allocator.ts:13`) for the host side.

**5.6 Session wiring.** Assemble the engine in the session factory; apply at `session.ts:170-188`; revert in `close()` at `:256`.

**5.7 Lease wiring.** The four explicit revert calls in §4.5. → killing a job mid-run leaves the device with no proxy.

**5.8 API + permissions.** The four routes, `device.network` in the ACL, lease gating, event recording, the `redact.ts:23` regex extension.

**5.9 The dead-config guard.** A test that reads `DeviceSettingsSchema`'s network keys and asserts each one is consumed by `createDbDeviceSource` → `DeviceSnapshot` → the session factory. It must fail if a key is added to the schema and nowhere else.

**5.10 SDK.** The four edits in §4.8, plus README documentation stating that `ctx.device.network` routes the **device's** traffic, not the script process's — under `ENKAKU_JOB_ISOLATION=container` the job runs with `--network=none` and the two are unrelated.

**5.11 Studio.** The Network card, the drift display, the Probe button, and the `DeviceLog.tsx` kind labels.

**5.12 Docs.** `docs/guide/` gains a network page; update the package READMEs per the global Definition of Done.

---

## 6. Acceptance criteria

1. A device with `network: 'none'` behaves byte-identically to before this plan.
2. Setting `adb-proxy` from Studio applies within one session start; `adb shell settings get global http_proxy` shows the value; the device page shows declared and observed in agreement.
3. Releasing the lease reverts it; `settings get global http_proxy` reads `:0` or empty.
4. Killing the core mid-lease and restarting reverts the stale route on the next reconcile.
5. Letting a manual lease expire through the reaper reverts it without any client action.
6. `adb-reverse-proxy` routes through a proxy on the host over **USB**, with the device on a different network, and no credential appears anywhere on the device.
7. Selecting two network engines is rejected with `LOCK_CONFLICT`.
8. `vpn-helper` appears disabled in the dropdown with its reason.
9. Changing an external proxy behind the farm's back produces `drift: true` and a visible warning.
10. A script calls all five `ctx.device.network.*` methods; the change is recorded to the event log; the route is reverted after the job even when the job times out.
11. No raw credential appears in the `jobs` table, artifacts, the event log, or any API response — verified by grepping a run with a credential configured.
12. An operator (non-admin) can set a route; the ACL test covers it.
13. `bun run typecheck` clean; `bun test` green; 5.9's guard fails when a key is deliberately orphaned.

## 7. Test plan

**Unit** — `NetworkConfigSchema` refinement (host/port required unless `direct`); the `:0` reset semantics; `observe()` parsing of an empty, malformed, and valid value; drift computation; `revert()` idempotency called twice on a clean device; the extended `CREDENTIAL_FLAG_RE` against `http://user:pass@host`; `validateEngineSelection` rejecting two network engines; the 5.9 guard.

**Integration (no device)** — lease release, expiry, WS close, and device-offline each trigger exactly one revert; the API rejects a mutation without a lease; an operator passes the ACL and an unauthenticated caller does not.

**Manual smoke (`ENKAKU_TEST_DEVICE=1`)** —

```bash
bun run dev
# 1. Set adb-proxy on the device page, host = a mitmproxy on the LAN
adb -s <serial> shell settings get global http_proxy      # → host:port
# 2. Browse on the device; traffic appears in mitmproxy
# 3. Release the lease in Studio
adb -s <serial> shell settings get global http_proxy      # → :0
# 4. adb-reverse-proxy over USB, phone on mobile data, proxy on the laptop
adb -s <serial> reverse --list                            # → the expected mapping, this device only
# 5. Drift: change it behind the farm's back, confirm the warning
adb -s <serial> shell settings put global http_proxy 1.2.3.4:9999
# 6. Timeout revert
bun run publish:example && # run a script that sets a route then sleeps past its timeout
adb -s <serial> shell settings get global http_proxy      # → :0
```

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| **Dead config** — saved, never read (the repo has two live instances) | 5.4 wires the seam first; 5.9 is a test that fails on a new orphan key |
| **Leaked route across tenants** — the worst outcome, and silent | Revert on all four paths; plus a reconcile when a device returns to `idle` that reverts and logs `network.drift` |
| `adb reverse` binding to the wrong device | Verify `reverse --list` ownership before pointing the device at the port, exactly as `launcher.ts:55-71` does |
| Operator believes traffic is enforced when `adb-proxy` is advisory | Capabilities come from the descriptor and are rendered in the UI; `health` is `unverified` until a probe passes |
| Credential leakage into logs/artifacts | `credentialRef` only, resolved host-side; extended redaction; acceptance criterion 11 is a grep |
| Probe endpoint becomes a hardcoded third-party dependency | The endpoint is configurable and self-hostable; probing is opt-in |
| Scope creep toward pools/rotation | Spec §17 states the boundary; `NetworkConfig` has no pool field to grow into |

## 9. Open questions

1. **Should a route survive across leases when an operator explicitly pins it?** A per-device "sticky route" is convenient for a dedicated test device and dangerous on a shared one. Current assumption: no — lease-scoped only. Revisit after real use.
2. **Where do credentials live?** A new `network_credentials` table versus reusing an existing secret store. Needs a decision before 5.8.
3. **Does the cloud path need a separate engine?** In cloud mode the proxy must run on the **agent**, near the device. The engine likely works unchanged because the agent executes the session, but this must be confirmed against `packages/core/src/tunnel/device-proxy.ts` before 5.6 — and confirmed by running acceptance criterion 6 through an agent.
4. **Is the core's own outbound proxy folded in here or split?** Honouring `HTTPS_PROXY`/`NO_PROXY` for toolchain downloads and enrollment is a genuine install-blocker behind corporate egress (`packages/toolchain/src/download.ts:60`, `manifest.ts:57`, `agent/src/state.ts:37`) but shares no code with this layer. Recommendation: a separate small plan, done first because it is a bug fix rather than a feature.
