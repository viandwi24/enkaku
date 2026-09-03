# Plan 200 — MVP : The program — rules, plan format, waves, and verified references

> Status: active — the conventions document for the MVP series (plans 201–224). Opened 2026-09-03 by the CTO after the scope freeze (`docs/mvp/`, commit `74fa69d`). It is read first by every executing agent and by every plan author. It ships no code.
> Depends on: `docs/plans/00-overview.md` (§3 immutable stack decisions, §4 conventions, §6 template, §7 Definition of Done — all still binding), `docs/mvp/16-consolidated-plan.md` (the product picture and the wave order; wins over any earlier MVP document), `docs/mvp/13-removal-register.md` (the master deletion list).
> Spec references: none yet — the spec is rewritten by plan 202 from `docs/mvp/`; until then, where `docs/spec.md` and `docs/mvp/16` disagree, **`docs/mvp/16` wins** for the MVP series only.
> Ships: none — this is a conventions document, not a milestone plan

---

## 1. What this series is

The prototype (v0.1.32, plans 01–129) proved the stack. The MVP rebuilds the product model on top of the parts that are verified on hardware, and deletes everything the new model replaces. The decisions are frozen in `docs/mvp/` (sixteen documents plus the design handoff). This series turns them into plans an AI builder can execute without inventing anything.

The executing agent is expected to be a **Sonnet-class model**: strong at following an explicit plan, weaker at recovering from an ambiguous one. Every plan in this series is therefore written to remove judgment calls: exact files, exact schemas, exact commands, exact expected outputs, and a checklist whose every line can be verified mechanically. Where a plan cannot be that precise, it says so and names the human who decides.

Reading order for an executing agent, every time, before the first edit:

1. This document, entirely.
2. `docs/plans/00-overview.md` §3, §4, §7.
3. The plan being executed, entirely, including §0 (goal checklist) and §10 (removed).
4. The `docs/mvp/` documents the plan names in its header.
5. `CLAUDE.md` at the repo root (test scoping and the rules that get broken when unknown).

## 2. Rules for the executing agent

These are hard rules. A plan may add rules; it may not relax these.

### 2.1 Scope

- **Build only what the plan's §0 checklist names.** A good idea that is not on the checklist goes into the handoff report (§3.4) under "Observed, not done", never into the code.
- **Delete everything the plan's §10 names**, and nothing it does not name. Deletion is part of the deliverable: a plan whose §10 still greps to a live reference is not done.
- **Do not add compatibility shims, feature flags, `Legacy*` names, or "kept for one release" paths.** `00-overview.md` §4.3 applies: replace, never version. The only exception is a Drizzle migration for data already on disk.
- **Do not touch a file the plan does not name** unless the plan's own step requires it to compile or to keep an existing test green; say so in the report.
- **Do not decide an open question.** §9 of each plan lists them. If execution reaches a point where an open question blocks a step, stop that step, finish every step that does not depend on it, and report.

### 2.2 Reading before writing

- Read every file the step names **before** editing it. Quote the line you are changing in your working notes. Plans cite `file:line` as of 2026-09-03; lines drift, so match on content, not on number.
- When the plan's description of a file disagrees with the file, **the file wins for facts and the plan wins for intent**: implement the intent against the real code and record the discrepancy in the report.
- Never run `git stash`, `git checkout -- .`, `git reset --hard`, or any whole-tree operation. Other agents may be working in the same tree.

### 2.3 Testing

- `bun run typecheck` may be run freely and must be clean before the report.
- Run **only** the test files or directories the plan's §7 names, one invocation at a time, never concurrently with another test run. Never run a bare `bun test`. If a step cannot be tested within that scope, skip the test and say so in the report.
- **Studio and `@enkaku/ui` have no tests** (decided 2026-09-03 with the CEO, §8.3). Do not write a `*.test.tsx` or any test under `packages/studio` or `packages/ui`; do not add happy-dom, testing-library, or a `[test].preload`. Logic that deserves a test lives in `packages/protocol` or `packages/core` and is tested there.
- **Backend tests exist only for the critical list in §8.3.** A test that asserts UI copy, wiring, or a snapshot is not written; an existing one in the files you touch is deleted, not maintained.
- Tests that need a device are gated behind `ENKAKU_TEST_DEVICE=1` and are run by the owner, not the agent, unless the plan says the lab device is attached.
- Every process you started is dead before the report: `ps -Ao pid=,command= | grep -i "[o]penpf"` shows nothing but your shell.

