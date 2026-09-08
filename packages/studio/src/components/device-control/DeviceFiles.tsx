'use client'

import { useEffect, useState } from 'react'
import {
  Button,
  CaretRightIcon,
  ConfirmDialog,
  FileIcon,
  FilmSlateIcon,
  FolderSimpleIcon,
  ImageIcon,
  PackageIcon,
  TrashIcon,
  UploadSimpleIcon,
  fileSize,
  useAction,
} from '@enkaku/ui'
import type { GenericActionId } from '@/lib/generic-actions'
import { deleteDeviceFile, listDeviceFiles, type DeviceFsEntry, type DeviceFsListResult } from '@/lib/device-fs'

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])
const VIDEO_EXT = new Set(['.mp4', '.mkv', '.webm', '.mov'])

function iconFor(entry: DeviceFsEntry) {
  if (entry.kind === 'dir') return FolderSimpleIcon
  const dot = entry.name.lastIndexOf('.')
  const ext = dot === -1 ? '' : entry.name.slice(dot).toLowerCase()
  if (ext === '.apk') return PackageIcon
  if (IMAGE_EXT.has(ext)) return ImageIcon
  if (VIDEO_EXT.has(ext)) return FilmSlateIcon
  return FileIcon
}

/**
 * The Device tab's Files section (design handoff README.md:284-289; plan 215
 * §4.12, §3.2 D9), moved onto the `device.fs.*` capabilities by plan 800
 * wave 6.
 *
 * It used to run `ls -lA` + `df -k` through the generic `adb` action and parse
 * the output here. That parser had to guess at a column layout that differs
 * between toybox and BusyBox and a date format that varies by locale, and the
 * `adb` action is gated on running arbitrary shell — which an operator may
 * legitimately have turned off on a network-exposed farm, at which point
 * browsing files failed for a reason that had nothing to do with files.
 *
 * Now one capability call returns parsed entries and free space together, over
 * the `device.files` permission that push and pull already use. `files-parse.ts`
 * is gone with it.
 */
export function DeviceFiles({
  deviceId,
  onAction,
  nodeOwned,
}: {
  deviceId: string
  onAction: (id: GenericActionId, params?: Record<string, unknown>) => void
  nodeOwned: boolean
}) {
  const [path, setPath] = useState('/sdcard')
  const [result, setResult] = useState<DeviceFsListResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { run, pending } = useAction()

  async function load(p: string) {
    setLoading(true)
    setError(null)
    try {
      setResult(await listDeviceFiles(deviceId, p))
    } catch (err) {
      setResult(null)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load(path)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId, path])

  if (nodeOwned) {
    return <p className="p-1 text-meta text-faint">Files runs on the host that owns this device.</p>
  }

  const entries = result?.entries ?? null
  const segments = path.replace(/^\/+/, '').split('/').filter(Boolean)
  const busy = pending !== null

  const remove = (entry: DeviceFsEntry) =>
    run(`rm-${entry.path}`, () => deleteDeviceFile(deviceId, entry.path, entry.kind === 'dir'), {
      success: `${entry.name} deleted`,
      failure: 'Could not delete it',
      onSuccess: () => void load(path),
    })

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1 text-meta">
        <button type="button" className="text-faint hover:text-text" onClick={() => setPath('/')}>
          /
        </button>
        {segments.map((seg, i) => {
          const target = '/' + segments.slice(0, i + 1).join('/')
          const isLast = i === segments.length - 1
          return (
            <span key={target} className="flex items-center gap-1">
              {i > 0 && <span className="text-faint">/</span>}
              {isLast ? (
                <span className="text-text">{seg}</span>
              ) : (
                <button type="button" className="text-faint hover:text-text" onClick={() => setPath(target)}>
                  {seg}
                </button>
              )}
            </span>
          )
        })}
      </div>

      <div className="flex items-center justify-between text-meta text-faint">
        <span>
          {entries
            ? [
                `${entries.length}${result?.truncated ? '+' : ''} items`,
                // `truncated` is shown as a "+" rather than swallowed: a count
                // that silently caps is a count someone will trust.
                result?.usage ? `${fileSize(result.usage.freeBytes)} free` : 'free space unknown',
              ].join(' · ')
            : loading
              ? 'Loading…'
              : ''}
        </span>
        <Button size="sm" variant="outline" onClick={() => onAction('push', { remotePath: path })}>
          <UploadSimpleIcon className="size-4" aria-hidden />
          Upload file
        </Button>
      </div>

      {error && <p className="text-meta text-danger">{error}</p>}

      <div className="flex flex-col">
        {entries?.map((entry) => {
          const Icon = iconFor(entry)
          const isDir = entry.kind === 'dir'
          return (
            <div key={entry.path} className="group flex items-center gap-2 rounded-button px-1.5 py-1.5 hover:bg-muted">
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-default"
                disabled={!isDir}
                onClick={() => isDir && setPath(entry.path)}
              >
                <Icon className={isDir ? 'size-4 shrink-0 text-warn' : 'size-4 shrink-0 text-faint'} aria-hidden />
                <span className="min-w-0 flex-1 truncate text-body">{entry.name}</span>
                <span className="shrink-0 text-meta text-faint">{entry.sizeBytes !== null && !isDir ? fileSize(entry.sizeBytes) : ''}</span>
              </button>

              {/*
                Delete is offered only under the roots the capability will
                actually write to — everywhere else the server refuses, and an
                affordance that always fails is worse than none. The check is
                the same rule, restated: a prefix test, never a `startsWith` on
                the bare root (which would match `/sdcard-evil`).
              */}
              {isWritable(entry.path) && (
                <ConfirmDialog
                  trigger={
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={`Delete ${entry.name}`}
                      className="shrink-0 rounded p-0.5 text-faint opacity-0 hover:text-danger focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-50"
                    >
                      <TrashIcon className="size-3.5" aria-hidden />
                    </button>
                  }
                  title={`Delete ${entry.name}?`}
                  description={
                    isDir
                      ? 'This directory and everything inside it will be removed from the device. This cannot be undone.'
                      : 'This file will be removed from the device. This cannot be undone.'
                  }
                  confirmLabel="Delete"
                  onConfirm={() => void remove(entry)}
                />
              )}

              {isDir && <CaretRightIcon className="size-3.5 shrink-0 text-faint" aria-hidden />}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/**
 * Mirrors `DEVICE_FS_WRITABLE_ROOTS` in the core. Duplicated rather than
 * imported because it lives in `packages/core`, which Studio does not depend
 * on — and the server is still the one that enforces it. This copy only
 * decides whether to OFFER the button; a stale copy shows a button that gets a
 * clean refusal, never a delete that should not have happened.
 */
const WRITABLE_ROOTS = ['/sdcard', '/storage/emulated/0', '/storage/self/primary', '/data/local/tmp']

function isWritable(path: string): boolean {
  return WRITABLE_ROOTS.some((root) => path.startsWith(`${root}/`))
}
