# Plan 55 — M24e : A route that tells you when its exit moved

> Status: implemented except the §5.8 geo stages — `matchGeoExpectation` compares at the narrowest declared level, `geo`/`dns`/`leak` are real checks rather than permanent `skip`s, exit history is kept per device, and `onGeoFail: 'hold'` reaches Plan 54's hold-closed through a new `route.hold` wire method.
> **§5.8's geo/dns smoke stages are NOT added, deliberately.** Those checks are computed by the core, but `scripts/smoke-guest-agent.ts` talks straight to the agent's control socket and never starts a core — asserting them there would mean turning the smoke script into a core WS+REST client (lease acquisition is WS-only). That belongs in an integration test against a running core, not in the agent smoke script; Plan 50 §4.2's stage table should say so.
> Ships: packages/protocol/src/network.ts (`matchGeoExpectation`), packages/probe-server/
> **Depends on:** Plan 51 (the checks and the egress probe), Plan 52 (sticky identity, which this measures), Plan 54 (hold-closed, which this can trigger).
> **Spec references:** §7.9 (network layer), §17 (positioning).
> **Completes:** Plan 51 §4.1's `geo` check, which shipped as a permanent `skip`.

---

## 0. The gap, as an operator hit it

A device was pinned to `country-id-region-east_java-city-surabaya-isp-telkomsel`. Over one afternoon its exit address was `182.6.70.193`, then `182.5.238.2`, then `182.5.240.50` — three different addresses from the provider's residential pool. Throughout, `health` read `ok` and every implemented check passed.

Nothing in the system can currently say whether any of those addresses is still in Surabaya, still on Telkomsel, or still in Indonesia. `geo` reports `not checked` with the honest reason "no expected region was configured for this upstream" — honest, and useless, because **there is no way to configure one.** The field does not exist in the schema, the form, or the API.

So the one thing a device farm sells — a device that presents a specific network identity — is the one thing the platform cannot verify. `health: ok` currently means "traffic leaves through the proxy", not "traffic leaves where you asked". Those are different claims and only the second one is the product.

This is the same failure the last four plans have been closing one at a time: **the system reports intent, not reality.** Plan 51 made egress real. Plan 52 made the route durable. Plan 54 made failure safe. What is left is making the *destination* verifiable.

## 1. Goals

1. An operator can state where a route is expected to exit, per device.
2. `geo` compares the observed exit against that expectation and passes or fails on evidence.
3. A route whose exit has drifted out of its expectation is visibly not healthy, and says so in words an operator can act on.
4. Drift is detected while it is happening, not only when someone opens the page.
5. What "matches" means is explicit and tunable, because a residential pool legitimately moves within a region.

## 2. Non-goals

- **Automatically replacing an upstream whose exit drifted.** Detect and report; the operator decides (spec §17, and Plans 51/52 both drew this same line).
- Rotating, pooling, or binding a route to an account.
- A hosted geolocation service of our own — §3.2 explains why the lookup is pluggable rather than built in.
- The `dns` and `leak` checks. Still Plan 51 §5.3 and §5.7; this plan does not touch them.

## 3. Context and design decisions

### 3.1 Expectation is declared, never inferred

SOAX encodes targeting in the username (`country-id-region-east_java-city-surabaya-…`). Parsing it would work for exactly one provider and produce confident nonsense for every other — Plan 51 §4.1 already refused this and the refusal stands. Worse, the credential store now holds that username encrypted and the API deliberately never returns it, so the UI could not read it even if we wanted to.

So the expectation is its own field, typed by the operator, stored beside the route: country (required to enable the check), and optionally region, city, and ASN or ISP name. Absent expectation keeps `geo` at `skip` — never a silent `pass`.

### 3.2 The lookup is pluggable, and its absence degrades honestly

Turning an address into a location needs a database or a service. Both are somebody's data with somebody's licence, and hardcoding one vendor would repeat the mistake §3.1 avoids. So: a `network.geoProvider` setting with a documented response shape, defaulting to unset. Unset means `geo` stays `skip` with a reason naming what to configure — the same degradation rule Plan 51 §4.3 established for `probeUrl`, and for the same reason: an unavailable check must never become a false `ok`.

The self-hosted probe endpoint from Plan 51 §5.3 is the natural home for this — it already sees the request's source address, so it can answer with the location too, in one round trip, from infrastructure the farm controls.

### 3.3 Matching has to tolerate a pool without going blind

A residential pool moves. `182.5.238.2` and `182.5.240.50` may both be Telkomsel Surabaya, or one may be Jakarta. Strict equality on city would cry wolf constantly; matching only on country would have called all three afternoon addresses fine even if one had been in Germany.

So match at the **narrowest level the operator declared**, and report the observed location in full either way. An operator who declares only a country gets a country check and sees the city drift in the detail line without it failing. That makes the strictness the operator's choice rather than ours, and it makes the check's `detail` useful even when it passes.

### 3.4 Drift is a heartbeat concern, not a page-load concern

Plan 51 §9 Q1 left open how often checks re-run, and an egress probe every 20 s per device is real traffic and real cost at fleet scale. But a geo check that only runs when someone opens the device page cannot detect drift — which is the entire point.

Compromise: re-probe on a slow, configurable interval (default measured in minutes, not seconds), plus on every apply and every restore. Record the exit address history per device so drift is visible as a sequence rather than a single current value — three addresses in an afternoon is itself the signal.

### 3.5 What a failed `geo` should do

