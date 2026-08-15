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

`/api/devices/:id/guest-agent` reports the pre-plan-90 five states unless `AgentProvisioner.status()` is wired (see below), and the distinction between two of them is load-bearing: **`installed` means the package is present, `ready` means the control channel actually answers.** Collapsing them would report a broken device as healthy. The others are `not-installed`, `unreachable` (installed and bootstrapped but the channel is silent), and `unsupported` (device SDK below the agent's floor, with the reason returned). Once the provisioner is wired (which it is, in production — see below) the response's `state` additively widens to **seven** values, `outdated`/`failed` joining the five above (`GuestAgentStatusResponseSchema`, `@enkaku/protocol`) — never a replacement, so a caller that only knows the original five still parses every response it receives.

`/api/devices/:id/network` applies a SOCKS5 route through the `vpn-helper` engine — a full tunnel via `VpnService`, so an app under test cannot bypass it the way it can ignore `settings put global http_proxy`. Both endpoint groups require the `device.network` permission and a held manual lease (`leases.checkInputAllowed`), the same gate input and shell use.

The response separates **declared** (what was asked for) from **observed** (what the device reports), with a `drift` flag when they disagree — a VPN revoked from Settings, or a tunnel that died, must be visible rather than assumed away. `health` starts at `unverified` and a successful apply does **not** promote it to `ok`: only an egress probe can, and one has run through the tunnel since plan 51. `GET /:id/network` also carries a `recovery` block (`{ attempts, maxAttempts, nextAttemptAt, exhausted, reconnectCycles }`, plan 90 §3.7) — see "Route recovery" below.

Upstream passwords never appear in a response, in the device event log, or in any `meta` field — `redactRouteConfig()` in `@enkaku/protocol` is the single chokepoint. Route state currently lives in memory, so a core restart forgets it (the settings/read-seam half is plan 44 §5.4, deferred), and the lease-teardown revert is wired at two of its four sites, with TODOs marking the rest in `ws-handlers.ts`.

## The agent is a device property, not a session step (plan 90)

Before plan 90, the guest agent was installed only as a side effect of applying a network route — a farm that never configured a proxy had no agent on any phone, which blocked plan 89's screen-label facet outright. `AgentProvisioner` (`packages/core/src/device/agent-provisioner.ts`, `createAgentProvisioner`) makes the agent a property of the device itself, independent of whether a session or a route exists, because a route must survive with no session at all (spec §7.9 rule 1) — so the thing that installs the agent cannot be scoped to a session.

**The algorithm on every pass is `ui-server`'s** (verify → if absent, install → if version/signature mismatch, uninstall/reinstall/re-verify **once** → if still wrong, stop and report, never loop), against `verifyDeviceArtifact` — the identical function `ui-server`'s launcher uses — checked against the toolchain manifest's `deviceArtifact` expectation for `guest-agent`.

**Four hooks, all pre-existing:**

| Moment | Hook | Why |
|---|---|---|
| Admission | `onAdmitted` → `registry.admitted()` → `onOnline()` → `onDeviceReady` | The one moment a phone becomes ours |
| Device online (reconnect) | `onDeviceReady` — the SAME callback `restoreNetworkRoute` already uses | One wire covers both admission-while-connected and every later reconnect |
| Core boot | beside `reconcileNetworkRoutes()`, but for **every** admitted device, not only routed ones | A core upgrade carrying a new pinned APK must reach phones that never disconnect |
| On demand | `POST /api/devices/:id/guest-agent` (fires `ensure({force:true})` as a side effect) and `POST /api/guest-agent/provision` (fleet-wide) | The button an operator reaches for, and its fleet-wide equivalent |

**Failure policy, asserted by test, not merely claimed:** a `failed` agent (install refused, checksum missing, artifact unreadable) leaves `devices.status`/`quarantineReason` byte-for-byte untouched — including when the device was already quarantined for an unrelated reason. A device with no agent, or a failed one, still opens a session, streams video, takes input, runs a job, and answers a shell; only the facets that genuinely need the agent (route, label, keyboard, mock location) report a named precondition. Automatic retries are bounded — 3 attempts on a `[5, 20, 60]`s cooldown, then silent until an explicit `force:true` gives a fresh budget.

**Endpoints** (all beyond the pre-existing `GET/POST/DELETE /api/devices/:id/guest-agent`):

- `POST /api/guest-agent/provision` (`device.admin`) — fleet-wide `ensure()`, returns a per-device `AgentProvisionReport`.
- `GET /api/guest-agent/summary` (`device.view`) — `{ total, byState, byVersion }`, what Settings' "Guest agent" tab renders.
- `POST /api/devices/:id/network/retry` (`device.network`, lease-gated like `enable`) — the honest version of "disable then enable" (plan 90 §3.7 rule 4): clears an exhausted recovery bound and applies once, immediately, without the misleading "route is off" state a real toggle passes through.

**Settings** (`guestAgent`, `packages/protocol/src/settings.ts`): `provision` (`'auto' | 'manual' | 'off'`, default `'auto'`) — `'off'`/`'manual'` make every AUTOMATIC hook a true no-op (zero adb calls), while an explicit `force:true` still works; `maxRecoveryCyclesPerHour` (default 4) — the circuit breaker on how many times a genuine reconnect may reset a route's recovery bound within an hour before the slow re-arm clock takes over (plan 54 §9 Q2's answer: yes the bound resets on reconnect, but bounded by this second, coarser breaker so a device flapping against a genuinely dead proxy still converges); `recoveryRearmSec` (default 120) — replaces the old `max(lastBackoff*5, 60)` derivation with a number someone can argue with. All three are read fresh from `settingsStore.get().guestAgent` on every use, the same freshness pattern every other settings getter in `daemon.ts` follows.

`DeviceInfo.agent` (`AgentState`: `absent | provisioning | ready | outdated | failed | unsupported`) is the narrow, chip-only field every fleet card/wall tile/device header reads — populated by `deriveAgentState()` off the persisted `devices.agent` JSON column (Zod-validated on every read, defaulting to `absent` on a corrupt or pre-migration row) inside `rowToDeviceInfo()`, so every list/broadcast/detail response carries it with no per-call-site threading. Version and capability detail stay on the per-device `GET /:id/guest-agent` endpoint, so the fleet payload does not grow per device.

## Route recovery that knows the device came back (plan 90 §3.7)

The pre-plan-90 defect: a reconnect never reset a network route's recovery-attempt counter (`resetRecovery` only fired on the *disabled* branch), so a 90-second dead-man's-switch trip from a USB blip could leave a route dark for a full `RECOVERY_REARM_S` (5 minutes, a derived number nobody chose) — fixed only by an operator noticing and toggling the route off and on. The fix distinguishes two cases the old code conflated: `handleDeviceOffline` now stamps `offlineAt` on the recovery state (without deleting it — the state itself is what stops a flapper), and `restoreDeviceRoute`'s enabled branch resets `attempts`/`exhausted` **only when `offlineAt > exhaustedAt`** — a genuine disconnect after the give-up, never merely because a heartbeat ran. Each such reset increments an hourly-decaying `reconnectCycles`; past `guestAgent.maxRecoveryCyclesPerHour` resets stop and the plain re-arm clock takes over, with one `warn` naming the count — so a device flapping against a genuinely dead proxy still converges instead of retrying forever (plan 54 §9 Q2's fear, answered rather than reintroduced). `network.recovery.exhausted`/`network.recovery.recovered` are new main-stream device events, so "why was this device dark for four minutes" is answerable from the Logs tab after the fact.

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

