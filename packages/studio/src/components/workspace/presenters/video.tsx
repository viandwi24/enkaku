'use client'

import { useState, type SyntheticEvent } from 'react'
import { AlertTriangle } from 'lucide-react'
import type { FilePresenter, PresenterProps } from './index'

/**
 * `MediaError.code` (the DOM standard, not this codebase's own enum) mapped
 * to a sentence an operator can act on. §8's risk row is specifically a
 * browser refusing a codec (code 4) — that must read as "this browser can't
 * play this", never as a black rectangle with no explanation.
 */
const MEDIA_ERROR_MESSAGES: Record<number, string> = {
  1: 'Playback was aborted.',
  2: 'A network error interrupted the video while it was loading.',
  3: 'The video could not be decoded — the file may be corrupt.',
  4: "This browser cannot play this video's format or codec.",
}

/**
 * The video viewer (plan 116 §3.2, §3.3, §4.1) — `view` only, native
 * `<video controls>` pointed straight at 116.1's `GET /api/workspace/file`
 * URL. Seeking works because that route answers `Range` (§3.4, §4.2); this
 * component does nothing special for it beyond leaving `controls` and a
 * real `src` for the browser to issue ranged requests against. A video
 * editor is a declared non-goal (§2), hence `readOnlyReason`.
 */
export const videoPresenter: FilePresenter = {
  id: 'video',
  match: (file) => file.contentType.startsWith('video/'),
  capabilities: { view: true, edit: false },
  // Streamed and seeked through ranges rather than loaded whole (§3.6) —
  // generous relative to the text presenter's small ceiling.
  maxBytes: 2 * 1024 * 1024 * 1024,
  readOnlyReason: 'Videos can be viewed but not edited, because no video editor is installed.',
  Component: VideoViewer,
}

function VideoViewer({ path, src }: PresenterProps) {
  const [error, setError] = useState<string | null>(null)

  // The element's OWN error (§8's risk row), not a guess: a codec the
  // browser refuses fires this event with a real `MediaError`, and that is
  // what gets shown instead of a silent black rectangle.
  const handleError = (e: SyntheticEvent<HTMLVideoElement>) => {
    const mediaError = e.currentTarget.error
    setError((mediaError && MEDIA_ERROR_MESSAGES[mediaError.code]) || 'This video could not be played.')
  }

  if (error) {
    return (
      <div className="flex min-h-[40vh] flex-col items-center justify-center gap-2 bg-surface-2 p-6 text-center">
        <AlertTriangle className="size-5 text-led-danger" aria-hidden />
        <p className="text-[12.5px] text-fg-muted">{error}</p>
      </div>
    )
  }

  return (
    <div className="flex min-h-[40vh] items-center justify-center bg-surface-2 p-4">
      {/* `max-h-[70vh]` keeps a portrait recording from blowing out the pane; `object-contain`
          via the browser's own aspect-ratio handling on `<video>` needs no extra class for that. */}
      <video controls preload="metadata" src={src} className="max-h-[70vh] max-w-full rounded-md" onError={handleError}>
        <p className="text-[12.5px] text-fg-muted">{path}</p>
      </video>
    </div>
  )
}
