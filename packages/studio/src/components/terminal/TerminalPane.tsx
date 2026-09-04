'use client'

import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import Link from 'next/link'
import { isHighConsequence, type ServerMessage } from '@enkaku/protocol'
import { newId, ws } from '@/lib/ws'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  EmptyState,
  Input,
  cn,
} from '@enkaku/ui'

/**
 * The interactive device terminal (plan 26 §4.5). Beside the Monitor pane:
 * arbitrary `adb shell` commands, gated server-side (the input box being
 * enabled here is a convenience, never the control — spec §10.1). Everyone
 * viewing this device sees the transcript live; only the control-marker
 * holder can type (§3.8).
 *
 * No xterm.js (§4.5): there is no pty here, so there is nothing for a
 * terminal emulator to emulate — no cursor addressing, no colours, no
 * resize. A line-oriented transcript matches exactly what the transport can
 * actually deliver.
 */

interface ShellResultPayload {
  deviceId: string
  stdout: string
  /** Kept apart from `stdout` by the framed transport (plan 53) and rendered as its own stream. */
  stderr: string
  exitCode: number | null
  truncated: boolean
  durationMs: number
  cwd: string
  hint?: 'stream_suggested'
}

interface TranscriptEntry {
  id: string
  cmd: string
  cwd: string
  actor: string | null
  at: number
  result: ShellResultPayload | null
}

