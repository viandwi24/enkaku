'use client'

import { useState } from 'react'
import {
  Button,
  ClipboardIcon,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Textarea,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@enkaku/ui'
import { newId, ws } from '@/lib/ws'

/**
 * The rail's Clipboard button (design handoff rail item 10; plan 215 §4.7).
 * Replaces `components/device/ClipboardButton.tsx`: reads the device
 * clipboard on open, and sends host text with an optional immediate paste.
 */
export function ClipboardPopover({ deviceId }: { deviceId: string }) {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState<string | null>(null)
  const [reading, setReading] = useState(false)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

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

  async function copyToMine(): Promise<void> {
    if (value === null) return
    try {
      await navigator.clipboard.writeText(value)
    } catch {
      // Best-effort — some browsers refuse without a fresh gesture.
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
            <Button variant="ghost" size="icon-lg" className="rounded-[10px] text-dim" aria-label="Clipboard">
              <ClipboardIcon className="size-4" aria-hidden />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Clipboard · Alt+C / Alt+V</TooltipContent>
      </Tooltip>
      <PopoverContent data-menu-root="1" align="start" className="w-[260px]">
        {error && <p className="mb-2 text-[11px] text-danger">{error}</p>}
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" disabled={reading} onClick={() => void read()}>
            {reading ? 'Reading…' : 'Read'}
          </Button>
          {value !== null && (
            <Button size="sm" variant="ghost" onClick={() => void copyToMine()}>
              Copy
            </Button>
          )}
        </div>
        {value !== null && (
          <p className="mt-2 truncate rounded-inner border border-line bg-muted px-2 py-1.5 font-mono text-[11px]" title={value}>
            {value.length === 0 ? '(empty)' : value}
          </p>
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
