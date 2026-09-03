# `proxy-manager` — how the pack actually works

> An as-built analysis of `plugins/proxy-manager/`, read off the code on `main` (2026-08-21) at
> version **0.9.0**. Where the code and a plan (or the pack's own README) disagree, this document
> follows the code and says so — see §16.
>
> The design record is plans **112** (M77, the pack itself), **114** (M79, the two apply modes),
> **117** (M82, egress binding), **118** (M83, the port-mismatch guard) and **121** (M86, failover).
> Its host substrate is plans **108** (plugin surface), **109** (plugin runtime / `defineService`)
> and **111** (tier-C React UI) — see [`docs/feat/plugin-and-script.md`](plugin-and-script.md) for
> those. For operator-facing prose, read `plugins/proxy-manager/README.md` and
> [`docs/guide/install.md`](../guide/install.md)'s *"Egress binding: one proxy per way out"*.

---

## 1. What this pack is

Three halves of one plugin, and they run in three different places:

| half | declared as | runs in | file(s) |
|---|---|---|---|
| **the screen** | `surface.views.proxies.react` | the operator's browser, inside Studio's own React tree | `src/ui/**` |
| **the service** | `service: defineService({...})` | **the core's own Bun process**, for as long as the plugin is enabled | `src/service/**` |
| **the script** | `scripts: [checkScript]` | a job child, on a leased device | `src/index.ts` |

What it does, in one sentence each:

- **A catalogue.** Proxy records in the plugin's own KV namespace — a listener side, an upstream
  side, an ordered list of backup upstreams, and an intent flag.
- **A bridge per enabled record.** A real HTTP or SOCKS5 listener bound on the farm's machine,
  tunnelling through whatever the record names — a vendor `socks5`/`http` proxy, or **`direct`**
  (this host dials out itself, optionally bound to one of its own addresses).
- **Failover.** A record can name backup upstreams; a streak of dial failures earns a confirmation
  probe *through the same upstream*, and only a probe that **also** fails earns a switch.
- **An assignment note per device**, and an **Apply** button that asks the farm — through a
  capability, never a `fetch` — to point that phone at the record, as an HTTP proxy or as a VPN.
- **One log stream**, tagged per record, filtered server-side.
- **Reset data**, which turns off every route this pack applied *before* the farm deletes the only
  record of which phones it applied them to.

### 1.1 The hard line this pack keeps

> **A proxy an app *can be pointed at* and a route an app *cannot escape* are different things.**

That sentence is not a slogan, it is enforced in four separate places:

1. The screen's permanent banner headline (`src/ui/index.tsx`) is literally *"A proxy an app can be
   pointed at is not a route an app cannot escape"*.
2. The two apply modes are described **at the point of choice** (`ModePicker` renders the
   description under the closed dropdown, not inside the open one), and the VPN mode carries its own
   `VPN_CREDENTIAL_WARNING`.
3. **A VPN that cannot be applied is refused by name, never downgraded to an HTTP proxy** — plan 114
   §3.4 rule 4. An operator who asked for the inescapable route must never quietly get the escapable
   one.
4. A record with no passed egress probe reads **`unverified`**, never anything that could be read as
   success. `index.test.ts` greps the whole `src/` tree for the forbidden words, with a positive
   control proving the grep is not vacuous.

### 1.2 Scale

| metric | value |
|---|---|
| TypeScript files (excl. tests) | 35 |
| Total lines incl. tests | ~20,700 |
| Test files / test cases | 19 / ~354 |
| Runtime dependencies | `socks`, `zod`, `@enkaku/protocol`, `@enkaku/sdk`, `@enkaku/toolchain` |
| Dev-only | `@enkaku/ui`, `react`, `tailwindcss`, `@tailwindcss/cli` |
| Declared capabilities (standing) | 2 |
| Declared capabilities (reset-only) | 2 |
| HTTP handlers | 7 |
| Coded record problems | 20 |
| Coded runtime errors | 12 |
| KV key shapes | 5 |

---

## 2. Files and layout

```
plugins/proxy-manager/
├── package.json           `enkaku: { plugin, entry }` — the manifest the CLI reads
├── tsconfig.json          TWO halves, one config: lib adds DOM for src/ui, keeps types:["bun"]
├── README.md              operator-facing
└── src/
    ├── index.ts           definePlugin — the manifest, the one member script, defineService,
    │                      the `apply` handler, onResetData. THE consent record lives here.
    ├── shared.ts          (2,286 lines) IMPORTS NOTHING. The one module BOTH halves read:
    │                      key builders, the record shape, the read-time migration, the whole
    │                      problem vocabulary, routeForRecord, the paste parser, every sentence
    │                      an operator can read.
    ├── record.ts          The Zod declaration of the record + secret shapes; re-exports shared.ts
    ├── enkaku-host.d.ts   `window.__enkaku__.register` — the one global Studio puts in the page
    ├── service/           ── runs in the core's process ──
    │   ├── supervisor.ts  (876) THE owner of a bridge's state. Five-state machine, per-id lock,
    │   │                  two-phase stop, startEnabled, the probe sweep, destroyAll.
    │   ├── listener.ts    bind/accept/cap/track/relay-wiring, protocol-agnostic. UpstreamHolder.
    │   ├── listen-http.ts     HTTP proxy negotiator: CONNECT *and* absolute-form, RFC 7617 auth
    │   ├── listen-socks5.ts   SOCKS5 negotiator: RFC 1928 + RFC 1929 auth
    │   ├── relay.ts       the bidirectional pipe, byte counters, idle timer, one teardown path
    │   ├── upstream.ts    the `Upstream` interface + createUpstream()'s four-way dispatch
    │   ├── dial-socks5.ts     via the `socks` dependency
    │   ├── dial-http.ts       CONNECT + one status line, hand-written
    │   ├── dial-direct.ts     net.connect({ localAddress }) + a bound DNS resolver
    │   ├── gost-provision.ts  Windows-only: download+verify gost 3.2.6
    │   ├── gost-runtime.ts    Windows-only: supervise ONE gost process for every direct record
    │   ├── failover.ts    (412) the failure counter + confirmation-probe-gated switch
    │   ├── probe.ts       runEgressProbe — dialled THROUGH the record's own Upstream
    │   ├── auth.ts        listener-side credentials: constant-time compare, both wire formats
    │   ├── errors.ts      the 12 coded errors, classifyDialError/classifyBindError, scrubSecrets
    │   ├── logbook.ts     the log vocabulary, the field allowlist, proxySubject()
    │   ├── handlers.ts    the six `ctx.onRequest` routes — a door onto the supervisor, no state
    │   ├── apply.ts       (603) THE only file that reaches a phone, and it does so by asking
    │   ├── reset.ts       onResetData — un-route the phones, then stop the bridges
    │   ├── socket.ts      the `BridgeSocket` type alias + why it is node:net and not Bun.listen
    │   └── fixtures.ts    shared test fixtures
    └── ui/                ── runs in the browser ──
        ├── index.tsx      the registered component: banner + four tabs, URL-as-state
        ├── index.css      utilities-only Tailwind; NEVER `@import 'tailwindcss'`
        └── parts/
            ├── api.ts     the wire shapes + readProxy/writeProxy funnel + route builders
            ├── catalogue.tsx (2,292) the table, ProxyDialog, PasteDialog, GenerateDialog
            ├── assignments.tsx  the per-device note + ModePicker + Apply
            ├── logs.tsx        one stream, filtered by the farm
            ├── runs.tsx        this pack's own job history
            ├── upstream-fields.tsx   one upstream's fields, shared by primary and backups
            ├── backup-upstreams.tsx  the ordered fallback editor
            ├── failover-chip.tsx     the quiet-by-default "on backup #n" chip
            └── bits.tsx       useLoader, usePoll, ProxyStateBadge, StatusDot
```

### 2.1 `shared.ts` imports nothing, and that is load-bearing

The service runs in Bun and can reach `node:net`, `node:os`, `node:dns`. The screen runs in a
browser and cannot follow any of them. Both need the *same* answer to "what is a stored proxy",
"may this record run", "what route does this record produce", "how is this state worded".

So every one of those lives in `shared.ts`, which has **zero imports**, and both halves call it.
The pattern shows up repeatedly:

- `PROXY_STATES` moved out of `supervisor.ts` (which imports `node:net`) so the browser could stop
  keeping a second copy of the same five words.
- `describeDirectUpstream` moved out of `service/upstream.ts` for the same reason, and
  `upstream.ts` now re-exports it so existing importers are unaffected.
- `validateProxyRecord` and `routeForRecord` are called by the screen (to disable a button and say
  why) **and** by the service (to refuse the same record again when the request arrives). Neither
  may be the only place the rule exists.

Where a check genuinely needs a Node call, the parameter is **three-valued** rather than the
function reaching for it: `hostAddresses`, `hasListenerAuth`, `hasPassword` all treat `undefined`
as *"nobody looked"* — the browser's honest answer — and never as a refusal it cannot justify.

---

## 3. The data model — five keys, one namespace

A plugin has no storage engine of its own; `kv_entries` under the plugin's own namespace **is** its
store, and the namespace is injected server-side from the URL path (plan 108 §3.7). This pack uses
five key shapes:

| key | scope | secret | what it holds |
|---|---|---|---|
| `proxy:<id>` | global | no | the record — the whole catalogue row |
| `proxy-secret:<id>` | global | **yes**, `hint: false` | the primary upstream's password (legacy/slot-0 fallback) |
| `proxy-secret:<id>:<slot>` | global | **yes**, `hint: false` | slot `n`'s own password — `0` primary, `1..n` = `fallbackUpstreams[n-1]` |
| `proxy-auth:<id>` | global | **yes**, `hint: false` | the **inbound** listener credential `{ username, password }` |
| `proxy-probe:<id>` | global | no | the last observed egress: `{ at, ok, publicAddress?, latencyMs?, error? }` |
| `assigned` | **device** | no | `{ proxy: 'proxy:<id>' }` — the note against one phone |

Two rules fall out of that table and both are enforced:

- **`proxy-secret:` must never be picked up by a list of `proxy:`.** That is a property of the two
  strings, not of a filter someone has to remember — `record.ts` exports
  `SECRET_PREFIX_IS_DISJOINT` and `index.test.ts` asserts it.
- **The assignment is device-scoped**, by the farm's own one-sentence rule: *if forgetting the
  device should forget the fact, it is device-scoped*. Forgetting a phone forgets the note and must
  not take the catalogue with it.

### 3.1 `ProxyRecord`

```ts
interface ProxyRecord {
  label: string
  listen:   { proto: 'http' | 'socks5' | 'https'; bindHost: string; port: number | null }
  upstream: ProxyUpstream
  fallbackUpstreams: ProxyUpstream[]          // plan 121
  failover: { failureThreshold: number; autoFailback: boolean }
  enabled: boolean            // INTENT, never observation
  logDestinations: boolean    // off by default
  maxConnections: number      // default 256
  drainMs: number             // default 10_000
  capacity: number            // 0 = unlimited        } plan 117,
  exclusive: boolean          //                      } enforced in apply.ts
  listenerAuth: boolean       // INTENT that proxy-auth:<id> exists
  notes: string
}

interface ProxyUpstream {
  proto: 'http' | 'https' | 'socks5' | 'direct'
  host: string; port: number; username: string     // ignored when proto === 'direct'
  bindAddress: string                              // only for 'direct'
  resolveThroughEgress: boolean                    // only for 'direct'; default ON
}
```

Three field-level decisions worth naming:

- **`listen.port: null` is a real, storable state, not a gap.** The pack's shipped record shape
  named an *upstream* port and no local one, and there is no correct guess. The row says *"needs a
  local port"* and cannot start — a **precondition**, not an error.
- **`enabled` is intent, and nothing about a running bridge is ever persisted.** State, uptime,
  connection counts, byte totals and last error live in the supervisor's memory and are gone when
  the core restarts — which is correct, because *the listener is gone too*. A persisted `running`
  that survived a crash is a lie the moment it is read. `startEnabled()` is the whole of "survive a
  restart".
- **The password is never on `ProxyUpstream`.** It is the other key, and `ProxySecret` is
  deliberately `{ password: string }` — an **object with one field**, which must stay one: the KV
  store hints a non-string value from its JSON, so a forgotten `hint: false` would leak
  `{"passw…rd"}` rather than `Sup3rSe…word`. `shared.ts`'s `secretHintLeak()` **measures** that
  rather than asserting it, and `index.test.ts` checks it against the core's own `secretHint`
  source.

### 3.2 Read-time migration, never a rewrite pass

`readProxyRecord(value)` upgrades a stored value on the way in, and `writeProxyRecord(record)` is
its exact write half. Three properties, each a decision (plan 112 §4.3):

1. **Upgraded on read, written back only when the operator next saves that row.** No boot-time loop
   over the namespace ⇒ no partial-write hazard and nothing to resume after a crash.
2. **`enabled: false` always, on the migration path.** A migration must never start a listener
   nobody asked to start.
3. **`listen.port` stays genuinely absent.** A guess would be a port the operator did not choose,
   bound on their machine, by an upgrade.

It is also a **defensive reader**: a KV namespace is the plugin's scratch space and an operator with
`kv.manage` can put anything under `proxy:`, so junk renders as blanks rather than throwing inside a
table row and taking the tab down through the error boundary. Plan 117's five fields and plan 121's
two fall through the same `bounded`/`bool`/`oneOf` defaulting — there is no separate migration
branch for either.

The write side is one function, not an object literal at each call site, and the reason is stated in
the code: *a screen that writes `{ hostname }` into a reader that looks for `{ host }` renders blank
cells forever, the write succeeds, and nothing anywhere reports a fault.* `index.test.ts` runs a
value through **both** and parses the result against `ProxyRecordSchema` — two halves compiled by
two different bundlers, held to one shape by a test that actually executes both.

---

## 4. The problem vocabulary — refusal vs precondition

```ts
type ProxyProblemKind = 'refusal' | 'precondition'
```

- A **refusal** is a choice the product will not honour. Reported at **write**, before a record is
  stored, so an operator learns about it in a form and not as a 502 inside an app on a phone.
- A **precondition** is a fact that is not true *yet*. The record is perfectly storable, it simply
  cannot start. Plan 59's rule: a precondition disables the control and says what is missing; it is
  never rendered as an error.

```ts
isStorableRecord(problems)  // no refusals — preconditions do not block a write
isStartableRecord(problems) // no problems at all — both kinds block a start
```

`validateProxyRecord` returns **every** problem it finds rather than the first, because a form that
reports one error at a time makes an operator submit four times.

### 4.1 The twenty codes

| code | kind | source | means |
|---|---|---|---|
| `E_PROXY_LISTEN_UNSUPPORTED` | refusal | validate | an HTTPS *listener* would need a cert the farm cannot issue for a plugin |
| `E_PROXY_UPSTREAM_UNSUPPORTED` | refusal | validate | an HTTPS *upstream* is one `tls.connect` away and refused because untested-and-carrying-a-password is worse than an honest refusal |
| `E_PROXY_PORT_CONFLICT` | refusal | validate | another **enabled** record already claims this port |
| `E_PROXY_PORT_UNASSIGNED` | precondition | validate | migrated row with no local port |
| `E_PROXY_BIND_ADDRESS_INVALID` | refusal | validate | `bindAddress` is not an IPv4/IPv6 literal — no fact could make it valid |
| `E_PROXY_BIND_ADDRESS_UNAVAILABLE` | precondition | validate | this host does not hold that address *right now* — a NIC could appear |
| `E_PROXY_LISTENER_AUTH_REQUIRED` | refusal | validate | non-loopback bind with `listenerAuth: false` — an open relay |
| `E_PROXY_LISTENER_AUTH_MISSING` | precondition | validate | `listenerAuth: true` and no `proxy-auth:<id>` row |
| `E_PROXY_NOT_APPLICABLE` | refusal | route (http) | Android's system proxy names an HTTP proxy and nothing else |
| `E_PROXY_NOT_RUNNING` | precondition | route (http) | the record is not enabled, so nothing is listening |
| `E_PROXY_VPN_UPSTREAM_NOT_SOCKS5` | refusal | route (vpn) | the guest agent speaks SOCKS5 and nothing else |
| `E_PROXY_VPN_UPSTREAM_INCOMPLETE` | precondition | route (vpn) | no complete upstream address yet |
| `E_PROXY_VPN_NO_PASSWORD` | precondition | route (vpn) | a username with no saved password — a half credential |
| `E_PROXY_VPN_LISTEN_NOT_SOCKS5` | refusal | route (vpn, direct) | the phone dials *this* bridge, and it speaks HTTP |
| `E_PROXY_VPN_BIND_LOOPBACK` | refusal | route (vpn, direct) | `127.0.0.1` means "the phone itself" to the phone |
| `E_PROXY_VPN_BIND_UNSPECIFIED` | refusal | route (vpn, direct) | a wildcard bind names no address the phone could dial |
| `E_PROXY_AGENT_NOT_READY` | precondition | `vpnAgentProblem` | agent absent / provisioning / outdated / failed |
| `E_PROXY_AGENT_UNSUPPORTED` | refusal | `vpnAgentProblem` | this Android version cannot run the agent at all — nothing to retry |
| `E_PROXY_CAPACITY_FULL` | refusal | `apply.ts` | `capacity` reached, or `exclusive` and somebody else holds it |
| `E_PROXY_PORT_MISMATCH` | precondition | `apply.ts` | the record's stored port ≠ the port the bridge is actually bound on |

Two conventions this list encodes:

- **Every VPN code names the thing that is actually wrong.** One
  `E_PROXY_VPN_NOT_APPLICABLE` covering all four would send an operator whose phone has no guest
  agent off to edit the record's upstream.
- **`E_PROXY_BIND_NOT_LOOPBACK` was retired, not kept alongside its replacement**
  (00-overview §4.3: *replace, never version*). Its premise — *"no listener authentication
  exists"* — stopped being true the moment `service/auth.ts` shipped, so a code naming it would now
  be lying.

---

## 5. The service — the supervisor

`src/service/supervisor.ts` is the one file in the pack that owns a socket.

```
 stopped ──start──▶ starting ──listening──▶ running
    ▲                   │                     │
    │                   └── bind failed ──▶ failed
    │                                         │
    └──── stopped ◀── stopping ◀──── stop ─────┘
```

Plan 109's five-word service vocabulary, with plan 109's rule: **`starting` is never worded as
`running`, and `stopping` is never worded as `stopped`.** A bridge mid-drain has released its port
and is refusing new connections while already-open tunnels finish — an operator reading "stopped"
there would start something else on that port.

The screen adds a **sixth** word, `unknown`, and that is correct rather than an omission here: it
means *the runtime read failed*, which is a fact about the farm's answer and not a state any
supervisor was ever in.

### 5.1 Concurrency and lifecycle

- **One operation per proxy at a time** (`withLock`), so `restart` is genuinely stop-then-start with
  nothing interleaving. The lock chain swallows the previous result deliberately: a failed start
  must not prevent the next stop.
- **`refresh()` before anything.** Every route re-reads the catalogue first — the screen writes a
  record through `PUT …/data/entry` and presses Start a moment later, and a supervisor that had not
  looked since boot would answer about a row that no longer exists.
- **A deleted record keeps its entry for as long as its listener is up.** Forgetting it would strand
  a bound port with no handle left to close it. It is dropped once nothing is listening.
- **`startEnabled()` never throws for one bad record.** A catalogue of ten with one broken row
  starts the other nine, and the broken one says why on its own row. The `started` count counts only
  records that actually reached `running` — reporting the *intent* count as the *started* count is
  the exact conflation the intent/observation split refuses.

### 5.2 Stop is two phases, and `destroyAll()` is neither

1. **Drain** — `listener.close()`: stop accepting, **the port is released immediately**, live
   tunnels keep running, the row reads `stopping` with a live count.
2. **Close** — after `drainMs`, destroy whatever is still open. The row reads `stopped`.

A **force stop** skips phase 1 (a ten-second wait on a proxy carrying a long download is sometimes
not what an operator wants, and burying that behind the same button would make Stop feel broken).

**`destroyAll()` — the `ctx.onStop` disposer — does not drain, and that is forced by the code rather
than chosen**: the host's `DISPOSER_TIMEOUT_MS` is 5,000 ms for *every disposer combined*, after
which it logs a warn naming the plugin and marks the service `stopping` rather than `stopped`. A
10 s drain inside a disposer cannot succeed; it would blow the budget, earn the warn, and buy
nothing. Its one `await` is the Windows `gost` child process's `.kill()`, which resolves in well
under the budget.

The disposer is registered **before anything binds**, so a `setup` that throws halfway still has a
disposer for whatever did get opened.

### 5.3 `startLocked` — the order matters

```
read proxy-auth:<id>          ← BEFORE validating: E_PROXY_LISTENER_AUTH_MISSING is a
                                precondition about whether a row EXISTS, and validating first
                                could only answer `undefined` ("nobody looked")
validateProxyRecord({ hostAddresses: os.networkInterfaces(), hasListenerAuth })
  → any problem?  ⇒ state 'failed', log `start-refused`, return. No socket opened.
read proxy-secret:<id>[:0]    ← fail-open to '' on an unparseable row
createUpstream(record, password)
wrap in UpstreamHolder        ← plan 121: the indirection a failover swap reassigns
createFailoverController      ← fresh per start; a stale streak must not carry over
createHttpListener | createSocks5Listener
  → torndown while the bind was in flight?  ⇒ close it rather than leak it
state 'running', reportListener({ deviceReachable: false })
```

Both credential reads are **fail-open to absent**: an unparseable secret leaves the proxy dialling
without a password and failing honestly on the upstream's own refusal, rather than throwing out of
`start` with a storage error that reads like a bug in the farm. Whether *absent* is safe is the bind
gate's question, not the reader's.

`reportListener` is **pure observability** — reporting is not control, and not reporting does not
stop the socket working. What it buys is that a port open on the operator's machine is visible in
the product instead of only in `lsof`. `deviceReachable: false` is deliberate: the chain that would
make it true is not built, and claiming it would be a manifest whose central claim is false.

### 5.4 The egress probe sweep

Every **running** record, one after another, on a jittered interval:

- Base `PROBE_INTERVAL_MS = 300_000` (5 min) ± 20% full jitter. A public address changes rarely —
  this is *not* a liveness heartbeat, and twenty records created together by the range generator
  must not probe on the same tick forever.
- **Self-rescheduling `setTimeout`, never `setInterval`.** A plain interval would queue a second
  sweep while the first is still probing twenty records, and the two would interleave writes to the
  same rows.
- The probe is dialled **through the record's own `Upstream` object** — the same one the listener
  holds — which is what makes it worth anything: it exercises the bind (`localAddress`) and the
  bound resolver, the two things that can actually be wrong about an egress. The listener socket's
  own state is already reported by the supervisor; probing it again would prove nothing new.
- With `ENKAKU_NETWORK_PROBE_URL` unset, **no dial is attempted at all** and the row is written
  straight to the `skip` shape. An unmeasurable record says so; it never reads as a pass and never
  as a plain failure.
- An `https:` probe URL is **refused by name** rather than sent in the clear or failed inside a TLS
  handshake this file does not speak.

State vocabulary, and the word choices are deliberate:

```ts
proxyProbeState(null)                  // 'unverified'  — never probed
proxyProbeState({ ok: true, … })       // 'confirmed'   — not "verified"/"ok"/"success"
proxyProbeState({ error: SKIP_REASON}) // 'skip'        — labelled "Not checked"
```

`confirmed` rather than `verified` so that criterion 10's grep has nothing to catch *even by
substring*.

The same sweep tick also runs failover's background primary-recovery probe (§7) — no second timer.

---

## 6. The bridge

### 6.1 `listener.ts` — the protocol-agnostic half

Bind, accept, count, cap, hand each connection to a **negotiator**, wire the relay, let go on
demand.

Plan 112 §3.2 chose `node:net` over `Bun.listen` knowingly: that loses
`SocketListener.stop(closeActiveConnections)` and means keeping a `Set` of live sockets by hand.
The supervisor needs that `Set` anyway (for the live count and for phase 2 of the stop), so the cost
is near zero — and the alternative was hand-writing backpressure between a Bun socket and a Node
socket, since `SocksClient.createConnection` returns a `net.Socket` and Bun's socket is not a Node
stream and has no `.pipe()`.

Details that are bugs if missed:

- **`close()` is synchronous** — a correction to plan 112 §4.4's sketch, which typed it
  `Promise<void>`. Node's `server.close()` releases the listening socket before returning and calls
  its callback only once every connection has gone, so awaiting it would be awaiting the drain.
- **Connections are tracked from ACCEPT, not from "upstream connected."** A cap counting only
  established tunnels would be no cap at all against the case it exists for: a client opening
  connections faster than a slow upstream can answer them.
- **`client.on('error', …)` is attached immediately**, before the relay exists — an unhandled
  `error` on a `net.Socket` is an uncaught exception, and in the core's own process nothing catches
  that.
- **`leftover` is pushed back with `unshift`, after `pause()`.** A client that pipelines its first
  request body behind the head would otherwise lose exactly those bytes — intermittently, under
  load, and never in a test that writes the head as one chunk.

### 6.2 `NegotiationApi` — two verbs

```ts
open(dest, { onReady(upstream), onFailure(err), leftover? })   // dial, then wire the relay
refuse(reason, { code?, destPort?, destHost?, clientAddress? }) // log and close
```

`onReady` runs **after** the upstream connects and **before** any piping — which is where each
protocol writes its own success reply: `200 Connection Established`, a rewritten origin-form request
line, or an RFC 1928 reply.

### 6.3 `listen-http.ts` — the finding that failed the first feasibility probe

**An HTTP proxy must serve two request forms.** Every real client sends `CONNECT host:port` only for
**https** targets; for an **http** target it sends **absolute-form**
(`GET http://host:port/path HTTP/1.1`). A CONNECT-only bridge answers `405` — so it passes every
https test and dies silently on plain http.

Both forms are handled, they are separate acceptance criteria and separate tests, and neither
substitutes for the other. Absolute form is served by **rewriting the request line to origin-form**
and replaying the rest of the head upstream before piping.

One limit, stated rather than discovered: **only the first request line is rewritten.** A client
that sends a second absolute-form request for a *different* host on the same connection reaches the
first host's origin server. RFC 7230 §5.3.2 requires an origin server to accept absolute-form, so
the request is well-formed — it simply goes somewhere the client did not mean. `gost` behaves the
same way in the same mode. Fixing it means parsing every request and re-dialling per host, which is
a real HTTP proxy rather than a bridge.

Refusals: `431` for a head over 64 KiB, `405` for a non-proxy request (a browser pointed directly at
the port lands here), `503` for the connection cap, `502` on a dial failure — with **no body and no
upstream detail**, because a 502 body is read by whoever holds the client, which for a device is an
app.

### 6.4 `listen-socks5.ts`

RFC 1928 plus RFC 1929's username/password sub-negotiation. **Exactly one method is ever offered,
never both**: a client that could choose between them could choose its way past authentication on a
listener that has one configured. `opts.auth` present ⇒ only `X'02'`; absent ⇒ only `X'00'`; a
client that does not offer the one wanted gets `X'FF'`.

`BIND` and `UDP ASSOCIATE` are refused with reply `X'07'` (*command not supported*) — the RFC's own
answer, not a dropped connection. `BIND` has no meaning for a bridge, and **UDP cannot cross
`adb reverse` at all**, so a UDP association would be a promise the mechanism can never keep.

### 6.5 `auth.ts` — the listener credential

Hashing both sides to a fixed-length SHA-256 digest before `timingSafeEqual`, because
`timingSafeEqual` **throws** on length mismatch and branching on lengths first would leak the
secret's length. **Both fields are always compared** — never short-circuited on the username — so a
wrong username and a wrong password take the same path and the same time to refuse.

Two wire formats: RFC 7617 `Proxy-Authorization: Basic <base64>` / `407` +
`Proxy-Authenticate: Basic realm="proxy-manager"`, and RFC 1929's sub-negotiation whose own version
byte is `0x01`, **not** the handshake's `0x05` — the detail a straight read of "SOCKS5" gets wrong.

### 6.6 `relay.ts`

`a.pipe(b); b.pipe(a)` with Node's own backpressure, plus a byte counter per direction added as an
extra `data` listener (a `Transform` in the middle would be a second buffer to get wrong, and the
numbers are for a screen, not for accounting).

`onClose` fires **exactly once**, whichever side ends first and whether the end was clean or an
error — the live-connection count depends on it, and a count that can be decremented twice goes
negative under load. The `reason` is a **diagnostic, never a decision**; nothing in the pack
branches on it.

`idleMs` (default **600,000 ms**) destroys a pair with no bytes in either direction. This is the
timer plan 112's hypothesis H3 exists to decide, and the answer was yes: `socks`'s own timeout
covers the **handshake only**, so an upstream that completes the handshake and then black-holes
everything leaves the client hanging until its own timeout — which for a bare TCP client is never.
Ten minutes and not ten seconds, because this is a **stuck** detector, not an activity one: a
CONNECT tunnel carrying a long-poll or an idle SSH session is legitimately silent for minutes.

### 6.7 `createUpstream` — the four-way dispatch

```ts
socks5 → createSocks5Upstream   // the `socks` dependency
http   → createHttpUpstream     // CONNECT + one status line, hand-written
direct → win32 && bindAddress   ? gost hop over createHttpUpstream
                                : createDirectUpstream
https  → throw E_PROXY_UPSTREAM_PROTOCOL   // belt to validate's braces
```

The dependency split is the design statement: **the fiddly part worth a dependency is the SOCKS5
handshake** — greeting, method negotiation, RFC 1929, three address types, reply codes — which
`socks` (MIT, pure JS, two small pure-JS transitive deps) does. The HTTP upstream is `CONNECT` plus
one status line, and a second dependency for twenty lines would be a worse trade. `direct` needs no
dependency at all.

`DEFAULT_DIAL_TIMEOUT_MS = 10_000`, chosen from plan 112 H3's measurements rather than `socks`'s own
30,000 — long enough for a real residential upstream on a bad link, short enough that a dead one is
reported rather than endured.

**A returned socket may be PAUSED with bytes already buffered on it**, and a caller has to know
that: an upstream can pack the tunnel's first bytes into the same segment as its handshake reply,
and those bytes are `unshift`ed (which requires a paused stream). `pipe()` resumes; a bare
`on('data')` after an explicit `pause()` does **not**.

### 6.8 `dial-direct.ts` — the resolver is the point

`net.connect({ host, localAddress })` resolves `host` **before** binding, through Node's default
resolver, unconditionally. On a dual-homed machine that means the **lookup** leaves through one link
while the **connection** leaves through another, and nothing about the mismatch is visible anywhere.

So with `resolveThroughEgress` on and a `bindAddress` set, this file resolves the destination itself
with a `node:dns/promises` `Resolver` whose `setLocalAddress(bindAddress)` is a real bind under Bun
(measured — an address this host does not own fails the query rather than silently succeeding), then
calls `net.connect` with the literal that came back.

Three rules:

- **Family matching.** The family of `bindAddress` decides `resolve4` vs `resolve6`, rather than
  asking for whichever record type happens to exist — otherwise the mismatch surfaces at
  `net.connect` as a confusing "address family mismatch" rather than a DNS error.
- **No fallback lookup, ever.** A failure throws `E_PROXY_DNS_EGRESS_FAILED` and stops. A silent
  fallback is the precise defect this option exists to remove. There is exactly one `return` in the
  success path and one `throw` in the failure path, *so that a future edit wanting to "just try the
  normal resolver too" has to add a whole new branch rather than slot in one more line*.
- **A destination that is already a literal is not resolved at all**, whether or not
  `resolveThroughEgress` is on.

An **empty `bindAddress` is not an unfinished record** — it is a plain local bridge, useful to an
operator with no proxy account of any kind, and the option Bun ignores is then never passed at all.

---

## 7. Failover (plan 121)

### 7.1 The false-positive problem

A dial failure through the active upstream is ambiguous: the upstream may be down, or the *target
site* may be having a bad day. Switching on the first kind is the point; switching on the second
burns through a fleet's backups for nothing.

So a streak of `failureThreshold` (default **3**) consecutive failures against the **currently
active** upstream earns only a **confirmation probe** — `runEgressProbe`, dialled through that exact
same upstream — and only a probe that **also** fails earns a switch. *A probe that succeeds means
the streak was target-site-specific: the counter resets and nothing else happens, silently, on
purpose.*

### 7.2 The mechanism

```
listener ──dial──▶ opts.upstream.current.connect(dest)
                        │
                        └─▶ onDialResult(ok) ─▶ FailoverController
                                                  consecutiveFailures++
                                                  ≥ threshold? ─▶ confirmation probe
                                                                    ok  ⇒ reset, silent
                                                                    bad ⇒ build next fallback,
                                                                          reassign holder.current
```

**`UpstreamHolder` is the whole of the indirection.** Before plan 121 the listener captured a bare
`Upstream` in its closure for its whole lifetime. Wrapping it in `{ current }` that the
per-connection dial reads through means the supervisor can reassign it without restarting the
listener's port — an **already-open connection is a live pipe by then, not a lookup, so it is
untouched; only the next accepted connection sees the new upstream.**

State, never persisted (a core restart always starts back at primary and lets ordinary failure
detection re-discover whether it is down):

```ts
interface FailoverState {
  activeIndex: number            // 0 = primary, 1..n = fallbackUpstreams[i-1]
  consecutiveFailures: number    // per (record, ACTIVE upstream) — switching always resets it
  primaryRecoveryStreak: number  // background probes of primary while on a backup
  history: { at, from, to, reason }[]   // bounded to 20, most-recent-first
}
```

**Counted per-(record, active upstream), not per-record**: a record already on backup #2 must count
a fresh streak against #2 independently, or a stale count could cascade it through every backup in
one confused burst.

An in-flight check sets `checking`, so a failure arriving mid-probe still **counts** but does not
start a second overlapping probe/switch.

### 7.3 Failback

The supervisor's existing probe sweep also calls `checkPrimaryRecovery()` — once per tick, only for
a record where `activeIndex !== 0`. No second timer.

- A **successful** probe advances `primaryRecoveryStreak`.
- A **failed** probe resets it to zero — the anti-flap guard's whole point: a primary that comes and
  goes must never accumulate partial credit across a gap.
- An **unconfigured** probe endpoint is neither. This file cannot tell "primary is fine" from
  "primary is still down" when nothing was measured, so it leaves the streak exactly where it was —
  advancing would be a fabricated success, resetting would punish an operator who simply has not set
  the endpoint.

`RECOVERY_STREAK_THRESHOLD = 2`, **fixed and deliberately not owner-configurable**: an internal
anti-flap guard, not a product setting. With `autoFailback: false` the streak still advances (so
Studio can show *"primary looks healthy again"* as information) but only the manual
`resetToPrimary()` moves `activeIndex` back.

Both paths funnel through one `switchToPrimary()` so they cannot drift on which counters reset or
what a history entry looks like. `checkPrimaryRecovery` hands its **already-probed** `Upstream`
object in to be reused, so making it live is "use the thing that was just confirmed" rather than a
fresh, unverified build.

### 7.4 Per-slot credentials

`ProxyUpstream` has no password field, so plan 121.4 widened the key scheme:
`proxy-secret:<id>:<slot>`, with `slot 0` falling back to the legacy bare `proxy-secret:<id>` when
no `:0` key exists. A fallback naming a *different* account — another local egress, a third-party
rotating proxy — now authenticates as itself. Slots `1..n` have no legacy key to fall back to: a
missing secret there is a real absence, correct for a freshly-added fallback nobody has entered
credentials for yet.

### 7.5 Provably inert with no backups

`onDialResult` checks `record.fallbackUpstreams.length === 0` **first, before touching `state` at
all**, and re-reads `getRecord()` on every call rather than deciding once at construction — so a
record edited down to zero backups goes inert on its very next dial result. There is deliberately no
separate on/off switch: an empty list *is* the off state.

### 7.6 The event, and the deviation

A switch logs through `emitFailoverEvent`, tagged with `subject: proxySubject(id)` (so it lands
beside every other line about that record) and `fields.event: 'proxy.failover'` plus
`recordId`/`from`/`to`/`reason`/`at`.

**This is a structured `ctx.log` call, not a new WS message type**, and that is a stated deviation
from plan 121 §4.5's original sketch: there is no generic plugin→WS broadcast in this codebase, and
the core's protocol package must not carry one entry per optional plugin. The Studio chip is
consequently fed by **extending the catalogue's existing 1,500 ms poll** — `transitional` now stays
true while any row is on a backup — rather than by a WS subscription. `failover-chip.tsx`'s own
header says so explicitly rather than claiming a subscription that does not exist.

---

## 8. The `direct`-upstream bind workaround (plan 117 §12, gate corrected by plan 123)

**Originally recorded here as a Windows-only finding. It is not — that was the narrower of two
readings the evidence available in 2026-08-19 supported, and the wider one turned out to be
right.** `net.connect({ localAddress })` was measured on the owner's farm host on that date: the
record's `bindAddress` was correct, the routing rule was correct, `curl.exe --interface` and a raw
`.NET Socket.Bind` both egressed through the intended link — only the Bun-built bridge kept
leaving through the default one. That measurement was real and is unchanged; what changed is the
conclusion drawn from it. Plan 123 (`docs/archive/plans/123-m88-bind-capability-probe.md` §0) reproduced
the identical failure on **macOS 15**, including a bogus-address test proving Bun's `net.connect`
never calls `bind()` at all, and it was independently reported from a live **Ubuntu 24.04** farm
(`refs/tmp-bug-proxy-mikrotik.md`). `net.connect({ localAddress })` is dropped on every platform
tested under Bun, not only Windows — the option is accepted (no throw, no warning), the connection
succeeds, and the source address is picked by route as if no bind had been requested. Tracked
upstream (`oven-sh/bun#6888`, `#11570`, `#23486`; a fix landed as `#23464` on 2025-10-12 and was
reverted three days later).

**The gate that decides when to use the `gost` hop below is therefore measured, not guessed.**
Plan 117 originally gated it on `process.platform === 'win32' && bindAddress` — a guess about
*where* the bug lived rather than a check of *whether the bind works*. Plan 123 replaced that gate
with `bindIsEffective()` (`service/bind-probe.ts`): a per-boot capability probe that binds to a
TEST-NET-1 address this host does not hold and checks whether the connect fails the way a real
`bind()` would. The `gost` mechanism itself — everything in the bullets below — is reused
**unchanged**; only the condition that reaches for it moved. It is now taken on **any platform**
when the probe finds the bind ineffective and `gost` is available. `gost-provision.ts` itself still
refuses to provision anywhere but `win32` (see below) — widening that is real, separate work,
tracked as an open question rather than done here (plan 123 §9 Q4) — so on Linux and macOS today,
a `direct` record with a non-empty `bindAddress` whose bind the probe finds ineffective does not
start at all, and carries the precondition `E_PROXY_BIND_INEFFECTIVE` naming the §6 workaround
below rather than silently mis-egressing. That is a real, immediately visible behaviour change on
a live Linux/macOS farm — correct and intended, and plan 123's own status line says so plainly.

So, whenever the probe finds the bind ineffective and `gost` is available, for a `direct` record
with a **non-empty** `bindAddress`:

- `gost-provision.ts` downloads a **pinned** `gost` 3.2.6 Windows zip with a sha256 read off the
  real release asset (downloaded, hashed locally, compared, extracted and run to confirm — not
  copied blind from `checksums.txt`), into
  `<dataDir>/plugins/proxy-manager/gost/`. **Windows-only by construction, today** — the download
  refuses any other platform by name.
- `gost-runtime.ts` supervises **one** process for every `direct` record on this gate at once, not
  one per record. A new `bindAddress` means: rewrite the config, restart the process — a brief
  interruption for the other records on the same gate too, accepted deliberately.
- Each gost service binds `127.0.0.1` only, speaks plain HTTP CONNECT (so `dial-http.ts` — already
  written and tested for vendor HTTP upstreams — is the *only* dialler needed on the Bun→gost hop,
  no new protocol code), and has no `chain`: gost dials the destination itself, bound to
  `interface: <bindAddress>`.
- `ensurePort` does not resolve until a **real TCP probe** confirms the port accepts connections —
  never a fixed sleep standing in for "it's up".

Two honest limits:

- **`resolveThroughEgress` has no effect through this runtime.** gost resolves through its own
  default resolver. Not an oversight: on the real topology this was proven against, the
  `bindAddress`'s routing carried only a default route with no path back to the LAN's DNS server, so
  binding DNS through it is the exact configuration already proven not to work there.
- **This file owns the download; the core's Toolchain Manager does not.** gost works around a bug in
  *this pack's* feature, provisioned on *one* platform today (the bug itself is not platform-
  specific — see above; only the provisioning currently is); wiring it into the farm's central
  manifest would put a plugin-specific detail on every install's Tools page. What *is* reused is
  `@enkaku/toolchain`'s three primitives (`downloadVerified`, `extractZip`, `moveFile`) — rewriting
  them here would be the weaker parallel path 00-overview §4.3 forbids.

