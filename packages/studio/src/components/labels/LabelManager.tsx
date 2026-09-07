'use client'

import { useState } from 'react'
import { LABEL_COLORS, type LabelColor, type LabelInfo } from '@enkaku/protocol'
import {
  Button,
  ConfirmDialog,
  Input,
  LABEL_SWATCH,
  LabelChip,
  PencilSimpleIcon,
  PlusIcon,
  TrashIcon,
  cn,
} from '@enkaku/ui'
import { createLabel, deleteLabel, updateLabel, type LabelsState } from '@/lib/labels'

const ROW = 'flex w-full items-center gap-2 rounded-button px-2 py-1.5 text-row transition-colors'

/** The eight-swatch picker. Closed set, so it is a row of dots, not a colour wheel — see `LABEL_COLORS`. */
function ColorPicker({ value, onChange }: { value: LabelColor; onChange: (c: LabelColor) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {LABEL_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onChange(c)}
          aria-label={c}
          aria-pressed={value === c}
          className={cn(
            'size-[18px] rounded-full transition-transform',
            LABEL_SWATCH[c],
            value === c ? 'scale-110 ring-2 ring-accent ring-offset-2 ring-offset-panel' : 'hover:scale-110',
          )}
        />
      ))}
    </div>
  )
}

/**
 * Create, rename, recolour and delete labels (plan 225 §4.7) — the surface
 * that exists ONLY because a label is a row with a life of its own. The
 * free-form tags this replaces had nothing to manage: a tag came into being
 * when someone typed it onto a device and vanished with the last device that
 * carried it, so there was no empty label to create and no farm-wide typo to
 * fix.
 *
 * Deleting says how many devices lose the label, because that is the one
 * thing the operator cannot see from the list and cannot undo afterwards.
 * The devices themselves are never touched — same rule as deleting a group.
 */
export function LabelManager({ state, onClose }: { state: LabelsState; onClose: () => void }) {
  const { labels, loaded, reload } = state
  const [editing, setEditing] = useState<{ id: string | null; name: string; color: LabelColor } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const startNew = () => {
    setError(null)
    setEditing({ id: null, name: '', color: 'slate' })
  }

  const startEdit = (label: LabelInfo) => {
    setError(null)
    setEditing({ id: label.id, name: label.name, color: label.color })
  }

  const submit = async () => {
    if (!editing || !editing.name.trim()) return
    setBusy(true)
    setError(null)
    try {
      if (editing.id === null) await createLabel({ name: editing.name, color: editing.color })
      else await updateLabel(editing.id, { name: editing.name, color: editing.color })
      setEditing(null)
      reload()
    } catch (e) {
      // Verbatim: the server's refusal names the label that already has this
      // name, which is the whole reason a duplicate is worth reporting.
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (label: LabelInfo) => {
    await deleteLabel(label.id).catch(() => {})
    reload()
  }

  return (
    <div data-menu-root="1" className="w-[292px] rounded-card border border-border bg-panel p-2 shadow-menu">
      <div className="flex items-center justify-between px-1 pb-2">
        <p className="text-body font-semibold text-text">Labels</p>
        <button type="button" onClick={onClose} className="text-label text-faint hover:text-text">
          Close
        </button>
      </div>

      <div className="max-h-[260px] space-y-0.5 overflow-y-auto">
        {!loaded && <p className="px-2 py-3 text-center text-body text-faint">Loading…</p>}
        {loaded && labels.length === 0 && !editing && (
          <p className="px-2 py-3 text-center text-body text-faint">
            No labels yet. A label groups devices without moving them out of their group.
          </p>
        )}
        {labels.map((label) =>
          editing?.id === label.id ? (
            <div key={label.id} className="rounded-button bg-muted p-2">
              <Input
                autoFocus
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submit()
                  if (e.key === 'Escape') setEditing(null)
                }}
                className="h-8 text-[12.5px]"
              />
              <div className="mt-2">
                <ColorPicker value={editing.color} onChange={(color) => setEditing({ ...editing, color })} />
              </div>
              {error && <p className="mt-2 text-label text-danger">{error}</p>}
              <div className="mt-2 flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>
                  Cancel
                </Button>
                <Button variant="default" size="sm" disabled={busy || !editing.name.trim()} onClick={() => void submit()}>
                  Save
                </Button>
              </div>
            </div>
          ) : (
            <div key={label.id} className={cn(ROW, 'hover:bg-muted')}>
              <LabelChip name={label.name} color={label.color} className="min-w-0 flex-1 justify-start" />
              <span className="flex-none text-label text-faint">{label.deviceCount}</span>
              <button
                type="button"
                onClick={() => startEdit(label)}
                aria-label={`Edit ${label.name}`}
                className="flex-none rounded p-1 text-faint hover:text-text"
              >
                <PencilSimpleIcon className="size-3.5" aria-hidden />
              </button>
              <ConfirmDialog
                title={`Delete “${label.name}”?`}
                description={
                  label.deviceCount === 0
                    ? 'No device carries it. Nothing else changes.'
                    : `It comes off ${label.deviceCount} device${label.deviceCount === 1 ? '' : 's'}. The devices themselves stay exactly as they are.`
                }
                confirmLabel="Delete"
                onConfirm={() => void remove(label)}
                trigger={
                  <button type="button" aria-label={`Delete ${label.name}`} className="flex-none rounded p-1 text-faint hover:text-danger">
                    <TrashIcon className="size-3.5" aria-hidden />
                  </button>
                }
              />
            </div>
          ),
        )}

        {editing?.id === null && (
          <div className="rounded-button bg-muted p-2">
            <Input
              autoFocus
              value={editing.name}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit()
                if (e.key === 'Escape') setEditing(null)
              }}
              placeholder="Label name"
              className="h-8 text-[12.5px]"
            />
            <div className="mt-2">
              <ColorPicker value={editing.color} onChange={(color) => setEditing({ ...editing, color })} />
            </div>
            {error && <p className="mt-2 text-label text-danger">{error}</p>}
            <div className="mt-2 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button variant="default" size="sm" disabled={busy || !editing.name.trim()} onClick={() => void submit()}>
                Create
              </Button>
            </div>
          </div>
        )}
      </div>

      {!editing && (
        <>
          <div className="my-1 border-t border-line" />
          <button type="button" onClick={startNew} className={cn(ROW, 'text-accent hover:bg-muted')}>
            <PlusIcon className="size-4" aria-hidden />
            New label
          </button>
        </>
      )}
    </div>
  )
}
