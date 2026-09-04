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
- **Before you generate a migration, read `packages/core/drizzle/meta/_journal.json` and take the next free index — and say in §11 which index you took.** Two rounds in a row produced a collision: 206 and 207 both generated 0066, then 210 and 214 both generated 0068. A collision between two schema migrations cannot be fixed by renumbering, because the later plan's snapshot was generated against a schema that never existed; it has to be discarded and regenerated from the merged tree. Cheap to avoid, expensive to discover.
- **Commit a checkpoint every few files, never only at the end.** Two executors in this programme lost their connection mid-sweep, one with 176 files and 12 000 deletions uncommitted, and the work survived only because a checkpoint had just been taken. A `wip(mvp-NNN): <what>, mid step NNN.x` commit costs nothing and is the only thing standing between a dropped stream and hours of lost work. The round gate squashes nothing: checkpoints merge as they are.
- **A test your change broke is yours to fix, whatever its path.** "Out of scope" applies to work you were not asked to do, never to damage you caused. Plan 205's executor left nine failing tests in a plugin because the file was not in its §7; the fix was one word (§8.7).
- **Do not decide an open question.** §9 of each plan lists them. If execution reaches a point where an open question blocks a step, stop that step, finish every step that does not depend on it, and report.

### 2.2 Reading before writing

- Read every file the step names **before** editing it. Quote the line you are changing in your working notes. Plans cite `file:line` as of 2026-09-03; lines drift, so match on content, not on number.
- When the plan's description of a file disagrees with the file, **the file wins for facts and the plan wins for intent**: implement the intent against the real code and record the discrepancy in the report.
- Never run `git stash`, `git checkout -- .`, `git reset --hard`, or any whole-tree operation. Other agents may be working in the same tree **`git stash` is forbidden in every form, including a path-scoped `git stash push <file>`** — plan 223's executor used the scoped form to test whether a fixture bug predated its work, restored it immediately, lost nothing, and reported it plainly. The rule stays absolute anyway: it exists because one agent's whole-tree stash wiped 324 files belonging to three others, and a rule with a "when it is obviously safe" exemption is one an executor under time pressure will read as permission. To compare against an earlier state, use `git show <ref>:<path>`, `git diff`, or a copy in the scratchpad — never anything that moves the working tree.

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

### 2.6 Studio rules a plan's code block may not carry

Found by executing plan 204 on 2026-09-03: its `lib/theme.ts` code block omitted the `'use client'` directive and **the build failed until the executor added it**. A plan's code block is an excerpt written for a human reader; these rules hold whether or not the block shows them.

