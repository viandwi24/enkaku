'use client'

import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import type { ArtifactBulkDeleteInput, ArtifactBulkDeleteItem, ArtifactBulkDeleteResponse } from '@enkaku/protocol'
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  describeApiError,
  fileSize,
} from '@enkaku/ui'
import { bulkDeleteUploads, describeReference, type FileFilter } from './files-api'

/**
 * What the dialog was opened for: the files the operator ticked, or a clean-up
 * by rule (a family, an age, the current search).
 */
export type BulkDeleteTarget = { mode: 'selection'; ids: string[] } | { mode: 'cleanup'; family: FileFilter; query: string }

const FAMILY_OPTIONS: { value: FileFilter; label: string }[] = [
  { value: 'all', label: 'All files' },
  { value: 'video', label: 'Videos' },
  { value: 'image', label: 'Images' },
  { value: 'other', label: 'Other files' },
]

const AGE_OPTIONS = [
  { value: 'any', label: 'Any age' },
  { value: '1', label: 'Older than 1 day' },
  { value: '7', label: 'Older than 7 days' },
  { value: '30', label: 'Older than 30 days' },
  { value: 'custom', label: 'Older than…' },
] as const
type AgeOption = (typeof AGE_OPTIONS)[number]['value']

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

function reasonText(item: ArtifactBulkDeleteItem): string {
  if (item.references.length > 0 && (item.reason === 'in-use' || item.reason === 'referenced' || item.outcome === 'would-delete' || item.outcome === 'deleted')) {
    return `used by ${item.references.slice(0, 2).map(describeReference).join(', ')}${item.references.length > 2 ? ` and ${item.references.length - 2} more` : ''}`
  }
  return item.message ?? item.reason ?? ''
}

/**
 * Bulk removal from the Files page (owner request 2026-09-16: the Social Media
 * Manager and the post scripts upload a video per post, and old videos pile up).
 *
 * Every number shown comes from a server PREVIEW of the exact request the
 * Delete button will send — never from the list the page happens to hold — and
 * the real call re-checks everything, so a job queued between the two still
 * keeps its file.
 *
 * Not `ConfirmDialog`: a clean-up needs its rule controls, a live preview and
 * an opt-in for referenced files inside the confirmation, which a
 * title-plus-description dialog cannot hold. Single-file delete still uses it.
 */
