'use client'

import { useMemo, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import type { FarmSettings } from '@enkaku/protocol'
import { SchemaForm } from '@/components/schema-form/SchemaForm'
import { narrowSchema } from '@/components/schema-form/narrowSchema'
import type { JsonSchemaNode } from '@/components/schema-form/types'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { LoadingRows } from '@/components/states'
import { cn } from '@/lib/utils'
import { VideoQualityReadout } from './VideoQualityReadout'
import { VIDEO_ADVANCED_KEYS, VIDEO_PRESET_KEYS, deviceSourceLabel, profileRows, resolveControlProfile, resolveWallProfile, type DeviceVideoSettings } from './video-quality'

/**
 * The device page's Settings tab Video section (plan 92 §5 step 92.8,
 * acceptance criterion 3) — the SAME split-schema-plus-readout shape
 * `FarmVideoFields` uses, adapted for the device level's own two
 * differences from the farm level (both from `packages/protocol/src/
 * settings.ts`'s own doc comments): every field here is OPTIONAL (absent
 * means "use the farm's"), and `PATCH /api/devices/:id` replaces the whole
 * blob (F21), so "Reset to preset" genuinely CLEARS the six fields (sets
 * them to `undefined`, dropped by `JSON.stringify` on save) rather than
 * writing numbers into them the way the farm-level version has to (F22: a
 * farm field can never be truly empty, so there the SAME action instead
 * writes the selected preset's own numbers over the six fields).
 */
export function DeviceVideoFields({
  schema,
  draft,
  onChange,
  onSubmit,
  onReset,
  busy,
  dirty,
  farmVideo,
}: {
  schema: JsonSchemaNode
  draft: Record<string, unknown>
  onChange(next: unknown): void
  onSubmit(): void
  onReset(): void
  busy: boolean
  dirty: boolean
  /** `null` until the farm's own `/api/settings` fetch resolves — the readout needs it to name "the farm" as the source for an empty field. */
  farmVideo: FarmSettings['video'] | null
}) {
  const videoNode = schema.properties?.video
  // `draft` itself (not just `draft.video`) can genuinely be `undefined` for
  // one render on the device page: `settingsSections` is computed as soon
  // as the SCHEMA fetch (`/api/settings`) resolves, independently of the
  // DEVICE fetch (`/api/devices/:id`) that populates `draftSettings` —
  // the two race, and the generic `<SchemaForm value={draftSettings}>` path
  // already tolerates an undefined value structurally; this component needs
  // the same tolerance since it dereferences `draft.video` directly.
  const video = ((draft?.video as DeviceVideoSettings | undefined) ?? {}) as DeviceVideoSettings
  const hasOverride =
    video.controlMaxSize !== undefined ||
    video.controlMaxFps !== undefined ||
    video.controlBitRate !== undefined ||
    video.wallMaxSize !== undefined ||
    video.wallMaxFps !== undefined ||
    video.wallBitRate !== undefined
  const [advancedOpen, setAdvancedOpen] = useState(hasOverride)

  const presetSchema = useMemo<JsonSchemaNode | null>(
    () => (videoNode ? { ...schema, properties: { video: narrowSchema(videoNode, VIDEO_PRESET_KEYS) } } : null),
    [schema, videoNode],
  )
  const advancedSchema = useMemo<JsonSchemaNode | null>(
    () => (videoNode ? { ...schema, properties: { video: narrowSchema(videoNode, VIDEO_ADVANCED_KEYS) } } : null),
    [schema, videoNode],
  )

  if (!presetSchema || !advancedSchema) return <LoadingRows rows={4} />

  const clearOverride = () =>
    onChange({
      ...draft,
      video: {
        ...video,
        controlMaxSize: undefined,
        controlMaxFps: undefined,
        controlBitRate: undefined,
        wallMaxSize: undefined,
        wallMaxFps: undefined,
        wallBitRate: undefined,
      },
    })

  return (
    <div className="space-y-5">
      <p className="text-[12.5px] leading-relaxed text-fg-muted">
        Overrides the farm setting under Settings → Devices → Video, for this device only. Leave a field empty to follow
        the farm.
      </p>

      <SchemaForm schema={presetSchema} value={draft} onChange={onChange} />

      <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <CollapsibleTrigger className="flex items-center gap-1.5 text-[12.5px] font-medium text-fg-muted hover:text-fg">
          <ChevronRight className={cn('size-3.5 transition-transform', advancedOpen && 'rotate-90')} aria-hidden />
          Advanced
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-3 space-y-3">
          <SchemaForm schema={advancedSchema} value={draft} onChange={onChange} />
          <Button type="button" variant="ghost" size="sm" onClick={clearOverride} disabled={!hasOverride}>
            Reset to preset
          </Button>
        </CollapsibleContent>
      </Collapsible>

      {farmVideo ? (
        <VideoQualityReadout
          controlRows={profileRows(resolveControlProfile(farmVideo, video), deviceSourceLabel)}
          wallRows={profileRows(resolveWallProfile(farmVideo, video), deviceSourceLabel)}
        />
      ) : (
        <LoadingRows rows={2} />
      )}

      <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-2 border-t bg-bg py-3">
        <Button type="button" onClick={onSubmit} disabled={busy || !dirty}>
          {busy ? 'Saving…' : 'Save changes'}
        </Button>
        <Button type="button" variant="ghost" onClick={onReset} disabled={busy || !dirty}>
          Discard changes
        </Button>
        {!dirty && <span className="text-[12px] text-fg-subtle">No changes</span>}
      </div>
    </div>
  )
}
