# Plan 00 — Overview, Conventions, and the Execution Roadmap

> The parent document for every plan in `docs/plans/`. Read this **before** working on any plan.
> The product source of truth is `docs/spec.md` (Enkaku draft v0.2). If a plan contradicts the spec, the spec wins — then update the plan.

---

## 1. How to use this plan series

- Each plan is one milestone from spec §20, worked **in order** (01 → 11). Plan N assumes every plan below N is finished and its acceptance criteria are met.
- Each plan is **self-contained as a working context**: it carries goals, non-goals, technical design, numbered implementation steps, acceptance criteria, and a test plan. An AI agent builder needs only `00-overview.md` plus the plan being worked on (plus the spec sections it references).
- Do not pull features forward from a later plan "while you are in there". If you find a need that is not covered, record it under **Open questions** in the relevant plan; do not improvise architecture.
- When a plan is finished → run every acceptance criterion → commit with `feat(mX): ...` → only then move to the next plan.

## 2. The plans

| # | File | Milestone | Summary |
|---|---|---|---|
| 00 | `00-overview.md` | — | This document: conventions, stack, repo structure, template. |
| 01 | `01-m0-foundation.md` | M0 | Monorepo, core daemon, `packages/adb` (client plus track-devices), device registry plus stableId, SQLite, WS broadcast, per-device queue plus semaphore. |
| 02 | `02-m1-toolchain.md` | M1 | Toolchain Manager: manifest, download plus sha256, versioning, active pointer, swappable flag, first-run auto-provisioning. |
| 03 | `03-m2-basic-control.md` | M2 | Basic control: `screencap-loop` plus `adb-input`, coordinate mapping, Studio live view and click, the enrollment wizard. |
| 04 | `04-m3-session-lease-queue.md` | M3 | The device state machine, lease plus heartbeat, a per-device queue in SQLite (with a dummy job). |
| 05 | `05-m4-script-framework.md` | M4 | `defineScript`, the subprocess runner, artifacts and logs, `@enkaku/sdk`, the first inspector (`uiautomator dump`). |
| 06 | `06-m4.5-ui-server.md` | M4.5 | A persistent on-device inspector (the uiautomator2 pattern): fast `find`/`waitFor`, `set_text`. |
| 07 | `07-m5-studio-complete.md` | M5 | Studio complete: script CRUD plus run form and publish, job detail, the Tools UI, settings, the schema-driven renderer, the registry, battery/thermal plus auto-quarantine. |
| 08 | `08-m6-scrcpy.md` | M6 | The scrcpy display (H.264 relay, version-locked) plus `scrcpy-uhid` input plus WebCodecs decoding plus a fallback decoder. |
| 09 | `09-m7-multiuser-packaging.md` | M7 | Auth/ACL plus TLS, a single binary, a Docker image, the Tauri shell, auto-update, artifact retention and GC. |
| 10 | `10-m7.5-business-plumbing.md` | M7.5 | Docs, licence/activation, opt-in telemetry, the AUP, support and update channels, `LICENSES.md`. |
| 11 | `11-m8-cloud.md` | M8 | The cloud tunnel agent, a split control plane, WebRTC video, a per-job security boundary, opt-in appium, redroid, `scrcpy-aoa`. |
| 12 | `12-m9-cloud-session.md` | M9a | Cloud mode fully working: `@enkaku/session`, remote sessions, input, and jobs. |
| 13 | `13-m9-webrtc-backend.md` | M9b | The WebRTC backend (werift), the RTP relay, TURN. |
| 14 | `14-m9-desktop-tauri.md` | M9c | The Tauri desktop application. |
| 15 | `15-m10-design-system.md` | M10a | **Design foundations**: Tailwind plus shadcn/ui, tokens, the layout frame, fixing functional UI defects. |
| 16 | `16-m10-screens.md` | M10b | **Rebuilding every screen** and user flow. |
| 17 | `17-m11a-realtime-and-wake-ux.md` | M11a | **Realtime UI contract**: ticking durations, session wake-up progress, keep-awake modes, standby (screen off while mirroring), keyframe on join. |
| 18 | `18-m11b-device-event-log.md` | M11b | **Device event log**: one `device_events` table with `main` and `input` streams, live tail, redaction, per-stream retention, the Logs tab. |
| 19 | `19-m11c-tags-and-device-picker.md` | M11c | **Tags and the device picker**: `device_tags`, normalisation, tag filtering, a picker that shows stableId and unavailable devices with reasons. |
| 20 | `20-m11d-clusters-and-batch-runs.md` | M11d | **Clusters and batches**: a cluster is a saved selector; batches with `(concurrency, order)`, an aggregate report, cancel and re-run failed. |
| 21 | `21-m11e-schedules-and-queue-policy.md` | M11e | **Schedules**: croner, overlap policy, queue timeout (`expired`), catch-up, jitter, priority, run history. |
| 22.0 | `22.0-clusters-as-device-field.md` | M11d-rev | **Clusters become a device field**: `devices.clusterId`, one device in at most one cluster (or none), a cluster is a container rather than a saved selector. Supersedes Plan 20 §3.1. |
| 22.1 | `22.1-m12a-adb-deadlines-and-queue-safety.md` | M12a | **adb deadlines**: layered timeouts, forced socket termination, output caps, queue depth cap, `AbortSignal`, coded errors. No user-facing change. |
| 23 | `23-m12b-adb-concurrency-and-device-health.md` | M12b | **Concurrency and health**: a semaphore that scales with fleet size (amends spec §10.4), parallel battery polling, auto-quarantine on adb failure with automatic recovery, `/api/adb/stats`. |
| 24 | `24-m12c-adb-stream-lane-and-monitor.md` | M12c | **Streaming lane and Monitor tab**: `execStream` outside the per-device queue, fixed read-only monitors (logcat/top/thermal), one stream fanned out to all viewers, save-as-artifact. |
| 25 | `25-m12d-shell-over-tunnel.md` | M12d | **Cloud parity**: correlated request/response over the tunnel, a `shell` binary channel, agent-side handlers, one `ShellPort` interface with local and remote implementations. |
| 26 | `26-m12e-interactive-terminal.md` | M12e | **The device terminal**: free-form commands gated by lease plus the `device.shell` permission, full audit, emulated cwd, exit codes, all viewers watch and only the lease holder types. |
| 27 | `27-m12f-local-adb-endpoint.md` | M12f | **Lease-scoped adb endpoint (local)**: an adbd-protocol shim so a user can `adb connect` to a farm device with their own tooling. Starts with a spike gate. |
| 28 | `28-m12g-cloud-adb-endpoint.md` | M12g | **adb endpoint for cloud devices**: the same shim with ADB streams carried over tunnel channels, with delivery-acknowledged flow control. |
| 29 | `29-m13-runtime-resilience.md` | M13 | ⚠️ **DRAFT — DO NOT EXECUTE.** Single-owner data-dir lock, stale `adb forward` sweep, bounded session auto-recovery, per-device reconnect. Design unsettled; §9 must be answered first. |
| 30 | `30-m14a-server-side-pagination.md` | M14a | **Pagination**: one keyset envelope for every list endpoint, a shared `PaginatedTable`, no unbounded fetches. |
| 31 | `31-m14b-viewer-presence-and-control.md` | M14b | **Presence**: who is watching a device and who holds control, live to every viewer. Starts by reproducing the reported two-browser symptom. |
| 32 | `32-m14c-fleet-topology-view.md` | M14c | **Topology**: the whole farm as grouped tiles — status, battery, temperature, running job — live, no graph library. |
| 34 | `34-m16-shipped-defect-repairs.md` | M16 | **Four defects in shipped behaviour**: the ui-server inspector has never started (wrong stub class, measured); it must also move to the Plan 24 lane; the Timing settings are saved but never read; `app.launch` interpolates unquoted job params; `requirePermission` and `canUseDevice` are written but never called. |
| 35 | `35-m17a-session-hygiene-between-jobs.md` | M17a | **Session hygiene**: a declared reset before every job, so two jobs on one device stop inheriting each other's app state. |
| 36 | `36-m17b-retry-classification-and-backoff.md` | M17b | **Retry classification**: infrastructure failures separated from script failures, exponential backoff with jitter, a separate infra budget, batch members rebind to another device. |
| 37 | `37-m17c-crash-detection.md` | M17c | **Crash detection**: `logcat -b crash` on the Plan 24 lane, crash and ANR events, the trace as an artifact, opt-in job failure. |
| 38 | `38-m17d-clipboard.md` | M17d | **Clipboard**: get/set over the scrcpy control socket — which first needs a device-message reader, since that socket is write-only today. |
| 39 | `39-m17e-file-transfer-and-apk-install.md` | M17e | **File transfer and APK install**: the sync protocol on the streaming lane, artifact-id sources only (never a client URL), batch install across a cluster. |
| 40 | `40-m17f-input-realism.md` | M17f | **Input realism**: Bézier gesture paths with eased velocity, `scroll`/`fling` verbs, per-character typing cadence. Depends on Plan 34 reconnecting the Timing settings. |
| 48 | `48-m22-wall-tile-density.md` | M22 | **Wall tile density**: one chrome block instead of two (label line, then a fixed chip row), actions as a hover/focus overlay on the screen — with touch and keyboard fallbacks so nobody loses the control. |
| 47 | `47-m21-device-lifecycle-and-unified-fleet-view.md` | M21 | **Device lifecycle**: Forget (offline devices) and Block (by `stableId`, survives a replug) — there is no delete anywhere today. History is kept unless explicitly deleted with its counts shown. Devices and Topology merge into one page with view × grouping. |
| 46 | `46-m20-device-settings-ux.md` | M20 | **Device settings UX**: the Settings tab gains vertical sub-sections on the left, derived from the schema's own keys, with a URL per section. Layout only — no setting changes meaning. |
| 45 | `45-m19-device-readiness.md` | M19 | **Readiness as a state**: `asleep | awake | hot` as a second axis beside `DeviceStatus`, desired-vs-actual reported separately, Wake/Sleep without opening a stream, a farm-wide hot budget, and readiness on the Wall, the devices list, and topology. |
| 42 | `42-m18-view-lifecycle-and-fleet-wall.md` | M18 | **View lifecycle and the wall**: tab switching no longer restarts the video (the Control subtree is unmounted today), one lease truth across tabs, gated panels disabled rather than absent, the `api()` GET-with-body defect, an idle session TTL, and a Wall mode showing every device's screen at a low-rate quality profile. |
| 41 | `41-m17g-toolchain-integrity-and-doctor.md` | M17g | **Integrity and preflight**: verify on-device APKs by version and signature rather than package name; `enkaku doctor` with a remedy for every failed check. |
| 33 | `33-m15-device-network.md` | M15 | **Network layer**: a fifth driver layer (spec §7.9). `adb-proxy` and `adb-reverse-proxy` engines, lease-scoped apply/revert, declared-vs-observed status, a Studio card, and `ctx.device.network.*` in the SDK. |
| 43 | `43-m15b-guest-agent.md` | M15b | **`enkaku-guest-agent`**: a first-party on-device APK (`apps/guest-agent/`) with a `localabstract` control channel, provisioned unattended via the Toolchain Manager; turns on the `vpn-helper` engine — an enforcing SOCKS5 route apps cannot ignore. Depends on 33. |
| 44 | `44-m15v-proxy-end-to-end.md` | M15v | **Delivery slice**: the minimum subset of 33 and 43 that lets an operator set a SOCKS5 full-tunnel proxy on a device from Studio. Opens with a device bring-up gate; defers the other engines, the SDK, CI, and the toolchain entry. |
| 50 | `50-m24a-ci-and-device-smoke-test.md` | M24a | **CI plus a device smoke test**: typecheck and tests on every push, a path-conditional Android build job, and an `ENKAKU_TEST_DEVICE=1` runner whose stages map one-to-one onto the six defects the proxy bring-up could only find by hand. Prerequisite for 51 and 52. |
| 51 | `51-m24b-verified-egress-and-fail-closed.md` | M24b | **Verified egress, fail-closed routing**: `health` becomes named checks instead of one enum; an egress probe measured from the device *through* the tunnel and outside it; DNS-leak detection against a self-hosted endpoint; explicit IPv6 blocking; opt-in lockdown so a dead tunnel stops traffic instead of silently leaking the real address. |
| 52 | `52-m24c-device-scoped-routes-and-stable-identity.md` | M24c | **Routes belong to the device**: survive lease release, reboot and core restart; restore by probing rather than reapplying; a credential store replacing plaintext secrets; per-device sticky session identity; route and health on the devices list. **Supersedes Plan 44's lease-scoped lifetime.** |
| 54 | `54-m24d-fail-closed-and-route-recovery.md` | M24d | **Fail closed, and recovery that works**: the dead-man's switch currently tears the tunnel down, which *causes* the leak it exists to prevent — it becomes hold-closed instead (TUN stays, forwarding stops). Restore actually re-applies when the device reports no route, bounded and backed off, so a USB unplug or core restart no longer leaves a route enabled-but-dead forever. Amends Plan 52 §5.3 and Plan 43's switch. |
| 53 | `53-m25-framed-shell-transport.md` | M25 | **Framed shell**: `exec` returns `{ stdout, stderr, exitCode }`; deletes the exit-marker workaround. One shell path, 57 call sites migrated in one commit. |
| 55 | `55-m24e-geo-assertion-and-route-drift.md` | M24e | **A route that tells you when its exit moved**: Plan 51's `geo` check shipped as a permanent `skip` because no expectation can be declared anywhere. Adds a per-device expected exit, a pluggable geo lookup, matching at the narrowest declared level, exit-address history so a rotating pool is legible, and an opt-in hold-closed when the exit drifts. Completes Plan 51 §4.1. |
| 56 | `56-m26-device-admission.md` | M26 | **A farm you opt into**: a phone that connects to adb no longer joins the farm — it waits in a **Discovered** tray until an operator admits it by name. Discovered devices live in their own table, so the scheduler, leases, wall, clusters and topology are untouched and existing devices need no migration. Also removes Plan 47's trap where forgetting a *connected* device forced a permanent block: it now returns to the tray instead. |
| 56 | `56-m26-ui-inspector-devtools.md` | M26 | **The UI inspector**: dumps the on-device tree beside a picture from the same instant, proposes layered selectors with match counts, and copies a paste-ready SDK line. *(Shares a number with two other plans — see the note below this table.)* |
| 57 | `57-m27-device-page-layout.md` | M27 | **The device page earns its space back**: `Inspect` becomes a mode of the screen card instead of a tab, the right column is removed rather than made collapsible, watched facts (battery, temperature, viewers) move into the header while looked-up facts go behind a popover, clipboard joins the screen toolbar, and `Remove device` moves into an overflow menu. |
| 58 | `58-m28-device-identity-spoofing.md` | M28 | **Device identity spoofing**: timezone, locale, and a mock GPS fix, aligned with a network route's observed exit so every signal an app under test can see agrees on one identity. Timezone/locale are plain `setprop`, no guest agent needed; GPS depends on the guest agent advertising a new `mock-location` capability and is refused honestly when it does not. Includes a "sync from proxy" suggestion and drift detection against Plan 55's geo observations. *(Renumbered from `56-m26-device-identity-spoofing.md` to resolve the number collision noted above.)* |
| 59 | `59-m29-preconditions-not-errors.md` | M29 | **A precondition is not a failure**: the inspector stops reporting "take control first" as a red error and offers the button instead; it notices when control IS taken rather than needing a tab switch to unstick; attachment follows the lease so flipping Live/Inspect stops paying a cold start; an unchanged dump costs no re-render and keeps the selected node; auto-refresh defaults on, visible-only and chained; and an offline device can still be opened and read. |
| 60 | `60-m30-scripts-can-be-trusted.md` | M30 | **A script that cannot lie about what it did**: found by writing one — it opened Chrome, reported success, and had navigated nowhere. `find` stops answering with a viewport-sized container instead of `null`; `device.dump()` gives a script the tree the Inspect panel already shows; a script's return value reaches the person who ran it instead of only the database; a job's outcome is legible on Summary; and the runner's own log stops being listed as a script output. |
| 61 | `61-m31a-nodes.md` | M31a | **Nodes, and the word "agent" set free**: the cloud tunnel process becomes a *node* in package, table, routes, wire protocol, UI and docs, so "agent" can mean the AI feature without ambiguity. Includes a one-release compatibility window — the control plane accepts `agent.hello`, a node adopts an existing `agent.json` — because a binary already deployed in the field must survive the upgrade. `apps/guest-agent` is deliberately untouched. |
| 62 | `62-m31b-script-references.md` | M31b | **`name@version`, and a `@latest` that cannot drift**: a schedule stores the *reference*, a job stores the *resolution*, so `checkout@latest` picks up new versions while every job still records exactly what ran. `latest` is computed as the highest non-prerelease semver — never a stored tag, which is the bug Docker's `latest` actually is. One resolution per firing, so a batch never straddles two versions. The scripts list becomes one row per script with a version selector behind it. |
| 63 | `63-m32a-capability-registry.md` | M32a | **One declaration, three surfaces**: every operation the farm can perform is declared once with input, output, permission, lease requirement, deadline, side-effect class and a model-facing description — and the agent tool list, an MCP server and an OpenAPI document are all *generated* from it. One executor enforces permission, grant, lease and deadline, so there is exactly one door. `DeviceCallSchema` stops being a second definition of the same eighteen operations. |
| 64 | `64-m32b-workspace.md` | M32b | **A filesystem people and agents share**: a virtual, database-backed tree that Studio browses and agents write to — deliberately not the real filesystem, because scripts run as the core's OS user and an agent reads attacker-controllable device screens. Compare-and-swap writes so concurrent edits cannot silently lose work, quotas that say what to do about them, and server-side bundling behind an import allowlist so publishing never becomes an execution path. |
| 65 | `65-m33a-agents-providers-and-settings.md` | M33a | **What an agent *is***: a stored record with its own model, provider connector, credentials, system prompt, context budgets, tool allowlist, device grants and workspace scope — farm defaults overridden per agent, reusing the pattern devices already use. Credentials are encrypted with the same honest claim Plan 52 already makes. Ships no LLM call: an agent is fully configurable and inspectable before it can act. |
| 66 | `66-m33b-the-agent-loop.md` | M33b | **The loop**: threads, runs and append-only messages; streaming over the existing `/ws` with fetch-then-subscribe, because Studio's static export cannot proxy SSE and `/ws` has no snapshot replay. Every budget fails closed. Destructive capabilities pause for a human who sees the exact input — the structural half of the prompt-injection defence. Cancellation releases leases and tells the truth. |
| 67 | `67-m33c-the-run-tree.md` | M33c | **Spawning, messages, cascading cancellation**: an agent spawns another, waits or leaves it running, and messages it mid-flight — delivered at a turn boundary, never inside a tool call, because interrupting a gesture leaves a phone in an undefined state. A child's authority is the *intersection* of its own and its parent's, so spawning is not an escalation path. Depth, run count and a shared token budget all fail closed. There is no orchestrator type: an orchestrator is an agent with `agent.spawn`. |
| 68 | `68-m33d-triggers-and-notifications.md` | M33d | **Running while nobody is watching**: Plan 21's scheduler gains an agent target, so one scheduling model covers both. A farm-wide spend cap that never blocks an interactive run, `skip` as the default overlap, and `onApprovalRequired: 'deny'` so an unattended run degrades into a report instead of a one-hour wait. Notifications land in-app first and are then signed and posted to a webhook — two channels, and no SMTP. |
| 69 | `69-m34-agent-workbench.md` | M34 | **The workbench**: threads, transcript, and a context panel answering the four questions someone has while watching an agent — which phones, which tools, what did it write, what did it cost. Tool calls are the transcript's substance, not a footnote; screenshots render inline; child runs nest. Approvals get an inbox with untruncated inputs, because that is where an injected instruction becomes visible. A phone driven by an agent says so. |
| 70 | `70-m35-agents-can-see.md` | M35 | **An agent that can actually see**: a screenshot reached the model as ~1.4 M base64 characters of *text*, so it saw nothing and paid ~350k tokens for the privilege. A tool result carries blocks instead of a string; images are stored once, content-addressed, and referenced rather than inlined into every row and pushed over `/ws`; a person can attach one; and an image too large is refused by name rather than dropped. As a proper image block the same screenshot costs ~3.5k tokens, which is why resizing is an optimisation and not a prerequisite. |
| 71 | `71-m36-who-holds-this-device.md` | M36 | **Who holds this device**: `lease.changed` carried a boolean, and `DeviceInfo` had no holder at all — so an agent driving a phone was invisible to every surface and Plan 69 had to poll a tree endpoint every 15 s to guess. One `heldBy` field fixes the badge, the takeover dialog, and the wall, and deletes the polling. Control becomes takeable from a person or an agent with a warning that names the consequence, never from a job, and a job waits for the device to be quiet before claiming it. |
| 72 | `72-m37-studio-stops-guessing.md` | M37 | **Studio stops guessing what the core returns**: `api<T>()` ends in `return body as T` — an `as`-cast at the network boundary, 99 call sites, the single largest violation of the repo's own rule. It already cost the Tools tab, which crashes because `/api/v1/cap` returns a bare array. Response envelopes move into `@enkaku/protocol` so both sides share one definition, `api()` requires a schema, and Studio gains a DOM renderer — because fourteen test files rendered nothing, which is why 2091 passing tests said nothing about a broken screen. |
| 73 | `73-m38-the-workbench-earns-its-name.md` | M38 | **The workbench earns its name**: the shell never locked the viewport height and the agent page compensated with `calc(100vh-91px)` — a hard-coded guess at the header — so two scrollbars fought. Fixed at the shell, once, and every viewport `calc()` in Studio removed. The composer reaches the bar the user set: auto-grow, attachments, model and effort inline, Stop where your hands already are. Delete moves onto the list, AI settings group into one section, and `agentDefaults` — built by Plan 65 and editable nowhere — finally has a screen. |
| 74 | `74-m39-job-timeout-and-honest-find.md` | M39 | **A timeout you can set, and a `find` that says why**: `DEFAULT_TIMEOUT_MS = 300_000` was hard-coded in the runner; it becomes a farm setting defaulting to 60 minutes, with a script's own `timeout` still winning and a new startup timeout so raising the default does not make a hung child twelve times slower to surface. Completes Plan 60: the find guard has always known whether it refused an oversized container or simply found nothing, and has never been able to say — which for an agent is a retry loop. |
| 75 | `75-m40-harness-adoption.md` | M40 | **Adopting the harness**: `packages/harness` is copied in verbatim from `bitorex-algo@9eab029` (28 files, 3,166 lines) and made a first-class package. The copy already typechecks clean against TS 7 **and Zod 4** — the predicted Zod 3 conflict did not materialise, because Zod 4 ships a v3 compat subpath and only four files import zod at all — and its own 15 tests pass. Wires the Vercel AI SDK behind Plan 65's `ProviderAdapter`, with `@ai-sdk/anthropic` and `@openrouter/ai-sdk-provider` replacing the direct Anthropic SDK. |
| 76 | `76-m41-harness-loop.md` | M41 | **Running on the harness loop**: `runAgentLoop` replaces `packages/core/src/agent/loop/`, which is deleted rather than left beside it. The decision the rest hangs on: the capability registry **generates** the AI SDK `ToolSet`, so every tool call still lands in `invoke()` with its permission, lease, deadline and audit. Enkaku's additions — approval gates, leases, budgets that fail closed, the run tree — attach to `LoopConfig`'s existing hooks. `onCheckpoint` is deliberately left unset: upstream's audited step budget fails open in two places, which with its shipped settings is 550 model turns. |
| 77 | `77-m42-vfs-skills-plugins.md` | M42 | **VFS, skills, and the plugin system**: the harness's `VFS` interface driven by Plan 64's workspace store, exactly as upstream drives it with `PostgresVFS` — and `writeIfVersion` turns out to be the compare-and-swap Plan 64 already built. File tools and smart-replace port with their bodies intact and become capabilities. Skills work from `/skills/`, read-only to agents so one cannot rewrite its own instructions mid-run. The plugin system — one feature, one prompt section, its capabilities, its commands, merged fail-fast with a boot dry run — is the piece worth the most. |
| 78 | `78-m43-harness-ui.md` | M43 | **The chat UI, ported**: five `ai-elements` (the five upstream actually imports, not all 48) plus `chat-panel`'s shape replace the from-scratch `Transcript`/`Composer`. Streaming moves to the AI SDK's `fetch` transport — not upstream's `EventSource`, which cannot set headers and would force the session token into a URL. Enkaku's own cards (approval, child run, holder badge) are kept and re-mounted, because they render concepts the source project has no notion of. |
| 84 | `84-m49-spec-reconciliation.md` | M49 | **Spec reconciliation**: audit `spec.md` against the shipped code, record every divergence with an owner decision, then close the loop so it cannot drift again. Reads everything, changes almost nothing. |
| 86 | `86-m51-tiktok-account-switch-and-searched-follow.md` | M51 | **The TikTok pack grows**: account switching, a reusable search helper, and a searched follow — built on dump-and-walk, because `find()` silently returns the first match on this app's list screens. Touches only `plugins/`. |

