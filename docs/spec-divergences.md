# Spec ⇄ code divergence register

## What this file is

This file is the deliverable of Plan 84 (M49 — Spec Reconciliation): a durable, append-only
record of every place `docs/spec.md` and the shipped code disagree, one row per divergence.
It exists so a disagreement, once found, is written down exactly once — never rediscovered by
a future audit, and never silently "fixed" by an agent that assumes the code must be right
just because it compiles and ships.

**This file outlives Plan 84.** When later work adds a table, endpoint, protocol message,
screen, or engine without updating `spec.md` in the same commit, the Definition of Done
(`docs/plans/00-overview.md` §7, once Plan 84 §4.4 lands) requires a new row here instead —
appended with the next unused `DIV-` id. Rows are never renumbered, never deleted, and never
inserted into the middle of the existing sequence. A closed row (once it has a `decision`)
stays exactly as decided; if reality changes again later, that gets a *new* row that references
the old one, not an edit to it.

**The `decision` column was blank on every row below until 2026-08-09, on purpose.** Filling it
in was step 84.4 of Plan 84 — a hard stop reserved for the product owner, not for whoever merged
this register. Plan §3.7 names the exact temptation that guarded against: *"it is tempting to
'just update the spec to match the code'... Some of the [undocumented] tables represent
deliberate product growth the spec should absorb. Others may represent scope that grew because
an agent found it convenient... The audit cannot tell those apart, and neither can an agent."*
`recommendation` below remained this audit's opinion throughout; `decision` is the owner's alone.

**Every `decision` cell is now filled — step 84.5 — but not every one carries the same weight,**
and the cell text says so explicitly rather than let a reader infer it:

- **Four rows (DIV-048, DIV-040, and the two "Cluster" groups) were ruled on by the owner
  directly, 2026-08-09**, and are marked `owner decision, 2026-08-09` in their own words.
- **Two pairs (DIV-009/DIV-055, and DIV-068/DIV-069) were resolved by the manager**, not sent to
  the owner because they are factual-staleness or code-internal questions, not scope questions —
  marked `manager decision (not owner-adjudicated)`. **DIV-068/DIV-069 were then CLOSED on
  2026-08-09**, at the owner's request once the audit surfaced them: `descriptors.ts` now
  advertises `probe` and `CLAUDE.md`'s rule was corrected. They are the first rows in this
  register to move from recorded to fixed, and they are kept here rather than deleted — a closed
  row stays exactly as decided (see the append-only rule above).
- **The remaining `needs-owner` rows not individually named above** (roughly 31, in device
  readiness, tags, KV store, presence, clipboard, transfer progress, batch/schedule pushes, and a
  few Studio screens and driver-engine wording fixes) are marked **`follows owner direction
  2026-08-09 — not individually ratified`** — deliberately distinct wording, so any one of them
  can be overturned cheaply later without disturbing the four the owner actually looked at. This
  is Plan §3.7's guard applied at the decision stage, not just the recommendation stage: an
  inference about what the owner *would probably* say is never written up as if the owner *did*
  say it.
- **Two `spec-wins` recommendations existed (DIV-059, DIV-067) and both were overridden** — see
  each row for why neither produced a defect plan.
- Rows the audit itself was already confident about (the `ai_agents` family, decided 2026-08-03;
  most of the plain table/endpoint naming gaps) are marked `accepted, 2026-08-09` — not sent to
  the owner as a scope question, because they were never a scope question.

## Scope and provenance

**Audited commit:** `9820492` (`git rev-parse --short HEAD` at the time all six passes ran).
Every citation below — `file:line` for code, `spec.md:line` for the spec — was read against
this commit, across six independent, mechanical passes run by four workers: tables, HTTP
endpoints, WebSocket protocol messages, Studio screens, driver engines, and enumerations
(Plan 84 §4.3). This document is their merge, not a re-audit.

**This is a snapshot, not a permanent census.** Plan 85 (M50 — Windows fleet scale) is landing
concurrently with this audit and adds new settings, endpoints, and protocol messages of its
own. Plan 85's step 85.9 is responsible for appending further `DIV-` rows for whatever it
introduces once it lands — this register does not attempt to audit work that had not shipped
at the commit above, and a reader should not treat the absence of a Plan-85 feature here as
either "accounted for" or "missed."

## Corrections to Plan 84's own counts

Two of Plan 84 §3's own numbers were wrong, caught by this audit applying its own "search the
whole file" method more thoroughly than the plan itself did when it was written:

- **§3.1 claimed 7 tables are documented in spec.md and 29 are not.** The real split is
  **8 documented, 28 undocumented**. `plugins` is substantively described in §11.6 ("Publishing
  a plugin writes one `plugins` row..."), outside §12 — the data-model section the plan's own
  count only checked. This register uses 8/28 throughout, not the plan's 7/29.
- **§3.3 claimed spec §19 describes "roughly five" screens.** The `## 19. Studio — screen spec`
  table literally has **seven** rows (Dashboard, Enrollment wizard, Device detail / live
  control, Scripts, Job / run detail, Tools (Toolchain), Settings), and there are **5**
  `/agents*` Studio routes, not the 6 this task's own brief assumed. Both are corrected here.

**One row runs the opposite direction from almost everything else in this register.** Every
other row here has the same shape: code grew past what the spec describes, and the
recommendation is to bring the spec up to date (`code-wins`) or ask the owner whether the growth
was wanted (`needs-owner`). **`DIV-059` is not that shape.** `spec.md:791` promises "DB backup
and restore" as a Settings-screen feature, and no such feature exists anywhere in the code — the
only "backup" reference in the whole repo is a doctor-check remedy string telling the *operator*
to restore a database backup they made themselves, outside the product. `DIV-059`'s
recommendation is `spec-wins`: the spec promised something unbuilt, so it needs a defect plan
(Plan 84 §84.5), not a spec edit. Watch for it — it is easy to miss among 71 rows that all point
the other way. **Update, 2026-08-09:** the owner overrode this recommendation — see DIV-059's
`decision` cell. The claim is withdrawn from spec.md rather than pursued as a defect, and no
defect plan exists for it. `DIV-067` (§7.1, scrcpy's codec claim) was the register's other
`spec-wins` row and was likewise overridden, for a different reason (spec wording error, not
overridden by product judgment) — between the two, this register ends with **zero** open
`spec-wins` decisions and therefore zero defect plans, despite two `spec-wins`
*recommendations* existing.

**Merge-time corrections.** While merging the six fragments, two numbers were independently
re-verified against the repository rather than carried over as written, in keeping with Plan 84
§3's own warning that miscounts compound when nobody re-checks them: the endpoints pass's
fragment stated "Row count: 13" but its own table lists 14 distinct rows — this register uses
14. And the tables pass's column-staleness caveat cited `devices` at 26 columns and `jobs` at 25
relative to code; a direct re-count against `packages/core/src/db/schema.ts` at the audited
commit gives **24 and 24** (`DIV-029` uses the verified numbers — the *set* of newly added
columns the pass named was correct, only the totals were off by a couple).

## The scale, as measured

| Measured | Count |
|---|---|
| Tables in `packages/core/src/db/schema.ts` | **36** |
| HTTP routes mounted from `packages/core/src/server/http.ts` | **169** |
| Protocol messages (`ServerMessageSchema` + `ClientMessageSchema`, `@enkaku/protocol`) | **97** (62 server / 35 client) |
| Studio routes (`page.tsx` under `packages/studio/src/app`) | **23** |
| Driver engines, across the 5 driver layers (transport, display, input, inspector, network) | **13** |

Of the 36 tables, 8 are documented in spec.md and 28 are not (corrected count, see above). Of
the 23 Studio routes, 8 map onto spec §19's 7 documented screen rows and 15 are gaps. This
register carries **72 rows** in total across all six passes.

---

## Needs-owner rows — read this first (35)

These 35 rows are the ones this audit could not, and should not, resolve on its own — either
because the audit found the code split against itself, or because the underlying question is a
product-scope call, not a documentation gap. Everything else in the register further down is
either already decided (the `ai_agents` family, owner decision 2026-08-03, Plan §9 Q1) or this
audit's own opinion about which way a plain wording fix should go.

### High severity, needs-owner (4)

| id | area | subject | spec says | code does | severity | recommendation | decision |
|---|---|---|---|---|---|---|---|
| DIV-009 | §4, §5.3, §7, §14 | `nodes` table vs. spec's stale "agent" terminology | §4's architecture tree lists `agent/  # the cloud tunnel mini-core (M8)` (`spec.md:79`); §5.3 (`spec.md:104`): "a lightweight **agent** (a mini-core) that opens an outbound WebSocket tunnel"; §7.1's Transport row (`spec.md:237`): "the tunnel is the agent's outbound WS" — only §14 (`spec.md:711`) uses the post-rename name: "The node tunnel uses a token (the process was called an \"agent\" before plan 61 renamed it)." | Cloud nodes table, one holding many devices, enrolled via a single-use token then a long-lived credential hash (`packages/core/src/db/schema.ts:511-528`, plan 11 §4.3, renamed from `agents` in plan 61; the real package on disk is `packages/node/`, not `packages/agent/`). | high | needs-owner | **code-wins — manager decision (not owner-adjudicated), 2026-08-09.** This is factual staleness, not a scope question, so it did not go to the owner. §4's tree, §5.3, and §7.1's Transport row are corrected to "node" (§14 already used the post-rename name). Applied to spec.md in this pass. |
| DIV-048 | §11.3 | On-device monitor (logcat/perf live stream) and interactive shell — a different trust boundary than §11.3 describes | §11.3 ("Trust model and isolation"), `spec.md:557`: **"The local/self-host trust model is 'the script author is a trusted operator.'"** — the isolation that exists is crash containment, explicitly not a security boundary, and it is written for an *operator's own script*, a single actor. | server: `monitor.started`, `monitor.data`, `monitor.ended`, `monitor.result`, `monitor.subscribers` (`packages/protocol/src/messages/shell.ts:51,64,69,74,90`), `shell.echo`, `shell.result` (`:130,144`); client: `monitor.start`, `monitor.stop`, `monitor.oneshot` (`:25,37,43`), `shell.exec` (`:108`) — 11 messages giving an authenticated **browser session** a live interactive shell plus raw adb access to a leased device. | high | needs-owner | **code-wins — owner decision, 2026-08-09.** The spec is extended, the feature stays: the code wins. §11.3 is rewritten to cover a second actor — an authenticated operator working through the browser, not only "the script author" running a script — naming the interactive shell and the `monitor.*` live streams explicitly, stating plainly what lease-gating and authentication do and do not guarantee. Same ruling as DIV-040 (the REST-level half of this same trust boundary). Not softened into vagueness, per the owner's explicit instruction. |
| DIV-055 | §19, §4 | `/nodes` — cloud node fleet screen, plus a naming collision with the newer AI-agent feature | Nothing in §19; separately, §4's package tree (`spec.md:79`) still says `agent/  # the cloud tunnel mini-core (M8)`. | `packages/studio/src/app/nodes/page.tsx:44-48` — own comment: "Renamed from \"Agents\" in plan 61 — the tunnel process is a node everywhere now, so \"agent\" is free for the AI feature starting in plan 63." A reader following `spec.md:79` today would misidentify what "agent" currently means in this product. | high | needs-owner | **code-wins — manager decision (not owner-adjudicated), 2026-08-09.** Same ruling as DIV-009 (same terminology fix). No `/nodes` screen row is added to §19 individually — the underlying naming confusion is what needed fixing, and it now is. |
| DIV-058 | §19 | `/settings` — AI Agents / Connectors / Webhooks / Audit-log / KV-store section group has grown well past its spec description | `spec.md:791`: "Farm-wide defaults (driver, timing, default input mode), users and ACL (admin), retention policy, DB backup and restore." — no mention of connectors, webhooks, audit log, KV store, blocked devices, or per-agent spend. | `packages/studio/src/app/settings/page.tsx:72-101` — 4 groups / 12 named sections: Devices, Jobs, AI Agents (Defaults, Connectors, Webhooks, Spend), Farm (Blocked devices, KV store, Users, Audit log) — more than double what spec describes. | high | needs-owner | **code-wins — follows owner direction 2026-08-09 — not individually ratified.** Not one of the owner's four named rows. §19's Settings row is updated to match reality (and to drop the now-withdrawn "DB backup and restore" claim, DIV-059), but the grouping itself was not individually reviewed. |

### Medium severity, needs-owner (28), grouped by pass

**Tables (4)**

| id | area | subject | spec says | code does | severity | recommendation | decision |
|---|---|---|---|---|---|---|---|
| DIV-015 | none | `workspace_files` — the AI agent's virtual, DB-backed filesystem | nothing | Content-addressed virtual filesystem the AI agent reads/writes instead of the real OS filesystem — deliberately, since scripts (and an agent reading attacker-controllable device screens) run under crash containment, not a sandbox (`packages/core/src/db/schema.ts:667-688`, plan 64 §3.1, §4.1). Named in Plan 84 §9 Q2 as open scope, distinct from the settled `ai_agents` family. | medium | needs-owner | **code-wins — owner decision, 2026-08-09 (Cluster A).** `workspace_files` is described in the spec alongside the AI agent section. Described in spec.md §12.2. |
| DIV-018 | none | `connectors` — farm-level LLM provider endpoints feeding the AI agent | nothing | A configured AI-provider endpoint (Anthropic, OpenRouter, ...) plus an AES-256-GCM-encrypted credential, farm-level and shared across agents (`packages/core/src/db/schema.ts:780-794`, plan 65 §3.2, §3.6, §4.1). Named in Plan 84 §9 Q2. Close to load-bearing for the `ai_agents` decision (an agent needs a connector to run at all), worth deciding alongside it rather than separately. | medium | needs-owner | **code-wins — owner decision, 2026-08-09 (Cluster A).** `connectors` is load-bearing — an agent cannot run at all without one — so it was decided alongside `ai_agents` rather than separately, per the owner's own reasoning. Described in spec.md §12.2. |
| DIV-026 | none | `notifications` — the in-app notification record | nothing | Written FIRST, before any webhook delivery is attempted, so the record survives even when delivery fails; `context` makes a row clickable (`packages/core/src/db/schema.ts:1053-1069`, plan 68 §3.4, §4.1). Not named in Plan §9 Q2's list, but tightly coupled to `webhook_endpoints` (same plan, same delivery mechanism) — recommend deciding both together. | medium | needs-owner | **code-wins — owner decision, 2026-08-09 (Cluster A).** Decided together with `webhook_endpoints`, as this row's own note recommended. The table and its REST API are described in spec.md §12.2; the `notification.created` push (DIV-052) is a separate, not-individually-ratified row — see there. |
| DIV-027 | none | `webhook_endpoints` — farm-level, admin-managed webhook targets | nothing | An agent can only choose among these by NAME via `notify.send`, never a raw URL, so a webhook cannot leak farm data to an arbitrary address (`packages/core/src/db/schema.ts:1080-1094`, plan 68 §3.4, §4.1). Named in Plan §9 Q2. | medium | needs-owner | **code-wins — owner decision, 2026-08-09 (Cluster A).** Described in spec.md §12.2. |

**Endpoints (10)**

| id | area | subject | spec says | code does | severity | recommendation | decision |
|---|---|---|---|---|---|---|---|
| DIV-031 | none | Connectors REST API | nothing | `GET/POST/PATCH/DELETE /api/connectors`, `GET /:id/models`, `POST /:id/test` (`packages/core/src/api/connectors.ts:34-72`, 7 routes). | medium | needs-owner | **code-wins — owner decision, 2026-08-09 (Cluster A).** Described in spec.md §12.2. |
| DIV-032 | none | Webhooks REST API | nothing | `GET/POST/PATCH/DELETE /api/webhooks` (`packages/core/src/api/webhooks.ts:33-52`, 4 routes). | medium | needs-owner | **code-wins — owner decision, 2026-08-09 (Cluster A).** Described in spec.md §12.2. |
| DIV-033 | none | Clusters and topology REST API | The words "clusters" and "topology" appear once each, in passing, at `spec.md:316` — never described as a feature. | `GET/POST/PATCH/DELETE /api/clusters`, `POST/DELETE /:id/devices`, `POST /preview` (`api/clusters.ts:72-203`, 8 routes); `GET /api/topology` (`api/topology.ts:92`, 1 route). | medium | needs-owner | **code-wins — owner decision, 2026-08-09 (Cluster B).** The scheduling subsystem is wanted scope. Described in spec.md §12.3. |
| DIV-034 | none | Batches REST API | nothing | `POST/GET /api/batches`, `GET /:id`, `POST /:id/cancel`, `POST /:id/rerun-failed` (`api/batches.ts:151-199`, 5 routes). Matches the `batches` table (DIV-011). | medium | needs-owner | **code-wins — owner decision, 2026-08-09 (Cluster B).** Described in spec.md §12.3. |
| DIV-035 | §10 (different meaning) | Schedules REST API — cron-style recurring runs | §10's title is "Session, lease, queue, **scheduler**" but its content is entirely the per-device job-queue picker (§10.3), a different mechanism than cron dispatch. | `POST /validate`, `GET/POST /api/schedules`, `GET/PATCH/DELETE /:id`, `GET /:id/runs`, `POST /:id/run-now` (`api/schedules.ts:318-536`, 8 routes). A naive reconciliation could wrongly treat §10's text as already covering this. | medium | needs-owner | **code-wins — owner decision, 2026-08-09 (Cluster B).** Described in spec.md §12.3. §10 gains an explicit note (as this row itself warned would be needed) that its "scheduler" title covers only the per-device job-queue picker, not this cron-dispatch subsystem — otherwise a future reader would wrongly conclude §10 already covers it. |
| DIV-036 | none | Durable KV store REST API (admin-scoped) | nothing | `GET /`, `GET/PUT/DELETE /entry` under `/api/kv` (`api/kv.ts:59-105`, 4 routes). Matches the `kv_entries` table (DIV-017). | medium | needs-owner | **code-wins — follows owner direction 2026-08-09 — not individually ratified.** "The KV store" is one of the owner's named examples of a row in this bucket. Described briefly in spec.md §12.4. |
| DIV-037 | none | Notifications REST API (the bell) | nothing | `GET /`, `GET /unread-count`, `POST /:id/read`, `POST /read-all` under `/api/notifications` (`api/notifications.ts:22-33`, 4 routes). | medium | needs-owner | **code-wins — owner decision, 2026-08-09 (Cluster A).** "Notifications and their REST APIs" was named explicitly. Described in spec.md §12.2. |
| DIV-038 | none | Device tags REST API | nothing | `GET /api/tags` (`api/tags.ts:15`); `PUT /api/devices/:id/tags` (`api/devices.ts:530`). | medium | needs-owner | **code-wins — follows owner direction 2026-08-09 — not individually ratified.** "Device tags" is one of the owner's named examples of a row in this bucket. §7.5 now names the `device_tags` table and this API inline. |
| DIV-039 | none | Device readiness REST API, plus a bundle of small CRUD extras | "Readiness" appears 0 times in spec.md, despite sitting beside the well-documented §7.5 admission flow. | `GET/PUT /api/devices/:id/readiness` (`api/devices.ts:405,419`); also `POST /:id/monitor/save` (515), `POST /:id/unquarantine` (500), `PUT /:id/cluster` (550), `GET /:id/history-counts` (573). Readiness (declared-vs-actual fitness, drives the scheduling pool) is the substantial part of this row; the bundled extras are minor by comparison. | medium | needs-owner | **code-wins — follows owner direction 2026-08-09 — not individually ratified.** "Device readiness" is one of the owner's named examples of a row in this bucket. Described briefly in spec.md §12.4; the bundled CRUD extras (`monitor/save`, `unquarantine`, `cluster`, `history-counts`) are not individually spelled out. |
| DIV-040 | none | Raw device-scoped access: lease-scoped adb endpoint, install/push/pull | §6.1 mentions "drag-and-drop APK" as worth borrowing from OpenSTF, in the competitor-analysis section — not a committed feature. | `POST/DELETE/GET /api/devices/:id/adb-endpoint` (`api/adb-endpoint.ts:72,82,91`); `POST /:id/install`, `POST /:id/push`, `POST /:id/pull` (`api/transfer.ts:85,129,166`). Both lease-gated, but hand a browser session direct adb-level device access — worth reconciling explicitly against §14's "server-authoritative, client never trusted" principle, not just documenting. | medium | needs-owner | **code-wins — owner decision, 2026-08-09.** Same ruling as DIV-048 — this is the REST-level half of the same trust boundary (the lease-scoped raw adb access). §11.3 now names it explicitly rather than reconciling it away. |

**Protocol (7)**

| id | area | subject | spec says | code does | severity | recommendation | decision |
|---|---|---|---|---|---|---|---|
| DIV-044 | none | Presence ("who is watching this device") | "Presence" and "viewers" are named 0 times. | server: `hello`, `device.viewers` (`packages/protocol/src/messages/presence.ts:29,18`). A live multi-viewer indicator with no product description anywhere. | medium | needs-owner | **code-wins — follows owner direction 2026-08-09 — not individually ratified.** "Presence" is one of the owner's named examples of a row in this bucket. Mentioned briefly in spec.md §13. |
| DIV-045 | none | Device readiness WS push/set messages | "Readiness" is named 0 times. | `device.readiness` (`packages/protocol/src/device.ts:156`), `device.readiness.set` (`:141`). Same feature as DIV-039; one underlying concept, two surfaces. | medium | needs-owner | **code-wins — follows owner direction 2026-08-09 — not individually ratified.** "Device readiness" is one of the owner's named examples. Mentioned briefly in spec.md §12.4 and §13, alongside DIV-039 and DIV-071 (same concept, three surfaces). |
| DIV-046 | none | Batch status push | nothing | `batch.status` (`packages/protocol/src/messages/batch.ts:83`). Matches DIV-011 and DIV-034. | medium | needs-owner | **code-wins — follows owner direction 2026-08-09 — not individually ratified.** "Batch status" is one of the owner's named examples of a row in this bucket — despite sitting inside the Cluster B subject area, the owner's Cluster B ruling was explicitly scoped to "3 tables, 21 routes, 6 Studio screens," not the protocol layer, so this WS push was not individually ratified the way the batches table/API/screen were. Mentioned briefly in spec.md §13. |
| DIV-047 | §10 (different meaning) | Schedule fired push | §10's "scheduler" is the per-device job-queue picker (§10.3), not this subsystem. | `schedule.fired` (`packages/protocol/src/messages/schedule.ts:102`). Matches DIV-012 and DIV-035; flagging the "scheduler" name collision again, since a reconciliation pass could paper over it by pointing at §10. | medium | needs-owner | **code-wins — follows owner direction 2026-08-09 — not individually ratified.** "Schedule-fired" is one of the owner's named examples, for the same reason as DIV-046 (Cluster B's ruling covered tables/routes/screens, not this protocol push). Mentioned briefly in spec.md §13; §10's new note (DIV-035) still applies to it. |
| DIV-049 | none | Clipboard sync | nothing | server: `clipboard.value`, `clipboard.ok` (`packages/protocol/src/messages/clipboard.ts:38,44`); client: `clipboard.get`, `clipboard.set` (`:18,24`). | medium | needs-owner | **code-wins — follows owner direction 2026-08-09 — not individually ratified.** "Clipboard" is one of the owner's named examples. Mentioned briefly in spec.md §13. |
| DIV-050 | none | File transfer progress (push/pull/install) | Same §6.1 "worth borrowing" aside as DIV-040 — not a commitment. | server: `transfer.progress`, `transfer.done` (`packages/protocol/src/messages/transfer.ts:16,28`); client: `transfer.cancel` (`:41`). Matches DIV-040. | medium | needs-owner | **code-wins — follows owner direction 2026-08-09 — not individually ratified.** "File-transfer progress" is one of the owner's named examples. Mentioned briefly in spec.md §13, separate from DIV-040's own §11.3 treatment (that row is about the access itself, this one is only the progress push). |
| DIV-052 | none | Notification created push | nothing | `notification.created` (`packages/protocol/src/messages/notify.ts:92`). Matches DIV-026 and DIV-037. | medium | needs-owner | **code-wins — follows owner direction 2026-08-09 — not individually ratified.** The owner's Cluster A wording ("connectors, workspace_files, webhook_endpoints, notifications **and their REST APIs**") named tables and REST APIs, not the WS protocol layer — so, consistent with how DIV-046/DIV-047 were treated relative to Cluster B, this push is not read as covered by that ratification. Mentioned briefly in spec.md §13. |

**Screens (3)**

| id | area | subject | spec says | code does | severity | recommendation | decision |
|---|---|---|---|---|---|---|---|
| DIV-054 | §19 | Scheduling subsystem screens (`/schedules`, `/schedules/detail`, `/batches`, `/batches/detail`, `/clusters`) | nothing — no Schedules/Batches/Clusters row in §19; `schedules`/`batches` are 0-mention tables, `cluster` appears once (`spec.md:316`) describing an unrelated point. | 5 routes under `packages/studio/src/app/{schedules,schedules/detail,batches,batches/detail,clusters}/page.tsx`. Not covered by the 2026-08-03 `ai_agents` decision; Plan §9 Q2 leaves this class open. | medium | needs-owner | **code-wins — owner decision, 2026-08-09 (Cluster B).** New §19 rows added for Clusters, Batches, and Schedules. |
| DIV-056 | §19 | `/plugins` — plugin install/health status screen | Nothing in §19; spec's only 2 "plugin" mentions (`spec.md:571,573`) describe the `definePlugin` SDK authoring API, not an operational screen. | `packages/studio/src/app/plugins/page.tsx` — failed-plugins-first list, verbatim error + code, dev-slot badges (plan 82 §4.6). | medium | needs-owner | **code-wins — follows owner direction 2026-08-09 — not individually ratified.** "The `/plugins`... screen[s]" is one of the owner's named examples of a row in this bucket. New §19 row added. |
| DIV-057 | §19 | `/workspace` — file tree + editor | Nothing; the one "workspace" hit (`spec.md:573`) is about AI-agent capability sections, unrelated to this screen. | `packages/studio/src/app/workspace/page.tsx` — plan 64: tree+editor over the same `fs.*` capabilities the AI agent uses, compare-and-swap saves. `workspace_files` (DIV-015) is its backing table. | medium | needs-owner | **code-wins — follows owner direction 2026-08-09 — not individually ratified.** "...and `/workspace` screens" is one of the owner's named examples — note this is the *screen*; the `workspace_files` *table* (DIV-015) was individually ratified under Cluster A. New §19 row added for the screen. |

**Engines (3)**

| id | area | subject | spec says | code does | severity | recommendation | decision |
|---|---|---|---|---|---|---|---|
| DIV-063 | §7.1 | `cloud-tunnel` transport engine | §7.1's Transport row lists `adb-usb`, `adb-tcp`, and `cloud-tunnel` ("the tunnel is the agent's outbound WS"). | No engine with id `cloud-tunnel` exists — absent from `packages/drivers/src/descriptors.ts` and the registry's `PLANNED` list. `grep -rn "cloud-tunnel"` across `packages/` returns zero hits. Devices behind a node still connect locally via `adb-usb`/`adb-tcp`; the node's own WS tunnel is not modelled as a `Transport` engine. Owner should decide whether §7.1's row describes an architecture superseded by the nodes/relay model (plan 61) and should be reworded, or whether a real `cloud-tunnel` transport is still intended and simply unbuilt. | medium | needs-owner | **code-wins — follows owner direction 2026-08-09 — not individually ratified.** Not one of the owner's four named rows or the two manager rows, but "and similar" covers it. §7.1's Transport row is reworded to describe reality: devices behind a node connect locally via `adb-usb`/`adb-tcp`; the node's own tunnel is not modelled as a `Transport` engine today. |
| DIV-064 | §7.9, §7.1 | `adb-proxy` / `adb-reverse-proxy` network engines | §7.1's Network row lists `adb-proxy`, `adb-reverse-proxy` ("the default recommendation"), `vpn-helper` as the three network engines. | Only `none` and `vpn-helper` are registered (`packages/drivers/src/descriptors.ts:83-108`). `packages/protocol/src/network.ts:7-9` documents the gap directly: "`adb-proxy` and `adb-reverse-proxy`... are deliberately NOT modelled here... deferred by plan 44 §2 to Plan 33 §5.5." A tracked deferral, not an oversight — but spec §7.9 still calls `adb-reverse-proxy` "the default recommendation," which a reader building against the table would expect to exist today. | medium | needs-owner | **code-wins — follows owner direction 2026-08-09 — not individually ratified.** §7.1 and §7.9 are corrected to mark `adb-proxy`/`adb-reverse-proxy` as deferred (plan 44 §2 → Plan 33 §5.5), not shipped — only `none` and `vpn-helper` exist today. |
| DIV-068 | §7.9 rule 3 | `vpn-helper` declares its `probe` capability two contradictory ways in the code itself | §7.9 rule 3: "An engine that can verify egress must offer `probe()`; without a probe, the status is reported as `unverified`, never as `ok`." The rule itself is fine — the two files implementing it disagree with each other. | `packages/drivers/src/descriptors.ts:94-95`: `capabilities: ['auth', 'enforcing', 'udp']` with the comment "// NOT 'probe' — the egress probe does not exist yet and claiming it would be a lie." `packages/drivers/src/network/guest-agent/vpn-helper.ts:132`: `capabilities: { auth: true, enforcing: true, udp: true, probe: true }`, citing plan 51 §4.2/§5.4: "the egress probe now exists on this engine." `deriveHealth()` (`packages/protocol/src/network.ts:304-310`) does return `'ok'` once the `egress` check passes, so the functional behaviour matches spec's rule — only `descriptors.ts`'s generic capability array (and its comment) was never updated when plan 51 landed. **Elevated from the engines pass's original `low`** — this is a code-internal contradiction between two files about the same engine's capabilities, not mere doc staleness, and which declaration is authoritative is a design call. See DIV-069 for the matching `CLAUDE.md` staleness. | medium | needs-owner | **Manager decision (not owner-adjudicated), 2026-08-09 — resolved in favour of the runtime engine.** `vpn-helper.ts:132`'s `probe: true` (plan 51 §4.2/§5.4, a real `probe()` shipped) is authoritative; `descriptors.ts:94-95`'s capability array and its "does not exist yet" comment are stale and should be corrected to include `probe`. `spec.md` never repeated the stale claim (§7.9 rule 3 is the general rule, not this specific claim), so no spec edit was needed. **CLOSED 2026-08-09, at the owner's request after the audit reported it**: `descriptors.ts` now declares `capabilities: ['auth', 'enforcing', 'udp', 'probe']`, and its comment records both why the old one was wrong and the distinction that still matters — advertising `probe` is not the same as passing it, so `deriveHealth` continues to report `unverified` until an `egress` check actually passes. Worth noting for anyone auditing next: this array is served to Studio through `GET /api/registry`, so the stale entry was visible in the product, not only in a comment. `CLAUDE.md` was corrected in the same pass — see DIV-069. |

**Enumerations (1)**

| id | area | subject | spec says | code does | severity | recommendation | decision |
|---|---|---|---|---|---|---|---|
| DIV-071 | none | Device readiness enum (`asleep`/`awake`/`hot`) undocumented | Spec never mentions "readiness," "asleep/awake/hot," or a warm-pool concept; zero hits anywhere in spec.md. `spec.md:765` only says the network layer has "no proxy pool," a different subsystem. | `packages/protocol/src/readiness.ts`: `ReadinessSchema = z.enum(['asleep', 'awake', 'hot'])` (line 16), `ReadinessBlockedReasonSchema = z.enum(['offline', 'quarantined', 'hot_budget_full', 'locked', 'error'])` (line 20), `DeviceReadinessSchema` (lines 29-39) — a second state axis beside `DeviceStatus` (plan 43 §3.1, §3.2). A `hot_budget_full` block reason implies a fleet-wide resource cap, so this changes scheduler-adjacent semantics, not just wording. | medium | needs-owner | **code-wins — follows owner direction 2026-08-09 — not individually ratified.** "Device readiness" is one of the owner's named examples of a row in this bucket. Same underlying concept as DIV-039 and DIV-045; described briefly in spec.md §12.4. |

### Low severity, needs-owner (3)

| id | area | subject | spec says | code does | severity | recommendation | decision |
|---|---|---|---|---|---|---|---|
| DIV-042 | §5.3, §14 | Cloud tunnel node management REST API | The concept is documented ("a lightweight agent... opens an outbound WebSocket tunnel," §5.3; the agent→node rename is narrated in §14) — only the literal endpoint list is missing. | `POST /enroll`, `GET/POST /`, `DELETE /:id`, `GET /ice-config` under `/api/nodes` (`packages/core/src/api/nodes.ts:72-101`, 5 routes). Lower severity than the other endpoint rows because the underlying concept already has real spec prose. | low | needs-owner | **code-wins — follows owner direction 2026-08-09 — not individually ratified.** Not one of the two manager-named terminology rows (DIV-009/DIV-055 fixed the wording, not the endpoint list). §5.3 now also names the literal routes in passing. |
| DIV-065 | §7.1 | `ocr-pixel` inspector engine | §7.1's Inspection row lists `ui-server` (default), `appium` (opt-in), `ocr-pixel` ("last resort") as the three inspection engines. | No `ocr-pixel` engine exists anywhere in `packages/drivers` or the registry. Explicitly the lowest-priority "last resort" rung in spec's own framing; unimplemented but never contradicted elsewhere. | low | needs-owner | **code-wins — follows owner direction 2026-08-09 — not individually ratified.** §7.1's Inspection row now marks `ocr-pixel` as planned/unbuilt rather than implying it ships. |
| DIV-066 | §7.1, §9.5 | `appium` listed as an Input engine, but only registered as `inspector` | §7.1's Input row lists `scrcpy-uhid`, `scrcpy-sdk`, `scrcpy-aoa`, `adb-input`, and `appium` (opt-in) as five input engines. | `appium` is registered only under `kind: 'inspector'` (`packages/core/src/registry/engines.ts:12-30`); `AppiumInspector` implements `dump`/`find`/`screenshot` only, no `tap`/`swipe`/`key`/`text`. The registry's own lock modelling (`locks: ['instrumentation', 'input-injection']`) already signals appium *consumes* the input-injection resource rather than being a distinct `InputSink`, consistent with §9.5's lock table, which never lists a separate `appiumInput`. Likely a wording fix (spec's table conflates appium's two roles into one cell) — or code should add a real input path if one was intended. | low | needs-owner | **code-wins — follows owner direction 2026-08-09 — not individually ratified.** Treated as the wording fix the row itself flagged as likely: `appium` is removed from §7.1's Input row (it is registered only as an inspector that consumes the `input-injection` lock, matching §9.5, which already showed this correctly). |

---

## Full register, by severity

The remaining 37 rows below already have a clear recommendation this audit is confident in —
either `code-wins` (the spec is stale; update it) or, for exactly one row, `spec-wins` (the code
is missing something promised). They are ordered critical → high → medium → low, and within
medium/low, grouped by the pass that found them (tables, endpoints, protocol, screens, engines,
enumerations).

### Critical (0)

None found. No row in any of the six passes contradicts a §2 non-negotiable principle or a
§00-overview.md §3 immutable stack decision. This is stated explicitly, not by omission — see
"What is NOT diverging" below for what was checked and held.

### High (3)

| id | area | subject | spec says | code does | severity | recommendation | decision |
|---|---|---|---|---|---|---|---|
| DIV-059 | §19 | `/settings` — "DB backup and restore" claimed by spec, not implemented | `spec.md:791`: "...retention policy, DB backup and restore." | No backup/restore UI anywhere in `packages/studio/src/app/settings/page.tsx`. The only "backup" reference in `packages/core` is `packages/core/src/doctor/checks/db.ts:15` — a doctor-check remedy string ("restore enkaku.db from a backup, or move it aside...") telling the operator to restore a backup they made themselves outside the product, not a built-in feature. A reader implementing against spec would expect a Settings control that does not exist anywhere in the codebase. | high | spec-wins | **Deliberately withdrawn — owner override, 2026-08-09.** The owner overrode this audit's `spec-wins` recommendation. Enkaku is self-hosted on SQLite, where a backup is copying one file — operator territory, not a product feature. The claim is removed from spec.md §19 (was `spec.md:791`), not quietly deleted: this row records that the removal was deliberate. **No defect plan is filed** — plan 84 §6 criterion 6 requires a defect plan only for a `spec-wins` *decision*, and the actual decision here is withdrawal, not `spec-wins`. **Correction, 2026-08-11: the withdrawal's own reasoning was false for this codebase, and the decision has been reversed.** "Copying one file" is not what a correct backup of this database is: `packages/core/src/db/index.ts:21` sets `PRAGMA journal_mode = WAL` unconditionally, so a live `enkaku.db` is really three files (`enkaku.db`, `-wal`, `-shm`) whose non-atomic copy can yield a torn, unrecoverable set; and `packages/core/src/secrets/store.ts:33` keeps `secrets.key` as a file separate from `enkaku.db` — without it every AES-256-GCM-encrypted credential in a restored database is permanently unreadable, a failure this exact codebase has already suffered once (see that module's own comment on its pre-rename key file). On reconsideration the owner chose a CLI command over both a Settings UI and documentation alone. `enkaku backup` (`packages/core/src/backup/index.ts`, dispatched from `packages/core/src/index.ts`) now exists: it takes the database snapshot via SQLite's own `VACUUM INTO` run over a **read-only** connection — safe against a live, writing core, and correct even with an active, uncheckpointed WAL — then bundles the resulting `enkaku.db` together with `secrets.key` (and, when present, the pre-rename legacy key file) into one `.tar.gz`, so the two cannot be separated by accident; the command's own output warns plainly that the archive can decrypt every credential the farm has ever stored. There is no `enkaku restore` command — restore is rare, deliberate, and only ever done with the core stopped, so the procedure (including the one real trap: stale `-wal`/`-shm` files left in the *target* data directory) is documented instead, in `docs/guide/install.md` under "Backup and restore". **The feature exists in the product again**, which means `spec.md:876`'s current line ("'DB backup and restore' is not a feature — deliberately withdrawn") is now itself the stale claim; that correction is `spec.md`'s to make, not this register's, since `spec.md` is outside this task's file ownership — flagged here so it is not missed. |
| DIV-060 | §19 | `/device` — 8 of 10 tabs undescribed by spec's one-line row | `spec.md:787`: "Video stream plus click input, a driver selection panel..., input mode choice uhid/sdk/aoa, per-device settings (schema-driven), a prep button. While busy: input disabled..." | `packages/studio/src/app/device/page.tsx:459-475` — `EntityTabs` lists Control, Jobs, Monitor, Crashes, Terminal, Files, Network, Identity, Logs, Storage, Settings (Terminal/Files conditionally hidden per farm settings). Reads as §19's table simply never being updated as tabs were added across many plans (crash containment and the network layer are both described elsewhere in spec), not scope creep. | high | code-wins | **Accepted, 2026-08-09.** Not a scope question — the audit's own recommendation is confirmed. §19's Device detail row is updated to list the actual tab set. |
| DIV-070 | §12 | Job status `expired` missing from spec's enum | `spec.md:621`: `status: text('status').default('queued'), // queued\|running\|success\|failed\|cancelled` — five states, no `expired`. | `packages/protocol/src/messages/job.ts:12`: `JobStatusSchema = z.enum(['queued', 'running', 'success', 'failed', 'cancelled', 'expired'])` — six values. `expired` is a real terminal state the queue produces on timeout (`packages/core/src/queue/job-store.ts:470`, plan 21). `packages/core/src/db/schema.ts:220` carries the same stale comment as the spec. A reader implementing a status handler strictly from spec.md would have no `case` for `expired`. | high | code-wins | **Accepted, 2026-08-09.** Not a scope question. §12's `jobs` table comment is updated to add `expired`. |

### Medium (24), grouped by pass

**Tables (21)**

| id | area | subject | spec says | code does | severity | recommendation | decision |
|---|---|---|---|---|---|---|---|
| DIV-001 | none | `device_tags` | nothing | Many-to-many device↔tag table for pool selection ("smoke pool", "Android 15"); no FK to `devices`, cleaned up by the deleter (`packages/core/src/db/schema.ts:87-100`, plan 19 §4.1). Normalisation rule (lowercase/trimmed/`[a-z0-9:._-]`) and the resolver clusters use it for (plan 20) are both undocumented. | medium | code-wins | **Accepted, 2026-08-09.** Cheap to close, as this row itself suggested: the table name and its API are now named inline in §7.5. |
| DIV-004 | §7.5 | `deleted_devices` | "**Forget** now works on a connected device, returning it to the tray." (`spec.md:317`) — nothing about what happens to old references. | Placeholder row (old `devices.id`, `stableId`, label) so `jobs`/`artifacts`/`device_events` pointing at a forgotten device render "deleted device (\<stableId\>)" instead of crashing (`packages/core/src/db/schema.ts:153-160`, plan 47 §3.4). The *consequence* of Forget — dangling foreign-key-shaped references and how the UI copes — is the more surprising half, and it's the part spec doesn't cover. | medium | code-wins | **Accepted, 2026-08-09.** §7.5 now names `deleted_devices` and the `GET /api/devices/refs` resolution endpoint inline. |
| DIV-005 | §7.9 (tangential) | `network_credentials` | "Credentials are referenced, never inlined..." (`spec.md:371`) — a general principle, not this table. | Named upstream credentials for a `vpn-helper` route; `secret` is AES-256-GCM via `credential-store.ts`, referenced by name from `devices.network_route.config.credentialRef` (`packages/core/src/db/schema.ts:174-184`, plan 52 §4.2, §5.1). Supersedes an earlier plaintext design (plan 44) spec never described either. | medium | code-wins | **Accepted, 2026-08-09.** §7.9 rule 4 now names the `network_credentials` table inline. |
| DIV-007 | §14 | `sessions` | "Server/cloud mode: login is mandatory (argon2 hashes), with session tokens." (`spec.md:711`) — mechanism unnamed. | Login sessions keyed by id; only the sha256 of the raw token is ever stored, plus `userId`, `expiresAt`, `lastUsedAt`, `userAgent`, `ip` (`packages/core/src/db/schema.ts:451-462`, plan 09 §M7). Security-relevant and entirely unspecified: no revocation story, no session-list-per-user story, no mention that the raw token is never persisted. | medium | code-wins | **Accepted, 2026-08-09.** §14 now names the `sessions` table and states that only the sha256 of the raw token is ever persisted. |
| DIV-008 | §7.9, §14 (tangential) | `device_events` | "every change is recorded to the device event log (rule 5) with an actor" (`spec.md:368`) — log referenced repeatedly, never named as a table. | One table, two streams (`main` lifecycle, `input` every injected action) sharing a shape but different retention budgets (`packages/core/src/db/schema.ts:485-507`, plan 18). The `input` half — a full audit trail of every tap/swipe/key injected — has zero mention anywhere in spec.md. | medium | code-wins | **Accepted, 2026-08-09.** §7.9 rule 5 and §14's Audit bullet now name the `device_events` table and its two streams (`main`, `input`). |
| DIV-010 | §7.5 (one incidental word) | `clusters` | "...the scheduler, lease manager, wall, clusters and topology need no filter of their own..." (`spec.md:316`) — the only appearance of the word, and not about the table. | Container, not a selector (plan 22.0 §3.1-3.3): a device belongs to at most one cluster via `devices.clusterId`; this table carries only the cluster's own identity (`packages/core/src/db/schema.ts:321-332`). Zero description of what a cluster IS, how membership works, or that `/clusters` and `/topology` exist because of it. | medium | code-wins | **Owner decision, 2026-08-09 (Cluster B).** Named explicitly by the owner ("clusters, batches, schedules... get real spec description"). Described in spec.md §12.3. |
| DIV-011 | none | `batches` | nothing | One script run across a resolved device set; `status` is a cached projection recomputed from member jobs, never incremented (`packages/core/src/db/schema.ts:339-358`, plan 20 §3.2, §3.5). Referenced by `jobs.batchId`/`batchSeq` (see DIV-029). | medium | code-wins | **Owner decision, 2026-08-09 (Cluster B).** Described in spec.md §12.3. |
| DIV-012 | §10 (title only, different meaning) | `schedules` | §10's title is "Session, lease, queue, **scheduler**" but its content (§10.1-10.4) is entirely job-queue claiming, not cron triggers. | Cron-triggered dispatch of a batch or an agent thread, with overlap policy, queue timeout, catch-up, jitter, priority (`packages/core/src/db/schema.ts:538-590`, plan 21 §1, §4.1). Adding cron scheduling under §10's header without disambiguating would recreate the same name collision `nodes`/`ai_agents` already had. | medium | code-wins | **Owner decision, 2026-08-09 (Cluster B).** Described in spec.md §12.3. §10 gains the explicit disambiguating note this row called for, so a future reader does not wrongly conclude §10 already covers cron scheduling. |
| DIV-013 | none | `schedule_runs` | nothing | One row per fire decision, including "ran nothing" outcomes (`'dispatched'\|'skipped-overlap'\|'skipped-missed'\|'no-targets'\|'error'`) — history even when nothing happened (`packages/core/src/db/schema.ts:599-613`, plan 21 §4.1). | medium | code-wins | **Owner decision, 2026-08-09 (Cluster B, companion of `schedules`/DIV-012).** Described in spec.md §12.3. |
| DIV-014 | none | `schedule_agent_targets` | nothing | A schedule's AI-agent target as a companion row, not columns on `schedules` (TypeScript-literal-compatibility reason, per the table's own comment); presence of a row is the discriminator the dispatcher checks before reading `schedules.scriptRef` (`packages/core/src/db/schema.ts:637-656`, plan 68 §3.1, §4.1). Sits at the intersection of `schedules` and `ai_agents` — once either gets a spec section this one needs a cross-reference from both. | medium | code-wins | **Owner decision, 2026-08-09 (Cluster B, companion of `schedules`/DIV-012).** Described in spec.md §12.3, cross-referenced from §12.1 (AI agents) as this row asked for. |
| DIV-016 | none | `agent_blobs` | nothing | Content-addressed image blob store (id = `sha256:<hex>` of the content itself), referenced from `agent_messages.content` rather than inlined as base64 (`packages/core/src/db/schema.ts:698-710`, plan 70 §3.4, §4.1). One of the `ai_agents` companions confirmed in scope by Plan 84 §9 Q1. | medium | code-wins | **Owner decision, 2026-08-03 (Plan 84 §9 Q1).** Applied to spec.md §12.1 in this pass (2026-08-09). |
| DIV-017 | none | `kv_entries` | nothing | Durable key/value store scripts and plugins use across job runs; identity is `(scope, scopeId, namespace, key)`, with `namespace` runtime-injected so two plugins can't collide (`packages/core/src/db/schema.ts:735-768`, plan 79 §3.2, §3.3, §4.2). A natural, low-controversy extension of the already-spec'd script framework (§11). | medium | code-wins | **Accepted, 2026-08-09.** Described briefly in spec.md §12.4, alongside its REST API (DIV-036). |
| DIV-019 | none (one incidental phrase, §11.6) | `ai_agents` | §11.6, in passing: "...`defineAgentPlugin` ... groups the AI agent's own built-in capabilities (device control, workspace, skills, and so on)..." — the only acknowledgment that an "AI agent" feature exists at all. | A stored, editable AI agent: model, provider connector, system prompt, context budgets, tool allowlist, device grants (empty/null = ALL devices), workspace scope, permissions (`packages/core/src/db/schema.ts:817-863`, plan 65 §3, §4.1). **Confirmed intended scope — Plan 84 §9 Q1, owner decision 2026-08-03.** `ai_agents`, not `agents`, is deliberate: `agents` meant the cloud-tunnel process (now `nodes`, DIV-009) for this project's entire life until plan 61 renamed it — reusing the name here would recreate that exact ambiguity. When spec gains a section for this, `ai_agents` and `nodes` must stay explicitly distinct, or spec.md's own still-stale §4/§5/§7 "agent" usage (DIV-009) will make the confusion Plan 61 fixed in code reappear in prose. | medium | code-wins | **Owner decision, 2026-08-03 (Plan 84 §9 Q1), reaffirmed 2026-08-09.** Applied to spec.md §12.1 in this pass — the new section carries exactly the naming distinction this row calls for (`ai_agents` vs. the now-consistently-named `nodes`, DIV-009). |
| DIV-020 | none | `agent_threads` | nothing | A conversation with one agent; `origin` records whether it began from Studio chat, a firing schedule, or a parent agent spawning a child (`packages/core/src/db/schema.ts:871-897`, plan 66 §3.1, §4.1). `ai_agents` companion — see DIV-019. | medium | code-wins | **Owner decision, 2026-08-03 (Plan 84 §9 Q1).** Applied to spec.md §12.1. |
| DIV-021 | none | `agent_runs` | nothing | One execution within a thread; carries `stopReason`/`errorClass` plus the parent/root/depth spawn-tree columns (`packages/core/src/db/schema.ts:904-935`, plan 66, plan 67). `ai_agents` companion — see DIV-019. | medium | code-wins | **Owner decision, 2026-08-03 (Plan 84 §9 Q1).** Applied to spec.md §12.1. |
| DIV-022 | none | `agent_messages` | nothing | One turn (user/assistant/tool/system), append-only including through compaction; unique `(threadId, seq)` makes a double-submit an error, not a duplicate (`packages/core/src/db/schema.ts:946-965`, plan 66 §3.1, §4.1). `ai_agents` companion — see DIV-019. | medium | code-wins | **Owner decision, 2026-08-03 (Plan 84 §9 Q1).** Applied to spec.md §12.1. |
| DIV-023 | none | `agent_approvals` | nothing | A paused destructive-capability call awaiting a human decision, persisted so it survives a core restart and the run resumes exactly where it paused (`packages/core/src/db/schema.ts:975-1001`, plan 66 §3.6, §4.1). `ai_agents` companion — see DIV-019. | medium | code-wins | **Owner decision, 2026-08-03 (Plan 84 §9 Q1).** Applied to spec.md §12.1. |
| DIV-024 | none | `agent_inbox` | nothing | The agent run tree's message channel, a table rather than an in-memory queue so an undelivered message survives a restart and is inspectable; drained only at a turn boundary (`packages/core/src/db/schema.ts:1012-1028`, plan 67 §3.3, §4.1). `ai_agents` companion — see DIV-019. | medium | code-wins | **Owner decision, 2026-08-03 (Plan 84 §9 Q1).** Applied to spec.md §12.1. |
| DIV-025 | none | `agent_spawn_grants` | nothing | Opt-in per-pair "which agents may spawn which" table, defaulting to none for a newly created agent (`packages/core/src/db/schema.ts:1036-1045`, plan 67 §3.4, §4.1). `ai_agents` companion — see DIV-019. | medium | code-wins | **Owner decision, 2026-08-03 (Plan 84 §9 Q1).** Applied to spec.md §12.1, including the `spawn-grants` REST endpoints (closing part of the spec:check route gap). |
| DIV-028 | §10.4 (one setting, not the table) | `farm_settings` | "The farm setting `adb.maxConcurrent` (default `0` = auto)..." (`spec.md:497`) — acknowledges *a* farm setting exists, not the singleton table holding all of them. | Single-row (`id = 1`) JSON blob holding every farm-wide setting, including `agentDefaults` for the entire `ai_agents` subsystem (`packages/core/src/db/schema.ts:430-436`, plan 07 §M5). Spec name-drops one field of this table's JSON payload without ever saying the table (or the "always exactly one row" pattern) exists. | medium | code-wins | **Accepted, 2026-08-09.** §10.4 now names the `farm_settings` table and the "always exactly one row" pattern inline. |
| DIV-029 | §12 | Column-level staleness on the two most central "documented" tables | `devices` block (`spec.md:580-598`, 18 columns); `jobs` block (`spec.md:615-627`, 12 columns). Being counted as "documented" table-purpose-wise hides how far the column lists have drifted. | `devices` (`packages/core/src/db/schema.ts:9-70`): **24 columns**, +6 beyond spec — `quarantineReason`, `nodeId`, `tenantId`, `clusterId`, `desiredReadiness`, `networkRoute` — each one the anchor of a different divergence row in this register (clusters, nodes, multi-tenancy, readiness, network routing). `jobs` (`schema.ts:212-274`): **24 columns**, +12 beyond spec — batch membership (`batchId`/`batchSeq`), expiry, failure classification, error phase, infra-retry count, denormalised script name/version, and the full trigger/lineage chain (plan 81: `triggeredByJobId`/`rootJobId`/`depth`/`triggerKey`). Column counts re-verified directly against `schema.ts` at merge time (see "Merge-time corrections" above). | medium | code-wins | **Accepted, 2026-08-09.** A note is added after §12's code block stating the column lists are illustrative, not a full schema dump, and pointing at this row for the complete current column set — rewriting the code block itself was judged out of proportion for this pass. |

**Endpoints (1)**

| id | area | subject | spec says | code does | severity | recommendation | decision |
|---|---|---|---|---|---|---|---|
| DIV-030 | none | AI agent platform REST API (chat, runs, approvals, blobs, capability registry, MCP, OpenAPI doc) | nothing — `ai_agents` and its companion tables are named 0 times in spec.md. | `GET/GET:id/POST/PATCH/DELETE /api/agents*` (`packages/core/src/api/agents.ts:33-87`, 8 routes); `/api/v1/threads`, `/api/v1/runs`, `/api/v1/approvals`, `/api/v1/agent-commands` (`api/threads.ts:45-171`, 14 routes); `POST/GET /api/v1/blobs` (`api/blobs.ts:27-73`, 2 routes); `GET/POST /api/v1/cap` (`api/cap.ts:84-100`, 2 routes); `POST /mcp` (`mcp/server.ts:60`); `GET /api/openapi.json` (`server/http.ts:197`) — 28 routes total. Already decided (Plan 84 §9 Q1) — this is that decision's endpoint-layer footprint. Whoever writes the spec section must keep "agents" (this feature) distinct from "nodes" (DIV-009). | medium | code-wins | **Owner decision, 2026-08-03 (Plan 84 §9 Q1).** Applied to spec.md §12.1, kept explicitly distinct from `nodes` (DIV-009) as required. |

**Protocol (1)**

| id | area | subject | spec says | code does | severity | recommendation | decision |
|---|---|---|---|---|---|---|---|
| DIV-051 | none | AI agent chat protocol (runs, deltas, tool calls, approvals, child agents) | nothing | server (12): `agent.run.started`, `agent.run.finished`, `agent.delta`, `agent.message`, `agent.tool.started`, `agent.tool.finished`, `agent.approval.requested`, `agent.approval.resolved`, `agent.child.started`, `agent.child.finished`, `agent.message.queued`, `agent.message.delivered` (`packages/protocol/src/messages/agent.ts:288-399`); client (3): `agent.subscribe`, `agent.unsubscribe`, `agent.run.cancel` (`:265-278`). Same decided subsystem as DIV-030 and DIV-019; 15 of the 97 protocol members belong to it, the largest single accounted-for-by-decision group. | medium | code-wins | **Owner decision, 2026-08-03 (Plan 84 §9 Q1).** Mentioned in spec.md §13's new protocol-category bullets, alongside §12.1. |

**Screens (1)**

| id | area | subject | spec says | code does | severity | recommendation | decision |
|---|---|---|---|---|---|---|---|
| DIV-053 | §19 | AI agent subsystem screens (`/agents`, `/agents/approvals`, `/agents/detail`, `/agents/runs`, `/agents/thread`) | nothing — no AI-agent row in the §19 table. | 5 routes under `packages/studio/src/app/agents/**/page.tsx` (roster, approvals inbox, per-agent workbench, run history; `/agents/thread` is a compat redirect). Owner-confirmed intended scope (Plan 84 §9 Q1, 2026-08-03). This is 5 routes, not the 6 an earlier count assumed — corrected here (see "Corrections to Plan 84's own counts" above). | medium | code-wins | **Owner decision, 2026-08-03 (Plan 84 §9 Q1).** New §19 row "AI agents" added. |

Engines and enumerations contributed no `medium`, `code-wins`/`spec-wins` rows — every medium-severity engine and enum finding above needed the owner (see the needs-owner section).

### Low (10), grouped by pass

**Tables (3)**

| id | area | subject | spec says | code does | severity | recommendation | decision |
|---|---|---|---|---|---|---|---|
| DIV-002 | §7.5 | `blocked_devices` | "Blocking... remains the outer layer and still wins over everything: a blocked `stableId` never reaches the tray." (`spec.md:311`) | Keyed on `stableId` (not the adb serial or `devices.id`), so a block survives a port change or forget/re-enroll (`packages/core/src/db/schema.ts:112-118`, plan 47 §3.2, §3.3). The *behavior* is documented; the *table* and its identity-key rationale are not — cheap to close: attach the table name to the existing paragraph. | low | code-wins | **Accepted, 2026-08-09.** Done exactly as suggested: the table name is attached to the existing §7.5 paragraph. |
| DIV-003 | §7.5 | `discovered_devices` | "Discovered devices live in their own table rather than as a sixth `DeviceStatus`... they query `devices`, which only ever holds members." (`spec.md:316`) | `stableId`-keyed tray of adb-seen, not-yet-admitted phones; probed for model/version but nothing else runs against it (`packages/core/src/db/schema.ts:133-142`, plan 56 §3.3). Same situation as `blocked_devices` — spec already explains *why* a separate table exists, just never names it. | low | code-wins | **Accepted, 2026-08-09.** Table name attached to the existing §7.5 paragraph, same as DIV-002. |
| DIV-006 | none | `migration_markers` | nothing | Guards a one-shot data migration (currently only the cluster materialisation) so it runs exactly once across restarts (`packages/core/src/db/schema.ts:192-197`, plan 22.0 §3.4, §4.1). Pure internal bookkeeping, not a product-facing feature — closer to a schema-migrations table than a data-model entity. | low | code-wins | **Accepted, 2026-08-09 — no spec text added.** As this row's own recommendation says, it is internal bookkeeping, not a product-facing concept; recorded here in the register rather than given spec prose, which this pass judges sufficient for a table nobody using the product would ever need to know exists. |

**Endpoints (2)**

| id | area | subject | spec says | code does | severity | recommendation | decision |
|---|---|---|---|---|---|---|---|
| DIV-041 | §8 | `GET /api/registry` response includes a `networks` array not in spec's example | §8's example JSON lists exactly `transports, displays, inputs, inspectors, tools`. | `packages/core/src/registry/engines.ts:56` — `RegistryResponseSchema.parse({ transports, displays, inputs, inspectors, networks, tools })`. Purely additive (§7.9's network layer, v0.4) — nothing in §8's example is wrong, it just predates the fifth driver layer. | low | code-wins | **Accepted, 2026-08-09.** §8's example JSON now includes `networks`. |
| DIV-043 | none, except §10.4 (adb concurrency) in prose | Operational/diagnostic endpoints | Nothing names these three surfaces specifically. | `GET /api/health` (`server/http.ts:128`); `GET /api/doctor` (`api/doctor.ts:23`); `GET /api/adb/stats` (`api/adb-stats.ts:34`). Boilerplate ops surfaces — worth a one-line spec mention each, not a design question. | low | code-wins | **Accepted, 2026-08-09.** §7.7 now names all three inline. |

**Screens (2)**

| id | area | subject | spec says | code does | severity | recommendation | decision |
|---|---|---|---|---|---|---|---|
| DIV-061 | §19 | `/dev/tools` — internal debug-only job submission form | nothing | `packages/studio/src/app/dev/tools/page.tsx:13-20` — own doc comment: "Development aid — deliberately absent from the menu." Self-declared as intentionally outside the product surface; carried here so `spec:check` doesn't flag it as a silent gap, but no spec section should be written for it. | low | code-wins | **Accepted, 2026-08-09 — no spec text added, on purpose.** Matches this row's own recommendation: it is a self-declared dev aid, deliberately outside the product surface. This register row is its documentation. |
| DIV-062 | §19 | `/topology` — dead route kept only as a redirect | Spec never had a Topology screen either. | `packages/studio/src/app/topology/page.tsx` — `router.replace('/?view=wall&group=cluster')`; own comment explains the redirect exists only so an old bookmark still lands somewhere useful (plan 47). No screen left to document — its content now lives inside the already-documented Dashboard row. | low | code-wins | **Accepted, 2026-08-09.** §19's Dashboard row gains a one-line footnote about the `/topology` redirect, per this row's own conclusion that there is no separate screen left to document. |

**Engines (2)**

| id | area | subject | spec says | code does | severity | recommendation | decision |
|---|---|---|---|---|---|---|---|
| DIV-067 | §7.1 | scrcpy display codec — spec claims H.264/H.265, code ships H.264 only | §7.1: "`scrcpy` (H.264/H.265, default)." | `packages/drivers/src/display/scrcpy.ts:71` hardcodes `codec: 'h264'`; `packages/scrcpy/src/session.ts:105` hardcodes `'video_codec=h264'`. The `scrcpy` display descriptor advertises `capabilities: ['video-h264']` only (`descriptors.ts:53`). H.265 exists only as a parser-level constant in the demuxer, never requested from the device. | low | spec-wins | **Spec corrected, not pursued as a defect — owner direction, 2026-08-09.** It is low severity and the spec simply overclaims a codec that was never wired up. §7.1's Display row is corrected to "H.264" only. No defect plan filed — plan 84 §6 criterion 6 requires one only for a `spec-wins` *decision*, and the actual decision here is to fix the wording, not to build H.265 support. |
| DIV-069 | none (CLAUDE.md, not spec.md) | `CLAUDE.md` still repeats the stale "vpn-helper never advertises probe" claim | CLAUDE.md's "Rules that get broken" section: "It deliberately does not advertise a `probe` capability, so its status is reported `unverified`, never `ok`." spec.md itself never made this permanent claim — only `descriptors.ts`'s stale comment and CLAUDE.md do. | `packages/drivers/src/network/guest-agent/vpn-helper.ts:132` sets `capabilities: { ..., probe: true }` and `deriveHealth()` (`packages/protocol/src/network.ts:304-310`) does return `'ok'` once the egress check passes — the capability exists and is exercised. This row does not touch CLAUDE.md; it only records that CLAUDE.md needs a correction someone should make deliberately, matching the code-internal question in DIV-068. | low | code-wins | **Manager decision (not owner-adjudicated), 2026-08-09. CLOSED the same day, at the owner's request.** Confirms DIV-068's ruling (the runtime engine is authoritative). `CLAUDE.md`'s rule now reads that `vpn-helper` *does* advertise `probe` (a real egress probe through the tunnel, plan 51), while keeping the half of the old rule that was always true and is the one that matters operationally: `unverified` is not success and must never be worded as though it were. |

**Enumerations (1)**

| id | area | subject | spec says | code does | severity | recommendation | decision |
|---|---|---|---|---|---|---|---|
| DIV-072 | none | Session progress phase enum undocumented | Spec §13 (protocol) and §10 (session/lease/queue) never enumerate a session-startup phase machine; no hits for "connecting"/"waking"/"starting-video"/"waiting-frame". | `packages/protocol/src/messages/stream.ts:77-83`: `SessionPhaseSchema = z.enum(['connecting', 'waking', 'starting-video', 'waiting-frame', 'ready'])`, carried on `session.progress`. Doc comment: "Phases a session goes through before the first frame (Plan 17 §3.3)." Unlike readiness (DIV-071), this doesn't change scheduling or job semantics — a client without it just misses incremental progress text, not functionally broken code. | low | code-wins | **Accepted, 2026-08-09.** Mentioned briefly in spec.md §13's new protocol-category bullets. |

---

## What is NOT diverging

Worth stating plainly, because a register that only lists faults earns no trust (Plan §3.5):

- **`adb kill-server` has exactly one call site**, re-verified independently by two passes:
  `packages/core/src/tools/adb-swap.ts:48`, inside the Toolchain Manager's version-swap flow,
  after draining every session — the single use §10.4 permits. A doctor-package test
  (`packages/core/src/doctor/render.test.ts:141`) asserts the string appears nowhere else in
  that package. Every other hit in `packages/` is a comment referencing the rule, not a call.
- **scrcpy is still pinned to `3.3.1`**, vanilla, never forked (`packages/scrcpy/src/version.ts:24`,
  §7.6) — no `scrcpy-server` jar or Java source is vendored anywhere in the repo; it is
  downloaded at runtime from the official GitHub release and checksum-verified
  (`LICENSES.md:12`).
- **All five driver layers are intact**, and there is no sixth. `packages/drivers/src/identity/`
  (`mock-location.ts`) looks like a candidate at a glance, but it has no registry `id`, never
  appears in `engineDescriptors` or `PLANNED`, and is gated by the guest agent's own
  `mock-location` capability rather than a driver-registry `kind` — a thin helper riding on the
  `network` layer, not a sixth layer. `EngineDescriptorSchema.kind` still enumerates exactly
  `transport | display | input | inspector | network`.
- **Device status matches exactly.** Spec §10.1 and spec's own schema comment both give
  `offline|idle|manual|busy|quarantined` (5 values, same order) — `DeviceStatusSchema`
  (`packages/protocol/src/device.ts:9`) matches verbatim. Job status's five original members
  (`queued`, `running`, `success`, `failed`, `cancelled`) also match exactly; `expired` (DIV-070)
  is a clean addition, not a rewrite.
- **Capability locks match spec §9.5 exactly** across every engine: `appium`'s
  `locks: ['instrumentation', 'input-injection']`, `ui-server`/`uiautomator-dump`'s
  `['instrumentation']`, `scrcpy-uhid`/`scrcpy-sdk`/`adb-input`/`scrcpy-aoa`'s
  `['input-injection']`, `scrcpy`'s `['video-encoder']` — all identical to spec's table.
- **`scrcpy-aoa` is honestly disabled**, not silently missing: registered `available: false`
  with a real `unavailableReason` (`packages/core/src/registry/engines.ts:39-40`), matching
  spec's own "opt-in / not-yet-wired" framing (§9.1) — the "future-proof, disabled with a
  reason" pattern the code's own comment describes.
- **The Toolchain Manager API matches §7.7 verbatim** — all 7 routes
  (`packages/core/src/tools/routes.ts`): `GET /api/tools`, `POST /api/tools/:id/install`,
  `POST /api/tools/:id/activate`, `DELETE /api/tools/:id/:version`, `POST /api/tools/:id/check`,
  `POST /api/tools/manifest/refresh`, `POST /api/tools/repair`.
- **The device admission/discovery/block/forget REST surface, the guest-agent and network-route
  endpoints, device-identity, scripts, jobs, artifacts, and the plugins API** all match their
  respective spec sections closely at the concept level — §7.5, §7.9, §7.10, §3, §11, §11.5,
  §11.6, §12, §18. Only the literal endpoint lists (not required by spec, which enumerates
  routes explicitly only in §7.7 and §8) go beyond what's written, and none of the mismatches
  found here are contradictions.
- **56 of the 97 protocol messages are already accounted for** in spec.md — 14 by literal
  `type` string in §13's prose, 42 more by category description or another section's prose
  (video/WebRTC, registry/tools, session/lease, enrollment, discovered-device tray, inspector
  live view, device event log, manual-control gestures), plus the generic `error` envelope every
  WS protocol needs.
- **The `/device` query-param URL design (`?id=`, not a dynamic route) is a deliberate choice
  spec is simply silent on, not a contradiction** — a static export cannot pre-render dynamic
  ids, and §19's Device-detail row never specifies a URL shape either way.
- **The 23 Studio routes and 36 tables were re-counted directly** (`find ... -name page.tsx`,
  matching the first argument of every `sqliteTable(` call) rather than trusted from Plan 84's
  own text, per the plan's own warning about the `grep -A1` phantom-table trap — both figures
  held exactly.

The immutable decisions survived intact. What drifted is description, not architecture — the
same conclusion Plan 84 §3.5 reached, now independently re-verified by every pass that touched
these claims.

## New surface added since the audit (post-2026-08-09)

Per this file's own rule ("When later work adds a table, endpoint, protocol message, screen, or
engine without updating `spec.md` in the same commit... requires a new row here instead —
appended with the next unused `DIV-` id"). `docs/spec.md` was held by a concurrent worker at the
time this route landed, so the row below is the interim record; `spec.md` §11.3/§18 (or wherever
the batches REST surface is enumerated) still needs the same text this row carries.

| id | area | subject | spec says | code does | severity | recommendation | decision |
|---|---|---|---|---|---|---|---|
| DIV-073 | §11 (batches) | `GET /api/batches/:id/artifacts` and `GET /api/batches/:id/artifacts.zip` undocumented | spec.md's batches/jobs sections (§11) never mention a collected-files listing or a one-download archive for a bulk pull. | Plan 93 §3.13, §4.4, §4.7, step 93.10 (`packages/core/src/api/batches.ts`): `GET /:id/artifacts` (`job.view`) returns one row per device-scoped pull artifact the batch's member jobs produced — `deviceLabel`, `stableId`, `filename`, `sizeBytes`, and a `contentUrl` reusing the existing single-artifact download. `GET /:id/artifacts.zip` (`job.view`) streams a stored (uncompressed) zip of all of them at once, built by the new `packages/core/src/api/zip-stream.ts` (no dependency), entries named `<device-label-slug>-<stableId>/<original-filename>` (the full `stableId`, never shortened, so two same-labelled devices with the same filename land in different directories). Bounded by `transfer.maxArchiveBytes` (already documented in DIV-072's sibling settings work, plan 93 §4.1) — refused with 413 before any byte is written, never a truncated download. `GET /api/artifacts` also gained `?kind=upload` (closing F14: an uploaded artifact has both `jobId` and `deviceId` null, so it was unreachable through the existing `?jobId=`/`?deviceId=` query modes) — same endpoint, no new route line, so it is not a separate row here. | low | code-wins | **Superseded by spec, 2026-08-14 (plan 94 §5, step 94.11).** `docs/spec.md` §12.3's `batches` bullet now names both `GET /:id/artifacts` and `GET /:id/artifacts.zip` directly, alongside the rest of the batches REST surface — `docs/spec.md` was no longer held by a concurrent worker by the time step 94.11 closed out this plan series, so the "Pending" note above no longer applies. Left in place rather than deleted (this register is append-only); this row is now historical record of the interim gap, not an open item.** |
