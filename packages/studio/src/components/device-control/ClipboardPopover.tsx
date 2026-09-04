'use client'

import { useEffect, useState } from 'react'
import {
  Button,
  CaretLeftIcon,
  CaretRightIcon,
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
 * Rows per page. Ten, because a 300px popover that scrolls past ten rows is
 * a list nobody reads to the bottom of — the owner asked for exactly this
 * cap (2026-09-05). The store behind it holds more (`CLIPBOARD_HISTORY_MAX`,
 * `use-cast.ts`), so paging back reaches what scrolled off rather than
 * discarding it, and Clear still drops the lot in one click.
 */
const CLIPBOARD_PAGE_SIZE = 10

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
  onRead: () => Promise<boolean>
}) {
  const [open, setOpen] = useState(false)
  const [reading, setReading] = useState(false)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** A plain statement of fact, not a fault — see `read()`. Rendered in the muted colour, never the danger one. */
  const [note, setNote] = useState<string | null>(null)
  /** Which row was just copied, so the button can confirm it landed. Cleared on a timer. */
  const [copied, setCopied] = useState<string | null>(null)
  /** Zero-based page into `history`. Reset whenever a new copy arrives, so page 1 is always what just happened. */
  const [page, setPage] = useState(0)

  const pageCount = Math.max(1, Math.ceil(history.length / CLIPBOARD_PAGE_SIZE))
  const safePage = Math.min(page, pageCount - 1)
  const start = safePage * CLIPBOARD_PAGE_SIZE
  const shown = history.slice(start, start + CLIPBOARD_PAGE_SIZE)

  // A new copy lands at the top of page 1. Staying on page 3 while the thing
  // the operator just copied scrolls in above them is the wrong default.
  useEffect(() => {
    setPage(0)
  }, [history[0]?.at])

  async function read(): Promise<void> {
    setError(null)
    setNote(null)
    setReading(true)
    try {
      // Deliberately the hook's call, not a local one: its answer runs
      // through the same `recordClipboard` the pushes do, so this adds a row
      // instead of opening a second, competing readout.
      //
      // `false` means the device sent nothing back — an empty clipboard, or
      // one unchanged since it last announced one. That is not a failure and
      // must not be painted as one; it only deserves a line at all when the
      // list is otherwise empty, where silence would look like a hang.
      const answered = await onRead()
      if (!answered && history.length === 0) setNote('The phone sent nothing back — its clipboard is empty, or it has not copied anything yet.')
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
        {note && !error && <p className="mb-2 text-[11px] leading-relaxed text-faint">{note}</p>}

        <div className="flex items-center justify-between">
          <p className="text-label text-faint">
            Copied on the device{history.length > 0 && ` (${history.length})`}
          </p>
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
          <ul className="mt-2 space-y-1">
            {shown.map((entry) => (
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

        {pageCount > 1 && (
          <div className="mt-2 flex items-center justify-between">
            <span className="font-mono text-[10px] text-faint">
              {start + 1}–{start + shown.length} of {history.length}
            </span>
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-1"
                aria-label="Newer"
                disabled={safePage === 0}
                onClick={() => setPage(safePage - 1)}
              >
                <CaretLeftIcon className="size-3.5" aria-hidden />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-1"
                aria-label="Older"
                disabled={safePage >= pageCount - 1}
                onClick={() => setPage(safePage + 1)}
              >
                <CaretRightIcon className="size-3.5" aria-hidden />
              </Button>
            </div>
          </div>
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
