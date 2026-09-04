# Plan 212 - MVP wave 2 : Settings reduced to fifteen visible fields and eleven advanced

> Status: implemented (software) — executed 2026-09-04; every §0 goal closed except G12 (owner's farm smoke). See §11 for the handoff report.
> Depends on: plan 205 (adds the `control` block and deletes `coControl`, `mirror`, `job.quietPeriodSec`, `job.maxWaitSec`), plan 211 (jobs and runs; `job.*` readers move to the run model), plan 200 (rules and format). Plans 206 and 207 land before this one in the wave order and have already rewritten the `session` block and deleted the `shell.fanout*` fields; this plan must not re-add either.
> Spec references: `docs/mvp/12-settings.md` (entire: §0 the rule, §1 the fifteen visible, §2 the eleven advanced, §3 the constants, §4 the removed, §5 the moved, §6 the result table, §7 the open points), `docs/mvp/13-removal-register.md` A.7 (copied into §10), `docs/mvp/15-ui-migration.md` §1 row "Settings content" and §0 (the two-column layout and the group names), `docs/mvp/design_handoff_enkaku_openpf/README.md` "Screen: Settings" (quoted verbatim in §4.9), `docs/mvp/09-additional-scope.md` §6 (retention defaults) and §7 (the wall budget becomes measured), `docs/mvp/16-consolidated-plan.md` §2 row "Settings" and §3 wave 2, `docs/settings-audit.md` (the dead and shadowed findings).
> Ships: packages/core/src/config/constants.ts

---

## 0. Goal checklist

Every command runs from the repo root. `GREP_212` is the one gate grep, defined once in §10 and copied verbatim wherever it is cited.

| # | Goal | Parameter | Verified by | Done |
|---|---|---|---|---|
| G1 | `FarmSettingsSchema` carries exactly 26 titled settings | 15 visible + 11 advanced | `rg -c 'ui\(\{ title:' packages/protocol/src/settings.ts` prints `26` | [x] |
| G2 | The settings schema file is small | under 600 lines | `wc -l < packages/protocol/src/settings.ts` prints a number ≤ 600 | [x] |
| G3 | `FarmSettingsSchema` has exactly nine top-level keys, in the §4.3 order | `general, hostDaemon, networkScan, jobRunner, capture, storage, devices, privacy, advanced` | `bun test packages/protocol/src/settings.test.ts` → the test named `top-level keys are the nine sections, in order` passes | [x] |
| G4 | Every removed or renamed field name is gone from live code | 0 matches | `GREP_212` (§10) prints nothing | [x] |
| G5 | `packages/core/src/config/constants.ts` exists and every constant it exports has an `ENKAKU_*` row in `.env.example` | 0 unmatched names | `bun test packages/core/src/config/constants.test.ts` → the test named `every override name appears in .env.example` passes | [x] |
| G6 | An out-of-range support override fails the boot with `E_BAD_CONFIG` | `ENKAKU_ADB_TCP_PORT=70000` | `bun test packages/core/src/config/constants.test.ts` → the test named `an out-of-range override throws E_BAD_CONFIG` passes | [x] |
| G7 | A settings blob stored by the current (pre-212) schema migrates without loss of the fields that survive | the six §4.8 cases | `bun test packages/core/src/settings/migrate-settings.test.ts` passes (6 cases) | [x] |
| G8 | `DeviceSettingsSchema` carries only the §4.6 keys, and every override field is optional | `engines, identity, prep, autoReconnect, logInputText, instrumentation, overrides` | `bun test packages/protocol/src/settings.test.ts` → the test named `device settings are engines, identity, prep and optional overrides` passes | [x] |
| G9 | `GET /api/agents/settings` answers the agent block and `GET /api/settings` no longer carries it | `agentDefaults`/`scheduledAgents` absent from the farm payload | `bun test packages/core/src/api/agent-settings.test.ts` passes | [x] |
| G10 | Studio's farm section list is derived from the schema and yields ten sections | 10 sections, 4 group headings | `bun run typecheck` exits 0 and `rg -n "FARM_SECTION_DEFS" packages/studio/src` prints nothing (the constant is replaced by `farmSections(schema)`) | [x] |
| G11 | The workspace typechecks | 0 errors | `bun run typecheck` exits 0 | [x] |
| G12 | On the owner's farm, the Settings page shows ten sections and every field saves | ten left-nav entries; a PATCH of each section returns `200` | §7.4 manual smoke | owner |

## 1. Goals

1. Cut `FarmSettingsSchema` from 115 titled fields to 26: the fifteen a farm operator can predict the effect of, and the eleven an engineer may need (`docs/mvp/12-settings.md` §0, §1, §2).
2. Promote roughly seventy values that do not differ between farms into named constants in one file, each with an `ENKAKU_*` support override read once at boot through Zod (`docs/mvp/12-settings.md` §3).
3. Delete the fields whose feature is gone, and the nine fields `docs/settings-audit.md` marked dead or shadowed - deleted, not kept with corrected copy (`docs/mvp/13-removal-register.md` A.7).
4. Move the five AI blocks to an `AgentSettingsSchema` served by `/api/agents/settings`, and unhook the Key/Value browser from the farm Settings page so plan 219 can put it on Plugins (`docs/mvp/12-settings.md` §5).
5. Reduce the per-device schema to the same visible set plus "use farm default" on each field, and delete the farm-wide `defaults` mirror that produced the shadowing class of bug in the first place (`docs/mvp/12-settings.md` §5, `docs/settings-audit.md` #2).
6. Make retention a visible section with the MVP 09 §6 defaults, so plan 224's nightly sweeper has settings to read.
7. Migrate the stored settings JSON: unknown keys dropped, renamed keys mapped, out-of-range values clamped, one log line each.

## 2. Non-goals

| Not done here | Plan that does it |
|---|---|
| The Settings page itself - the two-column layout, the left nav, the Advanced disclosure, the field controls | plan 219 (this plan only keeps the existing page compiling and regenerates its section list from the new schema) |
| The Agents page and its Settings tab, which renders `AgentSettingsSchema` | plan 220 (this plan defines the schema and the route) |
| The Plugins page, which hosts the Key/Value browser | plan 219 (this plan only removes the browser from the farm Settings page) |
| The nightly retention sweeper, the Storage usage row, and first-run packaging | plan 224 (this plan ships the settings the sweeper reads) |
| Deleting `coControl`, `mirror`, `job.quietPeriodSec`, `job.maxWaitSec`; adding the `control` block | plan 205 (already landed; this plan folds `control.overControl` into `privacy` and turns `control.idleSec` into a constant) |
| Rewriting the `session` block to `buildsPerUsbRoot` | plan 206 (already landed; this plan moves that one field under `advanced`) |
| Deleting `shell.fanout*`, `shell.commandRunsPerUser`, `shell.savedCommandLimit`, `retention.commandRunDays` | plan 207 (already landed; this plan must not re-add them) |
| The measured wall tile ceiling and the 100-device scale number | plan 223 (this plan freezes today's placeholder as a constant and says so) |
| Archiving `docs/settings-audit.md` | plan 202 |

## 3. Context and design decisions

### 3.1 What is there today, verified on 2026-09-03

- `packages/protocol/src/settings.ts` is **2 694 lines**. `rg -c 'ui\(\{ title:' packages/protocol/src/settings.ts` prints **115** - that is the number MVP 12 §6 calls "titled fields in the farm schema". A further 104 nodes carry a bare `.meta({ title: … })` (section objects, array-item leaves, and per-device leaves), so `grep -c "title:"` prints 219; only the `ui({ title:` form is counted anywhere in this plan.
- `FarmSettingsSchema` starts at `:1019` (`export const FarmSettingsSchema = z.object({`) and ends at `:2668` (`})`). Its top-level keys, with the line each begins on: `defaults` `:1044`, `labelling` `:1058`, `battery` `:1071`, `retention` `:1082`, `adb` `:1202`, `discovery` `:1286`, `guestAgent` `:1514`, `monitor` `:1569`, `health` `:1588`, `adbControl` `:1635`, `shell` `:1686`, `coControl` `:1860`, `mirror` `:1909`, `job` `:1945`, `workflow` `:1977`, `session` `:2004`, `display` `:2061`, `video` `:2106`, `wall` `:2233`, `readiness` `:2308`, `transfer` `:2366`, `network` `:2426`, `workspace` `:2470`, `kv` `:2517`, `agentDefaults` `:2567`, `scheduledAgents` `:2581`, `recording` `:2615`.
- `defaults` is `DeviceSettingsSchema.omit({ identity: true })` (`:1016` `const FarmDeviceDefaultsSchema = DeviceSettingsSchema.omit({ identity: true })`). Every per-device field therefore exists twice, which is the mechanism behind `docs/settings-audit.md` finding #2: `daemon.ts:4186` `timing: () => settingsStore.get().defaults.timing` is the only reader of timing anywhere, so a per-device `timing` edit is silently ignored.
- `packages/core/src/api/settings.ts` is 44 lines: `GET /` at `:17-25` returns `{ settings, schema: z.toJSONSchema(FarmSettingsSchema), deviceSchema: z.toJSONSchema(DeviceSettingsSchema) }`; `PATCH /` at `:30-33` is gated by `requirePermission('settings.manage')`; `GET /device-schema` at `:36` is deleted by plan 201 and must not be reintroduced.
- `packages/core/src/settings/farm-settings.ts` is the store. `:26-28` reads the single row and falls back to `defaultFarmSettings()` when the parse fails - **silently**, which is what §4.8's migration replaces. `:40` applies the server-mode override `shell: { mode: 'off', fanoutEnabled: false }` on a brand-new row; plan 207 has already removed `fanoutEnabled`. `:47-68` is a one-level-deep merge plus `FarmSettingsSchema.safeParse`.
- `packages/core/src/db/schema.ts:1173-1177` is the storage: `farmSettings` with `id` (always 1), `value` (`text(..., { mode: 'json' })`), `updatedAt` (integer unix seconds, `mode: 'timestamp'`). **No Drizzle migration is needed by this plan** - the column shape does not change; only the JSON inside it does, and §4.8's transform runs on read.
- `packages/studio/src/components/settings/farmSections.ts:51-162` is a hand-maintained list of 22 sections in four groups (`Devices`, `Jobs`, `AI Agents`, `Farm`). `packages/studio/src/components/settings/deviceSections.ts:45-69` already derives its sections from the schema's own `x-enkaku.group` hint; this plan makes the farm list work the same way.
- Almost every reader of a farm setting is an accessor lambda wired in `packages/core/src/daemon.ts`. `rg -o "settingsStore\.get\(\)\.[a-zA-Z]+" packages/core/src -g '!*.test.ts'` returns 108 matches, 104 of them in `daemon.ts`. That is why promoting a field to a constant is, at the call site, a one-line edit in `daemon.ts`; §5 lists every one by line and content.

### 3.2 The rule this plan applies

`docs/mvp/12-settings.md` §0: a setting is visible only if the right value differs between farms **and** a non-engineer can predict what changing it does. Everything else is advanced (differs between farms, engineer only), constant (does not differ), removed (its feature is gone), or moved (it belongs to a device, a plugin, or the Agents page). Section 3.5 below records the five places where this plan deviates from MVP 12's own proposed numbers, with the reason.

### 3.3 Design decisions

1. **One top-level key per section.** `FarmSettingsSchema` gets exactly nine top-level keys, each an object carrying `ui({ title, group })`, and each is exactly one section of the Settings page. That is what lets `farmSections.ts` stop being a hand-maintained parallel list (`farmSections.ts:19-50` argues for keeping it hand-maintained on the grounds that half its entries are bespoke screens; after this plan only one is, so the argument no longer holds).
2. **The 26 rule.** Every one of the fifteen visible settings and every one of the eleven advanced settings carries exactly one `ui({ title: … })`. Every other titled node - the nine section objects, the leaves of a compound setting, the leaves of the network array item - carries a bare `.meta({ title: … })`. G1's count is that rule, mechanised.
3. **`defaults` is deleted, not reduced.** A farm-wide copy of the whole per-device schema is what made `timing.*` shadowed and what made `defaults.identity` actively harmful (`docs/settings-audit.md` #1, #2). After this plan a per-device field either has no farm analogue at all (engines, identity, prep) or is an `.optional()` override of one of the fifteen visible farm fields, where absent means "use the farm default". There is no third case, so there is nothing left to shadow.
4. **Constants live in one core file and are never imported across packages.** `packages/core/src/config/constants.ts` is the only file that reads an `ENKAKU_*` support override. `packages/session`, `packages/adb` and `packages/drivers` receive the values the way they receive settings today: through the accessor deps `daemon.ts` wires. This is not a new mechanism, it is the existing one with the store replaced by a literal.
5. **Retention is visible (MVP 12 §7 point 1, proposed and accepted).** Disk is the first thing a client runs out of, and MVP 09 §6 fixes the defaults. The audit window is the one exception - see §9 Q1.
6. **"Reset the app before each job" stays a visible farm default (MVP 12 §7 point 2, proposed and accepted).** A script may still declare its own; the farm field is the fallback. Nothing in this plan implements the per-script declaration - that is plan 210's manifest, already landed.
7. **The wall's four tile numbers become constants, not advanced fields.** MVP 12 §3 says they "become measured automatic values (MVP 09 §7) rather than fields". Until plan 223 measures them they keep today's values as constants with an override, and `WALL_DECODE_TILE_CEILING`'s comment says in one line that 24 is still the unmeasured placeholder plan 100 §7.3 recorded.
8. **Physical labelling splits into content and surface.** Today `defaults.labelling.mode` is `off | lock-screen | wallpaper` (the *surface*) and `defaults.labelling.showName` is the *content*. MVP 12 §1's visible field is content only: "off, number, number and name". The surface becomes the constant `DEVICE_LABEL_SURFACE` (`ENKAKU_DEVICE_LABEL_SURFACE`, `lock-screen | wallpaper`, default `lock-screen`), and the migration in §4.8 maps a stored `wallpaper` onto the env var's documented value with one log line.
9. **Every setting the handoff draws that MVP 12 classifies as a constant is not built** (`docs/mvp/15-ui-migration.md` §1, row "Settings content": "Fields MVP 12 classified as constants are dropped from the pane"). That is why three of the handoff's sections have no fields left and are not built: **ADB transport** (adb binary, preferred transport, keep-awake, restart-on-stall - all constants or per-device), **Appearance** (theme lives in the icon rail per the handoff's own Global shell section; table density and monospace numbers are not settings this product has), and **Groups** (managed from the Devices tab strip, `docs/mvp/15-ui-migration.md` §0.1.3 - no schema field exists). The handoff's **Scripts** section is dropped by MVP 15 §1 outright.

### 3.4 The ten sections

Nine schema-backed, one bespoke. Group headings follow the handoff (`README.md:423-425`).

| # | Group heading | Section title | Schema key | Fields |
|---|---|---|---|---|
| 1 | (none, first) | General | `general` | Farm name; Physical label on the screen |
| 2 | Connection | Host & daemon | `hostDaemon` | Egress probe endpoint |
| 3 | Connection | Network scan | `networkScan` | Networks to scan for wireless devices |
| 4 | Automation | Job runner | `jobRunner` | Default job timeout; Reset the app before each job; Human-like touch profile |
| 5 | Automation | Capture & replay | `capture` | Control quality; Wall quality |
| 6 | Storage | Retention | `storage` | Keep job history and logs for; Keep trace frames for; Keep artifacts |
| 7 | Farm | Devices | `devices` | Pause jobs above N °C |
| 8 | Farm | Privacy | `privacy` | Control over control; Adb command action for operators |
| 9 | Farm | Access | - (bespoke) | Users and API tokens (a table, not a field) |
| 10 | Farm | Advanced | `advanced` | the eleven of MVP 12 §2 |

### 3.5 Deviations from MVP 12's own numbers, and why

MVP 12 §2's defaults are described in that document as "the CTO's proposal". Where a proposed number would delete a working behaviour, this plan keeps the behaviour and records the deviation here rather than silently taking either side.

| MVP 12 §2 says | This plan ships | Why |
|---|---|---|
| Max concurrent adb commands: 8 | `advanced.adbMaxConcurrent` default **0**, range 0–24, `0 = scale automatically with device count` | 0 is not "unset", it is a live feature (`daemon.ts:3059` `auto: () => settingsStore.get().adb.maxConcurrent === 0`, `packages/core/src/device/adb-scaling.ts`). Pinning 8 would turn auto-scaling off for every farm on upgrade. The hint tells an engineer to raise it off auto. |
| Max concurrent installs: "1 per USB root" | `advanced.installsPerUsbRoot` default **1** | The current field (`adb.maxInstallConcurrent`, default 2) is farm-wide, not per USB root. Changing the unit is a real semantic change with a real consumer (`daemon.ts:2387`, `:2389`) - see §9 Q2. |
| Infrastructure retries and backoff base: 3, 1 s | `advanced.infraRetry` = `{ attempts: 3, backoffBaseMs: 1000 }` | Adopted; old values were 2 and 2 000 ms. Listed in §4.10 as a changed default. |
| Job memory limit: 256 MB | `advanced.jobMemoryLimitBytes` default **268 435 456** | Adopted; the old default was `null` (no limit). This turns a limit on for every farm - listed in §4.10 and called out in §8. |
| Wall bandwidth budget on WAN: 20 Mbit | `advanced.wallWanBandwidthBps` default **20 000 000** | Adopted. It replaces the hard-coded `WALL_VIDEO_BUDGET_BPS` (`packages/session/src/video-profile.ts:138`), which plan 100 pinned deliberately; making it the advanced field is exactly what MVP 12 §2 asks for. The loopback/LAN budget becomes the constant `WALL_LAN_BANDWIDTH_BPS`. |

## 4. Technical design

### 4.1 The complete field disposition

Every leaf of `DeviceSettingsSchema` and `FarmSettingsSchema` as they stand on 2026-09-03, after plans 205, 206 and 207. **No field is unlisted.** "Disposition" is one of `visible`, `advanced`, `constant`, `removed`, `moved`, `kept` (a per-device field with no farm analogue, which survives unchanged). For a `constant`, the "Lands as" column names the exported constant in `packages/core/src/config/constants.ts` and its `ENKAKU_*` override.

#### 4.1.1 `DeviceSettingsSchema` (`:365-645`)

| # | Path | Current default | Current title | Disposition | Lands as |
|---|---|---|---|---|---|
| D1 | `engines.transport` | `'adb-usb'` | Transport | kept | `DeviceSettingsSchema.engines.transport`, unchanged |
| D2 | `engines.display` | `'scrcpy'` | Screen capture | kept | unchanged |
| D3 | `engines.input` | `'scrcpy-uhid'` | Input delivery | kept | unchanged |
| D4 | `engines.inspection` | `'ui-server'` | Screen inspection | kept | unchanged |
| D5 | `engines` (object) | - | Engines | kept | unchanged; keeps `ui({ title, group: 'Engines' })` as a bare `.meta({ title })` (the 26 rule) |
| D6 | `input.preferredMode` | `'uhid'` | Injection mode | removed | duplicates `engines.input`; its one reader `packages/core/src/session/adapters.ts:42-44` derives `preferredInputMode` from `engines.input` instead (`scrcpy-uhid`→`uhid`, `scrcpy-sdk`→`sdk`, `adb-input`→`sdk`) |
| D7 | `input` (object) | - | Input injection | removed | with D6 |
| D8 | `timing.tapJitterMs` | `[40, 120]` | Tap duration | constant | `TOUCH_PROFILES.natural.tapHoldMs`; `ENKAKU_TOUCH_PROFILES` |
| D9 | `timing.betweenActionMs` | `[300, 900]` | Pause between actions | constant | `TOUCH_PROFILES.natural.betweenActionMs`; same override |
| D10 | `timing.coordJitterPx` | `2` | Tap point jitter | constant | `TOUCH_PROFILES.natural.coordJitterPx`; same override |
| D11 | `timing.profile` | `'natural'` | Input profile | removed | replaced by the visible `jobRunner.touchProfile` (`precise \| natural \| slow`); the old two-value enum is not a subset of the new three-value one, so it is mapped, not kept (§4.8 case 4) |
| D12 | `timing.gestureCurvature` | `0.08` | Gesture curvature | constant | `TOUCH_PROFILES.natural.gestureCurvature`; same override |
| D13 | `timing.gestureSampleIntervalMs` | `8` | Gesture sample interval (ms) | constant | `TOUCH_PROFILES.<all>.gestureSampleIntervalMs`; same override |
| D14 | `timing.perCharMs` | `[40, 140]` | Typing cadence (ms) | constant | `TOUCH_PROFILES.natural.perCharMs`; same override |
| D15 | `timing` (object) | - | Human-like touch | removed | `TimingSettingsSchema` moves to `packages/protocol/src/timing.ts` as the resolved shape `deps.timing` returns; it is no longer part of any settings schema and carries no `ui()` |
| D16 | `prep.disableAnimations` | `true` | Disable animations | removed | **DEAD** (`docs/settings-audit.md` #4): no applier exists. Deleted, not corrected |
| D17 | `prep.keepAwake` | `'always'` | Keep the screen awake | kept | unchanged |
| D18 | `prep.screenOffTimeoutMs` | `1_800_000` | Screen timeout on the device | constant | `DEVICE_SCREEN_OFF_TIMEOUT_MS`; `ENKAKU_DEVICE_SCREEN_OFF_TIMEOUT_MS` |
| D19 | `prep.standbyScreenOff` | `false` | Turn the device screen off while streaming | kept | unchanged |
| D20 | `prep.rotation` | `'device'` | Screen rotation | kept | unchanged |
| D21 | `prep.textInput` | `'auto'` | Text input | kept | unchanged |
| D22 | `prep` (object) | - | Before a job runs | kept | keeps `normaliseLegacyPrep` (`:129-135`) and its `.default({...})`, minus D16 and D18 |
| D23 | `autoReconnect` | `true` | Auto-reconnect | kept | unchanged |
| D24 | `logInputText` | `false` | Log typed text in the clear | kept | unchanged |
| D25 | `identity.timezone` | absent | Timezone | kept | unchanged (per-device only, plan 58) |
| D26 | `identity.locale` | absent | Locale | kept | unchanged |
| D27 | `identity.gps.lat` | - | Latitude | kept | unchanged |
| D28 | `identity.gps.lng` | - | Longitude | kept | unchanged |
| D29 | `identity.gps.accuracy` | `100` | Accuracy (m) | kept | unchanged |
| D30 | `identity.gps` (object) | absent | GPS location | kept | unchanged |
| D31 | `identity` (object) | - | Identity | kept | unchanged |
| D32 | `video.controlPreset` | absent | Device page picture (not yet applied) | removed | **DEAD** (`docs/settings-audit.md` #5): nothing reads it. Replaced by `overrides.controlQuality`, which is read |
| D33 | `video.controlMaxSize` | absent | Device page size (px) | removed | the preset replaces the three numbers (MVP 12 §5, "reduced to the same visible set as the farm") |
| D34 | `video.controlMaxFps` | absent | Device page frame rate | removed | with D33 |
| D35 | `video.controlBitRate` | absent | Device page bitrate | removed | with D33 |
| D36 | `video.wallPreset` | absent | Wall tile picture (not yet applied) | removed | **DEAD**, as D32; replaced by `overrides.wallQuality` |
| D37 | `video.wallMaxSize` | absent | Wall tile size (px) | removed | with D33 |
| D38 | `video.wallMaxFps` | absent | Wall tile frame rate | removed | with D33 |
| D39 | `video.wallBitRate` | absent | Wall tile bitrate | removed | with D33 |
| D40 | `video` (object) | `{}` | Video | removed | replaced by `overrides.controlQuality` / `overrides.wallQuality` |
| D41 | `instrumentation.tagTraffic` | `true` | Mark device as under automation | kept | unchanged |
| D42 | `instrumentation` (object) | - | Device instrumentation | kept | unchanged |
| D43 | `labelling.mode` | `'off'` | Label the phone's screen | constant + visible | the *surface* becomes `DEVICE_LABEL_SURFACE` (`ENKAKU_DEVICE_LABEL_SURFACE`); the *content* becomes the visible farm field `general.deviceLabel` with the per-device override `overrides.deviceLabel` (§3.3 decision 8) |
| D44 | `labelling.showName` | `true` | Include the name | removed | folded into the three-value `deviceLabel` enum |
| D45 | `labelling` (object) | - | Physical labelling | removed | with D43, D44 |

#### 4.1.2 `FarmSettingsSchema` - blocks `defaults` through `shell` (`:1044-1858`)

| # | Path | Current default | Current title | Disposition | Lands as |
|---|---|---|---|---|---|
| F1 | `defaults.*` (all 44 leaves, = D1–D45 minus `identity`) | - | Defaults for new devices | removed | the whole block goes; §3.3 decision 3. `defaultsForNewDevice` (`packages/core/src/registry/admission.ts`, `device-registry.ts`) writes `defaultDeviceSettings()` instead |
| F2 | `labelling.maxConcurrent` | `2` | Max concurrent label writes | constant | `LABEL_WRITE_CONCURRENCY`; `ENKAKU_LABEL_WRITE_CONCURRENCY` |
| F3 | `battery.pollIntervalSec` | `60` | Polling interval | constant | `BATTERY_POLL_INTERVAL_SEC`; `ENKAKU_BATTERY_POLL_INTERVAL_SEC` |
| F4 | `battery.autoQuarantine` | `true` | Auto-quarantine when hot | constant | `DEVICE_AUTO_QUARANTINE`; `ENKAKU_DEVICE_AUTO_QUARANTINE` (shared with F13) |
| F5 | `battery.tempThresholdC` | `45` | Temperature threshold | **visible** | `devices.tempThresholdC` |
| F6 | `retention.enabled` | `false` | Clean up automatically | removed | retention is always on (MVP 09 §6: "a nightly sweeper", not an opt-in). Behaviour change, listed in §4.10 |
| F7 | `retention.maxAgeDays` | `30` | Maximum age (days) | **visible** | `storage.artifacts.maxAgeDays` |
| F8 | `retention.maxTotalGb` | `20` | Maximum size (GB) | **visible** | `storage.artifacts.maxTotalGb` |
| F9 | `retention.eventMainDays` | `30` | Main log retention (days) | **visible** | `storage.historyDays` |
| F10 | `retention.eventInputDays` | `3` | Input log retention (days) | constant | `INPUT_EVENT_RETENTION_DAYS`; `ENKAKU_INPUT_EVENT_RETENTION_DAYS` |
| F11 | `retention.eventMaxRowsPerDevice` | `50_000` | Max rows per device per stream | constant | `EVENT_MAX_ROWS_PER_DEVICE`; `ENKAKU_EVENT_MAX_ROWS_PER_DEVICE` |
| F12 | `retention.blobOrphanGraceHours` | `24` | Unreferenced screenshot grace period (hours) | constant | `BLOB_ORPHAN_GRACE_HOURS`; `ENKAKU_BLOB_ORPHAN_GRACE_HOURS` |
| F13 | `retention.traceDays` | `30` | Job trace retention (days) | **visible** | `storage.traceDays`, **default 7** (MVP 09 §6); §4.10 |
| - | `retention.commandRunDays` | - | - | already gone | deleted by plan 207 |
| F14 | `adb.maxConcurrent` | `0` | Max concurrent adb commands | **advanced** | `advanced.adbMaxConcurrent` |
| F15 | `adb.maxStreamsPerDevice` | `4` | Max streams per device | constant | `ADB_MAX_STREAMS_PER_DEVICE`; `ENKAKU_ADB_MAX_STREAMS_PER_DEVICE` |
| F16 | `adb.maxStreams` | `0` | Max concurrent streams (farm-wide) | constant | `ADB_MAX_STREAMS_FARM`; `ENKAKU_ADB_MAX_STREAMS_FARM`. `normaliseLegacyAdb` (`:144-149`) is deleted with the field |
| F17 | `adb.maxHostConcurrent` | `4` | Max adb CLI processes | constant | `ADB_MAX_HOST_PROCESSES`; `ENKAKU_ADB_MAX_HOST_PROCESSES` |
| F18 | `adb.maxInstallConcurrent` | `2` | Max concurrent installs | **advanced** | `advanced.installsPerUsbRoot`, default 1, per USB root (§3.5, §9 Q2) |
| F19 | `discovery.scanIntervalSec` | `10` | Device rescan interval (s) | constant | `DEVICE_RESCAN_INTERVAL_SEC`; `ENKAKU_DEVICE_RESCAN_INTERVAL_SEC` |
| F20 | `discovery.offlineGraceSec` | `20` | Offline grace (s) | constant | `DEVICE_OFFLINE_GRACE_SEC`; `ENKAKU_DEVICE_OFFLINE_GRACE_SEC` |
| F21 | `discovery.recoveryCooldownSec` | `120` | Recovery cooldown (s) | constant | `DEVICE_RECOVERY_COOLDOWN_SEC`; `ENKAKU_DEVICE_RECOVERY_COOLDOWN_SEC` |
| F22 | `discovery.tcpPort` | `5555` | adb TCP port | constant | `ADB_TCP_PORT`; `ENKAKU_ADB_TCP_PORT` |
| F23 | `discovery.endpointsPerDevice` | `4` | Remembered addresses per device | constant | `DEVICE_ENDPOINTS_REMEMBERED`; `ENKAKU_DEVICE_ENDPOINTS_REMEMBERED` |
| F24 | `discovery.endpointRetireAfter` | `10` | Retire an address after | constant | `DEVICE_ENDPOINT_RETIRE_AFTER`; `ENKAKU_DEVICE_ENDPOINT_RETIRE_AFTER` |
| F25 | `discovery.connectSettleMs` | `3_000` | Connect settle time (ms) | constant | `DEVICE_CONNECT_SETTLE_MS`; `ENKAKU_DEVICE_CONNECT_SETTLE_MS` |
| F26 | `discovery.networks[]` | `[]` | Farm networks | **visible** | `networkScan.networks`; the item leaves `cidr`, `label`, `medium`, `scan`, `port` keep their bare `.meta({ title })` |
| F27 | `discovery.scan.mode` | `'on-demand'` | Network scanning | constant | `SCAN_MODE`; `ENKAKU_SCAN_MODE` |
| F28 | `discovery.scan.maxAddresses` | `1024` | Max addresses per scan | constant | `SCAN_MAX_ADDRESSES`; `ENKAKU_SCAN_MAX_ADDRESSES`. The `superRefine` at `:1469-1483` moves with `networks` and compares against this constant |
| F29 | `discovery.scan.concurrency` | `32` | Simultaneous probes | constant | `SCAN_CONCURRENCY`; `ENKAKU_SCAN_CONCURRENCY` |
| F30 | `discovery.scan.probeTimeoutMs` | `300` | Probe timeout (ms) | constant | `SCAN_PROBE_TIMEOUT_MS`; `ENKAKU_SCAN_PROBE_TIMEOUT_MS` |
| F31 | `discovery.cutover.armWindowSec` | `180` | Cutover window (s) | constant | `CUTOVER_WINDOW_SEC`; `ENKAKU_CUTOVER_WINDOW_SEC` |
| F32 | `discovery.cutover.armPollSec` | `5` | Cutover poll interval (s) | constant | `CUTOVER_POLL_SEC`; `ENKAKU_CUTOVER_POLL_SEC` |
| F33 | `guestAgent.provision` | `'auto'` | Provision the guest agent | constant | `GUEST_AGENT_PROVISION`; `ENKAKU_GUEST_AGENT_PROVISION` (MVP 10 §3: always on) |
| F34 | `guestAgent.maxRecoveryCyclesPerHour` | `4` | Recovery resets per hour | **advanced** | `advanced.recoveryResetsPerHour`, default 6; §4.10 |
| F35 | `guestAgent.recoveryRearmSec` | `120` | Recovery re-arm (s) | constant | `GUEST_AGENT_RECOVERY_REARM_SEC`; `ENKAKU_GUEST_AGENT_RECOVERY_REARM_SEC` |
| F36 | `monitor.crashWatch` | `'always'` | Always-on crash detection | constant | `CRASH_WATCH`; `ENKAKU_CRASH_WATCH` |
| F37 | `health.consecutiveFailures` | `3` | Failures before quarantine | **advanced** | `advanced.failuresBeforeQuarantine`, default 5; §4.10 |
| F38 | `health.autoQuarantine` | `true` | Auto-quarantine unreachable devices | constant | `DEVICE_AUTO_QUARANTINE` (shared with F4) |
| F39 | `health.probeIntervalSec` | `60` | Recovery probe interval (s) | constant | `DEVICE_RECOVERY_PROBE_INTERVAL_SEC`; `ENKAKU_DEVICE_RECOVERY_PROBE_INTERVAL_SEC` |
| F40 | `adbControl.healthIntervalSec` | `15` | adb health probe interval (s) | **advanced** | `advanced.adbHealthIntervalSec`, default 30; §4.10 |
| F41 | `adbControl.stuckTimeoutRate` | `0.5` | Timeout-storm threshold | constant | `ADB_TIMEOUT_STORM_RATE`; `ENKAKU_ADB_TIMEOUT_STORM_RATE` |
| F42 | `adbControl.restartCooldownSec` | `60` | adb restart cooldown | constant | `ADB_RESTART_COOLDOWN_SEC`; `ENKAKU_ADB_RESTART_COOLDOWN_SEC` |
| F43 | `adbControl.drainTimeoutMs` | `30_000` | adb drain timeout (ms) | constant | `ADB_DRAIN_TIMEOUT_MS`; `ENKAKU_ADB_DRAIN_TIMEOUT_MS` |
| F44 | `shell.mode` | `'admin'` | Device terminal access | **visible** | `privacy.adbCommand`, a boolean (MVP 12 §1: "one switch; the console and terminal are gone"). §4.8 case 5 maps `off`→`false`, `admin`/`operator`→`true`; the role check stays `canUseShell` |
| F45 | `shell.execTimeoutMs` | `15_000` | Terminal command timeout (ms) | constant | `SHELL_EXEC_TIMEOUT_MS`; `ENKAKU_SHELL_EXEC_TIMEOUT_MS` |
| F46 | `shell.maxOutputBytes` | `262_144` | Max output per command (bytes) | constant | `SHELL_MAX_OUTPUT_BYTES`; `ENKAKU_SHELL_MAX_OUTPUT_BYTES` |
| F47 | `shell.endpointEnabled` | `false` | Allow adb endpoint | constant | `ADB_ENDPOINT_ENABLED`; `ENKAKU_ADB_ENDPOINT_ENABLED` |
| F48 | `shell.endpointBind` | `'127.0.0.1'` | adb endpoint bind address | constant | `ADB_ENDPOINT_BIND`; `ENKAKU_ADB_ENDPOINT_BIND` |
| F49 | `shell.endpointIdleSec` | `300` | adb endpoint idle timeout (s) | constant | `ADB_ENDPOINT_IDLE_SEC`; `ENKAKU_ADB_ENDPOINT_IDLE_SEC` |
| F50 | `shell.maxEndpointStreams` | `8` | Max endpoint streams | constant | `ADB_ENDPOINT_MAX_STREAMS`; `ENKAKU_ADB_ENDPOINT_MAX_STREAMS` |
| - | `shell.fanout*` (7), `shell.commandRunsPerUser`, `shell.savedCommandLimit` | - | - | already gone | deleted by plan 207 |
| - | `coControl.*` (5), `mirror.*` (4) | - | - | already gone | deleted by plan 205. Its `queueWaitMs`/`maxQueueDepth` values live on as `INPUT_WAIT_BUDGET_MS` (5 000) and `INPUT_MAX_QUEUE_DEPTH` (32) - §5 step 212.4 |
| F51 | `control.overControl` (added by 205) | `'allow'` | Control over control | **visible** | `privacy.overControl` |
| F52 | `control.idleSec` (added by 205) | `30` | Control idle seconds | constant | `CONTROL_IDLE_SEC`; `ENKAKU_CONTROL_IDLE_SEC` (plan 205 already exports `DEFAULT_CONTROL_IDLE_SEC = 30` from `packages/core/src/activity/registry.ts`; that literal moves into `constants.ts` and the registry imports it) |

#### 4.1.3 `FarmSettingsSchema` - blocks `job` through `recording` (`:1945-2667`)

| # | Path | Current default | Current title | Disposition | Lands as |
|---|---|---|---|---|---|
| F53 | `job.resetPolicy` | `'home'` | Reset before each job | **visible** | `jobRunner.resetPolicy`, enum `never \| always \| on-failure` (MVP 12 §1). §4.8 case 6 maps `none`→`never`, `home`/`declared`/`aggressive`→`always` |
| F54 | `job.resetTimeoutMs` | `15_000` | Reset timeout (ms) | constant | `JOB_RESET_TIMEOUT_MS`; `ENKAKU_JOB_RESET_TIMEOUT_MS` |
| F55 | `job.resetStrict` | `false` | Fail on reset error | constant | `JOB_RESET_STRICT`; `ENKAKU_JOB_RESET_STRICT` (MVP 12 §3: "fail-on-reset-error folds into the visible reset policy" - `on-failure` is the only policy that retries, so the strict flag has no visible meaning left) |
| F56 | `job.retry.maxInfraAttempts` | `2` | Infrastructure retries | **advanced** | `advanced.infraRetry.attempts`, default 3; §4.10 |
| F57 | `job.retry.backoffBaseMs` | `2_000` | Retry backoff base (ms) | **advanced** | `advanced.infraRetry.backoffBaseMs`, default 1 000; §4.10 |
| F58 | `job.retry.backoffMaxMs` | `30_000` | Retry backoff cap (ms) | constant | `JOB_RETRY_BACKOFF_MAX_MS`; `ENKAKU_JOB_RETRY_BACKOFF_MAX_MS` |
| F59 | `job.retry.timeoutIsInfra` | `false` | Timeouts count as infrastructure | constant | `JOB_TIMEOUT_IS_INFRA`; `ENKAKU_JOB_TIMEOUT_IS_INFRA` |
| F60 | `job.retry.rebindOnInfra` | `true` | Move batch members after infrastructure failures | constant | `JOB_REBIND_ON_INFRA`; `ENKAKU_JOB_REBIND_ON_INFRA` |
| F61 | `job.crashPolicy` | `'declared'` | Fail jobs on app crash | constant | `JOB_CRASH_POLICY`; `ENKAKU_JOB_CRASH_POLICY` |
| - | `job.quietPeriodSec`, `job.maxWaitSec` | - | - | already gone | deleted by plan 205 |
| F62 | `job.defaultTimeoutMs` | `3_600_000` | Default job timeout (ms) | **visible** | `jobRunner.defaultTimeoutMs` |
| F63 | `job.startupTimeoutMs` | `60_000` | Job startup timeout (ms) | constant | `JOB_STARTUP_TIMEOUT_MS`; `ENKAKU_JOB_STARTUP_TIMEOUT_MS` |
| F64 | `job.maxTimeoutMs` | `null` | Maximum job timeout (ms) | constant | `JOB_MAX_TIMEOUT_MS`; `ENKAKU_JOB_MAX_TIMEOUT_MS` (empty string means `null` = no ceiling) |
| F65 | `job.memory.defaultMaxRssBytes` | `null` | Default job memory limit | **advanced** | `advanced.jobMemoryLimitBytes`, default 268 435 456; §4.10 |
| F66 | `job.memory.maxRssBytes` | `null` | Maximum job memory limit | constant | `JOB_MEMORY_MAX_BYTES`; `ENKAKU_JOB_MEMORY_MAX_BYTES` |
| F67 | `job.memory.enforce` | `'kill'` | On a memory breach | constant | `JOB_MEMORY_ENFORCE`; `ENKAKU_JOB_MEMORY_ENFORCE` |
| F68 | `job.memory.sampleIntervalMs` | `2_000` | Memory sample interval (ms) | constant | `JOB_MEMORY_SAMPLE_INTERVAL_MS`; `ENKAKU_JOB_MEMORY_SAMPLE_INTERVAL_MS` |
| F69 | `job.trigger.maxDepth` | `5` | Maximum trigger depth | constant | `JOB_TRIGGER_MAX_DEPTH`; `ENKAKU_JOB_TRIGGER_MAX_DEPTH` |
| F70 | `job.trigger.maxPerChain` | `200` | Maximum jobs per chain | constant | `JOB_TRIGGER_MAX_PER_CHAIN`; `ENKAKU_JOB_TRIGGER_MAX_PER_CHAIN` |
| F71 | `job.trigger.maxPerJob` | `10` | Maximum jobs triggered by one job | constant | `JOB_TRIGGER_MAX_PER_JOB`; `ENKAKU_JOB_TRIGGER_MAX_PER_JOB` |
| F72 | `job.maxResultBytes` | `65_536` | Max result size | constant | `JOB_MAX_RESULT_BYTES`; `ENKAKU_JOB_MAX_RESULT_BYTES` |
| F73 | `job.progressIntervalMs` | `1_000` | Progress interval | constant | `JOB_PROGRESS_INTERVAL_MS`; `ENKAKU_JOB_PROGRESS_INTERVAL_MS` |
| F74 | `workflow.maxTotalMs` | `21_600_000` | Max workflow duration (ms) | constant | `WORKFLOW_MAX_TOTAL_MS`; `ENKAKU_WORKFLOW_MAX_TOTAL_MS` |
| F75 | `session.buildsPerUsbRoot` (after 206) | `4` | Session builds per USB root | **advanced** | `advanced.sessionBuildsPerUsbRoot` |
| - | `session.idleTtlSec`, `session.maxIdleSessions`, `session.maxConcurrentBuilds` | - | - | already gone | deleted by plan 206 |
| F76 | `display.fallbackRetryCount` | `6` | Fallback retry attempts | constant | `DISPLAY_FALLBACK_RETRIES`; `ENKAKU_DISPLAY_FALLBACK_RETRIES` |
| F77 | `video.controlPreset` | `'sharp'` | Device page picture | **visible** | `capture.controlQuality`, enum `sharp \| balanced \| light` |
| F78 | `video.controlMaxSize` | `1600` | Device page size (px) | constant | inside `CONTROL_PRESETS` (`packages/session/src/video-profile.ts:13-17`), which is unchanged |
| F79 | `video.controlMaxFps` | `30` | Device page frame rate | constant | as F78 |
| F80 | `video.controlBitRate` | `4_000_000` | Device page bitrate | constant | as F78 |
| F81 | `video.wallPreset` | `'balanced'` | Wall tile picture | **visible** | `capture.wallQuality`, enum `minimal \| light \| balanced \| detailed` |
| F82 | `video.wallMaxSize` | `480` | Wall tile size (px) | constant | inside `WALL_PRESETS` (`video-profile.ts:48-53`), unchanged |
| F83 | `video.wallMaxFps` | `18` | Wall tile frame rate | constant | as F82 |
| F84 | `video.wallBitRate` | `1_100_000` | Wall tile bitrate | constant | as F82 |
| F85 | `wall.maxTiles` | `0` | Max live wall tiles | constant | `WALL_MAX_TILES`; `ENKAKU_WALL_MAX_TILES`. `normaliseLegacyWall` (`:160-165`) is deleted with the field |
| F86 | `wall.rampConcurrency` | `2` | Wall fill-in concurrency | constant | `WALL_RAMP_CONCURRENCY`; `ENKAKU_WALL_RAMP_CONCURRENCY` |
| F87 | `wall.decodeTileCeiling` | `24` | Max live tiles your browser will decode | constant | `WALL_DECODE_TILE_CEILING`; `ENKAKU_WALL_DECODE_TILE_CEILING`. Its comment says in one line that 24 is still plan 100 §7.3's unmeasured placeholder, to be measured by plan 223 |
| F88 | `wall.bandwidthBps` | `200_000_000` | Wall bandwidth budget (loopback/LAN) | constant | `WALL_LAN_BANDWIDTH_BPS`; `ENKAKU_WALL_LAN_BANDWIDTH_BPS` |
| F89 | `wall.transportOverride` | `'auto'` | Wall transport | constant | `WALL_TRANSPORT_OVERRIDE`; `ENKAKU_WALL_TRANSPORT_OVERRIDE` |
| F90 | (new) WAN wall budget | `20_000_000` (`WALL_VIDEO_BUDGET_BPS`, `video-profile.ts:138`) | - | **advanced** | `advanced.wallWanBandwidthBps`; the hard-coded constant is deleted and the value is passed in |
| F91 | `readiness.maxHot` | `8` | Max hot devices | constant | `READINESS_MAX_HOT`; `ENKAKU_READINESS_MAX_HOT` |
| F92 | `readiness.defaultDesired` | `'awake'` | Default device readiness | constant | `READINESS_DEFAULT_DESIRED`; `ENKAKU_READINESS_DEFAULT_DESIRED` |
| F93 | `transfer.enabled` | `true` | Allow file transfer | constant | `TRANSFER_ENABLED`; `ENKAKU_TRANSFER_ENABLED` |
| F94 | `transfer.maxPushBytes` | `536_870_912` | Max push size (bytes) | **advanced** | `advanced.transferCaps.maxPushBytes` |
| F95 | `transfer.maxPullBytes` | `536_870_912` | Max pull size (bytes) | **advanced** | `advanced.transferCaps.maxPullBytes` |
| F96 | `transfer.installTimeoutMs` | `300_000` | Install timeout (ms) | **advanced** | `advanced.installTimeoutMs`, default 120 000; §4.10 |
| F97 | `transfer.maxArchiveBytes` | `2_147_483_648` | Max bulk download size (bytes) | **advanced** | `advanced.transferCaps.maxArchiveBytes` |
| F98 | `network.geoProvider` | absent | Geo lookup provider URL | constant | `GEO_PROVIDER_URL`; `ENKAKU_GEO_PROVIDER_URL` |
| F99 | `network.geoIntervalSec` | `300` | Geo re-check interval (s) | constant | `GEO_RECHECK_INTERVAL_SEC`; `ENKAKU_GEO_RECHECK_INTERVAL_SEC` |
| F100 | (new) egress probe endpoint | `null` (`ENKAKU_NETWORK_PROBE_URL`, `packages/core/src/network/route-service.ts:153-155`) | - | **visible** | `hostDaemon.egressProbeUrl`; the env var becomes the fallback, not the only source (MVP 12 §1, plan 51 §5.3) |
| F101 | `workspace.maxFileBytes` | `268_435_456` | Max file size (bytes) | constant | `WORKSPACE_MAX_FILE_BYTES`; `ENKAKU_WORKSPACE_MAX_FILE_BYTES` |
| F102 | `workspace.maxFilesPerScope` | `1_000` | Max files per scope | constant | `WORKSPACE_MAX_FILES_PER_SCOPE`; `ENKAKU_WORKSPACE_MAX_FILES_PER_SCOPE` |
| F103 | `workspace.maxTotalBytesPerScope` | `8_589_934_592` | Max total bytes per scope | constant | `WORKSPACE_MAX_BYTES_PER_SCOPE`; `ENKAKU_WORKSPACE_MAX_BYTES_PER_SCOPE` |
| F104 | `workspace.inlineMaxBytes` | `65_536` | Inline storage threshold (bytes) | constant | `WORKSPACE_INLINE_MAX_BYTES`; `ENKAKU_WORKSPACE_INLINE_MAX_BYTES` |
| F105 | `kv.maxValueBytes` | `65_536` | Max value size (bytes) | constant | `KV_MAX_VALUE_BYTES`; `ENKAKU_KV_MAX_VALUE_BYTES` |
| F106 | `kv.maxKeyLength` | `256` | Max key length | constant | `KV_MAX_KEY_LENGTH`; `ENKAKU_KV_MAX_KEY_LENGTH` |
| F107 | `kv.maxEntriesPerNamespace` | `1_000` | Max entries per namespace | constant | `KV_MAX_ENTRIES_PER_NAMESPACE`; `ENKAKU_KV_MAX_ENTRIES_PER_NAMESPACE` |
| F108 | `kv.maxEntriesPerDevice` | `5_000` | Max entries per device | constant | `KV_MAX_ENTRIES_PER_DEVICE`; `ENKAKU_KV_MAX_ENTRIES_PER_DEVICE` |
| F109 | `agentDefaults.*` (12 leaves: `connectorId`, `model`, `systemPrompt`, `effort`, `thinking`, `maxOutputTokens`, `maxSteps`, `maxRunSeconds`, `compactAtRatio`, `maxConcurrentRuns`, `maxImagesPerRequest`, `maxImageBytes`) | see `packages/protocol/src/agent.ts:26-107` | Agent defaults | **moved** | `AgentSettingsSchema.defaults`, served by `/api/agents/settings` (§4.7) |
| F110 | `scheduledAgents.spendCapOutputTokensPer24h` | `null` | Spend cap - scheduled runs only | **moved** | `AgentSettingsSchema.scheduled.spendCapOutputTokensPer24h` |
| F111 | `scheduledAgents.maxConcurrentScheduledRuns` | `3` | Max concurrent scheduled runs | **moved** | `AgentSettingsSchema.scheduled.maxConcurrentScheduledRuns` |
| F112 | `recording.anchorQuietMs` | `400` | Anchor quiet period (ms) | constant | `RECORDING_ANCHOR_QUIET_MS`; `ENKAKU_RECORDING_ANCHOR_QUIET_MS` |
| F113 | `recording.anchorMinIntervalMs` | `1_500` | Anchor minimum interval (ms) | constant | `RECORDING_ANCHOR_MIN_INTERVAL_MS`; `ENKAKU_RECORDING_ANCHOR_MIN_INTERVAL_MS` |
| F114 | `recording.longPressMs` | `400` | Long-press threshold (ms) | constant | `RECORDING_LONG_PRESS_MS`; `ENKAKU_RECORDING_LONG_PRESS_MS` |
| F115 | `recording.maxSteps` | `500` | Max steps per recording | constant | `RECORDING_MAX_STEPS`; `ENKAKU_RECORDING_MAX_STEPS` |
| F116 | `recording.maxDurationSec` | `900` | Max recording duration (s) | constant | `RECORDING_MAX_DURATION_SEC`; `ENKAKU_RECORDING_MAX_DURATION_SEC` |
| F117 | `recording.captureScreenshots` | `true` | Capture step screenshots | constant | `RECORDING_CAPTURE_SCREENSHOTS`; `ENKAKU_RECORDING_CAPTURE_SCREENSHOTS` |
| F118 | (new) audit retention | - | - | constant | `AUDIT_RETENTION_DAYS = 90`; `ENKAKU_AUDIT_RETENTION_DAYS` (MVP 09 §6; see §9 Q1) |

Counts after the table: **15 visible** (F5, F7+F8 as one compound, F9, F13, F26, F44, F51, F53, F62, F77, F81, F100, plus `general.name` and `general.deviceLabel`, both new), **11 advanced** (F14, F18, F34, F37, F40, F56+F57 as one compound, F65, F75, F90, F94+F95+F97 as one compound, F96), **69 constants**, **6 moved** (F109 counted as one block plus its 12 leaves, F110, F111), the rest removed.

### 4.2 `hint` is added to the hint vocabulary

The handoff draws "an 11.5px `var(--faint)` hint below" each field (`README.md:433`). MVP 12 §2 requires each advanced field to carry its own "raise or lower if" sentence. `.describe()` is already taken (it is the field's description), so the sentence needs its own key.

`packages/protocol/src/schema/vocabulary.ts` - three edits, all additive:

1. In `ParamHints` (`:122-167`), after `summary?: boolean` (`:166`):

```ts
  /**
   * One sentence telling a reader when to change this from its default -
   * MVP 12 §2's "raise or lower if". Rendered under the control, beside the
   * default. Meaning, not presentation: it is a fact about the value, the
   * same way `enforcement` is.
   */
  hint?: string
```

2. In `ParamHintsSchema` (`:187-201`), after `summary: z.boolean().optional(),` (`:200`): `hint: z.string().max(200).optional(),`.
3. Nothing else. `ui()`'s overloads (`:250-266`) already spread `Omit<ParamHints, 'kind' | 'unit' | 'extensions'>`, so `ui({ title, kind, hint })` type-checks with no signature change, and `readHints(node).hint` works because `ParamHintsSchema` strips unknown keys and now knows this one.

**Do not** add a second `.meta()` call to carry the hint, and do not put the sentence in `.describe()` - `.describe()` says what the field is, `hint` says when to move it.

### 4.3 The new `FarmSettingsSchema`

`packages/protocol/src/settings.ts` is rewritten. What survives from the old file: `BatteryStateSchema` (`:7-16`, telemetry, not a setting), `KeepAwakeModeSchema` (`:26`), `RotationModeSchema` (`:180`), `TextInputModeSchema` (`:195`), `DeviceGpsSchema` (`:204-214`), `DeviceIdentitySchema` (`:231-250`), `DeviceInstrumentationSchema` (`:268-281`), `VideoNumbersSchema` (`:327-331`), `CidrSchema` (`:984-987`), `addressCount` (`:1001-1007`), `normaliseLegacyPrep` (`:129-135`). Everything else in the file is deleted or replaced.

```ts
import { z } from 'zod'
import { ui } from './schema/vocabulary'

/** MVP 12 §1 - the two video quality profiles, named. `ControlPresetSchema`/`WallPresetSchema` renamed. */
export const ControlQualitySchema = z.enum(['sharp', 'balanced', 'light'])
export type ControlQuality = z.infer<typeof ControlQualitySchema>
export const WallQualitySchema = z.enum(['minimal', 'light', 'balanced', 'detailed'])
export type WallQuality = z.infer<typeof WallQualitySchema>

/** MVP 12 §1 - what a phone shows about itself on a rack. The SURFACE is the constant `DEVICE_LABEL_SURFACE`. */
export const DeviceLabelSchema = z.enum(['off', 'number', 'number-and-name'])
export type DeviceLabel = z.infer<typeof DeviceLabelSchema>

/** MVP 12 §1 - the one timing knob a non-engineer understands. The tuples behind each name are `TOUCH_PROFILES`. */
export const TouchProfileSchema = z.enum(['precise', 'natural', 'slow'])
export type TouchProfile = z.infer<typeof TouchProfileSchema>

/** MVP 12 §1 - "Reset the app before each job". A script may declare its own; this is the farm default. */
export const ResetPolicySchema = z.enum(['never', 'always', 'on-failure'])
export type ResetPolicy = z.infer<typeof ResetPolicySchema>

/** MVP 04 §1.3 rows 7 and 8, carried over from plan 205's `control.overControl`. */
export const OverControlSchema = z.enum(['allow', 'warn', 'forbid'])
export type OverControl = z.infer<typeof OverControlSchema>

const IPV4_OCTET = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d|0)'
const IPV4_CIDR_RE = new RegExp(`^${IPV4_OCTET}\\.${IPV4_OCTET}\\.${IPV4_OCTET}\\.${IPV4_OCTET}/(3[0-2]|[12]?\\d)$`)

export const CidrSchema = z
  .string()
  .regex(IPV4_CIDR_RE, 'must be an IPv4 CIDR block, like 10.20.0.0/24')
  .meta({ title: 'Network (CIDR)' })

export function addressCount(cidr: string): number {
  const match = /\/(\d{1,2})$/.exec(cidr)
  if (!match) return 0
  const prefix = Number(match[1])
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return 0
  return 2 ** (32 - prefix)
}

/** One entry of the farm-network list. Leaves are bare-titled: the array itself is the one titled setting. */
const FarmNetworkSchema = z.object({
  cidr: CidrSchema,
  label: z.string().max(40).default('').meta({ title: 'Label' }),
  medium: z.enum(['wired', 'wireless']).default('wired').meta({ title: 'Medium' }),
  scan: z.boolean().default(true).meta({ title: 'Include in a sweep' }),
  port: z
    .number()
    .int()
    .min(1024)
    .max(65535)
    .optional()
    .describe('Overrides the adb TCP port for this range only. Leave unset to use 5555.')
    .meta({ title: 'Port (optional override)' }),
})

/**
 * Farm-wide settings - a single row, nine top-level keys, one per Settings
 * section (MVP 12 §1 as amended by MVP 15 §1; the group names are the design
 * handoff's, `README.md:423-425`).
 *
 * The 26 rule: each of the fifteen visible settings and each of the eleven
 * advanced settings carries exactly one `ui({ title: ... })`. Section objects,
 * compound leaves, and array-item leaves carry a bare `.meta({ title })`.
 * `rg -c 'ui\(\{ title:' packages/protocol/src/settings.ts` is therefore 26,
 * and that is a goal of the plan that produced this file, not a coincidence.
 */
export const FarmSettingsSchema = z.object({
  general: z
    .object({
      name: z
        .string()
        .min(1)
        .max(60)
        .default('Enkaku farm')
        .describe('Shown on every page and on the guest agent status screen.')
        .meta(ui({ title: 'Farm name' })),
      deviceLabel: DeviceLabelSchema.default('off')
        .describe('What each phone shows about itself on its own screen, for a rack you can see.')
        .meta(ui({ title: 'Physical label on the screen', labels: { off: 'Off', number: 'Number', 'number-and-name': 'Number and name' } })),
    })
    .default({ name: 'Enkaku farm', deviceLabel: 'off' })
    .meta({ title: 'General' }),

  hostDaemon: z
    .object({
      egressProbeUrl: z
        .union([z.string().url(), z.literal('')])
        .default('')
        .describe('Your own probe endpoint (`bun run probe-server`). Without it the egress, DNS and geo checks stay "skip" and a route never reports "ok".')
        .meta(ui({ title: 'Egress probe endpoint' })),
    })
    .default({ egressProbeUrl: '' })
    .meta({ title: 'Host & daemon', 'x-enkaku': { group: 'Connection' } }),

  networkScan: z
    .object({
      networks: z
        .array(FarmNetworkSchema)
        .max(16)
        .default([])
        .describe('The networks your devices live on. Enkaku labels a device found here, and scans the ones you tick.')
        .meta(ui({ title: 'Networks to scan for wireless devices' })),
    })
    .default({ networks: [] })
    .meta({ title: 'Network scan', 'x-enkaku': { group: 'Connection' } }),

  jobRunner: z
    .object({
      defaultTimeoutMs: z
        .number()
        .int()
        .min(30_000)
        .max(86_400_000)
        .default(3_600_000)
        .describe("How long a job may run before it is killed, when its script does not declare its own timeout. A script's own timeout always wins.")
        .meta(ui({ title: 'Default job timeout', kind: 'duration', unit: 'ms' })),
      resetPolicy: ResetPolicySchema.default('always')
        .describe('Whether the app under test is returned to a clean state before a job runs. A script may declare its own; this is the default.')
        .meta(ui({ title: 'Reset the app before each job', labels: { never: 'Never', always: 'Always', 'on-failure': 'On failure' } })),
      touchProfile: TouchProfileSchema.default('natural')
        .describe('How human the taps, swipes and typing look. A script may override it per call.')
        .meta(ui({ title: 'Human-like touch profile', labels: { precise: 'Precise', natural: 'Natural', slow: 'Slow' } })),
    })
    .default({ defaultTimeoutMs: 3_600_000, resetPolicy: 'always', touchProfile: 'natural' })
    .meta({ title: 'Job runner', 'x-enkaku': { group: 'Automation' } }),

  capture: z
    .object({
      controlQuality: ControlQualitySchema.default('sharp')
        .describe('Picture quality while you are driving one device. Sharper costs host CPU and USB bandwidth.')
        .meta(ui({ title: 'Control quality', labels: { sharp: 'Sharp', balanced: 'Balanced', light: 'Light' } })),
      wallQuality: WallQualitySchema.default('balanced')
        .describe('Picture quality for a tile in the Screens view. Lower quality means more tiles live at once.')
        .meta(ui({ title: 'Wall quality', labels: { minimal: 'Minimal', light: 'Light', balanced: 'Balanced', detailed: 'Detailed' } })),
    })
    .default({ controlQuality: 'sharp', wallQuality: 'balanced' })
    .meta({ title: 'Capture & replay', 'x-enkaku': { group: 'Automation' } }),

  storage: z
    .object({
      historyDays: z
        .number()
        .int()
        .min(1)
        .max(3_650)
        .default(30)
        .describe('Jobs, runs and device logs older than this are deleted by the nightly sweep.')
        .meta(ui({ title: 'Keep job history and logs for', kind: 'count' })),
      traceDays: z
        .number()
        .int()
        .min(1)
        .max(3_650)
        .default(7)
        .describe('Job traces older than this are deleted, with their captured frames and UI snapshots. Traces are the largest thing on disk.')
        .meta(ui({ title: 'Keep trace frames for', kind: 'count' })),
      artifacts: z
        .object({
          maxAgeDays: z.number().int().min(1).max(3_650).default(30).describe('Artifacts older than this are deleted.').meta({ title: 'Maximum age (days)' }),
          maxTotalGb: z.number().min(0.1).max(10_000).default(20).describe('Once the total passes this, the oldest are deleted first.').meta({ title: 'Maximum size (GB)' }),
        })
        .default({ maxAgeDays: 30, maxTotalGb: 20 })
        .describe('Screenshots, recordings and downloads a job produced. Whichever limit is reached first applies.')
        .meta(ui({ title: 'Keep artifacts' })),
    })
    .default({ historyDays: 30, traceDays: 7, artifacts: { maxAgeDays: 30, maxTotalGb: 20 } })
    .meta({ title: 'Retention', 'x-enkaku': { group: 'Storage' } }),

  devices: z
    .object({
      tempThresholdC: z
        .number()
        .min(20)
        .max(90)
        .default(45)
        .describe('A device hotter than this is pulled from the queue until it cools, so job results stay trustworthy.')
        .meta(ui({ title: 'Pause jobs above', kind: 'temperature' })),
    })
    .default({ tempThresholdC: 45 })
    .meta({ title: 'Devices', 'x-enkaku': { group: 'Farm' } }),

  privacy: z
    .object({
      overControl: OverControlSchema.default('allow')
        .describe('What happens when someone starts controlling a device another person just touched.')
        .meta(ui({ title: 'When someone controls a device another person just touched', labels: { allow: 'Allow', warn: 'Warn', forbid: 'Forbid' } })),
      adbCommand: z
        .boolean()
        .default(true)
        .describe('Whether an operator may run the Adb command action. Admins always may. Off on a network-exposed install unless you turn it on.')
        .meta(ui({ title: 'Adb command action for operators' })),
    })
    .default({ overControl: 'allow', adbCommand: true })
    .meta({ title: 'Privacy', 'x-enkaku': { group: 'Farm' } }),

  advanced: z
    .object({
      adbMaxConcurrent: z
        .number()
        .int()
        .min(0)
        .max(24)
        .default(0)
        .describe('Total adb commands in flight across the farm. 0 scales it automatically with the device count.')
        .meta(ui({ title: 'Max concurrent adb commands', kind: 'count', hint: 'Raise this if the adb server saturates on a large hub.' })),
      installsPerUsbRoot: z
        .number()
        .int()
        .min(1)
        .max(16)
        .default(1)
        .describe('APK installs and file pushes allowed at once on one USB root hub. USB bandwidth is shared.')
        .meta(ui({ title: 'Max concurrent installs', kind: 'count', hint: 'Raise this if installs time out on a hub that can take more.' })),
      sessionBuildsPerUsbRoot: z
        .number()
        .int()
        .min(1)
        .max(16)
        .default(4)
        .describe('How many device sessions may be starting at the same time on one USB root hub.')
        .meta(ui({ title: 'Session build concurrency per USB root', kind: 'count', hint: 'Raise this if a cold start of 100 devices is too slow; lower it if it saturates USB.' })),
      infraRetry: z
        .object({
          attempts: z.number().int().min(0).max(10).default(3).describe('Extra attempts when a job fails for infrastructure reasons.').meta({ title: 'Attempts' }),
          backoffBaseMs: z.number().int().min(100).max(60_000).default(1_000).describe('First backoff delay; it doubles each retry, with jitter.').meta({ title: 'Backoff base (ms)' }),
        })
        .default({ attempts: 3, backoffBaseMs: 1_000 })
        .describe("Infrastructure failures (device lost, adb timeout) retry with backoff, separately from a script's own retries.")
        .meta(ui({ title: 'Infrastructure retries and backoff base', hint: 'Raise this if USB is flaky.' })),
      jobMemoryLimitBytes: z
        .number()
        .int()
        .min(67_108_864)
        .max(17_179_869_184)
        .default(268_435_456)
        .describe("Memory a job gets when its script does not declare its own. A breach kills the job.")
        .meta(ui({ title: 'Job memory limit', kind: 'bytes', enforcement: 'sampled', hint: 'Raise this if a script legitimately needs more.' })),
      transferCaps: z
        .object({
          maxPushBytes: z.number().int().min(1_048_576).default(536_870_912).describe('Largest file that may be pushed or installed.').meta({ title: 'Push (bytes)' }),
          maxPullBytes: z.number().int().min(1_048_576).default(536_870_912).describe('Largest file that may be pulled from a device.').meta({ title: 'Pull (bytes)' }),
          maxArchiveBytes: z.number().int().min(1_048_576).max(4_294_967_295).default(2_147_483_648).describe('Largest combined download of a bulk pull.').meta({ title: 'Bulk download (bytes)' }),
        })
        .default({ maxPushBytes: 536_870_912, maxPullBytes: 536_870_912, maxArchiveBytes: 2_147_483_648 })
        .describe('Ceilings on one push, one pull, and one bulk download.')
        .meta(ui({ title: 'Push, pull and bulk download size caps', hint: 'Raise these if you ship large APKs or artifact bundles.' })),
      installTimeoutMs: z
        .number()
        .int()
        .min(10_000)
        .max(1_800_000)
        .default(120_000)
        .describe('Budget for pm install once the APK is on the device.')
        .meta(ui({ title: 'Install timeout', kind: 'duration', unit: 'ms', hint: 'Raise this if your devices are slow.' })),
      adbHealthIntervalSec: z
        .number()
        .int()
        .min(5)
        .max(300)
        .default(30)
        .describe('How often the shared adb server is probed to see whether it is still answering.')
        .meta(ui({ title: 'adb health probe interval', kind: 'duration', unit: 's', hint: 'Lower this on a farm that must detect a dead adb faster.' })),
      failuresBeforeQuarantine: z
        .number()
        .int()
        .min(1)
        .max(20)
        .default(5)
        .describe('Consecutive adb timeouts before a device is quarantined as unreachable.')
        .meta(ui({ title: 'Failures before quarantine', kind: 'count', hint: 'Raise this if a noisy farm quarantines too eagerly.' })),
      wallWanBandwidthBps: z
        .number()
        .int()
        .min(1_000_000)
        .max(1_000_000_000)
        .default(20_000_000)
        .describe('Bandwidth the Screens view may spend when the browser is not on the local network. Loopback and LAN use a fixed, much larger budget.')
        .meta(ui({ title: 'Wall bandwidth budget on WAN', kind: 'bitrate', hint: 'Raise this for remote viewing over a link you know the size of.' })),
      recoveryResetsPerHour: z
        .number()
        .int()
        .min(1)
        .max(20)
        .default(6)
        .describe('How many times an hour a device may have its network route reset automatically before Enkaku stops trying.')
        .meta(ui({ title: 'Recovery resets per hour', kind: 'count', hint: 'Lower this for a device that flaps; raise it to give one more chances.' })),
    })
    .default(() => ({
      adbMaxConcurrent: 0,
      installsPerUsbRoot: 1,
      sessionBuildsPerUsbRoot: 4,
      infraRetry: { attempts: 3, backoffBaseMs: 1_000 },
      jobMemoryLimitBytes: 268_435_456,
      transferCaps: { maxPushBytes: 536_870_912, maxPullBytes: 536_870_912, maxArchiveBytes: 2_147_483_648 },
      installTimeoutMs: 120_000,
      adbHealthIntervalSec: 30,
      failuresBeforeQuarantine: 5,
      wallWanBandwidthBps: 20_000_000,
      recoveryResetsPerHour: 6,
    }))
    .meta({
      title: 'Advanced',
      description: 'Values an engineer may need to move. Every one shows its default; changing one is your problem to undo.',
      'x-enkaku': { group: 'Farm' },
    }),
})
export type FarmSettings = z.infer<typeof FarmSettingsSchema>

export const defaultFarmSettings = (): FarmSettings => FarmSettingsSchema.parse({})
```

Note the shape of the section objects' `.meta()`: the group is written as a literal `'x-enkaku': { group: … }` key rather than through `ui({ title, group })`. `readHints` only looks under `x-enkaku` (`packages/protocol/src/schema/vocabulary.ts:220-226`), so the group has to live there for `farmSections()` (§4.5) to see it, and using `ui()` on a section object would break the 26 rule. The same shape is used on the per-device section objects in §4.6, which `deviceSections()` already reads the same way.

The `networks` ceiling check that lived in `discovery`'s `superRefine` (`:1469-1483`) moves onto `networkScan` and compares against the constant, which the schema cannot import from core. It is therefore expressed as a fixed literal in the protocol:

```ts
/** MVP 12 §3 - the sweep's address ceiling, the constant `SCAN_MAX_ADDRESSES` mirrors. */
export const SCAN_MAX_ADDRESSES = 1024
```

declared in `packages/protocol/src/settings.ts` and imported by `packages/core/src/config/constants.ts` as the default for `ENKAKU_SCAN_MAX_ADDRESSES`, so the two can never disagree. The `superRefine` on `networkScan` reads it directly.

**Do not** keep `FarmSettingsSchema.defaults`, do not add a `deprecated` marker to any deleted key, and do not leave `normaliseLegacyAdb` or `normaliseLegacyWall` behind - their fields are gone, so a preprocessor for them is dead code.

### 4.4 `packages/core/src/config/constants.ts` (new - the artefact this plan ships)

Every promoted constant, its value, the setting it replaces, and one `ENKAKU_*` override each, read **once at module load** through Zod. An invalid value throws `EnkakuError('E_BAD_CONFIG', …)`, which fails the boot exactly as `loadConfig()` already does for a bad config file (`packages/core/src/config.ts:138-145`), per `CLAUDE.md`'s config-precedence rule.

```ts
import { z } from 'zod'
import { SCAN_MAX_ADDRESSES as PROTOCOL_SCAN_MAX_ADDRESSES } from '@enkaku/protocol'
import { EnkakuError } from '../util/errors'

/**
 * Support overrides (MVP 12 §3). These are NOT settings: they do not differ
 * between farms in any way the product supports, and none of them appears in
 * Studio. Each exists so a support engineer can move one number on one farm
 * without a build, and every one is listed in `.env.example` under
 * "Support overrides".
 *
 * Read once, here, at module load. An invalid value fails the boot with
 * `E_BAD_CONFIG` rather than falling back silently - the same rule
 * `loadConfig()` follows for `enkaku.config.json`.
 */
const applied = new Map<string, string>()

function readEnv(name: string): string | undefined {
  const raw = process.env[name]
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  return trimmed === '' ? undefined : trimmed
}

function parse<T>(name: string, raw: string, schema: z.ZodType<T>, coerce: (s: string) => unknown): T {
  const result = schema.safeParse(coerce(raw))
  if (!result.success) {
    throw new EnkakuError('E_BAD_CONFIG', `${name}: ${result.error.issues.map((i) => i.message).join('; ')}`)
  }
  applied.set(name, raw)
  return result.data
}

/** A number override, checked against the same bounds the old setting had. */
function num(name: string, fallback: number, schema: z.ZodType<number>): number {
  const raw = readEnv(name)
  return raw === undefined ? fallback : parse(name, raw, schema, Number)
}

/** A nullable number: an empty value means "unset"; the literal `none` means null. */
function numOrNull(name: string, fallback: number | null, schema: z.ZodType<number>): number | null {
  const raw = readEnv(name)
  if (raw === undefined) return fallback
  if (raw === 'none') { applied.set(name, raw); return null }
  return parse(name, raw, schema, Number)
}

function bool(name: string, fallback: boolean): boolean {
  const raw = readEnv(name)
  if (raw === undefined) return fallback
  return parse(name, raw, z.boolean(), (s) => (s === 'true' || s === '1' ? true : s === 'false' || s === '0' ? false : s))
}

function str(name: string, fallback: string, schema: z.ZodType<string> = z.string().min(1)): string {
  const raw = readEnv(name)
  return raw === undefined ? fallback : parse(name, raw, schema, (s) => s)
}

function strOrNull(name: string, fallback: string | null, schema: z.ZodType<string>): string | null {
  const raw = readEnv(name)
  if (raw === undefined) return fallback
  if (raw === 'none') { applied.set(name, raw); return null }
  return parse(name, raw, schema, (s) => s)
}

function pick<T extends string>(name: string, fallback: T, values: readonly [T, ...T[]]): T {
  const raw = readEnv(name)
  return raw === undefined ? fallback : (parse(name, raw, z.enum(values), (s) => s) as T)
}

function json<T>(name: string, fallback: T, schema: z.ZodType<T>): T {
  const raw = readEnv(name)
  if (raw === undefined) return fallback
  return parse(name, raw, schema, (s) => {
    try {
      return JSON.parse(s)
    } catch {
      throw new EnkakuError('E_BAD_CONFIG', `${name}: not valid JSON`)
    }
  })
}

/** Every override actually in effect, for the boot log and `bun run doctor`. */
export function appliedSupportOverrides(): ReadonlyMap<string, string> {
  return applied
}

// ── Touch profiles (replaces defaults.timing.*, D8–D15) ───────────────────────
const TouchProfileValuesSchema = z.object({
  tapHoldMs: z.tuple([z.number().int().min(0), z.number().int().min(0)]),
  betweenActionMs: z.tuple([z.number().int().min(0), z.number().int().min(0)]),
  coordJitterPx: z.number().min(0).max(20),
  gestureCurvature: z.number().min(0).max(0.5),
  gestureSampleIntervalMs: z.number().int().min(4).max(50),
  perCharMs: z.tuple([z.number().int().min(0), z.number().int().min(0)]),
})
const TouchProfilesSchema = z.object({ precise: TouchProfileValuesSchema, natural: TouchProfileValuesSchema, slow: TouchProfileValuesSchema })
export type TouchProfileValues = z.infer<typeof TouchProfileValuesSchema>

/** The tuples behind `jobRunner.touchProfile`. `natural` is the pre-212 `defaults.timing` default, unchanged. */
export const TOUCH_PROFILES = json('ENKAKU_TOUCH_PROFILES', {
  precise: { tapHoldMs: [40, 60], betweenActionMs: [150, 300], coordJitterPx: 0, gestureCurvature: 0, gestureSampleIntervalMs: 8, perCharMs: [20, 50] },
  natural: { tapHoldMs: [40, 120], betweenActionMs: [300, 900], coordJitterPx: 2, gestureCurvature: 0.08, gestureSampleIntervalMs: 8, perCharMs: [40, 140] },
  slow: { tapHoldMs: [80, 200], betweenActionMs: [700, 1800], coordJitterPx: 3, gestureCurvature: 0.12, gestureSampleIntervalMs: 8, perCharMs: [90, 220] },
}, TouchProfilesSchema)

// ── Device housekeeping (replaces defaults.prep.screenOffTimeoutMs, discovery.*, health.*, adbControl.*, battery.*, labelling.*) ──
export const DEVICE_SCREEN_OFF_TIMEOUT_MS = num('ENKAKU_DEVICE_SCREEN_OFF_TIMEOUT_MS', 1_800_000, z.number().int().min(0))
export const DEVICE_OFFLINE_GRACE_SEC = num('ENKAKU_DEVICE_OFFLINE_GRACE_SEC', 20, z.number().int().min(5).max(600))
export const DEVICE_RECOVERY_COOLDOWN_SEC = num('ENKAKU_DEVICE_RECOVERY_COOLDOWN_SEC', 120, z.number().int().min(30).max(3600))
export const DEVICE_RECOVERY_PROBE_INTERVAL_SEC = num('ENKAKU_DEVICE_RECOVERY_PROBE_INTERVAL_SEC', 60, z.number().int().min(10).max(3600))
export const DEVICE_ENDPOINTS_REMEMBERED = num('ENKAKU_DEVICE_ENDPOINTS_REMEMBERED', 4, z.number().int().min(1).max(16))
export const DEVICE_ENDPOINT_RETIRE_AFTER = num('ENKAKU_DEVICE_ENDPOINT_RETIRE_AFTER', 10, z.number().int().min(1).max(100))
export const DEVICE_CONNECT_SETTLE_MS = num('ENKAKU_DEVICE_CONNECT_SETTLE_MS', 3_000, z.number().int().min(500).max(30_000))
export const DEVICE_RESCAN_INTERVAL_SEC = num('ENKAKU_DEVICE_RESCAN_INTERVAL_SEC', 10, z.number().int().min(0).max(300))
export const DEVICE_AUTO_QUARANTINE = bool('ENKAKU_DEVICE_AUTO_QUARANTINE', true)
export const BATTERY_POLL_INTERVAL_SEC = num('ENKAKU_BATTERY_POLL_INTERVAL_SEC', 60, z.number().int().min(10))
export const DEVICE_LABEL_SURFACE = pick('ENKAKU_DEVICE_LABEL_SURFACE', 'lock-screen', ['lock-screen', 'wallpaper'] as const)
export const LABEL_WRITE_CONCURRENCY = num('ENKAKU_LABEL_WRITE_CONCURRENCY', 2, z.number().int().min(1).max(16))
export const CONTROL_IDLE_SEC = num('ENKAKU_CONTROL_IDLE_SEC', 30, z.number().int().min(5).max(600))

// ── adb transport and the shared server (replaces adb.*, adbControl.*, discovery.tcpPort) ──
export const ADB_TCP_PORT = num('ENKAKU_ADB_TCP_PORT', 5555, z.number().int().min(1024).max(65535))
export const ADB_MAX_STREAMS_PER_DEVICE = num('ENKAKU_ADB_MAX_STREAMS_PER_DEVICE', 4, z.number().int().min(1).max(8))
export const ADB_MAX_STREAMS_FARM = num('ENKAKU_ADB_MAX_STREAMS_FARM', 0, z.number().int().min(0).max(64))
export const ADB_MAX_HOST_PROCESSES = num('ENKAKU_ADB_MAX_HOST_PROCESSES', 4, z.number().int().min(1).max(32))
export const ADB_TIMEOUT_STORM_RATE = num('ENKAKU_ADB_TIMEOUT_STORM_RATE', 0.5, z.number().min(0).max(1))
export const ADB_RESTART_COOLDOWN_SEC = num('ENKAKU_ADB_RESTART_COOLDOWN_SEC', 60, z.number().int().min(10).max(3600))
export const ADB_DRAIN_TIMEOUT_MS = num('ENKAKU_ADB_DRAIN_TIMEOUT_MS', 30_000, z.number().int().min(5_000).max(300_000))

// ── Network sweep and cutover (replaces discovery.scan.*, discovery.cutover.*) ──
export const SCAN_MODE = pick('ENKAKU_SCAN_MODE', 'on-demand', ['off', 'on-demand'] as const)
export const SCAN_MAX_ADDRESSES = num('ENKAKU_SCAN_MAX_ADDRESSES', PROTOCOL_SCAN_MAX_ADDRESSES, z.number().int().min(64).max(4096))
export const SCAN_CONCURRENCY = num('ENKAKU_SCAN_CONCURRENCY', 32, z.number().int().min(1).max(256))
export const SCAN_PROBE_TIMEOUT_MS = num('ENKAKU_SCAN_PROBE_TIMEOUT_MS', 300, z.number().int().min(50).max(5_000))
export const CUTOVER_WINDOW_SEC = num('ENKAKU_CUTOVER_WINDOW_SEC', 180, z.number().int().min(30).max(900))
export const CUTOVER_POLL_SEC = num('ENKAKU_CUTOVER_POLL_SEC', 5, z.number().int().min(1).max(60))

// ── Guest agent and crash monitoring (replaces guestAgent.provision/recoveryRearmSec, monitor.crashWatch) ──
export const GUEST_AGENT_PROVISION = pick('ENKAKU_GUEST_AGENT_PROVISION', 'auto', ['auto', 'manual', 'off'] as const)
export const GUEST_AGENT_RECOVERY_REARM_SEC = num('ENKAKU_GUEST_AGENT_RECOVERY_REARM_SEC', 120, z.number().int().min(30).max(3600))
export const CRASH_WATCH = pick('ENKAKU_CRASH_WATCH', 'always', ['always', 'off'] as const)

// ── Job runtime (replaces job.* minus the two visible and the two advanced) ────
export const JOB_RESET_TIMEOUT_MS = num('ENKAKU_JOB_RESET_TIMEOUT_MS', 15_000, z.number().int().min(1_000).max(60_000))
export const JOB_RESET_STRICT = bool('ENKAKU_JOB_RESET_STRICT', false)
export const JOB_STARTUP_TIMEOUT_MS = num('ENKAKU_JOB_STARTUP_TIMEOUT_MS', 60_000, z.number().int().min(5_000).max(600_000))
export const JOB_MAX_TIMEOUT_MS = numOrNull('ENKAKU_JOB_MAX_TIMEOUT_MS', null, z.number().int().min(30_000).max(86_400_000))
export const JOB_MEMORY_MAX_BYTES = numOrNull('ENKAKU_JOB_MEMORY_MAX_BYTES', null, z.number().int().min(67_108_864).max(17_179_869_184))
export const JOB_MEMORY_ENFORCE = pick('ENKAKU_JOB_MEMORY_ENFORCE', 'kill', ['kill', 'warn', 'off'] as const)
export const JOB_MEMORY_SAMPLE_INTERVAL_MS = num('ENKAKU_JOB_MEMORY_SAMPLE_INTERVAL_MS', 2_000, z.number().int().min(250).max(30_000))
export const JOB_TRIGGER_MAX_DEPTH = num('ENKAKU_JOB_TRIGGER_MAX_DEPTH', 5, z.number().int().min(1).max(50))
export const JOB_TRIGGER_MAX_PER_CHAIN = num('ENKAKU_JOB_TRIGGER_MAX_PER_CHAIN', 200, z.number().int().min(1).max(10_000))
export const JOB_TRIGGER_MAX_PER_JOB = num('ENKAKU_JOB_TRIGGER_MAX_PER_JOB', 10, z.number().int().min(1).max(1_000))
export const JOB_MAX_RESULT_BYTES = num('ENKAKU_JOB_MAX_RESULT_BYTES', 65_536, z.number().int().min(1_024).max(1_048_576))
export const JOB_PROGRESS_INTERVAL_MS = num('ENKAKU_JOB_PROGRESS_INTERVAL_MS', 1_000, z.number().int().min(250).max(10_000))
export const JOB_RETRY_BACKOFF_MAX_MS = num('ENKAKU_JOB_RETRY_BACKOFF_MAX_MS', 30_000, z.number().int().min(1_000).max(300_000))
export const JOB_TIMEOUT_IS_INFRA = bool('ENKAKU_JOB_TIMEOUT_IS_INFRA', false)
export const JOB_REBIND_ON_INFRA = bool('ENKAKU_JOB_REBIND_ON_INFRA', true)
export const JOB_CRASH_POLICY = pick('ENKAKU_JOB_CRASH_POLICY', 'declared', ['ignore', 'declared', 'any'] as const)
export const WORKFLOW_MAX_TOTAL_MS = num('ENKAKU_WORKFLOW_MAX_TOTAL_MS', 21_600_000, z.number().int().min(60_000).max(604_800_000))

// ── Monitoring and retention the sweeper reads but nobody tunes (replaces retention.*) ──
export const INPUT_EVENT_RETENTION_DAYS = num('ENKAKU_INPUT_EVENT_RETENTION_DAYS', 3, z.number().int().min(1).max(365))
export const EVENT_MAX_ROWS_PER_DEVICE = num('ENKAKU_EVENT_MAX_ROWS_PER_DEVICE', 50_000, z.number().int().min(1_000))
export const BLOB_ORPHAN_GRACE_HOURS = num('ENKAKU_BLOB_ORPHAN_GRACE_HOURS', 24, z.number().int().min(1))
export const AUDIT_RETENTION_DAYS = num('ENKAKU_AUDIT_RETENTION_DAYS', 90, z.number().int().min(1).max(3_650))

// ── Device terminal and the temporary adb endpoint (replaces shell.* minus the visible switch) ──
export const SHELL_EXEC_TIMEOUT_MS = num('ENKAKU_SHELL_EXEC_TIMEOUT_MS', 15_000, z.number().int().min(1_000).max(120_000))
export const SHELL_MAX_OUTPUT_BYTES = num('ENKAKU_SHELL_MAX_OUTPUT_BYTES', 262_144, z.number().int().min(4_096).max(4_194_304))
export const ADB_ENDPOINT_ENABLED = bool('ENKAKU_ADB_ENDPOINT_ENABLED', false)
export const ADB_ENDPOINT_BIND = str('ENKAKU_ADB_ENDPOINT_BIND', '127.0.0.1')
export const ADB_ENDPOINT_IDLE_SEC = num('ENKAKU_ADB_ENDPOINT_IDLE_SEC', 300, z.number().int().min(30).max(3_600))
export const ADB_ENDPOINT_MAX_STREAMS = num('ENKAKU_ADB_ENDPOINT_MAX_STREAMS', 8, z.number().int().min(1).max(32))

// ── Input arbitration and display fallback (replaces coControl.queueWaitMs/maxQueueDepth, display.fallbackRetryCount) ──
export const INPUT_WAIT_BUDGET_MS = num('ENKAKU_INPUT_WAIT_BUDGET_MS', 5_000, z.number().int().min(500).max(30_000))
export const INPUT_MAX_QUEUE_DEPTH = num('ENKAKU_INPUT_MAX_QUEUE_DEPTH', 32, z.number().int().min(1).max(256))
export const DISPLAY_FALLBACK_RETRIES = num('ENKAKU_DISPLAY_FALLBACK_RETRIES', 6, z.number().int().min(0).max(20))

// ── Screens view budgets (replaces wall.*, readiness.*) ───────────────────────
export const WALL_MAX_TILES = num('ENKAKU_WALL_MAX_TILES', 0, z.number().int().min(0).max(64))
export const WALL_RAMP_CONCURRENCY = num('ENKAKU_WALL_RAMP_CONCURRENCY', 2, z.number().int().min(1).max(8))
/** 24 is still plan 100 §7.3's unmeasured placeholder; plan 223 measures it (MVP 09 §7). */
export const WALL_DECODE_TILE_CEILING = num('ENKAKU_WALL_DECODE_TILE_CEILING', 24, z.number().int().min(4).max(64))
export const WALL_LAN_BANDWIDTH_BPS = num('ENKAKU_WALL_LAN_BANDWIDTH_BPS', 200_000_000, z.number().int().min(1_000_000).max(1_000_000_000))
export const WALL_TRANSPORT_OVERRIDE = pick('ENKAKU_WALL_TRANSPORT_OVERRIDE', 'auto', ['auto', 'loopback', 'lan', 'wan'] as const)
export const READINESS_MAX_HOT = num('ENKAKU_READINESS_MAX_HOT', 8, z.number().int().min(0).max(64))
export const READINESS_DEFAULT_DESIRED = pick('ENKAKU_READINESS_DEFAULT_DESIRED', 'awake', ['asleep', 'awake', 'hot'] as const)

// ── Transfer, workspace and KV limits (replaces transfer.enabled, workspace.*, kv.*) ──
export const TRANSFER_ENABLED = bool('ENKAKU_TRANSFER_ENABLED', true)
export const WORKSPACE_MAX_FILE_BYTES = num('ENKAKU_WORKSPACE_MAX_FILE_BYTES', 268_435_456, z.number().int().min(1))
export const WORKSPACE_MAX_FILES_PER_SCOPE = num('ENKAKU_WORKSPACE_MAX_FILES_PER_SCOPE', 1_000, z.number().int().min(1))
export const WORKSPACE_MAX_BYTES_PER_SCOPE = num('ENKAKU_WORKSPACE_MAX_BYTES_PER_SCOPE', 8_589_934_592, z.number().int().min(1))
export const WORKSPACE_INLINE_MAX_BYTES = num('ENKAKU_WORKSPACE_INLINE_MAX_BYTES', 65_536, z.number().int().min(0))
export const KV_MAX_VALUE_BYTES = num('ENKAKU_KV_MAX_VALUE_BYTES', 65_536, z.number().int().min(1))
export const KV_MAX_KEY_LENGTH = num('ENKAKU_KV_MAX_KEY_LENGTH', 256, z.number().int().min(1))
export const KV_MAX_ENTRIES_PER_NAMESPACE = num('ENKAKU_KV_MAX_ENTRIES_PER_NAMESPACE', 1_000, z.number().int().min(1))
export const KV_MAX_ENTRIES_PER_DEVICE = num('ENKAKU_KV_MAX_ENTRIES_PER_DEVICE', 5_000, z.number().int().min(1))

// ── Action recorder (parked by plan 210, bounds still enforced; replaces recording.*) ──
export const RECORDING_ANCHOR_QUIET_MS = num('ENKAKU_RECORDING_ANCHOR_QUIET_MS', 400, z.number().int().min(0).max(10_000))
export const RECORDING_ANCHOR_MIN_INTERVAL_MS = num('ENKAKU_RECORDING_ANCHOR_MIN_INTERVAL_MS', 1_500, z.number().int().min(0).max(60_000))
export const RECORDING_LONG_PRESS_MS = num('ENKAKU_RECORDING_LONG_PRESS_MS', 400, z.number().int().min(200).max(10_000))
export const RECORDING_MAX_STEPS = num('ENKAKU_RECORDING_MAX_STEPS', 500, z.number().int().min(1).max(2_000))
export const RECORDING_MAX_DURATION_SEC = num('ENKAKU_RECORDING_MAX_DURATION_SEC', 900, z.number().int().min(1).max(86_400))
export const RECORDING_CAPTURE_SCREENSHOTS = bool('ENKAKU_RECORDING_CAPTURE_SCREENSHOTS', true)

// ── Network geo verification (replaces network.geoProvider/geoIntervalSec) ────
export const GEO_PROVIDER_URL = strOrNull('ENKAKU_GEO_PROVIDER_URL', null, z.string().url())
export const GEO_RECHECK_INTERVAL_SEC = num('ENKAKU_GEO_RECHECK_INTERVAL_SEC', 300, z.number().int().min(30).max(86_400))
```

Two rules the executor must follow:

- **No package other than `packages/core` imports this file.** `packages/session`, `packages/adb`, `packages/drivers` and `packages/protocol` keep receiving values through the accessor deps `daemon.ts` already wires; §5 lists each rewiring by line.
- **`packages/core/src/index.ts:18`** (`const cfg = loadConfig()`) is wrapped so an `E_BAD_CONFIG` thrown while `./config` is being imported, or by `loadConfig()` itself, prints the code and message and exits 1 rather than printing a stack:

```ts
  let cfg: ReturnType<typeof loadConfig>
  try {
    cfg = loadConfig()
  } catch (err) {
    if (err instanceof EnkakuError) log.error(`failed to start [${err.code}]: ${err.message}`)
    else log.error(`failed to start: ${String(err)}`)
    process.exit(1)
  }
```

`packages/core/src/config.ts` gains `import './config/constants'` as its first import, so the overrides are parsed before anything else runs.

### 4.5 Studio: the farm section list is derived, not maintained

`packages/studio/src/components/settings/farmSections.ts` is rewritten from a 162-line hand-maintained constant into a 40-line derivation, the same shape `deviceSections.ts:45-69` already has. The old file's doc comment argues for keeping it hand-maintained because "half of these entries are bespoke screens"; after this plan exactly one is, so the argument is gone and so is the comment.

```ts
import { readHints } from '@enkaku/protocol'
import type { JsonSchemaNode } from '@/components/schema-form/types'

export interface FarmSectionDef {
  id: string
  title: string
  /** The heading `SectionNav` renders above a run of consecutive entries sharing it. Empty means no heading. */
  group: string
  /** Top-level `FarmSettingsSchema` keys this section's `FarmForm` renders. Empty for the one bespoke screen. */
  keys: string[]
}

/**
 * The ten Settings sections (MVP 12 §1 as amended by MVP 15 §1). Nine come
 * from `FarmSettingsSchema`'s own top-level keys, in declaration order, each
 * titled and grouped by its own `title`/`x-enkaku.group`. The tenth, Access
 * (users and API tokens), is a table against `/api/auth/*`, not a settings
 * row, and is spliced in before Advanced.
 */
export function farmSections(schema: JsonSchemaNode): FarmSectionDef[] {
  const properties = schema.properties ?? {}
  const derived: FarmSectionDef[] = Object.keys(properties).map((key) => {
    const node = properties[key] ?? {}
    return { id: key, title: typeof node.title === 'string' ? node.title : key, group: readHints(node).group ?? '', keys: [key] }
  })
  const advancedAt = derived.findIndex((s) => s.id === 'advanced')
  const access: FarmSectionDef = { id: 'access', title: 'Access', group: 'Farm', keys: [] }
  return advancedAt === -1 ? [...derived, access] : [...derived.slice(0, advancedAt), access, ...derived.slice(advancedAt)]
}
```

`packages/studio/src/app/settings/page.tsx` changes, by content:

| Line as of 2026-09-03 | Change |
|---|---|
| `:37` `import { KvPanel } from '@/components/kv/KvPanel'` | delete the import; the KV browser moves to Plugins (plan 219). The component file stays |
| `:43` `import { FarmVideoFields } from '@/components/video/FarmVideoFields'` | delete the import and the file |
| `:44` `import { FARM_SECTION_DEFS } from '@/components/settings/farmSections'` | becomes `import { farmSections } from '@/components/settings/farmSections'` |
| `:107` `const sections: SettingsSection[] = FARM_SECTION_DEFS.map(({ id, title, group, keys }) => ({` | becomes `const sections: SettingsSection[] = farmSections(schema).map(...)`, where `schema` is the `schema` field the page already fetches from `GET /api/settings` |
| `:114-122` the `id === 'kv'` branch (`) : id === 'kv' ? (`) | delete |
| `:123-126` the `id === 'connectors'` and `id === 'webhooks'` branches | delete (moved to Agents, plan 220) |
| `:127-130` the `id === 'users'` and `id === 'audit'` branches | keep both, merged under one `id === 'access'` branch (Users and API tokens plus the audit log are one Access section) |
| `:112-113` the `id === 'blocked'` branch | delete; blocked devices move into the discovery sheet (MVP 15 §1). `BlockedDevicesSection` itself stays for plan 214 |
| `:136-145` the `id === 'discovery'` branch | becomes `id === 'networkScan'`, rendering `<FarmNetworksEditor />` alone (the `omit={['discovery.networks']}` trick is unnecessary once `networks` is the only field in the block) |
| `:146-174` the `id === 'network'` cross-link banner | delete; the two blocks it disambiguated no longer both exist |
| `:175-180` the `id === 'video'` branch | delete |
| `:181-185` the `id === 'spend'` branch and `ObservedSpendPanel` | delete (moved to Agents, plan 220) |
| `:186-195` the `id === 'guest-agent'` branch | delete; `GuestAgentSummarySection` moves onto the Devices page (plan 214). If plan 214 has not landed, mount it under `id === 'devices'` and say so in the report |
| `:131-135` the `id === 'adb'` branch with `AdbDiagnosticsPanel` | retarget to `id === 'advanced'` |
| `:106` `const tab = useSearchParams().get('tab') ?? 'defaults'` | the default tab id becomes `'general'` |
| `:207` `onChange={(id) => router.push(id === 'defaults' ? '/settings' : \`/settings?tab=\${id}\`)}` | `id === 'general'` is the bare `/settings` case |
| the imports left unused by the deletions above | delete each; `bun run typecheck` catches any that is missed |

`packages/studio/src/components/settings/farmSections.test.ts` and `deviceSections.test.ts` are already deleted by plan 201 (Studio has zero tests). **Do not** write a replacement for either.

Three Studio files under `components/video/` are also edited:

- `FarmVideoFields.tsx`, `DeviceVideoFields.tsx` - **deleted**. Their whole subject (the six numeric overrides and the Advanced disclosure over them) is gone.
- `video-quality.ts` - reduced. Deleted exports: `FarmVideoSettings`, `DeviceVideoSettings`, `CONTROL_ADVANCED_KEYS`, `WALL_ADVANCED_KEYS`, `VIDEO_PRESET_KEYS`, `VIDEO_ADVANCED_KEYS`, `farmSourceLabel`, `deviceSourceLabel`, `capitalize`. Kept and rewritten to the preset-only model: `VideoSource` becomes `'preset' | 'device'`, `resolveControlProfile`/`resolveWallProfile` take `{ controlQuality, wallQuality }` and an optional per-device `{ controlQuality?, wallQuality? }`, `computeAutoTiles` takes its budget from the values the API reports rather than a settings read. Kept unchanged: `ReadoutRow`, `profileRows`, `formatMbps`, `formatBitRatePreset`, `sameVideoNumbers`, `buildReprofileToast`, `WallTransport`, `resolveWallBandwidthBps`.
- `VideoQualityReadout.tsx` - unchanged; it imports `ReadoutRow`, which survives. `packages/studio/src/app/scripts/detail/page.tsx` and `app/scripts/runtime-readout.ts` are untouched.

`packages/studio/src/components/device-popup/SettingsPopup.tsx` and `packages/studio/src/app/device/page.tsx` each render `<DeviceVideoFields …>`; both usages and their imports are deleted. The generic `SchemaForm` beneath them already renders `overrides.controlQuality` / `overrides.wallQuality` with no bespoke component.

### 4.6 Per-device settings (MVP 12 §5)

```ts
/** Per-device settings. A field here either has no farm analogue at all, or is an
 *  `.optional()` override of one of the fifteen visible farm fields, where ABSENT
 *  means "use the farm default". There is no third case, so nothing can shadow. */
export const DeviceSettingsSchema = z.object({
  engines: z
    .object({
      transport: z.enum(['adb-usb', 'adb-tcp']).default('adb-usb').describe('How the core talks to the device').meta({ title: 'Transport' }),
      display: z.enum(['scrcpy', 'screencap-loop']).default('scrcpy').describe('Where the picture sent to Studio comes from').meta({ title: 'Screen capture' }),
      input: z.enum(['scrcpy-uhid', 'scrcpy-sdk', 'adb-input']).default('scrcpy-uhid').describe('How taps, swipes, and typing reach the device').meta({ title: 'Input delivery' }),
      inspection: z.enum(['ui-server', 'uiautomator-dump', 'appium']).default('ui-server').describe('How scripts find elements on screen').meta({ title: 'Screen inspection' }),
    })
    .default({ transport: 'adb-usb', display: 'scrcpy', input: 'scrcpy-uhid', inspection: 'ui-server' })
    .meta({ title: 'Engines', description: 'The core rejects combinations that cannot work together.', 'x-enkaku': { group: 'Engines' } }),

  identity: DeviceIdentitySchema.default(() => DeviceIdentitySchema.parse({})).meta({ title: 'Identity', 'x-enkaku': { group: 'Identity' } }),

  prep: z
    .preprocess(
      normaliseLegacyPrep,
      z.object({
        keepAwake: KeepAwakeModeSchema.default('always').describe('Keep the device awake while a session is open').meta({ title: 'Keep the screen awake' }),
        standbyScreenOff: z.boolean().default(false).describe('Turn the device screen off while streaming').meta({ title: 'Turn the device screen off while streaming' }),
        rotation: RotationModeSchema.default('device').describe('Whether the device rotates freely or is pinned while a session is open').meta({ title: 'Screen rotation' }),
        textInput: TextInputModeSchema.default('auto').describe('Use the guest agent keyboard while a session is open, so non-ASCII text can be typed.').meta({ title: 'Text input' }),
      }),
    )
    .default({ keepAwake: 'always', standbyScreenOff: false, rotation: 'device', textInput: 'auto' })
    .meta({ title: 'Before a job runs', 'x-enkaku': { group: 'Power & readiness' } }),

  autoReconnect: z.boolean().default(true).describe('Reconnect automatically when the device disappears').meta({ title: 'Auto-reconnect' }),
  logInputText: z
    .boolean()
    .default(false)
    .describe('Store the literal typed text in the input log, instead of just its length. Turning this on is recorded in the audit log.')
    .meta({ title: 'Log typed text in the clear' }),

  instrumentation: DeviceInstrumentationSchema.default(() => DeviceInstrumentationSchema.parse({})),

  /** MVP 12 §5 - the same visible set as the farm, each optional: absent = use farm default. */
  overrides: z
    .object({
      controlQuality: ControlQualitySchema.optional().describe('Overrides the farm control quality for this device.').meta({ title: 'Control quality' }),
      wallQuality: WallQualitySchema.optional().describe('Overrides the farm wall quality for this device.').meta({ title: 'Wall quality' }),
      touchProfile: TouchProfileSchema.optional().describe('Overrides the farm touch profile for this device.').meta({ title: 'Human-like touch profile' }),
      resetPolicy: ResetPolicySchema.optional().describe('Overrides the farm reset policy for this device.').meta({ title: 'Reset the app before each job' }),
      defaultTimeoutMs: z.number().int().min(30_000).max(86_400_000).optional().describe('Overrides the farm default job timeout for this device.').meta({ title: 'Default job timeout' }),
      deviceLabel: DeviceLabelSchema.optional().describe('Overrides what this phone shows about itself.').meta({ title: 'Physical label on the screen' }),
      tempThresholdC: z.number().min(20).max(90).optional().describe('Overrides the farm temperature threshold for this device.').meta({ title: 'Pause jobs above' }),
    })
    .default({})
    .meta({ title: 'Farm overrides', description: 'Leave a field empty to use the farm setting.', 'x-enkaku': { group: 'Overrides' } }),
})
export type DeviceSettings = z.infer<typeof DeviceSettingsSchema>
export const defaultDeviceSettings = (): DeviceSettings => DeviceSettingsSchema.parse({})
```

One resolver is added beside the schema so no call site invents its own precedence rule:

```ts
/** The ONE place a per-device override is combined with the farm value. */
export function resolveDeviceSetting<K extends keyof DeviceSettings['overrides']>(
  farm: FarmSettings,
  device: DeviceSettings | null,
  key: K,
): NonNullable<DeviceSettings['overrides'][K]> {
  const override = device?.overrides?.[key]
  if (override !== undefined) return override as NonNullable<DeviceSettings['overrides'][K]>
  switch (key) {
    case 'controlQuality': return farm.capture.controlQuality as never
    case 'wallQuality': return farm.capture.wallQuality as never
    case 'touchProfile': return farm.jobRunner.touchProfile as never
    case 'resetPolicy': return farm.jobRunner.resetPolicy as never
    case 'defaultTimeoutMs': return farm.jobRunner.defaultTimeoutMs as never
    case 'deviceLabel': return farm.general.deviceLabel as never
    case 'tempThresholdC': return farm.devices.tempThresholdC as never
  }
}
```

Deleted with this schema: `TimingSettingsSchema` (moved to `packages/protocol/src/timing.ts` without any `ui()`), `ControlPresetSchema`, `WallPresetSchema`, `DeviceLabelModeSchema`, `DeviceLabellingSchema`, `ShellModeSchema`, `CoControlModeSchema` (already deleted by plan 205), `WallTransportSchema`, `FarmDeviceDefaultsSchema`, and the exported types `FarmDeviceDefaults`, `SessionSettings`, `VideoSettings`, `WallSettings`, `ReadinessSettings`, `WorkspaceSettings`, `KvSettings`, `WorkflowJobSettings`, `RecordingSettings`, `JobSettings`, `DeviceLabelMode`, `DeviceLabelling`, `ControlPreset`, `WallPreset`, `ShellMode`, `WallTransport`.

`packages/protocol/src/api/devices.ts:881` `DEVICE_PREP_KEYS` loses `'disableAnimations'`, `:905` loses the `disableAnimations: z.boolean().optional()` line, and `:945`'s `_EveryPrepKeyIsCovered` guard loses the `| 'screenOffTimeoutMs'` exclusion (the field is gone, so the guard covers every remaining prep key with no exception). `packages/studio/src/components/BulkPrepDialog.tsx` loses its `disableAnimations` state, label, toggle and patch line.

### 4.7 `AgentSettingsSchema` and `/api/agents/settings` (MVP 12 §5)

The five AI blocks leave farm settings. `agentDefaults` and `scheduledAgents` are the two with a schema; connectors and webhooks already have their own REST endpoints (`/api/connectors`, `/api/webhooks`) and move only as Studio sections (plan 220); the workspace block becomes constants (F101–F104), so nothing of it moves.

`packages/protocol/src/agent-settings.ts` (new):

```ts
import { z } from 'zod'
import { AgentDefaultsSchema } from './agent'

/**
 * Farm-level agent settings (MVP 12 §5) - rendered by the Agents page's
 * Settings tab (plan 220), not by farm Settings. `AgentDefaultsSchema` is
 * unchanged; only its home moves.
 */
export const AgentSettingsSchema = z.object({
  defaults: AgentDefaultsSchema.default(() => AgentDefaultsSchema.parse({})).meta({
    title: 'Agent defaults',
    description: 'Model, provider connector, and budgets a new agent inherits until it overrides them.',
  }),
  scheduled: z
    .object({
      spendCapOutputTokensPer24h: z
        .number()
        .int()
        .positive()
        .nullable()
        .default(null)
        .describe('Farm-wide output tokens allowed for SCHEDULED agent runs in a rolling 24 hours. Never applies to an interactive chat run.')
        .meta({ title: 'Spend cap - scheduled runs only' }),
      maxConcurrentScheduledRuns: z
        .number()
        .int()
        .min(1)
        .default(3)
        .describe('Scheduled agent runs allowed at once, farm-wide.')
        .meta({ title: 'Max concurrent scheduled runs' }),
    })
    .default({ spendCapOutputTokensPer24h: null, maxConcurrentScheduledRuns: 3 })
    .meta({ title: 'Scheduled agents' }),
})
export type AgentSettings = z.infer<typeof AgentSettingsSchema>
export const defaultAgentSettings = (): AgentSettings => AgentSettingsSchema.parse({})

export const AgentSettingsResponseSchema = z.object({ settings: AgentSettingsSchema, schema: JsonSchemaNodeSchema })
export const UpdateAgentSettingsResponseSchema = z.object({ settings: AgentSettingsSchema })
```

(`JsonSchemaNodeSchema` is imported from `./api/json-schema`, as `packages/protocol/src/api/settings.ts:3` already does.)

Storage: a second row in the existing `farm_settings` table, `id = 2`. **No Drizzle migration** - the table shape is unchanged (`packages/core/src/db/schema.ts:1173-1177`), and a missing row 2 parses as `defaultAgentSettings()` on first read exactly as row 1 does today.

`packages/core/src/settings/agent-settings.ts` (new) is `createAgentSettingsStore(db)`, a copy of `createFarmSettingsStore`'s shape (`get`, `update`, `onChange`) against `ROW_ID = 2` and `AgentSettingsSchema`, with no `authMode` argument.

Routes, mounted under the existing agents router (`daemon.ts:3249` `agentRoutes: createAgentRoutes({ store: agentStore, tree: agentTreeStore, audit })`, which gains `settings: agentSettingsStore`):

| Method | Path | Permission | Body | Response | Errors |
|---|---|---|---|---|---|
| GET | `/api/agents/settings` | `agent.view` | none | `200` `AgentSettingsResponseSchema` | - |
| PATCH | `/api/agents/settings` | `agent.manage` | a partial `AgentSettings` | `200` `UpdateAgentSettingsResponseSchema` | `400 E_BAD_REQUEST` with the Zod issue path and message |

Route order matters: `createAgentRoutes` already declares `app.get('/:id', …)` (`packages/core/src/api/agents.ts:34`). **Register `/settings` before `/:id`**, or a GET of the settings resolves as an agent lookup and answers `agent_not_found`.

Every reader is rewired in `daemon.ts`:

| Line as of 2026-09-03 | Now |
|---|---|
| `:2079` `scheduledAgentCeilings: () => settingsStore.get().scheduledAgents,` | `() => agentSettingsStore.get().scheduled` |
| `:3024` same line, second wiring | same change |
| `:3259` `maxUploadBytes: () => settingsStore.get().agentDefaults.maxImageBytes` | `() => agentSettingsStore.get().defaults.maxImageBytes` |

`packages/protocol/src/api/settings.ts` is unchanged in shape: `SettingsResponseSchema` keeps `settings`, `schema` and `deviceSchema` and simply reflects the smaller `FarmSettingsSchema`.

### 4.8 The stored settings migration

`packages/core/src/settings/migrate-settings.ts` (new). `createFarmSettingsStore` calls it on the value it reads from the row, **before** `FarmSettingsSchema.safeParse`, replacing the silent fallback at `farm-settings.ts:27-28`.

```ts
import { FarmSettingsSchema, type FarmSettings } from '@enkaku/protocol'
import type { Logger } from '../util/logger'

/** A value out of the new schema's range, clamped, with the fact recorded. */
interface Clamp { path: string; from: unknown; to: unknown }

const RESET_POLICY: Record<string, 'never' | 'always' | 'on-failure'> = {
  none: 'never', home: 'always', declared: 'always', aggressive: 'always',
  never: 'never', always: 'always', 'on-failure': 'on-failure',
}

function n(v: unknown): number | undefined { return typeof v === 'number' && Number.isFinite(v) ? v : undefined }
function clampTo(lo: number, hi: number, v: number): number { return v < lo ? lo : v > hi ? hi : v }
function get(o: unknown, ...path: string[]): unknown {
  let cur: unknown = o
  for (const k of path) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[k]
  }
  return cur
}

/**
 * Map a settings blob written by ANY earlier schema onto the nine-key one
 * (plan 212 §4.8). Three rules, in this order:
 *   1. a renamed key is mapped;
 *   2. an unknown key is dropped (Zod's own strip mode does this; nothing here
 *      has to);
 *   3. a value outside the new bounds is clamped, and every clamp is logged
 *      on its own line - never silently.
 * Returns a value that is then parsed; if the parse still fails, the caller
 * logs and falls back to defaults, which is the only path that loses data.
 */
export function migrateFarmSettings(raw: unknown, log: Logger): FarmSettings {
  const clamps: Clamp[] = []
  const clamp = (path: string, lo: number, hi: number, v: number): number => {
    const out = clampTo(lo, hi, v)
    if (out !== v) clamps.push({ path, from: v, to: out })
    return out
  }

  // Already the new shape (nine keys, `general` present): parse as-is.
  if (get(raw, 'general') !== undefined) {
    const parsed = FarmSettingsSchema.safeParse(raw)
    if (parsed.success) return parsed.data
  }

  const labelMode = get(raw, 'defaults', 'labelling', 'mode')
  const showName = get(raw, 'defaults', 'labelling', 'showName')
  if (labelMode === 'wallpaper') {
    log.warn('settings: the wallpaper label surface is now the env var ENKAKU_DEVICE_LABEL_SURFACE=wallpaper; the stored mode is dropped')
  }

  const shellMode = get(raw, 'shell', 'mode')
  const oldTouch = get(raw, 'defaults', 'timing', 'profile')
  const oldReset = get(raw, 'job', 'resetPolicy')

  const next = {
    general: {
      name: typeof get(raw, 'general', 'name') === 'string' ? get(raw, 'general', 'name') : 'Enkaku farm',
      deviceLabel: labelMode === 'off' || labelMode === undefined ? 'off' : showName === false ? 'number' : 'number-and-name',
    },
    hostDaemon: { egressProbeUrl: process.env.ENKAKU_NETWORK_PROBE_URL?.trim() ?? '' },
    networkScan: { networks: Array.isArray(get(raw, 'discovery', 'networks')) ? get(raw, 'discovery', 'networks') : [] },
    jobRunner: {
      defaultTimeoutMs: clamp('jobRunner.defaultTimeoutMs', 30_000, 86_400_000, n(get(raw, 'job', 'defaultTimeoutMs')) ?? 3_600_000),
      resetPolicy: RESET_POLICY[String(oldReset)] ?? 'always',
      touchProfile: oldTouch === 'instant' ? 'precise' : 'natural',
    },
    capture: {
      controlQuality: get(raw, 'video', 'controlPreset') ?? 'sharp',
      wallQuality: get(raw, 'video', 'wallPreset') ?? 'balanced',
    },
    storage: {
      historyDays: clamp('storage.historyDays', 1, 3_650, n(get(raw, 'retention', 'eventMainDays')) ?? 30),
      traceDays: clamp('storage.traceDays', 1, 3_650, n(get(raw, 'retention', 'traceDays')) ?? 7),
      artifacts: {
        maxAgeDays: clamp('storage.artifacts.maxAgeDays', 1, 3_650, n(get(raw, 'retention', 'maxAgeDays')) ?? 30),
        maxTotalGb: clamp('storage.artifacts.maxTotalGb', 0.1, 10_000, n(get(raw, 'retention', 'maxTotalGb')) ?? 20),
      },
    },
    devices: { tempThresholdC: clamp('devices.tempThresholdC', 20, 90, n(get(raw, 'battery', 'tempThresholdC')) ?? 45) },
    privacy: {
      overControl: get(raw, 'control', 'overControl') ?? 'allow',
      adbCommand: shellMode === undefined ? true : shellMode !== 'off',
    },
    advanced: {
      adbMaxConcurrent: clamp('advanced.adbMaxConcurrent', 0, 24, n(get(raw, 'adb', 'maxConcurrent')) ?? 0),
      installsPerUsbRoot: clamp('advanced.installsPerUsbRoot', 1, 16, n(get(raw, 'adb', 'maxInstallConcurrent')) ?? 1),
      sessionBuildsPerUsbRoot: clamp('advanced.sessionBuildsPerUsbRoot', 1, 16, n(get(raw, 'session', 'buildsPerUsbRoot')) ?? 4),
      infraRetry: {
        attempts: clamp('advanced.infraRetry.attempts', 0, 10, n(get(raw, 'job', 'retry', 'maxInfraAttempts')) ?? 3),
        backoffBaseMs: clamp('advanced.infraRetry.backoffBaseMs', 100, 60_000, n(get(raw, 'job', 'retry', 'backoffBaseMs')) ?? 1_000),
      },
      jobMemoryLimitBytes: clamp('advanced.jobMemoryLimitBytes', 67_108_864, 17_179_869_184, n(get(raw, 'job', 'memory', 'defaultMaxRssBytes')) ?? 268_435_456),
      transferCaps: {
        maxPushBytes: n(get(raw, 'transfer', 'maxPushBytes')) ?? 536_870_912,
        maxPullBytes: n(get(raw, 'transfer', 'maxPullBytes')) ?? 536_870_912,
        maxArchiveBytes: clamp('advanced.transferCaps.maxArchiveBytes', 1_048_576, 4_294_967_295, n(get(raw, 'transfer', 'maxArchiveBytes')) ?? 2_147_483_648),
      },
      installTimeoutMs: clamp('advanced.installTimeoutMs', 10_000, 1_800_000, n(get(raw, 'transfer', 'installTimeoutMs')) ?? 120_000),
      adbHealthIntervalSec: clamp('advanced.adbHealthIntervalSec', 5, 300, n(get(raw, 'adbControl', 'healthIntervalSec')) ?? 30),
      failuresBeforeQuarantine: clamp('advanced.failuresBeforeQuarantine', 1, 20, n(get(raw, 'health', 'consecutiveFailures')) ?? 5),
      wallWanBandwidthBps: 20_000_000,
      recoveryResetsPerHour: clamp('advanced.recoveryResetsPerHour', 1, 20, n(get(raw, 'guestAgent', 'maxRecoveryCyclesPerHour')) ?? 6),
    },
  }

  for (const c of clamps) log.warn(`settings: ${c.path} was ${String(c.from)}, outside the new range; clamped to ${String(c.to)}`)

  const parsed = FarmSettingsSchema.safeParse(next)
  if (parsed.success) return parsed.data
  log.warn(`settings: the stored row could not be migrated (${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}); starting from defaults`)
  return FarmSettingsSchema.parse({})
}
```

The code above is the transform, not a paste: `get()` returns `unknown`, so each read needs its own narrowing before it can be assigned (the `n()` helper does it for numbers; do the same for the enum and string reads rather than casting the whole object). The shape of `next` and every mapping in it are the specification and must not change.

Test cases, in `packages/core/src/settings/migrate-settings.test.ts` (§7.1):

| # | Input | Expected |
|---|---|---|
| 1 | the full pre-212 blob captured from `defaultFarmSettings()` as of `74fa69d` (checked in as `packages/core/src/settings/__fixtures__/farm-settings-0.1.32.json`) | parses; `general.deviceLabel === 'off'`; `privacy.adbCommand === true`; `jobRunner.resetPolicy === 'always'`; `capture.controlQuality === 'sharp'`; no clamp is logged |
| 2 | that blob with 60 unknown extra keys | identical result; no throw |
| 3 | `{ retention: { traceDays: 9999 }, battery: { tempThresholdC: 300 } }` | `storage.traceDays === 3650`, `devices.tempThresholdC === 90`, exactly two `log.warn` lines, each naming its path and both numbers |
| 4 | `{ defaults: { timing: { profile: 'instant' } } }` | `jobRunner.touchProfile === 'precise'` |
| 5 | `{ shell: { mode: 'off' } }` and `{ shell: { mode: 'operator' } }` | `privacy.adbCommand === false` and `=== true` |
| 6 | a value already in the new shape (`{ general: { name: 'x', deviceLabel: 'number' }, … }`) | returned unchanged, no warn |

**Do not** write a Drizzle migration; nothing about the table changes. **Do not** keep the old silent `?? defaultFarmSettings()` fallback at `farm-settings.ts:27-28` - the only path that discards data must log why.

### 4.9 The design handoff's Settings measurements, quoted

From `docs/mvp/design_handoff_enkaku_openpf/README.md:414-444`, verbatim. Plan 219 builds this; the plan below only has to produce a schema whose sections and hints it can render.

> ## Screen: Settings
>
> Two columns inside the panel.
>
> **Left nav** — `width: 236px`, `border-right: 1px solid var(--line)`, `padding: 12px 10px 16px`.
> Items: `padding: 8px 10px`, `border-radius: 9px`, 12.5px, icon 15px in an 18px box; active =
> `var(--accent-soft)`/`var(--accent)`/600. Group headings are non-interactive: 11px/600 `var(--faint)`,
> `padding: 14px 10px 6px`, `border-top: 1px solid var(--line)`, `margin-top: 8px`.
>
> Order: **General** · *Connection* (Host & daemon, ADB transport, Network scan) · *Automation*
> (Job runner, Capture & replay, Scripts) · *Storage* (Artifacts, Retention) · *Farm* (Clusters, Privacy,
> Appearance).
>
> **Right pane** — `max-width: 720px`, `padding: 18px 22px 28px`. Each section: a 19px/600 title with a
> `border-bottom: 1px solid var(--line)`, an optional intro paragraph (12.5px `var(--dim)`), then fields
> `padding-top: 14px`:
> - *Text field*: 12.5px/600 label, then an input (`padding: 9px 12px`, `border-radius: 9px`,
>   `border: 1px solid var(--border-2)`, `background: var(--panel-2)`; `Geist Mono` for paths/addresses)
>   with optional trailing buttons (Rename, Test, Rotate, Browse, Scan now, Open, Add) and an 11.5px
>   `var(--faint)` hint below.
> - *Checkbox*: 16×16 accent box + 12.5px/600 label + 11.5px `var(--faint)` explanation.
> - *Choice*: label then option buttons (`padding: 7px 12px`, `border-radius: 9px`; selected =
>   `border-color: var(--accent)`, `background: var(--accent-soft)`, 600).

Four differences between that nav order and §3.4's, each already argued in §3.3 decision 9: **ADB transport**, **Scripts**, **Clusters** (Groups) and **Appearance** have no field left after MVP 12's classification and are not built; **Artifacts** and **Retention** merge into one Retention section; **Access** is added, because MVP 12 §1 puts users and API tokens in Settings. The 11.5px hint below a text field is what `ui({ hint })` (§4.2) feeds.

### 4.10 Every default this plan changes

No default changes silently. This is the complete list.

| Setting | Old path and default | New path and default | Why |
|---|---|---|---|
| Trace retention | `retention.traceDays` = 30 days | `storage.traceDays` = **7 days** | MVP 09 §6 ("trace frames 7 days"). Traces are the largest thing on disk |
| Retention on/off | `retention.enabled` = `false` | gone; the sweep always runs | MVP 09 §6 makes retention a nightly sweeper, not an opt-in. A farm that never enabled it now sweeps; the first sweep after upgrade can be large (§8 risk R2) |
| Infrastructure retries | `job.retry.maxInfraAttempts` = 2 | `advanced.infraRetry.attempts` = **3** | MVP 12 §2 |
| Retry backoff base | `job.retry.backoffBaseMs` = 2 000 ms | `advanced.infraRetry.backoffBaseMs` = **1 000 ms** | MVP 12 §2 |
| Default job memory limit | `job.memory.defaultMaxRssBytes` = `null` (no limit) | `advanced.jobMemoryLimitBytes` = **268 435 456** (256 MB) | MVP 12 §2. A script that quietly used more than 256 MB is now killed; §8 risk R1 |
| Install timeout | `transfer.installTimeoutMs` = 300 000 ms | `advanced.installTimeoutMs` = **120 000 ms** | MVP 12 §2 |
| adb health probe interval | `adbControl.healthIntervalSec` = 15 s | `advanced.adbHealthIntervalSec` = **30 s** | MVP 12 §2 |
| Failures before quarantine | `health.consecutiveFailures` = 3 | `advanced.failuresBeforeQuarantine` = **5** | MVP 12 §2 |
| Recovery resets per hour | `guestAgent.maxRecoveryCyclesPerHour` = 4 | `advanced.recoveryResetsPerHour` = **6** | MVP 12 §2 |
| Concurrent installs | `adb.maxInstallConcurrent` = 2, farm-wide | `advanced.installsPerUsbRoot` = **1, per USB root** | MVP 12 §2; the unit changes, §9 Q2 |
| Reset before each job | `job.resetPolicy` = `'home'` (of four levels) | `jobRunner.resetPolicy` = `'always'` (of three) | MVP 12 §1's three-value enum. `home` maps to `always`, so behaviour is unchanged for a farm on the default |
| Touch profile | `defaults.timing.profile` = `'natural'` (of two) | `jobRunner.touchProfile` = `'natural'` (of three) | MVP 12 §1. `instant` maps to `precise`; the tuples behind `natural` are byte-identical to today's |
| Egress probe endpoint | `ENKAKU_NETWORK_PROBE_URL` only | `hostDaemon.egressProbeUrl`, falling back to that env var | MVP 12 §1; plan 51 §5.3's own follow-up |

Every other value in §4.1 keeps the number it has today.

## 5. Implementation steps

Steps are ordered so `bun run typecheck` is meaningful after each one except 212.3, whose breakage 212.4 to 212.8 repair. Read every file before editing it and match on the quoted content, not the line number.

### 212.1 Add `hint` to the hint vocabulary

- **Files changed**: `packages/protocol/src/schema/vocabulary.ts` (§4.2's three edits).
- **Test file**: `packages/protocol/src/schema/vocabulary.test.ts` - add one case: `readHints({ 'x-enkaku': { hint: 'Raise this if …' } }).hint` is the string, and `readHints({ 'x-enkaku': { hint: 42 } }).hint` is `undefined` (the whole object fails `safeParse` and `readHints` returns `{}`).
- **Verifiable result**: `bun test packages/protocol/src/schema/vocabulary.test.ts` passes.
- **Do not** widen `ui()`'s overload signatures; they already accept `Omit<ParamHints, 'kind' | 'unit' | 'extensions'>`.

### 212.2 Create `packages/core/src/config/constants.ts` and the support-override section of `.env.example`

- **Files created**: `packages/core/src/config/constants.ts` (§4.4 in full), `packages/core/src/config/constants.test.ts`.
- **Files changed**: `packages/core/src/config.ts` (add `import './config/constants'` as the first import); `packages/core/src/index.ts` (wrap `const cfg = loadConfig()` per §4.4); `.env.example`.
- `.env.example` gains one new section, inserted after the "Toolchain" block (`.env.example:146-148`) and before "adb" (`:154`), in the file's own comment style:

```
# ── Support overrides ──────────────────────────────────────────────────────────
# Values that used to be settings and are now constants (docs/plans/212-mvp-settings.md).
# None of these appears in Studio. Set one only when support asks you to; an invalid value
# fails the boot with E_BAD_CONFIG rather than falling back. `none` means "unset" for the
# three that accept it (ENKAKU_JOB_MAX_TIMEOUT_MS, ENKAKU_JOB_MEMORY_MAX_BYTES,
# ENKAKU_GEO_PROVIDER_URL).
# ENKAKU_TOUCH_PROFILES=                        # JSON, the three profiles' tuples
# ENKAKU_DEVICE_SCREEN_OFF_TIMEOUT_MS=1800000
...one commented line per constant in §4.4, in the same order, with its default as the value...
```

- **Test file**: `packages/core/src/config/constants.test.ts` with three cases:
  1. `every override name appears in .env.example` - read `.env.example`, read this plan's own list by reading `constants.ts`'s source and extracting every `'ENKAKU_[A-Z0-9_]+'` string literal, and assert each appears in `.env.example`. This is the G5 check and it is the reason the list cannot rot.
  2. `an out-of-range override throws E_BAD_CONFIG` - set `ENKAKU_ADB_TCP_PORT=70000`, re-import the module with a cache-busting query (`await import('./constants.ts?bust=' + Math.random())`), assert the thrown error is an `EnkakuError` with `code === 'E_BAD_CONFIG'` and a message naming `ENKAKU_ADB_TCP_PORT`.
  3. `an applied override is reported` - set `ENKAKU_WALL_DECODE_TILE_CEILING=32`, re-import, assert the constant is 32 and `appliedSupportOverrides().get('ENKAKU_WALL_DECODE_TILE_CEILING') === '32'`.
- **Verifiable result**: `bun test packages/core/src/config/constants.test.ts` passes; G5 and G6 turn green.
- **Do not** read an override anywhere but this file, and do not give any constant a value that differs from the default in §4.1 unless §4.10 lists the change.

### 212.3 Rewrite the protocol schemas

- **Files created**: `packages/protocol/src/timing.ts` (`TimingSettingsSchema` and `TimingSettings`, moved from `settings.ts:53-115` with every `ui(...)` and `.meta({ title })` stripped - it is a runtime shape now, not a form), `packages/protocol/src/agent-settings.ts` (§4.7).
- **Files changed**: `packages/protocol/src/settings.ts` (rewritten to §4.3 plus §4.6; it must end under 600 lines), `packages/protocol/src/index.ts` (drop every export named in §4.6's deletion list; add `ControlQualitySchema`, `ControlQuality`, `WallQualitySchema`, `WallQuality`, `DeviceLabelSchema`, `DeviceLabel`, `TouchProfileSchema`, `TouchProfile`, `ResetPolicySchema`, `ResetPolicy`, `OverControlSchema`, `OverControl`, `SCAN_MAX_ADDRESSES`, `resolveDeviceSetting`, and everything from `./timing` and `./agent-settings`), `packages/protocol/src/api/devices.ts` (`:881`, `:905`, `:945` per §4.6).
- **Files deleted**: none.
- **Test file**: `packages/protocol/src/settings.test.ts`, rewritten. It is 74.6 KB today and asserts fields that no longer exist. Keep only what plan 200 §8.3 calls critical - the schema contract - as these cases: `top-level keys are the nine sections, in order`; `device settings are engines, identity, prep and optional overrides`; `defaults round-trip` (`FarmSettingsSchema.parse(defaultFarmSettings())` deep-equals `defaultFarmSettings()`); `an unknown key is stripped, never rejected`; `resolveDeviceSetting prefers the device value and falls back to the farm one` (one case per override key); `z.toJSONSchema(FarmSettingsSchema) does not throw` (the settings route depends on it and a `.transform()` anywhere would break it); `every visible and advanced field carries a hint or a description`.
- **Verifiable result**: `bun test packages/protocol/src/settings.test.ts` passes; `rg -c 'ui\(\{ title:' packages/protocol/src/settings.ts` prints `26`; `wc -l < packages/protocol/src/settings.ts` is ≤ 600. G1, G2, G3, G8 turn green. `bun run typecheck` fails at this point, in `packages/core` and `packages/studio` - that is expected and is repaired by 212.4 to 212.8.
- **Do not** keep a deleted key with a deprecation comment, do not keep `normaliseLegacyAdb` or `normaliseLegacyWall`, and do not add a `.transform()` anywhere in the file (`z.toJSONSchema` throws on one - the reason `normaliseLegacyPrep` is a `z.preprocess`, `settings.ts:117-128`).

### 212.4 Rewire every core reader

One edit per row. Each replaces a settings read with a constant import from `../config/constants` (path relative to the file) or with the new field path.

| File and line as of 2026-09-03 | Content to match | Now |
|---|---|---|
| `daemon.ts:615` | `drainTimeoutMs: () => settingsStore.get().adbControl.drainTimeoutMs,` | `drainTimeoutMs: () => ADB_DRAIN_TIMEOUT_MS,` |
| `daemon.ts:683`, `:4423`, `:4484` | `settings: () => settingsStore.get().discovery,` | `settings: () => discoveryConstants(settingsStore.get())` - a local helper in `daemon.ts` returning `{ scanIntervalSec: DEVICE_RESCAN_INTERVAL_SEC, offlineGraceSec: DEVICE_OFFLINE_GRACE_SEC, recoveryCooldownSec: DEVICE_RECOVERY_COOLDOWN_SEC, tcpPort: ADB_TCP_PORT, endpointsPerDevice: DEVICE_ENDPOINTS_REMEMBERED, endpointRetireAfter: DEVICE_ENDPOINT_RETIRE_AFTER, connectSettleMs: DEVICE_CONNECT_SETTLE_MS, networks: s.networkScan.networks, scan: { mode: SCAN_MODE, maxAddresses: SCAN_MAX_ADDRESSES, concurrency: SCAN_CONCURRENCY, probeTimeoutMs: SCAN_PROBE_TIMEOUT_MS }, cutover: { armWindowSec: CUTOVER_WINDOW_SEC, armPollSec: CUTOVER_POLL_SEC } }`, so no consumer module has to change |
| `daemon.ts:708`, `:753` | `settings: () => settingsStore.get().adb`, `const cfg = settingsStore.get().adb` | `{ maxConcurrent: s.advanced.adbMaxConcurrent, maxStreamsPerDevice: ADB_MAX_STREAMS_PER_DEVICE, maxStreams: ADB_MAX_STREAMS_FARM, maxHostConcurrent: ADB_MAX_HOST_PROCESSES, maxInstallConcurrent: s.advanced.installsPerUsbRoot }` through a second local helper `adbConstants(s)` |
| `daemon.ts:988`, `:1600`, `:2856`, `:2864`, `:2979`, `:2996`, `:3044`, `:3052`, `:3609` | `shellSettings: () => settingsStore.get().shell` / `settings: () => settingsStore.get().shell` | a third helper `shellConstants(s)` returning `{ mode: s.privacy.adbCommand ? 'operator' : 'off', execTimeoutMs: SHELL_EXEC_TIMEOUT_MS, maxOutputBytes: SHELL_MAX_OUTPUT_BYTES, endpointEnabled: ADB_ENDPOINT_ENABLED, endpointBind: ADB_ENDPOINT_BIND, endpointIdleSec: ADB_ENDPOINT_IDLE_SEC, maxEndpointStreams: ADB_ENDPOINT_MAX_STREAMS }` |
| `daemon.ts:2017`, `:2074`, `:2961`, `:3034`, `:3221` | `shellMode: () => settingsStore.get().shell.mode` | `shellMode: () => (settingsStore.get().privacy.adbCommand ? 'operator' : 'off')` |
| `daemon.ts:1051`, `:2144`, `:4082` | `maxFileBytes: () => settingsStore.get().transfer.maxPushBytes` | `maxFileBytes: () => settingsStore.get().advanced.transferCaps.maxPushBytes` |
| `daemon.ts:1244`, `:2865`, `:2970` | `settings: () => settingsStore.get().transfer`, `transferSettings`, `archiveSettings` | `transferConstants(s)` = `{ enabled: TRANSFER_ENABLED, maxPushBytes: s.advanced.transferCaps.maxPushBytes, maxPullBytes: s.advanced.transferCaps.maxPullBytes, installTimeoutMs: s.advanced.installTimeoutMs, maxArchiveBytes: s.advanced.transferCaps.maxArchiveBytes }` |
| `daemon.ts:2018`, `:2074`, `:2962`, `:3035`, `:3222` | `transferEnabled: () => settingsStore.get().transfer.enabled` | `transferEnabled: () => TRANSFER_ENABLED` |
| `daemon.ts:1391`, `:4157` | `timeoutIsInfra: … settingsStore.get().job.retry.timeoutIsInfra` | `JOB_TIMEOUT_IS_INFRA` |
| `daemon.ts:1392` | `rebindOnInfra: () => settingsStore.get().job.retry.rebindOnInfra,` | `JOB_REBIND_ON_INFRA` |
| `daemon.ts:1410` | `maxResultBytes: () => settingsStore.get().job.maxResultBytes,` | `JOB_MAX_RESULT_BYTES` |
| `daemon.ts:1689` | `createKvStore(db, cfg.dataDir, () => settingsStore.get().kv)` | `createKvStore(db, cfg.dataDir, () => ({ maxValueBytes: KV_MAX_VALUE_BYTES, maxKeyLength: KV_MAX_KEY_LENGTH, maxEntriesPerNamespace: KV_MAX_ENTRIES_PER_NAMESPACE, maxEntriesPerDevice: KV_MAX_ENTRIES_PER_DEVICE }))` |
| `daemon.ts:1870` | `triggerBudgets: () => settingsStore.get().job.trigger,` | `() => ({ maxDepth: JOB_TRIGGER_MAX_DEPTH, maxPerChain: JOB_TRIGGER_MAX_PER_CHAIN, maxPerJob: JOB_TRIGGER_MAX_PER_JOB })` |
| `daemon.ts:1941` | `maxHot: () => settingsStore.get().readiness.maxHot,` | `READINESS_MAX_HOT` |
| `daemon.ts:2011`, `:2947`, `:3219` | `farmJobSettings: () => settingsStore.get().job,` | `jobConstants(s)` = the pre-212 `JobSettings` object built from the constants plus `resetPolicy` mapped back (`never`→`'none'`, `always`→`'home'`, `on-failure`→`'declared'`) and `defaultTimeoutMs` from `s.jobRunner`, so the job runner does not change shape in this plan (plan 211 owns that shape) |
| `daemon.ts:2079`, `:3024`, `:3259` | the three agent reads | §4.7's table |
| `daemon.ts:2267` | `networkSettings: () => settingsStore.get().network,` | `() => ({ geoProvider: GEO_PROVIDER_URL ?? undefined, geoIntervalSec: GEO_RECHECK_INTERVAL_SEC })` |
| `daemon.ts:2272`, `:2319` | `guestAgentSettings`, `provision` | `() => ({ provision: GUEST_AGENT_PROVISION, maxRecoveryCyclesPerHour: settingsStore.get().advanced.recoveryResetsPerHour, recoveryRearmSec: GUEST_AGENT_RECOVERY_REARM_SEC })` and `() => GUEST_AGENT_PROVISION` |
| `daemon.ts:2387`, `:2389` | `Math.max(1, settingsStore.get().adb.maxInstallConcurrent)` | `Math.max(1, settingsStore.get().advanced.installsPerUsbRoot)` |
| `daemon.ts:2456` | `maxConcurrent: () => settingsStore.get().labelling.maxConcurrent,` | `LABEL_WRITE_CONCURRENCY` |
| `daemon.ts:2473` | `createWorkspaceStore(db, () => settingsStore.get().workspace, {` | `() => ({ maxFileBytes: WORKSPACE_MAX_FILE_BYTES, maxFilesPerScope: WORKSPACE_MAX_FILES_PER_SCOPE, maxTotalBytesPerScope: WORKSPACE_MAX_BYTES_PER_SCOPE, inlineMaxBytes: WORKSPACE_INLINE_MAX_BYTES })` |
| `daemon.ts:2531`, `:2651`, `:2853`, `:2910`, `:2924`, `:4316` | `networks: () => settingsStore.get().discovery.networks` (and the one non-lambda at `:2651`) | `settingsStore.get().networkScan.networks` |
| `daemon.ts:2594` | `settings: () => settingsStore.get().recording,` | `() => ({ anchorQuietMs: RECORDING_ANCHOR_QUIET_MS, anchorMinIntervalMs: RECORDING_ANCHOR_MIN_INTERVAL_MS, longPressMs: RECORDING_LONG_PRESS_MS, maxSteps: RECORDING_MAX_STEPS, maxDurationSec: RECORDING_MAX_DURATION_SEC, captureScreenshots: RECORDING_CAPTURE_SCREENSHOTS })` |
| `daemon.ts:2732` | `restartCooldownSec: () => settingsStore.get().adbControl.restartCooldownSec,` | `ADB_RESTART_COOLDOWN_SEC` |
| `daemon.ts:2783`, `:4302` | `deviceDefaults: () => settingsStore.get().defaults,` | delete the dep; `defaultsForNewDevice` (`packages/core/src/registry/admission.ts`, `device-registry.ts`) uses `defaultDeviceSettings()` |
| `daemon.ts:2784`, `:4303` | `defaultDesiredReadiness: () => settingsStore.get().readiness.defaultDesired,` | `READINESS_DEFAULT_DESIRED` |
| `daemon.ts:3059` | `auto: () => settingsStore.get().adb.maxConcurrent === 0,` | `() => settingsStore.get().advanced.adbMaxConcurrent === 0` |
| `daemon.ts:3103`, `:3105`, `:3110` | `settingsStore.get().wall.*`, `computeAutoTiles(resolveVideoProfile(settingsStore.get().video, null, 'wall').bitRate, {…})` | the wall budget from `WALL_MAX_TILES`, `WALL_RAMP_CONCURRENCY`, `WALL_DECODE_TILE_CEILING`, `WALL_LAN_BANDWIDTH_BPS`, `WALL_TRANSPORT_OVERRIDE` and `settingsStore.get().advanced.wallWanBandwidthBps`; the profile from `resolveVideoProfile({ controlQuality, wallQuality }, null, 'wall')` (§212.5) |
| `daemon.ts:3108` | `maxConcurrentBuilds: settingsStore.get().session.maxConcurrentBuilds,` | `settingsStore.get().advanced.sessionBuildsPerUsbRoot` (plan 206 may already have renamed the field; if so, only the path changes) |
| `daemon.ts:3171`, `:4253` | `settings: () => settingsStore.get().workflow` | `() => ({ maxTotalMs: WORKFLOW_MAX_TOTAL_MS })` |
| `daemon.ts:3638` | `crashPolicy: () => settingsStore.get().job.crashPolicy,` | `JOB_CRASH_POLICY` |
| `daemon.ts:3642` | `crashWatch: () => settingsStore.get().monitor.crashWatch,` | `CRASH_WATCH` |
| `daemon.ts:3909` | `resolveProfile: (deviceId, quality) => resolveVideoProfile(settingsStore.get().video, deviceSource.get(deviceId)?.video ?? null, quality)` | `resolveVideoProfile(settingsStore.get().capture, deviceSource.get(deviceId)?.overrides ?? null, quality)` |
| `daemon.ts:3913` | `maxConcurrentBuilds: () => settingsStore.get().session.maxConcurrentBuilds,` | `() => settingsStore.get().advanced.sessionBuildsPerUsbRoot` |
| `daemon.ts:3934`, `:3935` | `arbiterQueueWaitMs`, `arbiterMaxQueueDepth` | `INPUT_WAIT_BUDGET_MS`, `INPUT_MAX_QUEUE_DEPTH`. If plan 205 already replaced these with literals in `packages/core/src/server/input-arbiter.ts`, move those literals into `constants.ts` instead and record it in §11 |
| `daemon.ts:3938` | `fallbackRetryCount: () => settingsStore.get().display.fallbackRetryCount,` | `DISPLAY_FALLBACK_RETRIES` |
| `daemon.ts:4142` | `resetPolicy: () => settingsStore.get().job,` | the same `jobConstants(s)` helper |
| `daemon.ts:4186` | `timing: () => settingsStore.get().defaults.timing,` | `() => TOUCH_PROFILES[settingsStore.get().jobRunner.touchProfile]` |
| `daemon.ts:4444`, `:4445`, `:4464`, `:4465`, `:4466` | the five inline `settingsStore.get().discovery.*` reads | the matching constants |
| `daemon.ts:4513` | `settings: () => settingsStore.get().adbControl,` | `() => ({ healthIntervalSec: settingsStore.get().advanced.adbHealthIntervalSec, stuckTimeoutRate: ADB_TIMEOUT_STORM_RATE, restartCooldownSec: ADB_RESTART_COOLDOWN_SEC, drainTimeoutMs: ADB_DRAIN_TIMEOUT_MS })` |
| `packages/core/src/device/battery.ts` | `const cfg = deps.settings.get().battery`, `deps.settings.get().battery.pollIntervalSec * 1000` | `BATTERY_POLL_INTERVAL_SEC`, `DEVICE_AUTO_QUARANTINE`, and `deps.settings.get().devices.tempThresholdC` for the threshold |
| `packages/core/src/device/health.ts` | `const cfg = deps.settings.get().health`, `deps.settings.get().health.probeIntervalSec * 1000` | `DEVICE_RECOVERY_PROBE_INTERVAL_SEC`, `DEVICE_AUTO_QUARANTINE`, and `deps.settings.get().advanced.failuresBeforeQuarantine` |
| `packages/core/src/agent/blob/gc.ts` | `deps.settings.get().retention.blobOrphanGraceHours` | `BLOB_ORPHAN_GRACE_HOURS` |
| `packages/core/src/maintenance/retention.ts:64-108` | `policy.eventMainDays`, `policy.eventInputDays`, `policy.eventMaxRowsPerDevice` | `deps.settings.get().storage.historyDays`, `INPUT_EVENT_RETENTION_DAYS`, `EVENT_MAX_ROWS_PER_DEVICE` |
| `packages/core/src/maintenance/retention.ts:164-204` | `policy.traceDays` | `deps.settings.get().storage.traceDays` |
| `packages/core/src/maintenance/retention.ts:205-244` | `if (!policy.enabled) return …`, `policy.maxAgeDays`, `policy.maxTotalGb` | delete the `enabled` guard; read `storage.artifacts.maxAgeDays` / `.maxTotalGb` |
| `packages/core/src/device/labelling.ts:191`, `:275`, `:317`, `:367`, `:383`, `:390`, `:399`, `:404` | `settings.labelling.mode`, `settings.labelling.showName` | `resolveDeviceSetting(farm, row, 'deviceLabel')` for the content and `DEVICE_LABEL_SURFACE` for the surface; `showName` becomes `label !== 'number'` |
| `packages/core/src/doctor/checks/labelling.ts` | `settingsParsed.data.labelling.mode` | `settingsParsed.data.overrides.deviceLabel ?? farm.general.deviceLabel` |
| `packages/core/src/session/adapters.ts:42-44` | `preferredInputMode: (row.settings as …)?.input?.preferredMode ?? 'uhid'` | derive from `engines.input`: `scrcpy-uhid` → `'uhid'`, `scrcpy-sdk` and `adb-input` → `'sdk'` |
| `packages/core/src/network/route-service.ts:153-155` | `function probeUrl(): string | null { return process.env.ENKAKU_NETWORK_PROBE_URL?.trim() || null }` | read `settings().hostDaemon.egressProbeUrl` first and fall back to the env var; the function gains a `settings` accessor from `daemon.ts:2267`'s wiring |
| `packages/core/src/settings/farm-settings.ts:40` | `if (opts?.authMode === 'server') cached = { ...cached, shell: { ...cached.shell, mode: 'off' } }` | `cached = { ...cached, privacy: { ...cached.privacy, adbCommand: false } }` |

- **Test file**: `packages/core/src/settings/farm-settings.test.ts` (exists) - update to the new schema; keep only the server-mode default case and the partial-merge case.
- **Verifiable result**: `bun run typecheck` is clean for `packages/core`; `bun test packages/core/src/settings/` passes.
- **Do not** thread a constant through a new dependency into `packages/session`, `packages/adb`, or `packages/drivers` - every one of those consumers already takes an accessor, and the accessor is what changes.

### 212.5 Video profile resolution becomes preset-only

- **Files changed**: `packages/session/src/video-profile.ts`. `resolveVideoProfile` (`:86-120`) becomes:

```ts
export function resolveVideoProfile(
  farm: { controlQuality: ControlQuality; wallQuality: WallQuality },
  device: { controlQuality?: ControlQuality; wallQuality?: WallQuality } | null,
  quality: Quality,
): VideoProfile {
  if (quality === 'control') {
    const name = device?.controlQuality ?? farm.controlQuality
    const numbers = CONTROL_PRESETS[name]
    return { quality, ...numbers, source: sourceFor(device?.controlQuality !== undefined) }
  }
  const name = device?.wallQuality ?? farm.wallQuality
  const numbers = WALL_PRESETS[name]
  return { quality, ...numbers, source: sourceFor(device?.wallQuality !== undefined) }
}

const sourceFor = (fromDevice: boolean): VideoProfile['source'] => {
  const s: VideoSource = fromDevice ? 'device' : 'preset'
  return { maxSize: s, maxFps: s, bitRate: s }
}
```

  `VideoSource` becomes `'preset' | 'device'` - `'farm'` had exactly one meaning ("an operator typed a number into the Advanced reveal", `video-profile.ts:64-76`) and there is no longer a number to type. `sourceOf` (`:73-76`) is deleted. `WALL_VIDEO_BUDGET_BPS` (`:138`) is deleted; `computeAutoTiles`'s budget argument is now always supplied by the caller (§212.4's `daemon.ts:3110` row), with the WAN branch taking `advanced.wallWanBandwidthBps` and loopback/LAN taking `WALL_LAN_BANDWIDTH_BPS`. `CONTROL_PRESETS` (`:13-17`) and `WALL_PRESETS` (`:48-53`) are unchanged, values included.
- **Test file**: `packages/session/src/video-profile.test.ts` - rewritten to the preset-only model. Keep: each preset name resolves to its exact table row; a device override wins and reports `'device'`; `computeAutoTiles` returns the min of the decode and bandwidth bounds and pins the WAN branch to the value it is given.
- **Verifiable result**: `bun test packages/session/src/video-profile.test.ts` passes.
- **Do not** keep a numeric override path "in case a farm stored one" - the migration in §4.8 drops those keys, and a farm that had them keeps the preset they were derived from.

### 212.6 The settings store reads through the migration

- **Files created**: `packages/core/src/settings/migrate-settings.ts` (§4.8), `packages/core/src/settings/migrate-settings.test.ts`, `packages/core/src/settings/__fixtures__/farm-settings-0.1.32.json`.
- **Files changed**: `packages/core/src/settings/farm-settings.ts` - `:26-28` becomes `const row = …; cached = row ? migrateFarmSettings(row.value, log) : defaultFarmSettings()`, and the store takes a `log` in `opts`. When the row was migrated (that is, when `get(raw, 'general')` was undefined), the migrated value is written straight back with `db.update(...)` so the migration runs once, not on every boot.
- **Test file**: `packages/core/src/settings/migrate-settings.test.ts`, the six cases of §4.8.
- **Verifiable result**: `bun test packages/core/src/settings/migrate-settings.test.ts` passes with 6 cases; G7 turns green.
- **Do not** run the migration inside a Drizzle migration file - the value is JSON in one column, the transform needs the Zod schema, and `db:generate` produces SQL.

### 212.7 Agent settings move out of farm settings

- **Files created**: `packages/core/src/settings/agent-settings.ts`, `packages/core/src/api/agent-settings.test.ts`.
- **Files changed**: `packages/core/src/api/agents.ts` (the two routes of §4.7, registered before `app.get('/:id')` at `:34`), `packages/core/src/daemon.ts` (`:3249` gains the store; the three reader rows of §4.7), `packages/protocol/src/index.ts` (export `./agent-settings`).
- **Test file**: `packages/core/src/api/agent-settings.test.ts` - GET returns defaults on a fresh database; PATCH of `{ scheduled: { maxConcurrentScheduledRuns: 5 } }` returns 200 and a GET reads 5 back; PATCH of `{ scheduled: { maxConcurrentScheduledRuns: 0 } }` returns 400 with `maxConcurrentScheduledRuns` in the message; `GET /api/agents/settings` does not resolve as `GET /api/agents/:id`.
- **Verifiable result**: `bun test packages/core/src/api/agent-settings.test.ts` passes; G9 turns green.
- **Do not** create a new table; row 2 of `farm_settings` is the store.

### 212.8 Studio compiles against the new schema

- **Files changed**: `packages/studio/src/components/settings/farmSections.ts` (rewritten to §4.5), `packages/studio/src/app/settings/page.tsx` (§4.5's table), `packages/studio/src/components/video/video-quality.ts` (reduced per §4.5), `packages/studio/src/components/device-popup/SettingsPopup.tsx`, `packages/studio/src/app/device/page.tsx`, `packages/studio/src/components/BulkPrepDialog.tsx` (§4.6's last paragraph), `packages/studio/src/components/wall/useLiveSet.ts` and `components/wall/Wall.tsx` (comment references to `wall.maxTiles` become references to the constant; no logic change), `packages/studio/src/lib/api.ts` if it names a removed type.
- **Files deleted**: `packages/studio/src/components/video/FarmVideoFields.tsx`, `packages/studio/src/components/video/DeviceVideoFields.tsx`. Their `.test.tsx` files are already gone (plan 201).
- **Test file**: none. **Studio has zero tests (plan 200 §8.3).** Do not add one, do not restore `farmSections.test.ts`.
- **Verifiable result**: `bun run typecheck` exits 0 for the whole workspace; `rg -n "FARM_SECTION_DEFS" packages/studio/src` prints nothing. G10 and G11 turn green.
- **Do not** keep a `id === '<removed section>'` branch "in case the section comes back", and do not leave an unused import behind - `bun run typecheck` is the check that catches both.

### 212.9 Documentation and the removal gate

- **Files changed**: `packages/core/README.md` (the settings section: nine keys, the constants file, the support-override rule), `packages/protocol/README.md` (the settings exports list), `docs/guide/install.md` (a paragraph naming `.env.example`'s Support overrides section and saying that none of it appears in Studio), `CLAUDE.md` (one line under "Rules that get broken when you do not know them": *a value that does not differ between farms is a constant in `packages/core/src/config/constants.ts` with an `ENKAKU_*` override in `.env.example`, never a settings field*).
- **Verifiable result**: `GREP_212` (§10) prints nothing; every §10 row's proof command passes. G4 turns green.
- **Do not** edit `docs/spec.md` - plan 202 rewrites it. **Do not** edit `docs/settings-audit.md` - plan 202 archives it.

## 6. Acceptance criteria

1. `rg -c 'ui\(\{ title:' packages/protocol/src/settings.ts` prints `26`, and `wc -l < packages/protocol/src/settings.ts` prints a number ≤ 600.
2. `FarmSettingsSchema` has the nine top-level keys of §3.4 in that order, each carrying a title and (except `general`) a group.
3. Every one of the eleven advanced settings carries a `hint` that is its "raise or lower if" sentence from MVP 12 §2.
4. `packages/core/src/config/constants.ts` exports every constant of §4.4 and is the only file in the workspace that reads an `ENKAKU_*` name introduced by this plan.
5. `.env.example` has a "Support overrides" section with one commented line per constant, and the §212.2 test proves the two lists match.
6. An invalid support override fails the boot with `E_BAD_CONFIG` naming the variable, never a silent fallback.
7. A settings row written by v0.1.32 migrates: renamed keys mapped, unknown keys dropped, out-of-range values clamped with one `warn` line each, and the migrated value written back once.
8. `DeviceSettingsSchema` has only `engines`, `identity`, `prep`, `autoReconnect`, `logInputText`, `instrumentation` and `overrides`; every field of `overrides` is optional, and `resolveDeviceSetting` is the only place the fallback is expressed.
9. `GET /api/agents/settings` returns `AgentSettings` plus its JSON Schema; `GET /api/settings` no longer carries `agentDefaults` or `scheduledAgents`.
10. Studio's Settings page derives its ten sections from the schema and typechecks; `FARM_SECTION_DEFS` no longer exists.
11. `GREP_212` prints nothing.
12. `bun run typecheck` exits 0.

## 7. Test plan

Scoped runs only, one invocation at a time, never concurrently (`CLAUDE.md`; plan 200 §2.3). No Studio test is written or run - Studio and `@enkaku/ui` have zero tests (plan 200 §8.3).

### 7.1 Automated, by the executor

```bash
bun run typecheck                                              # after every step; must be clean before the report
bun test packages/protocol/src/schema/vocabulary.test.ts       # 212.1
bun test packages/core/src/config/constants.test.ts            # 212.2 - 3 cases (G5, G6)
bun test packages/protocol/src/settings.test.ts                # 212.3 - the schema contract (G1, G3, G8)
bun test packages/core/src/settings                            # 212.4, 212.6 - the store and the migration (G7)
bun test packages/session/src/video-profile.test.ts            # 212.5
bun test packages/core/src/api/agent-settings.test.ts          # 212.7 (G9)
```

Nothing else is run. In particular `bun test packages/core` is **not** run: it is the suite `CLAUDE.md` forbids until plan 224.

### 7.2 What is deliberately not tested

Per plan 200 §8.3: the section list, the field titles, the hint sentences, the `.env.example` prose, the route wiring beyond the one 400 case, and every Studio component. `bun run typecheck` and the owner smoke cover them.

### 7.3 Removal greps

```bash
# GREP_212, defined in §10
rg -n "coControl|mirror\.|idleTtlSec|maxIdleSessions|maxConcurrentBuilds|commandRunsPerUser|disableAnimations|controlPreset|wallPreset" packages apps plugins scripts --glob '!packages/core/packs/**' --glob '!docs/archive/**'
rg -n "FARM_SECTION_DEFS|FarmDeviceDefaults|settingsStore\.get\(\)\.defaults" packages
test ! -e packages/studio/src/components/video/FarmVideoFields.tsx
test ! -e packages/studio/src/components/video/DeviceVideoFields.tsx
```

Each must print nothing (the two `test` commands must exit 0).

### 7.4 Manual smoke, on the owner's farm (the G12 row)

```bash
bun run reset && bun run dev                                   # a fresh farm
curl -s localhost:7700/api/settings | jq '.settings | keys'    # the nine keys of §3.4
curl -s localhost:7700/api/settings | jq '[.schema.properties | to_entries[] | .value.title]'   # nine titles
curl -s -X PATCH localhost:7700/api/settings -H 'content-type: application/json' \
  -d '{"general":{"name":"Owner farm","deviceLabel":"number"}}' | jq '.settings.general'
curl -s -X PATCH localhost:7700/api/settings -H 'content-type: application/json' \
  -d '{"devices":{"tempThresholdC":300}}' -o /dev/null -w '%{http_code}\n'   # 400
curl -s localhost:7700/api/agents/settings | jq '.settings | keys'           # ["defaults","scheduled"]
ENKAKU_ADB_TCP_PORT=70000 bun run dev                          # fails with [E_BAD_CONFIG] naming ENKAKU_ADB_TCP_PORT
```

Then, against the owner's existing `.dev-data` (a v0.1.32 row): start the core once and confirm the log carries the migration's warn lines and no others, then confirm `GET /api/settings` reports the farm's old temperature threshold, networks, and video presets under their new paths.

In the browser: open `/settings`, confirm ten left-nav entries in four group headings, open Advanced and confirm eleven fields each showing a default and a hint, change one field in each section and confirm each saves.

Every process is dead before the report: `ps -Ao pid=,command= | grep -i "[o]penpf"` shows nothing but the shell.

## 8. Risks and mitigations

| # | Risk | Mitigation |
|---|---|---|
| R1 | The new 256 MB default job memory limit kills a script that quietly used more (§4.10). Today the default is `null` - no limit at all | The migration carries a farm's own stored `job.memory.defaultMaxRssBytes` when it has one; only a farm that never set it gets 256 MB. `advanced.jobMemoryLimitBytes` is one field away in the Advanced disclosure, and the kill is logged with the limit. Called out for the owner in §7.4 |
| R2 | Retention stops being opt-in (§4.10). A farm that never enabled it has months of artifacts and traces, and the first sweep after upgrade deletes a large number of rows and files at once | Plan 224 owns the sweeper and must run the first sweep in chunks; this plan only supplies the settings. The trace sweep already chunks (`maintenance/retention.ts:193-204`). Record the row and byte counts of the first sweep on the owner's farm |
| R3 | `daemon.ts` is ~4 600 lines and is edited by several plans in the same stage (plan 200 §8.1 names it a shared file). A merge conflict is likely | Every edit in §212.4 is a one-line replacement matched on quoted content, so a conflict resolves line by line. This plan merges after 215–218 in stage 6 (plan number order), so it resolves rather than creates the conflicts |
| R4 | The `shell.mode` three-value enum becomes a boolean (F44). A farm that used `'operator'` to mean "operators may, admins may" and `'admin'` to mean "admins only" loses the middle distinction | `canUseShell(role, mode)` keeps its signature; `adbCommand: false` maps to `'off'` and `true` to `'operator'`, so an admin-only farm becomes operator-allowed. Named in §9 Q3 as the one behaviour change a human should confirm |
| R5 | `z.toJSONSchema(FarmSettingsSchema)` throws if any node uses `.transform()`, and the settings route (`api/settings.ts:20`) calls it on every GET | The `does not throw` case in §212.3's test file is the guard. `normaliseLegacyPrep` stays a `z.preprocess`, which `z.toJSONSchema` accepts (`settings.ts:117-128` records why) |
| R6 | Promoting ~70 values to constants moves them out of the farm's reach; a client who had tuned one loses it silently | The migration logs every value it drops that was not at its default. Add that to `migrateFarmSettings`: for each constant path, if the stored value differs from the constant, one `warn` line naming the path, the stored value, and the `ENKAKU_*` variable that can restore it |
| R7 | `packages/core/src/config/constants.ts` is evaluated at import, so a test that sets an env var after importing it sees the old value | Every case in `constants.test.ts` re-imports with a cache-busting query, as §212.2 states. Do not add a `reload()` export for production code to call |

## 9. Open questions

Only a human decides these. Every step above is executable with the stated default; nothing in §5 is blocked.

1. **Is the audit log's retention window a visible setting?** MVP 09 §6 gives it a default of 90 days; MVP 12 §1's visible list does not include it. This plan makes it the constant `AUDIT_RETENTION_DAYS = 90` (`ENKAKU_AUDIT_RETENTION_DAYS`) so the visible count is MVP 12's own 15. If the CEO wants it visible it becomes a sixteenth `storage` field, and G1's parameter becomes 27.
2. **Is "max concurrent installs" per USB root or farm-wide?** MVP 12 §2 says "1 per USB root"; the field it replaces (`adb.maxInstallConcurrent`, default 2) is farm-wide, and its consumer is a single farm-wide `Semaphore` (`daemon.ts:2387`). Making it per USB root is a scheduler change, not a settings change. This plan ships the field named `installsPerUsbRoot` with default 1 and leaves the semaphore farm-wide, which is the conservative reading; making the semaphore per-root belongs to plan 223 (MVP 09 §2, "Concurrent installs per USB root: serialised, never more than one"). Confirm that split.
3. **Does the adb command switch lose the admin-only setting?** F44 turns `shell.mode` (`off | admin | operator`) into `privacy.adbCommand` (boolean). A farm currently on `'admin'` becomes operator-allowed under the mapping in §4.8 case 5 unless the mapping is inverted to `'admin'`→`false`. MVP 12 §1 words the field as "Adb command action for operators: on or off", which reads as the on/off this plan ships; confirm which way `'admin'` maps.
4. **Where does Access live?** MVP 12 §1 says users and API tokens live in Settings; MVP 15 §0's nav does not draw them. This plan keeps them as the tenth section. If plan 219's design puts them elsewhere, `farmSections`'s spliced entry is the one line that changes.
5. **Should `appliedSupportOverrides()` appear in `bun run doctor`?** A support engineer debugging a farm wants to see which overrides are live. This plan exports the map and wires nothing; adding a doctor check is a one-line follow-up if the answer is yes.

## 10. Removed

`GREP_212`, cited by G4 and §7.3, is exactly:

```bash
rg -n "coControl|mirror\.|idleTtlSec|maxIdleSessions|maxConcurrentBuilds|commandRunsPerUser|disableAnimations|controlPreset|wallPreset" packages apps plugins scripts --glob '!packages/core/packs/**' --glob '!docs/archive/**'
```

It must print nothing. Note the case: `CONTROL_PRESETS` and `WALL_PRESETS` (`packages/session/src/video-profile.ts:13`, `:48`) survive and do not match - they are the preset tables, not settings.

Rows come from `docs/mvp/13-removal-register.md` A.7 plus the fields this plan's own §4.1 disposes of.

| What | Where it was | Proof |
|---|---|---|
| `FarmSettingsSchema.defaults` and `FarmDeviceDefaultsSchema` | `packages/protocol/src/settings.ts:1016`, `:1044` | `rg -n "FarmDeviceDefaults\|settingsStore\.get\(\)\.defaults" packages` → empty |
| `prep.disableAnimations` (DEAD, `docs/settings-audit.md` #4) | `settings.ts:437-441`, `protocol/src/api/devices.ts:881`, `:905`, `studio/src/components/BulkPrepDialog.tsx` | `rg -n "disableAnimations" packages apps plugins` → empty |
| per-device `video.controlPreset` / `video.wallPreset` (DEAD, audit #5) | `settings.ts:592-594`, `:598-600` | `rg -n "controlPreset\|wallPreset" packages` → empty |
| per-device `timing.*` (SHADOWED, audit #2) - 7 leaves | `settings.ts:432`, `TimingSettingsSchema` `:53-115` | `rg -n "settings\.timing\|deviceSettings\.timing\|defaults\.timing" packages` → empty |
| `shell.commandRunsPerUser` and `trimForUser` (DEAD, audit #7) | deleted by plan 207; re-proved here | `rg -n "commandRunsPerUser\|trimForUser" packages` → empty |
| `session.idleTtlSec`, `session.maxIdleSessions`, `session.maxConcurrentBuilds` | deleted by plan 206; re-proved here | `rg -n "idleTtlSec\|maxIdleSessions\|maxConcurrentBuilds" packages` → empty |
| `coControl.*` (5) and `mirror.*` (4) | deleted by plan 205; re-proved here | `rg -n "coControl\|CoControlSettings\|MirrorSettings" packages` → empty |
| `retention.enabled` | `settings.ts:1084`, `maintenance/retention.ts:216` | `rg -n "retention\.enabled\|policy\.enabled" packages` → empty |
| `retention.eventInputDays`, `eventMaxRowsPerDevice`, `blobOrphanGraceHours` as settings | `settings.ts:1107-1142` | `rg -n "eventInputDays\|eventMaxRowsPerDevice\|blobOrphanGraceHours" packages/protocol packages/studio` → empty |
| `normaliseLegacyAdb`, `normaliseLegacyWall` | `settings.ts:144-149`, `:160-165` | `rg -n "normaliseLegacyAdb\|normaliseLegacyWall" packages` → empty |
| `ControlPresetSchema`, `WallPresetSchema`, `DeviceLabelModeSchema`, `DeviceLabellingSchema`, `WallTransportSchema`, `ShellModeSchema` | `settings.ts:335`, `:339`, `:295`, `:304`, `:353`, `:36` | `rg -n "ControlPresetSchema\|WallPresetSchema\|DeviceLabelModeSchema\|DeviceLabellingSchema\|WallTransportSchema\|ShellModeSchema" packages` → empty |
| the types `FarmDeviceDefaults`, `SessionSettings`, `VideoSettings`, `WallSettings`, `ReadinessSettings`, `WorkspaceSettings`, `KvSettings`, `WorkflowJobSettings`, `RecordingSettings`, `JobSettings` | `settings.ts:2678-2691` | `rg -n "WorkflowJobSettings\|RecordingSettings\|ReadinessSettings\|KvSettings\|WorkspaceSettings\|WallSettings" packages` → empty |
| `DeviceSettingsSchema.input.preferredMode` | `settings.ts:411-420`, `core/src/session/adapters.ts:42-44` | `rg -n "preferredMode" packages` → empty |
| `WALL_VIDEO_BUDGET_BPS` | `packages/session/src/video-profile.ts:138` | `rg -n "WALL_VIDEO_BUDGET_BPS" packages` → empty |
| `sourceOf` and the `'farm'` video source | `packages/session/src/video-profile.ts:73-76`, `studio/src/components/video/video-quality.ts:42` | `rg -n "'farm'" packages/session/src/video-profile.ts packages/studio/src/components/video` → empty |
| `FARM_SECTION_DEFS` and the hand-maintained section list | `packages/studio/src/components/settings/farmSections.ts:51-162` | `rg -n "FARM_SECTION_DEFS" packages` → empty |
| `FarmVideoFields.tsx`, `DeviceVideoFields.tsx` | `packages/studio/src/components/video/` | `test ! -e packages/studio/src/components/video/FarmVideoFields.tsx && test ! -e packages/studio/src/components/video/DeviceVideoFields.tsx` |
| `CONTROL_ADVANCED_KEYS`, `WALL_ADVANCED_KEYS`, `VIDEO_PRESET_KEYS`, `VIDEO_ADVANCED_KEYS`, `farmSourceLabel`, `deviceSourceLabel` | `packages/studio/src/components/video/video-quality.ts:196-240` | `rg -n "CONTROL_ADVANCED_KEYS\|WALL_ADVANCED_KEYS\|VIDEO_PRESET_KEYS\|VIDEO_ADVANCED_KEYS\|farmSourceLabel\|deviceSourceLabel" packages` → empty |
| the settings page's `kv`, `connectors`, `webhooks`, `spend`, `workspace`, `ai-defaults`, `blocked`, `video`, `network`-banner branches | `packages/studio/src/app/settings/page.tsx:112-194` | `rg -n "id === 'kv'\|id === 'connectors'\|id === 'webhooks'\|id === 'spend'\|id === 'ai-defaults'\|id === 'blocked'\|id === 'video'" packages/studio/src/app/settings/page.tsx` → empty |
| the 74 KB `settings.test.ts` cases that assert removed fields | `packages/protocol/src/settings.test.ts` | the rewritten file is under 400 lines: `wc -l < packages/protocol/src/settings.test.ts` ≤ 400 |
| `packages/studio/src/components/settings/farmSections.test.ts`, `deviceSections.test.ts` | already deleted by plan 201 | `test ! -e packages/studio/src/components/settings/farmSections.test.ts` |

Forbidden words this plan's area introduces: none new. The vocabulary rows this plan must not reintroduce (plan 200 §2.4) are `lease`, `assist`, `co-control`, `grant`, `cluster` - all owned by plans 205 and 207 and all covered by `GREP_212`'s first three alternatives plus those plans' own greps.

## 11. Handoff report

- **Checklist**: G1 ⬜ G2 ⬜ G3 ⬜ G4 ⬜ G5 ⬜ G6 ⬜ G7 ⬜ G8 ⬜ G9 ⬜ G10 ⬜ G11 ⬜ G12 ⏳ owner
- **Commits**:
- **Typecheck**:
- **Tests run**:
- **Removed, proven**:
- **Discrepancies between plan and code**:
- **Observed, not done**:
- **Open questions hit**:
- **Processes**:
