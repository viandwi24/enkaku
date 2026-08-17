'use client'

import type { AgentApproval } from '@enkaku/protocol'
import { AgentAvatar } from './AgentAvatar'
import { Button, relativeTime } from '@enkaku/ui'

export interface ApprovalCardContext {
  agentName: string
  agentColour: string | null
  deviceLabel?: string | null
  threadTitle?: string | null
}

/**
 * A paused destructive call, at full width (plan 69 §3.3, criterion 7) — the
 * exact input is the detection mechanism for prompt injection, an operator
 * noticing an install of a package nobody mentioned. It is NEVER truncated:
 * a long input scrolls inside its own box instead of being elided.
 *
 * Shared between the inline approval in `Transcript` (no `context`, since the
 * thread already names its own agent) and `/agents/approvals` (`context` set,
 * because the inbox spans every agent at once).
 */
export function ApprovalCard({
  approval,
  context,
  onDecide,
  pendingDecision,
}: {
  approval: AgentApproval
  context?: ApprovalCardContext
  onDecide(decision: 'approve' | 'deny'): void
  pendingDecision: 'approve' | 'deny' | null
}) {
  const now = Math.floor(Date.now() / 1000)
  const expiresIn = approval.expiresAt - now

  return (
    <div className="w-full rounded-lg border border-led-warn/40 bg-led-warn/10 px-3 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          {context && <AgentAvatar name={context.agentName} colour={context.agentColour} size="sm" />}
          <p className="text-[12.5px] font-medium">
            {context && <span className="text-fg">{context.agentName} · </span>}
            Approval requested — <span className="readout">{approval.capabilityId}</span>
          </p>
        </div>
        <span className="readout shrink-0 text-[11px] text-fg-muted" title={new Date(approval.createdAt * 1000).toLocaleString()}>
          {relativeTime(approval.createdAt)} · expires {expiresIn > 0 ? `in ${Math.max(1, Math.round(expiresIn / 60))}m` : 'soon'}
        </span>
      </div>

      {context?.deviceLabel && <p className="mt-1 text-[11.5px] text-fg-muted">device: {context.deviceLabel}</p>}
      {context?.threadTitle && <p className="text-[11.5px] text-fg-muted">thread: {context.threadTitle}</p>}

      {/* The COMPLETE input, never truncated (criterion 7) — long content scrolls inside its own
          box rather than being elided with an ellipsis, because that is exactly where an injected
          instruction would hide. */}
      <pre className="readout mt-2 max-h-64 w-full overflow-auto whitespace-pre-wrap break-words rounded bg-bg px-2.5 py-2 text-[11.5px] text-fg">
        {JSON.stringify(approval.input, null, 2)}
      </pre>

      {approval.status === 'pending' ? (
        <div className="mt-2.5 flex gap-2">
          <Button size="sm" disabled={pendingDecision !== null} onClick={() => onDecide('approve')}>
            {pendingDecision === 'approve' ? 'Approving…' : 'Approve'}
          </Button>
          <Button size="sm" variant="outline" disabled={pendingDecision !== null} onClick={() => onDecide('deny')}>
            {pendingDecision === 'deny' ? 'Denying…' : 'Deny'}
          </Button>
        </div>
      ) : (
        <p className="mt-2 text-[11.5px] text-fg-muted">
          {approval.status} {approval.decidedBy ? `by ${approval.decidedBy}` : ''}
        </p>
      )}
    </div>
  )
}
