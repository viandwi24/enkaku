'use client'

import { useEffect, useState } from 'react'
import type { DeviceInfo } from '@enkaku/protocol'
import { CaretRightIcon, ConfirmDialog, Input, MagnifyingGlassIcon, cn } from '@enkaku/ui'
import { LabelAssign } from '@/components/labels/LabelAssign'
import { fetchDevices } from '@/lib/api'
import { useAdbShortcuts } from '@/lib/adb-command-memory'
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
 *    where a submenu would open over the phone being watched. Groups are
 *    accordions, collapsed by default, with a search box over them.
 *
 * Both walk `groupedDeviceActions(shortcuts)`, so the membership, the order, the
 * icons, the hints and what each row DOES cannot differ between the three
 * surfaces: none of them holds a row of its own. What differs is only the
 * context each passes — which devices, and which surface — and a row that
 * cannot act in that context is drawn disabled with its reason, never hidden
 * and never quietly narrowed to one device.
 *
 * The farm's saved adb shortcuts are subscribed to HERE, in the one component
 * all three surfaces draw through, and handed to `groupedDeviceActions` — the
 * registry itself stays a plain module with no hooks in it, and no surface
 * ends up with a shortcut list of its own.
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
  const shortcuts = useAdbShortcuts()
  const [openGroup, setOpenGroup] = useState<string | null>(null)
  const [labelsOpen, setLabelsOpen] = useState(false)
  const side = submenuSide === 'left' ? 'right-full mr-1' : 'left-full ml-1'
  const align = submenuAlign === 'bottom' ? 'bottom-0' : 'top-0'

  return (
    <div className="relative p-1" onMouseLeave={() => setOpenGroup(null)}>
      {groupedDeviceActions(shortcuts).map(({ group, items }, index) => {
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

/**
 * Device Control's Actions tab.
 *
 * Every labelled run is a COLLAPSED accordion, and there is a search box above
 * them (owner, 2026-09-16: the tab "makan space terlalu panjang kebawah").
 * Forty-odd rows under eight headings made a column nobody could reach the
 * bottom of inside a window that is mostly phone, and the farm's saved adb
 * shortcuts only make it longer. Collapsed, the whole tab is one screen: the
 * three unlabelled rows that are why the tab is opened (Open Device Control,
 * Labels, Forget) stay inline exactly as before, and everything else is one
 * click — or one word typed — away.
 *
 * Typing searches every row in every run at once and opens whatever matched,
 * so the accordions never become a thing to remember the layout of: an
 * operator who knows the row's name does not have to know which heading it
 * lives under. Matching a heading's own name ("screen") keeps that whole run,
 * because that is the other way this box gets used.
 *
 * Which runs are open is deliberately NOT remembered across opens. Default
 * collapsed is the ask, and a tab that reopens the way you left it is a tab
 * that slowly returns to the long column this replaces.
 */
export function DeviceActionPanel({ ctx }: { ctx: DeviceActionContext }) {
  const shortcuts = useAdbShortcuts()
  const [labelsOpen, setLabelsOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({})

  const q = query.trim().toLowerCase()
  const groups = groupedDeviceActions(shortcuts)
    .map(({ group, items }) => {
      if (q.length === 0) return { group, items }
      // A heading that matches keeps all of its rows; otherwise the rows
      // match on their own name, and an empty run drops out below.
      const kept = group.label.toLowerCase().includes(q) ? items : items.filter((i) => i.label.toLowerCase().includes(q))
      return { group, items: kept }
    })
    .filter((g) => g.items.length > 0)

  const searching = q.length > 0
  const rowsFound = groups.reduce((n, g) => n + g.items.length, 0)

  return (
    <div className="flex flex-col p-1 pb-2">
      <div className="relative px-1 pt-1 pb-0.5">
        <MagnifyingGlassIcon className="absolute left-3.5 top-1/2 size-3.5 -translate-y-1/2 text-faint" aria-hidden />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search actions…"
          aria-label="Search actions"
          className="h-8 pl-8 text-[12.5px]"
        />
      </div>

      {searching && rowsFound === 0 && <p className="px-3 py-3 text-meta text-faint">No action matches “{query.trim()}”.</p>}

      {groups.map(({ group, items }, index) => {
        if (group.label === '') {
          return (
            <div key={group.id} className="flex flex-col gap-0.5">
              {index > 0 && <div className="my-1 border-t border-line" />}
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
          )
        }

        // While searching, what matched is open — collapsing a hit would hide
        // the answer to the thing just typed.
        const expanded = searching || openGroups[group.id] === true
        const GroupIcon = items[0]!.icon
        return (
          <div key={group.id} className="flex flex-col gap-0.5">
            <button
              type="button"
              className={cn(ROW, 'mt-1 text-text hover:bg-muted', expanded && 'bg-muted')}
              aria-expanded={expanded}
              onClick={() => setOpenGroups((prev) => ({ ...prev, [group.id]: !expanded }))}
            >
              <GroupIcon className="size-4 shrink-0 text-faint" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-left">{group.label}</span>
              <span className="shrink-0 text-label text-faint">{items.length}</span>
              <CaretRightIcon className={cn('size-3 shrink-0 text-faint transition-transform', expanded && 'rotate-90')} aria-hidden />
            </button>
            {expanded && (
              <div className="flex flex-col gap-0.5 pl-2.5">
                {items.map((item) => (
                  <ActionRow key={item.id} item={item} ctx={ctx} onDone={() => {}} />
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
