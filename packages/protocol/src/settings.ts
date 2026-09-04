import { z } from 'zod'
import { ui } from './schema/vocabulary'

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
 * How a session holds the screen awake (spec §9, Plan 17 §3.4). `usb` only
 * holds the screen while plugged into USB, which does nothing over `adb-tcp`.
 */
export const KeepAwakeModeSchema = z.enum(['off', 'while-charging', 'always'])
export type KeepAwakeMode = z.infer<typeof KeepAwakeModeSchema>

/** Who may run shell commands (plan 26 §4.1). Plan 212 turns the FARM SETTING into a boolean (`privacy.adbCommand`); this survives as the shape `acl.ts`'s `canUseShell` et al. check — `'admin'` is no longer reachable from a setting. */
export const ShellModeSchema = z.enum(['off', 'admin', 'operator'])
export type ShellMode = z.infer<typeof ShellModeSchema>

/**
 * A device row written before Plan 17 still holds `prep.stayAwake` as a plain
 * boolean; this rewrites it into the new shape before validation ever sees
 * it, so an old row keeps working with no migration. A `.transform()` would
 * do the same job, but `z.toJSONSchema` cannot represent one and throws.
 */
function normaliseLegacyPrep(raw: unknown): unknown {
  if (raw && typeof raw === 'object' && 'stayAwake' in raw && !('keepAwake' in raw)) {
    const { stayAwake, ...rest } = raw as Record<string, unknown>
    return { ...rest, keepAwake: stayAwake ? 'while-charging' : 'off' }
  }
  return raw
}

/**
 * Screen rotation control (plan 85 §3.7, §4.1) — `'device'` leaves the
 * device's own auto-rotate behaviour untouched; the lock modes pin
 * `user_rotation` while a session is open and revert on close.
 */
export const RotationModeSchema = z.enum(['device', 'lock-portrait', 'lock-landscape', 'lock-current'])
export type RotationMode = z.infer<typeof RotationModeSchema>

/**
 * Which keyboard types text during a session (plan 90 §3.2-§3.3, §4.4) —
 * `'auto'` uses the guest agent's own IME when available and falls through
 * the rest of the text ladder otherwise; `'agent'` always routes through the
 * agent; `'device'` never touches the device's own default IME.
 */
export const TextInputModeSchema = z.enum(['auto', 'agent', 'device'])
export type TextInputMode = z.infer<typeof TextInputModeSchema>

/** A spoofed GPS fix (plan 58 §4.1). `accuracy` is the radius the OS reports alongside the fix. */
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
 * its network path: timezone, locale, GPS. Every field is optional: absent
 * means "leave the device's own value alone", never a guessed default.
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
  .meta({ title: 'Identity', description: 'What the device presents to apps besides its network path — timezone, locale, GPS.' })
export type DeviceIdentity = z.infer<typeof DeviceIdentitySchema>

/** Device-under-automation marker (spec §9.4) — set at session start, cleared at close (`packages/session/src/farm-tag.ts`). Not network-level tagging: it never touches a packet. */
export const DeviceInstrumentationSchema = z
  .object({
    tagTraffic: z
      .boolean()
      .default(true)
      .describe('Mark this device as under active Enkaku automation with a device-scoped system property, set for the life of each session and cleared on close. Readable by any app on the device that checks for it.')
      .meta({ title: 'Mark device as under automation' }),
  })
  .meta({
    title: 'Device instrumentation',
    description: 'A device-scoped marker — not network-level tagging — that discloses a session is currently open on this device (spec §9.4).',
  })
export type DeviceInstrumentation = z.infer<typeof DeviceInstrumentationSchema>

/** The three numbers behind a video quality profile (plan 92 §3.5; kept by plan 212 §4.1) — the preset tables in `packages/session/src/video-profile.ts` share this shape. */
export const VideoNumbersSchema = z.object({
  maxSize: z.number().int(),
  maxFps: z.number().int(),
  bitRate: z.number().int(),
})
export type VideoNumbers = z.infer<typeof VideoNumbersSchema>

