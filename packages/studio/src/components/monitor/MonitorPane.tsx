'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Download, Pause, Play, RefreshCw, Users } from 'lucide-react'
import {
  MonitorKindSchema,
  MonitorSaveResponseSchema,
  type LogcatOptions,
  type MonitorEndReason,
  type MonitorKind,
} from '@enkaku/protocol'
import { api, Button, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, cn, EmptyState, ErrorState, LoadingRows } from '@enkaku/ui'
import { newId, ws } from '@/lib/ws'

/** A local cap on the visible pane — the server's own ring buffer is 2000 lines (plan 24 §3.5); this just bounds DOM growth for a tab left open a long time. */
const MAX_VISIBLE_LINES = 5000
const SAVE_OPTIONS = [100, 500, 1000, 2000, 5000] as const

/**
 * `crash` (plan 90 §3.5, step 90.7) — the crash watcher's own feed
 * (`logcat -b crash,main`, plan 37) was always a valid `MonitorKind` and
 * always streaming, but this list only ever listed six of the seven kinds,
 * so an operator could never pick it here even though the always-on crash
 * watcher already shares its stream with anyone who does.
 */
const MONITOR_KINDS: Array<{ value: MonitorKind; label: string; streaming: boolean }> = [
  { value: 'logcat', label: 'Logcat', streaming: true },
  { value: 'top', label: 'CPU (top)', streaming: true },
  { value: 'thermal', label: 'Thermal', streaming: true },
  { value: 'crash', label: 'Crash', streaming: true },
  { value: 'ps', label: 'Processes (ps)', streaming: false },
  { value: 'meminfo', label: 'Memory', streaming: false },
  { value: 'df', label: 'Disk (df)', streaming: false },
]

const END_REASON_LABEL: Record<MonitorEndReason, string> = {
  closed: 'The device closed the stream.',
  idle: 'Stopped: no data for a while.',
  deadline: 'Stopped: reached its time limit.',
  bytes: 'Stopped: output limit reached.',
  stopped: 'Stopped.',
  error: 'Stopped after an error.',
}

function logLevelOf(line: string): 'V' | 'D' | 'I' | 'W' | 'E' | 'F' | null {
  // logcat -v time: "MM-DD HH:MM:SS.mmm  PID  TID LEVEL TAG: message"
  const m = line.match(/^\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3}\s+\d+\s+\d+\s+([VDIWEF])\s/)
  return (m?.[1] as 'V' | 'D' | 'I' | 'W' | 'E' | 'F' | undefined) ?? null
}

function lineTone(line: string): string {
  switch (logLevelOf(line)) {
    case 'E':
    case 'F':
      return 'text-led-danger'
    case 'W':
      return 'text-led-warn'
    case 'I':
      return 'text-fg'
    default:
      return 'text-fg-muted'
  }
}

/** `meminfo`'s optional package scope (plan 90 §3.5, step 90.7) — narrows
 * `dumpsys meminfo` to one app; empty means the whole-device dump, unchanged. */
function optionsFor(kind: MonitorKind, logcat: LogcatOptions, meminfoPackage: string): unknown {
  if (kind === 'logcat') return logcat
  if (kind === 'meminfo') return meminfoPackage ? { package: meminfoPackage } : {}
  return {}
}

