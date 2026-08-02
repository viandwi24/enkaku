import { z } from 'zod'

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
}).meta({
  title: 'Human-like touch',
  description: 'A little randomness in tap timing and position, so automation does not fall into an obvious pattern.',
})

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
    timing: TimingSettingsSchema.default({ tapJitterMs: [40, 120], betweenActionMs: [300, 900], coordJitterPx: 2 }),
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
  })
  .meta({ title: 'Device settings' })
export type DeviceSettings = z.infer<typeof DeviceSettingsSchema>

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
       */
      maxStreamsPerDevice: z
        .number()
        .int()
        .min(1)
        .max(8)
        .default(1)
        .describe('Concurrent adb streams (logcat, top, ...) allowed on one device.')
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
    .default({ maxConcurrent: 0, execTimeoutMs: 15_000, maxQueueDepth: 32, maxStreamsPerDevice: 1, maxStreams: 4 })
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
})
export type FarmSettings = z.infer<typeof FarmSettingsSchema>

export const defaultFarmSettings = (): FarmSettings => FarmSettingsSchema.parse({})
export const defaultDeviceSettings = (): DeviceSettings => DeviceSettingsSchema.parse({})
