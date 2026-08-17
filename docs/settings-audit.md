# Settings audit — every field in `packages/protocol/src/settings.ts`

Read-only audit. Every field of `DeviceSettingsSchema` (per-device, and reused verbatim as
`FarmSettingsSchema.defaults`) and `FarmSettingsSchema` is checked against the actual code that
would need to read it. `BatteryStateSchema` is also in this file and is audited for completeness
even though it is telemetry, not a setting. `packages/core/src/plugin*` and plans 108/109 were
excluded (a peer session is actively changing that area).

**Totals: 176 fields audited — 151 LIVE, 11 DEAD, 7 SHADOWED, 1 PARTIAL, 6 DISPLAY-ONLY.**

Method: every field's name, dotted path, and any destructured/spread/aliased access was grepped
across `packages/core/src`, `packages/session/src`, `packages/adb/src`, `packages/studio/src`
(excluding `plugin*`), and `apps/guest-agent`. A hit only counts if it is genuine runtime
consumption (a gate check, a timer, a semaphore, a kill decision) — not a re-export, a type, or a
Studio form field. The device Settings tab and the farm Settings tab are both **fully
schema-driven** (`packages/studio/src/components/settings/deviceSections.ts`,
`farmSections.ts`) — `farmSections.test.ts` asserts every `FarmSettingsSchema` top-level key is
claimed by exactly one section, and `deviceSections()` derives its sections entirely from
`DeviceSettingsSchema`'s own `x-enkaku.group` metadata. So **every field in both schemas is
rendered and savable somewhere in Studio** — the open question for each one is only ever "does
anything read it back," never "does it appear in the UI." That is why the Studio citation for most
rows below is just "the generic schema form," and why a bespoke UI (a dedicated component) is
called out specifically where one exists.

---

## Summary table

| Field(s) | Scope | Verdict | Consequence |
|---|---|---|---|
| `defaults.identity.timezone/locale/gps.*` (5 fields) | farm-wide, duplicated (per-device instance also exists) | **DEAD, ACTIVELY HARMFUL** | See detail — not inert, it stamps identical GPS onto every device admitted while it's set |
| `timing.*` (7 fields: tapJitterMs, betweenActionMs, coordJitterPx, profile, gestureCurvature, gestureSampleIntervalMs, perCharMs) | per-device instance | **SHADOWED** | Per-device customization is silently ignored; the farm default always wins for every job on every device |
| `workflow.maxTotalMs` | farm-wide | **PARTIAL** | Live for the runtime kill switch, hardcoded for the publish-time preflight check — the two can disagree |
| `prep.disableAnimations` | per-device (+ farm default) | **DEAD** | No applier exists anywhere; turning it off does nothing, sits beside three siblings that DO work |
| `video.controlPreset`, `video.wallPreset` | per-device override | **DEAD** | Schema text says "overrides the farm setting for this device only" — false. Only the four numeric siblings actually override |
| `adb.execTimeoutMs` | farm-wide | **DEAD** | Every real adb timeout comes from a hardcoded per-call-site table (`packages/adb/src/timeouts.ts`), never this setting |
| `adb.maxQueueDepth` | farm-wide | **DEAD** | `AdbClient` is constructed without this option; no setter exists at all, unlike its four live siblings |
| `shell.commandRunsPerUser` | farm-wide | **DEAD** | `trimForUser()` is implemented and unit-tested but never called from any production code path |
| `engines.*` (4), `input.preferredMode`, `prep.keepAwake/standbyScreenOff/rotation/textInput`, `autoReconnect`, `logInputText`, `instrumentation.tagTraffic`, `labelling.mode/showName` (13 fields) | per-device | LIVE | — |
| `video.controlMaxSize/MaxFps/BitRate`, `video.wallMaxSize/MaxFps/BitRate` (6 fields) | per-device override, farm-wide | LIVE | — |
| `job.*` — all 23 leaf fields (resetPolicy/resetTimeoutMs/resetStrict, retry.\*, crashPolicy, quietPeriodSec/maxWaitSec, defaultTimeoutMs/startupTimeoutMs/maxTimeoutMs, memory.\*, trigger.\*, maxResultBytes, progressIntervalMs) | farm-wide | LIVE | `job.memory.*`'s doc comment in settings.ts is stale (says enforcement "has not landed yet"); plan 98 is marked fully implemented and the kill path traces end to end — documentation bug only |
| `adb.maxConcurrent/maxStreamsPerDevice/maxStreams/maxHostConcurrent/maxInstallConcurrent` (5) | farm-wide | LIVE | — |
| `discovery.*` — all 14 leaf fields including `networks[]`, `scan.*`, `cutover.*` | farm-wide | LIVE | — |
| `guestAgent.*` (3), `monitor.crashWatch`, `health.*` (3), `adbControl.*` (4), `labelling.maxConcurrent` | farm-wide | LIVE | — |
| `shell.*` — remaining 15 leaf fields | farm-wide | LIVE | `fanoutConfirmThreshold` is enforced **only client-side** (Studio JS), no server-side re-check — not dead, but not a real security gate either |
| `coControl.*` (5), `mirror.*` (4) | farm-wide | LIVE | — |
| `session.*` (3), `display.fallbackRetryCount`, `readiness.*` (2) | farm-wide | LIVE | — |
| `video.*` (8, farm-wide top-level block), `wall.*` (5) | farm-wide | LIVE | — |
| `transfer.*` (5), `network.geoProvider/geoIntervalSec` (2) | farm-wide | LIVE | — |
| `workspace.*` (3), `kv.*` (4) | farm-wide | LIVE | — |
| `agentDefaults`, `scheduledAgents.*` (2), `recording.*` (6) | farm-wide | LIVE | Scheduled-run-only exclusion for `scheduledAgents.*` confirmed real (interactive runs cannot reference either ceiling) |
| `battery.*` (3, farm-wide), `retention.*` (8, farm-wide) | farm-wide | LIVE | `enabled`-gating split (artifact sweep only) confirmed to hold exactly as documented |
| `BatteryStateSchema` — level, temperatureC, status, health, voltageMv, updatedAt (6) | device telemetry | DISPLAY-ONLY | Not a defect. Minor completeness note: `voltageMv` is collected and stored but has no display site found anywhere in Studio |

