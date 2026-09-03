# MVP finalization — index

> Status: research phase. Opened 2026-09-03.
> Everything the repo has shipped so far (v0.1.32, plans 01–129) is treated here as **proof of concept and prototype**. The MVP ("minimum value product") is the first release we commit to in front of investors and clients. Documents in this directory record the gap between the prototype and that release, one topic per file, each grounded in the code as it stands (file and line references) rather than in memory.

## How to read this directory

- **Start with [16](16-consolidated-plan.md)**: it is the wired-up picture and wins over any earlier document where they disagree. Documents 01–15 hold the evidence and the history of each decision.
- Each document opens with the complaint as it was reported, then the evidence from the code, then the proposed plan ranked by cost. A claim without a `file:line` reference is an opinion and is marked as such.
- These are **research and decision documents**, not milestone plans. Once a decision is taken, the work is written up as a normal plan under `docs/plans/` following `docs/plans/00-overview.md`, and the MVP document links to it.
- `docs/spec.md` remains the single source of truth. Where an MVP document proposes changing a spec commitment, it says so explicitly.

## Documents

| # | Topic | Reported by | Status |
|---|---|---|---|
| [01](01-casting-latency.md) | Screen casting feels delayed compared with Panda (some3c) | investors and clients, 2026-09-03 | researched, plan proposed, no decision |
| [02](02-inspector-readiness.md) | The UI inspector (ui-server) wakes up slowly and times out, so automation scripts stall waiting for the UI tree | investors and clients, 2026-09-03 | researched, plan proposed, no decision |
| [03](03-navigation-and-pages.md) | The Studio navigation is confusing; fourteen flat items and the same entity listed on several screens | CEO, 2026-09-03 | under discussion; one decision recorded in §2 |
| [04](04-device-activity.md) | Leases and control get in the way; replace them with a per-device activity list, control as a marker, and a warn/forbid policy | CEO, 2026-09-03 | direction decided; model proposed |
| [05](05-jobs-model.md) | Two job systems: script jobs as the unit of execution, workflow jobs as orchestrators of script jobs | CEO, 2026-09-03 | direction decided; model proposed |
| [06](06-feature-scope.md) | Feature scope: keep, merge, defer, with three large items needing a decision | CEO, 2026-09-03 | proposed |
| [07](07-actions-api.md) | One action model: every action takes a target, responses are per device, one Studio component per verb | CEO, 2026-09-03 | direction decided; convention proposed |
| [08](08-device-control.md) | Device Control: live drag, wheel scroll, mouse buttons, full keyboard passthrough over UHID, hotkeys, clipboard both ways | CEO, 2026-09-03 | direction decided; specification proposed |
| [09](09-additional-scope.md) | Additional scope proposed by the CTO: spec reset, device lifecycle reliability, honest vocabulary, first run and packaging, test strategy, retention, a measured scale number | CTO, 2026-09-03 | proposed |
| [10](10-guest-agent.md) | Guest agent APK: `ui-tree` and `activity` facets, keyboard preferences, a complete status screen, APK built and pinned by the release | CEO, 2026-09-03 | direction decided; scope proposed |
| [11](11-always-on.md) | Always on: a session lives as long as the device is online, the wall encoder never stops, the browser only attaches; "Waking" is deleted | CEO, 2026-09-03 | direction decided; model proposed |
| [12](12-settings.md) | Settings: 115 fields become 15 visible and 11 advanced; the rest are constants, removed, or moved | CEO, 2026-09-03 | direction decided; classification proposed |
| [13](13-removal-register.md) | Removal register: everything switched off by the MVP (Part A) and everything already dead in the code (Part B) | CEO, 2026-09-03 | compiled: Part A from decisions, Part B from a full code scan |
| [14](14-jobs-and-runs.md) | A job is an intent, a run is an execution: re-running keeps every previous result beside the new one | CEO, 2026-09-03 | direction decided; model proposed |
| [16](16-consolidated-plan.md) | The consolidated picture: the product in one page, what changes area by area, six waves of work, open decisions, the CTO's advice. Wins over earlier documents where they disagree | CTO, 2026-09-03 | current |
| [15](15-ui-migration.md) | UI migration: the design handoff (`design_handoff_enkaku_openpf/`) is the design of record; where it and 03–14 disagree, which side wins; rebuild order | CEO, 2026-09-03 | direction decided; CEO corrections in §0.1 (Schedules under Scripts, Files under Agents, Groups, no Console, Recordings deferred); Agents and Nodes undesigned |

## Reference competitor

Panda by some3c (`https://panda.some3c.com/`, manual at `https://doc.some3c.com/panda-manual/quickstart`) is the product clients compare us against. What its public pages claim, quoted for the record:

- Native Windows 10/11 and macOS 12+ client, no web client. Talks "standard ADB protocol" to Android 6.0+.
- "Millisecond-level latency" for keystrokes, gestures, and commands.
- 24 FPS real-time thumbnail previews.
- Up to 500 connections on one computer (manual) and "up to 1,000 Android devices" (marketing), hardware and network dependent.
- Batch synchronisation, ADB command console, text and file distribution, random delay and offset, record and replay, scheduled tasks, "JS/ADB" scripts, visual flow automation.
- Free for the first 40 devices, subscription beyond that.
- Nothing published about codec, hardware decoding, or a UI element inspector.

The public pages do not explain how the latency is achieved. The realistic reading is that a native client with a hardware H.264 decoder drawing straight to a window has fewer moving parts than a browser, not that it uses a different protocol.

## Approach: what is kept and what is rebuilt

Decided by the CTO on 2026-09-03 after the CEO made clear that the MVP is not bound to revising existing code and that time is not the constraint. The risk named was specific: a revision that leaves an old feature merged with its replacement, so that a feature meant to be A ships as A plus B.

**Kept**, because it is verified on hardware and encodes field incidents a rewrite would lose: the adb client, scrcpy integration, toolchain manager, the five driver layers, the guest agent, the job runner and its crash containment, the binary WS framing, the plugin stage-verify-activate pipeline, SQLite plus Drizzle.

**Rebuilt from scratch**, because the product semantics changed: the device state model (04), the jobs model (05), script and workflow ownership (03 §2), Studio navigation and every screen that touches control (03).

**Guards against A becoming A plus B:**

1. Every MVP plan carries a "Removed" section listing files, messages, settings, and spec paragraphs, and the plan is not done until a grep for each name returns zero references outside its own changelog.
2. Spec sections are rewritten, never appended to. A rewritten section drops its history notes.
3. A new concept gets a new word (activity, not lease; step, not node; workflow job, not job kind) so leftovers are greppable.
4. Old routes and messages get no compatibility shim beyond one release, and the shim is listed in "Removed" of the release after.

## Open decisions for the CEO

1. One Android 16 (API 36) device for the lab. Both documents need it; the owner's 20-device Samsung farm runs API 36 and cannot be experimented on.
2. Whether the first casting sprint is allowed to be a measurement sprint (document 01 §4, step 1).
3. Whether to fund a first-party inspector inside the guest agent (document 02 §4, phase 2), estimated at two to three sprints of Android work.
4. Document 05 §4: single-device, sequential workflows only for the MVP.
5. Document 06 §4: cloud mode after the MVP; AI agents kept in core but compacted (decided); recordings deferred (decided).
6. Document 09: which of the seven additional items enter the MVP; the CTO recommends all of 1–4 and 7, with 5 and 6 allowed to slip one release.
7. Document 15 §4: where Agents lives; confirm the three design revisions the documents force (Scripts table without versions, run picker on Jobs detail, Settings reduced to the MVP 12 fields); live cast at every Screens card width.
