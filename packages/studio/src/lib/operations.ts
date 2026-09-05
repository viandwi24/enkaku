'use client'

import { useEffect, useState } from 'react'
import type { ActionResult, ActionVerb } from '@enkaku/protocol'
import { fetchOperation } from './actions'

/**
 * Long actions keep running when the modal goes away (CEO, 2026-09-05:
 * "modal yang ada loadingnya itu bisa di minimize, terus di floating bawah
 * pojok itu ada indicator yang lagi running").
 *
 * The store exists because of where the work used to live: `ActionDialog`
 * awaited the operation inside its own component, so closing the dialog
 * orphaned the poll and the operator lost every way of finding out how an
 * install on twenty phones had gone. Installing an APK on a farm takes
 * minutes, and a modal is a wall across the whole app for the whole of it.
 *
 * Polling lives here, at module scope, for the same reason `ActionDialogHost`
 * and `DeviceControlHost` keep their state here: it must outlive any tree.
 * The core keeps an operation readable for an hour after it settles
 * (`GET /api/operations/:id`), so a reload could re-attach to one — this
 * store does not, and a reload loses the indicator while the work itself
 * carries on. That is a gap, not a design: nothing here is the source of
 * truth, the core is.
 */
export interface TrackedOperation {
  id: string
  verb: ActionVerb
  /** What the operator called it — the dialog's own submit label ("Install APK on 8 devices"). */
  title: string
  results: ActionResult[]
  settled: boolean
  /** Set when polling itself failed — the work may well have finished; we simply stopped being able to ask. */
  error: string | null
  startedAt: number
  /**
   * False while a dialog is showing this operation, true once it was
   * minimised or its dialog closed. The tray renders only the visible ones,
   * so an operation is never in two places at once.
   */
  visible: boolean
}

type Listener = (ops: TrackedOperation[]) => void

let operations: TrackedOperation[] = []
const listeners = new Set<Listener>()
const polling = new Set<string>()

function emit(): void {
  const snapshot = operations
  for (const l of listeners) l(snapshot)
}

function patch(id: string, next: Partial<TrackedOperation>): void {
  operations = operations.map((op) => (op.id === id ? { ...op, ...next } : op))
  emit()
}

/** Everything the tray needs about one device's outcome, counted the way the card reads. */
export function countResults(results: ActionResult[]): { done: number; failed: number; pending: number; total: number } {
  let done = 0
  let failed = 0
  let pending = 0
  for (const r of results) {
    if (r.status === 'accepted') pending += 1
    else if (r.status === 'done') done += 1
    else failed += 1
  }
  return { done, failed, pending, total: results.length }
}

/**
 * Poll until the operation settles, writing every intermediate answer into the
 * store so a card can show 3/8 rather than a spinner.
 *
 * One second, matching `awaitOperation`'s own interval, and it stops on the
 * first settled read — an install that finishes in four seconds costs four
 * requests. It gives up after fifteen minutes, which is longer than
 * `awaitOperation`'s ten because the operator is no longer sitting in front
 * of a modal waiting for it.
 */
async function poll(id: string): Promise<void> {
  if (polling.has(id)) return
  polling.add(id)
  const deadline = Date.now() + 900_000
  try {
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 1000))
      if (!operations.some((op) => op.id === id)) return
      try {
        const op = await fetchOperation(id)
        patch(id, { results: op.results, settled: op.settled })
        if (op.settled) return
      } catch (err) {
        patch(id, { error: err instanceof Error ? err.message : String(err), settled: true })
        return
      }
      if (Date.now() > deadline) {
        patch(id, { error: 'this operation has been running for 15 minutes — check the device', settled: true })
        return
      }
    }
  } finally {
    polling.delete(id)
  }
}

/**
 * Take ownership of an operation the core has accepted. Idempotent on `id`, so
 * a dialog that re-submits with `force` does not produce a second card.
 */
export function trackOperation(input: { id: string; verb: ActionVerb; title: string; results: ActionResult[]; visible: boolean }): void {
  const existing = operations.find((op) => op.id === input.id)
  if (existing) {
    patch(input.id, { results: input.results, visible: existing.visible || input.visible })
    return
  }
  operations = [
    ...operations,
    { id: input.id, verb: input.verb, title: input.title, results: input.results, settled: false, error: null, startedAt: Date.now(), visible: input.visible },
  ]
  emit()
  void poll(input.id)
}

/** The dialog handing its operation to the tray — on Minimise, and on any close while the work is still running. */
export function detachOperation(id: string): void {
  if (!operations.some((op) => op.id === id)) return
  patch(id, { visible: true })
}

export function dismissOperation(id: string): void {
  operations = operations.filter((op) => op.id !== id)
  emit()
}

/**
 * Resolve once the operation settles — the dialog's own await, served by the
 * SAME poll the tray reads. Deliberately not a second `awaitOperation`: two
 * pollers on one operation is two answers that can disagree, and the one the
 * operator can see must be the one the dialog acted on.
 */
export function whenSettled(id: string): Promise<TrackedOperation> {
  const now = operations.find((op) => op.id === id)
  if (!now) return Promise.reject(new Error(`operation ${id} is not tracked`))
  if (now.settled) return Promise.resolve(now)
  return new Promise((resolve) => {
    const listener: Listener = (ops) => {
      const op = ops.find((o) => o.id === id)
      // Gone from the store (dismissed) counts as settled for the waiter:
      // there is nothing left to wait on, and leaving the promise pending
      // would hang whatever asked.
      if (!op) {
        listeners.delete(listener)
        resolve({ ...now, settled: true })
      } else if (op.settled) {
        listeners.delete(listener)
        resolve(op)
      }
    }
    listeners.add(listener)
  })
}

export function getOperation(id: string): TrackedOperation | null {
  return operations.find((op) => op.id === id) ?? null
}

/** Subscribe to the whole list — the tray. */
export function useOperations(): TrackedOperation[] {
  const [ops, setOps] = useState<TrackedOperation[]>(operations)
  useEffect(() => {
    setOps(operations)
    listeners.add(setOps)
    return () => {
      listeners.delete(setOps)
    }
  }, [])
  return ops
}

/** Subscribe to one — the dialog, while it is still the thing on screen. */
export function useOperation(id: string | null): TrackedOperation | null {
  const ops = useOperations()
  return id === null ? null : (ops.find((op) => op.id === id) ?? null)
}
