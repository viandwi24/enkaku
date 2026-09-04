import { z } from 'zod'
import { AgentDefaultsSchema } from './agent'
import { ui } from './schema/vocabulary'
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
 * `wall.maxTiles` was a fixed 8 before plan 92 — a laptop-sized number
 * (plan 42 §3.5) nobody chose deliberately; it was the only number available
 * (F3). A stored 8 therefore reads as "never configured" and is migrated to
 * 0 (auto — `computeAutoTiles`, `packages/session/src/video-profile.ts`),
 * the same reasoning `normaliseLegacyAdb` above already applied to
 * `adb.maxStreams`. Tracked removal: 2027-02-13, after which a stored 8
 * means a deliberate 8 (`docs/plans/00-overview.md` §9).
 */
function normaliseLegacyWall(raw: unknown): unknown {
  if (raw && typeof raw === 'object' && (raw as { maxTiles?: unknown }).maxTiles === 8) {
    return { ...(raw as object), maxTiles: 0 }
  }
  return raw
}

/**
 * Screen rotation control (plan 85 §3.7, §4.1) — `'device'` leaves the
 * device's own auto-rotate behaviour untouched (today's behaviour, exactly);
 * the lock modes pin `user_rotation` while a session is open and are
 * reverted on close the same way `keepAwake` already is.
 *
 * `'lock-current'` locks whatever is on screen at the moment it is applied.
 * Its behaviour on a device with no readable live orientation (asleep) is
 * still the UNRATIFIED substitution plan 85 §9 Q4 proposed — fall back to
 * portrait, and say so at `warn`. Nothing here ratifies it; see
 * `packages/session/src/orientation.ts`'s `resolveCurrentTarget`, which is
 * still the one place that decision lives.
 */
export const RotationModeSchema = z.enum(['device', 'lock-portrait', 'lock-landscape', 'lock-current'])
export type RotationMode = z.infer<typeof RotationModeSchema>

/**
 * Which keyboard types text during a session (plan 90 §3.2, §3.3, §4.4) —
 * `'auto'` uses the guest agent's own IME when it advertises `text-input`
 * and falls through the rest of the text ladder otherwise (agent-ime →
 * scrcpy INJECT_TEXT → clipboard paste → adb-input); `'agent'` always routes
 * through the agent and reports a precondition when it is unavailable;
 * `'device'` never touches the device's own default IME — today's
 * behaviour, exactly. Schema only here; applying and reverting it is step
 * 90.5's `applyTextInput()` in `packages/session/src/session.ts`, beside
 * `applyRotation()`, and the ladder itself is `packages/session/src/text-input.ts`'s
 * `resolveTextRoute`.
 */
export const TextInputModeSchema = z.enum(['auto', 'agent', 'device'])
export type TextInputMode = z.infer<typeof TextInputModeSchema>

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
 * This is NOT a driver layer (plan 58 §3.1): it has no activity-scoped
 * apply/revert lifecycle, no capability negotiation, and persists across
 * control markers like `timing` and `prep`. It lives in `DeviceSettingsSchema`
 * alongside them.
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
 * Physical labelling — what a device shows about itself on its own screen
 * (plan 89 §3.5, §3.8, §4.3). `'off'` is the default: the wallpaper overwrites
 * something an operator may care about (§3.8), so nothing is ever written
 * unattended. `'lock-screen'` needs nothing installed (H2, plan 89 §3.5's tier
 * 0); `'wallpaper'` needs the guest agent's `screen-label` capability and
 * covers both surfaces (tier 1) — a device without that capability reports
 * `unavailable` rather than silently falling back to the lesser tier (§3.5,
 * the same rule `vpn-helper`'s `probe` capability already follows,
 * CLAUDE.md).
 */
export const DeviceLabelModeSchema = z.enum(['off', 'lock-screen', 'wallpaper'])
export type DeviceLabelMode = z.infer<typeof DeviceLabelModeSchema>

/**
 * Plan 89 §3.3, §4.3. The number and the name compose but the number never
 * enters `label` (§3.3's decision) — `showName` only ever affects whether the
 * NAME half of the label is drawn; the number is always shown when a mode
 * other than `'off'` is active, at a larger size when the name is hidden.
 */
export const DeviceLabellingSchema = z
  .object({
    mode: DeviceLabelModeSchema.default('off')
      .describe(
        'Show this device’s number and name on the phone itself. "Lock screen" writes one line of text under the lock-screen clock and needs nothing installed. "Wallpaper" replaces the wallpaper with a black label on both the home and lock screens, and needs the Enkaku guest agent — a device without it reports the label as unavailable rather than silently doing less.',
      )
      .meta({ title: 'Label the phone’s screen' }),
    showName: z
      .boolean()
      .default(true)
      .describe('Include the device name above the number. Turn off for the number alone, at a larger size.')
      .meta({ title: 'Include the name' }),
  })
  .meta({ title: 'Physical labelling', description: 'What this phone shows about itself on a rack.' })
export type DeviceLabelling = z.infer<typeof DeviceLabellingSchema>

/**
 * The three numbers behind a video quality profile (plan 92 §3.5, §4.1) —
 * named once so `FarmSettings.video`'s farm-wide numbers, `DeviceSettings.video`'s
 * per-device override, and `packages/session/src/video-profile.ts`'s preset
 * tables all share one shape instead of three ad-hoc
 * `{ maxSize, maxFps, bitRate }` literals that could drift apart.
 */
export const VideoNumbersSchema = z.object({
  maxSize: z.number().int(),
  maxFps: z.number().int(),
  bitRate: z.number().int(),
})
export type VideoNumbers = z.infer<typeof VideoNumbersSchema>

/** The device page's picture presets (plan 92 §3.6) — `sharp` is today's only constant, unchanged. */
export const ControlPresetSchema = z.enum(['sharp', 'balanced', 'light'])
export type ControlPreset = z.infer<typeof ControlPresetSchema>

/** A wall tile's picture presets (plan 92 §3.6) — `balanced` is today's only constant, unchanged. */
export const WallPresetSchema = z.enum(['detailed', 'balanced', 'light', 'minimal'])
export type WallPreset = z.infer<typeof WallPresetSchema>

/**
 * Where a wall tab's browser is assumed to be relative to the core (plan 100
 * §3.1, §4.1, step 100.3) — resolved from `ENKAKU_MODE` unless
 * `wall.transportOverride` names one explicitly. The single source of truth
 * for this union: `packages/session/src/video-profile.ts`'s own
 * `WallTransport` type is structurally identical but declared separately
 * (session cannot import protocol's zod-inferred type without pulling zod
 * into that package's public surface) — kept in sync by
 * `settings.test.ts`/`video-profile.test.ts` both asserting against the
 * same three literal strings.
 */