### 2.4 Vocabulary

New words for new concepts, so leftovers are greppable (`docs/mvp/README.md`, Approach):

| Use | Never |
|---|---|
| activity, activities | lease, hold, holder, assist, co-control, grant |
| group | cluster |
| run (of a job), step (of a workflow run) | attempt (except `infraAttempts`), node (for a workflow step) |
| workflow job | job kind |
| Device Control | device page, popup, modal (for the control window) |
| Screens view | wall (in UI copy; `wall` stays as the video profile name in code) |
| action, verb, target | bulk twin, per-device route |
| online / offline / quarantined | idle, manual, busy (as stored device states) |

A plan's §10 lists the forbidden words its area introduces; the report includes the grep proving they are gone from non-archived code.

### 2.5 Do the work yourself

- **Do not delegate.** An executor implements the plan with its own tool calls. It does not spawn subagents, research helpers, or "verification" agents. This is not a style preference: on 2026-09-03 a plan author asked to write one document instead spawned four research agents, burned about 300 000 tokens on reports nobody read, and produced no file. The same failure during execution would produce no code and a confident summary.
- **One executor, one plan, one worktree** (§8.1). If a plan is too large for one executor, that is a defect in the plan, reported in §11, not a reason to fan out.
- **Never predict a result you have not seen.** Run the command, read the output, then write it down. A §0 row marked done without its command having been run is a false claim about the product.

### 2.6 Commits and reporting

- Conventional commits, one plan may span many: `feat(mvp-205): …`, `fix(mvp-205): …`, `chore(mvp-205): …`. No attribution lines.
- Work on the `mvp` branch. `main` stays shippable for hotfixes until wave 3 lands (`docs/mvp/16` §3).
- The plan's `> Status:` line is updated at the end (`implemented`, `partial`, or left `draft` with a reason) and `bash scripts/check-plan-status.sh` passes. Never write `implemented` while §0 has an unchecked box.
- Finish with the handoff report in §3.4's format, in the plan's own §11, committed with the code.

## 3. Plan format for this series

Every plan 201–224 uses `00-overview.md` §6's nine sections **plus** the three below. Section numbers are fixed so an agent can be told "do §5 step 5.3".

### 3.0 §0 — Goal checklist (before §1)

A table, one row per goal, every row verifiable by a command or a measurement, no row that needs judgment:

```markdown
## 0. Goal checklist

| # | Goal | Parameter | Verified by | Done |
|---|---|---|---|---|
| G1 | `POST /api/actions/wake` accepts a target and answers per device | body `{ target: { deviceIds: [..] } }`; response `202` with `results[]` of length = targets | `bun test packages/core/src/api/actions.test.ts` → the named test passes | [ ] |
| G2 | The word `lease` no longer appears outside `docs/archive/` | 0 matches | `rg -n -i "lease" packages apps plugins scripts --glob '!**/*.test.ts'` → empty | [ ] |
| G3 | Cold start of 20 sessions completes under the budget | ≤ 60 s from core start to 20 `device.activity` end-of-prep events, owner's farm | `bun run scripts/bench-device-nfrs.ts --warmup` prints `warm: 20/20 in <N> s`, N ≤ 60 | [ ] |
```

Rules: a parameter is a number, a string, a file path, or a schema, never an adjective. "Verified by" is a command and its expected output, or a measurement and its threshold. A goal that depends on hardware says `owner` in its Done column instead of `[ ]`, and the plan's status can be `implemented (software)` with that row open, as plan 129 did.

### 3.0.1 The `> Ships:` line

`scripts/check-plan-status.sh` fails a plan whose declared status disagrees with whether its artefact exists on disk. A `draft` plan whose `Ships:` path already exists is therefore a build failure, and two plans in this series (217 and 219) shipped that mistake before it was caught.

