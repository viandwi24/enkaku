import { z } from 'zod'
import { RouteLifecycleStateSchema, Socks5RouteConfigSchema } from './network'
import { UiNodeSchema } from './ui-node'
import { ActivityKindSchema } from './activity'

/**
 * The wire contract between the farm host and the Enkaku guest agent APK
 * (plan 44 §4.2). Mirrors
 * `apps/guest-agent/app/src/main/java/dev/enkaku/guestagent/control/Protocol.kt`
 * exactly — both sides change together, and `GUEST_AGENT_PROTOCOL` is bumped
 * whenever a message shape changes, so a mismatch is refused with a coded
 * error rather than degraded into silently talking past each other.
 *
 * No message-type string from this contract belongs anywhere outside this
 * package (CLAUDE.md): every method name and error code is a value exported
 * from here, never a literal typed again at a call site.
 */

/**
 * The abstract-namespace socket name the host reaches with
 * `adb forward localabstract:<name>`. Abstract rather than a TCP port: no
 * INTERNET permission needed, no device-side port collision between phones,
 * unreachable from any network interface, nothing left on disk.
 */
export const GUEST_AGENT_SOCKET = 'enkaku-guest-agent'

/**
 * The protocol major version. A host that speaks a different major refuses
 * to proceed rather than guessing at compatibility (plan 44 §4.4's `client.ts`
 * checks this on `hello`, before anything else).
 */
export const GUEST_AGENT_PROTOCOL = 1

/**
 * What a build of the agent can actually do, advertised rather than assumed
 * — the same pattern the driver registry uses for engine capabilities.
 * `egress-probe` has been advertised by every build since plan 51 §5.4, once
 * the probe actually ran on a socket protected out of the agent's own
 * tunnel (a probe measured from inside the tunnel would only ever answer its
 * own question — Protocol.kt's `CAPABILITIES` comment, plan 44 §2). This
 * comment previously claimed no build advertised it, which was already false
 * the moment plan 51 shipped Protocol.kt's own entry — corrected here (F41,
 * plan 90 §0.1): `Protocol.kt` is the file that was always right.
 *
 * `route-hold` (plan 55 §3.5, §4.1, §5.6) — an older build has no `route.hold` handler and
 * answers `E_UNKNOWN_METHOD`; the host gates on this the same way it gates `egress.probe` on
 * `egress-probe`, rather than finding out from a failed call.
 *
 * `screen-label` (plan 89 §4.5; plan 90 §3.6, §4.1) — gates `label.apply` / `label.status` /
 * `label.clear`. An older build (or one whose on-device label facet is not yet built — see
 * `Protocol.kt`'s doc comment on this same list) answers `E_UNKNOWN_METHOD` for all three, which
 * plan 89 §3.5 reports as its `unavailable` tier rather than an error.
 *
 * `text-input` (plan 90 §3.2, §3.3, §4.1) — gates `text.commit` / `text.status`. An older build
 * answers `E_UNKNOWN_METHOD` for both, which the text-routing resolver (`resolveTextRoute`, §4.5)
 * reads as "rung 1 (`agent-ime`) is unavailable" and falls down the ladder rather than failing
 * the call outright.
 *
 * `ui-tree` (plan 221 §4.2, MVP 02 §4 phase 2, MVP 10 §1.1) — gates `ui.dump` / `ui.find` /
 * `ui.watch` / `ui.unwatch` / `ui.status`. Advertised by every build that CONTAINS the
 * `AccessibilityService`, whether or not the service is currently enabled in Settings: the
 * capability says what the build can do, `ui.status` says whether it can do it right now.
 * Conflating the two would make an unenabled service look like an old APK, which is a different
 * repair.
 *
 * `activity` (plan 221 §4.5, MVP 10 §1.3) — gates `activity.set` and `device.describe`. Read-only
 * on the device: nothing acts on the list, it only lets the phone's own screen say what the farm
 * is doing to it.
 */
export const GuestAgentCapabilitySchema = z.enum([
  'socks5-route',
  'vpn-status',
  'egress-probe',
  'route-hold',
  'mock-location',
  'screen-label',
  'text-input',
  'ui-tree',
  'activity',
])
export type GuestAgentCapability = z.infer<typeof GuestAgentCapabilitySchema>