Linear dependencies: `01 → … → 11 → 12 → 13 → 14`, then `15 → 16` for the interface layer. (07 and 06 can partly run in parallel, but the default is sequential.)

The M11 series is **not** a single chain. `17` and `18` are independent of everything after 16 and of each other. `19 → 20 → 21` is a hard chain: clusters select devices by tag, and schedules trigger batches.

```
17 (realtime + wake UX)   ─┐
18 (device event log)     ─┼─ independent, any order
19 (tags) → 20 (clusters/batches) → 21 (schedules)
```

The M12 series (remote shell and adb access) is a chain with one branch. Plan 22.1 is a hard prerequisite for everything after it: until adb calls have deadlines, any long-running command can park a per-device queue slot permanently, which is the failure already recorded in `packages/scrcpy/src/session.ts:90-98`.

Plan 22.0 is not part of that series — it revises the M11d cluster model — but it lands first because it changes `devices`, `clusters`, and every batch/schedule target path, and rebasing the M12 work onto it later would be wasteful.

```
22.0 (clusters as a device field)   ← independent; lands first to avoid a later rebase
22.1 (adb deadlines)  ← hard prerequisite for 23–28
 ├─ 23 (concurrency + health)   independent of 24–28; needed before a farm exceeds ~10 devices
 └─ 24 (stream lane + monitor) → 25 (cloud parity) → 26 (terminal)
                                              └────→ 27 (local adb endpoint) → 28 (cloud adb endpoint)
```

