'use client'

import { useState } from 'react'
import { ImageOff } from 'lucide-react'
import type { FilePresenter, PresenterProps } from './index'

/**
 * The image viewer (plan 116 §3.2, §3.3, §4.1) — `view` only. An image
 * editor is a declared non-goal (§2: skipped on the owner's own
 * instruction, not an oversight), so `readOnlyReason` is a real sentence
 * the page renders verbatim instead of leaving a missing Save control
 * unexplained.
 */
export const imagePresenter: FilePresenter = {
  id: 'image',
  match: (file) => file.contentType.startsWith('image/'),
  capabilities: { view: true, edit: false },
  // The browser decodes and streams the picture itself rather than this
  // component loading it into a string (§3.6) — generous compared to the
  // text presenter's small ceiling, but still a real number so a truly
  // enormous file falls through to the page's metadata-and-download
  // fallback instead of hanging the tab.
  maxBytes: 200 * 1024 * 1024,
  readOnlyReason: 'Images can be viewed but not edited, because no image editor is installed.',
  Component: ImageViewer,
}

function ImageViewer({ path, src }: PresenterProps) {
  const [broken, setBroken] = useState(false)

  if (broken) {
    return (
      <div className="flex min-h-[40vh] flex-col items-center justify-center gap-2 bg-surface-2 p-6 text-center">
        <ImageOff className="size-5 text-fg-subtle" aria-hidden />
        <p className="text-[12.5px] text-fg-muted">This image could not be decoded by the browser.</p>
      </div>
    )
  }

  return (
    <div className="flex min-h-[40vh] items-center justify-center bg-surface-2 p-4">
      {/* eslint-disable-next-line @next/next/no-img-element -- a core-served workspace blob, never a build-time asset next/image could optimise */}
      <img src={src} alt={path} className="max-h-[70vh] max-w-full rounded-md object-contain" onError={() => setBroken(true)} />
    </div>
  )
}
