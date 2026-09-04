# Enkaku MVP specification

> Status: **complete for the MVP** — started by plan 202 on 2026-09-03 from the decisions in `docs/mvp/` (MVP 16 wins where those documents disagree), filled section by section as plans 203 to 224 landed, and closed on 2026-09-04. Every `TBD by plan NNN` marker is gone; the two that plans 219 and 220 left behind were written at the programme's closing gate from what those plans actually shipped.
> This document describes software that builds, typechecks and agrees with itself. It does not yet describe software proven on hardware: `docs/guide/owner-smoke.md` is the pass that would establish that, and it has not been run.
> The prototype specification this replaces is `docs/archive/spec-prototype.md`; §21 maps its section numbers to this document.

## 0. How to read this document

- **Authority.** A section that carries decided text is the product statement: if a plan or the code contradicts it, the spec wins and the plan or the code is corrected. A line `TBD by plan NNN (source: docs/mvp/MM §K)` carries no authority; until plan NNN lands, the `docs/mvp/` document it names is the decision of record for that topic.
- **Rewritten, never appended.** A plan that changes a section replaces its text. There are no history notes, no "revised in", no strike-throughs (`docs/mvp/README.md`, Approach, guard 2). History lives in `docs/archive/` and in the plan that made the change.
- **Vocabulary.** The words for the MVP's concepts are fixed in `docs/plans/200-mvp-program.md` §2.4. This document uses them and only them.
- **Measured, not promised.** A number in §17 is either measured (with the plan that measured it and the hardware) or marked "not measured". A target that has not been measured is not a promise to a client (MVP 09 §7).
- **Immutable decisions** are in §2. A plan may not change them; only a revision of this document by the CTO may.

## 1. Product

Enkaku is a self-hosted Android phone farm: plug in phones, see all of them live, drive any one of them by hand, and run automation on many of them at once. One host, one binary, one browser. Cloud mode, mirroring at scale, and internationalisation come after the MVP (MVP 09 §8, MVP 06 §4.1).

**Nouns.** A **device** belongs to at most one **group**. A device has a list of **activities** (a job, an install, a transfer, someone controlling it) and a status of offline, online, or quarantined. A **plugin** is the only way code reaches the farm; it has versions and one active version, and it registers **scripts**, which have no version of their own. A **workflow** is a document chaining scripts, authored in the UI, with no version. A **schedule** names a script or workflow, a target, and a cron. A **job** is the intent to run one script or workflow on one device; each execution is a **run**, and runs accumulate. A **batch** is the jobs created together from one target. An **agent** is an AI operator with its own runs, approvals, and **files**.

**Surfaces.** An icon rail with Devices, Scripts & Workflows, Jobs, Plugins, then the dynamic plugin menu, then theme, Settings, avatar. Agents is either the fifth icon or the first plugin entry (open, MVP 16 §4.1). A status bar with health, counters, alerts, clock. Devices: group tabs, table or Screens grid, discovery sheet, selection with marquee, a bulk pill with the generic action set. **Device Control**: a floating window with hardware shortcuts, the cast with a latency readout, full keyboard and mouse passthrough, Actions, Inspector, and Device (Jobs, Files). Scripts & Workflows: Scripts, Workflows, Schedules. Jobs: Jobs, Batches, detail with Inputs, Output, Logs, Timeline, Artifacts, and a run picker. Plugins. Settings: 15 visible fields, 11 advanced.

**Mechanisms.** Sessions live as long as the device is online; the Screens encoder never stops; the browser only attaches. Activities replace the prototype's exclusive-hold model; a policy table answers allow, warn, or forbid; control is a marker that expires from the last input. Every action takes a target and answers per device. The inspector is a first-party accessibility service in the guest agent with push-based `waitFor`, ui-server as fallback. The guest agent's own screen tells a person holding the phone what the farm is doing to it.

**Who it is for.** An operator running 20 to 100 phones on a shelf, who compares the product with Panda by some3c (`docs/mvp/README.md`, Reference competitor). The MVP is judged on three measured numbers: latency, attach time, and a warm-up time for the whole farm (MVP 16 §5.2).

## 2. Stack (immutable)

From `docs/plans/00-overview.md` §3 and `docs/plans/200-mvp-program.md` §7. No plan changes these.

| Area | Decision |
|---|---|
| Core runtime | Bun, not Node. The core daemon is Bun plus Hono. |
| Web UI | Next.js (Studio), static export (`output: 'export'`), served by the core on one origin. |
| Database | SQLite plus Drizzle ORM. Migrations are generated (`bun run --cwd packages/core db:generate`), never hand-written. Timestamps are integer unix seconds (`mode: 'timestamp'`). |
| Validation | Zod 4 at every boundary: WS messages, HTTP bodies, JSON DB columns, config files, script params. No `as`-cast of external input. |
| Monorepo | Bun workspaces (§3). Cross-package imports go through `@enkaku/*` package names. |
| scrcpy-server | Genymobile's vanilla jar, pinned in `packages/scrcpy/src/version.ts` (3.3.1 today); the Java side is never forked. |
| Default input | `scrcpy-uhid`, falling back to `scrcpy-sdk`; `adb-input` only as a last resort. |
| Default inspector | a persistent on-device engine (§8); `uiautomator dump` is the last rung. |
| Core to Studio | one `/ws` WebSocket for realtime and streaming, REST for CRUD; the contract lives in `packages/protocol` as Zod schemas; no message type string exists outside that package. |
| adb | one per-device command queue plus a global semaphore; `adb kill-server` runs only inside `packages/core/src/tools/adb-server-control.ts`'s `cycle()`. |
| Isolation | crash containment (child process plus hard-timeout kill), never called a sandbox. |
| Identity | `stableId` (ro.serialno, then ANDROID_ID) is the device identity; the adb serial is a transport address. |
| Added by the MVP | a script exists only inside a plugin and has no version of its own; a device's state is `offline \| online \| quarantined` plus an activity list; a session lives as long as the device is online; every action takes a target and answers per device; a job is an intent and a run is an execution; the design of record is `docs/mvp/design_handoff_enkaku_openpf/` as corrected by MVP 15 §0.1 and §1. |

## 3. Repository layout

