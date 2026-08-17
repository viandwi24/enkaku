import { TriangleAlert } from 'lucide-react'
import type { AgentState } from '@enkaku/protocol'
import { cn } from '@enkaku/ui'

/**
 * A fleet-card/wall-tile chip for the guest agent's coarse state
 * (`DeviceInfo.agent`, plan 90 §4.7) — deliberately quiet for the common
 * case. `ready` and `absent` render nothing: a healthy or never-provisioned
 * agent is not news, and a farm of twenty phones must not grow twenty chips
 * for a state nobody needs to act on (plan 90 §5 step 90.6's own words).
 * Only `failed` and `outdated` — the two states an operator can actually do
 * something about — earn a chip; `provisioning` and `unsupported` stay
 * quiet too (a pass in flight resolves itself, and a floor is not
 * actionable).
 *
 * Reads the SAME narrow `DeviceInfo.agent` field `DeviceHeader`'s chip and
 * `AgentPanel`'s full detail both trace back to — no per-card fetch, which
 * is exactly why that field is a bare enum rather than the full
 * `AgentStatus` (its own doc comment in `packages/protocol/src/device.ts`).
 */
export function AgentAlertChip({ agent, className }: { agent: AgentState; className?: string }) {
  if (agent !== 'failed' && agent !== 'outdated') return null

  const label = agent === 'failed' ? 'Agent failed' : 'Agent outdated'
  const tone = agent === 'failed' ? 'text-led-danger border-led-danger/40 bg-led-danger/10' : 'text-led-warn border-led-warn/35 bg-led-warn/10'

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-none',
        tone,
        className,
      )}
      title={agent === 'failed' ? 'The guest agent could not be installed or reached — the device itself still works.' : 'A newer guest agent build is pinned — update it from the Agent tab.'}
    >
      <TriangleAlert className="size-2.5" aria-hidden />
      {label}
    </span>
  )
}
