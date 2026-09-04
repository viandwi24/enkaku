'use client'

import { useEffect, useRef, useState } from 'react'
import { CHANNEL, decodeSnapshot, type InspectState, type UiNode } from '@enkaku/protocol'
import { Button, CameraIcon, cn } from '@enkaku/ui'
import { newId, ws, WsRequestError } from '@/lib/ws'

/** Copied from `InspectorPanel.tsx` before that file was deleted (plan 215 §4.11). */
function shortClassName(className: string): string {
  const idx = className.lastIndexOf('.')
  return idx === -1 ? className : className.slice(idx + 1)
}

function primaryLabel(node: UiNode): string {
  if (node.resourceId.trim()) return node.resourceId
  if (node.text.trim()) return node.text
  if (node.desc.trim()) return node.desc
  return ''
}

interface FlatRow {
  node: UiNode
  depth: number
  path: number[]
}

function flatten(node: UiNode, depth = 0, path: number[] = []): FlatRow[] {
  const rows: FlatRow[] = [{ node, depth, path }]
  node.children.forEach((child, i) => rows.push(...flatten(child, depth + 1, [...path, i])))
  return rows
}

/**
 * The Inspector tab (design handoff README.md:274-278; plan 215 §4.11):
 * Snapshot with Capture, UI nodes tree, Node details. Captures on demand —
 * no follow poll, no dump history, no selector-candidate strip (D10).
 */
