'use client'

import { useEffect, useMemo, useState } from 'react'
import { Plus, Search, Smartphone } from 'lucide-react'
import type { DeviceInfo, JobInfo } from '@enkaku/protocol'
import { DeviceCard } from '@/components/DeviceCard'
import { EnrollmentDialog } from '@/components/EnrollmentDialog'
import { PageHeader } from '@/components/layout/PageHeader'
import { EmptyState, ErrorState, LoadingRows } from '@/components/states'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { api, useAction } from '@/lib/actions'
import { ws } from '@/lib/ws'
import { cn } from '@/lib/utils'

type Filter = 'all' | 'ready' | 'inUse' | 'attention'

export default function Dashboard() {
  const [devices, setDevices] = useState<DeviceInfo[] | null>(null)
  const [jobs, setJobs] = useState<JobInfo[]>([])
  const [unauthorized, setUnauthorized] = useState<string[]>([])
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [enrollOpen, setEnrollOpen] = useState(false)
  const { run } = useAction()

  const load = async () => {
    setError(null)
    try {
      const [d, j] = await Promise.all([
        api<{ devices: DeviceInfo[] }>('/api/devices'),
        api<{ jobs: JobInfo[] }>('/api/jobs?status=running&limit=50'),
      ])
      setDevices(d.devices)
      setJobs(j.jobs)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => {
    void load()
    const off = ws.on((m) => {
      if (m.type === 'device.added' || m.type === 'device.removed' || m.type === 'device.status') void load()
      else if (m.type === 'job.status') void load()
      else if (m.type === 'device.battery') {
        setDevices((prev) =>
          prev
            ? prev.map((d) => (d.id === m.payload.deviceId ? { ...d, battery: m.payload.battery } : d))
            : prev,
        )
      } else if (m.type === 'device.unauthorized') {
        setUnauthorized((prev) => (prev.includes(m.payload.serial) ? prev : [...prev, m.payload.serial]))
        setEnrollOpen(true)
      }
    })
    return off
  }, [])

  const needsAttention = (d: DeviceInfo) =>
    d.status === 'quarantined' || d.status === 'offline' || Boolean(d.battery && d.battery.temperatureC >= 45)

  const summary = useMemo(() => {
    const list = devices ?? []
    return {
      all: list.length,
      ready: list.filter((d) => d.status === 'idle').length,
      inUse: list.filter((d) => d.status === 'busy' || d.status === 'manual').length,
      attention: list.filter(needsAttention).length,
    }
  }, [devices])

  const filtered = useMemo(() => {
    let list = devices ?? []
    if (filter === 'ready') list = list.filter((d) => d.status === 'idle')
    else if (filter === 'inUse') list = list.filter((d) => d.status === 'busy' || d.status === 'manual')
    else if (filter === 'attention') list = list.filter(needsAttention)
    const q = query.trim().toLowerCase()
    if (q) list = list.filter((d) => d.label.toLowerCase().includes(q) || d.serial.toLowerCase().includes(q))
    return list
  }, [devices, filter, query])

  const releaseQuarantine = (d: DeviceInfo) =>
    run('unq-' + d.id, () => api(`/api/devices/${d.id}/unquarantine`, { method: 'POST' }), {
      success: `${d.label} is back in the queue`,
      failure: 'Could not return the device to the queue',
      onSuccess: () => void load(),
    })

  return (
    <>
      <PageHeader
        title="Devices"
        description="Phones connected to this farm"
        actions={
          <Button size="sm" onClick={() => setEnrollOpen(true)}>
            <Plus className="size-4" aria-hidden />
            Add device
          </Button>
        }
      />

      <div className="space-y-4 px-5 py-4">
        {/* The summary doubles as the filter: clicking "needs attention"
            filters straight away, instead of being a number you cannot act on. */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {(
            [
              ['all', 'Total', summary.all, ''],
              ['ready', 'Ready', summary.ready, 'text-led-ok'],
              ['inUse', 'In use', summary.inUse, 'text-led-active'],
              ['attention', 'Needs attention', summary.attention, 'text-led-danger'],
            ] as const
          ).map(([key, label, value, tone]) => (
            <button
              key={key}
              type="button"
              aria-pressed={filter === key}
              onClick={() => setFilter(key as Filter)}
              className={cn(
                'rounded-lg border bg-surface px-3.5 py-3 text-left transition-colors',
                filter === key ? 'border-accent' : 'hover:border-line-strong',
              )}
            >
              <div className={cn('readout text-2xl leading-none', value > 0 ? tone : 'text-fg-subtle')}>
                {value}
              </div>
              <div className="rack-label mt-1.5">{label}</div>
            </button>
          ))}
        </div>

        <div className="relative max-w-xs">
          <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-subtle" aria-hidden />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name or serial…"
            aria-label="Search devices"
            className="h-8 pl-8 text-[12.5px]"
          />
        </div>

        {error ? (
          <ErrorState message={error} onRetry={load} />
        ) : devices === null ? (
          <LoadingRows rows={4} />
        ) : devices.length === 0 ? (
          <EmptyState
            icon={<Smartphone className="size-4" aria-hidden />}
            title="No devices yet"
            description={
              <>
                Plug in a phone over USB with USB debugging turned on, then accept the prompt on its screen. For
                devices on the same network, use wireless pairing.
              </>
            }
            action={<Button onClick={() => setEnrollOpen(true)}>Add device</Button>}
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            title="Nothing matches"
            description="Change the search or pick a different filter."
            action={
              <Button
                variant="outline"
                onClick={() => {
                  setQuery('')
                  setFilter('all')
                }}
              >
                Show all
              </Button>
            }
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {filtered.map((d) => (
              <DeviceCard
                key={d.id}
                device={d}
                runningJob={jobs.find((j) => j.deviceId === d.id) ?? null}
                onReleaseQuarantine={d.status === 'quarantined' ? () => void releaseQuarantine(d) : undefined}
              />
            ))}
          </div>
        )}
      </div>

      <EnrollmentDialog open={enrollOpen} onOpenChange={setEnrollOpen} unauthorizedSerials={unauthorized} />
    </>
  )
}
