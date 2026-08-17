import type { DerivedGraph } from './derive-graph'

/**
 * Plan 102 (M67) §3.2, §4.1, step 102.1 — layout computed ON OPEN from
 * `deriveGraph`'s output, never stored (the workflow document has no
 * coordinates, plan 102 G3, and this function's whole point is that it
 * never needs any). A pure function, no React, tested without a renderer.
 *
 * **Deliberately NOT dagre/elkjs.** Plan 102 §3.4 names those as the
 * candidate layout dependency, but a Sugiyama-style layered layout earns
 * its cost on a graph with many crossing/converging edges — this one's
 * `WORKFLOW_LIMITS.maxNodes` is 50, and the dominant shape (per G5/G17) is
 * "mostly linear, with occasional branches and rare backward jumps," which
 * a rank computed straight from the edges already lays out cleanly with no
 * external dependency, no cycle-detection subtlety to get wrong, and a
 * trivially bounded termination proof (below). If H2 (owner-run, §7) finds
 * this genuinely unreadable on a real workflow, that is the evidence for
 * pulling in a real layout library — not a guess made before anyone looked
 * at the result.
 *
 * Algorithm: a node's RANK is the longest forward-edge distance from the
 * entry node (array index 0) — computed by relaxing every FORWARD edge
 * (never a `backward` one, i.e. never a backward `goto`, plan 102 G5) for
 * up to `nodes.length` passes. Excluding backward edges from rank
 * propagation is what makes this terminate on a cyclic graph: there is no
 * cycle among the forward edges by construction (a forward edge always
 * points to a later-or-equal array position... no — a forward edge points
 * strictly to where `backward` is false, and `backward` is defined as
 * `toIndex <= fromIndex`, so every forward edge strictly increases array
 * index, which cannot cycle). A node no forward edge ever reaches (starts
 * with no rank once the relaxation settles) falls back to its own array
 * index, so it still gets a stable, deterministic column instead of
 * collapsing onto rank 0. ROW, within one rank, is array order — so the
 * result is deterministic for the same input (an acceptance criterion in
 * its own right, §7: "a layout that reshuffles on every open is unusable
 * regardless of how it scores on H2").
 */

export interface LayoutNode {
  id: string
  x: number
  y: number
}

export interface Layout {
  nodes: LayoutNode[]
}

const COLUMN_WIDTH_PX = 240
const ROW_HEIGHT_PX = 130

export function computeLayout(graph: DerivedGraph): Layout {
  const { nodes, edges } = graph
  if (nodes.length === 0) return { nodes: [] }

  const idOrder = nodes.map((n) => n.id)
  const indexOf = new Map(idOrder.map((id, i) => [id, i]))
  const forwardEdges = edges.filter((e) => !e.backward)

  const rank = new Map<string, number>()
  rank.set(idOrder[0]!, 0)
  // Bounded relaxation, not a DFS/topological sort — a fixed number of
  // passes (at most one node's rank can still be growing per pass), so
  // this terminates unconditionally regardless of the edge set's shape.
  for (let pass = 0; pass < nodes.length; pass++) {
    let changed = false
    for (const e of forwardEdges) {
      const fromRank = rank.get(e.from)
      if (fromRank === undefined) continue
      const candidate = fromRank + 1
      if ((rank.get(e.to) ?? -1) < candidate) {
        rank.set(e.to, candidate)
        changed = true
      }
    }
    if (!changed) break
  }
  // A node no forward edge ever reaches (isolated, or reachable only via a
  // backward jump) — falls back to its own array position.
  for (const id of idOrder) {
    if (!rank.has(id)) rank.set(id, indexOf.get(id)!)
  }

  const byRank = new Map<number, string[]>()
  for (const id of idOrder) {
    const r = rank.get(id)!
    const list = byRank.get(r)
    if (list) list.push(id)
    else byRank.set(r, [id])
  }

  const positions = new Map<string, LayoutNode>()
  for (const [r, ids] of byRank) {
    ids.forEach((id, row) => {
      positions.set(id, { id, x: r * COLUMN_WIDTH_PX, y: row * ROW_HEIGHT_PX })
    })
  }

  return { nodes: idOrder.map((id) => positions.get(id)!) }
}
