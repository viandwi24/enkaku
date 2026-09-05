'use client'

import { useCallback, useEffect, useMemo, useRef } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useNodesInitialized,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type OnConnectEnd,
  type OnNodeDrag,
  type OnSelectionChangeParams,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { WorkflowDoc, WorkflowFinding, WorkflowPoint } from '@enkaku/protocol'
import { connectionToEdgeChange, type EdgeChange } from './canvas-edit'
import { deriveGraph } from './derive-graph'
import { computeLayout } from './layout'
import { nodeIndexOf } from './useValidation'
import { edgeTargetOf, type EdgeKind } from './doc-edit'
import { FLOW_NODE_TYPES, type FlowNodeData } from './FlowNode'
import { FLOW_EDGE_TYPES, type FlowEdgeData } from './FlowEdge'
import type { RunState } from './useRunState'

/**
 * Plan 305 §3.1, §3.2, §4.1 — the canvas, now the editor of record. Built
 * on `@xyflow/react` v12 (pan/zoom/minimap/hit-testing, multi-select,
 * box-select — plan 300 R1's own inventory), controlled by the DOCUMENT:
 * `doc.nodes[i].ui` is the position (plan 300 D2), never recomputed here.
 * `computeLayout` survives only as the position SOURCE for a node with no
 * `ui` and for Auto-arrange (`layout.ts`'s `autoArrangePositions`).
 */

const EDGE_KIND_LABEL: Record<string, string> = { next: '', onFailure: 'on failure', then: 'then', else: 'else', default: 'default' }

function labelFor(kind: EdgeKind): string | undefined {
  if (kind in EDGE_KIND_LABEL) return EDGE_KIND_LABEL[kind] || undefined
  const m = /^case:(\d+)$/.exec(kind)
  return m ? `case ${Number(m[1]) + 1}` : undefined
}

export interface FlowCanvasProps {
  doc: WorkflowDoc
  findings: readonly WorkflowFinding[]
  selectedIds: ReadonlySet<string>
  /** A script ref whose plugin is not (or no longer) installed — rendered dashed, with its raw ref. */
  notInstalledScriptRefs: ReadonlySet<string>
  /** Node ids with an authoring-state pin (plan 300 P10) — the canvas badge (plan 306 §4.2 step 306.7). */
  pinnedIds: ReadonlySet<string>
  onSelectionChange(ids: string[]): void
  /** A DOUBLE click opens a node's panel; a single click only selects it (plan 305 §4.3). Absent on the read-only replay canvas, which opens nothing. */
  onNodeOpen?: (id: string) => void
  /** Fired once per drag gesture (one `move-nodes` history entry, plan 305 §3.3). */
  onNodesMoved(positions: Record<string, WorkflowPoint>): void
  onEdgeChange(change: EdgeChange): void
  onEdgesRemoved(edges: { nodeId: string; kind: EdgeKind }[]): void
  onNodesRemoved(ids: string[]): void
  onInsertOnEdge(from: string, kind: EdgeKind): void
  /** A connection dragged from a handle and dropped on EMPTY canvas — one of P2's three ways to add a node (plan 305 §3.6). */
  onConnectToEmpty(from: string, kind: EdgeKind): void
  /** Plan 307 §3.1, §4.2 — `RunOverlay`'s own projection, drawn on top when present. `undefined` outside a run view: every existing caller of `FlowCanvas` is unaffected. */
  runState?: RunState
  /** Plan 307 §4.1 — the replay canvas (job detail page) is not editable: no drag, no connect, no delete, no palette. `false` (the default) keeps every existing editor behaviour unchanged. */
  readOnly?: boolean
}

