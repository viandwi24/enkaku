# Plan 51 — M24b : Verified egress, and a route that fails closed

> Status: implemented — named `RouteCheck`s with `deriveHealth()` replace the single enum, the `egress.probe` agent capability and control method exist end to end, and Studio surfaces per-check state.
> Ships: packages/protocol/src/network.ts
> **Depends on:** Plan 44 (the working route), Plan 50 (CI and the device smoke test — its stage 8 becomes real here).
> **Spec references:** §7.9 (network layer — this plan makes rule 3 true), §17 (positioning).
> **Research:** `docs/research/android-guest-agent.md` §6 (always-on VPN), and the VpnService findings behind it.

---

## 0. The two things this plan fixes

**A route that cannot be verified.** `health` has only ever reported `unverified`, because nothing anywhere proves traffic actually leaves through the proxy. That is honest, but it is not a product: an operator has no way to tell a working route from one that is up and carrying nothing — which is exactly the state that consumed a whole debugging session, with the device reporting `up: true` while every SOCKS5 session failed.

**A route that fails open.** When the route drops, the device silently reverts to its real IP. Nothing blocks traffic, nothing tells anyone. This was hit in practice: a geo check ran seconds after a lease expired and returned the operator's real Indonesian IP instead of the Japanese proxy. For a QA farm that is a confusing result; for a farm where the whole point is that a device presents a specific network identity, a silent fallback is the worst possible failure mode — it does the opposite of what was asked, quietly.

Both are the same underlying gap: **the system reports intent, not reality.**

## 1. Goals

1. `health` is computed from named checks that each ran, not from a single opaque enum.
2. An egress probe answers what the world actually sees, measured **from the device, through the tunnel**.
3. `health: 'ok'` becomes reachable — and only when every check passes.
4. A route can be configured to **fail closed**: if the tunnel is down, the device sends nothing rather than falling back to its real address.
5. IPv6 is verifiably blocked rather than accidentally blocked.
6. Studio shows which check failed, not just that something did.

## 2. Non-goals

- Rotating or replacing an upstream automatically when a check fails. Detect and report; the operator decides. (Spec §17.)
- A hosted probe service. The endpoint is self-hosted and configurable — see §4.3 for why that is a technical requirement, not a preference.
- Per-app routing.
- Fixing the lease-scoped lifetime — that is Plan 52.

## 3. Context and design decisions

### 3.1 One enum cannot answer six questions

`health: 'ok' | 'unverified' | 'degraded' | 'unknown'` collapses several independent facts: is the TUN up, can the tunnel reach the proxy, does traffic leave through it, is the exit where it was asked to be, is DNS leaking, is there a bypass. During bring-up those were false in different combinations and the single value could not say which — so it read `degraded` for hours while the real answer was "the app has no `INTERNET` permission".

Replacing it with a list of checks costs almost nothing and makes the next failure diagnosable from the UI instead of from `adb logcat`.

### 3.2 Why the probe must run on the device, through the tunnel

Checking the exit IP from the host proves the proxy works for the host. It says nothing about the device. The whole failure mode this plan exists for — tunnel up, traffic not flowing — is invisible from anywhere except inside the device's own network namespace.

`RouteVpnService.protectOutbound()` already exists for exactly this and has never been called. It is what lets the probe also measure the *unprotected* path for comparison: a probe through the tunnel and a probe outside it, in the same moment, is what proves the tunnel is actually carrying traffic rather than the device having internet by some other route.

### 3.3 Why the probe endpoint must be yours

A third-party IP echo answers one question: what IP do you appear as. A self-hosted endpoint answers the ones that matter and cannot be outsourced:

- **Which resolver actually looked up the name.** Ask for a unique subdomain per probe and observe which resolver hits your authoritative server. That is real DNS-leak detection — the kind `browserleaks.com/dns` performs — and it is impossible against someone else's endpoint.
- **Whether the request looks like the device or like something else** (headers, TLS characteristics).
- Availability you control, so a failing check means something is wrong with the route rather than with a free service.