export function MonitorPane({ deviceId }: { deviceId: string }) {
  const [kind, setKind] = useState<MonitorKind>('logcat')
  const [logcatOptions, setLogcatOptions] = useState<LogcatOptions>({ priority: 'V', buffer: 'main' })
  const [filterDraft, setFilterDraft] = useState('')
  const [tagDraft, setTagDraft] = useState('')
  const [meminfoDraft, setMeminfoDraft] = useState('')
  const [meminfoPackage, setMeminfoPackage] = useState('')

  const [streamId, setStreamId] = useState<string | null>(null)
  const [lines, setLines] = useState<string[]>([])
  const [pending, setPending] = useState<string[]>([])
  const [paused, setPaused] = useState(false)
  const [subscribers, setSubscribers] = useState(1)
  const [endedReason, setEndedReason] = useState<MonitorEndReason | null>(null)
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)

  const [oneshotText, setOneshotText] = useState<string | null>(null)
  const [oneshotTruncated, setOneshotTruncated] = useState(false)
  const [oneshotLoading, setOneshotLoading] = useState(false)
  const [oneshotError, setOneshotError] = useState<string | null>(null)

  const [saving, setSaving] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const streamIdRef = useRef<string | null>(null)

  const isStreaming = MONITOR_KINDS.find((m) => m.value === kind)?.streaming ?? false
  const options = optionsFor(kind, logcatOptions, meminfoPackage)

  const runOneshot = useCallback(() => {
    setOneshotLoading(true)
    setOneshotError(null)
    void ws
      .request({ type: 'monitor.oneshot', id: newId(), payload: { deviceId, kind, options } })
      .then((res) => {
        if (res.type !== 'monitor.result') return
        setOneshotText(res.payload.text)
        setOneshotTruncated(res.payload.truncated)
      })
      .catch((err) => setOneshotError(err instanceof Error ? err.message : String(err)))
      .finally(() => setOneshotLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId, kind, JSON.stringify(options)])

  // Streaming kinds: start on mount / whenever kind or options change; stop
  // on cleanup. One-shot kinds: just run once (§4.7 "a refreshable text block").
  useEffect(() => {
    setEndedReason(null)
    if (!isStreaming) {
      setStreamId(null)
      streamIdRef.current = null
      setLines([])
      setPending([])
      runOneshot()
      return
    }

    setStarting(true)
    setStartError(null)
    setLines([])
    setPending([])
    let cancelled = false

    const start = () =>
      ws
        .request({ type: 'monitor.start', id: newId(), payload: { deviceId, kind, options } })
        .then((res) => {
          if (cancelled || res.type !== 'monitor.started') return
          streamIdRef.current = res.payload.streamId
          setStreamId(res.payload.streamId)
          setLines(res.payload.backlog.slice(-MAX_VISIBLE_LINES))
        })
        .catch((err) => {
          if (!cancelled) setStartError(err instanceof Error ? err.message : String(err))
        })
        .finally(() => {
          if (!cancelled) setStarting(false)
        })
    void start()
    const offReconnect = ws.onReconnected(() => void start())

    const off = ws.on((msg) => {
      const sid = streamIdRef.current
      if (!sid) return
      if (msg.type === 'monitor.data' && msg.payload.streamId === sid) {
        if (paused) setPending((p) => [...p, ...msg.payload.lines].slice(-MAX_VISIBLE_LINES))
        else setLines((l) => [...l, ...msg.payload.lines].slice(-MAX_VISIBLE_LINES))
      } else if (msg.type === 'monitor.ended' && msg.payload.streamId === sid) {
        setEndedReason(msg.payload.reason)
        streamIdRef.current = null
        setStreamId(null)
      } else if (msg.type === 'monitor.subscribers' && msg.payload.streamId === sid) {
        setSubscribers(msg.payload.count)
      }
    })

    return () => {
      cancelled = true
      off()
      offReconnect()
      const sid = streamIdRef.current
      if (sid) ws.send({ type: 'monitor.stop', payload: { streamId: sid } })
      streamIdRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId, kind, JSON.stringify(options)])

  // Auto-follow the tail unless the pane has been scrolled up.
  useEffect(() => {
    const el = scrollRef.current
    if (!el || paused) return
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight
  }, [lines, paused])

  function togglePause() {
    setPaused((was) => {
      if (was) setLines((l) => [...l, ...pending].slice(-MAX_VISIBLE_LINES))
      setPending([])
      return !was
    })
  }

  function applyLogcatFilters() {
    setLogcatOptions((o) => ({ ...o, filter: filterDraft.trim() || undefined, tag: tagDraft.trim() || undefined }))
  }

  function applyMeminfoPackage() {
    setMeminfoPackage(meminfoDraft.trim())
  }

  async function saveLastLines(n: number) {
    const toSave = lines.slice(-n)
    if (toSave.length === 0) {
      toast.error('Nothing to save yet')
      return
    }
    setSaving(true)
    try {
      const res = await api(`/api/devices/${deviceId}/monitor/save`, MonitorSaveResponseSchema, {
        method: 'POST',
        json: { kind, lines: toSave },
      })
      toast.success(`Saved ${toSave.length} line${toSave.length === 1 ? '' : 's'}`, {
        action: {
          label: 'Download',
          onClick: () => window.open(`/api/artifacts/${res.artifact.id}/content`, '_blank'),
        },
      })
    } catch (err) {
      toast.error('Could not save', { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="px-5 py-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Select value={kind} onValueChange={(v) => setKind(MonitorKindSchema.parse(v))}>
          <SelectTrigger className="h-8 w-44 text-[12.5px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MONITOR_KINDS.map((m) => (
              <SelectItem key={m.value} value={m.value}>
                {m.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {kind === 'logcat' && (
          <>
            <Select
              value={logcatOptions.priority}
              onValueChange={(v) => setLogcatOptions((o) => ({ ...o, priority: v as LogcatOptions['priority'] }))}
            >
              <SelectTrigger className="h-8 w-24 text-[12.5px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(['V', 'D', 'I', 'W', 'E', 'F'] as const).map((p) => (
                  <SelectItem key={p} value={p}>
                    {p}+
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={logcatOptions.buffer}
              onValueChange={(v) => setLogcatOptions((o) => ({ ...o, buffer: v as LogcatOptions['buffer'] }))}
            >
              <SelectTrigger className="h-8 w-28 text-[12.5px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(['main', 'system', 'crash', 'events', 'all'] as const).map((b) => (
                  <SelectItem key={b} value={b}>
                    {b}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              value={tagDraft}
              onChange={(e) => setTagDraft(e.target.value)}
              onBlur={applyLogcatFilters}
              onKeyDown={(e) => e.key === 'Enter' && applyLogcatFilters()}
              placeholder="tag"
              className="h-8 w-28 text-[12.5px]"
            />
            <Input
              value={filterDraft}
              onChange={(e) => setFilterDraft(e.target.value)}
              onBlur={applyLogcatFilters}
              onKeyDown={(e) => e.key === 'Enter' && applyLogcatFilters()}
              placeholder="Filter text"
              className="h-8 w-48 text-[12.5px]"
            />
          </>
        )}

        {kind === 'meminfo' && (
          <Input
            value={meminfoDraft}
            onChange={(e) => setMeminfoDraft(e.target.value)}
            onBlur={applyMeminfoPackage}
            onKeyDown={(e) => e.key === 'Enter' && applyMeminfoPackage()}
            placeholder="Package (optional, e.g. com.example.app)"
            className="h-8 w-64 text-[12.5px]"
          />
        )}

        <div className="ml-auto flex items-center gap-2">
          {isStreaming && subscribers > 1 && (
            <span className="readout inline-flex items-center gap-1 rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[11px] text-fg-muted">
              <Users className="size-3" aria-hidden />
              {subscribers} watching
            </span>
          )}
          {isStreaming ? (
            <>
              {pending.length > 0 && paused && (
                <button
                  type="button"
                  onClick={togglePause}
                  className="readout rounded-full border border-led-active/35 bg-led-active/10 px-2 py-0.5 text-[11px] text-led-active"
                >
                  {pending.length} new line{pending.length === 1 ? '' : 's'}
                </button>
              )}
              <Button variant="outline" size="sm" onClick={togglePause} disabled={!streamId}>
                {paused ? (
                  <>
                    <Play className="size-3.5" aria-hidden />
                    Resume
                  </>
                ) : (
                  <>
                    <Pause className="size-3.5" aria-hidden />
                    Pause
                  </>
                )}
              </Button>
              <Select onValueChange={(v) => void saveLastLines(Number(v))}>
                <SelectTrigger className="h-8 w-auto text-[12.5px]" disabled={saving || lines.length === 0}>
                  <Download className="size-3.5" aria-hidden />
                  <SelectValue placeholder="Save last…" />
                </SelectTrigger>
                <SelectContent>
                  {SAVE_OPTIONS.map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      Last {n} lines
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </>
          ) : (
            <Button variant="outline" size="sm" onClick={runOneshot} disabled={oneshotLoading}>
              <RefreshCw className={cn('size-3.5', oneshotLoading && 'animate-spin')} aria-hidden />
              Refresh
            </Button>
          )}
        </div>
      </div>

      {endedReason && (
        <div className="mb-3 rounded-lg border border-led-warn/35 bg-led-warn/5 px-3.5 py-2.5 text-[12.5px] text-led-warn">
          {END_REASON_LABEL[endedReason]}
        </div>
      )}
      {startError && <ErrorState message={startError} />}

      {isStreaming ? (
        starting && lines.length === 0 ? (
          <LoadingRows rows={5} />
        ) : lines.length === 0 && !startError ? (
          <EmptyState
            title="No output yet"
            description="Waiting for the device to produce output on this stream."
          />
        ) : (
          <div
            ref={scrollRef}
            className="readout max-h-[32rem] overflow-y-auto rounded-lg border bg-surface p-3 text-[11.5px] leading-relaxed"
          >
            {lines.map((line, i) => (
              <div key={i} className={cn('whitespace-pre-wrap break-all', lineTone(line))}>
                {line}
              </div>
            ))}
          </div>
        )
      ) : oneshotLoading && oneshotText === null ? (
        <LoadingRows rows={5} />
      ) : oneshotError ? (
        <ErrorState message={oneshotError} onRetry={runOneshot} />
      ) : oneshotText !== null ? (
        <div className="rounded-lg border bg-surface p-3">
          {oneshotTruncated && (
            <p className="mb-2 text-[11.5px] text-led-warn">Output was truncated to fit.</p>
          )}
          <pre className="readout max-h-[32rem] overflow-auto whitespace-pre-wrap break-all text-[11.5px] leading-relaxed text-fg-muted">
            {oneshotText}
          </pre>
        </div>
      ) : (
        <EmptyState title="No output yet" description="Refresh to fetch the current snapshot." />
      )}
    </div>
  )
}