export function TerminalPane({
  deviceId,
  canType,
  onRunAsStream,
}: {
  deviceId: string
  /** Only the control-marker holder may type (plan 26 §3.8) — everyone else watches. */
  canType: boolean
  /** The `stream_suggested` hint (§3.6): opens the Monitor pane on the same command. */
  onRunAsStream: (cmd: string) => void
}) {
  const [entries, setEntries] = useState<TranscriptEntry[]>([])
  const [draft, setDraft] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState<number | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmCmd, setConfirmCmd] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const last = entries[entries.length - 1]
  const cwd = last ? (last.result?.cwd ?? last.cwd) : '/'

  // The transcript is server-published, not locally inferred (plan 26 §3.8):
  // subscribing to this device's `input` event stream is what makes THIS
  // connection count as a "viewer" for `shell.echo`/`shell.result` fan-out
  // on the server (`deviceTargets` in `ws-handlers.ts`), exactly the same
  // registration `DeviceLog`'s Logs tab already does for the same stream.
  useEffect(() => {
    setEntries([])
    const subscribe = () => ws.send({ type: 'log.subscribe', payload: { deviceId, streams: ['input'] } })
    subscribe()
    const offReconnect = ws.onReconnected(subscribe)

    const off = ws.on((msg: ServerMessage) => {
      if (msg.type === 'shell.echo' && msg.payload.deviceId === deviceId) {
        const p = msg.payload
        setEntries((es) => [...es, { id: crypto.randomUUID(), cmd: p.cmd, cwd: p.cwd, actor: p.actor, at: p.at, result: null }])
      } else if (msg.type === 'shell.result' && msg.payload.deviceId === deviceId) {
        setPending(false)
        setEntries((es) => {
          const idx = es.findLastIndex((e) => e.result === null)
          if (idx === -1) return es
          const copy = es.slice()
          const target = copy[idx]
          if (!target) return es
          copy[idx] = { ...target, result: msg.payload }
          return copy
        })
      }
    })

    return () => {
      off()
      offReconnect()
      ws.send({ type: 'log.unsubscribe', payload: { deviceId } })
    }
  }, [deviceId])

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [entries])

  // Plan 207 §4.7, §4.9 — the fleet command console (and its `GET
  // /api/command-runs?mine=1` history seed) is gone entirely: ArrowUp
  // recall is now exactly what was typed THIS session, in this component's
  // own `useState` (the same limitation plan 93 §3.5's F3 originally
  // reported and then fixed by seeding from history — that history no
  // longer exists to seed from).

  function submit(cmd: string): void {
    const trimmed = cmd.trim()
    if (!trimmed || pending) return
    setError(null)
    setPending(true)
    setHistory((h) => [...h, trimmed])
    setHistoryIndex(null)
    setDraft('')
    const id = newId()
    // A refusal (no control marker, no permission, mode off, ...) arrives as `error`
    // with this id — success is NOT replied to the sender alone, it is
    // broadcast as `shell.echo`/`shell.result` to every viewer (§3.8), so
    // this listener only needs to catch the immediate-refusal case.
    const off = ws.on((msg) => {
      if (msg.type === 'error' && msg.id === id) {
        setPending(false)
        setError(msg.payload.message)
        off()
      }
    })
    ws.send({ type: 'shell.exec', id, payload: { deviceId, cmd: trimmed } })
  }

  function handleSubmit(): void {
    if (isHighConsequence(draft).hit) {
      setConfirmCmd(draft)
      return
    }
    submit(draft)
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleSubmit()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (history.length === 0) return
      const nextIndex = historyIndex === null ? history.length - 1 : Math.max(0, historyIndex - 1)
      setHistoryIndex(nextIndex)
      setDraft(history[nextIndex] ?? '')
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (historyIndex === null) return
      const nextIndex = historyIndex + 1
      if (nextIndex >= history.length) {
        setHistoryIndex(null)
        setDraft('')
      } else {
        setHistoryIndex(nextIndex)
        setDraft(history[nextIndex] ?? '')
      }
    }
  }

  return (
    <div className="px-5 py-4">
      <p className="mb-3 max-w-3xl text-[12px] leading-relaxed text-fg-muted">
        Commands run with the device&apos;s own adb shell privileges — this is not a sandbox. Every command and its
        outcome is written to this device&apos;s Logs tab, with the account that ran it. The prompt below is an
        emulated working directory (Studio tracks it; the device does not) — each command actually runs in a fresh
        shell prefixed with <code className="readout">cd</code>.
      </p>

      {error && (
        <div className="mb-3 rounded-lg border border-led-danger/40 bg-led-danger/5 px-3.5 py-2.5 text-[12.5px] text-led-danger">
          {error}
        </div>
      )}

      {entries.length === 0 ? (
        <EmptyState
          title="No commands run yet"
          description="Commands run here are visible to everyone watching this device, live."
        />
      ) : (
        <div
          ref={scrollRef}
          className="readout mb-3 max-h-[28rem] overflow-y-auto rounded-lg border bg-surface p-3 text-[11.5px] leading-relaxed"
        >
          {entries.map((e) => (
            <TranscriptRow key={e.id} entry={e} deviceId={deviceId} onRunAsStream={onRunAsStream} />
          ))}
        </div>
      )}

      {canType ? (
        <div className="flex items-center gap-2">
          <span className="readout shrink-0 text-[12px] text-fg-muted">{cwd} $</span>
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="getprop ro.serialno"
            disabled={pending}
            className="readout h-8 flex-1 text-[12.5px]"
          />
          <Button size="sm" onClick={handleSubmit} disabled={pending || draft.trim().length === 0}>
            {pending ? 'Running…' : 'Run'}
          </Button>
        </div>
      ) : (
        <p className="rounded-lg border bg-surface px-3.5 py-2.5 text-[12.5px] text-fg-muted">
          Take control to run commands. Everyone watching this device sees the transcript live.
        </p>
      )}

      <AlertDialog open={confirmCmd !== null} onOpenChange={(open) => !open && setConfirmCmd(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Run this command?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div>
                <code className="readout mt-1 block rounded-md bg-surface-2 px-2 py-1.5 text-[12px] break-all">{confirmCmd}</code>
                <p className="mt-2">
                  This looks like it could affect the whole device (reboot, power, or adb settings). This is a
                  Studio-side reminder, not a server-side restriction — the command runs exactly as typed either way.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setConfirmCmd(null)}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const cmd = confirmCmd
                setConfirmCmd(null)
                if (cmd) submit(cmd)
              }}
            >
              Run anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function TranscriptRow({
  entry,
  deviceId,
  onRunAsStream,
}: {
  entry: TranscriptEntry
  deviceId: string
  onRunAsStream: (cmd: string) => void
}) {
  const { cmd, actor, result } = entry
  return (
    <div className="border-b border-line/60 py-1.5 last:border-b-0">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-fg-subtle">{entry.cwd} $</span>
        <span className="font-medium break-all text-fg">{cmd}</span>
        {actor && <span className="text-[10.5px] text-fg-subtle">{actor}</span>}
      </div>
      {result === null ? (
        <div className="pl-4 text-fg-subtle">running…</div>
      ) : (
        <>
          {result.stdout.length > 0 && <pre className="whitespace-pre-wrap break-all text-fg-muted">{result.stdout}</pre>}
          {/*
            stderr is a separate stream, not a verdict. Plenty of Android tools
            write warnings and progress to it while exiting 0 — `dumpsys` on a
            missing service does exactly that — so it is marked as a different
            stream (warn) rather than as failure (danger). Whether the command
            succeeded is the `exit` badge's job, and only its job.
          */}
          {result.stderr.length > 0 && (
            <div className="border-l-2 border-led-warn/40 pl-2">
              <div className="readout text-[10px] uppercase tracking-wide text-led-warn/70">stderr</div>
              <pre className="whitespace-pre-wrap break-all text-led-warn">{result.stderr}</pre>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-x-3 text-[10.5px]">
            <span
              className={cn(
                result.exitCode === 0 ? 'text-led-ok' : result.exitCode === null ? 'text-fg-subtle' : 'text-led-danger',
              )}
            >
              exit {result.exitCode ?? '?'}
            </span>
            <span className="text-fg-subtle">{result.durationMs} ms</span>
            {result.truncated && <span className="text-led-warn">output truncated</span>}
            {result.hint === 'stream_suggested' && (
              <button type="button" className="text-accent underline" onClick={() => onRunAsStream(cmd)}>
                Run as a stream
              </button>
            )}
            {/* Plan 93 §3.16, step 93.7 — opens the fleet console with this
                exact command prefilled and this device preselected. The
                console is a SEPARATE surface (§3.17): this link does not run
                anything itself, it only hands the same text to the one place
                that starts a fan-out run. */}
            <Link href={`/console?cmd=${encodeURIComponent(cmd)}&deviceId=${encodeURIComponent(deviceId)}`} className="text-accent underline">
              Run on more devices…
            </Link>
          </div>
        </>
      )}
    </div>
  )
}