The M17 series (35–41) is **not** a chain — each plan stands alone and they can be worked in any order, with two exceptions: Plan 40 depends on Plan 34 (building input realism on a settings block that is never read would be building on sand), and Plans 37 and 39 each need `adb.maxStreamsPerDevice` raised, so whichever lands second must not lower it again.

```
34 (defect repairs)  ← do first: 40 depends on it, and it revives the ui-server
 ├─ 35 (session hygiene)      ─┐
 ├─ 36 (retry classification)  ├─ independent, any order
 ├─ 37 (crash detection)       │   37 and 39 both raise the per-device stream budget
 ├─ 38 (clipboard)             │
 ├─ 39 (transfer + install)    │
 ├─ 41 (integrity + doctor)   ─┘
 └─ 40 (input realism)  ← after 34
```

Plans 27 and 28 are the largest in the series and are gated: **Plan 27 opens with a throwaway spike against a real `adb` client, and the plan stops there if the spike fails.** Do not start 28 before 27's shim is proven.

One plan is one working session. Do not start a later plan in the same session as an earlier one — the point of the split is that the context stays small enough to hold accurately.

The M14 series is independent of M12 and M13. `30` and `31` do not depend on each other; `32` reads best after `31` (a device tile can then show its viewer count), but does not require it.