/** MVP 12 §1 — the two video quality profiles, named. Replaces the old `ControlPresetSchema`/`WallPresetSchema`. */
export const ControlQualitySchema = z.enum(['sharp', 'balanced', 'light'])
export type ControlQuality = z.infer<typeof ControlQualitySchema>
export const WallQualitySchema = z.enum(['minimal', 'light', 'balanced', 'detailed'])
export type WallQuality = z.infer<typeof WallQualitySchema>

/** MVP 12 §1 — what a phone shows about itself. The CONTENT half of the old `labelling.mode`/`showName` pair; the SURFACE half is the constant `DEVICE_LABEL_SURFACE`. */
export const DeviceLabelSchema = z.enum(['off', 'number', 'number-and-name'])
export type DeviceLabel = z.infer<typeof DeviceLabelSchema>

/** The SURFACE a label is written to (plan 89) — the applied STATE's own field (`DeviceLabelStateSchema.mode`, `./api/device-label.ts`), not a settings field; the settings-facing surface choice is the constant `DEVICE_LABEL_SURFACE`. */
export const DeviceLabelModeSchema = z.enum(['off', 'lock-screen', 'wallpaper'])
export type DeviceLabelMode = z.infer<typeof DeviceLabelModeSchema>

/** MVP 12 §1 — the one timing knob a non-engineer understands. The tuples behind each name are `TOUCH_PROFILES` (`packages/core/src/config/constants.ts`). */
export const TouchProfileSchema = z.enum(['precise', 'natural', 'slow'])
export type TouchProfile = z.infer<typeof TouchProfileSchema>

/** MVP 12 §1 - "Reset the app before each job". A script may declare its own; this is the farm default. */
export const ResetPolicySchema = z.enum(['never', 'always', 'on-failure'])
export type ResetPolicy = z.infer<typeof ResetPolicySchema>

/** MVP 04 §1.3 rows 7 and 8, folded from plan 205's `control.overControl` into `privacy.overControl` (plan 212 §4.3). */
export const OverControlSchema = z.enum(['allow', 'warn', 'forbid'])
export type OverControl = z.infer<typeof OverControlSchema>

/** Where a wall tab's browser sits relative to the core (plan 100 §3.1). `WALL_TRANSPORT_OVERRIDE` (constants.ts) adds `'auto'` for the farm-facing override. */
export const WallTransportSchema = z.enum(['loopback', 'lan', 'wan'])
export type WallTransport = z.infer<typeof WallTransportSchema>

/** `networkScan.networks[].cidr` (plan 88 §3.5-§3.6, §4.2) — the bounded sweep's address space. IPv4 only. */
const IPV4_OCTET = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d|0)'
const IPV4_CIDR_RE = new RegExp(`^${IPV4_OCTET}\\.${IPV4_OCTET}\\.${IPV4_OCTET}\\.${IPV4_OCTET}/(3[0-2]|[12]?\\d)$`)

export const CidrSchema = z
  .string()
  .regex(IPV4_CIDR_RE, 'must be an IPv4 CIDR block, like 10.20.0.0/24')
  .meta({ title: 'Network (CIDR)' })

/** Addresses a CIDR block contributes to the sweep's ceiling — `2 ** (32 - prefix)`, INCLUDING network/broadcast. Returns 0 for anything already invalid, rather than throwing. */
export function addressCount(cidr: string): number {
  const match = /\/(\d{1,2})$/.exec(cidr)
  if (!match) return 0
  const prefix = Number(match[1])
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return 0
  return 2 ** (32 - prefix)
}

/** MVP 12 §3 — the sweep's address ceiling. `constants.ts`'s `SCAN_MAX_ADDRESSES` imports this as its own default so the two can never disagree. */
export const SCAN_MAX_ADDRESSES = 1024