- **`'use client'` is the first line of every file you create that uses a hook, an event handler, a browser API, or a context.** Next.js is in static-export mode: a component that reaches for `useState`, `useEffect`, `useRef`, `onClick` or `window` without it fails the build. If the plan's block omits it, add it and note the correction in §11 — do not restructure the component to avoid needing it.
- **The prototype colour tokens still exist.** Plan 204 kept its "block D" verbatim because deleting it would unstyle 168 Studio files and 14 plugin views on `mvp` before wave 3 lands (plan 204 §9 Q1, the owner's call). Your new components use the handoff palette; the old block staying is not an invitation to use it, and not a bug to fix.
- **A plan's `rg` list of call sites may be short.** Plan 204's own grep missed a fifth `Switch size="sm"` site. Re-run the plan's grep yourself before you assume its list is complete, and report any site it missed.
- **`bun run build:studio` is part of your verification, not only `typecheck`.** A missing directive, a bad import path, or a server/client boundary error passes typecheck and fails the export.

### 2.7 Commits and reporting

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
| 216 | 3 | Action dialogs and the DevicePicker | MVP 07 §2 | 214, 207, **215** |
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

- **Put worktrees OUTSIDE the repository.** `git worktree add ../openpf-<plan>`, never `.claude/worktrees/` inside it. A worktree nested in the repo is walked by every editor and indexer that has the project open: on 2026-09-04 Zed's git integration re-ran `git diff --numstat HEAD` across the nested copies on every file an agent wrote, spawning storms of 17-plus git processes. `.zed/settings.json` now excludes them for Zed specifically, but the durable fix is not to nest them.
- **Remove a worktree the moment its branch is merged.** Each worktree is a full checkout with its own `node_modules`; eight of them reached 9.5 GB and drove the maintainer's machine to a load average of 116 with `kernel_task` at 38 % on 2026-09-04, because every file watcher and indexer on the machine was walking eight copies of the monorepo. `git worktree remove --force <path>` after the merge, and check `git worktree list` at every round gate.
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

### 8.5 The round gate: reconcile the downstream plans before the next round starts

Added 2026-09-03 at the CEO's request, after round R1's first finished plan produced three facts that contradicted plans not yet run.

A plan is written against the codebase as it was on the day it was written. An executed plan changes that codebase, and an executor's §11 report is the only place the difference is recorded. **Between rounds, before any executor for the next round is launched, the programme owner reconciles the plans that have not run yet.** This is not optional cleanup; a plan that contradicts the tree it will run against is how a Sonnet-class executor produces confident, wrong work.

The gate, in order:

1. **Read every §11 finished in the round.** Four fields carry the reconciliation load: *Discrepancies between plan and code*, *Observed, not done*, *Open questions hit*, and the §10 proofs that did not come back empty.
2. **For each discrepancy, find every unrun plan that repeats the same wrong assumption** and amend it. Amend, do not rewrite: append a dated `## 12. Amendment` (or a further one) stating what changed and which of the plan's own steps, §0 rows or §7 commands it supersedes.
3. **Fix the contradiction where the executor will actually read it, not only in the amendment.** An amendment at the end of a 1 500-line document does not stop a step-by-step executor from following §5 or §7. Strike the superseded line in place, or put a banner in the header block above §0.
4. **Re-run every gate that exists, not the ones you remember.** As of round R3 that is
   `bun run typecheck`, `bun run build:studio`, `bash scripts/check-dead-code.sh`,
   `bun run scripts/check-design-tokens.ts`, `bun run scripts/check-routes.ts`,
   `bash scripts/check-plan-status.sh`, and `bun run spec:check`. **A round creates new gates**:
   plan 204 shipped `check-design-tokens.ts` and plan 213 shipped `check-routes.ts`, and the
   design-token gate failed silently from the R1 merge until R3 because the programme owner ran
   the three gates he could recall instead of listing what was on disk. Enumerate `scripts/check-*`
   before every gate run.
5. **Re-run the cheap gates on the reconciled documents**: `bash scripts/check-plan-status.sh`, and a grep for whatever the round's findings made forbidden.
6. **Record the reconciliation in the round's own commit message**, so the next reader can see which plans moved and why.

Two classes of finding recur and are worth naming, because both were found this way rather than by reading:

- **A `Ships:` path that already exists.** `check-plan-status.sh` fails a `draft` plan whose artefact is on disk (§3.0.1). Two plans shipped that defect before it was caught.
- **An amendment that contradicts its own document's body.** Ten plans carry a §12 testing amendment; nine of them still named Studio tests in §5 or §7, which a literal executor would have created. Fixed on 2026-09-03 by banner plus in-place strike, and this is why step 3 above exists.

### 8.6 Round R1 reconciliation, 2026-09-03

The first application of §8.5, recorded so the next round has a worked example.

**Merged into `mvp` in plan order:** 201, 202, 203, 204. Two conflicts needed a judgement, three were mechanical.

| Finding | Where it came from | What was reconciled |
|---|---|---|
| Prototype plans moved to `docs/archive/plans/`, so 32 citations in the MVP series pointed at nothing | plan 202 | Every citation in six MVP plans repointed. The one that mattered was plan 208's reference to plan 129's measured API 36 attach times, which an executor is meant to read. |
| `--radius-card` was dead when 201 ran and alive after 204 | the 201-into-204 merge | 201's `check-dead-code.sh` forbade `radius-card` and `rounded-card`. Narrowed to `destructive-foreground`, with the reason written into the script. Neither plan was wrong; only their combination was. |
| WebRTC deleted by 201, but 203's edit of the same component kept `transport !== 'webrtc'` | the merged branch | Fixed in the merge. **Each plan was green alone**; together they referenced a deleted binding. `bun run typecheck` and `check-dead-code.sh` on the merged branch are what caught it, which is why both run at the round gate and not only per plan. |
| A plan's code block omitted `'use client'` and the build failed | plan 204 | Added as §2.6, applying to all eight Studio plans rather than editing eight documents. |
| `AGENTS.md` is tracked, not untracked as plan 202 §9 Q4 assumed | plan 202 | The assumption was wrong because the programme owner had committed the file by accident. Left untouched as the plan required; the record corrected. |
| A plan's own `rg` list of call sites was short by one | plan 204 | Added to §2.6: re-run the plan's grep, do not trust its list. |
| Plan 59's `Ships:` pointed at a Studio test 201 deleted | plan 201 | Resolved by the merge order: 202 archives plans 01 to 129, so the stale citation left the checked set. Worth knowing that merge order can close a finding without an edit. |

**The lesson worth carrying:** three of these seven were invisible to the plans and to the executors, and only appeared when two green branches met. A per-plan green is necessary and not sufficient; the round gate is where the product is actually checked.

### 8.7 Round R2 reconciliation, 2026-09-04

Plan 205 merged into `mvp`; typecheck, `check-dead-code.sh` and `check-plan-status.sh` all clean. **345 files changed, 10 966 insertions, 14 646 deletions** — the series' first net-negative plan, which is what replacing a mechanism rather than adding one looks like.

**The finding that matters, and it changes a rule.** Four test files were broken by R1 and R2 and stayed broken through two round gates, because **no plan's §7 named them**:

| File | Broken by | Why nobody saw it |
|---|---|---|
| `plugins/mikrotik-routing/src/service/identity-bridge.test.ts` (9 of 10 failing) | plan 205 shrinking `DeviceStatus` | its fixture said `status: 'idle'`, which Zod now rejects; plan 205's executor flagged it as out of scope and moved on |
| `packages/core/src/daemon-wiring.test.ts` (2 failing) | plan 203 adding a `streamStats` argument; plan 201 deleting the `scan.progress` broadcast | it asserts `daemon.ts`'s literal source text, so any wiring change breaks it, and no plan owns it |
| `binding.test.ts`, `action-executor.test.ts` | plan 205 | stale `'idle'` fixtures that passed anyway, because those inserts bypass Zod. Latent, not failing |

All four are fixed. Two lessons:

1. **"Out of scope" is the wrong answer when your own change broke it.** A test that fails *because of* this plan is this plan's to fix, whatever its path. Added to §2.1.
2. **Scoped testing has a real hole, and it is now named rather than discovered again.** Running only the files a plan lists means a change can break a test in a file nobody looks at. The round gate closes it: **before merging a round, run every test file that names a symbol the round deleted or renamed.** That is a grep, not a full suite, and it is cheap.

The second lesson also exposes a policy question this programme should answer rather than drift on: `daemon-wiring.test.ts` asserts wiring by matching source text, which §8.3 explicitly lists under "not tested". It has now cost two false alarms and caught nothing a typecheck would not. Plan 224 should decide whether it survives the test-strategy reset; it is not deleted here, because deleting an 88-test file mid-merge is not a call to make at a round gate.


### 8.8 Round R4 reconciliation, 2026-09-04

Merged 208, 209, 210, 214 into `mvp`; all nine gates green; the cross-round test sweep (§8.7) clean.

| Finding | From | Reconciled |
|---|---|---|
| **A second migration collision, and a worse one.** 210 and 214 both generated 0068, and unlike R3's pair both change the schema. 214's snapshot was generated without the `workflows` table and with `scripts.kind` still present, so renumbering it would have shipped a snapshot that contradicts its own database. | the merge | 210 keeps 0068; 214's artefacts were discarded and `db:generate` re-ran against the merged schema, producing 0069 with exactly `ALTER TABLE devices ADD model text`. The rule is now in §2.1: read the journal first, and say which index you took. |
| Plan 208's own §4 would have created a **circular ES-module dependency** through a value re-export | plan 208 | The executor kept two independently defined constants with a cross-reference comment, and said so. Nothing to propagate. |
| Plan 209's §4 example for the scroll encoder used the **wrong fixed-point scale**; the real device protocol divides by 16 | plan 209 | Fixed against the verified v3.3.1 source, not against the plan. A plan's worked example is not evidence. |
| Plan 214 could not delete `use-bulk-selection.ts`: plan 220's Agents page still imports it | plan 214 | 214 marked itself `partial` with the row unchecked rather than claiming done. **Plan 216 owns the bulk removal and must finish it**; carried into 216's launch brief. |
| Three executors each found an error in their own plan document rather than only following it | 208, 209, 214 | No action, but it is the signal worth watching: an executor that never contradicts its plan is probably not reading the code. |

### 8.9 Round R5 reconciliation, 2026-09-04

Merged 211, 215, 216, 221, 223. Eight gates green; `bun run typecheck` is green for all nineteen workspace packages and fails only on `youtube-automation-pack`, which is the owner's own uncommitted work in progress (`readableStrings` is imported before it is exported) and is not this round's to fix.

| Finding | From | Reconciled |
|---|---|---|
| **Three plans put their work on a differently named branch than their worktree's.** `git merge <worktree-branch>` answered "Already up to date" and would have merged nothing while looking successful. | 215, 216, 221 | Caught by checking `git merge-base --is-ancestor` per branch before trusting any of them. **Always verify the branch actually carries the commits; the worktree's own branch name is not evidence.** |
| **Plan 216 could not finish because plan 215 had not merged.** Its §10 deletions target dialogs that `device-popup/` and `app/device/` still imported, and 215 deletes those directories. | 216 | 216 shipped what it could and marked itself `partial` rather than breaking the build. §4's dependency column now records 216 → 215. The blocked deletions completed at this gate once 215 landed. |
| **`action-set.ts` versus `lib/generic-actions.ts`.** 215 renamed the module; 216 edited the old path. Two interfaces for one concept. | the merge | Unified: 215's `id` and `submenu`, 216's `overflow`, and `needsDialog` dropped — that flag existed only to disable rows until 216 built their dialogs, which is exactly what 216 did. The id is now narrowed to `ActionDialogVerb`, so a row whose dialog does not exist cannot be rendered. |
| **A real coverage regression on the critical list.** Plan 211 deleted 53 test files broken by the job/run split. Net backend tests went 395 → 353. | plan 211 | Taking the modified versions was impossible — they reference the old schema and do not compile. The deletions stand, and the five that were on §8.3's critical list are named below rather than absorbed. |

**Critical-list tests deleted in R5, and what each covered:**

| File | What it protected |
|---|---|
| `packages/core/src/api/actions.test.ts` | plan 207's 29 tests over all 25 action verbs, HTTP 202/404, and the policy warn-then-force path |
| `packages/core/src/server/ws-handlers-activity.test.ts` | the `device.activity.warning` throttle — written by plan 205 precisely because that behaviour had no coverage anywhere |
| `packages/core/src/plugins/runtime.test.ts` | the plugin stage → verify → activate pipeline, the only way code reaches a farm |
| `packages/core/src/db/migrations/artifacts-device-scope.test.ts` | a migration over rows already on disk |
| `packages/core/src/db/migrations/schedule-target-backfill.test.ts` | the same |

**This is a debt, not a decision.** Plan 224 owns the test-strategy reset and must either restore these five against the new schema or state, per file, why the behaviour is covered elsewhere. Added to 224's acceptance below.

### 8.10 Open item carried at the R6 gate: plan 216's blocked deletions

**The programme owner said at the R5 gate that he would finish plan 216's blocked deletions once 215 merged, and then did not.** Plan 217's executor found them still on disk. Recorded here rather than promised again.

It is not a forgotten `rm`. The chain, verified 2026-09-04:

| File 216 wanted to delete | Still imported by |
|---|---|
| `components/target/TargetPicker.tsx` | `InstallBatchDialog.tsx`, `BulkForgetDialog.tsx`, `RunScriptDialog.tsx`, and **`components/plugin-view/ActionRunner.tsx`** |
| `components/DevicePicker.tsx` | `TargetPicker.tsx` |
| `components/RunScriptDialog.tsx` | `lib/script-row.ts` (a type import) |
| `lib/operations.ts` | `InstallBatchDialog.tsx` and two files under `components/operations/` |

The first three rows unblock by deleting the dialogs 216 already named. **The fourth does not**: `plugin-view/ActionRunner.tsx` is the plugin view host's own action runner, it legitimately needs a target picker, and no plan named it. Plan 216 replaced `DeviceWallWithPicker` with `DevicePickerDialog` but never migrated `ActionRunner`.

**Owner: plan 219**, which already touches the plugin surface, or an explicit follow-up. The work is a migration, not a deletion: point `ActionRunner` at `components/target/DevicePicker.tsx` (216's new one, not the old `components/DevicePicker.tsx`), then the chain collapses and all four rows can go.

**The lesson, which is the reason this section exists:** a deletion deferred at a gate needs a written owner in the same minute it is deferred. "I will finish it after the next merge" is not a record, and this one survived a whole round because nobody wrote it down.

### 8.11 R6 reconciliation — 212, 217, 218, 222

Merged in plan order onto `mvp`; four conflicts, all real, none resolved by
picking a side:

- `icons.ts` and `check-design-tokens.ts` — 217 and 218 each added icons to the
  same list. Union. The exact-total assertion derives from `GROUP_3.length`, so
  it widened itself.
- `check-routes.ts` — each plan deleted its own `PENDING_REMOVAL` row; the
  result keeps neither.
- `app/jobs/detail/page.tsx` — modify/delete. 218 replaced the page with
  `components/jobs/*`; 212 had patched the old file for the new settings shape.
  The deletion is the right answer, but the patch was the tell that the NEW
  Jobs code might read `settings.job` too. It does not — checked, not assumed.
- `protocol/settings.ts` — 212 rewrote the file to 26 fields while 222 changed
  four lines of the old one. Resolved by taking 212's file and re-applying
  222's `ui-tree` enum and default onto it.

**The collective test sweep the CEO asked for found 26 failures across four
packages, and only one of them belonged to R6's own work.** The rest had been
red for one to three rounds, invisible because no scoped run had touched those
directories. What that says about the "run only what you touched" rule is in
§8.12.

Real defects, not stale tests:

1. **`0067_groups_rename` carried a `when` 18 minutes EARLIER than
   `0066_desired_awake`** — my own wave-3 renumbering. Drizzle picks pending
   migrations by comparing `when` against the highest `created_at` already
   recorded, read once. A fresh install is unaffected; any database already at
   0066 would have skipped the `clusters` → `groups` rename **permanently, with
   no error**, then failed with "no such table: groups". Timestamp repaired and
   `db/journal-ordering.test.ts` now guards monotonicity, `idx` order, and that
   every tag has its `.sql`.
2. **A per-device video-quality change stopped restarting the open session.**
   212 moved the knobs from a `video` block to `overrides.*`; the route still
   watched `changedKeys.includes('video')`. The operator would get a success
   toast and an unchanged picture — the exact class plan 92 was written for.
3. **`GET /api/plugins/dev` lost its last caller** when 215 deleted
   `app/device/`, so unpublished dev builds are invisible in Studio. Recorded
   in a new `UNREACHABLE_PENDING` list with an owning plan, NOT in
   `NOT_IN_STUDIO_BY_DESIGN` — a gap filed as a decision is a lie the next
   reader believes. Owner: plan 219.

Stale fixtures repaired: four agent settings stores still keyed `agentDefaults`
(the store's key is `defaults` since 212) — every one an `as never` cast, which
is exactly why typecheck saw nothing; `health.test.ts` seeding `status: 'idle'`,
which stopped being a `DeviceStatus` at plan 205; `cutover.test.ts` pinning the
"DHCP lease" wording 205 de-jargoned; labelling fixtures in two doctor files;
`.text-fg-muted` in the SDK scaffold test, renamed by 204.

Tests deleted, with replacements: `awake-policy`'s `screenOffTimeoutMs: null`
case and `blob/gc`'s two grace-period cases drove settings 212 turned into
constants. Each was replaced by a test of the contract that survived — the
boundary, and the absence of the removed key — never merely removed.

Plan 216's blocked deletions were completed here (twelve files; both
`components/bulk/` and `components/operations/` are gone), verified with a full
`build:studio`. `target/TargetPicker` and `useTargetSelection` stay for plan 219
with `plugin-view/ActionRunner.tsx`.

### 8.12 The scoped-test rule has a hole, and this is what it costs

CLAUDE.md forbids a full suite for a real reason (the 2026-08-17 overheating
incident), and that rule stands. But "run only what you touched" silently
assumes every break lands in a directory somebody touches soon after. R6 proved
it does not: 25 of 26 failures were inherited, the oldest from R2, and they
surfaced only because a round gate happened to sweep wider than any single plan.

The rule this adds, for the remaining rounds: **a round gate sweeps every
backend directory the round changed, not only those with changed test files.**
The `agent/` directory had no changed test file in R6 and held four failures.
Plan 224 owns measuring the backend suite; until then the gate is the net.

### 8.13 R7 reconciliation — 219, 220

One conflict, the same additive shape as R6's: each plan deleted its own
`PENDING_REMOVAL` row in `check-routes.ts`, so the merge keeps neither. That
list is now **empty** — every route ever parked for removal is actually gone.

Both inherited items from §8.10/§8.11 are closed by 219: `ActionRunner.tsx` is
migrated to the new DevicePicker/useTarget, `components/target/TargetPicker.tsx`
and `useTargetSelection.ts` are deleted, and the Plugins page now calls
`GET /api/plugins/dev`, so `UNREACHABLE_PENDING` is empty too.

Two corrections to what the programme owner wrote earlier:

- §8.11 said `ViewRenderer.tsx` referenced `TargetPicker`. It never did. The
  gate grep matched the bare name, not an import specifier — the same mistake
  that made `operations.ts` look orphaned minutes earlier, caught then by
  re-running with `from '[^']*<specifier>'`. **Match the import, never the
  name**; a comment mentioning a module is not an importer.
- The plan's own §3 table carried the same wrong claim, which is where the
  gate note came from. A plan is a decision record, not an oracle about the
  tree: 220 likewise found the protocol schema is `FarmAgentSettingsSchema`
  (not the `AgentSettingsSchema` it assumed) and that several of its steps had
  already landed with 212.

Two things deliberately NOT done, both recorded rather than quietly resolved:

1. **`RemovePluginAction`'s overflow scopes.** Plan 219 §4.4's code hardcodes
   `['version']`, which drops the pre-existing "remove all versions" and
   "remove all except latest" options from the row's `⋯` menu — a
   `DropdownMenuItem asChild` cannot host a nested multi-item menu. The
   executor flagged it for the owner instead of silently restoring or silently
   dropping a capability. **Owner decision needed before release.**
2. **`lucide-react` is not removed** (220's G6/G7). 49 files outside the agent
   subsystem still import it, all owned by other plans. Documented as unmet
   rather than checked off falsely. Owner: plan 224's packaging pass.

Sweep, per §8.12 (every backend directory the round changed, not only those
with changed test files): `core/src/api` 501 pass, `core/src/agent` 307 pass,
typecheck across 20 packages, `build:studio` clean, all six `scripts/check-*`
green. **Zero collateral failures** — the first round with none, and the
difference is that R6's sweep had already drained three rounds of debt.

The `spawn-grants` HTTP routes are gone; the store and its `canSpawn`
enforcement remain (`agent/runner.ts:111`). That was the decision in §8.6 and
it survived the deletion intact.

### 8.14 R8 reconciliation — 224, and the programme closes

Merged clean, no conflicts. Migration `0072` taken after reading the journal,
as the last three plans all did.

What 224 measured, and what it means: the root suite is **140.66 s**, well over
the 60 s target §8.12 named, and `packages/core` alone is 91 s of it. **The
no-full-suite rule stays in force**, now with a number behind it instead of a
2026-08-17 anecdote. CLAUDE.md records both.

Of plan 211's five deleted critical-list tests, three are restored
(`actions/run`, `server/ws-handlers-activity`, `db/migrations/
schedule-target-backfill`). Two are not, with reasons in 224 §11 rather than
hollow replacements — the right answer when a test's subject is gone.

`lucide-react` is still a dependency: 44 importers remain outside the agent
subsystem. Both 220 and 224 declined to check the goal off. That is the
behaviour the §0 checklist exists to produce.

Two things this gate had to repair, and both are the same defect wearing
different clothes:

1. `jobs/executors/script.test.ts` — 10 failures 224 correctly flagged as
   pre-existing and out of its scope. Plan 211 moved `runtimeOverride` onto the
   run row and made `ExecutorContext.run` required; every `ctx` fixture in that
   file predates it and is cast `as never`, so the file threw on
   `ctx.run.runtimeOverride`. **That is the fourth time in two rounds an
   `as never` cast hid a broken fixture from typecheck** (R6's four agent
   settings stores, R7's none, and this). The rule for whoever works here next:
   a test fixture cast to `never` is a fixture with no contract, and it will
   drift the moment the shape moves.
2. `ws-handlers-activity.test.ts` — restored by 224 asserting a warning that
   the CEO struck an hour earlier (see §8.15). Rewritten against the conflict
   that still warns.

### 8.15 The owner's first hardware session, and what it caught

On 2026-09-04, with R7 merged, the owner ran the build against a real phone for
the first time in the programme and reported three things. All three were real;
**none of them could have been caught by anything in this repo.**

1. **A wall tile said "Disconnected" for an online phone.** `!live` covered
   three unrelated facts — offline, quarantined, and "the tile budget is not
   streaming this one right now" — under one word. Under always-on sessions
   (plan 206) the third is the common case, so the screen was telling the owner
   his casting was broken while the device was online and under his own
   control. A label, not a type.
2. **Every action in Device Control's Actions tab was dead.** Plan 215 left a
   stub that toasted `"Opens a dialog (plan 216)"`; plan 216 built the dialogs
   and wired the entry points that existed on ITS branch. Both ran in R5. The
   stub was a toast string, so no typecheck, no test, and no grep in §10 could
   see it. **This is the third defect traced to 215 and 216 sharing a round**,
   after 216's blocked deletions (§8.10) and the `ViewRenderer` claim (§8.13).
   The dependency was in §4 and I scheduled them together anyway.
3. **A queued job waited up to 60 s while someone had the device open.** This
   one is mine: I wrote it into MVP 04 §3 as a proposal ("a queued job whose
   device has a fresh `control` entry waits…"), carried from plan 71's quiet
   gate. It was never a CEO decision, and it sat in the same document as the
   decisions that were, which is exactly why it survived to hardware. The CEO
   struck it on sight — correctly: it is the lease this programme exists to
   remove, wearing another name.

The model is now the state dot and nothing else: **green** free, **amber** a
person is driving, **red** the system is. Amber blocks nothing. A person may
take over a device a job is driving with no sentence to dismiss — that is help,
not interference. Only job-over-job stays exclusive, and it lives in the SQL
claim. MVP 04 §3 is struck in place, dated, with the reason; the wire's
`job.waiting.reason` enum drops `'control'` rather than keeping a value nothing
emits.

**The lesson worth carrying past this programme:** a proposal and a decision
must not look alike in the same document. Everything in `docs/mvp/` that reads
as settled fact should carry who decided it and when, or be marked as proposed.
Three rounds of agents built on §3 believing it was law.

### 8.16 State at close

Twenty-four working plans merged on `mvp`; `main` untouched at `8fb7b4b`.
Typecheck clean across 20 packages, `build:studio` clean, all six
`scripts/check-*` green, and every backend directory the programme changed
swept.

What remains is not code. `docs/guide/owner-smoke.md` is 61 checks in 7 device
sessions, and **every `owner` row in every plan from 201 to 224 is still open**.
Until that pass runs, this programme has proved that the software builds,
typechecks, and agrees with itself. It has not proved that it works.