Plan `33` is independent of M12–M14. It needs Plan 18 (the device event log it writes to), Plan 22.1 (adb deadlines, since a hung `adb reverse` would otherwise park a queue slot), and the permission-gating pattern established in Plan 26. Its §9 Q4 names a smaller bug fix — honouring `HTTPS_PROXY` for the core's own outbound requests — that should land **before** it and is not part of it.

Plan `43` is a hard successor to `33`: it implements the `vpn-helper` engine that 33 registers as `available: false`, against the `NetworkRoute` interface and the lease-scoped teardown 33 establishes. It also introduces the repo's **third language toolchain** (Kotlin/Gradle in `apps/guest-agent/`, alongside TypeScript/Bun and Rust/Cargo), so it is the one plan whose cost is as much operational as technical. Its platform research lives in `docs/research/android-guest-agent.md` and must be read before its step 5.1. **Start from Plan `44` rather than from `33` or `43` directly** — it is a delivery slice that selects the minimum subset of both needed to make a proxy work end to end, and defers the rest explicitly.

### The AI Agents series (61–69)

Nine plans, and the ordering is not a preference: 61 must land first because until the tunnel process stops being called an agent, every later plan is writing the word twice for two things. 63 is the hinge — the tool list, the MCP server and the OpenAPI document are all generated from its registry, so anything built before it would be built against a surface that is about to be replaced.

