import type { ActivityActor } from '@enkaku/protocol'
import type { ActivityRegistry } from '../../activity/registry'
import type { EventRecorder } from '../../events/recorder'
import type { ShellPort } from '../../device/shell-port'
import { redactShellCommand } from '../../device/redact'

export interface ShellRunResult {
  exitCode: number | null
  stdout: string
  stderr: string
  truncated: boolean
  durationMs: number
}

/**
 * The `adb` verb's one operation, and `clear-cache`'s (a specific `cmd`) —
 * a `command` activity per device, an event write matching `shell.exec`'s
 * own (`ws-handlers.ts:1403-1425`).
 */
export async function runShellCommand(
  deps: {
    activities: Pick<ActivityRegistry, 'start' | 'end'>
    shellPortFor: (deviceId: string) => ShellPort
    record?: EventRecorder['record']
  },
  deviceId: string,
  operationId: string,
  cmd: string,
  opts: { timeoutMs: number; maxOutputBytes: number; actor: ActivityActor },
): Promise<ShellRunResult> {
  const activityId = `command:${operationId}:${deviceId}`
  deps.activities.start(deviceId, { id: activityId, kind: 'command', label: 'Running an adb command', actor: opts.actor })
  const startedAt = Date.now()
  try {
    const port = deps.shellPortFor(deviceId)
    const result = await port.exec(cmd, { timeoutMs: opts.timeoutMs, maxOutputBytes: opts.maxOutputBytes })
    const durationMs = Date.now() - startedAt
    deps.record?.({
      deviceId,
      stream: 'input',
      kind: 'shell.exec',
      actor: opts.actor.id,
      meta: { cmd: redactShellCommand(cmd) },
    })
    return { ...result, durationMs }
  } finally {
    deps.activities.end(deviceId, activityId)
  }
}