During bring-up two different third-party checkers were unreachable through the tunnel while an ordinary site loaded fine, which sent the investigation down a wrong path for an hour. An endpoint we control removes that class of confusion.

### 3.4 Fail-closed is a policy, not a default

Blocking all traffic when the tunnel is down is correct for a device that must present a specific identity, and wrong for a device someone is debugging by hand. So it is a per-device setting with a clear name and an honest description, defaulting **off** — and the UI must say plainly what turning it on means, including that recovering a locked-down device may need adb.

Android's mechanism is always-on VPN with lockdown. The research documents two routes: `DevicePolicyManager.setAlwaysOnVpnPackage` (documented, but requires device-owner, so a factory-clean device) and writing `Settings.Secure.always_on_vpn_app` + `always_on_vpn_lockdown` from adb shell (undocumented, `@hide`, **and marked UNCONFIRMED — it is read only at `Vpn` construction, so it needs a reboot, and nobody has verified it takes effect**). Step 5.1 settles that before anything is built on it.

## 4. Technical design

### 4.1 Checks replace the enum

```ts
export const RouteCheckIdSchema = z.enum([
  'tunnel',    // the device reports a TUN is established
  'upstream',  // a SOCKS5 session reaches the proxy and completes its handshake
  'egress',    // a probe through the tunnel returns an address
  'geo',       // that address matches what the upstream was asked for
  'dns',       // the resolver that looked us up belongs to the upstream's network
  'leak',      // IPv6 blocked; lockdown active when required
])

export const RouteCheckSchema = z.object({
  id: RouteCheckIdSchema,
  state: z.enum(['pass', 'fail', 'skip', 'unknown']),
  detail: z.string().optional(),   // never a credential
  at: z.number().int().nullable(),
})
```

`health` becomes derived, not stored: `ok` when every non-skipped check passes, `degraded` when any fails, `unverified` when `egress` has never run, `unknown` before anything ran. Keep the field — Studio and the API already use it — but compute it, and always return the checks beside it so the UI can say *which*.

`geo` is `skip` when the operator did not state an expectation. Do not infer one from the username: SOAX encodes targeting there (`country-jp-region-tokyo-…`) but that is provider-specific and guessing it would produce confident nonsense against any other provider.

### 4.2 Agent: the `egress-probe` capability

The agent already declares `socks5-route` and `vpn-status`; `egress-probe` is the third, and it must only be advertised once implemented — the registry advertises capabilities honestly or the mechanism is pointless.

New control method `egress.probe`, taking a URL and a timeout, returning both measurements:

```
{ tunnelled: { ok, status?, body?, ms }, direct: { ok, status?, body?, ms } }
```

`direct` uses a socket passed through `protectOutbound()`, so it leaves on the underlying network. Comparing the two is what distinguishes "the tunnel carries traffic" from "the device has internet".

The probe runs on the route service's existing executor — never the main thread. That rule is not negotiable: doing blocking work on the main thread is what produced the ANR and the white screen.

### 4.3 The probe endpoint

A small handler the farm serves, reachable by devices. Returns the observed source address, the resolver that performed the lookup for the unique subdomain, and a request nonce so a cached response cannot be mistaken for a live one.

Configurable per farm (`network.probeUrl`); when unset, the `egress`, `geo`, and `dns` checks are `skip` and `health` stays `unverified` — never silently `ok`.

### 4.4 Fail-closed

A per-device setting `network.failClosed`, default `false`. When on, provisioning also sets always-on with lockdown by whichever mechanism §5.1 proves works, and the `leak` check asserts it is actually in effect rather than assuming the write succeeded.

Two things the UI must state before it can be enabled: the device may need a reboot for it to take effect, and a device whose upstream dies will have **no** connectivity until an operator intervenes.

### 4.5 IPv6

