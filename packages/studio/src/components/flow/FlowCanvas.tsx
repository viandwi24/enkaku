'use client'

import { useCallback, useMemo } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { GitBranch, Workflow as WorkflowIcon } from 'lucide-react'
import { cn } from '@enkaku/ui'
import { connectionToEdgeChange, type EdgeChange } from './canvas-edit'
import { deriveGraph, type EdgeKind } from './derive-graph'
import { computeLayout } from './compute-layout'
import type { WorkflowDocDraft } from './model'

/**
 * Plan 102 (M67) §3.1, §3.2, §4.1, step 102.2/102.3/102.5 — the canvas.
 * `@xyflow/react` (React Flow v12) supplies pan/zoom/minimap/hit-testing
 * AND (step 102.5) connection dragging and edge reconnection; this
 * component's only job is turning `deriveGraph`/`computeLayout`'s pure
 * output into that library's controlled `nodes`/`edges` props, and turning
 * a completed connection/reconnection/deletion BACK into an `EdgeChange`
 * for the caller — never holding edge state of its own (§3.3: an edge is a
 * projection, never independent state). Node POSITION is never written
 * back either (§3.2: layout is computed on open, not stored) — dragging a
 * node to reposition it is still disabled; only the edges are editable.
 * Selecting a node fires `onSelectNode`, which the caller (§3.5) wires to
 * the SAME node editor the list editor already uses — nothing here renders
 * a form of its own.
 */

const NODE_KIND_COLOR: Record<'script' | 'gate', string> = {
  script: 'border-accent bg-surface-2 text-fg',
  gate: 'border-led-warn bg-surface-2 text-fg',
}

/**
 * Step 102.5 — one node exposes a `target` handle (incoming edges, from
 * anywhere) plus one or two named SOURCE handles, one per `EdgeKind` it can
 * actually own (`canvas-edit.ts`'s `ownsEdgeKind`): a script node gets
 * `next` (right, the ordinary path) and `onFailure` (bottom, styled like a
 * backward/warn edge since it is the failure path); a gate gets `then`
 * (right) and `else` (bottom). The handle's `id` IS the `EdgeKind` string —
 * `connectionToEdgeChange` reads it straight off the library's own
 * `Connection.sourceHandle`, so there is no separate id-to-kind table to
 * keep in sync.
 */
const PRIMARY_KIND: Record<'script' | 'gate', EdgeKind> = { script: 'next', gate: 'then' }
const SECONDARY_KIND: Record<'script' | 'gate', EdgeKind> = { script: 'onFailure', gate: 'else' }

function WorkflowGraphNode({ data, selected }: NodeProps<Node<{ label: string; kind: 'script' | 'gate'; unreachable: boolean; editable: boolean }>>) {
  const Icon = data.kind === 'gate' ? GitBranch : WorkflowIcon
  return (
    <div
      className={cn(
        'relative flex min-w-40 items-center gap-2 rounded-lg border-2 px-3 py-2 text-[12.5px] shadow-md',
        NODE_KIND_COLOR[data.kind],
        selected && 'ring-2 ring-accent ring-offset-2 ring-offset-bg',
        data.unreachable && 'opacity-60',
      )}
    >
      {/* `isConnectable` is a HANDLE-level prop, not inherited from the node's own `connectable` — passed explicitly here from `data.editable` so a read-only canvas (no `onEdgeChange`) truly cannot start or receive a drag on any handle, not merely lacks a caller to hand the result to. */}
      <Handle
        type="target"
        id="target"
        position={Position.Left}
        isConnectable={data.editable}
        className="!h-2.5 !w-2.5 !border-2 !border-line-strong !bg-surface"
      />
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 truncate">{data.label}</span>
      {data.unreachable && (
        <span title="No node in this workflow reaches this one" className="rack-label shrink-0 rounded bg-led-danger/20 px-1 py-0.5 text-led-danger">
          unreachable
        </span>
      )}
      <Handle
        type="source"
        id={PRIMARY_KIND[data.kind]}
        position={Position.Right}
        isConnectable={data.editable}
        title={data.kind === 'gate' ? 'Drag to set where "then" goes' : 'Drag to set what runs next'}
        className="!h-2.5 !w-2.5 !border-2 !border-accent !bg-surface"
      />
      <Handle
        type="source"
        id={SECONDARY_KIND[data.kind]}
        position={Position.Bottom}
        isConnectable={data.editable}
        title={data.kind === 'gate' ? 'Drag to set where "else" goes' : 'Drag to set what runs on failure'}
        className="!h-2.5 !w-2.5 !border-2 !border-led-warn !bg-surface"
      />
    </div>
  )
}

const NODE_TYPES = { workflowNode: WorkflowGraphNode }

/**
 * Backward edges (an explicit `goto` that jumps to an earlier-or-equal node,
 * plan 102 G5) are the single most valuable thing this canvas shows that the
 * list cannot (§4.2) — styled distinctly (dashed, warn-coloured) rather than
 * left to blend into the ordinary flow.
 */
const EDGE_KIND_LABEL: Record<EdgeKind, string> = {
  next: '',
  onFailure: 'on failure',
  then: 'then',
  else: 'else',
}