```
61 (nodes — frees the word "agent")   ← first, unconditionally
62 (script refs, @latest)             ← independent of the rest; ships value alone, any time
63 (capability registry)  ← the hinge: 65–68 generate their surfaces from it
 └─ 64 (workspace/VFS)    ← adds fs.*; 65's workspace scope needs its path model
     └─ 65 (agents, providers, settings)   ← what an agent IS; no LLM call yet
         └─ 66 (the loop: threads, runs, streaming, approvals)
             └─ 67 (run tree: spawn, messages, cascading cancel)
                 └─ 68 (schedules + notifications)
                     └─ 69 (the workbench)
```

Two properties are worth protecting across the whole series because they are cheap to preserve and expensive to retrofit:

- **`invoke` is the only door.** Plan 63 §3.4 puts permission, device grant, lease, deadline and audit in one function. No later plan adds a check of its own or reaches a driver directly — an agent loop containing its own permission logic is an agent loop that will eventually disagree with the HTTP path.
- **Every budget fails closed.** Steps, seconds, tokens, depth, tree size, spend. No error path anywhere may produce *more* budget. This is written into 65 §3.7, 66 §6.3, 67 §3.6 and 68 §3.3 as an acceptance criterion rather than a convention, because the harness this design was studied against failed open in exactly one place and it was the step guard — two independent failures each led to 550 model turns. On a farm of physical phones that is twenty devices doing something nobody asked for, at 3 a.m.

