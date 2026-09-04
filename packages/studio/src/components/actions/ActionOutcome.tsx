import Link from 'next/link'
import type { ActionResult, DeviceInfo } from '@enkaku/protocol'
import { Badge, DeviceName, StatusDot, coreBase } from '@enkaku/ui'
import { dotStateOf } from '@/components/devices/device-state'
import { groupResults } from '@/lib/actions'

const MAX_ROWS = 50

const STATUS_VARIANT: Record<ActionResult['status'], 'default' | 'secondary' | 'ghost' | 'warn' | 'destructive'> = {
  done: 'default',
  accepted: 'secondary',
  skipped: 'ghost',
  warned: 'warn',
  forbidden: 'destructive',
  failed: 'destructive',
}

function messageTone(status: ActionResult['status']): string {
  if (status === 'failed' || status === 'forbidden') return 'text-danger'
  if (status === 'warned') return 'text-warn'
  return 'text-faint'
}

/**
 * One renderer for `ActionResult[]`, used by every verb dialog (§4.5). It
 * replaces plan 207's placeholder `components/actions/ActionResults.tsx`,
 * whose own comment says "plan 216 replaces it with the design handoff's own
 * chips."
 */
export function ActionOutcome({ results, devices, className }: { results: readonly ActionResult[]; devices: readonly DeviceInfo[]; className?: string }) {
  const grouped = groupResults([...results])
  const settled = grouped.done.length + grouped.failed.length + grouped.forbidden.length + grouped.skipped.length
  const refused = grouped.failed.length + grouped.forbidden.length
  const byId = new Map(devices.map((d) => [d.id, d] as const))
  const shown = results.slice(0, MAX_ROWS)
  const overflow = results.length - shown.length

  return (
    <div className={className}>
      <p className="text-meta text-faint">
        {grouped.done.length} done · {refused} refused · {grouped.skipped.length} skipped ({settled}/{results.length})
      </p>
      <ul className="mt-2 space-y-1">
        {shown.map((result) => {
          const device = byId.get(result.deviceId)
          const detail = result.detail as { artifactId?: string } | undefined
          return (
            <li key={result.deviceId} className="flex w-full items-start gap-2.5 rounded-button px-[10px] py-[9px] text-row">
              {device && <StatusDot state={dotStateOf(device)} />}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  {device ? <DeviceName number={device.number} label={device.label} /> : <span>{result.deviceId}</span>}
                  <Badge variant={STATUS_VARIANT[result.status]}>{result.status}</Badge>
                  {result.jobId && (
                    <Link href={`/jobs/detail?id=${result.jobId}`} className="text-tip text-accent hover:underline">
                      job
                    </Link>
                  )}
                  {detail?.artifactId && (
                    <a href={`${coreBase()}/api/artifacts/${detail.artifactId}/download`} className="text-tip text-accent hover:underline">
                      download
                    </a>
                  )}
                </div>
                {result.message && <p className={`text-meta ${messageTone(result.status)}`}>{result.message}</p>}
              </div>
            </li>
          )
        })}
      </ul>
      {overflow > 0 && <p className="mt-1 text-meta text-faint">… and {overflow} more</p>}
    </div>
  )
}
