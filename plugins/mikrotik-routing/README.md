# @enkaku/plugin-mikrotik-routing

Assigns a farm device its own internet egress path by writing policy routing rules on a MikroTik
router. **It never touches the device** — the only thing this plugin changes is the router. Full
design in `docs/plans/122-m87-mikrotik-routing.md`; this file covers what is actually built so far.

## Status: stages 1 through 4 in progress — through step 122.9, the reconcile loop

This package has a real write path: a device can be assigned to an egress path from the
Assignments tab, reviewed as an exact diff, and applied — and, as of step 122.8, a NAMED GROUP of
devices can be defined once and activated or deactivated as a unit from the Groups tab, with the
router's rules following automatically. A standalone assignment (Assignments tab) still lives in the
implicit group `default` (see `shared.ts`'s own comment); a named group is its own `group:<id>` KV row
(§4.9). See `docs/plans/122-m87-mikrotik-routing.md` §5 for the authoritative status of every step;
this file only tracks what is actually built.

- `src/service/rest-client.ts` — `MikrotikRestClient`: HTTP Basic Auth, a configurable timeout, a
  TLS toggle, and a base URL, talking RouterOS's REST API (`/rest/...`) over `GET`/`PUT`/`PATCH`/
  `DELETE`. Every failure is a typed `MikrotikRestError` (`network` / `auth` / `http` / `parse`),
  never a raw `fetch` error, and the router password is never interpolated into a message —
  `src/service/errors.ts` explains why and how.
- `src/service/schemas.ts` — Zod shapes for every RouterOS REST response this plugin reads. Read
  this file's own header before trusting a field name: only `/routing/rule`'s shape was verified
  against real hardware (RouterOS 7.24, a hAP ax², plan 122 §0); the other four endpoints follow
  RouterOS's public REST documentation but were not exercised against a live router in this change.
- `src/service/router-driver.ts` — `RouterDriver`, the seam plan 122 §4.1 draws so a second vendor
  or the RouterOS binary API can slot in later without touching anything above it, and
  `MikrotikRestDriver`, its only implementation:
  - `inventory()` — paths (routing tables joined with their own default route, gateway and `active`
    flag — "up" per plan 122 §4.5), interfaces, and DHCP leases (read now for a later step's
    static/dynamic lease check).
  - `listRules()` — every routing rule, managed and foreign alike; classification is a later step.
  - `doctor()` — reachability, auth, best-effort REST version, and — the single most important
    check in the whole plugin (plan 122 §3.2, acceptance criterion 1) — whether the operator's
    **local-exception rule** exists, naming the exact commands to add it when it does not.
  - `createRule`/`updateRule`/`deleteRule` (step 122.6) — real `PUT`/`PATCH`/`DELETE` calls. Every
    `src-address` this driver writes is an explicit `/32` (a correction made right after 122.6
    landed, before it shipped — see the step's own note in the plan doc): `resolve.ts`/`planner.ts`
    match a rule's `src-address` against an endpoint by parsed address *range* (`cidr.ts`'s
    `sameAddressSpec`), not raw string equality, so a bare address and its `/32` spelling are matched
    as the same host either way — the router's real behaviour of echoing `src-address` back in CIDR
    form regardless of what was written can no longer produce a duplicate rule on the next apply.
- `src/index.ts` — the full manifest (step 122.3): `service.permissions` is exactly `device.list`,
  `device.get`, `job.run`, `notify.send` (§4.10 — **no device-control capability of any kind**), a
  `defineService` that registers the three routes below, and a tier-C `surface` (one nav entry, one
  view, `react: { entry: 'index.js' }`) modelled on `plugins/proxy-manager`.
- `src/shared.ts` — grew the KV data model: `CONFIG_KEY`/`ROUTER_KEY` (§4.9's `config`/`router`),
  `PluginConfig`/`RouterConfig`, and (step 122.6) `ASSIGNMENT_KEY`/`StoredAssignment`/
  `readAssignment`/`writeAssignment`/`isAssignmentEmpty` — the device-scoped `assignment` record
  (`pathId`/`groupId`/`lanIp`/`lanIpSource`/`leaseKind`/`since`, plus step 122.10's optional
  `lastVerifiedAt`/`lastPublicIp`), plus `DEFAULT_GROUP_ID`/`DEFAULT_GROUP_NAME` for §9 Q1's implicit
  group. Every read/write pair follows `plugins/proxy-manager/src/shared.ts`'s
  `readProxyRecord`/`writeProxyRecord` discipline. `router` is written `secret: true, hint: false` as
  one atomic row — this plugin ships **no reveal route** (§4.10), so the Settings tab can never read a
  saved connection back; every save re-enters all five fields.
- `src/service/router-config.ts` (step 122.6) — `loadRouterConfig`, factored out of `handlers.ts` so
  the write path (`apply.ts`) refuses with the exact same two messages the read routes already do.
- `src/service/handlers.ts` — three `ctx.onRequest` routes (`inventory`, `rules`, `doctor`), all
  `script.view` (nothing here writes). Every refusal — no connection saved, an incomplete one, or a
  thrown `MikrotikRestError` — answers `200`-shaped `{ ok: false, code, message }`, never a throw.
  `rules` classifies each rule Managed/Foreign via `service/marker.ts`'s `parseMarker` (read, not
  edited, by this step).
- `src/service/apply.ts` + `src/service/apply-routes.ts` (step 122.6) — the write path. `loadFleetState`
  joins `device.list` to every device's own `assignment` note and `identity-bridge.ts`'s resolved LAN
  address; `prepareApply` fetches the router fresh and runs `planner.ts`'s `buildPlan` once, shared by
  `previewPlan` (`POST plan`, no write) and `applyNow` (`POST apply`) so the two can never disagree.
  `applyNow` refuses — zero driver calls — while the §3.2 local-exception check is not `ok`
  (`E_LOCAL_EXCEPTION_NOT_OK`). `executePlan` attempts each `create`/`update`/`delete` row
  independently through the driver; `skip`/`foreign` rows are never touched. `GET fleet`/`POST plan`
  are `script.view`; `POST apply` is `plugin.runtime`.
- `src/service/groups.ts` (step 122.7, pure core; step 122.8 added `slugifyGroupName`/`deriveGroupId`
  and `duplicateDeviceIds`) — the §4.9 `group:<id>` KV shape, the conflict algebra
  (`conflict`/`overlappingDeviceIds`), `decideActivation` (clean/refuse/force), and now the two
  save-time helpers group CRUD needs: an id minted from an operator-typed name (mirroring
  `plugins/proxy-manager`'s own `slugifyProxyName`/`deriveProxyKey`), and the acceptance-criterion-12
  check (the same device listed twice inside one group's own `entries`).
- `src/service/groups-service.ts` (step 122.8) — the I/O layer: `listAllGroups`/`saveGroup`/
  `deleteGroup` (CRUD — refuses a duplicate device at save time, refuses to delete an active group),
  `activateGroup` (§4.6 steps 1–7 — gated on §3.2's local-exception check BEFORE any mutation, writes
  the candidate's own entries into each device's `assignment` note, then reuses `apply.ts`'s
  `applyNow` — the same write path a single Assignments-tab edit goes through, so a group and a
  single assignment can never disagree about how a write happens), `deactivateGroup` (resolves each
  entry against the router's current rules via `resolve.ts`'s `resolveTarget`, then removes or
  disables per `onDeactivate` and clears the entry's `assignment` note). `force` deactivates a
  conflicting group's NON-overlapping entries outright but leaves an OVERLAPPING device's existing
  rule and note untouched, so the candidate's own write turns it into one `update`, never a
  delete-then-create — there is never a window where an overlapping device has no assignment.
- `src/service/groups-routes.ts` (step 122.8) — five routes: `groups` (`script.view`, list),
  `group-save`/`group-delete` (`plugin.data` — editing this plugin's own record), `group-activate`/
  `group-deactivate` (`plugin.runtime` — an action that changes the router, `apply`'s own precedent).
- `src/ui/**` — the Studio screen, five tabs: **Paths** (routing tables with a default route, gateway,
  a best-effort bound-interface join, health, and a `0` assigned-devices column — no group model
  exists yet, so the number is never faked), **Assignments** (step 122.6 — device, LAN address with
  the §3.4 dynamic-lease warning, a manual-IP input for a `needs-address` device, assigned path, path
  health, Unassign, and a "Preview & apply" dialog that shows the exact diff and the local-exception
  status before Confirm), **Groups** (step 122.8 — group list with device count, active state and a
  conflict indicator; create/edit with add/remove entries and an inline duplicate-device warning; an
  Activate dialog showing the group's own declared entries before the click and the real §4.4 plan
  rows/outcomes immediately after, with a Force-activate escalation naming the exact overlap on
  refusal; a Deactivate confirmation stating the immediate traffic consequence; a conflict matrix),
  **Settings** (the connection form, a Test connection button surfacing `doctor()` — with the
  local-exception rule's absence rendered as a prominent warning carrying the exact fix commands,
  §3.2 — the reconcile-interval/confirm/auto-repair preferences, now actually read by the reconcile
  loop below except "Require confirmation" (still saved but unread, since apply and group activation
  both always preview) — and a Reconcile card with a "Reconcile now" button sharing the running
  loop's own state), and **Rules** (every router rule, split Managed | Foreign, foreign rows greyed
  and non-actionable). No unit tests exist under `src/ui/**` — a standing owner instruction (plan 122
  §2); verified by `bun run typecheck` and manual use only.

- `src/service/reconcile.ts` + `src/service/reconcile-routes.ts` (step 122.9) — the reconcile loop. A
  self-rescheduling `setTimeout` (never `setInterval`, cleared on `ctx.onStop`, the interval
  injectable for tests — the same shape `plugins/proxy-manager/src/service/supervisor.ts`'s own probe
  sweep uses, since `PluginServiceContext` has no timer of its own). Every tick re-fetches the
  router's rules and the fleet's own desired state fresh and feeds `drift.ts`'s `classifyDrift`
  (122.2) unchanged — including §3.5's `stale-owner`, made reachable for a device blocked out of
  `device.list` by falling back to an ACTIVE group's own declared `entries` (a standalone,
  never-grouped assignment on a blocked device is a named, real gap this cannot see — it still
  surfaces as an orphan, just not the more specific `stale-owner`; see the file's own header).
  Report-only by default; `autoRepair` (saved since 122.3, unread until now) covers only
  `missing-rule`/`wrong-path`, gated on §3.2, never `duplicate`/`unexpected-managed-rule`/
  `stale-owner`/`path-missing`. `notify.send` fires once per NEWLY-detected drift item per tick (a
  signature that never uses a rule's own `.id`, since §3.3 proved that is not stable across a router
  reboot), never once per standing item per tick. `reconcile` (`POST`, `plugin.runtime`) is the
  "Reconcile now" route, sharing the loop's own single-flight guard and dedup state rather than
  running a second, disconnected pass.

- `src/service/network-probe.ts` + `src/service/browser-probe.ts` (step 122.10) — the mechanism
  behind the two member scripts below. **There is no shell/exec primitive a plugin script can
  reach** — confirmed by reading the whole SDK `DeviceApi` and the core's capability registry;
  `device.shell` exists only as an ACL permission gating the interactive terminal (plan 26), not
  something `ctx.farm.call` can invoke — so both scripts drive a real browser (`ctx.device.app.launch`
  + `ctx.device.dump()`) instead of a command, following the pattern `plugins/networking` already
  proved on real hardware (without importing that package — its `package.json` declares no
  `exports`/`main`). `network-probe.ts` is the pure half: `extractPublicIp`/`extractLanIp` read
  IPv4 tokens out of a page's rendered text (reusing `cidr.ts`'s `rfc1918BlockContaining` to tell a
  private address from a public one), and `decideVerifyOutcome` decides what a fresh public-IP
  reading means against an assignment's own prior baseline. `browser-probe.ts` is the async half:
  one intent launch, one poll loop, a permission-dialog dismiss.
- `src/verify-egress.ts` (step 122.10) — runs on the device under a lease. Reads the device's own
  public IP from `https://api.ipify.org` and compares it against the last public IP THIS SAME
  assignment observed (there is no per-path "known good" IP anywhere in this plugin's data model —
  a path is a routing-table name, and a modem's own address can rotate — so "expected" can only mean
  a learned baseline). `matches` is `null` when there is nothing to compare against yet (no path
  assigned, or the first-ever observation), never a fabricated pass. Always records the fresh
  reading into `assignment.lastPublicIp`/`lastVerifiedAt`, win or lose.
- `src/discover-lan-ip.ts` (step 122.10) — reads a device's own LAN address from
  `https://browserleaks.com/webrtc` (WebRTC ICE candidate gathering — the one web-standard mechanism
  that reveals a device's own local address to a page) and writes `assignment.lanIp` with
  `lanIpSource: 'probe'` (§3.4 tier 2) — needed only for USB-attached devices, which the core
  otherwise knows no address for at all. A page showing more than one distinct private-range
  candidate is reported `ambiguous` and **nothing is written**, rather than guessing.
- `src/activate-group.ts` (step 122.10) — a thin wrapper over `groups-service.ts`'s own
  `activateGroup(ctx, group, force)`, so a rotation between named groups is an ordinary scheduled
  job. `ctx` (a `ScriptContext`) is handed straight through as the host — every enforcement point
  (the §4.6 conflict check, the §3.2 local-exception gate, the duplicate-device guard) lives inside
  that one function, never reimplemented here.

## Testing

Every test in this package runs against a fake HTTP server (`Bun.serve({ port: 0, fetch })`, the
pattern already established in `packages/toolchain/src/manager.test.ts`) or a fake, scripted device
(`browser-probe.test.ts`'s own `fakeCtx`) — no real router or device is needed, or was used, to
write or verify this code.

```bash
bun run --cwd plugins/mikrotik-routing test
```
