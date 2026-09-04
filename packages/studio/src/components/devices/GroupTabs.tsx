'use client'

import { useRef, useState } from 'react'
import { GroupResponseSchema, type DeviceInfo, type GroupInfo } from '@enkaku/protocol'
import { Button, Input, PencilSimpleIcon, PlusIcon, TrashIcon, api, cn, z } from '@enkaku/ui'
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

const ROW = 'flex w-full items-center gap-2.5 rounded-button px-[10px] py-[9px] text-row transition-colors text-text hover:bg-muted'

/**
 * The pill container, the add-group popover, and the tab context menu
 * (design handoff, Devices toolbar's left-hand tab strip; plan 214 §4.7).
 * Group CRUD lives only here (G7) — `POST/PATCH/DELETE /api/groups`.
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
  const [form, setForm] = useState<{ mode: 'new' } | { mode: 'rename'; id: string } | null>(null)
  const [draft, setDraft] = useState('')
  const [tabMenu, setTabMenu] = useState<{ id: string; name: string; left: number } | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const tabs: Tab[] = [
    { id: 'all', name: 'All', count: devices.length },
    ...groups.map((g) => ({ id: g.id, name: g.name, count: devices.filter((d) => d.group?.id === g.id).length })),
  ]

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
    setForm(next)
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
    const containerLeft = containerRef.current?.getBoundingClientRect().left ?? 0
    const left = e.currentTarget instanceof HTMLElement ? e.currentTarget.getBoundingClientRect().left - containerLeft : 0
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
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => onSelect(t.id)}
            onContextMenu={(e) => t.id !== 'all' && openTabMenu(e, t)}
            className={cn(
              'flex flex-none items-center rounded-pill px-[14px] py-[7px] text-body transition-colors',
              t.id === active ? 'bg-panel font-semibold text-text shadow-active-pill' : 'text-dim hover:text-text',
            )}
          >
            {t.name}
            <span className="ml-[7px] text-label text-faint">{t.count}</span>
          </button>
        ))}
      </div>
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
          className="absolute top-[40px] right-0 z-30 w-[224px] rounded-card border border-border bg-panel p-3 shadow-menu"
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
