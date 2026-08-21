# Plan 122 — M87 : MikroTik routing — device → egress path, from Studio

> Status: partial — **stage 1 (read-only) is complete**, 2026-08-21. Done: 122.1 (REST driver + inventory), 122.2 (marker/drift/resolve), 122.3 (plugin shell + Paths/Settings/Rules tabs), 122.4 (identity bridge), 122.5 (planner), 122.7 (group algebra). An operator can now see their router through Enkaku — paths and health, managed vs foreign rules, and a Settings tab that runs `doctor()` and states plainly when §3.2's local-exception rule is missing. **No write path to the router exists in the codebase** (`createRule`/`updateRule`/`deleteRule` are declared and unconditionally reject), so nothing here can change a router yet. Outstanding: 122.6 (apply + Assignments tab — stage 2), 122.8 (Groups tab + group CRUD, which also owns new acceptance criterion 12), 122.9 (reconcile loop), 122.10 (member scripts), 122.11 (docs/status closure). 122.4 and 122.7 shipped their pure cores only; the broker/KV wiring each defers is named in their own step notes below. **Nothing in this plan has been exercised against a real MikroTik router** — every schema except `/routing/rule`'s is inferred from RouterOS documentation, and §7's gated integration test and hardware smoke are both unbuilt. Stage 1 is exactly the right thing to point at the owner's own router first, since it cannot change anything.
> Depends on: plan 117 (M82) — whose §3.3/§5 explicitly refused router integration for `proxy-manager`; §0.4 below is the argument for why a SEPARATE plugin is the right home for it rather than a reversal of that decision. Plan 108/109 (plugin surface + runtime) for the tier-C React surface, member scripts, and the plugin KV/capability model this builds on.
> Spec references: §7.9 (network layer — this plugin is deliberately NOT one; see §0.4), §22 (plugins)
> Ships: plugins/mikrotik-routing/src/service/router-driver.ts

A first-party plugin that assigns each farm device its own internet egress path by writing **policy routing rules on a MikroTik router**, so an operator stops hand-editing router config every time a device should move to a different modem. Sourced from the owner's own design proposal (`refs/tmp-mikrotik-plugin.md`, written against real hardware — hAP ax², RouterOS 7.24), corrected in §0.3 where that proposal assumed platform features this codebase does not actually have.

**It never touches the device.** The only thing that changes is the router.

---

## 0. Evidence

### 0.1 Where this comes from

The owner runs ~45–60 LTE modems behind a MikroTik hAP ax² plus trunked-VLAN switches, one VLAN and one routing table per modem, each with a health-checked default route. Steering one device out through a chosen modem is already a solved one-liner **on the router**:

```
/routing rule add src-address=192.168.10.215/32 action=lookup-only-in-table table=via-modem7-p12
```

The owner's ask, in their own words: *"biar app kita ada plugin mikrotik ini bisa bikin routing langsung lewat app kita ga harus nyetting terus di mikrotik routernya."* What is missing is not the mechanism — it is everything around it: an inventory of paths, a record of who is assigned where, a safe way to change many assignments at once, a way to tell Enkaku's rules from hand-made ones, and a way to notice when the router no longer matches what Enkaku believes.

### 0.2 What the platform actually provides — verified by reading the code, not assumed

- **Outbound HTTP from a plugin service is unrestricted.** There is no sandbox, no egress allowlist, no `fetch` gate — stated outright in `packages/sdk/src/runtime.ts:634-650` ("It is not a sandbox… Your code is loaded into the core process") and `packages/core/src/plugins/runtime-host.ts:54-57`. `proxy-manager` already opens raw sockets to arbitrary hosts (`service/dial-direct.ts:111`). A LAN `fetch('http://192.168.x.x/rest/…')` is fine, and needs no new capability.
- **A device's LAN IP is already known for network-attached devices, and a plugin can read it.** `DeviceConnection` (`packages/protocol/src/device.ts:23-32`) carries `address: string | null` and `port: number | null`, derived from the adb transport serial by `deriveConnection` (`packages/core/src/registry/device-registry.ts:219-250`). The `device.list`/`device.get` capabilities return `DeviceInfoSchema` **verbatim** (`packages/core/src/capability/device-state.ts:20-45`) — nothing strips the address. For the owner's own farm (every device on `192.168.10.x:5555`) the identity bridge §5 of the proposal worries about is therefore **free and exact**, not inferred.
- **A `device_endpoints` table already remembers network addresses per `stableId`**, surviving serial change, transport change, and forget/re-admit (`packages/core/src/db/schema.ts:224-252`, `registry/endpoints.ts:16-46`). It is **not** exposed to plugins today (no capability, no route).
- **Plugin KV has `global`, ambient `device`, and `forDevice(deviceId)` scopes** (`packages/sdk/src/types.ts:274-287`), each a `KvApi` with `get/getRaw/set/setIfVersion/increment/delete/list({prefix,limit,cursor})` (`types.ts:288-311`). `set` takes `{ secret, hint, ttlSec }` (`types.ts:263-278`) — `proxy-manager` stores its upstream password exactly this way (`shared.ts:44-62`).
- **Forgetting a device really does delete its plugin KV, in the same transaction** — `packages/core/src/device/lifecycle.ts:273-297`, line 278, unconditional. **But Blocking a device does not** (`lifecycle.ts:360-372` never calls `deleteDevice`), and `deps.kv` is optional (`lifecycle.ts:103`). The proposal's claim is true for Forget and false for Block; §3.5 handles that.
- **Member scripts become ordinary `scripts` rows on activation** (`packages/core/src/plugins/runtime.ts:344-376`, named `<plugin>/<exportId>`), so they are schedulable and batchable like any script (`schedules/runner.test.ts:534`). A declared `result` schema is real and persisted (`runtime.ts:362`); `proxy-manager` declares one at `src/index.ts:123-129,157`.
- **There is no host-provided periodic primitive.** `PluginServiceContext` (`packages/sdk/src/runtime.ts:137-455`) has `onStop`/`onRequest`/`onSocket`/`onQuery`/`onWebhook`/`logs`/`page`/`storage`/`log`/`farm` — no timer. `proxy-manager` rolls its own self-rescheduling `setTimeout` (deliberately NOT `setInterval`), cleared in teardown and wired to `ctx.onStop` (`service/supervisor.ts:220,495-506,856`; `src/index.ts:364`), with the interval injectable for tests (`supervisor.ts:151`). This plan follows that precedent exactly.
- **UI tiers are real**: tier A = declarative `table` + `data` + `actions`; tier C = `react: { entry, apiVersion }`, the two mutually exclusive per view (`docs/design.md:258-272`, `docs/spec.md:733-743`). Tier B was deleted (plan 108 §4). `proxy-manager` is tier C (`src/index.ts:487-508`).