**Rule: `> Ships:` names a file the plan CREATES, which does not exist when the plan is written.** Verify it with `test -e <path>` before committing the plan. A plan that rebuilds an existing screen names one of the new components it extracts, never the page file it overwrites. A plan that genuinely creates no artefact writes `> Ships: none — <reason>`.

### 3.1 §10 — Removed

A table of every file, export, route, message, setting, table, column, and spec paragraph this plan deletes, each with the grep that proves it is gone:

```markdown
## 10. Removed

| What | Where it was | Proof |
|---|---|---|
| `packages/core/src/lease/` | directory | `test ! -d packages/core/src/lease` |
| `lease.acquire` message | `packages/protocol/src/messages/job.ts` | `rg -n "lease\.acquire" packages apps plugins` → empty |
```

Rows come from `docs/mvp/13-removal-register.md` (Part A rows the plan owns, Part B rows assigned to it). A row that turns out to still have a live consumer outside the plan's scope is reported, not silently kept.

### 3.2 §11 — Handoff report (written by the executing agent)

Filled in at the end of execution, in this order, no other headings:

```markdown
## 11. Handoff report

- **Checklist**: G1 ✅ G2 ✅ G3 ⏳ owner (needs the 20-device farm)
- **Commits**: <hashes>
- **Typecheck**: clean / <errors>
- **Tests run**: <exact commands> → <pass/fail counts>
- **Removed, proven**: <the §10 greps, each with its output>
- **Discrepancies between plan and code**: <file, what the plan said, what was true, what was done>
- **Observed, not done**: <things noticed and deliberately left>
- **Open questions hit**: <§9 items that blocked a step, and which steps were skipped because of them>
- **Processes**: `ps` output confirming none left
```

### 3.3 Writing rules for plan authors

- Cite code as `path:line` **verified by reading the file on the day the plan is written**, and quote the line so the executor can match on content when the number drifts.
- Give schemas as complete Zod or Drizzle code blocks, not prose. Give routes with method, path, body, response, and error codes. Give UI as the handoff's own measurements (`docs/mvp/design_handoff_enkaku_openpf/README.md`), quoted.
- Every implementation step names: files created, files changed, files deleted, the test file that covers it, and the verifiable result.
- State what the executor must **not** do in a step when the obvious move is wrong (for example "do not add a fallback branch for the old message; delete the old handler").
- Length is not a virtue; completeness is. A step an executor can misread is a defect in the plan.
- External facts (library versions, platform behaviour) are cited from §5 of this document or verified again and added there with the date.

## 4. Waves and plans

From `docs/mvp/16` §3. A plan may start when every plan in its "Depends on" column is `implemented` or `implemented (software)`.