Plans 61 and 62 have no dependency on each other and neither blocks the other; 62 can land whenever it is convenient.

### The repair series (70–74)

Plans 61–69 shipped with a green suite and a broken product. The defects were found by a person opening the pages, and every one of them was invisible to 2091 passing tests — which is the finding that shapes this series: **typecheck and unit tests never proved a screen worked, and treating them as verification was the mistake.** Plan 72 exists to make that class of defect catchable at all.

```
70 (vision — an agent can see)     ← FIRST: until it lands, the core feature does not work
71 (heldBy — who holds a device)   ← independent of 70; deletes plan 69's polling workarounds
72 (Studio parses; a DOM renderer) ← independent; land BEFORE 73, which is a large UI change
 └─ 73 (workbench UI/UX surgery)   ← needs 70 (attachments), 71 (device affordances), 72 (verifiability)
74 (job timeout + honest find)     ← independent of all of the above; completes plan 60
```

Only 73 has hard prerequisites. 70, 71, 72 and 74 can be worked in any order, and 70 is first by importance rather than by dependency: an agent that cannot see a phone screen is not an agent for a phone farm.

Two things this series establishes and later plans should hold to:

- **A response shape is declared once, in `@enkaku/protocol`, and parsed on both sides.** The Tools tab crashed because `api<T>()` ends in `return body as T` at 99 call sites — an `as`-cast at the exact boundary the repo's own rule was written for. No new endpoint may reintroduce it.
- **A UI plan is not verified until its screens have been rendered.** Plan 72 supplies the renderer; after it, "typecheck and tests pass" is a necessary claim and never a sufficient one.

**Plan 29 is a draft, not a work item.** Its status line says `DRAFT — NEEDS DISCUSSION. DO NOT EXECUTE`, and it deliberately has no implementation steps or acceptance criteria. It becomes executable only when a human answers its §9 and changes the status line. "Work the plans in order" does not include it.

## 3. Stack and decisions that must NOT change

These are settled in the spec (§4, §10.3, and the §21 closing note). No plan may change them without revising the spec:

| Area | Decision |
|---|---|
| Core runtime | **Bun** (not Node). The core daemon is Bun plus **Hono**. |
| Web UI | **Next.js** (Studio), reached through a browser; either served by the core (static export) or hosted. |
| DB | **SQLite** (zero setup) plus **Drizzle ORM**. The DB driver stays abstracted, but SQLite is the default. |
| Validation/schema | **Zod** at every boundary (protocol messages, script params, engine config, DeviceSettings). The JSON Schema for UI forms is generated from Zod. |
| Monorepo | Bun workspaces, laid out exactly as spec §4 (`packages/core|studio|sdk|protocol|adb|scrcpy|toolchain|drivers|node`, `apps/desktop`). `packages/node` was `packages/agent` before plan 61 renamed it. |
| scrcpy-server | **Genymobile's official vanilla .jar**, pinned to the core version (`swappable: false`). Never fork the Java. (spec §7.6) |
| Default input | `scrcpy-uhid`; falling back to `scrcpy-sdk`; `adb-input` is only a crude MVP fallback. (spec §9) |
| Default inspector (final) | A persistent on-device `ui-server`; `uiautomator dump` is only a bridge in M4. (spec §7.4) |
| Core⇄Studio communication | Message-based over **WebSocket** for realtime and streaming; REST for CRUD. The contract lives in `packages/protocol` (Zod). (spec §13) |
| adb serialisation | A per-device command queue (unchanged: one device, one command at a time) plus a **global** semaphore that scales with fleet size — `min(24, max(6, ceil(nonOfflineDeviceCount * 0.75)))`, so 6 is the floor (≤4 devices, same as before Plan 23) and 24 is the ceiling; the farm setting `adb.maxConcurrent` (default `0` = auto) can pin it instead. **`adb kill-server` is forbidden** except in the Toolchain Manager's adb version swap. (spec §10.4, amended by plan 23) |
| Local trust model | Crash containment (child process plus a hard-timeout kill), **not** a security sandbox. Never claim "sandbox". (spec §11.3) |
| Device identity | `stableId` (ro.serialno → ANDROID_ID fallback) is the identity; the adb serial is a transport address. (spec §7.5) |

