# MVP 13 — Removal register

> Status: compiled 2026-09-03. Part A is decided (it follows from documents 03–12); Part B is the result of a code scan for what is already dead today and is the CTO's finding, to be confirmed file by file when each plan lands.
> Ask as stated by the CEO: analyse every feature that will be switched off or is already dead, so the MVP work deletes it and nothing survives as dead code.
> Rule (README, "Approach"): a plan is not done until every name in its Removed list greps to zero references outside its own changelog. This register is the master list those plans draw from.

---

## Part A — Removed by MVP decisions

Each row names the source document. "Replaced by" is what a reader looking for the old thing should find instead.

### A.1 Device state, leases, control (MVP 04)

| Remove | Where | Replaced by |
|---|---|---|
| Lease manager, co-control grants | `packages/core/src/lease/` (lease-manager.ts, co-control.ts) | device activity list, policy table |
| `manual` / `busy` transitions, `MANUAL_ACQUIRED`, `MANUAL_RELEASED`, `JOB_CLAIMED`, `JOB_FINISHED` | `packages/core/src/device/state-machine.ts` | `devices.status` = offline / online / quarantined; activities |
| Quiet-period gate (`quietPeriodSec`, `maxWaitSec`, `lastManualRelease*`) | `packages/core/src/queue/scheduler.ts:85-100,156` | policy row "job over fresh control" |
| `checkInputAllowed` and its 12 call sites | `ws-handlers.ts` (input, shell, inspect, clipboard, recording ×3), `api/transfer.ts`, `api/adb-endpoint.ts`, `api/device-identity.ts`, `network/route-service.ts` ×2 | policy evaluation |
| `capability.lease: 'none' \| 'control'`, `E_NEEDS_LEASE`, `E_DEVICE_HELD`, `E_LEASE_REVOKED` | `capability/types.ts:59`, `capability/invoke.ts:98-110`, every `capability/device-*.ts` | `capability.activity` |
| Messages `lease.acquire/acquired/released/changed/revoked`, `assist.start/stop/started/stopped/changed`, `input.mirror` | `@enkaku/protocol` messages/job.ts, messages/co-control.ts | `device.activity` |
| `DeviceInfo.heldBy`, `DeviceInfo.assistedBy`, `LeaseHolder` | `packages/protocol/src/device.ts:60-73,249,261` | `DeviceInfo.activities` |
| Agent harness lease handling (`ensureControlLease`, `checkLeaseRevoked`, refcounted `releaseDevice`) | `packages/core/src/agent/harness/run.ts:224-247`, `agent/runner.ts:237-244` | an `agent` activity |
| Command console lease admission (`purpose: 'command'`) | `command-console/runner.ts:155,469` | a `command` activity |
| Bulk network lease acquire | `network/route-service.ts:3170-3205`, `capability/device-network.ts:183` | a `network-apply` activity |
| Drain of leases in adb cycle / app restart | `tools/adb-server-control.ts`, `tools/app-restart-control.ts` | drain of activities |
| Studio: `ControlState.tsx`, `TakeControlDialog`, `AssistDialog`, `HolderBadge`, lease banner in `ScreenCard`, lease handlers in `DevicePopup`, `DeviceHeader`, `WallTile`, `DeviceContextMenu`, `DeviceCard`, `DevicePicker`, `app/device/page.tsx`, `app/page.tsx:579`, `DeviceLog` assist rendering | `packages/studio/src/components/...` | activity strip, activity badge |
| Settings: co-control mode, grant TTL, max assisting per device, assist idle timeout, manual idle timeout, quiet period ×2 | `settings.ts` coControl block, session block | two rows in MVP 04 §1.3 |
| Spec §10.5 entirely; §10.1, §10.2 rewritten | `docs/spec.md` | |

### A.2 Mirror (MVP 06)

`packages/core/src/mirror/`, `mirror.*` messages, `input.mirror`, `mirror` settings block (4 fields), Studio mirror controls. Rebuilt later as a bulk action on control markers.

### A.3 Sessions and wake (MVP 11)

