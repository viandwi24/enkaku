export interface FarmSectionDef {
  id: string
  title: string
  /**
   * Plan 73 §3.4, §4.5 — the heading `SectionNav` renders above a run of
   * CONSECUTIVE entries sharing it (declaration order below IS render
   * order, so every group's entries must stay adjacent in this array).
   */
  group: string
  /**
   * Top-level `FarmSettingsSchema` keys this section's `FarmForm` renders.
   * Empty for a section with no generic schema form at all (`Connectors`,
   * `Webhooks`, `Blocked devices`, `Users`, `Audit log` are each their own
   * bespoke screen against a different API, not a settings row).
   */
  keys: string[]
}

/**
 * The farm Settings page's section list (plan 96 item 96.4).
 *
 * Deliberately still hand-maintained, not derived from the schema the way
 * `deviceSections()` now is (plan 95 §5 step 95.4) — and that asymmetry is
 * intentional, not an oversight this plan forgot to close. Plan 95 §3.5
 * already weighed deriving this list and rejected it: half of these entries
 * (`Connectors`, `Webhooks`, `Blocked devices`, `Users`, `Audit log`) are not
 * `FarmSettingsSchema` fields at all — they are bespoke screens against
 * their own REST endpoints (`/api/connectors`, `/api/webhooks`, `/api/devices/
 * blocked`, `/api/auth/users`, `/api/auth/audit`). A schema has nothing to
 * say about screen ORDER, human section titles, or which screens share a
 * component beyond a generic form either — this file is a page manifest,
 * not a shadow copy of a schema, and that is the actual test for whether a
 * list like this is drift-prone (plan 95 §3.5's own words).
 *
 * What WAS drift-prone, and what plan 96 item 96.4 found and fixes: a
 * hand-maintained manifest silently OMITS a schema-backed key nobody
 * remembered to add — which is exactly how `discovery`, `monitor`, `shell`,
 * `transfer`, `network`, `workspace`, the `kv` quota block, and (found while
 * fixing the other seven, and not itself in plan 96's original list) the
 * farm-wide `readiness` block went unreachable from Studio despite existing
 * and working server-side. A schema cannot silently omit a field the way a
 * parallel list can — so instead of deriving the SCREEN list (which would
 * throw away the screen-vs-schema distinction plan 95 drew on purpose),
 * `farmSections.test.ts` asserts directly against `FarmSettingsSchema` that
 * every one of its top-level keys is claimed, by exactly one section's
 * `keys`, here. That test is what makes a future omission fail loudly
 * instead of silently, which is the actual defect this item exists to fix —
 * not the seven missing entries themselves, which are just its first
 * instance.
 */