/** Mirrors Protocol.kt's `ERR_*` constants. Failures are matched on `code`, never on message text. */
export const GuestAgentErrorCodeSchema = z.enum([
  'E_UNAUTHORISED',
  'E_BAD_REQUEST',
  'E_UNKNOWN_METHOD',
  'E_NOT_PAIRED',
  'E_NOT_PREPARED',
  /** Plan 221 §4.2 — the build has the service, the device has not enabled it (or it is not connected yet). */
  'E_UI_TREE_UNAVAILABLE',
])
export type GuestAgentErrorCode = z.infer<typeof GuestAgentErrorCodeSchema>

// ---- requests (host -> agent) ----

/**
 * Every request carries `id` (for response correlation over the
 * one-connection-many-requests channel) and `token` (the pairing token —
 * authorisation lives in the payload, not in a component permission, because
 * `adb shell am` and this socket both need to reach the agent unsigned; see
 * `ControlService.handle`).
 */
const GuestAgentRequestBaseSchema = z.object({
  id: z.string(),
  token: z.string(),
})

export const HelloRequestSchema = GuestAgentRequestBaseSchema.extend({
  method: z.literal('hello'),
  /**
   * Plan 221 §4.9, MVP 10 §2 — the `deviceArtifact.versionCode` this host has pinned. The agent
   * stores it and its status screen says "host expects build N" when N is higher than its own, so
   * an outdated agent says so itself instead of waiting for someone to compare two numbers by
   * hand. Optional: an older host omits it and the row is simply absent.
   */
  expectVersionCode: z.number().int().positive().optional(),
})
export type HelloRequest = z.infer<typeof HelloRequestSchema>

export const PingRequestSchema = GuestAgentRequestBaseSchema.extend({
  method: z.literal('ping'),
})
export type PingRequest = z.infer<typeof PingRequestSchema>

export const RouteStartRequestSchema = GuestAgentRequestBaseSchema.extend({
  method: z.literal('route.start'),
  config: Socks5RouteConfigSchema,
})
export type RouteStartRequest = z.infer<typeof RouteStartRequestSchema>

export const RouteStopRequestSchema = GuestAgentRequestBaseSchema.extend({
  method: z.literal('route.stop'),
})
export type RouteStopRequest = z.infer<typeof RouteStopRequestSchema>

export const RouteStatusRequestSchema = GuestAgentRequestBaseSchema.extend({
  method: z.literal('route.status'),
})
export type RouteStatusRequest = z.infer<typeof RouteStatusRequestSchema>

/**
 * Plan 51 §4.2, §5.4 — measures whether the world is actually reachable, from the device, through
 * the tunnel. Only meaningful once the agent advertises the `egress-probe` capability (§5.4:
 * advertised ONLY once this is implemented) — an older build answers `E_UNKNOWN_METHOD`, which the
 * host-side engine checks (`packages/core/src/api/guest-agent.ts`) treat as "cannot run this check"
 * rather than a route failure.
 */
export const EgressProbeRequestSchema = GuestAgentRequestBaseSchema.extend({
  method: z.literal('egress.probe'),
  url: z.string().url(),
  timeoutMs: z.number().int().positive().max(60_000),
})
export type EgressProbeRequest = z.infer<typeof EgressProbeRequestSchema>

/**
 * Plan 55 §3.5, §4.1, §5.6 — forces the SAME hold-closed transition Plan 54's dead-man's switch
 * reaches internally (`RouteVpnService.hold()`), but reachable from the HOST: a `geo` check
 * disagreeing with `Socks5RouteConfig.onGeoFail: 'hold'` is decided on the HOST (only the host
 * runs the geo lookup and the comparison), so unlike every other hold trigger — which are all
 * on-device conditions the agent notices about itself — this one has to be told. `reason` is
 * plain language, shown back through `route.status`'s `lastError`, same as any other hold.
 */
export const RouteHoldRequestSchema = GuestAgentRequestBaseSchema.extend({
  method: z.literal('route.hold'),
  reason: z.string().min(1),
})
export type RouteHoldRequest = z.infer<typeof RouteHoldRequestSchema>