| Remove | Where |
|---|---|
| Lazy build on `acquire` / `stream.start` | `packages/session/src/manager.ts:86` and `ws-handlers.ts` stream.start |
| `idleTtlSec`, `maxIdleSessions`, `maxConcurrentBuilds` and their Studio rows | `settings.ts` session block, `farmSections.ts` |
| "Waking" phase panel, `WAKE_OFFER_AFTER_SEC`, wake-offer flow | `LiveView.tsx:132-154, 42, 356-413` |
| Readiness `asleep` default and its fallbacks | `device/readiness.ts:153,225,255-259` |
| Screencap loop as first-frame substitute during build | `drivers/src/display/screencap-loop.ts` usage in build; the engine stays as scrcpy-unavailable fallback |

### A.4 Scripts, workflows, recordings (MVP 03 §2, MVP 05)

| Remove | Where |
|---|---|
| Direct publish: `POST /api/scripts` publish branch, `resolveDirectPublishOwner`, `script.publish` capability, non-plugin `enkaku publish` | `scripts/routes.ts:355-438`, `plugins/owner.ts`, `capability/script.ts`, `sdk/src/cli/publish.ts` |
| Synthetic `recordings` owner, `RESERVED_PLUGIN_NAMES`, `SYNTHETIC_OWNER_*` | `plugins/owner.ts` |
| `scripts.kind`, `ScriptKind`, `?kind=` filter, `fallbackByKind`, `scriptKind` dep, `executor-kind-dispatch.test.ts` | `db/schema.ts:866-890`, `scripts/routes.ts:221`, `jobs/executor.ts`, `jobs/executor-host.ts:77,330` |
| Workflow rows in `scripts`, `POST /api/workflows` as a script publish, `/:name/versions` for workflows | `api/workflows.ts` |
| `jobNodes` table, `GET /api/jobs/:id/nodes`, `POST /api/jobs/:id/resume`, the `node` block on `job.status`, `artifacts.nodeId` | `db/schema.ts:1003-1058`, `api/jobs.ts:374-388,538-560`, `protocol/messages/job.ts:271-290,453-479` |
| Child-spawning workflow executor | `jobs/executors/workflow.ts` (rewritten as an orchestrator) |
| Version picker on script detail, `enabled` toggle UI, `PATCH /api/scripts/:id` | `app/scripts/detail/page.tsx:104-190`, `scripts/routes.ts:440` |
| `/scripts` redirect, `/plugins?tab=scripts` | `app/scripts/page.tsx`, `app/plugins/page.tsx` |
| Spec §11.4 exemption for workflows, §11.5 "create, edit, version, enable/disable", §11.7 "one job under one lease", §11.8 recording-as-synthetic-owner | `docs/spec.md` |

### A.5 Actions and dialogs (MVP 07)

| Remove | Where |
|---|---|
| Per-device action routes: `/:id/install`, `/:id/push`, `/:id/pull`, `/:id/label/apply`, `/:id/label/clear`, `/:id/preparation`, `/:id/preparation/:c/retry`, `/:id/connection/cutover`, `/:id/connection/disconnect`, `/:id/connection/reconnect`, `/:id/network/*`, `/:id/block`, `/:id/unquarantine`, `PUT /:id/cluster`, `PUT /:id/tags`, `PUT /:id/readiness`, `PUT /:id/network`, `DELETE /:id` as an action | `packages/core/src/api/devices*.ts`, `transfer.ts`, `device-*.ts`, `network/route*.ts` | `POST /api/actions/<verb>` |
| Multi-device twins: `/devices/network/apply`, `/devices/labels/apply`, `/devices/prep/apply`, `POST /api/batches` as a public enqueue, `POST /api/jobs` as a public enqueue, `POST /api/transfers` split | same | same |
| Studio: `InstallBatchDialog`, `BulkTransferDialog`, `BulkPrepDialog`, `BulkForgetDialog`, `BulkCutoverDialog`, `BulkProxyDialog`, `components/command/TargetPicker.tsx`, `target-preview.ts`, `AdbCommandDialog`, job-or-batch branch in `RunScriptDialog.tsx:478-481`, `useTargetSelection.ts` (folded into `useTarget`) | `packages/studio/src/components/` | one `*Dialog` per verb, one `DevicePicker` |
| Per-verb response schemas | `@enkaku/protocol` | `ActionResponseSchema` |

### A.6 Navigation and pages (MVP 03, 06)