## 4. Repo and code conventions

### 4.1 Monorepo structure (the final target; built up gradually from Plan 01)

```
openpf/
  package.json                # workspaces: ["packages/*", "apps/*"]
  bunfig.toml
  tsconfig.base.json
  packages/
    core/                     # the Bun + Hono daemon
    studio/                   # the Next.js web UI
    sdk/                      # @enkaku/sdk — defineScript, public types
    protocol/                 # @enkaku/protocol — Zod message schemas, shared types
    adb/                      # @enkaku/adb — adb client, track-devices, scrcpy-server push
    scrcpy/                   # @enkaku/scrcpy — the protocol client (demux, meta decode), version-locked
    toolchain/                # @enkaku/toolchain — tool provisioning (download, sha256, versions)
    drivers/                  # @enkaku/drivers — Transport/DisplaySource/InputSink/Inspector implementations
    node/                     # @enkaku/node — the cloud tunnel mini-core (Plan 11, renamed from "agent" in Plan 61)
  apps/
    desktop/                  # the Tauri shell (Plan 09)
  docs/
    spec.md
    plans/
```

- Internal npm package names use the `@enkaku/*` scope. `sdk` and `protocol` are designed to be publishable; everything else is `"private": true`.
- TS path aliases: cross-package imports always go through the package name (`@enkaku/protocol`), never a relative path across packages.

### 4.2 TypeScript conventions

- `"strict": true` and `"noUncheckedIndexedAccess": true` in `tsconfig.base.json`.
- All data crossing a boundary (WS messages, HTTP bodies, JSON DB columns, config files) **must** pass through Zod `.parse()`/`.safeParse()` — no `as` casting of external input.
- Errors: use coded error classes (`EnkakuError` with `code: string`) in the core; the API consistently returns `{ error: { code, message } }`.
- Logging: one logger utility in the core (levels debug/info/warn/error, a subsystem prefix, optional JSON-lines output). Every subsystem uses it; no stray `console.log`.
- Entity IDs: use `nanoid()` or `crypto.randomUUID()` — pick one consistently from Plan 01 onward (we use `crypto.randomUUID()`, built into Bun).
- DB timestamps: integer unix epoch **seconds** (Drizzle `{ mode: 'timestamp' }`), consistently across every table.

### 4.3 Replace, never version

This is a pre-1.0 prototype. Nothing has shipped to anyone, so **no compatibility window exists and none may be invented.**

- No `v2` suffixes, no `Legacy*` names, no `Old`/`New` pairs, no "deprecated but kept for one release". A change replaces the thing it changes.
- Renaming a field, changing a return type, or dropping a query parameter is a normal edit. Migrate every call site in the same commit — the only client ships in this repository.
- The exception is data already written to disk: a Drizzle migration that reads old rows is not a compatibility shim, it is a migration, and it is expected to exist.
- External protocol names are not ours to rename. adb's `shell,v2` service string is adb's spelling; it appears in the wire call and nowhere in our API surface.

This rule exists because the opposite was tried: Plan 30 kept six legacy response keys and an `offset` alias "for one release", which protected no one and left every list endpoint publishing the same array under two names. All of it was removed on 2026-08-03.

### 4.4 API and protocol conventions

- REST: the `/api/...` prefix, JSON, semantic status codes. Tool endpoints follow spec §7.7 exactly.
- WS: one `/ws` endpoint for control-plane messages (a JSON envelope), with binary video streams as binary messages carrying a channel prefix (details in Plans 03 and 08). The JSON envelope:
  ```ts
  { type: string; id?: string; payload: unknown }   // id correlates request and reply
  ```
- Every message type is declared in `packages/protocol` as a Zod discriminated union; core and studio import from there. There are **no** hardcoded message type strings outside the protocol package.

### 4.5 Testing conventions

- Test runner: `bun test`. `*.test.ts` files colocated in `src/`.
- Every plan has a **Test plan** section; at minimum: unit tests for pure logic (queue, parsers, checksums, state machine) plus a scripted manual smoke test (with the exact commands written into the plan).
- Tests needing a physical device are marked and skippable via the `ENKAKU_TEST_DEVICE=1` env var.

### 4.6 Commit and branch conventions

- One plan may span many commits; messages read `feat(m0): ...`, `fix(m2): ...`, `chore: ...`.
- This repo is not yet a git repo — Plan 01's first step includes `git init`.

## 5. App-data and runtime paths (used across plans)

Per spec §7.2:

- macOS: `~/Library/Application Support/Enkaku`
- Windows: `%APPDATA%\Enkaku`
- Linux: `~/.local/share/enkaku` (as a service: `/var/lib/enkaku`)
- Dev/test override: the `ENKAKU_DATA_DIR` env var.

Contents: `enkaku.db`, `tools/<toolId>/<version>/...` plus an `active` pointer, `artifacts/<job-id>/...`, `logs/`.

## 6. Plan template (the required structure for documents 01–11)

Every plan follows this structure, at a depth where "the AI builder just follows it":

