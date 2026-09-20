'use client'

import { useEffect, useRef, useState } from 'react'
import { GroupOrderResponseSchema, GroupResponseSchema, type DeviceInfo, type GroupInfo } from '@enkaku/protocol'
import { Button, CaretLeftIcon, CaretRightIcon, Input, PencilSimpleIcon, PlusIcon, TrashIcon, api, cn, z } from '@enkaku/ui'
import { useOverlay } from '@/lib/overlays'

/** `Farm D` -> `FARM-D` (design handoff, Devices toolbar). Collapses runs of whitespace, then uppercases. */
export function normaliseGroupName(raw: string): string {
  return raw.trim().replace(/\s+/g, '-').toUpperCase()
}

interface Tab {
  id: string
  name: string
  count: number
}

const ROW = 'flex w-full items-center gap-2.5 rounded-button px-[10px] py-[9px] text-row transition-colors text-text hover:bg-muted disabled:pointer-events-none disabled:opacity-40'

const FORM_WIDTH_PX = 224
const TAB_MENU_WIDTH_PX = 188
/** The gap a menu keeps from either edge of the window. */
const MENU_GUTTER_PX = 8

/**
 * A menu here is absolutely positioned inside the tab strip's container, so
 * its `left` is container-relative — and that container is only as wide as
 * the tabs happen to be. A farm with one or two groups makes it narrower
 * than the 224px form, and right-aligning the form to it then put the form's
 * left edge off the left of the screen (owner, 2026-09-20). Clamp the
 * container-relative left so a menu of `width` stays inside the window with
 * a gutter on both sides; the window is always wider than either menu, so
 * the lower bound wins only when the upper one would push it off the left.
 */
function clampMenuLeft(container: DOMRect, desired: number, width: number): number {
  const min = MENU_GUTTER_PX - container.left
  const max = window.innerWidth - MENU_GUTTER_PX - width - container.left
  return Math.max(min, Math.min(desired, max))
}

/** `groups` in `order`, with any group the order does not name (created elsewhere meanwhile) kept at the end. */
function applyOrder(groups: GroupInfo[], order: readonly string[] | null): GroupInfo[] {
  if (!order) return groups
  const byId = new Map(groups.map((g) => [g.id, g]))
  const placed = order.map((id) => byId.get(id)).filter((g): g is GroupInfo => g !== undefined)
  const seen = new Set(order)
  return [...placed, ...groups.filter((g) => !seen.has(g.id))]
}

/** `ids` with `moving` taken out and put back before or after `target`. */
function moveId(ids: readonly string[], moving: string, target: string, side: 'before' | 'after'): string[] {
  const rest = ids.filter((id) => id !== moving)
  const at = rest.indexOf(target)
  if (at === -1) return [...ids]
  rest.splice(side === 'before' ? at : at + 1, 0, moving)
  return rest
}

/**
 * The pill container, the add-group popover, and the tab context menu
 * (design handoff, Devices toolbar's left-hand tab strip; plan 214 §4.7).
 * Group CRUD lives only here (G7) — `POST/PATCH/DELETE /api/groups`.
 *
 * The order is too (owner, 2026-09-15): drag a group tab onto another, press
 * Alt+Left/Right on a focused one, or use Move left/right in its menu. `All`
 * is fixed first and never moves. The order is farm-wide, so it is stored on
 * the server (`PUT /api/groups/order`) and every `/api/groups` reader — the
 * schedule and action dialogs included — gets the same sequence.
 */
