import { z } from 'zod'
import { AgentDefaultsSchema } from './agent'
import { ui } from './params/vocabulary'
import { ReadinessSchema } from './readiness'

/** Per-device battery and thermal state (spec §15.2). */
export const BatteryStateSchema = z.object({
  level: z.number().min(0).max(100),
  /** dumpsys 'temperature' (deci-°C) / 10. */
  temperatureC: z.number(),
  status: z.enum(['charging', 'discharging', 'not_charging', 'full', 'unknown']),
  health: z.enum(['good', 'overheat', 'dead', 'over_voltage', 'cold', 'unknown']),
  voltageMv: z.number().optional(),
  /** Unix epoch seconds. */
  updatedAt: z.number(),
})
export type BatteryState = z.infer<typeof BatteryStateSchema>

/**
 * How a session holds the screen awake (spec §9, Plan 17 §3.4).
 *
 * `svc power stayon` accepts `true|false|usb|ac|wireless`; `usb` only holds the
 * screen while plugged into USB, which does nothing for a device attached over
 * `adb-tcp`. The three modes here map onto that command in `session.ts`.
 */
export const KeepAwakeModeSchema = z.enum(['off', 'while-charging', 'always'])
export type KeepAwakeMode = z.infer<typeof KeepAwakeModeSchema>

/**
 * Who may run free-form shell commands on a device (plan 26 §3.2, §4.1) —
 * `'off'` disables the terminal entirely (server-authoritative: the WS
 * handler checks this itself, not just Studio hiding the tab). Extracted to
 * a named schema so `packages/core/src/auth/acl.ts` and Studio can both
 * import the type without duplicating the enum.
 */
export const ShellModeSchema = z.enum(['off', 'admin', 'operator'])
export type ShellMode = z.infer<typeof ShellModeSchema>

/** Timing realism (spec §9.3). */
export const TimingSettingsSchema = z.object({
  tapJitterMs: z
    .tuple([z.number(), z.number()])
    .default([40, 120])
    .describe('Random range for how long a tap is held, in milliseconds')
    .meta(ui({ title: 'Tap duration', kind: 'duration', unit: 'ms' })),
  betweenActionMs: z
    .tuple([z.number(), z.number()])
    .default([300, 900])
    .describe('Random range for the pause between actions, in milliseconds')
    .meta(ui({ title: 'Pause between actions', kind: 'duration', unit: 'ms' })),
  coordJitterPx: z
    .number()
    .default(2)
    .describe('Random offset applied to the tap point, in pixels')
    .meta(ui({ title: 'Tap point jitter', kind: 'pixels' })),
  /**
   * Input realism (plan 40 §3.5, §4.3): `instant` reproduces the pre-plan-40
   * behaviour exactly — a straight-line swipe, and text delivered in one go —
   * which matters both as an escape hatch for a suite that would otherwise
   * change behaviour, and as the control arm when comparing results (§7's
   * A/B). `natural` curves gestures and types character by character, which
   * is what exercises `VelocityTracker`-driven fling physics, autocomplete,
   * and debounced validation — code paths a straight line and a single
   * `set_text` never reach.
   */
  profile: z
    .enum(['instant', 'natural'])
    .default('natural')
    .describe(
      '"instant" sends a straight-line swipe and types text in one go — the pre-M17f behaviour. "natural" curves gestures and types character by character, which exercises fling physics, autocomplete, and debounced validation.',
    )
    .meta({ title: 'Input profile' }),
  // NOT `kind: 'chance'` (plan 95 §3.3's own worked example): this is a
  // fraction of a swipe's length, not a probability — the resolver would
  // reject it anyway (chance requires the domain to be exactly [0, 1], and
  // this one is [0, 0.5]), but left bare rather than writing a hint the
  // resolver is documented to refuse.
  gestureCurvature: z
    .number()
    .min(0)
    .max(0.5)
    .default(0.08)
    .describe('How far a swipe bows away from a straight line, as a fraction of its length.')
    .meta({ title: 'Gesture curvature' }),
  gestureSampleIntervalMs: z
    .number()
    .int()
    .min(4)
    .max(50)
    .default(8)
    .describe('Interval between touch-move events. Android needs several to compute a release velocity.')
    .meta(ui({ title: 'Gesture sample interval (ms)', kind: 'duration', unit: 'ms' })),
  perCharMs: z
    .tuple([z.number().int().min(0), z.number().int().min(0)])
    .default([40, 140])
    .describe('Delay range between characters when typing.')
    .meta(ui({ title: 'Typing cadence (ms)', kind: 'duration', unit: 'ms' })),
}).meta({
  title: 'Human-like touch',
  description: 'A little randomness in tap timing and position, so automation does not fall into an obvious pattern.',
})
export type TimingSettings = z.infer<typeof TimingSettingsSchema>

/**
 * A device row written before Plan 17 still holds `prep.stayAwake` as a plain
 * boolean. `z.preprocess` runs ahead of validation, so a legacy row is rewritten
 * into the new shape before the enum ever sees it — the row keeps working
 * unchanged, with no migration and no special-casing at the call sites that
 * read `DeviceSettings` (spec: config precedence must never silently drop data).
 *
 * A `.transform()` would do the same job, but Zod 4's `z.toJSONSchema` cannot
 * represent a transform's output type and throws — and this schema feeds the
 * settings form's generated JSON Schema (§17.7), so the rewrite has to happen
 * in a preprocessor instead.
 */
function normaliseLegacyPrep(raw: unknown): unknown {
  if (raw && typeof raw === 'object' && 'stayAwake' in raw && !('keepAwake' in raw)) {
    const { stayAwake, ...rest } = raw as Record<string, unknown>
    return { ...rest, keepAwake: stayAwake ? 'while-charging' : 'off' }
  }
  return raw
}

/**
 * `adb.maxStreams` was a fixed 4 before plan 85 — a farm-wide cap identical
 * to the per-device one, which starved any farm past two instrumented
 * devices. Nobody chose it; it was the default. A stored 4 therefore reads
 * as "never configured" and is migrated to 0 (auto). Tracked removal:
 * 2027-02-01, after which a stored 4 means a deliberate 4.
 */
function normaliseLegacyAdb(raw: unknown): unknown {
  if (raw && typeof raw === 'object' && (raw as { maxStreams?: unknown }).maxStreams === 4) {
    return { ...(raw as object), maxStreams: 0 }
  }
  return raw
}

/**
 * Screen rotation control (plan 85 §3.7, §4.1) — `'device'` leaves the
 * device's own auto-rotate behaviour untouched (today's behaviour, exactly);
 * the lock modes pin `user_rotation` while a session is open and are
 * reverted on close the same way `keepAwake` already is.
 */
export const RotationModeSchema = z.enum(['device', 'lock-portrait', 'lock-landscape', 'lock-current'])
export type RotationMode = z.infer<typeof RotationModeSchema>

/**
 * A spoofed GPS fix (plan 58 §4.1). Bounds are the real-world ranges — a
 * latitude outside ±90 or a longitude outside ±180 is a typo, not a place.
 * `accuracy` is the radius the OS reports alongside the fix; social apps weigh
 * it, so it is surfaced rather than hardcoded.
 */
export const DeviceGpsSchema = z.object({
  lat: z.number().min(-90).max(90).describe('Latitude, in decimal degrees').meta({ title: 'Latitude' }),
  lng: z.number().min(-180).max(180).describe('Longitude, in decimal degrees').meta({ title: 'Longitude' }),
  accuracy: z
    .number()
    .positive()
    .max(10_000)
    .default(100)
    .describe('Reported fix accuracy in metres — a phone on WiFi is roughly 20–100m')
    .meta({ title: 'Accuracy (m)' }),
})
export type DeviceGps = z.infer<typeof DeviceGpsSchema>

/**
 * Device identity (plan 58) — the signals a device presents to an app besides
 * its network path: timezone, locale, and GPS location. A route that exits in
 * New York while the device still reports `Asia/Jakarta` and Jakarta GPS is
 * exactly the mismatch social platforms flag, so this block exists to align all
 * three with the route's observed exit (the "sync with proxy" affordance, plan
 * 56 §3.4). Every field is optional: an absent field means "leave the device's
 * own value alone", never a guessed default — same honesty rule as the network
 * layer's `expect` (never inferred, never defaulted).
 *
 * This is NOT a driver layer (plan 58 §3.1): it has no lease-scoped
 * apply/revert lifecycle, no capability negotiation, and persists across leases
 * like `timing` and `prep`. It lives in `DeviceSettingsSchema` alongside them.
 */