export function BulkDeleteDialog({
  target,
  onClose,
  onDone,
}: {
  target: BulkDeleteTarget | null
  onClose: () => void
  onDone: (result: ArtifactBulkDeleteResponse) => void
}) {
  const [family, setFamily] = useState<FileFilter>('all')
  const [age, setAge] = useState<AgeOption>('any')
  const [customDays, setCustomDays] = useState('14')
  const [force, setForce] = useState(false)
  const [preview, setPreview] = useState<ArtifactBulkDeleteResponse | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ArtifactBulkDeleteResponse | null>(null)

  useEffect(() => {
    setFamily(target?.mode === 'cleanup' ? target.family : 'all')
    setAge('any')
    setForce(false)
    setPreview(null)
    setPreviewError(null)
    setResult(null)
  }, [target])

  const body = useMemo((): Omit<ArtifactBulkDeleteInput, 'preview'> | null => {
    if (!target) return null
    if (target.mode === 'selection') return target.ids.length > 0 ? { ids: target.ids, force } : null
    const days = age === 'any' ? null : age === 'custom' ? Number(customDays) : Number(age)
    if (days !== null && (!Number.isFinite(days) || days < 0 || customDays.trim() === '')) return null
    const query = target.query.trim()
    return {
      filter: {
        ...(family !== 'all' ? { family } : {}),
        ...(days !== null ? { olderThanSec: Math.round(days * 86_400) } : {}),
        ...(query.length > 0 ? { query } : {}),
      },
      force,
    }
  }, [target, family, age, customDays, force])
  const bodyKey = body === null ? null : JSON.stringify(body)

  useEffect(() => {
    if (bodyKey === null || result !== null) return
    let cancelled = false
    setPreviewError(null)
    const timer = setTimeout(() => {
      bulkDeleteUploads({ ...(JSON.parse(bodyKey) as Omit<ArtifactBulkDeleteInput, 'preview'>), preview: true })
        .then((r) => {
          if (!cancelled) setPreview(r)
        })
        .catch((e) => {
          if (!cancelled) setPreviewError(describeApiError(e))
        })
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [bodyKey, result])

  const items = preview?.items ?? []
  const pinned = items.filter((i) => i.reason === 'pinned').length
  const inUse = items.filter((i) => i.reason === 'in-use').length
  const referenced = items.filter((i) => i.reason === 'referenced').length
  const forcedReferenced = force ? items.filter((i) => i.outcome === 'would-delete' && i.references.length > 0).length : 0
  const other = items.filter((i) => i.reason === 'not-found' || i.reason === 'not-upload').length
  const notable = items.filter((i) => i.outcome === 'skipped' || i.references.length > 0)

  const confirm = async () => {
    if (!body) return
    setBusy(true)
    try {
      const r = await bulkDeleteUploads({ ...body, preview: false })
      setResult(r)
      onDone(r)
      const freed = `${plural(r.deleted, 'file')} deleted, ${fileSize(r.bytesFreed)} freed`
      if (r.failed > 0) toast.warning(`${freed}; ${r.failed} could not be deleted`)
      else toast.success(freed)
    } catch (e) {
      toast.error('Could not delete the files', { description: describeApiError(e) })
    } finally {
      setBusy(false)
    }
  }

  const title = result
    ? 'Clean-up finished'
    : target?.mode === 'selection'
      ? `Delete ${plural(target.ids.length, 'selected file')}?`
      : 'Clean up files'

  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-3 text-[13px] leading-relaxed text-dim">
              {result ? (
                <ResultSummary result={result} />
              ) : (
                <>
                  {target?.mode === 'cleanup' && (
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Select value={family} onValueChange={(v) => setFamily(v as FileFilter)}>
                          <SelectTrigger className="h-8 w-36" aria-label="Which files">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {FAMILY_OPTIONS.map((o) => (
                              <SelectItem key={o.value} value={o.value}>
                                {o.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Select value={age} onValueChange={(v) => setAge(v as AgeOption)}>
                          <SelectTrigger className="h-8 w-44" aria-label="How old">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {AGE_OPTIONS.map((o) => (
                              <SelectItem key={o.value} value={o.value}>
                                {o.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {age === 'custom' && (
                          <span className="flex items-center gap-1.5">
                            <Input
                              type="number"
                              min={0}
                              step={1}
                              value={customDays}
                              onChange={(e) => setCustomDays(e.target.value)}
                              className="h-8 w-20"
                              aria-label="Days"
                            />
                            <span className="text-faint">days</span>
                          </span>
                        )}
                      </div>
                      {target.query.trim().length > 0 && (
                        <p className="text-[12px] text-faint">Only files whose name contains "{target.query.trim()}" (the current search).</p>
                      )}
                    </div>
                  )}

                  {previewError !== null ? (
                    <p className="text-danger">{previewError}</p>
                  ) : body === null ? (
                    <p>Enter a number of days.</p>
                  ) : preview === null ? (
                    <p>Checking what this would delete…</p>
                  ) : (
                    <>
                      <p className="text-text">
                        {preview.deleted === 0 ? (
                          'Nothing here can be deleted.'
                        ) : (
                          <>
                            <strong>{plural(preview.deleted, 'file')}</strong>, <strong>{fileSize(preview.bytesFreed)}</strong>, will be deleted from the farm, bytes and all. This cannot be undone.
                          </>
                        )}
                      </p>
                      {(pinned > 0 || inUse > 0 || referenced > 0 || other > 0 || forcedReferenced > 0) && (
                        <ul className="list-disc space-y-0.5 pl-5 text-[12.5px]">
                          {inUse > 0 && <li>{plural(inUse, 'file')} kept: a queued or running job still uses them. These are never deleted while that work is in progress.</li>}
                          {referenced > 0 && <li>{plural(referenced, 'file')} kept: still referenced by plugin data (a Social Media Manager post, for example), a schedule or a saved workflow.</li>}
                          {forcedReferenced > 0 && <li className="text-danger">{plural(forcedReferenced, 'file')} still referenced by plugins, schedules or workflows will be deleted too.</li>}
                          {pinned > 0 && <li>{plural(pinned, 'file')} kept: pinned. Unpin a file to delete it.</li>}
                          {other > 0 && <li>{plural(other, 'file')} skipped: no longer exists, or belongs to a run.</li>}
                        </ul>
                      )}

                      {(referenced > 0 || force) && (
                        <label className="flex items-start gap-2 rounded border border-danger/35 bg-danger/10 px-3 py-2 text-[12.5px] text-text">
                          <Checkbox className="mt-0.5" checked={force} onCheckedChange={(v) => setForce(v === true)} aria-label="Also delete referenced files" />
                          <span>
                            Also delete files still used by plugins, schedules or saved workflows. Posts, retries or runs that use them will fail. Files a queued or running job uses are still kept.
                          </span>
                        </label>
                      )}

                      {notable.length > 0 && <ItemList items={notable} summary="Show the files that are kept or referenced" />}
                    </>
                  )}

                  <p className="text-[11.5px] text-faint">
                    The farm checks queued and running jobs, active batches, schedules, saved workflows, presets and plugin data. It cannot see a
                    file a plugin keeps anywhere else, or inside an encrypted value.
                  </p>
                </>
              )}
            </div>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          {result ? (
            <Button onClick={onClose}>Done</Button>
          ) : (
            <>
              <Button variant="outline" onClick={onClose} disabled={busy}>
                Cancel
              </Button>
              <Button variant="destructive" disabled={busy || body === null || preview === null || preview.deleted === 0} onClick={() => void confirm()}>
                {busy ? 'Deleting…' : preview && preview.deleted > 0 ? `Delete ${plural(preview.deleted, 'file')}` : 'Delete'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** "Deleted 42 files, 3.1 GB freed; 2 could not be deleted: <reason>" — and which ones, so a partial failure stays readable. */
function ResultSummary({ result }: { result: ArtifactBulkDeleteResponse }) {
  const failed = result.items.filter((i) => i.outcome === 'failed')
  const skipped = result.items.filter((i) => i.outcome === 'skipped')
  return (
    <>
      <p className="text-text">
        Deleted {plural(result.deleted, 'file')}, {fileSize(result.bytesFreed)} freed
        {failed.length > 0 ? `; ${failed.length} could not be deleted${failed.length === 1 && failed[0]?.message ? `: ${failed[0].message}` : ''}` : ''}.
      </p>
      {skipped.length > 0 && <p>{plural(skipped.length, 'file')} kept (in use, referenced or pinned).</p>}
      {failed.length + skipped.length > 0 && <ItemList items={[...failed, ...skipped]} summary="Show the files that were not deleted" />}
    </>
  )
}

function ItemList({ items, summary }: { items: ArtifactBulkDeleteItem[]; summary: string }) {
  const shown = items.slice(0, 100)
  return (
    <details className="rounded border bg-panel-2/40 text-[12px]">
      <summary className="cursor-pointer px-3 py-1.5 text-faint">{summary}</summary>
      <ul className="max-h-48 overflow-y-auto border-t">
        {shown.map((item) => (
          <li key={item.id} className="flex items-baseline gap-2 px-3 py-1">
            <span className="min-w-0 max-w-[45%] shrink-0 truncate text-text" title={item.label ?? item.id}>
              {item.label ?? item.id}
            </span>
            <span className={`min-w-0 flex-1 truncate ${item.outcome === 'failed' || item.reason === 'in-use' ? 'text-danger' : 'text-faint'}`} title={reasonText(item)}>
              {reasonText(item)}
            </span>
          </li>
        ))}
        {items.length > shown.length && <li className="px-3 py-1 text-faint">and {items.length - shown.length} more</li>}
      </ul>
    </details>
  )
}