/** One entry of the farm-network list. Leaves are bare-titled: the array itself is the one titled setting. */
const FarmNetworkSchema = z.object({
  cidr: CidrSchema,
  label: z.string().max(40).default('').meta({ title: 'Label' }),
  // Not a shared import from `./device` — that would close an import cycle.
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
 * section (MVP 12 §1 as amended by MVP 15 §1; group names are the design
 * handoff's, `docs/mvp/design_handoff_enkaku_openpf/README.md:423-425`).
 *
 * The 26 rule: each of the fifteen visible and each of the eleven advanced
 * settings carries exactly one titled UI hint call; a section object, a
 * compound leaf, or an array-item leaf carries a bare `.meta({ title })`
 * instead. The gate grep for that call, counted across this file, is
 * therefore 26 — a goal of plan 212, not a coincidence.
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
        .describe(
          'Your own probe endpoint (`bun run probe-server`). Without it the egress, DNS and geo checks stay "skip" and a route never reports "ok".',
        )
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
          maxTotalGb: z
            .number()
            .min(0.1)
            .max(10_000)
            .default(20)
            .describe('Once the total passes this, the oldest are deleted first.')
            .meta({ title: 'Maximum size (GB)' }),
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
          attempts: z
            .number()
            .int()
            .min(0)
            .max(10)
            .default(3)
            .describe('Extra attempts when a job fails for infrastructure reasons.')
            .meta({ title: 'Attempts' }),
          backoffBaseMs: z
            .number()
            .int()
            .min(100)
            .max(60_000)
            .default(1_000)
            .describe('First backoff delay; it doubles each retry, with jitter.')
            .meta({ title: 'Backoff base (ms)' }),
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
        .describe('Memory a job gets when its script does not declare its own. A breach kills the job.')
        .meta(ui({ title: 'Job memory limit', kind: 'bytes', enforcement: 'sampled', hint: 'Raise this if a script legitimately needs more.' })),
      transferCaps: z
        .object({
          maxPushBytes: z
            .number()
            .int()
            .min(1_048_576)
            .default(536_870_912)
            .describe('Largest file that may be pushed or installed.')
            .meta({ title: 'Push (bytes)' }),
          maxPullBytes: z
            .number()
            .int()
            .min(1_048_576)
            .default(536_870_912)
            .describe('Largest file that may be pulled from a device.')
            .meta({ title: 'Pull (bytes)' }),
          maxArchiveBytes: z
            .number()
            .int()
            .min(1_048_576)
            .max(4_294_967_295)
            .default(2_147_483_648)
            .describe('Largest combined download of a bulk pull.')
            .meta({ title: 'Bulk download (bytes)' }),
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
        .describe(
          'Bandwidth the Screens view may spend when the browser is not on the local network. Loopback and LAN use a fixed, much larger budget.',
        )
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

/**
 * Per-device settings. A field here either has no farm analogue, or is an
 * `.optional()` override of a visible farm field, where ABSENT means "use
 * the farm default" — no third case, so nothing can shadow the way
 * `defaults.timing` used to (`docs/settings-audit.md` #2).
 */
export const DeviceSettingsSchema = z.object({
  engines: z
    .object({
      transport: z.enum(['adb-usb', 'adb-tcp']).default('adb-usb').describe('How the core talks to the device').meta({ title: 'Transport' }),
      display: z
        .enum(['scrcpy', 'screencap-loop'])
        .default('scrcpy')
        .describe('Where the picture sent to Studio comes from')
        .meta({ title: 'Screen capture' }),
      input: z
        .enum(['scrcpy-uhid', 'scrcpy-sdk', 'adb-input'])
        .default('scrcpy-uhid')
        .describe('How taps, swipes, and typing reach the device')
        .meta({ title: 'Input delivery' }),
      inspection: z
        .enum(['ui-tree', 'ui-server', 'uiautomator-dump', 'appium'])
        .default('ui-tree')
        .describe('How scripts find elements on screen')
        .meta({ title: 'Screen inspection' }),
    })
    .default({ transport: 'adb-usb', display: 'scrcpy', input: 'scrcpy-uhid', inspection: 'ui-tree' })
    .meta({ title: 'Engines', description: 'The core rejects combinations that cannot work together.', 'x-enkaku': { group: 'Engines' } }),

  identity: DeviceIdentitySchema.default(() => DeviceIdentitySchema.parse({})).meta({ title: 'Identity', 'x-enkaku': { group: 'Identity' } }),

  prep: z
    .preprocess(
      normaliseLegacyPrep,
      z.object({
        keepAwake: KeepAwakeModeSchema.default('always').describe('Keep the device awake while a session is open').meta({ title: 'Keep the screen awake' }),
        standbyScreenOff: z
          .boolean()
          .default(false)
          .describe('Turn the device screen off while streaming')
          .meta({ title: 'Turn the device screen off while streaming' }),
        rotation: RotationModeSchema.default('device')
          .describe('Whether the device rotates freely or is pinned while a session is open')
          .meta({ title: 'Screen rotation' }),
        textInput: TextInputModeSchema.default('auto')
          .describe('Use the guest agent keyboard while a session is open, so non-ASCII text can be typed.')
          .meta({ title: 'Text input' }),
      }),
    )
    .default({ keepAwake: 'always', standbyScreenOff: false, rotation: 'device', textInput: 'auto' })
    .meta({ title: 'Before a job runs', 'x-enkaku': { group: 'Power & readiness' } }),

  autoReconnect: z.boolean().default(true).describe('Reconnect automatically when the device disappears').meta({ title: 'Auto-reconnect' }),
  logInputText: z
    .boolean()
    .default(false)
    .describe(
      'Store the literal typed text in the input log, instead of just its length. Turning this on is recorded in the audit log — anything typed on this device (including passwords) becomes readable by any farm user who opens the Logs tab.',
    )
    .meta({ title: 'Log typed text in the clear' }),

  instrumentation: DeviceInstrumentationSchema.default(() => DeviceInstrumentationSchema.parse({})),

  /** MVP 12 §5 - the same visible set as the farm, each optional: absent = use farm default. */
  overrides: z
    .object({
      controlQuality: ControlQualitySchema.optional().describe('Overrides the farm control quality for this device.').meta({ title: 'Control quality' }),
      wallQuality: WallQualitySchema.optional().describe('Overrides the farm wall quality for this device.').meta({ title: 'Wall quality' }),
      touchProfile: TouchProfileSchema.optional()
        .describe('Overrides the farm touch profile for this device.')
        .meta({ title: 'Human-like touch profile' }),
      resetPolicy: ResetPolicySchema.optional().describe('Overrides the farm reset policy for this device.').meta({ title: 'Reset the app before each job' }),
      defaultTimeoutMs: z
        .number()
        .int()
        .min(30_000)
        .max(86_400_000)
        .optional()
        .describe('Overrides the farm default job timeout for this device.')
        .meta({ title: 'Default job timeout' }),
      deviceLabel: DeviceLabelSchema.optional().describe('Overrides what this phone shows about itself.').meta({ title: 'Physical label on the screen' }),
      tempThresholdC: z
        .number()
        .min(20)
        .max(90)
        .optional()
        .describe('Overrides the farm temperature threshold for this device.')
        .meta({ title: 'Pause jobs above' }),
    })
    .default({})
    .meta({ title: 'Farm overrides', description: 'Leave a field empty to use the farm setting.', 'x-enkaku': { group: 'Overrides' } }),
})
export type DeviceSettings = z.infer<typeof DeviceSettingsSchema>
export const defaultDeviceSettings = (): DeviceSettings => DeviceSettingsSchema.parse({})

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
    default: throw new Error(`resolveDeviceSetting: unknown override key ${String(key)}`)
  }
}
