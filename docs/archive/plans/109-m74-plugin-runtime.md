# Plan 109 — M74 : A plugin can run code, listen on a port, and be reached by a device

> Status: partial — designed 2026-08-17 with the owner across one design conversation. Every decision in §3 is theirs, recorded with its reasoning and with the cost it carries. **Steps 109.1 (the one context), 109.2 (the host), 109.3 (the broker), 109.4 (listeners), 109.5 (events), 109.6 (HTTP, WS, query handlers), 109.7 (inbound webhooks) and 109.8 (logs) are implemented and tested as of 2026-08-17**; 109.9 onward is unbuilt. The author-facing name settled at `service`, not `runtime` (§9 Q7, the owner's call), so `defineRuntime` no longer exists anywhere — the vocabulary below has been updated to match the code rather than left to disagree with it. Corrections the implemented steps forced on this document are recorded in §9 as Q4–Q31 rather than silently repainted into §3/§4.
> Depends on: Plan 108 (M73) — the manifest, the `.enkaku` package, `plugin.data`, the action executor, and the Plugins page this extends.
> Deliberately does NOT depend on: the network/guest-agent layer (plans 33/43/44/51/52/54/55). The proxy case in §4.7 is an **illustration of the general problem**, never a dependency. Nothing in this plan reads `Socks5RouteConfig` or the guest agent. **Amended 2026-08-18 by plan 114 step 114.10.** This line used to add *"the owner is removing that feature temporarily"*. That removal was stated and never executed, and plan 114 §0.2 checked it against the code rather than against the sentence: the drivers are exported from the package barrel, two `kind: 'network'` descriptors are served through `GET /api/registry`, nine HTTP routes are built and mounted, both Studio surfaces render the panel, `guestAgent.provision` still defaults to `auto`, and `git log` over `packages/drivers/src/network`, `packages/core/src/api/guest-agent.ts` and `packages/core/src/device/agent-provisioner.ts` shows no removal, deprecation or disabling commit. The layer is live and plan 114 has since **extended** it with two more engines. The scope fence this line actually draws — 109 does not reach for `Socks5RouteConfig` — is unaffected and stands; only the stale aside about intent is gone.
> Spec references: §11.3 (the trust model — crash containment, never "sandbox"), §11.6 (plugins), §13 (the wire protocol), §19 (Studio screens)
> Ships: packages/core/src/plugins/runtime-host.ts

---

## 0. Evidence

The owner reduced this plan to two questions, deliberately stripped of any one use case:

> *"gimana kalau plugin perlu runtime server kaya listen suatu port? lalu gimana kalau plugin yang listen suatu port ini harus bisa diakses oleh devices di core maupun di nodes lain?"*

Everything below answers those two. A TCP bridge appears in §4.7 as a worked example only.

### 0.1 Confirmed findings — the substrate

| # | Finding | Evidence |
|---|---|---|
| **R1** | **The only long-lived processes this codebase spawns are job children.** There is no supervisor, no restart policy, and no plugin process of any kind. | `packages/session/src/runner/isolation.ts`; `packages/core/src/plugins/verify-child.ts` |
| **R2** | **`hub.broadcast` is the single fan-out point in the whole core**, and every message is already typed: `job.status`, `job.progress`, `job.artifact`, `lease.changed`, `lease.revoked`, `assist.changed`, `device.readiness`, `notification.created`, and more. | `packages/core/src/daemon.ts:335, 1057, 1121, 1163-1209, 1362, 1458` |
| **R3** | **A bounded in-memory ring + a file + a WS broadcast is the established shape** for watching something that is running, including an honest `truncated` flag. | `packages/core/src/jobs/log-buffer.ts` |
| **R4** | **Outbound webhooks exist with HMAC-SHA256 signing; inbound webhooks do not.** | `packages/core/src/notify/webhook.ts`; `api/webhooks.ts` is outbound endpoints only |
| **R5** | **A bind-test port check already exists** and is the right primitive to lend a plugin. | `packages/session/src/port-allocator.ts` (`isPortFree`) |
| **R6** | **`adb reverse` does not exist anywhere in this repo.** Every forward is host→device (`adb forward`), issued through one bounded adb CLI helper. | grep across `packages/adb`, `core`, `session`, 2026-08-17; `packages/core/src/device/host-adb.ts` |
| **R7** | **`adb forward` entries do not survive a device reconnect**, and the ui-server launcher already carries a documented re-issue path. Any reverse tunnel inherits the same lifecycle and the same fix. | `packages/drivers/src/inspector/ui-server/launcher.ts:97-99` |
| **R8** | **Core and node already share a bidirectional binary multiplexer.** `tunnel.channel.open { channelId, deviceId, kind }`, frames `[0x02][channelId u16BE][payload]`, `kind ∈ {video, audio, control-raw, shell, adb-raw}` — and `adb-raw` is already proven core→node as well as node→core. | `packages/protocol/src/tunnel.ts:95-130`; `packages/node/src/hosts.ts:27-28, 252-265` |
| **R9** | **A node already receives and runs bundles.** Its `job.dispatch` handler takes the bundle, materialises it, and runs it through its own runner. Bundle distribution to a node is an existing pattern. | `packages/node/src/hosts.ts:326` |
| **R10** | **A node is a mini-core with no control-plane state**: adb, toolchain, drivers, local sessions — no Studio, no queue/scheduler, no users, no ACL, no script storage. | `packages/node/src/index.ts:35-40` |
| **R11** | **Self-reported RSS already crosses the job IPC boundary on a timer** and the parent accumulates a peak. | plan 98 §3.5; `packages/session/src/runner/child-entry.ts:610-611` |
| **R12** | **A dependency-free SQLite is already in the runtime** (`bun:sqlite`, used by Drizzle), so a per-plugin database file costs no new dependency. | `packages/core/src/db/` |

### 0.2 Hypotheses

| # | Hypothesis | Probe |
|---|---|---|
| **H1** | `adb reverse tcp:<devicePort> tcp:<hostPort>` works on the reference hardware over **both** USB and wireless adb, and a process on the device can dial `127.0.0.1:<devicePort>`. | One command, §7. **This gates every device-reachability step in the plan.** → **PASS over USB, 2026-08-17.** Wireless **not tested** — see below. |
| **H2** | An in-process plugin handler wrapped in try/catch + a deadline survives 10 000 invocations of a deliberately-misbehaving fixture without leaking memory or handles. | A loop test against a fixture that throws, rejects, and hangs in turn. → **PASS, 2026-08-17** — numbers below. |
| **H3** | A node-side forwarder over `tunnel-stream` does not starve video frames at a realistic device count. | 10 devices streaming plus one saturated forwarder; compare frame intervals against the same run with the forwarder idle. |

**H1 result — PASS over USB, on `ZP2222RMBS` (moto_g06_power), adb 36.0.0.** `adb reverse tcp:46999 tcp:45999` listed as `UsbFfs tcp:46999 tcp:45999`; a process on the device dialled `127.0.0.1:46999`, the host listener accepted and wrote 13 bytes, and the device read all 13 back. The reverse was removed afterwards and `adb reverse --list` returned to the empty state it started in. **Steps 109.9–109.11 are unblocked on this substrate.**

**H2 result — PASS, 2026-08-17**, on the maintainer's machine (macOS arm64, Bun 1.3.14), against `runtime-host.fixture.ts`: a real plugin, bundled by `Bun.build`, staged, verified, activated, and loaded by the real host from the real content-addressed bundle cache. The handler deadline was set to 5 ms so a hang costs 5 ms rather than 30 s, and the error budget was raised past the run so the fixture kept being invoked (the budget itself is proven separately). Each figure is measured after a forced `Bun.gc(true)` on both sides, following a 300-invocation warm-up so the baseline is not first-run allocation.

| run | wall | RSS delta | heapUsed delta | open fds | counters |
|---|---|---|---|---|---|
| 10 000 × throw | 27 ms | +49.6 MB | **−0.10 MB** | 7 → 7 | 10 000 failures, 0 timeouts |
| 10 000 × reject | 26 ms | +0.2 MB | **+0.15 MB** | 7 → 7 | 10 000 failures, 0 timeouts |
| 10 000 × hang | 64.1 s | −180.6 MB | **−4.63 MB** | 7 → 7 | 10 000 failures, 10 000 timeouts |
| 10 000 × mixed (throw/reject/hang) | 21.9 s | −5.3 MB | **−0.03 MB** | 7 → 7 | 3 333 timeouts |
| 10 000 × mixed, second pass (steady state) | 21.9 s | −0.9 MB | **+0.02 MB** | 7 → 7 | 3 333 timeouts |

Over 51 500 cumulative invocations the heap is flat to within ±0.2 MB and the file-descriptor count never moves. The RSS column is the one that needs reading carefully and is recorded exactly as measured: the +49.6 MB on the first run is allocator high-water, not retention — the very next runs give it back, and the process settles at ~115 MB from a peak of ~301 MB. **RSS is not the signal here; heapUsed and fd count are.**

**The result that was not expected, and is the useful part.** 10 000 *abandoned* hung handlers retain nothing measurable (heapUsed went DOWN 4.63 MB across that run). The reason matters, because it is the difference between a design that is safe and one that got lucky: a pending promise that nothing references any more is collectable even though it will never settle. `invoke` holds the handler's promise in a local, `Promise.race` registers its reactions ON that promise, and once `invoke` returns nothing outside points at it. A design that had parked abandoned handlers in a map "so they could be reported later" would leak exactly 3 333 closures per mixed run, and the counter (`lateSettlements`) is what makes them visible instead.

**Handle leakage was probed separately, because an fd count cannot see a timer.** Each invocation arms a `setTimeout` for its deadline, and `invoke` clears it in a `finally`. A second run — 10 000 successful invocations with the deadline set to **five minutes** — is the direct test: an uncleared timer would both retain its closure and hold the event loop open. Result: heapUsed −0.19 MB, fds 7 → 7, and **the process exited on its own in 0.56 s total** with no `process.exit()` call, i.e. zero armed timers survived the loop.

**What H2 does NOT show, stated so nobody reads it as more than it is.** It says nothing about the four failures §3.2 lists as uncatchable — a synchronous infinite loop, an OOM, `process.exit()`, or a native crash still take the core down, and no loop test can demonstrate otherwise. It also does not measure a plugin that leaks on purpose (an unbounded array in module scope); in-process gives the farm no way to bound that, which is exactly why §4.2's Memory row is counters and a warn rather than a ceiling.

**Wireless is untested, deliberately.** Proving it needs `adb tcpip`, which restarts adbd on the device and drops the USB connection — a disruptive change to a live device that was serving the owner's running core. It should be run once by the owner, or on a device that is not in use. Until then the plan claims USB only.

> **The probe reported FAIL three times before it passed, and every one of those was a defect in the probe.** Recorded because anyone re-running H1 will hit the same trap and may conclude the substrate cannot do this.
>
> **`toybox nc` on Android reads nothing when its stdin is `/dev/null`.** It takes the immediate EOF and exits *before* the peer's bytes arrive — exit code 0, empty output, no error. Neither `-w` (timeout) nor `-q` (quit N seconds after stdin EOF) changes it. The dialer must hold stdin open: `sleep 3 | toybox nc 127.0.0.1 <port>`.
>
> What made this diagnosable was a **device-local control with no adb in the path at all** — one `nc` listener and one `nc` client, both on the phone. It failed identically, which located the fault in the tool rather than in the tunnel. A host-side control (the mac dialling its own listener, which worked) had already cleared the listener. Two controls, and the remaining suspect was the only thing left. Without them the honest-looking reading was "the connection arrives but no data crosses" — a plausible, specific, and completely wrong account of `adb reverse`.

---

## 1. Goals

1. **A plugin can run code for as long as it is enabled** — not only inside a job.
2. **One context, every entry point.** A script handler, an HTTP handler, a WebSocket handler, an event handler, and a query handler all reach storage, logging, and farm capabilities through the **same functions**, so a plugin's own helpers can be called from any of them.
3. **A plugin may listen on a port it chooses**, and cleans up after itself through a lifecycle hook so a reload never leaks it.
4. **A device can reach that port**, whether the device is attached to the core or to a remote node, through one call that hides the topology.
5. **A plugin can subscribe to farm events** (device connected/disconnected, and the rest of the typed set) without being able to block anything.
6. **A plugin can be reached from outside** through an inbound webhook with its own secret.
7. **Everything the runtime does is visible and controllable in Studio**: status, listeners, handlers, subscriptions, logs, start/stop/restart.
8. **A misbehaving plugin is contained as far as an in-process design allows**, and the limits of that containment are written down rather than implied.

## 2. Non-goals

- **A security sandbox.** §3.2 is explicit about what this is and is not. The word "sandbox" is not used for it, matching spec §11.3's own discipline for job isolation.
- **A separate process per plugin.** Explicitly refused by the owner for now (§3.2). `isolation: 'process'` is reserved in the manifest and documented, not built.
- **Containers.** Refused by the owner as too expensive for a self-hosted farm that cannot assume Docker.
- **Blocking hooks.** A plugin may observe an event; it may never veto, delay, or rewrite one (§3.5).
- **Triggers that start a script from an event.** Refused by the owner: an event reaches the plugin's own handler, and what the plugin does next is its own code.
- **Running plugin code on a node.** A node never loads a plugin (§3.4). It runs a generic, plugin-agnostic forwarder.
- **UDP reachability from a device.** Not possible through `adb reverse` (§3.4). A UDP listener may exist; it is host-local.

## 3. Context and design decisions

### 3.1 One context, many entry points (the owner's own framing)

> *"kan script itu didalam plugins, bisa sharing fungsi yang sama, nah pertanyaannya kan context global nya gimana... biar baik handler script atau handler query dan websocket atau api http yah sama fungsinya."*

So there is no separate script API and runtime API, and no `service.query`. There is **one `PluginContext`**, and several kinds of handler that receive it. (`service` did end up as the name of the plugin's long-lived HALF — `PluginDefinition.service`, §4.1, §9 Q7 — but it is a lifetime, not a second API: what its `setup` receives is the same `PluginContext`, widened only by the things that need a lifetime to mean anything, §9 Q9.)

```ts
// shared by EVERY handler kind
ctx.storage.device / ctx.storage.global   // KV — get/set/CAS/increment/list, Zod-validated
ctx.db                                    // optional: this plugin's own SQLite file (§3.6)
ctx.log.{debug,info,warn,error}
ctx.farm.<capability>(input)              // device.list, job.run, … — declared, gated, audited
ctx.settings                              // this plugin's own settings, schema-driven
ctx.isPortFree(port) / ctx.exposeToDevice(...)
ctx.onStop(fn)

// only in a script handler (it holds a leased device)
ctx.device, ctx.params, ctx.job, ctx.artifact, ctx.jobs
```

**The one honest asymmetry, stated rather than smoothed over:** a script handler runs in a **job child process**, per job, per device; every other handler runs in the **core process**. `storage`/`db`/`log`/`farm`/`settings` are identical across both because each already crosses a function or IPC boundary anyway. `device`/`params` cannot exist outside a job, and that is not a gap to close — a job child must remain independently killable on timeout without taking anything else with it.

Handler kinds:

| kind | declared as | receives | runs in |
|---|---|---|---|
| script | a `definePlugin` member (plan 82) | `PluginContext` + device/params/job | job child |
| http | `ctx.onRequest(name, fn)` | `PluginContext` + request | core |
| ws | `ctx.onSocket(name, fn)` | `PluginContext` + socket | core |
| event | `ctx.onEvent(type, fn)` | `PluginContext` + the event | core |
| query | `ctx.onQuery(name, fn)` | `PluginContext` + input | core |
| connection | the plugin's own `Bun.listen` handler | whatever the plugin closes over | core |

A **query** handler is what plan 108's declarative views call when the rows are not already stored in the shape the table needs — a table joining plugin storage with live farm state has no single place to read from, so something must assemble it. Plan 108's `DataSourceSchema` gains one member: `{ kind: 'handler', name }`.

### 3.2 In-process, and exactly what that costs (owner-decided)

> *"sementara runtime plugin yah jalan bersamaan, tapi dengan isolasi, try-catch handler yang benar benar harus aman."*

Accepted. Plugin code is loaded into the core process. What that buys and what it does not:

**Caught, reliably:**

| failure | mechanism |
|---|---|
| a handler throws | `try/catch` around every invocation; the plugin is charged an error, the caller gets a coded failure |
| a handler rejects | the same. A FLOATING rejection is attributed by three tiers and reported as unattributed when none of them fires — **not** by the async-context tag this row used to claim, which Bun does not support (§9 Q10) |
| a handler hangs (async) | a per-invocation deadline via `Promise.race`; the call fails, the plugin is charged |
| a bad module at load | caught; the plugin is `failed` and registers nothing (plan 82 §3.8's existing behaviour) |
| repeated failures | an error budget — N failures in a window disables the plugin's runtime and surfaces it verbatim |

**Not caught, by any amount of try/catch — and this must be in the docs, not discovered:**

| failure | consequence |
|---|---|
| a synchronous infinite loop (`while (true) {}`) | the event loop stops. **The whole farm freezes.** |
| out of memory | the core process dies |
| `process.exit()` in plugin code | the core process dies |
| a native crash inside an npm dependency | the core process dies |

This changes the *kind* of guarantee plan 82 §3.8 makes. Today it reads *"enforced structurally, not by discipline"* — because plugin code never enters the core process. In-process replaces that with discipline. Plan 82 §3.8 is amended in this plan's own step 109.12 rather than left to read as though it still holds.

**Why it is nonetheless a defensible call right now:** plugins are written by the farm operator. There is no marketplace, no third-party distribution, and no signing. The repo already takes the same position for `agent/plugins/`, which merges fail-fast in-process precisely because it is first-party code.

**The escape hatch is reserved, not built.** `isolation: 'process'` is accepted in the manifest, documented as the mode a third-party plugin will require, and rejected at verify with a clear message until it exists. Reserving the field now means adding it later is not a rewrite of every plugin's manifest.

### 3.3 Listeners belong to the plugin (owner-decided)

> *"plugin tetap punya hak untuk membuat listen portnya sendiri, urusan tabrakan yah itu urusan plugins itu sendiri."*

Accepted. The core does not allocate, bind, or own the socket. The plugin calls `Bun.listen`/`Bun.udpSocket` itself and picks its own port.

Three small things make that safe without taking ownership away:

| | what | why |
|---|---|---|
| **`ctx.onStop(fn)`** | the core calls every registered disposer before reload, disable, remove, and shutdown, then waits up to 5 s | **the one genuinely mechanical problem.** In-process, replacing a plugin's module leaves the old socket bound with no handle to close it, and the new instance then fails to bind *its own* port — the plugin is broken until the core restarts. The disposer is the plugin closing its own socket; the core only says when |
| **`ctx.isPortFree(port)`** | the bind-test that already exists (R5), lent rather than reimplemented | the plugin is responsible for collisions; it should not have to write this badly, twelve times |
| **`ctx.reportListener({ port, proto, deviceReachable })`** | pure observability — shown on the Plugins page | otherwise a port is open on the operator's machine and nothing in the product says so. Reporting is not control |

**Backstop, advisory only:** after calling the disposers, the core bind-tests each reported port. Still bound ⇒ one `warn` naming the plugin and the port, and the plugin's runtime is marked `stopping` rather than `stopped`. The core never force-closes a socket it does not own.

The port itself is an ordinary plugin setting, so an operator can change it from the schema-driven settings form plan 108 already renders.

### 3.4 Device reachability — the two-hop chain

A device is attached to exactly **one host**: the core's machine, or a node's. The plugin's listener lives on the core. So there are one or two hops, and **the platform owns both**.

```
device on the core:
  device 127.0.0.1:P  ──adb reverse──>  plugin listener on core                      (1 hop)

device on a node:
  device 127.0.0.1:P  ──adb reverse──>  node-local port  ──tunnel──>  plugin listener  (2 hops)
```

**Hop 1 — `adb reverse`.** Makes `127.0.0.1:<port>` *on the device* tunnel to a port on the host, over the adb connection that already exists. Identical for USB and wireless. Issued by **whichever host holds that device's adb connection** — the core for core devices, the node for node devices. Does not exist yet (R6) and must be added to the one bounded adb CLI helper; does not survive a reconnect (R7) and must be re-issued in the same place the ui-server's forward already is.

**Hop 2 — the existing tunnel multiplexer.** `kind` gains one member, `tunnel-stream` (R8). The node runs a **generic, plugin-agnostic forwarder**: open a local TCP listener, pipe it into a tunnel channel, and the core pipes the other end into the plugin's listener over loopback. **A node never loads plugin code** (R10 — it has no ACL, no users, no control-plane state, and giving it any would mean duplicating all three).

**What the plugin sees.** One call, and the topology is invisible:

```ts
const addr = await ctx.exposeToDevice({ port: 1080, deviceId })
// → { host: '127.0.0.1', port: 47001 }   ← valid ON THAT DEVICE
```

The platform picks the hop count, allocates the device-side port, and tears the whole chain down on device disconnect, plugin stop, plugin reload, and core shutdown. On a farm with no nodes this is always one hop, with no branch of its own — the local case is not a special case.

**Four limits, all consequences of the mechanism rather than choices:**

1. **TCP only.** `adb reverse` supports `tcp:`, `localabstract:`, `localfilesystem:` — **not UDP**. A UDP listener may exist and is host-local; nothing reaches it from a device through this chain.
2. **Hop 2 shares one socket with screencast video**, with no per-channel flow control. Fine for control-plane volumes; **not** for bulk device traffic at fleet scale. H3 measures it; the finding is recorded either way, and the future answer — shipping the handler to the node the way `job.dispatch` already ships a bundle (R9) — is named but not built.
3. **Re-issued on every reconnect** (R7), with the ui-server's existing handling as the precedent to follow.
4. **An exposed port is reachable by every app on that device**, not only the one under test — `adb reverse` opens it on the device's shared loopback. So a device-reachable listener must never be both unauthenticated and privileged. This belongs in the authoring docs, not in a plugin author's eventual incident.

### 3.5 Events: observation only

A plugin declares what it wants to hear; the runtime taps `hub.broadcast` (R2) and filters:

```ts
events: ['device.connected', 'device.disconnected', 'device.readiness', 'job.status']
```

Fire-and-forget, per-handler deadline, dropped after the error budget. **A plugin can never veto, delay, or rewrite an event** — a plugin able to gate a job start becomes load-bearing for core correctness, and one hung handler would hang every job. If a plugin needs to gate something, it owns the action, not the interception.

Delivery is best-effort by design: no replay, no queue, no ordering guarantee across types. A plugin that needs durable state reconciles from `ctx.storage` on start, which is also what makes a core restart survivable.

### 3.6 Storage: KV, plus an optional database of its own

`ctx.storage` (plan 108 §3.1) stays the default and covers key/value, per-device or global, with secrets and quotas.

For a plugin that genuinely needs SQL — ordering by value, joins, "which rows match Y" — `ctx.db` is an **opt-in, per-plugin SQLite file**:

```
<dataDir>/plugins/<name>/data.db
```

The plugin owns its schema and its migrations. This is deliberately **not** a handle to the farm database: the farm schema stays private and un-breakable, `audit.record` is not bypassed, the ACL does not become decorative, and no plugin can write `DELETE FROM devices`. Quota is a file-size cap checked on open and periodically; the file joins the existing backup archive.

Declared in the manifest (`storage: { db: true }`) so it appears in the install consent step, and absent by default.

### 3.7 Reaching a plugin from outside: HTTP and webhooks

| who | how |
|---|---|
| Studio / the browser | `ctx.onRequest` handlers mounted at `/api/plugins/:name/http/*` — the core's auth, TLS, CORS, rate limiting, and audit apply unchanged |
| an external system | `/api/plugins/:name/webhook/:id` with a **per-webhook secret** (never the operator session), HMAC-verified using the helper that already exists for outbound (R4), rate-limited, and body-validated against a schema the plugin declares |
| a device | a raw listener plus `exposeToDevice` (§3.4) — **the only case that needs a real port** |

The trap worth naming: opening a raw port to serve a UI. That bypasses every one of the protections in row 1.

---

## 4. Technical design

### 4.1 Manifest

**As built in step 109.2.** The field is `service`, not `runtime` (§9 Q7 — the owner's ruling), and the declaration and the code are ONE object rather than a manifest block plus a separate entry file (§9 Q8):

```ts
export interface PluginDefinition {
  // … plan 82 and plan 108 fields
  service?: PluginService   // = defineService({ … })
}

// @enkaku/sdk
export function defineService(input: {
  /** Exhaustive. `ctx.farm` refuses anything absent, BEFORE invoke(). Shown at install. Plain strings — there is no `CapabilityId` union (§9 Q6). */
  permissions?: string[]
  /** Reserved. The schema ACCEPTS 'process'; verify refuses it, naming it unimplemented (criterion 7). */
  isolation?: 'in-process' | 'process'
  setup: (ctx: PluginServiceContext) => void | Promise<void>
}): PluginService

// what the manifest and the wire carry — @enkaku/protocol's PluginServiceDeclarationSchema.
// The `setup` FUNCTION never crosses the verify boundary; a declaration does.
```

`listeners` and `events` arrived with the steps that consume them (109.4, 109.5) and are in the shipped shape; `webhooks` and `storage` are still absent, each waiting for 109.7 and 109.13. Declaring a field before a reader exists would let an author write a manifest the farm silently ignores — the same reason 109.1 declined to attach `service` itself before 109.2 built the host.

`PluginServiceContext` is `PluginContext` plus the service-only surface (`onStop` today; `isPortFree`/`reportListener`/`onRequest`/`onSocket`/`onEvent`/`onQuery`/`exposeToDevice` as their steps land) — see §9 Q9 for why those cannot sit on the shared `PluginContext` that §3.1's table put them in.

### 4.2 The runtime host — `plugins/runtime-host.ts`

Owns load, lifecycle, containment, and accounting.

| concern | policy |
|---|---|
| Load | on activate, and at boot for every already-active plugin — **after** the HTTP server is listening, so a bad plugin can never block boot |
| Unload | on disable, remove, reload, and shutdown: run every `onStop` disposer, wait ≤ 5 s, then unregister handlers, cancel event subscriptions, and bind-test each reported port (§3.3) |
| Every invocation | `try/catch` + a deadline (default 30 s, per-handler override, clamped) through ONE funnel, `host.invoke` — there is deliberately no second door. The deadline frees the CALLER; it does not cancel the handler, which is impossible for a promise, so the handler receives an `AbortSignal` and a late settlement is counted (`lateSettlements`) rather than pretended away. The clamp's ceiling is a constant, not yet a farm setting — §9 Q11 |
| Rejections | `process.on('unhandledRejection')`, installed on the first service load and removed on the last unload. Attribution is three tiers — a `WeakMap` of promises the host itself handed out (exact), a non-enumerable stamp on every error the core rejects a plugin's own port with, which survives arbitrary `.then()` hops (exact), and the plugin's own bundle path in the reason's stack, accepted only when exactly ONE loaded plugin matches (heuristic, and reported as such). Anything else is **unattributed**: logged verbatim with the loaded plugins named, charged to nobody, and rethrown so the core dies exactly as it would with no handler installed. **Not** `AsyncLocalStorage` — §9 Q10 records the measurement that ruled it out |
| Error budget | 20 handler failures in 60 s ⇒ the runtime is disabled, marked `failed` with the last error verbatim, and stops receiving events and calls. Loud and finite, never a silent loop |
| Memory | RSS is process-wide in-process, so there is **no per-plugin ceiling**. Instead: per-plugin counters (invocations, failures, open sockets, event deliveries) and a warn when a plugin's own reported listener count or storage size crosses a threshold. Stated as the honest substitute it is |
| Status | `stopped \| starting \| running \| failed \| stopping` — and `starting` is never worded as `running`, per `docs/design.md`'s own rule about degraded states. As built the distinction is *enforced*, not merely displayed: `running` is set only after `setup` RESOLVES, and a call into a `starting` service is refused with its own code (`E_PLUGIN_RUNTIME_STARTING`, distinct from `E_PLUGIN_RUNTIME_NOT_RUNNING`) rather than queued. `stopping` is also real rather than transitional: a disposer that has not finished inside the 5 s budget leaves the service `stopping`, because the host does not know whether the plugin let go |

### 4.3 The capability broker — `plugins/farm-broker.ts`

**As built in step 109.3.** `ctx.farm.call(id, input, schema)` is checked twice: against the manifest's declared `permissions`, then by the real `invoke()` against the real ACL, with a `CapabilityContext` bound to a **plugin principal** (`plugin:<name>`, role resolved live from the plugin's publisher — §9 Q14).

```
ctx.farm.call(id, input)
  ├─ 0. FarmCallSchema                    ── bad ─→ E_BAD_INPUT          ┐
  ├─ 1a. is this an active plugin?        ── no ──→ E_FARM_NO_PLUGIN     │ audited as `plugin.capability`,
  ├─ 1b. is `id` in ITS manifest?         ── no ──→ E_FARM_UNDECLARED    │ invoke() never entered
  ├─ 2.  does `id` exist in the registry? ── no ──→ E_FARM_UNKNOWN_CAPABILITY ┘
  └─ 3. invoke(cap, ctx as plugin:<name>, input)   → the real ACL, grant, lease, readiness, deadline
                                                    …and the ONE `capability.invoke` audit row
```

Step 1b happening **before** `invoke()` is criterion 10's load-bearing half: an undeclared `device.app.clear` must not clear an app and then be reported as refused. It also sits upstream of `invoke`'s own input parse, deliberately — an undeclared capability called with garbage reads UNDECLARED, because the manifest is the more useful thing to be told about.

**Exactly one audit row per call, and which one it is** (§9 Q12): a refusal the broker made itself is `plugin.capability` (userId `plugin:<name>`, target the capability id, meta carrying what the manifest DID declare at that moment, never the input); an accepted call is the one `capability.invoke` row `invoke()` writes, under the same principal. Both are reachable with one query on `audit_log.user_id`, and plan 63 acceptance #7 — every capability invocation is in the log under `capability.invoke` — keeps holding.

No `Db`, no `KvStore` object, no capability registry — and, as of this step, no `CapabilityContext`, audit logger or broker — is reachable from plugin code: asserted by a graph walk over the context object's own shape, with a table-driven control that every fingerprint matches a real object, and a negative control that the walk finds them when they genuinely are reachable (§9 Q15).

**It is not a sandbox** (§2, §3.2; spec §11.3). The broker narrows what a plugin reaches *through `ctx`*; the plugin shares the core's process and OS authority and can reach around it. What the gate buys is that a declared list means something, and that everything taken through the pleasant path is answerable later.

### 4.4 Device reachability — `plugins/device-expose.ts`

```ts
exposeToDevice(opts: { port: number; deviceId: string; ttlSec?: number }): Promise<{ host: string; port: number }>
revokeFromDevice(opts: { port: number; deviceId: string }): Promise<void>
```

- Resolves the device's host (core or node) from the device registry.
- **Core-attached:** `hostAdb.reverse(serial, devicePort, pluginPort)`.
- **Node-attached:** open a `tunnel-stream` channel, ask the node to bind a local port and pipe it, then `adb reverse` on the node to that local port.
- Device-side port allocated from `ENKAKU_DEVICE_REVERSE_PORT_RANGE` (default `47000–47199`), per device.
- Torn down on: `revokeFromDevice`, device disconnect, plugin stop/reload, core shutdown, TTL expiry.
- Re-issued on device reconnect, hooked in the same place the ui-server's forward already is (R7).

### 4.5 Logs — `plugins/runtime-logs.ts`

R3's shape, keyed on plugin name: a ring (2 000 lines, honest `truncated`), a `plugin.log` WS message, and a rotated file at `<dataDir>/plugins/<name>/runtime.log` (2 × 5 MiB). `GET /api/plugins/:name/runtime/logs?cursor=` gives the fetch-then-subscribe shape every live surface in Studio uses (the `/ws` protocol has no snapshot replay). Redaction reuses the same `kv.redact` the job logger applies, keyed on the plugin's namespace.

### 4.6 REST and WS

| Method + path | Permission | Purpose |
|---|---|---|
| `GET /api/plugins/:name/runtime` | `script.view` | `{ status, since, restarts, lastError, listeners, handlers, events, counters }` |
| `POST /api/plugins/:name/runtime/{start,stop,restart}` | **`plugin.runtime`** (new, operator) | |
| `GET /api/plugins/:name/runtime/logs` | `script.view` | ring + `truncated` + cursor |
| `GET/POST /api/plugins/:name/http/*` | per the handler's declared permission | `ctx.onRequest` handlers |
| `GET /api/plugins/:name/query/:name` | `plugin.data` | `ctx.onQuery` — what plan 108's `{ kind: 'handler' }` data source calls |
| `POST /api/plugins/:name/webhook/:id` | **per-webhook secret**, no session | HMAC-verified, rate-limited, schema-validated |
| `WS /api/plugins/:name/socket/:name` | per the handler's declared permission | `ctx.onSocket` |

WS: `plugin.log` and `plugin.runtime.status` in `packages/protocol/src/messages/plugin.ts` (new) — never a hardcoded string outside the protocol package.

### 4.7 Worked example — a TCP bridge (illustration only)

A plugin that terminates connections from devices and forwards them somewhere else. It exercises every mechanism in this plan and depends on none of the network layer:

```ts
export default definePlugin({
  id: 'bridge',
  version: '1.0.0',
  scripts: [ /* … */ ],
  service: defineService({ permissions: ['device.list'], setup: async (ctx) => {
  const port = ctx.settings.port ?? 1080
  if (!(await ctx.isPortFree(port))) throw new Error(`port ${port} is already in use`)

  const server = Bun.listen({ hostname: '127.0.0.1', port, socket: { /* … */ } })
  ctx.onStop(() => server.stop(true))
  ctx.reportListener({ id: 'bridge', port, proto: 'tcp', deviceReachable: true })

  ctx.onEvent('device.connected', async (e) => {
    const addr = await ctx.exposeToDevice({ port, deviceId: e.deviceId })
    await ctx.storage.device.set('bridge', addr, { deviceId: e.deviceId })
    ctx.log.info(`bridge reachable on ${e.deviceId} at ${addr.host}:${addr.port}`)
  })

  ctx.onQuery('status', async () => /* rows for the plugin's own view */)
  } }),
})
```

Plan 108's view renders `{ kind: 'handler', name: 'status' }`, and the operator sees the listener, the per-device addresses, the logs, and Start/Stop — all from mechanisms in this plan, none from a proxy-specific feature.

### 4.8 Files

```
packages/protocol/src/
  messages/plugin.ts            NEW — plugin.log, plugin.runtime.status
  tunnel.ts                     + 'tunnel-stream' channel kind
  plugin-surface.ts             + { kind: 'handler', name } data source (plan 108's vocabulary)
packages/protocol/src/
  plugin-service.ts             NEW (109.2) — PluginServiceDeclarationSchema, the isolation refusal, the status vocabulary
                                + (109.4) PluginListenerSchema / ReportedListenerSchema and the UDP-reachability refusal
                                + (109.5) PluginEventTypeSchema, `events`
  index.ts                      + (109.5) SERVER_MESSAGE_TYPES, derived from ServerMessageSchema; unknownPluginEventTypesMessage
packages/session/src/
  port-allocator.ts             + (109.4) `isPortFree` exported (R5), with a `udp` mode
packages/core/src/
  plugins/runtime-events.ts     NEW (109.5) — the filter and the DETACHMENT; containment stays in runtime-host.ts
  plugins/runtime-service.test.ts NEW (109.4/109.5) — criteria 8, 9, 12, 17, each absence claim with its two controls
  plugins/runtime-host.bundle.ts NEW (109.4) — the fixture bundled ONCE per test process; two top-level Bun.build
                                calls on one entrypoint make the second test file fail with a bogus EISDIR
  server/ws.ts                  + (109.5) WsHub.addObserver — the tap, called after every send, never awaited
packages/sdk/src/
  runtime.ts                    109.1/109.2 — PluginContext, PluginServiceContext, defineService(), isService()
  index.ts                      + defineService / isService
  plugin.ts                     + PluginDefinition.service
packages/core/src/
  plugins/runtime-host.ts       NEW (109.2) — load/unload, try/catch+deadline, error budget, rejection attribution, counters, status
  plugins/runtime-host.fixture.ts       NEW (109.2) — the deliberately-misbehaving plugin, bundled and really installed by the test
  plugins/runtime-host.rejection-child.ts NEW (109.2) — criterion 4's proof, in a child process (§9 Q10: `bun test` never calls an unhandledRejection listener)
  plugins/verify-child{,-entry}.ts + the service declaration, and the isolation refusal (criterion 7)
  plugins/runtime.ts            + manifest persistence of `service`, `service(name)`, and `onLifecycle`
  plugins/plugin-context.ts     109.1 — the CORE's port bindings; the one BUILDER is @enkaku/session's (§9 Q4)
  plugins/farm-broker.ts        NEW (109.3) — declared-permission gate → invoke() → audit; also `createFarmRunnerPort`, the job child's parent side
  auth/audit.ts                 + `plugin.capability` — the action for a refusal the BROKER made itself (§9 Q12)
  plugins/device-expose.ts      NEW — exposeToDevice/revoke, hop selection, reconnect re-issue
  plugins/plugin-db.ts          NEW — the opt-in per-plugin SQLite file, quota, backup registration
  plugins/runtime-logs.ts       NEW — ring + rotation + WS
  plugins/webhook-routes.ts     NEW — per-webhook secret, HMAC, rate limit, schema
  device/host-adb.ts            + reverse() / reverseRemove()
  tunnel/plugin-stream.ts       NEW — core side of the tunnel-stream channel
  api/plugins.ts                + the runtime routes
  auth/acl.ts                   + plugin.runtime (OPERATOR)
  daemon.ts                     + build the host; load after HTTP is listening; unload on shutdown
packages/node/src/
  plugin-forward.ts             NEW — generic port forwarder over tunnel-stream. NO plugin code.
  hosts.ts                      + the tunnel-stream case
packages/studio/src/
  components/plugin-view/RuntimePanel.tsx  NEW — status, listeners, handlers, events, counters, Start/Stop/Restart
  components/plugin-view/RuntimeLogs.tsx   NEW — fetch-then-subscribe log view
  app/plugins/page.tsx                     + a runtime column; the install consent step gains
                                             permissions, events, listeners, and storage
```

---

## 5. Implementation steps

**109.1 — `defineService` and the context.** *(done — the helper shipped as `defineRuntime` and was renamed by 109.2; §9 Q7.)* `sdk/src/runtime.ts`; `plugins/plugin-context.ts` as the ONE builder, shared with the script path so `storage`/`log`/`farm` are literally the same code. *Result:* a plugin helper can be called from a script handler and an HTTP handler unchanged.

**109.2 — The host.** *(done.)* `runtime-host.ts` with every policy in §4.2; load after HTTP is listening; unload on shutdown. *Result:* a fixture that throws, rejects, and hangs is contained, charged, and finally disabled by the budget — with the core still serving `/api/health` (H2).

**109.3 — The broker.** *(done.)* `farm-broker.ts`; declared permissions enforced at both ends; audit rows; a test asserting no `Db`/`KvStore`/registry is reachable from `ctx`. *Result:* `ctx.farm` is live on both hosts — the service's, through `RuntimeHostDeps.farm`, and a member script's, through `createFarmRunnerPort` on `JobRunnerDeps.farm` — reaching ONE broker, checked against ONE manifest, audited under ONE principal. "Refused before `invoke()`" is proven twice: every capability in the test records whether its handler ran, and `invoke()`'s own audit row (written on every path it takes, its `E_BAD_INPUT` included) is an independent witness that the function was never entered. See §9 Q12–Q15 for the four things this step found wrong.

**109.4 — Listeners.** *(done.)* `ctx.isPortFree`, `ctx.reportListener`, `ctx.onStop` with the 5 s wait and the advisory bind-test backstop; `listeners` added to the manifest declaration. *Result:* a fixture binds a fixed port, is reloaded twice in a row, and the port is still bindable — asserted against a real `Bun.listen`, not a bookkeeping entry. See §9 Q17–Q20 for what this step found wrong.

**109.5 — Events.** *(done.)* `WsHub.addObserver` as the tap, filtered by declared types, dispatched on a fresh macrotask, per-handler deadline, charged to the error budget. **`device.connected`/`device.disconnected` were NOT added: the fan-out already carries them under another name** — `device.status`, plus `device.added`/`device.removed` (§9 Q16). *Result:* a handler that throws, hangs, or burns 150 ms synchronously delays a broadcast by nothing measurable, proven against a control that shows the same measurement catching a 150 ms delay when one exists.

**109.6 — HTTP, WS, query handlers.** *(done.)* The three route families; plan 108's `{ kind: 'handler' }` data source and its failed-runtime `ErrorState` path (a view whose handler is down names the plugin and offers Restart — never an empty table, never an unresolved spinner). *Result:* `ctx.onRequest`/`ctx.onSocket`/`ctx.onQuery` register through one registry (`service-handlers.ts`), are reached through one resolver whose refusal ORDER is the feature (`service-routes.ts` — status before handler, so a stopped service is never reported as a missing screen), and run through the SAME `host.invoke` funnel as `setup` and an event delivery. See §9 Q23–Q31 for the nine things this step found wrong, including a live false report in the route-parity guard itself.

**109.7 — Webhooks.** *(done.)* `plugin_webhooks` (a farm-held secret, write-only, **no hint column** — §9 Q32/Q37), `ctx.onWebhook` against a DECLARED list, `webhook-routes.ts` (a per-webhook rate limiter, the constant-time HMAC check through R4's own `verifyWebhookSignature`, the declared body schema through the one `validateAgainstSchema`), `POST /:name/webhook/:id` exempted from the session in `auth/middleware.ts`, and `ctx.webhooks.{list,secret,rotate}`. *Result:* a third party with no farm account reaches a plugin handler by proving it holds a secret the farm generated; a bad or missing signature never reaches the handler; and the secret rotates — with a bounded overlap window by default and an immediate revoke on request — without republishing, re-verifying, re-activating or reloading anything. See §9 Q32–Q41 for the ten things this step and 109.8 found wrong.

**109.8 — Logs.** *(done, except the farm-level route, which is 109.12's for Q23's reason — §9 Q38.)* `runtime-logs.ts`: R3's ring (2 000 lines, honest `truncated`, and a `truncated` that is also reported **per reader** when a cursor fell off the back), a rotated file at `<dataDir>/plugins/<name>/runtime.log` (2 × 5 MiB, and the rotation **writes its own banner** so a reader learns what was dropped), the `plugin.log` broadcast, and redaction through the same `buildSecretRedactor` the job logger uses **plus** the webhook secrets that live outside KV. Every line carries an optional `subject`, lifted from `fields.subject`, and the page filter is server-side — so plan 112's "logs all, logs per proxy" is a predicate over one ring rather than a second stream. `ctx.logs.page()` is the read half.

**109.9 — `adb reverse` (gated on H1).** `hostAdb.reverse()`/`reverseRemove()`; re-issue on reconnect where the ui-server's forward already is; removal on disconnect and at boot cleanup. **If H1 fails, stop here** and record that device reachability is not available on this substrate — a real answer, not a workaround.

**109.10 — `exposeToDevice`, one hop.** Core-attached devices only. Device-side port range, TTL, teardown on every path in §4.4.

**109.11 — `exposeToDevice`, two hops.** `tunnel-stream` channel kind; `packages/node/src/plugin-forward.ts`; the core side. Measure H3 and record the number whether or not it is comfortable.

**109.12 — Studio, and the honesty edits.** `RuntimePanel`, `RuntimeLogs`, the runtime column, and the widened install consent step. Extend plan 108's route-parity test to the runtime routes. Amend **plan 82 §3.8** to say the guarantee is now held by discipline rather than structure, and say why. `docs/spec.md` §11.6/§12/§13/§19; `docs/design.md` gains the runtime status vocabulary with the `starting ≠ running` rule.

**109.13 — `ctx.db` (optional).** The per-plugin SQLite file, quota, backup registration, and the manifest flag. Sequenced last so it can be dropped without disturbing anything above it.

---

## 6. Acceptance criteria

1. A plugin declaring no `runtime` behaves byte-identically to plan 108.
2. A plugin helper function calling `ctx.storage`/`ctx.log`/`ctx.farm` works unchanged from a script handler and from an HTTP handler — asserted by a fixture that exports one function and is called from both.
3. A handler that throws, rejects, or exceeds its deadline is contained: the caller gets a coded failure, the plugin is charged, and no other plugin or job is affected.
4. A floating promise rejection inside plugin code is attributed to that plugin, not merely logged.
5. The error budget disables a misbehaving plugin's runtime and surfaces the last error verbatim; it never retries forever.
6. `docs/spec.md` and the authoring docs state, in plain words, that a synchronous infinite loop, an OOM, `process.exit()`, or a native crash in plugin code **takes the core down**, and that this is the cost of in-process execution.
7. `isolation: 'process'` is accepted by the manifest schema and refused at verify with a message naming it as unimplemented.
8. `ctx.onStop` disposers run before reload, disable, remove, and shutdown; after two consecutive reloads the plugin's own port is still bindable.
9. A plugin that fails to release a reported port produces one `warn` naming the plugin and the port, and status `stopping` — the core never force-closes a socket it does not own.
10. `ctx.farm` refuses any capability absent from the manifest **before** `invoke()` is called; every accepted call writes one audit row.
11. No `Db`, `KvStore`, or capability registry is reachable from `ctx` — asserted over the context object's own shape.
12. An event handler cannot veto, delay, or modify an event: a handler that throws or hangs changes nothing about the broadcast, proven by asserting the event still reached every other subscriber and the core's own path.
13. A webhook request with a bad or missing signature is refused; a valid one reaches the handler; the secret can be rotated without reinstalling the plugin.
14. `exposeToDevice` returns an address a process on the device can actually dial, for a **core-attached** device (H1).
15. `exposeToDevice` returns a working address for a **node-attached** device, with no plugin code loaded on the node — asserted by grepping the node's module graph.
16. The chain is torn down on revoke, device disconnect, plugin stop, plugin reload, and core shutdown, and re-issued after a device reconnect without operator action.
17. A UDP listener is accepted but `deviceReachable: true` on it fails verification, naming `adb reverse`'s TCP-only limit.
18. H3's measurement is recorded in this plan whether or not the result is comfortable.
19. Status, listeners, handlers, event subscriptions, counters, logs, Start/Stop/Restart are all reachable in Studio; the route-parity test extended from plan 108 passes.
20. The install consent step lists declared permissions, events, listeners, and whether the plugin gets its own database file.
21. A view whose `{ kind: 'handler' }` data source targets a stopped runtime renders an error naming the plugin with a Restart affordance.
22. Plan 82 §3.8 is amended in the same commit that lands in-process loading.
23. `bun run typecheck`, `bun test`, `bun run --cwd packages/studio test` green; `bash scripts/check-plan-status.sh` exits 0.

## 7. Test plan

**Unit** — `plugin-context.test.ts` (one context, every kind; the absent surfaces are genuinely absent); `farm-broker.test.ts` (declared vs undeclared, audit contents); `device-expose.test.ts` (hop selection from the device registry, port allocation, teardown on all five paths, TCP-only refusal).

**Core integration** — `runtime-host.test.ts` (a real fixture that throws/rejects/hangs; the budget; two reloads with no port leak; 10 000 invocations with no handle growth — H2); `runtime-boot.integration.test.ts` (**the test plan 82 never wrote**: a real `createDaemon().start()` with a deliberately-broken plugin present, asserting `/api/health` answers and every other plugin still registers); `webhook-routes.test.ts`; `api/plugins-runtime.test.ts` (every route and its permission split).

**Node** — `plugin-forward.test.ts` (bytes round-trip over a fake tunnel; the module graph contains no plugin code).

**Studio** — `RuntimePanel.test.tsx`, `RuntimeLogs.test.tsx` (all four states, live append, `truncated` shown), `app/plugins/page.test.tsx` (runtime column, widened consent step).

**Manual smoke — H1, the probe that gates §3.4**
```bash
# reference device, USB first, then over `adb connect <ip>:5555`
adb reverse tcp:11080 tcp:11080
python3 -m http.server 11080 &
adb shell curl -s -m 3 http://127.0.0.1:11080/ | head -1     # expect a response
adb reverse --remove tcp:11080 ; kill %1
```

**Manual smoke — the bridge fixture**
```bash
bun run dev ; bun run dev:studio
bun run --cwd packages/sdk dev plugins/bridge-example/src/index.ts --farm http://localhost:7700
# → Plugins page: runtime `running`, one listener, one event subscription
# → connect a device → the log line names its reachable address
# → Stop → the port is free (`ctx.isPortFree` in a scratch script confirms)
ps -Ao pid=,command= | grep -i "[o]penpf"
```

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| **In-process means one bad plugin can freeze or kill the farm** (§3.2). | Cannot be mitigated away — it is inherent to the owner's chosen model. Mitigated by: being written down in the spec and the authoring docs (criterion 6), the error budget, and `isolation: 'process'` reserved so the escape hatch is a build rather than a redesign. |
| **H1 fails and `adb reverse` does not work.** | Probed in 109.9 before any exposure code exists. A failure stops the reachability steps; everything from 109.1 to 109.8 still ships and is still useful. |
| A reverse tunnel dies on reconnect and a plugin keeps reporting the last good address. | Re-issue is built in the same step as the tunnel, in the same place the ui-server's forward already handles it; criterion 16 tests a real reconnect. |
| Hop 2 starves video. | H3 measures it and the number is recorded either way; the honest guidance ("control-plane volumes, not bulk") ships with the API's own doc comment, not only in this plan. |
| An exposed port is reachable by every app on the device. | Documented in authoring guidance and repeated in the `exposeToDevice` doc comment — the two places a plugin author will actually look. |
| A plugin's declared permission list grows until it is effectively admin. | Shown at install and on the Plugins page; capabilities are individually gated by the real ACL, so a declared permission the operator does not hold is refused at call time regardless of the manifest. |
| `ctx.db` becomes a second, divergent storage story. | Opt-in, declared, shown at install, sequenced last (109.13), and documented as the exception for genuine query needs — `ctx.storage` stays the default in every example. |
| The node forwarder quietly becomes a place plugin code creeps into. | Criterion 15 asserts it by grepping the node's module graph, not by review. |

## 9. Open questions

**Q1 — Does the core already broadcast `device.connected`/`device.disconnected`, or only `device.readiness` and the registry's own transitions?**
Step 109.5 assumes typed connect/disconnect events exist or can be added cheaply at the same `hub.broadcast` call sites. If the closest existing signal is `device.readiness`, the plugin-facing vocabulary should say `readiness` rather than invent a connect/disconnect that does not map onto anything real — the same discipline the network layer's own `unverified` follows. Needs one look at the registry's transition points before 109.5 is written.

**Q2 — Should a plugin's HTTP handler be able to declare that it needs NO authentication?**
Some integrations want an unauthenticated read (a health endpoint, a metrics scrape). Allowing it means a plugin can open an unauthenticated route on a farm whose bind address implies TLS-and-auth. **Recommendation: no for v1** — the webhook path with a secret already covers the legitimate case, and an unauthenticated route is a hole an operator cannot see. Worth confirming, because it is easier to allow later than to withdraw.

**Q3 — What is the per-plugin `ctx.db` size cap, and what happens at the limit?**
A hard refusal on write is honest but can wedge a plugin mid-operation; a warn-only cap means an unbounded file. **Recommendation: warn at 80%, refuse writes at 100%, and surface both on the Plugins page** — the same shape the workspace quota already uses. Only relevant if 109.13 is built at all.

---

### Corrections found while building step 109.1 (2026-08-17)

These four are not open design questions in the usual sense — three were settled by the code refusing to be written any other way, and are recorded here because §3/§4 still read as though they had not been. The fourth genuinely needs the owner.

**Q4 — `plugins/plugin-context.ts` cannot be the ONE builder, and §4.8 puts it in the wrong package.**
The two hosts are the job CHILD process (`packages/session/src/runner/child-entry.ts`) and the core. `packages/core` depends on `@enkaku/session`; `@enkaku/session` must never depend on `@enkaku/core`. So a builder living in `packages/core` is structurally unreachable from the child, and criterion 2 could only have been met by writing the context twice — the exact thing the criterion exists to prevent. `@enkaku/sdk` cannot host it either: `ctx.storage`'s client (`createKvApiFor`) and the `KvCall` wire schema both live in `@enkaku/session`, and moving them would split a Zod schema from the type it generates.

**Resolved as built:** `buildPluginContext` lives in `packages/session/src/plugin-context.ts` and is the single assembler; `packages/core/src/plugins/plugin-context.ts` is the core's port bindings and its single door onto it, not a second builder. `ScriptContext` now **extends** `PluginContext` (`packages/sdk/src/runtime.ts`), so "a helper works from both" is a compiler guarantee rather than a convention. §4.8's file list should be corrected when this plan is next revised.

**Q5 — `ctx.storage.device` cannot mean the same thing from both ends, and §4.7's `{ deviceId }` option does not survive contact with `KvApi`.**
§4.7 sketches `ctx.storage.device.set('bridge', addr, { deviceId })`. The shipped `KvApi` (plan 79) has no options object on `get(key, schema)`, `getRaw(key)` or `increment(key, by)` — so on exactly the calls a plugin reads its own per-device state with, that option would have been silently ignored.

**Resolved as built:** `PluginStorage` is `{ global, device, forDevice(deviceId) }`. `device` is the context's *ambient* device — a script's own job device; a core handler built without one refuses every call with `E_NO_DEVICE_SCOPE` naming `forDevice` as the fix, rather than quietly reading the farm scope. `forDevice(id)` is the accessor that means the same thing from both ends, and on the script side it refuses any device but the job's own (`E_FOREIGN_DEVICE_SCOPE`), which is what keeps plan 108 §3.1 G4 true now that a script can name a device at all.

**Q6 — `ctx.farm.<capability>(input)` is not writable as declared.**
Capability ids are dotted (`device.list`, `job.run`), so they cannot be property names; and §4.1's `CapabilityId[]` type does not exist anywhere in the workspace — capability ids are plain strings (`packages/core/src/capability/registry.ts`). A property per capability would have had to be a `Proxy`, which also defeats criterion 11's assertion *over the context object's own shape* and turns an undeclared capability into `TypeError: x is not a function` instead of a coded refusal.

**Resolved as built:** `ctx.farm.call(id, input, schema)` and `ctx.farm.callRaw(id, input?)` — deliberately mirroring `KvApi`'s own `get`/`getRaw` split, so the caller validates the farm's output against its OWN schema at the boundary. The transport for the script side landed with it (`farm.call`/`farm.result` on the child⇄parent IPC, `FarmRunnerDeps` on the runner, refusing `E_FARM_UNAVAILABLE` while unwired — the same optional-port shape `kv`/`jobs` already use). The gate itself is still 109.3's.

**Q7 — `PluginDefinition.runtime` collides with plan 98's `runtime`, and needs a ruling before 109.2 attaches it.**
§4.1 hangs a `runtime` block off `PluginDefinition`. A plugin MEMBER already has a `runtime` (plan 98's `RuntimeEnvelope`: `timeoutMs`, `retries`, `maxRssBytes`, `maxConcurrent`) — a restriction a script places on its own execution. The new one is a long-lived process entry point. Two adjacent authoring types, one word, two unrelated meanings, and an author will read the wrong doc comment.

Step 109.1 declared the shape (`PluginRuntimeDeclaration`, `packages/sdk/src/runtime.ts`, with `isolation` reserved and documented per criterion 7) but deliberately did **not** attach it to `PluginDefinition`: attaching a field before the host that reads it exists would let an author write a manifest the farm silently ignores. **109.2 must attach it, and should take the naming decision with the owner at the same time** — `service`, `host`, or keeping `runtime` and accepting the collision.


---

### Corrections found while building step 109.2 (2026-08-17)

**Q7 is settled: the author-facing name is `service`.** The owner's ruling, taken before anything depended on the old one. `defineService`, `PluginServiceDeclaration`, `PluginDefinition.service`; 109.1's `defineRuntime`/`PluginRuntimeDeclaration`/`isRuntime` are gone, not aliased. Two `runtime` keys nested one level apart, meaning entirely different things, is a permanent ambiguity in a **published** type surface, and the rename cost one pass. It also removes a THIRD collision nobody had noticed: `packages/core/src/plugins/runtime.ts` already exports an interface called `PluginRuntime` — the plugin *management* service (stage/verify/activate) — so 109.1's SDK type of the same name would have made `import { PluginRuntime }` mean two unrelated things depending on which package it came from. The internal file name (`runtime-host.ts`) and the operator-facing words ("runtime status", "the plugin runtime") are kept: there is no second meaning of "runtime" in either place to confuse.

**Q8 — §4.1's `entry: 'runtime'` cannot exist. The declaration and the code are one object.**
§4.1 hangs a manifest block off `PluginDefinition` that names a SEPARATE entry file the host would load. Nothing in the shipped pipeline can do that: verification imports exactly one bundle per plugin (`verify-child.ts`), a plugin ships as one `scripts.mjs` (spec §11.6), and a second entry would mean a second bundle, a second verify, and two live module instances of the same plugin with two copies of its module state. **Resolved as built:** `defineService({ permissions, isolation, setup })` returns one branded object, `PluginDefinition.service` holds it, and the verify child reports the *declaration* (never the `setup` function, which cannot and must not cross an IPC boundary) for the parent to re-validate and persist into `plugins.manifest`. A whole failure class goes with it: a manifest cannot declare permissions the entry does not have, because there is only one place to write them.

**Q9 — §3.1's shared block cannot hold `onStop`, `isPortFree` or `exposeToDevice`.**
§3.1's table lists them under "shared by EVERY handler kind". They are not shareable: a script handler runs in a job CHILD process, which has no service to stop and cannot register a socket in the core's process, so putting them on `PluginContext` would force the child to supply ports that mean nothing and would give a script author three members that always fail. **Resolved as built:** `PluginServiceContext extends PluginContext` carries them, exactly mirroring how `ScriptContext extends PluginContext` carries `device`/`params`/`job`. Criterion 2 is unaffected and is arguably strengthened — a helper is typed against `PluginContext`, the genuinely shared part, and accepts either end by compiler check.

**Q10 — §4.2's rejection mechanism does not exist on this runtime, and criterion 4's test cannot run inside `bun test`.** *(This is the correction that cost the most and matters the most.)*
§4.2 and §3.2 both specify attribution as "`process.on('unhandledRejection')` with an `AsyncLocalStorage` plugin tag". Measured on Bun 1.3.14 (macOS arm64, 2026-08-17), before anything was built on it:

- `AsyncLocalStorage.getStore()` inside an `unhandledRejection` handler returns `undefined` in **every** case tried — a rejection created synchronously inside `als.run`, one created after an `await` inside it, one created in a `setTimeout` scheduled from inside it, one whose promise was created inside it and rejected outside, and one created with no context at all. Five for five.
- `async_hooks.createHook({ init })` — the other way to bind a promise to the context that created it — is a **no-op** in Bun: zero `init` callbacks fire, for promises or for anything else.

So the plan's stated mechanism was unavailable, and the criterion explicitly forbids replacing it with a guess. **Resolved as built:** three tiers, each reporting *how* it decided, plus a fourth outcome that is a real answer — `owned-promise` (a `WeakMap` of promises the host itself handed to plugin code; exact), `tagged-reason` (a non-enumerable stamp on every error the core rejects a plugin's own port with, which rides the reason through arbitrary `.then()` hops where a promise-keyed map cannot; exact), `module-stack` (the plugin's own content-addressed bundle path in an `Error`'s stack, accepted only when exactly ONE loaded plugin matches; a heuristic, and surfaced as `lastRejection.how` so an operator can see which tier decided), and **unattributed** — logged verbatim with the loaded plugins named, charged to nobody. The deliberate refusal: when exactly one service is loaded it is tempting to blame it, and that is a guess dressed as a finding. The known gap, verified rather than assumed: a rejection whose reason is not an `Error` (`Promise.reject('a string')` from inside plugin code) has no stack and no stamp and is unattributable.

Two consequences that are not obvious:

1. **Installing the handler at all changes global behaviour.** With no handler, Bun prints an unhandled rejection and **exits 1** (measured). A handler that swallowed everything would silently convert every CORE bug into a shrug. So the host installs the handler only while at least one service is loaded, removes it when the last one unloads, and **rethrows** anything it could not attribute — restoring exactly the behaviour the core had before any plugin existed. A farm with no plugin service is byte-identical to one built before this plan (criterion 1).
2. **`bun test` never calls an `unhandledRejection` listener.** The runner owns that hook: a floating rejection inside a test is reported by the runner and fails the test, and a listener that only increments a counter never increments it (measured with a two-line probe). §7's "Core integration" line assumed this could be tested in-process; it cannot. Criterion 4 is proven instead by `runtime-host.rejection-child.ts` — a real Bun process with a real host, a real plugin row and the real fixture bundle — spawned by the test, which asserts on the JSON it prints and on its exit code. That also makes the rethrow path testable, which it could never be in-process: the case that should kill the process is asserted by observing that it did.

**Q11 — the invocation deadline's clamp cannot be a farm setting yet, and the reason is a Studio test.**
§4.2 says the per-handler deadline is "clamped by a farm setting". Adding one means a new top-level key on `FarmSettingsSchema` — and `packages/studio/src/components/settings/farmSections.test.ts` asserts that **every** top-level key of that schema is claimed by exactly one Studio section (plan 96 item 96.4, which exists precisely because eight schema-backed keys had gone unreachable from Studio). A protocol-only addition therefore fails a Studio test, correctly. The two belong in one commit and that commit is 109.12's. Until then the ceiling is a constant (`MAX_INVOCATION_TIMEOUT_MS`, 300 s) with a per-host override, which is the shape `daemon.ts` will pass the setting through when it exists. Worth generalising: **on this repo, a `FarmSettingsSchema` key and its Studio section are one change, never two.**

---

### Corrections found while building step 109.3 (2026-08-17)

**Q12 — §4.3's "every call is audited as `plugin.capability`" and criterion 10's "exactly one audit row" cannot both be satisfied the obvious way.**
Writing a `plugin.capability` row for an ACCEPTED call means either two rows (criterion 10 fails) or suppressing `invoke()`'s own row. The second is worse than it looks: `capability.invoke` is defined in `auth/audit.ts` as *"Every capability invocation, refusals included (plan 63 §3.4 step 7, acceptance #7) — one action for the whole registry"*, so a plugin path that opted out would put a plugin-shaped hole in the one query that is supposed to be complete, and nothing in this plan noticed that it was proposing one.

**Resolved as built:** `plugin.capability` is the action for a refusal **the broker itself made** — one that never reached `invoke()` and therefore has no row of its own. An accepted call gets exactly one row, `capability.invoke`, written by `invoke()` under the same `plugin:<name>` principal, with the capability as `target`. So: one row per call on every path, the plugin dimension is still a single query (`audit_log.user_id = 'plugin:<name>'` returns both actions), and a refusal is *more* legible than before rather than less — "show me every plugin that reached for something undeclared" is one action rather than a scan of every `E_FORBIDDEN` on the farm. A refusal records what the manifest declared **at that moment** (a manifest changes on reload) and never the input (a capability input can carry a secret — the rule `kv.set` and `command.run` already state).

**Q13 — 109.1's `namespace` on `FarmRunnerDeps` made its own stated plan structurally impossible.**
Step 109.1 gave the job child's farm port a `namespace`, resolved as `pluginId ?? scriptId ?? jobId` — copied from `kv.call`, where that fallback is correct, because a standalone script legitimately owns a KV namespace. Its comment said *"the core side refuses those rather than inventing a principal (step 109.3's job)"*. The core side cannot: once the fallback has been applied, "plugin `foo`" and "standalone script `foo`" are the same string, so the broker would have checked a standalone script against a same-named plugin's manifest — the one thing the sentence was written to prevent.

**Resolved as built:** the field is `pluginId`, not `namespace`, so the type itself cannot carry the fallback; `job-runner.ts` refuses `E_FARM_NO_PLUGIN` at the call site, which is the last place `meta.pluginId` is still distinguishable from absent; and the broker keeps its own `E_FARM_NO_PLUGIN` for every other caller. Generalisable: **`kv`'s namespace and `farm`'s principal are not the same identifier**, and a port that reuses one for the other inherits a fallback it must not have.

**Q14 — the plugin principal needs a ROLE, and §4.3 names only an id.**
`CapabilityActor` is `{ id, role }` and `invoke`'s permission check is `can(actor.role, cap.permission)`, so "bound to a plugin principal (`plugin:<name>`)" left the only question that changes behaviour unanswered. A fixed `'operator'` is the tempting answer and is wrong in a specific way: it puts `device.files`, `device.shell`, `kv.manage` and `job.cancel.any` permanently out of reach of every plugin on every farm, with no way to grant them short of editing core — and an operator-published plugin would fail at a call its own manifest declared, with no fix available to the operator.

**Resolved as built:** the role is the plugin's PUBLISHER's (`plugins.created_by` → that user's role), resolved **live on every call**, so demoting them narrows their plugin at once — the discipline plan 67 §3.4 established for an agent run, and plan 65 §3.5's "never wider than its owner's own set" applied to plugins. An unknown, absent or deleted publisher resolves to `'operator'`, the narrower of the two, never the wider. It is also the reading plan 109 §8's own risk row already assumed: *"a declared permission the operator does not hold is refused at call time regardless of the manifest."*

The uncomfortable half, stated rather than buried: on a farm whose plugins were published by an admin — and on any farm in `local` auth mode, where the one implicit user is an admin — this hands those plugins admin authority over the capability surface. That is a real widening. It is still narrower than the truth of in-process loading, where a plugin already holds the core's process and can open the farm database directly; the broker was never the thing standing between a plugin and the farm, and a design that pretended otherwise would be the actual danger.

**Q15 — criterion 11's most important fingerprint was invented, and could never have fired.**
109.1's graph-walk test fingerprinted "a capability registry" as an object with `list`, `get` and `ids`. The real `CapabilityRegistry` is `{ all, get, visibleTo }` (`capability/registry.ts`), and nothing in the workspace has the first shape — so the row named in the criterion's own title was asserted against a shape that does not exist. The test's control paragraph exists precisely to stop a vacuous pass, and it controlled the other two rows (`KvStore`, `Db`) but not this one, which is exactly where an unchecked fingerprint hides.

**Resolved as built:** the row is the real shape; three more were added for what the broker introduces (`CapabilityContext`, the audit logger, and the broker object itself); and the control is now **table-driven** — every entry in `FORBIDDEN` must be matched by a real object the harness built, asserted key-for-key, so adding an invented fingerprint fails the control instead of silently weakening the walk. A second, negative control asserts the walk **does** find those objects when they genuinely are reachable, which is the half no amount of fingerprint correctness can give you. Worth generalising: **a test that proves an absence needs two controls — that the thing it looks for is real, and that it would be seen if it were there.**

**Known gap left open by 109.3, reported rather than discovered later: `ctx.farm` is unavailable to a plugin being iterated in a DEV SLOT.** *(Unchanged by 109.4/109.5, and now slightly wider: a dev slot's service is not loaded at all, so its listeners and event subscriptions do not exist either.)* The broker reads `plugins.active(name)` and `plugins.service(name)`, both of which answer for the ACTIVE row only — a dev slot shadows the active row for tier-B assets (plan 111 §4.4) but not for a service declaration — so a dev-slot script's farm call is refused `E_FARM_NO_PLUGIN`. It is inherited from 109.2, whose host does not load a dev slot's service either, and closing it needs a decision this step had no mandate to take: what a dev slot's declared permissions *mean*, given they are an unpublished manifest nobody consented to at install. It belongs with 109.12's Studio work (the install consent step is the other half of the same question) or with a deliberate ruling from the owner.

---

### Corrections found while building steps 109.4 and 109.5 (2026-08-17)

**Q16 — R2 is two claims, one of them wrong, and the wrong half is what step 109.5's own condition turned on.** *(The finding that changed the most.)*

R2 says *"`hub.broadcast` is the single fan-out point in the whole core"*. It is the single **broadcast** point — verified, and it is what makes one `addObserver` the entire event surface. It is **not** the single fan-out point. Device events (`device.event`, carrying `device.online` / `device.offline`) never touch it: `EventRecorder.publish` (`events/recorder.ts`) hands them to `handler.publishEvent`, which sends only to connections that subscribed with `log.subscribe` (`ws-handlers.ts`, `state.logSubs`). A subscriber-scoped unicast is not a broadcast, and a plugin tapping `hub.broadcast` never sees one. R2's line numbers are also stale (`daemon.ts:335` is now 345, and there are ~45 call sites, not six).

That matters because step 109.5 said *"`device.connected`/`device.disconnected` are added as typed events **if the fan-out does not already carry them under another name**"*, and §9 Q1 asked the same question and left it for this step. **The answer is that they already exist, under a name `hub.broadcast` really does carry:**

| what the plan wanted | what the core actually broadcasts |
|---|---|
| `device.connected` | **`device.status`** with `payload.status !== 'offline'` — the device state machine's `DEVICE_CONNECTED` transition, `daemon.ts`'s `broadcastDeviceStatus` |
| `device.disconnected` | **`device.status`** with `payload.status === 'offline'` |
| a device joining/leaving the farm | `device.added` / `device.removed` |
| the per-device audit trail of the same fact | `device.event` kind `device.online`/`device.offline` — **not** on `hub.broadcast`, see above |

So nothing was added. Adding a second pair of names for a fact `device.status` already carries would have been the exact mistake Q1 was written to prevent, and it would have meant a plugin and Studio watching two different messages for one transition. The refusal message names the real ones (`unknownPluginEventTypesMessage`), because an author who writes `device.connected` deserves to be told what to write instead rather than that their manifest is invalid.

**The event vocabulary is therefore `ServerMessage['type']`, derived from the union rather than restated.** `SERVER_MESSAGE_TYPES` is read off `ServerMessageSchema` through an ordinary `safeParse` of the union object's own shape — no cast, and no hand-maintained list to go stale the first time somebody appends to a file whose comments say it is appended to constantly. The manifest schema accepts any dotted lowercase token and **verify** refuses the ones this build cannot deliver, the same accept-then-refuse split `isolation` already uses, so a plugin published against a newer core stays parseable rather than becoming unreadable.

**Q17 — §3.3's "waits up to 5 s" and §4.2's "wait ≤ 5 s" are ONE budget, and the bind test is outside it.**
The plan states the number twice, in two sections, without saying whether a plugin with four disposers gets 5 s or 20. Decided and recorded in `DISPOSER_TIMEOUT_MS`'s own doc comment: **five seconds for the whole teardown**, shared, measured from the first disposer. Per-disposer would make the worst case unbounded in a number the plugin chooses, and what the budget exists to bound is how long an operator waits for Disable to return. The advisory bind test runs **after** that budget and is not charged to it — it is the core's own check, and a slow bind test reported as "the plugin failed to let go" would be a lie about whose fault it is.

**Q18 — `defineService`'s input type was the schema's OUTPUT type, and the bug only becomes visible once a default is nested.**
109.2 wrote `PluginServiceInput extends Partial<PluginServiceDeclaration>`. `Partial` only reaches the top level, and every default in the schema was top-level at the time, so it worked by coincidence. The moment `listeners[]` arrived — with `proto` and `deviceReachable` defaulted *inside* an array element — an author was forced to write out both values on every listener, i.e. to supply by hand exactly what the schema exists to supply. **Resolved as built:** `Partial<z.input<typeof PluginServiceDeclarationSchema>>`. Generalisable, and it will bite again: **an authoring type is the schema's `z.input`, never its inferred output** — the two are the same shape only while every default is top-level.

**Q19 — §3.3's "the port itself is an ordinary plugin setting" cannot be built: there is no `ctx.settings`.** *(Reported, not worked around — plan 112 already filed it.)*
§3.1's table lists `ctx.settings` and §4.7's worked example opens with `const port = ctx.settings.port ?? 1080`. Nothing in the workspace provides it, and this step deliberately did not invent one: a settings mechanism is a schema, a persisted store, a Studio form and an install-consent line, which is a plan and not a paragraph inside another step. What 109.4 does instead is make the port genuinely the plugin's own — `ctx.reportListener` takes whatever port the plugin bound, and the manifest's `listeners[].port` is explicitly advisory. When `ctx.settings` lands, nothing here changes shape; the plugin reads the port from a different place and reports the same thing.

**Q20 — criterion 17 says "fails verification", which requires a DECLARED listener; §3.3 says the plugin owns its port, which sounds like the opposite. Both are satisfiable, and the resolution is worth stating.**
A manifest cannot fail verification over something that only exists at run time, so criterion 17 forces `listeners` into the declaration — which reads, at first, like the core taking ownership back from §3.3. It does not, because a declaration and a reservation are different things. **What is declared is the SHAPE** (`id`, `proto`, `deviceReachable`, a description, and an advisory `port`): the fact the operator consents to at install, *"this plugin opens a TCP port that devices are meant to dial."* **What is reported is the FACT** (`ctx.reportListener`, `port` mandatory): what the plugin actually bound. The core allocates nothing, reserves nothing, and arbitrates nothing between two plugins that pick the same port — that stays the plugin's problem, exactly as the owner ruled.

One schema (`PluginListenerSchema`) serves both boundaries, so the install consent step and the Plugins page cannot disagree, and the one refusal — `{ proto: 'udp', deviceReachable: true }` — fires in all three places an author can hit it: `defineService` on their own machine, verify on the farm, and `ctx.reportListener` at run time. The refusal is about the CLAIM and never the socket: a plugin that catches it keeps its UDP listener and keeps running.

**Q21 — TypeScript cannot check a `(event: Extract<ServerMessage, { type: T }>) => …` handler against an implementation, and the honest fix is a type guard rather than a cast.**
`ctx.onEvent('device.status', (e) => e.payload.status)` is the ergonomics worth having, and it needs `Extract`. But no implementation satisfies that signature: TypeScript will not narrow a discriminated union against a value of *generic* literal type, so `if (event.type !== type) return; handler(event)` fails inside the generic body, and a non-generic implementation fails to be assignable to it. Measured four ways (bare `Extract`, a mapped `{ [K in M as K['type']]: K }` event map, a non-generic implementation, and an intersection) — all four rejected. **Resolved as built:** `isFarmEventOfType(event, type): event is Extract<ServerMessage, { type: T }>`, a user-defined type guard exported from `@enkaku/sdk`, whose body is that one comparison. It compiles, it is a real runtime check (a routing bug delivers nothing rather than the wrong shape), and it puts the unprovable step in one named, documented function instead of in an `as` somebody later reads as noise.

**Q22 — the file R5 points at did not export the thing R5 says to lend.** `isPortFree` was a module-private function in `packages/session/src/port-allocator.ts`. Exported, with a doc comment stating what a loopback bind test can and cannot see (a listener on another interface is invisible to it; the answer is a snapshot, never a reservation), and given a `udp` mode — `Bun.udpSocket` refuses a second bind with `EADDRINUSE`, measured — so the unload backstop can bind-test a UDP listener too.

**One design decision worth recording because the plan does not contain it: how dispatch is detached.**
`WsHub.broadcast` calls its observers *after* every `ws.send`, ignores their return values, and wraps each in a `try`/`catch` — so an observer cannot veto or modify, and cannot break the broadcast by throwing. That leaves "delay", which the obvious implementation loses: if the tap calls a handler inline, the handler's synchronous prefix runs inside the broadcast's own frame. So `runtime-events.ts` defers dispatch to a **fresh macrotask** (`setTimeout(fn, 0)`), not a microtask — a microtask still runs in the same tick, ahead of the broadcaster's own continuation. One timer per broadcast, only when something is subscribed to that type; an event nobody wants costs one `Map.get`.

The test measures *timing*, not delivery, and carries the two controls §9 Q15 asks for: control 1, that the blocking handler is real (it is entered, and it really burns its 150 ms); control 2, that the same measurement catches a delay when one exists — asserted twice, once with an inline `WsHub` observer and once by swapping only `scheduleEvent` for `(fn) => fn()` and watching the identical fixture push the same measurement past 140 ms. The remaining hole is stated rather than papered over: a handler that blocks the event loop synchronously stops everything, and nothing in a single process can prevent it (§3.2).

---

### Corrections found while building step 109.6 (2026-08-17)

**Q23 — §4.6's `/:name/runtime` block is four routes, and exactly one of them could ship in this step.**
§4.6 lists `GET /:name/runtime` and `POST /:name/runtime/{start,stop,restart}` alongside the three handler families. Only `restart` was built, and the constraint that decided it is plan 108's route-parity guard (`api/plugins-route-parity.test.ts`), which fails on any registered route with no call site in `packages/studio/src` and explicitly refuses *"nobody has built the UI yet"* as an excuse. `GET /:name/runtime`, `start` and `stop` are the RuntimePanel's, and the RuntimePanel is 109.12's — registering them now would have meant either a red guard or an opt-out entry that was a lie.

The useful half of the finding is that **the failed-service UI does not need `GET /:name/runtime` at all**, which was not obvious when §4.6 was written. The query route's own refusal already carries the state — one code per state (`E_PLUGIN_RUNTIME_STARTING`, `_NOT_RUNNING`, `_NOT_LOADED`, `_DISABLED`) — so criterion 21's error state branches on the error it already has, rather than making a second request to find out why the first failed. A status panel is a convenience; it was never a dependency.

**Q24 — `/:name/http/*` promises a path space; `ctx.onRequest(name, fn)` names a HANDLER. Both are satisfiable, and the split has to be written down.**
§3.1's table spells the registration `ctx.onRequest(name, fn)` — a name, not a path — while §4.6 spells the route `GET/POST /api/plugins/:name/http/*`. Read literally the two disagree about what the `*` addresses. **Resolved as built:** the route is `/:name/http/:path{.+}` and the FIRST segment selects the handler; whatever follows is handed to it as `request.path` (`'/'` when there is none). So `ctx.onRequest('reports', …)` answers `/http/reports` and `/http/reports/2026/q1`, and a plugin gets a path space under its own name without the core arbitrating one.

One registration serves all five methods (`app.on([...PLUGIN_HTTP_METHODS], …)`) because the methods a handler answers are the handler's own declaration, checked after the lookup. That has a consequence for the parity guard — see Q28.

**Q25 — "per the handler's declared permission" leaves the two questions that decide behaviour unanswered: what the DEFAULT is, and what happens to a name that is not real.**
§4.6's permission column says only *"per the handler's declared permission"*. **Resolved as built:** the default is `script.view` — the permission that already had to be true for an operator to open the plugin's screen, which is what an HTTP handler overwhelmingly backs — and an unknown name is refused **at registration** with `E_PLUGIN_PERMISSION_UNKNOWN`, naming it. Defaulting past a typo would gate the route on something the author did not mean; accepting it would produce a route nobody on the farm can reach, discovered months later as a 403 naming a permission that does not exist. A WIDER permission than the default is accepted without comment: `permission: 'kv.manage'` narrows a handler to admins, which is a reasonable thing for a plugin to want.

This also settles **§9 Q2 as built: there is no way to say "no authentication"** — not a rejected value, but no value at all. The query family's permission is fixed at `plugin.data` and is not the plugin's to choose, because it sits beside `GET /:name/data` and `/data/scan` and answers the same question about the same data.

**Q26 — a handler is REGISTERED, not declared, and the order the route asks its questions in is criterion 21's load-bearing half.** *(The finding that changed the most.)*
`permissions`, `listeners` and `events` are manifest fields: they exist before the plugin runs and the operator consented to them at install. A handler is none of those things — it comes into being when `setup` calls `ctx.onRequest`, and it is gone the moment the service unloads. **So a stopped service has no handlers at all.**

The obvious implementation looks the handler up and 404s when it is missing. That answers *"this plugin declares no such screen"* — a claim about the MANIFEST, and a false one — for a plugin whose service merely stopped. Studio would then tell an operator their screen no longer exists, when the truth is a service they can restart in one click. The order is therefore fixed in one place (`plugins/service-routes.ts`) and shared by all three families:

| # | question | refusal |
|---|---|---|
| 1 | is a plugin of this name live? | `plugin_not_found` (404) |
| 2 | live only as a DEV SLOT? | `E_PLUGIN_DEV_SLOT_NO_SERVICE` (409) |
| 3 | does it declare a service? | `E_PLUGIN_NO_SERVICE` (409) |
| 4 | is that service running? | `E_PLUGIN_RUNTIME_*` (503), one code per state |
| 5 | is there a handler by this id? | `E_PLUGIN_HANDLER_NOT_FOUND` (404) |
| 6 | may this caller reach it? | `auth.forbidden` (403) |

Generalisable: **when a lookup can only succeed in one state, ask about the state first** — otherwise the absence of the thing gets reported as the reason for it.

**Q27 — 109.3's audit design leaves the plugin rows with no way back to the human, and this step is where that became visible.**
Everything a plugin does through `ctx.farm` is audited as `plugin:<name>` under its publisher's role (§4.3, Q14) — correct, and it must stay that way: invoking a handler does not lend a plugin the caller's authority. But once a browser can invoke a handler, "plugin `foo` enqueued a job" has an operator behind it that nothing in the log names. **Resolved as built:** `plugin.http` and `plugin.socket` audit actions, written under the REAL caller with `target` = `<plugin>/<handlerId>`, so one query on `target` answers *who set this off* and one on `user_id` answers *what the plugin then did*.

Audited on **every** method, `GET` included, and that is deliberate: the farm cannot know whether a plugin's handler mutates — `GET /http/wipe` is legal plugin code — so filtering by method would be a guess dressed as a policy. The query family is NOT audited, for the opposite and equally deliberate reason: it is the read path, `GET /:name/data` and `/data/scan` are silent, and auditing it would make a table's own refresh loop the loudest thing in the log. The residual is stated rather than hidden — a query handler is still plugin code and could mutate; what makes that visible is `capability.invoke`, which does not care which handler was running.

**Q28 — the route-parity guard could not see `app.on(...)`, and it was already reporting two things falsely before this step touched it.**
Two separate defects, both found by extending it as instructed rather than tripping it:

1. **`app.on([methods], path)` was invisible.** The extractor matched only `app.get|post|put|delete|patch(`. This step registers the five HTTP methods through Hono's multi-method form, so a fifth of the new plugin surface would have been unreportable — the guard would have gone quietly vacuous exactly where it was needed. Fixed by reading `PLUGIN_HTTP_METHODS` from `@enkaku/protocol` rather than re-listing it, with its own control asserting the extractor returns those five and that a hand-written literal array still parses.
2. **A trailing-slash URL was mis-shaped, and the guard was RED in the working tree before this step began.** `lib/plugin-host.ts` (plan 111) builds `` `${base}/api/plugins/${name}/ui/` `` as a PREFIX and concatenates each asset path onto it. The segment regex stops at the trailing slash, so the call shaped as `/api/plugins/:x/ui` — which does not match `GET /:name/ui/:path{.+}` (its `**` needs one more segment) and DOES match the catch-all `GET /:name/:version` two registrations later. Both halves of the report were wrong at once: `/ui/**` read as unreachable when Studio plainly reaches it, and `GET /:name/:version` read as "excused but in fact called" when nothing calls it. A trailing slash now shapes as `**`, which is what the source means.

The `/:name/http/*` family is the one genuine `NOT_IN_STUDIO_BY_DESIGN` entry this step adds, and the reason is structural rather than temporal: Studio cannot call it — it does not know a plugin's handler ids and has no request to make of them — because its caller is the plugin's own tier-C React view, which ships inside `plugins/<name>/ui/` and is outside `packages/studio/src` by construction. The two service routes Studio DOES call (`GET /:name/query/:queryId`, `POST /:name/runtime/restart`) are not excused and have real call sites.

The WS family is invisible to the guard for a different reason and is covered by its own test instead: a WebSocket upgrade needs the raw `Request` and the `Bun.serve` instance, which a Hono handler does not have, so it is wired in `daemon.ts`. What is asserted there is that the path comes from `@enkaku/protocol` (`pluginSocketPath`/`parsePluginSocketPath`, never a literal), that `daemon.ts` really branches on it, and that `api/plugins.ts` registers no `/socket/` route of its own.

**Q29 — the dev-slot gap widens a third time, and is now refused BY NAME.**
109.3 reported it for `ctx.farm`; 109.4/109.5 widened it to listeners and events. With handlers it becomes operator-visible: a dev slot IS live for `requireLivePlugin`, so `/draft/query/rows` would have reached the handler lookup and answered a bare 404 that reads like a typo in the URL. **Resolved as built:** `E_PLUGIN_DEV_SLOT_NO_SERVICE` (409) on all three families and on Restart, with a message that names the gap, says why it exists (the host and the broker answer for the ACTIVE row, and a dev slot is an unpublished manifest nobody consented to at install), and gives the action — publish and activate. Studio shows that message and deliberately offers **no** Restart, because there is nothing loaded to restart and a button that cannot help is worse than no button. The decision the gap needs is still the owner's or 109.12's; what changed is that an author now hits a sentence instead of a 404.

**Q30 — a `{ kind: 'handler' }` view with no `service` had to be refused at VERIFY, or criterion 21's error state stops meaning anything.**
`ctx.onQuery` is registered by `defineService({ setup })` and exists nowhere else, so a surface naming a handler source on a plugin with no service could never have rendered. Left to fail at request time it would render as *"the service is not running, press Restart"* — sending an operator to press a button that cannot help, for an authoring mistake only the author can fix. **Resolved as built:** `handlerViewsWithoutServiceMessage` (`plugin-surface.ts`) and `E_PLUGIN_HANDLER_NO_SERVICE` at verify, naming the offending view ids — the same accept-then-refuse split `isolation` and the event vocabulary already use. Criterion 21's state is now reserved for a genuine outage.

**Q31 — what a plugin HTTP/WS handler may see of the caller, which §4.6 never says.**
It sees **identity** — `{ id, role }` — and never a **credential**: no session cookie, no `Authorization`, no WS ticket, no `x-forwarded-*`. Request headers are an ALLOWLIST (`content-type`, `accept`, `accept-language`, `user-agent`) and response headers are one too, with `set-cookie` and `access-control-*` absent from it.

The reasoning is not that a plugin is untrusted with authority — it runs in the core's process, holds the core's OS authority, and can open the farm database directly (§3.2, §4.3: *it is not a sandbox*, and a design that pretended the header filter was a security boundary would be the actual danger). It is that **a bearer credential is the one kind of authority that can leave the process**: written to `ctx.storage`, printed by `ctx.log`, posted to a webhook, replayed tomorrow from another machine as that operator. Identity cannot. `set-cookie` is the same argument in the other direction — a plugin able to set a cookie on the farm's own origin could overwrite the session cookie the core authenticates with.

And identity is not delegation. A handler invoked by an admin is still `plugin:<name>` with its publisher's role when it calls `ctx.farm`, checked against its own manifest (Q14). `caller.role` is "who is looking at this screen", never permission to do something the farm would otherwise refuse the plugin.

**One design decision worth recording because the plan does not contain it: a plugin socket is not the farm's `/ws`, and the two are wired one line apart on purpose.**
`WsHub` carries the farm's typed `ServerMessage` broadcast; `ctx.onEvent` (109.5) is a read-only tap on it that cannot veto, delay or answer. `ctx.onSocket` is neither: a private, bidirectional connection at `/api/plugins/:name/socket/:id` between one browser and one plugin handler, carrying whatever bytes the plugin writes, with no envelope, no `WsHub`, no observer list. Conflating them is how a plugin would end up able to write into the farm's broadcast — the exact thing criterion 12 forbids — so the test asserts the absence with two controls: that the plugin really did write to its socket, and that what it wrote is not parseable as a `ServerMessage` at all.

Three smaller decisions the code had to take, recorded so they are not rediscovered: the permission is checked **before** the upgrade (a browser cannot tell a socket that closes immediately from a network blip, and would retry forever); frames arriving before an `async` handler has returned its callbacks are **queued**, bounded at 32, and flushed in order (dropping them would make a plugin's own first-message protocol nondeterministic, and buffering without bound would let a peer grow the core's heap); and a handler that throws closes **that one socket** with 1011, leaving every other connection and the service itself untouched.

**§4.8's file list, as actually built by this step.** No `messages/plugin.ts` — this step adds no WS message type, because a plugin socket carries no envelope (`plugin.log` and `plugin.runtime.status` remain 109.8's and 109.12's). What it adds is `packages/core/src/plugins/service-handlers.ts` (the registry and the permission resolution), `service-routes.ts` (the refusal order and the two runners), `service-socket.ts` (the WS half), the routes themselves in `api/plugins.ts` (registered there so the parity guard can see them), `plugin.runtime` in `auth/acl.ts`, `plugin.http`/`plugin.socket`/`plugin.runtime` in `auth/audit.ts`, and three Studio files — `components/plugin-view/data.ts` (the `handler` branch), `rows.ts` (`rowsFromQuery`), and `ViewRenderer.tsx` (the failed-service state and Restart).

---

### Corrections found while building steps 109.7 and 109.8 (2026-08-17)

**Q32 — §4.5's "redaction reuses the same `kv.redact` the job logger applies" names a wrapper that cannot be reused, and the redactor underneath it is blind to the one secret THIS PLAN generates.** *(The finding that changed the most.)*

Three separate things were wrong in one sentence.

1. **There is no `kv.redact` to reuse.** What the job logger reaches is `KvRunnerPort.redact` (`kv/runner-port.ts`), whose signature is `({ deviceId, namespace }, text)` — it resolves a **job's device** to a `stableId` and scans the global scope plus that device's. A plugin service has no device (§9 Q5), so that function cannot be called at all. What is genuinely shared is one level down: `buildSecretRedactor(store, scopes, namespace)` in `kv/store.ts`. Both logs now run through that same function, which is what makes "one vocabulary" true rather than asserted.
2. **It only sees KV.** `buildSecretRedactor` enumerates secret KV entries. A webhook secret (109.7) deliberately does not live in KV — see Q37 — so **the one secret the farm minted itself would have been the one secret a plugin could print**, in a step whose deliverable is redaction. Closed by an `extraSecrets(pluginId)` port that hands the log store the plugin's webhook plaintexts, redacted as `«redacted:webhook:<id>»`.
3. **Per-line is the wrong cost here.** The job logger builds a redactor per line: a `list()` plus one AES-GCM decrypt per secret. A job logs at human pace; a plugin service can log per connection (plan 112's proxy manager is the first, and its `accepted`/`closed` lines are the point). Memoised for 5 s, with the cost stated in the code and asserted by a test — *a secret written inside the window is not redacted until it expires* — and with an invalidation hook the farm calls when it mints or rotates a webhook secret, because that is the one creation event the farm itself can see.

The scope is **global only**, stated rather than left to be discovered: a service has no ambient device, and scanning every device's scope for every log line is unbounded work. A device-scoped secret is not redacted from a service log line.

And the honest ceiling, which is now in `runtime-logs.ts`'s own header and in `ctx.log`'s doc comment rather than only here: it is a **substring replace over values it can enumerate**. It cannot see a secret split across two lines, one under 8 characters (`buildSecretRedactor`'s own false-positive rule), one that was never stored, or another plugin's. Each of those is asserted as a real gap, with a control showing the redactor did run.

**Q33 — `plugin.log` widens the plugin EVENT vocabulary, and the widening is an unbounded loop.**

§4.6 asks for `plugin.log` on `ServerMessageSchema`. Step 109.5 derives the plugin event vocabulary **from that union** (`SERVER_MESSAGE_TYPES`, §9 Q16 — deliberately, so no hand-maintained list can go stale). Those two facts compose into something neither step contemplated: adding the message silently makes `plugin.log` a legal `defineService({ events })` entry, and a plugin subscribed to its own log lines whose handler logs anything — directly, or through any helper that does — is fed its own output back forever, inside the core's process, **with nothing failing for the error budget to notice**. Neither the per-handler deadline nor the failure counter can see it; nothing is slow and nothing throws.

**Resolved as built:** `PLUGIN_EVENT_TYPE_DENYLIST` and `refusedPluginEventTypesMessage`, refused at verify (`E_PLUGIN_EVENT_REFUSED`, its own code — the type is *real*, so `unknownPluginEventTypesMessage` would have accepted it) and again in `ctx.onEvent`, because the manifest is a persisted JSON column and the one loop the farm cannot survive is not worth trusting to a single gate. A denylist rather than a rule ("no event a plugin can cause"): a plugin can cause `job.status` too, and reacting to a job it started terminates. What makes `plugin.log` different is that the reaction's own *observation* is the feedback.

Generalisable, and it will bite again: **deriving a vocabulary from a union means every message anyone adds to that union is a subscription they granted.**

**Q34 — a webhook is DECLARED, which is the exact opposite of Q26's ruling for handlers, and both are right.**

Q26 established that a handler is *registered, never declared*, and that a stopped service therefore has none — which is why the route asks about the state before the handler. A webhook cannot work that way, and the reason is worth stating because it looks like an inconsistency:

| what | declared or registered | why |
|---|---|---|
| the **secret** | declared (its existence follows from the manifest) | it must verify, and be **rotatable**, while the service is stopped, reloading or `failed` — which is exactly when an operator is most likely to be rotating it |
| the **envelope** — body schema, size cap, rate limit, freshness window | declared | so a stopped service's URL is still rate-limited and still size-capped. Registered, they would vanish the moment the plugin stopped, and "stop the plugin" would be the cheapest way to remove every guard on a public URL |
| the **handler** | registered | it is code; it goes with the service, exactly as Q26 says |

It is also the one plugin-facing door reachable by someone with **no farm session at all**, so the operator has to be shown it at install rather than find it in an access log.

**Q35 — §3.7's "the core's auth, TLS, CORS, rate limiting and audit apply unchanged" is four-fifths true: this core has no HTTP rate limiter.**

The only limiter in the workspace is `createNotifyRateLimiter` — per agent, for outbound notifications. Row 1 of §3.7's table does not need one (it is behind a session and an ACL), but row 2 is the one place the claim mattered, and it was not there to inherit.

**Built here, and keyed per WEBHOOK rather than per caller.** That is not a shortcut: the core has no identity for an inbound sender before the signature verifies, and the only pre-verification signal is the peer address — which behind the reverse proxy an operator is told to put in front of a server-mode farm is the proxy's, identical for every caller, while `x-forwarded-for` is forgeable and is dropped with every other header outside the allowlist. A limiter keyed on a value that is either constant or forgeable lets everyone through or nobody. Per webhook bounds the thing that actually needs bounding: how much HMAC work, how many audit rows, and how many signature guesses one URL can cause per minute. **Refusals count against the same budget** — that is what makes it a defence rather than a fairness policy, and it is asserted.

**Q36 — the refusal order needs a question 0, and everything before it has to collapse into one answer.**

Q26's order is reused literally — `requireRunningService` and `requireHandler` were extracted from `resolvePluginHandler` so there is still exactly one place it is written, and a signed delivery to a stopped service answers `E_PLUGIN_RUNTIME_NOT_RUNNING` (503) rather than a 404 that would blame the manifest. But an unauthenticated caller cannot be given those answers: `plugin_not_found` and `E_PLUGIN_DEV_SLOT_NO_SERVICE` are useful to an operator and a **plugin-name oracle** to a stranger.

So the signature is asked first, and every refusal before it is the same 404 with the same body — an unknown plugin, an undeclared webhook, and a declared webhook whose secret has never been generated are indistinguishable, asserted byte-for-byte. Only a caller that has proven it holds the secret gets the real state, which is also the only caller that can do anything with it. Two more consequences fell out: an unauthenticated request must never call `ensure()` (or a stranger could fill the table by guessing ids — asserted), and the residual is **timing**, not answers: a real webhook does HMAC work an unknown one does not. Closing that would mean hashing against a decoy on every 404, which is real work on every miss for a signal the rate limiter already bounds.

**Q37 — where a farm-generated secret lives, and why `secretHint` is the wrong mechanism for it.**

The obvious home is the plugin's own KV namespace with `secret: true`. It is wrong three times over, and all three are about ownership: the farm generates this value, the farm verifies against it, and the operator rotates it — none of that is the plugin's data. It also has to survive `DELETE /:name/:version?deleteKv=1`, must not count against the plugin's entry quota, and must not be rewritable as a side effect of an ordinary `set` (plan 112 §0.1 F13 records that `increment` silently un-secrets a key). And `kv_entries` stores `secretHint` — `${first 7}…${last 4}` of the plaintext, in clear, on the row, handed to anyone with `plugin.data`. That is right for an API key with a public prefix an operator pasted in and eleven characters too many for 32 random bytes the farm minted.

**Resolved as built:** a `plugin_webhooks` table whose `secret_ref` is `iv.tag.ciphertext` under the **`'webhook'` namespace of `secrets/store.ts`** — which already existed, and is the same box `webhook_endpoints` (outbound) and `connectors.credential` use. Not a fourth secret mechanism, and not a second hint suppressor: **the table simply has no hint column**, so there is nothing for plan 112 step 112.2's `hint?: boolean` to have to reach. That flag stays what it is for — a PLUGIN storing a credential of its own in KV — and this plan does not duplicate it. Shown once: `reveal`/`rotate` return the plaintext, every read path reports `configured` and never a character of it, asserted with a control that the same search *does* find it in an object that carries it.

**Rotation keeps the old secret working, by default, and that is the deliberate half.** The far end of a webhook is a system the farm cannot restart; between pressing Rotate and pasting the new value into GitHub there is a human. An instant cutover makes every rotation a guaranteed outage of unknown length, and the habit that produces is that nobody rotates. So the previous secret keeps verifying for 24 hours, the delivery records **which** secret verified (`current`/`previous` — so "the sender has not been updated yet" is visible rather than a surprise when the window shuts), and three things stop that becoming "old secrets work forever": the window is stored and checked per request, **at most one** previous secret is ever live (rotating twice inside the window drops the older immediately), and `graceSec: 0` revokes at once — which is the right answer for a *compromised* secret and is where an overlap would be exactly wrong. One parameter serves both cases and the caller is told which happened.

**Q38 — criterion 13's rotation had no operator door, and §4.6's `GET /:name/runtime/logs` still has none. Q23's constraint decided both.**

The parity guard refuses "nobody has built the UI yet" as a reason for a registered route, and the panels are 109.12's. A farm-level `POST …/webhook/:id/rotate` and `GET …/runtime/logs` would each have had to be either red or excused by a false statement.

Rather than ship criterion 13's mechanism unreachable, **rotation is on `ctx.webhooks.rotate`**: the plugin's own screen — a `ctx.onRequest` handler behind the core's auth, audit and TLS — is the door, and that caller is structurally outside `packages/studio/src`, which is the same genuine exemption `/http/*` already carries. 109.12 adds the farm-level panel for plugins that build none. The same reasoning gives 109.8 **`ctx.logs.page()`**, which also unblocks plan 112 step 112.8 without waiting for 109.12: its `GET …/http/logs` handler reads the core's ring through its own context.

The only route this pair registers is `POST /:name/webhook/:id`, and its opt-out is the strongest form the guard admits — **Studio cannot be the caller**, because the caller is by construction a third-party system with no session and nothing to sign with.

**Handing a plugin its own secret is honest, not a hole.** It runs in the core's process and can open `enkaku.db` and the key file beside it (§3.2, §4.3 — *it is not a sandbox*), so refusing the plaintext would be performing a boundary the farm does not have. What the named door buys is the **audit row**: "plugin `x` revealed webhook `y`'s secret" becomes a fact somebody can find rather than an inference nobody can.

**Q39 — what an audit row names when there is no operator behind the request.**

Q27 added `plugin.http`/`plugin.socket` under the REAL caller precisely so the plugin rows had a way back to a human. A webhook has none. `userId: null` was the other option and it says less — it is the same value a core-internal action carries, so *"which of these rows had nobody behind them because they came in off the internet"* would stop being a query. The row is written under **`webhook:<plugin>/<id>`**: a **named absence**, which states both that there was no operator and what stood in for one (a holder of that webhook's secret).

One row per request that got past the limiter, whatever became of it — a stranger probing with a wrong signature is exactly the event an operator wants in the log, and the limiter is what bounds the volume. `meta` carries the outcome, the status, the body size and which secret verified; never the body, never the signature, never the secret. Asserted, with a control that the same harness DOES write an operator-named row for an HTTP handler call — otherwise "no row names an operator" would pass on an empty table.

**Q40 — `PluginHandlerView.permission` could not stay non-nullable.** A webhook handler has no ACL permission; writing `script.view` there would be a false statement about what gates the route, in the one field the Plugins page reads to tell an operator what gates it. It is `null`, and `resolvePluginHandler` refuses a `null` permission outright rather than defaulting — a `null` arriving on a route that asks an ACL question can only be a routing bug, and the safe reading of a routing bug is closed.

**Two small traps, recorded so they are not rediscovered.** `Bun.write` **truncates**, so the rotated file is appended with `appendFileSync` — the obvious call would have turned a log into a one-line file that always looks like the plugin just started. And rotation is announced **in the log itself**: the banner is a real line, so it reaches the ring, the broadcast and the head of the new file, where relying on the ring's `truncated` flag alone would only have told a reader that the *memory* window dropped something, which is a different and much smaller fact.

**§4.8's file list, as actually built by these two steps.** `packages/protocol/src/messages/plugin.ts` (`plugin.log`, `PluginLogLineSchema`, `PluginLogPageSchema`) and the `PLUGIN_EVENT_TYPE_DENYLIST` half of `index.ts`; `plugin-service.ts` gains `PluginWebhookSchema`, `webhooks`, `pluginWebhookPath`/`parsePluginWebhookPath`, the signature header, `PluginWebhookInfoSchema` and `duplicateWebhookIdsMessage`; `packages/sdk/src/runtime.ts` gains `ctx.onWebhook`, `ctx.webhooks`, `ctx.logs` and their request/response types; `packages/core/src/plugins/webhook-secrets.ts` (**not in §4.8's list at all** — the store is a separate concern from the routes), `webhook-routes.ts`, `runtime-logs.ts`; `db/schema.ts` + `drizzle/0059_*` for `plugin_webhooks`; `auth/middleware.ts` gains `isPublicPath` (a `Set` cannot express a two-variable path); `auth/audit.ts` gains `plugin.webhook`; `api/plugins.ts` gains the one route and its status map; and `daemon.ts` wires the store, the limiter, the log ring and the auditing `ctx.webhooks` port. **No `plugin.runtime.status` message** — that is 109.12's, with the panel that reads it.

**One thing that is red in the working tree and is NOT ours, proven rather than asserted: `packages/core/src/plugins/verify-child.test.ts`.**

26 of its 30 tests fail with `ResolveMessage: Cannot find package 'zod'`. Every failing fixture writes a bundle that itself does `import { z } from 'zod'` into `os.tmpdir()` and asks the verify child to `import()` it; Bun resolves a bare specifier from the importing FILE's directory, and there is no hoisted `node_modules/zod` above `/private/var/folders/…` — root `node_modules` holds only what the root `package.json` declares, and both it and `bun.lock` are modified in the working tree by concurrent work.

The measurement that settles whose fault it is, because "it looks environmental" is exactly the kind of claim that is worth one command: the same bundle was verified four ways — through the working tree's child entry and through **`git show HEAD:…verify-child-entry.ts`**, each against a bundle in `os.tmpdir()` and one in `/tmp`. Both entries fail in `os.tmpdir()` and both succeed in `/tmp`. **The variable is the directory, not the code**, and HEAD fails identically, so this predates every step of plan 109. The same child verifies a bundle with no bare imports perfectly, including this step's new `E_PLUGIN_WEBHOOK_INVALID` and `E_PLUGIN_EVENT_REFUSED` refusals, which were exercised that way.

Left alone rather than fixed: it is an install-layout problem in another agent's blast radius. The fix, when someone takes it, is for the fixture to write its bundle somewhere `zod` resolves from (or to stop importing `zod` in fixtures that do not need it), not for the child to change.
