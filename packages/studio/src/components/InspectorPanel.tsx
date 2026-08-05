'use client'

import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { toast } from 'sonner'
import { ChevronDown, ChevronRight, Copy, RefreshCw } from 'lucide-react'
import {
  CHANNEL,
  decodeSnapshot,
  proposeSelectors,
  type InspectState,
  type Selector,
  type SelectorCandidate,
  type UiNode,
} from '@enkaku/protocol'
import { Button } from '@/components/ui/button'
import { EmptyState, ErrorState, LoadingRows } from '@/components/states'
import { relativeTime } from '@/lib/format'
import { useNow } from '@/lib/useNow'
import { newId, ws } from '@/lib/ws'
import { cn } from '@/lib/utils'

/**
 * The Inspect tab (plan 56) — dumps the on-device UI tree through the
 * existing `Inspector` driver, shows it beside a snapshot taken at the same
 * instant, and turns a picked node into a ranked, match-counted selector an
 * operator can test on the device and paste into a script.
 *
 * Mount-on-demand, like `MonitorPane`/`CrashesPanel` (device/page.tsx §3.1,
 * §4.1) — never kept alive under a hidden `TabPanel`. This tab holds an
 * on-device engine (`instrumentation` lock, an `adb.maxConcurrent` slot) for
 * as long as it is attached, so mounting only while the tab is actually open
 * is what makes "released when the tab is not open" (§3.2, acceptance #8)
 * true rather than aspirational.
 */

interface TreePayload {
  root: UiNode
  frameSize: { width: number; height: number }
  at: number
  tookMs: number
  requestId: number
}

type TestOutcome = { matched: boolean; identity: string | null; tookMs: number; error?: string }

const DEFAULT_EXPAND_DEPTH = 3

function shortClassName(className: string): string {
  const idx = className.lastIndexOf('.')
  return idx === -1 ? className : className.slice(idx + 1)
}

/** The first non-empty of resourceId / text / desc — whatever most identifies this node at a glance. */
function primaryLabel(node: UiNode): { text: string; kind: 'id' | 'text' | 'desc' | null } {
  if (node.resourceId.trim()) return { text: node.resourceId, kind: 'id' }
  if (node.text.trim()) return { text: node.text, kind: 'text' }
  if (node.desc.trim()) return { text: node.desc, kind: 'desc' }
  return { text: '', kind: null }
}

function nodeAt(root: UiNode, path: number[]): UiNode | null {
  let node = root
  for (const i of path) {
    const child = node.children[i]
    if (!child) return null
    node = child
  }
  return node
}

function containsPoint(b: UiNode['bounds'], x: number, y: number): boolean {
  return x >= b.left && x < b.right && y >= b.top && y < b.bottom
}

/** The deepest node whose bounds contain (x, y) in device-pixel space — depth-first, first match at each level. */
function deepestContaining(node: UiNode, x: number, y: number, path: number[] = []): { node: UiNode; path: number[] } | null {
  if (!containsPoint(node.bounds, x, y)) return null
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i]
    if (!child) continue
    const hit = deepestContaining(child, x, y, [...path, i])
    if (hit) return hit
  }
  return { node, path }
}

interface FlatRow {
  key: string
  node: UiNode
  path: number[]
  depth: number
  hasChildren: boolean
}

/** A flattened, DFS-ordered row list (device/page.tsx-style — never nested JSX for a tree that can run to hundreds of nodes, §4.4 risk mitigation). Collapsed branches contribute no rows past their own. */
function flattenTree(root: UiNode, expanded: Set<string>): FlatRow[] {
  const rows: FlatRow[] = []
  const walk = (node: UiNode, path: number[], depth: number) => {
    const key = path.join('.') || 'root'
    rows.push({ key, node, path, depth, hasChildren: node.children.length > 0 })
    if (node.children.length > 0 && !expanded.has(key)) return
    node.children.forEach((child, i) => walk(child, [...path, i], depth + 1))
  }
  walk(root, [], 0)
  return rows
}

/** Every leaf carrying non-empty text, anywhere in the tree — the "find a label fast" filter (§4.4). */
function textLeaves(root: UiNode): FlatRow[] {
  const rows: FlatRow[] = []
  const walk = (node: UiNode, path: number[]) => {
    if (node.children.length === 0 && node.text.trim()) {
      rows.push({ key: path.join('.') || 'root', node, path, depth: 0, hasChildren: false })
    }
    node.children.forEach((child, i) => walk(child, [...path, i]))
  }
  walk(root, [])
  return rows
}

