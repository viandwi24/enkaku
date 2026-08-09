# enkaku-core

The Bun + Hono daemon: device registry, toolchain manager, API and WS.

## Run in dev

```bash
ENKAKU_DATA_DIR=/tmp/enkaku-dev bun run packages/core/src/index.ts
```

On first run adb is downloaded, verified, and activated automatically by the Toolchain Manager — no system adb required. Progress is visible over WS (`tool.provision.progress`).

Env:

| Env | What it does |
|---|---|
| `ENKAKU_DATA_DIR` | Override the app-data dir (per-OS default, see 00-overview §5) |
| `ENKAKU_PORT` | HTTP/WS port (default 7700) |
| `ENKAKU_LOG_LEVEL` | debug \| info \| warn \| error |
| `ENKAKU_LOG_JSON` | `1` → JSON-lines logs |
| `ENKAKU_TOOLS_MANIFEST_URL` | Remote manifest for `POST /api/tools/manifest/refresh` |
| `ENKAKU_ADB_PATH` | Override the adb binary (dev/test only, always warns) |

## Boot sequence

DB and migrations (including the one-shot cluster materialisation, see below) → WS hub plus ToolchainManager (reconcile and adopt pre-baked tools) → HTTP and WS listen → provision required tools (a gate) → adb client, track-devices, registry.

## Endpoints

- `GET /api/health` — `{ ok, version, adb: { state, serverVersion }, deviceCount, uptimeMs }`
- `GET /api/devices` — `{ devices: DeviceInfo[] }`; `?tag=` narrows by tag (AND), `?clusterId=<id|none>` narrows by cluster
- `PUT /api/devices/:id/cluster` — `{ clusterId: string | null }`, moves the device (or unassigns it)
- `GET/POST /api/clusters`, `PATCH/DELETE /api/clusters/:id` — a cluster is a container (plan 22.0): `POST /api/clusters/:id/devices` assigns members, `DELETE /api/clusters/:id/devices/:deviceId` removes one, `GET /api/clusters/:id/devices` lists them. A device belongs to at most one cluster; deleting a cluster unassigns its members without deleting any device.
- `GET /api/tools` · `POST /api/tools/:id/install|activate|check` · `DELETE /api/tools/:id/:version` · `POST /api/tools/manifest/refresh` (spec §7.7)
- `GET/POST/DELETE /api/devices/:id/guest-agent` — install, inspect, or remove the on-device helper APK
- `GET/PUT/DELETE /api/devices/:id/network` — the device's network route (plan 44)
- `POST /api/devices/rescan` — runs one discovery reconcile pass immediately and returns the `ReconcileReport` (plan 85, see below)
- `GET /api/adb/stats` — exec semaphore, streaming lane, `hostAdb`, and `transport` occupancy (plan 23, extended by plan 85, see below)
- WS `/ws` — broadcasts `device.*` and `tool.*` (schemas in `@enkaku/protocol`), plus a one-way `heartbeat` every 15s (plan 85). A client must `GET /api/devices` first, then subscribe (there is no snapshot replay).

## Guest agent and the device network route (plan 44)