export const WallTransportSchema = z.enum(['loopback', 'lan', 'wan'])
export type WallTransport = z.infer<typeof WallTransportSchema>

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
          .enum(['uhid', 'sdk'])
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
          /**
           * Replaces the old `stayAwake` boolean (Plan 17 §3.4).
           *
           * **The default moved `'while-charging'` → `'always'` in plan 125
           * §3.3.** `'while-charging'` maps to `svc power stayon usb`, and
           * this file's own `KeepAwakeModeSchema` comment (above) already
           * records the consequence: `usb` only holds the screen while
           * plugged into USB, *which does nothing for a device attached over
           * `adb-tcp`* — which is exactly the shape of farm plan 125 is for.
           * Leaving it would have made plan 125's new awake-by-default
           * (`readiness.defaultDesired`, below) a lie on the very hardware it
           * was chosen for.
           *
           * **An existing farm is not touched by this.** Every device row is
           * written with a FULLY MATERIALISED `DeviceSettings`
           * (`defaultDeviceSettings()` → `DeviceSettingsSchema.parse({})`, via
           * `registry/admission.ts`'s `baseFields`), so a device enrolled
           * before this change has its own literal `keepAwake` stored in the
           * `devices.settings` JSON column and re-reads that value, never this
           * default. The default is consulted only for a row that has no
           * `prep` at all — a fresh device, or one predating the block
           * entirely (plan 125 §8's "flipping a product default surprises an
           * existing farm" risk, and §5 step 125.2's migration note).
           */
          keepAwake: KeepAwakeModeSchema.default('always')
            .describe('Keep the device awake while a session is open')
            .meta({ title: 'Keep the screen awake' }),
          /**
           * Plan 125 §3.3, §4.2 — the PERSISTED half of the awake policy, and
           * the piece that keeps a boxed phone awake **even when the core is
           * not running at all**.
           *
           * `svc power stayon` (`keepAwake` above) is reverted by
           * `releaseAwake`/`close()` and only holds while the device is
           * plugged in; `Settings.System.screen_off_timeout` is the phone's
           * own setting and survives a core restart, a core crash, and a
           * reboot. Both are read back before either is reported as applied,
           * and both revert over adb alone — the two rules plan 125 §0.2
           * imposes because the owner's phones are sealed in a box where the
           * recovery cost of a bad write is hardware disassembly.
           *
           * `null` means "leave the device's own value alone" and issues no
           * write at all. The default, 30 minutes, is long enough that a
           * device is still reachable across a lunch break and short enough
           * that a phone which somehow falls out of the farm's management
           * still eventually parks its panel (plan 125 §8's burn-in and
           * thermal risk, which H4 measures rather than assumes).
           *
           * Applied by `wakeDevice` (`packages/session/src/wake.ts`) and by
           * `packages/core/src/device/awake-policy.ts`; never applied without
           * a capture of the device's prior value first (§3.3).
           */
          screenOffTimeoutMs: z
            .number()
            .int()
            .min(0)
            .nullable()
            .default(1800000)
            .describe('How long the device’s own screen timeout is set to while it is in the farm. Leave empty to keep whatever the device already had. This setting is written to the phone and survives a restart of the core, which is what keeps a device awake and reachable while nothing is watching it.')
            .meta(ui({ title: 'Screen timeout on the device', kind: 'duration', unit: 'ms' })),
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
           * Rotation lock (plan 85 §3.7, §4.1) — schema only here. Applying
           * and reverting it is `packages/session/src/orientation.ts`, next
           * to `keepAwake`; re-applying it to a session that is already
           * streaming is `SessionManager.setRotation`, called by `PATCH
           * /api/devices/:id` the moment this value changes.
           */
          rotation: RotationModeSchema.default('device')
            .describe(
              'Lock the screen orientation while a session is open. Takes effect immediately on a device that is streaming right now, and on every session afterwards; the device’s own setting is put back when the last session closes. Not applied while a job is running — that waits for the job’s next session.',
            )
            .meta({ title: 'Screen rotation' }),
          /**
           * Plan 90 §3.2, §3.3, §4.4, §5 step 90.5 — schema only here; the
           * applier is `session.ts`'s `applyTextInput()`, next to
           * `applyRotation()` above it in this same object.
           */
          textInput: TextInputModeSchema.default('auto')
            .describe('Use the guest agent’s keyboard while a session is open, so non-ASCII text can be typed.')
            .meta({ title: 'Text input' }),
        }),
      )
      // A LITERAL default, not a thunk — because the `z.preprocess` wrapper
      // above has no inner schema to re-parse `{}` through the way `timing`
      // does. Zod 4 does not validate a `.default()` value, so this object
      // must be kept in lockstep with the fields above BY HAND: a field added
      // there and forgotten here reads `undefined` at runtime on every farm
      // that has never saved this block. `screenOffTimeoutMs` (plan 125 §4.2)
      // and `keepAwake: 'always'` (plan 125 §3.3) are here for exactly that
      // reason.
      .default({ disableAnimations: true, keepAwake: 'always', screenOffTimeoutMs: 1800000, standbyScreenOff: false, rotation: 'device', textInput: 'auto' })
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
     * Video picture quality, per-device override (plan 92 §3.5, §4.1) —
     * persisted like `identity` above, but every field is optional: an
     * absent one means "use the farm's" (`FarmSettings.video` below).
     * `resolveVideoProfile` (`packages/session/src/video-profile.ts`) is the
     * ONE place a farm value and a device override are combined — nothing
     * else in the codebase computes `max_size`/`max_fps`/`video_bit_rate` on
     * its own (F5, F7). `PATCH /api/devices/:id` replaces the whole settings
     * blob (F21), so an emptied field here genuinely clears the override —
     * unlike the farm-level version of this problem (F22), which is why
     * `FarmSettings.video` below has no optional field of its own.
     *
     * `controlPreset`/`wallPreset` below are the exception to the paragraph
     * above (docs/settings-audit.md #5): `resolveVideoProfile` indexes
     * `CONTROL_PRESETS`/`WALL_PRESETS` off the FARM argument only
     * (`farm.controlPreset`/`farm.wallPreset`) — `device?.controlPreset`/
     * `device?.wallPreset` are read nowhere in that file or anywhere else.
     * Only the six numeric siblings (`controlMaxSize`/`controlMaxFps`/
     * `controlBitRate`/`wallMaxSize`/`wallMaxFps`/`wallBitRate`) genuinely
     * merge as this comment describes. Kept rather than deleted, since Studio
     * already renders and saves them like any other field and deleting would
     * be a schema/DB-shape change for no behavioural gain over just telling
     * the truth here — but setting either preset here does nothing today.
     */
    video: z
      .object({
        controlPreset: ControlPresetSchema.optional()
          .describe('Not yet read anywhere — resolveVideoProfile only consults the farm-wide preset. Setting this has no effect. Use the numeric fields below to override picture quality for this device.')
          .meta({ title: 'Device page picture (not yet applied)' }),
        controlMaxSize: z.number().int().min(480).max(2560).optional().meta({ title: 'Device page size (px)' }),
        controlMaxFps: z.number().int().min(5).max(60).optional().meta({ title: 'Device page frame rate' }),
        controlBitRate: z.number().int().min(500_000).max(20_000_000).optional().meta({ title: 'Device page bitrate' }),
        wallPreset: WallPresetSchema.optional()
          .describe('Not yet read anywhere — resolveVideoProfile only consults the farm-wide preset. Setting this has no effect. Use the numeric fields below to override picture quality for this device.')
          .meta({ title: 'Wall tile picture (not yet applied)' }),
        wallMaxSize: z.number().int().min(160).max(1080).optional().meta({ title: 'Wall tile size (px)' }),
        wallMaxFps: z.number().int().min(1).max(30).optional().meta({ title: 'Wall tile frame rate' }),
        wallBitRate: z.number().int().min(100_000).max(8_000_000).optional().meta({ title: 'Wall tile bitrate' }),
      })
      .default({})
      .meta(
        ui({
          title: 'Video',
          description: 'Picture quality for this device. Every field is optional — anything left empty follows the farm setting under Settings → Devices → Video.',
          group: 'Video',
        }),
      ),
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
    /**
     * Physical labelling (plan 89 §3.8, §4.3) — persisted per device exactly
     * like `identity`/`instrumentation` above, a thunk default so a field
     * added to `DeviceLabellingSchema` later can never silently go unset. The
     * farm default (`FarmSettings.defaults.labelling`) is copied onto a
     * device once, at admission (F26) — flipping the farm default never
     * retroactively relabels an existing fleet (§3.8's explicit rule).
     *
     * `group`-annotated as of step 89.8 (plan 89 §5): earlier steps left this
     * ungrouped deliberately, "Studio's own bespoke 'Physical labelling'
     * screen is step 89.8, not this one" — this is that step. `deviceSections`
     * (`packages/studio/src/components/settings/deviceSections.ts`) derives
     * the Settings tab's tab strip entirely from this metadata, so a
     * dedicated "Physical labelling" tab appears with NO Studio-side
     * hand-maintained section list to keep in sync (spec §19's rule).
     */
    labelling: DeviceLabellingSchema.default(() => DeviceLabellingSchema.parse({})).meta(
      ui({ title: 'Physical labelling', group: 'Physical labelling' }),
    ),
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
     * The script runtime envelope's memory field (plan 98 §3.5, §4.3) —
     * `defaultMaxRssBytes`/`maxRssBytes` mirrors `defaultTimeoutMs`/
     * `maxTimeoutMs`'s exact "offered, and off" shape (F7): both byte
     * fields default to `null` (no limit anywhere) so a farm that sets
     * neither and runs scripts that declare nothing sees no change at all.
     * `resolveRuntime` (`../runtime-envelope.ts`) is the one place these are
     * combined with a script's own `runtime.maxRssBytes` and a per-job
     * override. LIVE, fully enforced end to end (plan 98, step 98.3
     * "Measure before limiting" — status: implemented): the child
     * self-reports RSS on every sample (`packages/session/src/runner/
     * child-entry.ts`'s `rss` message), and `packages/session/src/runner/
     * job-runner.ts`'s `checkMemoryBreach` compares it against the resolved
     * `maxRssBytes` and calls `doAbort('memory', …)` once a sample reaches
     * the limit under `enforce: 'kill'` (a `warn` fires first, at 80% of the
     * limit, so a kill is never unexplained). `enforcement: 'sampled'` on the
     * two byte fields is not decoration: a memory breach is caught on the
     * NEXT sample interval, not prevented (§3.5) — the badge next to the
     * input in Studio reflects that honestly, not "unenforced."
     */
    memory: z
      .object({
        defaultMaxRssBytes: z
          .number()
          .int()
          .min(67_108_864)
          .max(17_179_869_184)
          .nullable()
          .default(null)
          .describe("The memory limit a job gets when its script does not declare its own `runtime.maxRssBytes`. Null means no default — the job runs with no memory limit at all.")
          .meta(ui({ title: 'Default job memory limit', kind: 'bytes', group: 'Memory', enforcement: 'sampled' })),
        maxRssBytes: z
          .number()
          .int()
          .min(67_108_864)
          .max(17_179_869_184)
          .nullable()
          .default(null)
          .describe('An optional ceiling on what a script or a job override may request. Null means no ceiling. A clamp is logged, never silent — the same rule `job.maxTimeoutMs` already follows.')
          .meta(ui({ title: 'Maximum job memory limit', kind: 'bytes', group: 'Memory', enforcement: 'sampled' })),
        enforce: z
          .enum(['kill', 'warn', 'off'])
          .default('kill')
          .describe('What happens on a memory breach, once a limit is in effect for that job. "kill" SIGKILLs immediately, no grace period. "warn" logs and lets the job continue. "off" does nothing.')
          .meta(
            ui({
              title: 'On a memory breach',
              group: 'Memory',
              labels: { kill: 'Kill the job', warn: 'Log a warning and continue', off: 'Do nothing' },
            }),
          ),
        sampleIntervalMs: z
          .number()
          .int()
          .min(250)
          .max(30_000)
          .default(2_000)
          .describe('How often a running job reports its own memory use, when a limit is in effect. A breach is caught within one interval, not instantly.')
          .meta(ui({ title: 'Memory sample interval (ms)', kind: 'duration', unit: 'ms', group: 'Memory', advanced: true })),
      })
      .default({ defaultMaxRssBytes: null, maxRssBytes: null, enforce: 'kill', sampleIntervalMs: 2_000 })
      .meta({
        title: 'Memory',
        description: "A job's memory limit, and what happens when it is breached (plan 98). Enforced by sampling, not prevented — nothing here is wired to a kill until plan 98's own limit step lands.",
      }),
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
    /**
     * Plan 97 §3.4, §4.1, §4.9 — the written size bound on a job's result,
     * measured in the CHILD before it ever crosses IPC (F10, F11). The
     * default matches `kv.maxValueBytes` exactly (plan 79) — the other place
     * a script persists structured JSON — on the stated principle "64 KiB is
     * what a script may hand the database as a value; anything larger is a
     * file" (§3.4). Raising it does not raise `kv.maxValueBytes`, and the
     * reverse: the two are equal by convention, not by a shared reference,
     * because an operator may reasonably need to widen one without the
     * other.
     */
    maxResultBytes: z
      .number()
      .int()
      .min(1_024)
      .max(1_048_576)
      .default(65_536)
      .describe('Largest result a script may return, in bytes. Larger output belongs in an artifact, not the result column.')
      .meta(ui({ title: 'Max result size', kind: 'bytes', group: 'Jobs' })),
    /**
     * Plan 97 §3.7, §4.9 — the coalescing interval for `ctx.progress()`: at
     * most one push per interval, last value wins, never persisted. Not a
     * result — §3.7's own rule ("a result is a commitment; a progress is an
     * observation") is why this lives beside `maxResultBytes` rather than
     * inside a "streaming" concept this plan deliberately does not build.
     */
    progressIntervalMs: z
      .number()
      .int()
      .min(250)
      .max(10_000)
      .default(1_000)
      .describe('How often a running job may push a live progress snapshot.')
      .meta(ui({ title: 'Progress interval', kind: 'duration', unit: 'ms', group: 'Jobs' })),
  })
  .default({
    resetPolicy: 'home',
    resetTimeoutMs: 15_000,
    resetStrict: false,
    retry: { maxInfraAttempts: 2, backoffBaseMs: 2_000, backoffMaxMs: 30_000, timeoutIsInfra: false, rebindOnInfra: true },
    crashPolicy: 'declared',
    defaultTimeoutMs: 3_600_000,
    startupTimeoutMs: 60_000,
    maxTimeoutMs: null,
    memory: { defaultMaxRssBytes: null, maxRssBytes: null, enforce: 'kill', sampleIntervalMs: 2_000 },
    trigger: { maxDepth: 5, maxPerChain: 200, maxPerJob: 10 },
    maxResultBytes: 65_536,
    progressIntervalMs: 1_000,
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
 * and a farm chassis switch does not hand out IPv6 addresses via DHCP in practice.
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

/**
 * The per-device schema, minus `identity` — see the note on
 * `FarmSettingsSchema.defaults` below for why. Named so `defaultsForNewDevice`
 * (`packages/core/src/registry/admission.ts` and `device-registry.ts`) has a
 * real type to declare its `deviceDefaults` accessor against, instead of the
 * wider `DeviceSettings`.
 */
const FarmDeviceDefaultsSchema = DeviceSettingsSchema.omit({ identity: true })

/** Farm-wide settings (a single row). */
export const FarmSettingsSchema = z.object({
  /**
   * The per-device schema, reused — see the note on `DeviceSettingsSchema` —
   * MINUS `identity` (docs/settings-audit.md #1, the highest-severity
   * finding; `docs/plans/96-m61-hotfixes.md`). A farm-wide default
   * timezone/locale/GPS is not merely dead as an ONGOING setting (nothing
   * ever reads `defaults.identity` for an already-enrolled device — device
   * identity is per-device only, plan 58) — it is actively harmful as a
   * ONE-SHOT enrollment stamp: `defaultsForNewDevice` used to spread the
   * WHOLE `DeviceSettings` object onto every newly admitted device's row, so
   * a farm-wide GPS set under Settings → Defaults placed every device
   * admitted while it was set at byte-identical coordinates — a STRONGER
   * fingerprinting signal than no identity spoofing at all, silently, with
   * no audit entry and nothing in the admission response calling it out.
   * `DeviceSettingsSchema.identity` itself, and every per-device identity
   * route (`packages/core/src/api/device-identity.ts`, plan 58), are
   * UNCHANGED by this — this only makes a FARM-WIDE default impossible to
   * set. A thunk: every remaining inner field already carries a default, so
   * parsing an empty object yields the canonical defaults without
   * duplicating them here. Zod's own default "strip" mode (no `.strict()`
   * anywhere in this file) means a stored row from before this change, whose
   * `defaults` still carries an `identity` key, parses cleanly — that key is
   * simply dropped, never an `E_BAD_CONFIG` boot failure (settings.test.ts
   * has the explicit legacy-row case).
   */
  defaults: FarmDeviceDefaultsSchema.default(() => FarmDeviceDefaultsSchema.parse({})).meta({
    title: 'Defaults for new devices',
    description:
      'Copied onto a device the first time it is enrolled. Devices already registered keep their own settings. Device identity (timezone/locale/GPS) is deliberately excluded — it is per-device only (Settings → Devices → Identity). A farm-wide default here would stamp every device admitted while it was set with byte-identical coordinates, a stronger fingerprinting signal than no spoofing at all.',
  }),
  /**
   * Plan 89 §3.7, §4.3 — the only genuinely farm-wide labelling knob;
   * everything else (`mode`, `showName`) rides `defaults.labelling` above,
   * exactly like every other device-scoped setting (F26). Bounds simultaneous
   * label writes across the whole fleet for the same reason
   * `adb.maxInstallConcurrent` exists (plan 85 §3.4): twenty phones
   * reconnecting at once must not start twenty agent round trips over one
   * USB controller.
   */
  labelling: z
    .object({
      maxConcurrent: z
        .number()
        .int()
        .min(1)
        .max(16)
        .default(2)
        .describe('How many phones may have their label written at once. USB bandwidth is shared.')
        .meta({ title: 'Max concurrent label writes' }),
    })
    .default({ maxConcurrent: 2 })
    .meta({ title: 'Physical labelling', description: 'Fleet-wide bound on simultaneous label writes.' }),
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
      /**
       * The command console's own history budget (plan 93 §3.9, §4.1).
       * Alongside `eventMainDays`/`eventInputDays`/`blobOrphanGraceHours`
       * above, and NOT gated by `enabled` for the same stated reason: an
       * unbounded command history is a disk-filling bug, not an opt-in
       * convenience — `command_runs` is the same append-only, per-action
       * shape `device_events` already is.
       */
      commandRunDays: z
        .number()
        .int()
        .min(1)
        .default(14)
        .describe('Command runs older than this are deleted, with their per-device results.')
        .meta({ title: 'Command history retention (days)' }),
      /**
       * The job trace's own history budget (plan 128 §3.7, §4.1).
       * Alongside `eventMainDays`/`eventInputDays`/`blobOrphanGraceHours`/
       * `commandRunDays` above, and NOT gated by `enabled` for the same
       * stated reason: `job_events` is the same append-only, per-action shape
       * `device_events` and `command_runs` already are — one row per device
       * call plus a screenshot per row — so leaving it unbounded is a
       * disk-filling bug, not an opt-in convenience.
       *
       * A trace's LIFETIME rule is separate and stricter: a trace lives
       * exactly as long as its job's history, and deleting a job takes its
       * `job_events` rows and its `traces/<jobId>` directory with it (§3.5).
       * That is the correctness rule; this is the bound. Nothing deletes
       * finished jobs on its own today except the device-removal cascade, so
       * without this second lever a farm accumulates traces forever.
       */
      traceDays: z
        .number()
        .int()
        .min(1)
        .default(30)
        .describe('Job traces older than this are deleted, with their captured frames and UI snapshots.')
        .meta({ title: 'Job trace retention (days)' }),
    })
    .default({ enabled: false, maxAgeDays: 30, maxTotalGb: 20, eventMainDays: 30, eventInputDays: 3, eventMaxRowsPerDevice: 50_000, blobOrphanGraceHours: 24, commandRunDays: 14, traceDays: 30 })
    .meta({
      title: 'Artifact storage',
      description: 'Screenshots and job logs pile up over time. Turn this on to clear them automatically.',
    }),
  /**
   * adb concurrency and per-command budgets (plan 23 §4.1). `maxConcurrent: 0`
   * means "scale automatically with fleet size" (§3.2 of the plan) — a
   * non-zero value pins the global semaphore and the autoscaler leaves it alone.
   *
   * `execTimeoutMs` and `maxQueueDepth` used to live here and were removed
   * (docs/settings-audit.md #6, `docs/plans/96-m61-hotfixes.md`): every real
   * adb exec deadline comes from `packages/adb/src/timeouts.ts`'s hardcoded
   * `ADB_TIMEOUTS` table via `resolveExecTimeout()`, never this setting, and
   * `AdbClient` is constructed at `daemon.ts` with no `maxQueueDepth` option
   * at all, so it always fell back to the compiled-in `DEFAULT_MAX_QUEUE_DEPTH`.
   * Neither field had a reader anywhere in the workspace. `shell.execTimeoutMs`
   * is a different, correctly-wired field with the same name — unaffected.
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
    .default({ maxConcurrent: 0, maxStreamsPerDevice: 4, maxStreams: 0, maxHostConcurrent: 4, maxInstallConcurrent: 2 })
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
            /**
             * Per-range port override (plan 88 §9 Q7, resolved; `docs/plans/
             * 96-m61-hotfixes.md` §96.44's follow-up). Optional, matching
             * `DeviceSettingsSchema.video`'s own "absent means inherit the
             * farm default" convention (this file, above) — unset falls back
             * to `discovery.tcpPort` for this range. Same bounds as
             * `tcpPort` itself.
             */
            port: z
              .number()
              .int()
              .min(1024)
              .max(65535)
              .optional()
              .describe('Overrides the farm-wide adb port (discovery.tcpPort) for this range only. Leave unset to use the farm default.')
              .meta({ title: 'Port (optional override)' }),
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
      /**
       * The USB → network cutover wizard's armed-window policy (plan 88
       * §3.4, §4.2, §5 step 88.5) — how long Enkaku keeps polling the ladder
       * and sweep for the phone to reappear after "flip the port now", and
       * how often. Not persisted alongside the wizard's own state
       * (`cutover.ts` is deliberately in-memory) — just the two numbers that
       * shape it.
       */
      cutover: z
        .object({
          armWindowSec: z
            .number()
            .int()
            .min(30)
            .max(900)
            .default(180)
            .describe('How long Enkaku watches for a device after you flip its port.')
            .meta(ui({ title: 'Cutover window (s)', kind: 'duration', unit: 's' })),
          armPollSec: z
            .number()
            .int()
            .min(1)
            .max(60)
            .default(5)
            .meta(ui({ title: 'Cutover poll interval (s)', kind: 'duration', unit: 's' })),
        })
        .default({ armWindowSec: 180, armPollSec: 5 })
        .meta({
          title: 'Cutover window',
          description: 'How long, and how often, Enkaku watches the network for a phone after a guided USB → OTG/Wi-Fi move (plan 88 §3.4).',
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
      cutover: { armWindowSec: 180, armPollSec: 5 },
    })
    .meta({
      title: 'Device discovery',
      description: 'How often adb is re-scanned for devices the live event stream may have missed, the recovery cadence for offline/unauthorized devices, how network addresses are remembered and retried, the farm-network list, and the bounded subnet sweep (plan 88).',
    }),
  /**
   * The on-device Enkaku guest agent (plan 90 §3.7, §3.8, §4.4) — written in
   * ONE pass by step 90.4 on behalf of all three steps that need a key here
   * (90.3, 90.4, 90.5), because three concurrent edits to one schema object
   * would collide; see `packages/core/src/api/guest-agent.ts`'s own note on
   * this for the reasoning. `provision` is step 90.3's `AgentProvisioner`
   * switch (unused by this file); `maxRecoveryCyclesPerHour`/
   * `recoveryRearmSec` are step 90.4's — they replace `RECOVERY_REARM_S`'s
   * old `max(lastBackoff * 5, 60)` derivation (F15: "a derivation, not a
   * decision") and give plan 54 §9 open question 2 ("should the bound reset
   * on reconnect?") its real answer: yes, but bounded by a second, coarser
   * breaker so a device flapping against a genuinely dead proxy still
   * converges on the slow re-arm clock instead of retrying forever.
   */
  guestAgent: z
    .object({
      provision: z
        .enum(['auto', 'manual', 'off'])
        .default('auto')
        .describe(
          'Install and keep the on-device agent up to date on every admitted device. "manual" only installs when asked; "off" disables it entirely.',
        )
        .meta({ title: 'Provision the guest agent' }),
      /**
       * The circuit breaker on AUTOMATIC recovery resets (plan 90 §3.7 rule
       * 2) — the same rolling-window shape
       * `packages/drivers/.../ui-server/watchdog.ts`'s restart breaker
       * already uses, fixed at a one-hour window (only the threshold is a
       * setting). Past this many genuine-reconnect resets within the last
       * hour, resets stop and the plain `recoveryRearmSec` clock takes over
       * — the fix for plan 54 §9 Q2's own stated fear that resetting on
       * reconnect would hide a permanently dead proxy behind an infinite
       * retry loop.
       */
      maxRecoveryCyclesPerHour: z
        .number()
        .int()
        .min(1)
        .max(20)
        .default(4)
        .describe(
          'How many times a reconnect may reset a network route’s recovery budget within an hour before the slow retry clock takes over.',
        )
        .meta(ui({ title: 'Recovery resets per hour', kind: 'count' })),
      /**
       * Replaces `RECOVERY_REARM_S`'s old derived value (F15). 120s by
       * default: long enough not to hammer a dead upstream on the 20s
       * route heartbeat, short enough that an operator does not need to
       * reach for the disable/enable toggle (or, now, the `/retry`
       * endpoint) just to wait less than five minutes.
       */
      recoveryRearmSec: z
        .number()
        .int()
        .min(30)
        .max(3600)
        .default(120)
        .describe('How long automatic network-route recovery waits after giving up before trying again.')
        .meta(ui({ title: 'Recovery re-arm (s)', kind: 'duration', unit: 's' })),
    })
    .default({ provision: 'auto', maxRecoveryCyclesPerHour: 4, recoveryRearmSec: 120 })
    .meta({
      title: 'Guest agent',
      description: 'The on-device Enkaku agent — whether it is kept installed automatically on every admitted device, and the recovery bound for the network route it carries (plan 90).',
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
   * The interactive device terminal (plan 26 §4.1), extended by plan 93 §4.1
   * to also cover the fleet command console — extends this block rather than
   * adding a new top-level one, because an operator looking for "can people
   * run commands on the whole farm" looks under Device terminal, and the
   * gates are the same gates. `mode` defaults to `'admin'` here — that
   * default is correct for a loopback (single-user) install. A server-mode
   * install (non-loopback bind) overrides it to `'off'` at config load
   * instead, in `createFarmSettingsStore`: the auth mode is derived from the
   * bind address, which this Zod schema cannot see. `fanoutEnabled` below
   * gets the SAME server-mode override, forced to `false` alongside `mode`.
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
        .describe('Allow a controlling client to open a temporary adb endpoint for this farm.')
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
      /**
       * Fan-out (plan 93 §3.8, §4.1) — a SEPARATE opt-in from `mode` above,
       * on the exact precedent of `endpointEnabled` above: running one gated
       * shell and running a hundred at once are different decisions. Unlike
       * the endpoint this follows `mode`'s asymmetry rather than a flat
       * `false` — `true` here, forced to `false` in server mode by
       * `createFarmSettingsStore` (the auth mode is derived from the bind
       * address, which this schema cannot see). A laptop farm gets the
       * feature by default; an exposed farm gets a decision.
       */
      fanoutEnabled: z
        .boolean()
        .default(true)
        .describe('Allow one command to be sent to many devices at once. Turned off automatically on a server-mode install.')
        .meta(ui({ title: 'Allow fleet commands', group: 'Fleet commands' })),
      fanoutMaxDevices: z
        .number()
        .int()
        .min(0)
        .max(1_000)
        .default(0)
        .describe('Largest number of devices one command may target. 0 means no limit.')
        .meta(ui({ title: 'Max devices per fleet command', kind: 'count', group: 'Fleet commands' })),
      /** 0 = as many as the adb exec semaphore already lets through (plan 93 §3.5) — no second concurrency mechanism. */
      fanoutConcurrency: z
        .number()
        .int()
        .min(0)
        .max(64)
        .default(0)
        .describe('How many devices a fleet command runs on at once. 0 lets the adb scheduler decide.')
        .meta(ui({ title: 'Fleet command concurrency', kind: 'count', group: 'Fleet commands' })),
      fanoutMaxOutputBytes: z
        .number()
        .int()
        .min(1_024)
        .max(262_144)
        .default(32_768)
        .describe('Output kept per device for a fleet command. Smaller than a single terminal command on purpose — a fleet command is a survey, not a capture.')
        .meta(ui({ title: 'Max output per device (bytes)', kind: 'bytes', group: 'Fleet commands' })),
      /** Sized against `MAX_BUFFERED` (512 KB, `ws-handlers.ts`) — see plan 93 §3.6, §4.4. */
      fanoutPreviewBytes: z
        .number()
        .int()
        .min(256)
        .max(16_384)
        .default(2_048)
        .describe('How much of each distinct result is pushed live to the browser. The rest is fetched on demand.')
        .meta(ui({ title: 'Live result preview (bytes)', kind: 'bytes', group: 'Fleet commands' })),
      fanoutConfirmThreshold: z
        .number()
        .int()
        .min(0)
        .max(1_000)
        .default(5)
        .describe('Above this many devices, the operator must type the device count to confirm. 0 always asks.')
        .meta(ui({ title: 'Typed confirmation above', kind: 'count', group: 'Fleet commands' })),
      fanoutStageWaitSec: z
        .number()
        .int()
        .min(60)
        .max(86_400)
        .default(900)
        .describe('How long a staged command waits for Continue before it is cancelled.')
        .meta(ui({ title: 'Staged command wait (s)', kind: 'duration', unit: 's', group: 'Fleet commands' })),
      commandRunsPerUser: z
        .number()
        .int()
        .min(50)
        .max(5_000)
        .default(500)
        .describe('How many past commands are kept per person. The oldest go first.')
        .meta(ui({ title: 'Command history per person', kind: 'count', group: 'Fleet commands' })),
      savedCommandLimit: z
        .number()
        .int()
        .min(10)
        .max(1_000)
        .default(200)
        .describe('How many saved commands this farm may hold.')
        .meta(ui({ title: 'Max saved commands', kind: 'count', group: 'Fleet commands' })),
    })
    .default({
      mode: 'admin',
      execTimeoutMs: 15_000,
      maxOutputBytes: 262_144,
      endpointEnabled: false,
      endpointBind: '127.0.0.1',
      endpointIdleSec: 300,
      maxEndpointStreams: 8,
      fanoutEnabled: true,
      fanoutMaxDevices: 0,
      fanoutConcurrency: 0,
      fanoutMaxOutputBytes: 32_768,
      fanoutPreviewBytes: 2_048,
      fanoutConfirmThreshold: 5,
      fanoutStageWaitSec: 900,
      commandRunsPerUser: 500,
      savedCommandLimit: 200,
    })
    .meta({
      title: 'Device terminal and command console',
      description:
        'Free-form adb shell commands, gated by permission and audited in full (plan 26), plus an optional adb endpoint scoped to a controlling client (plan 27) and fleet-wide fan-out with saved commands and history (plan 93).',
    }),
  /** MVP 04 §1.3 rows 7 and 8, MVP 12 §1 "Control". */
  control: z
    .object({
      overControl: z
        .enum(['allow', 'warn', 'forbid'])
        .default('allow')
        .describe('What happens when someone starts controlling a device another person is already controlling.')
        .meta(ui({ title: 'Control over control' })),
      idleSec: z
        .number()
        .int()
        .min(5)
        .max(600)
        .default(30)
        .describe('How long after the last tap or key a device stops showing "Controlled by".')
        .meta(ui({ title: 'Control idle seconds', kind: 'duration', unit: 's' })),
    })
    .default({ overControl: 'allow', idleSec: 30 })
    .meta({ title: 'Control', description: 'Who may touch a device someone else just touched, and how long "controlled" lasts.' }),
  job: JobSettingsSchema,
  /**
   * The workflow executor's OWN outer clock (plan 99 §3.11 — "three clocks,
   * and which one kills a workflow"). Deliberately separate from
   * `job.maxTimeoutMs` right above: that ceiling answers "how long may one
   * SCRIPT run"; this one answers "how long may one DEVICE be held by one
   * PIPELINE". A 4-node workflow of hour-long nodes is 4 hours, and
   * `job.defaultTimeoutMs` is 1 hour — inheriting it would kill every
   * non-trivial workflow, and with a message naming no node. This is the
   * coarse backstop; a node's own timeout (still `job.maxTimeoutMs`-clamped,
   * unchanged) is the fine-grained one that can say what is actually stuck.
   *
   * Two consumers, both LIVE, both read fresh, never captured (matching every
   * other farm-wide knob in this file — docs/settings-audit.md #3,
   * `docs/plans/96-m61-hotfixes.md`): the workflow executor's own runtime
   * clock (`packages/core/src/jobs/executors/workflow.ts`,
   * `E_WORKFLOW_BUDGET_EXCEEDED` — `daemon.ts` wires
   * `settings: () => settingsStore.get().workflow`, guarded by
   * `workflow-settings-wiring.test.ts`) and `checkWorkflow`'s publish-time
   * arithmetic (`packages/protocol/src/workflow-check.ts`,
   * `E_WORKFLOW_BUDGET_IMPOSSIBLE`, plan 99 §4.3 check 7) — `daemon.ts`'s
   * `createWorkflowRoutes({...})` call also passes
   * `settings: () => settingsStore.get().workflow`, guarded by
   * `daemon-wiring.test.ts`'s own workflow-routes describe block;
   * `checkWorkflow` itself never reads a settings store (§4.3's own "stays
   * pure" rule), so the route resolves the value and hands it in. Until the
   * routes half was wired, this comment (and `workflow.ts`'s own module doc
   * comment) described the gap BACKWARDS — claiming the executor was the
   * half still hardcoded and the publish check was already live, when the
   * opposite was true. Both are correct now; if a future edit regresses
   * either wiring, the two guard tests above fail by name.
   */
  workflow: z
    .object({
      maxTotalMs: z
        .number()
        .int()
        .min(60_000)
        .max(604_800_000) // 7 days
        .default(21_600_000) // 6h — plan 99 §4.10's own default
        .describe(
          "How long a workflow job may run in total, across every node, before it is failed with E_WORKFLOW_BUDGET_EXCEEDED. Separate from a script's own timeout (job.maxTimeoutMs) — this bounds the whole pipeline, not one node.",
        )
        .meta(ui({ title: 'Max workflow duration (ms)', kind: 'duration', unit: 'ms' })),
    })
    .default({ maxTotalMs: 21_600_000 })
    .meta({
      title: 'Workflows',
      description: 'How long a workflow job may hold a device in total, across every node in the pipeline (plan 99 §3.11).',
    }),
  /**
   * Session builds (MVP 11 §1.4). A session is built when a device comes online and lives
   * as long as the device is online; the only knob is how many builds may run at once per
   * USB root hub. The farm-wide ceiling is a constant (`SESSION_BUILD_FARM_CEILING`, 16).
   */
  session: z
    .object({
      buildsPerUsbRoot: z
        .number()
        .int()
        .min(1)
        .max(16)
        .default(4)
        .describe('How many device sessions may be starting at the same time on one USB root hub. Raise if a cold start of many devices is too slow; lower if it saturates USB.')
        .meta(ui({ title: 'Session builds per USB root', kind: 'count' })),
    })
    .default({ buildsPerUsbRoot: 4 })
    .meta({
      title: 'Device sessions',
      description: 'How many device sessions may be starting at once on one USB root hub. Sessions themselves are always on.',
    }),
  /**
   * Plan 100 §4.3, step 100.6 (closes 96.22/G10/G11) — a session that opened
   * on the screencap-loop fallback used to stay there for its whole life,
   * with no way back short of a full core restart. This bounds the
   * background retry `packages/session/src/session.ts` now runs: 10s, 30s,
   * 60s, then a 5-minute steady state, up to this many attempts before the
   * session settles honestly into the degraded state until a fresh session
   * (device reconnect) rebuilds it. Six is not measured against real
   * hardware — it is chosen so the retry keeps trying for roughly 25
   * minutes (10+30+60+300*3) before giving up, comfortably longer than any
   * transient adb/toolchain hiccup this plan's own evidence recorded (96.25's
   * boot race settled in under 90s), while still bounded rather than polling
   * a genuinely broken device forever.
   */
  display: z
    .object({
      fallbackRetryCount: z
        .number()
        .int()
        .min(0)
        .max(20)
        .default(6)
        .describe('How many times a session on the screencap-loop fallback re-attempts scrcpy before giving up until a fresh session. 0 disables the retry entirely.')
        .meta(ui({ title: 'Fallback retry attempts', kind: 'count' })),
    })
    .default({ fallbackRetryCount: 6 })
    .meta({
      title: 'Display fallback recovery',
      description: 'How persistently a device recovers from the screencap-loop fallback back to scrcpy.',
    }),
  /**
   * Video quality (plan 92 §3.5, §3.6, §3.7, §4.1) — the numbers behind the
   * two quality profiles (`control`, the device page; `wall`, a wall tile),
   * farm-wide. `resolveVideoProfile` (`packages/session/src/video-profile.ts`)
   * is the ONE place these are combined with a device's own override
   * (`DeviceSettingsSchema.video` above) — nothing else in the codebase
   * computes `max_size`/`max_fps`/`video_bit_rate` on its own (F5, F7).
   *
   * Deliberately flat, not nested under `control`/`wall` sub-objects:
   * `PATCH /api/settings` merges one level deep (F22) and the settings form
   * PATCHes the whole object anyway, but a flat section is the shape that is
   * correct under both, and it keeps every field its own Zod node the
   * schema-driven form can render (§3.6) with no bespoke component.
   *
   * No optional field anywhere in this block, on purpose (F22): every field
   * carries a default, so the farm-level "saved but never cleared" defect
   * that already affects `network.geoProvider` cannot happen here.
   *
   * The defaults below are `CONTROL_PRESETS.sharp` and `WALL_PRESETS.balanced`
   * (`packages/session/src/video-profile.ts`). `control`'s numbers are the
   * pre-plan-92 `QUALITY_PROFILES` constants, unchanged, so a farm that
   * changes no `control` setting still sees byte-identical scrcpy arguments
   * (step 92.1's own verifiable result). `wall`'s numbers were revised by
   * plan 100 §3.4 — the pre-plan-100 `balanced` default (480 px · 5 fps ·
   * 800 kbit/s) read as a slideshow; a farm that changes no `wall` video
   * setting now sees the new, higher-fps defaults on upgrade, on purpose
   * (plan 100 §1's own goal, not a regression of 92.1's promise, which only
   * ever covered `control`).
   */
  video: z
    .object({
      controlPreset: ControlPresetSchema.default('sharp')
        .describe(
          'Picture quality for the device page. Sharp 1600 px · 30 fps · 4 Mbit/s. Balanced 1080 px · 30 fps · 2.5 Mbit/s. Light 720 px · 20 fps · 1.2 Mbit/s.',
        )
        .meta({ title: 'Device page picture' }),
      controlMaxSize: z
        .number()
        .int()
        .min(480)
        .max(2560)
        .default(1600)
        .describe('Longest edge of the device-page picture, in pixels.')
        .meta({ title: 'Device page size (px)' }),
      controlMaxFps: z
        .number()
        .int()
        .min(5)
        .max(60)
        .default(30)
        .describe('Frames per second for the device page.')
        .meta({ title: 'Device page frame rate' }),
      controlBitRate: z
        .number()
        .int()
        .min(500_000)
        .max(20_000_000)
        .default(4_000_000)
        .describe('Video bitrate for the device page, in bits per second.')
        .meta({ title: 'Device page bitrate' }),
      wallPreset: WallPresetSchema.default('balanced')
        .describe(
          'Picture quality for wall tiles. Detailed 640 px · 22 fps · 1.5 Mbit/s. Balanced 480 px · 18 fps · 1.1 Mbit/s. Light 320 px · 14 fps · 650 kbit/s. Minimal 240 px · 10 fps · 350 kbit/s. These fps numbers are an interim raise (plan 100 step 100.8), pending the hardware ladder in that plan\'s §7.3.',
        )
        .meta({ title: 'Wall tile picture' }),
      wallMaxSize: z
        .number()
        .int()
        .min(160)
        .max(1080)
        .default(480)
        .describe('Longest edge of a wall tile, in pixels. Bigger tiles mean fewer live at once.')
        .meta({ title: 'Wall tile size (px)' }),
      wallMaxFps: z
        .number()
        .int()
        .min(1)
        .max(30)
        .default(18)
        .describe(
          'Frames per second for a wall tile. Raised by plan 100 step 100.8 now that a loopback/LAN wall\'s tile budget is decode-bound, not bandwidth-bound (step 100.3) — an interim number pending §7.3\'s hardware ladder, not a measured ceiling. Kept below Control\'s 24 fps NFR floor (spec §16) so the two stay visibly distinct.',
        )
        .meta({ title: 'Wall tile frame rate' }),
      wallBitRate: z
        .number()
        .int()
        .min(100_000)
        .max(8_000_000)
        .default(1_100_000)
        .describe(
          'Video bitrate for one wall tile, in bits per second. The live-tile budget is divided by this number when Max live wall tiles is set to automatic.',
        )
        .meta({ title: 'Wall tile bitrate' }),
    })
    .default({
      controlPreset: 'sharp',
      controlMaxSize: 1600,
      controlMaxFps: 30,
      controlBitRate: 4_000_000,
      wallPreset: 'balanced',
      wallMaxSize: 480,
      wallMaxFps: 18,
      wallBitRate: 1_100_000,
    })
    .meta({
      title: 'Video',
      description: 'How much picture each of the two views asks for. The device page and the wall are tuned separately: one is being driven, the other is being watched.',
    }),
  /**
   * The fleet Wall (plan 42 §3.5, §4.6; plan 92 §3.2, §3.3, §3.7, §4.1; plan
   * 100 §3.1, §3.3, §4.1) — a grid of every device's screen at a low-rate
   * `wall` quality profile.
   *
   * `maxTiles: 0` (auto) resolves through `computeAutoTiles`
   * (`packages/session/src/video-profile.ts`), the min of TWO independent
   * bounds (plan 100 §3.1, amending plan 92 §3.7's single bandwidth-only
   * formula):
   *
   *   - a DECODE bound (`decodeTileCeiling` below) — how many tiles one
   *     browser tab is assumed able to decode smoothly, applied always,
   *     any transport, because decode cost is a browser-tab constraint, not
   *     a network one;
   *   - a BANDWIDTH bound — `bandwidthBps` below divided by the resolved
   *     wall bitrate, but ONLY on loopback/LAN; a cloud/WAN deployment is
   *     hard-pinned to the pre-plan-100 20 Mbit/s constant instead
   *     (`WALL_VIDEO_BUDGET_BPS`, `packages/session/src/video-profile.ts`),
   *     never this field, so cloud mode's tile budget stays provably
   *     byte-identical to its pre-plan-100 behaviour (plan 100 §3.6) no
   *     matter what an operator sets `bandwidthBps` to.
   *
   * Raising wall picture quality still lowers the live-tile count
   * automatically on either bound; a non-zero `maxTiles` still pins the
   * count exactly like `adb.maxStreams`'s own `0 = auto` convention (F24).
   *
   * `rampConcurrency` bounds how many tiles may ask for a stream at the same
   * time while the wall fills in (plan 92 §3.3) — a CLIENT-side courtesy
   * only; sessions are always on now (plan 206), so a tile's request
   * attaches to an already-built entry rather than racing a build.
   *
   * There is deliberately NO `defaultView` field here. §9 Q1 (decided
   * 2026-08-12, plan 92 §3.10): the Wall is the unconditional landing view;
   * a farm setting that let an admin default everyone to List is exactly the
   * configurability the owner ruled out. A later step makes the Wall the
   * front door through a per-tab session preference instead
   * (`packages/studio/src/lib/prefs.ts`), never a farm setting.
   *
   * `maxTiles: 8` was the fixed pre-plan-92 default (F3) — nobody chose it,
   * it was the only number available. `normaliseLegacyWall` above rewrites a
   * stored 8 to 0 on the first boot after upgrade
   * (`docs/plans/00-overview.md` §9); a stored value that is not 8 is left
   * alone. `normaliseLegacyWall` is untouched by plan 100 — the three new
   * fields below are additive, and every farm without them stored already
   * gets Zod's own per-field defaults on read, no migration needed (matching
   * plan 92's own precedent for adding `maxTiles`/`rampConcurrency`).
   */
  wall: z
    .preprocess(
      normaliseLegacyWall,
      z.object({
        maxTiles: z
          .number()
          .int()
          .min(0)
          .max(64)
          .default(0)
          .describe(
            'How many wall tiles stream live at once. 0 divides a fixed video budget by the wall tile bitrate, so raising picture quality lowers the tile count automatically.',
          )
          .meta(ui({ title: 'Max live wall tiles', kind: 'count' })),
        rampConcurrency: z
          .number()
          .int()
          .min(1)
          .max(8)
          .default(2)
          .describe('How many wall tiles may ask for a stream at the same time while the wall fills in.')
          .meta(ui({ title: 'Wall fill-in concurrency', kind: 'count' })),
        decodeTileCeiling: z
          .number()
          .int()
          .min(4)
          .max(64)
          .default(24)
          .describe(
            'The hard cap on how many wall tiles show a live picture at once — if your wall stops casting at a certain number, this is usually the number. It is about what one browser TAB can decode, not what the farm can send, and it applies regardless of transport. The default of 24 is a placeholder, NOT a measurement: plan 100 §7.3\'s hardware ladder has never been run, and 24 was picked to sit safely below the auto-tile formula\'s own [4, 32] ceiling. Raise it until your own tab stutters — that is the measurement nobody has taken yet.',
          )
          .meta(ui({ title: 'Max live tiles your browser will decode', kind: 'count' })),
        bandwidthBps: z
          .number()
          .int()
          .min(1_000_000)
          .max(1_000_000_000)
          .default(200_000_000)
          .describe(
            'Bits/sec assumed available to a wall tab on loopback or LAN. Only used when the deployment is genuinely cloud (WAN); on WAN this is overridden to a fixed 20 Mbit/s regardless of this value, matching the pre-plan-100 behaviour exactly.',
          )
          .meta(ui({ title: 'Wall bandwidth budget (loopback/LAN)', kind: 'bitrate' })),
        transportOverride: z
          .enum(['auto', 'loopback', 'lan', 'wan'])
          .default('auto')
          .describe(
            'How the wall tile budget decides whether bandwidth is a real constraint. "Auto" derives it from how the core was started — orchestrator/cloud mode reads as WAN, everything else as loopback/LAN (CLAUDE.md: "auth mode derives from the bind address" is the same rule). Set this only when Studio is deliberately served over a WAN link from a local-mode core.',
          )
          .meta(
            ui({
              title: 'Wall transport',
              labels: { auto: 'Auto', loopback: 'Loopback', lan: 'LAN', wan: 'WAN' },
            }),
          ),
      }),
    )
    .default({ maxTiles: 0, rampConcurrency: 2, decodeTileCeiling: 24, bandwidthBps: 200_000_000, transportOverride: 'auto' })
    .meta({
      title: 'Fleet wall',
      description: 'The devices list Wall mode: every screen live, at a low-rate quality profile.',
    }),
  /**
   * Device readiness (plan 43 §3.5, §4.4). `maxHot` no longer "matches
   * `wall.maxTiles`" — plan 92 §3.7 corrects this comment, because
   * `wall.maxTiles` is now derived from the wall's own resolved video
   * bitrate and the decode/bandwidth budget split (`computeAutoTiles`, the
   * `video`/`wall` blocks above; plan 100 §3.1 amends the formula but not
   * this independence), not a fixed number this could match. Plan 100 §2
   * leaves `maxHot`/`defaultDesired` untouched by construction — this block
   * is unedited by plan 100 beyond this comment. What is actually true: `maxHot` bounds
   * devices held hot BY POLICY — the readiness manager keeping a session
   * warm because `defaultDesired` or an operator asked for it — while the
   * wall's own live-set policy (plan 92 §3.2) separately bounds devices held
   * hot BY BEING WATCHED. The two budgets are independent.
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
      /**
       * **The default moved `'asleep'` → `'awake'` in plan 125 §3.1.** The
       * owner's instruction was direct: the default must be on.
       *
       * This is a genuine change of product character and is worth defending.
       * A device farm's phones exist to be looked at and driven; a fleet that
       * goes dark five minutes after you look away optimises for a cost
       * (battery) that a permanently-powered rack does not pay, and against
       * the thing the product is for. Plan 45 §3.7 described the old
       * behaviour approvingly — "sleeps five minutes after you navigate away"
       * — and it reads very differently from inside a sealed phone-farm box
       * where waking a device by hand means opening the box.
       *
       * `'awake'` and not `'hot'` (plan 125 §3.2): `maxHot` above defaults to
       * 8, so a `'hot'` default on a 12-device farm would leave four phones
       * `blocked: 'hot_budget_full'` — a farm that boots into a partly-failed
       * state, with the failure worded as a budget error. `'awake'` has no
       * cap.
       *
       * **An existing farm is not touched by this**, by the same mechanism as
       * `prep.keepAwake` above: `createFarmSettingsStore`
       * (`packages/core/src/settings/farm-settings.ts`) writes a FULLY
       * MATERIALISED `FarmSettings` into the `farm_settings` row the first
       * time a farm boots, so every farm that already exists has its own
       * literal `'asleep'` stored and re-reads that, never this default. And
       * a device already enrolled keeps the `desiredReadiness` column it was
       * admitted with — `desiredOf`/`staticReadinessFallback`
       * (`packages/core/src/device/readiness.ts`) still read a NULL column as
       * `'asleep'`, so a row predating readiness entirely is left where it is
       * rather than being woken by a schema edit. Only a fresh farm's freshly
       * admitted device gets `'awake'` (plan 125 §5 step 125.2's migration
       * note, §8's "flipping a product default" risk).
       */
      defaultDesired: ReadinessSchema.default('awake')
        .describe('Readiness a newly enrolled device starts at.')
        .meta({ title: 'Default device readiness' }),
    })
    .default({ maxHot: 8, defaultDesired: 'awake' })
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
      /**
       * Bulk pull's one-download archive (plan 93 §3.13, §4.1). Bounded well
       * under the 4 GiB boundary where zip64 would be required, so the
       * stored-zip writer (`api/zip-stream.ts`) stays simple.
       */
      maxArchiveBytes: z
        .number()
        .int()
        .min(1_048_576)
        .max(4_294_967_295)
        .default(2_147_483_648)
        .describe('Largest combined download of the files a bulk pull collected. Above this, download them per device.')
        .meta(ui({ title: 'Max bulk download size (bytes)', kind: 'bytes' })),
    })
    .default({ enabled: true, maxPushBytes: 536_870_912, maxPullBytes: 536_870_912, installTimeoutMs: 300_000, maxArchiveBytes: 2_147_483_648 })
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
   * The workspace (plan 64 §3.3, extended by plan 115 §3.1, §3.4, §3.5) —
   * SQLite holds only the catalogue; a content driver holds the bytes
   * (`inline` in the row, or `fs` on disk under `workspace-content/`). `
   * maxFileBytes`/`maxTotalBytesPerScope` are now a DISK budget rather than a
   * database one — which is what makes numbers this size reasonable at all —
   * so their defaults moved from ~1 MiB/64 MiB to 256 MiB/8 GiB to fit the
   * owner's actual workflow (uploading video into the workspace). `E_QUOTA`
   * names whichever of these was exceeded, plus current usage AND which
   * setting to raise, so a caller that hits one can act on it rather than
   * just retry.
   */
  workspace: z
    .object({
      maxFileBytes: z
        .number()
        .int()
        .min(1)
        .default(268_435_456)
        .describe(
          'Largest single workspace file, in bytes — a disk budget (plan 115 §3.5): a file over the inline threshold below lives on disk behind the fs content driver, not in SQLite.',
        )
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
        .default(8_589_934_592)
        .describe('Largest total size of one scope\'s files, in bytes — a disk budget, not a database one (plan 115 §3.5).')
        .meta(ui({ title: 'Max total bytes per scope', kind: 'bytes' })),
      inlineMaxBytes: z
        .number()
        .int()
        .min(0)
        .default(65_536)
        .describe(
          'Content at or under this size, and recognised as text, is stored inline in the workspace_files row; anything larger, or anything not text, is stored on disk behind the fs content driver instead (plan 115 §3.4). A caller never picks — this setting does.',
        )
        .meta(ui({ title: 'Inline storage threshold (bytes)', kind: 'bytes' })),
    })
    .default({ maxFileBytes: 268_435_456, maxFilesPerScope: 1_000, maxTotalBytesPerScope: 8_589_934_592, inlineMaxBytes: 65_536 })
    .meta({
      title: 'Workspace',
      description: 'Limits on the workspace\'s database catalogue and its on-disk content driver, shared by agents and people (plan 64, extended by plan 115).',
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
  /**
   * The action recorder (plan 94 §3.3, §4.6, step 94.3) — the tee that turns
   * an operator's manual taps and drags into a `RecordingDoc` (`./recording.ts`)
   * while `recording.start` is open on a device. `anchorQuietMs`/
   * `anchorMinIntervalMs` throttle the one expensive part (an inspector dump,
   * F14: 334-584ms measured) to windows where the operator is between
   * gestures, so recording never distorts the very timing it is capturing.
   * `maxSteps`/`maxDurationSec` are the bounds a recorder left running must
   * hit eventually — exceeding either ends the recording cleanly, with a
   * stated reason, never a silent truncation.
   */
  recording: z
    .object({
      anchorQuietMs: z
        .number()
        .int()
        .min(0)
        .max(10_000)
        .default(400)
        .describe('How long the operator must pause between gestures before the recorder takes an anchor — a UI tree snapshot used to propose a selector for the next tap.')
        .meta(ui({ title: 'Anchor quiet period (ms)', kind: 'duration', unit: 'ms' })),
      anchorMinIntervalMs: z
        .number()
        .int()
        .min(0)
        .max(60_000)
        .default(1_500)
        .describe('The least time between two anchor dumps, so a fast operator cannot flood the blob store with tree snapshots.')
        .meta(ui({ title: 'Anchor minimum interval (ms)', kind: 'duration', unit: 'ms' })),
      longPressMs: z
        .number()
        .int()
        .min(200)
        .max(10_000)
        .default(400)
        .describe('A tap held at least this long is recorded as a long press rather than a plain tap. The wire message is still input.tap either way — only the recorded step kind differs.')
        .meta(ui({ title: 'Long-press threshold (ms)', kind: 'duration', unit: 'ms' })),
      maxSteps: z
        .number()
        .int()
        .min(1)
        .max(2_000)
        .default(500)
        .describe('A recording stops itself, cleanly, once it reaches this many steps — a recorder left running is an unbounded write path.')
        .meta(ui({ title: 'Max steps per recording', kind: 'count' })),
      maxDurationSec: z
        .number()
        .int()
        .min(1)
        .max(86_400)
        .default(900)
        .describe('A recording stops itself, cleanly, once it has been open this long.')
        .meta(ui({ title: 'Max recording duration (s)', kind: 'duration', unit: 's' })),
      captureScreenshots: z
        .boolean()
        .default(true)
        .describe('Store a screenshot for each recorded step, through the same content-addressed blob store agent screenshots already use (F16) — an unchanged screen between two steps stores only one blob.')
        .meta({ title: 'Capture step screenshots' }),
    })
    .default({ anchorQuietMs: 400, anchorMinIntervalMs: 1_500, longPressMs: 400, maxSteps: 500, maxDurationSec: 900, captureScreenshots: true })
    .meta({
      title: 'Action recorder',
      description: 'How the recorder samples the screen while an operator free-taps a device, and the bounds that end a forgotten recording cleanly (plan 94).',
    }),
})
export type FarmSettings = z.infer<typeof FarmSettingsSchema>
/**
 * `DeviceSettings` minus `identity` — what `FarmSettings.defaults` actually
 * is (docs/settings-audit.md #1). `defaultsForNewDevice`
 * (`packages/core/src/registry/admission.ts` and `device-registry.ts`)
 * declares its `deviceDefaults` accessor against this type, then fills a new
 * device's `identity` from `DeviceIdentitySchema`'s own empty default —
 * never from the farm-wide block, which cannot carry one anymore.
 */
export type FarmDeviceDefaults = FarmSettings['defaults']
export type SessionSettings = FarmSettings['session']
/** Plan 92 §3.5, §4.1 — read by `packages/session/src/video-profile.ts`'s `resolveVideoProfile`. */
export type VideoSettings = FarmSettings['video']
export type WallSettings = FarmSettings['wall']
export type ReadinessSettings = FarmSettings['readiness']
export type WorkspaceSettings = FarmSettings['workspace']
export type KvSettings = FarmSettings['kv']
export type ControlSettings = FarmSettings['control']
/** Plan 99 §3.11 — read by `packages/core/src/jobs/executors/workflow.ts` (its own `WorkflowSettings`) and by whichever caller passes a `WorkflowBudget` into `checkWorkflow` (`packages/protocol/src/workflow-check.ts`). */
export type WorkflowJobSettings = FarmSettings['workflow']
/** Plan 94 §4.6, step 94.3 — read by `packages/core/src/recording/service.ts`. */
export type RecordingSettings = FarmSettings['recording']

export const defaultFarmSettings = (): FarmSettings => FarmSettingsSchema.parse({})
export const defaultDeviceSettings = (): DeviceSettings => DeviceSettingsSchema.parse({})
