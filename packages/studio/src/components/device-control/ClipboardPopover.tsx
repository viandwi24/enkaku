'use client'

import { useState } from 'react'
import {
  Button,
  ClipboardIcon,
  CheckIcon,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Textarea,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  cn,
} from '@enkaku/ui'
import { newId, ws } from '@/lib/ws'
import type { ClipboardEntry } from './use-cast'

/**
 * The rail's Clipboard button (design handoff rail item 10; plan 215 §4.7).
 *
 * It used to be pull-only: opening it fired one `clipboard.get`, and that
 * single value was the whole surface. Which is why it read as unreliable
 * (owner, 2026-09-04) — a device that had copied three things since you
 * opened the window showed one of them, and a `clipboard.get` that raced a
 * focus change on the device showed the wrong one or nothing at all.
 *
 * The push it needed already existed and was being thrown away.
 * `clipboard.changed` (plan 209 §3.2 D10) is emitted to every connection
 * holding a control-quality binding the moment the device copies, and
 * `use-cast.ts` was keeping only the newest for Alt+C. It now keeps a
 * bounded list, and this popover renders it: every copy made on the device
 * while the window has been open, newest first, each with its own Copy
 * button.
 *
 * The `clipboard.get` on open stays, and is now the ONE thing the push
 * cannot do: it catches what was on the device's clipboard BEFORE this
 * window opened. It is folded into the same list rather than shown
 * separately, so there is one place to look instead of two.
 *
 * Nothing here is persisted. The list lives in the window's own state, dies
 * with it, and is never sent anywhere — clipboard content is very often a
 * password or a one-time token (plan 38 §4.5, the reason `clipboard.value`
 * is unicast), so remembering it in a DB or fanning it to other viewers
 * would be a privacy hole introduced for convenience.
 */
export function ClipboardPopover({
  deviceId,
  history,
  onClearHistory,
  onRead,
}: {
  deviceId: string
  history: ClipboardEntry[]
  onClearHistory: () => void
  /** `use-cast`'s own `clipboard.get`, so its answer lands in the same history the pushes feed. */
  onRead: () => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [reading, setReading] = useState(false)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** Which row was just copied, so the button can confirm it landed. Cleared on a timer. */
  const [copied, setCopied] = useState<string | null>(null)

  async function read(): Promise<void> {
    setError(null)
    setReading(true)
    try {
      // Deliberately the hook's call, not a local one: its answer runs
      // through the same `recordClipboard` the pushes do, so this adds a row
      // instead of opening a second, competing readout.
      await onRead()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setReading(false)
    }
  }

  async function copyRow(entry: ClipboardEntry): Promise<void> {
    try {
      await navigator.clipboard.writeText(entry.text)
      setCopied(entry.text)
      setTimeout(() => setCopied((c) => (c === entry.text ? null : c)), 1200)
    } catch {
      // Best-effort — some browsers refuse without a fresh gesture.
      setError('Your browser refused the copy. Click the row again.')
    }
  }

  async function send(paste: boolean): Promise<void> {
    if (text.length === 0) return
    setError(null)
    setSending(true)
    try {
      await ws.request({ type: 'clipboard.set', id: newId(), payload: { deviceId, text, paste } })
      setText('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSending(false)
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) void read()
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon-lg" className="relative rounded-[10px] text-dim" aria-label="Clipboard">
              <ClipboardIcon className="size-4" aria-hidden />
              {/*
                A count, not a dot: "the device copied something you have not
                looked at" and "the device copied nine things" are different
                situations, and the rail is the only place either is visible.
              */}
              {history.length > 0 && (
                <span className="absolute -top-0.5 -right-0.5 min-w-[15px] rounded-pill bg-accent-soft px-1 text-center font-mono text-[9px] leading-[15px] text-accent">
                  {history.length > 9 ? '9+' : history.length}
                </span>
              )}
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        {/* Beside the rail, not above it — same reason as `ShortcutRail`. */}
        <TooltipContent side="left" sideOffset={6}>
          Clipboard · Alt+C / Alt+V
        </TooltipContent>
      </Tooltip>
      <PopoverContent data-menu-root="1" align="start" className="w-[300px]">
        {error && <p className="mb-2 text-[11px] text-danger">{error}</p>}

        <div className="flex items-center justify-between">
          <p className="text-label text-faint">Copied on the device</p>
          <div className="flex items-center gap-1">
            <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[11px]" disabled={reading} onClick={() => void read()}>
              {reading ? 'Reading…' : 'Read now'}
            </Button>
            {history.length > 0 && (
              <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[11px] text-faint" onClick={onClearHistory}>
                Clear
              </Button>
            )}
          </div>
        </div>

        {history.length === 0 ? (
          <p className="mt-2 rounded-inner border border-line bg-muted px-2 py-2 text-[11px] leading-relaxed text-faint">
            Nothing yet. Copy something on the phone and it appears here — no need to press anything.
          </p>
        ) : (
          <ul className="mt-2 max-h-[220px] space-y-1 overflow-y-auto">
            {history.map((entry) => (
              <li key={`${entry.at}-${entry.text}`}>
                <button
                  type="button"
                  onClick={() => void copyRow(entry)}
                  title={entry.text}
                  className={cn(
                    'group flex w-full items-center gap-2 rounded-inner border border-line px-2 py-1.5 text-left transition-colors',
                    copied === entry.text ? 'border-accent/40 bg-accent-soft' : 'bg-muted hover:bg-muted-2',
                  )}
                >
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-text-2">{entry.text}</span>
                  {copied === entry.text ? (
                    <CheckIcon className="size-3.5 shrink-0 text-accent" aria-hidden />
                  ) : (
                    <span className="shrink-0 text-[10px] text-faint opacity-0 transition-opacity group-hover:opacity-100">Copy</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-3 border-t border-line pt-3">
          <Textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Text to send" disabled={sending} className="text-[12px]" />
          <div className="mt-2 flex justify-end gap-2">
            <Button size="sm" variant="outline" disabled={sending || text.length === 0} onClick={() => void send(false)}>
              Send
            </Button>
            <Button size="sm" disabled={sending || text.length === 0} onClick={() => void send(true)}>
              Send + paste
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
