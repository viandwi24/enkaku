'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { newId, ws } from '@/lib/ws'

/**
 * The Control tab's clipboard row (plan 38 §4.7): Read shows the device's
 * current clipboard text (with a copy-to-my-clipboard action); the text field
 * plus Send writes it, with an explicit "paste into the focused field"
 * switch (off by default — §3.4). Reading needs no lease; Send is disabled
 * with the exact same rule as every other input control here (`canSend`, the
 * caller's `iHoldControl && !busy`) — a convenience only, the server checks
 * the lease itself on every `clipboard.set` regardless (spec §10.1).
 */
export function ClipboardCard({ deviceId, canSend }: { deviceId: string; canSend: boolean }) {
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
    <div className="mt-3 rounded-lg border bg-surface p-3.5">
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
          <Button size="sm" className="h-7 text-[12px]" disabled={!canSend || sending || text.length === 0} onClick={() => void send()}>
            {sending ? 'Sending…' : 'Send'}
          </Button>
        </div>
        {!canSend && <p className="mt-1.5 text-[11px] text-fg-subtle">Take control before sending.</p>}
      </div>
    </div>
  )
}
