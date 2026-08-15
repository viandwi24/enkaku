import { z } from 'zod'

/**
 * Progress of the shared adb server's drain → stop → [swap] → start →
 * reattach → reconcile cycle (plan 88 §3.10, §4.8) — broadcast once per
 * phase so twenty devices dropping together reads as ONE farm-wide banner
 * rather than twenty separate offline toasts. Two callers share this exact
 * phase set: the Toolchain Manager's adb version swap (`reason: 'swap'`) and
 * the operator's "Restart adb server" button on the Tools page (`reason:
 * 'restart'`) — both go through `packages/core/src/tools/adb-server-control.ts`,
 * the one file in the workspace that runs the server-stop command (spec
 * §10.4, plan 88 §3.10).
 */
export const AdbServerPhaseSchema = z.enum([
  'draining',
  'stopping',
  'swapping',
  'starting',
  'reattaching',
  'reconciling',
  'done',
  'failed',
])
export type AdbServerPhase = z.infer<typeof AdbServerPhaseSchema>

export const AdbServerPhaseMessage = z.object({
  type: z.literal('adb.server.phase'),
  payload: z.object({
    phase: AdbServerPhaseSchema,
    reason: z.enum(['swap', 'restart']),
    detail: z.string(),
  }),
})
export type AdbServerPhaseEvent = z.infer<typeof AdbServerPhaseMessage>
