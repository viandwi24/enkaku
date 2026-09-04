'use client'

import { useRef, useState } from 'react'
import type { ValueExpr, WorkflowParam } from '@enkaku/protocol'
import { parse } from '@enkaku/expr'
import { Button, CodeIcon } from '@enkaku/ui'
import { ValueExprEditor, type NodeOption } from './ValueExprEditor'
import { ExprEditor } from './ExprEditor'
import { usePreview, type PreviewScope } from './usePreview'
import type { DataTreeSegment } from './DataTree'

/** `WorkflowPathSchema`'s own grammar (`packages/protocol/src/workflow.ts`), duplicated here (a Studio-side check, never the source of truth — the server re-validates on publish) so a click that cannot be expressed as a `{ from, path }` binding is refused with a reason instead of silently misbuilding one. */
const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.(?:[A-Za-z_][A-Za-z0-9_]*|\d+))*$/

function pathFor(segments: readonly DataTreeSegment[]): string | null {
  if (segments.length === 0) return null
  const path = segments.map((s) => String(s.key)).join('.')
  return PATH_RE.test(path) ? path : null
}

/** What `NodePanel.tsx` registers per focused field — one click in the input pane calls whichever field last focused (plan 306 §3.3, P7). */
export interface ActiveField {
  onLeafClick(ref: string, segments: readonly DataTreeSegment[]): void
}

/**
 * One parameter field (plan 306 §4.3) — the `fx` toggle plus, depending on
 * the current form: the plain `ValueExprEditor` (const/param/from/run), or
 * the expression editor with its live local preview (P8). Converting a
 * literal to an expression writes its JSON source; converting an expression
 * BACK to a literal is only ever done when the expression is a bare literal
 * AST — anything else is refused with a one-line reason rather than
 * discarded (plan 306 §4.3).
 */
export function ExprField({
  value,
  onChange,
  workflowParams,
  nodeOptions,
  previewScope,
  predecessorId,
  onRegisterActive,
}: {
  value: ValueExpr | undefined
  onChange(next: ValueExpr | undefined): void
  workflowParams: readonly WorkflowParam[]
  nodeOptions: readonly NodeOption[]
  previewScope: PreviewScope
  /** The node whose output the input pane's `$input` root belongs to — needed to build a `{ from, path }` binding from a click while this field is in `from` mode (plan 306 §3.3's second paragraph). `null` when there is no predecessor (the first node in the run). */
  predecessorId: string | null
  onRegisterActive(active: ActiveField | null): void
}) {
  const isExpr = value !== undefined && 'expr' in value
  const source = isExpr ? value.expr : ''
  const preview = usePreview(source, previewScope)
  const [convertError, setConvertError] = useState<string | null>(null)
  const [clickError, setClickError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const insertAtCursor = (ref: string) => {
    const el = textareaRef.current
    const start = el?.selectionStart ?? source.length
    const end = el?.selectionEnd ?? source.length
    const next = source.slice(0, start) + ref + source.slice(end)
    onChange({ expr: next })
    if (el) {
      requestAnimationFrame(() => {
        el.focus()
        el.setSelectionRange(start + ref.length, start + ref.length)
      })
    }
  }

  const handleLeafClick = (ref: string, segments: readonly DataTreeSegment[]) => {
    setClickError(null)
    if (isExpr) {
      insertAtCursor(ref)
      return
    }
    if (value && 'from' in value) {
      // §3.3's second paragraph: writes the BINDING, never converts to an expression.
      if (!predecessorId) {
        setClickError('This node has no predecessor to bind from.')
        return
      }
      const path = pathFor(segments)
      if (segments.length > 0 && path === null) {
        setClickError('This key cannot be expressed as a plain binding — switch to an expression (fx) to use get().')
        return
      }
      onChange({ from: predecessorId, path: path ?? undefined, optional: value.optional, default: value.default })
      return
    }
    // Every other kind (unset/const/param/run): the most useful one-click
    // behaviour is to become an expression referencing the clicked value —
    // there is no legacy form here for a click to silently misinterpret.
    onChange({ expr: ref })
  }

  const toggleExpr = () => {
    setConvertError(null)
    if (isExpr) {
      try {
        const ast = parse(source)
        if (ast.t === 'lit') {
          onChange({ const: ast.v })
          return
        }
      } catch {
        // falls through to the refusal below
      }
      setConvertError('This expression is not a bare literal — edit it directly, or clear it, before switching back.')
      return
    }
    const literal = value && 'const' in value ? value.const : ''
    onChange({ expr: typeof literal === 'string' ? JSON.stringify(literal) : String(literal ?? 'null') })
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-start gap-1.5">
        <div className="min-w-0 flex-1">
          {isExpr ? (
            <ExprEditor
              ref={textareaRef}
              value={source}
              onChange={(next) => onChange({ expr: next })}
              error={preview.error}
              onFocus={() => onRegisterActive({ onLeafClick: handleLeafClick })}
            />
          ) : (
            <div onFocus={() => onRegisterActive({ onLeafClick: handleLeafClick })}>
              <ValueExprEditor value={value} onChange={onChange} workflowParams={workflowParams} nodeOptions={nodeOptions} />
            </div>
          )}
        </div>
        <Button
          type="button"
          variant={isExpr ? 'secondary' : 'outline'}
          size="icon-sm"
          aria-label={isExpr ? 'Switch to a plain value' : 'Switch to an expression'}
          onClick={toggleExpr}
          title="fx — expression"
        >
          <CodeIcon className="size-3.5" aria-hidden />
        </Button>
      </div>
      {convertError && <p className="text-[11px] text-led-warn">{convertError}</p>}
      {clickError && <p className="text-[11px] text-led-warn">{clickError}</p>}
      {isExpr && (
        <div className="rounded border bg-panel-2 px-2 py-1 text-[11px]">
          <p className="mb-0.5 text-fg-subtle">preview</p>
          {preview.error ? (
            <p className="text-led-danger">unresolved</p>
          ) : preview.pending ? (
            <p className="text-fg-subtle">…</p>
          ) : preview.hasValue ? (
            <pre className="whitespace-pre-wrap break-all font-mono text-fg">{formatPreviewValue(preview.value)}</pre>
          ) : (
            <p className="text-fg-subtle">(empty)</p>
          )}
        </div>
      )}
    </div>
  )
}

function formatPreviewValue(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
