'use client'

import { useState } from 'react'
import { Clipboard } from 'lucide-react'
import {
  Button,
  Input,
  Switch,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@enkaku/ui'
import { newId, ws } from '@/lib/ws'

/**
 * The device clipboard, in the screen card's toolbar (plan 57 §3.4).
 *
 * It used to be a panel in the right column, filed with the hardware facts.
 * But a clipboard is not a property of a device — it is something you *do to*
 * one, in the same family as back / home / recents / power / volume. So it
 * sits with those buttons instead. It needs a text field, so it cannot be a
 * bare icon button like the rest: it opens a popover.
 *
 * Read needs no lease; Send is disabled with the same rule as every other
 * input control here (`canSend`, the caller's `iHoldControl && !busy`) — a
 * convenience only, the server checks the lease itself on every
 * `clipboard.set` regardless (spec §10.1).
 */
export function ClipboardButton({ deviceId, canSend }: { deviceId: string; canSend: boolean }) {
  const [value, setValue] = useState<string | null>(null)
  const [reading, setReading] = useState(false)
  const [text, setText] = useState('')
  const [paste, setPaste] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  async function read(): Promise<void> {
    setError(null)
    setReading(true)
    try {
      const res = await ws.request({ type: 'clipboard.get', id: newId(), payload: { deviceId } })
      if (res.type === 'clipboard.value') setValue(res.payload.text)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setReading(false)
    }
  }

  async function send(): Promise<void> {
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

  async function copyToMine(): Promise<void> {
    if (value === null) return
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Some browsers refuse without a user gesture or a secure context —
      // the value is still shown on screen either way, so this is best-effort.
    }
  }

  return (
    <Popover>
      {/* A tooltip like its neighbours in the toolbar, on the same trigger. */}
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button size="sm" variant="ghost" className="h-8 w-10" aria-label="Clipboard">
              <Clipboard className="size-4" aria-hidden />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Clipboard — read what the device holds, or send it text</TooltipContent>
      </Tooltip>
      <PopoverContent align="start" className="w-80">
        <h2 className="rack-label mb-2.5">clipboard</h2>
        {error && <p className="mb-2 text-[11.5px] text-led-danger">{error}</p>}

        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" className="h-7 text-[12px]" disabled={reading} onClick={() => void read()}>
            {reading ? 'Reading…' : 'Read'}
          </Button>
          {value !== null && (
            <Button size="sm" variant="ghost" className="h-7 text-[12px]" onClick={() => void copyToMine()}>
              {copied ? 'Copied' : 'Copy to my clipboard'}
            </Button>
          )}
        </div>
        {value !== null && (
          <p className="readout mt-2 truncate rounded-md border bg-surface-2 px-2 py-1.5 text-[11.5px]" title={value}>
            {value.length === 0 ? '(empty)' : value}
          </p>
        )}

        <div className="mt-3 border-t pt-3">
          <Input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Text to send"
            disabled={!canSend || sending}
            className="h-7 text-[12px]"
          />
          <div className="mt-2 flex items-center justify-between gap-2">
            <label className="flex items-center gap-1.5 text-[11.5px] text-fg-muted">
              <Switch size="sm" checked={paste} onCheckedChange={setPaste} disabled={!canSend || sending} />
              Paste into focused field
            </label>
            <Button
              size="sm"
              className="h-7 text-[12px]"
              disabled={!canSend || sending || text.length === 0}
              onClick={() => void send()}
            >
              {sending ? 'Sending…' : 'Send'}
            </Button>
          </div>
          {!canSend && <p className="mt-1.5 text-[11px] text-fg-subtle">Take control before sending.</p>}
        </div>
      </PopoverContent>
    </Popover>
  )
}