function candidateKey(sel: Selector): string {
  return JSON.stringify(sel)
}

function quoteJs(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

function formatSelectorLiteral(sel: Selector): string {
  if ('id' in sel) return `{ id: ${quoteJs(sel.id)} }`
  if ('desc' in sel) return `{ desc: ${quoteJs(sel.desc)} }`
  if ('text' in sel) return `{ text: ${quoteJs(sel.text)} }`
  return `{ point: { x: ${sel.point.x}, y: ${sel.point.y} } }`
}

function nodeIdentity(node: UiNode): string {
  const label = primaryLabel(node)
  return `${shortClassName(node.className)}${label.text ? ` "${label.text}"` : ''}`
}

export function InspectorPanel({ deviceId }: { deviceId: string }) {
  const now = useNow(1000)

  const [state, setState] = useState<InspectState>('detached')
  const [engineId, setEngineId] = useState('')
  const [capabilities, setCapabilities] = useState<string[]>([])
  const [reason, setReason] = useState<string | null>(null)
  const [attachError, setAttachError] = useState<string | null>(null)

  const [tree, setTree] = useState<TreePayload | null>(null)
  const [dumpLoading, setDumpLoading] = useState(false)
  const [dumpError, setDumpError] = useState<string | null>(null)
  const [snapshotUrl, setSnapshotUrl] = useState<string | null>(null)
  const [snapshotRequestId, setSnapshotRequestId] = useState<number | null>(null)
  const [stale, setStale] = useState(false)

  const [selectedPath, setSelectedPath] = useState<number[] | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [textOnlyFilter, setTextOnlyFilter] = useState(false)

  const [testingKey, setTestingKey] = useState<string | null>(null)
  const [testResults, setTestResults] = useState<Record<string, TestOutcome>>({})
  const [copiedKey, setCopiedKey] = useState<string | null>(null)

  const nextRequestIdRef = useRef(0)
  const snapshotUrlRef = useRef<string | null>(null)
  const imgRef = useRef<HTMLImageElement>(null)

  const nextRequestId = (): number => {
    const id = nextRequestIdRef.current
    nextRequestIdRef.current = (id + 1) & 0xff
    return id
  }

  // ---- attach / detach lifecycle — the engine runs only while this
  // component is mounted (§3.2, acceptance #8). ----
  useEffect(() => {
    setState('detached')
    setEngineId('')
    setCapabilities([])
    setReason(null)
    setAttachError(null)
    setTree(null)
    setSnapshotUrl(null)
    setSnapshotRequestId(null)
    setSelectedPath(null)
    setTestResults({})

    let cancelled = false
    const attach = () => {
      setState('starting')
      ws.request({ type: 'inspect.attach', id: newId(), payload: { deviceId } })
        .then((res) => {
          if (cancelled || res.type !== 'inspect.status') return
          setState(res.payload.state)
          setEngineId(res.payload.engineId)
          setCapabilities(res.payload.capabilities)
          setReason(res.payload.reason ?? null)
        })
        .catch((err) => {
          if (cancelled) return
          setState('detached')
          setAttachError(err instanceof Error ? err.message : String(err))
        })
    }
    attach()
    const offReconnect = ws.onReconnected(attach)

    // The interim 'starting' push (no `id`, so it never resolves the
    // request above) — cosmetic only, kept separate from the final
    // ready/unavailable outcome the request settles with.
    const off = ws.on((msg) => {
      if (msg.type === 'inspect.status' && msg.payload.deviceId === deviceId && msg.payload.state === 'starting') {
        setState('starting')
      }
    })

    return () => {
      cancelled = true
      off()
      offReconnect()
      ws.send({ type: 'inspect.detach', payload: { deviceId } })
    }
  }, [deviceId])

  // A tree describes the instant it was dumped, never longer (§3.3): any
  // input recorded on this device — from ANY viewer, not only this tab —
  // marks the visible tree stale rather than pretending it still applies.
  useEffect(() => {
    ws.send({ type: 'log.subscribe', id: newId(), payload: { deviceId, streams: ['input'] } })
    const off = ws.on((msg) => {
      if (msg.type === 'device.event' && msg.payload.deviceId === deviceId && msg.payload.stream === 'input') {
        setStale(true)
      }
    })
    return () => {
      off()
      ws.send({ type: 'log.unsubscribe', payload: { deviceId } })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId])

  // The snapshot PNG rides CHANNEL.SNAPSHOT, correlated by requestId (§3.8)
  // — a single connection-wide binary handler, active regardless of which
  // dump is in flight; the requestId match is what keeps a stale reply from
  // a superseded refresh from ever being shown.
  useEffect(() => {
    const off = ws.onBinary((buf) => {
      if (buf.length === 0 || buf[0] !== CHANNEL.SNAPSHOT) return
      const { requestId, data } = decodeSnapshot(buf)
      const blob = new Blob([data.slice()], { type: 'image/png' })
      const url = URL.createObjectURL(blob)
      if (snapshotUrlRef.current) URL.revokeObjectURL(snapshotUrlRef.current)
      snapshotUrlRef.current = url
      setSnapshotUrl(url)
      setSnapshotRequestId(requestId)
    })
    return () => {
      off()
      if (snapshotUrlRef.current) {
        URL.revokeObjectURL(snapshotUrlRef.current)
        snapshotUrlRef.current = null
      }
    }
  }, [])

  async function refresh() {
    if (state !== 'ready') return
    setDumpLoading(true)
    setDumpError(null)
    const requestId = nextRequestId()
    try {
      const res = await ws.request({ type: 'inspect.dump', id: newId(), payload: { deviceId, requestId, screenshot: true } })
      if (res.type !== 'inspect.tree') return
      setTree({ root: res.payload.root, frameSize: res.payload.frameSize, at: res.payload.at, tookMs: res.payload.tookMs, requestId })
      setSelectedPath(null)
      setStale(false)
      setTestResults({})
      // Auto-expand the default depth of the FRESH tree — a stale
      // `expanded` set from a previous dump would otherwise show nothing at
      // all if the new tree happens to be shallower.
      const initial = new Set<string>()
      const seed = (node: UiNode, path: number[], depth: number) => {
        if (depth < DEFAULT_EXPAND_DEPTH) initial.add(path.join('.') || 'root')
        node.children.forEach((c, i) => seed(c, [...path, i], depth + 1))
      }
      seed(res.payload.root, [], 0)
      setExpanded(initial)
      if (!res.payload.snapshot) setSnapshotUrl(null)
    } catch (err) {
      setDumpError(err instanceof Error ? err.message : String(err))
    } finally {
      setDumpLoading(false)
    }
  }

  // The first dump happens automatically once the engine is ready — an
  // operator opening the tab should not have to also press Refresh.
  const autoRefreshedFor = useRef<string | null>(null)
  useEffect(() => {
    if (state === 'ready' && autoRefreshedFor.current !== deviceId) {
      autoRefreshedFor.current = deviceId
      void refresh()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, deviceId])

  async function testOnDevice(candidate: SelectorCandidate) {
    if (state !== 'ready' || candidate.kind === 'point') return
    const key = candidateKey(candidate.selector)
    setTestingKey(key)
    const requestId = nextRequestId()
    try {
      const res = await ws.request({ type: 'inspect.find', id: newId(), payload: { deviceId, requestId, selector: candidate.selector } })
      if (res.type !== 'inspect.match') return
      setTestResults((m) => ({
        ...m,
        [key]: { matched: res.payload.node !== null, identity: res.payload.node ? nodeIdentity(res.payload.node) : null, tookMs: res.payload.tookMs },
      }))
    } catch (err) {
      setTestResults((m) => ({ ...m, [key]: { matched: false, identity: null, tookMs: 0, error: err instanceof Error ? err.message : String(err) } }))
    } finally {
      setTestingKey(null)
    }
  }

  function copyLine(candidate: SelectorCandidate) {
    const line = `await ctx.device.tap(${formatSelectorLiteral(candidate.selector)})`
    void navigator.clipboard
      .writeText(line)
      .then(() => {
        setCopiedKey(candidateKey(candidate.selector))
        setTimeout(() => setCopiedKey(null), 1500)
      })
      .catch(() => toast.error('Could not copy to the clipboard'))
  }

  function toggleExpand(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function selectPath(path: number[]) {
    setSelectedPath(path)
    // Selecting a node from the tree should reveal it, not require a second click to expand its way there.
    setExpanded((prev) => {
      const next = new Set(prev)
      for (let i = 0; i < path.length; i++) next.add(path.slice(0, i).join('.') || 'root')
      return next
    })
  }

  function onSnapshotClick(e: MouseEvent<HTMLImageElement>) {
    if (!tree) return
    const img = imgRef.current
    if (!img) return
    const rect = img.getBoundingClientRect()
    const nx = (e.clientX - rect.left) / rect.width
    const ny = (e.clientY - rect.top) / rect.height
    const x = Math.round(nx * tree.frameSize.width)
    const y = Math.round(ny * tree.frameSize.height)
    const hit = deepestContaining(tree.root, x, y)
    if (hit) selectPath(hit.path)
  }

  const selectedNode = tree && selectedPath ? nodeAt(tree.root, selectedPath) : null
  const candidates = useMemo(() => (tree && selectedNode ? proposeSelectors(tree.root, selectedNode) : []), [tree, selectedNode])

  const rows = useMemo(() => {
    if (!tree) return []
    return textOnlyFilter ? textLeaves(tree.root) : flattenTree(tree.root, expanded)
  }, [tree, expanded, textOnlyFilter])

  const highlight =
    tree && selectedNode
      ? {
          left: (selectedNode.bounds.left / tree.frameSize.width) * 100,
          top: (selectedNode.bounds.top / tree.frameSize.height) * 100,
          width: ((selectedNode.bounds.right - selectedNode.bounds.left) / tree.frameSize.width) * 100,
          height: ((selectedNode.bounds.bottom - selectedNode.bounds.top) / tree.frameSize.height) * 100,
        }
      : null

  // ---- render ----

  if (state === 'detached' || state === 'starting') {
    return (
      <div className="px-5 py-4">
        {attachError ? (
          <ErrorState message={attachError} />
        ) : (
          <div className="flex items-center gap-2 text-[12.5px] text-fg-muted">
            <RefreshCw className="size-3.5 animate-spin" aria-hidden />
            Starting the inspector…
          </div>
        )}
      </div>
    )
  }

  if (state === 'unavailable') {
    return (
      <div className="px-5 py-4">
        <ErrorState message={reason ?? `The ${engineId || 'inspector'} engine is not available on this session.`} />
      </div>
    )
  }

  return (
    <div className="px-5 py-4">
      {/* Header: engine, tree age, staleness, Refresh (§4.4). */}
      <div className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border bg-surface px-3.5 py-2.5">
        <span className="rack-label">{engineId}</span>
        <span className="readout text-[11.5px] text-fg-muted">
          {tree ? `taken ${relativeTime(tree.at, now)} · ${tree.tookMs}ms` : 'no dump yet'}
        </span>
        {stale && tree && (
          <span className="rounded-full border border-led-warn/35 bg-led-warn/10 px-2 py-0.5 text-[11px] text-led-warn">
            input was sent — this tree may no longer match the screen
          </span>
        )}
        <Button variant="outline" size="sm" className="ml-auto" onClick={() => void refresh()} disabled={dumpLoading}>
          <RefreshCw className={cn('size-3.5', dumpLoading && 'animate-spin')} aria-hidden />
          Refresh
        </Button>
      </div>

      {dumpError && <ErrorState message={dumpError} onRetry={() => void refresh()} />}

      {!tree && !dumpError && dumpLoading && <LoadingRows rows={4} />}

      {!tree && !dumpError && !dumpLoading && (
        <EmptyState title="No dump yet" description="Refresh to read the current screen." />
      )}

      {tree && (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          {/* Left: the tree. */}
          <div className="min-w-0">
            <div className="mb-2 flex items-center justify-between">
              <span className="rack-label">tree ({countNodes(tree.root)} nodes)</span>
              <label className="flex items-center gap-1.5 text-[11.5px] text-fg-muted">
                <input
                  type="checkbox"
                  checked={textOnlyFilter}
                  onChange={(e) => setTextOnlyFilter(e.target.checked)}
                  className="size-3.5"
                />
                leaf nodes with text only
              </label>
            </div>
            <div className="max-h-[32rem] overflow-y-auto rounded-lg border bg-surface">
              {rows.length === 0 ? (
                <div className="px-3 py-6 text-center text-[12px] text-fg-muted">No nodes match this filter.</div>
              ) : (
                rows.map((row) => {
                  const label = primaryLabel(row.node)
                  const isSelected = selectedPath?.join('.') === row.path.join('.')
                  const isExpanded = expanded.has(row.key)
                  return (
                    <div
                      key={row.key}
                      role="button"
                      tabIndex={0}
                      onClick={() => selectPath(row.path)}
                      onKeyDown={(e) => e.key === 'Enter' && selectPath(row.path)}
                      style={{ paddingLeft: `${8 + row.depth * 16}px` }}
                      className={cn(
                        'flex cursor-pointer items-center gap-1.5 border-b border-line/50 py-1 pr-2 text-[12px] last:border-b-0',
                        isSelected ? 'bg-accent/10' : 'hover:bg-surface-2',
                      )}
                    >
                      {row.hasChildren && !textOnlyFilter ? (
                        <span
                          role="button"
                          tabIndex={-1}
                          onClick={(e) => {
                            e.stopPropagation()
                            toggleExpand(row.key)
                          }}
                          className="grid size-4 shrink-0 place-items-center text-fg-muted"
                        >
                          {isExpanded ? <ChevronDown className="size-3.5" aria-hidden /> : <ChevronRight className="size-3.5" aria-hidden />}
                        </span>
                      ) : (
                        <span className="size-4 shrink-0" />
                      )}
                      <span className="shrink-0 text-fg-subtle">{shortClassName(row.node.className)}</span>
                      {label.text && (
                        <span className={cn('min-w-0 truncate', label.kind === 'id' && 'readout text-fg-muted')}>
                          {label.kind === 'id' ? label.text : `"${label.text}"`}
                        </span>
                      )}
                    </div>
                  )
                })
              )}
            </div>
          </div>

          {/* Right: the snapshot, with a highlight over the selected node. */}
          <div className="min-w-0">
            <span className="rack-label mb-2 block">snapshot</span>
            {snapshotUrl && snapshotRequestId === tree.requestId ? (
              <div className="relative overflow-hidden rounded-lg border bg-surface">
                {/* A blob: URL built from CHANNEL.SNAPSHOT bytes, not a static asset — next/image cannot take one. */}
                <img
                  ref={imgRef}
                  src={snapshotUrl}
                  alt="Device snapshot"
                  onClick={onSnapshotClick}
                  className="block w-full cursor-crosshair"
                />
                {highlight && (
                  <div
                    className="pointer-events-none absolute border-2 border-led-active bg-led-active/15"
                    style={{
                      left: `${highlight.left}%`,
                      top: `${highlight.top}%`,
                      width: `${highlight.width}%`,
                      height: `${highlight.height}%`,
                    }}
                  />
                )}
              </div>
            ) : (
              <EmptyState title="No snapshot" description="This dump did not carry a screenshot." />
            )}

            {/* Selector card (§3.5, §4.4). */}
            {selectedNode ? (
              <div className="mt-4 rounded-lg border bg-surface p-3.5">
                <h3 className="rack-label mb-2.5">{nodeIdentity(selectedNode)}</h3>
                <ul className="space-y-2">
                  {candidates.map((c) => {
                    const key = candidateKey(c.selector)
                    const result = testResults[key]
                    return (
                      <li key={c.kind} className="rounded-md border border-line px-2.5 py-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="rack-label">{c.kind}</span>
                          <span className="readout text-[11.5px]">{formatSelectorLiteral(c.selector)}</span>
                          <span
                            className={cn(
                              'ml-auto rounded-full px-1.5 py-0.5 text-[10.5px]',
                              c.count === 1
                                ? 'bg-led-ok/10 text-led-ok'
                                : c.count === 0
                                  ? 'bg-led-danger/10 text-led-danger'
                                  : c.count === null
                                    ? 'bg-surface-2 text-fg-muted'
                                    : 'bg-led-warn/10 text-led-warn',
                            )}
                          >
                            {c.count === null ? 'not counted' : `${c.count} match${c.count === 1 ? '' : 'es'}`}
                          </span>
                        </div>
                        <p className="mt-1 text-[11px] leading-relaxed text-fg-muted">{c.note}</p>
                        {c.expandsTo && <p className="readout mt-0.5 text-[10.5px] text-fg-subtle">on ui-server: {c.expandsTo}</p>}
                        {result && (
                          <p className={cn('mt-1 text-[11px]', result.error ? 'text-led-danger' : result.matched ? 'text-led-ok' : 'text-led-warn')}>
                            {result.error
                              ? `Test failed: ${result.error}`
                              : result.matched
                                ? `Matched on device — ${result.identity} (${result.tookMs}ms)`
                                : `Not found on device (${result.tookMs}ms)`}
                          </p>
                        )}
                        <div className="mt-1.5 flex gap-1.5">
                          {c.kind !== 'point' && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-6 px-2 text-[11px]"
                              disabled={testingKey === key}
                              onClick={() => void testOnDevice(c)}
                            >
                              {testingKey === key ? 'Testing…' : 'Test on device'}
                            </Button>
                          )}
                          <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={() => copyLine(c)}>
                            <Copy className="size-3" aria-hidden />
                            {copiedKey === key ? 'Copied' : 'Copy'}
                          </Button>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              </div>
            ) : (
              <div className="mt-4 text-[12px] text-fg-muted">Select a node in the tree, or click the snapshot, to see selector candidates.</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function countNodes(node: UiNode): number {
  let n = 1
  for (const c of node.children) n += countNodes(c)
  return n
}