---

## 9. Apply — the one door to a phone

`src/service/apply.ts` is the **only file in the pack that reaches a phone**, and it does so by
asking. The pack has no adb, no shell, and writes no device setting — `index.test.ts` greps the
whole tree to prove it, and the shell string that writes the Android proxy setting is deliberately
not spelled anywhere in the pack, *not even in a comment*, because a grep that has to distinguish a
comment from a call will eventually get it wrong.

### 9.1 Why a capability call and not a `fetch`

The route goes out through `ctx.farm.call('device.network.set', …)`, landing in the very handler
`PUT /api/devices/:id/network` lands in. That buys five things a browser `fetch` to the same URL
buys none of:

1. the plugin's **manifest** is checked *before* the capability runs at all — a pack that did not
   declare `device.network.set` cannot change a phone and *then* be told it was refused;
2. the farm's real ACL runs under a `plugin:proxy-manager` principal;
3. the call is audited under that principal, so *"what has this plugin done to my farm"* stays one
   query;
4. the device's own lease admission applies — a phone somebody is driving is refused, naming them,
   never taken over;
5. the route is stamped **set by proxy-manager**, which the device's Network panel renders.

A `fetch` would run as the **operator**, and the device would report that a person set the route
when a plugin did. That is not a smaller version of the same thing — it is the attribution being
wrong, which is exactly what makes *"who put this proxy on my phone"* unanswerable.

