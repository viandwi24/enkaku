'use client'

import { useEffect, useRef, useState } from 'react'
import type { WorkflowDoc, WorkflowFinding } from '@enkaku/protocol'
import { validateWorkflow } from '@/lib/api'

/** `nodes[2].params.keyword` → node index `2`; `undefined` for a doc-level or `onFail.*` finding. Reuses the exact regex the old list editor's `WorkflowBuilder.tsx` already proved out (plan 99 §5 step 99.9), so the canvas and the (deleted) list editor never disagreed about which node a finding belongs to. */
export function nodeIndexOf(path: string): number | undefined {
  const m = /^nodes\[(\d+)\]/.exec(path)
  return m?.[1] !== undefined ? Number(m[1]) : undefined
}

/** The debounce window (plan 305 G7's own parameter: "≤ 1 request per 400 ms"). */
export const VALIDATE_DEBOUNCE_MS = 400

export interface UseValidationResult {
  findings: WorkflowFinding[]
  /** Findings keyed by node ARRAY INDEX (`nodeIndexOf`'s output) — `undefined` for a doc-level or `onFail.*` finding. */
  findingsByNodeIndex: Map<number, WorkflowFinding[]>
  validating: boolean
}

/**
 * Plan 305 §4.5, G7 — continuous, debounced validation. Posts the current
 * document to `POST /api/workflows/validate` (the SAME `checkWorkflow` call
 * the publish gate runs) at most once per `VALIDATE_DEBOUNCE_MS`, so an
 * author sees a problem on the node it belongs to before ever pressing
 * Save. A document that fails the client-side shape check entirely (still
 * possible mid-edit — e.g. a node with `script: ''`) is posted anyway; the
 * server's own `E_WORKFLOW_INVALID` path degrades to the same finding shape
 * `zodIssuesToFindings` used to produce client-side, so there is exactly
 * ONE source of "what does invalid mean" (plan 99 §4.5).
 */
export function useValidation(doc: WorkflowDoc): UseValidationResult {
  const [findings, setFindings] = useState<WorkflowFinding[]>([])
  const [validating, setValidating] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const generation = useRef(0)

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current)
    const myGeneration = ++generation.current
    setValidating(true)
    timer.current = setTimeout(() => {
      void validateWorkflow(doc)
        .then((f) => {
          if (myGeneration === generation.current) setFindings(f)
        })
        .catch(() => {
          // A transient network failure never clears findings already
          // shown — it simply leaves them stale until the next successful
          // round trip.
        })
        .finally(() => {
          if (myGeneration === generation.current) setValidating(false)
        })
    }, VALIDATE_DEBOUNCE_MS)
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
    // `doc` is a new object identity on every edit (the reducer never
    // mutates), so this effect re-fires exactly on document change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc])

  const findingsByNodeIndex = new Map<number, WorkflowFinding[]>()
  for (const f of findings) {
    const i = nodeIndexOf(f.path)
    if (i === undefined) continue
    const list = findingsByNodeIndex.get(i)
    if (list) list.push(f)
    else findingsByNodeIndex.set(i, [f])
  }

  return { findings, findingsByNodeIndex, validating }
}
