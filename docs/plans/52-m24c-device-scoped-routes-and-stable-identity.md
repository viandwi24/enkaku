# Plan 52 — M24c : Routes belong to the device, and keep a stable identity

> Status: implemented — lease-scoped teardown is removed (`onManualRevoked` deliberately leaves the route alone), routes are restored on device-online/core-start, and the AES-256-GCM `network_credentials` store replaces plaintext secrets.
> Ships: packages/core/src/network/credential-store.ts
> **Depends on:** Plan 44 (the working route), Plan 50 (smoke test), Plan 51 (verification — a persistent route that cannot be verified is worse than none).
> **Spec references:** §7.9 (network layer), §17 (positioning).
> **Supersedes:** Plan 44 §1 goal 4 and its lease-scoped lifetime.

---

## 0. The design mistake this corrects

Plan 44 tied a route to a **lease**: applied on acquire, torn down on release, expiry, disconnect, or the device going offline. That was written to prevent one device's routing from leaking into the next tenant's session, and as a safety property it was right.

As a product model it is wrong, and it showed up as a bug report within hours: an operator set a proxy, checked the device's geo IP, and got their own real address — because the lease had idle-timed-out ninety seconds earlier and taken the route with it. Nothing was broken; the system did exactly what it was designed to do, and the design was wrong.

A device's network route is a property of **the device**, not of whoever happens to be holding control. A phone pinned to a region should stay pinned across leases, reboots, and core restarts — that is true for regional QA testing and it is true for any farm where a device is expected to present a consistent network identity. The tenant-isolation concern is real but is answered by ownership and audit, not by tearing the route down.

## 1. Goals

1. A route survives lease release, lease expiry, client disconnect, device reboot, and a core restart.
2. On a device coming online with a configured route, the core restores it — verified, not assumed.
3. Each device holds a **stable upstream identity**: the same exit address across reconnects, not a fresh one from the pool every time.
4. Credentials are stored properly, not as plaintext in the devices table.
5. The devices list shows each device's route, exit address, and verification state at a glance.
6. Turning a route off is an explicit act, and the only thing that does it.

## 2. Non-goals

- **Pools, rotation, or binding a route to an account or persona.** Spec §17. This plan makes one operator-set route per device durable; it does not add a mechanism for cycling through many.
- Per-app routing.
- Automatically replacing an upstream that fails a check — detect and report (Plan 51), the operator decides.
- Fleet-wide bulk assignment. One device at a time is enough to prove the model; bulk is a follow-up.

## 3. Context and design decisions

### 3.1 What replaces lease-scoping as the safety property

Dropping lease-scoped teardown removes a real protection, so it has to be replaced rather than deleted:

- **Ownership is visible.** A device's route, its upstream, and who set it are shown wherever the device is shown. A tenant who acquires a device sees immediately that it is routed and where.
- **Every change is audited.** `network.applied` / `network.reverted` already carry an actor; that becomes the record of who pinned a device and when.
- **Turning it off is one click**, from the device page, with no lease gymnastics.

The thing lease-scoping actually protected against — a device silently carrying someone else's routing into your session — is solved by making it *not silent*.

### 3.2 Restore, never blind re-apply

On boot or on a device coming online, the core must not simply re-run `apply()`. Plan 44's reconcile already probes rather than reapplies, and that instinct was right: a route that was enabled before a crash may point at an upstream that has since expired, and blindly bringing it up would produce a device that looks routed and carries nothing — the exact failure this whole line of work has been fighting.

So: probe first, report drift, and only apply when the device reports no route. Log the decision either way.

### 3.3 Stable identity, and its limit

Residential pools rotate. Two consecutive checks during testing returned `106.155.0.92` and `106.155.0.51` — same provider, same city, different address. For a device expected to look consistent, that is a problem the proxy provider solves with **sticky sessions**: a token, usually carried in the username, that asks for the same exit across connections.

The mechanism is provider-specific, so the design must not hardcode one vendor's syntax. Store a per-device `sessionId` and a farm-level template describing where it goes (for example `…-sessionid-{id}` appended to the username). Generate the id once per device, keep it with the route, and expose it read-only so an operator can see why a device keeps a given address.

**State the limit honestly in the UI:** stickiness is a request, not a guarantee. Providers expire sessions, and no setting on our side changes that. Plan 51's `geo` check is what tells you when the exit has moved.

### 3.4 Credentials

Plan 44 stored the upstream password as plaintext in `devices.network_route`, with a comment saying so and pointing at Plan 33 §9 Q2. That was acceptable for proving a path; it is not acceptable for a product, and it gets worse the moment routes are durable and fleet-wide.

Introduce a small credential store: named entries, the secret encrypted at rest with a farm key derived from the data dir, and routes referencing an entry by name. `credentialRef` already exists in the schema for exactly this. The API never returns a secret, the event log never records one, and Studio only ever shows the name.

This also fixes a workflow problem: the same upstream currently has to be retyped per device, including the password.

## 4. Technical design

### 4.1 Lifecycle

Remove the four lease-teardown revert calls (`daemon.ts` `onManualRevoked` and device-offline; the two TODOs in `ws-handlers.ts` are now moot and should be deleted rather than implemented). Replace with:

