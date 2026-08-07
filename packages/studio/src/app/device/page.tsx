'use client'

import { Suspense, useEffect, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  DeviceDetailResponseSchema,
  DeviceResponseSchema,
  DeviceViewersResponseSchema,
  JobsPageResponseSchema,
  PluginDevSlotsResponseSchema,
  SettingsResponseSchema,
  type BatteryState,
  type DeviceStatus,
  type JobInfo,
  type LeaseHolder,
  type RegistryResponse,
  type ShellMode,
  type Viewer,
} from '@enkaku/protocol'
import { DeviceLog } from '@/components/DeviceLog'
import { CrashesPanel } from '@/components/CrashesPanel'
import { MonitorPane } from '@/components/monitor/MonitorPane'
import { TerminalPane } from '@/components/terminal/TerminalPane'
import { AdbEndpointCard } from '@/components/terminal/AdbEndpointCard'
import { FilesPanel } from '@/components/FilesPanel'
import { NetworkPanel } from '@/components/guest-agent/NetworkPanel'
import { IdentityPanel } from '@/components/identity/IdentityPanel'
import { KvPanel } from '@/components/kv/KvPanel'
import { DeviceHeader, type DeviceDetailInfo } from '@/components/device/DeviceHeader'
import { ScreenCard, type ScreenMode } from '@/components/device/ScreenCard'
import { EntityTabs } from '@/components/layout/EntityTabs'
import { UNAVAILABLE_REASON } from '@/components/DevicePicker'
import { JobStatusBadge } from '@/components/StatusBadge'
import { TagEditor } from '@/components/TagEditor'
import { RunScriptDialog, type ScriptRow } from '@/components/RunScriptDialog'
import { ForgetDeviceDialog } from '@/components/ForgetDeviceDialog'
import { PaginatedTable, type PaginatedTableHandle } from '@/components/PaginatedTable'
import { TableCell, TableHead } from '@/components/ui/table'
import { relativeTime, duration } from '@/lib/format'
import { useNow } from '@/lib/useNow'
import { ErrorState, LoadingRows } from '@/components/states'
import { fetchRegistry } from '@/components/schema-form/useEnumSource'
import { SchemaForm } from '@/components/schema-form/SchemaForm'
import { narrowSchema } from '@/components/schema-form/narrowSchema'
import type { JsonSchemaNode } from '@/components/schema-form/types'
import { SectionNav, type SettingsSection } from '@/components/settings/SectionNav'
import { deviceSections } from '@/components/settings/deviceSections'
import { Button } from '@/components/ui/button'
import { api, useAction } from '@/lib/actions'
import { fetchAllPages, fetchDeviceRefs, type DeviceRef } from '@/lib/api'
import { newId, ws } from '@/lib/ws'

