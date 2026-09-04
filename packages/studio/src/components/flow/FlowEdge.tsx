'use client'

import { BaseEdge, EdgeLabelRenderer, getBezierPath, type Edge, type EdgeProps } from '@xyflow/react'
import { Plus } from 'lucide-react'
import { cn } from '@enkaku/ui'
import type { EdgeKind } from './doc-edit'

/**
 * One edge, with a `+` affordance at its midpoint (plan 305 §3.6, §4.1) —
 * clicking it opens the palette wired to `insert-on-edge` for this exact
 * edge, one of P2's three ways to add a node. Backward edges (an explicit
 * `goto` that jumps to an earlier-or-equal node, plan 102 G5) stay styled
 * distinctly (dashed, warn-coloured) — still the single most valuable
 * thing the canvas shows that a list ever could (plan 102 §4.2).
 */

export interface FlowEdgeData extends Record<string, unknown> {
  kind: EdgeKind
  label: string
  backward: boolean
  editable: boolean
  onInsert?: (from: string, kind: EdgeKind, x: number, y: number) => void
}

export function FlowEdge({ id, source, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, markerEnd }: EdgeProps<Edge<FlowEdgeData>>) {
  const [edgePath, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition })
  const backward = data?.backward ?? false

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={backward ? { stroke: 'var(--color-led-warn)', strokeDasharray: '5 4' } : { stroke: 'var(--color-line-strong)' }}
      />
      <EdgeLabelRenderer>
        <div
          style={{ position: 'absolute', transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`, pointerEvents: 'all' }}
          className="nodrag nopan flex items-center gap-1"
        >
          {data?.label && <span className="rack-label rounded bg-surface px-1 py-0.5 text-fg-muted">{data.label}</span>}
          {data?.editable && data.onInsert && (
            <button
              type="button"
              aria-label="Insert a node on this edge"
              title="Insert a node here"
              onClick={() => data.onInsert?.(source, data.kind, labelX, labelY)}
              className={cn('flex size-4 items-center justify-center rounded-full border bg-surface text-fg-subtle hover:border-accent hover:text-accent')}
            >
              <Plus className="size-2.5" aria-hidden />
            </button>
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  )
}

export const FLOW_EDGE_TYPES = { flowEdge: FlowEdge }
