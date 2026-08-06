'use client'

import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { toast } from 'sonner'
import { normaliseTag, DeviceResponseSchema, DeviceTagsResponseSchema, type ClusterInfo } from '@enkaku/protocol'
import { z } from 'zod'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api } from '@/lib/actions'
import { relativeTime } from '@/lib/format'
import type { DiscoveredDevice } from '@/lib/api'

/**
 * The admission wizard (plan 56 §4.5): one screen, opened from a Discovered
 * tray row. Model and Android version are read-only facts probed off the
 * phone; label, cluster and tags are the only things an operator sets.
 *
 * Two actions, both final: **Add to farm** creates the `devices` row (plan 56
 * §4.3), **Dismiss** clears the tray row (§3.5) — it is NOT a block, so the
 * phone shows up again here the next time it connects. Closing the dialog any
 * other way (Escape, the × button) decides nothing and leaves the row as it was.
 */
export function AdmitDeviceDialog({
  entry,
  clusters,
  open,
  onOpenChange,
  onDone,
}: {
  entry: DiscoveredDevice | null
  clusters: ClusterInfo[]
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called after a successful Add to farm OR Dismiss — either way the row just left the tray. */
  onDone: () => void
}) {
  const [label, setLabel] = useState('')
  const [clusterId, setClusterId] = useState('none')
  const [tags, setTags] = useState<string[]>([])
  const [tagDraft, setTagDraft] = useState('')
  const [busy, setBusy] = useState<'admit' | 'dismiss' | null>(null)

  // Reseed the draft from the probed values every time a fresh row opens —
  // otherwise the previous row's edits would bleed into this one.
  useEffect(() => {
    if (!open) return
    setLabel(entry?.label ?? '')
    setClusterId('none')
    setTags([])
    setTagDraft('')
  }, [open, entry])

  if (!entry) return null

  const addTag = (raw: string) => {
    const trimmed = raw.trim()
    if (!trimmed) return
    const normalised = normaliseTag(trimmed)
    if (!tags.includes(normalised)) setTags([...tags, normalised])
    setTagDraft('')
  }
  const removeTag = (tag: string) => setTags(tags.filter((t) => t !== tag))

  const admit = async () => {
    setBusy('admit')
    try {
      const body: { label?: string; clusterId?: string } = {}
      if (label.trim()) body.label = label.trim()
      if (clusterId !== 'none') body.clusterId = clusterId
      const res = await api(
        `/api/devices/discovered/${encodeURIComponent(entry.stableId)}/admit`,
        DeviceResponseSchema,
        { method: 'POST', json: body },
      )
      if (tags.length > 0) {
        // Best-effort: the phone is already in the farm either way, so a
        // failure here is a warning, not a reason to say the whole action failed.
        //
        // The plan called this one z.void() (the caller does not read the
        // response) — but PUT /:id/tags actually returns `{ tags }`
        // (`packages/core/src/api/devices.ts`), a non-empty body. `z.void()`
        // only parses `undefined`, so it would reject that real response and
        // turn every successful save into a spurious "could not be saved"
        // warning. `DeviceTagsResponseSchema` is the schema that matches what
        // the route actually sends; the result is still discarded.
        await api(`/api/devices/${res.device.id}/tags`, DeviceTagsResponseSchema, { method: 'PUT', json: { tags } }).catch(
          () => toast.warning(`${res.device.label} was added, but its tags could not be saved`),
        )
      }
      toast.success(`${res.device.label} added to the farm`)
      onOpenChange(false)
      onDone()
    } catch (err) {
      toast.error('Could not add the phone to the farm', { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(null)
    }
  }

  const dismiss = async () => {
    setBusy('dismiss')
    try {
      // `DELETE /discovered/:stableId` returns `{ ok: true }` — no envelope
      // for that exists in `@enkaku/protocol` yet, and this call site never
      // reads the body, so a small ad-hoc schema rather than a new export
      // for a value nothing reads.
      await api(`/api/devices/discovered/${encodeURIComponent(entry.stableId)}`, z.object({ ok: z.boolean() }), {
        method: 'DELETE',
      })
      toast.success(`${entry.label ?? entry.stableId} dismissed — it reappears here if it connects again`)
      onOpenChange(false)
      onDone()
    } catch (err) {
      toast.error('Could not dismiss the phone', { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add {entry.label ?? entry.stableId} to the farm</DialogTitle>
          <DialogDescription>
            This phone is not part of the farm — adb can see it, but it is only listed, not schedulable, until you add
            it.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3 rounded-md border p-3 text-[12.5px]">
            <div>
              <p className="rack-label">Model</p>
              <p className="mt-0.5">{entry.label ?? 'Unknown model'}</p>
            </div>
            <div>
              <p className="rack-label">Android version</p>
              <p className="readout mt-0.5">{entry.androidVersion ?? '—'}</p>
            </div>
          </div>
          <p className="text-[11.5px] text-fg-subtle">
            <span className="readout">{entry.serial}</span> · waiting since {relativeTime(entry.firstSeen)}
          </p>

          <div className="space-y-1.5">
            <Label htmlFor="admit-label" className="text-[13px] font-normal">
              Label
            </Label>
            <Input
              id="admit-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={entry.stableId}
              className="h-8 text-[12.5px]"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="admit-cluster" className="text-[13px] font-normal">
              Cluster
            </Label>
            <Select value={clusterId} onValueChange={setClusterId}>
              <SelectTrigger id="admit-cluster" className="h-8 w-full text-[12.5px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No cluster</SelectItem>
                {clusters.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label className="text-[13px] font-normal">Tags</Label>
            {tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {tags.map((tag) => (
                  <Badge key={tag} variant="secondary" className="gap-1 py-0.5 pr-1">
                    <span className="readout">{tag}</span>
                    <button
                      type="button"
                      onClick={() => removeTag(tag)}
                      aria-label={`Remove tag ${tag}`}
                      className="rounded-full p-0.5 hover:bg-surface-3"
                    >
                      <X className="size-3" aria-hidden />
                    </button>
                  </Badge>
                ))}
              </div>
            )}
            <Input
              value={tagDraft}
              onChange={(e) => setTagDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  addTag(tagDraft)
                }
              }}
              placeholder="Add a tag, e.g. pool:smoke"
              aria-label="Add a tag"
              className="h-8 text-[12.5px]"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={busy !== null} onClick={() => void dismiss()}>
            {busy === 'dismiss' ? 'Dismissing…' : 'Dismiss'}
          </Button>
          <Button disabled={busy !== null} onClick={() => void admit()}>
            {busy === 'admit' ? 'Adding…' : 'Add to farm'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