export function GroupTabs({
  groups,
  devices,
  active,
  onSelect,
  onMutated,
}: {
  groups: GroupInfo[]
  devices: DeviceInfo[]
  active: string
  onSelect: (id: string) => void
  onMutated: () => void
}) {
  const [form, setForm] = useState<({ mode: 'new' } | { mode: 'rename'; id: string }) & { left: number } | null>(null)
  const [draft, setDraft] = useState('')
  const [tabMenu, setTabMenu] = useState<{ id: string; name: string; left: number } | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  /**
   * The order just asked for, shown before the server confirms it so a drop
   * lands where it was dropped. Cleared whenever a fresh `groups` list
   * arrives — the reload after the PUT, or any other — because from then on
   * the server's own order is the truth.
   */
  const [pendingOrder, setPendingOrder] = useState<string[] | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropHint, setDropHint] = useState<{ id: string; side: 'before' | 'after' } | null>(null)
  const [orderError, setOrderError] = useState<string | null>(null)
  const tabRefs = useRef(new Map<string, HTMLButtonElement>())

  useEffect(() => setPendingOrder(null), [groups])

  useEffect(() => {
    if (!orderError) return
    const t = setTimeout(() => setOrderError(null), 4000)
    return () => clearTimeout(t)
  }, [orderError])

  const ordered = applyOrder(groups, pendingOrder)
  const orderedIds = ordered.map((g) => g.id)

  const tabs: Tab[] = [
    { id: 'all', name: 'All', count: devices.length },
    ...ordered.map((g) => ({ id: g.id, name: g.name, count: devices.filter((d) => d.group?.id === g.id).length })),
  ]

  const saveOrder = (ids: string[], refocus?: string) => {
    if (ids.every((id, i) => id === orderedIds[i])) return
    setPendingOrder(ids)
    setOrderError(null)
    // Moving a focused button through the DOM drops its focus; a keyboard
    // move puts it back so the next Alt+Arrow keeps working.
    if (refocus) requestAnimationFrame(() => tabRefs.current.get(refocus)?.focus())
    api('/api/groups/order', GroupOrderResponseSchema, { method: 'PUT', json: { ids } })
      .catch(() => {
        // Stale (a group created or deleted elsewhere) or refused: snap back
        // to the server's order and say so, rather than leaving a tab where
        // the farm does not have it.
        setPendingOrder(null)
        setOrderError('Group order not saved')
      })
      .finally(onMutated)
  }

  const moveBy = (id: string, delta: -1 | 1) => {
    const at = orderedIds.indexOf(id)
    const to = at + delta
    if (at === -1 || to < 0 || to >= orderedIds.length) return
    const target = orderedIds[to]
    if (target === undefined) return
    saveOrder(moveId(orderedIds, id, target, delta < 0 ? 'before' : 'after'), id)
  }

  const endDrag = () => {
    setDragId(null)
    setDropHint(null)
  }

  const onTabDragOver = (e: React.DragEvent<HTMLButtonElement>, t: Tab) => {
    if (!dragId) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    // Over `All`, the only place to go is before the first group.
    if (t.id === 'all') {
      const first = orderedIds[0]
      if (first && first !== dragId) setDropHint((h) => (h?.id === first && h.side === 'before' ? h : { id: first, side: 'before' }))
      return
    }
    if (t.id === dragId) {
      setDropHint(null)
      return
    }
    const r = e.currentTarget.getBoundingClientRect()
    const side = e.clientX < r.left + r.width / 2 ? 'before' : 'after'
    setDropHint((h) => (h?.id === t.id && h.side === side ? h : { id: t.id, side }))
  }

  const onTabDrop = (e: React.DragEvent<HTMLButtonElement>) => {
    e.preventDefault()
    if (dragId && dropHint) saveOrder(moveId(orderedIds, dragId, dropHint.id, dropHint.side))
    endDrag()
  }

  const closeForm = () => setForm(null)
  const closeTabMenu = () => setTabMenu(null)
  useOverlay('menu', form !== null, closeForm)
  useOverlay('menu', tabMenu !== null, closeTabMenu)

  const openForm = (next: { mode: 'new' } | { mode: 'rename'; id: string }) => {
    if (next.mode === 'rename') {
      const g = groups.find((x) => x.id === next.id)
      setDraft(g?.name ?? '')
    } else {
      setDraft('')
    }
    const r = containerRef.current?.getBoundingClientRect()
    /*
      Right-aligned under the `+` button — but never past the strip's own
      left edge. A farm with one group makes the container narrower than the
      224px form, and a plain right-align then took the form off the screen
      entirely (owner, 2026-09-20). `Math.max(0, …)` is what turns that into
      a left-align under the first tab instead: still inside the page panel,
      rather than hanging over the rail, which is where clamping to the
      WINDOW alone would have left it.
    */
    const left = r ? clampMenuLeft(r, Math.max(0, r.width - FORM_WIDTH_PX), FORM_WIDTH_PX) : 0
    setForm({ ...next, left })
    setTabMenu(null)
  }

  const submit = async () => {
    const name = normaliseGroupName(draft)
    if (!name) return
    if (form?.mode === 'new') {
      await api('/api/groups', GroupResponseSchema, { method: 'POST', json: { name } })
    } else if (form?.mode === 'rename') {
      await api(`/api/groups/${encodeURIComponent(form.id)}`, GroupResponseSchema, { method: 'PATCH', json: { name } })
    }
    closeForm()
    onMutated()
  }

  const openTabMenu = (e: React.MouseEvent, t: Tab) => {
    e.preventDefault()
    const r = containerRef.current?.getBoundingClientRect()
    const tabLeft = e.currentTarget instanceof HTMLElement ? e.currentTarget.getBoundingClientRect().left : 0
    const left = r ? clampMenuLeft(r, tabLeft - r.left, TAB_MENU_WIDTH_PX) : 0
    setTabMenu({ id: t.id, name: t.name, left })
  }

  const deleteGroup = async (id: string) => {
    await api(`/api/groups/${encodeURIComponent(id)}`, z.void(), { method: 'DELETE' }).catch(() => {})
    closeTabMenu()
    if (active === id) onSelect('all')
    onMutated()
  }

  return (
    <div ref={containerRef} className="relative flex min-w-0 flex-none items-center gap-2">
      <div className="flex min-w-0 flex-[0_1_auto] items-center gap-1 overflow-x-auto rounded-pill bg-muted p-1">
        {tabs.map((t) => {
          const movable = t.id !== 'all'
          return (
            <button
              key={t.id}
              ref={(node) => {
                if (node) tabRefs.current.set(t.id, node)
                else tabRefs.current.delete(t.id)
              }}
              type="button"
              draggable={movable}
              title={movable ? 'Drag to reorder (Alt+Left/Right)' : undefined}
              aria-keyshortcuts={movable ? 'Alt+ArrowLeft Alt+ArrowRight' : undefined}
              onClick={() => onSelect(t.id)}
              onContextMenu={(e) => movable && openTabMenu(e, t)}
              onKeyDown={(e) => {
                if (!movable || !e.altKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return
                e.preventDefault()
                moveBy(t.id, e.key === 'ArrowLeft' ? -1 : 1)
              }}
              onDragStart={(e) => {
                if (!movable) return
                e.dataTransfer.effectAllowed = 'move'
                // Firefox starts no drag without data.
                e.dataTransfer.setData('text/plain', t.name)
                setDragId(t.id)
                setTabMenu(null)
              }}
              onDragOver={(e) => onTabDragOver(e, t)}
              onDrop={onTabDrop}
              onDragEnd={endDrag}
              className={cn(
                'relative flex flex-none items-center rounded-pill px-[14px] py-[7px] text-body transition-colors',
                t.id === active ? 'bg-panel font-semibold text-text shadow-active-pill' : 'text-dim hover:text-text',
                dragId === t.id && 'opacity-50',
              )}
            >
              {dropHint?.id === t.id && (
                <span
                  aria-hidden
                  className={cn('pointer-events-none absolute top-1 bottom-1 w-0.5 rounded-pill bg-accent', dropHint.side === 'before' ? 'left-0' : 'right-0')}
                />
              )}
              {t.name}
              <span className="ml-[7px] text-label text-faint">{t.count}</span>
            </button>
          )
        })}
      </div>
      {orderError && (
        <span role="status" className="flex-none text-label text-danger">
          {orderError}
        </span>
      )}
      <button
        type="button"
        onClick={() => openForm({ mode: 'new' })}
        aria-label="New group"
        className="flex size-[30px] flex-none items-center justify-center rounded-pill border border-dashed border-border-3 text-faint transition-colors hover:border-accent hover:text-accent"
      >
        <PlusIcon className="size-[14px]" aria-hidden />
      </button>

      {form && (
        <div
          data-menu-root="1"
          style={{ left: form.left }}
          className="absolute top-[40px] z-30 w-[224px] rounded-card border border-border bg-panel p-3 shadow-menu"
        >
          <p className="text-body font-semibold text-text">{form.mode === 'new' ? 'New group' : 'Rename group'}</p>
          <Input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit()
              if (e.key === 'Escape') closeForm()
            }}
            className="mt-2"
          />
          <div className="mt-2 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={closeForm}>
              Cancel
            </Button>
            <Button variant="default" size="sm" disabled={!normaliseGroupName(draft)} onClick={() => void submit()}>
              {form.mode === 'new' ? 'Create' : 'Save'}
            </Button>
          </div>
        </div>
      )}

      {tabMenu && (
        <div
          data-menu-root="1"
          style={{ left: tabMenu.left }}
          className="absolute top-[40px] z-30 w-[188px] rounded-card border border-border bg-panel p-1 shadow-menu"
        >
          <button
            type="button"
            className={ROW}
            disabled={orderedIds.indexOf(tabMenu.id) <= 0}
            onClick={() => {
              moveBy(tabMenu.id, -1)
              closeTabMenu()
            }}
          >
            <CaretLeftIcon className="size-4" aria-hidden />
            Move left
          </button>
          <button
            type="button"
            className={ROW}
            disabled={orderedIds.indexOf(tabMenu.id) === orderedIds.length - 1}
            onClick={() => {
              moveBy(tabMenu.id, 1)
              closeTabMenu()
            }}
          >
            <CaretRightIcon className="size-4" aria-hidden />
            Move right
          </button>
          <button type="button" className={ROW} onClick={() => openForm({ mode: 'rename', id: tabMenu.id })}>
            <PencilSimpleIcon className="size-4" aria-hidden />
            Rename group
          </button>
          <button type="button" className={cn(ROW, 'text-danger')} onClick={() => void deleteGroup(tabMenu.id)}>
            <TrashIcon className="size-4" aria-hidden />
            Delete group
          </button>
        </div>
      )}
    </div>
  )
}
