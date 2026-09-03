# MVP 16 — The consolidated picture: what the MVP is, what changes, in what order

> Status: written by the CTO on 2026-09-03 after documents 01–15 were reconciled with the design handoff and the CEO's corrections. **Where this document and an earlier one disagree, this one wins**; the earlier documents keep their research and history.
> Purpose: one page an investor, a client, or a new engineer can read to know what the MVP is; one dependency order the plans from 200 onward follow.

---

## 1. The product, in one page

**Enkaku** is a self-hosted Android phone farm: plug in phones, see all of them live, drive any one of them by hand, and run automation on many of them at once. One host, one binary, one browser. Cloud mode, mirror at scale, and internationalisation come after the MVP.

**Nouns.** A **device** belongs to at most one **group**. A device has a list of **activities** (a job, an install, a transfer, someone controlling it) and a status of offline, online, or quarantined. A **plugin** is the only way code reaches the farm; it has versions and one active version, and it registers **scripts**, which have no version of their own. A **workflow** is a document chaining scripts, authored in the UI, with no version. A **schedule** names a script or workflow, a target, and a cron. A **job** is the intent to run one script or workflow on one device; each execution is a **run**, and runs accumulate. A **batch** is the jobs created together from one target. An **agent** is an AI operator with its own runs, approvals, and **files**.

**Surfaces.** An icon rail with Devices, Scripts & Workflows, Jobs, Plugins, then the dynamic plugin menu, then theme, Settings, avatar. Agents is either the fifth icon or the first plugin entry (open). A status bar with health, counters, alerts, clock. Devices: group tabs, table or Screens grid, discovery sheet, selection with marquee, a bulk pill with the generic action set. **Device Control**: a floating window with hardware shortcuts, the cast with a latency readout, full keyboard and mouse passthrough, Actions, Inspector, and Device (Jobs, Files). Scripts & Workflows: Scripts, Workflows, Schedules. Jobs: Jobs, Batches, detail with Inputs, Output, Logs, Timeline, Artifacts, and a run picker. Plugins. Settings: 15 visible fields, 11 advanced.

**Mechanisms.** Sessions live as long as the device is online; the wall encoder never stops; the browser only attaches. Activities replace leases; a policy table answers allow, warn, or forbid; control is a marker that expires from the last input. Every action takes a target and answers per device. The inspector is a first-party accessibility service in the guest agent with push-based `waitFor`, ui-server as fallback. The guest agent's own screen tells a person holding the phone what the farm is doing to it.

## 2. What changes, area by area

| Area | Today (v0.1.32) | MVP | Documents |
|---|---|---|---|
| Video | session built when a browser asks; "Waking" panel; latency never measured; drag sent on release | always-on wall encoder, control encoder on demand with the wall stream shown meanwhile; PTS carried end to end and a latency overlay; live drag, hardware decode hint, rAF paint, ring buffer | 01, 11 |
| Inspector | openatx instrumentation started per tab, torn down on close, 15–32 s cold start, suspected broken on API 36; agents silently use the slow engine | session-scoped prewarm, fail-fast start, idle-wait configured; then a first-party AccessibilityService with `ui.watch` push | 02, 10 |
| Device state | in-memory lease, assist grant, mirror grant, single-slot busy/manual state machine, twelve gates, six Studio components | one activity list per device, control as a marker, policy table, `devices.status` = offline / online / quarantined | 04 |
| Actions | every action twice (single route and bulk twin), two TargetPickers, job-or-batch branch | `POST /api/actions/<verb>` with a target, per-device results, one dialog per verb with the DevicePicker as its first row, the handoff's generic action set | 07, 15 |
| Scripts | rows with their own versions; direct publish creates hidden owner plugins; recordings under a synthetic plugin; workflows unowned | scripts only through plugins, no script version in the product; workflows in their own table; recordings deferred | 03 §2 |
| Jobs | one table; re-run creates a new job; workflow nodes are child processes and the executor is unreachable; schedules keep their own run table | job is an intent with runs; workflow job orchestrates script jobs as steps; schedules fire runs; one Jobs list plus Batches | 05, 14 |
| Navigation | 14 flat items, 3 redirect stubs, a 12-tab device page, the same entity on several screens | rail with 4 (or 5) items plus plugin menu; no device page; Device Control is the device surface; Groups managed from the Devices strip; no Console; no Recordings | 03, 06, 15 |
| Settings | 115 fields in 22 sections, 9 dead or shadowed | 15 visible, 11 advanced, about 60 constants, in the handoff's two-column layout | 12 |
| Device Control input | three keys mapped, 500 ms text debounce, drag on release, no wheel, no clipboard back | UHID keyboard passthrough, hotkeys, wheel scroll, mouse buttons, pinch, clipboard both ways, host-banner input fan-out to the selection | 08, 15 |
| Guest agent | four facets; status screen knows only the phone's own state | plus `ui-tree` and `activity`; status screen shows what the farm is doing; APK built and pinned by the release | 10 |
| Feature set | cloud mode half built, mirror on grants, console page, recordings, topology, tools page, workspace | cloud after the MVP; mirror as client fan-out; console removed; recordings deferred; workspace is Files under Agents; tools inside Settings | 06 |
| Dead code | two whole subsystems, WebRTC client, unreachable workflow executor, five routes, nine messages, desktop app unwired | all in the removal register with a grep-zero rule per plan | 13 |
| Docs and process | 220 KB spec that wins over code, 129 plans | spec rewritten from these decisions, plans archived, new plans from 130 with a Removed section each | 09 |

