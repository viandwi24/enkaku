'use client'

import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { toast } from 'sonner'
import { ChevronDown, ChevronRight, Copy, Hand, RefreshCw } from 'lucide-react'
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
import { Switch } from '@/components/ui/switch'
import { EmptyState, ErrorState, LoadingRows } from '@/components/states'
import { relativeTime } from '@/lib/format'
import { useNow } from '@/lib/useNow'
import { newId, ws } from '@/lib/ws'
import { cn } from '@/lib/utils'

/**
 * The Inspect mode of the screen card (plan 56; relocated by plan 57 §3.1) —
 * dumps the on-device UI tree through the existing `Inspector` driver, shows
 * it beside a snapshot taken at the same instant, and turns a picked node into
 * a ranked, match-counted selector an operator can test on the device and
 * paste into a script.
 *
 * **The attachment follows the lease, not the mode** (plan 59 §3.3). Plan 56
 * §3.2 was right that an attached inspector holds an on-device engine — the
 * `instrumentation` lock and an `adb.maxConcurrent` slot — and that the cost
 * has to be paid consciously. What it missed is that this panel already
 * requires a *manual lease* (§3.7, and plan 59 §3.1 keeps that), and a manual
 * lease has already made the device exclusively one operator's: the scheduler
 * will not pick it and nobody else can take it. Holding the instrumentation
 * lock for the duration of a lease you are already holding therefore costs
 * nobody anything, while unmounting on every `Live ⇄ Inspect` flip cost a full
 * cold start each time. So the panel now stays mounted for as long as the
 * device page does (the same `hidden` treatment `LiveView` has had since plan
 * 42 §3.1) and detaches when the lease goes, not when the mode does.
 *
 * The lease requirement itself is *not* presentational politeness that could
 * be dropped: a dump carries whatever is on screen, including text already
 * typed into a field, and it seizes an instrumentation lock. Only the way the
 * panel *says* so changed — a precondition an operator can satisfy in one
 * click is not a failure, so it is no longer rendered through `ErrorState`
 * (plan 59 §3.1).
 */

/** `follow` polls at a stated interval (plan 59 §3.5) — a dump costs 334–584 ms on hardware, so it is never faster than this. */
const FOLLOW_INTERVAL_MS = 2000

/** A failing dump backs off rather than hammering a device that is already struggling (plan 59 §9 Q2). */
const FOLLOW_MAX_BACKOFF_STEPS = 3

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

export function nodeAt(root: UiNode, path: number[]): UiNode | null {
  let node = root
  for (const i of path) {
    const child = node.children[i]
    if (!child) return null
    node = child
  }
  return node
}

/**
 * Every field of every node, in a fixed order — the comparison that decides
 * whether a dump changed anything (plan 59 §3.4).
 *
 * Deliberately total, and deliberately not a hash of "the interesting parts":
 * a false "unchanged" hides a real change on a screen someone is drawing
 * conclusions from, which is far worse than one unnecessary re-render. The
 * exhaustiveness record below is what keeps it total — adding a field to
 * `UiNode` stops compiling until this function is told about it.
 */
type Assert<T extends true> = T
type SerialisedField =
  | 'resourceId'
  | 'text'
  | 'desc'
  | 'className'
  | 'packageName'
  | 'bounds'
  | 'clickable'
  | 'enabled'
  | 'focused'
  | 'index'
  | 'children'
type _EveryUiNodeFieldIsCompared = Assert<Exclude<keyof UiNode, SerialisedField> extends never ? true : false>

export function serialiseTree(node: UiNode): string {
  const b = node.bounds
  // JSON.stringify of an array, so a field whose text happens to contain a
  // separator can never be read as a boundary between two fields.
  const self = JSON.stringify([
    node.className,
    node.resourceId,
    node.text,
    node.desc,
    node.packageName,
    node.index,
    b.left,
    b.top,
    b.right,
    b.bottom,
    node.clickable,
    node.enabled,
    node.focused,
  ])
  return `${self}[${node.children.map(serialiseTree).join(',')}]`
}

/**
 * The selection to carry into a changed tree (plan 59 §3.4): kept when the
 * path still resolves to a node, dropped only when the node genuinely went
 * away. `refresh()` used to clear it unconditionally, which — with `follow`
 * on — wiped the operator's selection every couple of seconds.
 */
export function keepSelection(root: UiNode, path: number[] | null): number[] | null {
  if (!path) return null
  return nodeAt(root, path) ? path : null
}