The handler itself declares `permission: 'device.network'` — **both gates apply and neither is
redundant**: this one is about the operator who pressed the button, the broker's is about the
plugin.

### 9.2 The two modes

| mode | route | what carries the traffic | the credential |
|---|---|---|---|
| `http` | `{ engine: 'adb-reverse-proxy', hostPort }` | this record's bridge, over `adb reverse` | **never leaves the farm** |
| `vpn`, vendor upstream | `{ engine: 'vpn-helper', host, port, username, password }` | the guest agent, dialling the record's **upstream** directly | **sent to the phone** |
| `vpn`, `direct` upstream | `{ engine: 'vpn-helper', host, port, username, password }` | the guest agent, dialling **this record's own bridge** | **sent to the phone** |

The two `vpn` rows share a shape because `routeForRecord` always names **whatever performs the
egress**. For a vendor record that is the vendor's own address. For a `direct` record **this farm is
the egress**, so the route names the record's own `listen.bindHost`/`.port` and the phone dials *in*
rather than *through*.

This corrected an earlier standing claim in the pack's own comments — that the enforcing rung was
structurally out of reach because *"a loopback bridge is not a SOCKS5 upstream"*. That was **right
about the bridge and wrong about the record**: a record holds *two* addresses.

Consequences the `direct` VPN branch enforces with its own codes: the listener must speak SOCKS5
(`E_PROXY_VPN_LISTEN_NOT_SOCKS5`), a loopback bind means *the phone dialling itself*
(`E_PROXY_VPN_BIND_LOOPBACK` — there is no adb reverse on the vpn-helper path), and a wildcard bind
names no address at all (`E_PROXY_VPN_BIND_UNSPECIFIED`).

