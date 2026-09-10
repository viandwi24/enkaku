'use client'

import { useEffect, useMemo, useState } from 'react'
import type { ArtifactInfo } from '@enkaku/protocol'
import { Button, Input } from '@enkaku/ui'
import { listUploads } from '@/components/files/files-api'
import { FieldRow } from './shell'
import type { BaseControlProps } from './types'

/**
 * `kind: 'artifactIds'` — the bulk sibling of `ArtifactControl`.
 *
 * `ArtifactPicker` chooses ONE file, which is right for "push this APK" and
 * wrong for an operator holding twenty videos: it makes them walk the same
 * dialog twenty times. This lists what has already been uploaded and lets
 * them tick a set, with **Select all** for the case the whole point is
 * "everything I just uploaded".
 *
 * ## It does not upload
 *
 * Deliberately. Uploading belongs to the Files screen, which already does it
 * — with drag-and-drop, progress, rename, pin and delete — and a second
 * uploader inside a form would be a worse copy of it that also has to be
 * maintained. The empty state says where to go instead of pretending there is
 * nothing to choose.
 *
 * ## Failure is stated, never rendered as an empty library
 *
 * An unreachable `GET /api/artifacts` and a farm with no uploads look
 * identical as an empty list, and an operator would reasonably read the
 * second. So the error is said in words and the list is not drawn at all.
 */
export function ArtifactsControl({ id, path, label, help, error, value, onChange, bare }: BaseControlProps) {
  const [files, setFiles] = useState<ArtifactInfo[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  useEffect(() => {
    let alive = true
    listUploads()
      .then((list) => {
        if (alive) setFiles(list)
      })
      .catch((err: unknown) => {
        if (alive) setLoadError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      alive = false
    }
  }, [])

  // Anything that is not an array of strings is "nothing chosen" — a stored
  // value from an older shape must not crash the form it appears in.
  const selected = useMemo(() => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []), [value])
  const chosen = new Set(selected)

  const nameOf = (f: ArtifactInfo): string => f.label ?? f.path.split('/').pop() ?? f.id

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    const all = files ?? []
    return q === '' ? all : all.filter((f) => nameOf(f).toLowerCase().includes(q))
  }, [files, query])

  function toggle(fileId: string): void {
    // Order is the SELECTION order, not the library's: a caller pairing this
    // list against another (captions, say) needs the order the operator built.
    onChange(path, chosen.has(fileId) ? selected.filter((v) => v !== fileId) : [...selected, fileId])
  }

  const allVisibleChosen = visible.length > 0 && visible.every((f) => chosen.has(f.id))

  const body =
    loadError !== null ? (
      <p className="text-meta text-warn">Could not read the file library ({loadError}), so there is nothing to choose from here.</p>
    ) : files === null ? (
      <p className="text-meta text-faint">Reading the file library…</p>
    ) : files.length === 0 ? (
      <p className="text-meta text-faint">No files uploaded yet. Upload them on the Files screen, then come back — they will be listed here.</p>
    ) : (
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search files…" className="h-8 text-body" />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              const ids = visible.map((f) => f.id)
              onChange(path, allVisibleChosen ? selected.filter((v) => !ids.includes(v)) : [...selected, ...ids.filter((v) => !chosen.has(v))])
            }}
          >
            {allVisibleChosen ? 'Clear' : 'Select all'}
          </Button>
        </div>
        <div className="max-h-64 overflow-y-auto rounded-input border border-line">
          {visible.length === 0 ? (
            <p className="px-2.5 py-2 text-meta text-faint">Nothing matches “{query}”.</p>
          ) : (
            visible.map((f) => (
              <label key={f.id} className="flex cursor-pointer items-center gap-2 border-b border-line px-2.5 py-1.5 last:border-b-0 hover:bg-hover">
                <input type="checkbox" checked={chosen.has(f.id)} onChange={() => toggle(f.id)} className="size-3.5 accent-[--color-accent]" />
                <span className="truncate text-body">{nameOf(f)}</span>
                <span className="ml-auto shrink-0 text-caption text-faint">{f.mimeType ?? 'unknown type'}</span>
              </label>
            ))
          )}
        </div>
      </div>
    )

  if (bare) return body

  return (
    <FieldRow
      id={id}
      label={label}
      {...(help === undefined ? {} : { help })}
      {...(error === undefined ? {} : { error })}
      readout={selected.length === 0 ? 'None' : `${selected.length} chosen`}
    >
      {body}
    </FieldRow>
  )
}
