import { z } from 'zod'
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
    .meta({ title: 'Tap duration' }),
  betweenActionMs: z
    .tuple([z.number(), z.number()])
    .default([300, 900])
    .describe('Random range for the pause between actions, in milliseconds')
    .meta({ title: 'Pause between actions' }),
  coordJitterPx: z.number().default(2).describe('Random offset applied to the tap point, in pixels').meta({ title: 'Tap point jitter' }),
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
    .meta({ title: 'Gesture sample interval (ms)' }),
  perCharMs: z
    .tuple([z.number().int().min(0), z.number().int().min(0)])
    .default([40, 140])
    .describe('Delay range between characters when typing.')
    .meta({ title: 'Typing cadence (ms)' }),
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
    // rejects values outside the list. `enumSource` tells the UI where to read
    // engine display names and availability (spec §8).
    engines: z
      .object({
        transport: z
          .enum(['adb-usb', 'adb-tcp'])
          .default('adb-usb')
          .describe('How the core talks to the device')
          .meta({ title: 'Transport', enumSource: 'registry.transports' }),
        display: z
          .enum(['scrcpy', 'screencap-loop'])
          .default('scrcpy')
          .describe('Where the picture sent to Studio comes from')
          .meta({ title: 'Screen capture', enumSource: 'registry.displays' }),
        input: z
          .enum(['scrcpy-uhid', 'scrcpy-sdk', 'adb-input'])
          .default('scrcpy-uhid')
          .describe('How taps, swipes, and typing reach the device')
          .meta({ title: 'Input delivery', enumSource: 'registry.inputs' }),
        inspection: z
          .enum(['ui-server', 'uiautomator-dump', 'appium'])
          .default('ui-server')
          .describe('How scripts find elements on screen')
          .meta({ title: 'Screen inspection', enumSource: 'registry.inspectors' }),
      })
      .default({
        transport: 'adb-usb',
        display: 'scrcpy',
        input: 'scrcpy-uhid',
        inspection: 'ui-server',
      })
      .meta({
        title: 'Engines',
        description: 'The core rejects combinations that cannot work together.',
      }),
    input: z
      .object({
        preferredMode: z
          .enum(['uhid', 'sdk', 'aoa'])
          .default('uhid')
          .describe('uhid looks like real hardware to the device; sdk is the widest-compatibility fallback')
          .meta({ title: 'Injection mode' }),
      })
      .default({ preferredMode: 'uhid' })
      .meta({ title: 'Input injection' }),
    // A thunk, not a literal object (plan 40 §4.3): a literal default bypasses
    // schema validation, so a hand-written object here would silently omit
    // any field added to `TimingSettingsSchema` later (as this plan just did)
    // and every consumer would read `undefined` for it at runtime despite TS
    // believing it present. Parsing `{}` through the schema itself keeps this
    // in lockstep with `TimingSettingsSchema`'s own defaults, always.
    timing: TimingSettingsSchema.default(() => TimingSettingsSchema.parse({})),
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
        }),
      )
      .default({ disableAnimations: true, keepAwake: 'while-charging', standbyScreenOff: false })
      .meta({ title: 'Before a job runs' }),
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
    identity: DeviceIdentitySchema.default(() => DeviceIdentitySchema.parse({})),
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
    resetPolicy: z
      .enum(['none', 'home', 'declared', 'aggressive'])
      .default('home')
      .describe(
        'What to reset on a device before each job. "home" returns to the launcher; "declared" also stops the packages a script declares; "aggressive" stops every non-system app.',
      )
      .meta({ title: 'Reset before each job' }),
    resetTimeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(60_000)
      .default(15_000)
      .describe('Budget for the pre-job reset. Exceeding it logs a warning and the job continues.')
      .meta({ title: 'Reset timeout (ms)' }),
    resetStrict: z
      .boolean()
      .default(false)
      .describe('Fail the job when its pre-job reset fails, instead of warning and continuing.')
      .meta({ title: 'Fail on reset error' }),
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
          .meta({ title: 'Infrastructure retries' }),
        backoffBaseMs: z
          .number()
          .int()
          .min(100)
          .max(60_000)
          .default(2_000)
          .describe('First backoff delay; it doubles each infrastructure retry, with jitter.')
          .meta({ title: 'Retry backoff base (ms)' }),
        backoffMaxMs: z
          .number()
          .int()
          .min(1_000)
          .max(300_000)
          .default(30_000)
          .describe('Upper bound on the backoff delay.')
          .meta({ title: 'Retry backoff cap (ms)' }),
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
  })
  .default({
    resetPolicy: 'home',
    resetTimeoutMs: 15_000,
    resetStrict: false,
    retry: { maxInfraAttempts: 2, backoffBaseMs: 2_000, backoffMaxMs: 30_000, timeoutIsInfra: false, rebindOnInfra: true },
    crashPolicy: 'declared',
  })
  .meta({
    title: 'Jobs',
    description: 'Session hygiene between jobs — what gets cleaned up on a device before each run.',
  })
