'use client'

import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { toast } from 'sonner'
import {
  normaliseTag,
  DeviceDetailResponseSchema,
  DeviceResponseSchema,
  DeviceTagsResponseSchema,
  type ClusterInfo,
  type DeviceLabelMode,
} from '@enkaku/protocol'
import { z } from 'zod'
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  api,
  relativeTime,
} from '@enkaku/ui'
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
  farmLabellingMode,
  open,
  onOpenChange,
  onDone,
}: {
  entry: DiscoveredDevice | null
  clusters: ClusterInfo[]
  /** The farm's default `labelling.mode` (plan 89 §3.8) — what the checkbox below reflects, and what a device gets if the box is left alone. */
  farmLabellingMode: DeviceLabelMode
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
  // Physical labelling (plan 89 §3.8, §5 step 89.8) — reflects the farm
  // default (`admitDevice()` copies `FarmSettings.defaults.labelling` onto
  // every new device automatically, F26), and is genuinely EDITABLE for
  // this one phone: unchecking it here, or checking it against an `off`
  // farm default, issues one follow-up `PATCH` after admission overrides
  // `labelling.mode` for this device alone — there is no admission-time
  // body field for it (§4.3's own admit body is `{ label?, clusterId? }`),
  // so a two-step "admit, then override" is the only way Studio can honour
  // an operator's per-device choice without touching the admission route.
  const [wallpaper, setWallpaper] = useState(farmLabellingMode === 'wallpaper')

  // Reseed the draft from the probed values every time a fresh row opens —
  // otherwise the previous row's edits would bleed into this one.
  useEffect(() => {
    if (!open) return
    setLabel(entry?.label ?? '')
    setClusterId('none')
    setTags([])
    setTagDraft('')
    setWallpaper(farmLabellingMode === 'wallpaper')
  }, [open, entry, farmLabellingMode])

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
      // Physical labelling (plan 89 §3.8, §5 step 89.8): `admitDevice()`
      // already copied the farm default (F26), so a follow-up PATCH is only
      // needed when the checkbox disagrees with that default — the common
      // case (leaving it alone) costs nothing extra. `PATCH .../:id`
      // replaces the WHOLE `settings` blob (`DeviceVideoFields`'s own
      // comment states this), so the just-admitted device's real settings
      // are re-fetched first rather than guessed at — this is a labelling
      // override, not a reset of everything else `admitDevice()` copied.
      const wantsWallpaper = wallpaper
      if (wantsWallpaper !== (farmLabellingMode === 'wallpaper')) {
        try {
          const detail = await api(`/api/devices/${res.device.id}`, DeviceDetailResponseSchema)
          const settings = (detail.device.settings ?? {}) as Record<string, unknown>
          const labelling = (settings.labelling ?? {}) as Record<string, unknown>
          await api(`/api/devices/${res.device.id}`, DeviceResponseSchema, {
            method: 'PATCH',
            json: { settings: { ...settings, labelling: { ...labelling, mode: wantsWallpaper ? 'wallpaper' : 'off' } } },
          })
        } catch {
          toast.warning(`${res.device.label} was added, but its labelling could not be set — check its Settings tab`)
        }
      }
      // The dialog itself shows NO number beforehand (plan 89 §3.1): a
      // discovered device has none, and predicting one is a promise a
      // concurrent admit could break. The toast names the number it was
      // actually given, allocated server-side inside `admitDevice()`'s own
      // transaction.
      toast.success(
        res.device.number !== null
          ? `Added as #${res.device.number} ${res.device.label}`
          : `${res.device.label} added to the farm`,
      )
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

          {/* Physical labelling opt-in (plan 89 §3.8, §5 step 89.8) — the
              admit dialog is where a device's state STARTS changing, so this
              is where the choice is made, not only in a doc. Reflects the
              farm default rather than a blank checkbox nobody has decided
              on yet — an operator running a real farm has already set the
              farm default once and every subsequent admission should need
              no further thought (§3.8's own words). The copy is verbatim. */}
          <label className="flex items-start gap-3 rounded-md border p-3 text-[12.5px]">
            <Switch checked={wallpaper} onCheckedChange={setWallpaper} aria-label="Label this phone's screen" className="mt-0.5" />
            <span>
              <span className="block font-medium">Label this phone&rsquo;s screen</span>
              <span className="text-fg-muted">
                Replaces this phone&rsquo;s wallpaper with a black label. Enkaku will try to save the current one
                first, but on many Android versions it cannot read it back — if that fails, turning labelling off
                restores the system default wallpaper, not the original.
              </span>
            </span>
          </label>

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