---

## Detail — DEAD, SHADOWED, PARTIAL, and other consequential findings, ranked by real consequence

### 1. `defaults.identity` (timezone, locale, gps.lat/lng/accuracy) — DEAD as an ongoing setting, ACTIVELY HARMFUL as a one-shot enrollment stamp

**Highest-severity finding.** Scope: **duplicated** — the same shape exists per-device
(`DeviceSettingsSchema.identity`, live) and farm-wide (`FarmSettingsSchema.defaults.identity`,
the subject of this row).

- **Studio surface**: Settings → Defaults (`packages/studio/src/components/settings/farmSections.ts:58`,
  `{ id: 'defaults', ..., keys: ['defaults', 'labelling'] }`), rendered by the generic schema form
  under the "Identity" group, editable and savable exactly like every other farm default.
- **Ongoing reads**: `packages/core/src/api/device-identity.ts`'s `readSettings` (~line 94) parses
  only `row.settings` (a device's own persisted identity) and falls back to
  `defaultDeviceSettings()` on parse failure — it never touches `settingsStore.get().defaults.identity`.
  Confirmed by grep: no other file in `packages/core/src`, `packages/session/src`, or
  `packages/studio/src` reads `defaults.identity` for a device that is already enrolled. This
  matches the schema's own top-level description of `defaults`: "Devices already registered keep
  their own settings" — so for an existing fleet, editing this control is provably a no-op, exactly
  as the task's own framing states.
- **But it is not simply inert.** `packages/core/src/registry/admission.ts`'s `defaultsForNewDevice`
  (line 62) does `const s = opts.deviceDefaults?.() ?? defaultDeviceSettings()` and spreads the
  **entire** `DeviceSettings` object — `settings: s` — onto every newly admitted device's row,
  with no field-level exclusion. `opts.deviceDefaults` is wired at `packages/core/src/daemon.ts:2121`
  and `:3341` as `() => settingsStore.get().defaults` — a live read of the real store. So a farm-wide
  GPS/timezone/locale set under Settings → Defaults **is** applied — once, silently, at the moment
  of admission — to the per-device `identity` field of every device admitted while it is set. It
  then becomes each device's own persisted value, at which point `device-identity.ts` treats it as
  that device's deliberate identity going forward.
- **Consequence**: this is exactly the scenario the field's own schema doc comment (plan 58) warns
  against — "a route that exits in New York while the device still reports Asia/Jakarta... is
  exactly the mismatch social platforms flag." A farm-wide default GPS does not merely fail to
  help; it actively creates a *stronger* correlation signal than no identity spoofing at all,
  because every device admitted in that window shares byte-identical coordinates. An operator who
  sets a "sensible default" location before onboarding a batch of phones — a natural thing to try —
  gets the worst possible outcome, with no indication anything happened (no audit entry, no warning,
  nothing in the admission response calls out that identity was seeded).
- **Plan status**: plan 58's own text (cited in the schema comment) states device identity is
  designed to be per-device, not fleet-wide, and is explicit that every field is optional so an
  absent value means "leave the device alone" — this control's continued existence in the `defaults`
  block, and its silent one-shot application, contradicts that stated design. This is not a
  half-built plan waiting on a follow-up step; plan 58 reads as complete, and the defaults form
  still renders and saves this control as if it worked continuously.

### 2. `timing.*` (tapJitterMs, betweenActionMs, coordJitterPx, profile, gestureCurvature, gestureSampleIntervalMs, perCharMs) — SHADOWED

Scope: **duplicated** — per-device `DeviceSettingsSchema.timing` (SHADOWED, the subject of this
row) vs. farm-wide `FarmSettingsSchema.defaults.timing` (the half that actually wins, see below).

- **Studio surface**: device Settings → "Human-like touch" tab (group `Timing`, generic schema
  form), and the same fields again under Settings → Defaults → Timing.
- **Reader**: `packages/core/src/daemon.ts:3230` — `timing: () => settingsStore.get().defaults.timing`
  — wired once into the job runner's dependency set and read fresh per attempt. This is the **only**
  place timing realism is resolved for a running job; it reads the farm-wide `defaults.timing`
  unconditionally.
- **Verification of absence**: grepped `\.timing\b` and `settings.timing`/`deviceSettings.timing`
  across `packages/core/src`, `packages/session/src`, `packages/studio/src` — no code path reads a
  specific device row's own `settings.timing`. `packages/core/src/capability/context.ts:374` and
  `packages/session/src/device-executor.ts`/`runner/job-runner.ts` only ever forward whatever
  `deps.timing` (the daemon-wired farm accessor) returns — none of them accept or look up a
  per-device override.
- **Consequence**: an operator who customizes tap jitter, gesture curvature, or typing cadence on
  one device — say, to make one particular account behave more cautiously — gets no effect at all;
  every job on every device uses the farm default. This is silently ignored, not actively harmful,
  but it directly contradicts what the per-device Settings tab implies is possible.
- **Note on the code's own comment**: `daemon.ts`'s inline comment argues this is intentional —
  "`defaults` because `timing` is defined once, on `DeviceSettingsSchema`... there is no separate
  top-level `timing` field" — but this reasoning is misleading: `DeviceSettingsSchema.timing` *is*
  a genuinely separate, independently-persisted instance on every device row (Studio renders and
  saves it as such), even though it shares one Zod schema declaration with `defaults.timing`. The
  comment conflates "one schema declaration" with "one live instance."
- **This is the exact bug shape named in the task brief** (plan 94 F35/F36) — confirmed present and
  unfixed as of this audit.

### 3. `workflow.maxTotalMs` — PARTIAL, and both this file's and `workflow.ts`'s own doc comments are stale in the opposite direction

Scope: farm-wide, single field, no per-device analog.

- **Studio surface**: Settings → Jobs tab (`farmSections.ts:117`, `keys: ['job', 'workflow']`).
- **Runtime executor (LIVE)**: `packages/core/src/jobs/executors/workflow.ts:414-419` reads
  `deps.settings().maxTotalMs` and raises `E_WORKFLOW_BUDGET_EXCEEDED` when a workflow's wall-clock
  time exceeds it. `packages/core/src/daemon.ts:3292` wires `settings: () => settingsStore.get().workflow`
  — a genuine live read. Confirmed by
  `packages/core/src/jobs/executors/workflow-settings-wiring.test.ts`, a regression guard that reads
  `daemon.ts`'s own source text and fails if this ever regresses back to a captured literal — its own
  comment states it "used to PIN THE GAP... now pins the OPPOSITE fact."
- **Publish-time check (DEAD/hardcoded)**: `checkWorkflow`'s `E_WORKFLOW_BUDGET_IMPOSSIBLE` check
  (`packages/protocol/src/workflow-check.ts`) is called from `packages/core/src/api/workflows.ts`
  via `budgetFor(deps)` (line 135): `return deps.settings ? deps.settings() : { maxTotalMs: defaultFarmSettings().workflow.maxTotalMs }`.
  `packages/core/src/daemon.ts:2469` calls `createWorkflowRoutes({ db, registry: scriptRegistry, audit })`
  — **`settings` is never passed** — so `budgetFor` always falls back to the hardcoded 6-hour schema
  default, never the live customized value.
- **Both settings.ts's comment (lines ~1799-1811) and `workflow.ts`'s own module doc comment describe
  this the wrong way round** — they say the *runtime executor* is the one still hardcoded and the
  *publish-time check* is the one already live, citing a "concurrent worker held `daemon.ts`" note
  from plan 99 step 99.7. The current code is the exact inverse: the runtime executor was fixed (with
  a dedicated regression test), and the publish-time route was never given the same fix, with no
  equivalent regression test guarding it.
- **Consequence**: an operator who raises `workflow.maxTotalMs` above 6h gets the longer budget
  correctly *enforced* at runtime, but `POST /api/workflows/.../publish`'s pre-flight worst-case
  check still validates against the stale 6h ceiling — it can wrongly flag (or wrongly fail to flag)
  a workflow whose real worst case sits between the operator's actual budget and 6h. The two
  consumers of one setting disagree with each other, which is a more confusing failure mode than the
  field simply being ignored.
- **Plan status**: plan 99 (`docs/plans/99-m64-workflows.md`) is marked "Status: partial — 99.1–99.10
  and 99.12 are done... 99.11 (H1–H4 hardware measurements) is the one remaining step" — but 99.11 is
  unrelated to this gap (it is a hardware-measurement task). The `createWorkflowRoutes` settings pass-through
  was evidently dropped when the runtime-executor half was fixed, and nothing currently tracks it as
  open.

### 4. `prep.disableAnimations` — DEAD

Scope: per-device (and its farm-default template instance, same non-effect either way).

- **Studio surface**: device Settings → "Before a job runs" (group `Power & readiness`), alongside
  `keepAwake`, `standbyScreenOff`, `rotation`, `textInput` — all four of which **are** wired.
- **Verification**: grepped `disableAnimations` across `packages/core/src`, `packages/session/src`,
  `apps/guest-agent` — zero hits outside `settings.ts` and its own test. No `animator_duration_scale`
  / `transition_animation_scale` / `window_animation_scale` shell command, no applier alongside
  `applyRotation()`/`applyTextInput()`/`wakeDevice()` in `packages/session/src/session.ts`.
- **Consequence**: turning this off is expected, by an operator reading the label, to make automation
  more reliable against animation-timing flakiness before a job runs. It does nothing. Silently
  ignored, not actively harmful, but it sits in the same control group as four siblings that do work,
  which makes the gap easy to miss and easy to trust incorrectly.

### 5. `video.controlPreset`, `video.wallPreset` (per-device override) — DEAD, with misleading UI copy

Scope: per-device override of a farm-wide default.

- **Studio surface**: device Settings → Video tab (group `Video`), described in the schema itself
  as "Overrides the farm setting for this device only."
- **Verification**: `packages/session/src/video-profile.ts`'s `resolveVideoProfile` reads
  `CONTROL_PRESETS[farm.controlPreset]` (line 88) and `WALL_PRESETS[farm.wallPreset]` (line 105) —
  both indexed only off the **farm** argument. `device?.controlPreset`/`device?.wallPreset` are
  referenced nowhere in that file or anywhere else. Meanwhile the four numeric per-device fields
  right below each preset — `controlMaxSize/MaxFps/BitRate`, `wallMaxSize/MaxFps/BitRate` — genuinely
  do merge (`device?.controlMaxSize ?? farm.controlMaxSize`, etc.), confirmed live.
- **Consequence**: an operator who tries to give one device a lighter or sharper picture *by
  choosing a preset* gets silently ignored — the description text actively promises this works. An
  operator who instead sets the four numeric fields individually gets the override they wanted. This
  is the more misleading of the two DEAD device-level findings because the UI copy makes an explicit,
  false claim rather than just omitting a warning.

### 6. `adb.execTimeoutMs`, `adb.maxQueueDepth` — DEAD

Scope: farm-wide, both in the same `adb.*` block as five siblings that are genuinely live
(`maxConcurrent`, `maxStreamsPerDevice`, `maxStreams`, `maxHostConcurrent`, `maxInstallConcurrent`,
all confirmed wired at `packages/core/src/daemon.ts:514-515, 534-535`, and
`packages/core/src/device/host-adb.ts:169-170`).

- **Studio surface**: Settings → adb tab (`farmSections.ts:65`).
- **`execTimeoutMs`**: every real adb exec deadline comes from `packages/adb/src/timeouts.ts`'s
  hardcoded `ADB_TIMEOUTS` per-call-site profile map via `resolveExecTimeout()` — confirmed by
  reading `packages/adb/src/client.ts:445` (`const execTimeoutMs = resolveExecTimeout(opts)`, which
  never consults farm settings) and grepping `execTimeoutMs` across `packages/core/src` and
  `packages/adb/src` for any settings-store read — none exists for the `adb.*` block specifically
  (the field name is reused, unrelatedly, by `shell.execTimeoutMs`, which *is* live for the terminal —
  a different, correctly-wired field with the same name).
- **`maxQueueDepth`**: `AdbClient` is constructed at `packages/core/src/daemon.ts:2887` with no
  `maxQueueDepth` option, so `packages/adb/src/client.ts:286` always falls back to the compiled-in
  `DEFAULT_MAX_QUEUE_DEPTH` (32, `packages/adb/src/timeouts.ts:11`). Unlike `maxConcurrent`/`maxStreams`/
  `maxStreamsPerDevice`, there is no resize-style setter for this value at all — even a future fix
  that starts reading the setting in `recomputeAdbConcurrency` would still need a new code path, not
  just a wiring change.
- **Consequence**: silently ignored, not harmful. Masked in practice because both hardcoded defaults
  (15,000ms; 32) happen to equal the schema's own defaults — an operator only discovers the gap by
  changing the value and observing no behavior change.

### 7. `shell.commandRunsPerUser` — DEAD

Scope: farm-wide, in the fleet command console's block (`shell.*`), whose other 15 fields (including
its close sibling `savedCommandLimit`, confirmed live at `packages/core/src/api/saved-commands.ts:123`)
are all live.

