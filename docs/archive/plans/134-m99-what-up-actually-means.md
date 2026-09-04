# Plan 134 — M99 : What "Up" actually means

> Status: implemented (software) — **134.1–134.6 land**, with one gap stated below. Opened 2026-08-26 from the owner's own question right after plan 133 shipped. `PathHealth` now carries `link`/`gateway`/`egress` instead of standing one boolean in for all three; `up` is byte-identical and every existing consumer is untouched. Egress is operator-triggered (`POST /rest/ping` with `interface=`) and reports `unknown` — never `fail` — for anything it could not run. Two previously-silent faults are named: two uplinks holding one address (free, from a new best-effort `/ip/dhcp-client` GET) and two paths egressing from one public IP (free, from each device's own `verify-egress` reading). Ships as `mikrotik-routing@0.13.0`.
>
> **The gap, stated rather than papered over:** the router-side probe returns *reachability*, not a public IP. `deriveFleetFaults` can group paths by public IP and is tested, but nothing on the router side feeds it — the only public-IP readings in the system come from `verify-egress` running on a device, which is what the Assignments-tab warning uses. So `PathHealth.publicIp` exists, is honest, and is currently never populated from the router. §9 Q3.
> Depends on: plan 122 (M87 — `RouterDriver.inventory()`, `verify-egress`), plan 132 (M97 — an assignment is a hard constraint), plan 133 (M98 — `PathHealth.reason`).
> Spec references: §7.9 (driver layers), §11.6 (plugin screens).
> Ships: plugins/mikrotik-routing/src/service/health.ts

---

## 0. Evidence

### 0.1 The farm session that produced plan 133 had three devices offline and health caught one

| Device | Path | Health said | Truth | Caught by |
|---|---|---|---|---|
| #5 | `via-modem25-s2p7` | Down | router holds no address in `192.168.125.0/24` | plan 133 |
| #7 | `via-modem27-s2p9` | Down | same | plan 133 |
| **#20** | `via-modem40-s2p22` | **Up** | **modem answers ping, has no data plan — zero upstream** | **nothing** |

Two of three are now explained in Studio. The third is worse than unexplained: it is **reported healthy**. An operator reading the Paths tab would have moved on from #20 and kept looking at the router.

### 0.2 `check-gateway=ping` answers a different question than the one being asked

The route carries `check-gateway=ping`, and `active` is what `PathHealth.up` is built from. What that proves is: *the modem's LAN interface replies to ICMP*. What the operator reads it as: *traffic sent down this path reaches the internet*. Those come apart in at least four ways this farm will meet:

1. **No data plan / suspended SIM** — modem is a perfectly healthy LAN device with no upstream. Observed, #20.
2. **Captive portal or carrier redirect** — every request returns 200 from somewhere that is not the destination.
3. **Upstream up, DNS dead** — traffic egresses, nothing resolves.
4. **The rule is wrong but the path is fine** — the path is genuinely up and the device is still egressing through a different one. `check-gateway` cannot see this by construction: it never sends a packet the device would have sent.

### 0.3 The thing that would have caught the plan 133 bug in one glance is free

`/ip/dhcp-client` was never fetched. Printed by hand during the session, it read:

```
client5 wan-modem25-s2p7  192.168.8.100/24
client7 wan-modem27-s2p9  192.168.8.100/24
client4 wan-modem24-s2p6  192.168.124.100/24
client6 wan-modem26-s2p8  192.168.126.101/24
```

**Two WAN clients holding the identical address.** That is the entire fault, visible in one line, from one GET the driver does not currently make. Plan 133 inferred it from `immediate-gw=""` — correct, but downstream of the cause and one step removed from the fix.

### 0.4 A shared public IP is the risk the owner actually cares about

Stated in plan 132's §0: the reason an assignment is a hard constraint is that a device egressing from an IP it should not share **risks a ban**. The plugin has no per-path public IP anywhere in its data model — `verify-egress` says so in its own header comment. So the single fact most load-bearing for the owner's stated risk is the one fact nothing stores.

---

## 1. Goals

