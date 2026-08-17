'use client'

import { useEffect, useState } from 'react'
import { z } from 'zod'
import { ArtifactInfoSchema, type ArtifactInfo } from '@enkaku/protocol'
import { Tabs, TabsContent, TabsList, TabsTrigger, fileSize } from '@enkaku/ui'
import { coreBase } from '@/lib/ws'

/**
 * `ArtifactPicker` (plan 93 §3.13, §4.8, step 93.11) — pick a file for a
 * bulk push/install without re-uploading one already in the store. Used by
 * `BulkTransferDialog` and `InstallBatchDialog`.
 *
 * F14's fix — `GET /api/artifacts?kind=upload` listing upload-owned rows
 * (`jobId`/`deviceId` both null) — is step 93.10's, a file this step does
 * not own (`packages/core/src/api/artifacts.ts`). At the time this component
 * was built, `?kind=upload` was NOT yet accepted: `GET /api/artifacts`
 * still throws `E_BAD_REQUEST` ("either ?jobId= or ?deviceId= is required")
 * for any request naming neither. Rather than stub the "choose existing"
 * tab silently, or block on a dependency owned by a concurrent worker, this
 * component calls the real endpoint with `?kind=upload` and degrades
 * honestly (plan 59's "a precondition is not a failure") when it 400s —
 * the tab still renders, with a sentence saying browsing previously
 * uploaded files isn't available on this build yet, instead of a spinner
 * that never resolves or (worse) claiming an empty list is the whole
 * truth. Once `?kind=upload` lands, this starts listing with no Studio
 * code change — the response shape it expects (`{ artifacts:
 * ArtifactInfo[] }`) is already exactly what `GET /api/artifacts` returns
 * today for `?jobId=`/`?deviceId=` (`packages/core/src/api/artifacts.ts`
 * line ~98's `return c.json({ items, nextCursor, total, artifacts: items
 * })`), so no NEW shape is being guessed at here.
 *
 * `ArtifactPicker.test.tsx`'s "the gap, named" test is this component's own
 * self-detecting proof of that 400 — it fails by name once `?kind=upload`
 * starts working, at which point its assertion (and this comment) should be
 * updated together.
 */

const ArtifactListResponseSchema = z.object({ artifacts: z.array(ArtifactInfoSchema) })

export type ArtifactSource = { kind: 'upload'; file: File } | { kind: 'existing'; artifactId: string; label: string }

export function ArtifactPicker({
  accept,
  value,
  onChange,
  disabled,
}: {
  /** File input `accept`, e.g. `.apk` for an install picker. Omit for any file. */
  accept?: string
  value: ArtifactSource | null
  onChange: (value: ArtifactSource | null) => void
  disabled?: boolean
}) {
  const [mode, setMode] = useState<'upload' | 'existing'>('upload')
  const [existing, setExisting] = useState<ArtifactInfo[] | null>(null)
  const [unavailable, setUnavailable] = useState(false)

  useEffect(() => {
    let cancelled = false
    void fetch(`${coreBase()}/api/artifacts?kind=upload`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const body = await res.json()
        const parsed = ArtifactListResponseSchema.safeParse(body)
        if (!parsed.success) throw new Error('unexpected response shape')
        if (!cancelled) setExisting(parsed.data.artifacts)
      })
      .catch(() => {
        if (!cancelled) setUnavailable(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <Tabs value={mode} onValueChange={(v) => setMode(v as 'upload' | 'existing')}>
      <TabsList className="grid w-full grid-cols-2">
        <TabsTrigger value="upload">Upload new</TabsTrigger>
        <TabsTrigger value="existing">Choose existing</TabsTrigger>
      </TabsList>
      <TabsContent value="upload" className="mt-2">
        <input
          type="file"
          accept={accept}
          disabled={disabled}
          className="block w-full text-[12.5px] disabled:opacity-50"
          onChange={(e) => {
            const file = e.target.files?.[0]
            onChange(file ? { kind: 'upload', file } : null)
          }}
        />
      </TabsContent>
      <TabsContent value="existing" className="mt-2">
        {unavailable ? (
          <p className="rounded-md border bg-surface-2/40 px-2.5 py-2 text-[12px] text-fg-muted">
            Browsing previously uploaded files isn&apos;t available on this build yet — upload the file instead.
          </p>
        ) : existing === null ? (
          <p className="text-[12px] text-fg-subtle">Loading…</p>
        ) : existing.length === 0 ? (
          <p className="rounded-md border bg-surface-2/40 px-2.5 py-2 text-[12px] text-fg-muted">
            No previously uploaded files yet.
          </p>
        ) : (
          <ul className="max-h-48 divide-y overflow-auto rounded-md border text-[12.5px]">
            {existing.map((a) => {
              const label = a.label ?? a.id
              const selected = value?.kind === 'existing' && value.artifactId === a.id
              return (
                <li key={a.id}>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => onChange({ kind: 'existing', artifactId: a.id, label })}
                    className={`flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left hover:bg-surface-2/60 disabled:opacity-50 ${
                      selected ? 'bg-accent/10' : ''
                    }`}
                  >
                    <span className="min-w-0 truncate">{label}</span>
                    <span className="shrink-0 text-fg-subtle">{a.sizeBytes !== null ? fileSize(a.sizeBytes) : ''}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </TabsContent>
    </Tabs>
  )
}

/** Uploads `file`, returning the new artifact's id — the shared multipart-upload shape `FilesPanel.tsx`/`InstallBatchDialog.tsx` already use. */
export async function uploadArtifactSource(source: ArtifactSource): Promise<string> {
  if (source.kind === 'existing') return source.artifactId
  const form = new FormData()
  form.set('file', source.file)
  form.set('label', source.file.name)
  const res = await fetch(`${coreBase()}/api/artifacts`, { method: 'POST', body: form })
  const body = (await res.json().catch(() => null)) as { artifact?: { id: string }; error?: { message?: string } } | null
  if (!res.ok || !body?.artifact) {
    throw new Error(body?.error?.message ?? `Upload failed (HTTP ${res.status})`)
  }
  return body.artifact.id
}