export const DeviceIdentitySchema = z
  .object({
    timezone: z
      .string()
      .min(1)
      .optional()
      .describe('IANA timezone the device presents, e.g. "America/New_York". Absent: the device keeps its own timezone.')
      .meta({ title: 'Timezone' }),
    locale: z
      .string()
      .min(2)
      .optional()
      .describe('Locale the device presents, e.g. "en-US" or "ja-JP". Absent: the device keeps its own locale.')
      .meta({ title: 'Locale' }),
    gps: DeviceGpsSchema.optional().describe('A mock GPS fix the guest agent reports as the device location.').meta({ title: 'GPS location' }),
  })
  .meta({
    title: 'Identity',
    description: 'What the device presents to apps besides its network path — timezone, locale, GPS. Align these with the route exit so the signals agree.',
  })
export type DeviceIdentity = z.infer<typeof DeviceIdentitySchema>

/**
 * Device-under-automation marker (spec §9.4) — a device-scoped system
 * property, applied at session start and cleared at close
 * (`packages/session/src/farm-tag.ts`), that discloses a session is
 * currently open on this device. It is deliberately not network-level
 * tagging: it never touches a packet, a header, or a proxy hop, and it
 * marks the device only for as long as a session is actually open.
 * `tagTraffic: false` means the operator turned off that disclosure, not
 * that they gained any new capability; nothing else about a session changes
 * when it is off.
 *
 * Its own schema, thunk-defaulted like `DeviceIdentitySchema` above, so a
 * field added here later cannot silently go unset the way a hand-written
 * literal default would (same rule `TimingSettingsSchema`'s comment states).
 */
export const DeviceInstrumentationSchema = z
  .object({
    tagTraffic: z
      .boolean()
      .default(true)
      .describe(
        'Mark this device as under active Enkaku automation with a device-scoped system property (spec §9.4), set for the life of each session and cleared on close. Readable by any app on the device that checks for it. This is not network-level tagging — it never touches a packet. Turning it off removes a disclosure, not a capability: the marker can never be used to disguise an automated session even when it is on.',
      )
      .meta({ title: 'Mark device as under automation' }),
  })
  .meta({
    title: 'Device instrumentation',
    description: 'A device-scoped marker — not network-level tagging — that discloses a session is currently open on this device (spec §9.4).',
  })
export type DeviceInstrumentation = z.infer<typeof DeviceInstrumentationSchema>

/**
 * Everything that is scoped to a single device (spec §12).
 *
 * This is the ONE schema for device-scoped settings, and `FarmSettings.defaults`
 * reuses it verbatim. That is deliberate: when the two were written separately
 * they drifted — `prep` and `autoReconnect` existed per device with no farm
 * default, while the engine choices existed as farm defaults that no device
 * could override. Sharing the object makes that drift impossible.
 */
export const DeviceSettingsSchema = z
  .object({
    // Enums, not free strings: the renderer builds a dropdown AND the server
    // rejects values outside the list. `x-enkaku.source` (plan 95 §3.4) tells
    // the UI where to read engine display names and availability (spec §8).
    engines: z
      .object({
        transport: z
          .enum(['adb-usb', 'adb-tcp'])
          .default('adb-usb')
          .describe('How the core talks to the device')
          .meta(ui({ title: 'Transport', source: 'registry.transports' })),
        display: z
          .enum(['scrcpy', 'screencap-loop'])
          .default('scrcpy')
          .describe('Where the picture sent to Studio comes from')
          .meta(ui({ title: 'Screen capture', source: 'registry.displays' })),
        input: z
          .enum(['scrcpy-uhid', 'scrcpy-sdk', 'adb-input'])
          .default('scrcpy-uhid')
          .describe('How taps, swipes, and typing reach the device')
          .meta(ui({ title: 'Input delivery', source: 'registry.inputs' })),
        inspection: z
          .enum(['ui-server', 'uiautomator-dump', 'appium'])
          .default('ui-server')
          .describe('How scripts find elements on screen')
          .meta(ui({ title: 'Screen inspection', source: 'registry.inspectors' })),
      })
      .default({
        transport: 'adb-usb',
        display: 'scrcpy',
        input: 'scrcpy-uhid',
        inspection: 'ui-server',
      })
      .meta(
        ui({
          title: 'Engines',
          description: 'The core rejects combinations that cannot work together.',
          // Plan 95 §3.5, §5 step 95.4: `engines` and `input` below are the
          // ONLY two top-level keys sharing this group, and they are
          // declared back to back — a maximal consecutive run, so
          // `deviceSections()` derives one "Engines" section from them with
          // no parallel list (replaces the old hand-maintained `NAMED_GROUPS`).
          group: 'Engines',
        }),
      ),
    input: z
      .object({
        preferredMode: z
          .enum(['uhid', 'sdk', 'aoa'])
          .default('uhid')
          .describe('uhid looks like real hardware to the device; sdk is the widest-compatibility fallback')
          .meta({ title: 'Injection mode' }),
      })
      .default({ preferredMode: 'uhid' })
      .meta(ui({ title: 'Input injection', group: 'Engines' })),
    // A thunk, not a literal object (plan 40 §4.3): a literal default bypasses
    // schema validation, so a hand-written object here would silently omit
    // any field added to `TimingSettingsSchema` later (as this plan just did)
    // and every consumer would read `undefined` for it at runtime despite TS
    // believing it present. Parsing `{}` through the schema itself keeps this
    // in lockstep with `TimingSettingsSchema`'s own defaults, always.
    //
    // The outer `.meta()` here only sets `title`/`group` (plan 95 §5 step
    // 95.4) — `TimingSettingsSchema`'s own `description` still comes through
    // unmerged (Zod merges an outer `.meta()` onto the inner schema's JSON
    // Schema node key by key; a key this call does not set is left alone).
    timing: TimingSettingsSchema.default(() => TimingSettingsSchema.parse({})).meta(ui({ title: 'Human-like touch', group: 'Timing' })),
    prep: z
      .preprocess(
        normaliseLegacyPrep,
        z.object({
          disableAnimations: z
            .boolean()
            .default(true)
            .describe('Turn off system animations before a job runs')
            .meta({ title: 'Disable animations' }),
          /** Replaces the old `stayAwake` boolean (Plan 17 §3.4). */
          keepAwake: KeepAwakeModeSchema.default('while-charging')
            .describe('Keep the device awake while a session is open')
            .meta({ title: 'Keep the screen awake' }),
          /**
           * Blank the device's physical panel while mirroring continues (§3.5).
           * The video stream is unaffected.
           */
          standbyScreenOff: z
            .boolean()
            .default(false)
            .describe('Turn the device screen off while streaming')
            .meta({ title: 'Turn the device screen off while streaming' }),
          /**
           * Rotation lock (plan 85 §3.7, §4.1) — schema only here; applying
           * and reverting it belongs to plan 85.8, next to `keepAwake`.
           */
          rotation: RotationModeSchema.default('device')
            .describe('Lock the screen orientation while a session is open')
            .meta({ title: 'Screen rotation' }),
        }),
      )
      .default({ disableAnimations: true, keepAwake: 'while-charging', standbyScreenOff: false, rotation: 'device' })
      .meta(ui({ title: 'Before a job runs', group: 'Power & readiness' })),
    autoReconnect: z
      .boolean()
      .default(true)
      .describe('Reconnect automatically when the device disappears')
      .meta({ title: 'Auto-reconnect' }),
    /**
     * Off by default (plan 18 §3.4): `input.text` normally stores only
     * `{ length, sha256Prefix }`, never the literal string, because typed
     * text routinely includes passwords and one-time codes. Turning this on
     * is itself audited (the API route writes the `audit_log` entry).
     */
    logInputText: z
      .boolean()
      .default(false)
      .describe('Store the literal typed text in the input log, instead of just its length. Turning this on is recorded in the audit log — anything typed on this device (including passwords) becomes readable by any farm user who opens the Logs tab.')
      .meta({ title: 'Log typed text in the clear' }),
    /**
     * Plan 58 §4.1 — device identity (timezone/locale/GPS), persisted per
     * device exactly like `timing`/`prep`. A thunk default (plan 40 §4.3) keeps
     * this in lockstep with `DeviceIdentitySchema`'s own shape; every inner
     * field is optional so an empty object parses to "leave everything alone".
     */
    identity: DeviceIdentitySchema.default(() => DeviceIdentitySchema.parse({})).meta(ui({ title: 'Identity', group: 'Identity' })),
    /**
     * Plan 87 §4.12, §5 step 87.13 — farm traffic tagging, persisted per
     * device exactly like `identity` above. The applier lives in
     * `packages/session/src/farm-tag.ts`, wired next to `prep.rotation`.
     *
     * Deliberately NOT `group`-annotated (plan 95 §5 step 95.4): it has no
     * sibling of its own, and `autoReconnect`/`logInputText` above are
     * likewise ungrouped, so this — like them — lands in "General", which is
     * exactly K9's property (an unclaimed key can never silently vanish).
     */
    instrumentation: DeviceInstrumentationSchema.default(() => DeviceInstrumentationSchema.parse({})),
  })
  .meta({ title: 'Device settings' })