- **Studio surface**: Settings → Terminal & transfer tab (`farmSections.ts:148`, group `Fleet commands`).
- **Verification**: `packages/core/src/command-console/store.ts:184` defines
  `trimForUser(createdBy: string, cap: number): number`, fully implemented and covered by
  `store.test.ts:234-271` — but grepping `trimForUser` across `packages/core/src` shows no caller in
  `runner.ts`, `ws-handlers.ts`, `daemon.ts`, or any `api/*.ts` route.
- **Consequence**: silently ignored. The per-user command-history cap an operator sets in Studio is
  never enforced anywhere; each user's command run history grows without bound regardless of the
  configured value.

### 8. `job.memory.*` — LIVE, but the schema's own doc comment is stale and could mislead an operator

Scope: farm-wide, all four leaf fields (`defaultMaxRssBytes`, `maxRssBytes`, `enforce`,
`sampleIntervalMs`).

- The comment directly above this block in `packages/protocol/src/settings.ts` (~lines 729-736)
  states verbatim: "nothing here enforces anything by itself — plan 98's own step 98.3 (Measure
  before limiting) is what wires a breach to a kill, and it has not landed yet."
- **This is now false.** `docs/plans/98-m63-script-runtime-envelope.md` line 3: "Status: implemented
  — every step 98.1–98.9 implemented and tested," and line 53 names 98.3 specifically as implemented.
  Tracing the code confirms full end-to-end enforcement: `packages/session/src/runner/child-entry.ts:610-611`
  self-reports RSS, `packages/session/src/runner/job-runner.ts:629-633` compares it against the
  resolved ceiling and calls `doAbort('memory', …)` when `enforce: 'kill'`.
