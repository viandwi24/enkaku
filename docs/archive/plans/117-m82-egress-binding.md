# Plan 117 — M82 : egress binding — a proxy record that chooses which way out

> Status: partial — **117.1–117.11 are all built now; two gaps remain, named below, and neither is 117.11's own unit-test pass.** 117.1–117.4: the record's five new fields and their migration, `dial-direct.ts` with the resolver, `createUpstream`'s third branch, and the two `bindAddress` problem codes wired into `validateProxyRecord` and into `supervisor.ts`'s two call sites. 117.5: the screen's `direct` fields and range generator. 117.6: `service/auth.ts`, both listener wire formats, and `supervisor.ts` reading `proxy-auth:<id>`. 117.7: the loopback rule in `validateProxyRecord` made conditional on a saved listener credential (`E_PROXY_LISTENER_AUTH_REQUIRED`/`_MISSING`), replacing the unconditional `E_PROXY_BIND_NOT_LOOPBACK`. 117.8: `vpnRouteForRecord` branches on `upstream.proto`, pointing a `direct` record's VPN route at its own bridge (`directVpnRouteForRecord`, `E_PROXY_VPN_BIND_UNSPECIFIED`) and `apply.ts` reading the listener credential from `proxy-auth:<id>` for it. **117.10 is built**: `apply.ts` counts the devices currently noted against a record through the device-scoped `assigned` key (reading each device's own row directly — the operator-facing `GET …/data/scan` route needs a browser session this service call does not have — rather than a second capability) and refuses `E_PROXY_CAPACITY_FULL` over `capacity` or under `exclusive`, naming the count and the devices, for both apply modes alike (§9 Q1) and without penalising a re-Apply of a device that already holds the record; `assignments.tsx` shows the count against the limit per catalogue entry, in the picker and under the noted row. `E_PROXY_CAPACITY_FULL` **is now in** `shared.ts`'s `PROXY_PROBLEM_CODES` (it was added, by the time 117.11 read this file, by whichever of 117.9/117.10's sessions next held `shared.ts` — the array's own comment beside it names `apply.ts`'s capacity guard as its producer). Documentation landed alongside it: `docs/guide/install.md` gained "Egress binding: one proxy per way out" (Linux/Windows recipes, counted audits, linking `docs/tmp-try-arch-mikrotik.md` rather than copying it); `plugins/proxy-manager/README.md` (new) and its `package.json` description now cover the `direct` upstream, `bindAddress`, `resolveThroughEgress`, and the VPN-credential trade-off; this document's own §9 gained the JSON-shape row for plan 117's five fields. **One thing 117.10's own paragraph asked for was left undone, and is flagged rather than silently skipped**: `catalogue.tsx`'s dialog still reads "stored now, not yet enforced" beside `capacity`/`exclusive` (and `record.ts` carries the same "stored; enforced in step 117.10" comment) — both now false, and both sit in files this pass was told another worker owns concurrently (`catalogue.tsx`, `record.ts`). Whoever lands 117.9 or takes the next pass over those two files should drop both sentences. `bun run typecheck` is clean for `plugins/proxy-manager` (`packages/core` is separately mid-edit by another session, unrelated to this plan).
>
> **117.11 is now built — the verification pass.** Every unit case §7 asks for is written and green: `record.test.ts` (the migration, both `bindAddress` codes, the bind-gate invariant enumerated over loopback/off-host × `listenerAuth` × `hasListenerAuth`, `vpnRouteForRecord` for a vendor and a `direct` record including its three refusals, the closed-code-list reachability check extended for plan 117's eight new codes), `service/apply.test.ts` (new — the capacity guard, the exclusive refusal, and the re-apply case that must NOT be refused, which is `E_PROXY_CAPACITY_FULL`'s own reachability proof, absent from `record.test.ts`'s pure-function check because its producer needs an `ApplyHost`), `service/dial-direct.test.ts` (new — the literal short-circuit proved by contrast against a `127.0.0.1` `bindAddress` that provably cannot resolve any hostname, criterion 4's no-fallback assertion, the connect timeout against an RFC 5737 address measured to hang rather than refuse in this environment, and the family===0 defensive throw), `service/auth.test.ts` (new — both wire formats in isolation), `service/errors.test.ts` (new — `scrubSecrets`/`listenerAuthSecrets`/`classifyDialError`, each with the two controls), `service/probe.test.ts` (new — `probeUrlFromEnv`, the state vocabulary, a successful parse and its three body shapes, a non-2xx failure, a timeout, the `https:` refusal proved never to touch the upstream, and the credential-absence claim with its positive control), and new auth-wiring tests added to `listen-socks5.test.ts`, `listen-http.test.ts` (criterion 6's four client behaviours, plus the base64-scrubbing test) and `service/supervisor.test.ts` (a new describe block: `listenerAuth` + a saved `proxy-auth:<id>` row lets a non-loopback bind actually start, its absence refuses with `E_PROXY_LISTENER_AUTH_MISSING` even on loopback, and the credential genuinely reaches the listener rather than being read and discarded). `plugins/proxy-manager/src/ui/parts/catalogue.tsx`'s own `stepLastOctet` was exported (a one-word, behaviour-preserving change) so `ui/parts/catalogue.test.ts` (new) could prove the octet-boundary refusal directly rather than by reading the file as text.
>
> **The retired-code fallout named in this plan's own prior status is fixed**: `record.test.ts` and `service/supervisor.test.ts` no longer assert `E_PROXY_BIND_NOT_LOOPBACK` anywhere; both now assert `E_PROXY_LISTENER_AUTH_REQUIRED` (or `_MISSING`, where that is the actually-true code), and `record.test.ts` gained the criterion-5 invariant test rather than one example. **117.11 also found and fixed two pieces of drift `index.test.ts` had never been run against since 117.4 and 117.8 landed** — not part of the named fallout, but the same class of thing: a source-anchored regex expecting `const incomplete = effectiveKey.trim()…` on one line, broken across two lines by 117.4's own reformatting of the `direct`-upstream relaxation; and a regex expecting `mode === 'vpn' ? await readPassword` verbatim, which 117.8 restructured into a nested `isDirectUpstream` branch. Both assertions are now tolerant of the actual, current shape while still proving the same invariant.
>
> **Two gaps are named rather than rounded up to done, and neither blocks calling 117.1–117.11 built:**
>
> 1. **Criterion 11's first half — "the generator writes exactly the rows shown in its preview" — is not tested.** The octet-boundary refusal (the criterion's second half) is, directly, against the real `stepLastOctet`. But `GenerateDialog`'s own `create()` closes over `useState`/`useMemo` and this pack has no component-rendering test harness (no `@testing-library/react`, unlike `packages/studio`/`@enkaku/ui`, and building one for a single dialog was judged out of scope for a verification pass rather than a feature step). The manual sequence in §7 exercises this by hand.
> 2. **117.9's own open question — does the `https:` probe-URL refusal need a follow-up plan for real TLS?** No. `service/probe.test.ts` now carries the test 117.9's paragraph asked 117.11 to decide on (`an 'https:' probe URL is refused BY NAME … and the upstream is never dialled at all`), so the missing piece named at the time — "a test asserting the refusal" — now exists. Building `node:tls` over a raw `Upstream` socket remains out of scope: no code in this workspace speaks `node:tls` today, `packages/probe-server`'s own README defaults to plain HTTP for exactly this round trip, and nothing in the spec's §7.9/§4.3 asks for an encrypted probe leg. If an operator's probe endpoint is ever required to be HTTPS, that is a new, small, separate plan — not a gap this one leaves unaddressed.
>
> **Manual verification (§7's own hardware sequence) has not been run** — it is explicitly the owner's next step, on real hardware, through Studio in a real browser, and no automated pass can stand in for it.
>
> **117.9 is now built**: `src/service/probe.ts` (new) dials `ENKAKU_NETWORK_PROBE_URL` through the record's own `Upstream` — the same object `startLocked` hands to the listener — with a hand-rolled `GET`/status-line/`Content-Length` reader in the same shape `dial-http.ts`'s CONNECT reader already uses, so no HTTP client dependency was added. It is **plain-HTTP only**: an `https:` probe URL is refused by name (`the probe endpoint must be plain http — …`) rather than either sent in the clear or silently failing a TLS handshake this file does not speak — `packages/probe-server`'s own README already defaults to plain HTTP for this exact round trip, and nothing in §3.7/§4.3 asked for TLS over a raw `Upstream` socket, so this is a scoping call rather than a gap, flagged here for 117.11 to decide whether it needs a test asserting the refusal or a follow-up plan. `supervisor.ts` schedules it itself (`scheduleProbe`/`runProbeSweep`, a self-rescheduling `setTimeout` chain rather than `setInterval`, so overlapping sweeps cannot interleave writes to the same rows), on a 5-minute base interval with ±20% full jitter (`PROBE_INTERVAL_MS`/`PROBE_JITTER_FRACTION`, both overridable via a new `SupervisorOptions.probeIntervalMs` for 117.11), skips any record whose runtime state is not `running`, and writes `proxy-probe:<id>` through a new, **optional** `SupervisorHost.storage.global.set` (optional so the existing test fixtures in `supervisor.test.ts`, which this pass does not touch, keep typechecking unchanged — a missing `set` just means the write is skipped, the same fail-open shape `readPassword`/`readAuth` already use for a missing read). The vocabulary is in `shared.ts`, imported from plan 51 rather than reinvented: `ProxyProbeResult`, `PROXY_PROBE_SKIP_REASON` (word-for-word the sentence `packages/core/src/network/route-checks.ts` already uses for the same unset env var), `ProxyProbeState` (`unverified` | `skip` | `confirmed` — `confirmed` rather than `verified`/`ok`/`success`, so criterion 10's grep has nothing to catch), `proxyProbeState()` and `readProxyProbe()`. The catalogue table gained an `Egress` column (`@5xl` breakpoint, a local `ProbeCell` beside the existing local `StateCell`) showing the state badge, the observed address and latency when `confirmed`, the failure reason when `unverified` with one, and `checked-at` always — no wording on it reads `ok`/`routed`/`verified`/`success` for anything short of `confirmed`. The Upstream column's own 117.5 leftover bug is fixed the way this step's own paragraph specified: `describeDirectUpstream` moved from `service/upstream.ts` to `shared.ts` (which imports nothing, so the browser half can read it too), with `service/upstream.ts` re-exporting it unchanged so `dial-direct.ts`'s existing import keeps working untouched. **Also fixed, per 117.10's own flagged note above**: `catalogue.tsx`'s Capacity/Exclusive help text no longer says "stored, not yet enforced" — `record.ts` still carries that sentence and was left alone, since it is on this pass's do-not-touch list. `bun run typecheck` is clean for `plugins/proxy-manager`; no test was written or run, deliberately, per this plan's own "tests are 117.11" rule.
>
> 117.4's own correction, made rather than quietly worked around: this step's paragraph says `direct` *"stops requiring `host`/`port`/`username`"*, and **there was no such requirement to relax**. `validateProxyRecord` and `ProxyUpstreamSchema` never demanded those fields; the only two places that do are `catalogue.tsx`'s Save gate (a UI concern, 117.5) and `vpnRouteForRecord`'s VPN-mode `E_PROXY_VPN_UPSTREAM_INCOMPLETE` (117.8, and §4.2 already records that relaxation separately). Nothing was invented in order to relax it.
> Depends on: plan 112 (M77) — the proxy-manager pack, its record shape, its supervisor, its two listeners and two diallers, and the `Upstream` interface this plan adds a third implementation to. Plan 114 (M79) — the two device rungs (`adb-reverse-proxy`, `vpn-helper`), `device.network.set`, and dual-mode Apply. Plan 111 (M76) — the React screen this plan extends. Plan 108 (M73) — plugin KV, secret rows, and device-scoped keys. Plan 51 (M24b) — named checks, `deriveHealth`, and the vocabulary that forbids wording `unverified` as success.
> Spec references: §7.9 (the network layer and its three-rung ladder), §11 (advisory versus enforcing rungs), §19 (Studio screens)
> Ships: plugins/proxy-manager/src/service/dial-direct.ts, plugins/proxy-manager/src/service/auth.ts, plugins/proxy-manager/src/service/probe.ts

---

## 0. Evidence

### 0.1 The owner's words

The scope of this plan was set by one correction, kept verbatim because the whole design turns on it:

> *"masalahnya itu disini, plugin proxy manager yang kita bikin kan harus bisa generic, jadi ga cuman specific buat kita aja … di proxy manager codenya kan ga langsung anda tulis spesifik misalnya untuk ip a ip b kan ga gitu, yah dibuat generic, hal hal spesifik harus dibuat flexibilitas biar dipakai orang bisa juga tinggal enable atau tinggal custom ip nya aja misalnya."*

An earlier draft of this work (`refs/tmp-proxy-enggress-mikrotik.md`) proposed a `modem-manager` pack that knew about MikroTik, VLANs 101–120, and the subnet `192.168.100.0/24`. That document is superseded by this plan for two reasons: it duplicated a supervisor, a catalogue, a credential store, an assignment model and a screen that already exist, and it wrote a site's topology into first-party code. **No string in this plan's code says modem, VLAN, MikroTik, or any address.**

### 0.2 What the substrate actually does today, read off the code on 2026-08-18

- `plugins/proxy-manager/src/service/upstream.ts:83` — `createUpstream()` has exactly two branches, `socks5` and `http`, behind a two-method `Upstream` interface. An upstream is currently **always another proxy**; there is no way to say "dial the destination yourself".
- `plugins/proxy-manager/src/service/supervisor.ts:299` builds the upstream and hands it to `createSocks5Listener`/`createHttpListener` through one options object (`supervisor.ts:307`). The listener never learns what the upstream is. **This is the seam this plan uses, and it needs no change.**
- `plugins/proxy-manager/src/shared.ts:615` refuses any `bindHost` outside `LOOPBACK_BIND_HOSTS`, with the correct reason stated in the message: an unauthenticated proxy reachable off-host is an open relay.
- `plugins/proxy-manager/src/service/listen-socks5.ts:17` states, as a decision rather than an omission, that **there is no listener-side authentication in v1** — the greeting handler offers `METHOD_NO_AUTH` and nothing else (`listen-socks5.ts:169`, `:181`).
- `plugins/proxy-manager/src/shared.ts` `vpnRouteForRecord` hands the phone **the record's upstream address**. For a record whose egress is the farm's own machine there is no upstream address to hand over, so VPN mode needs a second shape (§3.6).
- `packages/drivers/src/network/guest-agent/vpn-helper.ts` contains **no `adb reverse` path** (grepped: no `reverse`, no `127.0.0.1`, no `localhost`). A phone in VPN mode dials the SOCKS5 address over its own network. LAN reachability is therefore a precondition of the enforcing rung, not a convenience.

### 0.3 Measured, not assumed — Bun, on this machine, 2026-08-18

Two facts the design depends on, each checked by running it rather than by reading a doc:

1. **`net.connect({ localAddress })` binds and connects under Bun.** A loopback dial with an explicit `localAddress` connected and reported that address back on `socket.localAddress`.
2. **`dns.Resolver#setLocalAddress` is a real bind under Bun, not a stub.** With `setLocalAddress('0.0.0.0')` a query resolved normally; with `setLocalAddress('192.0.2.99')` — an address the host does not own — the same query failed with `queryA ECONNREFUSED`. A no-op implementation would have resolved both. This is what makes §3.4 buildable rather than aspirational.

Note the calling convention found while measuring: the callback-style `dns.Resolver` refuses a promise-less call (`The "callback" argument must be of type function`). Use `node:dns/promises`'s `Resolver`.

### 0.4 The operational evidence, from the farm this was prompted by

`docs/tmp-try-arch-mikrotik.md` records a working per-device policy-routing setup and, in its §4, the bug that setup produces: a routing rule keyed on a **device's** source address drags that device's *entire* traffic into a table that holds only a default route to the WAN — including the replies to ADB, which then leave through the wrong path and drop the connection. It was fixed with exception rules for the management and intra-subnet destinations, and those exception rules must grow with every new management subnet.

The design in this plan does not need them: rules key on the **host's** source addresses, which are static, and no device address is ever policy-routed. Device traffic — adb, video, the guest agent's own control channel — is untouched. This is a structural property, not a mitigation.

Two further findings from that document shaped decisions here:

- **Finding #10** — 41 DHCP leases all named `Galaxy-Z-Flip4`, and a device believed to be #15 turned out to be #40. An identity bridge built on IP addresses is fragile. Enkaku keys on `stableId` and this design keeps IP out of the identity path entirely.
- **Finding #6** — a DHCP network served an empty `dns-server`, so packets flowed while names did not resolve. Name resolution has its own path, separate from the packet path. §3.4 is the consequence.
- **Finding #2** — a pasted command block silently lost its first line, twice, caught only by `count-only` audits. This is why §3.3 refuses to let the plugin write router configuration.

---

## 1. Goals

1. A proxy record can name a **local source address to bind outgoing connections to**, so a host with more than one way out can offer one proxy per way out. The mechanism is `net.connect({ localAddress })` and nothing else; what that address means physically is the operator's business.
2. Name resolution for such a record can follow the same path as its packets, and when it cannot, the record says so rather than resolving quietly through the host's default route.
3. A record can be reached **off-host** — by phones in VPN mode — and that is possible only for a listener that authenticates. The existing loopback rule is not relaxed; it is made conditional on the thing that made it necessary.
4. A record reports the **public address actually observed through it**, and reports `unverified` until it has.
5. Twenty such records can be created without twenty rounds of typing, from a stated pattern with a preview.
6. An assignment can be refused when a record is already carrying as many devices as it should.
7. Nothing in `plugins/proxy-manager` learns anything about any particular network. A farm with twenty LTE modems and a workstation with two NICs use the same fields.

## 2. Non-goals

- **Any router integration.** No RouterOS, no REST client, no route-flag polling, no rule auditing. §3.3 gives the reason, and §9 Q3 records what would have to be true for that to change.
- **Writing the host's addresses.** The plugin reads `os.networkInterfaces()` to *check* an address exists; it never adds one.
- **Replacing per-device policy routing.** A farm already steering devices by router rule keeps doing so; the two mechanisms are disjoint by source address and may coexist indefinitely.
- **Rotating an egress** (power-cycling a link, re-dialling a modem). Out of scope; noted in §9 Q4.
- **Automatic failover between records.** Moving a device's egress under a running automation is not always wanted, and the honest version of it needs health history this plan is only starting to collect.
- **An HTTPS listener.** Still refused, unchanged, for the reason `E_PROXY_LISTEN_UNSUPPORTED` already gives.

---

## 3. Context and design decisions

### 3.1 The concept is `bindAddress`, and it is not a farm feature

The generic statement of what the farm needed is one sentence: *when this record dials out, bind the outgoing socket to this local address.* That is what `curl --interface` exists for and what a dual-homed server has always needed. It is expressed here as a third value of the upstream protocol — `direct` — plus one field:

```
upstream: { proto: 'direct', bindAddress: '192.168.100.11' }
```

Three consequences worth stating because they are what makes it generic rather than merely renamed:

1. **`bindAddress` may be empty**, and an empty one means *"dial out however this host normally would"*. That makes `proxy-manager` useful to somebody with no proxy account at all: a plain local bridge a device can be pointed at. The feature widens the pack's audience instead of narrowing it.
2. **`direct` needs no upstream host, port, username or password.** The validation in §4.2 relaxes precisely those requirements for this protocol and tightens one of its own.
3. **The word for the field is `bindAddress`, not `egressIp`.** It names what the code does (`localAddress` in Node, `--interface` in curl); `egressIp` names what an operator hopes it produces, which is the observed public address — a different value, reported separately by the probe in §3.7.

### 3.2 This is an extension of `proxy-manager`, not a sibling pack

A separate pack would have to rebuild the supervisor (`supervisor.ts`, 518 lines), the catalogue with its derived keys and migration, the secret-row handling, the device-scoped assignment key, dual-mode Apply with its capability call and its audited principal, and a four-tab React screen — roughly 12 000 lines of already-working code, for the sake of a third `Upstream` implementation.

The `Upstream` interface (`service/upstream.ts`) is the seam, and it was already drawn correctly: `{ description, connect(dest) }`. A `direct` upstream satisfies it without any listener, relay, supervisor or log change.

### 3.3 The plugin never writes to a router, and never reads one either

Making the host's source addresses map to physical links is the operator's job, done once, in whatever their infrastructure is: static routing rules, source-based routing, separate NICs, VRFs, WireGuard tables. The plugin's contribution is that this mapping is **write-once** — it keys on host addresses, which do not change when a device is added, removed, re-imaged or re-leased.

Reading the router is refused for a sharper reason than vendor-neutrality: **the egress probe (§3.7) already answers the question that matters.** A router's route-health flag says a gateway answers pings. It cannot say which public address a connection through that path comes out of, which is the only fact an operator of this feature actually needs, and which is exactly what the probe measures. Route polling would add diagnosis speed, not truth, and it would cost a vendor client, a credential store, a permission surface, and a screen.

The evidence in §0.4 finding #2 argues the same way from the other side: router configuration is where a silently-dropped line goes unnoticed for hours. It should be applied by a person who then audits it, and the audit should be a count, as it already is.

### 3.4 DNS follows the packets, or says that it does not

`net.connect({ host: 'example.com', localAddress })` resolves the hostname **before** the socket is bound. The lookup therefore leaves through the host's default route, no matter what `bindAddress` says. On the farm in §0.4 that means a geo-sensitive lookup would resolve through the office ISP while the connection itself came out of an LTE link — a mismatch nothing would report.

So a `direct` record carries `resolveThroughEgress`, default **on**:

- **on** — the destination hostname is resolved by a `node:dns/promises` `Resolver` with `setLocalAddress(bindAddress)`, and the connection is then made to the resulting literal address. §0.3 measured that this bind is real under Bun.
- **off** — the host's normal resolution is used, and the record's own description says so, so a person reading the row knows which of the two they have.

Two rules that make this honest rather than merely present:

1. A resolver failure is **not** silently retried through the host's default resolver. That would produce exactly the invisible mismatch this option exists to remove. It fails, with a code, naming the resolver it used.
2. With an empty `bindAddress` the option is meaningless and is not offered.

The resolver's servers default to the host's own configured servers, which is right for the common case (a router that is also the DNS server for every path). An explicit override is §9 Q2.

### 3.5 The loopback rule is not relaxed — it is made conditional on its own premise

`shared.ts:615` refuses a non-loopback bind, and the message states the premise: *"A proxy with no authentication of its own, reachable off-host, is an open relay."* The premise is the load-bearing half. So the rule becomes:

> A listener may bind a non-loopback address **only if** the record has listener credentials saved.

Ordering matters and is not negotiable: **listener authentication (117.5) is built before the bind gate opens (117.6).** A window in which a non-loopback bind is possible without authentication is an open relay shipped to every user of the pack, not a temporary state.

Two narrower rules on top:

- `0.0.0.0` and `::` are still refused for a record used in VPN mode (`E_PROXY_VPN_BIND_UNSPECIFIED`). The route handed to a phone has to name an address the phone can dial, and a wildcard bind names none. Binding one concrete address is also the smaller exposure.
- The credential is per record. Twenty records are twenty credentials, so a credential recovered from a phone opens one egress rather than all of them, and rotation is per row.

### 3.6 VPN mode for a `direct` record points at the listener, not at the upstream

`vpnRouteForRecord` currently hands the phone `record.upstream.host:port` — correct for a vendor record, where the phone can dial the vendor itself and the bridge would only be a needless hop. A `direct` record has no such address: **this farm is the proxy**. So the route for a `direct` record is `listen.bindHost:listen.port` plus the listener credential from §3.5.

The vendor path is untouched, and that asymmetry is the design rather than a special case: the route always names *the thing that performs the egress*, which for one kind of record is somewhere else and for the other is here.

The existing trade-off statement stands unchanged and must keep being displayed: VPN mode sends a credential to the phone.

### 3.7 Health is the observed public address, and nothing weaker

Per record, on an interval, the service dials **through that record's own `Upstream`** to the farm's probe endpoint and records `{ at, ok, publicAddress?, latencyMs?, error? }`.

Vocabulary, imported from plan 51 rather than reinvented:

- A record that has not passed a probe is **`unverified`**. It is never worded as success anywhere on the screen.
- With `ENKAKU_NETWORK_PROBE_URL` unset the check is **`skip`**, never a false `ok`.
- The observed address is displayed as observed. It is not compared to anything the operator typed, because nothing they typed is a claim about it.

Dialling through the record's own `Upstream` object — the same one the listeners hold — is deliberate: it exercises the binding and the resolver, which is what can be wrong, and not the listener socket, which the supervisor's own state already reports.

### 3.8 Capacity is a property of a record, not of a topology

`capacity` (default `0` = unlimited) and `exclusive` (default false) live on the record; Apply counts current assignments through the device-scoped `assigned` key and refuses over the limit with `E_PROXY_CAPACITY_FULL`, naming the count and the devices. It is generic — a vendor plan with concurrent-session limits needs it as much as a single physical link does — and it is the one guard that stops a farm from quietly putting six devices behind one address.

### 3.9 The range generator is a generator, not a preset

Twenty rows are produced by a form that takes three patterns — a label template with `{n}`, a starting listen port, and a starting bind address — plus a count, and shows every generated row **before** anything is written, exactly as the existing paste box does. There is no button named after any hardware. Address stepping is ordinary IPv4 increment of the last octet, refused with a named message when the range would cross an octet boundary rather than guessing what was meant.

---

## 4. Technical design

### 4.1 The record

```ts
// shared.ts — PROXY_KINDS grows one value; nothing is removed
export const PROXY_KINDS = ['http', 'https', 'socks5', 'direct'] as const

ProxyUpstreamSchema = z.object({
  proto: z.enum(PROXY_KINDS).default('socks5'),
  host: z.string().max(200).default(''),          // ignored when proto === 'direct'
  port: z.number().int().min(0).max(65_535).default(0),   // ignored when proto === 'direct'
  username: z.string().max(200).default(''),      // ignored when proto === 'direct'
  bindAddress: z.string().max(64).default(''),    // NEW — '' means the host's default route
  resolveThroughEgress: z.boolean().default(true),// NEW — only meaningful with a bindAddress
})

ProxyRecordSchema = z.object({
  // … unchanged …
  capacity: z.number().int().min(0).max(1000).default(0),   // NEW — 0 = unlimited
  exclusive: z.boolean().default(false),                    // NEW
  listenerAuth: z.boolean().default(false),                 // NEW — intent; the secret is a KV row
})
```

`readProxyRecord` (the read-time migration in `shared.ts`) defaults all five for every existing row, so every record written before this plan parses unchanged and behaves exactly as it did.

### 4.2 New problem codes

Appended to `PROXY_PROBLEM_CODES`; every one names the thing that is actually wrong, per that list's own standing rule.

| Code | Kind | Raised when |
|---|---|---|
| `E_PROXY_BIND_ADDRESS_INVALID` | refusal | `bindAddress` is not a valid IPv4/IPv6 literal |
| `E_PROXY_BIND_ADDRESS_UNAVAILABLE` | precondition | the address is not present in `os.networkInterfaces()` on this host |
| `E_PROXY_LISTENER_AUTH_REQUIRED` | refusal | a non-loopback `bindHost` on a record with no listener credential |
| `E_PROXY_LISTENER_AUTH_MISSING` | precondition | `listenerAuth` is on but no `proxy-auth:<id>` row exists |
| `E_PROXY_VPN_BIND_UNSPECIFIED` | refusal | VPN mode on a record bound to `0.0.0.0` / `::` |
| `E_PROXY_VPN_BIND_LOOPBACK` | refusal | VPN mode on a record bound to `127.0.0.1` / `::1` — the phone would dial *itself*, and there is no `adb reverse` on the vpn-helper path |
| `E_PROXY_VPN_LISTEN_NOT_SOCKS5` | refusal | VPN mode on a record whose **listener** is not SOCKS5 — the guest agent speaks SOCKS5 only, so the route would look well-formed and die inside its dial |
| `E_PROXY_CAPACITY_FULL` | refusal | Apply would exceed `capacity`, or `exclusive` is set and a device already holds it |
| `E_PROXY_DNS_EGRESS_FAILED` | *(runtime, not a record problem)* | resolution through `bindAddress` failed; never falls back |

The existing relaxations for `direct`: `E_PROXY_VPN_UPSTREAM_NOT_SOCKS5` and `E_PROXY_VPN_UPSTREAM_INCOMPLETE` do not apply to it, because it names no upstream by design.

### 4.3 `service/dial-direct.ts`

```
createDirectUpstream({ bindAddress, resolveThroughEgress, timeoutMs }): Upstream

connect(dest):
  host = dest.host
  if (resolveThroughEgress && bindAddress):
      resolver = new Resolver({ timeout: timeoutMs, tries: 1 })   // node:dns/promises
      resolver.setLocalAddress(bindAddress)                        // family-matched
      host = (await resolver.resolve4|resolve6(dest.host))[0]      // literal passes through untouched
      // a failure throws E_PROXY_DNS_EGRESS_FAILED — never a fallback lookup
  socket = net.connect({ host, port: dest.port, localAddress: bindAddress || undefined })
  arm timeoutMs until 'connect'; classify errors through errors.ts
  return socket
```

Three details that will otherwise be got wrong:

1. **Address family must match.** An IPv4 `bindAddress` with a destination that resolves to IPv6 fails at connect with a confusing error. The family of `bindAddress` decides `resolve4` versus `resolve6` and is passed as `family` to the lookup.
2. **A destination that is already a literal is not resolved.** `net.isIP()` short-circuits it.
3. `describeUpstream` gains a form for this kind — `direct via 192.168.100.11` — and, as for every other upstream, it never contains a credential.

`createUpstream()` gains one branch. Nothing else in the service changes.

### 4.4 Listener authentication

**SOCKS5 (RFC 1929).** The greeting handler offers `METHOD_USERNAME_PASSWORD (0x02)` when the record has a credential and `METHOD_NO_AUTH (0x00)` when it does not — never both, so a client cannot choose its way past authentication. The sub-negotiation carries **version byte `0x01`, not `0x05`**: `[0x01, ulen, uname…, plen, passwd…]` in, `[0x01, 0x00]` for success or `[0x01, 0x01]` followed by a close for failure. Comparison is constant-time over both fields.

**HTTP.** `407 Proxy Authentication Required` with `Proxy-Authenticate: Basic realm="proxy-manager"`, and `Proxy-Authorization: Basic <base64>` accepted on both `CONNECT` and absolute-form requests. The header is never logged, and `errors.ts`'s scrubber gains the encoded form alongside the plaintext.

A refused authentication is logged as a `refused` event with a reason and the client address, and never with the attempted credential.

### 4.5 KV keys

| Key | Scope | Secret | Value |
|---|---|---|---|
| `proxy:<id>` | global | no | the record — unchanged, four new fields |
| `proxy-secret:<id>` | global | yes | the **upstream** password — unchanged |
| `proxy-auth:<id>` | global | **yes** | `{ username, password }` for **inbound** authentication — new |
| `proxy-probe:<id>` | global | no | `{ at, ok, publicAddress?, latencyMs?, error? }` — new |
| `assigned` | device | no | unchanged |

`proxy-auth:` and `proxy-probe:` do not start with `proxy:` (the sixth character is `-`, not `:`), so the catalogue's `list({ prefix: 'proxy:' })` continues to return records and only records — a property of the strings, asserted in `index.test.ts` beside the existing assertion for `proxy-secret:`. Every write of `proxy-auth:` passes `secret: true, hint: false` **on the same line**, as `proxy-secret:` already does and for the same reason.

### 4.6 Where each step's code lands

| Area | Files |
|---|---|
| record, migration, validation, route selection, copy | `src/shared.ts`, `src/record.ts` |
| the third upstream | `src/service/dial-direct.ts` (new), `src/service/upstream.ts` |
| listener authentication | `src/service/auth.ts` (new), `src/service/listen-socks5.ts`, `src/service/listen-http.ts`, `src/service/listener.ts` |
| probe | `src/service/probe.ts` (new), `src/service/supervisor.ts` |
| apply and capacity | `src/service/apply.ts`, `src/service/handlers.ts` |
| screen | `src/ui/parts/catalogue.tsx`, `src/ui/parts/api.ts`, `src/ui/parts/assignments.tsx` |

---

## 5. Implementation steps

Ordered so nothing is claimed buildable before its substrate exists. **Tests are step 117.11, deliberately, and no earlier step is blocked on writing one** — the owner's instruction was to build first and verify in one pass at the end. `bun run typecheck` is still run by every step, because it is cheap and it is the only thing standing between a step and the next one compiling.

**117.1 — the record learns `direct`.** `shared.ts`: `PROXY_KINDS` grows `'direct'`; `ProxyUpstreamSchema` grows `bindAddress` and `resolveThroughEgress`; `ProxyRecordSchema` grows `capacity`, `exclusive`, `listenerAuth`; `readProxyRecord` defaults all five for a row written before this plan; `PROXY_KIND_LABELS` gains a human word for it. `record.ts` re-exports as it already does. *Result:* every existing row still parses and behaves identically, and a record can express an egress binding it cannot yet use.

**117.2 — the third upstream dials.** `src/service/dial-direct.ts` per §4.3, minus the resolver (117.3): family handling, literal short-circuit, the connect timeout, error classification through `errors.ts`, and a `description` that carries no credential. `createUpstream()` in `upstream.ts` gains one branch. *Result:* an enabled record with `proto: 'direct'` starts a listener whose connections leave from the named source address.

**117.3 — DNS follows the packets.** The resolver half of §4.3, using `node:dns/promises`'s `Resolver` and `setLocalAddress` (measured real in §0.3), with `E_PROXY_DNS_EGRESS_FAILED` and **no fallback lookup**. `describeUpstream`'s `direct` form says which of the two modes the record is in. *Result:* a record can resolve names through the same path its packets take, and one that cannot says so instead of resolving elsewhere.

**117.4 — validation, and the host address check.** `validateProxyRecord` in `shared.ts`: `direct` stops requiring `host`/`port`/`username`; `bindAddress` is validated as a literal (`E_PROXY_BIND_ADDRESS_INVALID`); a separate, **start-time** check against `os.networkInterfaces()` raises `E_PROXY_BIND_ADDRESS_UNAVAILABLE` as a precondition (it is a fact about the host, which can change under a stored record, so it is not a write-time refusal). `capacity`/`exclusive` are stored but not yet enforced. The host lookup lives in `supervisor.ts` (`hostAddresses()`), read fresh on every start and passed in as a three-valued `context.hostAddresses` — `undefined` means *nobody looked*, which is the browser half's honest answer, mirroring the existing `hasPassword` pattern — because `shared.ts` imports nothing and cannot call `os.networkInterfaces()`. *Result:* a record naming an address this host does not hold refuses to start, naming the address, instead of binding to something else.

**117.5 — the screen can create one, and twenty.** `catalogue.tsx`: `direct` appears in the upstream protocol selector (it is driven off `PROXY_KINDS`, so it appears at all as soon as 117.1 lands — this step is the *fields*); a `bindAddress` input with the `resolveThroughEgress` toggle beside it; upstream host/port/username hidden for `direct` rather than shown-and-ignored; `capacity` and `exclusive` in the dialog. Then the **range generator** of §3.9: label template, first port, first bind address, count, and a preview table of every row it would write, correctable before anything is saved. `api.ts`'s `writeProxy`/`readProxy` carry the new fields, since they are the one funnel both halves go through. *Result:* an operator with several ways out of their machine can create one row per way out, or twenty in one form, and see exactly what will be written.

**117.6 — the listener authenticates.** `src/service/auth.ts`: the credential type, a constant-time comparison, and the two wire formats of §4.4. `listen-socks5.ts` offers `0x02` when a credential is present and `0x00` when it is not — never both — and runs the RFC 1929 sub-negotiation with version byte `0x01`. `listen-http.ts` answers `407` with `Proxy-Authenticate` and accepts `Proxy-Authorization: Basic`. `ListenerOptions` grows an optional `auth`; `supervisor.ts` reads `proxy-auth:<id>` beside the password it already reads and passes it through. `errors.ts`'s scrubber learns the base64 form. *Result:* a bridge can require a credential, and a refused attempt is logged with a reason and never with what was attempted.

**117.7 — the bind gate opens, conditionally.** `shared.ts:615`'s loopback rule becomes §3.5's rule: a non-loopback `bindHost` is permitted only for a record with listener credentials, and refused as `E_PROXY_LISTENER_AUTH_REQUIRED` otherwise, with a message that states the open-relay premise rather than merely citing it. `listenerAuth` without a stored row is `E_PROXY_LISTENER_AUTH_MISSING`. The dialog surfaces both at write time. *Result:* a bridge can be reached from the LAN, and only ever an authenticated one.

**117.8 — VPN mode for a `direct` record.** `vpnRouteForRecord` in `shared.ts` branches on `upstream.proto`: for `direct` the route is `{ engine: 'vpn-helper', host: listen.bindHost, port: listen.port, username }` with `E_PROXY_VPN_BIND_UNSPECIFIED` for a wildcard bind, and the vendor path stays byte-for-byte what it is. `apply.ts` reads the password from `proxy-auth:<id>` for a `direct` record and from `proxy-secret:<id>` for a vendor one — the same inline-credential path, the same scrubbing, the same audited capability call. *Result:* a phone can be put on a specific egress through the one rung an app under test cannot bypass.

**117.8a — the two silent failures 117.8's worker found, closed rather than noted.** `E_PROXY_VPN_LISTEN_NOT_SOCKS5` and `E_PROXY_VPN_BIND_LOOPBACK` per §4.2, both in `directVpnRouteForRecord`, each refused separately because the fixes differ — a wildcard bind names too many addresses, a loopback bind names the wrong machine, and an HTTP listener speaks the wrong protocol. And `hasListenerAuth` is wired into `supervisor.ts`'s `startLocked`, read **before** validation and carried down to `listenerOptions` as the only read, so `E_PROXY_LISTENER_AUTH_MISSING` can actually fire at the moment it guards a bind. `snapshot()` still passes `undefined` and says why: it is synchronous and a secret read is not. *Result:* every way a `direct` record can be applied to a phone and fail is now refused by name before the phone is touched.

**117.9 — the probe, and the catalogue's own Upstream column.** 117.5 left that column reading `Direct —` for a `direct` record, because it renders `PROXY_KIND_LABELS[proto]` followed by `upstream.host`, and a `direct` record has no host. It must read what `describeDirectUpstream` already produces (`direct via 192.168.100.11, DNS through the same address`) — the value is computed in `service/upstream.ts` and the same words belong on screen. Then:  `src/service/probe.ts`: dial `ENKAKU_NETWORK_PROBE_URL` through the record's own `Upstream`, parse the observed public address, write `proxy-probe:<id>`. Scheduled from the supervisor on an interval with jitter, skipped for a stopped record, and **`skip` — never `ok` — when the probe URL is unset**. The catalogue table gains status / observed address / latency / checked-at columns, with `unverified` as the state of a record that has not passed one and no wording anywhere that reads as success. *Result:* a row states the public address actually observed through it, or says honestly that nothing has verified it.

**117.10 — capacity is enforced, and documented.** `apply.ts` counts assignments through the device-scoped `assigned` key and refuses with `E_PROXY_CAPACITY_FULL`, naming the count and the holders; `assignments.tsx` shows the count against the limit per record. Then the documentation: `plugins/proxy-manager/README.md` (or the pack description) gains the egress-binding section; `docs/guide/install.md` gains a **vendor-neutral recipe** for "one proxy per way out" — how to add host addresses on Linux and Windows, how to make a host address map to a link, and the reminder that the mapping is applied by a person and audited by a count; `docs/plans/00-overview.md` §9 gains a row for the record's new fields (a JSON-shape change inside plugin KV, **no SQL migration**). The site-specific worked example — VLANs, a router's rule syntax, twenty modems — belongs in `docs/tmp-try-arch-mikrotik.md`, which is the operator's own log, and is linked from the guide rather than copied into it. *Result:* no first-party document describes anyone's particular network, and an operator with a different one can still follow the recipe.

**117.11 — the verification pass, all of it, here.** Unit tests colocated per the repo convention, covering: the migration of a pre-plan row; `direct` validation including both address codes; the resolver's no-fallback rule; the family-matching branch; both authentication wire formats including a wrong password and a client that offers only `0x00` to an authenticated listener; the bind gate in both directions; `vpnRouteForRecord` for both kinds of record; the capacity guard; the probe's `skip` and `unverified` states; and the absence assertions this pack already keeps (no credential in any `description`, thrown message, or log line — with the two controls plan 109 step 109.5 requires of an absence claim). Then `bun run typecheck`, then `bun run --cwd plugins/proxy-manager test`. **Scoped to this pack; no other suite is run, and no two runs are started at once** (CLAUDE.md's hard rule). *Result:* one verification pass over finished code, rather than eleven interrupted ones.

---

## 6. Acceptance criteria

1. A record stored before this plan parses, starts, and behaves exactly as it did — asserted by running a captured pre-plan value through `readProxyRecord` and `ProxyRecordSchema`.
2. An enabled `direct` record with a `bindAddress` the host holds serves connections whose source address is that address.
3. A `direct` record naming an address the host does **not** hold fails to start with `E_PROXY_BIND_ADDRESS_UNAVAILABLE`, naming the address — and never binds to a different one.
4. With `resolveThroughEgress` on, a resolution failure surfaces as `E_PROXY_DNS_EGRESS_FAILED`. **A test asserts no fallback lookup is performed**, because a silent fallback is the exact defect the option exists to remove.
5. A non-loopback `bindHost` on a record with no listener credential is refused with `E_PROXY_LISTENER_AUTH_REQUIRED` at write **and** at start. A test asserts a listener can never be bound off-host without authentication, on any combination of record fields.
6. A SOCKS5 client that offers only `METHOD_NO_AUTH` to an authenticated listener is refused; one that authenticates correctly is served; one that authenticates incorrectly is refused and disconnected. An HTTP client with no `Proxy-Authorization` receives `407`.
7. No credential — plaintext or base64 — appears in any upstream `description`, thrown message, log line, or probe record. Asserted with the two controls (a positive case proving the assertion would fire, and the negative case).
8. VPN mode on a `direct` record produces a route naming the **listener's** address and port; on a vendor record it still names the upstream's. A wildcard bind is refused with `E_PROXY_VPN_BIND_UNSPECIFIED`.
9. Apply is refused with `E_PROXY_CAPACITY_FULL` when it would exceed `capacity`, and the refusal names the devices already holding the record.
10. A record that has not passed a probe reads `unverified` on the screen. **A test asserts no string in the catalogue's status column can read `ok`, `routed`, `verified`, or `success` for such a record**, in the spirit of plan 51's own criterion 8. With the probe URL unset the state is `skip`.
11. The range generator writes exactly the rows shown in its preview, and refuses an address range that would cross an octet boundary rather than guessing.
12. `grep -ri "mikrotik\|vlan\|modem" plugins/proxy-manager/src` returns nothing.
13. `bun run typecheck` is clean and `bun run --cwd plugins/proxy-manager test` passes.

---

## 7. Test plan

Everything below runs in step 117.11, in one pass, in this order.

**Unit** — colocated `*.test.ts` beside the files they cover; no device, no router, no network:

- `shared.test.ts` / `record.test.ts`: the migration, both address codes, the bind gate, `vpnRouteForRecord` for both kinds, the capacity guard, the generator's octet-boundary refusal.
- `dial-direct.test.ts`: the literal short-circuit, the family branch, the connect timeout, and the no-fallback assertion — against a loopback server bound to `127.0.0.1`, using `127.0.0.1` as the `bindAddress`, which needs no special host configuration.
- `auth.test.ts` / `listen-socks5.test.ts` / `listen-http.test.ts`: both wire formats, the four client behaviours in criterion 6, and the scrubber.
- `probe.test.ts`: `skip`, `unverified`, a successful parse, and a failure that records an error without a credential.

**Integration, gated** behind `ENKAKU_TEST_DEVICE=1`, unchanged in spirit from the pack's existing gates: apply a `direct` record to one device in HTTP mode, read the public address the phone reports, and compare it with the record's probe.

**Manual, on the owner's hardware, driven through Studio in a real browser** (Claude in Chrome) rather than through curl — the owner asked for this explicitly, and it is the right ask: every refusal this plan adds is a *screen*, and a code path that returns the right problem object while the screen renders nothing is a bug this feature would ship with. Run once, after 117.11 is green.

What the browser can settle on its own: that a `direct` record can be created, that the generator writes exactly the rows it previewed, that each refusal (`E_PROXY_BIND_ADDRESS_UNAVAILABLE`, `E_PROXY_LISTENER_AUTH_REQUIRED`, `E_PROXY_VPN_BIND_UNSPECIFIED`, `E_PROXY_CAPACITY_FULL`) reaches the screen with its reason and not just its code, that Apply reaches the device and the device's own Network panel agrees about which engine and who set it, and that a record with no passed probe reads `unverified` rather than anything that could be mistaken for success.

What it cannot settle, and must not be reported as if it had: **whether the packets actually left by the intended path.** That is the observed public address, and it needs a `bindAddress` that is genuinely mapped to a distinct link (§0.4 / the install-guide recipe). Two useful stages:

1. **Without any special host setup** — bind a record to an address the host already holds (its ordinary LAN address). This exercises the whole mechanism end to end: the bind, the resolver, the listener, Apply, and the probe. It proves the machinery, and it proves nothing about per-link steering, because there is only one link.
2. **With the mapping in place** — the same run against several addresses, each mapped to its own link, where the point of the feature is finally observable: distinct public addresses per record, read off the phone's own screen and matched against the probe.

The sequence below is stage 2; stage 1 is the same list with one record:

```
# 1. one row, HTTP mode — the advisory rung, no LAN exposure, no credential on the phone
#    create a `direct` record, bindAddress = a host address mapped to one link
#    Apply → HTTP → open a public-IP page on the phone
#    → expect the public address of THAT link, and the same value the probe recorded
#
# 2. the same row, VPN mode — the enforcing rung
#    give the record listener credentials, bind it to a LAN address, re-Apply as VPN
#    → expect the same public address, and the guest agent's own through-tunnel probe to agree
#
# 3. the negative that matters most
#    stop the record → the phone loses egress rather than silently falling back to the LAN path
#
# 4. twenty rows from the generator, each on its own address
#    → twenty distinct observed public addresses in the catalogue table
```

Nothing in §7 runs a suite outside `plugins/proxy-manager`, and no two invocations run at once.

---

## 7a. What the hardware run actually established (2026-08-18, stage 1)

Run through Studio in a real browser against the running dev farm (`proxy-manager@0.7.0`, nine devices enrolled, one online), exactly as §7 prescribes. **Stage 1 only** — one host address, one path to the internet — so it proves the mechanism and proves nothing about per-link steering. Stage 2 waits on the operator's own address mapping.

| # | What was checked | Result |
|---|---|---|
| 1 | Two pre-plan records restart under 0.7.0 | **Pass** — both `Running` within seconds of activation; criterion 1 observed live, not only in a fixture |
| 2 | `bindAddress: not-an-address` at write time | **Pass** — `E_PROXY_BIND_ADDRESS_INVALID` rendered in the dialog with its reason and an example; Save disabled |
| 3 | `bindAddress: 192.0.2.99` (valid literal, not on this host) at start time | **Pass** — row reads `Failed · E_PROXY_BIND_ADDRESS_UNAVAILABLE`; the log line names the address and says the record is stored exactly as written |
| 4 | `bindAddress` = a real host address, `resolveThroughEgress` on | **Pass, and it caught something** — connections refused with `E_PROXY_DNS_EGRESS_FAILED`. The host runs a VPN whose resolver is unreachable from the LAN address. **Criterion 4's no-fallback rule held under real conditions**: it failed by name rather than resolving through the host's default resolver |
| 5 | Same record, `resolveThroughEgress` off | **Pass** — traffic flows; the bind works. The two halves are cleanly separable, which is the point of the toggle being a toggle |
| 6 | Apply to a live device, HTTP mode | **Pass** — route `adb-reverse-proxy` hostPort 9903 / devicePort 28100; `setBy: plugin proxy-manager`; checks `setting: pass` (read back off the phone), `reverse: pass`, `tunnel: skip`; `health: unverified` |
| 7 | The phone's own traffic through the bridge | **Pass** — the device browser reached `api.ipify.org` and displayed the public address of the bound path; the record logged 273 connections, 978.6 KB up / 2.3 MB down, every one `destPort=443` |
| 8 | Restore | **Pass** — Network → Remove put `http_proxy` back to `null`, route `enabled: false`, `engine: none`; the test record was deleted and the catalogue is as it was |

### Two findings, neither introduced by this plan

1. **The pack's manifest description is now wrong for a `direct` record.** It still reads *"runs a local bridge … that tunnels through the upstream proxy the record names"*, and a `direct` record names no upstream proxy. The description is what an operator reads on the consent screen at activation, so it should say what the pack now does. One-line fix, not done here because it belongs beside the version bump.
2. **The Assignments tab's `Clear` does not undo `Apply`.** `Apply` writes a route to the phone; `Clear` clears the note and the readout, and the phone keeps its route — confirmed by reading `settings get global http_proxy` after pressing it. The Delete dialog states the asymmetry outright (*"No device is reconfigured: pointing one at a proxy is the Assignments tab's Apply, and nothing here undoes it"*), so it is deliberate and documented rather than a defect — but an operator who presses Clear and walks away leaves a phone proxied. Turning it off means the device's own Network → Remove, which needs a lease. Worth a named `Turn off` action beside `Apply`; a follow-up, and out of this plan's scope.

---

## 8. Risks

| Risk | Why it is real | What is done about it |
|---|---|---|
| **A window where a non-loopback bind exists without authentication** | It would be an open relay shipped to every user of the pack | 117.6 precedes 117.7, stated as an ordering constraint, and criterion 5 asserts the invariant rather than the sequence |
| **`setLocalAddress` behaving differently on another platform or a later Bun** | §0.3 measured macOS on one Bun version | The failure is loud (`E_PROXY_DNS_EGRESS_FAILED`, no fallback), so a platform where it does not work reports rather than leaks |
| **Twenty listeners sharing the core's event loop with video and leases** | The earlier draft's reason for wanting an external engine; the concern is legitimate and unmeasured | `maxConnections` per record already bounds it; measure at 117.9 with real load. If it bites, moving the *service* to its own process is a smaller change than replacing the data plane, and this plan does not foreclose it |
| **A credential recovered from a phone** | VPN mode sends it there; that is the rung's known cost | Per-record credentials, so one recovered credential opens one egress; rotation is a single row; the existing on-screen statement of the trade-off stays |
| **An operator reads an observed public address as a guarantee** | It is a measurement at a point in time | `unverified` until proven, `skip` when unmeasurable, `checked-at` beside every value, and criterion 10's grep |
| **`os.networkInterfaces()` disagreeing with what the kernel will bind** | An address can disappear between the check and the bind | The check is a precondition, not the enforcement; the bind's own error is classified and reported either way |

---

## 9. Open questions

1. **Should `capacity` be enforced for the HTTP rung too, or only for VPN?** The HTTP rung is advisory — an app can ignore the proxy — so a capacity count over it is a count of *intent*, not of traffic. Proposal: enforce for both, because the count is about what the operator asked for, and say so in the message.
2. **Should a `direct` record be able to name its own DNS servers?** §3.4 uses the host's configured servers. A farm whose links each have their own resolver would want per-record servers. Proposal: not in this plan; the field is additive and nothing here forecloses it.
3. **What would have to be true to add a router integration?** An operator with two independent sources of health that can disagree needs a rule for which wins (`docs/plans/114-m79-device-proxy.md` records exactly this defect for the guest agent's two vocabularies). Until such a rule is written, one measured source is better than two unreconciled ones.
4. **Rotating an egress** — re-dialling a link to obtain a new public address — is the extension most likely to be asked for next. It is out of scope here and it is not vendor-neutral: every link type rotates differently. It belongs in a pack of its own that drives whatever hardware is present, and calls this pack's probe to confirm the address actually changed.

---

## 12. The Windows `gost` workaround

**`net.connect({ localAddress })` silently ignores the option on Windows under Bun.** Measured on
the owner's farm host on 2026-08-19: the record's `bindAddress` was correct, the routing rule was
correct, `curl.exe --interface` and a raw `.NET Socket.Bind` both egressed through the intended
link — only the Bun-built bridge kept leaving through the default one. Tracked upstream
(`oven-sh/bun#6888`, `#11570`, `#23486`; a fix landed as `#23464` on 2025-10-12 and was reverted
three days later).

So on `win32` **only**, and only for a `direct` record with a **non-empty** `bindAddress`:
`gost-provision.ts` downloads a **pinned** `gost` 3.2.6 Windows zip with a sha256 read off the real
release asset, into `<dataDir>/plugins/proxy-manager/gost/`; `gost-runtime.ts` supervises **one**
process for every Windows `direct` record at once, not one per record; each gost service binds
`127.0.0.1` only, speaks plain HTTP CONNECT (so `dial-http.ts`, already written and tested for
vendor HTTP upstreams, is the *only* dialler needed on the Bun→gost hop), and has no `chain`: gost
dials the destination itself, bound to `interface: <bindAddress>`. `resolveThroughEgress` has no
effect through this runtime — gost resolves through its own default resolver, matching the real
topology this workaround was proven against, where `bindAddress`'s own routing carried only a
default route with no path back to the LAN's DNS server.

**Correction, recorded here rather than rewritten into the paragraphs above (they describe what was
true when this plan shipped, against the evidence available on 2026-08-19): the gate above is too
narrow.** `docs/plans/123-m88-bind-capability-probe.md` §0 reproduced the identical failure on
macOS 15 under Bun 1.3.14 — including a bogus-address test proving Bun's `net.connect` never calls
`bind()` at all — and it was independently reported from a live Ubuntu 24.04 farm
(`refs/tmp-bug-proxy-mikrotik.md`). `process.platform === 'win32'` encoded a guess about *where*
the bug lived rather than a check of *whether the bind works*. Plan 123 replaces the platform gate
with a per-boot capability probe, `bindIsEffective()` (`service/bind-probe.ts`), and reuses the
`gost` mechanism recorded above **unchanged** — only the condition that reaches for it moved, and
it is now reachable on any platform once `gost` itself is provisioned there (still Windows-only by
construction as of plan 123; widening it is plan 123 §9 Q4, an open question for the owner). See
that plan for the measurement, the probe's design, and the operational consequence of the corrected
gate on a live Linux/macOS farm.