| Plan | Wave | Title | Source | Depends on |
|---|---|---|---|---|
| 201 | 0 | Housekeeping: delete already-dead code | MVP 13 Part B | — |
| 202 | 0 | Docs reset: archive the spec and plans, write the MVP spec skeleton | MVP 09 §1, 16 §1 | — |
| 203 | 0 | Latency measurement: PTS end to end, overlay, H-9, bench harness | MVP 01 step 1 | — |
| 204 | 0 | Design tokens, fonts, icons, primitives | MVP 15 §3 step 1 | — |
| 205 | 1 | Device activities and the policy table; leases, co-control, and mirror grants deleted | MVP 04, 06, 13 A.1–A.2 | 201 |
| 206 | 1 | Always-on sessions and the encoder split | MVP 11, 13 A.3 | 205 |
| 207 | 1 | Actions API with targets; groups rename; console removed | MVP 07, 15 §0.1, 13 A.5, A.6a | 205 |
| 208 | 1 | Inspector phase 1: session-scoped, fail-fast, idle-wait, capability path | MVP 02 §4 phase 1 | 206 |
| 209 | 1 | Video and input pipeline: quick wins and the driver-side input verbs | MVP 01 step 2, 08 §2 driver rows | 203, 206 |
| 210 | 2 | Scripts only through plugins; workflows table; recordings parked | MVP 03 §2, 13 A.4 | 207 |
| 211 | 2 | Jobs and runs; workflow orchestrator; schedules as runs | MVP 05, 14, 13 A.4 | 210 |
| 212 | 2 | Settings reduced to 26 fields | MVP 12, 13 A.7 | 205, 211 |
| 213 | 3 | Studio shell and status bar | MVP 15 §0, §3 step 2 | 204, 205 |
| 214 | 3 | Devices: table, Screens, groups, discovery, selection, bulk pill | MVP 15 §0, 04, 07, 11 | 213, 207, 206 |
| 215 | 3 | Device Control: the window and the input model | MVP 08, 15 §0 | 214, 209, 208 |
| 216 | 3 | Action dialogs and the DevicePicker | MVP 07 §2 | 214, 207 |
| 217 | 3 | Scripts, Workflows, Schedules pages | MVP 03, 15 §1 | 213, 210, 211 |
| 218 | 3 | Jobs: list, detail, timeline, artifacts, run picker | MVP 14, 15 §0 | 213, 211 |
| 219 | 3 | Plugins and Settings pages | MVP 12, 15 §0 | 213, 212 |
| 220 | 3 | Agents: Roster, Runs, Approvals, Files | MVP 06, 15 §2 | 213; **design pending** |
| 221 | 4 | Guest agent: `ui-tree`, `activity`, keyboard preferences, status screen, release APK | MVP 10 | 205, 208 |
| 222 | 4 | Inspector phase 2: `ui-tree` becomes the default engine | MVP 02 §4 phase 2 | 221 |
| 223 | 5 | Device lifecycle hardening and the scale runs | MVP 09 §2, §7 | 206, 214 |
| 224 | 5 | Retention, first run and packaging, test strategy, spec final | MVP 09 §1, §4, §5, §6 | 202, 219 |

## 5. Verified external references

Checked on 2026-09-03. A plan cites these by row; an author who needs a fact not here verifies it and adds a row with the date. Where a source was ambiguous, the caveat says what still has to be confirmed on hardware.