| Remove | Replaced by |
|---|---|
| Routes `/clusters`, `/console`, `/tools`, `/nodes`, `/topology`, `/dev/tools`, `/workspace`, `/recordings` (as top level), `/workflows` (as top level), `/batches`, `/schedules` (as top level), `/agents/approvals`, `/agents/runs`, `/agents/thread`, `/scripts` | tabs under Devices, Scripts & Workflows, Jobs, Agents, Settings |
| Flat 14-item `NAV` and `Counts` polling of `/api/scripts` | six-item nav |
| The whole device page and its 12 tabs (`app/device/`) | Device Control window (MVP 15 §1): Actions, Inspector, Device (Jobs, Files); the [i] popover; plugin views |
| Studio 5 s operations aggregator | `packages/studio/src/lib/operations.ts` (735 lines), `OperationTray` polling | `device.activity` push |
| `ux-audit.md` screen table, `spec.md` §19 | rewritten |

### A.6a Console and clusters naming (CEO, 2026-09-03)

| Remove | Where | Replaced by |
|---|---|---|
| The console page, the handoff's log console, saved commands, command runs and their history | `packages/core/src/command-console/`, `api/command-runs.ts`, `api/saved-commands.ts`, `commandRuns` and `savedCommands` tables, `app/console/`, `components/command/`, the status-bar console toggle, `shell.*` fleet-command settings | the `adb` action in the generic set (MVP 07), one dialog, results per device |
| The word "cluster" | `clusters` table and `devices.clusterId`, `/api/clusters`, `POST /api/clusters/preview`, `target.clusterId`, Studio `Cluster*` components and copy | `groups`, `devices.groupId`, `/api/groups`, `target.groupId`, the Devices tab strip |
| Recordings from the nav and the definition of done (parked, not deleted) | `app/recordings/`, the Recordings tab | deferred list in MVP 06 |

### A.7 Settings (MVP 12)

About 60 titled fields become constants (list in MVP 12 §3), 12 are removed with their features (§4), about 15 move (§5). The schema file shrinks from 2 694 lines to under 600; `farmSections.ts` from 22 sections to 10. The dead fields `docs/settings-audit.md` names (`prep.disableAnimations`, `shell.commandRunsPerUser` / `trimForUser`, per-device `video.controlPreset`/`wallPreset`, shadowed per-device `timing.*`) are deleted rather than kept with corrected copy.

### A.8 Device Control input (MVP 08)

`TEXT_DEBOUNCE_MS` and the text-collection branch, the three-key map in `onKeyDown`, the `compact` keyboard disable, the synthetic 40–120 ms tap hold as a default (`LiveView.tsx:27,857-884,1161`, `drivers/src/input/scrcpy-input.ts:49`).

### A.9 Inspector (MVP 02)

Once `ui-tree` (MVP 10) is the default engine: the ad-hoc `UiautomatorDumpInspector` instantiation in `device-executor.ts:165`, the Inspect-tab ref-counted teardown (`ws-handlers.ts:624-635`), the `instrumentation` lock conflict; ui-server itself stays as the fallback engine.

### A.10 Docs

`docs/spec.md` (archived and rewritten, MVP 09 §1), `docs/plans/01..129` (archived), `docs/ux-audit.md`, `docs/settings-audit.md`, `docs/spec-divergences.md`, `docs/tmp-try-arch-mikrotik.md` (archived), `CLAUDE.md` sections that describe removed rules (lease drain in `cycle()`, plugin seeding is unchanged and stays).

---

## Part B — Already dead today

Method: `rg` over `packages/ apps/ plugins/ examples/ scripts/ docs/`, excluding tests, generated packs, and `dist/`. "Certain" means the grep for the symbol or string returns only its own definition; "likely" means it is unreachable by construction but a product reason to keep it could exist. Each row is confirmed again by the plan that deletes it.

### B.1 Core, protocol, session, drivers, adb, scrcpy

**Whole subsystems with zero importers (certain)**

| What | Where | Evidence |
|---|---|---|
| Licensing: `loadLicense`, `LicensePayloadSchema`, `EDITION_LIMITS`, `limitsFor`, `withinDeviceLimit` | `packages/core/src/licensing/` | no importer outside the directory |
| Telemetry: `createTelemetry`, `TelemetryPayloadSchema` | `packages/core/src/telemetry/telemetry.ts` | no importer |
| WebRTC relay, server half: `relay/webrtc-relay.ts`, `werift-peer.ts`, `rtc-peer.ts`, `rtp-h264.ts`, `ice-credentials.ts`; handlers for `video.webrtc.*` in `ws-handlers.ts:2481-2506`; `GET /api/nodes/ice-config` | `packages/core/src/relay/`, `api/nodes.ts:101` | the only client, `studio/src/lib/webrtc-player.ts`, is imported by nothing; `LiveView.tsx:1074`'s `transport === 'webrtc'` branch is unreachable. MVP 01 §4 step 4 keeps this as an option; if it is not wired in the MVP it is deleted, not left |
| Compatibility barrel `session/index.ts` ("keeps older imports working") | `packages/core/src/session/index.ts` | zero importers |

