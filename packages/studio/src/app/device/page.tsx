'use client'

import { Suspense, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { ArrowLeft, Hand, Play } from 'lucide-react'
import type { BatteryState, DeviceInfo, DeviceStatus, JobInfo, RegistryResponse } from '@enkaku/protocol'
import { LiveView } from '@/components/LiveView'
import { DEVICE_LABEL, DeviceStatusBadge } from '@/components/StatusBadge'
import { PageHeader } from '@/components/layout/PageHeader'
import { EntityTabs } from '@/components/layout/EntityTabs'
import { JobStatusBadge } from '@/components/StatusBadge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { EmptyState } from '@/components/states'
import { relativeTime, duration } from '@/lib/format'
import { ErrorState, LoadingRows } from '@/components/states'
import { fetchRegistry } from '@/components/schema-form/useEnumSource'
import { SchemaForm } from '@/components/schema-form/SchemaForm'
import type { JsonSchemaNode } from '@/components/schema-form/types'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { api, useAction } from '@/lib/actions'
import { newId, ws } from '@/lib/ws'
import { cn } from '@/lib/utils'

/** The device's effective engines — from GET /api/devices/:id. */
interface DeviceDetailInfo extends DeviceInfo {
  transport: string
  display: string
  input: string
  inspection: string
  settings: unknown
}

const UNAVAILABLE_REASON: Partial<Record<DeviceStatus, string>> = {
  offline: 'The device is not connected to this farm',
  busy: 'An automation job is running',
  manual: 'Another client is controlling it',
  quarantined: 'The device was pulled from the queue — return it from the Devices page first',
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
  const deviceId = params.get('id')
  const tab = params.get('tab') ?? 'control'
  const [device, setDevice] = useState<DeviceDetailInfo | null>(null)
  const [registry, setRegistry] = useState<RegistryResponse | null>(null)
  const [status, setStatus] = useState<DeviceStatus | null>(null)
  const [expiresAt, setExpiresAt] = useState<number | null>(null)
  const [leaseHeld, setLeaseHeld] = useState(false)
  const [battery, setBattery] = useState<BatteryState | null>(null)
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [acquiring, setAcquiring] = useState(false)
  const [jobs, setJobs] = useState<JobInfo[] | null>(null)
  const [schema, setSchema] = useState<JsonSchemaNode | null>(null)
  const [savedSettings, setSavedSettings] = useState<unknown>(undefined)
  const [draftSettings, setDraftSettings] = useState<unknown>(undefined)
  const idleTimeoutRef = useRef(300)
  const { run, isPending } = useAction()

  const hasLease = expiresAt !== null
  /** The battery readings the core has pushed since load, else the first fetch. */
  const liveBattery = battery ?? device?.battery ?? null
  /** Someone else is driving: the lease is held, and it is not ours. */
  const heldByOther = leaseHeld && !hasLease

  useEffect(() => {
    if (!deviceId) return
    void api<{ device: DeviceDetailInfo }>(`/api/devices/${deviceId}`)
      .then((b) => {
        setDevice(b.device)
        setStatus(b.device.status)
        setSavedSettings(b.device.settings ?? undefined)
        setDraftSettings(b.device.settings ?? undefined)
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
    void fetchRegistry().then(setRegistry)
    // The very same schema the farm defaults are rendered from, so a field can
    // never exist in one place and be missing in the other.
    void api<{ deviceSchema: JsonSchemaNode }>('/api/settings')
      .then((b) => setSchema(b.deviceSchema))
      .catch(() => undefined)
    // The jobs API already filters by device; the old page simply never asked.
    void api<{ jobs: JobInfo[] }>(`/api/jobs?deviceId=${deviceId}&limit=100`)
      .then((b) => setJobs(b.jobs))
      .catch(() => setJobs([]))

    const off = ws.on((msg) => {
      if (msg.type === 'device.status' && msg.payload.id === deviceId) {
        setStatus(msg.payload.status)
        if (msg.payload.status !== 'manual') setExpiresAt(null)
      } else if (msg.type === 'lease.changed' && msg.payload.deviceId === deviceId) {
        // Broadcast to everyone: this is how a second viewer finds out that
        // control changed hands without having to click and get an error.
        setLeaseHeld(msg.payload.held)
        if (!msg.payload.held) setExpiresAt(null)
      } else if (msg.type === 'device.battery' && msg.payload.deviceId === deviceId) {
        // The panel used to show whatever the first fetch returned; a device
        // that heats up or drains while you watch it looked frozen.
        setBattery(msg.payload.battery)
      } else if (msg.type === 'lease.revoked' && msg.payload.deviceId === deviceId) {
        setExpiresAt(null)
        setNotice(
          msg.payload.reason === 'idle_timeout'
            ? 'Control was released automatically after a period of inactivity. Take it again to continue.'
            : `Control was released automatically (${msg.payload.reason}).`,
        )
      }
    })
    return off
  }, [deviceId])

  // Idle-timeout countdown. The server drops the lease when no input arrives;
  // people deserve to see that coming rather than have the screen go dead.
  useEffect(() => {
    if (expiresAt === null) {
      setSecondsLeft(null)
      return
    }
    const tick = () => setSecondsLeft(Math.max(0, Math.round((expiresAt - Date.now()) / 1000)))
    tick()
    const t = setInterval(tick, 1000)
    return () => clearInterval(t)
  }, [expiresAt])

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
  const inputEnabled = hasLease && !busy

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
            {currentStatus === 'offline' || currentStatus === 'quarantined' ? (
              <Button variant="outline" size="sm" disabled>
                <Play className="size-4" aria-hidden />
                Run a script
              </Button>
            ) : (
              <Button asChild variant="outline" size="sm">
                <Link href={`/scripts?device=${device.id}`}>
                  <Play className="size-4" aria-hidden />
                  Run a script
                </Link>
              </Button>
            )}
            {hasLease ? (
              <Button size="sm" variant="secondary" onClick={releaseControl}>
                Release control
              </Button>
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
          { key: 'jobs', label: 'Jobs', count: jobs?.length ?? null },
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

      {tab === 'control' && (
        <div className="grid gap-4 px-5 py-4 xl:grid-cols-[1fr_18rem]">
          <div className="min-w-0 space-y-3">
            {/* One line of control status, three possibilities — always in the
                same place so nobody has to hunt for it. */}
            <div
              className={cn(
                'rounded-lg border px-3.5 py-2.5 text-[12.5px] leading-relaxed',
                busy
                  ? 'border-led-active/40 bg-led-active/5 text-led-active'
                  : hasLease
                    ? 'border-led-ok/35 bg-led-ok/5'
                    : 'bg-surface text-fg-muted',
              )}
              role="status"
            >
              {busy ? (
                <>An automation job is running. Video keeps streaming, but input stays off until the job finishes.</>
              ) : heldByOther ? (
                // Arrives over lease.changed, so this flips the moment someone
                // else takes the device — no reload, no click-then-error.
                <>Someone else is controlling this device. You can keep watching; input stays off until they release it.</>
              ) : hasLease ? (
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

            <LiveView deviceId={device.id} inputEnabled={inputEnabled} onActivity={noteActivity} />
          </div>

          {/* Hardware facts sit beside the screen because they are read while
              controlling — "is it hot, is the battery dying". Configuration
              does not belong here; it has its own tab. */}
          <aside>
            <Panel title="hardware">
              <dl className="space-y-1.5">
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

            <div className="mt-3 rounded-lg border bg-surface p-3.5">
              <h2 className="rack-label mb-2.5">active engines</h2>
              <dl className="space-y-2">
                {ENGINE_ROWS.map((r) => (
                  <div key={r.key}>
                    <dt className="rack-label">{r.label}</dt>
                    <dd className="mt-0.5 text-[12.5px] leading-snug">{engineName(registry, r.reg, device[r.key])}</dd>
                  </div>
                ))}
              </dl>
              <Button asChild variant="ghost" size="sm" className="mt-2 h-7 w-full text-[12px]">
                <Link href={`/device?id=${encodeURIComponent(device.id)}&tab=settings`}>Change</Link>
              </Button>
            </div>
          </aside>
        </div>
      )}

      {tab === 'jobs' && (
        <div className="px-5 py-4">
          {jobs === null ? (
            <LoadingRows rows={4} />
          ) : jobs.length === 0 ? (
            <EmptyState
              title="No jobs on this device yet"
              description="Runs started on this device appear here, newest first."
              action={
                <Button asChild>
                  <Link href={`/scripts?device=${encodeURIComponent(device.id)}`}>Run a script</Link>
                </Button>
              }
            />
          ) : (
            <div className="overflow-hidden rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-[45%]">Script</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Duration</TableHead>
                    <TableHead>Started</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {jobs.map((j) => (
                    <TableRow key={j.jobId}>
                      <TableCell>
                        <Link href={`/jobs/detail?id=${j.jobId}`} className="font-medium hover:text-accent">
                          {j.scriptName ? `${j.scriptName}@${j.scriptVersion ?? '?'}` : j.scriptId}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <JobStatusBadge status={j.status} />
                      </TableCell>
                      <TableCell className="readout text-[11.5px] text-fg-muted">
                        {duration(j.startedAt, j.finishedAt)}
                      </TableCell>
                      <TableCell className="readout text-[11.5px] text-fg-muted">
                        {relativeTime(j.startedAt ?? j.createdAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      )}

      {tab === 'settings' && (
        <div className="max-w-3xl px-5 py-4">
          <p className="mb-4 text-[12.5px] leading-relaxed text-fg-muted">
            These start as the farm defaults and apply to this device alone. Changing the farm defaults later does not
            touch a device that is already enrolled.
          </p>
          {schema ? (
            <SchemaForm
              schema={schema}
              value={draftSettings}
              onChange={setDraftSettings}
              onSubmit={saveSettings}
              onReset={() => setDraftSettings(savedSettings)}
              busy={isPending('settings')}
              dirty={JSON.stringify(draftSettings) !== JSON.stringify(savedSettings)}
            />
          ) : (
            <LoadingRows rows={4} />
          )}
        </div>
      )}

    </>
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
