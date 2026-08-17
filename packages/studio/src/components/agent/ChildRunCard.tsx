import Link from 'next/link'
import { ChevronRight, SquareArrowOutUpRight } from 'lucide-react'
import type { AgentTreeNode } from '@enkaku/protocol'
import { AgentAvatar } from './AgentAvatar'
import { Badge } from '@enkaku/ui'

function elapsedLabel(node: AgentTreeNode): string {
  if (!node.startedAt) return '—'
  const endSec = node.finishedAt ?? Math.floor(Date.now() / 1000)
  const secs = Math.max(0, endSec - node.startedAt)
  if (secs < 60) return `${secs}s`
  return `${Math.floor(secs / 60)}m ${secs % 60}s`
}

/**
 * A spawned child, rendered as a nested run (plan 69 §3.2, step 69.3) — "the
 * child's own transcript, collapsed, with its status and elapsed time, so
 * the tree is the transcript rather than a separate diagram to correlate by
 * hand." This is the summary row ONLY: a toggle button, not a link, so
 * expanding it is the caller's job — `Transcript` renders itself again,
 * recursively, for the child's own live thread when `expanded` (see its own
 * "Sub-agents" section). Kept import-free of `Transcript` on purpose: that
 * self-reference lives in ONE file, avoiding a circular module dependency
 * between this component and the one that already imports it.
 *
 * The outbound `next/link` icon opens the child's full workbench tab
 * (context panel, settings, its own further descendants) — expanding here
 * is for watching it live inline, not a replacement for that. It is a
 * SIBLING of the toggle button, not nested inside it — `<a>` inside
 * `<button>` is invalid HTML and behaves unpredictably.
 */
export function ChildRunCard({ node, agentColour, expanded, onToggle }: { node: AgentTreeNode; agentColour?: string | null; expanded: boolean; onToggle: () => void }) {
  const terminal = node.status === 'succeeded' || node.status === 'failed' || node.status === 'cancelled'
  return (
    <div className="flex items-center gap-1 rounded-md border bg-surface pr-2 text-[12px]">
      <button type="button" onClick={onToggle} className="flex min-w-0 flex-1 items-center justify-between gap-2 px-2.5 py-1.5 text-left" aria-expanded={expanded}>
        <span className="flex min-w-0 items-center gap-1.5">
          <ChevronRight className={`size-3 shrink-0 text-fg-subtle transition-transform ${expanded ? 'rotate-90' : ''}`} aria-hidden />
          <AgentAvatar name={node.agentName} colour={agentColour} size="sm" />
          <span className="truncate font-medium text-fg">{node.agentName}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5 text-fg-subtle">
          {node.drivingDeviceIds.length > 0 && <span className="readout">{node.drivingDeviceIds.length} device{node.drivingDeviceIds.length === 1 ? '' : 's'}</span>}
          <Badge variant={node.status === 'failed' ? 'destructive' : terminal ? 'secondary' : 'default'}>{node.status}</Badge>
          <span className="readout">{node.steps} steps</span>
          <span className="readout">{elapsedLabel(node)}</span>
        </span>
      </button>
      <Link
        href={`/agents/detail?id=${node.agentId}&thread=${node.threadId}`}
        className="shrink-0 text-fg-subtle hover:text-accent"
        aria-label={`Open ${node.agentName}'s full workbench`}
        title="Open in its own workbench tab"
      >
        <SquareArrowOutUpRight className="size-3" aria-hidden />
      </Link>
    </div>
  )
}
