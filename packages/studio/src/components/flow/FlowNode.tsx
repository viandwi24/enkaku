'use client'

import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import type { WorkflowNode } from '@enkaku/protocol'
import { CircleIcon, cn } from '@enkaku/ui'
import { pluginIcon } from '@/lib/plugin-icons'
import type { EdgeKind } from './doc-edit'
import type { RunNodeState } from './useRunState'

/**
 * One node's card on the canvas (plan 305 §4.4, badge wired by plan 306
 * §4.2 step 306.7) — 220×64, per `layout.ts`'s existing rank spacing
 * (240×130), so an upgraded document opens unchanged. States: selected
 * (accent ring), unreachable (50% opacity), has-error finding
 * (`led-danger` ring), has-warning finding (`led-warn` ring), pinned (plan
 * 300 P10 — a filled dot badge; there is no pin-shaped icon in
 * `@enkaku/ui`'s exported set, and this plan may not add one — see the
 * handoff report's substitution note), not-installed (dashed border, raw
 * ref shown).
 */

export interface FlowNodeData extends Record<string, unknown> {
  node: WorkflowNode
  icon: string
  summaryText: string
  unreachable: boolean
  errorCount: number
  warningCount: number
  notInstalled: boolean
  pinned: boolean
  editable: boolean
  /** Plan 307 §4.2 — the run overlay's own state for this node, or `undefined` outside a run view (pending is the implicit fourth state: no ring, no badge). */
  run?: RunNodeState
}

const KIND_LABEL: Record<WorkflowNode['kind'], string> = {
  start: 'Start',
  script: 'Script',
  gate: 'Gate',
  switch: 'Switch',
  delay: 'Delay',
  finish: 'Finish',
  set: 'Set',
  shuffle: 'Shuffle',
}

/** One source `Handle` per edge kind the node owns, positioned so a `then`/`next`/`case:0` sits on the right and a secondary/failure edge sits lower — mirrors `WorkflowCanvas.tsx`'s pre-305 handle layout (plan 102 step 102.5), extended to `switch`'s N cases and `delay`'s single `next`. */
function outputHandles(node: WorkflowNode): { kind: EdgeKind; title: string; y: number }[] {
  switch (node.kind) {
    case 'start':
    case 'delay':
    case 'set':
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
    case 'shuffle': {
      // One handle per member plus `next` — the same "N cases plus default"
      // layout a `switch` uses, for the same reason: every branch the node
      // can take is visible on the canvas rather than hidden in its config.
      const n = node.members.length + 1
      return [
        ...node.members.map((m, i) => ({ kind: `member:${m}` as const, title: `member ${i + 1}: ${m}`, y: ((i + 1) * 100) / (n + 1) })),
        { kind: 'next' as const, title: 'Drag to set what runs after every member', y: (n * 100) / (n + 1) },
      ]
    }
    case 'finish':
      return []
  }
}

export function FlowNode({ data, selected }: NodeProps<Node<FlowNodeData>>) {
  const { node, icon, summaryText, unreachable, errorCount, warningCount, notInstalled, pinned, editable, run } = data
  const Icon = pluginIcon(icon)
  const handles = outputHandles(node)

  return (
    <div
      data-testid={`flow-node-${node.id}`}
      title={run?.status === 'failed' && run.error ? run.error : undefined}
      style={run?.status === 'running' ? { boxShadow: '0 0 0 4px var(--color-accent-soft)' } : undefined}
      className={cn(
        'relative flex h-16 w-[220px] flex-col justify-center gap-0.5 rounded-lg border-2 bg-panel px-3 py-1.5 text-[12.5px] shadow-md',
        node.kind === 'gate' || node.kind === 'switch' ? 'border-warn' : node.kind === 'finish' ? 'border-border-3' : 'border-accent',
        selected && 'ring-2 ring-accent ring-offset-2 ring-offset-bg',
        unreachable && 'opacity-50',
        // Plan 313 §3.4 — a node the author switched off. Dimmed and dashed
        // so it is visibly still THERE (it keeps its parameters and its
        // edges) but visibly not running, which is the whole difference
        // between switching a node off and deleting it.
        !node.enabled && 'opacity-40 border-dashed',
        notInstalled && 'border-dashed',
        errorCount > 0 && 'ring-2 ring-danger',
        errorCount === 0 && warningCount > 0 && 'ring-2 ring-warn',
        // Plan 307 §4.2, P11 — the run overlay's own rings, drawn ONLY when a
        // `run` state is handed down (the editor's own error/warning rings
        // above stay authoritative when it is not, e.g. no run has happened
        // yet). `skipped` and `running`'s opacity/pulse read at a glance
        // without needing the badge below.
        run?.status === 'running' && 'ring-2 ring-accent animate-pulse',
        run?.status === 'ok' && 'ring-2 ring-accent',
        run?.status === 'failed' && 'ring-2 ring-danger',
        run?.status === 'skipped' && 'opacity-40',
      )}
    >
      {node.kind !== 'start' && (
        <Handle type="target" id="target" position={Position.Left} isConnectable={editable} className="!h-2.5 !w-2.5 !border-2 !border-border-3 !bg-panel" />
      )}

      <div className="flex min-w-0 items-center gap-1.5">
        <Icon className="size-3.5 shrink-0 text-dim" aria-hidden />
        <span className="min-w-0 flex-1 truncate font-medium text-text">{node.title.trim() || KIND_LABEL[node.kind]}</span>
        {(errorCount > 0 || warningCount > 0) && (
          <span
            title={`${errorCount} error(s), ${warningCount} warning(s)`}
            className={cn('rack-label shrink-0 rounded px-1 py-0.5', errorCount > 0 ? 'bg-danger/20 text-danger' : 'bg-warn/20 text-warn')}
          >
            {errorCount > 0 ? errorCount : warningCount}
          </span>
        )}
      </div>
      <p className="truncate text-[11px] text-faint">{!node.enabled ? 'off' : notInstalled ? 'not installed' : summaryText || KIND_LABEL[node.kind]}</p>
      {run && (run.status === 'ok' || run.status === 'failed' || run.status === 'running') && (
        <span
          title={`step #${run.seq + 1}${run.status === 'failed' && run.error ? ` — ${run.error}` : ''}`}
          className={cn(
            'absolute -top-2 -right-2 flex items-center justify-center rounded-full px-1 py-0.5 text-badge font-semibold',
            run.status === 'failed' ? 'bg-danger text-white' : 'bg-accent text-white',
          )}
        >
          #{run.seq + 1}
        </span>
      )}
      {pinned && (
        <span title="Pinned — downstream nodes use this output instead of touching the device" className="absolute -top-2 -left-2 flex items-center gap-0.5 rounded bg-ok/20 px-1 py-0.5 text-ok">
          <CircleIcon weight="fill" className="size-2" aria-hidden />
          <span className="rack-label">pinned</span>
        </span>
      )}
      {unreachable && (
        <span title="No node in this workflow reaches this one" className="rack-label absolute -top-2 right-1 rounded bg-danger/20 px-1 py-0.5 text-danger">
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
          className={cn('!h-2.5 !w-2.5 !border-2 !bg-panel', h.kind === 'next' || h.kind.startsWith('case:') ? '!border-accent' : '!border-warn')}
        />
      ))}
    </div>
  )
}

export const FLOW_NODE_TYPES = { flowNode: FlowNode }