export const FARM_SECTION_DEFS: readonly FarmSectionDef[] = [
  // Plan 89 §3.7, §4.3, step 89.6 — `labelling.maxConcurrent` is the only
  // genuinely farm-wide labelling knob (everything else rides
  // `defaults.labelling`, already claimed by `defaults` above); paired with
  // it here rather than given a tab of its own, since step 89.8 (not this
  // one) is what builds a bespoke "Physical labelling" screen — this claim
  // only keeps the key reachable through the generic `FarmForm` until then.
  { id: 'defaults', title: 'Defaults', group: 'Devices', keys: ['defaults', 'labelling'] },
  { id: 'battery', title: 'Battery', group: 'Devices', keys: ['battery'] },
  // `adbControl` (plan 88 §3.9, §4.7 — adb server health monitoring: how
  // often it is probed, and the timeout rate that counts as a "storm") joins
  // `adb`/`health` here rather than a tab of its own: all three are the same
  // subject — the shared adb server and how the farm watches it — and this
  // tab already hosts `AdbDiagnosticsPanel`, the surface these settings tune.
  { id: 'adb', title: 'adb', group: 'Devices', keys: ['adb', 'health', 'adbControl'] },
  // Plan 96 item 96.4 — `discovery` (device rescan cadence, plan 85 §3.3)
  // and `monitor` (the always-on crash feed's farm-wide switch, plan 85
  // §3.2) are both about how the farm SEES its devices, one tab rather than
  // two one-field tabs.
  { id: 'discovery', title: 'Discovery & monitoring', group: 'Devices', keys: ['discovery', 'monitor'] },
  // Plan 90 §3.7, §3.8, §4.4 — the on-device Enkaku agent: whether it is
  // kept installed automatically (step 90.3), and the recovery bound for
  // the network route it carries (step 90.4). Its own tab rather than
  // folded into `discovery` above: step 90.6 adds a farm-wide "N of M
  // devices on the current agent" summary here with a Provision-all
  // action, which needs a home of its own, not a corner of a rescan-cadence
  // tab.
  { id: 'guest-agent', title: 'Guest agent', group: 'Devices', keys: ['guestAgent'] },
  // Plan 92 §3.5, §3.6, §4.1 — the two video quality profiles (device page,
  // wall tile), farm-wide. Rendered entirely by the generic `FarmForm` for
  // now; step 92.8 (not built by this step) adds the preset dropdown's
  // Advanced disclosure and the live Mbit/s projection on top of this same
  // section — it does not need a section of its own to exist first.
  { id: 'video', title: 'Video', group: 'Devices', keys: ['video'] },
  // `readiness` (`maxHot`/`defaultDesired`) joins `session`/`wall` here, not
  // a section of its own — the three answer one question, how many
  // devices/sessions the farm holds open at once. Plan 100 §4.3, step 100.6
  // — `display.fallbackRetryCount` joins the same tab: all four answer "how
  // a device session behaves while open," and a fifth single-field tab for
  // one retry count would be more clutter than the setting is worth. Plan
  // 206 §4.5 shrank `session` to its one remaining knob (`buildsPerUsbRoot`)
  // — sessions themselves are always on now — without moving this tab.
  { id: 'sessions', title: 'Sessions & Wall', group: 'Devices', keys: ['session', 'wall', 'readiness', 'display'] },
  // Plan 94 §4.6, §5 step 94.3 — the recorder's own throttles (how eagerly
  // it dumps the UI tree for a selector candidate) and bounds (steps,
  // duration). Its own tab: the old per-holder/secondary-operator subsystem
  // this used to sit beside is gone entirely (plan 205 §4.9) — a device is
  // simply online or it is not, with no farm-wide knob left to configure.
  { id: 'recording', title: 'Recording', group: 'Devices', keys: ['recording'] },
  // Plan 99 §3.11, §5 items 1-2 — `workflow` (today just `maxTotalMs`, the
  // pipeline's own outer clock) joins `job` here rather than getting a tab
  // of its own: it is one field, and it answers a variant of the exact same
  // question (`job.maxTimeoutMs` — "how long may one script run") — "how
  // long may one device be held by one pipeline". Same pattern as
  // `adbControl` folding into `adb` above.
  { id: 'job', title: 'Jobs', group: 'Jobs', keys: ['job', 'workflow'] },
  { id: 'storage', title: 'Storage', group: 'Jobs', keys: ['retention'] },
  // AI Agents (plan 73 §3.4) — `agentDefaults` rendered through the same
  // schema-driven `FarmForm` every other section already uses, so a field
  // added to `AgentDefaultsSchema` appears here automatically (criterion 13).
  { id: 'ai-defaults', title: 'Defaults', group: 'AI Agents', keys: ['agentDefaults'] },
  // Farm-level provider connectors (plan 65 §3.8) — appear inside the agent
  // editor only as a picker plus a link, because a credential edited from
  // inside one agent's page but affecting every other agent is a trap.
  { id: 'connectors', title: 'Connectors', group: 'AI Agents', keys: [] },
  // Plan 68 §3.4, §4.5 — farm-level, admin-managed webhook endpoints an
  // agent's `notify.send` chooses among by NAME (never a raw URL).
  { id: 'webhooks', title: 'Webhooks', group: 'AI Agents', keys: [] },
  // Plan 68 §3.3, §4.5 — the spend cap and scheduled-concurrency ceiling.
  // Both apply ONLY to scheduled agent runs; an interactive chat run is
  // never blocked by either, stated here in `scheduledAgents`'s own
  // `.meta()` description (rendered by the generic `FarmForm` below — no
  // bespoke UI needed, same as `job`/`sessions`/`battery`).
  { id: 'spend', title: 'Spend', group: 'AI Agents', keys: ['scheduledAgents'] },
  // Plan 96 item 96.4 — the shared database-backed workspace's quotas (plan
  // 64 §3.3). Grouped with AI Agents rather than Farm: the block's own
  // description names agents as the primary user of it ("agents and people
  // share"), and its neighbours here are the other AI-surface budgets
  // (`Spend`, and `agentDefaults`'s own context budgets).
  { id: 'workspace', title: 'Workspace', group: 'AI Agents', keys: ['workspace'] },
  { id: 'blocked', title: 'Blocked devices', group: 'Farm', keys: [] },
  // Plan 96 item 96.4 — `shell` (the device terminal, plan 26) and
  // `transfer` (push/pull/install, plan 39) are both about what an operator
  // or controlling client may DO on a device, farm-wide — the same "access
  // surface" shape as `Blocked devices` right above, not a `Devices`-tab
  // operational tuning knob like `battery`/`adb`.
  { id: 'access', title: 'Terminal & transfer', group: 'Farm', keys: ['shell', 'transfer'] },
  // Plan 96 item 96.4 — the geo-verification lookup a route's exit is
  // checked against (plan 55 §3.2). Off by default and farm-wide, so it
  // sits with the other farm-wide policy tabs rather than under `Devices`.
  { id: 'network', title: 'Network', group: 'Farm', keys: ['network'] },
  // Plan 79 §5.9 — global-scope ctx.kv values (device scope lives on each
  // device's own Storage tab instead, since it needs a device to browse).
  // Plan 96 item 96.4 adds the `kv` quota block's own `FarmForm` beneath the
  // browser, so the one tab named "Key/Value store" covers both browsing
  // entries and the limits that bound them — the same combined-tab shape
  // `adb`'s diagnostics panel and `spend`'s observed-usage panel already use.
  { id: 'kv', title: 'Key/Value store', group: 'Farm', keys: ['kv'] },
  { id: 'users', title: 'Users', group: 'Farm', keys: [] },
  { id: 'audit', title: 'Audit log', group: 'Farm', keys: [] },
]
