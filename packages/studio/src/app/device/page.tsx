'use client'

import { Suspense, useEffect, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { toast } from 'sonner'
import {
  DeviceDetailResponseSchema,
  DeviceLabelStateSchema,
  DeviceResponseSchema,
  DeviceViewersResponseSchema,
  JobsPageResponseSchema,
  PluginDevSlotsResponseSchema,
  ReconnectOutcomeSchema,
  ScriptListItemSchema,
  SettingsResponseSchema,
  type BatteryState,
  type DeviceLabelState,
  type DeviceStatus,
  type FarmSettings,
  type JobInfo,
  type RegistryResponse,
  type ShellMode,
  type Viewer,
} from '@enkaku/protocol'
import { DeviceLog } from '@/components/DeviceLog'
import { DisconnectDeviceDialog } from '@/components/DisconnectDeviceDialog'
import { CutoverDialog } from '@/components/device/CutoverDialog'
import { CrashesPanel } from '@/components/CrashesPanel'
import { MonitorPane } from '@/components/monitor/MonitorPane'
import { TerminalPane } from '@/components/terminal/TerminalPane'
import { AdbEndpointCard } from '@/components/terminal/AdbEndpointCard'
import { FilesPanel } from '@/components/FilesPanel'
import { AgentPanel } from '@/components/guest-agent/AgentPanel'
import { NetworkPanel } from '@/components/guest-agent/NetworkPanel'
import { IdentityPanel } from '@/components/identity/IdentityPanel'
import { KvPanel } from '@/components/kv/KvPanel'
import { DeviceHeader, type DeviceDetailInfo } from '@/components/device/DeviceHeader'
import { DeviceNumberField } from '@/components/device/DeviceNumberField'
import { PhysicalLabellingPanel } from '@/components/device/PhysicalLabellingPanel'
import { RotationQuickAction } from '@/components/device/RotationQuickAction'
import { ScreenCard, type ScreenMode } from '@/components/device/ScreenCard'
import { EntityTabs } from '@/components/layout/EntityTabs'
import { JobStatusBadge } from '@/components/StatusBadge'
import { TagEditor } from '@/components/TagEditor'
import { RunScriptDialog, type ScriptRow } from '@/components/RunScriptDialog'
import { ForgetDeviceDialog } from '@/components/ForgetDeviceDialog'
import { JobsList } from '@/components/JobsList'
import { PaginatedTable, type PaginatedTableHandle } from '@/components/PaginatedTable'
import { TableCell, TableHead, Button, formatDeviceName, relativeTime, duration, ErrorState, LoadingRows, api, useAction } from '@enkaku/ui'
import { isAdmin, useAuth } from '@/lib/auth'
import { useNow } from '@/lib/useNow'
import { applyActivityEvent, hasJob } from '@/lib/activity'
import { fetchRegistry } from '@/components/schema-form/useEnumSource'
import { SchemaForm } from '@/components/schema-form/SchemaForm'
import { narrowSchema } from '@/components/schema-form/narrowSchema'
import type { JsonSchemaNode } from '@/components/schema-form/types'
import { SectionNav, type SettingsSection } from '@/components/settings/SectionNav'
import { deviceSections } from '@/components/settings/deviceSections'
import { DeviceVideoFields } from '@/components/video/DeviceVideoFields'
import { fetchAllPages, fetchDeviceRefs, fetchGuestAgentStatus, type DeviceRef } from '@/lib/api'
import { ws } from '@/lib/ws'
import { runOnDevice } from '@/lib/actions'

function DeviceDetail() {
  // A query param rather than a dynamic route, because a static export cannot
  // pre-render dynamic ids — see the studio README.
  const params = useSearchParams()
  const router = useRouter()
  // `device.quarantine` is admin-only (`packages/core/src/auth/acl.ts`), the
  // same gate the fleet card applies to its own "Return to queue".
  const { user } = useAuth()
  const deviceId = params.get('id')
  // `Inspect` stopped being a tab (plan 57 §3.1) and became a mode of the
  // screen card. Links printed before that — a bookmark, a chat message —
  // still say `tab=inspect`, so they land on Control with that mode selected
  // rather than on a page with no active panel at all.
  const requestedTab = params.get('tab') ?? 'control'
  const tab = requestedTab === 'inspect' ? 'control' : requestedTab
  const [mode, setMode] = useState<ScreenMode>(requestedTab === 'inspect' ? 'inspect' : 'live')
  // The Settings tab's active sub-section (plan 46 §3.4, §4.3) — an
  // unknown or absent value falls back to the first section, resolved
  // below once the schema (and therefore the section list) has loaded.
  const section = params.get('section')
  const [device, setDevice] = useState<DeviceDetailInfo | null>(null)
  const [registry, setRegistry] = useState<RegistryResponse | null>(null)
  const [status, setStatus] = useState<DeviceStatus | null>(null)
  // Plan 73 §3.5, §4.6 — "Ask an agent" dialog visibility, lifted to the
  // caller: `DeviceHeader` keeps no hooks of its own.
  const [askAgentOpen, setAskAgentOpen] = useState(false)
  // Presence (plan 31): who is watching this device.
  const [viewers, setViewers] = useState<Viewer[]>([])
  const [mySessionId, setMySessionId] = useState<string | null>(() => ws.getSessionId())
  const [hoveredSessionId, setHoveredSessionId] = useState<string | null>(null)
  const [battery, setBattery] = useState<BatteryState | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // A `device.activity.warning` broadcast (plan 205 §4.9, MVP 04 §3) — a
  // concurrent-activity heads-up, shown for 5s then cleared, never a refusal.
  const [warning, setWarning] = useState<string | null>(null)
  const warningTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [error, setError] = useState<string | null>(null)
  // A link into this page can outlive the device it points at (plan 47 §3.4)
  // — resolved only when the device fetch itself fails, so the common case
  // pays nothing extra.
  const [deletedRef, setDeletedRef] = useState<DeviceRef | null>(null)
  const [jobsCount, setJobsCount] = useState<number | null>(null)
  const jobsRef = useRef<PaginatedTableHandle<JobInfo>>(null)
  const [scripts, setScripts] = useState<ScriptRow[]>([])
  const [runOpen, setRunOpen] = useState(false)
  // Removal (plan 47 §4.5) — the smallest additive hook into this page: a
  // single dialog, no new tab, no restructuring of what is already here.
  const [forgetOpen, setForgetOpen] = useState(false)
  // Per-device disconnect (plan 88 §3.7, §3.8, §4.6, §5 step 88.4) — same
  // "lift the dialog's open state, keep DeviceHeader hook-free" shape as
  // `forgetOpen` above. Reconnect has no dialog of its own (§3.8: it is not
  // destructive) — it fires directly from the menu.
  const [disconnectOpen, setDisconnectOpen] = useState(false)
  // The USB → network cutover wizard (plan 88 §3.4, §4.6, §5 step 88.5) —
  // same lifted-open-state shape as `disconnectOpen` above.
  const [cutoverOpen, setCutoverOpen] = useState(false)
  const [schema, setSchema] = useState<JsonSchemaNode | null>(null)
  // The terminal tab is hidden entirely when the farm switches it off (plan
  // 26 §5, step 26.1) — defaults to 'admin' (the loopback default) until the
  // real value loads, so the tab does not flash in and then disappear on a
  // typical single-user install.
  const [shellMode, setShellMode] = useState<ShellMode>('admin')
  // The adb endpoint card (plan 27 §4.4) is a separate opt-in from the
  // terminal — defaults to false (the feature's own safe default) until the
  // real value loads, so a farm that never enabled it never sees a flash.
  const [endpointEnabled, setEndpointEnabled] = useState(false)
  // The Files tab (plan 39 §4.7) — hidden entirely when the farm turns off
  // `transfer.enabled`, the same "hide, don't merely disable" treatment the
  // terminal tab gets from `shellMode: 'off'` above.
  const [transferEnabled, setTransferEnabled] = useState(true)
  const [savedSettings, setSavedSettings] = useState<unknown>(undefined)
  const [draftSettings, setDraftSettings] = useState<unknown>(undefined)
  // The EFFECTIVE inspector engine (plan 34 §4.6): `device.inspection` below
  // is only the configured choice — `createInspectorForSession` (session
  // package) falls back to `uiautomator-dump` per session when `ui-server`
  // cannot start, and until this plan nothing told the operator that had
  // happened. `null` means "no fallback reported for the current session" —
  // the configured engine is presumed to be the one actually running.
  const [inspectorFallback, setInspectorFallback] = useState<{ to: string; reason: string } | null>(null)
  // The guest agent's `appVersion` (plan 90 §5 step 90.6, fixes F11) —
  // `DeviceHeader` keeps no hooks of its own, so this is fetched here and
  // handed down as a prop, the same shape every other looked-up fact on
  // that component already follows. `null` while loading or unknown — a
  // failed fetch (agent never provisioned) is tolerated silently, same as
  // `fetchRegistry`/dev-slot scripts below.
  const [agentVersion, setAgentVersion] = useState<string | null>(null)
  // Physical labelling's applied state (plan 89 §3.5, §4.3, §5 step 89.8) —
  // fetched once here (not inside `DeviceHeader`, which keeps no hooks of
  // its own — same rule `agentVersion` above follows) and shared with
  // `PhysicalLabellingPanel` on the Settings tab, so the header badge and
  // the panel's own status row can never disagree about what was last
  // checked. `null` until the first `GET .../label` resolves.
  const [labelState, setLabelState] = useState<DeviceLabelState | null>(null)
  const { run, isPending } = useAction()
  // The jobs tab ticks without a refresh (Plan 17 §4.6).
  const now = useNow()
  // The farm's own video settings (plan 92 §3.9, §5 step 92.8) — read from
  // the SAME `/api/settings` fetch `shellMode`/`transferEnabled` above
  // already use, not a second request: `DeviceVideoFields`' effective-profile
  // readout needs it to name "the farm" as the source for any empty field
  // (this step's own acceptance criterion 3). `null` until that fetch
  // resolves, or if it fails — the readout shows a loading/neutral state
  // rather than guessing.
  const [farmVideo, setFarmVideo] = useState<FarmSettings['video'] | null>(null)
  /** The battery readings the core has pushed since load, else the first fetch. */
  const liveBattery = battery ?? device?.battery ?? null

  useEffect(() => {
    if (!deviceId) return
    void api(`/api/devices/${deviceId}`, DeviceDetailResponseSchema)
      .then((b) => {
        setDevice(b.device)
        setStatus(b.device.status)
        setSavedSettings(b.device.settings ?? undefined)
        setDraftSettings(b.device.settings ?? undefined)
        // A fresh load has no session-scoped fallback to report yet.
        setInspectorFallback(null)
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : String(e))
        // Tolerate a missing device rather than leaving a bare error (plan
        // 47 §3.4): if it was forgotten, `deletedDevices` still has a label.
        void fetchDeviceRefs([deviceId])
          .then((refs) => setDeletedRef(refs[deviceId]?.deleted ? refs[deviceId]! : null))
          .catch(() => undefined)
      })
    void fetchRegistry().then(setRegistry)
    // Plan 90 §5 step 90.6, fixes F11 — `GET .../guest-agent` already
    // returned `appVersion`; nothing rendered it. A fetch failure (agent
    // never provisioned, or the device is offline) leaves it `null`, read
    // as "unknown" by `DeviceHeader`'s popover, never a thrown error on
    // this page.
    setAgentVersion(null)
    void fetchGuestAgentStatus(deviceId)
      .then((s) => setAgentVersion(s.appVersion ?? null))
      .catch(() => setAgentVersion(null))
    // Physical labelling's applied state (plan 89 §5 step 89.8) — a fetch
    // failure (labelling not available on this host, or the device is
    // offline and nothing was ever cached) leaves it `null`, read as "not
    // yet checked" by `LabelStateBadge` and `PhysicalLabellingPanel`, never
    // a thrown page error.
    setLabelState(null)
    void api(`/api/devices/${deviceId}/label`, DeviceLabelStateSchema)
      .then(setLabelState)
      .catch(() => undefined)
    // The very same schema the farm defaults are rendered from, so a field can
    // never exist in one place and be missing in the other.
    void api('/api/settings', SettingsResponseSchema)
      .then((b) => {
        // `SettingsResponseSchema.deviceSchema` already parsed through
        // `JsonSchemaNodeSchema` (`z.record(z.string(), z.unknown())` — a
        // deliberately permissive placeholder for a recursive JSON Schema
        // node, per its own comment in `@enkaku/protocol`). This studio-local
        // `JsonSchemaNode` is the SAME permissive shape, independently typed
        // for the form renderer's own narrowing — the cast below reconciles
        // two parallel type definitions of already-validated data, not a
        // bypass of validation.
        setSchema(b.deviceSchema as JsonSchemaNode)
        setShellMode(b.settings.shell.mode)
        setEndpointEnabled(b.settings.shell.endpointEnabled)
        setTransferEnabled(b.settings.transfer.enabled)
        setFarmVideo(b.settings.video)
      })
      .catch(() => undefined)
    // `ScriptListItemSchema` (plan 95 §5 step 95.5, fixes F8): a
    // `paramsSchema` here is author-controlled input (F7) — this used to
    // reach the page through a bare `as` cast with nothing checking its
    // shape at all.
    void fetchAllPages('/api/scripts', undefined, ScriptListItemSchema)
      .then((scripts) => setScripts((scripts as ScriptRow[]).filter((x) => x.enabled)))
      .catch(() => setScripts([]))
    // Dev-slot scripts (plan 82 §3.5) are never rows in `/api/scripts` —
    // that is the whole point of a dev slot not surviving a restart — so
    // they are merged in from `GET /api/plugins/dev` here, marked
    // `isDev: true` (RunScriptDialog renders a DEV badge for them, plan 82
    // §4.6 step 13). A dev script may be run manually (plan 82 §3.5's own
    // "ad-hoc run" carve-out) — its `id` is already the registry's
    // `dev:<plugin>/<export>` form, which `POST /api/jobs` accepts as an
    // ordinary `scriptId`, same as any published one.
    void api('/api/plugins/dev', PluginDevSlotsResponseSchema)
      .then((b) => {
        const devRows: ScriptRow[] = b.items.flatMap((slot) =>
          slot.scripts.map((s) => ({
            id: `dev:${slot.pluginName}/${s.exportId}`,
            name: `${slot.pluginName}/${s.exportId}`,
            version: slot.buildVersion,
            paramsSchema: (s.paramsSchema ?? null) as JsonSchemaNode | null,
            enabled: true,
            createdAt: null,
            pluginName: slot.pluginName,
            isDev: true,
          })),
        )
        if (devRows.length > 0) setScripts((prev) => [...prev, ...devRows])
      })
      .catch(() => undefined)
    // The presence snapshot (plan 31 §3.4): `/ws` has no replay, so the
    // current viewer list is fetched once here and kept live by
    // `device.viewers` below.
    void api(`/api/devices/${deviceId}/viewers`, DeviceViewersResponseSchema)
      .then((b) => setViewers(b.viewers))
      .catch(() => undefined)

    const off = ws.on((msg) => {
      if (msg.type === 'hello') {
        setMySessionId(msg.payload.sessionId)
      } else if (msg.type === 'device.viewers' && msg.payload.deviceId === deviceId) {
        setViewers(msg.payload.viewers)
      } else if (msg.type === 'device.status' && msg.payload.id === deviceId) {
        setStatus(msg.payload.status)
      } else if (msg.type === 'device.activity' && msg.payload.deviceId === deviceId) {
        // What is happening to this device (plan 205 §4.11) — a control
        // marker starting/ending, a job claiming/releasing it, and
        // everything else the activity registry tracks, all through this
        // ONE broadcast. Replaces the four separate per-holder/secondary-
        // operator live-patch messages this used to need, and the per-client
        // "was I the one who lost it" tracking those needed — under the
        // activity model any operator may act on an online device
        // immediately, so there is no per-client hold left to lose.
        setDevice((d) => (d ? applyActivityEvent(d, msg.payload) : d))
      } else if (msg.type === 'device.activity.warning' && msg.payload.deviceId === deviceId) {
        // Unicast to the client whose input was accepted with `warn` (MVP 04
        // §3, at most one per device per minute per connection) — a
        // concurrent-activity heads-up, never a refusal. Shown for 5s, the
        // same one-line, non-blocking treatment `ScreenCard`'s own `warning`
        // prop renders it with.
        setWarning(msg.payload.message)
        if (warningTimerRef.current) clearTimeout(warningTimerRef.current)
        warningTimerRef.current = setTimeout(() => setWarning(null), 5_000)
      } else if (msg.type === 'device.battery' && msg.payload.deviceId === deviceId) {
        // The panel used to show whatever the first fetch returned; a device
        // that heats up or drains while you watch it looked frozen.
        setBattery(msg.payload.battery)
      } else if (msg.type === 'device.inspector.fallback' && msg.payload.deviceId === deviceId) {
        // The effective engine for the CURRENT session dropped to the
        // fallback (plan 34 §4.6) — reported until the next session start.
        setInspectorFallback({ to: msg.payload.to, reason: msg.payload.reason })
      } else if (
        msg.type === 'device.inspector.status' &&
        msg.payload.deviceId === deviceId &&
        msg.payload.state === 'starting'
      ) {
        // A new session is negotiating its inspector from scratch — any
        // fallback reported for the previous session no longer applies.
        setInspectorFallback(null)
      }
    })
    return off
  }, [deviceId])

  useEffect(() => () => {
    if (warningTimerRef.current) clearTimeout(warningTimerRef.current)
  }, [])

  const saveSettings = () =>
    // Not one of the call sites the plan named for this file — found while
    // migrating: `PATCH /:id` returns `{ device }` (plain `DeviceInfo`, not
    // the detail shape — `packages/core/src/api/devices.ts`), so
    // `DeviceResponseSchema` is the match, even though the result here is
    // discarded (the draft is trusted locally on success).
    run(
      'settings',
      () => api(`/api/devices/${deviceId}`, DeviceResponseSchema, { method: 'PATCH', json: { settings: draftSettings } }),
      {
        success: 'Device settings saved',
        failure: 'Could not save the device settings',
        onSuccess: () => setSavedSettings(draftSettings),
      },
    )

  // Re-fetches the whole device (plan 88 §5 step 88.4) — a disconnect or a
  // reconnect changes `connection`/`serial`, which `device.status`'s WS
  // broadcast above (`msg.payload.status`) does not carry.
  const reloadDevice = () =>
    void api(`/api/devices/${deviceId}`, DeviceDetailResponseSchema)
      .then((b) => {
        setDevice(b.device)
        setStatus(b.device.status)
      })
      .catch(() => undefined)

  /**
   * Return this device to the queue (field report, 2026-08-26). Thermal
   * quarantine never lifts on its own — `device/health.ts` releases only
   * reasons prefixed `adb:`, deliberately, so a phone that has cooled back
   * to 32 °C stays out of the pool until a human says otherwise. Until this
   * landed, the only place that "human says otherwise" existed was the fleet
   * card in List view; the device's OWN page had no way at all.
   */
  const releaseQuarantine = () =>
    deviceId &&
    run('unquarantine', () => runOnDevice('unquarantine', deviceId, {}), {
      success: 'Back in the queue',
      failure: 'Could not return the device to the queue',
      onSuccess: () => reloadDevice(),
    })

  /** Dials this device's last known address (plan 88 §3.3, §4.4, §4.6) — no confirmation, it is not destructive. */
  const reconnectDevice = () =>
    deviceId &&
    run(
      'reconnect',
      async () => ReconnectOutcomeSchema.parse((await runOnDevice('reconnect', deviceId, {})).detail),
      {
        failure: 'Could not reconnect the device',
        onSuccess: (outcome) => {
          // Plan 124 §4.4 Group D, step 124.4 — `#7 Galaxy A15`, not
          // `Galaxy A15`. All four toasts below read the SAME `label`, so
          // composing once here is what keeps them from disagreeing the way
          // `AdmitDeviceDialog`'s two ternary halves did (§0.1). `device` can
          // still be null on the very first reconnect after a cold load,
          // which is what the 'The device' fallback is for — and it is a
          // sentence, not a name, so it never gets a number.
          const label = device ? formatDeviceName(device.number, device.label) : 'The device'
          if (outcome.result === 'already-connected') toast.success(`${label} is already connected`)
          else if (outcome.result === 'connected') toast.success(`${label} reconnected from ${outcome.address}`)
          else if (outcome.result === 'not-found') toast.error(`Could not find ${label} on the network`, { description: 'It did not answer at any remembered address.' })
          else toast.error(`Could not reconnect ${label}`, { description: outcome.detail })
          reloadDevice()
        },
      },
    )

  if (!deviceId) {
    return (
      <div className="px-5 py-4">
        <ErrorState message="The address is missing an id parameter." />
      </div>
    )
  }
  if (error && !device) {
    // A forgotten device (plan 47 §3.4) — never a blank or a crash, and
    // never an ErrorState's "try again" for something retrying cannot fix.
    if (deletedRef) {
      return (
        <div className="px-5 py-4">
          <ErrorState
            message={`This device was removed from the farm — deleted device (${deletedRef.stableId}). Its jobs, artifacts, and events are kept.`}
          />
        </div>
      )
    }
    return (
      <div className="px-5 py-4">
        <ErrorState message={error} />
      </div>
    )
  }
  if (!device) {
    return (
      <div className="px-5 py-4">
        <LoadingRows rows={2} />
      </div>
    )
  }

  const currentStatus = status ?? device.status
  // Plan 205 §4.9 — the one precondition every control surface on this page
  // checks now: a device is either online or it is not. Replaces
  // `online`/`iAmAssisting`.
  const online = currentStatus === 'online'
  const busy = hasJob(device)
  const inputEnabled = online
  // A node-owned device has no local inspector to attach to, so it can never
  // be in `Inspect` — not even by way of an old `tab=inspect` link.
  const screenMode: ScreenMode = device.nodeId ? 'live' : mode

  // The Settings tab's vertical sub-sections (plan 46 §3.3, §4.2): derived
  // from `DeviceSettingsSchema`'s own top-level keys via `deviceSections`,
  // not a hand-maintained list, so a setting can never be added to the
  // schema and quietly appear nowhere. Each section renders the SAME
  // schema-driven form, submit path, and dirty/saved state as before —
  // only the visible slice of `schema` differs (`narrowSchema`).
  const settingsSections: SettingsSection[] = schema
    ? deviceSections(schema).map((s) => ({
        id: s.id,
        title: s.title,
        render: () =>
          s.id === 'video' ? (
            // Plan 92 §5 step 92.8, acceptance criterion 3 — still entirely
            // `SchemaForm`-rendered (spec §19); `DeviceVideoFields` only adds
            // the Advanced disclosure and the effective-profile readout
            // AROUND those fields, the same pattern `FarmVideoFields` uses
            // on the farm Settings page.
            <DeviceVideoFields
              schema={narrowSchema(schema, s.keys)}
              draft={draftSettings as Record<string, unknown>}
              onChange={setDraftSettings}
              onSubmit={saveSettings}
              onReset={() => setDraftSettings(savedSettings)}
              busy={isPending('settings')}
              dirty={JSON.stringify(draftSettings) !== JSON.stringify(savedSettings)}
              farmVideo={farmVideo}
            />
          ) : s.id === 'physical-labelling' ? (
            // Plan 89 §3.4, §3.5, §3.6, §3.8, §5 step 89.8 — the same
            // schema-plus-extra shape `DeviceVideoFields` uses above:
            // `mode`/`showName` are still entirely `SchemaForm`-rendered
            // (spec §19); this component only adds the content preview, the
            // live applied-state badge, and the `Re-apply`/`Clear` actions a
            // schema cannot describe.
            <PhysicalLabellingPanel
              device={{ id: device.id, label: device.label, number: device.number ?? null, screenW: device.screenW, screenH: device.screenH }}
              schema={narrowSchema(schema, s.keys)}
              draft={draftSettings as Record<string, unknown>}
              onChange={setDraftSettings}
              onSubmit={saveSettings}
              onReset={() => setDraftSettings(savedSettings)}
              busy={isPending('settings')}
              dirty={JSON.stringify(draftSettings) !== JSON.stringify(savedSettings)}
              labelState={labelState}
              onLabelStateChange={setLabelState}
            />
          ) : (
            <>
              {/* Plan 89 §5 step 89.3 — hand-authored, not schema-driven:
                  `number` lives in `device_numbers`, keyed by `stableId`,
                  never on `DeviceSettingsSchema` (§4.1), so it can never be
                  one of `s.keys` below. `general` is always present
                  (`deviceSections`'s own guarantee), which is why it lives
                  here rather than needing a section of its own. */}
              {s.id === 'general' && (
                <DeviceNumberField
                  device={device}
                  onSaved={(patch) => setDevice((d) => (d ? { ...d, ...patch } : d))}
                />
              )}
              {/* Plan 94 §3.6, §4.10, step 94.10 — the cross-reference this
                  step's brief asked for: this panel is layer 1 (sub-second,
                  INSIDE one action, applies to everything this device does)
                  and never the run form's own pacing (layer 2/3 — the gap
                  BETWEEN actions/repetitions and the fleet stagger, which
                  apply only to one run and live on the run form, not here).
                  The two are separate settings, deliberately never shown on
                  the same screen (§3.6: "No screen shows both") — this is a
                  pointer, not a duplication. */}
              {s.id === 'timing' && (
                <p className="mb-3 rounded-lg border bg-surface-2/40 px-3 py-2 text-[11.5px] leading-relaxed text-fg-muted">
                  This is how THIS device performs one action — hold duration, coordinate jitter, typing cadence — and
                  it applies to everything this device runs. Repeat pacing (how many times a run repeats, and how
                  long to wait between repetitions or across a fleet) is a property of the RUN, not the device — set
                  it in the run form's Repeat section instead.
                </p>
              )}
              <SchemaForm
                schema={narrowSchema(schema, s.keys)}
                value={draftSettings}
                onChange={setDraftSettings}
                onSubmit={saveSettings}
                onReset={() => setDraftSettings(savedSettings)}
                busy={isPending('settings')}
                dirty={JSON.stringify(draftSettings) !== JSON.stringify(savedSettings)}
              />
            </>
          ),
      }))
    : []

  return (
    <>
      {/* Everything the right column used to hold, placed by how it is used
          (plan 57 §3.3): battery and temperature inline, viewers as a count,
          the static facts and the engines behind `ⓘ`, and `Remove device`
          behind `⋮` — not sitting in the toolbar with the same weight as
          `Run a script` (§3.6). `All devices` is gone: the sidebar's Devices
          entry already goes there. */}
      <DeviceHeader
        device={device}
        status={currentStatus}
        battery={liveBattery}
        registry={registry}
        inspectorFallback={inspectorFallback}
        viewers={viewers}
        mySessionId={mySessionId}
        hoveredSessionId={hoveredSessionId}
        onHoverSession={setHoveredSessionId}
        now={now}
        canRunScript={scripts.length > 0}
        // The dialog picks the script now. This used to hand it `scripts[0]` —
        // whichever the API happened to sort first — so every other published
        // script was unreachable from a device's own page, and the version
        // moved on its own whenever anything was republished.
        onRunScript={() => setRunOpen(true)}
        onDisconnect={() => setDisconnectOpen(true)}
        onReconnect={reconnectDevice}
        onReleaseQuarantine={() => void releaseQuarantine()}
        canReleaseQuarantine={isAdmin(user)}
        onOpenCutover={() => setCutoverOpen(true)}
        onRemove={() => setForgetOpen(true)}
        askAgentOpen={askAgentOpen}
        onAskAgentOpenChange={setAskAgentOpen}
        agentVersion={agentVersion}
        labelState={labelState}
      />

      <EntityTabs
        active={tab}
        tabs={[
          { key: 'control', label: 'Control' },
          { key: 'jobs', label: 'Jobs', count: jobsCount },
          { key: 'monitor', label: 'Monitor' },
          { key: 'crashes', label: 'Crashes' },
          // Hidden entirely when the farm switches the terminal off (plan 26
          // §5, 26.1) — server-authoritative either way: even a forced
          // `tab=terminal` in the address bar still gets refused by the WS
          // handler, this is purely so the tab is not a dead end to click.
          ...(shellMode === 'off' ? [] : [{ key: 'terminal', label: 'Terminal' }]),
          ...(transferEnabled ? [{ key: 'files', label: 'Files' }] : []),
          { key: 'network', label: 'Network' },
          // Plan 90 §5 step 90.6 — the agent's own lifecycle (install/update/
          // retry/remove, version, capabilities) moved out of Network and
          // into its own tab (§3.8: it is a device property, not a route
          // concern).
          { key: 'agent', label: 'Agent' },
          { key: 'identity', label: 'Identity' },
          { key: 'logs', label: 'Logs' },
          // Plan 79 §5.9 — device-scoped ctx.kv values a script wrote for THIS device.
          { key: 'storage', label: 'Storage' },
          { key: 'settings', label: 'Settings' },
        ]}
        hrefFor={(k) => `/device?id=${encodeURIComponent(device.id)}${k === 'control' ? '' : `&tab=${k}`}`}
      />

      {notice && (
        <div className="mx-5 mt-4 rounded-lg border border-led-warn/35 bg-led-warn/5 px-3.5 py-2.5 text-[12.5px] text-led-warn">
          {notice}
        </div>
      )}
      {error && (
        <div className="mx-5 mt-4 rounded-lg border border-led-danger/40 bg-led-danger/5 px-3.5 py-2.5 text-[12.5px] text-led-danger">
          {error}
        </div>
      )}

      <TabPanel active={tab === 'control'}>
        <div className="px-5 py-4">
          {/* The Control tab is the screen and its controls, and nothing that
              repeats them (plan 57 §3.2): the status banner that used to sit
              here said "Take control before sending input" one screen region
              away from the video footer's own "Input is off — watching only."
              Only the job-running state carried something nothing else said,
              and it is a badge on the card now. */}
          <div className="mb-3 flex justify-end">
            {/* Rotation quick-action (plan 85 §3.7, §4.1, step 85.8): a
                shortcut to `settings.prep.rotation`, the same field the
                Settings tab's schema-driven form already exposes under
                "Power & readiness" — this just saves the trip there for the
                common case of locking or unlocking orientation. */}
            <RotationQuickAction
              deviceId={device.id}
              settings={device.settings}
              onSaved={(nextSettings) => {
                setDevice((d) => (d ? { ...d, settings: nextSettings } : d))
                // Only fast-forward the Settings tab's draft if it had no
                // unsaved edit of its own — this quick action must not
                // silently discard something the operator was mid-typing
                // there.
                const wasDirty = JSON.stringify(draftSettings) !== JSON.stringify(savedSettings)
                setSavedSettings(nextSettings)
                if (!wasDirty) setDraftSettings(nextSettings)
              }}
            />
          </div>
          <ScreenCard
            deviceId={device.id}
            mode={screenMode}
            onModeChange={setMode}
            // Node-owned (cloud) devices have no local Inspector to attach to
            // (plan 56 §2 non-goals) — disabled with a stated reason rather
            // than a dead end (design.md's quality floor).
            {...(device.nodeId ? { inspectDisabledReason: 'Inspecting a node-owned device is not available yet.' } : {})}
            // Plan 94 §5 step 94.3's own `ws-handlers.ts` refusal
            // (`recording is not available for cloud (node-owned) devices
            // yet`) — named here rather than left for the operator to
            // discover only as a WS error after pressing Start.
            {...(device.nodeId ? { recordDisabledReason: 'Recording is not available for cloud (node-owned) devices yet.' } : {})}
            jobRunning={busy}
            inputEnabled={inputEnabled}
            // The same server-published fact every other panel on this page
            // reads (plan 31 §4.3; plan 205 §4.9) — the inspector needs the
            // device to be online, and the core checks it on every message
            // regardless. This only decides what the panel says (plan 59 §3.1)
            // and whether it holds an engine (§3.3).
            canInspect={online}
            autoReconnect={Boolean((device.settings as { autoReconnect?: boolean } | null)?.autoReconnect)}
            configuredDisplay={device.display}
            visible={tab === 'control'}
            warning={warning}
          />
        </div>
      </TabPanel>

      <TabPanel active={tab === 'jobs'}>
        <div className="px-5 py-4">
          {/* The shared jobs table (audit finding 1). No device column: this
              page IS one device, and repeating it in every row is noise. */}
          <JobsList
            handleRef={jobsRef}
            filter={{ deviceId }}
            columns={{ script: true, time: 'started' }}
            onTotal={setJobsCount}
            empty={{
              title: 'No jobs on this device',
              description: 'Run a script against it from the Scripts page, or with the Run button on its card.',
            }}
          />
        </div>
      </TabPanel>

      {/* Monitor and Crashes stay mount-on-demand, deliberately NOT wrapped in
          TabPanel (Plan 42 §3.1, §4.1): each holds a device-side `logcat`
          stream (Plan 24's MonitorHub / the crash watcher's own subscription
          reuses it), and keeping either alive for a tab nobody is looking at
          would leave a process running on a real phone. Their own cleanup
          effects already stop the stream on unmount — that behaviour is
          unchanged, only Control and the cheap panels below gained the
          keep-mounted treatment. */}
      {tab === 'monitor' && <MonitorPane deviceId={device.id} />}

      {tab === 'crashes' && <CrashesPanel deviceId={device.id} />}

      {shellMode !== 'off' && (
        <TabPanel active={tab === 'terminal'}>
          <div className="px-5 pt-4">
            {endpointEnabled && (
              <AdbEndpointCard
                deviceId={device.id}
                clientId={mySessionId}
                // Same gate as the terminal's own input box (plan 27 §3.4) —
                // Studio hiding the card is a convenience, the server checks
                // `device.adb` and admission itself on every request.
                canOpen={online}
              />
            )}
          </div>
          <TerminalPane
            deviceId={device.id}
            // The SAME server-published fact the Control tab's button and
            // banner read (plan 31 §4.3) — never a local inference. The
            // server re-checks this itself on every `shell.exec` regardless
            // (spec §10.1); this only decides whether Studio shows the input
            // box at all.
            canType={online}
            onRunAsStream={() => router.replace(`/device?id=${encodeURIComponent(device.id)}&tab=monitor`)}
          />
        </TabPanel>
      )}

      {transferEnabled && (
        <TabPanel active={tab === 'files'}>
          <FilesPanel deviceId={device.id} clientId={mySessionId} canUse={online} />
        </TabPanel>
      )}

      <TabPanel active={tab === 'network'}>
        <NetworkPanel deviceId={device.id} canUse={online} />
      </TabPanel>

      <TabPanel active={tab === 'agent'}>
        {/* Plan 124 §4.4, step 124.4 — the four `deviceLabel: string` props in
            the product are deliberately NOT widened into objects; their
            callers compose instead (§4.4's own note). `AgentPanel` puts this
            straight into toasts and a confirm title, all of which need a
            plain string. */}
        <AgentPanel deviceId={device.id} deviceLabel={formatDeviceName(device.number, device.label)} canUse={online} />
      </TabPanel>

      <TabPanel active={tab === 'identity'}>
        <IdentityPanel deviceId={device.id} canUse={online} />
      </TabPanel>

      <TabPanel active={tab === 'logs'}>
        <DeviceLog deviceId={device.id} deviceOffline={currentStatus === 'offline'} />
      </TabPanel>

      <TabPanel active={tab === 'storage'}>
        <div className="px-5 py-4">
          <KvPanel scope={{ kind: 'device', stableId: device.stableId }} />
        </div>
      </TabPanel>

      <TabPanel active={tab === 'settings'}>
        <div className="max-w-4xl px-5 py-4">
          <section className="mb-5 rounded-lg border bg-surface p-5">
            <h3 className="text-[14px] font-semibold tracking-tight">Tags</h3>
            <p className="mt-1 text-[12px] leading-relaxed text-fg-muted">
              Used to filter and select this device elsewhere — the run dialog, the devices list, and ad-hoc batch
              targeting. The group shown above is separate: a device belongs to at most one group, managed from
              the Groups page.
            </p>
            <div className="mt-3">
              <TagEditor deviceId={device.id} tags={device.tags} />
            </div>
          </section>

          <p className="mb-4 text-[12.5px] leading-relaxed text-fg-muted">
            These start as the farm defaults and apply to this device alone. Changing the farm defaults later does not
            touch a device that is already enrolled.
          </p>
          {schema ? (
            <SectionNav
              sections={settingsSections}
              active={section ?? settingsSections[0]?.id ?? 'general'}
              onChange={(id) =>
                router.push(`/device?id=${encodeURIComponent(device.id)}&tab=settings&section=${id}`)
              }
            />
          ) : (
            <LoadingRows rows={4} />
          )}
        </div>
      </TabPanel>

      <RunScriptDialog
        script={null}
        scripts={runOpen ? scripts : undefined}
        devices={device ? [device] : []}
        initialDevice={device?.id ?? null}
        lockedDevice={device}
        onClose={() => setRunOpen(false)}
        onLaunched={() => {
          // Stay on the device. Running a script used to bounce the operator to
          // /scripts and then to /jobs/detail — two screens away from the phone
          // they were working on, with no way back but the device list.
          router.replace(`/device?id=${encodeURIComponent(device.id)}&tab=jobs`)
          jobsRef.current?.reload()
        }}
      />

      <ForgetDeviceDialog
        device={device}
        open={forgetOpen}
        onOpenChange={setForgetOpen}
        onDone={() => router.push('/')}
      />

      <DisconnectDeviceDialog
        device={device}
        open={disconnectOpen}
        onOpenChange={setDisconnectOpen}
        onDone={reloadDevice}
      />

      <CutoverDialog
        device={device}
        open={cutoverOpen}
        onOpenChange={setCutoverOpen}
        onDone={reloadDevice}
      />
    </>
  )
}

/**
 * Keeps a tab's subtree mounted and toggles visibility with CSS instead of
 * unmounting it (Plan 42 §3.1, §4.1). `{tab === 'x' && <Panel/>}` used to
 * take `LiveView` — its decoder, its frame subscription, its WS stream
 * registration — down with it on every switch away from Control, which is
 * why returning sometimes replayed the whole wake-up sequence: it depended
 * on whether the core-side session happened to still be alive.
 *
 * `hidden` is the HTML attribute, not only a class, so a hidden panel is out
 * of the accessibility tree and untabbable.
 */
function TabPanel({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <div hidden={!active} aria-hidden={!active}>
      {children}
    </div>
  )
}

export default function DevicePage() {
  return (
    <Suspense
      fallback={
        <div className="px-5 py-4">
          <LoadingRows rows={2} />
        </div>
      }
    >
      <DeviceDetail />
    </Suspense>
  )
}
