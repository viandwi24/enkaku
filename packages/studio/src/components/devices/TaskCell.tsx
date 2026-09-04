import { Badge } from '@enkaku/ui'
import type { DeviceActivity, DeviceInfo } from '@enkaku/protocol'

/**
 * The handoff's four Task variants (README, Table view), driven by the
 * activity list (MVP 15 §3 step 3: "Task is the activity list"):
 *
 *   script running -> `var(--accent-soft)`/`var(--accent)`   Badge variant="default"
 *   system action  -> `var(--warn-soft)`/`var(--warn)`       Badge variant="warn"
 *   queued         -> `var(--muted-2)`/`var(--dim)`          Badge variant="secondary"
 *   idle           -> plain `var(--faint-2)` text, no pill   Badge variant="ghost"
 *
 * `control` is deliberately NOT a Task: someone driving a phone is expressed
 * by the amber status dot (plan 214 §4.5), and showing it twice would make a
 * controlled idle device read as busy.
 */
const SCRIPT_KINDS = new Set<DeviceActivity['kind']>(['job', 'workflow-job'])

export function taskLabelOf(device: Pick<DeviceInfo, 'activities'>, queued: number): string {
  const script = device.activities.find((a) => SCRIPT_KINDS.has(a.kind))
  if (script) return script.label
  const system = device.activities.find((a) => a.kind !== 'control')
  if (system) return system.label
  if (queued > 0) return `Queued (${queued})`
  return 'Idle'
}

export function TaskCell({ device, queued }: { device: DeviceInfo; queued: number }) {
  const script = device.activities.find((a) => SCRIPT_KINDS.has(a.kind))
  const system = device.activities.find((a) => a.kind !== 'control')
  const variant = script ? 'default' : system ? 'warn' : queued > 0 ? 'secondary' : 'ghost'
  return (
    <span className="min-w-0 px-2">
      <Badge variant={variant} className="max-w-full truncate">
        {taskLabelOf(device, queued)}
      </Badge>
    </span>
  )
}
