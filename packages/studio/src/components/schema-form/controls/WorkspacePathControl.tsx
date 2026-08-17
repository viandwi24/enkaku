'use client'

import { useCallback, useEffect, useState } from 'react'
import { File, Folder, FolderOpen, X } from 'lucide-react'
import { Button, Skeleton, cn } from '@enkaku/ui'
import { listWorkspace, type WorkspaceListEntry } from '@/lib/workspace'
import type { FieldPlan } from '../plan'
import { FieldRow } from './shell'
import type { BaseControlProps } from './types'

/**
 * The two workspace path kinds (`kind: 'workspaceFolder'` and
 * `kind: 'workspaceFile'`), drawn as a browser over the workspace instead of
 * a text box the operator has to type a path into from memory.
 *
 * ONE component for both, because a folder picker and a file picker over the
 * same tree differ in exactly one thing — what is clickable — and `target`
 * says which. Directories always navigate; in `file` mode a file row selects,
 * in `folder` mode the "Use this folder" button selects wherever you are
 * standing.
 *
 * It talks to the workspace through `@/lib/workspace`'s `listWorkspace`, the
 * same `fs.list` capability the `/workspace` page and every agent already
 * use — there is no second workspace client, and no Studio-only endpoint
 * behind this control.
 *
 * ## What `fs.list` actually returns, and why `dirPath`/`storedPath` exist
 *
 * The workspace is a DB table of file rows with path strings; a directory is
 * not a row. `fs.list` SYNTHESISES a `kind: 'dir'` entry from the paths
 * beneath it and returns it WITH a trailing slash (`/videos/`) — while
 * `normaliseWorkspacePath`, which every other `fs.*` call runs its argument
 * through, refuses a trailing slash. So the two forms are converted at this
 * boundary, once: a browsing prefix always ends in `/`, a stored value never
 * does (except the root, which is `/` in both).
 *
 * Two consequences worth stating rather than discovering:
 *   - an EMPTY folder does not exist and cannot be picked, because nothing
 *     synthesises it. The empty state says so.
 *   - a folder disappears when its last file is deleted, so a stored value
 *     can name a folder the tree no longer lists. It is still shown as the
 *     current value, never silently blanked.
 */

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || value === ''
}

/** A stored value (`/videos`, `/`) → the prefix `fs.list` wants (`/videos/`, `/`). */
function dirPrefix(path: string): string {
  return path.endsWith('/') ? path : `${path}/`
}

/** A listed entry (`/videos/`) → the form the value is stored in (`/videos`). */
function storedPath(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
}

/** The prefix to open the browser at for a current value. A file opens in its
 *  own folder; a folder opens inside itself, so "Use this folder" re-selects
 *  what is already selected rather than its parent. */
function startPrefix(value: unknown, target: 'folder' | 'file'): string {
  if (typeof value !== 'string' || value === '') return '/'
  if (target === 'folder') return dirPrefix(value)
  const i = value.lastIndexOf('/')
  return i <= 0 ? '/' : value.slice(0, i + 1)
}

function baseName(path: string): string {
  const trimmed = storedPath(path)
  return trimmed.slice(trimmed.lastIndexOf('/') + 1)
}

function breadcrumbs(prefix: string): { label: string; prefix: string }[] {
  if (prefix === '/') return [{ label: 'Workspace', prefix: '/' }]
  const crumbs = [{ label: 'Workspace', prefix: '/' }]
  let acc = '/'
  for (const segment of prefix.slice(1, -1).split('/')) {
    acc += `${segment}/`
    crumbs.push({ label: segment, prefix: acc })
  }
  return crumbs
}

/** Case-insensitive suffix match. A declared filter narrows what is OFFERED,
 *  never what is accepted — a value already stored is still displayed. */
function matchesExtensions(path: string, extensions: string[] | undefined): boolean {
  if (!extensions || extensions.length === 0) return true
  const lower = path.toLowerCase()
  return extensions.some((ext) => lower.endsWith(ext.toLowerCase()))
}

