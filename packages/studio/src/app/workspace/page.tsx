'use client'

import { Suspense, useCallback, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { FileCode2, Folder, FolderOpen, Loader2, Plus, Rocket, Save, Trash2 } from 'lucide-react'
import { PageHeader } from '@/components/layout/PageHeader'
import { EmptyState, LoadingRows } from '@/components/states'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { relativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import {
  deleteWorkspaceFile,
  listWorkspace,
  publishScriptFromWorkspace,
  readWorkspaceFile,
  writeWorkspaceFile,
  type WorkspaceFileMeta,
  type WorkspaceListEntry,
} from '@/lib/workspace'

/**
 * `/workspace` (plan 64 §3.6, §4.5) — a tree in the left column, an editor
 * on the right, both talking to the SAME `fs.*` capabilities an agent uses.
 * A person editing a file an agent wrote is the normal case here, not an
 * edge case (§3.6), so every save is compare-and-swap and a conflict is
 * shown, never silently overwritten or silently discarded.
 */

/** "user:u1" / "agent:checkout-bot" -> "user u1" / "agent checkout-bot" — attribution is the point (plan 64 §4.5). */
function attributionLabel(who: string | null): string {
  if (!who) return 'nobody yet'
  const i = who.indexOf(':')
  if (i === -1) return who
  return `${who.slice(0, i)} ${who.slice(i + 1)}`
}

function parentPrefix(prefix: string): string {
  if (prefix === '/') return '/'
  const trimmed = prefix.slice(0, -1) // drop the trailing slash
  const i = trimmed.lastIndexOf('/')
  return i <= 0 ? '/' : trimmed.slice(0, i + 1)
}

function fileName(path: string): string {
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path
  const i = trimmed.lastIndexOf('/')
  return trimmed.slice(i + 1)
}

function breadcrumbs(prefix: string): { label: string; prefix: string }[] {
  if (prefix === '/') return [{ label: '/', prefix: '/' }]
  const segments = prefix.slice(1, -1).split('/')
  const crumbs = [{ label: '/', prefix: '/' }]
  let acc = '/'
  for (const seg of segments) {
    acc += seg + '/'
    crumbs.push({ label: seg, prefix: acc })
  }
  return crumbs
}

function WorkspaceView() {
  const params = useSearchParams()
  const router = useRouter()

  const [prefix, setPrefix] = useState('/')
  const [entries, setEntries] = useState<WorkspaceListEntry[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)

  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [meta, setMeta] = useState<WorkspaceFileMeta | null>(null)
  const [draft, setDraft] = useState('')
  const [original, setOriginal] = useState('')
  const [loadingFile, setLoadingFile] = useState(false)
  const [saving, setSaving] = useState(false)
  const [fileError, setFileError] = useState<string | null>(null)
  const [conflict, setConflict] = useState<{ message: string } | null>(null)

  const [newFileName, setNewFileName] = useState('')
  const [creating, setCreating] = useState(false)

  const [publishOpen, setPublishOpen] = useState(false)
  const [publishName, setPublishName] = useState('')
  const [publishVersion, setPublishVersion] = useState('1.0.0')
  const [publishing, setPublishing] = useState(false)
  const [publishError, setPublishError] = useState<string | null>(null)

  const loadDir = useCallback((p: string) => {
    setListError(null)
    setEntries(null)
    listWorkspace(p)
      .then(setEntries)
      .catch((err: unknown) => setListError(err instanceof Error ? err.message : String(err)))
  }, [])

  const loadFile = useCallback((path: string) => {
    setLoadingFile(true)
    setFileError(null)
    setConflict(null)
    readWorkspaceFile(path)
      .then((file) => {
        setMeta(file)
        setDraft(file.content)
        setOriginal(file.content)
      })
      .catch((err: unknown) => setFileError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoadingFile(false))
  }, [])

  useEffect(() => {
    void loadDir(prefix)
  }, [prefix, loadDir])

  // Deep link: /workspace?path=/scripts/hello.ts opens straight to a file.
  useEffect(() => {
    const initial = params.get('path')
    if (initial) {
      setSelectedPath(initial)
      void loadFile(initial)
      const dir = parentPrefix(initial)
      setPrefix(dir)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const openFile = (path: string) => {
    setSelectedPath(path)
    void loadFile(path)
    router.push(`/workspace?path=${encodeURIComponent(path)}`)
  }

  const dirty = selectedPath !== null && draft !== original

  const save = async () => {
    if (!selectedPath) return
    setSaving(true)
    setFileError(null)
    try {
      const saved = await writeWorkspaceFile(selectedPath, draft, { ifMatch: meta?.hash ?? null })
      setMeta(saved)
      setOriginal(draft)
      setConflict(null)
      void loadDir(prefix)
    } catch (err) {
      const code = (err as { code?: string } | undefined)?.code
      const message = err instanceof Error ? err.message : String(err)
      if (code === 'E_STALE') setConflict({ message })
      else setFileError(message)
    } finally {
      setSaving(false)
    }
  }

  const reloadDiscardingEdits = () => {
    if (selectedPath) void loadFile(selectedPath)
  }

  const copyMineToClipboard = () => {
    void navigator.clipboard.writeText(draft)
  }

  const createFile = async () => {
    if (!newFileName.trim()) return
    const path = prefix + newFileName.trim().replace(/^\/+/, '')
    setCreating(true)
    setListError(null)
    try {
      await writeWorkspaceFile(path, '')
      setNewFileName('')
      void loadDir(prefix)
      openFile(path)
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err))
    } finally {
      setCreating(false)
    }
  }

  const removeSelected = async () => {
    if (!selectedPath || !meta) return
    if (!window.confirm(`Delete ${selectedPath}? This cannot be undone.`)) return
    try {
      await deleteWorkspaceFile(selectedPath, meta.hash)
      setSelectedPath(null)
      setMeta(null)
      setDraft('')
      setOriginal('')
      router.push('/workspace')
      void loadDir(prefix)
    } catch (err) {
      setFileError(err instanceof Error ? err.message : String(err))
    }
  }

  const openPublish = () => {
    if (!selectedPath) return
    const base = fileName(selectedPath).replace(/\.[^.]+$/, '')
    setPublishName(base)
    setPublishVersion('1.0.0')
    setPublishError(null)
    setPublishOpen(true)
  }

  const doPublish = async () => {
    if (!selectedPath) return
    setPublishing(true)
    setPublishError(null)
    try {
      const result = await publishScriptFromWorkspace(selectedPath, publishName.trim(), publishVersion.trim())
      setPublishOpen(false)
      router.push(`/scripts/detail?id=${result.id}`)
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : String(err))
    } finally {
      setPublishing(false)
    }
  }

  const canPublish = selectedPath?.startsWith('/scripts/') ?? false

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Workspace"
        description="A shared filesystem — agents write to it, people browse and edit it here."
      />

      {/* `min-h-full` instead of a hard-coded viewport-height guess at the header's own height
          (plan 73 §3.1) — this row is a flex sibling below `PageHeader` in a `h-full` column, so
          "fill what's left" falls out of the box model instead of arithmetic. */}
      <div className="grid min-h-full grid-cols-1 gap-0 md:grid-cols-[280px_1fr]">
        {/* Tree / directory browser */}
        <div className="border-r md:overflow-y-auto">
          <div className="flex flex-wrap items-center gap-1 border-b px-3 py-2 text-[12px]">
            {breadcrumbs(prefix).map((c, i) => (
              <span key={c.prefix} className="flex items-center gap-1">
                {i > 0 && <span className="text-fg-muted">/</span>}
                <button
                  onClick={() => setPrefix(c.prefix)}
                  className={cn('rounded px-1 hover:bg-surface-2', c.prefix === prefix ? 'font-medium text-fg' : 'text-fg-muted')}
                >
                  {c.label}
                </button>
              </span>
            ))}
          </div>

          <div className="flex items-center gap-1.5 border-b px-3 py-2">
            <Input
              value={newFileName}
              onChange={(e) => setNewFileName(e.target.value)}
              placeholder="new-file.ts"
              className="h-7 text-[12px]"
              onKeyDown={(e) => {
                if (e.key === 'Enter') void createFile()
              }}
            />
            <Button size="sm" variant="secondary" className="h-7 shrink-0 px-2" disabled={creating || !newFileName.trim()} onClick={() => void createFile()}>
              <Plus className="size-3.5" aria-hidden />
            </Button>
          </div>

          {listError && <p className="px-3 py-3 text-[12px] text-led-danger">{listError}</p>}
          {!listError && entries === null && (
            <div className="px-3 py-3">
              <LoadingRows rows={4} />
            </div>
          )}
          {!listError && entries !== null && entries.length === 0 && <p className="px-3 py-6 text-center text-[12px] text-fg-muted">Nothing here yet.</p>}
          {!listError && entries !== null && entries.length > 0 && (
            <ul className="py-1">
              {entries.map((e) => (
                <li key={e.path}>
                  {e.kind === 'dir' ? (
                    <button
                      onClick={() => setPrefix(e.path)}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] hover:bg-surface-2"
                    >
                      <Folder className="size-3.5 shrink-0 text-fg-muted" aria-hidden />
                      <span className="truncate">{fileName(e.path)}</span>
                    </button>
                  ) : (
                    <button
                      onClick={() => openFile(e.path)}
                      className={cn(
                        'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] hover:bg-surface-2',
                        selectedPath === e.path && 'bg-surface-2 font-medium',
                      )}
                    >
                      <FileCode2 className="size-3.5 shrink-0 text-fg-muted" aria-hidden />
                      <span className="truncate">{fileName(e.path)}</span>
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Viewer / editor */}
        <div className="flex min-w-0 flex-col">
          {!selectedPath && (
            <div className="px-6 py-12">
              <EmptyState
                icon={<FolderOpen className="size-4" aria-hidden />}
                title="No file open"
                description="Pick a file on the left, or create a new one."
              />
            </div>
          )}

          {selectedPath && (
            <>
              <div className="flex flex-wrap items-center gap-3 border-b px-4 py-2.5">
                <p className="readout min-w-0 flex-1 truncate text-[12.5px]">{selectedPath}</p>
                <div className="flex items-center gap-2">
                  {canPublish && (
                    <Button size="sm" variant="secondary" className="h-7 text-[12px]" onClick={openPublish} disabled={loadingFile}>
                      <Rocket className="size-3.5" aria-hidden />
                      Publish as script
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" className="h-7 text-[12px] text-led-danger hover:text-led-danger" onClick={() => void removeSelected()} disabled={loadingFile || !meta}>
                    <Trash2 className="size-3.5" aria-hidden />
                    Delete
                  </Button>
                  <Button size="sm" className="h-7 text-[12px]" onClick={() => void save()} disabled={saving || loadingFile || !dirty}>
                    {saving ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Save className="size-3.5" aria-hidden />}
                    Save
                  </Button>
                </div>
              </div>

              {meta && (
                <p className="border-b px-4 py-1.5 text-[11.5px] text-fg-muted">
                  written by {attributionLabel(meta.createdBy)}
                  {meta.updatedBy && meta.updatedBy !== meta.createdBy && <> · last edited by {attributionLabel(meta.updatedBy)}</>}
                  {' · '}
                  {relativeTime(meta.updatedAt)}
                </p>
              )}

              {conflict && (
                <div className="border-b border-led-danger/40 bg-led-danger/5 px-4 py-3">
                  <p className="text-[12.5px] font-medium">This file changed since you opened it</p>
                  <p className="mt-0.5 text-[12px] text-fg-muted">{conflict.message}</p>
                  <div className="mt-2 flex gap-2">
                    <Button size="sm" variant="outline" className="h-7 text-[12px]" onClick={reloadDiscardingEdits}>
                      Reload (lose my edits)
                    </Button>
                    <Button size="sm" variant="outline" className="h-7 text-[12px]" onClick={copyMineToClipboard}>
                      Copy mine to clipboard
                    </Button>
                  </div>
                </div>
              )}

              {fileError && <p className="border-b px-4 py-2 text-[12px] text-led-danger">{fileError}</p>}

              <div className="flex-1 px-4 py-3">
                {loadingFile ? (
                  <LoadingRows rows={6} />
                ) : (
                  <Textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    className="min-h-[60vh] font-mono text-[12.5px] leading-relaxed"
                    spellCheck={false}
                  />
                )}
              </div>
            </>
          )}
        </div>
      </div>

      <Dialog open={publishOpen} onOpenChange={setPublishOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Publish as script</DialogTitle>
            <DialogDescription>
              The core bundles <span className="readout">{selectedPath}</span> itself — imports outside{' '}
              <span className="readout">@enkaku/sdk</span>, <span className="readout">zod</span>, or another workspace path fail the build.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="publish-name">Name</Label>
              <Input id="publish-name" value={publishName} onChange={(e) => setPublishName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="publish-version">Version</Label>
              <Input id="publish-version" value={publishVersion} onChange={(e) => setPublishVersion(e.target.value)} placeholder="1.0.0" />
            </div>
            {publishError && (
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-led-danger/40 bg-led-danger/5 p-2 text-[11.5px] text-led-danger">
                {publishError}
              </pre>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPublishOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void doPublish()} disabled={publishing || !publishName.trim() || !publishVersion.trim()}>
              {publishing ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Rocket className="size-3.5" aria-hidden />}
              Publish
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export default function WorkspacePage() {
  return (
    <Suspense fallback={<div className="px-5 py-4"><LoadingRows rows={4} /></div>}>
      <WorkspaceView />
    </Suspense>
  )
}
