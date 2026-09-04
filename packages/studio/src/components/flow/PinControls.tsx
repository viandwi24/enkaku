'use client'

import { useState } from 'react'
import { Button, CheckCircleIcon, PencilSimpleIcon, Textarea, TrashIcon, useAction } from '@enkaku/ui'

/**
 * Pin / unpin / edit (plan 300 P10, plan 306 §4.2 step 306.7). Only a
 * `script` or a `delay` node may be pinned — the caller (`NodePanel.tsx`)
 * never renders this at all on a `gate`/`switch`/`start`/`finish` node
 * (plan 300 R6, enforced server-side by `E_PIN_NOT_PINNABLE` since commit
 * `388f8c5`); this component does not re-check that, because a control that
 * is never mounted needs no guard of its own.
 */
export function PinControls({
  pinned,
  pinnedUpdatedAt,
  hasLastOutput,
  onPin,
  onUnpin,
  onEdit,
}: {
  pinned: boolean
  /** Unix seconds — `null` when not pinned. */
  pinnedUpdatedAt: number | null
  /** Whether this node has a recorded output to pin FROM (the "pin last output" shortcut). */
  hasLastOutput: boolean
  onPin(): Promise<void>
  onUnpin(): Promise<void>
  onEdit(data: unknown): Promise<void>
}) {
  const { run, isPending } = useAction()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [draftError, setDraftError] = useState<string | null>(null)

  return (
    <div className="space-y-1.5 rounded border bg-panel-2 px-2 py-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {pinned ? (
          <span className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-[11px] text-led-ok">
            <CheckCircleIcon className="size-3.5" aria-hidden />
            pinned{pinnedUpdatedAt ? ` · ${new Date(pinnedUpdatedAt * 1000).toLocaleString()}` : ''}
          </span>
        ) : (
          <span className="text-[11px] text-fg-subtle">not pinned</span>
        )}
        <div className="flex-1" />
        {!pinned && (
          <Button type="button" variant="outline" size="sm" disabled={!hasLastOutput || isPending('pin')} onClick={() => void run('pin', onPin)}>
            {isPending('pin') ? 'Pinning…' : 'Pin last output'}
          </Button>
        )}
        {pinned && (
          <Button type="button" variant="outline" size="sm" onClick={() => void run('unpin', onUnpin)} disabled={isPending('unpin')}>
            <TrashIcon className="size-3.5" aria-hidden />
            Unpin
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Edit pin by hand"
          onClick={() => {
            setDraft('')
            setDraftError(null)
            setEditing((v) => !v)
          }}
        >
          <PencilSimpleIcon className="size-3.5" aria-hidden />
        </Button>
      </div>
      {editing && (
        <div className="space-y-1">
          <Textarea
            className="min-h-16 font-mono text-[11.5px]"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="JSON value to pin"
            aria-label="Pin data, as JSON"
          />
          {draftError && <p className="text-[11px] text-led-danger">{draftError}</p>}
          <Button
            type="button"
            size="sm"
            disabled={isPending('edit-pin')}
            onClick={() => {
              let parsed: unknown
              try {
                parsed = JSON.parse(draft)
              } catch (err) {
                setDraftError(err instanceof Error ? err.message : 'Invalid JSON')
                return
              }
              setDraftError(null)
              void run('edit-pin', () => onEdit(parsed), { onSuccess: () => setEditing(false) })
            }}
          >
            {isPending('edit-pin') ? 'Saving…' : 'Save pin'}
          </Button>
        </div>
      )}
    </div>
  )
}