export type DeviceSettings = z.infer<typeof DeviceSettingsSchema>

/**
 * Session hygiene between jobs (plan 35 §4.1): what to reset on a device
 * before every job runs, so two jobs on one device stop inheriting each
 * other's application state. `resetPolicy` is one of four escalating levels
 * (plan 35 §3.3); `retry` is added by plan 36 to this same block, so the
 * shape here is deliberately a container rather than a flat set of fields.
 */
export const JobSettingsSchema = z
  .object({
    // `resetPolicy`/`resetTimeoutMs`/`resetStrict` are a maximal consecutive
    // run of `group: 'Reset'` (plan 95 §3.5, §5 step 95.4) — `retry` right
    // after them is already its own card (an object, K7), so it needs no
    // group of its own.
    resetPolicy: z
      .enum(['none', 'home', 'declared', 'aggressive'])
      .default('home')
      .describe(
        'What to reset on a device before each job. "home" returns to the launcher; "declared" also stops the packages a script declares; "aggressive" stops every non-system app.',
      )
      .meta(ui({ title: 'Reset before each job', group: 'Reset' })),
    resetTimeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(60_000)
      .default(15_000)
      .describe('Budget for the pre-job reset. Exceeding it logs a warning and the job continues.')
      .meta(ui({ title: 'Reset timeout (ms)', kind: 'duration', unit: 'ms', group: 'Reset' })),
    resetStrict: z
      .boolean()
      .default(false)
      .describe('Fail the job when its pre-job reset fails, instead of warning and continuing.')
      .meta(ui({ title: 'Fail on reset error', group: 'Reset' })),
    /**
     * Retry classification and backoff (plan 36 §4.2): infra failures (device
     * lost, adb timeout) draw from `maxInfraAttempts`, a budget separate from
     * `ScriptDefinition.retries` (§3.4) — a farm problem must never spend an
     * author's own retry count.
     */
    retry: z
      .object({
        maxInfraAttempts: z
          .number()
          .int()
          .min(0)
          .max(10)
          .default(2)
          .describe("Extra attempts allowed when a job fails for infrastructure reasons (device lost, adb timeout). Separate from a script's own retries.")
          .meta(ui({ title: 'Infrastructure retries', kind: 'count' })),
        backoffBaseMs: z
          .number()
          .int()
          .min(100)
          .max(60_000)
          .default(2_000)
          .describe('First backoff delay; it doubles each infrastructure retry, with jitter.')
          .meta(ui({ title: 'Retry backoff base (ms)', kind: 'duration', unit: 'ms' })),
        backoffMaxMs: z
          .number()
          .int()
          .min(1_000)
          .max(300_000)
          .default(30_000)
          .describe('Upper bound on the backoff delay.')
          .meta(ui({ title: 'Retry backoff cap (ms)', kind: 'duration', unit: 'ms' })),
        timeoutIsInfra: z
          .boolean()
          .default(false)
          .describe('Treat a job timeout as an infrastructure failure rather than a script failure.')
          .meta({ title: 'Timeouts count as infrastructure' }),
        rebindOnInfra: z
          .boolean()
          .default(true)
          .describe('On an infrastructure failure, let a batch member move to another eligible device.')
          .meta({ title: 'Move batch members after infrastructure failures' }),
      })
      .default({ maxInfraAttempts: 2, backoffBaseMs: 2_000, backoffMaxMs: 30_000, timeoutIsInfra: false, rebindOnInfra: true })
      .meta({
        title: 'Retry classification',
        description: "Infrastructure failures retry with backoff, separately from a script's own retry budget.",
      }),
    /**
     * Crash detection's opt-in job failure (plan 37 §3.4). Three escalating
     * levels, defaulting to the middle one: a blanket "any crash fails the
     * job" would fail every run on a farm phone with one flaky OEM service,
     * so `declared` — matching only the script's own target package(s) — is
     * the default, and `ignore` restores pre-plan-37 behaviour exactly
     * (crashes are still recorded as `app.crashed` events either way; this
     * setting only controls whether one can fail a *job*).
     */
    crashPolicy: z
      .enum(['ignore', 'declared', 'any'])
      .default('declared')
      .describe(
        'Whether an application crash can fail a running job. "ignore" only records the event; "declared" fails the job when the script\'s own target package crashes; "any" fails it on any non-system crash.',
      )
      .meta({ title: 'Fail jobs on app crash' }),
    /**
     * A job waits for the device to go quiet before claiming it (plan 71
     * §3.7) instead of interrupting whatever a person is mid-gesture on.
     * Bounded by `maxWaitSec` so one person cannot starve the queue.
     */
    quietPeriodSec: z
      .number()
      .int()
      .min(0)
      .max(600)
      .default(10)
      .describe('How long a device must have had no manual lease before a queued job may claim it.')
      .meta(ui({ title: 'Quiet period before claiming (sec)', kind: 'duration', unit: 's', group: 'Queueing' })),
    maxWaitSec: z
      .number()
      .int()
      .min(0)
      .max(3_600)
      .default(120)
      .describe('The most a job will wait for a quiet gap before claiming the device anyway.')
      .meta(ui({ title: 'Maximum wait for quiet (sec)', kind: 'duration', unit: 's', group: 'Queueing' })),
    /**
     * Plan 74 §3.1, §4.1 — replaces the hard-coded `DEFAULT_TIMEOUT_MS`
     * (`job-runner.ts`, 300_000) that appeared in no settings screen, no
     * config file, and no environment variable. A script's own
     * `ScriptDefinition.timeout` still wins whenever it declares one; this is
     * only what applies when it does not.
     */
    defaultTimeoutMs: z
      .number()
      .int()
      .min(30_000)
      .max(86_400_000)
      .default(3_600_000)
      .describe("How long a job may run before it is killed, when its script does not declare its own timeout. A script's own `timeout` always wins.")
      .meta(ui({ title: 'Default job timeout (ms)', kind: 'duration', unit: 'ms', group: 'Timeouts' })),
    /**
     * Plan 74 §3.2 — raising `defaultTimeoutMs` from the old 5-minute
     * hard-code to 60 minutes makes the pre-`ready` window twelve times
     * looser: the run timer used to be the only backstop for a child that
     * never starts. This is the real, short backstop for exactly that case,
     * armed at spawn and cleared the moment `ready` arrives — separate from
     * the run timeout, and classified as infrastructure (plan 36), never the
     * script's fault.
     */
    startupTimeoutMs: z
      .number()
      .int()
      .min(5_000)
      .max(600_000)
      .default(60_000)
      .describe("How long a job's process has to start and report ready before it is treated as broken. Separate from the run timeout.")
      .meta(ui({ title: 'Job startup timeout (ms)', kind: 'duration', unit: 'ms', group: 'Timeouts' })),
    /**
     * Plan 74 §3.3 — off by default (`null`, no ceiling) because the user's
     * instruction is explicit: a script's own timeout has priority. Setting
     * this clamps a script's request, and the clamp is ALWAYS logged, naming
     * the script and both numbers — a job that dies early for an unexplained
     * reason is worse than one that runs long.
     */
    maxTimeoutMs: z
      .number()
      .int()
      .min(30_000)
      .max(86_400_000)
      .nullable()
      .default(null)
      .describe("An optional ceiling on what a script may request. Null means no ceiling — a script's own timeout is honoured however long. A clamp is logged, never silent.")
      .meta(ui({ title: 'Maximum job timeout (ms)', kind: 'duration', unit: 'ms', group: 'Timeouts' })),
    /**
     * Bounds on `ctx.jobs.trigger()` (plan 81 §3.2) — the mechanism, not
     * guidance, that stops a runaway chain: every bound is a refusal
     * (`E_TRIGGER_TOO_DEEP` / `E_TRIGGER_CHAIN_FULL` / `E_TRIGGER_FAN_OUT`),
     * never a silent drop, and every check fails CLOSED — no parse failure,
     * timeout, or missing row may produce a deeper or longer chain (plan 67
     * §3.6's precedent, applied here).
     */
    trigger: z
      .object({
        maxDepth: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(5)
          .describe('How many links a trigger chain may have. A job that triggers a job that triggers a job... is refused past this depth.')
          .meta(ui({ title: 'Maximum trigger depth', kind: 'count' })),
        maxPerChain: z
          .number()
          .int()
          .min(1)
          .max(10_000)
          .default(200)
          .describe("The most jobs one chain may ever contain, counted from its root — the bound that actually stops a self-triggering script, since a chain that keeps re-rooting itself would otherwise never hit the depth limit.")
          .meta(ui({ title: 'Maximum jobs per chain', kind: 'count' })),
        maxPerJob: z
          .number()
          .int()
          .min(1)
          .max(1_000)
          .default(10)
          .describe('How many jobs a single job may directly trigger, so one script cannot queue a thousand jobs in a loop.')
          .meta(ui({ title: 'Maximum jobs triggered by one job', kind: 'count' })),
      })
      .default({ maxDepth: 5, maxPerChain: 200, maxPerJob: 10 })
      .meta({
        title: 'Job triggering',
        description: "Bounds on a running script's own ctx.jobs.trigger() calls — every one is a refusal a script sees as a throw, never a silent drop.",
      }),
  })
  .default({
    resetPolicy: 'home',
    resetTimeoutMs: 15_000,
    resetStrict: false,
    retry: { maxInfraAttempts: 2, backoffBaseMs: 2_000, backoffMaxMs: 30_000, timeoutIsInfra: false, rebindOnInfra: true },
    crashPolicy: 'declared',
    quietPeriodSec: 10,
    maxWaitSec: 120,
    defaultTimeoutMs: 3_600_000,
    startupTimeoutMs: 60_000,
    maxTimeoutMs: null,
    trigger: { maxDepth: 5, maxPerChain: 200, maxPerJob: 10 },
  })
  .meta({
    title: 'Jobs',
    description: 'Session hygiene between jobs — what gets cleaned up on a device before each run.',
  })
