'use client'

import { Textarea } from '@enkaku/ui'
import type { FilePresenter, PresenterProps } from './index'

/**
 * `text/*` plus the JSON/JS/TS family (plan 116 §3.3) — the same judgement
 * `packages/core/src/workspace/store.ts`'s `isTextContentType` makes for
 * routing a WRITE to the `inline` vs `fs` content driver. Kept as a second,
 * small implementation rather than an import: that function belongs to the
 * storage seam (plan 115), this one to the presenter seam (plan 116 §3.1),
 * and neither seam borrows the other's code any more than it borrows the
 * other's word.
 */
function isTextLikeContentType(contentType: string): boolean {
  const type = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  return type.startsWith('text/') || type === 'application/json' || type === 'application/javascript' || type === 'application/typescript' || type.endsWith('+json') || type.endsWith('+xml')
}

/**
 * A small ceiling (§3.6) — this presenter is an editor, and a huge file in a
 * `Textarea` hangs the tab. 2 MB comfortably covers real scripts and config;
 * anything bigger is not something a person edits by hand in a browser.
 */
const TEXT_MAX_BYTES = 2 * 1024 * 1024

function TextPresenterComponent({ text }: PresenterProps) {
  // The page only supplies a presenter with `capabilities.edit` when it also
  // supplies `text` — see the wiring in `app/workspace/page.tsx`.
  if (!text) throw new Error('text presenter rendered without `text` props')
  return (
    <Textarea
      value={text.value}
      onChange={(e) => text.onChange(e.target.value)}
      className="min-h-[60vh] font-mono text-[12.5px] leading-relaxed"
      spellCheck={false}
    />
  )
}

export const textPresenter: FilePresenter = {
  id: 'text',
  match: (file) => isTextLikeContentType(file.contentType),
  capabilities: { view: true, edit: true },
  maxBytes: TEXT_MAX_BYTES,
  Component: TextPresenterComponent,
}
