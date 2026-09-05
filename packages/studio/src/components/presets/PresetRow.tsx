'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import {
  ParamPresetDeleteResponseSchema,
  ParamPresetListResponseSchema,
  ParamPresetResponseSchema,
  reconcileParams,
  type JsonSchemaNode,
  type ParamPresetInfo,
  type PresetKind,
} from '@enkaku/protocol'
import { Button, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, api, describeApiError } from '@enkaku/ui'

/**
 * The preset row above a parameter form (plan 311 G1, §3.2) — pick one,
 * Save as…, Update, Delete. Shared by every dialog that fills in a
 * `SchemaForm` from a script's or a workflow's own parameter schema, so the
 * fetch, the CRUD wiring, and the one-line apply report (plan 311 §3.4)
 * exist in exactly one place rather than several. Replaces the script-only
 * picker plan 95 built — one store, one component (plan 311 G4), generalised over
 * `kind` so a workflow gets the exact same shortcut a script always had.
 *
 * Deliberately does NOT own `value` — applying a preset calls `onApply` with
 * the RECONCILED value (`reconcileParams`, plan 95 §4.4) and every
 * subsequent edit flows through the caller's own `SchemaForm` exactly as if
 * the operator had typed it in by hand. What this component tracks about
 * "which preset looks selected" is presentation only, cleared the moment the
 * caller's own `value` diverges from what was applied — never a live
 * binding a later preset edit could reach back through. This is the SAME
 * reference-vs-resolution split plan 62 §3.3 draws between a schedule's
 * `scriptRef` and a job's `scriptId`, applied here to a preset instead of a
 * script version: a caller stores what this component hands it, never the
 * preset's id.
 */
