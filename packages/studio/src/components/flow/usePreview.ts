'use client'

import { useEffect, useRef, useState } from 'react'
import { ExprEvalError, ExprParseError, deriveRandom, evaluate, parse, toScopeValue, type ExprScope } from '@enkaku/expr'

/**
 * Plan 306 §3.2, §4.4 — the live local preview (plan 300 P8, D4's own
 * condition on the whole expression feature). `@enkaku/expr` is imported
 * directly into the browser bundle here: `parse`+`evaluate` run in this tab,
 * against a scope built from data the panel already has, with NO network
 * call — a preview that round-trips to the core is a laggy validation, not a
 * preview (plan 300 §3 D4's own product rule).
 *
 * The scope shape mirrors `workflow-resolve.ts`'s `buildExprScope` EXACTLY —
 * same six roots, same `toScopeValue` normalisation, same `deriveRandom`
 * derivation for `$random` — so a value that resolves here is the value the
 * server would have produced for the SAME last run (plan 306 §3.2: "same
 * parser, same evaluator, same limits, two hosts, one package").
 */

export interface PreviewScope {
  /** The last run's own workflow parameters — `$params`. */
  params: unknown
  /** Every node's last-run output, by node id — `$nodes`. */
  nodes: Readonly<Record<string, unknown>>
  /** This node's own recorded `$input` (its predecessor's output, plan 306 §9 Q2). */
  input: unknown
  /** The run summary (one entry per node) — `$run.summary`. Optional: a run's own summary is not persisted verbatim, so this is best-effort and defaults to empty. */
  summary?: unknown
  /** The run's own `$random` seed. */
  seed: number
  /** This node's own `workflow_steps.seq` — the second half of `deriveRandom(seed, seq)`. `0` when the node has no recorded step (a fresh, never-run node still gets a stable preview). */
  seq: number
}

export interface PreviewError {
  message: string
  offset: number
}

export interface PreviewResult {
  /** `undefined` while pending, on an empty source, or on error. */
  value: unknown
  hasValue: boolean
  error: PreviewError | null
  pending: boolean
}

/** G3's own parameter: ≤ 150 ms keystroke → preview. A 120 ms debounce leaves headroom for parsing a ≤ 2 KB source (plan 306 §4.4's own comment). */
export const PREVIEW_DEBOUNCE_MS = 120

const EMPTY: PreviewResult = { value: undefined, hasValue: false, error: null, pending: false }

export function usePreview(source: string, scope: PreviewScope): PreviewResult {
  const [result, setResult] = useState<PreviewResult>(EMPTY)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current)
    if (!source.trim()) {
      setResult(EMPTY)
      return
    }
    setResult((r) => ({ ...r, pending: true }))
    timer.current = setTimeout(() => {
      try {
        const ast = parse(source)
        const exprScope: ExprScope = {
          $params: toScopeValue(scope.params) as Readonly<Record<string, unknown>>,
          $nodes: toScopeValue(scope.nodes) as Readonly<Record<string, unknown>>,
          $input: toScopeValue(scope.input),
          // The preview has no batch, so it previews the FIRST device of one:
          // index 0 of 1. An author checking `$run.index % 4` sees branch 0,
          // which is the honest answer for a single simulated device — the
          // split only exists once a batch does.
          $run: { summary: toScopeValue(scope.summary ?? []), index: 0, count: 1 },
          $now: Date.now(),
          $random: deriveRandom(scope.seed, scope.seq),
        }
        const value = evaluate(ast, exprScope)
        setResult({ value, hasValue: true, error: null, pending: false })
      } catch (err) {
        const offset = err instanceof ExprParseError || err instanceof ExprEvalError ? err.offset : 0
        const message = err instanceof Error ? err.message : String(err)
        setResult({ value: undefined, hasValue: false, error: { message, offset }, pending: false })
      }
    }, PREVIEW_DEBOUNCE_MS)
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
    // `scope` is rebuilt (new identity) only when the opened node or the
    // last-run data changes (`NodePanel.tsx` memoises it) — this effect
    // re-fires on every keystroke because `source` does, which is the point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, scope])

  return result
}
