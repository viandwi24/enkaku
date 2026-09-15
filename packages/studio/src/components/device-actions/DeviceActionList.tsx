'use client'

import { useEffect, useState } from 'react'
import type { DeviceInfo } from '@enkaku/protocol'
import { CaretRightIcon, ConfirmDialog, cn } from '@enkaku/ui'
import { LabelAssign } from '@/components/labels/LabelAssign'
import { fetchDevices } from '@/lib/api'
import { deviceActionHint, groupedDeviceActions, type DeviceAction, type DeviceActionContext } from '@/lib/device-actions'

/**
 * The ONE action list, drawn two ways from `lib/device-actions.ts`
 * (owner, 2026-09-15: "the Device Control popup, the floating button's list
 * and the right-click menu must be identical").
 *
 *  - `DeviceActionMenu` — the floating bulk pill and the right-click menu. A
 *    floating popover has a ceiling, so labelled groups open beside the menu
 *    (owner, 2026-09-05: nineteen flat rows reached the top of the window).
 *  - `DeviceActionPanel` — Device Control's Actions tab, a scrolling column
 *    with no ceiling, where a submenu would open over the phone being
 *    watched. Groups are headings and every row is one click away.
 *
 * Both walk `groupedDeviceActions()`, so the membership, the order, the
 * icons, the hints and what each row DOES cannot differ between the three
 * surfaces: none of them holds a row of its own. What differs is only the
 * context each passes — which devices, and which surface — and a row that
 * cannot act in that context is drawn disabled with its reason, never hidden
 * and never quietly narrowed to one device.
 */

const ROW = 'flex w-full items-center gap-2.5 rounded-button px-[10px] py-[9px] text-row transition-colors'

function ActionRow({
  item,
  ctx,
  onDone,
  expanded,
  onToggle,
}: {
  item: DeviceAction
  ctx: DeviceActionContext
  onDone: (id: string) => void
  /** The labels row only: whether its panel is open. */
  expanded?: boolean
  onToggle?: () => void
}) {
  const Icon = item.icon
  const reason = item.kind === 'run' ? (item.unavailable?.(ctx) ?? null) : null
  const blocked = reason ?? (ctx.deviceIds.length === 0 ? 'No device' : null)
  const hint = [blocked, deviceActionHint(item, ctx)].filter(Boolean).join(' — ') || undefined
  const className = cn(
    ROW,
    blocked !== null ? 'cursor-not-allowed text-faint' : item.danger ? 'text-danger hover:bg-muted' : 'text-text hover:bg-muted',
    expanded && 'bg-muted',
  )
  const body = (
    <>
      <Icon className={cn('size-4 shrink-0', item.iconClassName)} aria-hidden />
      <span className="min-w-0 flex-1 truncate text-left">{item.label}</span>
      {/* The reason a row cannot act HERE, said on the row rather than in a tooltip nobody hovers. */}
      {blocked !== null && <span className="shrink-0 text-label text-faint">{blocked}</span>}
      {item.kind === 'labels' && <CaretRightIcon className={cn('size-3 shrink-0 text-faint transition-transform', expanded && 'rotate-90')} aria-hidden />}
    </>
  )

  if (item.kind === 'labels') {
    return (
      <button type="button" className={className} title={hint} aria-expanded={expanded} disabled={blocked !== null} onClick={onToggle}>
        {body}
      </button>
    )
  }
  if (item.confirm && blocked === null) {
    const { title, description, confirmLabel } = item.confirm
    return (
      <ConfirmDialog
        title={title}
        description={description}
        confirmLabel={confirmLabel}
        onConfirm={() => {
          item.run(ctx)
          onDone(item.id)
        }}
        trigger={
          <button type="button" className={className} title={hint}>
            {body}
          </button>
        }
      />
    )
  }
  return (
    <button
      type="button"
      className={className}
      title={hint}
      disabled={blocked !== null}
      onClick={() => {
        item.run(ctx)
        onDone(item.id)
      }}
    >
      {body}
    </button>
  )
}

/**
 * The label panel for the targeted devices. The Devices screen already holds
 * live rows and passes them; Device Control holds only ids for its mirror
 * members, so it is read once when the panel opens.
 */
function TargetLabels({
  deviceIds,
  devices,
  onChanged,
  onDone,
}: {
  deviceIds: readonly string[]
  devices?: DeviceInfo[]
  onChanged?: () => void
  onDone: () => void
}) {
  const [fetched, setFetched] = useState<DeviceInfo[] | null>(null)
  const key = deviceIds.join('\n')
  useEffect(() => {
    if (devices) return
    let cancelled = false
    const wanted = new Set(key.split('\n'))
    void fetchDevices()
      .then((rows) => {
        if (!cancelled) setFetched(rows.filter((d) => wanted.has(d.id)))
      })
      .catch(() => {
        if (!cancelled) setFetched([])
      })
    return () => {
      cancelled = true
    }
  }, [devices, key])
  const rows = devices ?? fetched
  if (!rows) return <p className="px-3 py-2 text-meta text-faint">Loading…</p>
  return <LabelAssign devices={rows} onChanged={onChanged} onDone={onDone} />
}