```
openpf/
  packages/
    core/          the Bun + Hono daemon: registry, sessions host, jobs, plugins, API, WS, DB
    studio/        the Next.js UI (standalone TypeScript 5; never merged with the root TS 7 config)
    ui/            @enkaku/ui, the component primitives Studio and plugin views share
    protocol/      @enkaku/protocol, Zod schemas for every message, body, setting, and vocabulary table
    sdk/           @enkaku/sdk, defineScript and the plugin CLI (init, publish)
    session/       DeviceSession assembly, video profiles, input arbiter, text input, port allocation
    drivers/       the five driver layers (§5) and their engines
    adb/           the adb client (track-devices, forward, shell)
    scrcpy/        the scrcpy protocol client, version-locked
    toolchain/     tool provisioning: download, sha256, versions, manifest
    harness/       the AI agent harness (vendored, provenance-checked, never edited locally)
    node/          the cloud tunnel mini-core (post-MVP; stays, outside the MVP definition of done)
    probe-server/  the self-hosted egress/geo/DNS probe endpoint
  apps/
    guest-agent/   the on-device APK (§19)
    desktop/       the Tauri shell (parked; §18)
  plugins/         bundled plugins: google/tiktok/youtube automation packs, proxy-manager, mikrotik-routing, networking
  examples/        example scripts
  scripts/         repo tooling (typecheck, spec-check, check-plan-status, bench, doctor, smoke)
  docs/            spec.md, design.md, plans/, mvp/, guide/, archive/
```

`packages/sdk` and `packages/protocol` are designed to be publishable; everything else is private. The release binary embeds the Studio export and the bundled packs (`packages/core/packs/`, built by `bun run build:packs`).

## 4. Data model

Storage is SQLite through Drizzle (`packages/core/src/db/schema.ts`). Every JSON column is parsed through a Zod schema on read. Every timestamp is an integer of unix seconds. Identifiers are `crypto.randomUUID()`.

### 4.1 Device

- Identity: `stableId`; the adb serial is the transport address and may change (`device_endpoints` remembers network addresses).
- Status: `offline | online | quarantined`. Nothing else is stored as a state; "busy" and "controlled" are views over the activity list.
- Fields an operator sets: `groupId` (at most one group), tags (`device_tags`), number (`device_numbers`, the `#` shown everywhere and on the physical label), label.
- Readiness (`desiredReadiness`, `awake` by default and applied at connect), preparation map (per component), guest agent state, network route (§9), identity overrides.
- Admission: a phone adb can see is **not** on the farm until an operator adds it (`discovered_devices`, `blocked_devices`, `deleted_devices`). Quarantine is automatic after repeated infrastructure failures (§14 advanced setting).
- Tables kept from the prototype: `devices`, `device_tags`, `device_endpoints`, `device_numbers`, `discovered_devices`, `blocked_devices`, `deleted_devices`, `device_events` (the event log, two streams: `main` and `input`), `network_credentials`, `sequences`, `migration_markers`, `tool_installs`.

### 4.2 Group

A group is a named set of devices; a device belongs to at most one. Groups are managed from the Devices tab strip only (create, rename, delete by right-click); there is no page. Table `groups`; column `devices.groupId`; routes `/api/groups`; target shape `{ groupId }`. The prototype's table, routes, messages, settings, and Studio components for the same concept carry its old name (the word 200 §2.4 forbids) and are renamed by plan 207 (MVP 15 §0.1.3, MVP 13 A.6a).

### 4.3 Activity

One list per device, served as `DeviceInfo.activities` and pushed as `device.activity` (added, updated, ended):

```ts
type DeviceActivity = {
  id: string
  kind: 'control' | 'job' | 'workflow-job' | 'install' | 'transfer' | 'prep'
      | 'command' | 'agent' | 'network-apply' | 'wake'
  label: string                 // a human sentence, never an id
  actor: { kind: 'user' | 'agent' | 'system' | 'plugin'; id: string; label: string }
  startedAt: number             // unix seconds
  updatedAt: number             // last heartbeat or last input
  href?: string                 // where to look: job detail, transfer, plugin view
  meta?: Record<string, unknown>
}
```

Entries with a durable row (jobs, transfers, preparation) are projected from that row; `control`, `command`, and `wake` are in memory and are empty after a restart.

**Control is a marker, not a permission.** The first input from a client creates or refreshes a `control` activity with the user and `updatedAt`; it ends after `controlIdleSec` (default 30) without input. There is no acquire, release, takeover, or second authorisation object. The Screens card, table row, and Device Control header say "Controlled by Rani" while live and "Last controlled 12 s ago by Rani" for a short tail (default 120 s).

**Policy table.** Before starting activity X on a device whose list holds Y, the core answers `allow | warn | forbid` with a sentence:

| Starting, over existing | job / workflow-job | install | control (fresh input) | command | prep |
|---|---|---|---|---|---|
| job / workflow-job | forbid (queue behind it) | forbid | allow | warn | warn |
| install | forbid | forbid | allow | warn | warn |
| control | warn ("a job is running; your taps will interfere") | warn | allow, marker only | allow | allow |
| command (adb) | warn | warn | allow | allow | allow |
| transfer | allow | forbid | allow | allow | allow |
| wake / network-apply | forbid while a job runs | forbid | allow | allow | allow |

`warn` returns the sentence; Studio shows it once and proceeds on confirmation; a script or agent may pass `force: true`. `forbid` returns `E_DEVICE_CONFLICT` with the conflicting activity. Two rows are farm settings: control over control (default `allow`; `warn` or `forbid` selectable) and control idle seconds. A queued job whose device has a fresh `control` entry waits until the entry ends or `maxWaitSec` elapses. The job heartbeat (`heartbeatExpiresAt` on the run) stays as job liveness detection. The input arbiter stays with sources `{ kind: 'user' | 'job' | 'agent' }`. Capabilities declare `activity?: { kind, exclusiveWith?: kind[] }` and the invoke pipeline consults the policy table.

Plan 205 lands this section (source: MVP 04 §1). Open within it: whether `agent` is its own kind (proposed yes) and whether plugins may add kinds (proposed: deferred), MVP 04 §5.

### 4.4 Plugin

A plugin is the only way code reaches the farm. It is staged, verified, then activated; it has versions and exactly one active version; activation and rollback move every member script together and never delete older rows, so pinned jobs keep running. States: **active** or not ("latest" and "enabled" are not product words). Tables: `plugins`, `plugin_webhooks`, `kv_entries` (plugin KV, browsed from the Plugins page). A plugin may register scripts, navigation entries and views (`PluginSurface.nav`: id, label, icon, view), actions under `<plugin>/<verb>`, a service with `ctx.onRequest`, webhooks, and KV. Bundled packs are seeded once per `${name}@${version}` (record in `<dataDir>/seeded-packs.json`) and staged, not activated; editing a bundled plugin's source means bumping its version in all three sites (`package.json`, `src/index.ts`, `src/index.test.ts`) or the change never reaches a farm that has already booted.