export type JobSettings = z.infer<typeof JobSettingsSchema>

/**
 * `discovery.networks[].cidr` (plan 88 §3.5, §3.6, §4.2) — the bounded
 * sweep's whole address space. IPv4 only: every example and every cost-model
 * number in the plan is IPv4 (`10.20.0.0/24`, TEST-NET-1's `192.0.2.0/24`),
 * and a farm chassis switch does not hand out IPv6 leases in practice.
 */
const IPV4_OCTET = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d|0)'
const IPV4_CIDR_RE = new RegExp(`^${IPV4_OCTET}\\.${IPV4_OCTET}\\.${IPV4_OCTET}\\.${IPV4_OCTET}/(3[0-2]|[12]?\\d)$`)

export const CidrSchema = z
  .string()
  .regex(IPV4_CIDR_RE, 'must be an IPv4 CIDR block, like 10.20.0.0/24')
  .meta({ title: 'Network (CIDR)' })

/**
 * Total addresses a CIDR block contributes to `scan.maxAddresses`'s ceiling —
 * `2 ** (32 - prefix)`, INCLUDING the network and broadcast address, so four
 * `/24`s add up to exactly 1024 (`scan.maxAddresses`'s own default, plan 88
 * §4.2 and §3.5's "four /24s" note). The sweep itself
 * (`packages/core/src/registry/sweep.ts`) probes fewer addresses than this
 * per block — it skips each block's network/broadcast address — because this
 * function answers "how big is the ceiling", not "how many probes will this
 * cost". Returns 0 for anything `CidrSchema` would already have rejected,
 * rather than throwing — a save-time refinement over an array of these must
 * never itself be the thing that crashes on a malformed row.
 */
export function addressCount(cidr: string): number {
  const match = /\/(\d{1,2})$/.exec(cidr)
  if (!match) return 0
  const prefix = Number(match[1])
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return 0
  return 2 ** (32 - prefix)
}