1. Replace one boolean with **three independent facts**, each named after the question it actually answers:
   - **link** — can the router reach this path's gateway at all? (address present, route resolvable)
   - **gateway** — does the modem answer? (`check-gateway`, i.e. today's signal, correctly labelled)
   - **egress** — does traffic through this table reach the internet, and **from which public IP**?
2. `egress` is `unknown` until something measures it. **Never `ok` by inference** — CLAUDE.md's standing rule that `unverified` is not success.
3. Detect **two paths sharing a WAN address** (§0.3) and **two paths sharing a public IP** (§0.4) — both are silent faults today, and the second is the ban risk.
4. `up` keeps its exact current value and meaning, so the planner, plan 132's `overDownPath` and every existing consumer are untouched.

## 2. Non-goals

- Probing egress on a schedule by default. Every probe costs LTE data on a metered SIM, on a farm with 40+ modems. Cadence is the operator's, and the default is manual (§4.4).
- Replacing `verify-egress`. That script proves the thing from the **device's** side, which is the only side that can catch a mis-steer (§0.2 case 4). This plan adds the router's side; they answer different questions and both stay.
- Fixing the router's configuration. The plugin reports; the router's config is the operator's.

## 3. Context and design decisions

### 3.1 Three facts, not one enum

A single `status` field forces a precedence decision that has no right answer — is "gateway answers but no internet" worse than "no address"? They are different faults with different fixes. Three fields let the UI show the first one that is failing and stay honest about the rest being unmeasured.

```ts
export type Probe = 'ok' | 'fail' | 'unknown'

export interface PathHealth {
  pathId: string
  /** UNCHANGED: `defaultRoute?.active ?? false`. Every existing consumer keeps reading this. */
  up: boolean
  checkedAt: number
  /** Plan 133. Retained verbatim. */
  reason?: PathDownReason
  /** Plan 134 §1. */
  link: Probe
  gateway: Probe
  egress: Probe
  /** The public IP last observed egressing through this path, and when. Absent until something measured it. */
  publicIp?: string
  egressCheckedAt?: number
}
```

### 3.2 `link` and `gateway` are free; `egress` is not

`link` and `gateway` are derived from data already on the wire (`/ip/route`, plus one new GET for `/ip/dhcp-client`). They cost nothing and are always populated.

`egress` costs a real request through a metered modem. It is therefore `unknown` until an operator asks, and the UI says `unknown`, never "ok".

### 3.3 How egress gets measured, in falling order of preference

1. **From the router, per path.** RouterOS *may* expose a routing-table selector on `/tool/fetch`. The owner's RouterOS 7.24 has already **rejected** `routing-table=` on `/ping` (observed during the plan 133 session), so this must be **capability-detected at runtime, never assumed**: attempt it once, and on a parameter-rejection error record the capability as absent and stop attempting.
2. **From a device on that path**, via the existing `verify-egress` script. Authoritative — it is the only method that proves the device's own traffic egresses correctly — but needs an online, leased device.
3. **Neither available** → `egress: 'unknown'`, and the UI says exactly that.

The important property is that failing to measure is never rendered as success.

### 3.4 Duplicate detection is a fleet fact, not a path fact

Two paths sharing an address is a property of the pair, not of either one. It is computed over the whole inventory and attached to every path involved, so a single row can say so without the operator cross-referencing forty of them.

- **Duplicate WAN address** (§0.3) — free, from `/ip/dhcp-client`. This is the plan 133 fault, named directly.
- **Duplicate public IP** (§0.4) — only over paths that have actually been probed. Two probed paths reporting one public IP means two device groups are sharing an identity, which is the ban risk in plan 132 §0.

## 4. Technical design

### 4.1 One new GET

`inventory()` adds `/ip/dhcp-client` to the existing `Promise.all`. New Zod schema `DhcpClientSchema` (loose, per this package's convention): `interface`, `address`, `status`, `gateway`.

### 4.2 `link` derivation

| `link` | Condition |
|---|---|
| `fail` | plan 133's `no-route-to-gateway` — the router holds no address in the gateway's subnet |
| `fail` | plan 133's `no-default-route` |
| `ok` | the default route resolves to an interface |

### 4.3 `gateway` derivation

`ok` iff `defaultRoute.active`; `fail` when the route resolves but is inactive; `unknown` when `link` already failed (the check never ran meaningfully — reporting `fail` would claim an observation nobody made).

### 4.4 `egress` is operator-triggered

A **Probe egress** action per path, and a **Probe all** on the Paths tab. Manual by default (§2). What it records: `egress`, `publicIp`, `egressCheckedAt`. Persisted with the path's settings so a result survives a reload — a probe that costs data must not be thrown away by a refresh.

## 5. Implementation steps

### 134.1 — The router's WAN side becomes visible
- `schemas.ts`: `DhcpClientSchema` + list.
- `router-driver.ts`: fetch `/ip/dhcp-client`; expose it on the inventory result.
- Tests: parses a real-shaped response; a router with no DHCP clients degrades to an empty list, never a throw.

### 134.2 — Three facts replace one
- New `service/health.ts`: `deriveHealth(route, dhcpClients)` → `{ up, reason, link, gateway }`, pure, no I/O.
- `router-driver.ts` calls it. `up` byte-identical to today, asserted against the existing plan 133 fixtures.
- Tests: the full matrix of §4.2/§4.3, including that `gateway` is `unknown` — not `fail` — when `link` failed.

### 134.3 — Duplicates are named
- `deriveFleetFaults(health, dhcpClients)` → per-path `duplicateAddressWith: string[]`, `duplicatePublicIpWith: string[]`.
- Tests: the exact plan 133 fixture (`client5`/`client7` both `192.168.8.100/24`) produces a duplicate on both paths and on neither of the healthy two.

### 134.4 — Egress probe, capability-detected
- Attempt the router-side probe once; cache "not supported" on a parameter rejection and never retry within a session.
- Fall back to `verify-egress` on a leased device when one is assigned to the path.
- Neither → `unknown` with a message saying which was tried.
- Tests: a router that rejects the parameter falls back rather than reporting `fail`; an unmeasured path is `unknown` and never `ok`.

### 134.5 — Studio says all three
- The Paths tab health cell shows the failing layer, and `egress: unknown` reads as "not measured", never as a tick.
- A duplicate-address path carries the loudest warning on the screen: it names the other path by id.
- Tests: `unknown` never renders as success; a duplicate names its twin.

### 134.6 — Ship
- Bump **0.12.0 → 0.13.0** in all three sites, changelog row, `bun run build:packs`.

## 6. Acceptance criteria

1. A path whose modem answers ping but has no upstream reads `gateway: ok, egress: unknown` — never "Up" alone. (#20 from §0.1.)
2. Two paths whose DHCP clients hold the same address are both flagged, naming each other. (#5/#7 from §0.3.)
3. Two probed paths reporting the same public IP are flagged. (§0.4.)
4. `egress` is `ok` only when a probe actually returned; every unmeasured path reads `unknown` in the data and "not measured" on screen.
5. `up` is byte-identical to today for every existing fixture; the planner and plan 132's `overDownPath` are untouched.
6. No probe runs without an operator asking (§2).
7. `bun run typecheck` passes; the plugin's tests pass.

## 7. Test plan

Unit per step, from real-shaped fixtures. **Needs the farm:** confirm the router-side probe capability (§3.3.1) actually exists on RouterOS 7.24 — if it does not, §3.3.2 is the only mechanism and the plan's honesty rule (§3.3.3) is what carries the rest.

## 8. Risks and mitigations

| # | Risk | Mitigation |
|---|---|---|
| R1 | The router-side probe does not exist on this RouterOS, and the feature quietly reports `fail` for every path. | §3.3: a parameter rejection is a capability answer, not a probe result. It falls back, and reports `unknown` — never `fail`. |
| R2 | Probing burns LTE data on 40 metered SIMs. | Manual by default (§2/§4.4). No scheduler in this plan. |
| R3 | Three fields make the UI noisier than one chip. | The cell shows the first failing layer and one line; the detail is behind the row, not in it (§4.5). |
| R4 | `up` drifts from its current meaning and silently changes what the planner writes. | §134.2 asserts `up` against the existing plan 133 fixtures unchanged. |

## 9. Open questions

1. **Should a duplicate public IP block apply?** It is the exact condition plan 132 exists to prevent. Blocking is tempting and wrong for the same reason plan 132 gives — the operator's assignment is a constraint, not a suggestion. Warning loudly is this plan's answer; a hard block would be its own decision.
2. **Should egress get a scheduler later?** Yes, probably, per path with a cadence — but the data cost is the operator's to spend, so it needs their number, not a default this plan invents.
3. **Should the router-side probe also read a public IP?** It would close the gap in the status line above — `PathHealth.publicIp` currently exists and is never populated from the router. RouterOS's `/tool fetch` is the candidate, and unlike `/ping` nothing in this session established whether it can be pinned to one uplink on 7.24. Worth one experiment on the farm before it is designed.

## 10. Notes recorded during execution

1. **The new GET nearly took the whole screen down, and the test suite caught it.** `inventory()` renders the entire Paths tab and feeds every apply; `/ip/dhcp-client` powers one warning. Added to the `Promise.all` naively, it made every pre-existing driver test throw with `HTTP 404` — which is exactly what a farm with a read-restricted API user would have hit in production. It is now `.catch(() => null)` around that single call (not the whole `Promise.all`, so a genuine failure of any other endpoint still throws as before), with an unparseable list degrading the same way. Two tests pin it.

2. **The join key is the router's own answer, not a subnet match.** `immediate-gw` reads `192.168.124.1%wan-modem24-s2p6` — RouterOS has already resolved gateway → interface. Matching subnets by hand would have been the obvious implementation and would have picked the wrong modem on this exact farm, where two ports genuinely shared `192.168.8.0/24` (plan 133 §0.3). Where the router could not resolve one (`immediate-gw=""`, the plan 133 fault) the interface is `null`, the path joins no duplicate group, and the Paths tab says "No uplink resolved — nothing to probe through" rather than offering a button that would probe nothing.

3. **`gateway: 'unknown'` when `link` fails is the whole point of the split.** If the router holds no address in the gateway's subnet, it never asked the modem anything — so reporting `gateway: 'fail'` would blame a modem nobody managed to contact. That is the same category of error as #20's false "Up", pointed the other way, and it is what a two-state model cannot express.

4. **`/ping`'s RESPONSE shape is inference, and is handled as such.** `interface=` was chosen because the owner's RouterOS 7.24 was observed rejecting `routing-table=` on `/ping`. The reply format, though, is still read from public documentation — the same kind of inference `schemas.ts`'s header records going wrong once already, on `fib`. `summarisePing` therefore treats anything it cannot read as `unknown`, tested against `null`/`undefined`/`[]`/`{}`/a string/a number, and only an all-timeout result becomes `fail`.

5. **Unprobed is not a duplicate group.** The obvious implementation of "group by public IP" collects every path with no reading into one giant group. Forty devices sharing "no observation" is not forty devices sharing an identity, and reporting it that way would bury the one real case. Both duplicate finders skip absent values entirely, and both have a test that says so.
