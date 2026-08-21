# Plan 122 — M87 : MikroTik routing — device → egress path, from Studio

> Status: partial — **stage 1 (read-only) and stage 2 (single assignments) are complete**, 2026-08-21. Done: 122.1 (REST driver + inventory), 122.2 (marker/drift/resolve), 122.3 (plugin shell + Paths/Settings/Rules tabs), 122.4 (identity bridge), 122.5 (planner), 122.6 (apply + the Assignments tab — the write path), 122.7 (group algebra), 122.12 (local-exception check corrected — behaviour-based, per-device, position-aware, three states, urgent fix found on the owner's real router). An operator can now see their router through Enkaku — paths and health, managed vs foreign rules, a Settings tab that runs `doctor()` and states plainly (`missing`/`partial`/`ok`) whether §3.2's local-exception coverage actually protects every device it knows — **and can now assign a single device to a path from the Assignments tab, review the exact §4.4 diff, and apply it**, with the write refused rather than attempted while the local-exception check is not `ok` (acceptance criterion 1). `createRule`/`updateRule`/`deleteRule` on `MikrotikRestDriver` are real REST calls as of this step; no router `.id` is ever persisted to KV (§3.3) — every write re-resolves its target through `resolve.ts`'s `resolveTarget`, run by `planner.ts`'s `buildPlan` against rules fetched fresh in the same request. Single assignments made from this stage live in the IMPLICIT group `default` (§9 Q1) — no `group:<id>` KV row is read or written by this step. Outstanding: 122.8 (named Groups tab + group CRUD + activation, which also owns acceptance criterion 12), 122.9 (reconcile loop), 122.10 (member scripts — `verify-egress`/`discover-lan-ip`/`activate-group`), 122.11 (docs/status closure), 122.13 (optional bulk-assignment convenience). 122.4 and 122.7 still ship only their pure cores — group KV CRUD is 122.8's job, not this step's. **Nothing in this plan has been exercised against a real MikroTik router END-TO-END through the plugin's HTTP routes, including the new write path** — 122.6's `createRule`/`updateRule`/`deleteRule` were verified against a fake `Bun.serve` REST fixture (request method/path/body captured and asserted), not a live router; every schema except `/routing/rule`'s is still inferred from RouterOS documentation, and §7's gated integration test and hardware smoke are both unbuilt. The owner's own farm should be pointed at this stage next, on a low-risk device first, before 122.8's group activation lands.
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

**122.6 — apply, and the Assignments tab. DONE.** `createRule`/`updateRule`/`deleteRule` behind §4.3's resolve-before-write, gated on the local-exception check (§3.2 — **blocked**, not warned), plus the Assignments tab. Scoped narrower than this step's original one-liner in two ways, both deliberate and named rather than silently dropped:

- **Single assignments only, no named groups.** Stage 3 (122.7's pure algebra is DONE, 122.8's CRUD/activation is not) owns named groups. Every assignment made here lives in the IMPLICIT group `default` (§9 Q1: "standalone assignments live in an implicit group named `default`") — no `group:<id>` KV row is ever read or written by this step, and the Assignments tab therefore has no "owning group" column (it would only ever say "Default").
- **No `verify-egress` actions yet** (*Re-verify*/*Locate* from this step's original wording) — `verify-egress` is 122.10's member script and does not exist yet, so there is nothing for those buttons to run. The `assignment` KV's own shape carries no `lastVerifiedAt`/`lastPublicIp` fields for the same reason: a field nobody writes yet is a promise the record cannot keep (the same rule `router-driver.ts`'s own header states for a schema field nobody reads).

**What shipped**, five files plus two touched:

- `service/router-driver.ts` (touched) — `createRule` (`PUT /routing/rule`, `action: 'lookup-only-in-table'` per §0.1's own worked example, returns the router's `.id`), `updateRule` (`PATCH /routing/rule/<id>`, only the given fields), `deleteRule` (`DELETE /routing/rule/<id>`). **`src-address` is written as the bare address, never `/32`** — a deliberate divergence from §0.1's raw CLI example, because `resolve.ts`/`marker.ts`/`drift.ts`/`planner.ts` (122.2/122.5, already DONE and already tested) all match an endpoint against `RouterRule['src-address']` by exact string equality; appending a prefix here that a later `listRules()` echoed back verbatim would break that match on the very next apply and silently double the rule instead of updating it.
- `service/router-config.ts` (new) — `loadRouterConfig`, factored out of `handlers.ts`'s own `loadDriver` so the write path (`apply.ts`) refuses with the exact same two messages the read routes always have, rather than a second copy that could drift. `handlers.ts` itself now calls it too; its own tests pass unchanged.
- `service/apply.ts` (new) — the write path's whole orchestration. `loadFleetState` joins `device.list` to each device's own `assignment` KV (N+1 over devices, the same trade `plugins/proxy-manager/src/service/apply.ts`'s `currentHolders` already makes — no host-side capability scans device KV across the fleet in one call) and to `buildIdentityBridge`'s output (§3.4), passing each device's stored `lanIpSource: 'probe'|'manual'` value back in as `StoredLanCandidates` so tier 1 (`connection.address`) still always wins. `prepareApply` fetches the router's rules/inventory/device-list FRESH and runs the identical `buildPlan` both `previewPlan` and `applyNow` share, so a preview and an apply can never disagree (§4.4). `applyNow` is gated: `localException.status !== 'ok'` refuses (`E_LOCAL_EXCEPTION_NOT_OK`) with **zero** driver calls, asserted directly in tests for both `missing` and `partial` — `partial` is the state that looks safe and is not, and it is exercised, not merely `missing`. `executePlan` walks only `create`/`update`/`delete` rows (`skip`/`foreign` are structurally excluded before the loop even starts) and attempts each independently — the router has no cross-rule transaction, so one failing write is recorded as an `error` outcome and does not abort the rest.
- `service/apply-routes.ts` (new) — three routes: `GET fleet` / `POST plan` (`script.view`, the same permission the read-only routes already use) and `POST apply` (`plugin.runtime` — `plugins/proxy-manager`'s own precedent for "this changes what a plugin's own resource is doing", never `plugin.data`; there is no device-facing ACL permission to reuse the way that pack's `apply` route reuses `device.network`, because this plugin never touches a device).
- `shared.ts` (touched) — the `assignment` KV shape (§4.9): `ASSIGNMENT_KEY`, `StoredAssignment` (`pathId`/`groupId`/`lanIp`/`lanIpSource`/`leaseKind`/`since`), `readAssignment`/`writeAssignment`/`isAssignmentEmpty`, the same defensive read-time-default discipline every other key in this file already uses. `DEFAULT_GROUP_ID`/`DEFAULT_GROUP_NAME` for §9 Q1's implicit group. **The `assignment` note is written by the BROWSER directly**, through the core's generic `PUT/DELETE .../data/entry?scope=device&...` route — the same non-secret, device-scoped door `proxy-manager`'s own Assignments tab writes its note through — never by a custom service route, because choosing a path or typing a manual IP changes nothing on the router and needs no `plugin:mikrotik-routing` principal.
- `src/index.ts` (touched) — wires `registerApplyRoutes(ctx)` alongside `registerRouterRoutes(ctx)`. Version bumped `0.2.0` → `0.3.0`: `service.permissions` is unchanged (this is not a consent bump), but `seedEmbeddedPacks` keys on `name@version` and three new routes plus real write capability under an unchanged version would leave an already-provisioned farm silently running the read-only bundle forever — `proxy-manager`'s own 0.9.0/0.10.0 notes give the identical reasoning.
- `src/ui/parts/api.ts` (touched) — `FleetResultSchema`/`PlanPreviewResultSchema`/`ApplyResultSchema` and the four new calls (`fetchFleet`/`previewApplyPlan`/`runApply`/`saveAssignment`/`clearAssignment`).
- `src/ui/parts/assignments.tsx` (new) — the Assignments tab. Device label, LAN address with the §3.4 dynamic-lease warning (`leaseKind === 'dynamic'`), an obvious manual-IP input for a `needs-address` device (never hidden, never guessed — the owner's own tier-3 ask), assigned path (a `Select` disabled until an address is known), path health, and *Unassign*. Choosing a path or saving a manual IP writes the `assignment` KV note ONLY — the router is untouched until "Preview & apply" is pressed, which opens a dialog that fetches the live plan, shows the local-exception status and every `blocked` device by name, and only then offers "Confirm apply". **No unit tests for `src/ui/**`**, per the standing owner instruction. `src/ui/index.tsx` gained the fourth tab.

*Result:* the owner's stated goal is met — a device is assigned to a modem from Studio, and the router is the only thing that changed. *Verification:* `bun test` from inside `plugins/mikrotik-routing` (its own `bun run --cwd plugins/mikrotik-routing test`) — 273 pass, 0 fail, across 18 files, 540 `expect()` calls total; `router-driver.test.ts` gained real write-method tests (PUT/PATCH/DELETE captured and asserted, including the bare-address requirement and a parse-error on a response with no `.id`); `apply.test.ts` (new, 17 tests) covers `loadFleet`/`previewPlan`/the local-exception gate (both `missing` and `partial` block, zero driver calls) /create/update/delete row execution/a foreign rule never touched (criterion 2)/a duplicate never guessed at (criterion 3)/a down path skipped (§4.5)/one failing write not aborting the rest; `apply-routes.test.ts` (new, 6 tests) proves the registration table and that each route answers via its `apply.ts` function. `bun run typecheck` (workspace-wide) clean across all 18 packages. **What is explicitly NOT verified:** no real MikroTik router was available in this session — every write test runs against a fake `Bun.serve` fixture or a fake `RouterDriver`, never a live device. The bare-address-vs-`/32` decision (this step's own header comment on `createRule`) is reasoned from the ALREADY-TESTED matching contract in `resolve.ts`/`drift.ts`/`planner.ts`, not from a round-trip observed on hardware — the `ENKAKU_TEST_DEVICE=1`-gated integration test §7 calls for remains the place that would catch a disagreement (e.g. if RouterOS silently appends `/32` to a bare `src-address` on write).

**Correction, found by review immediately after this step landed, before the owner released it, 2026-08-21.** The bare-address bet above was wrong, and the owner's own `curl` against their real router (cited in step 122.12) proves it the same way it proved defect B there: `GET /rest/routing/rule` echoes every `src-address` in CIDR form (`192.168.10.221/32`, `192.168.50.11/32`, `192.168.100.230/32`, `192.168.50.0/24`), regardless of what was written. `resolve.ts`'s `resolveTarget` matched `src-address` against the endpoint by exact string equality — so the very next apply after a create would find zero matches for a rule it had just written, and create a **second** rule for the same device instead of updating the first. The same raw-equality bug also lived in `planner.ts`'s delete/foreign loop (the "claimed by desired" check), which meant the very same CIDR-echoed rule could show up as `create` **and** `delete` in one plan. Fixed by matching on parsed address range instead of raw string:

- `cidr.ts` gained `sameAddressSpec(a, b)` — true iff both sides parse to the identical address span (a bare host and its `/32` spelling are the same span; a broader block like `/24` is not, even though it contains the host). `false`, never a throw, when either side fails to parse.
- `resolve.ts`'s `resolveTarget` and `planner.ts`'s delete/foreign membership check both now compare `src-address` via `sameAddressSpec` instead of `===`.
- `router-driver.ts`'s `createRule`/`updateRule` now write `src-address` as an explicit `/32` rather than bare — now that matching no longer depends on the written form, `/32` is chosen because it is what the owner's own hand-made rules already look like in Winbox (§0.1's worked example, and the local-exception fixture in 122.12), so a managed rule no longer looks different from a hand-made one for no reason.
- `local-exception.ts` was audited too (§4.3's normalisation applies everywhere a router-supplied `src-address`/`dst-address` is compared against a value we produced) and needed no change: its `deviceIsCovered`/`dstCoversCore` already compare via `specContains` (parsed-range containment, from `cidr.ts`), never raw string equality. Its one remaining `===` (`firstManagedRuleIndexFor`'s `parsed.endpointKey === device.address`) compares two values this plugin itself produces — the marker's own `endpointKey` segment against the identity bridge's own resolved address — never the router's `src-address` field, so it does not carry this bug.
- `src/index.ts`'s `0.3.0` version-history comment (this fix shipped before that version was ever released, so it was not re-bumped) gained a paragraph naming the bug and the fix.

*Verification:* `bun test src/service/cidr.test.ts src/service/resolve.test.ts src/service/planner.test.ts src/service/router-driver.test.ts src/service/local-exception.test.ts src/service/apply.test.ts` (scoped to the touched files and their existing neighbours, run from inside `plugins/mikrotik-routing`) — 107 pass, 0 fail, 225 `expect()` calls; `resolve.test.ts` gained a CIDR-normalisation describe block (rule says `/32`/endpoint bare and vice versa, both spelled the same way, a malformed `src-address` never matches and never throws, a broader block is not treated as the same host) plus a REGRESSION test built around the owner's real router's CIDR-echo behaviour asserting `resolveTarget` returns `create` then `update` — never `create` twice; `planner.test.ts` gained the equivalent at the `buildPlan` level (same device/same path twice → `create` then no row, never a second `create` or a spurious `delete`; same device/different path → `create` then `update`); `cidr.test.ts` gained `sameAddressSpec` coverage; `router-driver.test.ts`'s write-method test now asserts the `/32` form. **Every new/changed test was confirmed to fail against the pre-fix code** (`resolve.ts`/`planner.ts` reverted to the raw `===` comparison) before being restored — the CIDR-normalisation and regression tests failed exactly as expected (`create` where `update` was required, and the same rule appearing as both `update` and `delete` in one plan for the reverted `planner.ts`), proving they actually catch the bug rather than passing vacuously. `bun run typecheck` (workspace-wide) clean across all 18 packages.

**122.13 — bulk assignment: pair many devices to many paths in one pass. OPTIONAL CONVENIENCE — read the correction below before prioritising it.**

*Recorded because the reasoning matters more than the step:* this was first written as a **missing feature**, on a reading of the owner's *"user bisa bikin routing otomatis beberapa modem dan assign ke beberapa device"* as "bulk-create the assignments". **That reading was wrong, and they corrected it immediately**: *"maksud saya otomatis itu kan bikin grup itu, assign beberapa dan bisa gampang diaktifkan atau didisable otomatis routing rulenya juga mengikuti"* — **"otomatis" means the group mechanism itself**: define a group once, then enable or disable it and have the router's rules follow automatically. That is **already** what §4.6, step 122.7 (built) and step 122.8 (not yet built) specify, and it is the centre of the whole feature, not a gap in it.

What remains genuinely true is narrower: a 40-entry group still has to get its entries from somewhere, and pairing 40 devices to 45 paths by hand in a form is tedious. So this step stays — as a **convenience for populating a group**, explicitly behind 122.8 in priority, not as the thing the owner asked for.

The shape is already established in this repo and should be followed rather than invented: `plugins/proxy-manager/src/ui/parts/catalogue.tsx`'s **`GenerateDialog`** — a small form (a label pattern, a starting value, a count), a **full preview table computed from the inputs and editable per row**, a refusal that names why a row cannot be created rather than dropping it silently, and **nothing written until the button is pressed**. Read it before designing; its own header comment states the discipline it follows and why.

Applied here, the generator pairs a **selected set of devices** with a **selected set of paths**:

- Pairing strategy is the operator's choice, not a hidden default. At minimum `round-robin` (device *i* → path *i mod n*) and `one-to-one` (refuse if the counts differ, rather than silently wrapping — for a 1 device : 1 modem farm, a wrap is a mistake, not a convenience).
- The preview is the §4.4 plan itself, not a second rendering of it — reuse `planner.ts`'s `buildPlan` (122.5) so bulk and single assignment can never disagree about what is about to happen. A path that is down still shows as `skip`, a duplicate still refuses.
- The result is written as a **group** (122.7's shape), not as loose assignments — §9 Q1 already decided that standalone assignments live in an implicit `default` group, so producing a group keeps one invariant covering both and makes the whole set switchable later, which is what stage 3 is for.
- Devices with no known address (§3.4's `needs-address`) are listed as refused rows with that reason, never silently skipped.

*Result:* the owner's actual sentence becomes one operation — select devices, select paths, choose how to pair them, review the exact plan, apply. **Depends on 122.6** (there is nothing to apply through until the write path exists) and produces input for 122.8. Tests: round-robin and one-to-one pairing as pure functions over fixture device/path lists (count mismatch refuses; wrap is only reachable in round-robin); a down path yields `skip` in the generated plan; a `needs-address` device yields a named refusal; the generated group satisfies `GroupSchema` and contains no duplicate device (acceptance criterion 12).

**Stage 3 — groups.**

**122.7 — the group algebra. DONE (pure core; I/O and CRUD deferred).** `src/service/groups.ts` — the §4.9 `group:<id>` KV shape (`GROUP_KEY_PREFIX`/`groupKeyFor`/`groupIdFromKey`, `GroupEntrySchema`/`GroupSchema`, `readGroup`/`writeGroup` with hand-rolled per-field defensive readers mirroring `proxy-manager`'s `readProxyRecord` discipline: junk/`undefined`/`null`/wrong-type/bad-enum all resolve to sane defaults rather than throwing, and **`id` always comes from the KV key, never from the stored value**, so a row cannot claim an identity other than the key it is filed under); the conflict algebra (`devicesOf`, `overlappingDeviceIds` — sorted and exact, `conflict`); and `decideActivation(group, activeGroups, force)` returning a discriminated union `{kind:'clean'}` | `{kind:'refuse', conflicts}` | `{kind:'force', toDeactivate}`, implementing §4.6's steps 1–3 and computing (never applying) what `force` would deactivate.

A refusal carries `GroupConflict = { group, overlappingDeviceIds }` — the whole conflicting group object plus the exact shared device ids — and `describeConflicts` renders §4.6's own sentence verbatim: *"Jadwal-2 conflicts with active Jadwal-1 on flip4-03, flip4-04"*. `decideActivation` also defensively filters `activeGroups` to `active: true` and excludes the candidate's own id, so re-activating an already-active group is never a self-conflict.

**Found, not fixed — a real gap this plan did not anticipate:** nothing yet refuses **the same device appearing twice inside ONE group's own `entries`**, at two different paths. That is a data-quality problem distinct from the cross-group exclusivity invariant this step covers (which is about two *different* active groups), and it would produce two desired rules for one endpoint — i.e. §4.3's `duplicate` refusal, discovered at apply time instead of at save time. The worker deliberately did not invent a refusal code for something unasked. **Assigned to 122.8's group-CRUD/validation work**, and added as acceptance criterion 12.

Also deferred to the wiring step and stated in the file's own header: reading/writing `group:<id>` through `ctx.storage` (this file imports nothing from the SDK), §4.6 steps 4–7 (build desired rules → plan → apply → mark active → write per-device `assignment`), and interpreting `onDeactivate` (a router write; this file only carries the field). *Result:* the invariant is enforced in code, not in an operator's head. *Verification:* `bun test src/service/groups.test.ts` — 39 pass, 0 fail, 53 expect() calls, including §4.6's worked example verbatim (Jadwal-1/2 over devices 1–5 and Jadwal-3/4 over 6–10: the two intersecting pairs conflict, and **all four cross-pairings coexist** — the per-device-not-global property that makes groups usable at 45 devices), partial overlaps reporting only the shared devices, every `readGroup` junk shape, and `writeGroup ∘ readGroup` always satisfying `GroupSchema`. `bun run typecheck` clean.

**122.8 — groups, end to end. THE CENTRE OF THE FEATURE — the owner's own "otomatis" (see 122.13's correction) is exactly this step, so it must not be read as a UI-only task.** 122.7 built the pure core and deliberately deferred everything that touches the world; this step owns all of it:

- **Group CRUD** — create, rename, edit and delete a group; add and remove `{deviceId, lanIp, pathId}` entries; persist through `ctx.storage` with `groups.ts`'s `readGroup`/`writeGroup` (122.7 imports nothing from the SDK by design). **Refuse a group that lists the same device twice** — acceptance criterion 12, the gap 122.7 found and named rather than silently allowing: one group alone would otherwise produce two desired rules for one endpoint and surface as an apply-time `duplicate` refusal (§4.3) instead of a save-time error.
- **The activation transaction, §4.6 steps 4–7** — build the desired rule set from the group, run it through `planner.ts` (122.5), apply through the write path (122.6), mark the group active, and write the per-device `assignment` KV. `decideActivation` (122.7) already decides *whether* activation may proceed and what `force` would deactivate; this step is what makes that decision actually change the router.
- **Deactivation, and `onDeactivate` honoured** — `remove-rules` (default) or `disable-rules`. 122.7 carries the field and interprets nothing. §6.3's warning is a UI requirement, not a nicety: "deactivate" reads like "pause", but the traffic consequence is immediate — those devices return to the router's default egress the moment it lands.
- **The tab itself** — group list with device count, active state and a conflict indicator; a **conflict matrix** making "which groups can coexist" visible at a glance; activation showing the §4.4 plan, plus — when conflicting — the exact overlapping devices and which groups would be deactivated.

*Result:* the owner's actual sentence works: define a group once, then enable or disable it and the router's rules follow automatically, with the exact consequences shown before the click and the per-device exclusivity invariant enforced rather than trusted. **Tests:** activation writes exactly the group's rules and nothing else; deactivation under each `onDeactivate` policy removes or disables exactly its own rules and leaves foreign and other-group rules untouched; a duplicate device in one group is refused at save time; a conflicting activation without `force` refuses and names the overlap; with `force` it deactivates the conflicting groups in the same operation, leaving no window where a device has no assignment.

**Stage 4 — reconcile, scripts, scheduling.**

**122.9 — the reconcile loop.** Self-rescheduling `setTimeout` per §4.7/§0.2 (never `setInterval`; cleared in teardown; `ctx.onStop`-wired; interval injectable), the full drift table including §3.5's stale-owner class, report-only by default with opt-in `autoRepair` for missing/wrong-path only, and `notify.send` on newly-detected drift. *Result:* the router silently diverging from what Enkaku believes becomes something an operator is told about.

**122.10 — the three member scripts.** `verify-egress` (with its declared `result` schema, §4.8), `discover-lan-ip` (new device-IP read, §0.3 item 4), `activate-group`. *Result:* rotation is schedulable with existing cron machinery, and the stale-IP mis-steer has a detector.

**122.12 — the local-exception check, corrected. DONE — URGENT, found on the owner's real router, 2026-08-21, before stage 2 exists.** Stage 1 was pointed at the live lab router and reported **"Local exception MISSING"** while a rule that reads like one was sitting at the top of the list. Four separate defects, and they compound:

- **(A) It matches by comment text.** `router-driver.ts:220` is `rules.find((r) => r.comment === LOCAL_EXCEPTION_COMMENT)` — an exact match on `'farm: local exception'`. The owner's rule says `'proxy: local exception'`. Detecting a routing rule by the prose a human typed into it is the wrong instrument entirely; the rule's *behaviour* is what matters.
- **(B) It checks existence, never coverage — and this is the dangerous one.** The obvious fix for (A) is "match on semantics instead of the comment", and that fix alone would be **worse than the bug**. The owner's rule is `src-address=192.168.50.0/24 dst-address=192.168.0.0/16 action=lookup table=main`: structurally a perfect local exception, and it protects the **server's** own lab-side addresses. Their devices are on `192.168.10.0/24`. It covers none of them. A semantic-only match would flip a false **negative** (annoying, blocks apply) into a false **positive** (silent, permits an apply that kills ADB to every device it touches — §3.2's exact failure).
- **(C) It never checks position.** Policy rules evaluate top-down and REST cannot reorder (§2, §3.2). An exception sitting *below* the device rules is inert. `RouterRuleSchema` is `.passthrough()` and the list is a `z.array()`, so both array order and RouterOS's own `.nextid` chain survive parsing — position is available and simply is not read.
- **(D) It never checks `disabled`/`inactive`.** Both fields are already parsed. The owner's router carries `comment="local exception .221"` with `disabled:true, inactive:true` — a rule that would satisfy a looser matcher and do nothing at all.

**The fix, and it must stay site-agnostic** (this plugin's whole §2 premise is *device → egress path*, never one operator's addressing):

1. **Detect by behaviour, per device, not by text.** For each device the plugin actually knows (`device.list` → `connection.address`, already available via §3.4's identity bridge), a rule protects it iff: `action == 'lookup'`, `table == 'main'`, **not** `disabled` and **not** `inactive`, its `src-address` **contains that device's address**, its `dst-address` **contains the address that device reaches the core at**, and its index is **above** any managed rule for that device.
2. **Derive "the address the device reaches the core at" rather than templating it.** Open a TCP connection from the core to the router's own REST endpoint and read `socket.localAddress` at `connect` — that is the core's source address on the path toward the router, which is by construction the same L3 path the devices sit behind. Plan 123 §0.3 established that reading this property at `connect` is accurate (reading it after close is not — the trap that plan hit first). No hardcoded subnet, works at any site. If it cannot be determined, degrade to requiring the rule to cover the RFC1918 ranges and **say which fallback was used** rather than quietly assuming.
3. **Report three states, not two.** `missing` (no candidate rule at all) / `partial` (a rule exists but leaves some devices uncovered, or sits below the device rules — **name the uncovered devices**) / `ok`. `partial` is the owner's actual situation and is the state most worth naming, because it is the one that looks safe and is not. All three block apply; only the message differs.
4. **Derive the suggested command from what is actually there.** Today the fix text hardcodes `dst-address=192.168.0.0/16` and a `<farm-subnet>` placeholder the operator has to fill in. Build it from the device addresses the plugin knows (their covering subnets) and the derived core address. For the owner's farm that yields `src-address=192.168.10.0/24 dst-address=192.168.0.0/16`, which is correct — but derived, not assumed.

*Result:* the check answers the question it was always meant to answer — *"is every device I am about to route still able to reach the controller?"* — instead of *"does a rule with this exact comment exist?"* **Tests:** the owner's real router output (7 rules, in `refs/tmp-bug-proxy-mikrotik.md`'s sibling report and the screenshot that prompted this) is a fixture: their `'proxy: local exception'` rule must be **found** (defeating A) and must still yield `partial` **naming the uncovered `192.168.10.x` devices** (defeating B); a correct-but-below-device-rules exception yields `partial` (C); the `disabled:true` `'local exception .221'` rule is never counted (D); and a genuinely correct rule yields `ok`.

**What shipped.** Four new files plus three reshaped ones, per the fix list above:

- `src/service/cidr.ts` (new) — IPv4 parsing and CIDR containment as its own pure, tested module (`ipToInt`/`intToIp`, `parseAddressSpec`, `specContains`, `specCoversBlock`, `RFC1918_BLOCKS`/`rfc1918BlockContaining`, `smallestCoveringCidr`), following `packages/studio/src/lib/ip-range.ts`'s own no-bitwise discipline (int32 overflow past `128.0.0.0`) rather than importing it — a plugin cannot cross-package-import a non-`@enkaku/*` path, and the arithmetic is small enough to own outright.
- `src/service/core-address.ts` (new) — fix 2: `deriveCoreAddress(config, deps?)` opens a bare TCP connection to the router's own REST host:port (`node:net`, no HTTP sent) and reads `socket.localAddress` inside the `'connect'` handler — the exact pattern plan 123 §0.3 established (`plugins/proxy-manager/src/service/listener.ts`'s `upstream-connected` read site) and the one this file's own header cites. `connect`/`timeoutMs` are injectable so tests never open a real socket. Every failure (connect error, timeout, no `localAddress` reported) degrades to `{ kind: 'rfc1918-fallback', reason }`, never a throw — `doctor()` cannot hang or crash on a bad network path.
- `src/service/local-exception.ts` (new) — the pure classifier, `classifyLocalException(rules, devices, coreAddress) → LocalExceptionReport`. Implements fix 1 (per-device behavioural match: `action==='lookup'`, `table==='main'`, not `disabled`/`inactive`, `src-address` contains the device, `dst-address` contains the core address) and fix 3 (`missing`/`partial`/`ok`, `partial` naming `uncoveredDevices` by label) directly; consumes fix 2's `CoreAddressResult` as a plain value (RFC1918-fallback requires a candidate's `dst-address` to cover **all three** RFC1918 blocks, since which one the core lives on is unknown); calls `buildLocalExceptionFixCommands` (fix 4) for the derived suggestion. Position (C) is enforced by comparing a candidate rule's array index against the index of the FIRST managed rule (`marker.ts`'s `parseMarker`) whose `endpointKey` equals the device's address — array order is evaluation order, per `listRules()`'s own contract (§4.1), so no `.nextid` walk is needed.
- `shared.ts` (reshaped) — `LOCAL_EXCEPTION_FIX_COMMANDS` (a static array) replaced by `buildLocalExceptionFixCommands(srcAddress, dstAddresses)`, a pure formatter the caller feeds derived values into; `LOCAL_EXCEPTION_COMMENT` kept, but re-scoped to a write-only default label for a *new* suggested rule — detection never reads it again anywhere in the codebase.
- `service/router-driver.ts` (reshaped) — `DoctorReport.localException` (the old `{ present, rule }` shape) removed; `DoctorReport.rules: RouterRule[]` added instead, so a caller with device knowledge can classify coverage without a second `listRules()` round trip. `doctor()` itself no longer does any exact-comment matching at all — reachability/auth/version/managed-and-foreign-counts only.
- `service/handlers.ts` (reshaped) — `HandlerHost` gained `farm: { call }` (the manifest already declared `device.list`/`device.get`, unused until now); the `doctor` route now composes `driver.doctor()` with `device.list` (joined through the already-built `identity-bridge.ts`, filtered to `state: 'resolved'` — a device with no derivable address is excluded from coverage, never guessed at) and `deriveCoreAddress()`, in parallel, feeding both into `classifyLocalException`. A `device.list` failure degrades to an empty device list plus an `errors` entry, never a thrown handler.
- `src/ui/parts/api.ts` / `src/ui/parts/settings.tsx` — `DoctorReportSchema`/`DoctorResult` updated to the new shape; the Settings tab's Safety check now renders three states (`Local exception OK` / `PARTIAL` / `MISSING`, three different tones and messages), names every uncovered device by label, states which path derived the core's own address (or which fallback was used and why), and shows the derived fix commands. No `src/ui/**` unit tests, per the standing owner instruction — verified by `bun run typecheck` only.

**How the core's device-facing address is derived, and the failure path.** `core-address.ts`'s `deriveCoreAddress` parses `RouterConfig.baseUrl`/`tls` into `{ host, port }` (falling back to the REST scheme's own default port, 80/443, when `baseUrl` carries none — mirroring `rest-client.ts`'s own `http`/`https` choice), opens `net.connect({ host, port })`, and reads `socket.localAddress` in the `'connect'` handler — never later, since plan 123 §0.3 proved the property is only accurate while the socket is live. A connect error, a timeout (default 3000 ms, configurable via `deps.timeoutMs` for tests), or a connected socket with no reported `localAddress` all resolve `{ kind: 'rfc1918-fallback', reason: '<what went wrong>' }` rather than throwing or hanging. `classifyLocalException` reacts to the fallback by requiring a candidate rule's `dst-address` to cover **all three** RFC1918 blocks (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`) instead of one address it could not observe, and the suggested fix commands add one `dst-address` line per block in that case. The Settings tab always states which path was used (`coreAddressCaption`).

**How CIDR containment is implemented and tested.** `cidr.ts` parses a router address field (a bare host, an implicit `/32`, or `a.b.c.d/n`) into an inclusive `{ start, end }` integer span, masking down to the block's real span even when not pre-aligned (mirroring `packages/studio/src/lib/ip-range.ts`'s own `cidrToRange`, but self-contained — a plugin cannot cross-package-import a non-`@enkaku/*` path). No bitwise operators anywhere (the same int32-overflow reasoning `ip-range.ts`'s own header gives for addresses past `128.0.0.0`) — every address is a plain `number` combined with `+`/`-`/`*`/`Math.floor`. `smallestCoveringCidr` derives the suggested `src-address` via the standard "smallest block covering `[min, max]`" construction (walk the prefix from `/32` down, take the first naturally-aligned block that reaches `max`), never a hardcoded subnet size. Tested exhaustively and independently of any router/device fixture in `src/service/cidr.test.ts` (21 tests, 46 `expect()` calls): dotted-quad parsing/round-tripping including addresses past `128.0.0.0`; bare-host vs. CIDR parsing, non-pre-aligned blocks, `/32`/`/0` edges, and rejection of address-list names / negated values / malformed prefixes; `specContains`/`specCoversBlock` including the owner's own `src=192.168.50.0/24` rule reproduced directly at the arithmetic layer (proving it does NOT cover a `192.168.10.x` device); the three RFC1918 blocks and `rfc1918BlockContaining`; and `smallestCoveringCidr` across a wide device spread (→ `/24`, the plan's own worked example), a tight cluster (→ `/29`, proving it never pads up to a "normal-looking" size), a single address (→ `/32`), an empty/unparseable list (→ `null`), and an octet-boundary crossing.

**The three-state logic.** `classifyLocalException` first collects every rule satisfying the behavioural shape (A/D: `action==='lookup'`, `table==='main'`, not disabled/inactive) AND whose `dst-address` covers the core's address (B, destination side) into `candidateIndexes`. Zero candidates ⇒ `missing` (every device named uncovered, since nothing protects anyone). One or more candidates ⇒ each device is checked individually: covered iff some candidate's `src-address` contains its address (B, source side) AND that candidate's index precedes the first managed rule for that device, if any (C). Any device left uncovered ⇒ `partial`, naming them by label in both `uncoveredDevices` and the message. Zero uncovered ⇒ `ok`. All three block apply (nothing in this build applies yet — that is 122.6); only the message and badge tone differ. Tested in `src/service/local-exception.test.ts` (16 tests, 24 `expect()` calls), including the owner's real 7-rule router output verbatim (parsed through the real `RouterRuleListSchema`, string `"true"`/`"false"` booleans and all) as its own fixture.

**Confirmed against the owner's real router fixture, end to end** (rules parsed through `RouterRuleListSchema`, three representative `192.168.10.x` devices standing in for the 40, core address `192.168.50.10` standing in for the derived lab-side address): their `'proxy: local exception'` rule (`.id: *7`) is **found** as a candidate (`report.status !== 'missing'`) — defeating defect A — and the result is **`partial`**, naming exactly `flip4-01, flip4-02, flip4-03` as uncovered — defeating defect B, the dangerous direction. The `disabled:true, inactive:true` `'local exception .221'` rule (`.id: *3`) is never counted, even for the one device (`.221`) its own `src-address` would otherwise cover — defeating defect D. The derived suggested fix is:

```
/routing rule add src-address=192.168.10.0/24 dst-address=192.168.0.0/16 \
    action=lookup table=main comment="farm: local exception"
/routing rule move [find comment="farm: local exception"] destination=0
```

— matching this step's own stated expectation exactly, and derived (from the known device addresses' bounding CIDR and the RFC1918 block containing the derived core address), not templated.

*Verification:* `cd plugins/mikrotik-routing && bun test src/service/cidr.test.ts src/service/core-address.test.ts src/service/local-exception.test.ts src/service/router-driver.test.ts src/service/handlers.test.ts src/shared.test.ts` — 82 pass, 0 fail, 182 `expect()` calls. The plugin's full existing suite (14 files, run together only as a scoped, single invocation — never the workspace-wide `bun test`) — 220 pass, 0 fail, 410 `expect()` calls. `bun run typecheck` (workspace-wide) — clean across all 18 packages.

**A note on concurrency.** `service/schemas.ts`'s `boolish` helper was independently reshaped by another session during this step (RouterOS omits a false-valued flag rather than sending `false`, discovered against the same owner router capture) — its final shape (`boolish({ absent, unreadable })`, absent-vs-unreadable no longer conflated) is exactly right for `classifyLocalException`'s own correctness: a naive "absent defaults to the cautious value" reading would have made the owner's real `.id: *7` rule (which omits `disabled` entirely) parse as `disabled: true` and vanish from candidacy, silently reintroducing a variant of defect A one layer down. Caught by re-running this step's own tests against the literal router JSON after that file settled, not by inspection; no file this step owns needed a change once it did. Nothing in `service/schemas.ts` was touched by this step.

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
5. **Path display aliases.** Paths are identified by routing-table name (`via-modem7-p12`), an operator convention. Worth letting the plugin store a display alias (`Modem 7 — Indosat`) without touching the router? Proposal: yes, but as a later, purely-cosmetic addition — it changes no behaviour and should not delay the stages above. **Raised in priority by the real farm:** 45 paths rendered as raw table names is a real legibility problem at that count, not a cosmetic one, and the same is true of the Paths tab's own list.

6. **(New, 2026-08-21) Is there a per-path capacity limit?** `proxy-manager` has `capacity`/`exclusive` per record (plan 117 §4.1); this plugin has nothing equivalent. The exclusivity invariant in §4.6 is about **groups not overlapping on a device**, which is a different question from **how many devices may share one path**. On a 40-device/45-path farm the natural intent is 1:1, and 122.13's `one-to-one` pairing enforces it *at generation time* — but nothing stops a later manual edit from putting five devices on one modem. Whether that should be refused, warned, or allowed is the owner's call about how they actually work; not assumed here.

7. **(New, 2026-08-21) Should the plugin ever manage more than one router?** The KV holds a single `router` connection (§4.9). That is right for this farm — the office router exists only so staff can reach Studio and carries no farm traffic, so the lab router is the only one with anything to manage. Recorded because the single-router assumption is currently implicit in the data model rather than stated, and a second site would meet it immediately.
