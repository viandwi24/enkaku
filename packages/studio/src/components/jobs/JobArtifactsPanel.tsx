'use client'

import { Download } from 'lucide-react'
import type { ArtifactInfo } from '@enkaku/protocol'
import { EmptyState } from '@/components/states'
import { fileSize } from '@/lib/format'
import { coreBase } from '@/lib/ws'

/** The name the file actually downloads as, rather than its internal label — "job.log" says what is inside, "job" does not. */
function fileName(a: ArtifactInfo): string {
  const base = a.path.split('/').pop() ?? ''
  const stripped = base.replace(/^\d+-/, '')
  return stripped || a.label || a.kind
}

/**
 * The Artifacts tab — everything a run produced with `ctx.artifact`.
 * Extracted from `app/jobs/detail/page.tsx` (2026-08-16, closing plan 103
 * step 103.11's audit row 4). `images`/`files` are `useJobDetail`'s own
 * split of `produced` (screenshots vs. everything else) — the same split
 * the page always rendered.
 */
export function JobArtifactsPanel({ images, files }: { images: ArtifactInfo[]; files: ArtifactInfo[] }) {
  if (images.length === 0 && files.length === 0) {
    return (
      <EmptyState
        title="No artifacts"
        description="Screenshots and files a script saves with ctx.artifact appear here. The run's own log is on the Logs tab."
      />
    )
  }
  return (
    <div className="space-y-4">
      {images.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-6">
          {images.map((a) => (
            <a
              key={a.id}
              href={`${coreBase()}/api/artifacts/${a.id}/content`}
              target="_blank"
              rel="noreferrer"
              className="group overflow-hidden rounded border hover:border-accent"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`${coreBase()}/api/artifacts/${a.id}/content`} alt={a.label ?? 'screenshot'} className="aspect-[9/16] w-full object-cover" />
              <span className="block truncate px-1.5 py-1 text-[10.5px] text-fg-muted">{a.label}</span>
            </a>
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div className="divide-y overflow-hidden rounded-lg border">
          {files.map((a) => (
            <a
              key={a.id}
              href={`${coreBase()}/api/artifacts/${a.id}/content`}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-2 px-3 py-2 text-[12.5px] hover:bg-surface-2"
            >
              <Download className="size-3.5 shrink-0 text-fg-subtle" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{fileName(a)}</span>
              <span className="readout shrink-0 text-[11px] text-fg-subtle">{fileSize(a.sizeBytes)}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  )
}
