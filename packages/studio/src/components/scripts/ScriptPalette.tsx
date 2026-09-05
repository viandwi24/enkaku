'use client'

import { useEffect, useMemo, useState } from 'react'
import type { ScriptListItem } from '@enkaku/protocol'
import { Badge, Button, CaretUpDownIcon, Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, cn } from '@enkaku/ui'
import { pluginIcon } from '@/lib/plugin-icons'
import { matchScore } from '@/lib/palette-rank'

/**
 * The script palette (plan 310 §3.2, §4.2) — replaces the flat `Combobox`
 * every script picker used before this plan. Two `cmdk` pages: page one
 * lists PLUGINS, page two lists one plugin's SCRIPTS. Typing on page one
 * searches scripts across every plugin too (G2) — a query that matches no
 * plugin name still finds the script, shown with its plugin as the hint.
 * `Backspace` on an empty query pops page two back to page one (G3), the
 * documented `cmdk` "pages" recipe.
 *
 * One fetch of `GET /api/scripts` per open — no second endpoint. The
 * grouping-by-plugin on page one is a projection of that same list, and a
 * plugin's own icon rides along on `ScriptListItem.plugin.icon` (plan 310
 * §4.1's amendment to `ScriptPluginRefSchema`) for exactly that reason:
 * carrying it there keeps this a ONE-fetch dialog instead of a second call
 * to `GET /api/plugins` just to draw the plugin page's icons.
 */

const MAX_SCRIPTS_ON_PLUGIN_PAGE = 8

interface PluginGroup {
  name: string
  version: string
  icon: string | null
  scripts: ScriptListItem[]
}