/**
 * Plan 58 §4.4 — reports a mock GPS fix as the device location. Only meaningful
 * once the agent advertises the `mock-location` capability; an older build
 * answers `E_UNKNOWN_METHOD`, which the host treats as "identity GPS cannot be
 * applied" rather than a route failure (same gate as `egress.probe`). The fix
 * is installed via Android's test-provider API — no root, stock Android.
 */
export const LocationSetRequestSchema = GuestAgentRequestBaseSchema.extend({
  method: z.literal('location.set'),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracy: z.number().positive().max(10_000).default(100),
})
export type LocationSetRequest = z.infer<typeof LocationSetRequestSchema>

/** Plan 58 §4.4 — removes the mock provider, restoring real location. */
export const LocationClearRequestSchema = GuestAgentRequestBaseSchema.extend({
  method: z.literal('location.clear'),
})
export type LocationClearRequest = z.infer<typeof LocationClearRequestSchema>

/**
 * Plan 89 §4.5, reproduced field for field; plan 90 §3.6, §4.1. Only meaningful once the agent
 * advertises `screen-label`; an older build (or one whose label facet is not yet built — see
 * `Protocol.kt`) answers `E_UNKNOWN_METHOD`, which plan 89 §3.5 reports as its `unavailable` tier.
 * `fingerprint` is opaque to the agent — it echoes it back verbatim rather than deriving it, so
 * the core's own hashing scheme (plan 89 §4.4) is never duplicated on the Kotlin side.
 */
export const LabelApplyRequestSchema = GuestAgentRequestBaseSchema.extend({
  method: z.literal('label.apply'),
  fingerprint: z.string(),
  /** Already formatted, e.g. `'7'` — the agent draws it, it does not compute it. */
  number: z.string(),
  /** `null` means number-only. */
  name: z.string().nullable(),
  surfaces: z.array(z.enum(['home', 'lock'])),
})
export type LabelApplyRequest = z.infer<typeof LabelApplyRequestSchema>

/** Plan 89 §4.5; plan 90 §3.6, §4.1. Same capability gate as `label.apply`. */
export const LabelStatusRequestSchema = GuestAgentRequestBaseSchema.extend({
  method: z.literal('label.status'),
})
export type LabelStatusRequest = z.infer<typeof LabelStatusRequestSchema>

/**
 * Plan 89 §4.5; plan 90 §3.6, §4.1. `restoreOriginal` chooses between the two things `label.clear`
 * is allowed to do (behavioural requirement 4: idempotent, no "already cleared" flag) — restore the
 * wallpaper captured on first apply, or fall back to the system default when nothing was ever
 * captured (`originalCaptured: false` on every prior `label.status`).
 */
export const LabelClearRequestSchema = GuestAgentRequestBaseSchema.extend({
  method: z.literal('label.clear'),
  restoreOriginal: z.boolean(),
})
export type LabelClearRequest = z.infer<typeof LabelClearRequestSchema>

/**
 * Plan 90 §3.2, §3.3, §4.1 — commits text through the agent's `InputMethodService`, the only rung
 * of the text ladder (§3.3) with no side effect on the device clipboard and per-code-point timing.
 * `text` is never re-escaped on the wire — it is committed exactly as sent, one code point at a
 * time when `perCharMs` is present (so plan 40's realism survives an IME the same way it already
 * survives `scrcpy INJECT_TEXT`), the whole string at once otherwise. Only meaningful once the
 * agent advertises `text-input`; an older build answers `E_UNKNOWN_METHOD`, which the text-routing
 * resolver (`resolveTextRoute`, §4.5) reads as "rung 1 unavailable" and falls down the ladder.
 */
export const TextCommitRequestSchema = GuestAgentRequestBaseSchema.extend({
  method: z.literal('text.commit'),
  text: z.string(),
  /** Absent = commit the whole string at once. `[minMs, maxMs]`, mirroring `typeText`'s `perCharMs` range (`device-args.ts`). */
  perCharMs: z.tuple([z.number().nonnegative(), z.number().nonnegative()]).optional(),
})
export type TextCommitRequest = z.infer<typeof TextCommitRequestSchema>

