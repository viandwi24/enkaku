'use client'

import { useState } from 'react'
import type { ArtifactInfo } from '@enkaku/protocol'
import { EmptyState, FileCodeIcon, FilmSlateIcon, ImageIcon, fileSize } from '@enkaku/ui'
import { coreBase } from '@/lib/ws'
import { STRIPE } from './job-view'

/**
 * Artifacts (design handoff, "Screen: Jobs"): "'Artifacts' + '5 files ·
 * 44.1 MB', then a `repeat(auto-fill, minmax(164px, 1fr))` grid of cards
 * (`border-radius: 12px`): a 92px thumbnail area (stripe pattern, 22px
 * `ph-image` / `ph-film-slate` / `ph-file-code`) over the file name and
 * 'screenshot · 1.2 MB'. Artifacts are the *file* outputs (frames, ui dumps,
 * replay video, metric copies) as distinct from the JSON **Output**
 * snapshot."
 */
function ArtifactThumb({ artifact }: { artifact: ArtifactInfo }) {
  const [failed, setFailed] = useState(false)
  if (artifact.kind === 'screenshot' && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={`${coreBase()}/api/artifacts/${artifact.id}/content`}
        alt={artifact.label ?? 'screenshot'}
        className="size-full object-cover"
        onError={() => setFailed(true)}
      />
    )
  }
  const Icon = artifact.kind === 'video' ? FilmSlateIcon : artifact.kind === 'screenshot' ? ImageIcon : FileCodeIcon
  return <Icon className="size-[22px] text-faint" />
}

export function ArtifactsTab({ artifacts }: { artifacts: ArtifactInfo[] }) {
  const total = artifacts.reduce((sum, a) => sum + (a.sizeBytes ?? 0), 0)

  if (artifacts.length === 0) {
    return (
      <div className="p-[14px]">
        <EmptyState
          title="No artifacts"
          description="Screenshots and files a script saves with ctx.artifact appear here. The run's own log is on the Logs tab."
        />
      </div>
    )
  }

  return (
    <div className="p-[14px]">
      <div className="flex items-center justify-between pb-[10px]">
        <span className="text-[12px] font-semibold">Artifacts</span>
        <span className="text-meta text-faint">
          {artifacts.length} file{artifacts.length === 1 ? '' : 's'} · {fileSize(total)}
        </span>
      </div>
      <div className="grid gap-[10px]" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(164px, 1fr))' }}>
        {artifacts.map((a) => {
          const name = (a.path.split('/').pop() ?? a.label ?? a.kind).replace(/^\d+-/, '')
          return (
            <a
              key={a.id}
              href={`${coreBase()}/api/artifacts/${a.id}/content`}
              target="_blank"
              rel="noreferrer"
              className="overflow-hidden rounded-inner border border-line-2 transition-colors hover:bg-muted"
            >
              <div className="flex h-[92px] items-center justify-center border-b border-line-2" style={STRIPE}>
                <ArtifactThumb artifact={a} />
              </div>
              <div className="px-[10px] pt-2 pb-[10px]">
                <div className="truncate text-[12px]">{name}</div>
                <div className="mt-[3px] text-label text-faint">
                  {a.kind} · {fileSize(a.sizeBytes)}
                </div>
              </div>
            </a>
          )
        })}
      </div>
      <p className="mt-3 text-tip text-faint">Artifacts are the files a run produced. The JSON it returned is on the Output tab.</p>
    </div>
  )
}