### 9.3 The refusal ladder, in order

```
1. mode is not 'http'|'vpn'        → E_PROXY_BAD_MODE      (a typo'd "vpn " is never defaulted)
2. device.list has no such stableId → E_PROXY_DEVICE_UNKNOWN
3. no `assigned` note on the device → E_PROXY_NO_ASSIGNMENT
4. note points at a deleted record  → E_PROXY_ASSIGNMENT_DANGLING
5. capacity / exclusive             → E_PROXY_CAPACITY_FULL   (both modes alike)
6. mode==='vpn' && guest agent      → vpnAgentProblem(device.agent)
7. read the credential for the mode that spends it
8. routeForRecord(record, {mode, hasPassword})
9. mode==='http' && live port ≠ stored port → E_PROXY_PORT_MISMATCH
10. ctx.farm.call('device.network.set', …)  — the farm's own refusals become 200-shaped outcomes
```

Notes on the interesting rungs:

- **An absent `mode` is `http`** (the only mode that existed before 0.6.0, so no existing caller's
  request changes meaning). An **unrecognised** one is refused rather than defaulted — defaulting a
  misspelled `"vpn "` to the advisory rung would be the silent downgrade this whole file refuses,
  arriving through a typo.
- **Capacity is checked before the agent precondition**, because it is a fact about the
  *assignment*, not about the record's upstream shape. It counts the **note**, not traffic — an
  HTTP-mode proxy is advisory, so the refusal says so plainly rather than implying it measured
  anything. A device **re-applying** a record it already holds is not a new occupant and is not
  counted, or a full record could never be re-applied to the very devices on it. The whole block is
  skipped for the ordinary record (`capacity: 0`, `exclusive: false`) so the common case pays no
  extra KV reads.
- **`E_PROXY_PORT_MISMATCH`** (plan 118 §4.2) is the confirmed gap it closes: a record's port is
  edited while its bridge is `Running`, and *a running bridge does not restart itself to pick up a
  new port*. `record.listen.port` is **intent**; `ApplyHost.bridgePort(id)` is **observation** — the
  same split the supervisor draws between `enabled` and `runtime.state`. Reproduced with a real
  supervisor and a real loopback bridge: the stale port went straight to `device.network.set`, which
  correctly re-pointed the device at a port nothing was listening on. *Core's re-apply behaviour was
  not the bug; the plugin was asking for the wrong thing.*
- **A username with no saved password is refused; a record with neither is applied as anonymous.**
  This pack cannot ask an upstream whether it demands authentication, so it reads the record: an
  account named with no secret behind it is a *half* credential, and a provider that also accepts
  IP-whitelist auth answers a half credential by serving a **default pool exit** rather than by
  failing — the silent wrong answer. Measured on this farm on 2026-08-17.
- **The guest-agent precondition** is read off `DeviceInfo.agent` (derived by the farm from
  `devices.preparation['guest-agent']` — the same record the built-in's own `vpnPrecondition` reads,
  not a second vocabulary). Each of the six states gets its own sentence naming the agent as the
  cause and pointing at the device's own Preparation section; a word this build does not recognise
  returns `null`, because inventing a refusal from a value we cannot interpret would block a device
  the farm would have accepted.

### 9.4 Where the plaintext lives

The route carries `username`/`password` **inline** rather than a `credentialRef`, deliberately:

- `credentialRef` names a row in the farm's `network_credentials` table; creating one is an HTTP
  endpoint with no capability behind it, so a plugin cannot mint one at all.
