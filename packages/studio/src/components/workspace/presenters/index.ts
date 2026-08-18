import type { JSX } from 'react'
import type { WorkspaceFileMeta } from '@enkaku/protocol'
import { downloadPresenter } from './download-presenter'
import { imagePresenter } from './image'
import { textPresenter } from './text-presenter'
import { videoPresenter } from './video'

/**
 * The presenter seam (plan 116 §3.1, §4.1) — HOW a workspace file is shown
 * and whether it can be edited.
 *
 * Deliberately not called "driver". Plan 115 already owns that word for a
 * different seam (`ContentDriver`, `packages/core/src/workspace/drivers/index.ts`)
 * that answers WHERE a file's bytes live. A reader who saw "driver" here too
 * would reasonably assume the two are one registry — they are not, and
 * neither file mentions the other's word.
 */
export interface FilePresenter {
  id: 'text' | 'image' | 'video' | 'download'
  /** First match in the REGISTRY below wins — order is meaning, not style. */
  match(file: { contentType: string; path: string }): boolean
  capabilities: { view: true; edit: boolean }
  /** Over this many bytes, the page shows metadata and a download instead of `Component` (§3.6). */
  maxBytes: number
  /** Why this presenter cannot edit — rendered verbatim by the page; required when `capabilities.edit` is false (§3.2). */
  readOnlyReason?: string
  Component: (props: PresenterProps) => JSX.Element
}

export interface PresenterProps {
  path: string
  meta: WorkspaceFileMeta
  /** The `GET /api/workspace/file?path=…` URL (plan 116 §4.2) — an image/video presenter points at this directly and never touches the bytes itself. */
  src: string
  /** Text only: loaded content, and the CAS-guarded save (plan 64's `fs.write`, unchanged — plan 116 §3.7). */
  text?: { value: string; onChange(next: string): void; onSave(): Promise<void>; dirty: boolean }
}

/**
 * The registry, in match order. Order is meaning, not style:
 *
 *   1. `text`     — `text/*` and the JSON/JS/TS family. View + edit.
 *   2. `download` — the fallback. Its own `match` never refuses anything, so
 *      it MUST stay last: ahead of a real presenter it would swallow every
 *      file that presenter was meant to handle instead of the presenter ever
 *      seeing it.
 *
 * The image and video presenters (plan 116 step 116.3) sit BETWEEN the two
 * — ahead of `download` so a real viewer wins the match, behind `text`
 * because neither an image nor a video content type collides with
 * `text/*`/the JSON/JS/TS family. Each was one new file plus one line here;
 * nothing else in this module or the page changed (criterion 8).
 */
const REGISTRY: FilePresenter[] = [textPresenter, imagePresenter, videoPresenter, downloadPresenter]

/** Walks the registry in order and returns the first match. `download` always matches, so this never returns nothing. */
export function resolvePresenter(file: { contentType: string; path: string }): FilePresenter {
  const presenter = REGISTRY.find((p) => p.match(file))
  return presenter ?? downloadPresenter
}