function FlowCanvasInner({
  doc,
  findings,
  selectedIds,
  notInstalledScriptRefs,
  pinnedIds,
  onSelectionChange,
  onNodeOpen,
  onNodesMoved,
  onEdgeChange,
  onEdgesRemoved,
  onNodesRemoved,
  onInsertOnEdge,
  onConnectToEmpty,
  runState,
  readOnly = false,
}: FlowCanvasProps) {
  const graph = useMemo(() => deriveGraph(doc), [doc])
  const unreachableSet = useMemo(() => new Set(graph.unreachable), [graph])

  const findingsByNode = useMemo(() => {
    const m = new Map<number, WorkflowFinding[]>()
    for (const f of findings) {
      const i = nodeIndexOf(f.path)
      if (i === undefined) continue
      const list = m.get(i)
      if (list) list.push(f)
      else m.set(i, [f])
    }
    return m
  }, [findings])

  // A node with no `ui` yet (an API caller that supplied none) falls back to
  // the computed layout — the same fallback rule plan 300 D2 states for a
  // v1 document being upgraded.
  const fallbackLayout = useMemo(() => computeLayout(graph), [graph])
  const fallbackById = useMemo(() => new Map(fallbackLayout.nodes.map((n) => [n.id, n])), [fallbackLayout])

  const flowNodes: Node<FlowNodeData>[] = useMemo(
    () =>
      doc.nodes.map((n, index) => {
        const pos = n.ui ?? fallbackById.get(n.id) ?? { x: 0, y: 0 }
        const nodeFindings = findingsByNode.get(index) ?? []
        const notInstalled = n.kind === 'script' && notInstalledScriptRefs.has(n.script)
        return {
          id: n.id,
          type: 'flowNode',
          position: { x: pos.x, y: pos.y },
          selected: selectedIds.has(n.id),
          data: {
            node: n,
            icon: iconFor(n),
            summaryText: summaryOf(n),
            unreachable: unreachableSet.has(n.id),
            errorCount: nodeFindings.filter((f) => f.severity === 'error').length,
            warningCount: nodeFindings.filter((f) => f.severity === 'warning').length,
            notInstalled,
            pinned: pinnedIds.has(n.id),
            editable: !readOnly,
            run: runState?.[n.id],
          },
        }
      }),
    [doc.nodes, fallbackById, findingsByNode, notInstalledScriptRefs, pinnedIds, selectedIds, unreachableSet, readOnly, runState],
  )

  const flowEdges: Edge<FlowEdgeData>[] = useMemo(
    () =>
      graph.edges.map((e, i) => ({
        id: `${e.from}-${e.kind}-${e.to}-${i}`,
        type: 'flowEdge',
        source: e.from,
        target: e.to,
        sourceHandle: e.kind,
        targetHandle: 'target',
        deletable: !readOnly,
        data: {
          kind: e.kind,
          label: labelFor(e.kind) ?? '',
          backward: e.backward,
          editable: !readOnly,
          onInsert: readOnly ? undefined : (from: string, kind: EdgeKind) => onInsertOnEdge(from, kind),
          taken: runState?.[e.from]?.takenEdge === e.kind,
        },
      })),
    [graph.edges, onInsertOnEdge, readOnly, runState],
  )

  /**
   * Fit the view ONCE, after React Flow has measured the nodes.
   *
   * The `fitView` prop alone is a race and it lost about half the time: the
   * library fits on its own initial pass, and if the nodes have not been
   * measured by then it silently does nothing, leaving the viewport at
   * `translate(0,0) scale(1)`. A document whose nodes sit at negative
   * coordinates — which `computeLayout` and any leftward drag both produce —
   * then renders entirely above and left of the visible area, and the canvas
   * looks EMPTY. The owner reported it twice: once as "the start node
   * sometimes disappears", and again as a saved three-node workflow that came
   * back blank (2026-09-05). The document was intact both times; only the
   * camera was wrong.
   *
   * `useNodesInitialized` is the library's own answer to "have the nodes been
   * measured yet", so the fit happens when it can actually succeed. The ref
   * keeps it to once per mount: refitting on every later change would yank
   * the canvas away from wherever the author had panned to.
   */
  const { fitView } = useReactFlow()
  const nodesInitialized = useNodesInitialized()
  const hasFitted = useRef(false)
  useEffect(() => {
    if (!nodesInitialized || hasFitted.current) return
    hasFitted.current = true
    void fitView({ maxZoom: 1, padding: 0.25 })
  }, [nodesInitialized, fitView])

  const handleConnect = useCallback(
    (connection: Connection) => {
      const change = connectionToEdgeChange(connection)
      if (change) onEdgeChange(change)
    },
    [onEdgeChange],
  )

  const handleReconnect = useCallback(
    (_oldEdge: Edge, newConnection: Connection) => {
      const change = connectionToEdgeChange(newConnection)
      if (change) onEdgeChange(change)
    },
    [onEdgeChange],
  )

  const handleEdgesDelete = useCallback(
    (deleted: Edge[]) => {
      const removed: { nodeId: string; kind: EdgeKind }[] = []
      for (const e of deleted) {
        const kind = e.sourceHandle as EdgeKind | null
        if (!kind || !e.source) continue
        removed.push({ nodeId: e.source, kind })
      }
      if (removed.length > 0) onEdgesRemoved(removed)
    },
    [onEdgesRemoved],
  )

  const handleNodesDelete = useCallback(
    (deleted: Node[]) => onNodesRemoved(deleted.map((n) => n.id)),
    [onNodesRemoved],
  )

  const handleNodeDragStop = useCallback<OnNodeDrag>(
    (_event, _node, nodes) => {
      const positions: Record<string, WorkflowPoint> = {}
      for (const n of nodes) positions[n.id] = { x: Math.round(n.position.x), y: Math.round(n.position.y) }
      onNodesMoved(positions)
    },
    [onNodesMoved],
  )

  const handleSelectionChange = useCallback(
    (params: OnSelectionChangeParams) => onSelectionChange(params.nodes.map((n) => n.id)),
    [onSelectionChange],
  )

  const handleNodeDoubleClick = useCallback((_event: unknown, node: { id: string }) => onNodeOpen?.(node.id), [onNodeOpen])

  const handleConnectEnd = useCallback<OnConnectEnd>(
    (_event, connectionState) => {
      if (connectionState.toNode || !connectionState.fromNode || !connectionState.fromHandle?.id) return
      onConnectToEmpty(connectionState.fromNode.id, connectionState.fromHandle.id as EdgeKind)
    },
    [onConnectToEmpty],
  )

  return (
    <div className="h-full min-h-[420px] w-full overflow-hidden rounded-lg border bg-surface" data-testid="flow-canvas">
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={FLOW_NODE_TYPES}
        edgeTypes={FLOW_EDGE_TYPES}
        onConnect={handleConnect}
        onReconnect={handleReconnect}
        onEdgesDelete={handleEdgesDelete}
        onNodesDelete={handleNodesDelete}
        onNodeDragStop={handleNodeDragStop}
        onSelectionChange={handleSelectionChange}
        onNodeDoubleClick={handleNodeDoubleClick}
        onConnectEnd={handleConnectEnd}
        fitView
        /* Without a maxZoom, fitView on a one- or two-node document zooms to
           the library's default ceiling and a single card fills the canvas —
           the "nodes are enormous" half of the owner's 2026-09-05 report.
           Capped at 1: fit shrinks to show everything, and never magnifies. */
        fitViewOptions={{ maxZoom: 1, padding: 0.25 }}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        elementsSelectable={!readOnly}
        multiSelectionKeyCode="Shift"
        selectionOnDrag={!readOnly}
        panOnDrag={[1, 2]}
        snapToGrid
        snapGrid={[8, 8]}
        defaultEdgeOptions={{ type: 'flowEdge' }}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--color-line)" />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable nodeColor={(n) => (n.data?.node && (n.data.node as { kind: string }).kind === 'gate' ? 'var(--color-led-warn)' : 'var(--color-accent)')} />
      </ReactFlow>
    </div>
  )
}

function iconFor(node: FlowCanvasProps['doc']['nodes'][number]): string {
  switch (node.kind) {
    case 'start':
      return 'play'
    case 'script':
      return 'terminal'
    case 'gate':
      return 'filter'
    case 'switch':
      return 'list'
    case 'delay':
      return 'pause'
    case 'finish':
      return 'check'
  }
}

function summaryOf(node: FlowCanvasProps['doc']['nodes'][number]): string {
  if (node.kind === 'script') return node.script || 'no script picked'
  if (node.kind === 'switch') return `${node.cases.length} case${node.cases.length === 1 ? '' : 's'}`
  if (node.kind === 'delay') return `up to ${node.maxMs}ms`
  if (node.kind === 'finish') return node.status
  return ''
}

/** `ReactFlowProvider` is required once per tree using React Flow's own hooks — wrapped here so every caller gets it for free. */
export function FlowCanvas(props: FlowCanvasProps) {
  return (
    <ReactFlowProvider>
      <FlowCanvasInner {...props} />
    </ReactFlowProvider>
  )
}
