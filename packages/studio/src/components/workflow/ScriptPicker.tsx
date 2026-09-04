'use client'

import { compareSemver } from '@enkaku/protocol'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@enkaku/ui'
import type { JsonSchemaNode } from '@/components/schema-form/types'

/** One published, ordinary (`kind: 'script'`) row — the shape `ScriptListItemSchema` already returns. */
export interface ScriptOption {
  id: string
  name: string
  version: string
  paramsSchema: JsonSchemaNode | null
}

export interface ScriptNameGroup {
  name: string
  pluginName: string | null
  versions: ScriptOption[]
}

/** Mirrors `RunScriptDialog.tsx`'s own `groupByName`/`groupByPlugin` (plan 99 §4.11: "reusing the run dialog's ..."), reimplemented here rather than imported — those two are private to that file, and this picker's job (build a `ScriptRef`, not a `scriptId`) is different enough to want its own small copy rather than an export that file's own owner did not ask for. */
export function groupScriptsByName(scripts: readonly ScriptOption[]): ScriptNameGroup[] {
  const byName = new Map<string, ScriptOption[]>()
  for (const s of scripts) byName.set(s.name, [...(byName.get(s.name) ?? []), s])
  return [...byName.entries()]
    .map(([name, versions]) => ({
      name,
      pluginName: name.includes('/') ? (name.split('/')[0] ?? null) : null,
      versions: [...versions].sort((a, b) => compareSemver(b.version, a.version)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

function groupByPlugin(groups: ScriptNameGroup[]): Array<{ pluginName: string | null; items: ScriptNameGroup[] }> {
  const runs: Array<{ pluginName: string | null; items: ScriptNameGroup[] }> = []
  for (const g of groups) {
    const last = runs[runs.length - 1]
    if (last && last.pluginName === g.pluginName) last.items.push(g)
    else runs.push({ pluginName: g.pluginName, items: [g] })
  }
  return runs
}

function parseRef(ref: string): { name: string; version: string } | null {
  const at = ref.lastIndexOf('@')
  if (at <= 0) return null
  return { name: ref.slice(0, at), version: ref.slice(at + 1) }
}

/**
 * Picks a script by name, then a version — `latest` or one pinned semver —
 * producing a `ScriptRef` string (`name@version` / `name@latest`), the same
 * reference grammar `ScriptRegistry.resolve()` already understands (plan 99
 * §3.4, F17). Never a `scriptId`: a workflow node names its script by
 * REFERENCE, resolved fresh at publish/run time, exactly like a schedule's
 * `scriptRef` (F29).
 */
export function ScriptPicker({
  scripts,
  value,
  onChange,
}: {
  scripts: readonly ScriptOption[]
  value: string
  onChange(ref: string): void
}) {
  const groups = groupScriptsByName(scripts)
  const parsed = parseRef(value)
  const pickedName = parsed?.name ?? ''
  const pickedGroup = groups.find((g) => g.name === pickedName)
  const pickedVersion = parsed?.version ?? 'latest'

  return (
    <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
      <Select
        value={pickedName}
        onValueChange={(name) => onChange(`${name}@latest`)}
      >
        <SelectTrigger className="h-8 w-full text-[12.5px]" aria-label="Script">
          <SelectValue placeholder={groups.length === 0 ? 'No scripts published' : 'Pick a script'} />
        </SelectTrigger>
        <SelectContent>
          {groupByPlugin(groups).map((run, i) =>
            run.pluginName ? (
              <SelectGroup key={`${run.pluginName}-${i}`}>
                <SelectLabel>{run.pluginName}</SelectLabel>
                {run.items.map((g) => (
                  <SelectItem key={g.name} value={g.name}>
                    {g.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            ) : (
              run.items.map((g) => (
                <SelectItem key={g.name} value={g.name}>
                  {g.name}
                </SelectItem>
              ))
            ),
          )}
        </SelectContent>
      </Select>

      <Select value={pickedVersion} onValueChange={(version) => onChange(`${pickedName}@${version}`)} disabled={!pickedGroup}>
        <SelectTrigger className="readout h-8 min-w-32 text-[12px]" aria-label="Version">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="latest" className="readout">
            latest {pickedGroup?.versions[0] ? `(currently ${pickedGroup.versions[0].version})` : ''}
          </SelectItem>
          {(pickedGroup?.versions ?? []).map((v) => (
            <SelectItem key={v.id} value={v.version} className="readout">
              {v.version}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
