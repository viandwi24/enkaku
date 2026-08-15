'use client'

import { useMemo, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { toast } from 'sonner'
import { VideoReprofileResponseSchema } from '@enkaku/protocol'
import { SchemaForm } from '@/components/schema-form/SchemaForm'
import { narrowSchema } from '@/components/schema-form/narrowSchema'
import type { JsonSchemaNode } from '@/components/schema-form/types'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { ErrorState, LoadingRows } from '@/components/states'
import { api, useAction } from '@/lib/actions'
import { fetchDeviceRefs } from '@/lib/api'
import { cn } from '@/lib/utils'
import { VideoQualityReadout } from './VideoQualityReadout'
import { useAdbVideoStatsPoll } from './useAdbVideoStatsPoll'
import {
  CONTROL_PRESETS,
  VIDEO_ADVANCED_KEYS,
  VIDEO_PRESET_KEYS,
  WALL_PRESETS,
  buildReprofileToast,
  capitalize,
  computeAutoTiles,
  farmSourceLabel,
  formatMbps,
  profileRows,
  resolveControlProfile,
  resolveWallBandwidthBps,
  resolveWallProfile,
  type FarmVideoSettings,
  type WallTransport,
} from './video-quality'
import type { AdbStatsResponse } from './useAdbVideoStatsPoll'

/**
 * The farm Settings page's Video section (plan 92 §3.6, §3.7, §3.9, §5 step
 * 92.8) — plugged into `FarmForm`'s `render` prop
 * (`app/settings/page.tsx`), which keeps owning the load/save/dirty/
 * `beforeunload` mechanics every other section already shares. Everything
 * INSIDE this component is still `SchemaForm`-rendered (spec §19): the two
 * preset dropdowns and the six number fields are the exact same
 * `FarmSettings.video` schema node, split into two narrowed views (never a
 * hand-written `<input>`) so the six numbers can sit behind an "Advanced"
 * disclosure while the presets stay in view.
 */
export function FarmVideoFields({
  schema,
  draft,
  onChange,
  onSubmit,
  onReset,
  busy,
  dirty,
}: {
  schema: JsonSchemaNode
  draft: Record<string, unknown>
  onChange(next: unknown): void
  onSubmit(): void
  onReset(): void
  busy: boolean
  dirty: boolean
}) {
  const videoNode = schema.properties?.video
  const video = (draft.video ?? {}) as FarmVideoSettings
  const wall = draft.wall as { maxTiles?: number; decodeTileCeiling?: number; bandwidthBps?: number; transportOverride?: WallTransport | 'auto' } | undefined

  // Plan 100 §3.1, §4.1, step 100.3 — lifted here (rather than left inside
  // `MeasuredBlock` below) so the PROJECTION line can be transport-aware
  // too, not only the measured one. One poll, shared by both.
  const { stats, error: statsError } = useAdbVideoStatsPoll(2000)

  const controlProfile = useMemo(() => resolveControlProfile(video), [video])
  const wallProfile = useMemo(() => resolveWallProfile(video), [video])
  const anyCustomized =
    controlProfile.source.maxSize !== 'preset' ||
    controlProfile.source.maxFps !== 'preset' ||
    controlProfile.source.bitRate !== 'preset' ||
    wallProfile.source.maxSize !== 'preset' ||
    wallProfile.source.maxFps !== 'preset' ||
    wallProfile.source.bitRate !== 'preset'
  const [advancedOpen, setAdvancedOpen] = useState(anyCustomized)

  // Memoised on the STABLE `schema` prop only (never on `draft`, which
  // changes every keystroke) — `SchemaForm` itself already documents why a
  // schema recomputed per render defeats its own `planForm` memoisation
  // (`SchemaForm.tsx`'s own comment on that hook).
  const presetSchema = useMemo<JsonSchemaNode | null>(
    () => (videoNode ? { ...schema, properties: { video: narrowSchema(videoNode, VIDEO_PRESET_KEYS) } } : null),
    [schema, videoNode],
  )
  const advancedSchema = useMemo<JsonSchemaNode | null>(
    () => (videoNode ? { ...schema, properties: { video: narrowSchema(videoNode, VIDEO_ADVANCED_KEYS) } } : null),
    [schema, videoNode],
  )

  if (!presetSchema || !advancedSchema) return <LoadingRows rows={4} />

  const resetToPreset = () => {
    const c = CONTROL_PRESETS[video.controlPreset]
    const w = WALL_PRESETS[video.wallPreset]
    onChange({
      ...draft,
      video: {
        ...video,
        controlMaxSize: c.maxSize,
        controlMaxFps: c.maxFps,
        controlBitRate: c.bitRate,
        wallMaxSize: w.maxSize,
        wallMaxFps: w.maxFps,
        wallBitRate: w.bitRate,
      },
    })
  }

  // §3.7's projection: a PINNED `wall.maxTiles` (non-zero) wins over the
  // auto-derived count, because that is what these settings would actually
  // produce — the same "a non-zero setting always wins" rule `0 = auto`
  // follows everywhere else in this codebase (F24).
  //
  // Plan 100 §3.1/§4.1, step 100.3: the auto-derived count is now the min of
  // a decode bound (this farm's own `wall.decodeTileCeiling`) and a
  // TRANSPORT-AWARE bandwidth bound. `ENKAKU_MODE` cannot be read from the
  // browser, so the mode-derived half of the classification is trusted from
  // the live poll (`stats.video.transport`) — that half never changes without
  // a core restart, so it is a safe proxy even for this "what would the
  // DRAFT produce" projection. An explicit unsaved `wall.transportOverride`
  // still wins outright, exactly like the server's own `resolveWallTransport`.
  const draftTransportOverride = wall?.transportOverride ?? 'auto'
  const transport: WallTransport = draftTransportOverride !== 'auto' ? draftTransportOverride : (stats?.video?.transport ?? 'loopback')
  const decodeCeiling = wall?.decodeTileCeiling ?? 24
  const resolvedBandwidthBps = resolveWallBandwidthBps(transport, wall?.bandwidthBps ?? 200_000_000)
  const pinnedTiles = wall?.maxTiles ?? 0
  const tiles = pinnedTiles > 0
    ? pinnedTiles
    : computeAutoTiles(video.wallBitRate, { decodeTileCeiling: decodeCeiling, bandwidthBps: resolvedBandwidthBps })
  const projectionBps = tiles * video.wallBitRate
  // Which bound actually decided the number above — computed the same way
  // `computeAutoTiles` itself does (`Math.min`), so this can never disagree
  // with `tiles`.
  const boundLabel = decodeCeiling <= Math.floor(resolvedBandwidthBps / video.wallBitRate) ? 'decode-bound' : 'bandwidth-bound'
  const transportLabel = `${boundLabel}, ${transport}`

  return (
    <div className="space-y-5">
      <SchemaForm schema={presetSchema} value={draft} onChange={onChange} />

      <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <CollapsibleTrigger className="flex items-center gap-1.5 text-[12.5px] font-medium text-fg-muted hover:text-fg">
          <ChevronRight className={cn('size-3.5 transition-transform', advancedOpen && 'rotate-90')} aria-hidden />
          Advanced
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-3 space-y-3">
          <SchemaForm schema={advancedSchema} value={draft} onChange={onChange} />
          <Button type="button" variant="ghost" size="sm" onClick={resetToPreset}>
            Reset to preset
          </Button>
        </CollapsibleContent>
      </Collapsible>

      <VideoQualityReadout
        controlRows={profileRows(controlProfile, (s) => farmSourceLabel(s, capitalize(video.controlPreset)))}
        wallRows={profileRows(wallProfile, (s) => farmSourceLabel(s, capitalize(video.wallPreset)))}
      />

      <p className="text-[12.5px] text-fg-muted">
        <span className="readout font-medium text-fg">
          {tiles} live tile{tiles === 1 ? '' : 's'}
        </span>{' '}
        at these settings ≈ <span className="readout font-medium text-fg">{formatMbps(projectionBps)}</span> into one browser tab
        {pinnedTiles > 0 ? ' (pinned by Max live wall tiles)' : ` (auto — ${transportLabel})`}.
      </p>

      <MeasuredBlock stats={stats} error={statsError} />
      <ApplyToLiveSessions />

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

/**
 * §3.9's measured block — what the farm is ACTUALLY spending right now
 * (from `/api/adb/stats`, polled every 2s while this section is open),
 * beside the projection above (what the current unsaved draft WOULD cost).
 * Two different numbers on purpose: one reads the saved state, the other
 * the draft — watching the measured figure converge on the projection
 * after Save (or after Apply to live sessions) is the feedback loop §1
 * promises.
 */
function MeasuredBlock({ stats, error }: { stats: AdbStatsResponse | null; error: string | null }) {
  return (
    <div className="rounded-lg border bg-surface p-3 text-[12.5px]">
      <h4 className="rack-label mb-2">measured — this farm, right now</h4>
      {error ? (
        <ErrorState message={error} />
      ) : !stats ? (
        <LoadingRows rows={1} />
      ) : (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-fg-muted">
          <span>
            <span className="readout font-medium text-fg">{stats.video?.controlStreams ?? 0}</span> control ·{' '}
            <span className="readout font-medium text-fg">{stats.video?.wallStreams ?? 0}</span> wall
          </span>
          <span>
            <span className="readout font-medium text-fg">{formatMbps(stats.transport.videoBytesPerSec * 8)}</span>
          </span>
          <span>
            Live-tile budget: <span className="readout font-medium text-fg">{stats.video?.maxTiles ?? 0}</span>
            {stats.video?.maxTilesAuto ? ` (auto — ${stats.video.transport})` : ' (pinned)'}
          </span>
          {(stats.video?.buildQueueDepth ?? 0) > 0 && (
            <span>
              <span className="readout font-medium text-fg">{stats.video?.buildQueueDepth}</span> session{(stats.video?.buildQueueDepth ?? 0) === 1 ? '' : 's'} queued to start
            </span>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * §3.8's manual "apply now" — the debounced automatic path already covers a
 * saved change within ~500ms; this button is for an operator who wants it
 * to happen right now, and for the summary toast that names what happened
 * (§3.8, and this step's own second warning: never say "applied" without
 * saying "except these").
 */
function ApplyToLiveSessions() {
  const { run, isPending } = useAction()

  const apply = () =>
    run('apply', () => api('/api/video/reprofile', VideoReprofileResponseSchema, { method: 'POST' }), {
      failure: 'Could not apply the new video settings',
      onSuccess: async (r) => {
        const labels =
          r.skippedBusy.length > 0
            ? Object.fromEntries(Object.entries(await fetchDeviceRefs(r.skippedBusy)).map(([id, ref]) => [id, ref.label ?? ref.stableId]))
            : {}
        const { message, description } = buildReprofileToast(r, labels)
        toast.success(message, description ? { description } : undefined)
      },
    })

  return (
    <div>
      <Button type="button" variant="outline" size="sm" disabled={isPending('apply')} onClick={() => void apply()}>
        {isPending('apply') ? 'Applying…' : 'Apply to live sessions'}
      </Button>
      <p className="mt-1.5 text-[11.5px] text-fg-subtle">
        Saving already applies a changed number within about half a second — this restarts every live session whose
        picture actually moved right now, without waiting. A device running a job keeps its picture until the job ends.
      </p>
    </div>
  )
}