It must not silently tear the route down, and it must not silently continue. Plan 54 gave us a third option: **hold closed**. A route whose exit left its declared region is arguably worse than one that is down — it is actively presenting the wrong identity while reporting success.

Make it a per-route policy alongside `failClosed`, defaulting to **report only**. Turning a geo failure into a hold-closed is the strict setting an operator opts into, with the consequence stated plainly. Defaulting it on would strand devices whenever a pool drifts one city over.

## 4. Technical design

### 4.1 Protocol

```ts
export const GeoExpectationSchema = z.object({
  country: z.string().length(2),          // ISO 3166-1 alpha-2, required
  region: z.string().min(1).optional(),
  city: z.string().min(1).optional(),
  asn: z.number().int().positive().optional(),
  isp: z.string().min(1).optional(),
})

export const GeoObservationSchema = z.object({
  address: z.string(),
  country: z.string().nullable(),
  region: z.string().nullable(),
  city: z.string().nullable(),
  asn: z.number().int().nullable(),
  isp: z.string().nullable(),
  at: z.number().int(),
})
```

`Socks5RouteConfig` gains `expect: GeoExpectationSchema.optional()` and `onGeoFail: z.enum(['report', 'hold']).default('report')`.

### 4.2 The check

`geo` compares each declared field against its observation, case-insensitively and trimmed:

- no expectation → `skip`, reason unchanged
- no provider configured → `skip`, reason names `network.geoProvider`
- lookup failed → `unknown`, with the error — never `pass`
- every declared field matches → `pass`, `detail` carries the full observed location
- any declared field differs → `fail`, `detail` names **which** field and both values

`health` derivation is unchanged: `fail` on any check already means `degraded`, so a drifted exit stops reading `ok` for free.

### 4.3 Exit history

A small bounded per-device ring (last N observations with timestamps) stored beside the route. The devices list already gets an exit address column from Plan 52 §4.4; this adds "and it changed 3 times today", which is what makes a rotating pool legible.

### 4.4 Studio

The route form gains an "Expected exit" group: country required to enable, the rest optional, with copy that says matching happens at the narrowest level declared. The `geo` row shows the observed location whether it passed or failed, and the failure names the mismatched field. The exit history is visible on the device page — a short list, not a chart.

## 5. Implementation steps

**5.1 Protocol.** §4.1, plus the settings key. Tests for the matcher including partial expectations and the all-absent case.

**5.2 Geo lookup.** The provider interface and its response schema; wire the self-hosted probe endpoint (Plan 51 §5.3) as the reference implementation. Document the shape so another provider can be dropped in.

**5.3 The check.** §4.2 in the engine, with `detail` never carrying a credential (Plan 51 acceptance criterion 8 applies unchanged).

**5.4 Periodic re-probe.** §3.4 — slow interval, plus on apply and on restore, sharing the heartbeat's existing per-device scheduling rather than adding a second timer.

**5.5 Exit history.** §4.3.

**5.6 `onGeoFail: 'hold'`.** Wire a geo failure into Plan 54's hold-closed path. Default `report`; the UI states what `hold` does before it can be selected.

**5.7 Studio.** §4.4.

**5.8 Smoke test.** Extend Plan 50: apply a route with an expectation that matches and assert `geo: pass`; apply one with a deliberately wrong country and assert `geo: fail` **and** `health !== 'ok'`.

## 6. Acceptance criteria

1. A route with no expectation reports `geo: skip` — never `pass`.
2. A route with an expectation and no configured provider reports `skip` naming the setting.
3. A matching exit reports `pass` with the observed location in `detail`.
4. A mismatched exit reports `fail`, names the field that differed, and `health` is no longer `ok`.
5. A failed lookup reports `unknown`, never `pass`.
6. An operator declaring only a country is not failed by a city change, but can see it.
7. Exit drift over time is visible per device without reading logs.
8. With `onGeoFail: 'hold'`, a drifted exit holds the device closed per Plan 54; with `report`, it does not.
9. No credential in any `detail`, response, event, or view.
10. `bun run typecheck` clean, `bun test` green, Plan 50's smoke test passes with the new stages.

## 7. Test plan

**Unit** — the matcher across every partial-expectation combination; `skip`/`unknown`/`pass`/`fail` selection; health derivation with a failing `geo`; history ring bounds; `detail` redaction.

**Device (`ENKAKU_TEST_DEVICE=1`)** — a real route with a correct expectation passes; the same route with a deliberately wrong country fails and drops health; `onGeoFail: 'hold'` holds the TUN closed and the device cannot reach the internet while `tun0` still exists.

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Geo data is wrong and cries wolf | Match at the declared level only (§3.3); default `onGeoFail: 'report'` |
| A vendor lock-in creeps in | Provider is pluggable and unset by default (§3.2) |
| Re-probing costs traffic at fleet scale | Slow interval, configurable, shared with the existing heartbeat (§3.4) |
| `geo: skip` becomes permanent again, as in Plan 51 | Acceptance criteria 1–5 are about which state is chosen, not about it existing |
| Holding closed on a benign city drift strands devices | `hold` is opt-in, and the UI states the consequence (§3.5) |

## 9. Open questions

1. Should the expectation be per-device or per-credential? The targeting lives in the credential's username, so two devices sharing one credential share an expectation — but Plan 52 §9 Q3 already flagged the device/credential split as unresolved.
2. Is ASN a better primary signal than city? It is far more stable and far less ambiguous, but operators think in cities.
3. Should a geo `fail` be distinguishable from a geo `fail` that has persisted for an hour? A pool that drifts and returns is different from one that has moved permanently.