`/api/devices/:id/guest-agent` reports one of five states, and the distinction between two of them is load-bearing: **`installed` means the package is present, `ready` means the control channel actually answers.** Collapsing them would report a broken device as healthy. The others are `not-installed`, `unreachable` (installed and bootstrapped but the channel is silent), and `unsupported` (device SDK below the agent's floor, with the reason returned).

`/api/devices/:id/network` applies a SOCKS5 route through the `vpn-helper` engine — a full tunnel via `VpnService`, so an app under test cannot bypass it the way it can ignore `settings put global http_proxy`. Both endpoint groups require the `device.network` permission and a held manual lease (`leases.checkInputAllowed`), the same gate input and shell use.

The response separates **declared** (what was asked for) from **observed** (what the device reports), with a `drift` flag when they disagree — a VPN revoked from Settings, or a tunnel that died, must be visible rather than assumed away. `health` starts at `unverified` and a successful apply does **not** promote it to `ok`: only an egress probe could, and that does not exist yet.

Upstream passwords never appear in a response, in the device event log, or in any `meta` field — `redactRouteConfig()` in `@enkaku/protocol` is the single chokepoint. Route state currently lives in memory, so a core restart forgets it (the settings/read-seam half is plan 44 §5.4, deferred), and the lease-teardown revert is wired at two of its four sites, with TODOs marking the rest in `ws-handlers.ts`.

## Device terminal (plan 26)

`shell.exec` over `/ws` runs a free-form `adb shell` command on a device: gated by the `device.shell` permission (`auth/acl.ts`), the farm-wide `shell.mode` setting (`off | admin | operator`, off by default in server mode), and the same manual-lease rule input uses (`leases.checkInputAllowed`) — busy/offline/idle/wrong-holder are all refused before anything runs. Every accepted command is recorded to the device's `input` event log twice (`shell.exec`, then `shell.result`), with credential-bearing flags redacted (`device/redact.ts`). Results — including the exit code, recovered via a trailing marker since adb's `shell:` service has no exit-status of its own (`device/exit-marker.ts`) — broadcast to every viewer of the device, not just the one who ran it (`shell.echo` / `shell.result`); only the current lease holder may send `shell.exec`. No command allowlist or denylist exists anywhere in this path — see the code comments in `ws-handlers.ts` and `TerminalPane.tsx` for why that would be a false sense of security, not a real one.

## Clipboard (plan 38)

`clipboard.get`/`clipboard.set` over `/ws` read and write the device clipboard through the scrcpy control socket (`@enkaku/scrcpy`'s device-message reader, `control/device-messages.ts` — the socket was write-only before this plan). `clipboard.set` is gated exactly like `input.*`: the manual lease (`leases.checkInputAllowed` + `touchManual`), recorded to the device's `input` event log — but only the text **length**, never the text itself, since clipboard content is routinely a password or a token. `clipboard.get` needs no lease. Both requests are request/reply correlated by `id`; unlike `shell.echo`/`shell.result`, the reply (`clipboard.value`) goes **only to the requesting connection**, never broadcast to every viewer. A session with no scrcpy control socket (`screencap-loop`) refuses reads with `E_CLIPBOARD_UNAVAILABLE` — never an empty string — while still best-effort writing via `adb shell cmd clipboard set-text`. Node-owned (cloud) devices route both operations through the plan 25 `TunnelRpc` (`clipboard.get.request`/`clipboard.set.request`), handled node-side in `packages/node/src/clipboard.ts`.

## Crash detection (plan 37)

A crash watcher (`device/crash-watcher.ts`) is always on for any device with an active session, independent of jobs: it subscribes to the shared monitor stream registry (`device/monitor-hub.ts`, plan 24) as the internal client `internal:crash`, reading `logcat -b crash,main -v threadtime -T 1` (the `crash` monitor kind, `device/monitors.ts`) — the crash-report buffer plus `main` (ANRs are reported by `ActivityManager` there, not in the crash buffer). Because it goes through the same hub every human Monitor tab uses, a device with both a watcher and an open viewer still runs exactly one `logcat` process.

`device/crash-parser.ts` turns those lines into `CrashEvent`s: a `FATAL EXCEPTION` block (tag `AndroidRuntime`) or an `ANR in ...` block (tag `ActivityManager`), closed by the first line that does not continue it, a 2s idle gap, or a 200-line cap — whichever comes first. Every crash is recorded as an `app.crashed` main-stream device event and its trace saved as an artifact (job-scoped when a **job** lease is held at the moment it arrives, device-scoped otherwise via `runner/artifact-store.ts`'s `saveForDevice`) — a manual lease means "record only", no job attribution.

Whether a crash also **fails** the running job is `job.crashPolicy` (`ignore` | `declared` | `any`, default `declared`): `declared` matches the script's own `ScriptDefinition.reset.packages`, falling back to packages it launched via `ctx.device.app.launch`; `any` matches any non-system crash. A match aborts the runner with reason `'crashed'` (`session/runner/job-runner.ts`), which settles the job `APP_CRASHED` — classified `script` by `jobs/failure-class.ts` (a crash is a result, not a farm fault) — while still running `finish()` (spec §11.3).

`adb.maxStreamsPerDevice` defaults to 3 (not Plan 24's original 1): the crash watcher and the ui-server inspector (plan 34) each hold a stream slot on top of anything a human opens in the Monitor tab.

## Idle session TTL and quality profiles (plan 42)

`@enkaku/session`'s `SessionManager` no longer closes a device session the instant its last viewer leaves. It goes idle instead, and is closed only after `session.idleTtlSec` (farm setting, default 300s) with no new subscriber — a viewer returning inside that window re-attaches to the still-live session and sees a picture within one keyframe request, rather than paying the full wake-up sequence again. `session.maxIdleSessions` (default 8) bounds how many idle sessions the whole farm may hold open at once; past the cap the least-recently-idle one closes immediately. An idle session is also closed immediately — never waiting out the TTL — when the device goes offline, is quarantined, or a job claims it (`SessionManager.closeIfIdle`); a session with an **active** viewer is never touched by any of these, since video keeps streaming while a device is busy (spec §10.1). Setting `idleTtlSec: 0` restores the exact pre-plan-42 behaviour. Idle sessions are listed (oldest first) in `GET /api/adb/stats`'s `idleSessions` field.

Every session also has a **quality profile** (`control` | `wall`), which maps to `max_size`/`max_fps`/`video_bit_rate` on the scrcpy server (`@enkaku/session`'s `QUALITY_PROFILES`). `control` (1600px / 30fps / 4Mbps) is what the device page always asks for; `wall` (480px / 5fps / 800kbps) is what the fleet Wall asks for, so many low-rate tiles can decode in one browser tab. The manager's rule: a device already at `control` quality is shared as-is with a `wall` request — **never** restarted or downgraded for a colleague's wall tile — while a `control` request against a `wall`-quality session restarts it at `control`, carrying existing viewers (e.g. a wall tile) over onto the new session rather than dropping them. `stream.start`'s `quality` payload field defaults to `control`; `stream.started` always reports back the quality actually granted.

## Cluster migration (plan 22.0)

Clusters used to be a saved tag selector; a device now carries a `cluster_id` field directly, so it belongs to at most one cluster. On first boot after upgrading, `db/migrations/cluster-materialise.ts` collapses every existing cluster's old (tag-based) membership into that field — oldest cluster wins any conflict — and writes a report to `<dataDir>/logs/cluster-migration-<timestamp>.json` naming every device that matched more than one. The step is guarded by a marker row (`migration_markers`), so it runs exactly once.

## AI agent provider connectors: Anthropic and OpenRouter, on the AI SDK (plan 75)

An agent's provider connector (`connectors.kind`) is `anthropic` or `openrouter` (`ConnectorKindSchema`, `@enkaku/protocol`) — both `ProviderAdapter` implementations (`agent/provider/{anthropic,openrouter}.ts`) sit on the Vercel AI SDK (`ai`, `@ai-sdk/anthropic`, `@openrouter/ai-sdk-provider`), not a provider-specific client library; the direct `@anthropic-ai/sdk` this used before plan 75 is gone from the dependency tree entirely. `agent/provider/message-mapping.ts` holds the one `ProviderMessage[] → ai`'s `ModelMessage[]` conversion both adapters share.

`stream()` still emits Enkaku's own `ProviderEvent` union (never a provider SDK's types, plan 65 §4.3) — Anthropic's four load-bearing request parameters (`thinking: {type:'adaptive'}`, never `budget_tokens`; `output_config.effort`; `fallbacks: 'default'`; the prompt-cache breakpoint after the last tool definition) travel as `providerOptions.anthropic` fields, verified against the actual wire body a fake `fetch` captures in `anthropic.test.ts`, not just an intermediate object. `listModels()` and `countTokens()` have no AI SDK equivalent, so both adapters call their provider's REST endpoint directly (`/v1/models`, `/v1/messages/count_tokens?beta=true` for Anthropic; `/models` for OpenRouter), Zod-parsing every response.

`countTokens()` returns `{tokens, estimated}`: Anthropic's is exact (`estimated: false`, from its real count-tokens endpoint); OpenRouter has none, so its estimate anchors to the last real `stream()` response's own `usage.inputTokens` and adds a cheap character-count estimate only for messages appended since (`estimated: true`) — never a full-history re-stringify. `agent/loop/compaction.ts` is untouched (that cadence-cached estimator predates this shape and stays a plain `Promise<number>` contract); `agent/loop/run.ts` unwraps `{tokens, estimated}` for it and applies a margin to the compaction threshold only when the last count was an estimate.

`ProviderAdapter.languageModel(modelId)` returns an AI SDK `LanguageModel` for either kind — unused by anything in this plan (Enkaku's own `agent/loop/` still runs), and is what plan 76 hands straight to the harness's `HarnessConfig.model`.

`packages/harness` (`@enkaku/harness`) is a workspace package, copied verbatim from `bitorex-algo@9eab029` and typechecked in `scripts/typecheck.sh` — see `docs/plans/75-m40-harness-adoption.md` for the provenance rule (`scripts/check-harness-provenance.sh` enforces it) and what plans 76-78 do with it.

## Script references and `@latest` (plan 62)

A script is addressed as `name@version`, or `name@latest` (`ScriptRefSchema`/`parseScriptRef`, `@enkaku/protocol`). `latest` is **computed at resolve time** (`scripts/resolve.ts`'s `resolveScriptRef`), never a stored tag: the highest semver among that name's ENABLED, NON-PRERELEASE versions — publish order plays no part, so a hotfix published onto an older line does not accidentally become latest. Four coded failures distinguish why a reference did not run: `script_not_found`, `script_version_not_found`, `script_ref_unresolved` (`@latest` with nothing eligible — never silently falls back to a prerelease), `script_disabled`.

- `jobs.scriptId` is unchanged — always a concrete `scripts.id`, resolved from a reference (if one was given) before the row is written. `POST /api/jobs` accepts either `scriptId` or `scriptRef`, exactly one.
- `schedules.scriptRef` (renamed from `scriptId`) stores the **reference itself** — `checkout@latest` keeps picking up new versions on every future firing; `checkout@1.0.1` stays pinned forever. Resolved exactly **once per firing**, in `schedules/runner.ts`'s `fireOnce`, before the batch is built — so one firing across many devices never straddles two versions, and a reference that fails to resolve enqueues nothing and is audited as `schedule.failed`, naming the code.
- `GET /api/scripts?group=name` — one row per script name (`{ id, name, latestVersion, versionCount, lastPublishedAt, enabled }`, `latestVersion` being exactly what `@latest` would resolve to); `GET /api/scripts/:name/versions` lists every version, newest semver first.
- The `schedules.script_id → script_ref` migration (`db/migrations/backfill-schedule-refs.ts`) converts every pre-existing schedule to the exact `"<name>@<version>"` it was already pinned to — **never** to `@latest`, since that would silently change what a trusted schedule runs on its next firing. Guarded by a marker row (`migration_markers`), same pattern as the cluster migration above.
- The semver comparison (`compareSemver`, `@enkaku/protocol`) is hand-written, not a dependency: numeric component comparison (so `1.0.10 > 1.0.9`, which a string sort gets backwards), a release outranking its own prerelease, and prerelease identifier ordering per semver.org §11 — with build metadata (`+build`) ignored entirely, as the spec requires.

## VFS, skills, and the plugin system (plan 77)

`agent/harness/enkaku-vfs.ts`'s `EnkakuVFS implements VFS` (`@enkaku/harness`'s interface) drives Plan 64's workspace store the same way upstream drives its own with `PostgresVFS` — the store's compare-and-swap `ifMatch` IS `writeIfVersion`, and `version` is the store's **sha256** (not the harness's sha1: both are equality-only change detection, and `EnkakuVFS` never calls `hashContent`). `write`/`writeIfVersion`/`delete`/`list`/`grep` all enforce the caller's read/write scope themselves (`pathWithinAnyPrefix`), since the bare `VFS` interface carries no scope of its own; an optional `root` chroots an instance into a subtree (paths come back relative, e.g. `"checkout/SKILL.md"`) and an optional `writeExcludePrefixes` refuses a write regardless of scope — both used by the skills driver below. `WorkspaceStore.grep(prefix, pattern)` (`workspace/store.ts`) is the one method Plan 64 did not already have: one SQL-backed scan, capped at 200 hits with an honest `truncated` flag, never a silent cutoff. `fs.grep` (`capability/fs.ts`) exposes it to a human via Studio too.

`tools/file-tools.ts` and `tools/smart-replace.ts` (`@enkaku/harness`) come across with their bodies unchanged as `files.list`/`.read`/`.write`/`.edit`/`.delete`/`.grep`/`.todo` (`capability/file-tools.ts`) — a SEPARATE surface from `fs.*`'s simple CAS-on-`ifMatch` CRUD, offering the read-before-edit / smart-replace-cascade workflow a model is typically tuned to use well. The "read before edit" `Session` (`@enkaku/harness`'s `newSession()`) has to survive across many separate `invoke()` calls to mean anything; `capability/context.ts`'s `fileToolsSessionFor(actor, runId)` keeps one per agent run (keyed off `CapabilityContext.currentRunId`, which is stable for a run's whole lifetime) or per human/MCP actor identity when there is no run, bounded at 2,000 entries.

`/skills/` is read-only to a running agent (`capability/fs.ts`'s `SKILLS_PREFIX`, checked in `fs.write`/`.delete`/`.move` whenever `ctx.currentRunId !== null`; `EnkakuVFS`'s `writeExcludePrefixes` enforces the identical rule for `files.write`/`.edit`/`.delete`) — unconditionally, even if an agent's own configured `workspaceScope.write` includes `/`. A human (no current run) still edits skills through Studio's ordinary `fs.write`. `agent/harness/skills.ts`'s `createSkillsVfs` builds the one read-only, `/skills`-rooted `EnkakuVFS` both `skills.list` and `skills.read` (`capability/skills.ts`) read through — dedicated tools, never the general file tools, so a skill is reference material an agent consults rather than part of the workspace it edits.

`agent/plugins/` is the port of upstream's `AgentPlugin`/`defineAgentPlugin` (`plugins/types.ts`) plus its fail-fast assembler and boot-time dry run (`plugins/index.ts`), with one change: `tools` returns `AnyCoreCapability[]`, not a raw AI SDK `ToolSet` — a plugin GROUPS existing capabilities (an agent's actual authority is still its own `tools: string[]`, Plan 65, unchanged) and contributes one static system-prompt section. A duplicate capability id across two plugins, or a plugin whose `tools()` throws, fails at MODULE LOAD — `agent/runner.ts` imports this module for every run it builds, so a broken plugin fails the real boot, not the first chat that reaches it. Ten plugins regroup the existing registry (`device-control`, `device-inspect`, `device-apps`, `device-files`, `fleet`, `workspace`, `skills`, `automation`, `orchestration`, `notify`) — no capability handler is rewritten. `agent/runner.ts`'s `buildRunEnv` calls `assembleSystemPrompt(agent's own prompt, the run's actual capability ids)`, splicing in each enabled plugin's section (only when the run holds at least one of that plugin's capabilities) in registry order; every `plugin.prompt` is a static string, so the assembled prefix is byte-identical for the same tool set, run to run — Plan 65 §3.4's prompt-cache prefix depends on exactly that.

## A script can see the queue (plan 80)

`ctx.jobs` (`jobs/script-jobs.ts`'s `createScriptJobsReader`) is a running script's own view of the queue — `list`/`previous`/`queuedAfter`/`resultOf`, over the *existing* `JobStore.list` keyset paging (plan 30), never a second query engine. Every method takes the caller's own `JobRow` (not a `deviceId`) and derives the scope from it, so `list`/`previous`/`queuedAfter` can never see another device's jobs — there is no argument that widens them. `resultOf` is the one exception: it is scoped by NAMESPACE (same script, by name) rather than by device, and refuses everything else — not-found, a different script's namespace, not finished yet — down to a single `null` on the wire, with the real reason logged parent-side (`jobs/jobs-runner-port.ts`) so a script cannot distinguish "doesn't exist" from "not yours to read."

Crosses IPC the same way `ctx.kv` does (plan 79): `jobs.call`/`jobs.result` in `packages/session/src/runner/ipc.ts`, a `JobsRunnerDeps.call({ jobId, deviceId }, call)` port on `JobRunnerDeps` (`packages/session/src/runner/job-runner.ts`) that `daemon.ts` wires to `createJobsRunnerPort`, and `packages/session/src/runner/jobs-client.ts`'s `createJobsApiFor` as the schema-validating child-side wrapper `child-entry.ts` exposes as `ctx.jobs`. A `JobSummary` (`@enkaku/protocol`) never carries `params` or `result` — both are script-authored JSON a neighbouring script has no business reading; `origin`/`pluginName` are declared on the type now but stay `null` until Plan 82 gives them a column to read. `triggeredByJobId`/`rootJobId`/`depth` are populated as of Plan 81, below.

## A job can start a job (plan 81)

`jobs/triggers.ts`'s `createJobTrigger` is `ctx.jobs.trigger()`'s entire parent-side mechanism: one `db.transaction()` per call that (in order) checks idempotency, resolves and pins the script reference through `ScriptRegistry.resolve(ref, { allowDev: true })`, checks the target device, checks the two budgets, and inserts — the SAME transaction the count and the insert both run in, so two calls racing at `maxPerChain - 1` cannot both read a stale count and both insert. Extends Plan 80's `jobs.call` union with a `trigger` method (`packages/session/src/runner/ipc.ts`'s `JobsCallSchema`) rather than a second IPC surface; `jobs-runner-port.ts`'s `call()` gained one more `case` beside `list`/`previous`/`queuedAfter`/`resultOf`.

Four columns on `jobs` (migration `0040`, plain `ALTER TABLE ... ADD` plus two indexes, no table rebuild): `triggeredByJobId`, `rootJobId` (null on a chain's own origin — the same "null means true of it" convention `depth: 0` already used), `depth`, and `triggerKey`. `rootJobId`/`depth` are computed from the TRIGGERING job's own row (`from.rootJobId ?? from.id`, `(from.depth ?? 0) + 1`) — never from anything the caller supplies, which is what makes the depth bound impossible to spoof. `idx_jobs_trigger_key` is a UNIQUE index on `(rootJobId, triggerKey)`, partial — `WHERE trigger_key IS NOT NULL` — so the overwhelming majority of jobs (which have no trigger key at all) never compete for it.

**Idempotency is client-derived, not server-derived.** `jobs-client.ts`'s `createJobsApiFor(request, { id, attempt })` closes over an in-process call counter; when a script omits `key`, the default `${jobId}:${attempt}:${callIndex}` is computed BEFORE the IPC message is ever sent. `child-entry.ts` builds this client once per spawned process, inside `runScript` (not at module scope, unlike `ctx.kv`) because the default needs `init.job`, which does not exist until the `init` handshake arrives. This is exactly why the mechanism works for a re-run `finish()`: a fresh process (the SAME `job-runner.ts` finish-only fallback plan 35 already spawns after any failed attempt) restarts the counter at 0 and reproduces the SAME key sequence, so the transaction's idempotency check finds the row the killed attempt already wrote and returns it with `deduped: true` instead of inserting a duplicate — proven end to end (a real `createJobRunner` against a real DB, no mocked trigger mechanism) in `jobs/trigger-runner.integration.test.ts`, because a unit test of the key function alone would pass while the runner interaction stayed broken.

Two farm-configurable budgets live inside `JobSettingsSchema.trigger` (`@enkaku/protocol`, `packages/protocol/src/settings.ts`) — `maxDepth` (5), `maxPerChain` (200), `maxPerJob` (10) — read fresh per call (`() => settingsStore.get().job.trigger`), the same freshness pattern `resetPolicy`/`adb.maxConcurrent` already use. Every refusal is a real throw the script sees (`E_TRIGGER_TOO_DEEP` / `E_TRIGGER_CHAIN_FULL` / `E_TRIGGER_FAN_OUT`), and the idempotency check runs BEFORE any budget check inside the transaction — a re-run must not be refused by a budget that changed after its first attempt already succeeded.

Cancel-with-descendants (`JobStore.cancelQueuedDescendants`, `POST /api/jobs/:id/cancel?cancelDescendants=1`) walks `triggeredByJobId` transitively (a level-by-level BFS, not a `rootJobId` heuristic) so a job's siblings — and their own descendants — are left alone; it is opt-in, never automatic, and works for a RUNNING job too, since a job that triggered children and kept running still has queued descendants worth cancelling. `job.triggered` is a main-stream device event on the TARGET device, fired once per successful (non-deduped) trigger.

Not shipped this pass: the Studio job detail page's lineage display and the Monitor feed's `job.triggered` rendering — the same scope cut Plan 79 made for its KV panel, given the size of the backend surface that actually needed to be correct and tested. The REST/event surface is real; a panel reading it is future work.

## The Windows fleet: discovery, a bounded adb CLI, and observability (plan 85)

Written against a field report where a five-device Windows farm was silently
capped at two fully-instrumented devices, could not recover a device plugged
in before the core started, and left orphaned `adb.exe` children and leaked
`adb forward` entries behind. `docs/plans/85-m50-windows-fleet-scale.md`
carries the full evidence and design; this section documents what actually
shipped.

**Discovery reconciler** (`registry/reconcile.ts`, `createDeviceReconciler`).
`host:track-devices` is an excellent primary signal and a terrible *only*
signal — it speaks on change, which for a phone that never gets unplugged may
never come again. The reconciler runs a periodic, independent pass against
adb's own truth (`host:devices-l`, `AdbClient.listDevices()`) every
`discovery.scanIntervalSec` (default 10s; `0` disables the reconciler
entirely, restoring the exact pre-plan-85 tracker-only behaviour): a `device`
state unknown to the registry is adopted through the normal `onOnline` path; a
device known to the registry but gone from adb is dropped through `onRemove`
(a safety net — the tracker's own `remove` event usually wins the race); a
device stuck `offline` past `discovery.offlineGraceSec` (default 20s) gets one
`host:reconnect-offline` — a host-level re-open, **not** `kill-server`, and no
other tool's session on port 5037 is disturbed — at most once per serial per
`discovery.recoveryCooldownSec` (default 120s); `unauthorized` re-broadcasts
`device.unauthorized` on a repeating cadence instead of once. `POST
/api/devices/rescan` and a boot-time call both run `runOnce()` directly, and
the Discovered tray's **Rescan** button (`packages/studio/src/components/DiscoveredTray.tsx`)
calls the endpoint and renders the returned `ReconcileReport` as one line
("Scanned 5 devices · adopted 1 · nothing else changed").

`POST /api/devices/rescan` is gated on **`device.settings`** — the plan
document that designed this endpoint named `device.admin`, but no such
permission exists in `packages/core/src/auth/acl.ts`; every other
device-configuration route (tags, cluster, discovered/admit, block) already
gates on `device.settings`, so the endpoint follows that existing convention
rather than inventing a new permission for one route.

**One bounded adb CLI helper** (`device/host-adb.ts`, `createHostAdb`).
Before this plan, the code that shells out to the adb **binary** (as opposed
to talking to its smartsocket, which is `@enkaku/adb`'s job) for `install`,
`push`, `forward`, and the long-lived `adb shell` that runs the scrcpy server
was duplicated across **four** call sites (the plan's own text named two;
the other two were the guest-agent routes and the ui-server launcher) — every
copy piped `stderr` and never read it, so a failing `adb install` reported
only stdout (`exit 1: Performing Streamed Install`) while the real
`INSTALL_FAILED_*` reason sat unread on the discarded stream. `createHostAdb`
replaces all four:

- `run(args, opts)` — one-shot, both streams drained *concurrently* (a
  sequential drain can deadlock: a full stderr pipe blocks the child, which
  blocks the stdout read this function is waiting on), a deadline (30s
  default, 180s for `opts.lane: 'install'`), the child killed on expiry, and
  a thrown `HostAdbError` carrying the exit code plus **both** bounded tails
  (last 64 KB each).
- `spawnLongLived(args, opts)` — for the scrcpy server: returns a handle with
  a bounded tail, `kill()`, and `exited`; every child is tracked so
  `killAll()` (called from `daemon.stop()`) can terminate all of them. It is
  **deliberately not** gated by `adb.maxHostConcurrent` — that budget bounds
  bursty, short-lived CLI processes, and it has no fleet-size autoscaler the
  way `adb.maxStreams` does; holding a farm-wide slot for a whole session's
  lifetime would silently reintroduce the exact "a cap sized for two
  devices" defect this plan exists to remove, one layer down.

Both `run()` lanes go through a `Semaphore`: `adb.maxHostConcurrent` (default
4) farm-wide, with `lane: 'install'` additionally bounded by
`adb.maxInstallConcurrent` (default 2) farm-wide **and** serialised per
device — a 20-device farm attaching inspectors at once must not fire 40
concurrent `pm install` sessions over one USB controller, but it also must
never let the same device race two installs against each other.

**Stream-lane autoscaling.** `adb.maxStreams` gains the same `0 = auto`
semantics `adb.maxConcurrent` already had — see `packages/adb/README.md` for
`computeAutoStreams` and why its formula differs from the exec semaphore's. A
stored `4` (the old fixed default) is rewritten to `0` by a Zod `preprocess`
(`normaliseLegacyAdb`, `packages/protocol/src/settings.ts`) on first boot
after upgrading — tracked for removal, see `docs/plans/00-overview.md` §9.

**Crash detection that resubscribes instead of dying.** The always-on crash
watcher (plan 37) used to inherit the streaming lane's generic clocks and,
when its stream hit any of them, silently drop its bookkeeping — crash
detection on a session open more than ten minutes was dead with no log line.
`monitor-hub.ts` now lets the `crash` kind override its clocks
(`idleTimeoutMs: 0`, `absoluteTimeoutMs: 0`, `maxBytes: 32 MiB`, all
`crash-watcher.ts` constructor deps in `daemon.ts`), and `crash-watcher.ts`
resubscribes on any unexpected end with exponential backoff (2s → 60s,
doubling per failed attempt, resetting only once a stream genuinely comes
back), logging exactly one `warn` per restart. The new farm setting
`monitor.crashWatch` (`'always' | 'off'`, default `'always'`) lets a
20-device farm trade the detection for the stream slot it costs per device;
`'off'` makes `watch()` a no-op and stops any in-flight resubscribe loop.

**The ui-server watchdog fails slowly.** `packages/drivers/src/inspector/ui-server/watchdog.ts`
gained a circuit breaker: more than `maxRestartsPerWindow` (default 3)
restart *cycles* within `restartWindowMs` (default 10 minutes) moves the
watchdog to a terminal `dead` state — no code path ever resets it back — and
the session falls back to `uiautomator-dump` with one `warn` explaining why.
Backoff between cycles is now exponential (1s, 3s, 10s, 30s) rather than the
old flat 1s/3s, and every cycle spends one unit of the circuit-breaker budget
regardless of whether it goes on to succeed — the old design reset its
failure counter on every restart that itself worked, which is why a device
that degraded every ~35 seconds churned forever without ever giving up.
`packages/drivers/src/inspector/ui-server/client.ts` splits its timeouts by
operation instead of one 3000ms constant for everything: `PING_TIMEOUT_MS`
(1000), `RPC_TIMEOUT_MS` (5000), `DUMP_WINDOW_HIERARCHY_TIMEOUT_MS` (20000 —
a deep hierarchy legitimately takes longer on a loaded phone),
`SCREENSHOT_TIMEOUT_MS` (15000); a `socket connection was closed
unexpectedly` failure — a known, benign symptom of a pooled connection
outliving an `adb forward` torn down by a restart — gets one retry after the
forward is re-asserted, rather than being reported as a device fault.

**Windows diagnosability.** `doctor/context.ts`'s `findPortHolderWindows`
answers "who holds this port" on Windows for the first time, via `netstat
-ano` (pid by port) and `tasklist /FI "PID eq <pid>"` (name by pid) — both
read-only, neither needs elevation, both ship with every Windows install.
`daemon.ts` catches `EADDRINUSE` on listen and reports the holding pid and
image name instead of re-throwing Bun's bare message; `enkaku doctor` uses
the same lookup. `util/data-dir-lock.ts` also probes the configured port when
taking over a stale lock, so "the lock's owner is dead" and "the port is
free" are answered as the two separate questions they are, rather than
proceeding into an unexplained listen failure. At boot, after `ensureServer()`,
every `adb forward` entry whose local port falls in the ui-server range
(`ENKAKU_UI_SERVER_PORT_RANGE`, default 27100–27299) and whose remote is
`tcp:9008` is removed and logged once with a count — `adb forward` entries
outlive a core crash because they live in the adb server, not the core.
Two new doctor checks, `streams` and `host-adb`
(`doctor/checks/streams.ts`, `doctor/checks/host-adb.ts`), report lane
occupancy against budget and orphaned/long-lived adb CLI children.

**Transport observability (85.7a).** A one-way `heartbeat` server message
broadcasts every 15s; Studio's WS client resets a 45s silence watchdog on
*any* inbound message and force-closes the socket on expiry, letting the
existing reconnect path run — this is what makes an open-but-silent
WebSocket (no `onclose` ever fires on one) self-healing instead of an
undetectable hang. `MAX_BUFFERED` in `server/ws-handlers.ts` drops from 4 MB
to 512 KB, so a control reply can no longer queue behind that much
already-buffered video. `GET /api/adb/stats` gains `transport` (connection
count, `bufferedBytesMax`/`bufferedBytesP95`, `videoBytesPerSec`,
`controlReplyMsP50`/`P95`, `watchdogReconnects`) and `hostAdb` (`running`,
`maxConcurrent`, `installsRunning`, `longLived`) blocks. A slow-request
logger warns once (rate-limited) on any HTTP request over 1s or WS command
over 2s.

**85.7b — splitting video onto its own `/ws/video` socket — was designed but
not built.** It is gated on the 10-device rung of the plan's §7.3 ladder
recording control-reply p95 above 500ms with a non-trivial
`bufferedBytesP95`; that rung needs physical Windows hardware and has not
been run. See the plan document's own closing note for the exact trigger.

**Rotation control** (`packages/session/src/orientation.ts`,
`applyRotation`). `DeviceSettings.prep.rotation` (`'device' | 'lock-portrait'
| 'lock-landscape' | 'lock-current'`, default `'device'`, today's unchanged
behaviour) is applied at session start next to `wakeDevice` and reverted on
close next to `svc power stayon false` — both `accelerometer_rotation` *and*
`user_rotation` are read before anything is written and both are restored,
which is stricter than the plan's own §3.7 prose (it only names the former)
and is what the plan's own acceptance criterion 16 actually requires: a
device already manually locked to landscape before the session started needs
its `user_rotation` put back too, not just its auto-rotate flag. `'lock-current'`
reads the live `SurfaceOrientation` and falls back to `lock-portrait` (logged)
when the device has none to read (e.g. asleep at session start) — an
unratified proposal, not a settled product decision (plan 85 §9 Q4).

**Everything above is implemented and unit-tested but not hardware-verified.**
The plan's §7.3 ladder (5 / 10 / 20 real devices on the actual Windows client
with the release binary) has not been run — see the plan document's own
status line and closing section for what that means for acceptance criteria
1–16.