export function PresetRow({
  kind,
  ownerName,
  schema,
  value,
  onApply,
}: {
  /** `'script' | 'workflow'` (plan 311 §3.3) — which route family and store partition to use. */
  kind: PresetKind
  /** The script or workflow NAME a preset is filed under — never a version (plan 311 §3.1), so a preset outlives every publish. */
  ownerName: string
  schema: JsonSchemaNode | null
  value: unknown
  onApply(next: unknown, report: { applied: string[]; unknown: string[] }): void
}) {
  const [presets, setPresets] = useState<ParamPresetInfo[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [appliedValue, setAppliedValue] = useState<unknown>(undefined)
  const [applyLine, setApplyLine] = useState<string | null>(null)
  const [savingAs, setSavingAs] = useState(false)
  const [draftName, setDraftName] = useState('')
  const [busy, setBusy] = useState(false)

  const listUrl = `${kind === 'script' ? '/api/scripts' : '/api/workflows'}/${encodeURIComponent(ownerName)}/${kind === 'script' ? 'param-sets' : 'presets'}`
  const itemUrl = (id: string) => `${listUrl}/${encodeURIComponent(id)}`

  // Refetched whenever the owner changes — a different script or workflow
  // has an entirely different set of presets, and the previous selection
  // cannot mean anything here.
  useEffect(() => {
    setSelectedId('')
    setAppliedValue(undefined)
    setApplyLine(null)
    setSavingAs(false)
    setDraftName('')
    if (!ownerName) {
      setPresets([])
      return
    }
    let cancelled = false
    void api(listUrl, ParamPresetListResponseSchema)
      .then((res) => {
        if (!cancelled) setPresets(res.items)
      })
      .catch(() => {
        if (!cancelled) setPresets([])
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, ownerName])

  if (!ownerName || !schema) return null

  const selected = presets.find((p) => p.id === selectedId) ?? null
  // "the form dirty against it" (plan 311 §4.2) — Update is only offered
  // once the operator has actually changed something since the apply/save.
  const dirty = selected !== null && JSON.stringify(value ?? null) !== JSON.stringify(appliedValue ?? null)

  const apply = (preset: ParamPresetInfo) => {
    setSelectedId(preset.id)
    const result = reconcileParams(schema, preset.params)
    setAppliedValue(result.value)
    const unknownFields = result.findings.filter((f) => f.kind === 'removed').map((f) => f.path)
    const applied = Object.keys((result.value as Record<string, unknown> | null) ?? {}).filter((k) => !unknownFields.includes(k))
    setApplyLine(formatApplyLine(applied.length, unknownFields))
    onApply(result.value, { applied, unknown: unknownFields })
  }

  const saveAs = async () => {
    const name = draftName.trim()
    if (!name) return
    setBusy(true)
    try {
      const res = await api(listUrl, ParamPresetResponseSchema, { method: 'POST', json: { name, params: value ?? {} } })
      setPresets((prev) => [...prev, res.preset].sort((a, b) => a.name.localeCompare(b.name)))
      setSelectedId(res.preset.id)
      setAppliedValue(value ?? {})
      setApplyLine(null)
      setSavingAs(false)
      setDraftName('')
      toast.success(`Saved as '${res.preset.name}'`)
    } catch (err) {
      toast.error('Could not save the preset', { description: describeApiError(err) })
    } finally {
      setBusy(false)
    }
  }

  const update = async () => {
    if (!selected) return
    setBusy(true)
    try {
      const res = await api(itemUrl(selected.id), ParamPresetResponseSchema, { method: 'PATCH', json: { params: value ?? {} } })
      setPresets((prev) => prev.map((p) => (p.id === res.preset.id ? res.preset : p)))
      setAppliedValue(value ?? {})
      setApplyLine(null)
      toast.success(`Updated '${res.preset.name}' to the current settings`)
    } catch (err) {
      toast.error('Could not update the preset', { description: describeApiError(err) })
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!selected) return
    if (!window.confirm(`Delete the '${selected.name}' preset? This cannot be undone.`)) return
    setBusy(true)
    try {
      await api(itemUrl(selected.id), ParamPresetDeleteResponseSchema, { method: 'DELETE' })
      setPresets((prev) => prev.filter((p) => p.id !== selected.id))
      setSelectedId('')
      setAppliedValue(undefined)
      setApplyLine(null)
      toast.success(`Deleted '${selected.name}'`)
    } catch (err) {
      toast.error('Could not delete the preset', { description: describeApiError(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-1.5 rounded-lg border bg-surface-2/40 p-3">
      <Label className="text-[12.5px] font-normal">Preset</Label>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={selectedId}
          onValueChange={(id) => {
            const preset = presets.find((p) => p.id === id)
            if (preset) apply(preset)
          }}
        >
          <SelectTrigger className="h-8 min-w-40 flex-1 text-[12.5px]">
            <SelectValue placeholder={presets.length === 0 ? 'No presets saved yet' : 'Pick a preset'} />
          </SelectTrigger>
          <SelectContent>
            {presets.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="h-8 text-[12px]"
          disabled={busy}
          onClick={() => {
            setSavingAs(true)
            setDraftName('')
          }}
        >
          Save as…
        </Button>
        <Button type="button" variant="ghost" size="sm" className="h-8 text-[12px]" disabled={busy || !selected || !dirty} onClick={() => void update()}>
          {selected ? `Update "${selected.name}"` : 'Update'}
        </Button>
        <Button type="button" variant="ghost" size="sm" className="h-8 text-[12px] text-led-danger" disabled={busy || !selected} onClick={() => void remove()}>
          Delete
        </Button>
      </div>
      {savingAs && (
        <div className="flex items-center gap-2 pt-1">
          <Input
            autoFocus
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            placeholder="Preset name"
            className="h-8 flex-1 text-[12.5px]"
            onKeyDown={(e) => {
              if (e.key === 'Enter') void saveAs()
              if (e.key === 'Escape') setSavingAs(false)
            }}
          />
          <Button type="button" size="sm" className="h-8 text-[12px]" disabled={busy || !draftName.trim()} onClick={() => void saveAs()}>
            Save
          </Button>
          <Button type="button" variant="ghost" size="sm" className="h-8 text-[12px]" onClick={() => setSavingAs(false)}>
            Cancel
          </Button>
        </div>
      )}
      {applyLine && <p className="pt-0.5 text-meta text-dim">{applyLine}</p>}
    </div>
  )
}

/**
 * The one line shown under the row after applying a preset (plan 311 §3.4):
 * "apply what matches, list what did not". `unknown` names fields the
 * preset carried that the current schema no longer declares — dropped from
 * the applied value (never written into the form, G7), only reported here.
 */
function formatApplyLine(appliedCount: number, unknown: readonly string[]): string {
  const appliedPart = `${appliedCount} field${appliedCount === 1 ? '' : 's'} applied`
  if (unknown.length === 0) return `${appliedPart}.`
  const names = unknown.map((u) => `\`${u}\``).join(', ')
  return `${appliedPart}, ${unknown.length} no longer exist${unknown.length === 1 ? 's' : ''} (${names}).`
}