**Built but not wired (certain)**

| What | Where | Note |
|---|---|---|
| `scriptKind` never passed to `createExecutorHost`, so the workflow executor (about 800 lines) and every `jobNodes` writer are unreachable in production | `daemon.ts:1345-1420`, `jobs/executor-host.ts:77,330`, `jobs/executors/workflow.ts` | superseded by MVP 05; delete with it |
| `resultSummaryFields: () => []` "no producer yet" | `daemon.ts:~1415` | self-documented inert seam |
| `CommandRunStore.trimForUser` implemented and tested, never called; makes `shell.commandRunsPerUser` dead | `command-console/store.ts:184,461`, `settings.ts:1813` | MVP 12 deletes the field |
| `ScrcpyAoaInput` throw-only stub, `'aoa'` enum value threaded through five files | `drivers/src/input/scrcpy-aoa.ts`, `registry/engines.ts:32-40`, `settings.ts:414`, `driver.ts:109`, `session/types.ts:24` | delete the stub and the enum value; re-add when an AOA transport exists |
| Stale "no producer yet" comments on `jobNodes` and `artifacts.nodeId` | `db/schema.ts:999,1059` | both tables go with MVP 05 and 14 |

**HTTP routes with no caller (certain unless noted)**

| Route | Where | Note |
|---|---|---|
| `GET /api/settings/device-schema` | `api/settings.ts:36` | Studio reads `deviceSchema` from `GET /api/settings` |
| `GET/POST/DELETE /api/agents/:id/spawn-grants` | `api/agents.ts:66-83` | API-only by plan 67; either gets a Studio surface on the compacted Agents page or is deleted |
| `GET /api/notifications/unread-count` | `api/notifications.ts:29` | redundant with the list payload |
| `GET /api/nodes/ice-config` | `api/nodes.ts:101` | transitively dead with WebRTC |
| `GET/POST/DELETE /api/tokens` | `api/tokens.ts:37-50` | likely: no Studio, SDK, plugin, or guide caller; there is no way to mint a token from the product. MVP 12 puts a Users and tokens table in Settings → Access, which becomes its caller |

**WebSocket messages sent but never handled (certain)**

`plugin.log` (also on the plugin event denylist), `scan.progress`, `agent.message.queued`, `agent.message.delivered`, `mirror.stopped`, `lease.released`, `clipboard.ok`, `input.text.result`, `node.hello.ack` (likely: the node may ignore the ack by design). Plan 67's claim that Studio shows a queued-message counter from `agent.message.*` is false; no such counter exists.

**Settings with no reader (certain)**

`prep.disableAnimations` (a member of `DEVICE_PREP_KEYS`, so bulk prep reports it as changed while nothing happens on the device), per-device `video.controlPreset` / `video.wallPreset`, `shell.commandRunsPerUser`. Client-only fields misfiled as live: `DeviceSettings.autoReconnect`, `wall.rampConcurrency`. All covered by MVP 12.

**Exports with exactly one occurrence in the repo (certain)**

`assertApiKey` (`agent/provider/anthropic.ts:359`), `assertOpenRouterApiKey` (`openrouter.ts:154`), `RecordingCreateResponseSchema` and `RecordingPatchResponseSchema` (`api/recordings.ts:175-176`, Studio keeps its own copies), `tagPluginPromise` (`plugins/runtime-host.ts:594`), `scriptNamesByIds` (`scripts/registry.ts:404`), plus the licensing and telemetry names above. About 80 further symbols are exported but used only inside their own file (constants in `runtime-host.ts`, `webhook-secrets.ts`, `rtp-h264.ts`, `config.ts` schemas, `registry/device-tags.ts`, `agent/tree/authority.ts`, `capability/device-network.ts`): export-surface bloat, to be made module-private in the plan that touches each file, not a separate task.

**Small items**