- **Consequence**: not a functional defect — this is a documentation bug. But an engineer or operator
  reading only the schema's inline comment (a reasonable thing to do, since it is the primary
  documentation surface for this field) would incorrectly conclude memory limits are currently
  decorative, when they are fully enforced. Worth a one-line comment fix.

### 9. `shell.fanoutConfirmThreshold` — LIVE, but client-side only

Scope: farm-wide.

- Enforced in `packages/studio/src/app/console/page.tsx:221` and
  `packages/studio/src/components/device-popup/AdbCommandDialog.tsx:242`
  (`needsTyped = targetCount > fanoutConfirmThreshold`) — a genuine read of the setting, so it is not
  DEAD. But grepping `packages/core/src/command-console/runner.ts` and `ws-handlers.ts` shows no
  server-side re-check of this threshold before a fan-out command executes.
- **Consequence**: this is a real behavior for the Studio UI (a person is stopped and asked to type
  the device count above the threshold), but it provides no defense-in-depth against a scripted or
  API client sending the same fan-out request directly — the "typed confirmation" is a UI habit, not
  an authorization boundary. Worth noting since the setting's own description ("Above this many
  devices, the operator must type the device count to confirm") reads as a safety control, and for a
  person clicking through Studio it is one — it just does not extend to any other caller.

