# Plan 207 — MVP wave 1 : Actions API with targets; groups rename; console removed

> Status: draft — not started; written 2026-09-03 by the plan author for the MVP series
> Depends on: plan 205 (device activities: this plan evaluates `policy.evaluate` per device, starts `command`, `network-apply`, `install` and `transfer` activities through the registry, and maps `E_DEVICE_CONFLICT` to a per-device `forbidden` result; the `ActivityPort` shape of plan 206 §4.2 is the same registry seen through a narrower interface), plan 201 (housekeeping: `components/topology/`, `lib/api.ts`'s `fetchTopology` and the redirect stub reasoning are already handled there), plan 200 (rules and format).
> Spec references: `docs/mvp/07-actions-api.md` (entire: §1.1 verbs and the MVP 15 amendment adding `screenshot`, `clear-cache` and bulk `settings`; §1.2 per-device responses; §1.3 reads stay per device; §1.4 the WS input exception), `docs/mvp/15-ui-migration.md` §0.1 items 3 and 4 (Groups rename everywhere including the table and the routes; Console removed entirely, the Adb command action stays), `docs/mvp/13-removal-register.md` A.5 and A.6a (every row copied into §10), `docs/mvp/04-device-activity.md` §1.3 (warn and forbid, `force: true`), `docs/mvp/05-jobs-model.md` and `docs/mvp/14-jobs-and-runs.md` (`run-script` always creates a batch; plan 211 owns runs), `docs/mvp/16-consolidated-plan.md` §1 to §3 and §5 item 5 (the post-wave-2 alpha runs the old Studio against the new core). `docs/spec.md` §10 and §19 are superseded by `docs/mvp/16` for this series (plan 200 header); this plan records a `DIV-` row until plan 202 rewrites them.
> Ships: packages/core/src/api/actions.ts
> **Testing override, read before §5 and §7:** §12 supersedes every Studio and `@enkaku/ui` test named anywhere below. Create no test and run no test under `packages/studio` or `packages/ui`; delete a surviving one that breaks and list it in §11. Verification for UI is `bun run typecheck`, the design-token and route scripts, and the owner smoke.

---

## 0. Goal checklist

Every command runs from the repo root. `GREP_207_CLUSTER` and `GREP_207_CONSOLE` are the two gate greps, defined once in §10 and copied verbatim wherever they are cited.

| # | Goal | Parameter | Verified by | Done |
|---|---|---|---|---|
| G1 | `@enkaku/protocol` exports `TargetSchema`, `ActionVerbSchema` (26 verbs), `ActionRequestSchema` (a discriminated union on `verb`), `ActionResultSchema`, `ActionResponseSchema`, `OperationSchema`, `ACTION_ERROR_CODES` | the schemas in §4.1, byte for byte | `bun test packages/protocol/src/actions.test.ts` passes (every verb parses its params; an unknown verb fails; `status` accepts exactly the six values) | [ ] |
| G2 | `POST /api/actions/<verb>` accepts a target and answers per device with `202` | body `{ target, ...params, force? }`; response `{ operationId, results[] }`, `results.length` = resolved devices | `bun test packages/core/src/api/actions.test.ts` → tests `wake: answers 202 with one result per targeted device`, `unknown verb answers 404 E_UNKNOWN_VERB` pass | [ ] |
| G3 | Every verb dispatches to the existing per-device implementation, never to an HTTP route | 26 verbs, each with a test that asserts the injected implementation was called with the device id | `bun test packages/core/src/api/actions.test.ts` → the `describe('verbs')` block has 26 passing tests | [ ] |
| G4 | The policy table decides `warned`/`forbidden` per device and `force: true` acknowledges a warning | a device with a live `job` activity answers `warned` for `adb`, then `accepted` with `force: true`; answers `forbidden` for `install` with or without `force` | `bun test packages/core/src/api/actions.test.ts` → tests `policy: warn then force`, `policy: forbid ignores force` pass | [ ] |
| G5 | The target resolver answers `deviceIds`, `groupId` and `tags` and reports unknown or unavailable devices as `skipped` | `resolveActionTarget` in `packages/core/src/groups/resolve.ts` | `bun test packages/core/src/groups/resolve.test.ts` passes (the three shapes, dedupe, unknown id, offline, quarantined, unknown group throws `group_not_found`) | [ ] |
| G6 | `GET /api/operations/:id` returns the same array with final statuses and forgets it after one hour | `OPERATION_TTL_MS = 3_600_000`; `accepted` becomes `done` or `failed` when the dispatched promise settles | `bun test packages/core/src/actions/operations.test.ts` passes (fake clock) | [ ] |
| G7 | No per-device action route survives in the device routers | the only `/:id/` write left in `packages/core/src/api/devices.ts` is `POST /:id/monitor/save` | `rg -n "app\.(post|put|delete)\('/:id/" packages/core/src/api/devices.ts` prints exactly one line, containing `'/:id/monitor/save'`; `rg -n "app\.(post|put|delete)\('/" packages/core/src/api/transfer.ts packages/core/src/api/device-preparation.ts packages/core/src/api/topology.ts packages/core/src/api/command-runs.ts packages/core/src/api/saved-commands.ts` → `No such file` for all five | [ ] |
| G8 | The bulk twins and the public enqueue routes are gone | 0 matches | `rg -n "'/labels/apply'\|'/prep/apply'\|'/network/apply'" packages/core/src` → empty; `rg -n "app\.post\('/', " packages/core/src/api/jobs.ts packages/core/src/api/batches.ts` → empty | [ ] |
| G9 | The word cluster is gone from live code, with the one exception §10 names | 0 matches | `GREP_207_CLUSTER` (§10) prints nothing | [ ] |
| G10 | The console is gone: routers, runner, store, tables, messages, settings, page, components | 0 matches; three tables absent | `GREP_207_CONSOLE` (§10) prints nothing; `bun test packages/core/src/db/groups-migration.test.ts` → test `command_runs, command_run_members and saved_commands no longer exist` passes | [ ] |
| G11 | `clusters` is `groups`, `devices.cluster_id` is `devices.group_id`, `batches.cluster_id` and `schedules.cluster_id` are `group_id`, and existing rows survive | one migration, generated by `db:generate` (rename answers) or hand-written per the `0023` precedent (§4.6) | `bun test packages/core/src/db/groups-migration.test.ts` passes (a pre-existing group, its member device, a batch and a schedule read back through the renamed Drizzle tables) | [ ] |
| G12 | `/api/groups` replaces `/api/clusters` with no alias, and its member writes are verbs | routes `GET /`, `POST /`, `PATCH /:id`, `DELETE /:id`, `GET /:id/devices` only | `rg -n "app\.(get|post|patch|delete)\('" packages/core/src/api/groups.ts` prints exactly five lines; `rg -n "/api/clusters" packages` → empty | [ ] |
| G13 | The old Studio compiles against the new routes through one client | `packages/studio/src/lib/actions.ts` exports `runAction`, `fetchOperation`, `awaitOperation`, `runOnDevice`, `ActionRefusedError` | `bun run typecheck` exits 0; `bun test packages/studio/src/lib/actions.test.ts` passes; `rg -n "/api/devices/\\$\{[^}]*\}/(install|push|pull|label/|preparation|connection/|network|block|unquarantine|cluster|tags|readiness)" packages/studio/src --glob '!*.test.*'` prints only the two reads (`/label` in `PhysicalLabellingPanel.tsx`, `SettingsPopup.tsx`, `DevicePopup.tsx`, `app/device/page.tsx`; `/network` in `lib/api.ts`'s `fetchNetworkStatus`; `/readiness` nowhere; `/preparation` in `lib/use-preparation.ts`'s GET only) | [ ] |
| G14 | The capability broker exposes `actions.run` | capability id `actions.run`, input `ActionCapabilityInputSchema`, output `ActionResponseSchema` | `bun test packages/core/src/capability/actions.test.ts` passes; `rg -n "id: 'actions.run'" packages/core/src/capability/actions.ts` prints one line | [ ] |
| G15 | The two bundled plugins whose sources this plan edits are renumbered and rebuilt | `plugins/mikrotik-routing` and `plugins/tiktok-automation-pack` patch-bumped at their three sites; `bun run build:packs` exits 0 | `bun test plugins/tiktok-automation-pack/src/index.test.ts` passes; `git diff --stat main -- plugins/*/package.json` shows both files | [ ] |
| G16 | The workspace typechecks | 0 errors | `bun run typecheck` exits 0 | [ ] |
| G17 | On a real device, `POST /api/actions/adb` with `{ target: { deviceIds: [id] }, cmd: 'echo hi' }` answers `accepted`, and `GET /api/operations/:id` shows `done` with `detail.stdout` `hi` | 1 device, 1 result | §7.3 manual smoke with the lab device | owner |

## 1. Goals

1. One action model: `POST /api/actions/<verb>` takes a target (`deviceIds`, `groupId` or `tags`), evaluates ownership, availability and the policy table per device, dispatches to the per-device implementation that already exists, and answers `202` with one result per device (MVP 07 §1.1, §1.2). A single device is a target of one.
2. `warn` becomes a per-device `warned` result that is not started; the caller repeats with `force: true` (MVP 04 §1.3, MVP 07 §1.2). `forbid` becomes `forbidden` and ignores `force`.
3. Long-running verbs answer `accepted` and settle to `done` or `failed` on an operation record readable at `GET /api/operations/:id` for one hour; the activity registry carries the live picture (`device.activity`, plan 205).
4. `run-script` always creates a batch, even for one device, through the existing `createBatch` path (MVP 07 §1.2; plan 211 owns runs and reshapes the batch, this plan does not).
5. Every per-device action route, every bulk twin, `POST /api/jobs`, `POST /api/batches`, `/api/topology`, the console (page, routers, runner, store, three tables, seven WS messages, the `shell.*` fleet-command settings, `retention.commandRunDays`, the adb-stats block) are deleted (MVP 13 A.5, A.6a).
6. Clusters are groups everywhere: the `groups` table, `devices.group_id`, `batches.group_id`, `schedules.group_id`, `/api/groups`, `target.groupId`, `DeviceInfo.group`, `GroupInfo`, the Studio `Group*` components, the `?group=group` wall query, every line of copy (MVP 15 §0.1 item 3).
7. The old Studio keeps working on the `mvp` branch through one thin client (`packages/studio/src/lib/actions.ts`) so the owner's farm can run the post-wave-2 alpha on it (MVP 16 §5 item 5); the dialogs plan 216 deletes are switched, not rebuilt.
8. Plugins and agents reach the same model through one capability, `actions.run`, with a target (MVP 07 §4).

## 2. Non-goals

| Not done here | Done by |
|---|---|
| The `DevicePicker`, `useTarget`, one `*Dialog` per verb, the per-device result list component in its final form, the picker container's tokens (MVP 07 §2, §2.1) | plan 216 (this plan ships a minimal `ActionResults` list so the old dialogs can show per-device outcomes) |
| Deleting `InstallBatchDialog`, `BulkTransferDialog`, `BulkPrepDialog`, `BulkForgetDialog`, `BulkCutoverDialog`, `BulkProxyDialog`, `AdbCommandDialog`, `components/target/`, the job-or-batch branch's dialog shell | plan 216 (this plan re-points their fetches and deletes only `components/command/`, `app/console/`, `app/topology/`) |
| `run-workflow` doing anything, jobs as intents with runs, `POST /api/batches/:id/rerun` and `/rerun-failed` as job-creating routes, `POST /api/jobs/:id/resume`, the batch shape | plans 210 and 211 (this plan stubs `run-workflow` with `E_NOT_SUPPORTED` naming plan 211) |
| The rest of the settings reduction (`shell.mode`, endpoint fields, `execTimeoutMs`, `maxOutputBytes` stay; only the fleet-command fields and `retention.commandRunDays` go here) | plan 212 |
| The Devices page with group tabs, the Devices strip CRUD, the discovery sheet, the bulk pill with the generic set | plan 214 (this plan renames the old Groups page and its dialogs so they keep working) |
| The new shell and status bar (no Console toggle) | plan 213 |
| `Cluster*` to `Group*` in `docs/archive/plans/01..129` and `docs/spec.md` | plan 202 (archive and rewrite; this plan adds one `DIV-` row) |
| Plugin-declared verbs `<plugin>/<verb>` through the broker | deferred, §9 Q1 |
| The guest agent's own `LabelRenderer.kt:44` comment ("Grapheme-cluster cap", a different word) | plan 221's tree; excluded from the gate like plan 205's four Kotlin lines |
| Cloud mode parity for the actions router in `packages/node` | post-MVP (MVP 16 §1); the node keeps compiling through the field rename only |

## 3. Context and design decisions

### 3.1 What the code does today (verified 2026-09-03)

Every action exists at least twice. The routes this plan deletes, with the line to match on:

| Verb | Single-device route | Bulk twin |
|---|---|---|
| run-script | `packages/core/src/api/jobs.ts:207` `app.post('/', async (c) => {` | `packages/core/src/api/batches.ts:766` `app.post('/', requirePermission('job.run'), async (c) => {` |
| install / push / pull | `packages/core/src/api/transfer.ts:91` `app.post('/:id/install', async (c) => {`, `:135` `'/:id/push'`, `:177` `'/:id/pull'` | `InstallBatchDialog` and `BulkTransferDialog` post `internal:install`/`internal:push` batches to `POST /api/batches` |
| set-network | `packages/core/src/network/route-service.ts:3264` `app.put('/:id/network', ...)`, `:3269` `'/:id/network/enable'`, `:3296` `'/:id/network/disable'`, `:3327` `'/:id/network/retry'`, `:3347` `app.delete('/:id/network', ...)` | `:3228` `app.post('/network/apply', requirePermission('device.network'), async (c) => {` |
| set-label / clear-label | `packages/core/src/api/devices.ts:1328` `app.post('/:id/label/apply', ...)`, `:1346` `'/:id/label/clear'` | `:624` `app.post('/labels/apply', requirePermission('device.settings'), async (c) => {` |
| prepare / retry-prepare | `packages/core/src/api/device-preparation.ts:93` `app.post('/:id/preparation', ...)`, `:112` `app.post('/:id/preparation/:componentId/retry', ...)` | `packages/core/src/api/devices.ts:690` `app.post('/prep/apply', requirePermission('device.settings'), async (c) => {` (a prep-settings write, folded into `settings`) |
| cutover | `devices.ts:1555` `app.post('/:id/connection/cutover', requirePermission('device.enroll'), ...)`, `:1606` `app.delete('/:id/connection/cutover', ...)` | `BulkCutoverDialog` loops the single route |
| disconnect / reconnect | `devices.ts:1407` `app.post('/:id/connection/disconnect', ...)`, `:1474` `app.post('/:id/connection/reconnect', ...)` | none |
| forget / block | `devices.ts:1716` `app.delete('/:id', requirePermission('device.settings'), async (c) => {`, `:1738` `app.post('/:id/block', ...)` | `BulkForgetDialog` loops the single route |
| unquarantine | `devices.ts:1626` `app.post('/:id/unquarantine', requirePermission('device.quarantine'), (c) => {` | none |
| set-group / set-tags | `devices.ts:1680` `app.put('/:id/cluster', ...)`, `:1660` `app.put('/:id/tags', ...)` | `packages/core/src/api/clusters.ts:175` `app.post('/:id/devices', ...)`, `:191` `app.delete('/:id/devices/:deviceId', ...)` |
| wake / sleep | `devices.ts:1117` `app.put('/:id/readiness', requirePermission('device.view'), async (c) => {` | none |
| adb | the device Terminal tab (`shell.exec` over WS, stays) | `packages/core/src/api/command-runs.ts:285` `app.post('/', async (c) => {` and the whole console |

Facts the design below rests on:

- The target shape already exists three times: `packages/protocol/src/command/target.ts:16-20` `CommandTargetSchema = z.union([{ deviceIds }, { clusterId }, { tags }])`; `packages/core/src/api/batches.ts:51` `target: z.union([z.object({ clusterId: ... }), z.object({ deviceIds: ... })])`; `packages/core/src/api/schedules.ts:49-53` `ScheduleTargetSchema`. The resolver is `packages/core/src/clusters/resolve.ts:34` `export function resolveTarget(db, target: { tags: string[]; deviceIds: string[] })` and `:82` `export function resolveCluster(db, cluster)`, both reporting `usable`/`skipped` with `offline`/`quarantined`/`no longer exists` reasons.
- `createBatch` (`packages/core/src/clusters/dispatch.ts:311`) takes `CreateBatchInput` (`:92-131`: `scriptId`, `params`, `target: { clusterId } | { deviceIds }`, `concurrency`, `order`, `priority?`, `createdBy?`, `runtimeOverride?`, `expiresAt?`, `pacing?`) and its deps come from the one factory `createBatchDispatchDeps(deps, actor)` (`packages/core/src/api/batches.ts:292`).
- `runTransfer` (`packages/core/src/device/transfer-dispatch.ts:26`) is the one door for install/push/pull; the transfer registry (`device/transfer-registry.ts:54-57`) gets `progress()`/`done()` from it, and plan 205 §4.10 makes that registry the producer of `install`/`transfer` activities. `TransferService` (`device/transfer.ts:87-90`): `push(deviceId, artifactId, remotePath, opts)`, `pull(deviceId, remotePath, opts)`, `install(deviceId, artifactId, opts)`.
- The per-device implementations behind the other routes are plain functions or services: `DeviceLifecycle.forget/block` (`device/lifecycle.ts:58-63`), `ReadinessManager.set(deviceId, desired, { userId, clientId })` (`device/readiness.ts:42`), `LabellingService.apply(deviceId, actor)` and `.clear(deviceId, { restoreOriginal, actor })` (`device/labelling.ts:73-79`), `PreparationRunner.ensure(deviceId, opts)`, `.ensureComponent(deviceId, componentId, opts)`, `.status(deviceId)` (`device/preparation/runner.ts:54-58`), `DeviceReconnector.reconnect(stableId, { allowSweep, force })` and `.disconnect(stableId)` (`registry/reconnect.ts:34-36`), `CutoverManager.start(device, opts)` and `.cancel(stableId)` (`registry/cutover.ts:48-53`), `BatteryMonitor.unquarantine(deviceId)` (`device/battery.ts:57`), `replaceDeviceTags(db, deviceId, tags)` (`registry/device-tags.ts:74`), `assignDevices(db, clusterId, deviceIds)` and `unassignDevices(db, deviceIds)` (`clusters/membership.ts:19`, `:44`), `setRouteFromRequest`/`clearRouteFromRequest` (`network/route-service.ts:2857`, `:2974`, functions inside `createRouteService`), `ShellPort.exec(cmd, opts)` (`device/shell-port.ts:37-45`; `createLocalShellPort` `:64`, `createRemoteShellPort` `:105`), `ctx.deviceCall(deviceId, { method: 'screenshot', args: {} }, 'wall')` (`capability/device-inspect.ts:128`), `registerDeviceArtifact(` (`runner/artifact-store.ts:265`), `SessionManager.restartAt`/`setRotation`/`get` (`api/devices.ts:320` Pick).
- The console is 6 602 lines across `packages/core/src/command-console/{runner,store,saved}.ts`, `api/command-runs.ts`, `api/saved-commands.ts`, `app/console/page.tsx`, `components/command/*`, `AdbCommandDialog.tsx` and `TerminalPane.tsx`'s history fetch. Its three tables are `commandRuns` (`db/schema.ts:766-797`), `commandRunMembers` (`:805-837`), `savedCommands` (`:846-864`). Its WS surface is `packages/protocol/src/messages/command.ts` (seven messages, `index.ts:133-147`, `:1082-1089`, `:1270-1274`, `:1422-1435`) and `ws-handlers.ts:1332-1339` (`case 'command.subscribe'`/`'command.unsubscribe'`), `:2651` `broadcastCommand(runId, msg)`. `shell.exec` also writes a one-member run: `ws-handlers.ts:1426` `const commandRun = deps.commandRunStore?.recordSingle({ cmd: redactShellCommand(cmd), deviceId, actor })`, `:1513-1528` and `:1580-1591`. Its settings are `shell.fanoutEnabled` to `shell.savedCommandLimit` (`packages/protocol/src/settings.ts:1758-1828`, defaults `:1838-1846`), `retention.commandRunDays` (`:1152`, default `:1183`), and the server-mode override `packages/core/src/settings/farm-settings.ts:40` `shell: { ...cached.shell, mode: 'off', fanoutEnabled: false }`. Its stats are `commandConsole` on `AdbStatsResponseSchema` (`packages/protocol/src/api/adb.ts:209-232`), `ZERO_COMMAND_CONSOLE` (`core/src/api/adb-stats.ts:79-85`), the dep at `:137`, wired at `daemon.ts:3078`. Its retention sweep is `sweepCommandRuns` (`maintenance/retention.ts:121-133`). Its daemon wiring is `daemon.ts:161-164` (imports), `:405`, `:914`, `:1570-1627`, `:2973-3000`, `:3611-3616`, `:3679`, `:4577-4578`.
- The word cluster: `db/schema.ts:47` `clusterId: text('cluster_id'),` on `devices`, `:164` `index('idx_devices_cluster').on(t.clusterId),`, `:655-663` `export const clusters = sqliteTable('clusters', ...)` with `index('idx_clusters_created')`, `:678` `clusterId: text('cluster_id'),` on `batches`, `:1332` `clusterId: text('cluster_id'),` on `schedules`. `packages/core/src/clusters/` holds `dispatch.ts`, `pacer.ts`, `status.ts`, `resolve.ts`, `membership.ts` (batch dispatch and membership, 24 KB). `api/clusters.ts` (267 lines) is mounted at `http.ts:416` `app.route('/api/clusters', deps.clusterRoutes)`. Protocol: `messages/batch.ts:49-58` `ClusterInfoSchema`, `:63` `via: z.enum(['tag', 'explicit', 'cluster'])`, `:72-76` `ClusterPreviewSchema`, `:121` `clusterId: z.string().nullable(),` on `BatchInfoSchema`; `api/clusters.ts` `ClusterResponseSchema`; `api/devices.ts:332` `ClusterMoveResponseSchema`; `device.ts:224` `cluster: z.object({ id, name }).nullable().default(null)`; `messages/schedule.ts:61` `clusterId`; `api/plugins.ts:705`, `:739` `clusterId`; `plugin-surface.ts:261` `BINDING_DEVICE_FIELDS = ['id', 'stableId', 'label', 'status', 'clusterId', 'number']`; `schema/vocabulary.ts:106` `'clusters'` in `PARAM_SOURCES`. Studio: 51 hits in `app/page.tsx` (`type GroupBy = 'none' | 'cluster' | 'status' | 'tag'` at `:131`, the `?group=cluster` query at `:177`), `app/clusters/page.tsx`, `ClusterEditorDialog.tsx`, `ClusterMembersDialog.tsx`, `target/useTargetSelection.ts:7` `export type Target = 'single' | 'cluster' | 'devices'`, `packages/ui/src/components/device-picker.tsx:80` `cluster?: { id: string; name: string } | null`, and the rest of the inventory in §5 step 207.9. Audit actions `cluster.create/update/delete/assign/unassign` (`auth/audit.ts:103-107`). The historical migration helper `db/migrations/cluster-materialise.ts` reads the pre-`0014` `clusters` table by raw SQL and writes a persisted marker id `'cluster-materialise-22.0'` (`:18`); `daemon.ts:131`, `:464-465` sequence it.
- Permissions (`packages/core/src/auth/acl.ts`): `can(role, permission)` `:246`, `canUseShell(role, mode)` `:259`, `canUseFiles(role, mode)` `:288`, `canUseDevice(user, device)` `:299`, the `OPERATOR` set `:180`. Per-route today: `job.run` (batches), `device.files` widened by `shell.mode` plus `transfer.enabled` (transfer.ts `authorize` `:81-89`), `device.network` (network routes), `device.settings` (label, prep, tags, cluster, disconnect, reconnect, forget, block), `device.enroll` (cutover), `device.quarantine` (unquarantine), `device.view` (readiness), `canUseShell` (console and `shell.exec`).
- Studio callers of the deleted routes (verified with the grep in G13): `FilesPanel.tsx:139,161,179`, `ForgetDeviceDialog.tsx:92,111`, `BulkForgetDialog.tsx:93`, `DisconnectDeviceDialog.tsx:74`, `device/CutoverDialog.tsx:117,133`, `device/BulkCutoverDialog.tsx:179`, `device/PhysicalLabellingPanel.tsx:88,104`, `lib/labelling.ts:85`, `app/page.tsx:372,429,910,920`, `device-popup/ActionsList.tsx:513,528`, `app/device/page.tsx:493,503`, `TagEditor.tsx:35`, `AdmitDeviceDialog.tsx:124`, `device-popup/PreparationPanel.tsx:255,262`, `guest-agent/AgentAlertDetail.tsx:256`, `guest-agent/VpnAgentPrecondition.tsx:241`, `lib/readiness.ts:22`, `lib/api.ts:518` (`postNetworkAction`), `guest-agent/HttpProxyFields.tsx:194`, `guest-agent/VpnRouteFields.tsx:266`, `guest-agent/NetworkRouteForm.tsx:423`, `network/BulkProxyDialog.tsx:227`, `BulkPrepDialog.tsx:209`, `InstallBatchDialog.tsx:187`, `BulkTransferDialog.tsx:169`, `RunScriptDialog.tsx:838-866`, `device-popup/AdbCommandDialog.tsx:259-316`, `terminal/TerminalPane.tsx:133`, `lib/operations.ts:621`, `ClusterMembersDialog.tsx:78,107,135`, `ClusterEditorDialog.tsx:48,52`, `app/clusters/page.tsx:39,66`, `app/schedules/detail/page.tsx:144`, `ScheduleEditorDialog.tsx:183`, `RunScriptDialog.tsx:644`, `ActionsList.tsx:361`, `app/page.tsx:504`, `app/console/page.tsx` (whole file), `components/command/CommandHistory.tsx:38`, `components/command/SavedCommands.tsx:53,67,84`.
- MVP 13 A.5 lists `POST /api/transfers split` as a route to remove; no such route exists (`api/transfers.ts` has only `GET /`). Nothing to delete; recorded here so nobody looks for it.

### 3.2 Decisions

1. **One router, a verb table, no generic body verb.** `POST /api/actions/<verb>` is the only shape. A `POST /api/actions` with `verb` in the body is not added (MVP 07 §1.1 and §5 item 1); an unknown verb answers `404 E_UNKNOWN_VERB`. The verb table (§4.2) is data: params schema, permission gate, policy kind, availability rule, implementation. Adding a verb is adding a row.
2. **Per-device evaluation in a fixed order, then dispatch.** For each resolved device: (a) exists, else `skipped`; (b) `canUseDevice`, else `forbidden` with code `auth.forbidden`; (c) online unless the verb declares `offline: 'allow'`, else `skipped` (`offline` or `quarantined`); (d) the policy table (plan 205 `evaluate`) for the verb's `policyKind`, `forbid` becomes `forbidden`, `warn` becomes `warned` unless `force` is true; (e) dispatch. The order matters: a device the caller may not touch never learns why beyond `auth.forbidden`.
3. **`force` means "I read the warnings".** It acknowledges `warn` decisions only (MVP 04 §1.3). It is also passed through to the two implementations that have their own `force` today (`reconnect`, `disconnect`), so an old dialog's `force` checkbox keeps its meaning. It never overrides `forbid`.
4. **Sync verbs answer `done` in the 202; async verbs answer `accepted` and settle on the operation.** Sync: `wake`, `sleep`, `reconnect`, `disconnect`, `cutover`, `forget`, `block`, `unquarantine`, `set-label`, `clear-label`, `set-group`, `set-tags`, `settings`, `reprofile`, `run-script` (the batch is created synchronously; the jobs run later under the scheduler). Async: `install`, `push`, `pull`, `adb`, `screenshot`, `clear-cache`, `set-network`, `prepare`, `retry-prepare`. The split is the existing implementation's own duration: a settings write returns in milliseconds, an install in minutes.
5. **`run-script` does not consult the policy table at request time.** MVP 04 §1.3 says "job over job: forbid (queue behind it)"; plan 205 §4.7 puts that in `claimNext` and the scheduler's control wait. The router therefore hands every accepted device to `createBatch` and lets the queue do what it already does. `run-workflow` is a stub until plan 211.
6. **Fan-out is bounded by a constant, not a setting.** `ACTION_FANOUT_CONCURRENCY = 4` async dispatches run at once per operation; the adb semaphore (00-overview §3) bounds the rest. The console's `fanoutConcurrency`, `fanoutMaxDevices`, `fanoutConfirmThreshold` and `fanoutStageWaitSec` are deleted with it (MVP 12 §3 makes such numbers constants).
7. **The operation registry is in memory.** Like the transfer registry (`api/transfers.ts` doc comment), a core restart forgets operations; the durable rows (jobs, batches) and the activity list are the record. TTL one hour after the last result settles, at most 1 000 operations kept, oldest evicted.
8. **Groups is a rename, not a redesign.** The directory `packages/core/src/clusters/` becomes `packages/core/src/groups/` (`git mv`), the table and columns are renamed by one migration, every identifier and every line of copy follows. The historical migration helper keeps its raw SQL and its persisted marker id byte for byte, because both name a table as it was called before `0014`; the file is renamed to `db/migrations/materialise-0014.ts` so the only occurrences of the word live inside it.
9. **The old Studio gets an adapter, not a rebuild.** `packages/studio/src/lib/actions.ts` wraps the new routes. Old single-device flows call `runOnDevice(verb, deviceId, params)`, which sends the action, awaits the operation when the result is `accepted`, shows a `warned` sentence once as a toast and re-sends with `force: true` (the same "proceed and tell" plan 205 §3.2 item 2 chose for WS input), and throws `ActionRefusedError` on `forbidden`, `skipped` or `failed`. Old bulk dialogs call `runAction(verb, target, params)` and render the `results` array through a minimal `ActionResults` list. Plan 216 replaces all of it with the picker and inline chips.
10. **The Adb command dialog stays, the console goes.** `AdbCommandDialog` is rewritten around `runAction('adb', ...)` and the operation poll; `components/command/*` (the console's picker, report, history, saved commands, fan-out confirmation) are deleted with the page. `TerminalPane` (the device terminal over `shell.exec`) stays and loses its command-history fetch.
11. **`screenshot` and `pull` write device artifacts through the existing writer.** `registerDeviceArtifact` (`runner/artifact-store.ts:265`) is the one place a device-scoped artifact row is created; the verbs call it, never a second writer.
12. **`clear-cache` is `cmd package clear --cache-only`, never `pm clear`.** `pm clear` wipes app data (`packages/session/src/reset.ts:144` uses it deliberately for a reset); a menu item called "Clear cache" must not. The exact shell string is §9 Q3 (to verify on the lab device); a device that refuses the option reports `failed` with the shell's own message and nothing else is attempted.

## 4. Technical design

### 4.1 Protocol (`packages/protocol/src/actions.ts`, new)

Zod 4, the style of `packages/protocol/src/api/devices.ts` (`z.discriminatedUnion`, `.describe`, `z.infer`).

```ts
import { z } from 'zod'
import { CutoverStartBodySchema } from './api/devices'
import { DevicePrepPatchSchema } from './api/devices'
import { ConnectionMediumSchema } from './device'
import { DeviceSettingsSchema } from './settings'

/** MVP 07 §1.1: a single device is `{ deviceIds: [one] }`. Exactly one key. */
export const TargetSchema = z.union([
  z.object({ deviceIds: z.array(z.string().min(1)).min(1) }),
  z.object({ groupId: z.string().min(1) }),
  z.object({ tags: z.array(z.string().min(1)).min(1) }),
])
export type Target = z.infer<typeof TargetSchema>

export const ACTION_VERBS = [
  'run-script',
  'run-workflow',
  'install',
  'push',
  'pull',
  'adb',
  'wake',
  'sleep',
  'reconnect',
  'disconnect',
  'cutover',
  'forget',
  'block',
  'unquarantine',
  'set-network',
  'set-label',
  'clear-label',
  'set-group',
  'set-tags',
  'prepare',
  'retry-prepare',
  'reprofile',
  'screenshot',
  'clear-cache',
  'settings',
] as const
export const ActionVerbSchema = z.enum(ACTION_VERBS)
export type ActionVerb = z.infer<typeof ActionVerbSchema>

/** The `pacing` block `POST /api/batches` took (plan 94 §4.9), unchanged. */
const PacingSchema = z
  .object({
    count: z.number().int().min(1).max(1000).default(1),
    intervalMs: z.tuple([z.number().int().min(0), z.number().int().min(0)]).default([0, 0]),
    deviceIntervalMs: z.number().int().min(0).max(3_600_000).default(0),
  })
  .refine((p) => p.intervalMs[0] <= p.intervalMs[1], 'the interval range is inverted')

/**
 * A two-level partial of `DeviceSettingsSchema`: every top-level block optional,
 * every field inside a block optional. Built from `DeviceSettingsSchema.shape`
 * so a block added later cannot be missed; `actions.test.ts` pins the key set.
 * A block that is not a `ZodObject` after unwrapping its default (today `timing`
 * is `TimingSettingsSchema.default(...)`) is unwrapped with `.unwrap()` first.
 */
export const DeviceSettingsPatchSchema = z.object(
  Object.fromEntries(
    Object.entries(DeviceSettingsSchema.shape).map(([key, block]) => {
      const inner = block instanceof z.ZodDefault ? block.unwrap() : block
      return [key, (inner instanceof z.ZodObject ? inner.partial() : inner).optional()]
    }),
  ),
)
export type DeviceSettingsPatch = z.infer<typeof DeviceSettingsPatchSchema>

const CommonSchema = z.object({
  target: TargetSchema,
  /** MVP 04 §1.3: acknowledges `warn` decisions; never overrides `forbid`. */
  force: z.boolean().default(false),
})

/** One member per verb. `params` is the verb's own body, flattened beside `target` on the wire (MVP 07 §1.1). */
export const ActionRequestSchema = z.discriminatedUnion('verb', [
  CommonSchema.extend({
    verb: z.literal('run-script'),
    scriptId: z.string().min(1).optional(),
    /** `name@version` or `name@latest`, resolved by the script registry, the same `scriptRef` `POST /api/jobs` took. */
    scriptRef: z.string().min(1).optional(),
    params: z.unknown().optional(),
    concurrency: z.number().int().min(0).default(0),
    order: z.enum(['as-listed', 'random']).default('as-listed'),
    priority: z.number().int().optional(),
    runtimeOverride: z.unknown().optional(),
    pacing: PacingSchema.optional(),
  }).refine((b) => Boolean(b.scriptId) !== Boolean(b.scriptRef), 'exactly one of scriptId or scriptRef'),
  CommonSchema.extend({ verb: z.literal('run-workflow'), workflowName: z.string().min(1), params: z.unknown().optional() }),
  CommonSchema.extend({
    verb: z.literal('install'),
    artifactId: z.string().min(1),
    reinstall: z.boolean().optional(),
    grantPermissions: z.boolean().optional(),
    allowDowngrade: z.boolean().optional(),
  }),
  CommonSchema.extend({
    verb: z.literal('push'),
    artifactId: z.string().min(1),
    remotePath: z.string().min(1),
    mediaScan: z.enum(['auto', 'always', 'never']).default('auto'),
  }),
  CommonSchema.extend({ verb: z.literal('pull'), remotePath: z.string().min(1) }),
  CommonSchema.extend({ verb: z.literal('adb'), cmd: z.string().min(1).max(4096) }),
  CommonSchema.extend({ verb: z.literal('wake') }),
  CommonSchema.extend({ verb: z.literal('sleep') }),
  CommonSchema.extend({ verb: z.literal('reconnect'), allowSweep: z.boolean().optional() }),
  CommonSchema.extend({ verb: z.literal('disconnect') }),
  CommonSchema.extend({
    verb: z.literal('cutover'),
    op: z.enum(['start', 'cancel']).default('start'),
    medium: ConnectionMediumSchema.optional(),
    port: z.number().int().min(1).max(65535).optional(),
    address: z.string().min(1).optional(),
  }).refine((b) => b.op === 'cancel' || b.medium !== undefined, 'medium is required to start a cutover'),
  CommonSchema.extend({ verb: z.literal('forget'), deleteHistory: z.boolean().default(false) }),
  CommonSchema.extend({ verb: z.literal('block'), reason: z.string().min(1).optional() }),
  CommonSchema.extend({ verb: z.literal('unquarantine') }),
  CommonSchema.extend({
    verb: z.literal('set-network'),
    op: z.enum(['set', 'enable', 'disable', 'retry', 'clear']).default('set'),
    /** Unparsed on purpose, exactly as `DeviceNetworkApplyBodySchema.route` was (its doc comment): the door re-parses and refuses credentials. */
    route: z.record(z.string(), z.unknown()).optional(),
  }).refine((b) => b.op !== 'set' || b.route !== undefined, 'route is required for op: set'),
  CommonSchema.extend({ verb: z.literal('set-label') }),
  CommonSchema.extend({ verb: z.literal('clear-label'), restoreOriginal: z.boolean().default(false) }),
  CommonSchema.extend({ verb: z.literal('set-group'), groupId: z.string().min(1).nullable() }),
  CommonSchema.extend({ verb: z.literal('set-tags'), tags: z.array(z.string()) }),
  CommonSchema.extend({ verb: z.literal('prepare'), forceRecheck: z.boolean().default(false) }),
  CommonSchema.extend({ verb: z.literal('retry-prepare'), component: z.string().min(1) }),
  CommonSchema.extend({ verb: z.literal('reprofile') }),
  CommonSchema.extend({ verb: z.literal('screenshot') }),
  CommonSchema.extend({ verb: z.literal('clear-cache'), package: z.string().min(1).max(256) }),
  CommonSchema.extend({ verb: z.literal('settings'), settings: DeviceSettingsPatchSchema }),
])
export type ActionRequest = z.infer<typeof ActionRequestSchema>
export type ActionParams<V extends ActionVerb> = Omit<Extract<ActionRequest, { verb: V }>, 'verb' | 'target' | 'force'>

/** MVP 07 §1.2. `accepted`/`done`/`failed` are the life of an async verb; `done`/`failed` the whole life of a sync one. */
export const ActionResultStatusSchema = z.enum(['accepted', 'skipped', 'forbidden', 'warned', 'done', 'failed'])
export type ActionResultStatus = z.infer<typeof ActionResultStatusSchema>

export const ActionResultSchema = z.object({
  deviceId: z.string(),
  status: ActionResultStatusSchema,
  /** The policy sentence for `warned`/`forbidden`, the skip reason, or the failure message. */
  message: z.string().optional(),
  /** The coded error for `forbidden`/`failed` (`E_DEVICE_CONFLICT`, `auth.forbidden`, `job_running`, ...). */
  code: z.string().optional(),
  /** The activity this verb started on the device (plan 205 ids: `transfer:<id>`, `command:<operationId>:<deviceId>`, ...). */
  activityId: z.string().optional(),
  jobId: z.string().optional(),
  batchId: z.string().optional(),
  /** Verb-specific outcome for `done`: `ReconnectOutcome`, `CutoverState`, `DeviceLabelState`, `DeviceReadiness`, `{ artifactId, bytes }`, `{ exitCode, stdout, stderr, truncated, durationMs }`, ... Parsed by the caller with the verb's own schema. */
  detail: z.unknown().optional(),
})
export type ActionResult = z.infer<typeof ActionResultSchema>

export const ActionResponseSchema = z.object({
  operationId: z.string(),
  verb: ActionVerbSchema,
  results: z.array(ActionResultSchema),
})
export type ActionResponse = z.infer<typeof ActionResponseSchema>

/** `GET /api/operations/:id`. */
export const OperationSchema = ActionResponseSchema.extend({
  target: TargetSchema,
  createdBy: z.string().nullable(),
  /** Unix seconds. */
  createdAt: z.number().int(),
  /** True once no result is `accepted`. */
  settled: z.boolean(),
})
export type Operation = z.infer<typeof OperationSchema>
export const OperationResponseSchema = z.object({ operation: OperationSchema })

/** Whole-request refusals; per-device outcomes never use HTTP status. */
export const ACTION_ERROR_CODES = {
  E_UNKNOWN_VERB: 404,
  E_BAD_REQUEST: 400,
  'auth.forbidden': 403,
  group_not_found: 404,
  operation_not_found: 404,
  E_NOT_SUPPORTED: 501,
  unknown_script: 400,
  script_disabled: 409,
  invalid_job_params: 400,
  params_incompatible: 409,
  E_RUNTIME_ENVELOPE_INVALID: 400,
  E_RUNTIME_OVER_CEILING: 400,
} as const
```

`packages/protocol/src/index.ts` exports everything from `./actions`. The capability input, beside it:

```ts
/** `actions.run` (§4.10): the request without the flattening, so a plugin passes `params` as one object. */
export const ActionCapabilityInputSchema = z.object({
  verb: ActionVerbSchema,
  target: TargetSchema,
  params: z.record(z.string(), z.unknown()).default({}),
  force: z.boolean().default(false),
})
```

Changes in existing protocol files:

| File | Change |
|---|---|
| `messages/batch.ts:49-58` | `ClusterInfoSchema` becomes `GroupInfoSchema` (same fields; doc "A group is a container, not a selector"); `:63` `via: z.enum(['tag', 'explicit', 'group'])`; `:72-76` `ClusterPreviewSchema` becomes `TargetPreviewSchema`, `ClusterPreview` becomes `TargetPreview`; `:121` `groupId: z.string().nullable()` |
| `api/clusters.ts` | renamed `api/groups.ts`; `GroupResponseSchema = z.object({ group: GroupInfoSchema })`; `api/index.ts:23` `export * from './groups'` |
| `api/devices.ts:332-336` | delete `ClusterMoveResponseSchema` (the assign routes are gone; `set-group` returns `detail: { movedFrom }`) |
| `api/devices.ts:847-1004` | delete `DeviceLabelsApplyBodySchema`, `DeviceLabelsApplyResultSchema`, `DeviceLabelsApplyResponseSchema`, `DevicePrepApplyBodySchema`, `DevicePrepApplyResultSchema`, `DevicePrepApplyResponseSchema`, `DevicePrepApplyOutcome`, `classifyDevicePrepApply` and their types; keep `DEVICE_PREP_KEYS`, `DevicePrepPatchSchema`, `DeviceNumber*` |
| `api/devices.ts:632-692`, `:750` | delete `DeviceNetworkApplyBodySchema`, `DeviceNetworkApplyResultSchema`, `DeviceNetworkApplyResponseSchema`, `DeviceNetworkApplyOutcome`, `classifyDeviceNetworkApply`, `DEVICE_NETWORK_APPLY_SKIP_CODES` |
| `api/transfer.ts` | delete the file (`InstallResponseSchema`, `PushResponseSchema`, `PullResponseSchema` were the per-verb envelopes MVP 07 §3 replaces); `api/index.ts:32` line removed; `InstallResultSchema`/`PushResultSchema` in `messages/transfer.ts` stay (they are `detail` payloads) |
| `api/jobs.ts:25` | delete `JobCreateResponseSchema` (its only route is gone) |
| `api/batches.ts:9` | `BatchResponseSchema` stays (used by `/:id/rerun-failed` until plan 211) |
| `messages/schedule.ts:61` | `groupId: z.string().nullable(),` |
| `device.ts:220-224` | `group: z.object({ id: z.string(), name: z.string() }).nullable().default(null)`, doc "The owning group, or null" |
| `api/plugins.ts:692`, `:705`, `:739` | `groupId` |
| `plugin-surface.ts:261` | `BINDING_DEVICE_FIELDS = ['id', 'stableId', 'label', 'status', 'groupId', 'number'] as const` |
| `schema/vocabulary.ts:106` | `'groups',` |
| `command/target.ts`, `command/saved.ts`, `api/command-runs.ts`, `messages/command.ts` | deleted; `command/high-consequence.ts` stays (the device terminal's advisory guard) |
| `index.ts` | delete the imports and union members at `:133-147`, `:1082-1089`, `:1270-1274`, the re-exports at `:1395-1449`, `:1493-1508`; rename the `Cluster*` exports at `:521-533`; export `./actions` |
| `api/adb.ts:209-232` | delete `commandConsole` |
| `settings.ts:1758-1828`, `:1838-1846`, `:1849-1852` | delete `fanoutEnabled`, `fanoutMaxDevices`, `fanoutConcurrency`, `fanoutMaxOutputBytes`, `fanoutPreviewBytes`, `fanoutConfirmThreshold`, `fanoutStageWaitSec`, `commandRunsPerUser`, `savedCommandLimit`, their defaults, and the fleet-command half of the block's `title`/`description` (`title: 'Device terminal'`, description without the plan 93 clause); `:1152-1162`, `:1183` delete `commandRunDays` and its default |

### 4.2 The verb table (`packages/core/src/actions/verbs.ts`, new)

```ts
import type { ActivityKind } from '@enkaku/protocol'
import type { ActionVerb } from '@enkaku/protocol'
import type { Permission } from '../auth/acl'

/** `shell`: `canUseShell(role, shell.mode)`; `files`: `canUseFiles(role, shell.mode)` plus `transfer.enabled`. */
export type VerbGate = { permission: Permission } | { gate: 'shell' } | { gate: 'files' }

export interface VerbSpec {
  gate: VerbGate
  /** The row of MVP 04 §1.3 evaluated before dispatch; null means the implementation's own refusals are the only guard. */
  policyKind: ActivityKind | null
  /** Whether an offline or quarantined device is dispatched (`allow`) or reported `skipped` (`skip`). */
  offline: 'allow' | 'skip'
  /** `sync` answers `done` in the 202; `async` answers `accepted` and settles on the operation. */
  mode: 'sync' | 'async'
}

export const VERBS: Record<ActionVerb, VerbSpec> = {
  'run-script':   { gate: { permission: 'job.run' },            policyKind: null,            offline: 'skip',  mode: 'sync' },
  'run-workflow': { gate: { permission: 'job.run' },            policyKind: null,            offline: 'skip',  mode: 'sync' },
  install:        { gate: { gate: 'files' },                    policyKind: 'install',       offline: 'skip',  mode: 'async' },
  push:           { gate: { gate: 'files' },                    policyKind: 'transfer',      offline: 'skip',  mode: 'async' },
  pull:           { gate: { gate: 'files' },                    policyKind: 'transfer',      offline: 'skip',  mode: 'async' },
  adb:            { gate: { gate: 'shell' },                    policyKind: 'command',       offline: 'skip',  mode: 'async' },
  wake:           { gate: { permission: 'device.view' },        policyKind: null,            offline: 'skip',  mode: 'sync' },
  sleep:          { gate: { permission: 'device.view' },        policyKind: null,            offline: 'skip',  mode: 'sync' },
  reconnect:      { gate: { permission: 'device.settings' },    policyKind: null,            offline: 'allow', mode: 'sync' },
  disconnect:     { gate: { permission: 'device.settings' },    policyKind: null,            offline: 'skip',  mode: 'sync' },
  cutover:        { gate: { permission: 'device.enroll' },      policyKind: null,            offline: 'allow', mode: 'sync' },
  forget:         { gate: { permission: 'device.settings' },    policyKind: null,            offline: 'allow', mode: 'sync' },
  block:          { gate: { permission: 'device.settings' },    policyKind: null,            offline: 'allow', mode: 'sync' },
  unquarantine:   { gate: { permission: 'device.quarantine' },  policyKind: null,            offline: 'allow', mode: 'sync' },
  'set-network':  { gate: { permission: 'device.network' },     policyKind: 'network-apply', offline: 'allow', mode: 'async' },
  'set-label':    { gate: { permission: 'device.settings' },    policyKind: null,            offline: 'skip',  mode: 'sync' },
  'clear-label':  { gate: { permission: 'device.settings' },    policyKind: null,            offline: 'skip',  mode: 'sync' },
  'set-group':    { gate: { permission: 'device.settings' },    policyKind: null,            offline: 'allow', mode: 'sync' },
  'set-tags':     { gate: { permission: 'device.settings' },    policyKind: null,            offline: 'allow', mode: 'sync' },
  prepare:        { gate: { permission: 'device.settings' },    policyKind: 'prep',          offline: 'skip',  mode: 'async' },
  'retry-prepare':{ gate: { permission: 'device.settings' },    policyKind: 'prep',          offline: 'skip',  mode: 'async' },
  reprofile:      { gate: { permission: 'device.settings' },    policyKind: 'wake',          offline: 'skip',  mode: 'sync' },
  screenshot:     { gate: { permission: 'device.view' },        policyKind: null,            offline: 'skip',  mode: 'async' },
  'clear-cache':  { gate: { permission: 'device.control' },     policyKind: 'command',       offline: 'skip',  mode: 'async' },
  settings:       { gate: { permission: 'device.settings' },    policyKind: null,            offline: 'allow', mode: 'sync' },
}

export const ACTION_FANOUT_CONCURRENCY = 4
```

Notes the table encodes:

- `set-network` with `op: 'disable'` or `'clear'` is the disarm direction: an offline device is accepted (the route service records the teardown as owed, `route-service.ts:2985-2990`'s own comment); `set`, `enable`, `retry` on an offline device are what the door refuses, and the router reports the door's `device_unavailable` as `skipped`. That is why the row says `allow` and the door decides.
- `reprofile` uses the `wake` row (forbid over a job or an install, allow otherwise), the same rule `SessionManager.reprofile`'s `skippedBusy` applied.
- `disconnect` and `cutover` keep their running-job guards inside the implementation (§4.3), reported as `warned` (disconnect, `force` proceeds) and `forbidden` (cutover, no override, `devices.ts:1541-1543`'s own reasoning: a chassis port flip cannot be recovered mid-run).
- `prepare` and `retry-prepare` use the `prep` row plan 205 §4.3 proposes; if plan 205's §9 Q1 changed that row, the executor follows the landed table.

Per verb, the implementation the router dispatches to (all injected through `ActionsDeps`, §4.3):

| Verb | Implementation | Activity it starts (plan 205 registry) | `detail` on `done` |
|---|---|---|---|
| run-script | `createBatch(createBatchDispatchDeps(deps.batches, actor), { scriptId, params, target: { deviceIds: accepted }, concurrency, order, priority, runtimeOverride, pacing, createdBy })` once per request; `scriptRef` resolved through `deps.resolveScriptRef` exactly as `jobs.ts:216-221` did; each returned job maps to `{ status: 'accepted', jobId, batchId }`; each `batch.skipped` row maps to `skipped` with its reason | `job:<id>` when the scheduler claims it (plan 205 §4.7), not here | none |
| run-workflow | throws `EnkakuError('E_NOT_SUPPORTED', 'workflow jobs are plan 211; run-workflow is not available yet')` before resolving the target | none | none |
| install | `runTransfer({ transfer, broadcast, deviceId, kind: 'install', holdFor, op: (transferId, onProgress) => transfer.install(deviceId, artifactId, { transferId, onProgress, reinstall, grantPermissions, allowDowngrade }) })`; the `record` call of `transfer.ts:106-113` and `:122-128` copied | `transfer:<transferId>` (by the registry, plan 205 §4.10); the router returns that id as `activityId` | `InstallResult` |
| push | same door, `transfer.push(deviceId, artifactId, remotePath, { transferId, onProgress, mediaScan })`; events as `transfer.ts:150-156`, `:164-170` | `transfer:<transferId>` | `PushResult` |
| pull | same door, `transfer.pull(deviceId, remotePath, { transferId, onProgress })`; events as `transfer.ts:192-198`, `:206-212` | `transfer:<transferId>` | `{ artifactId, bytes }` |
| adb | `activities.start(deviceId, { id: \`command:${operationId}:${deviceId}\`, kind: 'command', label: 'Running an adb command', actor })`; `deps.shellPortFor(deviceId).exec(cmd, { timeoutMs: shell.execTimeoutMs, maxOutputBytes: shell.maxOutputBytes })`; the same device event `shell.exec` writes at `ws-handlers.ts:1403-1425` (the audit row above `recordSingle`), with `cmd` through `redactShellCommand`; `activities.end` in `finally` | `command:<operationId>:<deviceId>` | `{ exitCode, stdout, stderr, truncated, durationMs }` |
| wake | `readiness.set(deviceId, 'awake', { userId, clientId: null })` | `wake:<deviceId>` (by readiness, plan 206 §4.11) | `DeviceReadiness` |
| sleep | `readiness.set(deviceId, 'asleep', { userId, clientId: null })` | none | `DeviceReadiness` |
| reconnect | `reconnector.reconnect(row.stableId, { allowSweep, force })`; `record` `device.reconnected` and audit `device.reconnect` as `devices.ts:1484-1492` | none | `ReconnectOutcome` |
| disconnect | the body of `devices.ts:1407-1470` as a function: USB refusal `E_TRANSPORT_NOT_DETACHABLE` maps to `failed`; a live `job`/`workflow-job`/`install` activity without `force` maps to `warned` with the sentence `${n} running job${s} on ${label} (${names}) would fail if disconnected now`; then `sessions.closeDevice(id)`, the activity drain plan 205 put where `leases.releaseDevice` was, `reconnector.disconnect(stableId)`, the two records | none | `DisconnectOutcome` |
| cutover | `op: 'start'`: the body of `devices.ts:1555-1600` as a function (`E_ALREADY_ON_NETWORK`, `device_offline` map to `failed`; a live job maps to `forbidden` with `devices.ts:1577`'s sentence; `cutover.start(device, { port, medium, address })`; audit `device.cutover.start`); `op: 'cancel'`: `cutover.cancel(stableId)`, audit `device.cutover.cancel` | none | `CutoverState` (`start`), `{ cancelled: true }` (`cancel`) |
| forget | `lifecycle.forget(id, { deleteHistory, actor })`; audit `device.forget`; `broadcast({ type: 'device.removed', ... })` as `devices.ts:1719-1731` | none | `ForgetResult` |
| block | `lifecycle.block(id, { reason, actor })`; audit `device.block`; `device.removed` as `devices.ts:1741-1755` | none | `BlockedDevice` |
| unquarantine | `battery.unquarantine(id)`; `false` maps to `skipped` with message `not quarantined`; audit `device.unquarantine` | none | `DeviceInfo` |
| set-network | `op: 'set'`: validate once per request as `route-service.ts:3235-3242` does (`NetworkRouteConfigSchema.safeParse(tagUntaggedRouteConfig(raw))`, `assertNoHttpProxyAuth`), a failure is a `400` for the whole request; then per device `routeService.actions.set(id, raw, actor)`; `enable`/`disable`/`retry`/`clear`: `routeService.actions.<op>(id, actor)` (§5 step 207.5 extracts these five functions) | `network-apply:<uuid>` (by the door, plan 205 §4.9) | `DeviceNetworkStatusResponse` |
| set-label | `labelling.apply(id, actor)`; audit `device.label.apply` | none | `DeviceLabelState` |
| clear-label | `labelling.clear(id, { restoreOriginal, actor })`; audit `device.label.clear` | none | `DeviceLabelState` |
| set-group | `assignDevices(db, groupId, accepted)` or `unassignDevices(db, accepted)` once for every accepted device (both are one transaction and validate every id); per device `detail: { movedFrom }`; audit `group.assign`/`group.unassign` | none | `{ movedFrom: string \| null }` |
| set-tags | `replaceDeviceTags(db, id, tags)`; audit `device.settings` with the diff as `devices.ts:1665-1670` | none | `{ tags: string[] }` |
| prepare | `Promise.all([agentProvisioner?.ensure(id, opts), runner.ensure(id, opts)])` then `runner.status(id)`, exactly `device-preparation.ts:100-110` with `opts = forceRecheck ? { force: true } : undefined` | `prep:<component>` (by the runner, plan 205 §4.10) | `DevicePreparation` |
| retry-prepare | `device-preparation.ts:118-128`'s two branches (`GUEST_AGENT_COMPONENT_ID` through the provisioner, else `runner.ensureComponent(id, component, { force: true })`); an unknown component maps to `failed` with `preparation_component_not_found` | `prep:<component>` | `PreparationComponentStatus` |
| reprofile | `const s = sessions.get(id)`; null maps to `skipped` (`no session`); else `await sessions.restartAt(id, s.quality, 'applying new video settings')` (the same call `devices.ts:1240` makes) | none | `{ restarted: true }` |
| screenshot | `deps.screenshot(id)` (daemon: the `deviceCall` of `device-inspect.ts:128`, base64 decoded) then `registerDeviceArtifact(...)` with label `screenshot-<unix seconds>.png`; the executor reads `runner/artifact-store.ts:265`'s signature and passes `jobId: null` where a job id is optional | none | `{ artifactId, bytes }` |
| clear-cache | as `adb` with `cmd = \`cmd package clear --cache-only ${shellQuote(package)}\`` (§9 Q3); exit code non-zero maps to `failed` with the trimmed stderr, else `done` | `command:<operationId>:<deviceId>` | `{ exitCode, stdout, stderr }` |
| settings | per device: read the row, `DeviceSettingsSchema.safeParse(row.settings ?? {})` (a failure is `failed` with `E_SETTINGS_UNREADABLE`, `devices.ts:756-762`'s own reasoning), merge block by block and key by key (only keys present in the patch, never a spread), `DeviceSettingsSchema.parse` the result, write, `record` `settings.changed` with `source: 'bulk'`; when `prep.rotation` is in the patch, the live re-lock of `devices.ts:800-830` (`sessions.setRotation`, skipped with `state: 'busy'` when a job activity is live); when any `video` key is in the patch, the `restartAt` of `devices.ts:1236-1240` unless a job activity is live | none | `{ changed: string[], rotation: RotationApplyResult \| null }` |

### 4.3 The router (`packages/core/src/api/actions.ts`, new)

```ts
import { Hono } from 'hono'
import { ActionRequestSchema, ActionVerbSchema, ActionResponseSchema, OperationResponseSchema, ACTION_ERROR_CODES, type ActionVerb } from '@enkaku/protocol'
import type { AuthEnv } from '../auth/middleware'
import { runAction, type ActionsDeps } from '../actions/run'
import { EnkakuError } from '../util/errors'
import { typedJson } from './typed-json'

/** `POST /api/actions/:verb` and `GET /api/operations/:id`, one Hono app mounted twice (§4.8). */
export function createActionRoutes(deps: ActionsDeps): { actions: Hono<AuthEnv>; operations: Hono<AuthEnv> }
```

`POST /:verb`:

1. `const verb = ActionVerbSchema.safeParse(c.req.param('verb'))`; failure throws `EnkakuError('E_UNKNOWN_VERB', \`no such action: ${raw}\`)`.
2. `const body = ActionRequestSchema.safeParse({ verb: verb.data, ...(await c.req.json().catch(() => null)) })`; failure throws `E_BAD_REQUEST` with the joined issues (the `batches.ts:769` format).
3. `const user = c.get('user')` (always present under `authMiddleware`); `const response = await runAction(deps, body.data, { id: user.id, role: user.role })`.
4. `return typedJson(c, ActionResponseSchema, response, 202)`.

`GET /:id` on the operations app: `deps.operations.get(id)` or throw `operation_not_found`; `typedJson(c, OperationResponseSchema, { operation })`.

`app.onError`: `EnkakuError` maps through `ACTION_ERROR_CODES` (default 500), the same shape every other router uses.

`packages/core/src/actions/run.ts` (new) is the function both the router and the capability call:

```ts
export interface ActionActor { id: string; role: Role }

export interface ActionsDeps {
  db: Db
  audit: AuditLogger
  record: EventRecorder['record']
  broadcast: (msg: ServerMessage) => void
  activities: ActivityRegistry                                    // plan 205
  controlSettings: () => ControlSettings                          // plan 205 §4.5
  states: Pick<DeviceStateMachine, 'current'>
  operations: OperationRegistry                                   // §4.4
  userLabel: (userId: string) => string                           // plan 205's resolveActorLabel
  shellSettings: () => { mode: ShellMode; execTimeoutMs: number; maxOutputBytes: number }
  transferSettings: () => { enabled: boolean }
  batches: BatchDispatchHostDeps                                  // the object `createBatchDispatchDeps` takes (api/batches.ts:292)
  resolveScriptRef: (ref: string) => { id: string }
  transfer: { transfer: TransferService; broadcast: TransferBroadcast; holdFor?: (deviceId: string) => Promise<{ release(): void }> }
  shellPortFor: (deviceId: string) => ShellPort
  readiness: Pick<ReadinessManager, 'set'> | null
  reconnector: () => DeviceReconnector | null
  sessions: () => Pick<SessionManager, 'closeDevice' | 'restartAt' | 'get' | 'setRotation'> | null
  cutover: () => CutoverManager | null
  lifecycle: DeviceLifecycle
  battery: () => Pick<BatteryMonitor, 'unquarantine'> | null
  routeService: () => Pick<RouteService, 'actions'> | null
  labelling: LabellingService | null
  preparation: { runner: PreparationRunner; agentProvisioner: DevicePreparationRoutesDeps['agentProvisioner'] }
  screenshot: (deviceId: string) => Promise<Uint8Array>
  dataDir: string
  networks: () => FarmNetwork[]
  infoWithTags: (deviceId: string) => DeviceInfo                   // the same builder api/devices.ts uses
  now?: () => number
}

export async function runAction(deps: ActionsDeps, request: ActionRequest, actor: ActionActor): Promise<ActionResponse>
```

`runAction`, in order:

1. `const spec = VERBS[request.verb]`. Gate: `permission` through `can(actor.role, permission)`; `shell` through `canUseShell(actor.role, deps.shellSettings().mode)`; `files` through `canUseFiles(actor.role, deps.shellSettings().mode)` and `deps.transferSettings().enabled` (the two messages of `transfer.ts:82-87`). A refused gate throws `EnkakuError('auth.forbidden', ...)` for the whole request: the caller may not perform this verb on any device.
2. `run-workflow` throws `E_NOT_SUPPORTED` here.
3. `const resolved = resolveActionTarget(deps.db, request.target)` (§4.5). Unknown group throws `group_not_found`.
4. Per device, build the result (`evaluateDevice`): `skipped` for `resolved.skipped` entries (reason verbatim: `no longer exists`, `offline`, `quarantined`) unless `spec.offline === 'allow'` and the reason is `offline`/`quarantined`, in which case the device is a candidate; `forbidden` with `auth.forbidden` when `!canUseDevice(actor, { ownerId: row.ownerId })`; then, when `spec.policyKind` is set, `const decision = evaluate(spec.policyKind, deps.activities.list(id), deps.controlSettings())`: `forbid` maps to `{ status: 'forbidden', code: E_DEVICE_CONFLICT, message }`, `warn` maps to `{ status: 'warned', message }` unless `request.force`, in which case the device is a candidate and the sentence is kept in `message` beside the eventual `accepted`/`done`.
5. `const op = deps.operations.create({ verb, target, createdBy: actor.id, results })` with every non-candidate result final and every candidate `accepted`.
6. Dispatch. `run-script`, `set-group`: one call for all candidates (§4.2), results filled in from its return. Every other sync verb: `for` each candidate, `await` the implementation, `operations.settle(op.id, deviceId, { status: 'done', detail })` or `{ status: failedStatusOf(err), code, message }`. Async verbs: `dispatchBounded(candidates, ACTION_FANOUT_CONCURRENCY, (id) => impl(id))` started and not awaited; each settles its own result; the 202 goes out with `accepted` rows carrying `activityId` where the implementation minted one before its first await (a transfer id is minted synchronously by `runTransfer`, so the router mints it and passes `transferId` in, the same "reuse an existing id" option `transfer-dispatch.ts:31` documents).
7. `failedStatusOf(err)`: `E_DEVICE_CONFLICT`, `device_busy`, `device_in_use`, `job_running` map to `forbidden`; `device_unavailable`, `device_offline`, `device_quarantined`, `not_quarantined` map to `skipped`; everything else maps to `failed`. `code` is the `EnkakuError` code or `E_INTERNAL`; `message` the error message.
8. `return { operationId: op.id, verb, results: op.results }` (a snapshot at this instant).

Every thrown per-device error is caught per device; the only errors that escape `runAction` are the whole-request ones of step 1 to 3 and `set-network`'s per-request route validation.

### 4.4 The operation registry (`packages/core/src/actions/operations.ts`, new)

```ts
export const OPERATION_TTL_MS = 3_600_000
export const OPERATION_MAX = 1_000

export interface OperationRegistry {
  create(input: { verb: ActionVerb; target: Target; createdBy: string | null; results: ActionResult[] }): Operation
  /** Replaces one device's result; a result that is not `accepted` is never replaced (a settle races nothing). Returns false when unknown. */
  settle(operationId: string, deviceId: string, patch: Omit<ActionResult, 'deviceId'>): boolean
  get(id: string): Operation | null
  /** Evicts settled operations older than the TTL and, past OPERATION_MAX, the oldest first. Called by a 60 s interval `daemon.ts` starts beside the activity sweep. */
  sweep(): number
  startSweep(): void
  stopSweep(): void
}
export function createOperationRegistry(deps: { now?: () => number }): OperationRegistry
```

`settled` is `results.every((r) => r.status !== 'accepted')`; the TTL clock starts at the moment `settled` first became true. An operation that never settles (an implementation that hangs) is evicted by the cap, never by the TTL; the activity registry is where a hung transfer is visible.

### 4.5 Target resolution (`packages/core/src/groups/resolve.ts`, renamed from `clusters/resolve.ts`)

```ts
export interface ResolvedTarget { deviceId: string; via: 'tag' | 'explicit' | 'group' }
export interface ResolvedTargetSet {
  usable: ResolvedTarget[]
  skipped: { deviceId: string; reason: 'offline' | 'quarantined' | 'no longer exists' }[]
}
/** `resolveTarget` and `resolveGroup` stay (renamed); this is the one entry the actions router and the capability use. Throws `group_not_found`. Dedupes. */
export function resolveActionTarget(db: Db, target: Target): ResolvedTargetSet
```

`{ deviceIds }` calls `resolveTarget(db, { tags: [], deviceIds })`; `{ tags }` calls `resolveTarget(db, { tags, deviceIds: [] })`; `{ groupId }` loads the `groups` row and calls `resolveGroup(db, row)`. The `unavailableReason` helper (`resolve.ts:19-23`) reads `row.status` against plan 205's three values (`offline`, `quarantined`; anything else is usable).

### 4.6 Groups: schema and migration

`packages/core/src/db/schema.ts`:

| Line | Before | After |
|---|---|---|
| `:41-47` | `clusterId: text('cluster_id'),` with the "owning cluster" comment | `groupId: text('group_id'),` with "The owning group (plan 22.0 §3.2 as renamed by MVP 15 §0.1), or null. A device belongs to at most one group; this column IS that guarantee ..." |
| `:164` | `index('idx_devices_cluster').on(t.clusterId),` | `index('idx_devices_group').on(t.groupId),` |
| `:649-666` | `export const clusters = sqliteTable('clusters', {...}, (t) => [index('idx_clusters_created')...])`, `ClusterRow` | `export const groups = sqliteTable('groups', {...}, (t) => [index('idx_groups_created').on(t.createdAt, t.id)])`, `GroupRow` |
| `:678` | `clusterId: text('cluster_id'),` on `batches` | `groupId: text('group_id'),` |
| `:1332` | `clusterId: text('cluster_id'),` on `schedules` | `groupId: text('group_id'),` |
| `:754-864` | `commandRuns`, `commandRunMembers`, `savedCommands` and their doc comments and types | deleted |
| `:187`, `:370`, `:438`, `:688-736`, `:772`, `:841`, `:853` | comments naming clusters or the console | reworded (`groups/dispatch.ts`, `groups/status.ts`, "a group") |

The migration is one file. Generate it with `bun run --cwd packages/core db:generate` on a TTY and answer **rename** to every prompt drizzle-kit asks: `clusters` is renamed to `groups` (not created); `devices.cluster_id` is renamed to `group_id` (not added); the same for `batches.cluster_id` and `schedules.cluster_id`. Let it drop the three console tables and the two old indexes itself. The generated file must contain these statements, in an order drizzle-kit chooses:

```sql
ALTER TABLE `clusters` RENAME TO `groups`;--> statement-breakpoint
DROP INDEX `idx_clusters_created`;--> statement-breakpoint
CREATE INDEX `idx_groups_created` ON `groups` (`created_at`,`id`);--> statement-breakpoint
ALTER TABLE `devices` RENAME COLUMN `cluster_id` TO `group_id`;--> statement-breakpoint
DROP INDEX `idx_devices_cluster`;--> statement-breakpoint
CREATE INDEX `idx_devices_group` ON `devices` (`group_id`);--> statement-breakpoint
ALTER TABLE `batches` RENAME COLUMN `cluster_id` TO `group_id`;--> statement-breakpoint
ALTER TABLE `schedules` RENAME COLUMN `cluster_id` TO `group_id`;--> statement-breakpoint
DROP TABLE `command_run_members`;--> statement-breakpoint
DROP TABLE `command_runs`;--> statement-breakpoint
DROP TABLE `saved_commands`;
```

If the generator produces a `DROP TABLE clusters` plus `CREATE TABLE groups` (it was answered "create" by mistake, or ran without a TTY), delete the generated file and its journal entry and generate again on a TTY. If no TTY is available at all, follow the repo's own precedent for exactly this situation, `packages/core/drizzle/0023_rename_agents_to_nodes.sql` (plans 61 and 62, "drizzle-kit's rename prompt needs a TTY", `migration-watermark.test.ts:1-16`): write the SQL above by hand as `packages/core/drizzle/<next index>_groups_rename.sql`, append a journal entry to `meta/_journal.json` with `"when": <Date.now() at authoring>` (never a round synthetic number; the same file explains the poisoned-watermark incident), and copy the previous `meta/<index>_snapshot.json` to the new index with the table and column names edited so the next `db:generate` diffs against the renamed shape. Say which path was taken in §11. The index is the next free one after whatever plans 205 and 206 landed (both name `0065`); this document calls it `NNNN`.

`packages/core/src/db/migrations/cluster-materialise.ts` is renamed `materialise-0014.ts` (`git mv`), its exports `materialiseClusters` and `DROP_CLUSTER_SELECTOR_COLUMNS_TAG` become `materialiseMembership` and `DROP_SELECTOR_COLUMNS_TAG`, `ClusterMaterialise*` types become `Materialise0014*`; the raw SQL strings (`FROM clusters`, `clusters.tags`, `device_ids`) and `MARKER_ID = 'cluster-materialise-22.0'` are **not** changed (they address the table as it was named before `0014` and a marker row already persisted on every farm). Its test is renamed alongside. `daemon.ts:131`, `:464-465` and `db/index.ts:142-149` follow the new names; the `db/index.ts` comment says "the table then named `clusters`" is not written, it says "the pre-0014 selector columns".

`packages/core/src/db/groups-migration.test.ts` (new, modelled on `db/migrations/rename-agents-to-nodes.test.ts:1-20`): `runMigrationsUpTo('<NNNN>_groups_rename')`, insert by raw SQL one `clusters` row, one `devices` row with `cluster_id` set, one `batches` row and one `schedules` row with `cluster_id` set, one `command_runs` row; `runMigrations()`; assert through Drizzle that `groups` has the row, the device's `groupId` reads it, the batch's and the schedule's `groupId` read it, `PRAGMA table_info(devices)` has `group_id` and no `cluster_id`, `sqlite_master` has `idx_groups_created` and `idx_devices_group` and none of `command_runs`, `command_run_members`, `saved_commands`, `idx_clusters_created`, `idx_devices_cluster`.

### 4.7 The console: what goes and what replaces it

| Removed | Replacement |
|---|---|
| `packages/core/src/command-console/` (runner 671 lines, store 502, saved 183, two tests) | the `adb` verb: one operation, one `command` activity per device, results on the operation |
| `api/command-runs.ts`, `api/saved-commands.ts`, `api/adb-stats-command-console-wiring.test.ts`, their tests, the mounts `http.ts:425`, `:430`, the `HttpDeps` fields `:159`, `:167` | `POST /api/actions/adb`, `GET /api/operations/:id` |
| `commandRuns`, `commandRunMembers`, `savedCommands` tables | dropped by the §4.6 migration; no history table replaces them (MVP 15 §0.1 item 4: removed entirely) |
| `messages/command.ts` (seven messages), `command/target.ts`, `command/saved.ts`, `api/command-runs.ts` in the protocol | `actions.ts` |
| `ws-handlers.ts:1332-1339` cases, `state.commandSubs`, `commandTargets(runId)`, `:2651-2653` `broadcastCommand`, `:33` and `:347-356` `commandRunStore`, `:1426`, `:1513-1528`, `:1580-1591` | nothing; `shell.exec` runs and broadcasts exactly as before minus the history row |
| `daemon.ts:161-164` imports, `:405`, `:914-921`, `:1570-1627`, `:2973-3000`, `:3078`, `:3611-3616`, `:3679`, `:4577-4578` | the actions wiring of §4.8 |
| `settings.ts` `shell.fanout*`, `commandRunsPerUser`, `savedCommandLimit`; `retention.commandRunDays`; `farm-settings.ts:40` `fanoutEnabled: false` | constants (`ACTION_FANOUT_CONCURRENCY`); the operation registry's TTL |
| `maintenance/retention.ts:108-133` `sweepCommandRuns`, `commandRunsDeleted` (`:18`, `:209`, `:213`, `:216`, `:241`) | nothing to sweep |
| `api/adb-stats.ts:79-85` `ZERO_COMMAND_CONSOLE`, `:131-137` dep, the block in the response; `protocol/api/adb.ts:209-232` | nothing |
| Studio `app/console/`, `components/command/`, `AppShell.tsx:87`, `lib/operations.ts` command-runs source, `TerminalPane.tsx:125-145` history effect, `AdbCommandDialog` internals | `AdbCommandDialog` on `runAction('adb')` (§4.9) |
| `packages/core/README.md:597-740`, `packages/protocol/README.md:24-40` | a twelve-line "Actions API (MVP 07)" section in `packages/core/README.md` |

`packages/core/src/device/shell-port.ts:46` and `api/plugins.ts:1372` carry comments naming the console; both are reworded.

### 4.8 `daemon.ts` and `http.ts` wiring

- `http.ts`: `HttpDeps` gains `actionRoutes: Hono<AuthEnv>` and `operationRoutes: Hono<AuthEnv>`; loses `clusterRoutes` (`:146`), `topologyRoutes` (`:147`), `commandRunRoutes` (`:159`), `savedCommandRoutes` (`:167`); gains `groupRoutes: Hono<AuthEnv>`. Mounts: `app.route('/api/actions', deps.actionRoutes)` and `app.route('/api/operations', deps.operationRoutes)` where `:416-430` were; `app.route('/api/groups', deps.groupRoutes)` replaces `:416`; `:418`, `:425`, `:430` deleted.
- `daemon.ts`: `const operations = createOperationRegistry({})` beside the activity registry (plan 205 step 205.9), `operations.startSweep()`/`stopSweep()` beside `activities.startSweep()`/`stopSweep()`; `const actionRoutes = createActionRoutes({ ...ActionsDeps })` built after `deviceRoutes` (every accessor it needs is already a forward-ref there: `reconnector`, `sessions`, `cutoverManager`, `battery`, `labelling`, `deviceLifecycle`, `transferService`, `transferBroadcast`, `readinessHoldForTransfer`, `preparationRunner`, `agentProvisioner`, `jobService`, the batch host deps `createBatchRoutes` already receives at `:2931`); `shellPortFor` is `commandShellPortFor` (`daemon.ts:1580-1593`) renamed `actionShellPortFor` and kept; `screenshot` wraps the capability context's `deviceCall`; `routeService: () => guestAgent.routeService` (the object `createGuestAgentRoutes` builds at `:2250`, exposed as a field if it is not already); `groupRoutes: createGroupRoutes({ db, audit, activitiesOf, networks, declaredMedia })`.
- `createDeviceRoutes` loses `transfer`, `jobStore` (only the disconnect guard used it), `cutover`, `lifecycle` (kept only if `GET /:id/history-counts` still needs `historyCounts`; it does, so `lifecycle` stays as `Pick<DeviceLifecycle, 'historyCounts'>`), `labelling` (kept for `GET /:id/label`; narrow to `Pick<LabellingService, 'status'>`), `readiness` (narrow to `Pick<ReadinessManager, 'get'>`), `connection` (kept for `PATCH /:id`'s `restartAt`/`setRotation`; narrow the `Pick` to `'restartAt' | 'get' | 'setRotation'`), `broadcast` (kept only if another route still uses it; `device.removed` moves to the verbs, so delete it if nothing else sends).

### 4.9 Studio: the adapter and the old flows

`packages/studio/src/lib/actions.ts` (new):

```ts
import { ActionResponseSchema, OperationResponseSchema, type ActionParams, type ActionResponse, type ActionResult, type ActionVerb, type Operation, type Target } from '@enkaku/protocol'
import { api } from '@enkaku/ui'
import { toast } from 'sonner'

export class ActionRefusedError extends Error {
  readonly status: ActionResult['status']
  readonly code: string
  readonly deviceId: string
  constructor(result: ActionResult) { ... }
}

export function runAction<V extends ActionVerb>(verb: V, target: Target, params: ActionParams<V>, opts?: { force?: boolean }): Promise<ActionResponse> {
  return api(`/api/actions/${verb}`, ActionResponseSchema, { method: 'POST', json: { target, ...params, force: opts?.force ?? false } })
}

export function fetchOperation(id: string): Promise<Operation> {
  return api(`/api/operations/${encodeURIComponent(id)}`, OperationResponseSchema).then((b) => b.operation)
}

/** Polls every `intervalMs` (default 1000) until `settled`, or throws after `timeoutMs` (default 600000). */
export async function awaitOperation(id: string, opts?: { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal }): Promise<Operation>

/**
 * The old single-device flows (§3.2 item 9): send, await when accepted, show a `warned`
 * sentence once as `toast.warning` and re-send with `force: true`, throw `ActionRefusedError`
 * on `forbidden`, `skipped` or `failed`. Returns the device's final result (`done`).
 */
export async function runOnDevice<V extends ActionVerb>(verb: V, deviceId: string, params: ActionParams<V>, opts?: { force?: boolean }): Promise<ActionResult>

/** `results` grouped for the old bulk dialogs' reports: `{ done, failed, skipped, forbidden, warned, accepted }`. */
export function groupResults(results: ActionResult[]): Record<ActionResult['status'], ActionResult[]>
```

`packages/studio/src/components/actions/ActionResults.tsx` (new, minimal): props `{ results: ActionResult[]; nameOf: (deviceId: string) => string }`; one row per result with the device name, a `StatusBadge`-style chip for the status (`bg-surface`, `text-fg-muted`; Tailwind v4 classes only) and the `message` when present. No design investment: plan 216 replaces it with the handoff's chips.

The old flows, one line per call site (the `runOnDevice` return's `detail` is parsed with the verb's own schema where the caller reads it):

| File and line | Was | Becomes |
|---|---|---|
| `components/FilesPanel.tsx:139` | `api(\`/api/devices/${deviceId}/install\`, InstallResponseSchema, { json: { artifactId, clientId } })` | `const r = await runOnDevice('install', deviceId, { artifactId: uploaded.id })`; `setInstallResult(InstallResultSchema.parse(r.detail))`; the `!clientId` guard at `:131` is removed (`clientId` no longer travels) |
| `FilesPanel.tsx:161`, `:179` | `/push`, `/pull` | `runOnDevice('push', deviceId, { artifactId, remotePath })`, `runOnDevice('pull', deviceId, { remotePath })`; `PushResultSchema.parse(r.detail).mediaScan`, `z.object({ artifactId: z.string(), bytes: z.number() }).parse(r.detail).artifactId` |
| `components/ForgetDeviceDialog.tsx:92` | `DELETE /api/devices/:id?deleteHistory=` | `await runOnDevice('forget', device.id, { deleteHistory })`; `catch (err)`: `err instanceof ActionRefusedError` sets `refusal` from `err.code`/`err.message` (replacing `isApiError`) |
| `ForgetDeviceDialog.tsx:111` | `POST /:id/block` | `runOnDevice('block', device.id, {})` |
| `components/BulkForgetDialog.tsx:93` | the per-device `DELETE` loop | one `runAction('forget', { deviceIds }, { deleteHistory: false })`; the report from `groupResults` |
| `components/DisconnectDeviceDialog.tsx:74` | `POST /:id/connection/disconnect { force }` | `const r = await runOnDevice('disconnect', device.id, {}, { force })`; `DisconnectOutcomeSchema.parse(r.detail)` |
| `components/device/CutoverDialog.tsx:117` | `POST /:id/connection/cutover` | `runOnDevice('cutover', device.id, { op: 'start', medium, port, address })`; `CutoverStateSchema.parse(r.detail)` |
| `CutoverDialog.tsx:133` | `DELETE /:id/connection/cutover` | `runOnDevice('cutover', device.id, { op: 'cancel' })` |
| `components/device/BulkCutoverDialog.tsx:179` | the per-device `POST` | `runOnDevice('cutover', d.id, { op: 'start', ...body })` inside the existing loop |
| `components/device/PhysicalLabellingPanel.tsx:88`, `:104` | `/label/apply`, `/label/clear` | `runOnDevice('set-label', device.id, {})`, `runOnDevice('clear-label', device.id, { restoreOriginal })`; `DeviceLabelStateSchema.parse(r.detail)` |
| `lib/labelling.ts:85` `applyDeviceLabel` | `/label/apply` | `runOnDevice('set-label', deviceId, {})` and parse |
| `lib/labelling.ts:95-` `summariseLabelApply(results: DeviceLabelsApplyResult[], ...)` | reads `state`/`error` | takes `ActionResult[]`: `done` with `detail.state` is ok/off exactly as before; `failed`/`forbidden`/`skipped` are failures named by `message` |
| `app/page.tsx:372`, `:429`; `device-popup/ActionsList.tsx:513` | `POST /api/devices/labels/apply { deviceIds }` | `(await runAction('set-label', { deviceIds }, {})).results` into `summariseLabelApply` |
| `app/page.tsx:910`; `app/device/page.tsx:493` | `POST /:id/unquarantine` | `runOnDevice('unquarantine', id, {})` |
| `app/page.tsx:920`; `ActionsList.tsx:528`; `app/device/page.tsx:503` | `POST /:id/connection/reconnect {}` | `runOnDevice('reconnect', id, {})`; `ReconnectOutcomeSchema.parse(r.detail)` |
| `components/TagEditor.tsx:35`; `components/AdmitDeviceDialog.tsx:124` | `PUT /:id/tags` | `runOnDevice('set-tags', deviceId, { tags })`; `z.object({ tags: z.array(z.string()) }).parse(r.detail)` |
| `device-popup/PreparationPanel.tsx:255`; `guest-agent/AgentAlertDetail.tsx:256`; `guest-agent/VpnAgentPrecondition.tsx:241` | `POST /:id/preparation/:component/retry` | `runOnDevice('retry-prepare', deviceId, { component })`; `PreparationComponentStatusSchema.parse(r.detail)` |
| `PreparationPanel.tsx:262` | `POST /:id/preparation` | `runOnDevice('prepare', deviceId, {})`; `DevicePreparationSchema.parse(r.detail)` |
| `lib/readiness.ts:22` `setDeviceReadiness(deviceId, desired)` | `PUT /:id/readiness` | `desired === 'awake'` runs `wake`, `'asleep'` runs `sleep`, `'hot'` throws `Error('hot is not an action')` (plan 206 §9 Q3 owns `hot`); `DeviceReadinessSchema.parse(r.detail)`; the `clientId` clause and its comment are deleted |
| `lib/api.ts:518-533` `postNetworkAction` | `POST /:id/network/<action>` | `runOnDevice('set-network', deviceId, { op: action })`; `DeviceNetworkStatusResponseSchema.parse(r.detail)`; the `enable`/`disable`/`retry` wrappers keep their names |
| `guest-agent/HttpProxyFields.tsx:194`; `guest-agent/VpnRouteFields.tsx:266` | `PUT /:id/network { ...route }` | `runOnDevice('set-network', deviceId, { op: 'set', route })` |
| `guest-agent/NetworkRouteForm.tsx:423` | `DELETE /:id/network` | `runOnDevice('set-network', deviceId, { op: 'clear' })` |
| `network/BulkProxyDialog.tsx:227` | `POST /api/devices/network/apply` | `runAction('set-network', target, { op: 'set', route })` then `awaitOperation`; the report reads `groupResults` (`done` is applied) |
| `components/BulkPrepDialog.tsx:209` | `POST /api/devices/prep/apply { deviceIds, prep }` | `runAction('settings', target, { settings: { prep: patch } })`; the report reads `detail.changed` and `detail.rotation` |
| `components/InstallBatchDialog.tsx:187` | `POST /api/batches` with `internal:install` | `runAction('install', target, { artifactId, reinstall, grantPermissions, allowDowngrade })` then `awaitOperation`; the batch link becomes the `ActionResults` list |
| `components/BulkTransferDialog.tsx:169` | `fetch(/api/batches)` with `internal:push`/`pull` | `runAction('push' \| 'pull', target, params)` then `awaitOperation` |
| `components/RunScriptDialog.tsx:830-866` | `useBatch ? POST /api/batches : POST /api/jobs` | one `runAction('run-script', targetBody, { scriptId, params, concurrency, order, runtimeOverride, pacing })`; `targetBody` is `{ deviceIds: [deviceId] }`, `{ groupId }` or `{ deviceIds }`; the success handler reads `results[0]?.batchId` and `results[0]?.jobId` (a batch of one navigates to the job, as before); `useBatch` and the comment block `:826-829` are deleted |
| `device-popup/AdbCommandDialog.tsx` | `POST /api/command-runs` and the `command.*` stream | rewritten: `runAction('adb', target, { cmd })`, `awaitOperation` with a 1 s interval, `ActionResults` for the outcome with `detail.stdout`/`stderr` under each row, `isHighConsequence(cmd)` keeps its inline warning line; `ConfirmFanout`, `RunReport`, staging, `savedCommandId`, `acknowledge`, `rerun`, `cancel`, `continue` are deleted; `TerminalPane` stays for the single-device terminal tab |
| `terminal/TerminalPane.tsx:125-145` | `GET /api/command-runs?mine=1` history seed | deleted with its import; ArrowUp history is what was typed this session |
| `lib/operations.ts:6`, `:10`, `:257`, `:260`, `:265-275`, `:388`, `:517`, `:617-624` | the command-runs source | deleted (three sources remain until plan 213 deletes the file) |
| `components/ClusterMembersDialog.tsx:107`, `:135`, `:78` | `POST /api/clusters/:id/devices`, `DELETE .../:deviceId`, `GET .../devices` | `runAction('set-group', { deviceIds }, { groupId })`, `runAction('set-group', { deviceIds: [id] }, { groupId: null })`, `GET /api/groups/:id/devices` |

Studio identifiers and copy for the rename are in §5 step 207.9.

### 4.10 The capability (`packages/core/src/capability/actions.ts`, new)

```ts
export const actionsRun = defineCapability({
  id: 'actions.run',
  input: ActionCapabilityInputSchema,
  output: ActionResponseSchema,
  /** The static gate; the verb's own gate (§4.2) runs inside against `ctx.actor`. */
  permission: 'device.view',
  // no `activity`: the capability touches no device itself; each device is evaluated inside `runAction` (plan 205 §4.4 `activity` absent means device-less)
  deadline: 60_000,
  effect: 'write',
  description: 'Run one action (MVP 07 verbs) on a target: { deviceIds } | { groupId } | { tags }. Answers per device; a warned device is not started until force is true.',
  handler: (ctx, input) => {
    if (!ctx.actor) throw new EnkakuError('auth.forbidden', 'actions.run needs an actor')
    const request = ActionRequestSchema.parse({ verb: input.verb, target: input.target, force: input.force, ...input.params })
    return ctx.actions.run(request, ctx.actor)
  },
})
export const ACTIONS_CAPABILITIES = [actionsRun]
```

`CapabilityContext` (`capability/context.ts`) gains `actions: { run(request: ActionRequest, actor: ActionActor): Promise<ActionResponse> }`, wired from the same `ActionsDeps` object the router gets (`daemon.ts` builds one and passes it to both). `capability/index.ts:19-35` adds `{ file: 'capability/actions.ts', caps: ACTIONS_CAPABILITIES }`. Plugins reach it through the broker under their principal (`plugins/farm-broker.ts:340`), agents through the tool registry, both with no further change. `<plugin>/<verb>` registration is §9 Q1.

### 4.11 File structure

```
packages/protocol/src/
  actions.ts                       NEW    §4.1
  actions.test.ts                  NEW
  api/groups.ts                    RENAMED from api/clusters.ts
  messages/batch.ts                CHANGED
  api/devices.ts                   CHANGED  (per-verb envelopes deleted)
  api/transfer.ts                  DELETED
  api/jobs.ts, api/adb.ts, device.ts, messages/schedule.ts, api/plugins.ts, plugin-surface.ts, schema/vocabulary.ts, settings.ts, index.ts, api/index.ts   CHANGED
  messages/command.ts, command/target.ts, command/saved.ts, api/command-runs.ts   DELETED
packages/core/src/
  api/actions.ts                   NEW    §4.3 (Ships)
  api/actions.test.ts              NEW
  actions/run.ts                   NEW    §4.3
  actions/verbs.ts                 NEW    §4.2
  actions/operations.ts            NEW    §4.4
  actions/operations.test.ts       NEW
  actions/impl/*.ts                NEW    one file per verb family: transfer.ts, shell.ts, connection.ts, lifecycle.ts, labelling.ts, membership.ts, preparation.ts, settings.ts, screenshot.ts, run-script.ts (the moved route bodies)
  api/groups.ts                    RENAMED from api/clusters.ts, routes cut to five
  api/groups.test.ts               RENAMED from api/clusters.test.ts
  groups/                          RENAMED from clusters/ (dispatch, pacer, status, resolve, membership and tests)
  db/migrations/materialise-0014.ts   RENAMED from cluster-materialise.ts (+ test)
  db/groups-migration.test.ts      NEW
  drizzle/NNNN_groups_rename.sql   NEW (generated)
  api/devices.ts, api/device-preparation.ts, api/jobs.ts, api/batches.ts, api/schedules.ts, network/route-service.ts, api/guest-agent.ts, server/http.ts, server/ws-handlers.ts, daemon.ts, db/schema.ts, db/index.ts, auth/audit.ts, registry/device-registry.ts, registry/admission.ts, plugins/action-executor.ts, api/plugins.ts, schedules/runner.ts, maintenance/retention.ts, api/adb-stats.ts, settings/farm-settings.ts, capability/context.ts, capability/index.ts   CHANGED
  capability/actions.ts, capability/actions.test.ts   NEW
  api/transfer.ts, api/topology.ts, api/command-runs.ts, api/saved-commands.ts, command-console/   DELETED (+ tests)
packages/studio/src/
  lib/actions.ts, lib/actions.test.ts, components/actions/ActionResults.tsx   NEW
  app/groups/page.tsx              RENAMED from app/clusters/page.tsx
  components/GroupEditorDialog.tsx, GroupMembersDialog.tsx   RENAMED
  app/console/, app/topology/, components/command/   DELETED
  every file of §4.9 and §5 step 207.9   CHANGED
packages/ui/src/components/device-picker.tsx   CHANGED
plugins/mikrotik-routing, plugins/tiktok-automation-pack   comment reword + patch bump
```

## 5. Implementation steps

Every step: read the file before editing, match on the quoted content, run only the test file named in that step. Steps 207.1 and 207.2 can run in any order; 207.3 onward depend on both. Plan 205 must be `implemented` before 207.3.

### 207.1 Protocol: actions, groups rename, console shapes deleted

- Files created: `packages/protocol/src/actions.ts` (§4.1), `packages/protocol/src/actions.test.ts`.
- Files changed: every row of the §4.1 table.
- Files deleted: `packages/protocol/src/messages/command.ts`, `command/target.ts`, `command/saved.ts`, `api/command-runs.ts`, `api/transfer.ts`, and their tests if any.
- Test file: `packages/protocol/src/actions.test.ts` (every one of the 26 verbs parses a minimal valid body; `run-script` with both `scriptId` and `scriptRef` fails; `cutover` without `medium` fails and `op: 'cancel'` without `medium` passes; `set-network` `op: 'set'` without `route` fails; `TargetSchema` refuses `{}` and an empty `deviceIds`; `Object.keys(DeviceSettingsPatchSchema.shape)` equals `Object.keys(DeviceSettingsSchema.shape)`; `ActionResultStatusSchema` accepts exactly the six values), plus `packages/protocol/src/settings.test.ts` (the `shell` default has seven keys and no `fanout*`; `retention` default has no `commandRunDays`), `packages/protocol/src/api/devices.test.ts` (delete the `DeviceNetworkApply*`/`DevicePrepApply*`/`DeviceLabelsApply*` describes), `packages/protocol/src/plugin-surface.test.ts` (`groupId`).
- Verifiable result: `bun test packages/protocol/src/actions.test.ts`, `bun test packages/protocol/src/settings.test.ts`, `bun test packages/protocol/src/api/devices.test.ts`, `bun test packages/protocol/src/plugin-surface.test.ts` pass; `rg -n -i "cluster|CommandRun|CommandTarget|SavedCommand|commandConsole|fanout" packages/protocol/src` → empty.
- Do not: keep `ClusterInfoSchema` as an alias of `GroupInfoSchema`; keep `CommandTargetSchema` "because the shape is the same" (it says `clusterId`); add `POST /api/actions` with a `verb` field to the schema.

### 207.2 Schema, directory rename, migration

- Files changed: `packages/core/src/db/schema.ts` (§4.6 table), `packages/core/src/db/index.ts:142-149`, `packages/core/src/daemon.ts:131`, `:464-465`, `packages/core/drizzle/meta/_journal.json` (generated).
- Files renamed (`git mv`): `packages/core/src/clusters/` → `packages/core/src/groups/` (five modules and their tests; inside: `resolveCluster` → `resolveGroup`, `via: 'cluster'` → `'group'`, `ClusterMove` → `GroupMove`, `clusterMembers` → `groupMembers`, `deleteClusterAndUnassign` → `deleteGroupAndUnassign`, `CreateBatchInput.target: { groupId } | { deviceIds }`, every `clusters`/`clusterId` import and read), `packages/core/src/db/migrations/cluster-materialise.ts` → `materialise-0014.ts` (+ test), `.test.ts` files alongside.
- Files created: `packages/core/drizzle/NNNN_groups_rename.sql` (generated, §4.6), `packages/core/src/db/groups-migration.test.ts`, `packages/core/src/groups/resolve.ts`'s `resolveActionTarget` (§4.5) and its cases in `groups/resolve.test.ts`.
- Test file: `packages/core/src/db/groups-migration.test.ts` (§4.6), `packages/core/src/db/migration-watermark.test.ts`, `packages/core/src/groups/resolve.test.ts` (existing cases renamed; new: `resolveActionTarget` for the three shapes, a duplicate id appears once, an unknown id is `no longer exists`, an offline member is `skipped: offline`, an unknown `groupId` throws `group_not_found`), `packages/core/src/groups/membership.test.ts`, `packages/core/src/db/migrations/materialise-0014.test.ts` (renamed; asserts the marker id string is still `'cluster-materialise-22.0'`).
- Verifiable result: the five test files pass one at a time; `rg -n "from '\.\./clusters|from '\./clusters|clusters/" packages/core/src` → empty; `sqlite3 <a migrated .dev-data db> ".tables"` (or the test) shows `groups` and no `clusters`.
- Do not: edit any existing file under `packages/core/drizzle/`; change the raw SQL or `MARKER_ID` inside `materialise-0014.ts`; answer "create" to the rename prompt.

### 207.3 Operations registry and the verb table

- Files created: `packages/core/src/actions/operations.ts` (§4.4), `packages/core/src/actions/operations.test.ts`, `packages/core/src/actions/verbs.ts` (§4.2).
- Test file: `packages/core/src/actions/operations.test.ts` with an injected `now`: `create` returns `settled: false` while any result is `accepted` and `true` otherwise; `settle` replaces exactly one result and refuses to replace a non-`accepted` one; `sweep` keeps a settled operation for 3 599 s and drops it at 3 600 s; the 1 001st operation evicts the oldest; `get` of an evicted id is null.
- Verifiable result: `bun test packages/core/src/actions/operations.test.ts` passes.
- Do not: persist operations; use `setTimeout` per operation (one sweep interval).

### 207.4 The per-verb implementations (moved route bodies)

- Files created: `packages/core/src/actions/impl/transfer.ts` (install/push/pull, from `api/transfer.ts:91-218`), `impl/shell.ts` (adb, clear-cache; the event write copied from `ws-handlers.ts:1403-1425`), `impl/connection.ts` (reconnect, disconnect, cutover, from `devices.ts:1407-1622`), `impl/lifecycle.ts` (forget, block, unquarantine, from `devices.ts:1626-1642`, `:1716-1757`), `impl/labelling.ts` (set-label, clear-label, from `devices.ts:1328-1369`), `impl/membership.ts` (set-group, set-tags, from `devices.ts:1660-1700`), `impl/preparation.ts` (prepare, retry-prepare, from `device-preparation.ts:93-129`), `impl/settings.ts` (settings, from `devices.ts:723-836` `applyPrepToDevice` generalised block by block, and `PATCH /:id`'s `video` restart at `:1236-1240`), `impl/screenshot.ts`, `impl/run-script.ts` (from `batches.ts:766-777` and `jobs.ts:207-238`), `impl/network.ts` (set-network, calling `routeService.actions`), `impl/readiness.ts` (wake, sleep, from `devices.ts:1117-1128`).
- Files changed: `packages/core/src/network/route-service.ts`: extract the bodies of `:3269-3295` (enable), `:3296-3325` (disable), `:3327-3345` (retry) into `async function enableRoute(deviceId, actor)`, `disableRoute`, `retryRoute` beside `setRouteFromRequest` (`:2857`) and `clearRouteFromRequest` (`:2974`); expose `actions: { set: setRouteFromRequest, clear: clearRouteFromRequest, enable: enableRoute, disable: disableRoute, retry: retryRoute }` on the returned `RouteService` (interface at `:502`); delete the routes at `:3228-3257` (`/network/apply`, and `applyRouteInBulk` above it, `:3150-3205`, with `BULK_SKIP_FOR_CODE` and `BulkApplyResult`), `:3264-3350` (the five per-device routes); keep `GET /:id/network` (`:3259`), the credential routes (`:715-740`) and `/:id/network/credential/reveal` (`:3414`, a read of a secret behind POST for the reason its own comment at `:3363` gives).
- Test file: `packages/core/src/network/route-service.test.ts` (the bulk-apply cases become `actions.set` cases: one device applied, one skipped `E_DEVICE_CONFLICT` when a job is live, credentials refused before any device), `packages/core/src/device/lifecycle.test.ts` unchanged.
- Verifiable result: `bun test packages/core/src/network/route-service.test.ts` passes; `bun run typecheck` for `packages/core` is clean except for the routers 207.5 removes.
- Do not: leave a per-device HTTP route "for the plugin"; the plugin path is `device.network.set` (`capability/device-network.ts:233`), which already calls the function.

### 207.5 The router, the capability, and the routes it replaces

- Files created: `packages/core/src/actions/run.ts` (§4.3), `packages/core/src/api/actions.ts` (§4.3), `packages/core/src/api/actions.test.ts`, `packages/core/src/capability/actions.ts` (§4.10), `packages/core/src/capability/actions.test.ts`.
- Files changed: `packages/core/src/api/devices.ts` (delete `:624-641`, `:690-836`, `:1117-1128`, `:1328-1369`, `:1407-1622`, `:1626-1642`, `:1660-1700`, `:1716-1757`, the `app.route('/', createTransferRoutes(deps.transfer))` at `:864`, the body schemas `:103-113` and `:173-177` that only those routes read, the deps of §4.8, the `?clusterId` query at `:953-980` → `?groupId`, `AdmitDeviceBodySchema.groupId`, the `ERROR_STATUS` rows only those routes produced); `packages/core/src/api/device-preparation.ts` (delete `:93-129`, keep `GET /:id/preparation`); `packages/core/src/api/jobs.ts` (delete `:48` `EnqueueBody` and `:207-238`); `packages/core/src/api/batches.ts` (delete `:50-74` `CreateBatchBody` and `:766-777`; keep everything else); `packages/core/src/api/groups.ts` (renamed from `clusters.ts`: `createGroupRoutes`, five routes, `group_not_found`, `rowToGroupInfo`, `GroupResponseSchema`; delete `:175-203` and `:252-256`; the `heldByOf`/`assistedByOf` deps are already `activitiesOf` after plan 205); `packages/core/src/api/schedules.ts:49-53`, `:99`, `:297`, `:400-403`, `:456`, `:481`, `:539`, `:550` (`groupId`, `group_not_found`, `assertGroupExists`); `packages/core/src/schedules/runner.ts:18-21`, `:149-151`, `:338-354`; `packages/core/src/server/http.ts` (§4.8); `packages/core/src/daemon.ts` (§4.8); `packages/core/src/capability/context.ts` (`actions`), `packages/core/src/capability/index.ts:19-35`; `packages/core/src/auth/audit.ts:103-107` (`group.*`); `packages/core/src/registry/device-registry.ts:18`, `:139-147` (`loadGroupNames`, `groupRefFor`), `:300`, `:362`, `:422`, `:434`; `packages/core/src/registry/admission.ts:94`, `:133`; `packages/core/src/plugins/action-executor.ts:6`, `:137`; `packages/core/src/api/plugins.ts:119`, `:670`, `:691`, `:1372`; `packages/node/src/index.ts:195-202`, `:214`.
- Files deleted: `packages/core/src/api/transfer.ts`, `transfer.test.ts`, `packages/core/src/api/topology.ts`, `topology.test.ts`, `packages/core/src/api/devices-prep-apply.test.ts`, `packages/core/src/api/devices.network-apply.test.ts`.
- Test file: `packages/core/src/api/actions.test.ts`, built with a Hono app, an in-memory db, the real `evaluate` and a real activity registry, and a fake implementation per verb recorded through `ActionsDeps`: `wake: answers 202 with one result per targeted device`; `unknown verb answers 404 E_UNKNOWN_VERB`; `a malformed body answers 400 with the issue path`; `run-workflow answers 501 naming plan 211`; `a caller without job.run answers 403 for run-script`; `an operator on a device owned by someone else gets forbidden auth.forbidden, other devices proceed`; `an offline device is skipped for install and dispatched for forget`; `policy: warn then force` (a live `job:j1`, `adb` answers `warned` with the sentence, the same body with `force: true` answers `accepted` and the fake exec was called once); `policy: forbid ignores force` (`install` over a live job); `async: accepted then done on GET /api/operations/:id` (a fake install resolving on demand); `async: a rejected implementation settles failed with its code`; `a group target resolves members and an unknown group answers 404`; `a tags target ANDs the tags`; `duplicate ids dispatch once`; `set-group calls assignDevices once with every accepted id`; `run-script creates one batch for three devices and a batch of one for one device`; `set-network op set validates the route once and answers 400 on a credential`; the `describe('verbs')` block, one test per verb asserting the fake was called with the device id and the params. `packages/core/src/capability/actions.test.ts`: the capability flattens `params`, refuses without an actor, and returns the response.
- Also: `packages/core/src/api/devices.test.ts` (delete every test of a deleted route; keep GET/PATCH/discovery/numbers/monitor-save tests), `packages/core/src/api/device-preparation.test.ts` (keep the GET tests), `packages/core/src/api/jobs.test.ts` and `batches.test.ts` (delete the `POST /` tests), `packages/core/src/api/groups.test.ts` (renamed; delete the assign/unassign/preview tests), `packages/core/src/api/schedules.test.ts`, `packages/core/src/schedules/runner.test.ts`, `packages/core/src/registry/device-registry.test.ts`, `packages/core/src/plugins/action-executor.test.ts`, `packages/core/src/plugins/binding.test.ts`, `packages/core/src/api/plugins-data.test.ts`, `packages/core/src/daemon-wiring.test.ts`, `packages/core/src/tools/routes.test.ts`, `packages/core/src/api/guest-agent.test.ts` (delete the per-device network route tests), `packages/core/src/network/credential-reveal.test.ts` (unchanged route), `packages/core/src/capability/device-network.test.ts`, `packages/core/src/jobs/scheduled-batch-version-gate.test.ts`, `packages/core/src/device/preparation/ui-server-component.test.ts`, `packages/core/src/device/ui-server-test-package.test.ts` (rename `clusterId` fixtures), run one at a time.
- Verifiable result: G2, G3, G4, G7, G8, G12, G14; `bun run typecheck` clean for `packages/core` and `packages/node`.
- Do not: keep `POST /api/jobs` "for scripts" (scripts enqueue through `JobService.enqueue` and the `job.run` capability, neither of which is HTTP); keep `/api/clusters` as an alias; add a generic `POST /api/actions`.

### 207.6 The console: core

- Files deleted: `packages/core/src/command-console/` (all five files), `packages/core/src/api/command-runs.ts`, `command-runs.test.ts`, `saved-commands.ts`, `saved-commands.test.ts`, `saved-commands-mount.test.ts`, `adb-stats-command-console-wiring.test.ts`, `packages/core/src/server/ws-handlers-command.test.ts`.
- Files changed: `packages/core/src/server/ws-handlers.ts` (§4.7 row: `:33`, `:347-356`, `:1332-1339`, `:1426`, `:1513-1528`, `:1580-1591`, `commandSubs`, `commandTargets`, `:2651-2653`), `packages/core/src/daemon.ts` (§4.7 row), `packages/core/src/api/adb-stats.ts:79-85`, `:131-137`, the `commandConsole` field in the response object, `packages/core/src/api/adb-stats.test.ts`, `packages/core/src/maintenance/retention.ts` (§4.7 row), `packages/core/src/maintenance/retention.test.ts` (delete the command-run sweep cases), `packages/core/src/settings/farm-settings.ts:40` (`shell: { ...cached.shell, mode: 'off' }`), `packages/core/src/settings/farm-settings.test.ts` if it asserts `fanoutEnabled`, `packages/core/src/device/shell-port.ts:46`, `packages/core/src/server/ws-handlers-shell.test.ts` (delete the history-row assertions), `packages/core/src/backup/index.ts` (if it lists the three tables; grep `command_runs` there), `packages/core/README.md:597-740` (replaced by the "Actions API (MVP 07)" section), `packages/protocol/README.md:24-40` (deleted), `docs/spec-divergences.md` (append `DIV-078`: area §10 and §19; spec says per-device routes, bulk twins, a console and clusters; code does `POST /api/actions/<verb>` with targets, groups, no console; severity high; recommendation "plan 202 rewrites from MVP 07 and 15"; decision "superseded by plan 207, pending plan 202"; if `docs/spec.md` already contains a heading named "Actions" when this step runs, edit that section instead and say which in §11; `DIV-078` is the next number after plan 205's `DIV-077`, take the next free one if it is taken).
- Test file: `packages/core/src/server/ws-handlers-shell.test.ts`, `packages/core/src/api/adb-stats.test.ts`, `packages/core/src/maintenance/retention.test.ts`.
- Verifiable result: the three files pass one at a time; `GREP_207_CONSOLE` (§10) restricted to `packages/core packages/protocol` prints nothing.
- Do not: keep `commandRunStore` optional "in case a host still passes it"; keep the `fanoutEnabled` override with a comment.

### 207.7 Plugins

- Files changed: `plugins/tiktok-automation-pack/src/queue.ts:106` (reword `clusters/dispatch.ts` to `groups/dispatch.ts`), `plugins/mikrotik-routing/src/index.ts:355`, `:358` (`group grouping`, `no status, tags or group`); both plugins patch-bumped at their three sites (`package.json`, `src/index.ts` `version:`, `src/index.test.ts`), with a changelog line beside the earlier bumps ("groups rename, MVP 15 §0.1"); if plan 205 already bumped them on this branch, bump once more above that.
- Verifiable result: `bun run build:packs` exits 0; `bun test plugins/tiktok-automation-pack/src/index.test.ts` passes (from `plugins/tiktok-automation-pack` as `bun test src/index.test.ts` if bunfig's root refuses the path); `rg -n "source: 'clusters'|\\$device\.clusterId" plugins examples packages/sdk` → empty (none exist today; the grep proves nothing regressed).
- Do not: skip the bumps (CLAUDE.md: an unchanged version is never seeded).

### 207.8 Studio: the adapter and the old flows

- Files created: `packages/studio/src/lib/actions.ts` (§4.9), `packages/studio/src/lib/actions.test.ts`, `packages/studio/src/components/actions/ActionResults.tsx`, `packages/studio/src/components/actions/ActionResults.test.tsx`.
- Files changed: every row of the §4.9 table; `packages/studio/src/components/device-popup/AdbCommandDialog.tsx` (rewritten as the row says; its test rewritten to mock `/api/actions/adb` and `/api/operations/:id`); `packages/studio/src/components/terminal/TerminalPane.tsx:5`, `:125-145`.
- Files deleted: `packages/studio/src/app/console/` (page and test), `packages/studio/src/app/topology/` (page and test; plan 201 kept the stub for plan 213, and this plan deletes the route the stub redirected to, so the stub goes now), `packages/studio/src/components/command/` (all sixteen files).
- Test file: none — §12: Studio and `@enkaku/ui` have zero tests. Verify with `bun run typecheck` and the owner smoke.
- Verifiable result: G13; `rg -n "/api/command-runs|/api/saved-commands|/api/topology|labels/apply|prep/apply|network/apply|/api/batches'" packages/studio/src` → only `lib/operations.ts`'s `/api/batches?limit=50` read.
- Do not: run the Studio suite; add a "force" checkbox to the old dialogs (the toast-and-resend is the interim); keep `components/command/RunReport.tsx` "for the adb dialog" (the dialog uses `ActionResults`).

### 207.9 Studio: the rename

- Files renamed (`git mv`): `app/clusters/` → `app/groups/` (page and test; `GroupsPage`, `GroupsPageResponseSchema`, title "Groups", description unchanged in meaning, button "New group", toast "... deleted; its devices keep running without a group"), `components/ClusterEditorDialog.tsx` → `GroupEditorDialog.tsx` (+ test; `GroupRow`, `group` prop, "Group created"/"Group saved"/"Could not save the group"), `components/ClusterMembersDialog.tsx` → `GroupMembersDialog.tsx` (+ test).
- Files changed, exact edits: `app/page.tsx:16` (`GroupInfo`), `:86-87` (`GroupFilter`), `:131` `type GroupBy = 'none' | 'group' | 'status' | 'tag'`, `:146`, `:158`, `:171`, `:177` and `:700` comments (`view=wall&group=group`), `:504` (`/api/groups`), `:678-681` (`d.group`), `:773-786` (`byGroup`, `'No group'`), `:1025-1033` (`Group:` pill, `All groups`, `No group`), `:1308` (`Group by device group`), `:1594`, `:1739-1839` (`groups=` props); `components/layout/AppShell.tsx:88` `{ href: '/groups', label: 'Groups', icon: Layers, countKey: null }`, `:93` comment; `components/target/useTargetSelection.ts` (`Target = 'single' | 'group' | 'devices'`, `groupId`, `initialGroupId`, `groups`), `components/target/TargetPicker.tsx:3`, `:21` (`group: 'Group'`), `:39`, `:56`; `components/RunScriptDialog.tsx:14`, `:101`, `:475-510` (`initialGroup`), `:551`, `:602`, `:644`, `:663-677`, `:796`, `:856-860`, `:902`, `:1020`, `:1051`, `:1073`, `:1114`; `components/ScheduleEditorDialog.tsx:16`, `:98`, `:146-148`, `:183-185`, `:211-212`, `:247-248`, `:315-340`, `:396`, `:680-695` ("Group", "No group is saved yet, create one from the Groups page"); `components/InstallBatchDialog.tsx:4`, `:32`, `:48`, `:73-82`, `:107-137`, `:191`, `:227-228`; `components/BulkTransferDialog.tsx`, `BulkPrepDialog.tsx`, `network/BulkProxyDialog.tsx`, `device/BulkCutoverDialog.tsx`, `BulkForgetDialog.tsx` (the same `groups`/`groupId` props); `components/device-popup/ActionsList.tsx:30`, `:190`, `:274`, `:309`, `:356-366`, `:737`, `:757`, `:775`; `components/device-popup/AdbCommandDialog.tsx` (rewritten in 207.8 with `groupId`); `components/AdmitDeviceDialog.tsx:11`, `:40`, `:49-56`, `:65`, `:75`, `:85`, `:105-107`, `:229-238` ("Group", "No group"); `components/DiscoveredTray.tsx:6`, `:46-53`, `:173`; `components/DeviceCard.tsx:291-299` (`device.group`, `'No group'`); `components/device/DeviceHeader.tsx:188`, `:220-221` (`Row label="group"`, `'No group'`); `components/plugin-view/rows.ts:24`, `:104` (`groupId`); `components/schema-form/useEnumSource.ts:43` and its `KEY_MAP` entry (`groups` → `/api/groups`); `components/host/DeviceWallWithPicker.tsx:43`; `components/wall/Wall.tsx:148`; `components/wall/TileGrid.tsx:6` (if plan 201 left it); `components/bulk/use-batch-report.ts:28`; `app/plugins/page.tsx:98`, `:148`, `:588-596`, `:622`, `:634-653`, `:789` (`?group=`, `initialGroup`); `app/schedules/page.tsx:52`, `:222`; `app/schedules/detail/page.tsx:17`, `:85`, `:138-150`, `:182-184`, `:295` (`TargetPreview`, `via: 'group'`, `/api/groups/:id/devices`, `group ${name}`); `app/scripts/page.tsx:15`; `app/batches/page.tsx:112`; `app/batches/detail/page.tsx:365`, `:421` (`['group', batch.groupId ?? '(ad-hoc list)']`); `app/device/page.tsx:932-933` ("managed from the Groups page"); `components/ForgetDeviceDialog.tsx:21`, `:128`; `components/DisconnectDeviceDialog.tsx:22`, `:107`; `components/device-popup/DevicePopup.tsx:1173`; `lib/api.ts:186`; `lib/operations.ts` (its group mentions); `packages/ui/src/components/device-picker.tsx:29`, `:61-65`, `:80` (`group?: { id: string; name: string } | null`), `:146`, `:154-176` (`byGroup`, `'No group'`); `packages/ui/src/lib/device-name.ts:126`; `packages/studio/README.md` and `packages/sdk/README.md:640` (`groupId`).
- Test file: none — §12: Studio and `@enkaku/ui` have zero tests. Verify with `bun run typecheck` and the owner smoke.
- Verifiable result: `GREP_207_CLUSTER` restricted to `packages/studio packages/ui` prints nothing; `bun run typecheck` clean for Studio.
- Do not: keep a `/clusters` redirect page; write "Group by group" as copy (use "Group by device group"); keep `'Unclustered'` anywhere ("No group").

### 207.10 Docs and READMEs

- Files changed: `packages/core/README.md` (207.6's section; also `:10` and the other nine group mentions), `packages/protocol/README.md:36` and the deleted section, `packages/studio/README.md:108` (if plan 201 left a group mention), `packages/sdk/README.md:640`, `CLAUDE.md` (no rule changes; the "Rules" section does not name clusters or the console), `docs/spec-divergences.md` (207.6).
- Verifiable result: `GREP_207_CLUSTER` and `GREP_207_CONSOLE` for `packages/*/README.md` print nothing.
- Do not: edit `docs/archive/plans/01..129` or `docs/mvp/` in place.

### 207.11 Gate and handoff

- Run `GREP_207_CLUSTER`, `GREP_207_CONSOLE` and every §10 proof; run `bun run typecheck`; run the §7.1 list one file at a time; fill §11.
- Do not: run `bun test` bare or the Studio suite; write `implemented` while G17 is open (write `implemented (software)`).

## 6. Acceptance criteria

1. G1 to G16 are checked; G17 is `owner`.
2. `curl -s -X POST localhost:7700/api/actions/wake -H 'content-type: application/json' -d '{"target":{"deviceIds":["<id>"]}}'` answers HTTP 202 with `results[0].status` `done` and `results[0].detail.desired` `awake`.
3. The same call with `{"target":{"groupId":"<unknown>"}}` answers 404 `group_not_found`; with `{"target":{}}` answers 400.
4. `POST /api/actions/install` while a job runs on the device answers `forbidden` with code `E_DEVICE_CONFLICT` naming the job; `POST /api/actions/push` answers `accepted` (row "transfer over job = allow", MVP 04 §1.3).
5. `POST /api/actions/adb` with `cmd: 'true'` on a device someone is controlling answers `accepted` (row "command over control = allow"); on a device with a running job answers `warned` with the sentence, and `force: true` answers `accepted`; `GET /api/operations/:id` shows `done` with `detail.exitCode` 0 within the shell timeout.
6. `POST /api/actions/run-script` with one device creates one batch with one job (`GET /api/batches/:batchId` shows `counts.total` 1) and `results[0]` carries both ids.
7. `GET /api/groups` lists what `GET /api/clusters` listed before the migration, with the same ids; `GET /api/devices?groupId=<id>` filters; `GET /api/clusters` is 404.
8. `GET /api/adb/stats` has no `commandConsole` key; `GET /api/settings` has no `shell.fanoutEnabled` and no `retention.commandRunDays`.
9. The old Studio: the device page installs an APK through Files, forgets a device, disconnects a TCP device, sets tags, applies a label, retries a preparation component, wakes and sleeps, and the Groups page creates, renames, deletes a group and moves devices in and out; nothing on any page calls a deleted route (the browser's network panel shows only `/api/actions/*`, `/api/operations/*`, `/api/groups*` and reads).
10. Every §10 proof answers as its row says.
11. `ps -Ao pid=,command= | grep -i "[o]penpf"` shows nothing but the shell after the tests.

## 7. Test plan

### 7.1 Scoped commands, one at a time, never concurrently

```bash
bun test packages/protocol/src/actions.test.ts
bun test packages/protocol/src/settings.test.ts
bun test packages/protocol/src/api/devices.test.ts
bun test packages/protocol/src/plugin-surface.test.ts
bun test packages/core/src/db/groups-migration.test.ts
bun test packages/core/src/db/migration-watermark.test.ts
bun test packages/core/src/db/migrations/materialise-0014.test.ts
bun test packages/core/src/groups/resolve.test.ts
bun test packages/core/src/groups/membership.test.ts
bun test packages/core/src/actions/operations.test.ts
bun test packages/core/src/api/actions.test.ts
bun test packages/core/src/capability/actions.test.ts
bun test packages/core/src/api/groups.test.ts
bun test packages/core/src/api/devices.test.ts
bun test packages/core/src/api/device-preparation.test.ts
bun test packages/core/src/api/schedules.test.ts
bun test packages/core/src/network/route-service.test.ts
bun test packages/core/src/server/ws-handlers-shell.test.ts
bun test packages/core/src/api/adb-stats.test.ts
bun test packages/core/src/maintenance/retention.test.ts
bun test packages/core/src/daemon-wiring.test.ts
# CANCELLED by §12 (zero Studio tests): bun test packages/studio/src/lib/actions.test.ts
# CANCELLED by §12 (zero Studio tests): bun test packages/studio/src/components/actions/ActionResults.test.tsx
# CANCELLED by §12 (zero Studio tests): bun test packages/studio/src/components/device-popup/AdbCommandDialog.test.tsx
# CANCELLED by §12 (zero Studio tests): bun test packages/studio/src/components/target/useTargetSelection.test.ts
# CANCELLED by §12 (zero Studio tests): bun test packages/studio/src/app/groups/page.test.tsx
bun test plugins/tiktok-automation-pack/src/index.test.ts
bun run typecheck
```

Every other test file named in §5 is run individually right after its step, never as a directory wider than `packages/core/src/actions/` or `packages/core/src/groups/`.

### 7.2 Removal proofs

Run every command in §10 and paste the (empty) output into §11.

### 7.3 Manual smoke (one device, the author's machine; `ENKAKU_TEST_DEVICE=1` rows are the owner's)

```bash
bun run reset && bun run dev &                      # core on :7700; note the pid
sleep 20
ID=$(curl -s localhost:7700/api/devices | bun -e 'const r = await new Response(Bun.stdin).json(); console.log(r.items[0].id)')
curl -s -X POST localhost:7700/api/actions/adb -H 'content-type: application/json' -d "{\"target\":{\"deviceIds\":[\"$ID\"]},\"cmd\":\"echo hi\"}"
# expected: 202, {"operationId":"...","verb":"adb","results":[{"deviceId":"...","status":"accepted","activityId":"command:...:..."}]}
curl -s localhost:7700/api/operations/<operationId>
# expected within 2 s: results[0].status "done", results[0].detail.stdout "hi\n"
curl -s -X POST localhost:7700/api/actions/screenshot -H 'content-type: application/json' -d "{\"target\":{\"deviceIds\":[\"$ID\"]}}"
# expected: accepted, then done with detail.artifactId; GET /api/artifacts/<id>/content is a PNG
curl -s -X POST localhost:7700/api/groups -H 'content-type: application/json' -d '{"name":"Rack 01"}'
curl -s -X POST localhost:7700/api/actions/set-group -H 'content-type: application/json' -d "{\"target\":{\"deviceIds\":[\"$ID\"]},\"groupId\":\"<groupId>\"}"
curl -s "localhost:7700/api/devices?groupId=<groupId>" | grep -c "$ID"    # 1
curl -s -o /dev/null -w '%{http_code}\n' localhost:7700/api/clusters       # 404
bun run dev:studio &                                 # :3001; run acceptance item 9 by hand
kill %1 %2; ps -Ao pid=,command= | grep -i "[o]penpf"   # empty
```

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| drizzle-kit's rename prompt needs a TTY; a non-interactive run generates drop-and-create and loses every group and membership | §4.6: answer rename, or hand-write per the `0023` precedent with a real `when`; `groups-migration.test.ts` asserts the rows survive |
| Plans 205 and 206 both claim migration index `0065`; this plan's index collides | the executor takes the next free index, names it `NNNN` nowhere else, and records it in §11 |
| The two-level settings patch merges a key the operator did not send | the patch schema is built from `.shape` and pinned by a key-set test; the merge writes only keys present in the patch, never a spread (`devices.ts:775-790`'s own reasoning, copied) |
| An async verb hangs and its operation never settles | the activity list shows the transfer or command; the operation is evicted by the cap; nothing waits on it |
| A caller keeps `clientId` in a body | the schemas have no `clientId`; Zod strips it; the activity actor is the authenticated user |
| `cmd package clear --cache-only` is not accepted on some Android version | §9 Q3; the verb reports the shell's own failure and never falls back to `pm clear` |
| The old Studio silently proceeds on `warned` | the toast shows the sentence once before the forced re-send (plan 205 §3.2 item 2's interim rule); plan 216 replaces it with inline chips |
| A plugin reads `$device.clusterId` in a binding | none does today (207.7's grep); `BINDING_DEVICE_FIELDS` refuses the old name, so a stale plugin fails at surface validation, loudly |
| `entry-release.gen.ts` still names `console.html` until the next release build | it is gitignored and regenerated by `build:studio`; the gate excludes `*.gen.ts` |
| Deleting `POST /api/jobs` breaks a script or agent path | scripts use `ctx.farm`/the `job.run` capability and `JobService.enqueue`; the only HTTP callers were Studio (`RunScriptDialog`, `dev/tools`), both handled |

## 9. Open questions

1. **Plugin-declared verbs.** MVP 07 §1.1 says plugins add verbs under `<plugin>/<verb>` through the broker. `ActionVerbSchema` is closed in this plan. Confirm deferral, or name the plan that opens it.
2. **`settings` verb scope.** MVP 15 §1 says bulk `settings` is "the device Settings dialog with the picker", i.e. the per-device override fields of MVP 12 §5. This plan accepts any block of `DeviceSettingsSchema`. Should the verb refuse blocks plan 212 will make constants, or is a whole-settings patch acceptable until plan 212 shrinks the schema?
3. **`clear-cache`'s shell command.** `cmd package clear --cache-only <package>` (proposed) must be verified on the lab device (API 36) and on the owner's oldest phone; the author did not verify it against a source in plan 200 §5. If `--cache-only` is refused there, decide between `pm trim-caches` semantics (farm-wide, not per app) and dropping the verb from the first twelve.
4. **`screenshot` artifact kind and retention.** The verb writes a device-scoped artifact through `registerDeviceArtifact`. Whether a bulk screenshot of 100 devices should instead land in a batch-like container for the Jobs page is plan 218's question; confirm a plain artifact row per device is acceptable for the MVP.
5. **Operation TTL and cap.** One hour and 1 000 are the brief's numbers. A farm that runs many adb fan-outs may want longer; a setting is not wanted (MVP 12), a larger constant may be.
6. **`reprofile` as a verb.** MVP 07 lists it; `POST /api/video/reprofile` (farm-wide) stays. Confirm the per-device meaning ("restart this device's session at its current quality with the freshly resolved profile") or drop the verb if plan 206's always-on model makes it a no-op.
7. **The `?groupId=none` filter value.** `GET /api/devices?groupId=none` keeps `none` as "devices with no group" (renamed from `?clusterId=none`). Whether `none` should become `null` is a plan 214 API question; this plan keeps the literal.

## 10. Removed

Forbidden words introduced by this area: `cluster` (every casing and compound), `command-console`, `commandRun`, `command_run`, `savedCommand`, `saved_command`, `fanout`, `console` (as a product surface), `bulk twin`, `per-device route`, `clusterId`, `ClusterInfo`, `Unclustered`.

`GREP_207_CLUSTER` is:

```bash
rg -n -i "cluster" packages apps plugins scripts \
  --glob '!**/*.test.*' --glob '!**/dist/**' --glob '!**/packs/**' --glob '!**/node_modules/**' --glob '!**/out/**' --glob '!**/.next/**' \
  --glob '!**/*.tsbuildinfo' --glob '!**/*.gen.ts' \
  --glob '!packages/core/drizzle/**' \
  --glob '!packages/core/src/db/migrations/materialise-0014.ts' \
  --glob '!apps/guest-agent/**' \
  --glob '!apps/desktop/src-tauri/target/**'
```

`GREP_207_CONSOLE` is:

```bash
rg -n -P -i "command-console|command[-_ ]?runs?\b|saved[-_ ]?commands?\b|fanout|\bconsole\b(?!\.)" packages apps plugins scripts \
  --glob '!**/*.test.*' --glob '!**/dist/**' --glob '!**/packs/**' --glob '!**/node_modules/**' --glob '!**/out/**' --glob '!**/.next/**' \
  --glob '!**/*.tsbuildinfo' --glob '!**/*.gen.ts' \
  --glob '!packages/core/drizzle/**' \
  --glob '!apps/guest-agent/**' \
  --glob '!apps/desktop/src-tauri/target/**'
```

Allowed exceptions, precisely: (a) `packages/core/drizzle/**` is generated history and is never edited; (b) `packages/core/src/db/migrations/materialise-0014.ts` keeps the raw SQL naming the pre-`0014` table and the persisted marker id `'cluster-materialise-22.0'` (§3.2 item 8); (c) `apps/guest-agent/**` is plan 221's tree (`LabelRenderer.kt:44` "Grapheme-cluster cap" is a different word); (d) `apps/desktop/src-tauri/target/**` and `*.tsbuildinfo` are build artefacts; (e) `*.gen.ts` is regenerated by `build:studio`. The console regex excludes every `console.<member>` call (`console.log`, `console.error`, ...) with `(?!\.)`; the four prose uses of the word that name the browser's developer tools (`plugin-view/ReactView.tsx:80`, `lib/plugin-host.ts:477`, `DeviceLog.tsx:52`, `:298`, `LiveView.tsx:79`, `transport-metrics.ts:7`) and the two that name a Windows console window (`core/src/index.ts:32`, `:35`, `doctor/checks/host-adb.ts:8`) are reworded ("developer tools", "terminal window") so the gate is clean without an exception. Every other hit is a defect.

| What | Where it was | Proof |
|---|---|---|
| Per-device action routes `/:id/install`, `/:id/push`, `/:id/pull` | `packages/core/src/api/transfer.ts:91`, `:135`, `:177` | `test ! -e packages/core/src/api/transfer.ts` |
| `/:id/label/apply`, `/:id/label/clear`, `/:id/connection/disconnect`, `/:id/connection/reconnect`, `/:id/connection/cutover` (POST and DELETE), `/:id/unquarantine`, `PUT /:id/tags`, `PUT /:id/cluster`, `DELETE /:id`, `/:id/block`, `PUT /:id/readiness` | `packages/core/src/api/devices.ts:1117`, `:1328`, `:1346`, `:1407`, `:1474`, `:1555`, `:1606`, `:1626`, `:1660`, `:1680`, `:1716`, `:1738` | G7's grep prints one line (`'/:id/monitor/save'`) |
| `/:id/preparation`, `/:id/preparation/:c/retry` | `packages/core/src/api/device-preparation.ts:93`, `:112` | `rg -n "app\.post\(" packages/core/src/api/device-preparation.ts` → empty |
| `PUT /:id/network`, `/:id/network/enable`, `/disable`, `/retry`, `DELETE /:id/network`, `POST /network/apply`, `applyRouteInBulk`, `BULK_SKIP_FOR_CODE` | `packages/core/src/network/route-service.ts:3150-3257`, `:3264-3350` | `rg -n "app\.(put|delete)\('/:id/network'\|'/:id/network/(enable|disable|retry)'\|'/network/apply'\|applyRouteInBulk\|BULK_SKIP_FOR_CODE" packages/core/src` → empty |
| `POST /labels/apply`, `POST /prep/apply` | `packages/core/src/api/devices.ts:624`, `:690` | G8 |
| `POST /api/jobs`, `POST /api/batches` as public enqueues, `EnqueueBody`, `CreateBatchBody` | `packages/core/src/api/jobs.ts:48`, `:207`; `batches.ts:50`, `:766` | G8; `rg -n "EnqueueBody\|CreateBatchBody" packages/core/src` → empty |
| `POST /api/clusters/:id/devices`, `DELETE /api/clusters/:id/devices/:deviceId`, `POST /api/clusters/preview`, `/api/clusters` itself | `packages/core/src/api/clusters.ts:175`, `:191`, `:252`; `http.ts:416` | G12 |
| `/api/topology` | `packages/core/src/api/topology.ts`, `http.ts:418`, `daemon.ts:45`, `:2918-2930`; `packages/studio/src/app/topology/` | `test ! -e packages/core/src/api/topology.ts && test ! -d packages/studio/src/app/topology`; `rg -n "topology" packages/core/src packages/studio/src` → empty |
| The command console: runner, store, saved commands, routers, WS messages, `shell.exec` history rows, stats, retention sweep, settings, server-mode override | `packages/core/src/command-console/`, `api/command-runs.ts`, `api/saved-commands.ts`, `protocol/src/messages/command.ts`, `command/target.ts`, `command/saved.ts`, `api/command-runs.ts`, `ws-handlers.ts:1332-1339`, `:1426`, `:1513-1528`, `:1580-1591`, `:2651`, `adb-stats.ts:79-85`, `protocol/api/adb.ts:209-232`, `retention.ts:121-133`, `settings.ts:1758-1828`, `:1152`, `farm-settings.ts:40` | `test ! -d packages/core/src/command-console`; `GREP_207_CONSOLE` empty |
| `command_runs`, `command_run_members`, `saved_commands` tables | `packages/core/src/db/schema.ts:766-864` | G10's migration test; `rg -n "commandRuns\|commandRunMembers\|savedCommands" packages/core/src/db/schema.ts` → empty |
| Studio console page, `components/command/`, the nav entry, `TerminalPane`'s history fetch, `operations.ts`'s command-runs source | `packages/studio/src/app/console/`, `components/command/` (16 files), `AppShell.tsx:87`, `TerminalPane.tsx:125-145`, `lib/operations.ts:617-624` | `test ! -d packages/studio/src/app/console && test ! -d packages/studio/src/components/command`; `GREP_207_CONSOLE` restricted to `packages/studio` empty |
| The word cluster: `clusters` table, `devices.cluster_id`, `batches.cluster_id`, `schedules.cluster_id`, `idx_devices_cluster`, `idx_clusters_created`, `packages/core/src/clusters/`, `api/clusters.ts`, `ClusterInfoSchema`, `ClusterPreviewSchema`, `ClusterResponseSchema`, `ClusterMoveResponseSchema`, `DeviceInfo.cluster`, `via: 'cluster'`, `target.clusterId`, `?clusterId=`, audit `cluster.*`, `BINDING_DEVICE_FIELDS` `clusterId`, `PARAM_SOURCES` `clusters`, Studio `Cluster*` components, `GroupBy 'cluster'`, `?group=cluster`, `Target 'cluster'`, `'Unclustered'`, every comment and line of copy | the inventory in §3.1 and §5 steps 207.2, 207.5, 207.9 | `GREP_207_CLUSTER` empty |
| Per-verb response schemas `InstallResponseSchema`, `PushResponseSchema`, `PullResponseSchema`, `DeviceLabelsApply*`, `DevicePrepApply*`, `DeviceNetworkApply*`, `DEVICE_NETWORK_APPLY_SKIP_CODES`, `JobCreateResponseSchema`, `ClusterMoveResponseSchema` | `packages/protocol/src/api/transfer.ts`, `api/devices.ts:332-336`, `:632-692`, `:750`, `:847-1004`, `api/jobs.ts:25` | `rg -n "InstallResponseSchema\|PushResponseSchema\|PullResponseSchema\|DeviceLabelsApply\|DevicePrepApply\|DeviceNetworkApply\|DEVICE_NETWORK_APPLY_SKIP_CODES\|JobCreateResponseSchema\|ClusterMoveResponseSchema" packages plugins` → empty |
| `shell.fanoutEnabled`, `fanoutMaxDevices`, `fanoutConcurrency`, `fanoutMaxOutputBytes`, `fanoutPreviewBytes`, `fanoutConfirmThreshold`, `fanoutStageWaitSec`, `commandRunsPerUser`, `savedCommandLimit`, `retention.commandRunDays` | `packages/protocol/src/settings.ts:1758-1846`, `:1152-1183` | `rg -n "fanout\|commandRunsPerUser\|savedCommandLimit\|commandRunDays" packages` → empty |
| `packages/core/README.md` "The command console and bulk operations (plan 93, M58)"; `packages/protocol/README.md` "The command console and bulk operations — wire shapes" | `:597-740`; `:24-40` | `rg -n "command console" packages/core/README.md packages/protocol/README.md` → empty |
| MVP 13 A.5's `POST /api/transfers split` | never existed (`api/transfers.ts` has only `GET /`) | `rg -n "app\.post" packages/core/src/api/transfers.ts` → empty (unchanged) |
| Spec §10.1's per-device routes, §19's Console and Clusters screens | `docs/spec.md` | recorded as `DIV-078` (207.6) until plan 202 rewrites them; proof `rg -n "DIV-078" docs/spec-divergences.md` prints one row |

## 11. Handoff report

- **Checklist**:
- **Commits**:
- **Typecheck**:
- **Tests run**:
- **Removed, proven**:
- **Discrepancies between plan and code**:
- **Observed, not done**:
- **Open questions hit**:
- **Processes**:

---

## 12. Amendment 2026-09-03 — testing policy (plan 200 §8.3)

Studio and `@enkaku/ui` have zero tests. This amendment overrides every Studio test named above; the executor follows it where they differ.

- **Dropped, do not create or edit**: `packages/studio/src/lib/actions.test.ts`, `components/actions/ActionResults.test.tsx`, `components/device-popup/AdbCommandDialog.test.tsx`, `components/target/useTargetSelection.test.ts`, `components/target/TargetPicker.test.tsx`, `components/GroupEditorDialog.test.tsx`, `components/GroupMembersDialog.test.tsx`, `app/groups/page.test.tsx`, and every other Studio test this plan's steps name. Plan 201 deletes the existing ones. If this plan runs before 201 has merged and a Studio test fails to compile because of the route or `cluster`-to-`group` rename, **delete that test file in this plan** and list it in §11; never stub it, never skip it.
- **Kept, because they are on plan 200 §8.3's critical list**: the target resolver, the per-device result assembly, the policy integration (`warned` then `force`), the verb dispatch table, and the migration. These live in `packages/core` and `packages/protocol` and their tests stand exactly as §7 lists them.
- **§0 amended**: G13's "Verified by" becomes `bun run typecheck` clean plus the owner smoke below. Every other row keeps its command.
- **§7 amended**: remove the five `bun test packages/studio/...` lines. Add this owner smoke, run once on the lab device at the wave gate: select three devices on the wall, run **Adb command** `getprop ro.serialno` and confirm three per-device result rows; run **Install apk** on a group tab and confirm the per-device rows and the activity chips; start a job on one device, then run **Adb command** on it again and confirm the warn sentence appears once and the command still runs; rename a group and confirm the tab strip and every target picker follow.