### 4.5 Script

A script is a member of a plugin and has no version of its own. `scripts.version` remains as an internal denormalisation equal to the owning plugin's version, never shown, never listed, never documented as a script property; jobs display `plugin@1.2.0 / login`. There is no direct-publish path — `POST /api/scripts` publishing, the non-plugin branch of `enkaku publish`, and a per-script publish capability do not exist; publishing goes through `POST /api/plugins` or the `plugin.stage` capability. The farm-owned owner recordings used to publish under, and the column that once told a script row apart from a workflow row, are both gone (MVP 03 §2.2, MVP 13 A.4). `script_param_sets` stay keyed on script name so presets survive plugin upgrades. The `defineScript` contract: `run()` does the work; `finish()` is stateless and idempotent because after a timeout kill the core runs it again in a fresh process. A script declares its runtime envelope (`timeoutMs`, `retries`, `maxRssBytes`, `maxConcurrent`) and, optionally, a result schema; the output verdict (`undeclared | valid | invalid | partial | oversize`) is stored on the run.

### 4.6 Workflow

A workflow is a document chaining scripts, authored in the Studio editor, owned by the farm, with no version. Table `workflows`: `name` (unique), `doc`, `createdBy`, `updatedAt`. Enqueuing a workflow job copies the validated document onto the job (`jobs.workflow_doc`), so editing never changes a queued or running job. A workflow is its own table, never a row of `scripts` (plan 210). Single device, sequential steps only for the MVP (MVP 05 §4; the CEO decision is recorded in `docs/mvp/README.md`, Open decisions 4).

### 4.7 Schedule

A schedule names a script or a workflow (`target: { kind: 'script', ref } | { kind: 'workflow', name }`), a device target (§11), and a cron. It owns one job per target device; every fire adds a run with `trigger = 'schedule'`. `onOverlap` (skip, queue, cancel previous) applies to the job's running run. The prototype's `schedule_runs` table is deleted by plan 211; `schedule_agent_targets` stays for agent schedules. Schedules are listed on the third tab of Scripts & Workflows.

### 4.8 Job, run, batch

```
jobs:      id, kind ('script' | 'workflow'), scriptRef | workflowName, params,
           deviceId, batchId?, scheduleId?, createdBy, createdAt,
           latestRunId, runCount
job_runs:  id, jobId, seq (1..n),
           trigger ('manual' | 'rerun' | 'schedule' | 'batch' | 'resume' | 'workflow-step'),
           status, startedAt, finishedAt, heartbeatExpiresAt,
           result, error, failureClass, errorPhase, infraAttempts, assistCount,
           resumedFromRunId?, resumedFromStep?
```

- A **job** is the intent: what to run, with which parameters, on which device, made by whom. Its id is stable; its displayed status is `latestRun.status`.
- A **run** is one execution. Re-running adds a run with `seq + 1`; earlier runs never change. Logs, trace frames, UI captures, artifacts, and the input audit are keyed by `runId`. Infrastructure retries stay inside a run (`infraAttempts`).
- A **batch** is the set of jobs created together from one target. `run-script` and `run-workflow` always create a batch, even for one device; a batch of one is displayed as its single job. "Re-run" adds a run to every job in the batch; "re-run failed" only to jobs whose latest run failed. A batch's status is the projection of its jobs' latest runs.
- A **workflow job** orchestrates script jobs as steps: each script step is a real script job with `parentWorkflowJobId` and `stepSeq`; gate steps are rows of the workflow run's step table with a verdict. `workflow_runs` per workflow job, `workflow_steps` per run; the prototype's `job_nodes` is deleted. Resume is a run with `trigger = 'resume'`, `resumedFromRunId`, `resumedFromStep`.
- Changing parameters before running again creates a new job, because the intent changed.
- Tables kept: `jobs` (now carrying `workflow_doc`, the snapshot a workflow job's enqueue writes), `batches`, `artifacts`, `job_events` (the trace), `job_resumes` (until plan 211 folds it into runs), `schedules`, `scripts`, `script_param_sets`, `workflows` (plan 210: a workflow's own table, no version). Plans 210 and 141 land §4.5 to §4.8 (source: MVP 05, MVP 14).

### 4.9 Agent and files

An AI agent has a roster entry (`ai_agents`), threads, runs, messages, approvals, an inbox, spawn grants (`agent_threads`, `agent_runs`, `agent_messages`, `agent_approvals`, `agent_inbox`, `agent_spawn_grants`), connectors (`connectors`), notifications (`notifications`, `webhook_endpoints`), and files (`workspace_files`, `agent_blobs`; shown as Files under Agents). Agents stay in the core, compacted to one page with their settings on that page (MVP 06 §4.2). An agent run appears on a device as an `agent` activity. The agent surface is one page, `/agents`, with five tabs: **Roster**, **Runs**, **Approvals**, **Files**, and **Settings** (connectors and webhooks live inside Settings, not as pages of their own). `/agents/detail?id=` remains the single agent's own page. The former `/agents/approvals`, `/agents/runs`, `/agents/thread` and `/workspace` routes are gone — Workspace is Files, under Agents. Spawn grants keep their store and their `canSpawn` enforcement; the HTTP routes that exposed them are removed, because an operator never edited a grant by hand and the rule is enforced where it is read, not where it was displayed (plan 220 §3.5).

### 4.10 Farm, users, audit

`farm_settings` (§14), `users`, `sessions` (login sessions; only the sha256 of a token is stored), `api_tokens`, `audit_log` (who ran what, enrolled which device, activated which plugin), `nodes` (cloud mode, post-MVP, outside the definition of done).

## 5. Device layer

### 5.1 Five driver layers

A driver is five separate abstractions so each can be swapped alone. A factory assembles them into one `DeviceSession`; a script only ever sees that handle.