Every session also has a **quality profile** (`control` | `wall`), which maps to `max_size`/`max_fps`/`video_bit_rate` on the scrcpy server. `control` is what the device page always asks for; `wall` is what the fleet Wall asks for, so many low-rate tiles can decode in one browser tab. The manager's rule: a device already at `control` quality is shared as-is with a `wall` request — **never** restarted or downgraded for a colleague's wall tile — while a `control` request against a `wall`-quality session restarts it at `control`, carrying existing viewers (e.g. a wall tile) over onto the new session rather than dropping them. `stream.start`'s `quality` payload field defaults to `control`; `stream.started` always reports back the quality actually granted.

**Plan 92 §3.5, §4.1–§4.2** replaced the two fixed constants behind `control`/`wall` with farm settings: `FarmSettings.video` (eight flat fields — a preset per profile plus its three numbers, `controlPreset`/`controlMaxSize`/`controlMaxFps`/`controlBitRate` and the `wall...` equivalents) plus an all-optional `DeviceSettings.video` override. `packages/session/src/video-profile.ts`'s `resolveVideoProfile(farm, device, quality)` is the one place the two are combined — its preset tables (`CONTROL_PRESETS.sharp`, `WALL_PRESETS.balanced`) are the exact numbers the old constants held (1600px / 30fps / 4Mbps; 480px / 5fps / 800kbps), so a farm that changes no video setting sees byte-identical scrcpy arguments. `SessionManagerDeps.resolveProfile` resolves this fresh for every session build; `CreateSessionOpts.videoProfile` carries the result into `createSession`, which hands it straight to `makeScrcpy` — there is no `QUALITY_PROFILES` lookup table left anywhere in the codebase.

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

## The output contract: what a script returns, and who may believe it (plan 97, M62)

`packages/sdk/README.md`'s "Declaring a result" is the authoring side; this is where the core independently re-checks and stores what the child claims. `packages/core/src/jobs/result-store.ts`'s `recordResult` is this plan's own `Ships:` artefact — pure, unit-tested alone — and is the ONE place a child's self-reported `ResultOutcome` becomes the four `jobs.result_*` columns (`resultStatus`/`resultBytes`/`resultSummary`/`resultIssues`; `result` itself is the pre-existing column). It does not trust the child's claim blindly: it independently re-measures `bytes` from whatever value it actually received and re-derives `status`, overriding a child's stale or wrong claim to `oversize` whenever the re-measured size exceeds `job.maxResultBytes` — dropping the value even if one was, incorrectly, sent. This is the "the parent re-checks what it can cheaply and independently know" half of plan 97 §3.8's trust position; the child's claim about whether the value *matches its own declared schema* is taken on trust, because only the child holds the real Zod schema (`.refine()` included) at the same instant it holds the real value.

`ExecutorHost`'s settle path (`jobs/executor-host.ts`) calls `recordResult` at the same single `deps.jobStore.finish(...)` seam every other settle-time column already writes through — never a second write, never a race with the main settle. `ExecutorContext.onResultOutcome` is the callback an executor uses to report one (`executors/script.ts` and `executors/remote.ts`, the cloud/node path, both wire it); `JobExecutor.run()`'s own return type was deliberately NOT widened to carry the outcome inline, because that interface is shared by five unrelated executors (`sleep`, `install`, `workflow`, `remote`, `script`) and widening it would have been a breaking change for a concept only two of them have — see `executor.ts`'s own doc comment for the full reasoning. A missing outcome on a successful settle (any executor that never calls `onResultOutcome`, or a script built by a pre-plan-97 bundle) is written as `resultStatus: 'undeclared'` — a total answer for every successful settle, never a partial one.

**A failed or cancelled settle can carry a result too** (`resultStatus: 'partial'`, plan 97 §3.5) — a salvage value the runner reports alongside the failure, riding the thrown error as a `partialResult` property the same way `code`/`phase` already do, since `JobExecutor.run()` rejects on failure and has no resolved return value left to attach one to. `recordResult` refuses to let a computed `'partial'` downgrade an already-recorded `'valid'` status (`existingStatus`, defensive against `finish()` re-running in a fresh process after a timeout kill, spec §11.2) — returning `null` in that one case, which the caller reads as "nothing to report," leaving every `result_*` column untouched.