`A_SYNC`, `VERSION_SKIP_CHECKSUM`, `verifyChecksum` (`adb/src/transport/wire.ts`, likely); `SCID_MARKER_PREFIX` (`scrcpy/src/session.ts`, test-only); `FARM_TAG_PROPERTY` (`session/src/farm-tag.ts`, test-only). `TODO-verify` markers on scrcpy byte layouts (`control/messages.ts:5`, `demuxer.ts:6`, `session.ts:154`, `version.ts`) are unverified assumptions, not dead code; they are closed by MVP 01 step 1 on the lab device.

**Scripts**

`scripts/guest-agent.ts`: its own header says delete once `vpn-helper` exists, and it does (`drivers/src/network/guest-agent/vpn-helper.ts`); superseded by `smoke-guest-agent.ts`. Certain. `scripts/delete-unowned-scripts.ts`: one-off plan 110 migration, likely dead once run.

**Checked and alive, so not to be re-filed**

`device/labelling.ts` (Studio calls label apply and clear), `mirror/group.ts` (until MVP 06 removes it), every `tunnel/*` module, `api/transfers`, `doctor`, `topology`, `tags`, `kv`, `video`, `webhooks`, `saved-commands`, `clusters`, `command-runs`, `workflows`, `recordings`, `adb/stats`, `v1/cap`, `v1/blobs`, `workspace`, `tools`. `runtime-host.rejection-child.ts` and `queue/claim-race-worker.ts` are spawned by path from tests. TinyH264 is already fully removed. **`packages/harness` is a verbatim vendored copy with a provenance check**: its unused exports must not be deleted.

### B.2 Studio, ui, plugins, apps, examples, scripts

**Whole modules with zero importers (certain)**

| What | Where |
|---|---|
| `createWebRtcPlayer`, `WebRtcPlayer`, `PlayerState` (118 lines) | `packages/studio/src/lib/webrtc-player.ts` |
| `components/topology/` directory: `ClusterSection.tsx`, `DeviceTile.tsx` and its test (the render layer of the `/topology` page, which is now a redirect) | `packages/studio/src/components/topology/` |
| `/dev/tools` page and test: no nav entry, no link, no redirect | `packages/studio/src/app/dev/tools/page.tsx` |
| Redirect stubs `/topology`, `/scripts`, `/agents/thread` (bookmark compatibility only; deleted with MVP 03) | `packages/studio/src/app/{topology,scripts,agents/thread}/page.tsx` |
| `record.ts` (238 lines): a schema re-export shim imported only by tests; production imports `./shared` | `plugins/proxy-manager/src/record.ts` |

**Exports with zero references anywhere (certain)**

`lib/api.ts` `fetchHealth`, `HealthResponse`, `fetchTopology`, `OnGeoFail`; `lib/agent-chat.ts` `computeImageInContext`; `app/plugins/plugin-list.ts` `defaultVersion`, `declaredScriptIds`; `components/bulk/BatchResults.tsx` `ResultStatusChip`; `components/schema-form/types.ts` `FieldProps`; `schema-form/controls/types.ts` `LeafPlan`; `packages/ui/src/components/device-picker.tsx` `PickableDevice`; `packages/ui/src/lib/core-base.ts` `setCoreBase` (public through the `@enkaku/ui` barrel, no user).

**Vendored `components/ai-elements/` (2 303 lines, one consumer)**: `Chat.tsx` imports about 30 of about 90 exports. Dead: 18 exports in `prompt-input.tsx` (attachments, screenshot, header, action menu, hover card, tabs, command input), 8 in `message.tsx` (actions, branch selector, toolbar), `ConversationDownload` and `messagesToMarkdown` in `conversation.tsx`. Trim to what `Chat.tsx` uses when the Agents page is compacted (MVP 06). `motion` stays as a dependency for `shimmer.tsx`.