| # | Fact | Source | Caveat |
|---|---|---|---|
| R1 | scrcpy's latest release is **v4.1** (VP8/VP9 encoders, size-constraint algorithm, media scan after transfer); **v4.0** migrated SDL2→SDL3, added flex displays and `--keep-active`; the 3.3.x line ended at **v3.3.4**. The repo pins **3.3.1** (`packages/scrcpy/src/version.ts:11`). | https://github.com/Genymobile/scrcpy/releases | Release dates as summarised by the fetch tool were inconsistent; cite versions, not dates. The server control-message byte layout must be re-verified against the pinned tag's Java source (`TODO-verify` markers in `packages/scrcpy/src/control/messages.ts:5`, `demuxer.ts:6`, `session.ts:154`); plan 203 does this. Upgrading the pin is a decision for plan 209 §9, not a side effect. |
| R2 | scrcpy UHID keyboard and mouse (a virtual HID device on the phone) exists since **v2.4**; the device keyboard layout must match the host's, switchable with MOD+k in scrcpy or from device settings. | https://github.com/Genymobile/scrcpy (README, `doc/keyboard.md`) | `UHID_MIN_API = 29` in `version.ts:20` matches upstream. |
| R3 | WebCodecs `VideoDecoderConfig.hardwareAcceleration` takes `"no-preference"` (default), `"prefer-hardware"`, `"prefer-software"`; `optimizeForLatency: true` hints the decoder to minimise chunks before output. | https://developer.mozilla.org/en-US/docs/Web/API/VideoDecoder/configure, https://www.w3.org/TR/webcodecs/ | `configure()` may reject `prefer-hardware`; the plan must fall back to `no-preference` on `NotSupportedError`. |
| R4 | Android 13+ **restricted settings** block enabling an AccessibilityService for apps installed by a **non-session** installer (browser, file manager); session-based installers are exempt. `settings put secure enabled_accessibility_services` can be refused with the log line `Skipping enabling service disallowed by device admin policy`. The documented ADB workaround is `adb shell cmd appops set <package> ACCESS_RESTRICTED_SETTINGS allow`, then the settings write. | https://www.esper.io/blog/android-13-sideloading-restriction-harder-malware-abuse-accessibility-apis, https://dev.moe/en/3030, https://community.ikeymonitor.com/t/how-to-enable-accessibility-services-on-android-with-restricted-settings-error/196 | Whether `adb install` (a session install through `pm`) is exempt on every OEM is **not settled by any source**; plan 221 treats the appops call as mandatory before the settings write and verifies both on the lab device. The status screen's "Open accessibility settings" button (MVP 10 §2) is the last resort. |
| R5 | openatx `android-uiautomator-server` latest release is **2.4.0** (FastInputIME replaced by AdbKeyboard, `ADB_KEYBOARD_SMART_ENTER`); 2.3.11 added `uiAutomationFlags` on `ConfiguratorInfo` and `maxDepth` on `dumpWindowHierarchy`; 2.3.8 added `checkAccessibilityService`. The repo pins **2.3.3** (`packages/toolchain/manifest/enkaku-tools.json:87-129`). | https://github.com/openatx/android-uiautomator-server/releases | No release note mentions API 36; plan 208 tests 2.4.0 on the lab device before changing the pin and computes the sha256 itself. `ConfiguratorInfo` is the JSON-RPC surface for the idle-wait timeouts MVP 02 §4 phase 1 needs. |
| R6 | `@phosphor-icons/react` latest is **2.1.10**; Phosphor web font `@phosphor-icons/web` 2.1.1 is what the handoff uses by class name. | https://www.npmjs.com/package/@phosphor-icons/react, https://github.com/phosphor-icons/react | Studio uses the React package (tree-shakeable), the plugin icon allowlist maps ids to Phosphor names. |
| R7 | Geist self-hosting: `@fontsource-variable/geist` **5.3.0** and `@fontsource-variable/geist-mono` **5.3.0** (variable fonts); the `geist` npm package (1.7.2) is the Next.js-oriented wrapper. | https://www.npmjs.com/package/@fontsource-variable/geist, https://www.npmjs.com/package/@fontsource-variable/geist-mono, https://vercel.com/font | Self-host: the core serves Studio on LANs without internet. |
| R8 | Bun `ServerWebSocket.send()` returns `-1` when the message was enqueued under backpressure and `0` when dropped; `Bun.serve` websocket options include `backpressureLimit`, `closeOnBackpressureLimit`, and a `drain()` handler called when a backpressured socket is ready again. | https://bun.com/docs/runtime/http/websockets, https://bun.com/reference/bun/ServerWebSocket | `getBufferedAmount()` is used by the repo today (`ws-handlers.ts:917-973`) and exists on `ServerWebSocket`; plan 206 keeps it and adds `drain()`. |

## 6. Branch strategy and gates

- All MVP work on branch `mvp`, cut from `main` at `74fa69d`. Hotfixes for current clients land on `main` and are cherry-picked forward only if a plan needs them.
- **Wave gates** (`docs/mvp/16` §3): a wave closes when every plan in it is `implemented` or `implemented (software)` with only `owner` rows open, `bun run typecheck` is clean, `bash scripts/check-plan-status.sh` passes, and the owner has run the full suites once.
- **Removal gate**: before a wave closes, the union of its plans' §10 greps is run once from the repo root; any hit blocks the gate.
- After wave 3, `mvp` merges to `main` and the old Studio is gone. Nothing merges to `main` before that.

## 7. Immutable decisions, restated for this series

`00-overview.md` §3 stands unchanged: Bun + Hono, Next.js static export, SQLite + Drizzle, Zod at every boundary, vanilla scrcpy-server pinned in one file, `adb kill-server` only in `cycle()`, crash containment never called a sandbox, `stableId` as identity.

Added by the MVP, equally immutable for this series:

- A script exists only inside a plugin and has no version of its own (MVP 03 §2).
- A device's state is `offline | online | quarantined` plus an activity list; there is no lease (MVP 04).
- A session lives as long as the device is online (MVP 11).
- Every action takes a target and answers per device (MVP 07).
- A job is an intent; a run is an execution (MVP 14).
- The design of record is the handoff in `docs/mvp/design_handoff_enkaku_openpf/`, as corrected by MVP 15 §0.1 and §1.

## 8. Parallel execution schedule and the testing policy

Derived from §4's dependency column. A stage starts when every plan it waits on is `implemented` or `implemented (software)` on `mvp`.

