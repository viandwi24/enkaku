'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import type { WorkflowDoc } from '@enkaku/protocol'
import { applyDocEdit, type DocEdit } from './doc-edit'

/**
 * Plan 305 §3.3 — history is over the DOCUMENT, not over the canvas.
 * `past`/`present`/`future` hold immutable `WorkflowDoc` snapshots, capped
 * at 50 deep (P5). Every structural edit goes through `dispatch`, which is
 * the only way `present` ever changes — so undo/redo works for anything a
 * `DocEdit` can express, including edits made from a side panel React Flow
 * never sees.
 *
 * Coalescing is by INTENT, not by time (§3.3): a caller passes a
 * `coalesceKey` and consecutive edits sharing one merge into a single
 * history entry instead of one per keystroke/drag-tick. A `key` changes (or
 * is omitted) the next time an unrelated field is touched, which starts a
 * new entry.
 */

const MAX_HISTORY = 50

export interface UseHistoryResult {
  doc: WorkflowDoc
  dispatch(edit: DocEdit, coalesceKey?: string): void
  undo(): void
  redo(): void
  canUndo: boolean
  canRedo: boolean
  /** Replaces the whole document with no history entry — only for the initial load. */
  reset(doc: WorkflowDoc): void
}

export function useHistory(initial: WorkflowDoc): UseHistoryResult {
  const [past, setPast] = useState<WorkflowDoc[]>([])
  const [present, setPresent] = useState<WorkflowDoc>(initial)
  const [future, setFuture] = useState<WorkflowDoc[]>([])
  const lastCoalesceKey = useRef<string | undefined>(undefined)

  const dispatch = useCallback(
    (edit: DocEdit, coalesceKey?: string) => {
      setPresent((current) => {
        const next = applyDocEdit(current, edit)
        if (next === current) return current
        setFuture([])
        setPast((p) => {
          // Coalesce: the same key as the last dispatch replaces the top of
          // the undo stack's PRESENT rather than pushing a new entry — the
          // entry pushed onto `past` is still the state BEFORE this whole
          // coalesced run started.
          if (coalesceKey !== undefined && coalesceKey === lastCoalesceKey.current && p.length > 0) {
            return p
          }
          const pushed = [...p, current]
          return pushed.length > MAX_HISTORY ? pushed.slice(pushed.length - MAX_HISTORY) : pushed
        })
        lastCoalesceKey.current = coalesceKey
        return next
      })
    },
    [],
  )

  const undo = useCallback(() => {
    lastCoalesceKey.current = undefined
    setPast((p) => {
      if (p.length === 0) return p
      const prev = p[p.length - 1]!
      setPresent((current) => {
        setFuture((f) => [current, ...f])
        return prev
      })
      return p.slice(0, -1)
    })
  }, [])

  const redo = useCallback(() => {
    lastCoalesceKey.current = undefined
    setFuture((f) => {
      if (f.length === 0) return f
      const nextDoc = f[0]!
      setPresent((current) => {
        setPast((p) => {
          const pushed = [...p, current]
          return pushed.length > MAX_HISTORY ? pushed.slice(pushed.length - MAX_HISTORY) : pushed
        })
        return nextDoc
      })
      return f.slice(1)
    })
  }, [])

  const reset = useCallback((doc: WorkflowDoc) => {
    lastCoalesceKey.current = undefined
    setPast([])
    setFuture([])
    setPresent(doc)
  }, [])

  return useMemo(
    () => ({ doc: present, dispatch, undo, redo, canUndo: past.length > 0, canRedo: future.length > 0, reset }),
    [present, dispatch, undo, redo, past.length, future.length, reset],
  )
}
