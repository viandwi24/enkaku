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
 *
 * **The three stacks are ONE state object, and that is load-bearing.** The
 * first implementation held `past`, `present` and `future` as three
 * `useState`s and updated them by nesting `setFuture` inside a `setPresent`
 * updater inside a `setPast` updater. A state updater must be pure; React 19
 * invokes them twice in development precisely to surface that, so every undo
 * pushed the SAME snapshot onto `future` twice. Redo then appeared to do
 * nothing — it restored an identical duplicate — and the Redo button stayed
 * lit afterwards. Found on 2026-09-05 by pressing the keys, not by reading
 * the code: it typechecks, builds, and is wrong. One object, one pure
 * updater per transition, no nesting.
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
  const [history, setHistory] = useState<{ past: WorkflowDoc[]; present: WorkflowDoc; future: WorkflowDoc[] }>({
    past: [],
    present: initial,
    future: [],
  })
  const lastCoalesceKey = useRef<string | undefined>(undefined)

  const dispatch = useCallback((edit: DocEdit, coalesceKey?: string) => {
    const coalesces = coalesceKey !== undefined && coalesceKey === lastCoalesceKey.current
    lastCoalesceKey.current = coalesceKey
    setHistory((h) => {
      const next = applyDocEdit(h.present, edit)
      if (next === h.present) return h
      // Coalescing keeps the entry pushed BEFORE this run started, so a whole
      // drag (or a whole focus session in a text field) undoes as one step.
      const past = coalesces && h.past.length > 0 ? h.past : [...h.past, h.present]
      return { past: past.length > MAX_HISTORY ? past.slice(past.length - MAX_HISTORY) : past, present: next, future: [] }
    })
  }, [])

  const undo = useCallback(() => {
    lastCoalesceKey.current = undefined
    setHistory((h) => {
      const prev = h.past[h.past.length - 1]
      if (prev === undefined) return h
      return { past: h.past.slice(0, -1), present: prev, future: [h.present, ...h.future] }
    })
  }, [])

  const redo = useCallback(() => {
    lastCoalesceKey.current = undefined
    setHistory((h) => {
      const next = h.future[0]
      if (next === undefined) return h
      const past = [...h.past, h.present]
      return { past: past.length > MAX_HISTORY ? past.slice(past.length - MAX_HISTORY) : past, present: next, future: h.future.slice(1) }
    })
  }, [])

  const reset = useCallback((doc: WorkflowDoc) => {
    lastCoalesceKey.current = undefined
    setHistory({ past: [], present: doc, future: [] })
  }, [])

  return useMemo(
    () => ({
      doc: history.present,
      dispatch,
      undo,
      redo,
      canUndo: history.past.length > 0,
      canRedo: history.future.length > 0,
      reset,
    }),
    [history, dispatch, undo, redo, reset],
  )
}
