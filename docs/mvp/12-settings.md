# MVP 12 — Settings: from 115 fields to about 15

> Status: decided in direction (CEO, 2026-09-03); the classification below is the CTO's proposal.
> As stated by the CEO: settings must be far more compact; Panda has very few. Which settings should a user see, and which not?
> Related: `packages/protocol/src/settings.ts` (2 694 lines, 115 titled fields), `docs/settings-audit.md`, `packages/studio/src/components/settings/farmSections.ts` (22 sections), MVP 03 §1 (Settings page), MVP 04, 06, 11 (settings those documents delete).

---

## 0. The rule

A setting is **visible** only if both hold:

1. The right value differs between farms (a client with 20 phones on a shelf and one with 100 phones behind a MikroTik need different answers).
2. A non-engineer can predict what changing it does.

Everything else is one of:

- **Advanced**: differs between farms but only an engineer should touch it. Hidden behind one "Advanced" disclosure at the bottom of Settings, with the default shown beside each field and a reset. Not in the sidebar, not in search.
- **Constant**: does not differ between farms in any way the product should support. Becomes a named constant in code with an environment override for support cases, and leaves the schema.
- **Removed**: the feature it configures is deleted by another MVP document.
- **Moved**: belongs to a device, a plugin, or the Agents page, not to farm settings.

Panda's small settings screen is not restraint on their part; it is that they decided the constants themselves. So do we.

## 1. Visible (15)

| Section | Setting | Why it is visible |
|---|---|---|
| Farm | Farm name | shown on every page and in the agent's status screen |
| Video | Control quality: sharp, balanced, light | the one knob that trades sharpness for CPU and USB |
| Video | Wall quality: minimal, light, balanced, detailed | same, for the wall |
| Devices | Networks to scan for wireless devices (list) | pure farm topology |
| Devices | Battery: pause jobs above N °C | physical safety, differs by climate and enclosure |
| Devices | Physical label on the screen: off, number, number and name | depends on whether phones are on a visible shelf |
| Control | When someone controls a device another person just touched: allow, warn, forbid (MVP 04 §1.3) | team policy |
| Jobs | Default job timeout | depends on what the scripts do |
| Jobs | Reset the app before each job: never, always, on failure | depends on the scripts |
| Jobs | Human-like touch profile: precise, natural, slow | the only timing knob a non-engineer understands; scripts may override per call |
| Access | Adb command action for operators: on or off (one switch; the console and terminal are gone, MVP 15 §0.1) | security policy |
| Access | Users and API tokens | not a field, a table; lives here |
| Retention | Keep job history, logs, and traces for N days; keep artifacts for N days or up to N GB (MVP 09 §6) | disk differs per farm |
| Network | Egress probe endpoint (plan 51 §5.3) | self-hosted URL, differs per farm |

Sidebar sections after: Farm, Video, Devices, Control, Jobs, Access, Retention, Network, Toolchain, Advanced. Ten, down from 22 in four groups.

**Amended by MVP 15:** the layout and group names follow the design handoff (General; Connection: Host & daemon, ADB transport, Network scan; Automation: Job runner, Capture & replay; Storage: Artifacts, Retention; Farm: Clusters, Privacy, Appearance, Advanced). The field list stays this document's: fields the handoff draws that are classified here as constants are not built, and its Scripts section (auto-update, version pinning, run-as) is dropped under MVP 03 §2.

## 2. Advanced (11)

Hidden behind one disclosure; defaults shown; each has a one-line "raise this if" sentence.

| Setting | Default | Raise or lower if |
|---|---|---|
| Max concurrent adb commands | 8 | adb server saturates on a large hub |
| Max concurrent installs | 1 per USB root | installs time out on a hub that can take more |
| Session build concurrency per USB root (MVP 11 §1.4) | 4 | a cold start of 100 devices is too slow or saturates USB |
| Infrastructure retries and backoff base | 3, 1 s | flaky USB |
| Job memory limit | 256 MB | a script legitimately needs more |
| Push / pull / bulk download size caps | 512 MB, 512 MB, 2 GB | large APKs or artifact bundles |
| Install timeout | 120 s | slow devices |
| adb health probe interval | 30 s | a farm that must detect a dead adb faster |
| Failures before quarantine | 5 | a noisy farm quarantines too eagerly |
| Wall bandwidth budget on WAN | 20 Mbit | remote viewing over a known link |
| Recovery resets per hour | 6 | a device that flaps deserves fewer or more chances |

## 3. Constant (about 60): leaves the schema

Grouped by what the code will hold instead of the schema. Each becomes a named export in the owning package with an `ENKAKU_*` env override documented in `.env.example` under a "support overrides" heading.

- **Timing details**: tap duration, pause between actions, tap point jitter, gesture sample interval, typing cadence (the visible profile picks a tuple; scripts override per call). `docs/settings-audit.md` already found the per-device copies of these to be shadowed.
- **Device housekeeping**: screen timeout on the device, offline grace, recovery cooldown and re-arm, recovery probe interval, remembered addresses per device and retirement, connect settle time, scan limits and probe timeout, cutover window and poll, device rescan interval, timeout-storm threshold, adb restart cooldown and drain timeout.
- **Job runtime**: reset timeout, fail-on-reset-error (folds into the visible reset policy), startup timeout, maximum timeout, memory sample interval, trigger depth and chain limits, max result size, progress interval, max workflow duration.
- **Monitoring**: polling interval, max rows per device per stream, unreferenced screenshot grace.
- **Terminal and fleet commands**: command timeout, output caps, live preview size, typed-confirmation threshold, staged wait, history and saved-command counts, fleet concurrency and max devices. The two visible toggles remain.
- **adb endpoint**: bind address, idle timeout, max streams. The feature stays reachable from the device page; its limits are constants.
- **Input**: wait budget, max queued actions, fallback retry attempts.
- **Wall**: max live tiles, fill-in concurrency, browser decode ceiling, hot devices. All become measured automatic values (MVP 09 §7) rather than fields.
- **Storage limits**: workspace file size and counts, KV value size and entry counts, inline storage threshold.
- **Recording**: anchor quiet period and minimum interval, long-press threshold, max steps, max duration.
- **Guest agent**: auto-install and re-install policy (always on; MVP 10 §3).
- **Geo re-check interval**.

## 4. Removed (12): the feature is gone

Assist and mirror (7 fields, MVP 04 and 06), idle session TTL, max idle sessions, max concurrent session starts (MVP 11), quiet period before claiming and maximum wait for quiet (MVP 04).

## 5. Moved (about 15)

- AI defaults, connectors, webhooks, spend cap, scheduled-run limits, workspace: to the Settings tab of the Agents page (MVP 06 §3).
- Key/Value store browser: to the Plugins page (MVP 06 §3).
- Per-device overrides (video numbers, driver engines, prep toggles, readiness): stay on the device's Settings tab, reduced to the same visible set as the farm plus "use farm default" on each; the dead `prep.disableAnimations` and the misleading per-device presets named in `docs/settings-audit.md` are deleted.

## 6. Result

| | Before | After |
|---|---|---|
| Titled fields in the farm schema | 115 | 26 (15 visible, 11 advanced) |
| Sidebar sections | 22 in 4 groups | 10 |
| Schema file | 2 694 lines | expected under 600 |
| Fields the audit marked dead or shadowed | 9 | 0 |

## 7. Open points

1. Whether Retention is visible or advanced. Proposed: visible, because disk is the first thing a client runs out of.
2. Whether "Reset the app before each job" is a farm setting at all or a per-script declaration in the plugin manifest. Proposed: per-script declaration with a farm default; the field stays visible as the default.