| Round | Runs in parallel | Agents busy |
|---|---|---|
| R1 | 201, 202, 203, 204 | 4 |
| R2 | 205 | 1 |
| R3 | 206, 207, 213 | 3 |
| R4 | 208, 209, 210, 214 | 4 |
| R5 | 211, 215, 216, 221, 223 | **5 (peak)** |
| R6 | 212, 217, 218, 222 | 4 |
| R7 | 219, 220 | 2 |
| R8 | 224 | 1 |

Computed from §4's dependency column, not assigned by hand: a plan enters the earliest round in which every plan it waits on has finished. **The peak is five concurrent plans, at R5.** More than five executors cannot be kept busy at any point, and at R2 and R8 only one plan is eligible at all.

**The graph is deep, not wide.** Two plans are the reason:

- **205 is the first chokepoint.** Plans 206, 207, 213 and 221 all wait on the activity model, so R2 runs one plan while everything else idles.
- **213 is the second.** All eight Studio plans render inside the shell, so none of 214 to 220 can start before it lands.

Widening past five means re-cutting those two plans (for example splitting 205 into "the schemas and registry others import" and "the deletion sweep across the twelve gates", so R3 could start a round earlier). That is a real option, but it buys one or two rounds and adds an integration seam to the riskiest plan in the series, so it is not proposed.

**The practical limit is lower than five anyway.** Five concurrent executors all edit `packages/protocol/src/`, `packages/core/src/server/ws-handlers.ts`, `packages/core/src/db/schema.ts` and `packages/core/src/daemon.ts`. §8.1's merge order is what keeps that survivable; adding agents past five would multiply conflicts without shortening the chain.

### 8.1 Worktrees and merging

- Each executor works in its own git worktree on branch `mvp/<plan>` cut from `mvp` at the moment its stage starts (`git worktree add ../openpf-<plan> -b mvp/<plan> mvp`). Never two executors in one checkout.
- A plan merges into `mvp` when its §11 handoff report is complete. Merge order within a stage follows the plan number. The later plan resolves conflicts; it re-runs its own scoped tests after the merge.
- Files that several plans in one stage touch (`packages/protocol/src/*`, `packages/core/src/server/ws-handlers.ts`, `packages/core/src/db/schema.ts`, `packages/core/src/daemon.ts`, `packages/studio/src/lib/api.ts`) are edited additively where the plan allows it; a plan that must rewrite one of them says so in its §5 and is merged first in its stage.

### 8.2 Testing policy: write and run scoped tests per plan; defer only the expensive runs

Decided 2026-09-03 with the CEO. Executors may run in parallel and focus on writing code, with this division:

| Runs during the plan, by the executor | Runs once at the wave gate, by the owner |
|---|---|
| `bun run typecheck` (seconds) | the full `bun test` |
| the plan's own test files, one `bun test <file or dir>` at a time, never concurrently with another run (seconds to two minutes) | `bun run --cwd packages/studio test` and `bun run --cwd packages/ui test` |
| the §10 removal greps for the plan's own rows | the union of every §10 grep in the wave |
| | every `owner` row in §0 (lab device, owner's farm) |
| | `bash scripts/check-plan-status.sh`, `bash scripts/check-dead-code.sh` |

The scoped tests are not optional: they are what turns a §0 row from a claim into evidence while five executors change shared files at once. What is deferred is the expensive part, which is also the part that once overheated the maintainer's machine (`CLAUDE.md`, "NEVER run a full test suite"). An executor that cannot scope a test to the files it touched skips it and says so in §11; it does not run a suite to compensate.

### 8.3 What is tested, and what is not (decided 2026-09-03 with the CEO)

The prototype's Studio suite is about 170 isolated processes, each building a DOM, about 80 s per run, and it once overheated the maintainer's machine. Most of it asserts copy and wiring on screens the MVP deletes. The MVP replaces it with three checks: `bun run typecheck`, the design handoff as the specification, and one owner smoke run on the farm at each wave gate.

**Studio and `@enkaku/ui`: zero tests.** Plan 201 deletes every `packages/studio/**/*.test.ts(x)`, `packages/ui/**/*.test.ts(x)`, `packages/studio/bunfig.toml`'s `[test]` block, the happy-dom and testing-library dependencies, the `test` scripts in both `package.json`s, and the two CI steps that run them. No MVP plan adds one back.

**Backend: tests only for the critical list.** A test is written for, and only for:

| Area | Why it is critical |
|---|---|
| `packages/protocol` Zod schemas and binary framing | the wire contract between core, Studio, node, plugins |
| activity policy matrix (205), target resolver (207), actions per-device results | the rules that decide whether something runs on a phone |
| Drizzle migrations that rewrite rows (205, 207, 210, 211) | data already on disk |
| queue claim SQL, heartbeat reaper, workflow orchestrator, runs (211) | job correctness under concurrency |
| scrcpy demuxer, frame header, UHID report encoders (203, 209) | byte layouts nothing else checks |
| plugin stage → verify → activate pipeline | the only way code reaches a farm |
| inspector lifecycle state machine and fail-fast parser (208) | the automation bottleneck |
| toolchain sha256 and download verification | supply chain |

**The principle behind the list, so a plan can apply it to something the list does not name:** a backend test is written where **a wrong answer would be silent** — a byte layout, a schema contract, a rules matrix, a migration over rows already on disk, a decision made inside a SQL transaction. Those are the places where the code compiles, the screen looks right, and the product is wrong. Nothing is tested merely because it is code.

Not tested: HTTP route wiring, UI copy, settings section lists, log wording, anything a typecheck already proves. An existing backend test outside the list is deleted by the plan that touches its module (listed in that plan's §10).

**Target:** the full backend `bun test` under 60 s on the maintainer's laptop by plan 224, at which point `CLAUDE.md`'s "never run a full suite" rule is retired and executors run their package's suite instead of scoped files.

### 8.4 Estimated duration per stage

Added 2026-09-03 at the CEO's request. **These are the CTO's estimates and the least reliable numbers in this document.** Each figure is one executor working one plan, including reading the plan, writing the code, fixing typecheck fallout, running its scoped tests, proving its removal greps, and writing its §11 report. "Integration" is the merge into `mvp` plus re-running the stage's scoped tests after the merge.

| Stage | Plans in parallel | Longest plan in the stage | Integration | Stage total |
|---|---|---|---|---|
| 1 | 201 (3d), 202 (2d), 203 (4d), 204 (4d) | 4d | 1d | **5d** |
| 2 | 205 (6d) | 6d | 1d | **7d** |
| 3 | 206 (5d), 207 (6d), 213 (5d) | 6d | 1d | **7d** |
| 4 | 208 (4d), 209 (6d), 210 (5d), 221 (8d) | 8d (Android) | 1d | **9d** |
| 5 | 211 (8d), 214 (6d), 222 (5d) | 8d (schema surgery) | 1d | **9d** |
| 6 | 212 (5d), 215 (6d), 216 (5d), 217 (5d), 218 (7d) | 7d | 2d (five merges) | **9d** |
| 7 | 219 (4d), 220 (4d), 223 (3d) | 4d | 1d | **5d** |
| 8 | 224 (4d) | 4d | 0d | **4d** |

**Total: about 55 working days, roughly 11 working weeks.**

Three things that make that number optimistic, in order of how likely they are to bite:

1. **Review is the real bottleneck, not execution.** Twenty-four plans produce far more code than one person can read carefully in eleven weeks. The estimate assumes the owner reviews a stage while the next one is being written; if review queues, every later stage slides by the same amount. Nothing about adding executors fixes this.
2. **Two plans carry most of the risk.** Plan 205 (deleting leases across twelve gates, with a migration) and plan 211 (splitting thirty-four job columns and re-keying logs, traces and artifacts to runs) are the two where a mistake is expensive and quiet. Both sit on the critical path. Budget re-work, not just work.
3. **Without a lab device (§1 of `docs/mvp/DECISIONS-PENDING.md`), the `owner` rows do not close.** That does not lengthen the schedule, but it means stage 8 finishes with the product's headline numbers unmeasured.

**Critical path:** 201 → 205 → 207 → 210 → 211 → 212 → 219 → 224, eight plans, about 40 of the 55 days. Shortening anything off that path buys nothing.
