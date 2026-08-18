'use client'

import { Download, FileQuestion } from 'lucide-react'
import { Button, fileSize } from '@enkaku/ui'
import type { FilePresenter, PresenterProps } from './index'

/**
 * The fallback (plan 116 §3.3) — a real presenter, not an error state. Every
 * content type resolves to SOME presenter, so an unrecognised one is named,
 * sized, and offered as a download rather than left as a blank pane that
 * teaches an operator the app is broken. `match` never refuses anything,
 * which is exactly why it must stay last in the registry (see `index.ts`).
 */
function DownloadPresenterComponent({ meta, src }: PresenterProps) {
  return (
    <div className="flex flex-col items-start gap-3 px-1 py-10">
      <FileQuestion className="size-6 text-fg-muted" aria-hidden />
      <div className="space-y-1">
        <p className="text-[13px]">
          No viewer is installed for <span className="readout">{meta.contentType}</span> files.
        </p>
        <p className="text-[12px] text-fg-muted">{fileSize(meta.size)}</p>
      </div>
      <Button asChild size="sm" variant="secondary">
        <a href={src} target="_blank" rel="noreferrer">
          <Download className="size-3.5" aria-hidden />
          Download
        </a>
      </Button>
    </div>
  )
}

export const downloadPresenter: FilePresenter = {
  id: 'download',
  match: () => true,
  capabilities: { view: true, edit: false },
  // Never rendered against raw bytes — only metadata and a link to the byte
  // route — so there is no size at which showing it becomes unsafe (§3.6).
  maxBytes: Number.POSITIVE_INFINITY,
  readOnlyReason: 'No viewer is installed for this file type, so it cannot be edited here.',
  Component: DownloadPresenterComponent,
}