function groupByPlugin(scripts: readonly ScriptListItem[]): PluginGroup[] {
  const byName = new Map<string, PluginGroup>()
  for (const s of scripts) {
    const existing = byName.get(s.plugin.name)
    if (existing) existing.scripts.push(s)
    else byName.set(s.plugin.name, { name: s.plugin.name, version: s.plugin.version, icon: s.plugin.icon, scripts: [s] })
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

function scriptLabel(s: ScriptListItem): string {
  return s.title ?? s.exportId
}

/** Title, `exportId`, then description; prefix before substring (§4.2) — the SAME ranking shape `flow/NodePalette.tsx` uses, extracted to `lib/palette-rank.ts` so the two cannot drift apart. */
function rankScripts(scripts: readonly ScriptListItem[], query: string): ScriptListItem[] {
  return scripts
    .map((s) => ({ s, score: matchScore(query, { title: scriptLabel(s), description: s.description, keywords: [s.exportId] }) }))
    .filter((x): x is { s: ScriptListItem; score: number } => x.score !== null)
    .sort((a, b) => a.score - b.score || scriptLabel(a.s).localeCompare(scriptLabel(b.s)))
    .map((x) => x.s)
}

function ScriptRow({ script, onSelect }: { script: ScriptListItem; onSelect(): void }) {
  const Icon = pluginIcon(script.icon ?? 'play')
  return (
    <CommandItem value={script.id} onSelect={onSelect}>
      <Icon className="size-4 shrink-0 text-fg-muted" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="truncate">{scriptLabel(script)}</p>
        <p className="truncate text-[11px] text-fg-subtle">{script.plugin.name}</p>
      </div>
    </CommandItem>
  )
}

export function ScriptPalette({
  open,
  onOpenChange,
  scripts,
  /** Pre-selects the plugin page when reopening on an already-chosen script. */
  initialScriptName,
  onPick,
}: {
  open: boolean
  onOpenChange(open: boolean): void
  /** `null` while `GET /api/scripts` is still loading. */
  scripts: readonly ScriptListItem[] | null
  initialScriptName?: string
  onPick(script: ScriptListItem): void
}) {
  const [query, setQuery] = useState('')
  // `[]` = the plugin page; one entry = that plugin's script page. A stack
  // (not a boolean) on purpose, matching `cmdk`'s own documented "pages"
  // recipe, even though this palette only ever goes one level deep today.
  const [pages, setPages] = useState<string[]>([])
  const activePlugin = pages[pages.length - 1]

  useEffect(() => {
    if (!open) return
    setQuery('')
    const initial = initialScriptName ? (scripts ?? []).find((s) => s.name === initialScriptName) : undefined
    setPages(initial ? [initial.plugin.name] : [])
    // Only re-derived when the dialog OPENS — `scripts` finishing its load a
    // moment later must not yank the operator back to page one mid-search.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const groups = useMemo(() => groupByPlugin(scripts ?? []), [scripts])
  const currentGroup = groups.find((g) => g.name === activePlugin)

  // Page one's own ranking (§4.2): plugin NAME matches first (whole rows),
  // then script matches across every plugin, capped, shown with their
  // plugin as the hint — a query with no matching plugin name still finds
  // the script (G2).
  const pluginMatches = useMemo(() => {
    if (!query.trim()) return groups
    const q = query.trim().toLowerCase()
    return groups.filter((g) => g.name.toLowerCase().includes(q))
  }, [groups, query])

  const scriptMatchesAcrossPlugins = useMemo(() => {
    if (!query.trim()) return []
    // Skip a plugin the name search already matched whole — its scripts are
    // reachable by opening that row, and listing them twice on one page
    // would be noise, not help.
    const namedPluginIds = new Set(pluginMatches.map((g) => g.name))
    const candidates = (scripts ?? []).filter((s) => !namedPluginIds.has(s.plugin.name))
    return rankScripts(candidates, query).slice(0, MAX_SCRIPTS_ON_PLUGIN_PAGE)
  }, [scripts, query, pluginMatches])

  const rankedGroupScripts = useMemo(() => (currentGroup ? rankScripts(currentGroup.scripts, query) : []), [currentGroup, query])

  const pick = (script: ScriptListItem) => {
    onPick(script)
    onOpenChange(false)
  }

  const openPlugin = (name: string) => {
    const group = groups.find((g) => g.name === name)
    // Q4 — a plugin with exactly one script skips its own page: a page with
    // one row teaches nothing and costs a keystroke.
    if (group && group.scripts.length === 1 && group.scripts[0]) {
      pick(group.scripts[0])
      return
    }
    setPages((p) => [...p, name])
    setQuery('')
  }

  const popPage = () => {
    setPages((p) => p.slice(0, -1))
    setQuery('')
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={currentGroup ? `${currentGroup.name}'s scripts` : 'Choose a script'}
      description="Search scripts by title, or browse by the plugin that publishes them"
    >
      <Command shouldFilter={false}>
        <CommandInput
          placeholder={currentGroup ? 'Search this plugin’s scripts…' : 'Search scripts, or a plugin name…'}
          value={query}
          onValueChange={setQuery}
          aria-label="Search scripts"
          onKeyDown={(e) => {
            // The documented `cmdk` "pages" recipe (§3.2, G3): `Backspace` on
            // an empty query pops back to the plugin page, exactly the
            // keyboard convention an operator already has from every other
            // breadcrumb-less picker.
            if (e.key === 'Backspace' && query === '' && pages.length > 0) {
              e.preventDefault()
              popPage()
            }
          }}
        />
        <CommandList className="max-h-72">
          {scripts === null ? (
            <div className="px-3 py-4 text-[12.5px] text-fg-muted">Loading…</div>
          ) : scripts.length === 0 ? (
            <div className="px-3 py-4 text-[12.5px] text-fg-muted">
              No plugin publishes a script yet. Install one from the{' '}
              <a href="/plugins" className="text-accent hover:underline">
                Plugins page
              </a>
              .
            </div>
          ) : currentGroup ? (
            <>
              <CommandEmpty>No script matches in {currentGroup.name}.</CommandEmpty>
              <CommandGroup heading={currentGroup.name}>
                {rankedGroupScripts.map((s) => (
                  <ScriptRow key={s.id} script={s} onSelect={() => pick(s)} />
                ))}
              </CommandGroup>
            </>
          ) : (
            <>
              <CommandEmpty>No plugin or script matches.</CommandEmpty>
              {pluginMatches.length > 0 && (
                <CommandGroup heading="Plugins">
                  {pluginMatches.map((g) => {
                    const Icon = pluginIcon(g.icon ?? 'puzzle')
                    return (
                      <CommandItem key={g.name} value={g.name} onSelect={() => openPlugin(g.name)}>
                        <Icon className="size-4 shrink-0 text-fg-muted" aria-hidden />
                        <div className="min-w-0 flex-1">
                          <p className="truncate">{g.name}</p>
                          <p className="truncate text-[11px] text-fg-subtle">
                            {g.scripts.length} script{g.scripts.length === 1 ? '' : 's'}
                          </p>
                        </div>
                      </CommandItem>
                    )
                  })}
                </CommandGroup>
              )}
              {scriptMatchesAcrossPlugins.length > 0 && (
                <CommandGroup heading="Scripts">
                  {scriptMatchesAcrossPlugins.map((s) => (
                    <ScriptRow key={s.id} script={s} onSelect={() => pick(s)} />
                  ))}
                </CommandGroup>
              )}
            </>
          )}
        </CommandList>
      </Command>
    </CommandDialog>
  )
}

/**
 * The trigger row every call site renders instead of its own summary of the
 * chosen script (plan 310 §4.3 — "the three sites cannot render three
 * different summaries of the same choice"): icon, title, plugin chip, and
 * the pinned version as READ-ONLY text (§3.4 — a version is a fact now,
 * never a `Select`). Clicking opens `ScriptPalette` above; picking a row
 * closes it and reports the pick to `onPick`.
 */
export function ScriptTrigger({
  scripts,
  selected,
  onPick,
  placeholder = 'Choose a script',
  disabled,
  className,
  ariaLabel = 'Script',
}: {
  /** `null` while `GET /api/scripts` is still loading. */
  scripts: readonly ScriptListItem[] | null
  /** The currently pinned script, already resolved by the caller (e.g. `scriptBindings.ts`'s `resolveScriptOption`) — this component never guesses which ref format a caller pins in. */
  selected: ScriptListItem | null
  onPick(script: ScriptListItem): void
  placeholder?: string
  disabled?: boolean
  className?: string
  ariaLabel?: string
}) {
  const [open, setOpen] = useState(false)
  const Icon = selected ? pluginIcon(selected.icon ?? 'play') : null

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-label={ariaLabel}
        disabled={disabled || scripts === null}
        onClick={() => setOpen(true)}
        className={cn('w-full justify-between gap-2 font-normal', className)}
      >
        {selected ? (
          <span className="flex min-w-0 flex-1 items-center gap-2">
            {Icon && <Icon className="size-4 shrink-0 text-fg-muted" aria-hidden />}
            <span className="truncate">{selected.title ?? selected.exportId}</span>
            <Badge variant="secondary" className="shrink-0">
              {selected.plugin.name}
            </Badge>
            <span className="shrink-0 text-[11px] text-fg-subtle">@{selected.plugin.version}</span>
          </span>
        ) : (
          <span className="truncate text-fg-subtle">{scripts === null ? 'Loading…' : placeholder}</span>
        )}
        <CaretUpDownIcon className="size-3.5 shrink-0 opacity-60" aria-hidden />
      </Button>
      <ScriptPalette open={open} onOpenChange={setOpen} scripts={scripts} initialScriptName={selected?.name} onPick={onPick} />
    </>
  )
}