| Event | Behaviour |
|---|---|
| lease released / expired / client disconnect | **nothing** — the route stays |
| device offline | keep the stored route; mark checks `unknown` |
| device online | restore per §3.2 |
| core start | restore for every device with a route |
| explicit off (Studio or API) | tear down, keep config |
| explicit remove | tear down, clear config |
| agent uninstalled | tear down, clear config (already fixed in Plan 44) |

The dead-man's switch stays as-is: it is the device's protection against a farm that has vanished, and a durable route makes it more important, not less. The heartbeat must therefore run for every device with a live route regardless of lease state — which it already does, since it keys off `enabled` rather than the lease.

### 4.2 Credential store

New table `network_credentials`: `name` (unique), `username`, `secret` (encrypted), `createdAt`, `createdBy`. Key derived from a file in the data dir, created on first use with `0600`. Not a KMS and not pretending to be — the honest claim is "not readable by grepping the database", and the schema comment should say exactly that rather than implying more.

`Socks5RouteConfig` gains `credentialRef` and drops inline `username`/`password` once migrated. A migration moves existing inline credentials into named entries so nothing is lost.

### 4.3 Sticky identity

`devices.network_route` gains `sessionId`, generated on first apply and stable thereafter, regenerated only when the operator explicitly asks. A farm setting `network.sessionTemplate` describes how it is injected — default empty, meaning no stickiness, so nothing provider-specific is assumed.

### 4.4 Fleet visibility

The devices list gains a Route column: upstream name, exit address, and Plan 51's health, with a filter for routed/unrouted/failing. Reuse the existing list machinery; do not build a second table.

## 5. Implementation steps

**5.1 Credential store.** §4.2 plus the migration off inline secrets. → a route applies from a named credential; the password appears nowhere outside the store.

**5.2 Lifecycle change.** §4.1: remove lease teardown, add restore on device-online and core-start. → a route survives lease expiry, a reboot, and a core restart, and the smoke test's teardown stage still leaves the device clean.

**5.3 Restore semantics.** Probe-then-decide per §3.2, logging what it found. → a device that lost its route while offline is restored; one that still has it is left alone.

**5.4 Sticky identity.** §4.3. → the same device keeps the same exit across reconnects when a template is set, and `geo` (Plan 51) reports it when the provider moves anyway.

**5.5 Studio.** The Route column and filter; the device page shows owner, session id, and last change. → "which devices are routed, and are they healthy" is one glance.

**5.6 Smoke test.** Extend Plan 50: apply a route, release the lease, assert the route is still up; restart the core, assert it is restored.

**5.7 Docs.** Amend spec §7.9 rule 1 — it currently states routes are lease-bound, which this plan reverses. Note the reasoning so the reversal is not mistaken for drift.

## 6. Acceptance criteria

1. A route survives lease release, expiry, disconnect, device reboot, and core restart.
2. A device coming online with a stored route is **probed** first; a device already carrying it is not re-applied, and the decision is logged.
3. Turning a route off keeps the credential; removing it clears the config but not the stored credential.
4. No plaintext secret in `devices`, any API response, the event log, or Studio.
5. Two devices can share one named credential without it being typed twice.
6. With a session template set, a device reports the same exit across a disconnect/reconnect.
7. The devices list shows route and health per device and can filter on them.
8. Uninstalling the agent still clears the route (Plan 44's fix must not regress).
9. `bun run typecheck` clean, `bun test` green, and Plan 50's smoke test passes including the new stages.

## 7. Test plan

**Unit** — restore decision table (offline/online × route present/absent); credential encrypt/decrypt round-trip; migration off inline credentials; session template rendering, including a template that does not mention the id.

**Device** — Plan 50's stages plus 5.6's. Explicitly: kill the core with a route up, restart, and confirm the route is intact and verified rather than reapplied.

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| **A durable route is a durable way to leak** if it silently dies | Plan 51 is a hard dependency: persistence without verification is worse than no persistence |
| Losing lease-scoped isolation surprises a tenant | §3.1 — visible ownership, audit, one-click off |
| Encryption implies more safety than it provides | The claim is written down honestly, in the schema comment and the UI |
| Sticky session read as a guarantee | The UI states it is a request; the `geo` check is what actually reports the truth |
| Scope drifts toward pools and rotation | §2 and spec §17; `Socks5RouteConfig` has no field to grow one into |

## 9. Open questions

1. **Should a route auto-restore on core start, or wait for an operator?** Auto is what makes a farm usable; wait-for-operator is safer after an incident. A farm-level setting is the likely answer, but the default matters more than the setting.
2. Where does the encryption key live for a Docker deployment with a mounted data dir? The file-in-data-dir approach is honest for a single host and weak for a shared volume.
3. Is `sessionId` per device, or per device-and-credential? Two credentials on one device (rare, but a region switch would do it) probably want separate sessions.
4. Does the cloud path need anything? The agent runs the adb commands, so it should be unchanged — but that assumption has not been tested even once, and it has been carried unexamined since Plan 44 §9.
