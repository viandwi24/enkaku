# Plan 109 — M74 : A plugin can run code, listen on a port, and be reached by a device

> Status: draft — designed 2026-08-17 with the owner across one design conversation. Every decision in §3 is theirs, recorded with its reasoning and with the cost it carries. Nothing implemented.
> Depends on: Plan 108 (M73) — the manifest, the `.enkaku` package, `plugin.data`, the action executor, and the Plugins page this extends.
> Deliberately does NOT depend on: the network/guest-agent layer (plans 33/43/44/51/52/54/55). The owner is removing that feature temporarily, and the proxy case in §4.7 is an **illustration of the general problem**, never a dependency. Nothing in this plan reads `Socks5RouteConfig` or the guest agent.
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
| **H1** | `adb reverse tcp:<devicePort> tcp:<hostPort>` works on the reference hardware over **both** USB and wireless adb, and a process on the device can dial `127.0.0.1:<devicePort>`. | One command, §7. **This gates every device-reachability step in the plan.** |
| **H2** | An in-process plugin handler wrapped in try/catch + a deadline survives 10 000 invocations of a deliberately-misbehaving fixture without leaking memory or handles. | A loop test against a fixture that throws, rejects, and hangs in turn. |
| **H3** | A node-side forwarder over `tunnel-stream` does not starve video frames at a realistic device count. | 10 devices streaming plus one saturated forwarder; compare frame intervals against the same run with the forwarder idle. |

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

So there is no separate "service" concept and no `service.query`. There is **one `PluginContext`**, and several kinds of handler that receive it:

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
| a handler rejects | the same, plus `process.on('unhandledRejection')` with an async-context tag so a floating rejection is attributed to the right plugin |
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

```ts
export interface PluginDefinition {
  // … plan 82 and plan 108 fields
  runtime?: {
    /** Entry inside the package. Loaded when the plugin is activated. */
    entry: 'runtime'
    /** Exhaustive. `ctx.farm.*` refuses anything absent. Shown at install. */
    permissions: CapabilityId[]
    /** Typed farm events this plugin will receive. Shown at install. */
    events?: EventType[]
    /** Inbound webhooks, each with its own secret and body schema. */
    webhooks?: Array<{ id: string; schema?: JsonSchemaNode }>
    /** Declared intent only — the plugin binds its own socket (§3.3). Shown at install and on the Plugins page. */
    listeners?: Array<{ id: string; proto: 'tcp' | 'udp'; defaultPort?: number; deviceReachable?: boolean }>
    /** Opt-in per-plugin SQLite file (§3.6). */
    storage?: { db?: boolean }
    /** Reserved. Verify refuses anything but 'in-process' until a process host exists (§3.2). */
    isolation?: 'in-process' | 'process'
  }
}
```

### 4.2 The runtime host — `plugins/runtime-host.ts`

Owns load, lifecycle, containment, and accounting.

| concern | policy |
|---|---|
| Load | on activate, and at boot for every already-active plugin — **after** the HTTP server is listening, so a bad plugin can never block boot |
| Unload | on disable, remove, reload, and shutdown: run every `onStop` disposer, wait ≤ 5 s, then unregister handlers, cancel event subscriptions, and bind-test each reported port (§3.3) |
| Every invocation | `try/catch` + a deadline (default 30 s, per-handler override, clamped by a farm setting) |
| Rejections | `process.on('unhandledRejection')` with an `AsyncLocalStorage` plugin tag so a floating rejection is attributed, not merely logged |
| Error budget | 20 handler failures in 60 s ⇒ the runtime is disabled, marked `failed` with the last error verbatim, and stops receiving events and calls. Loud and finite, never a silent loop |
| Memory | RSS is process-wide in-process, so there is **no per-plugin ceiling**. Instead: per-plugin counters (invocations, failures, open sockets, event deliveries) and a warn when a plugin's own reported listener count or storage size crosses a threshold. Stated as the honest substitute it is |
| Status | `stopped | starting | running | failed | stopping` — and `starting` is never worded as `running`, per `docs/design.md`'s own rule about degraded states |

### 4.3 The capability broker — `plugins/farm-broker.ts`

`ctx.farm.<id>(input)` is checked twice: against the manifest's declared `permissions`, then by the real `invoke()` against the real ACL, with a `CapabilityContext` bound to a **plugin principal** (`plugin:<name>`). Every call is audited as `plugin.capability` with the plugin, the capability id, and the target.

No `Db`, no `KvStore` object, no capability registry is reachable from plugin code — asserted by a test over the context object's own shape.

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
// runtime entry
export default defineRuntime(async (ctx) => {
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
})
```

Plan 108's view renders `{ kind: 'handler', name: 'status' }`, and the operator sees the listener, the per-device addresses, the logs, and Start/Stop — all from mechanisms in this plan, none from a proxy-specific feature.

### 4.8 Files

```
packages/protocol/src/
  messages/plugin.ts            NEW — plugin.log, plugin.runtime.status
  tunnel.ts                     + 'tunnel-stream' channel kind
  plugin-surface.ts             + { kind: 'handler', name } data source (plan 108's vocabulary)
packages/sdk/src/
  runtime.ts                    NEW — defineRuntime(), PluginContext, handler registration
  index.ts                      + defineRuntime
packages/core/src/
  plugins/runtime-host.ts       NEW — load/unload, try/catch+deadline, error budget, counters, status
  plugins/plugin-context.ts     NEW — the one ctx builder shared by every handler kind
  plugins/farm-broker.ts        NEW — declared-permission gate → invoke() → audit
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

**109.1 — `defineRuntime` and the context.** `sdk/src/runtime.ts`; `plugins/plugin-context.ts` as the ONE builder, shared with the script path so `storage`/`log`/`farm` are literally the same code. *Result:* a plugin helper can be called from a script handler and an HTTP handler unchanged.

**109.2 — The host.** `runtime-host.ts` with every policy in §4.2; load after HTTP is listening; unload on shutdown. *Result:* a fixture that throws, rejects, and hangs is contained, charged, and finally disabled by the budget — with the core still serving `/api/health` (H2).

**109.3 — The broker.** `farm-broker.ts`; declared permissions enforced at both ends; audit rows; a test asserting no `Db`/`KvStore`/registry is reachable from `ctx`.

**109.4 — Listeners.** `ctx.isPortFree`, `ctx.reportListener`, `ctx.onStop` with the 5 s wait and the advisory bind-test backstop. *Result:* reload twice in a row and the plugin's own port is still bindable.

**109.5 — Events.** Tap `hub.broadcast`, filter by declared types, per-handler deadline, budget-aware. `device.connected`/`device.disconnected` are added as typed events if the fan-out does not already carry them under another name.

**109.6 — HTTP, WS, query handlers.** The three route families; plan 108's `{ kind: 'handler' }` data source and its failed-runtime `ErrorState` path (a view whose handler is down names the plugin and offers Restart — never an empty table, never an unresolved spinner).

**109.7 — Webhooks.** Per-webhook secret generation and rotation, HMAC verification reusing R4's helper, rate limiting, schema validation.

**109.8 — Logs.** Ring, rotation, `plugin.log`, the route, redaction.

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
