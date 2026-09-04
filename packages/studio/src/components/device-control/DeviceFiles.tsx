'use client'

import { useEffect, useState } from 'react'
import {
  Button,
  CaretRightIcon,
  DotsThreeIcon,
  FileIcon,
  FilmSlateIcon,
  FolderSimpleIcon,
  ImageIcon,
  PackageIcon,
  UploadSimpleIcon,
} from '@enkaku/ui'
import { runOnDevice } from '@/lib/actions'
import type { GenericActionId } from '@/lib/generic-actions'
import { parseFilesOutput, type DeviceFileEntry } from './files-parse'

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])
const VIDEO_EXT = new Set(['.mp4', '.mkv', '.webm', '.mov'])

function iconFor(entry: DeviceFileEntry) {
  if (entry.kind === 'dir') return FolderSimpleIcon
  const dot = entry.name.lastIndexOf('.')
  const ext = dot === -1 ? '' : entry.name.slice(dot).toLowerCase()
  if (ext === '.apk') return PackageIcon
  if (IMAGE_EXT.has(ext)) return ImageIcon
  if (VIDEO_EXT.has(ext)) return FilmSlateIcon
  return FileIcon
}

/**
 * The Device tab's Files section (design handoff README.md:284-289; plan
 * 215 §4.12, §3.2 D9): runs `ls -lA` + `df -k` through plan 207's `adb`
 * action — no core route, no capability, no new WS message.
 */
export function DeviceFiles({ deviceId, onAction, nodeOwned }: { deviceId: string; onAction: (id: GenericActionId, params?: Record<string, unknown>) => void; nodeOwned: boolean }) {
  const [path, setPath] = useState('/sdcard')
  const [entries, setEntries] = useState<DeviceFileEntry[] | null>(null)
  const [freePct, setFreePct] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function load(p: string) {
    setLoading(true)
    setError(null)
    try {
      const cmd = `ls -lA -- '${p}'; echo '@@enkaku-df@@'; df -k '${p}' | tail -n 1`
      const res = await runOnDevice('adb', deviceId, { cmd })
      const stdout = (res.detail as { stdout?: string } | undefined)?.stdout ?? ''
      const parsed = parseFilesOutput(stdout)
      setEntries(parsed.entries)
      setFreePct(parsed.freePct)
    } catch (err) {
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

  const segments = path.replace(/^\/+/, '').split('/').filter(Boolean)

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1 text-meta">
        {segments.map((seg, i) => {
          const target = '/' + segments.slice(0, i + 1).join('/')
          const isLast = i === segments.length - 1
          return (
            <span key={target} className="flex items-center gap-1">
              {i > 0 && <span className="text-faint">/</span>}
              {isLast ? <span className="text-text">{seg}</span> : (
                <button type="button" className="text-faint hover:text-text" onClick={() => setPath(target)}>
                  {seg}
                </button>
              )}
            </span>
          )
        })}
      </div>
      <div className="flex items-center justify-between text-meta text-faint">
        <span>{entries ? `${entries.length} items · ${freePct !== null ? `${freePct}% free` : 'free space unknown'}` : loading ? 'Loading…' : ''}</span>
        <Button size="sm" variant="outline" onClick={() => onAction('push', { remotePath: path })}>
          <UploadSimpleIcon className="size-4" aria-hidden />
          Upload file
        </Button>
      </div>
      {error && <p className="text-meta text-danger">{error}</p>}
      <div className="flex flex-col">
        {entries?.map((entry) => {
          const Icon = iconFor(entry)
          return (
            <button
              key={entry.name}
              type="button"
              className="flex items-center gap-2 rounded-button px-1.5 py-1.5 text-left hover:bg-muted disabled:cursor-default"
              disabled={entry.kind !== 'dir'}
              onClick={() => entry.kind === 'dir' && setPath(`${path.replace(/\/$/, '')}/${entry.name}`)}
            >
              <Icon className={entry.kind === 'dir' ? 'size-4 shrink-0 text-warn' : 'size-4 shrink-0 text-faint'} aria-hidden />
              <span className="min-w-0 flex-1 truncate text-body">{entry.name}</span>
              <span className="shrink-0 text-meta text-faint">
                {entry.size !== null ? `${entry.size}` : ''}
                {entry.modified ? ` · ${entry.modified}` : ''}
              </span>
              {entry.kind === 'dir' ? (
                <CaretRightIcon className="size-3.5 shrink-0 text-faint" aria-hidden />
              ) : (
                <DotsThreeIcon className="size-4 shrink-0 text-faint" aria-hidden />
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