export function DeviceActionMenu({
  ctx,
  devices,
  onLabelsChanged,
  onDone,
  submenuSide = 'left',
  submenuAlign = 'bottom',
}: {
  ctx: DeviceActionContext
  /** The targeted devices as live rows, for the label panel. */
  devices?: DeviceInfo[]
  onLabelsChanged?: () => void
  /** A row ran. The caller closes its menu; the labels row does not call this — its panel stays open across many ticks. */
  onDone: (id: string) => void
  /**
   * Which way a group's panel opens. `left` is the bulk pill's case; the
   * context menu computes it from where the cursor is, because a menu opened
   * near the left edge of the window has nowhere to go on that side.
   */
  submenuSide?: 'left' | 'right'
  /** `bottom` grows a submenu upward (the bulk pill opens upward); `top` grows it downward. */
  submenuAlign?: 'top' | 'bottom'
}) {
  const [openGroup, setOpenGroup] = useState<string | null>(null)
  const [labelsOpen, setLabelsOpen] = useState(false)
  const side = submenuSide === 'left' ? 'right-full mr-1' : 'left-full ml-1'
  const align = submenuAlign === 'bottom' ? 'bottom-0' : 'top-0'

  return (
    <div className="relative p-1" onMouseLeave={() => setOpenGroup(null)}>
      {groupedDeviceActions().map(({ group, items }, index) => {
        // An unlabelled group is drawn inline: Open Device Control and Labels
        // because they are the reason most menus are opened, Forget because
        // burying the only destructive row behind a hover is how someone
        // deletes a device they meant to look at.
        if (group.label === '') {
          return (
            <div key={group.id}>
              {index > 0 && <div className="my-1 border-t border-line" />}
              {items.map((item) => (
                <div key={item.id} className="relative" onMouseEnter={() => setOpenGroup(null)}>
                  <ActionRow item={item} ctx={ctx} onDone={onDone} expanded={item.kind === 'labels' && labelsOpen} onToggle={() => setLabelsOpen((v) => !v)} />
                  {item.kind === 'labels' && labelsOpen && (
                    <div
                      className={cn('absolute z-10 rounded-card border border-border bg-panel shadow-panel-2', side, align)}
                      // The panel stays open across many ticks; a click inside
                      // it must not reach the menu behind and close it.
                      onClick={(e) => e.stopPropagation()}
                    >
                      <TargetLabels deviceIds={ctx.deviceIds} devices={devices} onChanged={onLabelsChanged} onDone={() => setLabelsOpen(false)} />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )
        }

        const isOpen = openGroup === group.id
        // A group's icon is its first row's — "Screen" opening on a sun says
        // more than a generic folder would.
        const GroupIcon = items[0]!.icon
        return (
          <div
            key={group.id}
            className="relative"
            onMouseEnter={() => {
              setOpenGroup(group.id)
              setLabelsOpen(false)
            }}
          >
            <button
              type="button"
              className={cn(ROW, 'text-text hover:bg-muted', isOpen && 'bg-muted')}
              onClick={() => setOpenGroup(isOpen ? null : group.id)}
              aria-expanded={isOpen}
            >
              <GroupIcon className="size-4 text-faint" aria-hidden />
              <span className="flex-1 text-left">{group.label}</span>
              <span className="text-label text-faint">{items.length}</span>
              <CaretRightIcon className="size-3 text-faint" aria-hidden />
            </button>
            {isOpen && (
              <div className={cn('absolute z-10 w-[236px] rounded-card border border-border bg-panel p-1 shadow-panel-2', side, align)}>
                {items.map((item) => (
                  <ActionRow key={item.id} item={item} ctx={ctx} onDone={onDone} />
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

export function DeviceActionPanel({ ctx }: { ctx: DeviceActionContext }) {
  const [labelsOpen, setLabelsOpen] = useState(false)
  return (
    <div className="flex flex-col p-1 pb-2">
      {groupedDeviceActions().map(({ group, items }, index) => (
        <div key={group.id} className="flex flex-col gap-0.5">
          {group.label === '' ? (
            index > 0 && <div className="my-1 border-t border-line" />
          ) : (
            <p className="mt-2 px-2.5 pb-1 text-label tracking-wide text-faint uppercase">{group.label}</p>
          )}
          {items.map((item) => (
            <div key={item.id}>
              <ActionRow item={item} ctx={ctx} onDone={() => {}} expanded={item.kind === 'labels' && labelsOpen} onToggle={() => setLabelsOpen((v) => !v)} />
              {item.kind === 'labels' && labelsOpen && (
                <div className="mx-1 mt-1 mb-1 rounded-card border border-border-2 bg-panel p-1">
                  <TargetLabels deviceIds={ctx.deviceIds} onDone={() => setLabelsOpen(false)} />
                </div>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