Currently `dumpsys` shows `::/0 unreachable`, which blocks IPv6 leaks — but that is Android's own behaviour for a VPN with no IPv6 address, not something we asked for. It could change with a Builder edit nobody connects to leaks. Make it explicit in `RouteVpnService`, comment why, and have the `leak` check assert it.

## 5. Implementation steps

**5.1 Settle always-on. No feature code.** On a real device, try `settings put secure always_on_vpn_app` + `always_on_vpn_lockdown` + reboot, and confirm whether lockdown actually engages (kill the route, verify the device cannot reach the internet). Record the answer in the research doc either way. **If it does not work, §4.4 falls back to device-owner and the plan's scope changes** — so this is a gate, like Plan 44 §5.1 was.

**5.2 Protocol.** `RouteCheck`, `RouteCheckId`, the `egress.probe` request/result, and `network.probeUrl` / `network.failClosed` in settings. Derive `health` rather than storing it.

**5.3 Probe endpoint.** §4.3, plus the authoritative-DNS hook for the `dns` check. Document how to host it.

**5.4 Agent probe.** `egress.probe` on the executor, using `protectOutbound()` for the direct leg. Advertise `egress-probe` **only now**.

**5.5 Checks in the engine.** Run the checks, map them into status, keep credentials out of every `detail`.

**5.6 Fail-closed.** Per §4.4 and whatever §5.1 established; the `leak` check verifies rather than trusts.

**5.7 IPv6 explicit.** §4.5.

**5.8 Studio.** Per-check rows with state and time; `health` still shown but now expandable to *which*. The failing check names itself in plain language.

**5.9 Smoke test.** Turn Plan 50's stage 8 from a `VALIDATED` proxy into a real egress assertion, and add a fail-closed stage: drop the upstream and assert the device sends nothing.

## 6. Acceptance criteria

1. A working route reports every check `pass` and `health: 'ok'` — the first time that value has ever been reachable.
2. A route whose upstream is unreachable reports `upstream: fail` with the others honest, not a blanket `degraded`.
3. With `probeUrl` unset, `egress`/`geo`/`dns` are `skip` and health stays `unverified`.
4. The probe reports **both** legs; a device with internet but a dead tunnel shows `direct: ok, tunnelled: fail`.
5. `dns` fails when the resolver seen belongs to the device's real ISP rather than the upstream's network.
6. With `failClosed` on, killing the upstream leaves the device unable to reach anything — verified, not assumed.
7. IPv6 is asserted blocked by the `leak` check.
8. No credential in any check `detail`, API response, event log, or Studio view.
9. Studio names the failing check; an operator can act without opening logs.

## 7. Test plan

**Unit** — health derivation across every combination, including all-skip; check serialisation carries no secrets; probe result parsing.

**Device (`ENKAKU_TEST_DEVICE=1`)** — the Plan 50 stages, plus: probe through a working route returns the upstream's country; kill the upstream mid-route and confirm `upstream: fail` while `tunnel` stays `pass`; with fail-closed on, confirm no traffic escapes; confirm IPv6 is unreachable through the tunnel.

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| §5.1 shows adb cannot set lockdown | It is a gate; the fallback is device-owner, and the plan's scope is re-cut before code is written |
| A device is locked down and unreachable | Default off; the UI states the consequence; the smoke test always tears down |
| Probe endpoint becomes a single point of failure | Its absence degrades to `skip`, never to a false `ok` |
| Checks become decorative | Plan 50 criterion 5 applies here too: reverting a fix must fail a named check |
| Probe leaks the credential in `detail` | Acceptance criterion 8 is a grep over every surface |

## 9. Open questions

1. How often should checks re-run? The 20 s heartbeat is the obvious hook, but an egress probe every 20 s per device is real traffic and real cost at fleet scale.
2. Should a failed `geo` check be an error or a warning? A residential pool can legitimately hand out a neighbouring city; being strict would cry wolf.
3. Does fail-closed belong per-device, or per-cluster? Per-device matches the current model, but an operator running a whole cluster in one region will want to set it once.