/** Plan 90 §3.2, §3.3, §4.1. Same capability gate as `text.commit` — reports whether the agent's IME is actually the live one, so the resolver can decide whether rung 1 is usable before committing anything. */
export const TextStatusRequestSchema = GuestAgentRequestBaseSchema.extend({
  method: z.literal('text.status'),
})
export type TextStatusRequest = z.infer<typeof TextStatusRequestSchema>

// ---- ui-tree (plan 221 §4.2) ----

/** `maxDepth`/`maxNodes` bound the walk; both default on the device (50 / 5000). */
export const UiDumpRequestSchema = GuestAgentRequestBaseSchema.extend({
  method: z.literal('ui.dump'),
  maxDepth: z.number().int().positive().max(200).optional(),
  maxNodes: z.number().int().positive().max(50_000).optional(),
})
export type UiDumpRequest = z.infer<typeof UiDumpRequestSchema>

/**
 * The tree, in the SAME shape `uiautomator dump` and ui-server already return
 * (`packages/drivers/src/inspector/xml-parser.ts`'s `parseUiDump`): a synthetic
 * `className: 'hierarchy'` root whose children are the window roots. `root` is `UiNodeSchema`
 * itself, not a copy — that identity is what makes plan 222 an engine swap rather than a rewrite.
 * `truncated` is honest, not decorative: a tree that hit the node or depth cap says so, and a
 * caller must never render a truncated tree as complete.
 */
export const UiDumpResultSchema = z.object({
  root: UiNodeSchema,
  widthPx: z.number().int(),
  heightPx: z.number().int(),
  nodeCount: z.number().int(),
  truncated: z.boolean(),
  tookMs: z.number().int(),
})
export type UiDumpResult = z.infer<typeof UiDumpResultSchema>

/**
 * Plan 221 §4.2. `selector` is `SelectorSchema` minus its `{ point }` arm: a point selector is a
 * host-side synthetic node (`selector-match.ts`'s `matchSelector`), so sending one to the device
 * is a caller bug and the client refuses it before the wire.
 */
export const UiFindRequestSchema = GuestAgentRequestBaseSchema.extend({
  method: z.literal('ui.find'),
  selector: z.union([
    z.object({ id: z.string() }).strict(),
    z.object({ desc: z.string() }).strict(),
    z.object({ text: z.string() }).strict(),
  ]),
  maxDepth: z.number().int().positive().max(200).optional(),
  maxNodes: z.number().int().positive().max(50_000).optional(),
})
export type UiFindRequest = z.infer<typeof UiFindRequestSchema>

/** `matches` is the full count, so an ambiguous selector is reported as such (`findDetailed`'s contract). */
export const UiFindResultSchema = z.object({
  node: UiNodeSchema.nullable(),
  matches: z.number().int(),
  tookMs: z.number().int(),
})
export type UiFindResult = z.infer<typeof UiFindResultSchema>

export const UiWatchRequestSchema = GuestAgentRequestBaseSchema.extend({
  method: z.literal('ui.watch'),
})
export type UiWatchRequest = z.infer<typeof UiWatchRequestSchema>

export const UiUnwatchRequestSchema = GuestAgentRequestBaseSchema.extend({
  method: z.literal('ui.unwatch'),
})
export type UiUnwatchRequest = z.infer<typeof UiUnwatchRequestSchema>

/** The one-line ack. Every later line on that connection is a `UiChangedEvent`, never a response. */
export const UiWatchResultSchema = z.object({ watching: z.literal(true), debounceMs: z.number().int() })
export type UiWatchResult = z.infer<typeof UiWatchResultSchema>
export const UiUnwatchResultSchema = z.object({ watching: z.literal(false) })
export type UiUnwatchResult = z.infer<typeof UiUnwatchResultSchema>

/**
 * Plan 221 §4.4 — an unsolicited frame, discriminated by `event` rather than by `ok`, so a reader
 * can tell a push from a reply with one key and never has to guess. It carries no tree: the host
 * calls `ui.dump` or `ui.find` on a different connection when it wants content.
 */
