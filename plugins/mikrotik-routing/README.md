# @enkaku/plugin-mikrotik-routing

Assigns a farm device its own internet egress path by writing policy routing rules on a MikroTik
router. **It never touches the device** — the only thing this plugin changes is the router. Full
design in `docs/plans/122-m87-mikrotik-routing.md`; this file covers what is actually built so far.

## Status: stage 1 (read-only) and stage 2 (single assignments) — through step 122.6

This package now has a real write path: a device can be assigned to an egress path from the
Assignments tab, reviewed as an exact diff, and applied. Named groups (activate/deactivate many
devices as a unit) are NOT built yet — `service/groups.ts` (step 122.7) landed its pure algebra only;
group CRUD and activation are step 122.8's job. Every assignment made today lives in the implicit
group `default` (see `shared.ts`'s own comment). See `docs/plans/122-m87-mikrotik-routing.md` §5 for
the authoritative status of every step; this file only tracks what is actually built.

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
  (`pathId`/`groupId`/`lanIp`/`lanIpSource`/`leaseKind`/`since`), plus `DEFAULT_GROUP_ID`/
  `DEFAULT_GROUP_NAME` for §9 Q1's implicit group. Every read/write pair follows
  `plugins/proxy-manager/src/shared.ts`'s `readProxyRecord`/`writeProxyRecord` discipline. `router` is
  written `secret: true, hint: false` as one atomic row — this plugin ships **no reveal route** (§4.10),
  so the Settings tab can never read a saved connection back; every save re-enters all five fields.
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
- `src/ui/**` — the Studio screen, four tabs: **Paths** (routing tables with a default route, gateway,
  a best-effort bound-interface join, health, and a `0` assigned-devices column — no group model
  exists yet, so the number is never faked), **Assignments** (step 122.6 — device, LAN address with
  the §3.4 dynamic-lease warning, a manual-IP input for a `needs-address` device, assigned path, path
  health, Unassign, and a "Preview & apply" dialog that shows the exact diff and the local-exception
  status before Confirm), **Settings** (the connection form, a Test connection button surfacing
  `doctor()` — with the local-exception rule's absence rendered as a prominent warning carrying the
  exact fix commands, §3.2 — and the reconcile/confirm/auto-repair preferences), and **Rules** (every
  router rule, split Managed | Foreign, foreign rows greyed and non-actionable). No unit tests exist
  under `src/ui/**` — a standing owner instruction (plan 122 §2); verified by `bun run typecheck` and
  manual use only.

## Testing

Every test in this package runs against a fake HTTP server (`Bun.serve({ port: 0, fetch })`, the
pattern already established in `packages/toolchain/src/manager.test.ts`) — no real router is
needed, or was used, to write or verify this code.

```bash
bun run --cwd plugins/mikrotik-routing test
```