export function WorkspacePathControl({
  id,
  path,
  label,
  help,
  error,
  value,
  required,
  onChange,
  plan,
  bare,
}: BaseControlProps & { plan: Extract<FieldPlan, { control: 'workspacePath' }> }) {
  const { target, extensions } = plan
  const selected = typeof value === 'string' && value !== '' ? value : null
  const [prefix, setPrefix] = useState(() => startPrefix(value, target))
  const [entries, setEntries] = useState<WorkspaceListEntry[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)

  const load = useCallback((at: string) => {
    let cancelled = false
    setEntries(null)
    setListError(null)
    listWorkspace(at)
      .then((result) => {
        if (!cancelled) setEntries(result)
      })
      .catch((err: unknown) => {
        if (!cancelled) setListError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => load(prefix), [prefix, load])

  const visible = (entries ?? []).filter((entry) => entry.kind === 'dir' || target === 'file')
  const selectable = target === 'file' ? visible.filter((e) => e.kind === 'file' && matchesExtensions(e.path, extensions)) : visible
  const filterHid = target === 'file' && extensions !== undefined && visible.some((e) => e.kind === 'file' && !matchesExtensions(e.path, extensions))

  const browser = (
    <div className="overflow-hidden rounded-md border">
      <div className="flex flex-wrap items-center gap-1 border-b bg-surface-2 px-2 py-1.5 text-[11.5px]">
        {breadcrumbs(prefix).map((crumb, i) => (
          <span key={crumb.prefix} className="flex items-center gap-1">
            {i > 0 && <span className="text-fg-subtle">/</span>}
            <button
              type="button"
              onClick={() => setPrefix(crumb.prefix)}
              className={cn('rounded px-1 hover:bg-surface', crumb.prefix === prefix ? 'font-medium text-fg' : 'text-fg-muted')}
            >
              {crumb.label}
            </button>
          </span>
        ))}
        {target === 'folder' && (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="ml-auto h-6 px-2 text-[11.5px]"
            disabled={storedPath(prefix) === selected}
            onClick={() => onChange(path, storedPath(prefix))}
          >
            Use this folder
          </Button>
        )}
      </div>

      <div className="max-h-56 overflow-y-auto">
        {listError !== null && (
          <div className="px-3 py-3">
            <p className="text-[12px] text-led-danger">Could not list the workspace — {listError}</p>
            <Button type="button" size="sm" variant="outline" className="mt-2 h-6 px-2 text-[11.5px]" onClick={() => load(prefix)}>
              Try again
            </Button>
          </div>
        )}

        {listError === null && entries === null && (
          <div className="space-y-1.5 px-3 py-2.5" aria-busy="true" aria-live="polite">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-3/5" />
          </div>
        )}

        {listError === null && entries !== null && visible.length === 0 && (
          <p className="px-3 py-4 text-center text-[11.5px] text-fg-muted">
            {prefix === '/'
              ? 'The workspace is empty. Add a file on the Workspace page first — a folder only exists once something is inside it.'
              : target === 'folder'
                ? 'No folders inside this one.'
                : 'Nothing here.'}
          </p>
        )}

        {listError === null && entries !== null && visible.length > 0 && (
          <ul className="py-1">
            {visible.map((entry) => {
              const isDir = entry.kind === 'dir'
              const stored = storedPath(entry.path)
              const offered = isDir || matchesExtensions(entry.path, extensions)
              const isSelected = !isDir && stored === selected
              return (
                <li key={entry.path}>
                  <button
                    type="button"
                    disabled={!offered}
                    onClick={() => (isDir ? setPrefix(entry.path) : onChange(path, stored))}
                    className={cn(
                      'flex w-full items-center gap-2 px-3 py-1 text-left text-[12px] hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent',
                      isSelected && 'bg-surface-2 font-medium',
                    )}
                  >
                    {isDir ? (
                      <Folder className="size-3.5 shrink-0 text-fg-muted" aria-hidden />
                    ) : (
                      <File className="size-3.5 shrink-0 text-fg-muted" aria-hidden />
                    )}
                    <span className="truncate">{baseName(entry.path)}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {filterHid && selectable.length === 0 && entries !== null && (
        <p className="border-t px-3 py-1.5 text-[11px] text-fg-muted">Nothing here matches {extensions?.join(', ')}.</p>
      )}
      {filterHid && selectable.length > 0 && (
        <p className="border-t px-3 py-1.5 text-[11px] text-fg-muted">Only {extensions?.join(', ')} files can be picked here.</p>
      )}
    </div>
  )

  if (bare) return <div aria-label={label}>{browser}</div>

  return (
    <FieldRow
      id={id}
      label={label}
      help={help}
      error={error}
      readout={
        selected ? (
          <span className="inline-flex items-center gap-1.5">
            {target === 'folder' ? <FolderOpen className="size-3" aria-hidden /> : null}
            {selected}
            {!required && (
              <button
                type="button"
                aria-label={`Clear ${label}`}
                onClick={() => onChange(path, undefined)}
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
      {browser}
    </FieldRow>
  )
}