export const UiChangedEventSchema = z.object({
  event: z.literal('ui.changed'),
  seq: z.number().int(),
  at: z.number().int(),
  packageName: z.string(),
  reason: z.enum(['content', 'window', 'windows']),
})
export type UiChangedEvent = z.infer<typeof UiChangedEventSchema>

export const UiStatusRequestSchema = GuestAgentRequestBaseSchema.extend({ method: z.literal('ui.status') })
export type UiStatusRequest = z.infer<typeof UiStatusRequestSchema>

/**
 * `enabled` is the Settings fact, `connected` is the runtime fact, and they are not the same:
 * a service can be listed in `enabled_accessibility_services` and still not be bound. Reported
 * separately because the repair differs (write the setting, versus wait or reboot).
 */
export const UiStatusResultSchema = z.object({
  enabled: z.boolean(),
  connected: z.boolean(),
  watching: z.boolean(),
  lastDumpAgoMs: z.number().int().nullable(),
  lastDumpNodes: z.number().int().nullable(),
  lastError: z.string().nullable(),
})
export type UiStatusResult = z.infer<typeof UiStatusResultSchema>

// ---- activity mirror (plan 221 §4.5) ----

export const GuestAgentActivitySchema = z.object({
  id: z.string(),
  kind: ActivityKindSchema,
  label: z.string(),
  /** Already resolved by the host (`DeviceActivity.actor.label`) — the agent never sees an id it would have to resolve. */
  actorLabel: z.string(),
  startedAt: z.number().int(),
})
export type GuestAgentActivity = z.infer<typeof GuestAgentActivitySchema>

export const GuestAgentVideoSchema = z.object({
  running: z.boolean(),
  widthPx: z.number().int(),
  heightPx: z.number().int(),
  fps: z.number().int(),
})
export type GuestAgentVideo = z.infer<typeof GuestAgentVideoSchema>

/**
 * Plan 221 §4.5, MVP 10 §1.3. Read-only on the device: nothing acts on this list, it exists so
 * the phone's own screen can say what the farm is doing to it. `video` is what the HOST started,
 * never a claim that anyone is watching (MVP 10 §2's Video row); `null` means no scrcpy server.
 */
export const ActivitySetRequestSchema = GuestAgentRequestBaseSchema.extend({
  method: z.literal('activity.set'),
  activities: z.array(GuestAgentActivitySchema).max(64),
  video: GuestAgentVideoSchema.nullable(),
})
export type ActivitySetRequest = z.infer<typeof ActivitySetRequestSchema>

export const ActivitySetResultSchema = z.object({ accepted: z.number().int() })
export type ActivitySetResult = z.infer<typeof ActivitySetResultSchema>

/**
 * The farm's own facts about this device, for MVP 10 §2's Device section — the rows only the host
 * knows. `group`, never "cluster" (plan 200 §2.4).
 */
export const DeviceDescribeRequestSchema = GuestAgentRequestBaseSchema.extend({
  method: z.literal('device.describe'),
  stableId: z.string().nullable(),
  label: z.string().nullable(),
  number: z.string().nullable(),
  group: z.string().nullable(),
  tags: z.array(z.string()).max(32),
})
export type DeviceDescribeRequest = z.infer<typeof DeviceDescribeRequestSchema>

export const DeviceDescribeResultSchema = z.object({ accepted: z.literal(true) })
export type DeviceDescribeResult = z.infer<typeof DeviceDescribeResultSchema>

// ---- keyboard preference (plan 221 §4.6) ----

export const TextPrefsRequestSchema = GuestAgentRequestBaseSchema.extend({
  method: z.literal('text.prefs'),
  showSoftKeyboardWithHardware: z.boolean(),
})
export type TextPrefsRequest = z.infer<typeof TextPrefsRequestSchema>

/** The read-back, never the value that was sent — same discipline as `route.status` after `route.start`. */
export const TextPrefsResultSchema = z.object({ showSoftKeyboardWithHardware: z.boolean() })
export type TextPrefsResult = z.infer<typeof TextPrefsResultSchema>

