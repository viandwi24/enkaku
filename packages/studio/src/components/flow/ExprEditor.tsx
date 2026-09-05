'use client'

import { forwardRef } from 'react'
import { Textarea, cn } from '@enkaku/ui'
import type { PreviewError } from './usePreview'
import { ExprHighlight } from './expr-highlight'

/**
 * The expression source textarea, plus an offset-accurate error strip (plan
 * 306 §4.2, G4). `error.offset` names the character `@enkaku/expr` stopped
 * at — this renders the source a second time, underneath, split at that
 * offset with the offending character (or, at end of source, one trailing
 * space) highlighted, so "the error's `offset` is used" (G4's own verified-by
 * clause) is literally true rather than a message alone.
 */
export const ExprEditor = forwardRef<HTMLTextAreaElement, { value: string; onChange(next: string): void; error: PreviewError | null; onFocus?(): void }>(
  function ExprEditor({ value, onChange, error, onFocus }, ref) {
    return (
      <div className="space-y-1">
        {/*
          A coloured copy behind a transparent textarea — the standard way to
          highlight an editable field without replacing the browser's own text
          editing. Both layers carry the SAME font, size, leading, padding and
          wrapping, because any difference between them shows up as the caret
          drifting away from the glyph it is next to.

          `text-transparent` with `caret-text` keeps the caret and the
          selection visible while the letters themselves come from the layer
          underneath.
        */}
        <div className="relative">
          <pre
            aria-hidden
            className="pointer-events-none absolute inset-0 m-0 overflow-hidden rounded-input border border-transparent px-3 py-2 font-mono text-[12px] leading-[1.45] whitespace-pre-wrap break-words"
          >
            <ExprHighlight source={value} />
          </pre>
          <Textarea
            ref={ref}
            className={cn(
              'relative min-h-16 resize-y bg-transparent px-3 py-2 font-mono text-[12px] leading-[1.45] text-transparent caret-text',
              error && 'border-led-danger focus-visible:ring-led-danger/40',
            )}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onFocus={onFocus}
            spellCheck={false}
            aria-label="Expression"
            aria-invalid={error ? true : undefined}
          />
        </div>
        {error && (
          <div className="space-y-0.5 rounded border border-led-danger/30 bg-led-danger/5 px-2 py-1 text-[11px]">
            <p className="whitespace-pre-wrap break-all font-mono text-fg-muted">
              {value.slice(0, error.offset)}
              <span className="rounded-sm bg-led-danger/30 text-led-danger underline decoration-led-danger decoration-2">
                {value.slice(error.offset, error.offset + 1) || ' '}
              </span>
              {value.slice(error.offset + 1)}
            </p>
            <p className="text-led-danger">{error.message}</p>
          </div>
        )}
      </div>
    )
  },
)