- Inline is the shape the built-in already normalises — it mints an encrypted row itself and
  persists only a `credentialRef` on `devices.network_route`. The raw pair is never written to disk.
- Nothing on the way records it: `invoke()` audits `{ outcome, code, deviceId, durationMs }` and
  never the input; the `network.applied` device event runs its config through `redactRouteConfig()`;
  and this file's own log line names the proxy key and the engine, never the config.

So the plaintext exists in exactly two places, both in memory and both in the core's own process:
the local in `applyAssignment`, and whatever the built-in holds between receiving it and encrypting
it. **The credential joins the route on the last statement before the door**, so there is no
intermediate object holding it that something else could reach or log.

### 9.5 A farm refusal is a product outcome, not a plugin fault

Left to throw, a refusal from `device.network.set` became the host's `502` naming this pack as
broken — wrong for every case that actually happens: somebody is driving the phone (`admitMember`
working exactly as designed), the phone is offline, an incumbent route holds the `network-route`
lock, the guest agent could not be reached. The operator needs to read *which*, and
`Request failed (HTTP 502)` tells them none of it. So those are caught, the farm's own code travels
with the message, `scrubSecrets` runs over it, and the handler answers `200` with
`{ ok: false, code, kind, message }`. A **real** fault still throws and still becomes the 502 where
it belongs.

---

## 10. Reset data

Declared as `service.resetData` with its **own permission list and its own lifetime**:

```ts
permissions: ['device.list', 'device.network.set']            // standing
resetData: { permissions: ['device.network.get', 'device.network.clear'] }   // one pass only
```

**`device.network.clear` is deliberately NOT in the standing list.** Turning a device's proxy off is
the operator's own act on the device's own screen; a plugin that could silently un-route forty
phones is a bigger authority than anything on this screen asks for. It sits in the reset list, which
is live **only** during an operator-initiated pass, **only** through the context handed to
`onResetData`, and **only** until that pass ends — `setup`, the Apply handler, the six bridge routes
and every member script are refused it exactly as before. `index.test.ts` asserts precisely that
split.

### Why the handler has to exist