export type JobSettings = z.infer<typeof JobSettingsSchema>

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
      pollIntervalSec: z.number().int().min(10).default(60).describe('How often battery and temperature are read, in seconds').meta({ title: 'Polling interval' }),
      autoQuarantine: z.boolean().default(true).describe('Pull a device from the queue when it passes the temperature threshold').meta({ title: 'Auto-quarantine when hot' }),
      tempThresholdC: z.number().default(45).describe('The temperature considered too hot, in °C').meta({ title: 'Temperature threshold' }),
    })
    .default({ pollIntervalSec: 60, autoQuarantine: true, tempThresholdC: 45 })
    .meta({
      title: 'Battery and temperature',
      description: 'Overheating devices are pulled from the queue so job results stay trustworthy.',
    }),
  retention: z
    .object({
      enabled: z.boolean().default(false).meta({ title: 'Clean up automatically' }),
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
        .meta({ title: 'Max rows per device per stream' }),
    })
    .default({ enabled: false, maxAgeDays: 30, maxTotalGb: 20, eventMainDays: 30, eventInputDays: 3, eventMaxRowsPerDevice: 50_000 })
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
    .object({
      maxConcurrent: z
        .number()
        .int()
        .min(0)
        .max(24)
        .default(0)
        .describe('Total adb commands in flight across the farm. 0 = scale automatically with device count.')
        .meta({ title: 'Max concurrent adb commands' }),
      execTimeoutMs: z
        .number()
        .int()
        .min(1_000)
        .max(120_000)
        .default(15_000)
        .describe('Default execution budget for a single adb command.')
        .meta({ title: 'adb command timeout (ms)' }),
      maxQueueDepth: z
        .number()
        .int()
        .min(4)
        .max(256)
        .default(32)
        .describe('Pending adb commands allowed per device before new ones are rejected.')
        .meta({ title: 'Max queue depth per device' }),
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
        .meta({ title: 'Max streams per device' }),
      maxStreams: z
        .number()
        .int()
        .min(1)
        .max(64)
        .default(4)
        .describe('Concurrent adb streams allowed across the whole farm.')
        .meta({ title: 'Max concurrent streams (farm-wide)' }),
    })
    .default({ maxConcurrent: 0, execTimeoutMs: 15_000, maxQueueDepth: 32, maxStreamsPerDevice: 4, maxStreams: 4 })
    .meta({
      title: 'adb concurrency',
      description: 'How many adb commands the farm runs at once, and the budgets for a single command.',
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
        .meta({ title: 'Failures before quarantine' }),
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
        .meta({ title: 'Recovery probe interval (s)' }),
    })
    .default({ consecutiveFailures: 3, autoQuarantine: true, probeIntervalSec: 60 })
    .meta({
      title: 'Device health',
      description: 'A device that stops answering adb is pulled from the queue, and put back once it answers again.',
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
      mode: ShellModeSchema.default('admin')
        .describe('Who may run shell commands on a device. Off disables the terminal entirely.')
        .meta({ title: 'Device terminal access' }),
      execTimeoutMs: z
        .number()
        .int()
        .min(1_000)
        .max(120_000)
        .default(15_000)
        .describe('Budget for a single terminal command.')
        .meta({ title: 'Terminal command timeout (ms)' }),
      maxOutputBytes: z
        .number()
        .int()
        .min(4_096)
        .max(4_194_304)
        .default(262_144)
        .describe('Output kept per command before truncation.')
        .meta({ title: 'Max output per command (bytes)' }),
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
        .meta({ title: 'Allow adb endpoint' }),
      endpointBind: z
        .string()
        .min(1)
        .default('127.0.0.1')
        .describe('Address the temporary adb endpoint binds to. Anything other than 127.0.0.1 exposes full device control to that network.')
        .meta({ title: 'adb endpoint bind address' }),
      endpointIdleSec: z
        .number()
        .int()
        .min(30)
        .max(3_600)
        .default(300)
        .describe('Close the endpoint after this long with no connection.')
        .meta({ title: 'adb endpoint idle timeout (s)' }),
      maxEndpointStreams: z
        .number()
        .int()
        .min(1)
        .max(32)
        .default(8)
        .describe('Concurrent adb streams allowed per endpoint.')
        .meta({ title: 'Max endpoint streams' }),
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
        .meta({ title: 'Idle session TTL (s)' }),
      maxIdleSessions: z
        .number()
        .int()
        .min(0)
        .max(64)
        .default(8)
        .describe('How many idle sessions may be held open across the farm before the oldest is closed.')
        .meta({ title: 'Max idle sessions' }),
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
        .meta({ title: 'Max live wall tiles' }),
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
        .meta({ title: 'Max hot devices' }),
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
        .meta({ title: 'Max push size (bytes)' }),
      maxPullBytes: z
        .number()
        .int()
        .min(1_048_576)
        .default(536_870_912)
        .describe('Largest file that may be pulled from a device.')
        .meta({ title: 'Max pull size (bytes)' }),
      installTimeoutMs: z
        .number()
        .int()
        .min(10_000)
        .max(1_800_000)
        .default(300_000)
        .describe('Budget for pm install once the APK is on the device. Runs on the streaming lane, not the 120s adb exec ceiling.')
        .meta({ title: 'Install timeout (ms)' }),
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
        .meta({ title: 'Geo re-check interval (s)' }),
    })
    .default({ geoIntervalSec: 300 })
    .meta({
      title: 'Network geo verification',
      description: 'Where the geo check looks up an exit address\'s location, and how often it re-checks a route already applied.',
    }),
})
export type FarmSettings = z.infer<typeof FarmSettingsSchema>
export type SessionSettings = FarmSettings['session']
export type WallSettings = FarmSettings['wall']
export type ReadinessSettings = FarmSettings['readiness']

export const defaultFarmSettings = (): FarmSettings => FarmSettingsSchema.parse({})
export const defaultDeviceSettings = (): DeviceSettings => DeviceSettingsSchema.parse({})