/** The full request union, discriminated on `method` — mirrors `Protocol.METHOD_*`. */
export const GuestAgentRequestSchema = z.discriminatedUnion('method', [
  HelloRequestSchema,
  PingRequestSchema,
  RouteStartRequestSchema,
  RouteStopRequestSchema,
  RouteStatusRequestSchema,
  EgressProbeRequestSchema,
  RouteHoldRequestSchema,
  LocationSetRequestSchema,
  LocationClearRequestSchema,
  LabelApplyRequestSchema,
  LabelStatusRequestSchema,
  LabelClearRequestSchema,
  TextCommitRequestSchema,
  TextStatusRequestSchema,
  UiDumpRequestSchema,
  UiFindRequestSchema,
  UiWatchRequestSchema,
  UiUnwatchRequestSchema,
  UiStatusRequestSchema,
  ActivitySetRequestSchema,
  DeviceDescribeRequestSchema,
  TextPrefsRequestSchema,
])
export type GuestAgentRequest = z.infer<typeof GuestAgentRequestSchema>

// ---- per-method results ----

export const HelloResultSchema = z.object({
  protocol: z.number().int(),
  appVersion: z.string(),
  androidSdkInt: z.number().int(),
  capabilities: z.array(GuestAgentCapabilitySchema),
})
export type HelloResult = z.infer<typeof HelloResultSchema>

export const PingResultSchema = z.object({
  pong: z.literal(true),
})
export type PingResult = z.infer<typeof PingResultSchema>

export const RouteStartResultSchema = z.object({
  started: z.literal(true),
})
export type RouteStartResult = z.infer<typeof RouteStartResultSchema>

export const RouteStopResultSchema = z.object({
  stopped: z.literal(true),
})
export type RouteStopResult = z.infer<typeof RouteStopResultSchema>

/** Plan 55 §3.5, §4.1, §5.6. Mirrors `RouteStartResultSchema`'s shape — a plain acknowledgement, since `route.status` is where the resulting state is actually read back. */
export const RouteHoldResultSchema = z.object({
  held: z.literal(true),
})
export type RouteHoldResult = z.infer<typeof RouteHoldResultSchema>

/** Plan 58 §4.4. Plain acknowledgement that the mock fix was installed. */
export const LocationSetResultSchema = z.object({
  set: z.literal(true),
})
export type LocationSetResult = z.infer<typeof LocationSetResultSchema>

/** Plan 58 §4.4. Plain acknowledgement that the mock provider was removed. */
export const LocationClearResultSchema = z.object({
  cleared: z.literal(true),
})
export type LocationClearResult = z.infer<typeof LocationClearResultSchema>

/**
 * Plan 89 §4.5, reproduced field for field; plan 90 §3.6, §4.1. `applied` is behavioural
 * requirement 1 — it reports what the agent actually managed to draw, not what was requested, so
 * an OEM skin that swallows the lock-screen half produces `['home']` and the core reports
 * `partial` rather than `applied`. `rendererVersion` is behavioural requirement 5: an integer the
 * agent owns, bumped whenever the drawing changes, so a stale render is detectable without
 * re-fetching the bitmap.
 */
export const LabelApplyResultSchema = z.object({
  applied: z.array(z.enum(['home', 'lock'])),
  fingerprint: z.string(),
  rendererVersion: z.number().int(),
  widthPx: z.number().int(),
  heightPx: z.number().int(),
  /** `WallpaperManager.getWallpaperId(FLAG_SYSTEM)` — `null` only if the platform call itself failed. */
  wallpaperIdHome: z.number().int().nullable(),
  wallpaperIdLock: z.number().int().nullable(),
})
export type LabelApplyResult = z.infer<typeof LabelApplyResultSchema>

/**
 * Plan 89 §4.5; plan 90 §3.6, §4.1. `originalCaptured` is behavioural requirement 3 — reported
 * honestly (never an optimistic `true`) when the agent could not read back the pre-label
 * wallpaper on its first apply (a live wallpaper, an API-level restriction, or a thrown
 * `getWallpaperFile`). `matchesOurs` lets a reconnect probe be a cheap read: the core compares it
 * against the fingerprint it expects before deciding whether `label.apply` needs to run at all.
 */