### 0.3 Four things the source proposal assumed that are NOT true here — corrected before a line is written

The proposal (`refs/tmp-mikrotik-plugin.md`) is strong and most of it survives intact. These four points do not, and each is corrected in the design below rather than carried forward:

1. **`device.view` is not a capability.** It is an ACL *permission* (`packages/core/src/auth/acl.ts:67`) that capabilities are gated behind. `service.permissions` is a `string[]` of **capability ids** checked by the broker at call time (`plugins/runtime-host.ts:198`, `plugins/farm-broker.ts:306-310`). Declaring `device.view` buys nothing. The correct ids are **`device.list`** and **`device.get`** (`packages/core/src/capability/index.ts`).
2. **`kv.scan` does not exist on `ctx.storage`.** The prefix read is `list({ prefix })` (`packages/sdk/src/types.ts:311`). `kv.scan` is only a *tier-A declarative UI DataSource kind* (`docs/overview.md:531`) — not something service code can call.
3. **Matching devices to DHCP leases by MAC is impossible today.** There is no `mac`/`wifiMac`/`hwaddr` column, field, or adb read anywhere in `packages/core`, `packages/protocol`, or `packages/adb`. So `lanIpSource: 'dhcp-lease'` as the proposal describes it cannot be built. What *can* be built, and is more useful anyway, is the reverse join: we already know the IP from adb, so we look the **lease up by IP** to check whether it is static or dynamic — which is the actual safety question (§3.4).
4. **For a USB-attached device the core knows no LAN IP at all.** `connection.address` is `null` for USB (`packages/protocol/src/device.ts:28`), and a repo-wide search found **zero** device-IP reads — no `ip addr`, no `ifconfig`, no `getprop dhcp.wlan0.ipaddress`, anywhere. Plan 88's cutover does not discover the IP either: it runs `adb tcpip`, then *searches* for the phone with a bounded CIDR sweep and accepts whichever `host:port` answers (`registry/cutover.ts:96-202`). So the proposal's `discover-lan-ip` script is genuinely new work, not a wrapper over something existing (§4.6).

### 0.4 Why this does not reverse plan 117's refusal

Plan 117 §3.3/§5 put "any router integration — no RouterOS, no REST client, no route-flag polling, no rule auditing" explicitly out of scope, and its acceptance criterion 12 is that `grep -ri "mikrotik\|vlan\|modem" plugins/proxy-manager/src` returns nothing (`docs/plans/117-m82-egress-binding.md:79,323`). That still holds and this plan does not touch it: **`proxy-manager` stays vendor-neutral and gains nothing here.** The principle plan 117 was protecting is "no site topology in *generic* first-party code" — and the correct home for vendor knowledge is a plugin whose entire declared purpose IS that vendor, not a generic proxy pack that quietly learned about one operator's switches. The plugin's own data model stays generic anyway (§2: a *path*, never a *modem*), behind a `RouterDriver` seam (§4.1) so a second vendor or the binary API slots in without touching the group engine or the UI.

### 0.5 How this relates to `proxy-manager` — the owner's own decision, recorded

The owner chose (2026-08-21) that **both plugins live, with different jobs**. They solve the same goal by opposite mechanisms and neither replaces the other:

| | `proxy-manager` (`direct` upstream) | `mikrotik-routing` (this plan) |
|---|---|---|
| Where steering happens | The farm host — a loopback bridge whose outbound socket is bound to a modem's source IP (`net.connect({ localAddress })`, `service/dial-direct.ts:111`) | The router — one policy-routing rule keyed on the device's LAN IP |
| What is steered | Only traffic an app actually sends *through the proxy* | **All** of the device's traffic; an app cannot opt out |
| Device-side change | The device is told to use a proxy (`device.network.set`) | **None.** The device is never touched |
| Third-party proxies (SOAX) | Yes — that is what fallback chains are for (plan 121) | No — paths are the router's own uplinks |
| Survives core going down | No — the bridge is the core process | **Yes.** The router keeps routing exactly as last applied; only control pauses |
| Failover | Per-record backup chain + confirmation probe (plan 121) | Path health + optional substitute (§4.5); the data plane is the router's |

They can coexist on the same farm; on the same *device* at the same time they should not, and §9 Q2 asks whether the plugin should detect and warn about that rather than silently letting both apply.

---

## 1. Goals

1. Assign any farm device to any egress path from Studio, with the router as the only thing that changes.
2. Group assignments into named sets that activate/deactivate as a unit, with a hard guarantee that no device is claimed by two active groups.
3. Mark everything the plugin writes so a human reading the router config can tell managed rules from their own.
4. Detect and report drift — rules edited by hand, wiped by a Safe Mode rollback, or pointing at a path that is down.
5. Never lose control of a device: an apply that would cut the controller's own path to a phone is **refused**, not attempted (§3.2).
6. Stay general: the model is *device → egress path*, never *device → LTE modem*.

## 2. Non-goals

- **Configuring the router's WAN paths themselves** (VLANs, DHCP clients, NAT, routing tables, the routes inside them). Built once by an operator; the plugin reads them and refuses to invent them.
- **Managing rule order.** RouterOS REST has no `move`. The one ordering-sensitive rule is an operator prerequisite the plugin *verifies* and never writes (§3.2).
- **Rotating a path's public IP** (that means reconnecting an LTE modem — a different concern entirely).
- **Proxying traffic.** That is `proxy-manager`'s job (§0.5).
- **Touching the device.** No `device.network.*` capability is declared, at all.
- **Auto-healing drift by default.** Reported, not silently repaired (§4.7 explains why, from real incident evidence).
- **Unit tests for the plugin's Studio/React code** — standing owner instruction (carried forward from plan 121 §5 step 121.6). Backend/service code gets its normal coverage; `ui/**` is verified by `bun run typecheck` and manual use only.

## 3. Context and design decisions

### 3.1 The plugin writes to exactly one router endpoint

`/routing/rule` is the only thing written. `/routing/table`, `/ip/route`, `/ip/dhcp-server/lease`, `/interface`, `/ip/dhcp-client` are read-only. That is the smallest possible blast radius, and it is what makes the ownership marker (§4.2) sufficient as a safety boundary rather than wishful thinking.

### 3.2 The local-exception rule is a hard precondition, and this is the most important paragraph in this plan

Policy rules are evaluated top-down. Exactly one rule must sit **above** every device rule:

```
/routing rule add src-address=<farm-subnet> dst-address=192.168.0.0/16 \
    action=lookup table=main comment="farm: local exception"
/routing rule move [find comment="farm: local exception"] destination=0
```