/**
 * The expansion set for a new tree: the default depth, plus whatever the
 * operator had opened by hand that still exists.
 *
 * Seeding is not optional — a stale set from a previous dump would show
 * nothing at all if the new tree happens to be shallower. But *only* seeding
 * threw away every branch the operator had opened, which under a two-second
 * `follow` is the tree collapsing itself while it is being read.
 */
export function seedExpanded(root: UiNode, depth: number, previous?: ReadonlySet<string>): Set<string> {
  const next = new Set<string>()
  const walk = (node: UiNode, path: number[], d: number) => {
    const key = path.join('.') || 'root'
    if (d < depth) next.add(key)
    else if (previous?.has(key) && node.children.length > 0) next.add(key)
    node.children.forEach((c, i) => walk(c, [...path, i], d + 1))
  }
  walk(root, [], 0)
  return next
}

/**
 * Whether `follow` may fire another dump right now (plan 59 §3.5).
 *
 * Every term is a reason not to spend 334–584 ms of a real phone's time: no
 * lease means the server would refuse anyway; `Live` showing or the Control
 * tab hidden means nobody is reading the tree; a backgrounded browser tab is
 * the same fact one level up (§9 Q1).
 */
export function shouldPoll(o: {
  follow: boolean
  visible: boolean
  canUse: boolean
  ready: boolean
  pageVisible: boolean
  /** True while a past dump is on screen. Following would drag the operator back to the present. */
  viewingHistory: boolean
}): boolean {
  return o.follow && o.visible && o.canUse && o.ready && o.pageVisible && !o.viewingHistory
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

const HISTORY_LIMIT = 20

interface DumpEntry {
  requestId: number
  root: UiNode
  frameSize: { width: number; height: number }
  at: number
  tookMs: number
}

export function InspectorPanel({
  deviceId,
  canUse,
  onTakeControl,
  takeControlDisabledReason,
  visible,
}: {
  deviceId: string
  /**
   * The manual lease this panel requires (plan 56 §3.7). Attaching, dumping
   * and finding all need it, and the server checks it on every message — this
   * only decides what the panel says and when it holds an engine.
   */
  canUse: boolean
  /** Offered inline while `canUse` is false, so the fix is where the problem was found (plan 59 §3.1). */
  onTakeControl: () => void
  /** Why control cannot be taken right now (offline, held by someone else) — the button is then genuinely disabled and says so. */
  takeControlDisabledReason?: string
  /** False while `Live` is showing or the Control tab is hidden: stay mounted and attached, stop polling (§3.3, §3.5). */
  visible: boolean
}) {
  const now = useNow(1000)
  const pageVisible = usePageVisible()

  const [state, setState] = useState<InspectState>('detached')
  const [engineId, setEngineId] = useState('')
  const [capabilities, setCapabilities] = useState<string[]>([])
  const [reason, setReason] = useState<string | null>(null)
  const [attachError, setAttachError] = useState<string | null>(null)

  const [tree, setTree] = useState<TreePayload | null>(null)
  const [dumpLoading, setDumpLoading] = useState(false)
  const [dumpError, setDumpError] = useState<string | null>(null)
  const [snapshotUrl, setSnapshotUrl] = useState<string | null>(null)
  /**
   * The last few dumps, newest first, so a screen that has already changed can
   * still be read. Bounded hard: each entry pins a decoded PNG, and an
   * unbounded ring on a panel that refreshes every two seconds is a memory
   * leak with a nice name. Evicted entries have their blob URLs revoked —
   * dropping the reference alone would keep the bytes alive.
   */
  const [history, setHistory] = useState<DumpEntry[]>([])
  /**
   * Which history entry is on screen, or null for "whatever is newest".
   * Selecting one PAUSES following (see `shouldPoll`): a refresh that yanked
   * the operator back to the present would make the history unusable for the
   * one thing it is for.
   */
  const [viewing, setViewing] = useState<number | null>(null)
  const [snapshotRequestId, setSnapshotRequestId] = useState<number | null>(null)
  const [stale, setStale] = useState(false)

  const [selectedPath, setSelectedPath] = useState<number[] | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [textOnlyFilter, setTextOnlyFilter] = useState(false)

  // On by default (plan 59 §3.5): an inspector that does not track the screen
  // is not doing its job. What keeps that honest is not timidity about the
  // default but the three guards around it — visible-only, chained rather than
  // timed, and an unchanged screen costing nothing (§3.4).
  const [follow, setFollow] = useState(true)
  const [testingKey, setTestingKey] = useState<string | null>(null)
  const [testResults, setTestResults] = useState<Record<string, TestOutcome>>({})
  const [copiedKey, setCopiedKey] = useState<string | null>(null)

  const nextRequestIdRef = useRef(0)
  const snapshotUrlRef = useRef<string | null>(null)
  /** requestId → blob URL, for entries still in `history`. Revoked on eviction. */
  const snapshotsRef = useRef<Map<number, string>>(new Map())
  const imgRef = useRef<HTMLImageElement>(null)
  /** The serialised tree currently on screen — the left-hand side of §3.4's comparison. */
  const treeSerialRef = useRef<string | null>(null)
  /** One dump at a time, ever (acceptance #5) — `follow` chains, but a manual Refresh must not cut in front of one. */
  const inFlightRef = useRef(false)
  /**
   * The last dump that came back, whether or not it changed anything. Held in
   * a ref precisely because §3.4 forbids a state write for an unchanged dump:
   * the header line it feeds is repainted by `useNow(1000)` within a second
   * anyway, so "checked 1s ago, unchanged" costs no render of its own.
   */
  const lastCheckRef = useRef<{ at: number; tookMs: number; unchanged: boolean } | null>(null)
  /**
   * The requestId of a dump whose tree was dropped as unchanged. Its snapshot
   * is dropped with it, so the picture already on screen — which still matches
   * that identical tree — stays, and no blob is allocated for nothing. The
   * core sends `inspect.tree` before the snapshot frame (`ws-handlers.ts`), and
   * the reply's continuation is a microtask while the frame is another message
   * event, so this is always set before the frame arrives.
   */
  const droppedSnapshotRef = useRef<number | null>(null)
  /** Consecutive failed dumps, for `follow`'s back-off (§9 Q2). */
  const failuresRef = useRef(0)

  const nextRequestId = (): number => {
    const id = nextRequestIdRef.current
    nextRequestIdRef.current = (id + 1) & 0xff
    return id
  }

  // ---- everything that belongs to *this device* is dropped when the device
  // changes, and only then. Losing the lease detaches the engine (below) but
  // must not throw the tree away: the operator takes control again and the
  // previous dump is there while the re-attach happens behind it (§3.3). ----
  useEffect(() => {
    setEngineId('')
    setCapabilities([])
    setReason(null)
    setTree(null)
    treeSerialRef.current = null
    lastCheckRef.current = null
    setSnapshotUrl(null)
    setSnapshotRequestId(null)
    setSelectedPath(null)
    setTestResults({})
    setDumpError(null)
  }, [deviceId])

  // ---- attach / detach lifecycle — keyed on the LEASE, not on the mode
  // (§3.3). Gaining control attaches; losing it detaches and releases the
  // engine, which is what keeps acceptance #6 true. ----
  const autoRefreshedFor = useRef<string | null>(null)
  useEffect(() => {
    setAttachError(null)
    if (!canUse) {
      // Nothing to release: without a lease nothing was ever attached. The
      // panel simply says what it needs (§3.1).
      setState('detached')
      autoRefreshedFor.current = null
      return
    }

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
  }, [deviceId, canUse])

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
      // The tree from this dump was dropped as unchanged (§3.4), so its
      // picture is dropped too — the one already on screen came from the same
      // tree and still matches it, including every node's bounds.
      if (requestId === droppedSnapshotRef.current) return
      const blob = new Blob([data.slice()], { type: 'image/png' })
      const url = URL.createObjectURL(blob)
      // Deliberately NOT revoking the previous URL here any more. That was
      // right when only one snapshot existed, and is exactly wrong now that
      // history holds the last twenty: eviction from the ring owns revocation,
      // and revoking on arrival would blank every older entry the instant a
      // new dump landed.
      snapshotsRef.current.set(requestId, url)
      snapshotUrlRef.current = url
      setSnapshotUrl(url)
      setSnapshotRequestId(requestId)
    })
    const urls = snapshotsRef.current
    return () => {
      off()
      // Unmount frees the whole ring, not just the newest — otherwise nineteen
      // decoded PNGs outlive the panel that was showing them.
      for (const url of urls.values()) URL.revokeObjectURL(url)
      urls.clear()
      snapshotUrlRef.current = null
    }
  }, [])

  /**
   * One dump.
   *
   * `silent` is what a `follow` tick passes: no spinner on the Refresh button,
   * because a control that blinks every two seconds is noise, not feedback.
   *
   * A dump whose tree is byte-for-byte the tree already on screen is dropped
   * (§3.4) — no `setTree`, so no re-render of the rows, no reseeded expansion,
   * no lost selection, and no new snapshot blob. The only thing it leaves
   * behind is the fact that it happened, which the header reports as
   * "checked 1s ago, unchanged".
   */
  async function refresh({ silent = false }: { silent?: boolean } = {}) {
    if (state !== 'ready' || !canUse || inFlightRef.current) return
    inFlightRef.current = true
    if (!silent) setDumpLoading(true)
    // Both of these bail out inside React when the value has not changed, so
    // an unchanged dump still writes nothing.
    setDumpError(null)
    const requestId = nextRequestId()
    try {
      const res = await ws.request({ type: 'inspect.dump', id: newId(), payload: { deviceId, requestId, screenshot: true } })
      if (res.type !== 'inspect.tree') return
      failuresRef.current = 0
      const serial = serialiseTree(res.payload.root)
      const unchanged = serial === treeSerialRef.current
      lastCheckRef.current = { at: res.payload.at, tookMs: res.payload.tookMs, unchanged }
      if (unchanged) {
        droppedSnapshotRef.current = requestId
        // The screen is verifiably what the tree says it is again.
        setStale(false)
        return
      }
      droppedSnapshotRef.current = null
      treeSerialRef.current = serial
      const entry: DumpEntry = {
        requestId,
        root: res.payload.root,
        frameSize: res.payload.frameSize,
        at: res.payload.at,
        tookMs: res.payload.tookMs,
      }
      setTree({ ...entry })
      // Only CHANGED dumps enter the history — twenty identical screens would
      // be twenty ways of learning nothing, and would push out the change the
      // operator is looking for.
      setHistory((prev) => {
        const next = [entry, ...prev].slice(0, HISTORY_LIMIT)
        for (const dropped of prev.slice(HISTORY_LIMIT - 1)) {
          const url = snapshotsRef.current.get(dropped.requestId)
          if (url) {
            URL.revokeObjectURL(url)
            snapshotsRef.current.delete(dropped.requestId)
          }
        }
        return next
      })
      setViewing(null)
      setSelectedPath((prev) => keepSelection(res.payload.root, prev))
      setStale(false)
      setTestResults({})
      setExpanded((prev) => seedExpanded(res.payload.root, DEFAULT_EXPAND_DEPTH, prev))
      if (!res.payload.snapshot) setSnapshotUrl(null)
    } catch (err) {
      failuresRef.current += 1
      setDumpError(err instanceof Error ? err.message : String(err))
    } finally {
      inFlightRef.current = false
      if (!silent) setDumpLoading(false)
    }
  }

  // The first dump happens automatically once the engine is ready AND the
  // panel is actually on screen — an operator opening `Inspect` should not
  // have to also press Refresh, and one who took control while watching the
  // live video should not be charged a dump for a tree nobody is looking at.
  useEffect(() => {
    if (state === 'ready' && visible && autoRefreshedFor.current !== deviceId) {
      autoRefreshedFor.current = deviceId
      void refresh()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, deviceId, visible])

  // `follow` (plan 59 §3.5): the next dump is scheduled only once the previous
  // one has come back, so a slow engine stretches the gap instead of queueing
  // dumps behind each other on the device's adb queue. `shouldPoll` collects
  // every reason not to spend a phone's time on a tree nobody is reading.
  const polling = shouldPoll({
    follow,
    visible,
    canUse,
    ready: state === 'ready',
    pageVisible,
    viewingHistory: viewing !== null,
  })
  useEffect(() => {
    if (!polling) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const delay = () => FOLLOW_INTERVAL_MS * 2 ** Math.min(failuresRef.current, FOLLOW_MAX_BACKOFF_STEPS)
    const tick = async () => {
      await refresh({ silent: true })
      if (!cancelled) timer = setTimeout(() => void tick(), delay())
    }
    timer = setTimeout(() => void tick(), delay())
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [polling, deviceId])

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

  // A precondition, not a failure (§3.1). Nothing has gone wrong: control has
  // simply not been taken yet, and the thing that fixes it is one click away
  // from where it was discovered.
  if (!canUse) {
    return (
      <InspectorNeedsControl onTakeControl={onTakeControl} {...(takeControlDisabledReason ? { disabledReason: takeControlDisabledReason } : {})} />
    )
  }

  // Real failures keep the red box. A server refusal is still a refusal.
  if (attachError) {
    return (
      <div>
        <ErrorState message={attachError} />
      </div>
    )
  }

  if (state === 'unavailable') {
    return (
      <div>
        <ErrorState message={reason ?? `The ${engineId || 'inspector'} engine is not available on this session.`} />
      </div>
    )
  }

  // Only a panel with nothing to show waits. Once there is a tree, a re-attach
  // (a WS reconnect, say) happens behind it rather than blanking the screen —
  // it must never look like a cold start when it is not one (§3.3).
  if (!tree && (state === 'detached' || state === 'starting')) {
    return (
      <div className="flex items-center gap-2 text-[12.5px] text-fg-muted">
        <RefreshCw className="size-3.5 animate-spin" aria-hidden />
        Starting the inspector…
      </div>
    )
  }

  return (
    <div>
      {/* Header: engine, how old this tree is and what it cost, staleness,
          follow, Refresh (§4.4; plan 57 §3.5). The age and the duration are
          always on screen — an inspector quietly showing a ten-second-old tree
          is worse than one that admits its age, because every conclusion drawn
          from it is wrong in a way nothing else contradicts. */}
      <div className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border bg-surface px-3.5 py-2.5">
        <span className="rack-label">{engineId}</span>
        <span className="readout text-[11.5px] text-fg-muted">
          {tree ? `taken ${dumpAge(tree.at, now)} · ${tree.tookMs} ms${unchangedSuffix(lastCheckRef.current, tree.at, now)}` : 'no dump yet'}
        </span>
        {state !== 'ready' && (
          <span className="flex items-center gap-1.5 text-[11px] text-fg-muted">
            <RefreshCw className="size-3 animate-spin" aria-hidden />
            reattaching
          </span>
        )}
        {stale && tree && (
          <span className="rounded-full border border-led-warn/35 bg-led-warn/10 px-2 py-0.5 text-[11px] text-led-warn">
            input was sent — this tree may no longer match the screen
          </span>
        )}
        <label className="ml-auto flex items-center gap-1.5 text-[11.5px] text-fg-muted">
          <Switch size="sm" checked={follow} onCheckedChange={setFollow} />
          follow (every {FOLLOW_INTERVAL_MS / 1000}s)
        </label>
        <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={dumpLoading || state !== 'ready'}>
          <RefreshCw className={cn('size-3.5', dumpLoading && 'animate-spin')} aria-hidden />
          Refresh
        </Button>
      </div>

      {dumpError && <ErrorState message={dumpError} onRetry={() => void refresh()} />}

      {!tree && !dumpError && dumpLoading && <LoadingRows rows={4} />}

      {!tree && !dumpError && !dumpLoading && (
        <EmptyState title="No dump yet" description="Refresh to read the current screen." />
      )}

      {history.length > 1 && (
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          <span className="rack-label mr-1">history</span>
          {history.map((h, i) => {
            const active = viewing === null ? i === 0 : viewing === h.requestId
            return (
              <button
                key={h.requestId}
                type="button"
                onClick={() => {
                  // Selecting the newest returns to live; anything else pins
                  // the view and pauses following.
                  const live = i === 0
                  setViewing(live ? null : h.requestId)
                  setTree({ ...h })
                  setSnapshotUrl(snapshotsRef.current.get(h.requestId) ?? null)
                  setSnapshotRequestId(h.requestId)
                  setSelectedPath((prev) => keepSelection(h.root, prev))
                  setExpanded((prev) => seedExpanded(h.root, DEFAULT_EXPAND_DEPTH, prev))
                }}
                className={cn(
                  'readout rounded border px-1.5 py-0.5 text-[10.5px] transition-colors',
                  active
                    ? 'border-accent/50 bg-accent/10 text-accent-strong'
                    : 'border-line text-fg-subtle hover:border-line-strong hover:text-fg-muted',
                )}
                title={`${h.root ? countNodes(h.root) : 0} nodes · ${h.tookMs} ms`}
              >
                {i === 0 ? 'live' : `−${i}`}
              </button>
            )
          })}
          {viewing !== null && (
            <span className="ml-1 text-[11px] text-led-warn">following paused — showing an earlier dump</span>
          )}
        </div>
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
              <div className="relative mx-auto w-fit overflow-hidden rounded-lg border bg-surface">
                {/* A blob: URL built from CHANNEL.SNAPSHOT bytes, not a static asset — next/image cannot take one. */}
                <img
                  ref={imgRef}
                  src={snapshotUrl}
                  alt="Device snapshot"
                  onClick={onSnapshotClick}
                  // Fit to the same height the tree column is capped at. A
                  // 720×1640 portrait screen stretched to a ~700 px column
                  // renders about 1600 px tall, which is why this panel used to
                  // scroll for ever. Height-bound and centred keeps the whole
                  // screen visible beside its tree, which is the entire point
                  // of showing them together.
                  className="block max-h-[32rem] w-auto max-w-full cursor-crosshair object-contain"
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

/**
 * The dump's age, always as a number of seconds (plan 57 §3.5).
 *
 * `relativeTime` says "just now" under five seconds, which is the one thing
 * this line must never do: 4s of drift is enough for a highlight to land on
 * the wrong row, and "just now" hides exactly that.
 */
function dumpAge(at: number, now: number): string {
  const sec = Math.max(0, Math.floor(now / 1000) - at)
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ${sec % 60}s ago`
  return relativeTime(at, now)
}

function countNodes(node: UiNode): number {
  let n = 1
  for (const c of node.children) n += countNodes(c)
  return n
}

/**
 * "checked 1s ago, unchanged" (§3.4).
 *
 * A tree that has stopped being re-fetched and a tree that is re-fetched every
 * two seconds and comes back identical look the same on screen, and they are
 * not the same thing at all. This is the difference, said out loud — and it is
 * why dropping an unchanged dump is free rather than dishonest.
 */
export function unchangedSuffix(
  check: { at: number; unchanged: boolean } | null,
  treeAt: number,
  now: number,
): string {
  if (!check || !check.unchanged || check.at <= treeAt) return ''
  return ` · checked ${dumpAge(check.at, now)}, unchanged`
}

/**
 * Whether the browser tab itself is on screen (§9 Q1) — the same reason mode
 * visibility gates polling, one level up. A phone should not be dumped every
 * two seconds for a window nobody is looking at.
 */
function usePageVisible(): boolean {
  const [pageVisible, setPageVisible] = useState(true)
  useEffect(() => {
    if (typeof document === 'undefined') return
    const read = () => setPageVisible(document.visibilityState !== 'hidden')
    read()
    document.addEventListener('visibilitychange', read)
    return () => document.removeEventListener('visibilitychange', read)
  }, [])
  return pageVisible
}

/**
 * The panel with no lease (plan 59 §3.1).
 *
 * What used to be here was `ErrorState` — a warning triangle, a danger border,
 * "Could not load", and underneath it the *server's* wording for the input
 * path, `take control (lease.acquire) before sending input`. Nothing had
 * failed, and `lease.acquire` is an internal message name that means nothing
 * to the person reading it.
 *
 * The requirement is not the problem and does not move: a dump carries
 * whatever is on screen, text already typed into a field included, and it
 * seizes an instrumentation lock. Reading someone's screen is not a passive
 * act. So this says what is needed, says why, and offers it — the next action
 * is a click away from where the operator found out they needed it.
 *
 * No hooks, so it can be called directly in a test (the workspace has no DOM
 * renderer — see `TileChips.test.tsx`).
 */
export function InspectorNeedsControl({
  onTakeControl,
  disabledReason,
}: {
  onTakeControl: () => void
  /** Set when control cannot be taken at all right now — the button is then genuinely disabled and names the state it needs. */
  disabledReason?: string
}) {
  return (
    <EmptyState
      icon={<Hand className="size-4" aria-hidden />}
      title="Take control to inspect this screen"
      description={
        <>
          Reading the UI tree copies whatever is on screen — including text already typed into a field — and holds the
          device&apos;s instrumentation lock while it does. So it needs control of the device, the same as sending input.
          {disabledReason && <span className="mt-1.5 block text-fg-subtle">{disabledReason}</span>}
        </>
      }
      action={
        <Button
          size="sm"
          onClick={onTakeControl}
          disabled={Boolean(disabledReason)}
          {...(disabledReason ? { title: disabledReason } : {})}
        >
          <Hand className="size-4" aria-hidden />
          Take control
        </Button>
      }
    />
  )
}
