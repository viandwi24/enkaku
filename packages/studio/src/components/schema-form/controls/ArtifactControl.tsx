'use client'

import { useState } from 'react'
import { X } from 'lucide-react'
import { ArtifactPicker, uploadArtifactSource, type ArtifactSource } from '@/components/ArtifactPicker'
import { FieldRow } from './shell'
import type { BaseControlProps } from './types'

/**
 * `kind: 'artifact'` (plan 113 §4.1, step 113.9 — closes gap G6). Wraps the
 * same `ArtifactPicker` the bulk-transfer and install-batch dialogs already
 * use (plan 93 §3.13, §4.8) — upload-new and choose-existing against
 * `GET /api/artifacts?kind=upload` — rather than a second picker or a text
 * box the operator has to paste a UUID into.
 *
 * The field's VALUE is always the artifact ID `device.push`/`resolveArtifact`
 * already accept — never the `File`/label pair `ArtifactSource` itself
 * carries. Unlike `BulkTransferDialog`/`InstallBatchDialog`, which defer
 * `uploadArtifactSource` to their own submit handler, a schema-form control
 * has no separate submit step to hook into — `onChange` IS the only channel
 * back to the form's value — so the upload happens eagerly, right when a
 * file is picked, and the field stays empty until it resolves to a real id.
 * `uploadArtifactSource` is a no-op network-wise for an already-`existing`
 * source, so choosing from the browse tab resolves immediately.
 *
 * `ArtifactPicker` already degrades honestly when `GET /api/artifacts` is
 * unavailable (its own "Browsing previously uploaded files isn't available"
 * sentence) — this control does nothing that would defeat that; it only
 * ever renders `ArtifactPicker` as given.
 */
export function ArtifactControl({ id, path, label, help, error, value, required, onChange, bare }: BaseControlProps) {
  const [source, setSource] = useState<ArtifactSource | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)

  const artifactId = typeof value === 'string' && value !== '' ? value : null

  function handleChange(next: ArtifactSource | null) {
    setSource(next)
    setUploadError(null)
    if (next === null) {
      onChange(path, undefined)
      return
    }
    setUploading(true)
    uploadArtifactSource(next)
      .then((newId) => {
        setUploading(false)
        onChange(path, newId)
      })
      .catch((err: unknown) => {
        setUploading(false)
        setUploadError(err instanceof Error ? err.message : String(err))
      })
  }

  const picker = (
    <div className="space-y-1.5">
      <ArtifactPicker value={source} onChange={handleChange} disabled={uploading} />
      {uploading && <p className="text-[11.5px] text-fg-muted">Uploading…</p>}
      {uploadError !== null && <p className="text-[11.5px] text-led-danger">Upload failed — {uploadError}</p>}
    </div>
  )

  if (bare) return <div aria-label={label}>{picker}</div>

  return (
    <FieldRow
      id={id}
      label={label}
      help={help}
      error={error}
      readout={
        artifactId ? (
          <span className="inline-flex items-center gap-1.5">
            {source?.kind === 'upload' ? source.file.name : artifactId}
            {!required && (
              <button
                type="button"
                aria-label={`Clear ${label}`}
                onClick={() => handleChange(null)}
                className="rounded p-0.5 text-fg-subtle hover:bg-surface-2 hover:text-fg"
              >
                <X className="size-3" aria-hidden />
              </button>
            )}
          </span>
        ) : (
          'Nothing selected'
        )
      }
    >
      {picker}
    </FieldRow>
  )
}