**Exported only for their own file (about 180, likely)**: `createPluginHost`, `computeControlState` (deleted by MVP 04 anyway), `computeLiveSet`, `buildOperations` / `visibleTransfers` / `wantedTransferSubscriptions` (deleted by MVP 04's activity push), `hasScannableNetwork`, `cidrToRange`, `fetchPluginPage`, `retargetEdge`, `hasAnyExplicitEdges`, `formatBitRatePreset`. Several are exported so a sibling test can reach them; make private in the plan that touches each file.

**WebSocket**: `agent.subscribe` and `agent.unsubscribe` handler arms (`ws-handlers.ts:1276,1281`) have no client; Studio consumes agent events over the SSE stream from `api/agent-chat-stream.ts`. The message shapes they fan out stay live. REST is clean in both directions: every path Studio or a plugin fetches resolves to a core route, and no route lacks a caller beyond those in B.1.

**Plugin surface features with zero bundled users (certain, informational)**: data source `{ kind: 'handler' }` and `ctx.onQuery`, `ctx.onSocket`, `ctx.onWebhook`, `ctx.onEvent`, and the `handlerViewsWithoutServiceMessage` validator. Only `ctx.onRequest` has users (mikrotik-routing, proxy-manager). Of the 41 icons in the closed allowlist, bundled plugins use 4. These are third-party API surface, not deletion candidates by themselves; MVP 06 decides whether the plugin service contract shrinks to what a real plugin has needed.

**`@enkaku/host` drift (certain)**: `components/host/index.ts:31` exports `DeviceWallPickerProps`, which neither ambient declaration (`plugins/mikrotik-routing/src/enkaku-host.d.ts`, `packages/sdk/src/cli/init.ts:437`) names. The barrel's own comment says `DeviceWallWithPicker` is the only export. Delete the type export.

**Plugins**: `plugins/networking/package.json` says `2.2.0` while `src/index.ts` says `3.0.0`; the pack builder reads the bundle so the shipped version is right, but the rule in `CLAUDE.md` says all three sites move together. `proxy-manager`'s `VIEW_NOT_BUILT` names a view that is built (rename). `packages/core/packs/` is gitignored and regenerated by CI; local staleness is not a register item.

**Design tokens (certain)**: `--color-destructive-foreground` (`packages/ui/src/theme.css:138`) and `--radius-card` (`:109`) are defined and never referenced. Every other token and custom class is used.

**apps/desktop (certain)**: not wired to CI or release at all (zero mentions in `.github/workflows`). The sidecar mechanism it exists for is not configured: `tauri.conf.json` has `externalBin: []`, and `main.rs:56` resolves the core from `ENKAKU_CORE_BIN` or a bare `PATH` lookup, never `new_sidecar`, so `scripts/build-desktop.sh`'s header is false as configured. Zero `#[tauri::command]` handlers. It does hold three things Studio cannot do: tray icon with close-to-tray, core child-process supervision with orphan cleanup and free-port search, and a health-gated error page. MVP 09 §4 decides packaging; if the MVP ships as binary plus browser, the desktop app is parked outside the MVP definition of done, not deleted.

**apps/guest-agent**: `text.status` (`Protocol.kt:78`, `TextFacet.kt`, `client.ts:194`) has no host caller today; MVP 08 §1.2 and MVP 10 §1.2 give it one, so it stays. Every other method has a live caller. `README.md:118` claims `labelling.ts` "has not been built"; it exists (444 lines), is wired in `daemon.ts:61`, and Studio calls label apply and clear. Stale doc, fix in the plan. Note `labelling.ts` contains a stray non-text byte that makes plain `grep` skip it; clean the byte.

**scripts and examples**: `scripts/guest-agent.ts` is not in `package.json`, imported by nothing (only its own usage comment), and its header sets a deletion condition that `vpn-helper` now meets; certain, contradicting `apps/guest-agent/README.md:135`, which is also stale. `scripts/delete-unowned-scripts.ts` is a spent plan 110 migration, unreferenced; likely. `scripts/tag-release.sh` is human-invoked and stays. `examples/scroll-fling-demo.ts` is referenced only by its own test and one plan; low value, likely removable. `packages/studio/src/lib/dependency-gaps.test.ts` is a cross-package file-content guard with no source module; alive, but tooling will flag it.

---

## Part C — How this register is used

1. Every MVP plan (numbered from 130) copies the rows it owns from Part A and Part B into its own Removed section, and the plan's acceptance includes a grep of each name returning zero hits outside its changelog.
2. Part B rows that no MVP plan owns (licensing, telemetry, the small exports, the two tokens, the stale docs) are collected into one housekeeping plan that runs first, so the rebuild starts from a tree with no known dead code.
3. `packages/harness` is excluded from every deletion by the provenance check; anything unused there stays.
4. A row is closed only by a commit that deletes it, never by a comment saying it is deprecated.