export interface WorkflowCanvasProps {
  draft: WorkflowDocDraft
  /** Fired when an operator clicks a node — the caller opens the SAME node editor the list uses (plan 102 §3.5); this component renders no form of its own. */
  onSelectNode?: (nodeId: string) => void
  selectedNodeId?: string | null
  /**
   * Step 102.5 — fired when a connection is dragged from one node's handle
   * onto another (a new edge, or an existing one reconnected to a new
   * target) or when an edge is deleted (`targetId: null`, reverting the
   * field to its no-explicit-edge default, `canvas-edit.ts`'s `clearEdge`).
   * This component never mutates `draft` itself — the caller (§3.3) is the
   * one place a document write happens, through `model.ts`'s `updateNode`,
   * same as every other edit in this editor.
   */
  onEdgeChange?: (change: EdgeChange) => void
}

function WorkflowCanvasInner({ draft, onSelectNode, selectedNodeId, onEdgeChange }: WorkflowCanvasProps) {
  const graph = useMemo(() => deriveGraph(draft), [draft])
  const layout = useMemo(() => computeLayout(graph), [graph])

  const unreachableSet = useMemo(() => new Set(graph.unreachable), [graph])

  const positionById = useMemo(() => new Map(layout.nodes.map((n) => [n.id, n])), [layout])

  const editable = onEdgeChange !== undefined

  const flowNodes: Node[] = useMemo(
    () =>
      graph.nodes.map((n) => {
        const pos = positionById.get(n.id) ?? { x: 0, y: 0 }
        return {
          id: n.id,
          type: 'workflowNode',
          position: { x: pos.x, y: pos.y },
          data: { label: n.label, kind: n.kind, unreachable: unreachableSet.has(n.id), editable },
          selected: n.id === selectedNodeId,
          // Position is computed on open and never stored (§3.2) — a node
          // is never draggable, editable canvas or not. Only its EDGES are
          // (step 102.5); `connectable` gates whether ITS handles can start
          // or receive a drag, which is exactly "is this canvas editable".
          draggable: false,
          connectable: editable,
        }
      }),
    [graph.nodes, positionById, unreachableSet, selectedNodeId, editable],
  )

  const flowEdges: Edge[] = useMemo(
    () =>
      graph.edges.map((e, i) => ({
        id: `${e.from}-${e.kind}-${e.to}-${i}`,
        source: e.from,
        target: e.to,
        sourceHandle: e.kind,
        targetHandle: 'target',
        label: EDGE_KIND_LABEL[e.kind] || undefined,
        animated: e.backward,
        style: e.backward ? { stroke: 'var(--color-led-warn)', strokeDasharray: '5 4' } : { stroke: 'var(--color-line-strong)' },
        labelStyle: { fill: 'var(--color-fg-muted)', fontSize: 11 },
        labelBgStyle: { fill: 'var(--color-surface)' },
        deletable: editable,
      })),
    [graph.edges, editable],
  )

  // Step 102.5 — one connection (new OR reconnected) always means "retarget
  // this node's next/onFailure/then/else to point at the dropped-on node".
  // `onReconnect`'s `newConnection` carries the SAME sourceHandle as the
  // edge being dragged (the library keeps the un-dragged end fixed), so one
  // translator serves both `onConnect` and `onReconnect` (plan 102 §3.3: a
  // canvas edit is always a write to the ONE field an edge projects from).
  const handleConnect = useCallback(
    (connection: Connection) => {
      const change = connectionToEdgeChange(connection)
      if (change) onEdgeChange?.(change)
    },
    [onEdgeChange],
  )

  const handleReconnect = useCallback(
    (_oldEdge: Edge, newConnection: Connection) => {
      const change = connectionToEdgeChange(newConnection)
      if (change) onEdgeChange?.(change)
    },
    [onEdgeChange],
  )

  const handleEdgesDelete = useCallback(
    (deleted: Edge[]) => {
      for (const e of deleted) {
        const kind = e.sourceHandle as EdgeKind | null
        if (!kind || !e.source) continue
        onEdgeChange?.({ nodeId: e.source, kind, targetId: null })
      }
    },
    [onEdgeChange],
  )

  return (
    <div className="h-full min-h-[420px] w-full overflow-hidden rounded-lg border bg-surface" data-testid="workflow-canvas">
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={NODE_TYPES}
        onNodeClick={(_, node) => onSelectNode?.(node.id)}
        onConnect={editable ? handleConnect : undefined}
        onReconnect={editable ? handleReconnect : undefined}
        onEdgesDelete={editable ? handleEdgesDelete : undefined}
        fitView
        nodesDraggable={false}
        nodesConnectable={editable}
        elementsSelectable
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--color-line)" />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable nodeColor={(n) => (n.data?.kind === 'gate' ? 'var(--color-led-warn)' : 'var(--color-accent)')} />
      </ReactFlow>
    </div>
  )
}

/** `ReactFlowProvider` is required once per tree using React Flow's own hooks — wrapped here so every caller gets it for free. */
export function WorkflowCanvas(props: WorkflowCanvasProps) {
  return (
    <ReactFlowProvider>
      <WorkflowCanvasInner {...props} />
    </ReactFlowProvider>
  )
}