| Layer | Interface | Default engine | Alternatives |
|---|---|---|---|
| 1 Transport | `connect() disconnect() exec() serial stableId` | `adb-usb` | `adb-tcp` (wireless adb, remembered addresses, bounded subnet scan) |
| 2 Display | `start() onFrame(chunk, meta) stop()` | `scrcpy` (H.264, PTS carried in `FrameMeta`) | `screencap-loop` only when scrcpy is unavailable |
| 3 Input | `tap swipe key text gesture scroll keyDown keyUp pinch setClipboard getClipboard` | `scrcpy-uhid` (API 29 and up) | `scrcpy-sdk`, `adb-input` |
| 4 Inspector | `dump() find(sel) findDetailed(sel)? screenshot() watch(onChange)?` | `ui-tree` (the guest agent's accessibility service) | `ui-server`, then `uiautomator dump` (§8) |
| 5 Network | `capabilities apply(cfg) observe() revert() probe()?` | `none` | `adb-proxy`, `adb-reverse-proxy`, `vpn-helper` (§9) |

Engines declare the capability locks they take (for example `instrumentation`), so two engines cannot collide on one device. The default inspector takes none: `ui-tree` needs no `UiAutomation` connection, which is what removed the collision the prototype's inspector had with `uiautomator dump`.

### 5.2 Toolchain

adb, scrcpy-server, ui-server, and the guest agent APK are downloaded on first run into `<dataDir>/tools/<toolId>/<version>/` with an `active` pointer, sha256-verified against `packages/toolchain/manifest/enkaku-tools.json`, and never taken from the system PATH. adb is not redistributed (`LICENSES.md`). scrcpy-server is `swappable: false` and pinned to the core version. The guest agent APK resolves `ENKAKU_GUEST_AGENT_PATH`, then a local Gradle build, then the pinned artifact; it is never auto-built. Toolchain versions and `doctor` live under Settings (§13).

### 5.3 Session lifetime equals device lifetime

- When a device becomes online, the core builds its session in the background: forward, scrcpy server, control socket, wake, inspector prewarm, guest agent hello. The activity list shows `prep` while this runs, so a tile says "Preparing" only for a device that just arrived.
- The session stays up until the device goes offline or is forgotten. No idle TTL, no idle cap, no per-view build. The one knob is the connect-time stagger: concurrency per USB root (default 4) and a farm-wide ceiling (default 16), ordered by device number; a waiting device shows "Preparing, queued".
- A session whose scrcpy process dies is rebuilt with backoff; the tile shows "Recovering". Unplug and replug rebuild the session with no operator action. A core restart rebuilds every session under the stagger; the browser reconnects and attaches.
- Readiness desired is `awake` by default. A device an operator puts to sleep stays asleep with its session up; its tile shows a dark screen, not a loading panel.

Plan 206 lands this section (source: MVP 11 §1). Per-USB-root install serialisation and the lifecycle targets are plan 223 (MVP 09 §2).

### 5.4 Identity and admission

`stableId` is `ro.serialno`, then `ANDROID_ID`. A transport address change (USB port, TCP address) is not a new device. Admission: discovered, then added by an operator; a blocked device never appears again until unblocked; quarantine is automatic after N infrastructure failures and cleared by the `unquarantine` action.

## 6. Video

Phone MediaCodec → scrcpy-server over an adb forward → core demuxer (ring buffer, device PTS preserved) → one binary WebSocket frame per access unit (11-byte header carrying keyframe flag, dimensions, PTS) → Studio WebCodecs `VideoDecoder` → canvas. The host never transcodes; the Java side is never forked.

- **Two encoders per session.** The Screens encoder (`wall` profile in code: 480 px, 18 fps, about 1.1 Mbit) runs for the whole session; the Screens view attaches to it instantly. The control encoder (`control` profile) starts when a Device Control opens; until its first keyframe, Device Control shows the Screens stream upscaled, then switches; it stops with a short linger when the last Device Control on that device closes.
- **The browser is a viewer.** `stream.start` attaches to a running session and primes with the cached SPS/PPS and keyframe; it never builds. A device with no session answers with its activity (`prep`, `offline`), not a build. Only visible tiles are decoded.
- **Decode and paint.** `hardwareAcceleration: 'prefer-hardware'` with fallback to `'no-preference'` on `NotSupportedError` (200 §5 R3); `optimizeForLatency: true`; paint on `requestAnimationFrame`, newest frame wins, `decodeQueueSize` read and a keyframe requested when it grows; canvas `desynchronized: true, alpha: false`. A keyframe is obtained only through the `RESET_VIDEO` control message.
- **Latency is measured in band.** Device PTS travels to the decoder's chunk timestamp; a latency overlay (device PTS versus paint time, decode queue depth, dropped frames) is shown in Device Control's stats strip.
- **Backpressure.** Per viewer, drop to keyframe above the buffered-amount limit, plus Bun's `drain()` handler (200 §5 R8).

Profiles (launch arguments; a change rebuilds the encoder):

| Profile | maxSize | maxFps | bitRate |
|---|---|---|---|
| control `sharp` | 1600 | 30 | 4 000 000 |
| control `balanced` | 1080 | 30 | 2 500 000 |
| control `light` | 720 | 20 | 1 200 000 |
| Screens `balanced` (default) | 480 | 18 | 1 100 000 |

Whether `balanced` becomes the shipped control default is decided by plan 209 after plan 203 measures. Plan 203 lands the PTS path, the overlay, and the bench harness; plan 209 lands the quick wins (source: MVP 01 §4 steps 1 and 2). The cloud path (MVP 01 §4 step 3) and WebRTC (step 4) are post-MVP.

## 7. Input

**Rule.** While Device Control has focus, every key goes to the device. Focus is taken by clicking the cast and shown by a visible frame; it is released by clicking outside, by the release chord, or when the window closes.

| Host gesture | Device action | Mechanism |
|---|---|---|
| Click | tap; hold equals the real press length | `INJECT_TOUCH_EVENT` down/up |
| Press and hold | long press | same |
| Drag | touch move streamed live at 8 ms sampling | one `INJECT_TOUCH_EVENT` move per sample |
| Wheel; Shift+wheel | vertical; horizontal scroll at the pointer | `INJECT_SCROLL_EVENT` |
| Right click | Back | `BACK_OR_SCREEN_ON` |
| Middle click | Home | `INJECT_KEYCODE HOME` |
| Ctrl+drag (Cmd on macOS); Alt+drag | pinch around the screen centre; around the drag start | two touch pointers |
| Pointer leaves the canvas mid-drag | touch up at the last point | never a stuck finger |

Keyboard, three layers: hotkeys (Esc → Back always; Alt+H Home, Alt+S Recents, Alt+P power, Alt+R rotate, Alt+N notifications, Alt+M settings panel, Alt+O collapse panels, Alt+F fullscreen, Alt+K toolbar, Alt+C device clipboard to host, Alt+V host clipboard to device, Alt+Shift+K release focus; Cmd on macOS; the table is one export in `@enkaku/protocol`), key passthrough (every other key with real down and up through a UHID keyboard on API 29 and up, `INJECT_KEYCODE` with meta state below), and text (printable keys through UHID with no debounce; paste and anything UHID cannot express through the guest agent IME `text.commit`, falling back to `INJECT_TEXT`). Clipboard both ways. The 500 ms text debounce and the synthetic tap hold are gone; the synthetic hold survives only as a script-side option.

Toolbar: Back, Home, Recents, Power, Volume up/down, Rotate, Notifications, Screenshot, Paste, Copy, Keyboard, Keep awake, Fullscreen; every button's tooltip shows its hotkey from the same table. Device Control is one device; with several devices selected, the host banner fans `input.*` out to the selection client-side, each member getting a `control` marker; the server holds no mirror object.

New protocol messages: `input.scroll`, `input.keyEvent`, `input.pinch`, `clipboard.get`, `clipboard.set`. `input.*` stays single-device and fire-and-forget. Plan 209 lands the driver verbs and plan 215 the window (source: MVP 08 §1, §2). Open: the hotkey modifier (proposed Alt on Windows and Linux, Cmd on macOS, user-switchable) and a first-open overlay (MVP 08 §5).

## 8. Inspector

The inspector reads the UI tree for scripts, agents, and the Inspector tab. There are three engines and one ladder: `ui-tree`, then `ui-server`, then `uiautomator dump`. A session picks one rung at build time and reports which; it never runs two at once on one device.

**`ui-tree`, the default.** An `AccessibilityService` inside the guest agent, reached over the agent's existing control channel. It reads `AccessibilityNodeInfo`, the same source UiAutomator reads, and emits the same node shape every other engine emits, so selectors, the node schema and every consumer are unchanged. It runs no `am instrument`, holds no `instrumentation` lock, starts no per-session process, and does not conflict with `uiautomator dump`; it is a bound service that lives as long as the agent. It is enabled unattended from adb during provisioning (`cmd appops set <package> ACCESS_RESTRICTED_SETTINGS allow`, then `settings put secure enabled_accessibility_services` and `accessibility_enabled`, then a read-back that decides; 200 §5 R4), and the agent's own status screen has an "Open accessibility settings" button for the builds that refuse the write. It has no element actions: a scoped `setText` goes through the agent's IME instead.

**`waitFor` is push, not poll.** `ui.watch` subscribes to `TYPE_WINDOW_CONTENT_CHANGED`, and the executor evaluates the condition once immediately, then waits for the next change event with the caller's timeout as the ceiling. A condition that is already true returns with one round trip; a condition that becomes true resolves when the screen changes rather than at the next tick. A bounded one-second re-check runs alongside the subscription, because a `SurfaceView`, a `TextureView` or a WebView repaint can change the screen with no accessibility event at all, and an event can be lost. This is the structural answer to "the script waits for our system to see the UI".

**`ui-server`, the fallback.** The openatx instrumentation, session-scoped: started in the background after the first video frame and kept until session close, with a fail-fast start that reads the instrumentation's own stdout and a 15 s ceiling reserved for a server that says nothing, and the JSON-RPC configurator setting the idle waits to zero. It is chosen for a device where the guest agent is not installed, is an older build, or could not have its accessibility service enabled.

**`uiautomator dump`, the last resort.** One dump per query, no element actions, and it seizes UiAutomation. Chosen only when an operator pins it or when the ui-server rung failed to start.

**Degradation is visible, never silent.** Every hop broadcasts `device.inspector.fallback` and records `session.degraded` with the reason; the Inspector tab names the engine it actually got; and `GET /api/devices/:id` carries `liveInspection`, the engine running, beside `inspection`, the engine configured. The two are allowed to disagree, and on a mixed farm they will.

Targets are in §17.

## 9. Network

The fifth driver layer routes a device's traffic without giving a script a raw shell. Three engines beside `none`:

| Engine | Auth | Enforcing | Needs the agent | What it is |
|---|---|---|---|---|
| `adb-proxy` | no | advisory | no | `settings put global http_proxy`; world-readable, credentials refused (`E_HTTP_PROXY_NO_AUTH`); health is structurally `unverified` |
| `adb-reverse-proxy` | yes | advisory | no | `adb reverse` to a proxy on the host that holds the credentials; re-established on every device-online transition |
| `vpn-helper` | yes | yes | yes | the guest agent's `VpnService` SOCKS5 full tunnel; the only engine an app cannot bypass; fail-closed with bounded recovery and re-arm |

Rules for every engine: configuration is bound to the device and survives client disconnect, reboot, and core restart until an explicit act removes it; declared intent (`getConfig()`) and observed state (`observe()`) are separate reads; `apply()` is not a success signal, only a passing `egress` probe moves health from `unverified` to `ok`, and `unverified` is never worded as success; credentials are referenced by id (`network_credentials`, AES-256-GCM at rest), never inlined; every change is written to `device_events` with secrets redacted; HTTPS interception is out of scope. The operator surfaces are the plugin views of `proxy-manager` and `mikrotik-routing` and the `[i]` engines popover in Device Control; the bulk verb is `set-network` (§11). A `network-apply` activity appears while a route is applied.

## 10. Plugins

The plugin pipeline is stage → verify → activate; rollback and disable are the other two lifecycle actions; dev slots exist for local development. A plugin's surface may add navigation entries under the static rail (rendered from `PluginSurface.nav`), views, actions (`<plugin>/<verb>`, §11), a service, webhooks, and KV. The icon allowlist maps ids to Phosphor names (200 §5 R6). Plugin views are the only place device-scoped plugin data is shown. `enkaku init` scaffolds a plugin; `enkaku publish` stages one. The Plugins page lists Plugin · Status · Scripts · Verified · Actions (Disable or Activate; overflow with Reset data, Remove). The plugin service contract keeps `onQuery`, `onSocket`, `onWebhook` and `onEvent` for the MVP, and the observation behind the question stands: verified at the close of the programme, **no bundled plugin implements `onSocket`, `onWebhook` or `onEvent`**, and the apparent `onQuery` users are `onQueryChange`, an unrelated React prop. They are kept because an unused extension point is not dead code — it is the surface a plugin nobody has written yet would bind to, and the four hooks cost nothing at runtime. Shrinking the contract is a post-MVP review, and it needs a real third-party plugin to inform it rather than a grep over the six bundled ones.

## 11. Actions API

Every action takes a target and answers per device.

```
POST /api/actions/<verb>
{
  "target": { "deviceIds": ["…"] } | { "groupId": "…" } | { "tags": ["…"] },
  ...verb-specific parameters,
  "force": false            // acknowledge policy warnings (§4.3)
}
→ 202 { "operationId": "…",
        "results": [ { "deviceId": "…",
                       "status": "accepted" | "skipped" | "forbidden" | "warned",
                       "message": "…", "activityId": "…" } ] }
```

- One endpoint per verb, no `/:id/<verb>` routes. A single device is a list of one.
- Partial acceptance is normal. `warned` devices are not started until the caller repeats with `force: true`. `forbidden` carries the policy sentence.
- Long-running verbs create one activity per device; completion arrives on `device.activity`; `GET /api/operations/:id` returns the same array with final statuses.
- Verbs: `run-script`, `run-workflow`, `install`, `push`, `pull`, `adb`, `wake`, `sleep`, `reconnect`, `disconnect`, `cutover`, `forget`, `block`, `unquarantine`, `set-network`, `set-label`, `clear-label`, `set-group` (shown as "Move group"), `set-tags`, `prepare`, `retry-prepare`, `reprofile`, `screenshot`, `clear-cache`, `settings`. The first twelve entries of every action menu are the handoff's generic action set in its order (Reconnect, Disconnect, Install apk, Adb command, Run script, Screenshot, Sleep, Move group, Upload file, Clear cache, Settings, Forget); the rest sit in an overflow. Plugins add verbs as `<plugin>/<verb>`.
- Reads stay per device (`GET /api/devices/:id`, `/inspect/*`, `/screenshot`, `/logs`, `/files`); the only multi-device read is `GET /api/devices`. `input.*` over WebSocket is single-device and fire-and-forget.
- Errors follow `{ error: { code, message } }` with `E_DEVICE_CONFLICT` for a forbidden policy answer.

Studio: one dialog per verb, each with the `DevicePicker` as its first row in its own container, pre-filled from where it was opened, editable in place, three modes (devices, group, tags), readiness markers on the chips, `warned` and `forbidden` sentences inline, primary button "Continue for N devices". Plan 207 lands the API and plan 216 the dialogs (source: MVP 07). Open: `/api/actions/<verb>` versus `/api/devices/actions/<verb>` (proposed the former), MVP 07 §5.

## 12. Jobs and runs (execution)

- The queue is in SQLite; a scheduler claims the next run for a device whose policy answer is `allow` (or `warn` with `force`). Two queues, one scheduler: a workflow job creates a `workflow-job` activity and enqueues its script steps one at a time, waiting on each terminal status; nothing else may start a job on that device until the workflow job ends.
- Every run is a child process with crash containment: a hard timeout kill, then `finish()` again in a fresh process; a silence watchdog; a memory limit with `peak_rss_bytes` recorded; infrastructure retries with backoff and a failure class (`failureClass`, `errorPhase`).
- The trace: one event stream per run (`job_events`) with frames and UI captures per action, rendered as the Timeline (transport, lanes, frames, event panel). Typed text and clipboard writes are recorded as a length only.
- Artifacts are the file outputs of a run (frames, UI dumps, replay video, files a script saved), distinct from the JSON output snapshot.
- Retention is per run (§16).
- The prototype's `POST /api/jobs/:id/resume`, `POST /api/batches/:id/rerun` and `/rerun-failed` as job-creating routes, `job_nodes`, and `schedule_runs` are removed by plan 211. Plan 211 lands this section (source: MVP 05, MVP 14).

## 13. Studio

The design of record is `docs/mvp/design_handoff_enkaku_openpf/README.md` and the prototype HTML beside it, as corrected by MVP 15 §0.1 (Schedules under Scripts & Workflows; Workspace renamed Files under Agents; groups; no Console; Recordings deferred) and §1. `docs/design.md` is rewritten from the handoff as the screens land.

- **Shell.** A 60 px icon rail (Devices `ph-devices`, Scripts & workflows `ph-code`, Jobs `ph-lightning`, Plugins `ph-puzzle-piece`; then the dynamic plugin menu; then theme toggle, Settings `ph-gear`, avatar), a 44 px status bar (pulsing dot plus "System OK", `Devices n/m`, `Jobs n/m`, Alerts bell, clock in Geist Mono; no console toggle), one 16 px-radius page panel. Desktop-first, 1280 to 1600 px, usable to 960 px, no mobile layout. Theme persisted under `enkaku-theme`.
- **Devices.** Group tab pills with counts and a "+" popover (rename and delete by right-click); Discovered (N) opening a 452 px right sheet; search, filter, view, rescan icon buttons; a table with grid `38px 44px 1.3fr 108px 92px 138px 70px 74px 62px 62px 62px 76px 1.1fr` (checkbox · # · Device · Serial · OS · Endpoint · Batt · Temp · CPU · Mem · Disk · Uptime · Task) or a Screens card grid with width presets S 112 / M 146 / L 190 / XL 240. Selection: click toggles (deferred 200 ms), double-click opens Device Control, marquee drag, Ctrl/Cmd+A, tiered Escape. A floating "N selected" pill opens the generic action set; no per-row actions column. State dot: green free, amber someone controlling, red job running, grey disconnected, warn unauthorized; the reason only in a tooltip; the same mapping in table and grid. The Task column is the activity list. Live cast at every card width is proposed (MVP 16 §4.5, open).
- **Device Control.** A draggable floating window, not a modal; width `max(560 * (w/h) + 36, 380) + 52 + 274` px; a 52 px shortcut rail (Power, Volume up, Volume down, Mute, Back, Home, Recents, Rotate, Brightness, Clipboard); the cast with a 40 px stats strip (fps, resolution, codec, latency from §6); a 274 px info column with header (state dot, `#11`, name, `[i]`, close), the `[i]` popover (identity and active engines with Change), meta strip, and compact tabs Actions · Inspector (Snapshot, UI nodes, Node details) · Device (Jobs, Files). Double-clicking another device retargets the window. The host banner appears with several devices selected (§7).
- **Scripts & Workflows.** Tabs Scripts, Workflows, Schedules. Scripts table columns: Name (`plugin/script`, mono) · Plugin (version chip) · Params · Last run · Run; no version or enabled columns; "New script" opens the plugin scaffold or install flow. Workflows as cards with the step chain and a footer ("12 devices · daily 07:00"). The workflow editor and the Schedules tab are not yet designed.
- **Jobs.** Tabs Jobs and Batches; a 268 px left list with wrapping filter chips (All · Running · Queued · Success · Failed) and 12 rows per page; the right detail with a run picker in the header meta line ("run 3 of 3 ·"), Re-run, Open device, Export, and sub-tabs Inputs, Output, Logs, Timeline, Artifacts.
- **Plugins.** Table Plugin · Status · Scripts · Verified · Actions (§10).
- **Settings.** Two columns, the handoff's group structure, the field list of §14.
- **Agents.** Roster, Runs, Approvals, Files; placement open (MVP 16 §4.1); not designed.
- **Removed from the navigation.** The device page and its twelve tabs, Console, Recordings (deferred, code parked), Topology, Tools (into Settings), Workspace (into Agents), Nodes (post-MVP), and every redirect stub. Each new screen deletes its old route directory as it lands.
- **Rules.** Static export; links through `next/link`; Tailwind v4 classes (`bg-surface`, never bracket variables); workspace packages in `transpilePackages`; `@enkaku/ui` primitives; Geist and Geist Mono self-hosted (200 §5 R7); Phosphor icons (R6). A client must `GET /api/devices` before subscribing on `/ws`; there is no snapshot replay.

Plans 204 (tokens and primitives), 213 (shell), 214 (Devices), 215 (Device Control), 216 (dialogs), 217 (Scripts, Workflows, Schedules), 218 (Jobs), 219 (Plugins and Settings), 220 (Agents) land this section (source: MVP 15, MVP 03, the handoff). The undesigned screens (MVP 15 §2) are drawn before wave 3 starts (MVP 16 §5.3).

## 14. Settings

A setting is visible only if the right value differs between farms **and** a non-engineer can predict what changing it does. Everything else is advanced (one disclosure, default shown, reset), a constant (a named export with an `ENKAKU_*` environment override listed in `.env.example` under "support overrides"), removed with its feature, or moved to a device, a plugin, or the Agents page.

Visible (15): Farm name; Control quality (sharp, balanced, light); Screens quality (minimal, light, balanced, detailed); Networks to scan for wireless devices; Battery: pause jobs above N °C; Physical label on the screen (off, number, number and name); When someone controls a device another person just touched (allow, warn, forbid); Default job timeout; Reset the app before each job (never, always, on failure); Human-like touch profile (precise, natural, slow); Adb command action for operators (on, off); Users and API tokens (a table); Keep job history, logs, and traces for N days; Keep artifacts for N days or up to N GB; Egress probe endpoint.

Advanced (11), with defaults: max concurrent adb commands 8; max concurrent installs 1 per USB root; session build concurrency per USB root 4; infrastructure retries and backoff base 3, 1 s; job memory limit 256 MB; push / pull / bulk download caps 512 MB, 512 MB, 2 GB; install timeout 120 s; adb health probe interval 30 s; failures before quarantine 5; Screens bandwidth budget on WAN 20 Mbit; recovery resets per hour 6.

Layout: the handoff's two columns and groups (General; Connection: Host & daemon, ADB transport, Network scan; Automation: Job runner, Capture & replay; Storage: Artifacts, Retention; Farm: Groups, Privacy, Appearance, Advanced); fields the handoff draws that are constants here are not built. Per-device overrides keep the same visible set plus "use farm default". Config precedence is env > file > default; an invalid config fails the boot with `E_BAD_CONFIG` and never falls back. The schema file is expected under 600 lines (2 694 today). Plan 212 lands this section (source: MVP 12). Open: whether Retention is visible or advanced (proposed visible) and whether "reset the app before each job" is a per-script declaration with a farm default (proposed yes), MVP 12 §7.

## 15. Security and auth

- Server-authoritative: conflicts, policy answers, and ACL live in the core.
- Auth mode derives from the bind address: bound to loopback, the core may auto-create an admin and skip login; bound to anything else it is server mode, login is mandatory (argon2), sessions are stored as token hashes, and TLS is required unless `ENKAKU_ALLOW_INSECURE=1`. API tokens for scripts and agents.
- Crash containment is not a sandbox; a security boundary is post-MVP cloud work.
- Tool integrity: sha256 is mandatory for every downloaded tool.
- adb: per-device queue plus a global semaphore; `adb kill-server` only in `cycle()`, which drains sessions and activities first and reattaches remembered addresses afterwards.
- Audit: `audit_log` records who ran what, enrolled which device, activated which plugin.
- Data hygiene: the "reset the app before each job" policy (§14) clears app state between jobs so accounts do not leak between runs.
- Redaction: typed text and clipboard writes are stored as a length; proxy credentials are masked in every log and event.
- Multi-role authorisation beyond admin and operator is post-MVP (MVP 09 §8).

## 16. Retention

Per kind, with defaults: jobs and logs 30 days, trace frames 7 days, artifacts 30 days or a size cap, audit 90 days (`packages/protocol/src/settings.ts`'s `storage` block; `AUDIT_RETENTION_DAYS` in `packages/core/src/config/constants.ts`). Retention applies per run: old runs of a job expire individually; the job row stays while it has any run or while a schedule owns it, and is deleted by the same sweeper otherwise (`packages/core/src/retention/sweeper.ts`). The sweep runs on the existing hourly cadence (`retention.sweepIntervalMinutes` in `enkaku.config.json`, default 60 — looser than the nightly floor this section names, never looser than daily; there is no per-field env override for it, only the config file). A Storage row in Settings shows usage per kind (`GET /api/storage/usage`), computed from a cache (the `storage_usage` table) the sweeper recomputes once at boot and once every 24 hours, never on the request path.

## 17. Non-functional targets (measured, not promised)

A number in this table is a **target** until the Measured column names a plan, a date, and the hardware. Until then it is not quoted to a client (MVP 09 §7).

| Metric | Target | Measured |
|---|---|---|
| Glass-to-glass latency, Device Control, LAN | restated by plan 203 after measuring; the prototype's 150 ms is the reference | not measured |
| Input leg (key or tap to visible effect) | measured with the same overlay | not measured |
| Device Control first picture (Screens stream) then sharp picture | under 100 ms, then under 2 s | not measured |
| Inspector attach, lab device | under 3 s warm, under 8 s cold | not measured |
| Inspector `find` p95 | under 200 ms | not measured |
| Inspector fallbacks during a 10-minute job run on 20 devices | zero | not measured |
| `waitFor` on a push event (phase 2) | resolves on the event, no poll interval | not measured |
| Core restart to all tiles live, owner's 20-device farm | under 60 s, no browser interaction | not measured |
| USB plug to first painted frame | under 5 s warm, under 20 s on first provisioning | not measured |
| USB unplug and replug to recovered stream | under 5 s, no operator action | not measured |
| adb child processes and forwards after 24 h | equal to the count at boot | not measured |
| Concurrent installs per USB root | serialised, never more than one | not measured |
| Screens view, 20 live tiles, 1 h | zero decoder rebuilds except on rotation, zero session restarts | not measured |
| Devices per host | 20 (owner's farm), then 100 on the lab host with the USB topology documented | not measured |
| First run to first device visible, without reading the guide | under 5 minutes | not measured |
| First-run tool provisioning | under 90 s | not measured |
| Full test suite on a laptop | under 2 minutes (then the "never run a full suite" rule is retired) | 140.66 s, plan 224, maintainer's laptop, 2026-09-04 — over target, rule stays in force |
| Settings schema file | under 600 lines | 2 694 today |

Plans 203 (latency), 208 and 152 (inspector), 206 (warm-up), 223 (lifecycle and scale), 224 (first run, test strategy) fill the Measured column. The harness is `scripts/bench-device-nfrs.ts`, extended by plan 203.

## 18. Release and packaging

- The release workflow builds per-OS core binaries on a `v*` tag, boots each and checks `/api/health` before publishing. The binary embeds the Studio export and the bundled packs.
- The release workflow builds the guest agent APK, signs it, computes its sha256, and writes the pin into the toolchain manifest in the same commit as the core release; a core release never ships with an agent pin it did not build (plan 221, source: MVP 10 §3).
- First run: tools are downloaded and verified in under 90 s; provisioning progress is the first thing Studio shows on a fresh install; `bun run doctor` becomes a screen, not only a CLI.
- Packaging for the MVP: a single binary plus a browser. The desktop app (`apps/desktop`, Tauri) stays parked outside the MVP definition of done — not built, not wired to CI or the release workflow, not deleted. Decided by the CEO (`docs/mvp/README.md` Open decisions 6, MVP 09 §4), recorded by plan 224.
- Test strategy: the full backend `bun test` is measured at 140.66 s on the maintainer's laptop (plan 224, §11 handoff report). At or over the 60 s target — deferred; `packages/core` (91.19 s of the total, 234 of 364 files) is the named cause, and the rule stays in force until a later plan lowers the number. One hardware smoke suite on the lab device on every merge to `main` remains a target, not yet built (plan 223 or later; not this plan's scope).

## 19. Guest agent

One APK, provisioned unattended over adb on every admitted device, containing only what must run as an ordinary Android app. Facets: route (`VpnService` SOCKS5 tunnel), screen label (wallpaper), text input (`EnkakuIme`: `text.commit`, `text.status`, the per-device "show soft keyboard with a hardware keyboard" preference), mock location, and, added by the MVP, `ui-tree` (§8) and `activity` (a read-only copy of the device's activity list, pushed by the host; shown stale when the host is silent). Capabilities are advertised by `hello()`; an agent without the new ones is an older build, not an error; `versionCode` increments on every release and the host re-installs when the device reports a lower one.

The status screen (no Compose, 2 s refresh, never overstates, no secrets, omits unknown rows, Copy report): Banner; Now (the activity list); Device (label and number, group, tags, stable id, model, Android version, battery, screen state); Farm link; Video (whether a scrcpy server process runs and at what resolution and fps); Inspector; Route; Checks; Keyboard; Label; Location; This build (with "host expects version X"). Buttons: Refresh, Copy report, Switch keyboard, Open accessibility settings. Plan 221 lands this section (source: MVP 10). Everything is verified on the lab device (Android 16) and spot-checked on the owner's farm before the MVP is called done.

## 20. What the prototype had and the MVP does not

The master list is `docs/mvp/13-removal-register.md`; each MVP plan carries the rows it owns in its §10 and proves them gone by grep. In short: the exclusive-hold model and its second authorisation object, mirror grants, the single-slot device state machine, the quiet-period gate; the console page, saved commands, command runs; direct script publish, script versions, the synthetic recordings owner, workflow rows in `scripts`; child-process workflow steps and `job_nodes`; `schedule_runs`; per-device action routes and their multi-device twins, two target pickers; the device page and its twelve tabs, Topology, Tools, Workspace, Nodes, and the redirect stubs; 89 of 115 settings; lazy session build, "Waking", idle TTLs; the WebRTC client, licensing, telemetry, and the other dead code in MVP 13 Part B. Cloud mode stays in the tree behind its mode flag and outside the definition of done (MVP 06 §4.1). Recordings are parked, not deleted (MVP 06 §4.3).

## 21. Section map from the prototype specification

For readers of `docs/archive/plans/*` and of code comments that cite the prototype spec (`docs/archive/spec-prototype.md`) by section number.

| Prototype § | Topic | MVP § |
|---|---|---|
| 1, 2, 3 | vision, principles, personas | 1 |
| 4 | architecture | 2, 3 |
| 5 | deployment modes | 1 (cloud is post-MVP), 18 |
| 6 | competitor analysis | `docs/mvp/README.md`, Reference competitor |
| 7, 7.1 | five driver layers, engines | 5 |
| 7.2, 7.3, 7.6, 7.7, 7.8 | toolchain, manifest, scrcpy pin, tool API, tool security | 5.2, 15 |
| 7.4 | inspector | 8 |
| 7.5 | stable identity | 5.4 |
| 7.9, 7.10 | network layer, vpn-helper | 9, 19 |
| 7.11 | device preparation | 5.3 (`prep` activity) |
| 8 | registry and schema-driven UI | 14 |
| 9 | input modes | 7 |
| 10, 10.1, 10.2, 10.5 | session, device state, exclusive hold, second authorisation | 4.3 (rewritten: activities and the policy table), 5.3 |
| 10.3, 10.4 | queue, adb serialisation | 12, 2 |
| 11, 11.1, 11.2, 11.3, 11.9 | script framework, trust model, output contract | 4.5, 12 |
| 11.4, 11.5, 11.6 | dependencies, lifecycle, plugins | 4.4, 4.5, 10 |
| 11.7 | workflows | 4.6, 4.8 |
| 11.8 | action recordings | deferred (MVP 06 §4.3) |
| 12, 12.1 to 12.6 | data model, agents, connectors, batches and schedules, console, trace | 4, 4.9, 12 (console: removed) |
| 13 | protocol | 2, 6, 7, 11 |
| 14 | security | 15 |
| 15 | enrollment, battery, thermal | 5.4, 14 |
| 16 | non-functional requirements | 17 |
| 17 | positioning | 1 |
| 18 | housekeeping and business plumbing | 15, 18 |
| 19 | Studio screens | 13 |
| 20, 21, 22 | roadmap, sources, open questions | `docs/plans/200-mvp-program.md` §4, MVP 16 §4 |
