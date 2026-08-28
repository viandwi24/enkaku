# Plan 133 — M98 : A down path says why

> Status: implemented (software) — **133.1–133.3 land.** Opened 2026-08-26 from a live debugging session on the owner's farm, and the root cause was found while this plan was being written: **two Orbits had been left on the factory-default `192.168.8.0/24`**, so both DHCP clients pulled the same `192.168.8.100/24` and the router held no address in `192.168.125.0/24` or `192.168.127.0/24`. That is the `immediate-gw=""` in §0.1, confirmed on the router. A third device was green with no data plan at all. `PathHealth` now carries a `reason` derived from the route the driver already fetched — `no-route-to-gateway`, `gateway-unreachable`, `no-default-route` — and the Paths tab renders a sentence naming the thing to go and look at. `up` is unchanged. Ships as `mikrotik-routing@0.12.0`. **The bigger half is untouched and stated as such**: `check-gateway=ping` still cannot distinguish "the modem has internet" from "the modem answers ping" — §9 Q1.
> Depends on: plan 122 (M87 — §4.5 path health, `RouterDriver.inventory()`), plan 132 (M97 — which made a down path apply rather than skip, so the reason a path is down is now the operator's only remaining question).
> Spec references: §7.9 (driver layers), §11.6 (plugin screens).
> Ships: plugins/mikrotik-routing/src/service/router-driver.ts

---

## 0. Evidence

### 0.1 One symptom, three causes, and a CLI session to tell them apart

On a 25-device farm, three devices had no internet. Studio said the same thing about all of them — a `Path health` chip and nothing else. The real causes, found only by going to the router's terminal:

| Device | Path | Studio said | Actually |
|---|---|---|---|
| #20 | `via-modem40-s2p22` | **Up** | modem alive, **no data plan** — no upstream at all |
| #5 | `via-modem25-s2p7` | **Down** | the router has **no IP address on `192.168.125.0/24`** |
| #7 | `via-modem27-s2p9` | **Down** | same |

The route for #5, printed on the router:

```
0 Is ;;; internet via modem25 sw2 port7
     dst-address=0.0.0.0/0 routing-table=via-modem25-s2p7 gateway=192.168.125.1 immediate-gw=""
     check-gateway=ping distance=1 scope=30 target-scope=10
```

`I` = inactive, and **`immediate-gw=""`**. The router cannot resolve which interface reaches `192.168.125.1`, because it holds no address in that subnet. That is a configuration fault on a specific switch port — modem 40, on the same switch, resolves fine — and it is nothing like "the modem stopped answering".

### 0.2 The field that answers it is already on the wire

`IpRouteSchema` (`service/schemas.ts`) is `.passthrough()`, so `immediate-gw` already arrives from `/rest/ip/route` on every inventory call. Nothing reads it. `inventory()` reduces the whole route to one boolean:

```ts
health.push({ pathId: table.name, up: defaultRoute?.active ?? false, checkedAt })
```

So the plugin asks the router a precise question, receives a precise answer, and stores one bit.

### 0.3 Why this matters more after plan 132

Plan 132 made a down path **apply** rather than skip: the assignment is obeyed and the device goes offline until the path returns. That was the right call for this farm, and it makes "why is this path down" the operator's only remaining question — the one thing they now need in order to act. Answering it with a red chip is not enough.

---

## 1. Goals

1. `PathHealth` carries a **reason** when a path is down, derived from what the router already reports.
2. The three conditions are distinguished, because their fixes are unrelated:
   - **no default route in the table at all** — nothing to route through;
   - **`immediate-gw` empty** — the router has no address on the gateway's subnet, so it cannot reach the gateway at all (a wiring/VLAN/DHCP fault, not a modem fault);
   - **route present and resolvable but not active** — the gateway did not answer `check-gateway`.
3. Studio says which, in words an operator can act on.
4. `up` keeps its exact current meaning, so nothing that reads it changes behaviour.

## 2. Non-goals

- Replacing `check-gateway=ping` as the health signal. It answers "does the gateway answer ping", which is not "does this path reach the internet" — #20 proves it. Fixing that properly means driving health from `verify-egress`, which is a bigger change and its own plan. §9 Q1.
- Diagnosing *why* an address is missing (VLAN, bridge port, DHCP client). The plugin reports the fact; the router's own config is the operator's.
- Any change to how rules are written or applied.

## 3. Context and design decisions

### 3.1 The reason is derived, never guessed

Every input comes from the route object the driver already fetches:

| Condition | Derived from |
|---|---|
| `no-default-route` | no `0.0.0.0/0` route in the table |
| `no-route-to-gateway` | the default route exists and `immediate-gw` is empty |
| `gateway-unreachable` | the default route exists, `immediate-gw` is set, `active` is false |

If a future RouterOS omits `immediate-gw`, the reason falls back to `gateway-unreachable` — the honest, least-specific answer — rather than claiming a wiring fault that was never observed.

### 3.2 `up` does not change

`up` stays `defaultRoute?.active ?? false`. The reason is additive. Plan 132's `overDownPath` flag, the planner, and every existing consumer keep reading exactly what they read today.

### 3.3 The words matter more than the enum

A reason an operator cannot act on is the current chip with extra steps. Each maps to a sentence naming the thing to look at:

- **no-route-to-gateway** — "the router has no address on `192.168.125.0/24`, so it cannot reach this modem at all. Check that port's VLAN/DHCP client on the router, not the modem."
- **gateway-unreachable** — "`192.168.125.1` did not answer. The modem is either off or not responding to `check-gateway`."
- **no-default-route** — "this routing table has no default route. Nothing can egress through it."

The first sentence is the one that would have ended the owner's session in seconds instead of three rounds of CLI.

## 4. Technical design

```ts
export type PathDownReason = 'no-default-route' | 'no-route-to-gateway' | 'gateway-unreachable'

export interface PathHealth {
  pathId: string
  up: boolean
  checkedAt: number
  /** Absent when `up` — a healthy path has no reason to explain. */
  reason?: PathDownReason
}
```

`IpRouteSchema` gains `'immediate-gw': z.string().optional()`. It already arrives through `.passthrough()`; typing it is what makes it readable.

## 5. Implementation steps

### 133.1 — The driver reports the reason
- `schemas.ts`: type `immediate-gw`.
- `router-driver.ts`: `inventory()` derives `reason` per §3.1.
- Tests: each of the three conditions from a fixture route list; a healthy path carries no reason; a response with no `immediate-gw` field at all degrades to `gateway-unreachable` rather than inventing a wiring fault.

### 133.2 — Studio says which
- The Paths tab health cell, and the down-path warning plan 132 put above the plan list, both name the reason per §3.3.
- Tests: each reason renders its own sentence; an unknown reason from a newer core falls back to the plain "down" wording rather than rendering blank.

### 133.3 — Ship it
- Bump **0.11.0 → 0.12.0** in all three sites, changelog row, `bun run build:packs`.

## 6. Acceptance criteria

1. A path whose default route has an empty `immediate-gw` reports `no-route-to-gateway`, and Studio names the subnet the router is missing.
2. A path whose gateway simply did not answer reports `gateway-unreachable`.
3. A table with no default route reports `no-default-route`.
4. A healthy path carries no reason, and `up` is unchanged for every case.
5. An unrecognised reason degrades to the current wording, never a blank cell.
6. `mikrotik-routing` is 0.12.0 in all three sites; `build:packs` emits it.
7. `bun run typecheck` passes; the plugin's tests pass; no process left running.

## 7. Test plan

Unit tests per step. **Needs the farm:** confirm `via-modem25-s2p7` and `via-modem27-s2p9` report `no-route-to-gateway` on the real router, and that a modem that is merely switched off reports `gateway-unreachable` — the two must not collapse into one.

## 8. Risks and mitigations

| # | Risk | Mitigation |
|---|---|---|
| R1 | `immediate-gw` behaves differently on another RouterOS version. | Absent → `gateway-unreachable`, the least-specific answer (§3.1). The claim is only made when the field is present and empty. |
| R2 | The reason is mistaken for a health check that reaches the internet. | It is not, and §2 says so: #20 was `up` with no data plan. §9 Q1 is where that gets fixed. |

## 9. Open questions

1. **Should path health be driven by `verify-egress` instead of `check-gateway=ping`?** #20 was reported `Up` with no upstream at all, because ping only proves the modem answers. The plugin already ships a script that tests the real thing. Making it the health signal — scheduled, per path — is the fix, and it is a separate plan.
2. **Should the reconcile loop raise a notification** when a path flips to `no-route-to-gateway`? That is a wiring fault, not a transient modem blip, and it will not clear on its own.

## 10. Notes recorded during execution

1. **The cause was confirmed on the router mid-plan, and it was worse than the hypothesis.** `/ip dhcp-client print` showed `client5 wan-modem25-s2p7 → 192.168.8.100/24` and `client7 wan-modem27-s2p9 → 192.168.8.100/24` — not one modem left on the factory default, but **two**, both pulling the identical address. Working ports read `192.168.124.100/24`, `192.168.126.101/24`. So the router had no address in either expected subnet, exactly as `immediate-gw=""` reported.

2. **An earlier hypothesis was wrong and the evidence killed it.** Before the route was printed, the working theory was that the Orbits block ICMP, so `check-gateway=ping` marked healthy modems down — built on the owner's report that the modems' web UI was reachable from a device. That report turned out to be a mis-observation (wrong IP), and `immediate-gw=""` ruled the theory out outright. Recorded because the theory was plausible, was stated, and was wrong.

3. **`reason` is a plain optional string on the wire, not an enum.** `api.ts`'s `PathHealthSchema` follows this file's own loose-schema philosophy: a core newer than the loaded bundle may send a value this build has never heard of, and the whole fleet response must not fail to parse over one unfamiliar word. The UI falls back to the plain "Down" wording, asserted by its own test.