`packages/core/src/scripts/publish-result-e2e.test.ts` is the end-to-end proof that the publish-time storage half (`scripts.result_schema`, written at `scripts/routes.ts`'s `POST /` alongside `paramsSchema`, gated by the same `checkDeclaredSchema` limits under `E_RESULT_SCHEMA_INVALID`) actually reaches `GET /api/jobs/:id`: it publishes a script declaring `result` through the real route, settles a job through the real `recordResult`, and asserts `rowToJobDetail` — the exact function the route serves from — returns a non-null `resultSchema` equal to what was published, pinned to the version that ran (`queue/job-store.ts`'s `scriptNames()` selects `resultSchema` off the `scripts` row the job's `scriptId` points at, the same one-row-per-version join `paramsSchema` already used, so no drift is possible even after a later republish). `GET /api/jobs` (the list) carries `resultStatus`/`resultSummary` only, never `result` or `resultSchema` — the same "detail-only" discipline `result` itself has always had.

**Known gap, not this plan's file-ownership to close:** `packages/core/src/mcp/server.ts`'s `tools/list` does not yet advertise a per-tool `outputSchema`, even though `tools/call` already emits `structuredContent` and `toJsonSchema(cap.output)` is already computed for `GET /api/v1/cap` — the wiring is one field away, named and left for whoever holds `core/src/mcp/**` next.

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

## Connection, the address book, the sweep, and adb server control (plan 88)

`docs/plans/88-m53-transport-discovery-and-adb-control.md` carries the full
evidence and design; this section documents what actually shipped. As of
this revision the OTG **cutover wizard** (`registry/cutover.ts`,
`CutoverDialog.tsx` — arm TCP mode → have a human flip the chassis port →
watch the device come back) is **not** part of it — that step is still in
progress, tracked separately in the plan's own status line.

A second gap, easy to miss because the code on both sides of it is real and
tested: `device-registry.ts`'s `deriveConnection(serial, networks)` correctly
computes `medium`/`mediumSource` from a farm-network match, but every
production caller of `listDevicesWithTags`/`rowToDeviceInfo` (`daemon.ts`'s
`listDevices`, `capability/context.ts`, `api/topology.ts`, and
`device-registry.ts`'s own default export at line 615) passes no network
list at all — so `mediumSource` is `'unknown'` for every device Studio
actually renders, regardless of what is configured under Settings → Farm
networks. The declared-medium half (`PATCH /:id/connection` → the endpoint
store) has the identical problem: it writes, but `deriveConnection` never
reads it back. Both are wired to nothing; a device's badge is USB or TCP
only until one of them is threaded through a real call site.

**The address book** (`registry/endpoints.ts`, `EndpointStore`, table
`device_endpoints`) exists because adb forgets a TCP device's address the
moment it disconnects, and until this table, so did Enkaku — a wired or
wireless phone that came back on a new DHCP lease was unreachable by any
code path in the repo. `observe(stableId, serial)` is called for free from
the registry's own successful-probe path whenever the serial is `host:port`
shaped — no extra adb work, no new probe. Rows are keyed on `(stableId,
address)`, exactly like `blocked_devices`/`discovered_devices`, so an
address survives a serial change, a forget/re-admit cycle, and a transport
switch. Eviction happens inside the store itself, capped at
`discovery.endpointsPerDevice` (default 4) per device, oldest
`lastConnectedAt` first — there is no CHECK constraint, since the cap is a
live setting.

**The reconnect ladder** (`registry/reconnect.ts`, `DeviceReconnector`) is
what reads the address book back. `reconnect(stableId, opts)` runs cheapest
first: already-connected is a zero-work short circuit; failing that, every
remembered address is tried newest-first, each behind a cheap TCP pre-probe
(`Bun.connect`, `discovery.scan.probeTimeoutMs`, default 300ms) — load-bearing,
not an optimisation, because a raw `host:connect` against a genuinely dead
address can block the *entire shared adb server* for tens of seconds to well
over a minute (measured directly, see the plan's H5 write-up); only a probe
that accepts ever reaches a real `host:connect`. An address that answers as
a *different* `stableId` is disconnected immediately, recorded as a
conflict, and never adopted here — the ordinary Discovered-tray admission
gate is the only place that happens. Only when explicitly permitted
(`opts.allowSweep`) does step 4 fall through to the sweep below. A
per-`stableId` mutex means an operator double-clicking Reconnect, an armed
cutover window, and the restart flow's own reattach pass can never triple-dial
the same phone. `disconnect(stableId)` is the other half: it drops a `tcp`
device's transport and refuses outright on `usb` (`E_TRANSPORT_NOT_DETACHABLE`)
— adb has no host service that releases one USB transport, and a button that
quietly did something else would be worse than an honest refusal.

**The bounded sweep** (`registry/sweep.ts`, `Sweeper`) is the operator-triggered
subnet scan (`POST /api/devices/scan`), bounded on every axis the plan's §3.5
names: singleton (one sweep farm-wide behind a mutex), an explicit address
space only (`discovery.networks[]`, never auto-derived from the host's own
subnets), a hard ceiling (`scan.maxAddresses`, enforced as a Zod cross-field
refinement at save time), bounded concurrency behind the same cheap pre-probe
the ladder uses, and **on-demand only** — `scan.mode` is `'off' | 'on-demand'`,
full stop. There is no `'auto'` mode and no cooldown to gate one: the owner's
decision (plan 88 §9 Q1, 2026-08-12) was that this feature is manually
triggered, not manually triggered *plus* a background cadence nobody enabled.
A sweep can never enlarge the farm: every identified `stableId` unknown to the
registry goes through the exact same admission gate (plan 56) as any other
new phone.

**adb server control** (`tools/adb-server-control.ts`, `cycle()`) is now the
**one** function in the workspace that runs `adb kill-server` (spec §10.4) —
shared by exactly two audited entry points: the Toolchain Manager's adb
version swap (`tools/adb-swap.ts`, now a thin wrapper) and the operator's
`POST /api/tools/adb/restart` on the Tools page. Both flows are the same
seven steps with one optional extra: drain → stop → [swap the binary
pointer] → start → reattach → reconcile. The drain now genuinely includes
live sessions and leases (`drainSessions`, wired in `daemon.ts` — an unwired
optional dependency since M1, per the plan's F19); the reattach step dials
every address the endpoint book remembers, which is the entire reason the
OTG half and the restart half of this plan are one plan and not two — without
it, restarting adb on a 20-device OTG chassis would come back as 20 offline
rows. A workspace-wide guard test
(`tools/adb-server-control.test.ts`) walks every package's `src/`, strips
comments, and asserts the literal `kill-server` string appears in exactly
this one file — the guard plan 01 §398/§494 specified and that, until this
plan, was never built.

**adb server health** (`device/adb-health.ts`, `AdbServerHealth`, surfaced at
`GET /api/adb/stats`'s `adbHealth` block and a read-only `enkaku doctor`
check) answers "is adb stuck, and would restarting it help" with five named
symptoms (`server-unreachable`, `server-unresponsive`, `transports-wedged`,
`reconnect-ineffective`, `timeout-storm`) computed from a new ten-bucket,
60-second-per-bucket rolling window on the existing `adb-metrics.ts`
`record()` feed — not a second counter. Only two of the five symptoms
actually recommend a restart; the other three explain, in the remedy text
itself, why restarting will not help (a merely-absent server already
self-heals via `ensureServer()`, for instance). The doctor stays a pure
diagnostic: it reports the verdict and names the Tools action, and never
performs it itself.

## Co-control (Assist) and mirror groups (plan 91)

`docs/plans/91-m56-co-control-and-mirror-input.md` carries the full evidence
and design; this section documents what actually shipped. Two new,
cooperating subsystems — the grant, and the group — plus the input arbiter
that makes both safe (`@enkaku/session`'s three input lanes,
`packages/session/README.md`).

**The grant** (`lease/co-control.ts`, `CoControlManager`). A co-control grant
is a *third* authorisation object, not a lease variant: `grant()` never calls
`leases.acquireManual` and never touches `DeviceStatus` — it hands out
exactly the five input verbs (tap/swipe/gesture/key/text) against a device
someone or something else already holds, refusing `assist_not_allowed` /
`assist_taken` / `assist_denied_by_script` / `device_not_held` as
appropriate. `checkAssistAllowed(deviceId, clientId)` is consulted from
**exactly one place**, `ws-handlers.ts`'s `input.*` branch, and only as a
fallback once `leases.checkInputAllowed` has already refused — `shell.exec`,
`inspect.*`, `clipboard.set`, the transfer routes, and the adb endpoint were
never given this fallback and still call only the lease gate, so co-control
cannot widen any of them by construction. `ws-handlers.assist.test.ts` proves
this directly (the containment test): a client holding only a grant is
refused `shell.exec`/`inspect.attach`/`clipboard.set`/`POST :id/push`/`POST
:id/adb-endpoint` — all five, one test, same device, all `device_busy` —
while its `input.tap` succeeds.

**A grant can never outlive the hold it was subordinate to** — the property
this file exists to guarantee — proven for **five** independent end paths,
not four: the grant's own TTL expiring (`startReaper`, a ~5s sweep), the
assisting client's WebSocket closing (`releaseAllForClient`, the same
WS-close path the lease manager already has), the assisting operator
releasing it voluntarily (`release()`), the primary hold ending the ordinary
way (`onPrimaryEnded`, wired from `lease-manager.ts`'s `release()` and
`clearJobLease()`), and a **lease takeover** — found and wired separately
during this plan's own work, because a successful takeover's compare-and-swap
acquisition never calls `release()` at all, so `daemon.ts`'s
`onManualTakenOver` handler calls `coControl.onPrimaryEnded(deviceId)`
directly rather than relying on the release path to reach it. `assistedBy(deviceId)`
is the read side, threaded through every router that builds `DeviceInfo`
(`api/devices.ts`, `api/topology.ts`, `api/clusters.ts`,
`capability/context.ts` — the last three were a known gap this plan's own
step 91.4 flagged and left; closed 2026-08-13, see
`docs/plans/96-m61-hotfixes.md` §96.10). `maxConcurrentPerDevice` (default 1,
max 4) bounds how many clients may hold a grant on one device at once — not a
safety limit (the arbiter already serialises concurrent writers) but an
attribution one: past 1, nobody can say whose tap did what.

**Attribution** rides on the job's own row rather than a new table:
`jobs.assistCount` (migration `0046_watery_quentin_quire.sql`) increments on
every accepted assist action whose primary hold is a job; the same action is
written to that device's `input`-stream `device_events` with `meta.assist:
true`/`meta.jobId`, read back as `GET /api/jobs/:id/assists` (`job.view`) —
an indexed range scan over `idx_device_events_tail(deviceId, stream, at)`
bounded by the job's own `startedAt`/`finishedAt`, no JSON extraction, no new
index. `AuditEntrySchema` gained `meta` in this plan so the bookend
`device.assist` audit rows (recorded for `started`/`released`/`disconnected`
— `ttl` and `primary_ended` are NOT audited, a known, flagged gap, since
their only trigger points are the reaper and `onPrimaryEnded`, both reached
only through `daemon.ts`'s broadcast-only hooks) can actually be read back
naming the job, closing a pre-existing defect (F24) where `meta` was written
to `audit_log` but dropped by the API schema.

**Mirror groups** (`mirror/group.ts`, `MirrorManager`) are one operator
driving many phones from one focused view. `mirror.start` resolves every
requested device **independently** against §3.9's table (idle → an ordinary
manual lease; busy or held → an ordinary co-control grant, never a takeover;
offline/quarantined/mid-`internal:install`/node-owned → skipped by name) and
reports one outcome per device — never a silent drop. No multi-device lock is
acquired anywhere: every member gets exactly the same lease or grant a
single-device operator would get, through the exact same doors, and
`dispatch` trusts that authorisation for the group's whole life rather than
re-checking the gates on every action, because nothing in this file can ever
grant more than those two functions already would for one device.

`dispatch`'s per-lane orientation gate (§3.7) withholds pointer actions
(tap/swipe/gesture) from a member whose orientation disagrees with the
focused device's, naming it `orientation_mismatch` — keys and text still go
through, since a keycode has no geometry to disagree about. A member's aspect
ratio is compared once, at `mirror.start`, against `mirror.aspectTolerance`
and flagged (`aspectDrift`) rather than blocked, because for a scaling layout
the normalised coordinate is still correct and blocking on a 5% shape
difference would exclude most real fleets. A member that fails
`mirror.dropAfterConsecutiveFailures` (default 3) consecutive dispatches
leaves the group with one message naming it — `reconcile(deviceId)` is the
other direction, re-admitting a member whose blocker cleared (a job ended, an
`internal:install` finished), wired to `daemon.ts`'s existing
`onJobFinished` forward-ref so no client has to ask.

**Mirrored actions are recorded per-device, not in one aggregate row** —
`mirror/group.ts`'s own header comment states the reasoning directly:
`device_events` has no field for "N devices", every row belongs to exactly
one `deviceId`, so an aggregate row parked on the focus device would leave
every *other* member's own Device Log blind to input it visibly received,
and would make a mirrored assist on a job-busy member invisible to `GET
/api/jobs/:id/assists`, which finds assists strictly by `deviceId`. `dispatch`
therefore records one `device_events` row per successfully-delivered
per-device action (the same `kind`/meta shape the single-device `input.*`
branch uses, plus `meta.mirrored: true`/`groupId`), and increments
`jobs.assistCount` per `assist`-mode member whose primary hold is a job — on
delivery success, never before, since a member that never received the
action has nothing honest to report. `audit.record` is deliberately not
called per mirrored action, for the same reason ordinary manual input is
never audited either: audit is for the grant/release boundary, not every
tap. Write amplification is stated plainly rather than hidden: up to
`mirror.maxDevices` (20 default, 64 ceiling) `device_events` rows per
mirrored action, landing in the same buffered-transaction recorder every
concurrent human operator's input already shares — identical cost to 20
separate operators tapping 20 separate devices today, not a new scaling
problem this plan introduces.

**Settings** (`coControl`/`mirror` blocks, `packages/protocol/src/settings.ts`):

| Block | Field | Default | What it controls |
|---|---|---|---|
| `coControl` | `mode` | `'operator'` | `'off'` disables assisting farm-wide; `'admin'` restricts it to the admin role; `'operator'` (default) allows any role holding `device.assist` — checked together by `canAssist(role, mode)`, the same shape `shell.mode`/`canUseShell` already established. |
| `coControl` | `grantTtlSec` | 300 | How long a grant survives with no activity before it expires on its own. |
| `coControl` | `maxConcurrentPerDevice` | 1 (max 4) | How many clients may hold a grant on one device at once. |
| `coControl` | `queueWaitMs` | 5000 | The input arbiter's per-lane wait budget before refusing with `E_INPUT_BUSY` (`packages/session/README.md`). |
| `coControl` | `maxQueueDepth` | 32 | How many actions may be queued (not counting the one running) per lane. |
| `mirror` | `maxDevices` | 20 (max 64) | How many devices one mirror group may contain. |
| `mirror` | `requireSameOrientation` | `true` | Whether a rotated member is withheld from pointer actions (keys/text are unaffected regardless). |
| `mirror` | `aspectTolerance` | 0.05 | The `max(w,h)/min(w,h)` difference from the focused device above which a member is flagged `aspectDrift`. |
| `mirror` | `dropAfterConsecutiveFailures` | 3 | How many consecutive failed dispatches drop a member from the group. |

`coControl.queueWaitMs`/`maxQueueDepth` reach the real arbiter on every
session via `SessionManagerDeps.arbiterQueueWaitMs`/`arbiterMaxQueueDepth`
(both `() => number`, read fresh) — this wiring was itself a known gap
through most of this plan's own steps (the arbiter ran on hardcoded
`5_000`ms/`32` defaults regardless of what an operator configured) and was
closed 2026-08-13, see `docs/plans/96-m61-hotfixes.md` §96.13 and
`packages/session/README.md`.

**Endpoints and observability.** `GET /api/jobs/:id/assists` (`job.view`) —
see Attribution above. `GET /api/adb/stats` gains an `input` block: `lanes`
(keyed by `pointer`/`keys`/`text`, each `{ depth, waitMsP50, waitMsP95,
refusals }`, the WORST value observed across every live session's own local
arbiter — there is no farm-wide arbiter, so summing/averaging would smooth
away exactly the contention this block exists to surface),
`assistsActive`/`mirrorGroups`/`mirrorMembers`/`mirrorFanoutMsP50`/`P95`,
plus `queueWaitMs` (the farm's configured budget, so a caller can compare
like-for-like without a second fetch) and two leak-detector counts,
`uncollectedGrants`/`orphanedMirrorGroups`. `doctor/checks/co-control.ts`
reads the same block and reports `warn` (never `fail` — budget pressure and
a leak are both actionable-but-not-fatal, matching `streamsCheck`'s own
precedent) when a lane's `waitMsP95` exceeds half the configured
`queueWaitMs`, or either leak count is nonzero, naming the lane/counts in the
remedy.

## The command console and bulk operations (plan 93, M58)

`docs/plans/93-m58-command-console-and-bulk-operations.md` carries the full
evidence and design; this section documents what actually shipped as of
step 93.9. **93.11 (Studio's bulk-operations surfaces — `ArtifactPicker`,
`BulkTransferDialog`, the batch detail page's collected-files table, the
fleet toolbar's Push file…/Pull file… entries) is NOT built yet** — nothing
below should be read as claiming those exist. **93.10 (the archive/download
surface) is also incomplete, checked directly against the tree rather than
assumed**: `api/zip-stream.ts` (the STORED-zip writer) exists as a standalone
file, but it has no test file, is not imported by `api/batches.ts` or any
other route, and `GET /api/batches/:id/artifacts`/`.../artifacts.zip` do not
exist — a bulk pull's files are only reachable one at a time, per artifact,
today. `api/artifacts.ts` also has no `?kind=upload` query yet (F14 stays
open). None of `zip-stream.ts`, `api/artifacts.ts`, or `api/batches.ts` are
this documentation step's files to fix.

**Fan-out is a run, not a job.** A batch (plan 20) member is a job: it takes
a job lease, flips the device to `busy`, and is claimed by a scheduler tick
— correct for a 90-second APK install, wrong for a 200ms `getprop`. A
**command run** (`command_runs`/`command_run_members`,
`command-console/store.ts`) is the shape that fits a fan-out shell command:
one row per run, one row per targeted device, no job, no scheduler
involvement — `command-console/runner.ts`'s `createCommandRunner` drives a
bounded worker pool (`MAX_POOL_CONCURRENCY` 32) directly against
`ShellPort.exec`.

**Admission is the same three-branch policy the terminal already uses**
(`admitMember`, exported standalone from `runner.ts`): a device the caller
already controls runs immediately, with no lease acquire and no release; an
idle device is acquired with `Lease.purpose: 'command'` for the exact
duration of that one exec and released in a `finally`, even when the exec
throws; a device controlled by someone else, or running a job, is `skipped`
with `checkInputAllowed`'s own code and message verbatim — never taken
over. `POST /api/command-runs` (`api/command-runs.ts`) runs the full gate
order — role, `shell.mode`, `shell.fanoutEnabled`,
`shell.fanoutMaxDevices`, `canUseDevice` per resolved target, and (§3.14)
the high-consequence acknowledgement — before calling `commandRunner.start()`,
so nothing is written until every gate passes.

**The high-consequence guard is advisory and client-side, not a block.**
`isHighConsequence(cmd)` (moved into `@enkaku/protocol` from
`TerminalPane.tsx`) names what matched — `{ hit, pattern }` — and the REST
layer requires an explicit `acknowledged: true` on the request whenever the
target has more than one device and the command hits the guard. It is a
scale confirmation ("you are about to run this on N devices, say so"), not
a security judgement: any client can set the flag, and the server never
refuses a command for being dangerous, only for being un-acknowledged at
scale. The acknowledgement and the matched pattern (if any) are recorded on
the run and in the `command.run` audit action either way.

**Output is subscriber-scoped**, deliberately unlike `transfer.progress`
was before step 93.9's own fix (see below): `ws-handlers.ts`'s
`command.subscribe`/`command.unsubscribe` register a connection against
`commandTargets(runId)`, and `broadcastCommand(runId, msg)` reaches only
those subscribers — never `hub.broadcast`. A 100-device run's live payload
is sized against `MAX_BUFFERED` (512 KB, plan 85): progress is coalesced to
at most one frame per 250ms per run, and full per-device stdout/stderr is
never pushed over the socket at all — only a hashed, capped preview
(`shell.fanoutPreviewBytes`, default 2 048 bytes) for each **distinct**
output, fetched over HTTP (`GET /:id/members/:deviceId/output`) on demand.

**A run's cancel reaches a real `AbortSignal` on the exec**, not just the
stored row: `cancel(runId)` aborts every in-flight member's
`AbortController`, force-settles every `pending`/`running` member to
`cancelled` synchronously, and never starts a member that has not begun.

**Staged rollout** (`stageFirstN`) runs the first N members, then stops at
`awaiting-continue` — holding no lease while it waits — until the operator
calls `continue` or `cancel`, or `shell.fanoutStageWaitSec` (default 900s)
elapses and the runner cancels the remainder itself.

**Saved commands** (`saved_commands`, `command-console/saved.ts`,
`api/saved-commands.ts`) are a farm asset, not a personal bookmark: named,
described, visible to everyone, editable only by their owner or an admin,
gated on `canUseShell` at create time so nobody can save a command they
could not run. No `dangerous` field is stored anywhere — high-consequence-
ness is derived fresh from `cmd` every time it is rendered or run, so it
can never go stale when the guard's own patterns change.

**Bulk push and pull** (`jobs/executors/push.ts`/`pull.ts`, step 93.9) are
near-copies of the existing bulk-install executor, sharing its `{ gate:
'files', setting: 'transfer.enabled' }` declaration (`JobExecutor.requires`,
step 93.8) so all three transfer executors close the same permission hole
bulk install used to have (F10: `POST /api/batches` used to check only
`job.run`, bypassing `device.files` and `transfer.enabled` entirely — now
checked at every real dispatch site: `POST /api/jobs`, `POST /api/batches`,
`POST /api/schedules` create/patch, and the cron-fired schedule runner).
`registerDeviceArtifact` now takes a required `jobId: string | null`, so a
file a bulk pull collects is linked back to the job that pulled it —
`GET /api/artifacts?jobId=...` can answer "what did this bulk pull
collect", where before it silently wrote `jobId: null` forever (F12).
`transfer.progress`/`transfer.done` are scoped to viewers of the device the
same way `shell.result` already is (`daemon.ts`'s `broadcastTransferEvent`
forward-ref calling `handler.broadcastTransfer`) — the farm-wide
`hub.broadcast` those two messages used before (F27) is gone from every
transfer code path (`device/transfer.ts`, `device/transfer-dispatch.ts`,
the three `jobs/executors/{push,pull,install}.ts`).

**A batch no longer silently forgets a skipped device** (F11 closed, step
93.8): `batches.skipped` persists `resolved.skipped` (device id + reason),
on the wire on both create and `GET /:id`. `POST /api/batches/:id/rerun?
only=failed|skipped` retargets exactly that subset — `only=skipped` reads
the batch's own persisted `skipped` column, so a device that came back
online since the original dispatch is correctly retargeted, and one still
offline correctly refuses with `E_NO_TARGETS`.

**A core restart never leaves a command run `running` forever**:
`commandRunner.sweepOrphans()` runs in the same boot-recovery phase
`jobStore.failOrphanRunning()` already opens, marking every non-terminal
run `cancelled` and explaining every unfinished member — the same
`failOrphanRunning` precedent (F29) applied to a second kind of row.

**Settings** live under the existing `shell` block
(`packages/protocol/src/settings.ts`) rather than a new top-level one,
because "can people run commands on the whole farm" is a Device-terminal
question in an operator's head, and the gates are the same gates:
`fanoutEnabled` (default `true` on loopback, forced `false` in server mode
by `createFarmSettingsStore` — see `docs/guide/install.md`'s own section for
the reasoning), `fanoutMaxDevices`, `fanoutConcurrency` (0 = let the adb
exec semaphore decide, no second concurrency mechanism), `fanoutMaxOutputBytes`,
`fanoutPreviewBytes`, `fanoutConfirmThreshold`, `fanoutStageWaitSec`,
`commandRunsPerUser` (500, trimmed on insert), `savedCommandLimit`.
`retention.commandRunDays` (14) sweeps old runs regardless of
`retention.enabled` — the same "not gated by the master switch" precedent
`retention.eventInputDays` already sets.

**Measurement** (§5 step 93.12): `GET /api/adb/stats` gains a
`commandConsole` block — `runsInFlight`, `membersInFlight`,
`coalescedFramesPerSec` (H2: the coalescer's own effect, measured — the
spec's own ceiling is ≤4/s at 100 members), `distinctOutputRatio` (H1: near
1.0 on a real farm means grouping is not helping and the console's default
should flip to a flat table), and `leaseChangedPerMinute` (H4: the
per-member acquire/release traffic this feature's own lease policy adds,
each short hold counting the one broadcast its grant produces and the one
its release produces, mirroring the two real `lease.changed` broadcasts
production already sends for any manual hold). **This block is wired in
`command-console/runner.ts`'s `CommandRunner.stats()` and in
`api/adb-stats.ts`'s optional `commandConsole` dep, but `daemon.ts` — held
outside this documentation step's file ownership — does not yet pass
`commandConsole: () => commandRunner?.stats() ?? null` through**, so a real
boot reports the block zero-filled until that one line lands (tracked,
self-detecting, in `api/adb-stats-command-console-wiring.test.ts`). The
§7.3 fan-out ladder (5 / 20 / 100 devices, against real hardware) that these
numbers exist to fill in has not been run — see the plan's own status line
for the exact commands and the empty outcome table.

## Workflows — a pipeline of scripts, one job, one lease (plan 99, M64)

`docs/plans/99-m64-workflows.md` carries the full evidence and design;
`packages/protocol/README.md`'s own Workflows section documents the document
shape, the two closed grammars, and the no-code-evaluation rule. This section
documents the executor, `job_nodes`, resume, and the two new farm settings —
what actually shipped, which in a few places is not what the plan first
proposed.

A workflow publishes as an **ordinary `scripts` row** (`kind: 'workflow'`,
default `'script'` for every other row) whose `bundle` holds a validated
`WorkflowDoc` instead of an ESM bundle. It runs through
`jobs/executors/workflow.ts`'s `createWorkflowExecutor`, registered in
`daemon.ts` as the `kind: 'workflow'` fallback beside the ordinary script
executor — **one job, one lease, one device, for the whole pipeline**, not
one job per node. `sessions.acquire(deviceId)` is called exactly **once**,
before the first node, and released in a `finally` after the last one; every
node still runs as its own child process through the SAME `JobRunner.execute()`
a standalone job uses, so each node keeps its own crash containment, timeout,
retries, and `finish()` — only the outer session hold, the lease, and the
job id are shared. A gate spawns no child and makes no device call; it is
evaluated in-process, in microseconds, from values the pipeline already has.

**`scripts.kind` is read in exactly four places** — `jobs/executor.ts`'s
`ExecutorRegistry.get()` (executor selection), the workflow/script publish
routes, Studio's list/run-dialog filter, and
`packages/protocol/src/workflow-check.ts`'s `E_WORKFLOW_NESTED` check (a
nested workflow is refused at publish, and detecting it needs the same
`kind` fact `checkWorkflow` already carries in its `resolved` map — hoisting
that comparison into a route would either duplicate the check or defeat the
whole point of Validate and the publish gate running the identical
function). This list is a **falsifiable claim, not a target**: a repo-wide
search for the literal comparison `kind === 'workflow'` outside those four
files is expected to return nothing, and if it ever does, the containment
this design depends on has drifted.

### `job_nodes` — one row per node *execution*

Not one row per node — a `goto` loop runs one node several times, and each
run is its own fact, modelled on `schedule_runs`' own "never a blank gap"
rule. Every transition is written to `job_nodes` **before** the cursor
moves, so a core crash mid-pipeline leaves a readable record. A gate's row
carries the resolved left/right values, the operator, and the branch taken
(`verdict`, a `PredicateTrace`) — Studio renders it as one sentence, e.g.
`enough-videos — scroll1.videos (12) >= 10 → continue`. A node's own output
is capped at `workflow.maxNodeOutputBytes` (below); a cap is recorded, never
silent. `artifacts.nodeId` (nullable) groups a node's own screenshots the
same way, with no new artifact table. `GET /api/jobs/:id/nodes` (`job.view`)
returns `{ items, finalized }` — never a 404 for "no nodes yet", only a
missing job is.

### Resume — a new job, and two facts that are easy to assume wrong

`POST /api/jobs/:id/resume` (`job.run` plus the same device-ownership check
`/:id/cancel` uses) never mutates or restarts the original job. It refuses
`409` while the original is not terminal, and `400` when the requested
`fromNode` never actually ran in it (a node a gate steered around does not
count); omitted, it defaults to the last node the job actually attempted.

**A resumed job still runs the pre-job reset on its first real execution.**
Between the original job and the resume, the device may have run other
jobs, been used manually, or sat untouched for a week — nobody can vouch for
its state, so the interpreter's own step counter restarts at 0 for the
resumed job, and `reset: node.reset ?? (step === 0 ? 'farm' : 'none')` fires
exactly as it would for a brand-new run. This is deliberate, not an
oversight: skipping the reset on resume would mean trusting a device's
state across a gap the design explicitly says nobody can vouch for.

**Resume copies the original job's *resolved* `scriptId` — it never
re-resolves `@latest`.** A pipeline published as `tiktok/warmup@latest` and
resumed a week later runs the **exact same code** it started with, even if
a newer version has since been published. `resumedFromJobId`/
`resumedFromNode` are recorded on the first `job_nodes` row the resumed job
writes, and every node before the resume point is written as
`'skipped-on-resume'` — **not** the same status as `'skipped'`. A `'skipped'`
row means the cursor never reached that node because a gate branched away
from it; a `'skipped-on-resume'` row means the node genuinely ran in the
*original* job and its output was carried forward, not re-executed. Studio
renders the two distinguishably (different words, different tones — never
red or amber for the deliberate case), and a `'skipped-on-resume'` row links
back to `resumedFromJobId` so the lineage is readable.

### Static checking, and the one check that only works because of plan 98

`POST /api/workflows/validate` and the publish gate (`POST /api/workflows`)
both call the same `checkWorkflow` — **every finding is returned, never just
the first**, so an author fixing a workflow gets one list instead of one
error per round trip. `E_WORKFLOW_BUDGET_IMPOSSIBLE` (the sum of a
workflow's node timeouts against `workflow.maxTotalMs`) was a documented,
unimplementable gap through most of this plan, because nothing persisted a
script's declared `timeout` anywhere readable at publish time — it works
**now**, unblocked once plan 98 started persisting `scripts.runtime`
(`ScriptEntry.runtime?.timeoutMs`). The one thing worth knowing: **a node
whose script declares no timeout makes the whole sum uncheckable, not zero**
— reported once as `W_WORKFLOW_BUDGET_UNKNOWN`, naming every node
responsible, rather than silently passing a workflow that might not fit or
silently refusing one that might.

### Settings

Two fields, both under a new top-level `workflow` block
(`packages/protocol/src/settings.ts`), both plan-95 `ui()`-hinted so they
render in Settings with no Studio change:

| Field | Default | What it controls |
|---|---|---|
| `maxTotalMs` | 21 600 000 (6h) | How long one workflow job may hold a device before it fails `E_WORKFLOW_BUDGET_EXCEEDED`, naming the node in flight. Separate from a single script's own `job.maxTimeoutMs` — one node's timeout answers "how long may one script run", this answers "how long may one device be held by one pipeline". |
| `maxNodeOutputBytes` | 262 144 (matches `shell.maxOutputBytes`) | How much of a node's returned value is kept for a later node to read via `{ from }`. Anything larger is truncated, and the truncation is recorded on the `job_nodes` row rather than silently dropped. |

Read fresh on every check (`() => settingsStore.get().workflow`), the same
freshness pattern `resetPolicy`/`adb.maxConcurrent` already use — a farm
that changes the budget mid-pipeline is honoured on the next node, not only
on the next job.

### What this does not yet do

A workflow job does not run on a node-owned (cloud) device: unlike the
script executor beside it, `createWorkflowExecutor` always drives the
**local** `runner` and does not branch on `remoteSessions?.nodeIdFor(...)`.
Nothing in the plan asks for cloud-device workflow support yet, and the
remote-bridge equivalent is a comparably sized subsystem left for a
follow-up rather than half-built here. Separately — and unrelated to
workflows — `packages/core/src/api/jobs.ts` around the `GET /:id/nodes`
route carries a duplicate-schema typecheck error from a second,
out-of-workspace Claude session (`@enkaku/protocol` exports two differently
shaped `JobNodesResponseSchema`s and the wrong one currently wins the
package boundary); it is the repo owner's to arbitrate and is not fixed
here.

## The action recorder, and runs that repeat on a jittered, staggered clock (plan 94, M59)

### The recorder

`packages/core/src/recording/` tees the core's own manual-input path — the
same function every `input.tap`/`.swipe`/`.gesture`/`.key`/`.text` WS message
already passes through, after the lease check and before the device call —
into a `RecordingDoc` (`@enkaku/protocol`'s `recording.ts`) while
`recording.start` is open on a device. No device-side component: a recording
observes exactly what an operator's own control session already sends.

- **`RecordingService`** (`recording/service.ts`) is the per-farm registry:
  one recording per device, held by the lease holder, `E_RECORDING_ACTIVE` on
  a second `start`. `RecordingSession` (`recording/session.ts`) is the
  per-device state machine — `observe()` is synchronous and never awaited on
  the input path, so recording can never slow down or reorder a live control
  session.
- **Anchors** (`recording/anchors.ts`) are a UI-tree dump taken only when the
  operator has paused between gestures — `anchorQuietMs` (default 400 ms)
  since the last input, and no more than one every `anchorMinIntervalMs`
  (default 1 500 ms). A dump costs 334–584 ms measured; taking one per tap
  would distort the very timing being recorded, so the recorder only ever
  takes one when it is free. Each tap step is hit-tested against the most
  recent anchor and gets a `candidate` selector **only when it uniquely
  matches** — never used at replay time unless a human promotes it in
  Studio's review panel.
- **Bounds.** `maxSteps` (default 500) and `maxDurationSec` (default 900) end
  a recording cleanly, with a stated reason (`recording.state`'s
  `stoppedReason`) — never a silent truncation and never a failed recording.
- Screenshots and anchor snapshots go through the existing content-addressed
  blob store (`agent/blob/store.ts`) — no new blob kind, no new table.
- **A `text` step's literal string is stored verbatim, always** — never
  gated by the farm's `logInputText` setting, which only controls what the
  audit log may show. A recording exists specifically to be replayed, and a
  replayed `text` step needs the real string; Studio's review panel warns at
  every unparameterised text step before publish, and parameterising one
  (`{ param: 'caption' }`) removes the literal from the document entirely.
  This is a genuine privacy exposure — a recording can contain a password or
  a one-time code in the clear, on disk — and it is a real, unsettled
  product question, not a solved one; see `docs/guide/record-and-replay.md`.

`recording/compile.ts` turns a reviewed document into the published artefact:
`emitRecordingEntry(doc)` writes a short, generated entry (one `import` and
one `defineRecording({...})` call with the document inlined) that publishes
through the exact same `buildScriptFromWorkspace` + `publishScript` pair every
hand-written script uses — no new bundling, no new marker on the `scripts`
row. `emitDetachedScript(doc)` is the one-way "Detach" emitter: a plain
`defineScript` with every step expanded as a literal, ordered `await`.
`packages/core/src/api/recordings.ts` mounts the REST surface at
`/api/recordings` (list, get, create from a device's just-finished recording,
patch under compare-and-swap, delete, publish, detach).

### The pacer — `count`, a randomised interval, and a device stagger

A batch (§ below is the wire shape; see `docs/spec.md` §12.3) may carry an
optional `pacing` block: `count` (repetitions per device), `intervalMs:
[min,max]` (a fresh draw between repetitions), `deviceIntervalMs` (a one-time
stagger across devices). **Repetition is N jobs, not one job with a loop** —
each repetition gets its own job row, its own artifacts, its own retry, and
releases the device between repetitions rather than holding a lease for the
whole run.

- `jobs.notBefore` (unix seconds, nullable) is the mechanism: a job the queue
  will not claim before that instant. One predicate in the claim SQL
  (`AND (j.not_before IS NULL OR j.not_before <= strftime('%s','now'))`)
  enforces it inside the same transaction as every other claim gate — never a
  TypeScript pre-filter. `jobs.batchRepeat` is the 0-based repetition index
  for that device; `jobs.pacedDelayMs` is the delay actually drawn for that
  repetition, so an operator reading a job row sees "waited 4 min 12 s"
  without doing arithmetic against another column.
- `packages/core/src/clusters/pacer.ts` — `planFirst` bakes the stagger into
  repetition 0 for every device; `onMemberSettled` (called from
  `recomputeBatchStatus`, the existing single writer of `batches.status`)
  draws the next repetition's delay from `crypto.getRandomValues` — never
  `Math.random` — and inserts the next job row, or plans nothing once
  `repeatCount` is reached or the batch is `'stopping'`. **Every draw is
  materialised on the row it governs** — nothing here is reconstructed from a
  seed.
- **Restart-safe by construction.** The plan is derived entirely from `jobs`
  rows (`COUNT(*) WHERE batchId = ? AND deviceId = ?` against `repeatCount`),
  so a boot-time sweep over non-terminal batches re-plans anything a crash
  interrupted, and one dynamic `setTimeout` (rearmed at boot) plus the
  scheduler's existing 2 s fallback tick is what actually claims a job the
  moment its `notBefore` passes.
- **Stopping stops the pacer, not just the jobs.** `POST /api/batches/:id/stop`
  marks the batch `'stopping'` **first** — the state `onMemberSettled` reads
  before planning anything — then cancels every queued member and aborts
  every running one through the same `JobService.cancel()` a standalone job
  cancel uses. Gated per member by `canCancelJob` (device ownership or
  `job.cancel.any`), reporting `{ cancelled, aborted, refused,
  refusedDeviceIds }` rather than a silent partial success. This replaces
  `POST /:id/cancel`, which only ever touched queued members.
- **Schedules inherit pacing for the cost of one field** — `repeatCount`/
  `intervalMinMs`/`intervalMaxMs`/`deviceIntervalMs` pass straight through to
  `createBatch` on every firing, exactly like `concurrency`/`order`/
  `priority` already did. `schedule_runs.jitterMs` records the jitter value
  actually drawn for that firing (`0` when none was configured), closing the
  gap where a late-firing run could not say whether that was jitter or the
  farm being busy. **This is a different knob from a schedule's own
  `jitterSec`**: jitter shifts the whole firing, once, before a batch exists;
  pacing's interval shifts each repetition, once the batch does.

### New settings

`FarmSettingsSchema.recording` (`packages/protocol/src/settings.ts`) — the
recorder's own tuning, all farm-wide:

| Field | Default | What it controls |
|---|---|---|
| `anchorQuietMs` | 400 | How long the operator must pause before an anchor dump is taken |
| `anchorMinIntervalMs` | 1 500 | The floor between two anchor dumps |
| `longPressMs` | 400 | A tap held at least this long is recorded as a long press |
| `maxSteps` | 500 | A recording stops itself, cleanly, at this many steps |
| `maxDurationSec` | 900 | A recording stops itself, cleanly, after this long open |
| `captureScreenshots` | `true` | Store a screenshot per step, through the existing blob store |

`ScriptDefinition.timing?: Partial<TimingSettings>` (`@enkaku/sdk`) is the
per-script override a compiled recording uses to suppress `betweenActionMs`
in favour of its own recorded gaps — see `packages/sdk/README.md`'s own
section on the three timing layers for the full composition table.

## Device numbers and physical labelling (plan 89, M54)

`docs/plans/89-m54-device-identity-and-physical-labelling.md` carries the
full evidence and design; `docs/guide/physical-labelling.md` is the
operator-facing walkthrough. This section is the implementation summary.

**The number** (`registry/device-number.ts`, the plan's own `Ships:`
artefact). Two new tables: `device_numbers` (one row per reserved
`stableId`, `number UNIQUE`) and `sequences` (a one-row-per-name monotonic
counter — SQLite `AUTOINCREMENT` needs an `INTEGER PRIMARY KEY`, and
`devices.id` is a text UUID). `allocateDeviceNumber(tx, stableId)` is called
**inside `admitDevice()`'s own transaction** — the one place a `devices` row
is born — so the number reservation and the device row can never exist one
without the other. The reservation is deliberately keyed on `stableId`, not
`devices.id`: it is a survivor table, exactly like `blocked_devices` and
`discovered_devices`, so Forget → re-admit and Block → unblock → re-admit
all return the same number. It is released only by an explicit call:
`releaseDeviceNumber` (one device) or `compactDeviceNumbers` (the whole
fleet, `1..n` in `label ASC, id ASC` order, returning every device whose
number moved so the caller can re-push its label in the same operation —
`compactDeviceNumbers` writes changed rows through a negative-placeholder
pass first, since writing final numbers directly collides with the `UNIQUE`
index on essentially every real compaction). `setDeviceNumber` (a manual
override) throws `E_NUMBER_TAKEN` naming the current holder on a collision,
and always advances the watermark past what it just set. Correctness under
concurrent admissions rests on the `number UNIQUE` index first and the
`max(storedWatermark, max(number)+1)` arithmetic second — the index is what
actually prevents a duplicate; the arithmetic only makes a duplicate
unlikely. `formatDeviceLabel(number, label)` (same file) is the one place a
number composes with a label for text — every device-naming log line, main-
stream event, and doctor line goes through it, and it renders the bare
label when `number` is `null` (a released reservation, or, always, a
cloud-node device — see `packages/studio/src/components/wall/tile-identity.ts`
and register entry 96.21 in `docs/plans/96-m61-hotfixes.md`, unfixed).

`DeviceInfoSchema.number` (`@enkaku/protocol`) is nullable and populated by
`loadDeviceNumbers()` (one query for the whole fleet, never N+1) inside
`rowToDeviceInfo`/`listDevicesWithTags`. `GET /api/devices` sorts by it by
default (`?sort=number|label`). REST: `PATCH /api/devices/:id` accepts
`number` (409 on collision); `POST /api/devices/numbers/compact`; `DELETE
/api/devices/numbers/:stableId`.

**The labelling service** (`device/labelling.ts`, `LabellingService`).
Device-scoped, persistent state — not a session step, the same shape
`devices.networkRoute` already established, because the entire point is the
phone nobody currently has a session open on. Two tiers, gated, never a
silent fallback: `wallpaper` needs the guest agent's `screen-label`
capability (plan 90) and reports `unavailable` — never a quiet downgrade —
when it is absent; `lock-screen` (`packages/session/src/screen-label.ts`) is
plain adb, writes `settings secure lock_screen_owner_info`, and is verified
by reading straight back before it may ever be reported `applied`. A
fingerprint (`sha256` of mode, number, name, the agent's own
`rendererVersion`, and screen geometry) is what makes `reconcile()`
probe-first and cheap: an already-correct device costs one round trip and no
write. `apply()`/`clear()` are per-device serialised (a promise chain per
`deviceId`) and bounded farm-wide by `FarmSettings.labelling.maxConcurrent`
(default 2, the same reasoning as `adb.maxInstallConcurrent`). `clear()` is
idempotent — the tenth call performs the same writes as the first and
consults no "already cleared" flag. Every state transition writes a
`device.label` main-stream event.

Reconciliation fires on exactly three moments, never a timer sweep:
`onDeviceReady` (probe-first, beside `restoreNetworkRoute`), a `PATCH
/api/devices/:id` that actually changes `label` or `number` (debounced 2s
per device), and an explicit action (`Re-apply label`, the fleet-wide
`Apply labels`, or a renumber compaction's own re-push). Forget and Block
call `clearLabel` before their transaction, best-effort — logged and
recorded on failure, never blocking the removal, the identical discipline
`releaseRoute` already has beside it.

REST: `GET /api/devices/:id/label` (`device.view`, live when online, the
cached row when not — never flattens `partial`/`unavailable` into
`applied`); `POST /api/devices/:id/label/apply`; `POST
/api/devices/:id/label/clear` (`{ restoreOriginal? }`); `POST
/api/devices/labels/apply` (`{ deviceIds }`, the fleet-wide switch-on).

**Doctor.** `doctor/checks/labelling.ts` reads `enkaku.db` directly (no live
core required, the same pattern the `devices` check beside it uses) and
reports a farm-wide summary — `applied`/`partial`/`stale`/`unavailable`
counts, naming every non-`applied` device by its own `#N label`. `skip`
when no device has labelling enabled; never a false `ok`.

**Hardware status.** Every mechanism above is unit-tested against a
simulated device/transport. **H1 (whether any `adb shell cmd wallpaper`
surface exists), H2 (whether the lock-screen text is genuinely accepted and
rendered), H4 (icon occlusion), and H5 (whether an OEM skin silently drops
the lock-screen half of the wallpaper) remain unconfirmed on real
hardware** — no physical device was reachable while this was built. The
code fails closed regardless of how they resolve (`unavailable`/`stale`,
never a false `applied`). See the plan's own consolidated hardware table
(§5) for the exact commands that settle them.