export const LabelStatusResultSchema = z.object({
  fingerprint: z.string().nullable(),
  matchesOurs: z.boolean(),
  wallpaperIdHome: z.number().int().nullable(),
  wallpaperIdLock: z.number().int().nullable(),
  originalCaptured: z.boolean(),
  rendererVersion: z.number().int(),
})
export type LabelStatusResult = z.infer<typeof LabelStatusResultSchema>

/**
 * Plan 89 §4.5; plan 90 §3.6, §4.1. `restored` is behavioural requirement 4 — `label.clear` is
 * idempotent and consults no "already cleared" flag, so this reports which of the two possible
 * writes actually ran on THIS call, not a cached memory of an earlier one. `fingerprint` is
 * always `null` on a successful clear — there is no label to match against any more.
 */
export const LabelClearResultSchema = z.object({
  restored: z.enum(['original', 'system-default']),
  fingerprint: z.null(),
})
export type LabelClearResult = z.infer<typeof LabelClearResultSchema>

/**
 * Plan 90 §3.2, §3.3, §4.1. `ime: 'not-current'` is deliberate, not an error — it is a
 * precondition the host can fix (`ime set`), and `resolveTextRoute` (§4.5) reads it to fall down
 * the text ladder rather than fail the call. `committed` counts code points actually committed,
 * which can be fewer than `text.length` in UTF-16 code units for anything outside the BMP.
 */
export const TextCommitResultSchema = z.object({
  committed: z.number().int(),
  ime: z.enum(['current', 'not-current']),
})
export type TextCommitResult = z.infer<typeof TextCommitResultSchema>

/** Plan 90 §3.2, §3.3, §4.1. `id` is the IME component name, e.g. `'dev.enkaku.guestagent/.input.EnkakuIme'` — a plain string, not a code, because it is shown to an operator verbatim (§3.9's "what the operator sees") rather than matched on. */
export const TextStatusResultSchema = z.object({
  ime: z.enum(['current', 'enabled', 'disabled']),
  id: z.string(),
  connected: z.boolean(),
  /** Plan 221 §4.6, MVP 08 §1.2. Absent on a build that predates the field; never assume `false`. */
  softKeyboardShown: z.boolean().optional(),
  showSoftKeyboardWithHardware: z.boolean().optional(),
})
export type TextStatusResult = z.infer<typeof TextStatusResultSchema>

/**
 * `upstream`, `stats`, and `lastError` are ABSENT from the frame when there
 * is nothing to report, not `null` — `ControlService.handle` builds this with
 * `org.json.JSONObject`, whose `put(key, value)` removes the key outright on
 * a `null` value rather than emitting a JSON `null`. Modelled as optional,
 * never nullable, so a captured frame like
 * `{"prepared":true,"up":false}` (route down) parses without a `.nullable()`
 * anywhere pretending a `null` could show up instead.
 */
export const RouteStatusResultSchema = z.object({
  prepared: z.boolean(),
  up: z.boolean(),
  /** Plan 54 §4.1, §5.3 — see `RouteLifecycleStateSchema`'s doc comment. */
  state: RouteLifecycleStateSchema.optional(),
  upstream: z.string().optional(),
  /** [txPackets, txBytes, rxPackets, rxBytes]. */
  stats: z.tuple([z.number().int(), z.number().int(), z.number().int(), z.number().int()]).optional(),
  /**
   * A plain message, not a coded error: the device has no error codes, it reports what went wrong
   * (`RouteState.lastError()` is a `String?` in Kotlin). Modelling it as `{code, message}` by
   * analogy with the host-side `NetworkStatus.lastError` made every status frame carrying an error
   * fail validation — and it went unnoticed because the captured frames the schema was written
   * against had never errored, so no test covered it.
   */
  lastError: z.string().optional(),
  /**
   * Plan 51 §4.5, §5.7 — asserts IPv6 is actually blocked rather than the host assuming a
   * `Builder.addRoute("::", 0)` call that returned a non-null descriptor did exactly what was
   * asked (`Ipv6Leak.isBlocked()` on the Kotlin side reads back `LinkProperties` rather than
   * trusting the request). Absent on an older agent build that predates the check, and whenever
   * `ConnectivityManager` cannot currently find the VPN network to ask (nothing established yet)
   * — both map to the `leak` check reading `skip`/`unknown` rather than a guessed answer, never a
   * silent `pass`.
   */
  ipv6Blocked: z.boolean().optional(),
})
export type RouteStatusResult = z.infer<typeof RouteStatusResultSchema>

