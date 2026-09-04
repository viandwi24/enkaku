'use client'

import { forwardRef } from 'react'
import { Textarea, cn } from '@enkaku/ui'
import type { PreviewError } from './usePreview'

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
        <Textarea
          ref={ref}
          className={cn('min-h-16 font-mono text-[12px]', error && 'border-led-danger focus-visible:ring-led-danger/40')}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={onFocus}
          spellCheck={false}
          aria-label="Expression"
          aria-invalid={error ? true : undefined}
        />
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