export function Inspector({ deviceId, nodeOwned }: { deviceId: string; nodeOwned: boolean }) {
  const [status, setStatus] = useState<InspectState>('detached')
  const [reason, setReason] = useState<string | null>(null)
  const [tree, setTree] = useState<{ root: UiNode; frameSize: { width: number; height: number } } | null>(null)
  const [snapshotUrl, setSnapshotUrl] = useState<string | null>(null)
  const [selectedPath, setSelectedPath] = useState<number[] | null>(null)
  const [capturing, setCapturing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const snapshotUrlRef = useRef<string | null>(null)
  const attachedRef = useRef(false)

  async function capture() {
    setCapturing(true)
    setError(null)
    const requestId = Math.floor(Math.random() * 200)
    try {
      const res = await ws.request({ type: 'inspect.dump', id: newId(), payload: { deviceId, requestId, screenshot: true } })
      if (res.type === 'inspect.tree') {
        setTree({ root: res.payload.root, frameSize: res.payload.frameSize })
        setSelectedPath(null)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setCapturing(false)
    }
  }

  useEffect(() => {
    if (nodeOwned || attachedRef.current) return
    attachedRef.current = true
    let cancelled = false
    async function attach() {
      try {
        const res = await ws.request({ type: 'inspect.attach', id: newId(), payload: { deviceId } }, 50_000)
        if (cancelled || res.type !== 'inspect.status') return
        setStatus(res.payload.state)
        setReason(res.payload.reason ?? null)
        if (res.payload.state === 'ready') void capture()
      } catch (err) {
        if (cancelled) return
        if (err instanceof WsRequestError && err.code === 'E_INSPECTOR_STARTING') {
          setStatus('starting')
          setReason(err.message)
        } else {
          setError(err instanceof Error ? err.message : String(err))
        }
      }
    }
    void attach()
    return () => {
      cancelled = true
      ws.send({ type: 'inspect.detach', payload: { deviceId } })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId, nodeOwned])

  useEffect(() => {
    const off = ws.onBinary((buf) => {
      if (buf.length === 0 || buf[0] !== CHANNEL.SNAPSHOT) return
      try {
        const png = decodeSnapshot(buf)
        const url = URL.createObjectURL(new Blob([png.data.slice() as unknown as BlobPart], { type: 'image/png' }))
        if (snapshotUrlRef.current) URL.revokeObjectURL(snapshotUrlRef.current)
        snapshotUrlRef.current = url
        setSnapshotUrl(url)
      } catch {
        // A snapshot frame that fails to decode is dropped; the tree stays valid.
      }
    })
    return () => {
      off()
      if (snapshotUrlRef.current) URL.revokeObjectURL(snapshotUrlRef.current)
    }
  }, [])

  if (nodeOwned) {
    return <p className="p-3 text-meta text-faint">Inspection runs on the host that owns this device.</p>
  }

  if (status === 'starting') {
    return (
      <div className="flex flex-col gap-2 p-3 text-meta text-faint">
        <p>{reason ?? 'The inspector is still starting.'}</p>
        <Button size="sm" variant="outline" onClick={() => void capture()}>
          Retry
        </Button>
      </div>
    )
  }

  const selected = selectedPath && tree ? flatten(tree.root).find((r) => r.path.join(',') === selectedPath.join(','))?.node ?? null : null

  return (
    <div className="flex flex-col gap-3 p-3">
      {error && <p className="text-meta text-danger">{error}</p>}
      <div className="flex items-start gap-2">
        <div className="relative aspect-[9/19.5] w-[104px] shrink-0 overflow-hidden rounded-inner border border-border-2">
          {snapshotUrl && <img src={snapshotUrl} alt="" className="h-full w-full object-contain" />}
          {selected && tree && (
            <div
              className="absolute border-[1.5px] border-accent bg-accent-a2"
              style={{
                left: `${(selected.bounds.left / tree.frameSize.width) * 100}%`,
                top: `${(selected.bounds.top / tree.frameSize.height) * 100}%`,
                width: `${((selected.bounds.right - selected.bounds.left) / tree.frameSize.width) * 100}%`,
                height: `${((selected.bounds.bottom - selected.bounds.top) / tree.frameSize.height) * 100}%`,
              }}
            />
          )}
        </div>
        <Button variant="outline" size="sm" disabled={capturing} onClick={() => void capture()}>
          <CameraIcon className="size-4" aria-hidden />
          {capturing ? 'Capturing…' : 'Capture'}
        </Button>
      </div>

      <div className="max-h-[220px] overflow-y-auto font-mono text-[11.5px]">
        {tree ? (
          flatten(tree.root).map((row) => {
            const label = primaryLabel(row.node)
            const key = row.path.join(',') || 'root'
            return (
              <button
                key={key}
                type="button"
                style={{ paddingLeft: row.depth * 12 }}
                className={cn(
                  'block w-full truncate rounded-inner px-1 py-0.5 text-left',
                  selectedPath && selectedPath.join(',') === row.path.join(',') ? 'bg-accent-soft text-accent' : 'text-text',
                )}
                onClick={() => setSelectedPath(row.path)}
              >
                {shortClassName(row.node.className)}
                {label ? ` "${label}"` : ''}
              </button>
            )
          })
        ) : (
          <p className="text-faint">No capture yet.</p>
        )}
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 font-mono text-[11px]">
        <NodeDetailRow label="class" value={selected ? shortClassName(selected.className) : null} />
        <NodeDetailRow label="resource id" value={selected?.resourceId || null} />
        <NodeDetailRow label="text" value={selected?.text || null} />
        <NodeDetailRow
          label="bounds"
          value={selected ? `${selected.bounds.left},${selected.bounds.top} ${selected.bounds.right},${selected.bounds.bottom}` : null}
        />
        <NodeDetailRow label="clickable" value={selected ? String(selected.clickable) : null} />
        <NodeDetailRow label="enabled" value={selected ? String(selected.enabled) : null} />
        <NodeDetailRow label="package" value={selected?.packageName || null} />
        <NodeDetailRow label="depth" value={selectedPath ? String(selectedPath.length) : null} />
      </dl>
    </div>
  )
}

function NodeDetailRow({ label, value }: { label: string; value: string | null }) {
  return (
    <>
      <dt className="text-faint">{label}</dt>
      <dd className="truncate text-text">{value || '–'}</dd>
    </>
  )
}
