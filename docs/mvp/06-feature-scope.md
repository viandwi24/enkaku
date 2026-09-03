# MVP 06 — Feature scope: keep, merge, defer

> Status: proposed by the CTO, 2026-09-03. Three items need the CEO (§4).
> Ask as reported: make the feature set compact and straight to the point.
> Rule applied: a feature is in the MVP only if it sits on the main path: connect a device, run automation, see the result. Everything else becomes a plugin, folds into another surface, or waits.
> **Amended by MVP 15 (design handoff):** mirror returns as a client-side input fan-out from Device Control's host banner (no grants); the seven-tab device page in §1 is replaced by Device Control (Actions, Inspector, Device with Jobs and Files), the log Console, and the plugin views. Schedules are an attribute of workflows and scripts, not a tab.

---

## 0. Inventory (as of v0.1.32)

- 14 sidebar pages plus the plugin-view group (MVP 03 §0).
- 12 device tabs: Control, Jobs, Monitor, Crashes, Terminal, Files, Network, Agent, Identity, Logs, Storage, Settings.
- 22 farm settings sections in four groups: Devices (Defaults, Battery, adb, Discovery & monitoring, Guest agent, Video, Sessions & Wall, Assist & mirror, Recording), Jobs (Jobs, Storage), AI Agents (Defaults, Connectors, Webhooks, Spend, Workspace), Farm (Blocked devices, Terminal & transfer, Network, Key/Value store, Users, Audit log).
- 31 API route groups: agents, artifacts, auth, batches, clusters, command-runs, connectors, devices, doctor, guest-agent, jobs, kv, nodes, notifications, plugins, recordings, saved-commands, schedules, scripts, settings, tags, tokens, topology, transfers, video, webhooks, workflows, workspace.
- 19 capability files: agent, device-app, device-clipboard, device-files, device-input, device-inspect, device-network, device-state, file-tools, fs, job, job-trace, notify, script, skills.
- Bundled plugins: google, tiktok, youtube automation packs; proxy-manager; mikrotik-routing; networking.

## 1. Devices

| Feature | Today | MVP | Why |
|---|---|---|---|
| Wall / list, selection, bulk toolbar | `/` | keep | main path |
| Clusters, renamed **Groups** | own page | fold into the Devices tab strip (MVP 03); the word cluster leaves the UI, API, and schema | one-to-one with the wall grouping |
| Tags, device numbers | fields + filters | keep | cheap, used by targeting |
| Discovery / scan, admit, quarantine, blocked | page sections + dialogs | keep; blocked list moves to Settings → Access | main path |
| Wake / readiness, battery policy | device + farm settings | keep | field-proven |
| Control (live, inspect, record) | tab | keep | main path |
| Jobs tab | tab | keep | main path |
| Logs, Monitor, Crashes | three tabs | **one tab: Diagnostics** | same audience, same moment |
| Terminal, Files | tabs | keep | daily use |
| Network + Agent | two tabs | **one tab: Network** | the guest agent is the network engine |
| Identity | tab | fold into device Settings | written once |
| Storage (device-scoped plugin KV) | tab | move to each plugin's view | it is plugin data, not device data |
| Mirror (one input to many devices) | feature + settings | **defer** | built on grants that MVP 04 deletes; rebuild later as a bulk action on top of control markers |
| Console (adb command page, saved commands, command runs, the handoff's log console) | page | **removed** (CEO, 2026-09-03); "Adb command" stays as one action in the generic set | one action, not a destination |
| Topology, `/dev/tools`, old redirects | routes | delete | dead |

Device tabs after: none. The device page is deleted (MVP 15 §1); Device Control carries Actions, Inspector, and Device (Jobs, Files). Logs, monitor, and crashes reach the operator through the Jobs detail and the activity list; per-device settings through the Settings action.

## 2. Automation

| Feature | Today | MVP | Why |
|---|---|---|---|
| Scripts (plugin members), param sets | list + detail | keep (MVP 03 §2) | main path |
| Workflows | list + editor | keep, own table (MVP 03 §2) | main path |
| Recordings | list + detail + publish | **deferred** (CEO, 2026-09-03): not in the nav, not in the definition of done; code parked, not deleted | drags trace frames, parameterisation, and compile-to-plugin with it |
| Script jobs, workflow jobs | jobs | keep (MVP 05) | main path |
| Batches, schedules | pages | tabs under Jobs | main path |
| Job trace (timeline, frames, UI captures) | job detail | keep | it is how a failed job is read |
| Artifacts | per job / batch, zip | keep | result delivery |
| Resume | job route | keep, workflow jobs only (MVP 05) | |

## 3. Platform

| Feature | Today | MVP | Why |
|---|---|---|---|
| Plugins: install, verify, activate, rollback, disable, dev slots, surface (nav, views, actions), service, webhooks, KV | pages + routes | keep; KV browser moves from farm settings to the Plugins page | the extension model |
| Toolchain (Tools page), doctor | page | Settings → Toolchain (MVP 03) | configuration |
| Users, tokens, audit log, terminal & transfer policy | scattered sections | Settings → Access (one group) | one audience: the admin |
| Notifications bell | shell | keep | |
| Farm settings | 22 sections | about 10: Devices, Video, Discovery, Guest agent, Jobs & storage, Network, Access, Toolchain, Plugins, Recording (if kept) | the five AI sections move to Agents; Assist & mirror is deleted; Sessions & Wall merges into Video |
| Cloud mode: control plane, nodes, enrollment, tunnel | orchestrator mode, `/nodes`, `packages/node` | **decision needed (§4.1)** | half-built: no quality negotiation, no keyframe priming, no arbiter on remote sessions (MVP 01 §1.6) |
| AI agents: roster, workbench, runs, approvals, Files (Workspace renamed), connectors, spend, skills, notify | four pages + five settings sections | keep in core, one page: Roster, Runs, Approvals, Files, Settings; **not yet designed** (MVP 15 §2) | large surface, not on the main path for every client |

## 4. Decisions needed

1. **Cloud mode.** Proposed: the MVP is one host with local devices; orchestrator mode, nodes, and enrollment ship as the release after the MVP. Not deleted; hidden behind the mode flag it already has, and excluded from the MVP definition of done.
2. **AI agents.** Proposed: keep in core, compacted to one page with its settings on that page. The alternative is an official plugin; the CTO leans core because the capability broker the agents use is the same one plugins use, and moving it out buys little.
3. **Recordings.** Decided 2026-09-03: deferred.

## 5. Removed (to be verified by grep when the plans land)

Mirror (`mirror.*` messages, `mirror/group.ts`, `input.mirror`), Storage tab, Identity tab, Crashes/Monitor/Logs as separate tabs, `/console`, `/topology`, `/dev/tools`, `/clusters`, `/tools`, `/nodes` (folded), farm settings sections Assist & mirror, Sessions & Wall, AI defaults, Connectors, Webhooks, Spend, Workspace (moved), Key/Value store (moved).
