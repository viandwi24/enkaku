'use client'

import { useMemo, useState } from 'react'
import type { DeviceInfo, LabelInfo } from '@enkaku/protocol'
import { CheckIcon, Input, LabelChip, PlusIcon, cn } from '@enkaku/ui'
import { runAction } from '@/lib/actions'
import { createLabel, useLabels } from '@/lib/labels'

const ROW = 'flex w-full items-center gap-2 rounded-button px-2 py-[7px] text-row transition-colors hover:bg-muted'

/** none = no device in the selection carries it, all = every one does, some = a mixed selection. */
type Carriage = 'none' | 'some' | 'all'

/**
 * Put labels on, or take them off, whatever is selected (plan 225 §4.6).
 *
 * The ONE assignment surface: the context menu opens it for a right-clicked
 * selection of any size, and the device page opens it for one device. That is
 * deliberate — group membership already learned this lesson (`set-group` is
 * one verb reached from several places, never several implementations), and a
 * per-device editor beside a bulk editor is two chances to disagree about
 * what "add" means.
 *
 * Three states per row, not two. Across a selection a label can be on every
 * device, on some, or on none, and a plain checkbox has nowhere to put
 * "some" — it would render unchecked and then, on the first click, quietly
 * REMOVE the label from the devices that had it. So a mixed row shows a dash
 * and its first click adds to everyone, which is the only reading of that
 * click that cannot lose data.
 */
export function LabelAssign({
  devices,
  onChanged,
  onDone,
}: {
  devices: DeviceInfo[]
  /** A label was created or a count moved — the caller's own label list is now stale. */
  onChanged?: () => void
  onDone?: () => void
}) {
  const { labels, loaded, reload } = useLabels()
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  /**
   * What the panel has changed since it opened, keyed by label id.
   *
   * The panel is optimistic on purpose: `devices` comes from the screen's own
   * list, which is refreshed by the `device.updated` broadcast the action
   * triggers — a round trip that is fast but not instant, and a checkbox that
   * takes 200ms to tick reads as broken. Merged over the real carriage below,
   * never replacing it, so an untouched row still shows the truth.
   */
  const [pending, setPending] = useState<Record<string, boolean>>({})

  const deviceIds = useMemo(() => devices.map((d) => d.id), [devices])

  const carriageOf = (label: LabelInfo): Carriage => {
    const override = pending[label.id]
    if (override !== undefined) return override ? 'all' : 'none'
    if (devices.length === 0) return 'none'
    const carrying = devices.filter((d) => d.labels.some((l) => l.id === label.id)).length
    if (carrying === 0) return 'none'
    return carrying === devices.length ? 'all' : 'some'
  }

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return needle ? labels.filter((l) => l.name.toLowerCase().includes(needle)) : labels
  }, [labels, query])

  /** An exact name match means the operator is picking the label, not naming a new one. */
  const canCreate = query.trim().length > 0 && !labels.some((l) => l.name.toLowerCase() === query.trim().toLowerCase())

  const apply = async (labelId: string, op: 'add' | 'remove') => {
    if (deviceIds.length === 0) return
    setBusy(true)
    setPending((p) => ({ ...p, [labelId]: op === 'add' }))
    try {
      await runAction('set-labels', { deviceIds }, { op, labelIds: [labelId] })
      reload()
      onChanged?.()
    } catch {
      // Put the row back where it was — an optimistic tick that survives a
      // failed write is worse than a slow one.
      setPending((p) => {
        const next = { ...p }
        delete next[labelId]
        return next
      })
    } finally {
      setBusy(false)
    }
  }

  const createAndApply = async () => {
    const name = query.trim()
    if (!name) return
    setBusy(true)
    try {
      const label = await createLabel({ name })
      reload()
      onChanged?.()
      setQuery('')
      await apply(label.id, 'add')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="w-[248px] p-1">
      <div className="px-1 pt-1 pb-2">
        <Input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && canCreate) void createAndApply()
          }}
          placeholder="Find or create a label…"
          aria-label="Find or create a label"
          className="h-8 text-[12.5px]"
        />
      </div>

      <div className="max-h-[240px] overflow-y-auto">
        {!loaded && <p className="px-2 py-3 text-center text-body text-faint">Loading…</p>}
        {loaded && labels.length === 0 && (
          <p className="px-2 py-3 text-center text-body text-faint">No labels yet. Type a name to make one.</p>
        )}
        {loaded && labels.length > 0 && visible.length === 0 && !canCreate && (
          <p className="px-2 py-3 text-center text-body text-faint">No label matches.</p>
        )}
        {visible.map((label) => {
          const carriage = carriageOf(label)
          return (
            <button
              key={label.id}
              type="button"
              disabled={busy}
              className={ROW}
              // A mixed row adds to everyone; only a row every device already
              // carries removes. See the component comment.
              onClick={() => void apply(label.id, carriage === 'all' ? 'remove' : 'add')}
            >
              <span
                className={cn(
                  'flex size-[15px] flex-none items-center justify-center rounded-check border transition-colors',
                  carriage === 'none' ? 'border-border-3' : 'border-accent bg-accent text-on-accent',
                )}
                aria-hidden
              >
                {carriage === 'all' && <CheckIcon className="size-2.5" />}
                {carriage === 'some' && <span className="h-[1.5px] w-2 rounded-full bg-on-accent" />}
              </span>
              <LabelChip name={label.name} color={label.color} className="min-w-0 flex-1 justify-start" />
              <span className="text-label text-faint">{label.deviceCount}</span>
            </button>
          )
        })}
      </div>

      {canCreate && (
        <>
          <div className="my-1 border-t border-line" />
          <button type="button" disabled={busy} className={cn(ROW, 'text-accent')} onClick={() => void createAndApply()}>
            <PlusIcon className="size-[15px] flex-none" aria-hidden />
            <span className="min-w-0 flex-1 truncate text-left">
              Create “{query.trim()}” and apply
            </span>
          </button>
        </>
      )}

      {onDone && (
        <>
          <div className="my-1 border-t border-line" />
          <button type="button" className={cn(ROW, 'justify-center text-dim')} onClick={onDone}>
            Done
          </button>
        </>
      )}
    </div>
  )
}
