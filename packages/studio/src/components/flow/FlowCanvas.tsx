'use client'

import { useCallback, useMemo } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
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
  onSelectionChange(ids: string[]): void
  /** Fired once per drag gesture (one `move-nodes` history entry, plan 305 §3.3). */
  onNodesMoved(positions: Record<string, WorkflowPoint>): void
  onEdgeChange(change: EdgeChange): void
  onEdgesRemoved(edges: { nodeId: string; kind: EdgeKind }[]): void
  onNodesRemoved(ids: string[]): void
  onInsertOnEdge(from: string, kind: EdgeKind): void
  /** A connection dragged from a handle and dropped on EMPTY canvas — one of P2's three ways to add a node (plan 305 §3.6). */
  onConnectToEmpty(from: string, kind: EdgeKind): void
}

function FlowCanvasInner({
  doc,
  findings,
  selectedIds,
  notInstalledScriptRefs,
  onSelectionChange,
  onNodesMoved,
  onEdgeChange,
  onEdgesRemoved,
  onNodesRemoved,
  onInsertOnEdge,
  onConnectToEmpty,
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
            editable: true,
          },
        }
      }),
    [doc.nodes, fallbackById, findingsByNode, notInstalledScriptRefs, selectedIds, unreachableSet],
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
        deletable: true,
        data: { kind: e.kind, label: labelFor(e.kind) ?? '', backward: e.backward, editable: true, onInsert: (from: string, kind: EdgeKind) => onInsertOnEdge(from, kind) },
      })),
    [graph.edges, onInsertOnEdge],
  )

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
        onConnectEnd={handleConnectEnd}
        fitView
        nodesDraggable
        nodesConnectable
        elementsSelectable
        multiSelectionKeyCode="Shift"
        selectionOnDrag
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
