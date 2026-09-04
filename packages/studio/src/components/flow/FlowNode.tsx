'use client'

import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import type { WorkflowNode } from '@enkaku/protocol'
import { cn } from '@enkaku/ui'
import { pluginIcon } from '@/lib/plugin-icons'
import type { EdgeKind } from './doc-edit'

/**
 * One node's card on the canvas (plan 305 §4.4) — 220×64, per `layout.ts`'s
 * existing rank spacing (240×130), so an upgraded document opens unchanged.
 * States: selected (accent ring), unreachable (50% opacity), has-error
 * finding (`led-danger` ring), has-warning finding (`led-warn` ring),
 * pinned (plan 304's own field — not yet on the document this plan builds
 * against; the badge is wired but never fires until 304's schema lands),
 * not-installed (dashed border, raw ref shown).
 */

export interface FlowNodeData extends Record<string, unknown> {
  node: WorkflowNode
  icon: string
  summaryText: string
  unreachable: boolean
  errorCount: number
  warningCount: number
  notInstalled: boolean
  editable: boolean
}

const KIND_LABEL: Record<WorkflowNode['kind'], string> = {
  start: 'Start',
  script: 'Script',
  gate: 'Gate',
  switch: 'Switch',
  delay: 'Delay',
  finish: 'Finish',
}

/** One source `Handle` per edge kind the node owns, positioned so a `then`/`next`/`case:0` sits on the right and a secondary/failure edge sits lower — mirrors `WorkflowCanvas.tsx`'s pre-305 handle layout (plan 102 step 102.5), extended to `switch`'s N cases and `delay`'s single `next`. */
function outputHandles(node: WorkflowNode): { kind: EdgeKind; title: string; y: number }[] {
  switch (node.kind) {
    case 'start':
    case 'delay':
      return [{ kind: 'next', title: 'Drag to set what runs next', y: 50 }]
    case 'script':
      return [
        { kind: 'next', title: 'Drag to set what runs next', y: 35 },
        { kind: 'onFailure', title: 'Drag to set what runs on failure', y: 65 },
      ]
    case 'gate':
      return [
        { kind: 'then', title: 'Drag to set where "then" goes', y: 35 },
        { kind: 'else', title: 'Drag to set where "else" goes', y: 65 },
      ]
    case 'switch': {
      const n = node.cases.length + 1
      return [
        ...node.cases.map((c, i) => ({ kind: `case:${i}` as const, title: c.label || `case ${i + 1}`, y: ((i + 1) * 100) / (n + 1) })),
        { kind: 'default' as const, title: 'default', y: (n * 100) / (n + 1) },
      ]
    }
    case 'finish':
      return []
  }
}

export function FlowNode({ data, selected }: NodeProps<Node<FlowNodeData>>) {
  const { node, icon, summaryText, unreachable, errorCount, warningCount, notInstalled, editable } = data
  const Icon = pluginIcon(icon)
  const handles = outputHandles(node)

  return (
    <div
      data-testid={`flow-node-${node.id}`}
      className={cn(
        'relative flex h-16 w-[220px] flex-col justify-center gap-0.5 rounded-lg border-2 bg-surface px-3 py-1.5 text-[12.5px] shadow-md',
        node.kind === 'gate' || node.kind === 'switch' ? 'border-led-warn' : node.kind === 'finish' ? 'border-line-strong' : 'border-accent',
        selected && 'ring-2 ring-accent ring-offset-2 ring-offset-bg',
        unreachable && 'opacity-50',
        notInstalled && 'border-dashed',
        errorCount > 0 && 'ring-2 ring-led-danger',
        errorCount === 0 && warningCount > 0 && 'ring-2 ring-led-warn',
      )}
    >
      {node.kind !== 'start' && (
        <Handle type="target" id="target" position={Position.Left} isConnectable={editable} className="!h-2.5 !w-2.5 !border-2 !border-line-strong !bg-surface" />
      )}

      <div className="flex min-w-0 items-center gap-1.5">
        <Icon className="size-3.5 shrink-0 text-fg-muted" aria-hidden />
        <span className="min-w-0 flex-1 truncate font-medium text-fg">{node.title.trim() || KIND_LABEL[node.kind]}</span>
        {(errorCount > 0 || warningCount > 0) && (
          <span
            title={`${errorCount} error(s), ${warningCount} warning(s)`}
            className={cn('rack-label shrink-0 rounded px-1 py-0.5', errorCount > 0 ? 'bg-led-danger/20 text-led-danger' : 'bg-led-warn/20 text-led-warn')}
          >
            {errorCount > 0 ? errorCount : warningCount}
          </span>
        )}
      </div>
      <p className="truncate text-[11px] text-fg-subtle">{notInstalled ? 'not installed' : summaryText || KIND_LABEL[node.kind]}</p>
      {unreachable && (
        <span title="No node in this workflow reaches this one" className="rack-label absolute -top-2 right-1 rounded bg-led-danger/20 px-1 py-0.5 text-led-danger">
          unreachable
        </span>
      )}

      {handles.map((h) => (
        <Handle
          key={h.kind}
          type="source"
          id={h.kind}
          position={Position.Right}
          isConnectable={editable}
          title={h.title}
          style={{ top: `${h.y}%` }}
          className={cn('!h-2.5 !w-2.5 !border-2 !bg-surface', h.kind === 'next' || h.kind.startsWith('case:') ? '!border-accent' : '!border-led-warn')}
        />
      ))}
    </div>
  )
}

export const FLOW_NODE_TYPES = { flowNode: FlowNode }