The `assigned` rows are the **only** record of which phones this pack pointed at a proxy. The farm
knows a route exists (stamped *set by proxy-manager* on the device's own row) but nothing else knows
which catalogue entry it came from. Delete the assignments without turning the routes off and every
one of those phones carries a live route nothing left in the farm can explain.

### The order, and the four outcomes

**Devices first, bridges second.** In HTTP mode the phone dials this pack's loopback bridge over
`adb reverse`; stopping the bridge first would leave the phone pointed at a dead port for however
long the un-routing takes.

| outcome | when |
|---|---|
| `unchanged` | nothing armed and nothing owed — **or** the route was set by somebody else |
| `cleared` | the route was turned off on the phone and the pre-existing settings restored |
| `pending` | the phone could not be reached; the farm recorded the teardown against the device row and settles it — with a **real** teardown — on next admission |
| `failed` | the farm refused; nothing recorded the debt, so **none of the plugin's data is deleted** |

Three properties that make this safe:

- **A route this pack did NOT set is left alone**, checked via `setBy` on every device before
  anything is cleared. There is no orphan in that case either — the farm's own device row records
  it, with the person's name on it.
- **`pending` is never worded as `cleared`.** The obligation has genuinely *moved* to the device
  row, which outlives the plugin's namespace — which is what makes it safe for the farm to delete
  the data anyway.
- **Every step is idempotent**, because an operator will press it again. A pass that half-completed
  leaves the data in place, which is exactly the state a re-run needs.

Bridges are then stopped with `force: true` rather than drained: the record is going away, so there
is no arrangement left for a live tunnel to finish under.

**A missing supervisor is a refusal, not an empty pass.** `liveSupervisor` is a module-level variable
(`setup` and `onResetData` are siblings on the `defineService` input, so a closure cannot join them;
the host cache-busts its `import()` per start, so one module instance is one running service and the
variable can never point at a previous load's sockets). If it is `null`, the handler **throws** —
answering *"nothing to undo"* would let the farm delete every assignment on the strength of a
question that was never actually asked.

---

## 11. HTTP surface

Seven handlers, all through `ctx.onRequest` — so they inherit the core's auth, TLS, CORS, rate
limiting and audit unchanged. **Nothing in this pack opens a port to serve a UI**; plan 109 §3.7
names that as the trap, and a `Bun.listen` of the plugin's own would bypass all five.

| method + path | handler id | permission | timeout |
|---|---|---|---|
| `GET  /api/plugins/proxy-manager/http/proxies` | `proxies` | `script.view` | default |
| `POST …/http/start/<id>` | `start` | `plugin.runtime` | default |
| `POST …/http/stop/<id>` | `stop` | `plugin.runtime` | **135,000 ms** |
| `POST …/http/restart/<id>` | `restart` | `plugin.runtime` | default |
| `POST …/http/reset-failover/<id>` | `reset-failover` | `plugin.runtime` | default |
| `GET  …/http/logs?proxy=&cursor=&limit=` | `logs` | `script.view` | default |
| `POST …/http/apply` | `apply` | `device.network` | **180,000 ms** |

### 11.1 Why the id is in the path and not `proxies/:id/start`

The core takes the **first path segment after `/http/`** as the handler id and hands the rest to the
handler as `request.path`. A registration therefore owns a whole subtree, so `proxies` and
`proxies/:id/start` cannot be two registrations — and one registration for all four would mean **one
permission** for the list and the three actions, collapsing the `script.view` / `plugin.runtime`
split.

The audit log decided the shape between two options that both worked: `plugin.http` records
`target: '<plugin>/<handlerId>'` and the method, and **never the sub-path or the body**. A single
handler would leave every start, stop and force-stop as one indistinguishable row. With a handler
per verb the audit says *which verb*; *which proxy* is in this plugin's own log, tagged with that
proxy's subject.

### 11.2 Why `plugin.runtime` and not `plugin.data`

`plugin.runtime` is the farm's existing answer to *may this person start and stop a plugin's
long-lived half* — the same permission `POST /api/plugins/:name/runtime/restart` requires — and
starting a bridge is that act one bridge at a time. It is deliberately not `plugin.data`: the
operator is not editing a record, they are changing what is listening on the machine.

Both are in the operator set today, so the split refuses nobody anything **yet**. It is written down
anyway, because a read gated on a write permission is a fixture nobody notices until roles narrow.

### 11.3 CRUD deliberately does **not** live here

Creating, editing and deleting a record stays on `PUT`/`DELETE
/api/plugins/proxy-manager/data/entry` — the operator-facing `plugin.data` door that already audits
every write as `plugin.data.set`/`plugin.data.delete` and takes the namespace from the URL
server-side. A second write path would be the weaker parallel one 00-overview §4.3 forbids.

The shortcut this replaced was **refused rather than built**: the screen writing `enabled: true` into
KV and the service polling its own namespace every couple of seconds. A `list()` per tick is a real
cost in the core's own event loop.

### 11.4 Refusal shapes

- The **six questions** plan 109 step 109.6 asks (including *is the service running* **before** it
  looks for a handler, so a request to a stopped service refuses as *not running* rather than 404ing
  as if the screen had never existed) are already applied before a byte of `handlers.ts` runs.
  Re-deriving any of them here is how the two come to disagree.
- An unknown proxy id answers **404** with `{ ok: false, code: 'E_PROXY_UNKNOWN', message }` — a 404
  about a *record*, not about a route.
- The logs route, when the host has no log store wired, answers **503** with the farm's own
  `{ error: { code, message } }` envelope — **not** the flat `{ ok, code, message }` form. Step
  112.10 found the flat form on the screen, where the operator got a bare *"Request failed (HTTP
  503)"* and both the code and the sentence were dropped on the floor. It must **not** answer an
  empty page: `lines: []` would render *"this proxy has logged nothing"*, a different and false
  claim.

---

## 12. The screen (tier C)

`surface.views.proxies.react = { entry: 'index.js', apiVersion: PLUGIN_UI_API_VERSION }`.
`enkaku publish` builds `src/ui/index.tsx` → `ui/index.js` and `src/ui/index.css` → `ui/index.css`
inside the `.enkaku` package; Studio links the stylesheet **before** the script. `apiVersion` is read
from `@enkaku/protocol` rather than typed as a literal, because this pack lives in the repo and is
rebuilt with the farm; verify refuses a mismatch naming both numbers.

A module served to Studio does not *export* its component — it **registers** it:
`window.__enkaku__.register('proxies', ProxyManagerView)`, because a `<script type="module">` has no
return value.

### 12.1 Four things it leans on

1. **Hooks, in a plugin.** They run on **Studio's own React instance**, handed over by the import
   map. A second copy would throw `Invalid hook call` at the first one.
2. **`@enkaku/ui` is the host's *live* components, not lookalikes** — so the screen picks up Studio's
   next change on the day Studio does. Since plan 111 §3.3 it also carries the behaviour layer this
   pack used to hand-write: `api()`, `coreBase()`, `EmptyState`/`ErrorState`/`LoadingRows`,
   `relativeTime`, `useAction`, `z`, and `PluginViewProps` itself.
3. **The tab lives in the URL.** Three independent keys — `tab`, `q`, `proxy` — with patch
   semantics: writing one never has to know about the others, and a row's *Logs* button writes two
   in one patch. There is **no `useState` for the tab**: `params.tab` is read straight from the
   query, so a reload, a Back and a pasted link all land in the same place.
4. **Its own stylesheet**, for two classes Studio has never compiled
   (`bg-[repeating-linear-gradient(...)]` and `grid-cols-[max-content_1fr]`) — chosen so they fail
   **visibly** (a flat panel, stacked fields) rather than subtly if the link never happens.

`index.css` uses `@import 'tailwindcss/theme.css' theme(reference)` and
`@import 'tailwindcss/utilities.css' layer(plugin)`, plus `@enkaku/ui/theme.css` as a reference.
**Never `@import 'tailwindcss'`** — that pulls in preflight, a *global* reset, which would restyle
every other screen in the farm. Publishing refuses a stylesheet containing it. `theme(reference)`
registers the tokens so `bg-surface` compiles without writing a `:root` block, so Studio's live
values keep winning and a plugin can never repaint the farm with a palette frozen on its build day.

Every width decision uses **`@container`, never a viewport breakpoint** — this screen does not know
how wide its box is, and a `lg:` would fire on the *window*. Column widths are container-conditional
too, because a `w-56` is a *preferred* width a browser will not shrink below in an auto-layout
table, which is what pushes a table past the edge at 360 px.

### 12.2 The four tabs

**Catalogue** — the table, four independent reads, each allowed to fail on its own:

| read | prefix | on failure |
|---|---|---|
| the records | `proxy:` | fails the tab (there is nothing to draw) |
| the runtime (`…/http/proxies`) | — | a **note**, not an ErrorState: rows read `Unknown`, records stay editable |
| which records have a credential | `proxy-secret:` | silent — the dialog just says nothing about a stored password |
| the last observed egress | `proxy-probe:` | silent — rows read `unverified`, which is honest either way |

The credential read is *the whole of what a browser may know about a stored password*, and it is a
property of the store rather than of this code: `list()` never decrypts, so `value` is `null` on
every one of those rows, and `hint: false` leaves `hint` null too. There is no shape of that request
that could return more.

Three doors, all beside each other because the owner asked for all three: **Add proxy** (one record,
field by field), **Paste list** (a provider's list, four shapes, previewed and correctable), and
**Generate range** (a label pattern, a starting port, a starting IPv4, a count). None replaces
another; **nothing any of them creates is ever enabled** — each one is started from the catalogue,
deliberately.

Polling: `1500 ms`, and **only** while something is genuinely in flight — a row `starting` or
`stopping`, or a record currently on a backup upstream. A settled catalogue is not polled. The
skeleton is for the **first** load only; a reload keeps the table on screen, because replacing rows
an operator is watching with grey blocks twice a second is how a working screen looks broken.

**Assignments** — every device joined to whether it holds `assigned`, in **one** statement via
`GET …/data/scan?key=assigned` (a device with no note joins to nulls and reports `entry: null`
rather than dropping out). Listing devices and reading a key each would be the N+1 that route exists
to prevent. Both the mode chosen per row and the last Apply outcome are **in memory and never
stored**: the durable answer to *"what is this phone set to"* lives on the device's own Network
panel, and persisting either here would be a lie the moment it was read. Changing the mode drops the
last outcome, because an *"applied as HTTP proxy"* line under a picker now reading VPN is a sentence
about a different act.

The default mode is **`http`**, for one reason and not taste: it is the mode that keeps the upstream
account on this machine. A default that sent a saved password to a phone the first time somebody
pressed a button they had not read about would be the credential decision made *for* the operator.

**Logs** — one stream, filtered **by the farm**. `?proxy=` carries the record's **bare id** and the
handler prefixes it into the tag; sending the tag from the browser would mean two places deriving
one string, and the failure when they drift is silent in the worst way: no line matches, and the
view is *permanently and honestly empty*. There is deliberately **no client-side predicate** over a
fetched page — it would look identical and be wrong, since that page has already had the quiet
proxy's lines evicted and would report neither.

**Runs** — this pack's jobs. **Filtered in the browser, and that is a real limit stated rather than
hidden**: `GET /api/jobs` takes `deviceId`, `status` and `rootJobId` and has no script or plugin
filter, so this reads one page of 100 and keeps `scriptName` starting `proxy-manager/`. The caption
says what was actually searched.

### 12.3 The read/write funnel

Every read goes through `readProxy` and every write through `writeProxy`, both thin wrappers over
`shared.ts`. The **two writes are ordered, and the order is a decision**: the record first, because
a record whose credential write then failed dials without a password and fails visibly on its own
row — the other order would leave `proxy-secret:<id>` attached to a record that does not exist,
invisible in a catalogue that lists only `proxy:`, and silently inherited by the next record that
derives the same key. A credential failure is reported **separately** (*"The record was saved and
its password was not"*), because *"could not save"* over a record that **was** saved is the message
that makes an operator press Save again and change nothing.

A delete takes **both** keys, for the same inheritance reason; the credential delete is allowed to
fail quietly.

`putSecret`/`putSecretSlot` are **functions, not two lines at each call site**, precisely because
`secret: true` and `hint: false` travel together and neither is sticky — the store recomputes both
from the options of the write in front of it, so a later write that omitted `hint` would quietly
restore the leak on a key that had never had one.

### 12.4 The storage key is derived, not typed

`deriveProxyKey(name, taken)` slugs the name (`PROXY_SLUG_MAX = 64`), falls back to `untitled`, and
suffixes on collision — so two proxies both called *"SOAX Japan"* do not become one row. Four
separate sentences cover the four states: derived, collided, taken (blocks Save), and **locked**
(`kv.set` upserts and cannot *move* an entry, so an edit must never offer a rename).

Version 0.5.1 was a patch for exactly this: the derived key rendered `proxy:untitled` over an empty
Name field, advertising the slugs-to-nothing fallback as the plan. *Caught by rendering the dialog,
not by a test.*

### 12.5 The paste parser

Four shapes, listed on screen:

```
scheme://username:password@host:port
username:password@host:port
host:port:username:password
host:port
```

**Hand-written, not `new URL()`**, for two non-stylistic reasons: three of the four shapes have no
scheme, and `new URL()` splits userinfo at the *first* `:` and the *last* `@` of its own accord — so
a password holding an unencoded `@` or `:` (which a provider's generated password routinely does)
goes through the URL parser as part of a hostname and comes out as a **different proxy** rather than
as an error. (The pack is also bundled separately, so importing Studio's own parsers is not
available even where it would be right.)

`a:b:c:d` is genuinely ambiguous, and the answer is a rule **stated on screen** rather than a guess:
**the second field must be a port number.** Everything after the fourth field belongs to the
password. Three fields are refused outright rather than guessed. IPv6 must be bracketed.

And nothing here is trusted to be right: the preview shows every line as it was read — **with the
password masked** — for the operator to correct before anything is written. *A parse somebody can
see beats a cleverer one they cannot.* `index.test.ts` asserts that no parse refusal ever quotes the
line it refused, and that a password never reaches a preview, a name, or a parse failure.

---

## 13. Log and error discipline

### 13.1 One ring, tagged — never one ring per proxy

The farm keeps **one bounded ring per plugin** with every line optionally carrying a `subject`, and
`ctx.logs.page({ subject })` filters **server-side**. N rings for N proxies would be core memory
scaling with a list an operator edits, and a deleted proxy would take its own history away at
exactly the moment somebody wanted to know why it was deleted.

The cost is real and is **stated on the screen rather than discovered**: a busy proxy evicts a quiet
one's lines, and `PluginLogPage.truncated` is what stops that reading as *"this proxy did nothing"*.

`proxySubject(id)` = the storage key, clamped to **64 characters** — the same
`PLUGIN_LOG_MAX_SUBJECT` the core stores, restated rather than imported (a plugin should not grow a
dependency on the core for a number) with the drift hazard spelled out: the core trims what it
stores, so an untrimmed filter would miss every line of a long-keyed proxy, silently.

### 13.2 What a line records — and what it never does

| event | level | fields |
|---|---|---|
| `accepted` | debug | — |
| `upstream-connected` | debug | `destPort`; `destHost` **only** when `logDestinations` is on |
| `closed` | debug | `durationMs`, `bytesUp`, `bytesDown` |
| `refused` | warn | `reason`, `code`, `destPort`, `destHost` (same condition), `clientAddress` for an auth refusal |
| `start` / `restart` | info | — |
| `listening` | info | `port`, `listen`, `upstreamProto`, `upstreamHost`, `upstreamPort` |
| `start-refused` | warn | `code`, `message` |
| `start-failed` | error | `code`, `message`, `port` |
| `drain` | info | `live`, `drainMs` |
| `stop` | info | `forced`, `port` |
| `teardown` | info | `port` |
| `service-started` / `service-stopped` | info | **untagged** — they belong to the supervisor, not to any one proxy |

Never, at any setting: the upstream **password** (never passed to a log call at all, by
construction), the upstream **username** (not because it is a credential, but because it has not
been *decided* to be one — the owner's own example encodes an exit country and a sticky-session id,
and the narrower default is the one that can be widened later without re-reading old files), a
**path**, a **query string**, a **header**, a **byte of payload**, or a submitted **listener
credential** in any form.

A destination **port** is always recorded: it distinguishes *"TLS to something"* from *"plain HTTP
to something"*, which is not a browsing record, and without it a refusal is nearly undebuggable.

`LOGS_CONTENT_NOTE` states all of that on the screen, and `logbook.test.ts` asserts it against the
field allowlist — *it is a promise about the code, so it is tested, not merely written on a screen.*

`loggerFor(entry)` is built from the **current** record on every use, never cached: a cached logger
would keep writing destination hosts for as long as the process lived after an operator turned the
switch off — the setting nobody would think to re-check.

### 13.3 `errors.ts` — re-word, never re-throw

**A dialler's error is the single most likely place a credential leaks into something a person
reads.** `socks`'s messages are careful, but a `SocksClientError` carries the whole
`SocksClientOptions` — **password included** — on `err.options`, so anything serialising the error
*object* rather than its `message` would write the credential to a file.

So nothing from a dialler is ever re-thrown: a `ProxyError` is built fresh, from `message` only, and
`scrubSecrets` runs over the result as a second, independent net.

```ts
scrubSecrets(text, secrets)   // longest-first; skips anything under 8 chars
listenerAuthSecrets(cred)     // [password, base64("user:pass")] — both wire forms
messageOf(err)                // `message` and nothing else off a throwable
```

> **The primary defence is that no code path interpolates a password into a string.** `scrubSecrets`
> is defence in depth for the paths we do not own — *it is not a licence to interpolate one and clean
> it up afterwards.*

The 12 coded runtime errors split into upstream failures
(`UNREACHABLE`/`TIMEOUT`/`AUTH`/`PROTOCOL`/`DIAL`), bind failures
(`LISTEN_ADDR_IN_USE` — the one everyone hits — and `LISTEN_FAILED`), `CLIENT_PROTOCOL`,
`DNS_EGRESS_FAILED`, and three `GOST_*` codes.

---

## 14. Test map

19 test files, ~354 cases, all colocated. Run **only** what you touched:

```bash
bun test plugins/proxy-manager/src/service/supervisor.test.ts   # one file
bun test plugins/proxy-manager/src/service/                     # the directory you touched
```

| file | cases | what it holds |
|---|---|---|
| `index.test.ts` | 81 | the manifest, the **honesty copy** (narrowed-never-widened), the capability boundary, the surface, the CSS contract, the key derivation, the paste parser, the two forbidden-word greps with their controls |
| `record.test.ts` | 45 | the migration, the bind gate enumerated over loopback × `listenerAuth` × `hasListenerAuth`, both route modes, the closed-code-list reachability check |
| `service/supervisor.test.ts` | 31 | real sockets: start/stop/restart, the drain, `EADDRINUSE`, the auth wiring, failover snapshot + `resetFailover` |
| `service/handlers.test.ts` | 28 | the route table, permissions, the 404 shape, the 503 envelope |
| `service/listen-http.test.ts` | 19 | both request forms, the four auth behaviours, base64 scrubbing |
| `service/logbook.test.ts` | 18 | the field allowlist — so a later field cannot be added without a decision |
| `service/auth.test.ts` / `listen-socks5.test.ts` | 16 / 16 | both wire formats, method negotiation |
| `service/probe.test.ts` | 16 | the state vocabulary, three body shapes, the `https:` refusal proved never to touch the upstream |
| `service/errors.test.ts` | 14 | `scrubSecrets`/`listenerAuthSecrets`/`classifyDialError`, each with two controls |
| `service/apply.test.ts` | 13 | the capacity guard, the exclusive refusal, the re-apply case that must **not** be refused, the real port-mismatch repro |
| `service/reset.test.ts` | 12 | the four outcomes, the `setBy` check, idempotency |
| `service/dial-*.test.ts` | 27 | the literal short-circuit by contrast, the no-fallback assertion, family===0, the password-absence claims |
| `service/failover.test.ts` | 9 | inertness with no backups, the false-positive reset, the switch, failback |
| `service/relay.test.ts` / `listener.test.ts` | 4 / 1 | the idle timer, single-fire `onClose` |
| `ui/parts/catalogue.test.ts` | 4 | `stepLastOctet`'s octet-boundary refusal — a pure function proved directly, not by reading source as text |

The house pattern worth copying: **an absence claim needs two controls.** Asserting *"the password
never appears"* is vacuous unless a control proves the same detector **would** fire. Both
forbidden-word greps in `index.test.ts` carry one; so do `scrubSecrets`'s tests and the probe's
credential-absence claim.

---

## 15. Version history — and why each bump is a minor

The `version` field is not cosmetic here: it is what an operator **consents to** at install, since
the install dialog shows the plugin's title, description and declared capabilities.

| version | change | why a minor |
|---|---|---|
| 0.4.0 | `service.permissions` `[]` → `['device.list', 'device.network.set']` | a pack that quietly gained the ability to change a phone's networking under an already-approved version would make the consent screen a formality |
| 0.5.0 | first stored **credential** (`proxy-secret:<id>`) | what the operator agrees to is not only the capability list |
| 0.5.1 | patch: the derived key rendered `proxy:untitled` over an empty Name field | *caught by rendering the dialog, not by a test* |
| 0.6.0 | Apply grew VPN mode | permissions unchanged, but a pack that can now **send a stored password to a phone** is not doing what was approved at 0.5.x |
| 0.8.0 | `resetData` declaring `device.network.clear` | a scoped grant is still a grant, and it appears in its own list on the install screen |
| **0.9.0** | plan 121 failover | **not** a consent change — purely mechanical |

That last one is worth reading in full, because it is a real trap:
`packages/core/src/plugins/seed-embedded.ts` keys on `${pack.name}@${pack.version}` and **skips
restaging a version already present** in `<dataDir>/seeded-packs.json`. An install that had already
seeded `proxy-manager@0.8.0` would silently keep running the pre-121 bundle **forever** after
upgrading the binary — the new code would sit in the binary's embedded pack and never reach that
install's running plugin. `scripts/build-packs.ts` reads the version off the built bundle's
`definePlugin()` export, **never off `package.json`**, so `src/index.ts` is the one that matters
(the two are kept in sync anyway).

---

## 16. Rough edges, stated rather than hidden

1. **The README says three tabs; there are four.** `src/ui/index.tsx` declares Catalogue,
   Assignments, **Logs** and Runs. The README's table lists Catalogue, Assignments and Runs.
2. **The README's permission section omits `resetData`.** It lists the two standing capabilities and
   not the two reset-scoped ones (`device.network.get`, `device.network.clear`), which is the
   version-0.8.0 consent change.
3. **`src/index.ts`'s module header still carries a stale paragraph**: *"with no binary downloaded
   and no second process supervised"*, describing the bridge. That was true until plan 117 §12 added
   the Windows `gost` path, which downloads a pinned binary and supervises a child process. The
   `gost-*.ts` files themselves are explicit; the header is not.
4. **The same header says an upstream password "still cannot be stored at all" until step 112.2.**
   112.2 landed and the pack writes credentials with `hint: false` today — `PLUGIN_NOT_BUILT` and
   `CREDENTIAL_NOT_STORED` were narrowed accordingly, but the header paragraph was not.
5. **`capacity`/`exclusive` may still read "stored now, not yet enforced"** in `catalogue.tsx`'s
   dialog and `record.ts`'s comments. Both are false since step 117.10 — plan 117's own status block
   flags this and asks the next pass over those two files to drop both sentences.
6. **Plan 121's `proxy.failover` is not a WS message.** It rides `plugin.log`'s structured `fields`,
   and the chip is poll-fed. Deliberate, documented in `failover-chip.tsx`, and the reason is that no
   generic plugin→WS broadcast exists in the codebase.
7. **No component-rendering harness.** This pack has no `@testing-library/react` (unlike
   `packages/studio` and `@enkaku/ui`), so `GenerateDialog`'s *"writes exactly the rows shown in the
   preview"* is exercised by the manual sequence in plan 117 §7, not by a test. Plan 121's UI
   (`upstream-fields`, `backup-upstreams`, `failover-chip`) has no unit tests at all — an explicit
   owner instruction; it was verified by typecheck and a manual trace.
8. **Two coded refusals are unimplemented-by-choice, not missing.** An HTTPS *listener* would need a
   certificate the farm cannot issue for a plugin; an HTTPS *upstream* is one `tls.connect` away and
   is refused only because no case for it has been named, and *an untested path that carries a
   password is worse than an honest refusal*.
9. **Absolute-form HTTP proxying rewrites only the first request line** (§6.3). `gost` does the
   same; fixing it means building a real HTTP proxy.
10. **The catalogue's filter box is a client-side `includes` over one page of 200**, and its
    placeholder says so rather than implying a search of the whole namespace.
11. **Bun version sensitivity, recorded because it cost a CI cycle.** Bun 1.4.0 regressed ordinary
    `node:net` usage — `.end(data)` followed by `.destroy()` against a peer that never drains leaves
    the peer's socket stuck forever, where 1.3.14 closes it in 3 ms. That is exactly the shape
    `listen-http.ts`'s `onFailure` has used correctly for years. The workspace pins
    `bun-version: '1.3.14'` on every `oven-sh/setup-bun@v2` step in `ci.yml` and `release.yml` with
    the reasoning at each site, so a future bump is a deliberate, re-verified decision.

---

## 17. Where to go next

| you want to… | read |
|---|---|
| understand `definePlugin` / `defineService` / the surface tiers | [`docs/feat/plugin-and-script.md`](plugin-and-script.md) |
| understand the KV store's three axes and the `secret` flag | [`docs/feat/kv-storage.md`](kv-storage.md) |
| set up the physical side of `bindAddress` | [`docs/guide/install.md`](../guide/install.md) § *Egress binding: one proxy per way out* |
| understand the farm's own four network engines | [`docs/archive/overview.md`](../archive/overview.md) §11, `docs/spec.md` §9, plan 114 |
| understand the guest agent's SOCKS5 full tunnel | [`apps/guest-agent/README.md`](../../apps/guest-agent/README.md), [`docs/research/android-guest-agent.md`](../research/android-guest-agent.md) |
| read the design record | plans [112](../archive/plans/112-m77-proxy-manager.md), [114](../archive/plans/114-m79-device-proxy.md), [117](../archive/plans/117-m82-egress-binding.md), [118](../archive/plans/118-m83-windows-adb-performance.md), [121](../archive/plans/121-m86-proxy-failover.md) |
| use the pack as an operator | [`plugins/proxy-manager/README.md`](../../plugins/proxy-manager/README.md) |
