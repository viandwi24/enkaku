'use client'

import Link from 'next/link'
import { Battery, Play, ScreenShare, Thermometer } from 'lucide-react'
import type { DeviceInfo, JobInfo } from '@enkaku/protocol'
import { Button } from '@/components/ui/button'
import { DeviceStatusBadge } from '@/components/StatusBadge'
import { cn } from '@/lib/utils'

/**
 * The device card as a "rack unit": status rail down the left edge, identity
 * on top, instrument readouts (battery, temperature) in the middle, actions
 * at the bottom.
 *
 * The rail is this Studio's signature — scanning a column of colour is far
 * faster than reading status text one card at a time across a dozen devices.
 */
export function DeviceCard({
  device,
  runningJob,
  onReleaseQuarantine,
}: {
  device: DeviceInfo
  runningJob?: JobInfo | null
  onReleaseQuarantine?: () => void
}) {
  const offline = device.status === 'offline'
  const hot = device.battery && device.battery.temperatureC >= 45
  const lowBattery = device.battery && device.battery.level < 20

  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-lg border bg-surface transition-colors',
        offline ? 'opacity-60' : 'hover:border-line-strong',
      )}
    >
      <span
        className="status-rail"
        data-status={device.status}
        data-live={device.status === 'busy' ? 'true' : 'false'}
        aria-hidden
      />

      <div className="space-y-3 p-4 pl-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="truncate text-[14px] font-semibold tracking-tight">{device.label}</h3>
            <p className="readout mt-0.5 truncate text-[11px] text-fg-subtle">{device.serial}</p>
          </div>
          <DeviceStatusBadge status={device.status} />
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11.5px]">
          <div className="flex justify-between gap-2">
            <dt className="text-fg-subtle">Android</dt>
            <dd className="readout">
              {device.androidVersion ?? '—'}
              {device.apiLevel ? ` · ${device.apiLevel}` : ''}
            </dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-fg-subtle">Screen</dt>
            <dd className="readout">
              {device.screenW && device.screenH ? `${device.screenW}×${device.screenH}` : '—'}
            </dd>
          </div>
          {device.battery && (
            <>
              <div className="flex items-center justify-between gap-2">
                <dt className="flex items-center gap-1 text-fg-subtle">
                  <Battery className="size-3" aria-hidden /> Battery
                </dt>
                <dd className={cn('readout', lowBattery && 'text-led-warn')}>
                  {device.battery.level}%
                  {device.battery.status === 'charging' && (
                    <span className="ml-1 text-fg-subtle">charging</span>
                  )}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="flex items-center gap-1 text-fg-subtle">
                  <Thermometer className="size-3" aria-hidden /> Temp
                </dt>
                <dd className={cn('readout', hot && 'text-led-danger')}>
                  {device.battery.temperatureC.toFixed(1)}°C
                </dd>
              </div>
            </>
          )}
        </dl>

        {/* A busy device explains WHY it cannot be used right now. */}
        {device.status === 'busy' && runningJob && (
          <Link
            href={`/jobs/detail?id=${runningJob.jobId}`}
            className="block rounded border border-led-active/30 bg-led-active/5 px-2.5 py-1.5 text-[11.5px] hover:border-led-active/50"
          >
            Running a job — view details
          </Link>
        )}

        {/* Quarantine shows the reason and the way out in the same place. */}
        {device.status === 'quarantined' && (
          <div className="rounded border border-led-danger/30 bg-led-danger/5 px-2.5 py-2">
            <p className="text-[11.5px] text-led-danger">
              {device.quarantineReason
                ? `Pulled from the queue: ${explainQuarantine(device.quarantineReason)}`
                : 'Pulled from the queue, with no reason recorded.'}
            </p>
            {onReleaseQuarantine && (
              <Button variant="outline" size="sm" className="mt-2 h-7 text-[11.5px]" onClick={onReleaseQuarantine}>
                Return to queue
              </Button>
            )}
          </div>
        )}

        {/* An offline device gets a genuinely disabled button, not a link that
            looks dead but is still clickable. */}
        <div className="flex gap-2 pt-0.5">
          {offline ? (
            <>
              <Button size="sm" variant="secondary" className="h-8 flex-1 text-[12px]" disabled>
                <ScreenShare className="size-3.5" aria-hidden />
                Control
              </Button>
              <Button size="sm" variant="ghost" className="h-8 text-[12px]" disabled>
                <Play className="size-3.5" aria-hidden />
                Run
              </Button>
            </>
          ) : (
            <>
              <Button asChild size="sm" variant="secondary" className="h-8 flex-1 text-[12px]">
                <Link href={`/device?id=${encodeURIComponent(device.id)}`}>
                  <ScreenShare className="size-3.5" aria-hidden />
                  Control
                </Link>
              </Button>
              <Button asChild size="sm" variant="ghost" className="h-8 text-[12px]">
                <Link href={`/scripts?device=${encodeURIComponent(device.id)}`}>
                  <Play className="size-3.5" aria-hidden />
                  Run
                </Link>
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/** `thermal:49.8C` is not a sentence — turn it into something readable. */
function explainQuarantine(reason: string): string {
  const thermal = /^thermal:([\d.]+)C$/.exec(reason)
  if (thermal) return `temperature reached ${thermal[1]}°C`
  return reason
}