## 3. Order of work

Six waves. Core, Studio, and Android work run in parallel within a wave; a wave ends when its acceptance lines are green on the lab device and the owner's farm. Sprint counts are the CTO's estimate for one small team and are the thing most likely to be wrong.

**Wave 0, foundation (1 sprint).** Lab device in hand. Housekeeping plan: delete every Part B row of MVP 13 that no other plan owns. Archive the spec and plans; write the new spec's skeleton from §1. Latency measurement harness (01 step 1). Tokens, fonts, icons, and re-skinned primitives (15 step 1). Branch strategy: the rebuild happens on an `mvp` branch; `main` stays shippable for hotfixes to current clients until wave 3 lands.

**Wave 1, device core (2 sprints).** Activities and the policy table, leases and grants deleted (04). Always-on sessions and the encoder split (11). Actions API with targets and the groups rename (07). Inspector phase 1: session-scoped, fail-fast, idle-wait, capability path fixed (02). Console and mirror removed. Acceptance: no "Waking" anywhere; a job on a controlled device warns and proceeds; 20 devices warm within 60 s of a core restart.

**Wave 2, automation core (2 sprints).** Scripts only via plugins, workflows table, recordings parked (03 §2). Jobs and runs, workflow orchestrator, schedules as runs (05, 14). Settings schema reduced to 26 fields (12). Acceptance: re-run keeps both results; a workflow job shows its steps as script jobs; the settings file is under 600 lines.

**Wave 3, Studio (3 sprints).** Shell and status bar; Devices with groups, discovery, selection, bulk pill; Device Control with the MVP 08 input model and the latency readout; action dialogs with the DevicePicker; Scripts, Workflows, Schedules; Jobs with the timeline and run picker; Plugins; Settings; Agents once designed (15). Each screen deletes its old route. Acceptance: MVP 15 §3 lines per screen; the old `AppShell` is gone.

**Wave 4, Android (2 sprints, in parallel with 2 and 3).** `ui-tree` and `activity` facets, keyboard preferences, the full status screen, APK in the release workflow (10). Inspector phase 2 switches the default engine (02). Acceptance: `waitFor` resolves on a push event; the phone's screen shows the running job; a fresh core install pins the APK it built.

**Wave 5, hardening (1–2 sprints).** Device lifecycle targets (09 §2), the 20-device then 100-device scale run (09 §7), retention (09 §6), first run and packaging (09 §4), test strategy reset (09 §5), spec finalised (09 §1). Acceptance: the numbers in 09, measured, in the README.

Roughly nine to eleven sprints of calendar time with core, Studio, and Android overlapping. The CEO said time is not the constraint; correctness of the rebuild is.

## 4. Decisions still open

1. Agents: fifth rail icon, or first entry of the plugin menu.
2. Confirm the three design revisions: Scripts table without version columns, run picker on Jobs detail, Settings pane reduced to the MVP 12 fields.
3. Lab device (Android 16). Everything in waves 0, 4, and 5 waits on it.
4. Inspector phase 2 as a first-party AccessibilityService (02 §4, 10 §1.1): the CTO recommends it; it is Android work the current team has done once (the guest agent) and the only route to push-based `waitFor`.
5. Live cast at every Screens card width (proposed yes).

## 5. The CTO's advice

1. **Freeze scope now.** Documents 01–15 are the MVP. Anything new goes to a "post-MVP" list, not into a wave. Every idea in this session was good, and the risk the CEO named, A becoming A plus B, is now mostly a scope risk.
2. **Measure before wave 1 ends.** The latency number, the attach number, and the 20-device warm-up number decide whether waves 1 and 2 did their job. Without the lab device we are guessing again.
3. **Design the missing screens before wave 3 starts**: action dialogs with the picker container, the Scripts table without versions, the run picker, Schedules, the workflow editor, Agents. Studio work that starts without them will invent them and the invention will be wrong.
4. **Keep clients on `main` until wave 3.** The rebuild is not shippable halfway; a client seeing half-old, half-new screens is the exact failure the CEO described.
5. **Ship an internal alpha to the owner's farm after wave 2.** Core and automation are testable through the old Studio plus the new activity list; the owner's farm finds what the lab device cannot.
6. **Treat the removal register as a release gate.** A plan whose Removed rows still grep to something is not done, whatever its feature list says.
7. **Tell investors the honest version.** The prototype proved the stack; the MVP is the same stack with a coherent product model, a measured latency and scale number, and a fifth of the settings. That is a stronger story than a feature count.
