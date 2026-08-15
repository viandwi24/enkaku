'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import {
  ParamSetDeleteResponseSchema,
  ParamSetListResponseSchema,
  ParamSetResponseSchema,
  reconcileParams,
  summarizeApply,
  type JsonSchemaNode,
  type ParamSetInfo,
} from '@enkaku/protocol'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api, describeApiError } from '@/lib/actions'

/**
 * The preset row above a params form (plan 95 §4.7, §4.8, §5 step 95.8) —
 * pick one, Save as…, Update, Delete. Shared by `RunScriptDialog` and
 * `ScheduleEditorDialog` so the fetch, the CRUD wiring, and the one-line
 * apply report (`summarizeApply`) exist in exactly one place rather than
 * twice.
 *
 * Deliberately does NOT own `params` — applying a preset calls `onApply`
 * with the RECONCILED value (`reconcileParams`, plan 95 §4.4) and every
 * subsequent edit flows through the caller's own `SchemaForm` exactly as if
 * the operator had typed it in by hand. What this component tracks about
 * "which preset looks selected" is presentation only, cleared the moment the
 * caller's own `value` diverges from what was applied — never a live
 * binding a later preset edit could reach back through. This is the SAME
 * reference-vs-resolution split plan 62 §3.3 draws between a schedule's
 * `scriptRef` and a job's `scriptId`, applied here to a preset instead of a
 * script version: `ScheduleEditorDialog` stores what this component hands
 * it, never the preset's id.
 */
export function ParamSetPicker({
  scriptName,
  schema,
  value,
  onApply,
}: {
  /** The script NAME a set is filed under (plan 95 §4.7) — never a version id, so a preset outlives every publish. */
  scriptName: string
  schema: JsonSchemaNode | null
  value: unknown
  onApply(next: unknown): void
}) {
  const [sets, setSets] = useState<ParamSetInfo[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [savingAs, setSavingAs] = useState(false)
  const [draftName, setDraftName] = useState('')
  const [busy, setBusy] = useState(false)

  // Refetched whenever the script changes — a different script has an
  // entirely different set of presets, and the previous selection cannot
  // mean anything here.
  useEffect(() => {
    setSelectedId('')
    setSavingAs(false)
    setDraftName('')
    if (!scriptName) {
      setSets([])
      return
    }
    let cancelled = false
    void api(`/api/scripts/${encodeURIComponent(scriptName)}/param-sets`, ParamSetListResponseSchema)
      .then((res) => {
        if (!cancelled) setSets(res.items)
      })
      .catch(() => {
        if (!cancelled) setSets([])
      })
    return () => {
      cancelled = true
    }
  }, [scriptName])

  if (!scriptName) return null

  const selected = sets.find((s) => s.id === selectedId) ?? null

  const apply = (set: ParamSetInfo) => {
    setSelectedId(set.id)
    const result = reconcileParams(schema, set.params)
    onApply(result.value)
    const report = summarizeApply(set.name, result.findings)
    if (result.blocking) toast.warning(report)
    else toast.success(report)
  }

  const saveAs = async () => {
    const name = draftName.trim()
    if (!name) return
    setBusy(true)
    try {
      const res = await api(`/api/scripts/${encodeURIComponent(scriptName)}/param-sets`, ParamSetResponseSchema, {
        method: 'POST',
        json: { name, params: value ?? {} },
      })
      setSets((prev) => [...prev, res.paramSet].sort((a, b) => a.name.localeCompare(b.name)))
      setSelectedId(res.paramSet.id)
      setSavingAs(false)
      setDraftName('')
      toast.success(`Saved as '${res.paramSet.name}'`)
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
      const res = await api(`/api/scripts/${encodeURIComponent(scriptName)}/param-sets/${selected.id}`, ParamSetResponseSchema, {
        method: 'PATCH',
        json: { params: value ?? {} },
      })
      setSets((prev) => prev.map((s) => (s.id === res.paramSet.id ? res.paramSet : s)))
      toast.success(`Updated '${res.paramSet.name}' to the current settings`)
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
      await api(`/api/scripts/${encodeURIComponent(scriptName)}/param-sets/${selected.id}`, ParamSetDeleteResponseSchema, { method: 'DELETE' })
      setSets((prev) => prev.filter((s) => s.id !== selected.id))
      setSelectedId('')
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
            const set = sets.find((s) => s.id === id)
            if (set) apply(set)
          }}
        >
          <SelectTrigger className="h-8 min-w-40 flex-1 text-[12.5px]">
            <SelectValue placeholder={sets.length === 0 ? 'No presets saved yet' : 'Pick a preset'} />
          </SelectTrigger>
          <SelectContent>
            {sets.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name}
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
        <Button type="button" variant="ghost" size="sm" className="h-8 text-[12px]" disabled={busy || !selected} onClick={() => void update()}>
          Update
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
    </div>
  )
}