/** Farm-wide settings (a single row). */
export const FarmSettingsSchema = z.object({
  // Literally the per-device schema — see the note on DeviceSettingsSchema.
  // A thunk: every inner field already carries a default, so parsing an empty
  // object yields the canonical defaults without duplicating them here.
  defaults: DeviceSettingsSchema.default(() => DeviceSettingsSchema.parse({})).meta({
    title: 'Defaults for new devices',
    description:
      'Copied onto a device the first time it is enrolled. Devices already registered keep their own settings.',
  }),
  battery: z
    .object({
      pollIntervalSec: z.number().int().min(10).default(60).describe('How often battery and temperature are read, in seconds').meta(ui({ title: 'Polling interval', kind: 'duration', unit: 's' })),
      autoQuarantine: z.boolean().default(true).describe('Pull a device from the queue when it passes the temperature threshold').meta({ title: 'Auto-quarantine when hot' }),
      tempThresholdC: z.number().default(45).describe('The temperature considered too hot, in °C').meta(ui({ title: 'Temperature threshold', kind: 'temperature' })),
    })
    .default({ pollIntervalSec: 60, autoQuarantine: true, tempThresholdC: 45 })
    .meta({
      title: 'Battery and temperature',
      description: 'Overheating devices are pulled from the queue so job results stay trustworthy.',
    }),
  retention: z
    .object({
      enabled: z.boolean().default(false).meta({ title: 'Clean up automatically' }),
      // `maxAgeDays`/`maxTotalGb` and, below, `eventMainDays`/`eventInputDays`
      // are deliberately left bare (plan 95 §5 step 95.4's report): `kind:
      // 'duration'` requires a `unit` from `DURATION_UNITS` (`ms|s|min|h`) —
      // there is no `'d'` — and `kind: 'bytes'` means the STORED value is a
      // raw byte integer the control humanises on display (§4.6), which
      // `maxTotalGb` (a plain GB count) is not. Writing either kind here
      // would be a wrong, confidently-mislabelled control, not a bare one.
      maxAgeDays: z.number().int().default(30).describe('Artifacts older than this are deleted').meta({ title: 'Maximum age (days)' }),
      maxTotalGb: z.number().default(20).describe('The oldest are deleted first once the limit is passed').meta({ title: 'Maximum size (GB)' }),
      /**
       * Device event log budgets (plan 18 §4.4). Unlike the artifact policy
       * above, these are NOT gated by `enabled` — an unbounded input stream
       * is a disk-filling bug, not an opt-in convenience, so the row ceiling
       * always applies.
       */
      eventMainDays: z
        .number()
        .int()
        .min(1)
        .default(30)
        .describe('Main-stream device events older than this are deleted')
        .meta({ title: 'Main log retention (days)' }),
      eventInputDays: z
        .number()
        .int()
        .min(1)
        .default(3)
        .describe('Input-stream device events older than this are deleted — this stream is far higher volume')
        .meta({ title: 'Input log retention (days)' }),
      eventMaxRowsPerDevice: z
        .number()
        .int()
        .min(1000)
        .default(50_000)
        .describe('Hard ceiling per device per stream; the oldest rows go first once the age budget is not enough')
        .meta(ui({ title: 'Max rows per device per stream', kind: 'count' })),
      /**
       * Agent screenshot blob GC (`agent_blobs`, plan 70 §4.1) — content-
       * addressed image bytes an AI agent's tool calls store, one row per
       * distinct screenshot. Deliberately NOT the same shape as the artifact
       * policy above: a blob referenced by a live thread's messages is NEVER
       * a deletion candidate at any age (deleting one a live thread still
       * renders would break that thread's transcript), so there is no
       * `maxAgeDays`/`maxTotalGb` pair here to threaten one. Only a blob no
       * message anywhere references — orphaned by a deleted thread (`agent/
       * thread/store.ts`'s `deleteThread`), or an upload from `POST /api/v1/
       * blobs` whose message was never sent — is ever a candidate, and only
       * once it clears this grace window. Like `eventMainDays`/`eventInputDays`
       * above, this is NOT gated by `enabled`: an unreferenced blob is dead
       * weight by construction, never data a user expects to keep, so
       * cleaning it up is not the opt-in convenience the artifact policy is.
       */
      blobOrphanGraceHours: z
        .number()
        .int()
        .min(1)
        .default(24)
        .describe('An agent screenshot blob no message references anywhere is deleted once it is this old. Protects an upload still mid-compose from being swept before its message is sent.')
        .meta(ui({ title: 'Unreferenced screenshot grace period (hours)', kind: 'duration', unit: 'h' })),
    })
    .default({ enabled: false, maxAgeDays: 30, maxTotalGb: 20, eventMainDays: 30, eventInputDays: 3, eventMaxRowsPerDevice: 50_000, blobOrphanGraceHours: 24 })
    .meta({
      title: 'Artifact storage',
      description: 'Screenshots and job logs pile up over time. Turn this on to clear them automatically.',
    }),
  /**
   * adb concurrency and per-command budgets (plan 23 §4.1). `maxConcurrent: 0`
   * means "scale automatically with fleet size" (§3.2 of the plan) — a
   * non-zero value pins the global semaphore and the autoscaler leaves it alone.
   */
  adb: z
    .preprocess(
      normaliseLegacyAdb,
      z.object({
        maxConcurrent: z
          .number()
          .int()
          .min(0)
          .max(24)
          .default(0)
          .describe('Total adb commands in flight across the farm. 0 = scale automatically with device count.')
          .meta(ui({ title: 'Max concurrent adb commands', kind: 'count' })),
        execTimeoutMs: z
          .number()
          .int()
          .min(1_000)
          .max(120_000)
          .default(15_000)
          .describe('Default execution budget for a single adb command.')
          .meta(ui({ title: 'adb command timeout (ms)', kind: 'duration', unit: 'ms' })),
        maxQueueDepth: z
          .number()
          .int()
          .min(4)
          .max(256)
          .default(32)
          .describe('Pending adb commands allowed per device before new ones are rejected.')
          .meta(ui({ title: 'Max queue depth per device', kind: 'count' })),
        /**
         * The streaming lane's own budget (plan 24 §3.2, §4.2) — completely
         * separate from `maxConcurrent` above: streams never draw from the
         * exec semaphore, so their limit is its own field rather than a slice
         * of it.
         *
         * Raised from 3 to 4 by plan 39 §3.3: with the ui-server inspector
         * (plan 34), the always-on crash watcher (plan 37), a human's Monitor
         * tab, and now a file transfer or `pm install` (plan 39 — both run on
         * this lane, never `PerDeviceQueue`, so a 60 MB push does not block
         * video/input/jobs on that device), four concurrent slots is the
         * floor that lets all four coexist without one starving another. This
         * must never be lowered back down.
         */
        maxStreamsPerDevice: z
          .number()
          .int()
          .min(1)
          .max(8)
          .default(4)
          .describe(
            'Concurrent adb streams (logcat, top, crash, file transfer, ...) allowed on one device. Kept above 1 because the ui-server inspector, the always-on crash watcher, and a file transfer or APK install each hold a slot of their own, on top of anything a human opens in the Monitor tab.',
          )
          .meta(ui({ title: 'Max streams per device', kind: 'count' })),
        // CHANGED (plan 85 §3.1, §4.1): 0 = auto (computeAutoStreams). A
        // stored 4 is rewritten to 0 by `normaliseLegacyAdb` above — tracked
        // removal, 00-overview §9.
        maxStreams: z
          .number()
          .int()
          .min(0)
          .max(64)
          .default(0)
          .describe('Concurrent adb streams allowed across the whole farm. 0 scales it automatically with the number of connected devices.')
          .meta(ui({ title: 'Max concurrent streams (farm-wide)', kind: 'count' })),
        maxHostConcurrent: z
          .number()
          .int()
          .min(1)
          .max(32)
          .default(4)
          .describe('How many adb command-line processes (install, push, forward) may run at once.')
          .meta(ui({ title: 'Max adb CLI processes', kind: 'count' })),
        maxInstallConcurrent: z
          .number()
          .int()
          .min(1)
          .max(16)
          .default(2)
          .describe('How many APK installs or file pushes may run at once across the farm. USB bandwidth is shared.')
          .meta(ui({ title: 'Max concurrent installs', kind: 'count' })),
      }),
    )
    .default({ maxConcurrent: 0, execTimeoutMs: 15_000, maxQueueDepth: 32, maxStreamsPerDevice: 4, maxStreams: 0, maxHostConcurrent: 4, maxInstallConcurrent: 2 })
    .meta({
      title: 'adb concurrency',
      description: 'How many adb commands the farm runs at once, and the budgets for a single command.',
    }),
  /**
   * Device discovery reconciliation (plan 85 §3.3, §4.1) — schema only here;
   * the reconciler that reads these is plan 85.2. `scanIntervalSec: 0`
   * disables the periodic rescan entirely (regression watch, plan 85 §7.4).
   *
   * Plan 88 §4.2, §5 step 88.2 adds the address-book / reconnect-ladder
   * fields (`tcpPort`, `endpointsPerDevice`, `endpointRetireAfter`,
   * `connectSettleMs`) to this SAME block, since they answer the same
   * question this block already asks — "how does the farm find its devices"
   * — one field at a time rather than a new top-level block. Step 88.3 adds
   * `networks` and `scan` (the farm-network list and the bounded subnet
   * sweep) here too, plus the cross-field `maxAddresses` refinement below
   * that needs both to exist first — still no new top-level key.
   */
  discovery: z
    .object({
      scanIntervalSec: z
        .number()
        .int()
        .min(0)
        .max(300)
        .default(10)
        .describe('How often adb is re-scanned for devices the live event stream may have missed. 0 disables the rescan.')
        .meta(ui({ title: 'Device rescan interval (s)', kind: 'duration', unit: 's' })),
      offlineGraceSec: z
        .number()
        .int()
        .min(5)
        .max(600)
        .default(20)
        .describe('How long a device may sit in adb’s "offline" state before one automatic reconnect is attempted.')
        .meta(ui({ title: 'Offline grace (s)', kind: 'duration', unit: 's' })),
      recoveryCooldownSec: z
        .number()
        .int()
        .min(30)
        .max(3600)
        .default(120)
        .describe('Minimum gap between automatic reconnect attempts for the same device.')
        .meta(ui({ title: 'Recovery cooldown (s)', kind: 'duration', unit: 's' })),
      /** plan 88 §4.2, §5 step 88.2. */
      tcpPort: z
        .number()
        .int()
        .min(1024)
        .max(65535)
        .default(5555)
        .describe('The port a device listens on for adb over the network. 5555 is the default everywhere.')
        .meta({ title: 'adb TCP port' }),
      /** plan 88 §3.2, §4.2, §5 step 88.2 — the address book's per-device cap. */
      endpointsPerDevice: z
        .number()
        .int()
        .min(1)
        .max(16)
        .default(4)
        .describe('How many past network addresses to remember per device.')
        .meta(ui({ title: 'Remembered addresses per device', kind: 'count' })),
      /** plan 88 §3.3, §4.2, §5 step 88.2 — the ladder's own retirement rule. */
      endpointRetireAfter: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(10)
        .describe('Stop trying a remembered address after this many failures in a row.')
        .meta(ui({ title: 'Retire an address after', kind: 'count' })),
      /** plan 88 §3.3, §4.2, §5 step 88.2 — the ladder's settle-and-verify wait. */
      connectSettleMs: z
        .number()
        .int()
        .min(500)
        .max(30_000)
        .default(3_000)
        .describe('How long to wait for a device to appear after connecting to it.')
        .meta(ui({ title: 'Connect settle time (ms)', kind: 'duration', unit: 'ms' })),
      /**
       * Farm networks (plan 88 §3.5, §3.6, §4.2) — one list serves two
       * separate facts so they never drift apart: `medium` labels a device
       * found on it (§3.1's badge, `mediumSource: 'network'`), and
       * `scan: true` includes it in the sweep's address space. Empty by
       * default — a sweep with no configured network is unavailable and says
       * so, rather than falling back to guessing at one.
       */
      networks: z
        .array(
          z.object({
            cidr: CidrSchema,
            label: z.string().max(40).default(''),
            // NOT `ConnectionMediumSchema` from `./device`: device.ts already
            // imports `BatteryStateSchema` from THIS file, so importing back
            // from device.ts here would close an import cycle. Two string
            // literals repeated is cheaper than that, and Zod still enforces
            // the exact same two values.
            medium: z.enum(['wired', 'wireless']).default('wired').meta({ title: 'Medium' }),
            scan: z.boolean().default(true).meta({ title: 'Include in a sweep' }),
          }),
        )
        .max(16)
        .default([])
        .describe('The networks your devices live on. Enkaku labels a device found here, and scans the ones you tick.')
        .meta({ title: 'Farm networks' }),
      /**
       * The bounded sweep's own policy (plan 88 §3.5, §4.2) — address space
       * comes from `networks` above, never auto-derived from the host's own
       * subnets (a laptop on a corporate /16 would otherwise sweep 65,536
       * addresses because someone pressed a button).
       */
      scan: z
        .object({
          // §9 Q1 (decided 2026-08-12): 'auto' was cut before shipping — the
          // owner's decision is manual trigger only, full stop. No cooldown
          // field exists either: it would exist solely to gate a background
          // cadence this mode does not have.
          mode: z
            .enum(['off', 'on-demand'])
            .default('on-demand')
            .describe('When Enkaku may scan a network for devices. On demand = only when you ask, or during a guided move to the network. There is no automatic background scan.')
            .meta({ title: 'Network scanning' }),
          maxAddresses: z
            .number()
            .int()
            .min(64)
            .max(4096)
            .default(1024)
            .describe('The most addresses one scan may probe, across every scanned network.')
            .meta(ui({ title: 'Max addresses per scan', kind: 'count' })),
          concurrency: z
            .number()
            .int()
            .min(1)
            .max(256)
            .default(32)
            .describe('TCP pre-probes run at once during a sweep.')
            .meta(ui({ title: 'Simultaneous probes', kind: 'count' })),
          probeTimeoutMs: z
            .number()
            .int()
            .min(50)
            .max(5_000)
            .default(300)
            .describe('How long the cheap TCP pre-probe waits for an address to answer before moving on.')
            .meta(ui({ title: 'Probe timeout (ms)', kind: 'duration', unit: 'ms' })),
        })
        .default({ mode: 'on-demand', maxAddresses: 1024, concurrency: 32, probeTimeoutMs: 300 })
        .meta({
          title: 'Network scan',
          description: "The bounded subnet sweep's own policy (plan 88 §3.5) — on-demand only, never a background timer.",
        }),
    })
    .superRefine((d, ctx) => {
      // The cross-field ceiling (plan 88 §4.2): a sum over `networks`, not a
      // per-row bound, because one huge network and four small ones can both
      // total the same packet cost — checked here, at save time, so an
      // over-large config fails with a named message instead of at 2 a.m.
      // during a scan.
      const total = d.networks.filter((n) => n.scan).reduce((sum, n) => sum + addressCount(n.cidr), 0)
      if (total > d.scan.maxAddresses) {
        ctx.addIssue({
          code: 'custom',
          path: ['networks'],
          message: `these networks add up to ${total} addresses, over the ${d.scan.maxAddresses} limit — untick one, narrow a range, or raise the limit`,
        })
      }
    })
    .default({
      scanIntervalSec: 10,
      offlineGraceSec: 20,
      recoveryCooldownSec: 120,
      tcpPort: 5555,
      endpointsPerDevice: 4,
      endpointRetireAfter: 10,
      connectSettleMs: 3_000,
      networks: [],
      scan: { mode: 'on-demand', maxAddresses: 1024, concurrency: 32, probeTimeoutMs: 300 },
    })
    .meta({
      title: 'Device discovery',
      description: 'How often adb is re-scanned for devices the live event stream may have missed, the recovery cadence for offline/unauthorized devices, how network addresses are remembered and retried, the farm-network list, and the bounded subnet sweep (plan 88).',
    }),
  /**
   * The always-on crash watcher's farm-wide switch (plan 85 §3.2, §4.1) —
   * schema only here; the consumer that reads it is plan 85.4.
   */
  monitor: z
    .object({
      crashWatch: z
        .enum(['always', 'off'])
        .default('always')
        .describe('Keep a logcat crash feed open on every device with a live session.')
        .meta({ title: 'Always-on crash detection' }),
    })
    .default({ crashWatch: 'always' })
    .meta({
      title: 'Crash monitoring',
      description: 'Whether the always-on crash feed stays open for the life of a session.',
    }),
  /**
   * Auto-quarantine on repeated adb failure, and its automatic recovery
   * (plan 23 §3.5, §3.6) — reuses the existing `quarantined` status rather
   * than inventing a new one; only reasons prefixed `adb:` are ever released
   * automatically, so thermal quarantine (§15.2) stays manual-release only.
   */
  health: z
    .object({
      consecutiveFailures: z
        .number()
        .int()
        .min(1)
        .max(20)
        .default(3)
        .describe('Consecutive adb timeouts before a device is quarantined as unreachable.')
        .meta(ui({ title: 'Failures before quarantine', kind: 'count' })),
      autoQuarantine: z
        .boolean()
        .default(true)
        .describe('Quarantine a device automatically when it stops answering adb.')
        .meta({ title: 'Auto-quarantine unreachable devices' }),
      probeIntervalSec: z
        .number()
        .int()
        .min(10)
        .max(3600)
        .default(60)
        .describe('How often a device quarantined for adb failures is re-probed.')
        .meta(ui({ title: 'Recovery probe interval (s)', kind: 'duration', unit: 's' })),
    })
    .default({ consecutiveFailures: 3, autoQuarantine: true, probeIntervalSec: 60 })
    .meta({
      title: 'Device health',
      description: 'A device that stops answering adb is pulled from the queue, and put back once it answers again.',
    }),
  /**
   * adb SERVER health monitoring AND control (plan 88 §3.9, §3.10, §4.7,
   * §4.8, §5 step 88.9) — distinct from `health` above, which quarantines
   * one unreachable DEVICE. `healthIntervalSec`/`stuckTimeoutRate` watch the
   * shared adb server itself, farm-wide, and answer "is adb stuck?" (F21,
   * F23) rather than "is this phone stuck?" — the doctor check that reads
   * them stays read-only and never restarts anything.
   *
   * `restartCooldownSec`/`drainTimeoutMs` govern the ONE thing in this block
   * that actually touches the server: `adb-server-control.ts`'s `cycle()`,
   * behind both the Toolchain Manager's version swap and the operator's
   * Restart adb server button. These two fields shipped as local constants
   * in `daemon.ts` (`ADB_CYCLE_DRAIN_TIMEOUT_MS`, `ADB_RESTART_COOLDOWN_SEC`)
   * in step 88.8 because this file was under concurrent edit by another
   * worker at the time; promoted to real settings here, same defaults,
   * same call sites (both already read through a function, never a
   * captured constant, so this was always a one-line follow-up).
   */
  adbControl: z
    .object({
      healthIntervalSec: z
        .number()
        .int()
        .min(5)
        .max(300)
        .default(15)
        .describe('How often the shared adb server is probed with host:version to measure whether it is still responding.')
        .meta(ui({ title: 'adb health probe interval (s)', kind: 'duration', unit: 's' })),
      stuckTimeoutRate: z
        .number()
        .min(0)
        .max(1)
        .default(0.5)
        .describe('Share of adb commands timing out over the last 10 minutes (of at least 20) before that is reported as a timeout storm rather than ordinary load.')
        .meta(ui({ title: 'Timeout-storm threshold', kind: 'chance' })),
      restartCooldownSec: z
        .number()
        .int()
        .min(10)
        .max(3600)
        .default(60)
        .describe('Minimum gap between adb server restarts — refuses a second Restart adb server click before the farm has settled from the first.')
        .meta(ui({ title: 'adb restart cooldown', kind: 'duration', unit: 's' })),
      drainTimeoutMs: z
        .number()
        .int()
        .min(5_000)
        .max(300_000)
        .default(30_000)
        .describe('How long a restart or version swap waits for in-flight adb work and live sessions to finish before giving up.')
        .meta(ui({ title: 'adb drain timeout (ms)', kind: 'duration', unit: 'ms' })),
    })
    .default({ healthIntervalSec: 15, stuckTimeoutRate: 0.5, restartCooldownSec: 60, drainTimeoutMs: 30_000 })
    .meta({
      title: 'adb server health',
      description: 'How closely the shared adb server is watched for signs it is stuck, not just busy, and the drain/cooldown rules the Restart adb server action follows.',
    }),
  /**
   * The interactive device terminal (plan 26 §4.1). `mode` defaults to
   * `'admin'` here — that default is correct for a loopback (single-user)
   * install. A server-mode install (non-loopback bind) overrides it to
   * `'off'` at config load instead, in `createFarmSettingsStore`: the auth
   * mode is derived from the bind address, which this Zod schema cannot see.
   */
  shell: z
    .object({
      // `mode`/`execTimeoutMs`/`maxOutputBytes` are the terminal itself;
      // `endpointEnabled`/`endpointBind`/`endpointIdleSec`/`maxEndpointStreams`
      // below are the SEPARATE adb-endpoint opt-in this object's own doc
      // comment already calls out as independent of `mode` — two maximal
      // consecutive runs, grouped accordingly (plan 95 §5 step 95.4).
      mode: ShellModeSchema.default('admin')
        .describe('Who may run shell commands on a device. Off disables the terminal entirely.')
        .meta(ui({ title: 'Device terminal access', group: 'Terminal' })),
      execTimeoutMs: z
        .number()
        .int()
        .min(1_000)
        .max(120_000)
        .default(15_000)
        .describe('Budget for a single terminal command.')
        .meta(ui({ title: 'Terminal command timeout (ms)', kind: 'duration', unit: 'ms', group: 'Terminal' })),
      maxOutputBytes: z
        .number()
        .int()
        .min(4_096)
        .max(4_194_304)
        .default(262_144)
        .describe('Output kept per command before truncation.')
        .meta(ui({ title: 'Max output per command (bytes)', kind: 'bytes', group: 'Terminal' })),
      /**
       * The local adb endpoint (plan 27 §4.3) — a SEPARATE opt-in from
       * `mode` above: a farm can allow the terminal (`mode: 'admin'`) while
       * keeping the endpoint off, or vice versa. Defaults to `false`
       * unconditionally, on a loopback install too — unlike the terminal,
       * there is no server-mode-only asymmetry here, because handing out a
       * whole adb endpoint is a bigger decision than a single gated shell
       * and should never be a discovery, even on a single-user laptop.
       */
      endpointEnabled: z
        .boolean()
        .default(false)
        .describe('Allow lease holders to open a temporary adb endpoint for this farm.')
        .meta(ui({ title: 'Allow adb endpoint', group: 'adb endpoint' })),
      endpointBind: z
        .string()
        .min(1)
        .default('127.0.0.1')
        .describe('Address the temporary adb endpoint binds to. Anything other than 127.0.0.1 exposes full device control to that network.')
        .meta(ui({ title: 'adb endpoint bind address', group: 'adb endpoint' })),
      endpointIdleSec: z
        .number()
        .int()
        .min(30)
        .max(3_600)
        .default(300)
        .describe('Close the endpoint after this long with no connection.')
        .meta(ui({ title: 'adb endpoint idle timeout (s)', kind: 'duration', unit: 's', group: 'adb endpoint' })),
      maxEndpointStreams: z
        .number()
        .int()
        .min(1)
        .max(32)
        .default(8)
        .describe('Concurrent adb streams allowed per endpoint.')
        .meta(ui({ title: 'Max endpoint streams', kind: 'count', group: 'adb endpoint' })),
    })
    .default({
      mode: 'admin',
      execTimeoutMs: 15_000,
      maxOutputBytes: 262_144,
      endpointEnabled: false,
      endpointBind: '127.0.0.1',
      endpointIdleSec: 300,
      maxEndpointStreams: 8,
    })
    .meta({
      title: 'Device terminal',
      description: 'Free-form adb shell commands, gated by permission and audited in full (plan 26), plus an optional lease-scoped adb endpoint (plan 27).',
    }),
  job: JobSettingsSchema,
  /**
   * Idle session TTL (plan 42 §3.4, §4.4): when the last viewer of a device
   * leaves, the session is not closed right away — it is kept alive for
   * `idleTtlSec` in case the same or another viewer returns shortly, which is
   * what makes returning to a device instant instead of a fresh wake-up.
   * Bounded farm-wide by `maxIdleSessions` so a big fleet cannot hold every
   * device's session open at once; `idleTtlSec: 0` restores the pre-plan-42
   * behaviour of closing the instant the last viewer leaves.
   */
  session: z
    .object({
      idleTtlSec: z
        .number()
        .int()
        .min(0)
        .max(3600)
        .default(300)
        .describe('How long a device session stays alive after the last viewer leaves, so returning is instant. 0 closes it immediately.')
        .meta(ui({ title: 'Idle session TTL (s)', kind: 'duration', unit: 's' })),
      maxIdleSessions: z
        .number()
        .int()
        .min(0)
        .max(64)
        .default(8)
        .describe('How many idle sessions may be held open across the farm before the oldest is closed.')
        .meta(ui({ title: 'Max idle sessions', kind: 'count' })),
    })
    .default({ idleTtlSec: 300, maxIdleSessions: 8 })
    .meta({
      title: 'Device sessions',
      description: 'How long a device session lingers after the last viewer leaves, and how many may linger at once.',
    }),
  /**
   * The fleet Wall (plan 42 §3.5, §4.6) — a grid of every device's screen at
   * a low-rate `wall` quality profile, capped so a big fleet does not
   * saturate the browser or the network with live decoders at once.
   */
  wall: z
    .object({
      maxTiles: z
        .number()
        .int()
        .min(1)
        .max(64)
        .default(8)
        .describe('How many wall tiles stream live at once. The rest show their status and a "show live" action.')
        .meta(ui({ title: 'Max live wall tiles', kind: 'count' })),
    })
    .default({ maxTiles: 8 })
    .meta({
      title: 'Fleet wall',
      description: 'The devices list Wall mode: every screen live, at a low-rate quality profile.',
    }),
  /**
   * Device readiness (plan 43 §3.5, §4.4) — `maxHot` deliberately matches
   * `wall.maxTiles` and `session.maxIdleSessions` above (both default 8), so
   * one page of the Wall is, by default, exactly the set of devices that can
   * be hot: the thing you are looking at is the thing that is warm.
   */
  readiness: z
    .object({
      maxHot: z
        .number()
        .int()
        .min(0)
        .max(64)
        .default(8)
        .describe('How many devices may be held hot (session alive, encoder running) at once. Hot devices open instantly but the encoder costs device CPU and battery.')
        .meta(ui({ title: 'Max hot devices', kind: 'count' })),
      defaultDesired: ReadinessSchema.default('asleep')
        .describe('Readiness a newly enrolled device starts at.')
        .meta({ title: 'Default device readiness' }),
    })
    .default({ maxHot: 8, defaultDesired: 'asleep' })
    .meta({
      title: 'Device readiness',
      description: 'How many devices may be held warm at once, and what a newly enrolled device starts at.',
    }),
  /**
   * File transfer and APK install (plan 39 §4.3) — push, pull, and install
   * all run on the plan 24 streaming lane, never `PerDeviceQueue`, and the
   * client always names an artifact id, never a URL or filesystem path
   * (§3.5 — the SSRF-shaped hole that rule closes).
   */
  transfer: z
    .object({
      enabled: z
        .boolean()
        .default(true)
        .describe('Allow file transfer and APK install from Studio and scripts.')
        .meta({ title: 'Allow file transfer' }),
      maxPushBytes: z
        .number()
        .int()
        .min(1_048_576)
        .default(536_870_912)
        .describe('Largest file that may be pushed or installed.')
        .meta(ui({ title: 'Max push size (bytes)', kind: 'bytes' })),
      maxPullBytes: z
        .number()
        .int()
        .min(1_048_576)
        .default(536_870_912)
        .describe('Largest file that may be pulled from a device.')
        .meta(ui({ title: 'Max pull size (bytes)', kind: 'bytes' })),
      installTimeoutMs: z
        .number()
        .int()
        .min(10_000)
        .max(1_800_000)
        .default(300_000)
        .describe('Budget for pm install once the APK is on the device. Runs on the streaming lane, not the 120s adb exec ceiling.')
        .meta(ui({ title: 'Install timeout (ms)', kind: 'duration', unit: 'ms' })),
    })
    .default({ enabled: true, maxPushBytes: 536_870_912, maxPullBytes: 536_870_912, installTimeoutMs: 300_000 })
    .meta({
      title: 'File transfer',
      description: 'Push, pull, and APK install from Studio, a script, or a batch — always from a server-side artifact, never a client-supplied URL or path.',
    }),
  /**
   * Plan 55 §3.2, §5.1, §5.2 — the pluggable geo lookup the `geo` check compares an observed
   * exit address against a route's declared `expect`ation with. UNSET BY DEFAULT, on purpose
   * (§3.2: "a hosted geolocation service of our own" is explicitly a non-goal) — hardcoding one
   * vendor here would repeat the exact mistake Plan 51 §4.1 and Plan 55 §3.1 already refused for
   * geo-TARGETING syntax (never infer a region from the credential username). Unlike
   * `network.probeUrl`/`network.sessionTemplate` (still read from an env var, a scope decision
   * recorded on `probeUrl()` in `packages/core/src/api/guest-agent.ts`), this one lives in real
   * farm settings from the start: it needs to be something an operator sets from Studio, not
   * just at process start, and — unlike an env var — a value saved here and never read by
   * anything is a bug a test can actually catch.
   */
  network: z
    .object({
      // NOT `kind: 'text'` (plan 95 §5 step 95.4's report): `.url()` already
      // gives this node `format: 'uri'`, which the resolver's row 7 reads as
      // JSON Schema's own semantics — a real URL control. `kind: 'text'`
      // would win at row 3 (checked earlier) and downgrade it to a plain
      // text box, losing that for no gain (`text` and bare render
      // identically). Left off on purpose, not left off by oversight.
      geoProvider: z
        .string()
        .url()
        .optional()
        .describe(
          'URL of a GET <geoProvider>?ip=<address> endpoint answering GeoProviderResponseSchema\'s shape. Unset: the geo check stays skip, naming this setting. The self-hosted probe endpoint (packages/probe-server) implements this at its own /geo route.',
        )
        .meta({ title: 'Geo lookup provider URL' }),
      geoIntervalSec: z
        .number()
        .int()
        .min(30)
        .max(86_400)
        .default(300)
        .describe(
          'How often a route\'s exit is re-checked against its declared region, in seconds. A residential pool that rotates every few minutes is still caught; a lookup on every 20s heartbeat tick would be real per-device traffic and cost at fleet scale (Plan 51 §9 Q1, Plan 55 §3.4) for no extra safety.',
        )
        .meta(ui({ title: 'Geo re-check interval (s)', kind: 'duration', unit: 's' })),
    })
    .default({ geoIntervalSec: 300 })
    .meta({
      title: 'Network geo verification',
      description: 'Where the geo check looks up an exit address\'s location, and how often it re-checks a route already applied.',
    }),
  /**
   * The database-backed workspace (plan 64 §3.3) — three quotas so an agent
   * in a retry loop is not a fine way to fill a disk. `E_QUOTA` names
   * whichever of these was exceeded, plus current usage, so a caller that
   * hits one can act on it (delete something) rather than just retry.
   */
  workspace: z
    .object({
      maxFileBytes: z
        .number()
        .int()
        .min(1)
        .default(1_048_576)
        .describe('Largest single workspace file, in bytes.')
        .meta(ui({ title: 'Max file size (bytes)', kind: 'bytes' })),
      maxFilesPerScope: z
        .number()
        .int()
        .min(1)
        .default(1_000)
        .describe('Largest number of files inside one top-level scope (a directory like /shared/, or one agent\'s /agents/<slug>/ home).')
        .meta(ui({ title: 'Max files per scope', kind: 'count' })),
      maxTotalBytesPerScope: z
        .number()
        .int()
        .min(1)
        .default(67_108_864)
        .describe('Largest total size of one scope\'s files, in bytes.')
        .meta(ui({ title: 'Max total bytes per scope', kind: 'bytes' })),
    })
    .default({ maxFileBytes: 1_048_576, maxFilesPerScope: 1_000, maxTotalBytesPerScope: 67_108_864 })
    .meta({
      title: 'Workspace',
      description: 'Limits on the database-backed workspace agents and people share (plan 64).',
    }),
  /**
   * The durable key/value store scripts use across jobs (plan 79 §4.3) —
   * quotas so a retry loop cannot turn it into a place to keep a 40 MB
   * screenshot. `E_KV_QUOTA_EXCEEDED`/`E_KV_VALUE_TOO_LARGE`/`E_KV_KEY_INVALID`
   * name whichever of these was exceeded, the same "name the limit" pattern
   * `workspace` above already established.
   */
  kv: z
    .object({
      maxValueBytes: z
        .number()
        .int()
        .min(1)
        .default(65_536)
        .describe('Largest single stored value, in bytes (the JSON-encoded plaintext — measured before encryption for a secret).')
        .meta(ui({ title: 'Max value size (bytes)', kind: 'bytes' })),
      // NOT `kind: 'bytes'` (this is a count of CHARACTERS in a key, not a
      // byte size — `bytes`'s control humanises via 1024-based units, which
      // would misreport "256" as "256 B" implying a storage size) and not
      // confidently `kind: 'count'` either (`count`'s own examples —
      // `videos`, `wall.maxTiles` — are all counts of discrete objects, not
      // a string length). Left bare rather than picked between two
      // plausible-but-not-quite-right kinds.
      maxKeyLength: z
        .number()
        .int()
        .min(1)
        .default(256)
        .describe('Longest key allowed, in characters. A key is [A-Za-z0-9._:-]+ — no whitespace, no "/", so it never needs escaping in a log line or a URL.')
        .meta({ title: 'Max key length' }),
      maxEntriesPerNamespace: z
        .number()
        .int()
        .min(1)
        .default(1_000)
        .describe('Largest number of keys one (scope, namespace) pair may hold.')
        .meta(ui({ title: 'Max entries per namespace', kind: 'count' })),
      maxEntriesPerDevice: z
        .number()
        .int()
        .min(1)
        .default(5_000)
        .describe('Largest number of device-scoped entries one device (across every namespace) may hold.')
        .meta(ui({ title: 'Max entries per device', kind: 'count' })),
    })
    .default({ maxValueBytes: 65_536, maxKeyLength: 256, maxEntriesPerNamespace: 1_000, maxEntriesPerDevice: 5_000 })
    .meta({
      title: 'KV store',
      description: 'Limits on the durable key/value store scripts use across jobs (plan 79) — global and per-device.',
    }),
  /**
   * AI agent defaults (plan 65 §3.1, §3.7) — model, provider connector, and
   * context budgets an agent inherits unless it overrides them
   * (`AgentSettingsSchema` in `./agent.ts`). Same pattern as `defaults`
   * above: one schema, reused for both the farm-wide row and the per-entity
   * override.
   */
  agentDefaults: AgentDefaultsSchema.default(() => AgentDefaultsSchema.parse({})).meta({
    title: 'Agent defaults',
    description: 'Model, provider connector, and budgets a new agent inherits until it overrides them.',
  }),
  /**
   * Ceilings that apply ONLY to a SCHEDULED agent run (plan 68 §3.3) — an
   * interactive run started from Studio is never blocked by either of
   * these, on purpose: a cost control that can stop a person at a keyboard
   * turns into an outage. The spend cap is off by default (a ceiling
   * somebody did not choose, silently stopping their overnight work, is its
   * own failure) but offered prominently here with its reason, because the
   * first time anyone points a five-minute cron at an agent with a high
   * step budget they will want it.
   */
  scheduledAgents: z
    .object({
      spendCapOutputTokensPer24h: z
        .number()
        .int()
        .positive()
        .nullable()
        .default(null)
        .describe('Farm-wide output tokens allowed for SCHEDULED agent runs in a rolling 24 hours. Unset (off) by default. Never applies to an interactive chat run.')
        .meta(ui({ title: 'Spend cap — scheduled runs only', kind: 'count' })),
      maxConcurrentScheduledRuns: z
        .number()
        .int()
        .min(1)
        .default(3)
        .describe('Scheduled agent runs allowed at once, farm-wide. A firing beyond this follows its own overlap policy.')
        .meta(ui({ title: 'Max concurrent scheduled runs', kind: 'count' })),
    })
    .default({ spendCapOutputTokensPer24h: null, maxConcurrentScheduledRuns: 3 })
    .meta({
      title: 'Scheduled agents',
      description: 'A spend ceiling and a concurrency ceiling for UNATTENDED agent runs (plan 68 §3.3) — an interactive run is never blocked by either.',
    }),
})
export type FarmSettings = z.infer<typeof FarmSettingsSchema>
export type SessionSettings = FarmSettings['session']
export type WallSettings = FarmSettings['wall']
export type ReadinessSettings = FarmSettings['readiness']
export type WorkspaceSettings = FarmSettings['workspace']
export type KvSettings = FarmSettings['kv']

export const defaultFarmSettings = (): FarmSettings => FarmSettingsSchema.parse({})
export const defaultDeviceSettings = (): DeviceSettings => DeviceSettingsSchema.parse({})