Without it, a device's traffic **to the controller itself** — ADB on 5555, Studio, the scrcpy stream — gets dragged into the modem's routing table and dies there. The owner hit this the first time they built the mechanism by hand (`docs/tmp-try-arch-mikrotik.md` §4). On a farm where every device is reached over adb-tcp, applying a rule without this exception in place means **losing control of that device** until someone fixes the router by hand.

REST cannot position a rule (no `move`), so the plugin cannot create it correctly even if it wanted to. Therefore:

- it **does not create it**,
- `doctor()` **checks for it and blocks every apply** while it is missing, with a message naming the exact commands above,
- it **never modifies it** (no marker ⇒ foreign ⇒ read-only).

New device rules are appended at the end, below the exception, so ordering stays correct as long as the precondition holds. This is acceptance criterion 1.

### 3.3 Router rule `.id` is never persisted

`GET /rest/routing/rule` returns `.id` values like `*6`, and a `PUT` returns the created object including its `.id` — but the id **is not stable across a reboot or config reload** (verified on the hardware, `refs/tmp-mikrotik-plugin.md` §3.2). So every write resolves its target first, by marker prefix + `src-address` (§4.3). Two matches ⇒ refuse and flag a duplicate, never guess.

### 3.4 The identity bridge, and its three honest tiers

The router knows LAN IPs; Enkaku knows `stableId`. Getting this wrong steers **the wrong device** with no error anywhere, so the design assumes it can be wrong:

1. **`transport` (best, and the owner's entire farm)** — the device is on adb-tcp, so `connection.address` from `device.list` *is* the LAN IP, exact and live (§0.2). No probing, no guessing.
2. **`probe`** — read from the device itself by the `discover-lan-ip` member script (§4.6). Needed only for USB-attached devices, which the core otherwise knows no address for at all (§0.3 item 4).
3. **`manual`** — typed by the operator, for anything the first two cannot answer.

Whichever tier produced it, the stored `lanIp` carries its `lanIpSource` and the plugin **cross-checks it against the router's own DHCP lease table by IP** (not by MAC — §0.3 item 3): a lease that is *dynamic* means this IP can move to another phone, and that is surfaced as a warning on the assignment, because a stale IP is the one failure this whole subsystem cannot detect from the router side. The `verify-egress` script (§4.6) closes the loop from the device's own side.

### 3.5 Cleanup on Forget is free; on Block it is not

Assignments are stored **device-scoped** (`storage.forDevice(deviceId)`), so Forget deletes them in the same transaction that deletes the device (§0.2 — verified, `lifecycle.ts:278`). **Block does not** (`lifecycle.ts:360-372`), so a blocked device keeps its assignment KV and, more importantly, its **router rule stays live**. The reconcile pass (§4.7) therefore treats "managed rule whose device is blocked or no longer in the fleet" as its own drift class rather than an orphan, and offers removal — this is a real gap the source proposal did not have, found by reading the lifecycle code.

### 3.6 Tier C React for all five tabs

Tabs 1/3/4 (Paths, Rules, Assignments) *could* be tier-A declarative tables, as the proposal notes. They are tier C anyway, for one reason: every one of them has to render **drift and health state** (a badge that means "this rule disagrees with the router", "this path is down", "this IP is on a dynamic lease"), and tier A has no expressions — it renders KV rows into columns. Splitting the plugin across two tiers to save markup on three tables, while tabs 2 and 5 (plan preview, conflict matrix) need React regardless, buys nothing and costs a second mental model. `proxy-manager` is precedent for a whole-plugin tier-C surface.

## 4. Technical design

### 4.1 `RouterDriver` — the seam that keeps this general

```ts
interface RouterDriver {
  inventory(): Promise<{ paths: Path[]; interfaces: Iface[]; health: PathHealth[]; leases: Lease[] }>
  listRules(): Promise<RouterRule[]>            // ALL rules — managed and foreign
  createRule(r: DesiredRule): Promise<{ id: string }>
  updateRule(id: string, patch: Partial<DesiredRule>): Promise<void>
  deleteRule(id: string): Promise<void>
  doctor(): Promise<DoctorReport>
}
```

`MikrotikRestDriver` is the only implementation. It is the **only** file in the plugin that knows the words `src-address`, `lookup-only-in-table`, or `/rest/`. Everything above it — the group engine, the planner, the UI — speaks paths and endpoints. A future binary-API driver (port 8728, which *does* have `move`, §9 Q3) or another vendor slots in here.

Verified REST behaviour to build against (hardware-tested, `refs/tmp-mikrotik-plugin.md` §3.2): `GET /rest/routing/rule` → array with `.id`/`src-address`/`table`/`comment`/`disabled`/`inactive`; `PUT` → created object including `.id`; `PATCH /rest/routing/rule/*6` → updated object, takes effect immediately; `DELETE` → empty. `*` needs no URL-encoding. Basic auth over plain HTTP works.

### 4.2 The ownership marker

```
enkaku:mikrotik-routing:v1:<groupId>:<endpointKey>
```

e.g. `enkaku:mikrotik-routing:v1:jadwal-1:192.168.10.215`. It is **write-scope** (the plugin only ever creates/patches/deletes rules whose comment starts with `enkaku:mikrotik-routing:`), **human-readable** in Winbox, **self-describing** (enough to rebuild the plugin's whole view after total KV loss), and **versioned** so a later format change is detected rather than mis-parsed.

A rule with a well-formed marker but no matching KV record is an **orphan**: the UI offers *Adopt* or *Remove*, and the plugin does **neither** on its own — both directions can be wrong, so both are a human decision.

### 4.3 Resolve before every write

```
rules where comment starts with marker prefix AND src-address == endpoint
  → 0 matches : PUT   (create)
  → 1 match   : PATCH (update table / disabled)
  → 2+ matches: REFUSE, flag duplicate drift
```

### 4.4 Plan, then apply — never write blind

Every change computes a diff between the desired state (the union of active groups) and the router's current managed rules, rendered before anything is written:

```
+ create   192.168.10.215 → via-modem7-p12          (Jadwal-2)
~ update   192.168.10.216   via-modem2 → via-modem9 (Jadwal-2)
- delete   192.168.10.219 → via-modem4              (was Jadwal-1)
! skip     192.168.10.222 → via-modem31             path is DOWN
? foreign  192.168.100.230 → via-modem1             not managed, untouched
```

Studio requires confirmation (`config.requireConfirm`, default on). A schedule-driven activation (§4.6) skips the prompt by construction and records the executed plan in the run log instead — a rotation must never silently become a no-op waiting for a click nobody is there to give.

### 4.5 Path health

A path is **up** iff its default route in `/ip/route` carries the active flag (maintained on this router by `check-gateway=ping`). An assignment pointing at a down path appears in the plan as `skip` and in the UI as a warning — never applied silently, because a rule pointing at a dead path is a device with no internet, and that should never be a surprise. Optional per-group `failoverPolicy`: `none` (default — report and stop) or `substitute` (assign the healthiest least-loaded up path and **mark the assignment as substituted**, so the UI shows it differs from the group's declared intent).

### 4.6 Groups, activation, and the exclusivity invariant

A group is a named set of assignments activated as a unit. The invariant:

> **No device may be claimed by two active groups at the same time.**

Two groups conflict iff their device sets intersect — `conflict(A,B) ⇔ devices(A) ∩ devices(B) ≠ ∅`. It is **per device, not global**: many groups can be active at once as long as they cover disjoint devices, which is what makes groups usable at 45 devices instead of one farm-wide switch.

```
activate(groupId):
  1. resolve group and its device set
  2. compute conflicts against all active groups
  3. conflicts && !force → REFUSE, naming the conflicting groups AND the exact overlapping devices
     conflicts &&  force → deactivate those groups first, in the same operation
  4. build the desired rule set
  5. plan (§4.4)
  6. apply
  7. mark active; write per-device `assignment` KV
```

Refusal names the overlap explicitly — *"Jadwal-2 conflicts with active Jadwal-1 on flip4-03, flip4-04"* is actionable; *"conflict"* is not. `force` exists because the common case (switching Jadwal-1 → Jadwal-2 on the same devices) is *by definition* a conflicting activation, and making the operator do it in two steps opens a window where those devices have no assignment at all.

Deactivation removes the group's managed rules, returning those devices to the router's default egress — stated plainly in the UI, because "deactivate" reads like "pause" but the traffic consequence is immediate. Per-group `onDeactivate`: `remove-rules` (default) or `disable-rules` (keep the rule, set `disabled: true` — cheaper to re-activate, visible in Winbox).

### 4.7 Reconcile — reports, does not heal

A self-rescheduling `setTimeout` (per §0.2's precedent — **not** `setInterval`, cleared in teardown, wired to `ctx.onStop`, interval injectable for tests), default 60 s, plus an explicit *Reconcile now*. Every difference is classified:

| Drift | Meaning | Default handling |
|---|---|---|
| Missing rule | Expected rule absent from router | Report; offer re-apply |
| Unexpected managed rule | Marker present, no KV record | Orphan — adopt or remove (§4.2) |
| Wrong path | Rule exists, `table` differs | Report; offer re-apply |
| Duplicate | Two managed rules, same endpoint | Report only, **never** auto-fix |
| Path missing | `table` no longer on router | Report; assignment invalid |
| Stale owner | Device blocked or gone from fleet, rule still live | Report; offer remove (§3.5) |

`autoRepair` is opt-in and covers only missing/wrong-path. The default is report-only for a concrete reason: on the owner's own hardware a Safe Mode rollback silently wiped router configuration **three times in one day**. An auto-healer would have hidden that; a reporter makes it visible.

### 4.8 Member scripts

Ordinary scripts (§0.2), so they queue, batch and schedule like any other work, and never talk to the router directly — they go through the service, keeping one enforcement point and one audit trail.

| Script | Purpose |
|---|---|
| `verify-egress` | Runs on the device under a lease. Reads the public IP from the device's own network stack, compares it with the assigned path's expected IP, writes `lastVerifiedAt`/`lastPublicIp` into the device-scoped assignment, and declares `result: { publicIp, expectedPath, matches }` so a mismatch surfaces as a result banner, not a log line. Built to be scheduled fleet-wide — this is the only check that can catch a stale-IP mis-steer. |
| `discover-lan-ip` | Reads the device's own LAN IP from the device and updates `assignment.lanIp` with `lanIpSource: 'probe'`. Genuinely new code (§0.3 item 4) — nothing in the repo reads a device IP today. Only needed for USB-attached devices. |
| `activate-group` | Thin wrapper over the service handler, params `{ group, force? }`, so a rotation is an ordinary scheduled job: `02:00 → jadwal-1`, `14:00 → jadwal-2`, both `force: true` (a scheduled switch between groups covering the same devices is by definition conflicting). Every fire — including refusals and no-ops — is recorded, so a rotation's history is never a blank gap. |

Rotation *policies* (round-robin, random-without-repeat, avoid-last-N) belong in a generator that produces groups, not in the activation path. Keeping activation dumb keeps it auditable.

### 4.9 Data model

Plugin KV, namespace injected server-side.

| Key | Scope | Secret | Value |
|---|---|---|---|
| `config` | global | no | `{ reconcileIntervalSec, requireConfirm, autoRepair, defaultOnDeactivate }` |
| `router` | global | **yes** | `{ baseUrl, username, password, tls, timeoutMs }` |
| `inventory` | global | no | Cached `{ paths[], interfaces[], leases[], fetchedAt }` for fast UI load |
| `health` | global | no | `{ [pathId]: { up, checkedAt } }` — latest reconcile result |
| `group:<id>` | global | no | `{ id, name, note, entries: [{ deviceId, lanIp, pathId }], active, onDeactivate, failoverPolicy, updatedAt }` |
| `assignment` | **device** | no | `{ pathId, groupId, lanIp, lanIpSource, leaseKind, since, lastVerifiedAt, lastPublicIp }` |

Groups are global because a group is a farm-level object that outlives any device; assignments are device-scoped so Forget cleans them up for free (§3.5).

### 4.10 Capabilities and security

Declared `service.permissions`: **`device.list`**, **`device.get`** (the fleet + address bridge — NOT `device.view`, §0.3 item 1), **`job.run`** (enqueue `verify-egress`), **`notify.send`** (drift and path-down alerts). **No `device.*` control capability of any kind is declared** — the plugin never touches a phone, and its manifest should make that visible on the install screen.

Router credentials live in `secret: true` KV. The plugin ships **no reveal route** (following `proxy-manager`'s own deliberate choice, `shared.ts:2221`); an operator who needs the password back uses the core's admin-only, audited `POST /api/kv/entry/reveal` (`packages/core/src/kv/store.ts:31-32`). The router-side API user should be scoped with `address=` to the controller subnet and needs write access only to `/routing/rule` — the Settings tab says so rather than assuming it. Plain HTTP is acceptable only on a trusted management segment, and the Settings tab states that plainly instead of pretending otherwise.

## 5. Implementation steps

Sequenced as the source proposal's own rollout (§15 there), because each stage is useful alone and earns the next. The owner chose to cover all four in this plan; the ordering still gives natural checkpoints to stop and verify against the real router before the next stage lands.

**Stage 1 — read-only. An operator can see their router through Enkaku before Enkaku can change it.**

**122.1 — `MikrotikRestDriver` + inventory. DONE.** New package `plugins/mikrotik-routing` (package.json/tsconfig mirroring `plugins/networking`'s minimal, no-UI shape rather than `plugins/proxy-manager`'s fuller tier-C scaffold, since no screen exists yet — added to `scripts/typecheck.sh`'s package list). `src/service/rest-client.ts`: `MikrotikRestClient` — Basic Auth, `AbortSignal.timeout(timeoutMs)`, a `tls` boolean choosing `http`/`https`, a bare `baseUrl` (host[:port], no scheme, per §4.9's `router` KV shape), `GET`/`PUT`/`PATCH`/`DELETE`, every failure normalised to a typed `MikrotikRestError` (`network`/`auth`/`http`/`parse`) with the router password scrubbed from any message (`src/service/errors.ts`, mirroring `plugins/proxy-manager/src/service/errors.ts`'s `scrubSecrets`/`messageOf`). `src/service/schemas.ts`: Zod shapes for `/routing/rule` (hardware-verified field set per §0/§4.1), plus `/routing/table`, `/ip/route`, `/interface`, `/ip/dhcp-server/lease`, `/system/resource` — **NOT hardware-verified in this change** (no router was available); each is `.passthrough()` with a defensive `boolish` preprocessor (native `true`/`false` or the `"true"`/`"yes"`/`"false"`/`"no"` string spellings), so a genuine shape mismatch (a missing identifying field) still fails as a named `MikrotikRestError('parse', …)` rather than producing garbage — the file's own header says plainly which endpoint is verified and which four are inferred from RouterOS's public REST documentation. `src/service/router-driver.ts`: the `RouterDriver` interface exactly as §4.1 declares it (`inventory`/`listRules`/`createRule`/`updateRule`/`deleteRule`/`doctor`) and `MikrotikRestDriver`, its only implementation. `inventory()` joins `/routing/table` with `/ip/route` (preferring the `routing-table` field over v6's `table` spelling) to report each path's gateway and its `active`-flag health (§4.5); leases are read and returned now (macAddress/dynamic/status) though nothing yet consumes them (§3.4 is a later step). `listRules()` returns every rule unfiltered — classification is step 122.2's. `doctor()` never throws: it reports `reachable`/`authenticated` separately (a 401 vs. an unreachable host are distinguished), the local-exception rule's presence **by exact comment match** (`LOCAL_EXCEPTION_COMMENT = 'farm: local exception'`, `src/shared.ts`) with the two fix commands from §3.2 always populated verbatim (including the `<farm-subnet>` placeholder, which the plugin cannot fill in itself), a best-effort `restVersion` from `/system/resource`, and managed/foreign counts via a coarse `MANAGED_COMMENT_PREFIX` check (`enkaku:mikrotik-routing:`) — deliberately **not** the full marker parser, which is step 122.2's job. **`createRule`/`updateRule`/`deleteRule` are declared on the interface, implemented as `async` methods that unconditionally reject with "not implemented … step 122.6's job" — this build has zero write capability, exactly as scoped.** No router `.id` is stored anywhere in this step (§3.3) — nothing here persists state at all yet. *Result:* the router can be read and its health reported, with zero write capability existing yet. *Verification:* `bun run --cwd plugins/mikrotik-routing test` — 21 pass, 0 fail, across `rest-client.test.ts` (fake `Bun.serve` REST server: all four verbs, the hardware-verified `/routing/rule` shape, 401→`auth`, 5xx→`http` with the password scrubbed from an echoed body, non-JSON→`parse`, an unreachable port→`network`, a slow response aborted at `timeoutMs`, and `tls: true` against a plain-HTTP fixture failing to connect), `router-driver.test.ts` (inventory join incl. a path with no default route, a missing-field response failing as a named parse error, `listRules` returning everything unfiltered, `doctor()`'s local-exception present/absent/unauthenticated/unreachable branches, and the three write methods rejecting before any network call), and `index.test.ts` (the manifest itself, and that `checkScript` is a real script definePlugin accepts). `bun run typecheck` (workspace-wide, via `scripts/typecheck.sh`) is clean, `mikrotik-routing OK` alongside every other package. **What is explicitly NOT verified:** every schema in `schemas.ts` except `RouterRuleSchema` was written against RouterOS's public REST documentation, not exercised against a real router — there was no hardware available in this session. The `ENKAKU_TEST_DEVICE=1`-gated integration test §7 calls for is not built in this step and remains the place a real disagreement would surface. `docs/plans/00-overview.md` §9 gained no new row: this step adds no DB schema and no compatibility-window artefact, only a new package.

**122.2 — marker + drift classification, as pure functions. DONE.** `src/service/marker.ts` (`parseMarker`/`serialiseMarker`), `src/service/drift.ts` (`classifyDrift` over `{ desired, rules, pathIds, activeDeviceIds }`), and `src/service/resolve.ts` (`resolveTarget` — §4.3's matcher, built here rather than deferred to 122.6: it is a ten-line pure function with no dependency on the write path, and having it tested before anything calls it is the point of this step). `MANAGED_COMMENT_PREFIX` is imported from `shared.ts`, never redeclared, so the two constants cannot drift apart.

**Marker segment legality, decided and documented** (in `marker.ts`'s own header, with a round-trip test table): the format is fixed-arity, not delimiter-scanned — version and `groupId` each read to their next colon, `endpointKey` takes the remainder. So the two fields are deliberately asymmetric: **`groupId` may not contain `:`** (it is not the last field, so an embedded colon is indistinguishable from its terminator — `serialiseMarker` refuses one, and `parseMarker` can never produce one from a comment `serialiseMarker` wrote), while **`endpointKey` may** (it consumes the remainder unambiguously, which is what lets an IPv6 address round-trip even though §3.4's tier-1 bridge only emits IPv4 today). Both must be non-empty; nothing else is restricted (spaces, dots, dashes, non-ASCII all round-trip), since a RouterOS comment is a plain string and assuming more structure would be inventing a constraint the router does not have.

**One judgement call, flagged for sign-off rather than made silently, and hereby signed off:** §4.7's table has six rows and no row for *"a rule carrying the managed prefix whose marker does not parse"* — malformed, or a future `v2`. Both are classified as **`unexpected-managed-rule` (orphan)** with `groupId: null, endpointKey: null`, rather than inventing a seventh drift kind. That satisfies §4.2's "detected rather than mis-parsed" exactly: the plugin never guesses at such a rule's identity and never touches it, and adopt-or-remove stays the human decision §4.2 already requires for every orphan. **Agreed — this is the right call**, and it is the behaviour the tests pin.

Two further classifier decisions worth recording: `duplicate` is computed first and takes priority, flagged purely on "2+ managed rules share one `endpointKey`" independent of whether that endpoint is even in the desired set (§4.3's "never guess which to keep" applies whether or not we currently want the endpoint); and `stale-owner` fires only when a rule actually exists — a blocked-or-gone device with no rule on the router is not drift, it is just gone. *Result:* the two pieces of logic most likely to be subtly wrong are provable before anything uses them. *Verification:* `bun test src/service/marker.test.ts src/service/drift.test.ts src/service/resolve.test.ts` — 56 pass, 0 fail, 86 expect() calls (22 marker + 15 drift + 8 resolve, plus the round-trip table). `bun run typecheck` clean.

**122.3 — the plugin shell + read-only surface. DONE — stage 1 is complete.** Manifest (`src/index.ts`) declares exactly §4.10's capability list — `device.list`, `device.get`, `job.run`, `notify.send`, **and no device-control capability of any kind**, which is acceptance criterion 8 and is asserted by a test rather than left to inspection. One tier-C view (`react: { entry, apiVersion }`). Version bumped 0.1.0 → 0.2.0, treated as a consent change on `proxy-manager`'s own reasoning (a service plus four capabilities is new surface an operator approves at install).

KV per §4.9: `config` (plain) and `router` (**secret**, one atomic row `{baseUrl, username, password, tls, timeoutMs}`), both with defensive read/write pairs following `readProxyRecord`'s discipline. **No reveal route exists** (§4.10): the browser writes `router` through the generic `PUT /data/entry` with `secret: true, hint: false` and can only ever learn *whether* a connection is saved, never its value. Note the deliberate difference from `proxy-manager`, which splits password from the rest — §4.9's table specifies one secret row here, and the whole connection is one credential.

Service (`src/service/handlers.ts`): three `ctx.onRequest` read routes — `inventory`, `rules` (split Managed/Foreign via `marker.ts`'s `parseMarker`), `doctor`. **Every failure answers a shaped `{ok:false, code, message}` rather than throwing** — a router that is unreachable, unauthenticated, or not configured at all is an ordinary answer the screen renders, not an exception. **No write route exists.**

The §3.2 precondition is surfaced the way that section demands: Settings auto-runs `doctor()` once a connection is saved, and when the local-exception rule is absent it renders a dedicated warning panel stating **the consequence in plain terms — losing ADB control of the device** — with `LOCAL_EXCEPTION_FIX_COMMANDS` verbatim in a copyable block. The plain-HTTP and `address=`-scoping guidance from §4.10 is stated unconditionally, not only on failure.

Three deliberate scope trims, each named rather than silently dropped: `PluginConfig` omits §4.9's `defaultOnDeactivate` (deferred to the first step that needs `onDeactivate`, via the same read-time-default discipline); no `inventory`/`health` KV caching yet (Paths/Rules call the driver live — caching is an optimisation §4.9 lists but this step's own bullet does not require); and `docs/spec.md` is untouched, matching the precedent that no other plugin's screen is enumerated there either. *Result:* stage 1 ships and is independently useful; no write path exists in the codebase yet. *Verification:* `bun test src/index.test.ts src/shared.test.ts src/service/handlers.test.ts` — 32 pass, 0 fail, 75 expect() calls. `bunx tsc --noEmit -p plugins/mikrotik-routing` clean. **No tests under `src/ui/**`**, per the standing owner instruction (§2) — that code is typecheck-verified only.

**Stage 2 — single assignments.**

**122.4 — the identity bridge. DONE (pure module; broker wiring deferred).** `src/service/identity-bridge.ts` — `resolveDeviceLan(device, stored, leases)` and `buildIdentityBridge(devices, leases, stored?)`, both pure: they take `DeviceInfo[]` and the router's leases as arguments and call nothing. Wiring them to the real `device.list` capability and `inventory()` belongs to 122.6, deliberately.

**"Needs an address" is a discriminated union, not a nullable field** — a design improvement over what this plan originally specified, and worth keeping: `DeviceLanAddress` is `ResolvedDeviceLan { state: 'resolved', lanIp, lanIpSource, leaseKind, lease }` | `UnresolvedDeviceLan { state: 'needs-address' }`, and the unresolved arm carries **no `lanIp` field at all**. A caller therefore cannot read a null address and proceed anyway — TypeScript forces the `state` check first. For the one module in this plugin where being subtly wrong means silently steering *the wrong phone* (§8's first risk row), making the mistake unrepresentable beats documenting it.

Tier order is enforced by `pickLanIp`: `transport` (from `connection.address`) always wins when present; otherwise `probe` beats `manual`. Tiers 2 and 3 are modelled as `StoredLanCandidates { probe, manual }` rather than a single pre-resolved `{lanIp, lanIpSource}` pair, so "prefer correctly between them" is a real tested branch rather than an assumption baked into whatever wrote the KV row upstream. Lease classification is `leases.find(l => l.address === lanIp)` — **by IP only, never MAC** (§0.3 item 3) — yielding `leaseKind: 'static' | 'dynamic' | 'none'`, with `'none'` kept distinct from both rather than folded into either, because "no lease at all" is a different and separately unverifiable fact.

Field shapes were re-confirmed against the source by the worker rather than taken from the task brief: `DeviceConnectionSchema` at `packages/protocol/src/device.ts:23-33` (the object closes at 33, not 32 as §0.2 says — a one-line correction to this plan's own citation), and `Lease` at `plugins/mikrotik-routing/src/service/router-driver.ts:65-73`. Test fixtures are built through `DeviceInfoSchema.parse(...)` rather than an `as DeviceInfo` cast, so a fixture that drifts from the real shape fails loudly instead of silently. *Result:* "which device is which IP" is answerable and its uncertainty is visible, not assumed away. *Verification:* `bun test src/service/identity-bridge.test.ts` — 10 pass, 0 fail, 30 expect() calls, covering tcp→exact address (ignoring any stored value), USB→`needs-address`, USB+manual only, USB preferring `probe` over `manual`, dynamic/static/absent lease each distinguishable, a lease carrying a MAC still matched by IP, a mixed fleet, and an empty fleet. `bun run typecheck` clean.

**122.5 — the planner. DONE.** `src/service/planner.ts` — `buildPlan(input): PlanRow[]`, pure, reusing rather than reimplementing: `DesiredAssignment` from `drift.ts` (extended with `groupName` for rendering), `resolveTarget` from `resolve.ts`, `parseMarker` from `marker.ts`, and `PathHealth`/`RouterRule` from `router-driver.ts` verbatim.

**`skip` precedence is enforced by construction, not by ordering luck** (§4.5's requirement): a desired entry that fails the path-exists check, the path-up check, or resolves to `refuse-duplicate` is diverted into a `skip` row *before* `create`/`update` is ever considered. An update whose existing `table` already equals the desired `pathId` produces **no row at all**, mirroring `drift.ts`'s "matches exactly — no drift".

**`foreign` is decided by the marker prefix alone, never by address** — proven by a dedicated test where a foreign rule shares a managed endpoint's `src-address` and still stays `foreign`, never `delete`. That is §4.4's whole point (the operator can see what the plugin is *not* touching) and it is the one row kind where getting it wrong would delete somebody's hand-made rule.

**"Path missing" vs "path is down"**: two `skip` *reasons* rather than a sixth row kind — `path-missing` reuses `drift.ts`'s exact term (`!pathIds.has(pathId)`), `path-down` is the health-flag case, and a path with **no health entry at all is treated fail-safe as down** rather than assumed up. A third reason, `duplicate`, folds in `resolveTarget`'s refusal (§4.3): it is exactly as unsafe to write blind as a dead path, and the plan's five-kind framing left it no other home. Both judgement calls are documented in the file's own header rather than left for a reader to infer.

**Determinism**, as §4.4 requires of anything an operator reviews: sorted by `(kind, endpointKey, rule['.id'])` with kind ordered `create → update → delete → skip → foreign` — the same order §4.4's own worked example lists them. Asserted by running `buildPlan` twice on identical input and comparing, plus a dedicated tiebreak test.

One deferral, correctly reasoned: `delete` rows carry the raw marker `groupId` (`jadwal-1`), not a friendly `Group.name`, because the router comment only ever stores the id and resolving it needs `ctx.storage` over *all* groups — I/O, and therefore 122.6's or the UI's job, not a pure function's. *Result:* every write from here on is a reviewed plan, by construction. *Verification:* `bun test src/service/planner.test.ts` — 17 pass, 0 fail, 21 expect() calls. `bun run typecheck` clean.

**122.6 — apply, and the Assignments tab.** `createRule`/`updateRule`/`deleteRule` behind §4.3's resolve-before-write (with the duplicate refusal), gated on `doctor()`'s local-exception check (§3.2 — **blocked**, not warned), plus the Assignments tab: device, LAN IP + lease warning, assigned path, owning group, path health, last verified public IP; row actions *Re-verify*, *Re-apply*, *Locate*. *Result:* the owner's stated goal is met — a device is assigned to a modem from Studio, and the router is the only thing that changed.

**Stage 3 — groups.**

**122.7 — the group algebra. DONE (pure core; I/O and CRUD deferred).** `src/service/groups.ts` — the §4.9 `group:<id>` KV shape (`GROUP_KEY_PREFIX`/`groupKeyFor`/`groupIdFromKey`, `GroupEntrySchema`/`GroupSchema`, `readGroup`/`writeGroup` with hand-rolled per-field defensive readers mirroring `proxy-manager`'s `readProxyRecord` discipline: junk/`undefined`/`null`/wrong-type/bad-enum all resolve to sane defaults rather than throwing, and **`id` always comes from the KV key, never from the stored value**, so a row cannot claim an identity other than the key it is filed under); the conflict algebra (`devicesOf`, `overlappingDeviceIds` — sorted and exact, `conflict`); and `decideActivation(group, activeGroups, force)` returning a discriminated union `{kind:'clean'}` | `{kind:'refuse', conflicts}` | `{kind:'force', toDeactivate}`, implementing §4.6's steps 1–3 and computing (never applying) what `force` would deactivate.

A refusal carries `GroupConflict = { group, overlappingDeviceIds }` — the whole conflicting group object plus the exact shared device ids — and `describeConflicts` renders §4.6's own sentence verbatim: *"Jadwal-2 conflicts with active Jadwal-1 on flip4-03, flip4-04"*. `decideActivation` also defensively filters `activeGroups` to `active: true` and excludes the candidate's own id, so re-activating an already-active group is never a self-conflict.

**Found, not fixed — a real gap this plan did not anticipate:** nothing yet refuses **the same device appearing twice inside ONE group's own `entries`**, at two different paths. That is a data-quality problem distinct from the cross-group exclusivity invariant this step covers (which is about two *different* active groups), and it would produce two desired rules for one endpoint — i.e. §4.3's `duplicate` refusal, discovered at apply time instead of at save time. The worker deliberately did not invent a refusal code for something unasked. **Assigned to 122.8's group-CRUD/validation work**, and added as acceptance criterion 12.

Also deferred to the wiring step and stated in the file's own header: reading/writing `group:<id>` through `ctx.storage` (this file imports nothing from the SDK), §4.6 steps 4–7 (build desired rules → plan → apply → mark active → write per-device `assignment`), and interpreting `onDeactivate` (a router write; this file only carries the field). *Result:* the invariant is enforced in code, not in an operator's head. *Verification:* `bun test src/service/groups.test.ts` — 39 pass, 0 fail, 53 expect() calls, including §4.6's worked example verbatim (Jadwal-1/2 over devices 1–5 and Jadwal-3/4 over 6–10: the two intersecting pairs conflict, and **all four cross-pairings coexist** — the per-device-not-global property that makes groups usable at 45 devices), partial overlaps reporting only the shared devices, every `readGroup` junk shape, and `writeGroup ∘ readGroup` always satisfying `GroupSchema`. `bun run typecheck` clean.

**122.8 — the Groups tab.** Group list with device count, active state, conflict indicator; a **conflict matrix** making "which groups can coexist" visible at a glance; activation showing the §4.4 plan plus, when conflicting, the exact overlapping devices and which groups would be deactivated. *Result:* a 45-device rotation is a two-click operation with the consequences shown before the click.

**Stage 4 — reconcile, scripts, scheduling.**

**122.9 — the reconcile loop.** Self-rescheduling `setTimeout` per §4.7/§0.2 (never `setInterval`; cleared in teardown; `ctx.onStop`-wired; interval injectable), the full drift table including §3.5's stale-owner class, report-only by default with opt-in `autoRepair` for missing/wrong-path only, and `notify.send` on newly-detected drift. *Result:* the router silently diverging from what Enkaku believes becomes something an operator is told about.

**122.10 — the three member scripts.** `verify-egress` (with its declared `result` schema, §4.8), `discover-lan-ip` (new device-IP read, §0.3 item 4), `activate-group`. *Result:* rotation is schedulable with existing cron machinery, and the stale-IP mis-steer has a detector.

**122.11 — docs + status.** This plan's `> Status:`/`Ships:` (single literal path on the `Ships:` line — `scripts/check-plan-status.sh` requires it, the trap plans 119 and 121 both hit); a `docs/plans/00-overview.md` §9 row for the plugin's KV shape; `docs/guide/` note on the local-exception prerequisite (§3.2) since that is operator setup, not plugin behaviour; `LICENSES.md` untouched (no new third-party binary — this is `fetch` against the operator's own router).

## 6. Acceptance criteria

1. **An apply is refused, not attempted, while the local-exception rule (§3.2) is absent** — asserted by a test, with the refusal naming the exact commands to fix it. This outranks every other criterion: the failure it prevents is losing control of a phone.
2. The plugin never creates, patches, or deletes a rule whose comment lacks the marker prefix — asserted against a fixture router state containing foreign rules.
3. Two managed rules for the same endpoint cause a refusal and a duplicate-drift report, never a guess at which to keep.
4. Rule `.id` is never persisted anywhere in KV — every write re-resolves its target first (§3.3).
5. Two groups whose device sets intersect cannot both be active; the refusal names the overlapping devices, not just "conflict". Two groups with disjoint device sets **can** both be active.
6. Deactivating a group removes (or disables, per policy) exactly its own rules and nothing else.
7. Reconcile reports every drift class in §4.7's table and repairs nothing unless `autoRepair` is on.
8. The plugin declares no device-control capability; `grep` over its manifest shows only `device.list`, `device.get`, `job.run`, `notify.send`.
9. Router credentials are written `secret: true` and never appear in any log line, error message, or plan preview.
10. `bun run typecheck` is clean; every touched backend file's own test passes, run scoped and sequential (CLAUDE.md's hard rule). No unit tests exist for `plugins/mikrotik-routing/src/ui/**` (§2, standing owner instruction).
11. A device Forgotten mid-assignment leaves no assignment KV (free, §3.5) — and its now-stale router rule is reported by reconcile rather than left invisible.
12. **(Added during 122.7, from a gap that step found.)** A group cannot be saved with the same device listed twice in its own `entries`. This is distinct from the cross-group invariant in criterion 5: without it, one group alone produces two desired rules for one endpoint, so the problem surfaces as an apply-time `duplicate` refusal (§4.3) instead of a save-time validation error, which is both later and harder to read. Owned by 122.8.

## 7. Test plan

- 122.1: fake-HTTP-server tests for the REST driver — inventory parse, rule list, doctor's each branch. No router.
- 122.2/122.5/122.7: pure unit tests (marker parse/serialise, drift classification, plan diffing, conflict algebra). These are the four pieces most worth exhaustive coverage and they need no I/O at all.
- 122.4: bridge tests over fixture `DeviceInfo` payloads — a tcp device yields an address, a USB device yields *needs an address* rather than a guess, a dynamic lease raises the warning.
- 122.6/122.9: service-level tests against the fake router — resolve-before-write (all three branches of §4.3), the §3.2 block, drift classification end to end.
- 122.10: script tests following whatever pattern `proxy-manager`'s `checkScript` uses.
- **Integration**, gated behind an env flag (the `ENKAKU_TEST_DEVICE=1` precedent): against a real router — inventory parse, create/patch/delete round-trip, `.id` instability handling.
- **Smoke**, on the owner's hardware, by hand: activate a two-device group → `verify-egress` on both → confirm two different public IPs → switch to the mirrored group → confirm the IPs swapped → deactivate → confirm both return to default egress. This is the end-to-end proof, and the only test that can catch a stale-IP mis-steer.

Every automated run scoped to the files touched, sequential, never a bare `bun test`; the plugin gets its own `bun run --cwd plugins/mikrotik-routing test`, and that command must be added to `.github/workflows/ci.yml` and `release.yml` beside the three existing plugin test gates (the gap plan 118 found and closed for `proxy-manager`).

## 8. Risks

| Risk | Mitigation |
|---|---|
| **A stale LAN IP steers the wrong device**, silently — the one failure the router cannot detect | Three-tier sourced `lanIp` with the source recorded (§3.4); dynamic-lease warning; `verify-egress` confirming from the device's own side; and the fact that the owner's entire farm is tier 1 (live transport address), where the IP is exact rather than remembered |
| Applying a rule cuts ADB to the device and control is lost | §3.2's precondition is a hard block, criterion 1, tested — not a warning |
| A Safe Mode rollback wipes router config and the plugin quietly re-writes over the evidence | Reconcile is report-only by default, specifically because this happened three times in one day on this hardware (§4.7) |
| RouterOS REST shape differs on another version and the driver mis-parses silently | Everything vendor-specific is confined to `MikrotikRestDriver` (§4.1); `doctor()` reports the REST version; the integration test (gated) is the place a version difference surfaces |
| The plugin and `proxy-manager` are both steering the same device by different mechanisms | Recorded as §9 Q2 rather than silently allowed — needs the owner's own call on whether to detect and refuse |
| Scope: four stages is a large plan, and stage 4 schedules something that has never run by hand | The stage ordering is the mitigation — each stage is separately shippable and separately verifiable against the real router, and §5's own note says so |

## 9. Open questions

1. **Should a device be allowed in an active group *and* a manual standalone assignment?** Proposal (carried from the source doc, and I agree): no — standalone assignments live in an implicit group named `default`, so one invariant covers both cases with no special-casing.
2. **(New) Should the plugin detect that a device also has a `proxy-manager` route applied and refuse or warn?** The two steer the same device by opposite mechanisms (§0.5) and the interaction is genuinely undefined — the router would steer all traffic out modem A while the device's proxy setting sends app traffic to a bridge egressing modem B. Needs the owner's own call; not assumed here.
3. **Is `move` reachable over the binary API (8728)** even though REST lacks it? If yes, a future `MikrotikApiDriver` could manage the exception rule itself and remove §3.2's operator prerequisite entirely — a strictly better end state, but a second protocol implementation, so not in this plan.
4. **Should `failoverPolicy: substitute` survive a reconcile**, or revert to the declared path as soon as it is healthy? Proposal: revert, with the substitution logged — a group's declared intent is the source of truth, and a substitution that quietly becomes permanent is a group that no longer means what it says.
5. **Path display aliases.** Paths are identified by routing-table name (`via-modem7-p12`), an operator convention. Worth letting the plugin store a display alias (`Modem 7 — Indosat`) without touching the router? Proposal: yes, but as a later, purely-cosmetic addition — it changes no behaviour and should not delay the stages above.