---

## Fields confirmed correctly working as designed (not defects, included to close out ambiguity)

- **`labelling.mode`/`showName`** (per-device) and **`labelling.maxConcurrent`** (farm-wide): the farm
  default is genuinely copied onto a device once, at admission (`packages/core/src/registry/admission.ts`'s
  `defaultsForNewDevice`, same whole-object-spread mechanism identity rides), and never retroactively
  reapplied — exactly matching the schema's own documented intent ("flipping the farm default never
  retroactively relabels an existing fleet"). This is the same underlying mechanism that makes
  `defaults.identity` harmful (finding #1) and `defaults.timing` irrelevant (finding #2) for their own
  fields — but for `labelling`, `prep.keepAwake/rotation/textInput`, `engines.*`, `instrumentation.tagTraffic`,
  and `autoReconnect`/`logInputText`, this same enrollment-copy-then-diverge behavior is exactly the
  documented, correct design (`FarmSettingsSchema.defaults`'s own top-level `.meta().description`:
  "Copied onto a device the first time it is enrolled. Devices already registered keep their own
  settings.").
- **`scheduledAgents.spendCapOutputTokensPer24h`/`maxConcurrentScheduledRuns`**: confirmed the
  documented exclusion is real, not just described — `packages/core/src/agent/runner.ts` (interactive
  chat path) has zero references to either ceiling; both are read only from
  `packages/core/src/schedules/runner.ts` (the cron-fired path).
- **`retention.*`**: the documented `enabled`-gating split holds exactly — `sweepOnce()`
  (`packages/core/src/maintenance/retention.ts:127-131`) runs `sweepEvents()` and `sweepCommandRuns()`
  unconditionally, and only gates the artifact sweep (`maxAgeDays`/`maxTotalGb`) behind `policy.enabled`.
- **`BatteryStateSchema`**: confirmed read-only telemetry — written by
  `packages/core/src/device/battery.ts`'s poller, served by `packages/core/src/api/devices.ts`,
  displayed across multiple Studio components, never editable from any settings form. Correctly
  DISPLAY-ONLY, not a defect. Minor completeness note: `voltageMv` is polled and stored
  (`battery.ts:48`) but no Studio component appears to render it.