function DeviceDetail() {
  // A query param rather than a dynamic route, because a static export cannot
  // pre-render dynamic ids — see the studio README.
  const params = useSearchParams()
  const router = useRouter()
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
  const [expiresAt, setExpiresAt] = useState<number | null>(null)
  // Lifted out of `DeviceHeader` (plan 71 §3.6) — that component keeps no
  // hooks of its own, so it can be called directly in its own test.
  const [takeOverOpen, setTakeOverOpen] = useState(false)
  // Plan 73 §3.5, §4.6 — "Ask an agent" dialog visibility, the same lifted-to-the-caller pattern
  // `takeOverOpen` already uses (`DeviceHeader` keeps no hooks of its own).
  const [askAgentOpen, setAskAgentOpen] = useState(false)
  // Presence (plan 31): who is watching, and who — server-published, not
  // inferred locally — actually holds control.
  const [viewers, setViewers] = useState<Viewer[]>([])
  const [mySessionId, setMySessionId] = useState<string | null>(() => ws.getSessionId())
  const [hoveredSessionId, setHoveredSessionId] = useState<string | null>(null)
  const [battery, setBattery] = useState<BatteryState | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // A link into this page can outlive the device it points at (plan 47 §3.4)
  // — resolved only when the device fetch itself fails, so the common case
  // pays nothing extra.
  const [deletedRef, setDeletedRef] = useState<DeviceRef | null>(null)
  const [acquiring, setAcquiring] = useState(false)
  const [jobsCount, setJobsCount] = useState<number | null>(null)
  const jobsRef = useRef<PaginatedTableHandle<JobInfo>>(null)
  const [scripts, setScripts] = useState<ScriptRow[]>([])
  const [runOpen, setRunOpen] = useState(false)
  // Removal (plan 47 §4.5) — the smallest additive hook into this page: a
  // single dialog, no new tab, no restructuring of what is already here.
  const [forgetOpen, setForgetOpen] = useState(false)
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
  const idleTimeoutRef = useRef(300)
  const { run, isPending } = useAction()
  // The lease countdown and the jobs tab tick without a refresh (Plan 17 §4.6).
  const now = useNow()
  // Who holds the device's manual lease — a person, an agent, or a job, or
  // null when free (plan 71 §3.2). Server-published on `DeviceInfo.heldBy`
  // and kept live by `lease.changed` below; this is what makes an agent
  // driving the phone visible here without polling (plan 69 §3.5's old
  // `lib/agent-holders.ts`, deleted).
  const [heldBy, setHeldBy] = useState<LeaseHolder | null>(null)

  /**
   * The published fact (plan 31 §4.3), not an inference from local state: the
   * viewer list is the single thing the header's button and its viewer popover
   * both read, so there is no way for this tab to render "release control" for
   * a lease it does not hold — the button reads what the server published.
   */
  const holder = viewers.find((v) => v.holdsControl) ?? null
  const iHoldControl = holder !== null && holder.sessionId === mySessionId
  // Kept in sync every render (not just on the events that flip it) so the
  // ws.on callback below — created once per deviceId, not per render — can
  // still ask "was I the one who just lost control" without a stale closure.
  const iHoldControlRef = useRef(iHoldControl)
  iHoldControlRef.current = iHoldControl
  /** The battery readings the core has pushed since load, else the first fetch. */
  const liveBattery = battery ?? device?.battery ?? null

  useEffect(() => {
    if (!deviceId) return
    void api(`/api/devices/${deviceId}`, DeviceDetailResponseSchema)
      .then((b) => {
        setDevice(b.device)
        setStatus(b.device.status)
        setHeldBy(b.device.heldBy)
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
      })
      .catch(() => undefined)
    void fetchAllPages<ScriptRow>('/api/scripts')
      .then((scripts) => setScripts(scripts.filter((x) => x.enabled)))
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
        if (msg.payload.status !== 'manual') setExpiresAt(null)
      } else if (msg.type === 'lease.changed' && msg.payload.deviceId === deviceId) {
        // The single source of truth for who holds control (plan 71 §3.2) —
        // live, for a person, an agent, or a job alike, replacing the old
        // agent-only poll.
        setHeldBy(msg.payload.heldBy)
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
      } else if (msg.type === 'lease.revoked' && msg.payload.deviceId === deviceId) {
        setExpiresAt(null)
        // Scoped to the actual former holder (plan 31 §3.1): this broadcast
        // itself carries no identity, but the ref tracks whether THIS tab was
        // the one holding control the instant before the revoke arrived —
        // a bystander tab no longer sees a notice about a lease it never had.
        if (iHoldControlRef.current) {
          setNotice(
            msg.payload.reason === 'idle_timeout'
              ? 'Control was released automatically after a period of inactivity. Take it again to continue.'
              : msg.payload.reason === 'taken-over'
                ? `${msg.payload.takenBy ?? 'Someone else'} took control from you.`
                : `Control was released automatically (${msg.payload.reason}).`,
          )
        }
      }
    })
    return off
  }, [deviceId])

  // Idle-timeout countdown. The server drops the lease when no input arrives;
  // people deserve to see that coming rather than have the screen go dead.
  // Derived from the shared `now` tick rather than its own interval (Plan 17 §4.6).
  const secondsLeft = expiresAt === null ? null : Math.max(0, Math.round((expiresAt - now) / 1000))

  async function takeControl() {
    if (!deviceId) return
    setError(null)
    setNotice(null)
    setAcquiring(true)
    try {
      const res = await ws.request({ type: 'lease.acquire', id: newId(), payload: { deviceId } })
      if (res.type === 'lease.acquired') {
        const ms = res.payload.expiresAt * 1000
        idleTimeoutRef.current = Math.max(30, Math.round((ms - Date.now()) / 1000))
        setExpiresAt(ms)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setAcquiring(false)
    }
  }

  function releaseControl() {
    if (!deviceId) return
    ws.send({ type: 'lease.release', payload: { deviceId } })
    setExpiresAt(null)
  }

  /** A takeover succeeded via `TakeControlDialog` (plan 71 §3.4) — the same bookkeeping `takeControl`'s own success branch does. */
  function onControlTaken(expiresAtSec: number) {
    setError(null)
    setNotice(null)
    const ms = expiresAtSec * 1000
    idleTimeoutRef.current = Math.max(30, Math.round((ms - Date.now()) / 1000))
    setExpiresAt(ms)
  }

  // Every input refreshes the lease on the server (touchManual); mirror that
  // here so the countdown stays honest instead of alarming for no reason.
  const noteActivity = () => {
    if (expiresAt !== null) setExpiresAt(Date.now() + idleTimeoutRef.current * 1000)
  }

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
  const busy = currentStatus === 'busy'
  const inputEnabled = iHoldControl && !busy
  /**
   * Why `Take control` cannot be pressed right now, or null when it can — the
   * same rule the header's own button follows, so a panel that offers the
   * action inline (plan 59 §3.1) never offers one that would bounce. A
   * precondition the operator can satisfy stays a live button; one they
   * cannot is genuinely disabled and names the state it needs.
   */
  const takeControlReason = iHoldControl
    ? null
    : heldBy
      ? // The full takeover flow lives on the header's own button (plan 71
        // §3.4) — this inline one only explains why it cannot be pressed
        // here, naming who holds it exactly as the header's badge does.
        `Control is held by ${heldBy.label}. Use "Take control" above to take it over.`
      : currentStatus === 'idle'
        ? null
        : (UNAVAILABLE_REASON[currentStatus] ?? 'The device is unavailable')
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
        render: () => (
          <SchemaForm
            schema={narrowSchema(schema, s.keys)}
            value={draftSettings}
            onChange={setDraftSettings}
            onSubmit={saveSettings}
            onReset={() => setDraftSettings(savedSettings)}
            busy={isPending('settings')}
            dirty={JSON.stringify(draftSettings) !== JSON.stringify(savedSettings)}
          />
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
        secondsLeft={secondsLeft}
        holder={holder}
        heldBy={heldBy}
        iHoldControl={iHoldControl}
        acquiring={acquiring}
        canRunScript={scripts.length > 0}
        // The dialog picks the script now. This used to hand it `scripts[0]` —
        // whichever the API happened to sort first — so every other published
        // script was unreachable from a device's own page, and the version
        // moved on its own whenever anything was republished.
        onRunScript={() => setRunOpen(true)}
        onTakeControl={() => void takeControl()}
        onControlTaken={onControlTaken}
        onReleaseControl={releaseControl}
        onRemove={() => setForgetOpen(true)}
        takeOverOpen={takeOverOpen}
        onTakeOverOpenChange={setTakeOverOpen}
        askAgentOpen={askAgentOpen}
        onAskAgentOpenChange={setAskAgentOpen}
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
          <ScreenCard
            deviceId={device.id}
            mode={screenMode}
            onModeChange={setMode}
            // Node-owned (cloud) devices have no local Inspector to attach to
            // (plan 56 §2 non-goals) — disabled with a stated reason rather
            // than a dead end (design.md's quality floor).
            {...(device.nodeId ? { inspectDisabledReason: 'Inspecting a node-owned device is not available yet.' } : {})}
            jobRunning={busy}
            inputEnabled={inputEnabled}
            // The same server-published fact every other panel on this page
            // reads (plan 31 §4.3) — the inspector needs a manual lease
            // (plan 56 §3.7), and the core checks it on every message
            // regardless. This only decides what the panel says (plan 59 §3.1)
            // and whether it holds an engine (§3.3).
            canInspect={iHoldControl && !busy}
            onTakeControl={() => void takeControl()}
            {...(takeControlReason ? { takeControlDisabledReason: takeControlReason } : {})}
            onActivity={noteActivity}
            autoReconnect={Boolean((device.settings as { autoReconnect?: boolean } | null)?.autoReconnect)}
            visible={tab === 'control'}
          />
        </div>
      </TabPanel>

      <TabPanel active={tab === 'jobs'}>
        <div className="px-5 py-4">
          <PaginatedTable<JobInfo>
            ref={jobsRef}
            resetKey={deviceId}
            fetchPage={(cursor) =>
              api(`/api/jobs?deviceId=${deviceId}&limit=50${cursor ? `&cursor=${cursor}` : ''}`, JobsPageResponseSchema).then(
                (page) => {
                  if (cursor === null) setJobsCount(page.total)
                  return page
                },
              )
            }
            rowKey={(j) => j.jobId}
            header={
              <>
                <TableHead className="w-[45%]">Script</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>Started</TableHead>
              </>
            }
            renderRow={(j) => (
              <>
                <TableCell>
                  <Link href={`/jobs/detail?id=${j.jobId}`} className="font-medium hover:text-accent">
                    {j.scriptName ? `${j.scriptName}@${j.scriptVersion ?? '?'}` : j.scriptId}
                  </Link>
                </TableCell>
                <TableCell>
                  <JobStatusBadge status={j.status} />
                </TableCell>
                <TableCell className="readout text-[11.5px] text-fg-muted">
                  {duration(j.startedAt, j.finishedAt, now)}
                </TableCell>
                <TableCell className="readout text-[11.5px] text-fg-muted">
                  {relativeTime(j.startedAt ?? j.createdAt, now)}
                </TableCell>
              </>
            )}
            empty={{
              title: 'No jobs on this device yet',
              description: 'Runs started on this device appear here, newest first.',
              action: (
                <Button
                  disabled={scripts.length === 0}
                  onClick={() => setRunOpen(true)}
                >
                  Run a script
                </Button>
              ),
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
                // `device.adb` plus the lease itself on every request.
                canOpen={iHoldControl && !busy}
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
            canType={iHoldControl && !busy}
            onRunAsStream={() => router.replace(`/device?id=${encodeURIComponent(device.id)}&tab=monitor`)}
          />
        </TabPanel>
      )}

      {transferEnabled && (
        <TabPanel active={tab === 'files'}>
          <FilesPanel deviceId={device.id} clientId={mySessionId} canUse={iHoldControl && !busy} />
        </TabPanel>
      )}

      <TabPanel active={tab === 'network'}>
        <NetworkPanel deviceId={device.id} deviceLabel={device.label} canUse={iHoldControl && !busy} />
      </TabPanel>

      <TabPanel active={tab === 'identity'}>
        <IdentityPanel deviceId={device.id} canUse={iHoldControl && !busy} />
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
              targeting. The cluster shown above is separate: a device belongs to at most one cluster, managed from
              the Clusters page.
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