/**
 * One measurement leg of an egress probe (plan 51 §4.2). `stage` says WHERE a failed leg died —
 * `'connect'` covers the TCP/TLS connect and, for the tunnelled leg, the SOCKS5 handshake itself;
 * `'fetch'` covers the HTTP request/response to the probe target once a connection exists. This is
 * what lets the host-side engine tell "could not reach or authenticate with the SOCKS5 upstream"
 * (an `upstream` check failure) apart from "reached the upstream fine but the probe target itself
 * did not answer" (an `egress` check failure) without parsing `error` text. Absent on a successful
 * leg. `error` and every other field here must never carry a credential — nothing in this shape is
 * built from the upstream's username/password on the Kotlin side (`EgressProbe.kt`).
 */
export const EgressProbeLegSchema = z.object({
  ok: z.boolean(),
  status: z.number().int().optional(),
  /** Truncated to a few KB on the device side — never assume this is the whole body. */
  body: z.string().optional(),
  ms: z.number().int(),
  error: z.string().optional(),
  stage: z.enum(['connect', 'fetch']).optional(),
})
export type EgressProbeLeg = z.infer<typeof EgressProbeLegSchema>

/**
 * `tunnelled` is measured by proxying through the route's own configured SOCKS5 upstream — the
 * app's own uid is excluded from its own TUN (`RouteVpnService.start()`'s
 * `addDisallowedApplication`), so a plain socket from this process can never be captured by the
 * tunnel to prove anything about it; `direct` uses `RouteVpnService.protectOutbound()` so it
 * leaves on the underlying network. Comparing the two in one call is what proves the tunnel is
 * actually carrying traffic rather than the device merely having internet some other way (plan 51
 * §3.2, §4.2).
 */
export const EgressProbeResultSchema = z.object({
  tunnelled: EgressProbeLegSchema,
  direct: EgressProbeLegSchema,
})
export type EgressProbeResult = z.infer<typeof EgressProbeResultSchema>

// ---- response envelope (agent -> host) ----

/** `{ id?, ok: true, result }` — `id` is absent when the request line itself failed to parse (`handle`'s catch path had no `id` to echo back). */
export const GuestAgentOkResponseSchema = z.object({
  id: z.string().optional(),
  ok: z.literal(true),
  result: z.union([
    HelloResultSchema,
    PingResultSchema,
    RouteStartResultSchema,
    RouteStopResultSchema,
    RouteStatusResultSchema,
    EgressProbeResultSchema,
    RouteHoldResultSchema,
    LocationSetResultSchema,
    LocationClearResultSchema,
    LabelApplyResultSchema,
    LabelStatusResultSchema,
    LabelClearResultSchema,
    TextCommitResultSchema,
    TextStatusResultSchema,
    UiDumpResultSchema,
    UiFindResultSchema,
    UiWatchResultSchema,
    UiUnwatchResultSchema,
    UiStatusResultSchema,
    ActivitySetResultSchema,
    DeviceDescribeResultSchema,
    TextPrefsResultSchema,
  ]),
})
export type GuestAgentOkResponse = z.infer<typeof GuestAgentOkResponseSchema>

/** `{ id?, ok: false, error: { code, message } }`. */
export const GuestAgentErrorResponseSchema = z.object({
  id: z.string().optional(),
  ok: z.literal(false),
  error: z.object({
    code: GuestAgentErrorCodeSchema,
    message: z.string(),
  }),
})
export type GuestAgentErrorResponse = z.infer<typeof GuestAgentErrorResponseSchema>

/**
 * The full response envelope, discriminated on `ok` so a caller narrows with
 * a plain `if (response.ok)` and gets `result` or `error` typed accordingly
 * — no separate type guard needed.
 */
export const GuestAgentResponseSchema = z.discriminatedUnion('ok', [
  GuestAgentOkResponseSchema,
  GuestAgentErrorResponseSchema,
])
export type GuestAgentResponse = z.infer<typeof GuestAgentResponseSchema>