```markdown
# Plan XX — <Milestone> : <Title>

> Status / Depends on / Spec references (§...)

## 1. Goals            — what must be TRUE once the plan is done (measurable bullets)
## 2. Non-goals        — what is deliberately NOT done here (and which plan does it)
## 3. Context and design decisions — a design summary plus reasoning, referencing the spec
## 4. Technical design — TS interfaces, DB/Zod schemas, endpoints, file structure, flows and sequences
## 5. Implementation steps — numbered stages (X.1, X.2, ...) with concrete sub-checklists,
##                       each naming the files created or changed and a verifiable result
## 6. Acceptance criteria — the final checklist; everything must pass
## 7. Test plan         — unit tests plus a manual smoke test (with explicit commands)
## 8. Risks and mitigations
## 9. Open questions    — spec ambiguities needing a human decision (do not decide unilaterally)
```

## 7. Global Definition of Done (applies to every plan)

1. Every acceptance criterion in the plan passes.
2. `bun test` is green across the workspace.
3. No new unjustified TODOs or `any` in the code you touched.
4. New behaviour is documented at least in the relevant package README.
5. The spec §16 NFR targets relevant to that milestone are checked (Plan 06: inspector find < 200 ms; Plan 08: glass-to-glass < 150 ms on a LAN).
6. **The plan's status line is updated, and `bash scripts/check-plan-status.sh` passes.** Add a `> Ships: <path>` line naming one artefact that proves the plan shipped, so the check is mechanical rather than a memory exercise. Six of the first eight plans audited had shipped while still marked `draft` — and these documents are what an agent builder reads to decide what to work on next, so a stale status line makes it re-implement finished work.
7. **Every process you started is dead, verified with `ps`, not `lsof`.**
   ```bash
   ps -Ao pid=,command= | grep -i "[o]penpf"   # nothing but your own shell
   ```
   `lsof -sTCP:LISTEN` only sees processes that opened a port, so it is structurally incapable of catching the ones that matter most. A debug script left behind by an automated run burned a full CPU core for 14 hours on the maintainer's machine and passed an `lsof` check the whole time, because it never listened on anything.
8. **If this plan added a table, endpoint, protocol message, screen, or engine, `docs/spec.md` is updated in the same commit — or a `DIV-` row is added saying why not.**

## 8. Short glossary

- **Core** — the Bun + Hono daemon, orchestrator of everything.
- **Studio** — the Next.js web UI.
- **Engine** — an implementation of one of the four driver layers (Transport/DisplaySource/InputSink/Inspector).
- **DeviceSession** — the four engines assembled for one device (spec §7).
- **Lease** — the exclusive right to use a device (manual or job), with a heartbeat and an expiry.
- **stableId** — the stable device identity (ro.serialno / ANDROID_ID), not the adb serial.
- **Toolchain Manager** — the subsystem that provisions binaries (adb, scrcpy-server, ui-server, and so on).
- **swappable** — a tool flag: whether users may freely pick a version (scrcpy-server: `false`).

The **M24 series is a chain, and the order is load-bearing**: `50 → 51 → 52`. Plan 50 exists because the proxy bring-up found six defects that unit tests could not see, so 51 and 52 are built on a foundation that can be checked. Plan 51 must precede 52 because a route that persists across leases and reboots but cannot be verified is *worse* than one that dies — it fails silently for longer. Plan 52 deliberately reverses Plan 44's lease-scoped route lifetime; the reasoning is in its §0 and §3.1, and spec §7.9 rule 1 is amended by its step 5.7.

## 9. Tracked removals (dated follow-ups)

Compatibility windows are the one exception §4.3 "Replace, never version" allows — data already on disk, or a binary already deployed in the field. Every one opened here gets a removal target written down at the same time, so it does not quietly become permanent (§4.3's own cautionary example: Plan 30's "kept for one release" lasted far longer than one release).

| Opened by | What | Remove when |
|---|---|---|
| Plan 61 §3.3 | The control plane accepts the pre-rename `agent.hello`/`agent.devices` tunnel messages (logged `warn`) alongside `node.hello`/`node.devices`; a node adopts an existing `<data-dir>/agent.json` once and rewrites it as `node.json`; the control plane's WS upgrade also accepts the pre-rename `/agent/ws` path alongside `/node/ws`; ~~Studio's `/agents` route redirects to `/nodes`~~ **removed early by Plan 65** — `/agents` now hosts the real AI agents list Plan 65 §4.6 builds, so the redirect and the feature could not coexist at the same route; `/nodes` remains reachable via its own `AppShell` nav entry; the root `dev:agent` script alias calls `dev:node` with a deprecation line. | By v0.1.7 (two releases after the v0.1.5 this plan lands alongside) — remove the `agent.hello`/`agent.devices` schema variants and their router branch, the `agent.json` fallback in `packages/node/src/state.ts`, the `/agent/ws` path in `daemon.ts`, ~~the `/agents` Studio redirect page~~ (done, Plan 65), and the `dev:agent` package.json script. |
| Plan 85 §3.1, §4.1 | `adb.maxStreams` — the streaming lane's farm-wide budget — changed its meaning from a fixed constant to `0 = auto` (`computeAutoStreams`, matching `adb.maxConcurrent`'s existing convention). A stored `4` (the old default, which no operator ever chose deliberately — the setting had no visible effect until it started refusing streams past two instrumented devices) is rewritten to `0` by a Zod `preprocess` (`normaliseLegacyAdb`, `packages/protocol/src/settings.ts`) on the first boot after upgrading only; an operator who wants a pinned `4` sets it again afterward and it then survives untouched. | 2027-02-01 — remove `normaliseLegacyAdb` and its `.preprocess()` wrapper around `adb`'s Zod object in `packages/protocol/src/settings.ts`. After that date a stored `4` means a deliberate `4`, not an unmigrated leftover. |
