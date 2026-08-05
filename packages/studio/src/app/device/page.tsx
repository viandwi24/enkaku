'use client'

import { Suspense, useEffect, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { ArrowLeft, Hand, Play, Trash2 } from 'lucide-react'
import type { BatteryState, DeviceInfo, DeviceStatus, JobInfo, RegistryResponse, ShellMode, Viewer } from '@enkaku/protocol'
import { LiveView } from '@/components/LiveView'
import { ClipboardCard } from '@/components/ClipboardCard'
import { DeviceLog } from '@/components/DeviceLog'
import { CrashesPanel } from '@/components/CrashesPanel'
import { InspectorPanel } from '@/components/InspectorPanel'
import { MonitorPane } from '@/components/monitor/MonitorPane'
import { TerminalPane } from '@/components/terminal/TerminalPane'
import { AdbEndpointCard } from '@/components/terminal/AdbEndpointCard'
import { FilesPanel } from '@/components/FilesPanel'
import { NetworkPanel } from '@/components/guest-agent/NetworkPanel'
import { ViewerList, labelFor } from '@/components/ViewerList'
import { DEVICE_LABEL, DeviceStatusBadge } from '@/components/StatusBadge'
import { PageHeader } from '@/components/layout/PageHeader'
import { EntityTabs } from '@/components/layout/EntityTabs'
import { JobStatusBadge } from '@/components/StatusBadge'
import { TagEditor } from '@/components/TagEditor'
import { RunScriptDialog, type ScriptRow } from '@/components/RunScriptDialog'
import { ForgetDeviceDialog } from '@/components/ForgetDeviceDialog'
import { UNAVAILABLE_REASON } from '@/components/DevicePicker'
import { PaginatedTable, type Page, type PaginatedTableHandle } from '@/components/PaginatedTable'
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
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { api, useAction } from '@/lib/actions'
import { fetchAllPages, fetchDeviceRefs, type DeviceRef } from '@/lib/api'
import { newId, ws } from '@/lib/ws'
import { cn } from '@/lib/utils'

/** The device's effective engines — from GET /api/devices/:id. */
interface DeviceDetailInfo extends DeviceInfo {
  transport: string
  display: string
  input: string
  inspection: string
  settings: unknown
  /** Set only for an agent-owned (cloud) device — there is no local `Inspector` to attach to (plan 56 §2 non-goals), so the Inspect tab is disabled rather than left to dead-end at a server refusal. */
  agentId: string | null
}

const ENGINE_ROWS = [
  { key: 'transport', label: 'transport', reg: 'transports' },
  { key: 'display', label: 'video', reg: 'displays' },
  { key: 'input', label: 'input', reg: 'inputs' },
  { key: 'inspection', label: 'inspection', reg: 'inspectors' },
] as const

function DeviceDetail() {
  // A query param rather than a dynamic route, because a static export cannot
  // pre-render dynamic ids — see the studio README.
  const params = useSearchParams()
  const router = useRouter()
  const deviceId = params.get('id')
  const tab = params.get('tab') ?? 'control'
  // The Settings tab's active sub-section (plan 46 §3.4, §4.3) — an
  // unknown or absent value falls back to the first section, resolved
  // below once the schema (and therefore the section list) has loaded.
  const section = params.get('section')
  const [device, setDevice] = useState<DeviceDetailInfo | null>(null)
  const [registry, setRegistry] = useState<RegistryResponse | null>(null)
  const [status, setStatus] = useState<DeviceStatus | null>(null)
  const [expiresAt, setExpiresAt] = useState<number | null>(null)
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
  const [runScript, setRunScript] = useState<ScriptRow | null>(null)
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

  /**
   * The published fact (plan 31 §4.3), not an inference from local state: the
   * viewer list is the single thing both the button and the banner read, so
   * there is no way for this tab to render "release control" for a lease it
   * does not hold — the button reads what the server published.
   */
  const holder = viewers.find((v) => v.holdsControl) ?? null
  const iHoldControl = holder !== null && holder.sessionId === mySessionId
  /** Someone else is driving: a viewer holds control, and it is not us. */
  const heldByOther = holder !== null && !iHoldControl
  const holderLabel = holder ? labelFor(holder) : null
  // Kept in sync every render (not just on the events that flip it) so the
  // ws.on callback below — created once per deviceId, not per render — can
  // still ask "was I the one who just lost control" without a stale closure.
  const iHoldControlRef = useRef(iHoldControl)
  iHoldControlRef.current = iHoldControl
  /** The battery readings the core has pushed since load, else the first fetch. */
  const liveBattery = battery ?? device?.battery ?? null

  useEffect(() => {
    if (!deviceId) return
    void api<{ device: DeviceDetailInfo }>(`/api/devices/${deviceId}`)
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
    // The very same schema the farm defaults are rendered from, so a field can
    // never exist in one place and be missing in the other.
    void api<{
      deviceSchema: JsonSchemaNode
      settings: { shell: { mode: ShellMode; endpointEnabled: boolean }; transfer: { enabled: boolean } }
    }>('/api/settings')
      .then((b) => {
        setSchema(b.deviceSchema)
        setShellMode(b.settings.shell.mode)
        setEndpointEnabled(b.settings.shell.endpointEnabled)
        setTransferEnabled(b.settings.transfer.enabled)
      })
      .catch(() => undefined)
    void fetchAllPages<ScriptRow>('/api/scripts')
      .then((scripts) => setScripts(scripts.filter((x) => x.enabled)))
      .catch(() => setScripts([]))
    // The presence snapshot (plan 31 §3.4): `/ws` has no replay, so the
    // current viewer list is fetched once here and kept live by
    // `device.viewers` below.
    void api<{ viewers: Viewer[] }>(`/api/devices/${deviceId}/viewers`)
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

  // Every input refreshes the lease on the server (touchManual); mirror that
  // here so the countdown stays honest instead of alarming for no reason.
  const noteActivity = () => {
    if (expiresAt !== null) setExpiresAt(Date.now() + idleTimeoutRef.current * 1000)
  }

  const saveSettings = () =>
    run('settings', () => api(`/api/devices/${deviceId}`, { method: 'PATCH', json: { settings: draftSettings } }), {
      success: 'Device settings saved',
      failure: 'Could not save the device settings',
      onSuccess: () => setSavedSettings(draftSettings),
    })

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
  const canTakeControl = currentStatus === 'idle'
  const inputEnabled = iHoldControl && !busy

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
      <PageHeader
        title={device.label}
        description={`${device.serial} · ${device.androidVersion ? `Android ${device.androidVersion}` : 'Android version unknown'}`}
        meta={<DeviceStatusBadge status={currentStatus} />}
        actions={
          <>
            <Button asChild variant="ghost" size="sm">
              <Link href="/">
                <ArrowLeft className="size-4" aria-hidden />
                All devices
              </Link>
            </Button>
            {/* Removal (plan 47 §4.5) — the dialog itself states what is
                removed vs. kept, and handles the "still connected" refusal
                with a Block instead offer; this button only opens it. */}
            <Button variant="ghost" size="sm" onClick={() => setForgetOpen(true)}>
              <Trash2 className="size-4" aria-hidden />
              Remove device
            </Button>
            {currentStatus === 'offline' || currentStatus === 'quarantined' ? (
              <Button variant="outline" size="sm" disabled>
                <Play className="size-4" aria-hidden />
                Run a script
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                disabled={scripts.length === 0}
                onClick={() => {
                  setRunScript(scripts[0] ?? null)
                  setRunOpen(true)
                }}
              >
                <Play className="size-4" aria-hidden />
                Run a script
              </Button>
            )}
            {iHoldControl ? (
              <Button size="sm" variant="secondary" onClick={releaseControl}>
                Release control
              </Button>
            ) : heldByOther ? (
              // Reads a fact the server published (the viewer list), not a
              // local inference — this is what makes the reported two-browser
              // symptom impossible by construction (plan 31 §4.3).
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    tabIndex={0}
                    onMouseEnter={() => holder && setHoveredSessionId(holder.sessionId)}
                    onMouseLeave={() => setHoveredSessionId(null)}
                  >
                    <Button size="sm" variant="outline" disabled>
                      <Hand className="size-4" aria-hidden />
                      Take control
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>Held by {holderLabel}</TooltipContent>
              </Tooltip>
            ) : canTakeControl ? (
              <Button size="sm" disabled={acquiring} onClick={() => void takeControl()}>
                <Hand className="size-4" aria-hidden />
                {acquiring ? 'Taking…' : 'Take control'}
              </Button>
            ) : (
              // A lit-up primary button that cannot be pressed is a trap — when
              // control genuinely is not available, show a clearly disabled
              // button and say why.
              <Tooltip>
                <TooltipTrigger asChild>
                  <span tabIndex={0}>
                    <Button size="sm" variant="outline" disabled>
                      <Hand className="size-4" aria-hidden />
                      Take control
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>{UNAVAILABLE_REASON[currentStatus] ?? 'The device is unavailable'}</TooltipContent>
              </Tooltip>
            )}
          </>
        }
      />

      <EntityTabs
        active={tab}
        tabs={[
          { key: 'control', label: 'Control' },
          { key: 'jobs', label: 'Jobs', count: jobsCount },
          { key: 'monitor', label: 'Monitor' },
          { key: 'crashes', label: 'Crashes' },
          // Agent-owned (cloud) devices have no local Inspector to attach to
          // (plan 56 §2 non-goals) — disabled with a stated reason rather
          // than a dead end (design.md's quality floor).
          {
            key: 'inspect',
            label: 'Inspect',
            ...(device.agentId ? { disabledReason: 'Inspecting an agent-owned device is not available yet.' } : {}),
          },
          // Hidden entirely when the farm switches the terminal off (plan 26
          // §5, 26.1) — server-authoritative either way: even a forced
          // `tab=terminal` in the address bar still gets refused by the WS
          // handler, this is purely so the tab is not a dead end to click.
          ...(shellMode === 'off' ? [] : [{ key: 'terminal', label: 'Terminal' }]),
          ...(transferEnabled ? [{ key: 'files', label: 'Files' }] : []),
          { key: 'network', label: 'Network' },
          { key: 'logs', label: 'Logs' },
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
        <div className="grid gap-4 px-5 py-4 xl:grid-cols-[1fr_18rem]">
          <div className="min-w-0 space-y-3">
            {/* One line of control status, three possibilities — always in the
                same place so nobody has to hunt for it. */}
            <div
              className={cn(
                'rounded-lg border px-3.5 py-2.5 text-[12.5px] leading-relaxed transition-colors',
                busy
                  ? 'border-led-active/40 bg-led-active/5 text-led-active'
                  : iHoldControl
                    ? 'border-led-ok/35 bg-led-ok/5'
                    : heldByOther && holder && hoveredSessionId === holder.sessionId
                      ? 'border-accent/40 bg-accent/5'
                      : 'bg-surface text-fg-muted',
              )}
              role="status"
            >
              {busy ? (
                <>An automation job is running. Video keeps streaming, but input stays off until the job finishes.</>
              ) : heldByOther ? (
                // Derived from `device.viewers`, the same server-published fact
                // the button reads (plan 31 §4.3) — no local inference, and the
                // holder's name is hoverable so it lights up its row below too.
                <span className="flex flex-wrap items-center gap-x-1">
                  <span
                    className="cursor-default rounded font-medium text-fg"
                    onMouseEnter={() => holder && setHoveredSessionId(holder.sessionId)}
                    onMouseLeave={() => setHoveredSessionId(null)}
                  >
                    {holderLabel}
                  </span>
                  <span>is controlling this device. You can keep watching; input stays off until they release it.</span>
                </span>
              ) : iHoldControl ? (
                <span className="flex flex-wrap items-center gap-x-2">
                  You have control.
                  {secondsLeft !== null && (
                    <span className="readout text-fg-muted">
                      released automatically in {mmss(secondsLeft)} without activity
                    </span>
                  )}
                </span>
              ) : canTakeControl ? (
                <>Take control before sending input. The core rejects taps and typing without a lease.</>
              ) : (
                <>This device is {DEVICE_LABEL[currentStatus]}. Manual control is only available once it is ready.</>
              )}
            </div>

            <LiveView
              deviceId={device.id}
              inputEnabled={inputEnabled}
              onActivity={noteActivity}
              autoReconnect={Boolean((device.settings as { autoReconnect?: boolean } | null)?.autoReconnect)}
              active={tab === 'control'}
            />
          </div>

          {/* Hardware facts sit beside the screen because they are read while
              controlling — "is it hot, is the battery dying". Configuration
              does not belong here; it has its own tab. */}
          <aside>
            <Panel title="hardware">
              <dl className="space-y-1.5">
                {/* Always shown, even unclustered — a field, not an omission (plan 22.0 §4.5). */}
                <Row label="cluster" value={device.cluster ? device.cluster.name : 'Unclustered'} />
                <Row label="stable id" value={device.stableId} />
                <Row label="serial" value={device.serial} />
                <Row label="api level" value={device.apiLevel ? String(device.apiLevel) : '—'} />
                <Row
                  label="screen"
                  value={device.screenW && device.screenH ? `${device.screenW}×${device.screenH}` : '—'}
                />
                <Row label="density" value={device.density ? `${device.density} dpi` : '—'} />
                {liveBattery && (
                  <>
                    <Row label="battery" value={`${liveBattery.level}%`} />
                    {liveBattery.temperatureC !== null && liveBattery.temperatureC !== undefined && (
                      <Row label="temperature" value={`${liveBattery.temperatureC.toFixed(1)}°C`} />
                    )}
                  </>
                )}
              </dl>
            </Panel>

            <ViewerList
              viewers={viewers}
              now={now}
              mySessionId={mySessionId}
              hoveredSessionId={hoveredSessionId}
              onHoverSession={setHoveredSessionId}
            />

            <div className="mt-3 rounded-lg border bg-surface p-3.5">
              <h2 className="rack-label mb-2.5">active engines</h2>
              <dl className="space-y-2">
                {ENGINE_ROWS.map((r) => {
                  // The `inspection` row reports the EFFECTIVE engine, not
                  // just what is configured (plan 34 §3.1, §4.6): a session
                  // that fell back to `uiautomator-dump` is running the slow
                  // path, and an operator who only sees "ui-server" here has
                  // no way to know that.
                  const fallback = r.key === 'inspection' ? inspectorFallback : null
                  return (
                    <div key={r.key}>
                      <dt className="rack-label">{r.label}</dt>
                      <dd className="mt-0.5 text-[12.5px] leading-snug">
                        {fallback ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="cursor-default text-led-warn">
                                {engineName(registry, r.reg, fallback.to)} (fallback)
                              </span>
                            </TooltipTrigger>
                            <TooltipContent>
                              Configured as {engineName(registry, r.reg, device[r.key])}, but this session dropped to{' '}
                              {engineName(registry, r.reg, fallback.to)}: {fallback.reason}
                            </TooltipContent>
                          </Tooltip>
                        ) : (
                          engineName(registry, r.reg, device[r.key])
                        )}
                      </dd>
                    </div>
                  )
                })}
              </dl>
              <Button asChild variant="ghost" size="sm" className="mt-2 h-7 w-full text-[12px]">
                <Link href={`/device?id=${encodeURIComponent(device.id)}&tab=settings`}>Change</Link>
              </Button>
            </div>

            <ClipboardCard deviceId={device.id} canSend={inputEnabled} />
          </aside>
        </div>
      </TabPanel>

      <TabPanel active={tab === 'jobs'}>
        <div className="px-5 py-4">
          <PaginatedTable<JobInfo>
            ref={jobsRef}
            resetKey={deviceId}
            fetchPage={(cursor) =>
              api<Page<JobInfo>>(`/api/jobs?deviceId=${deviceId}&limit=50${cursor ? `&cursor=${cursor}` : ''}`).then(
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
                  onClick={() => {
                    setRunScript(scripts[0] ?? null)
                    setRunOpen(true)
                  }}
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

      {tab === 'inspect' &&
        (device.agentId ? (
          <div className="px-5 py-4">
            <ErrorState message="Inspecting an agent-owned device is not available yet." />
          </div>
        ) : (
          <InspectorPanel deviceId={device.id} />
        ))}

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

      <TabPanel active={tab === 'logs'}>
        <DeviceLog deviceId={device.id} deviceOffline={currentStatus === 'offline'} />
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
        script={runOpen ? runScript : null}
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

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border bg-surface p-3.5">
      <h2 className="rack-label mb-2.5">{title}</h2>
      {children}
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-[12px] text-fg-muted">{label}</dt>
      <dd className="readout min-w-0 truncate text-[12px]" title={value}>
        {value}
      </dd>
    </div>
  )
}

function engineName(registry: RegistryResponse | null, key: string, id: string): string {
  const entries = registry?.[key as keyof RegistryResponse] as
    | Array<{ id: string; displayName: string }>
    | undefined
  return entries?.find((e) => e.id === id)?.displayName ?? id
}

function mmss(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
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
