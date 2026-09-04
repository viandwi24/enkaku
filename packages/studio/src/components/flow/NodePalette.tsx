'use client'

import { useEffect, useState } from 'react'
import type { NodeType } from '@enkaku/protocol'
import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, describeApiError } from '@enkaku/ui'
import { pluginIcon } from '@/lib/plugin-icons'
import { fetchNodeTypes } from '@/lib/api'

/**
 * The palette (plan 305 §3.6, P2, P3) — fed by `GET /api/node-types` (plan
 * 303 §4.3). Grouped: core control nodes first, then one group per plugin,
 * each sorted by title. Search matches title, description, plugin id and
 * `keywords`, ranks prefix matches first, capped at 5 visible results
 * before scrolling (plan 300 P3's own parameter). Opens from three call
 * sites (the toolbar button, a drag from a handle to empty canvas, `+` on
 * an edge) — all three render this same component with a different
 * `onPick`, per §3.6.
 */

function pluginIdOf(type: NodeType): string | null {
  return type.source === 'plugin' ? (type.id.includes('/') ? type.id.split('/')[0]! : null) : null
}

function groupLabel(type: NodeType): string {
  return type.source === 'core' ? 'Core' : (pluginIdOf(type) ?? type.id)
}

function matchScore(query: string, type: NodeType): number | null {
  const q = query.trim().toLowerCase()
  if (!q) return 0
  const title = type.title.toLowerCase()
  const haystacks = [title, type.description.toLowerCase(), type.id.toLowerCase(), ...type.keywords.map((k) => k.toLowerCase())]
  if (title.startsWith(q)) return 0
  if (haystacks.some((h) => h.startsWith(q))) return 1
  if (haystacks.some((h) => h.includes(q))) return 2
  return null
}

function rankAndGroup(types: NodeType[], query: string): Map<string, NodeType[]> {
  const scored = types
    .map((t) => ({ t, score: matchScore(query, t) }))
    .filter((s): s is { t: NodeType; score: number } => s.score !== null)
    .sort((a, b) => a.score - b.score || a.t.title.localeCompare(b.t.title))
  const groups = new Map<string, NodeType[]>()
  for (const { t } of scored) {
    const label = groupLabel(t)
    const list = groups.get(label)
    if (list) list.push(t)
    else groups.set(label, [t])
  }
  // Core first, then alphabetical by group label.
  return new Map([...groups.entries()].sort(([a], [b]) => (a === 'Core' ? -1 : b === 'Core' ? 1 : a.localeCompare(b))))
}

export function NodePalette({
  open,
  onOpenChange,
  onPick,
}: {
  open: boolean
  onOpenChange(open: boolean): void
  onPick(type: NodeType): void
}) {
  const [types, setTypes] = useState<NodeType[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  useEffect(() => {
    if (!open) return
    setError(null)
    void fetchNodeTypes()
      .then(setTypes)
      .catch((e) => setError(describeApiError(e)))
  }, [open])

  useEffect(() => {
    if (!open) setQuery('')
  }, [open])

  const grouped = types ? rankAndGroup(types, query) : new Map<string, NodeType[]>()

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="Add a node" description="Search the node catalog by title, plugin id, or category">
      <Command shouldFilter={false}>
        <CommandInput placeholder="Search nodes…" value={query} onValueChange={setQuery} aria-label="Search nodes" />
        <CommandList className="max-h-60">
          {error ? (
            <div className="px-3 py-4 text-[12.5px] text-led-danger">{error}</div>
          ) : !types ? (
            <div className="px-3 py-4 text-[12.5px] text-fg-muted">Loading…</div>
          ) : (
            <>
              <CommandEmpty>No node matches.</CommandEmpty>
              {[...grouped.entries()].map(([group, items]) => (
                <CommandGroup key={group} heading={group}>
                  {items.map((t) => {
                    const Icon = pluginIcon(t.icon)
                    return (
                      <CommandItem
                        key={t.id}
                        value={t.id}
                        onSelect={() => {
                          onPick(t)
                          onOpenChange(false)
                        }}
                      >
                        <Icon className="size-4 shrink-0 text-fg-muted" aria-hidden />
                        <div className="min-w-0 flex-1">
                          <p className="truncate">{t.title}</p>
                          {t.description && <p className="truncate text-[11px] text-fg-subtle">{t.description}</p>}
                        </div>
                      </CommandItem>
                    )
                  })}
                </CommandGroup>
              ))}
            </>
          )}
        </CommandList>
      </Command>
    </CommandDialog>
  )
}
