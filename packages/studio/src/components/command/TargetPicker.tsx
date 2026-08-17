'use client'

import { useState } from 'react'
import type { ClusterInfo, CommandTarget, DeviceInfo } from '@enkaku/protocol'
import { DevicePicker } from '@/components/DevicePicker'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, cn } from '@enkaku/ui'
import { computeTargetPreview } from './target-preview'

/**
 * Plan 93 §3.14 guard 1, §3.16, step 93.7 — "a target preview, always...
 * names every device that will and will not receive the command."
 *
 * Three target shapes, matching `CommandTargetSchema` (`@enkaku/protocol`)
 * exactly: explicit devices, a saved cluster, or an ad-hoc tag set (AND
 * semantics — see `target-preview.ts`). Whichever mode is active, the
 * preview below it is always visible and always names names, never only a
 * count (plan 93 §0 finding H3: "no count without names").
 */

type Mode = 'devices' | 'cluster' | 'tags'

function modeOf(target: CommandTarget | null): Mode {
  if (target && 'clusterId' in target) return 'cluster'
  if (target && 'tags' in target) return 'tags'
  return 'devices'
}

const MODE_LABEL: Record<Mode, string> = { devices: 'Devices', cluster: 'Cluster', tags: 'Tags' }

export function TargetPicker({
  devices,
  clusters,
  target,
  onChange,
  mySessionId,
}: {
  devices: DeviceInfo[]
  clusters: ClusterInfo[]
  target: CommandTarget | null
  onChange: (target: CommandTarget | null) => void
  mySessionId: string | null
}) {
  const [mode, setMode] = useState<Mode>(modeOf(target))
  const preview = computeTargetPreview(devices, target, mySessionId)
  const allTags = [...new Set(devices.flatMap((d) => d.tags))].sort()

  return (
    <div className="space-y-3">
      <div className="flex gap-1.5" role="tablist" aria-label="Target type">
        {(['devices', 'cluster', 'tags'] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            onClick={() => {
              setMode(m)
              onChange(null)
            }}
            className={cn(
              'rounded-md border px-2.5 py-1 text-[12px] font-medium transition-colors',
              mode === m ? 'border-accent bg-accent/10 text-accent-strong' : 'border-line text-fg-muted hover:border-line-strong',
            )}
          >
            {MODE_LABEL[m]}
          </button>
        ))}
      </div>

      {mode === 'devices' && (
        <DevicePicker
          devices={devices}
          multiple
          value={target && 'deviceIds' in target ? target.deviceIds : []}
          onChange={(ids) => onChange(ids.length > 0 ? { deviceIds: ids } : null)}
        />
      )}

      {mode === 'cluster' &&
        (clusters.length === 0 ? (
          <p className="text-[12px] text-fg-muted">No clusters exist yet.</p>
        ) : (
          <Select
            value={target && 'clusterId' in target ? target.clusterId : undefined}
            onValueChange={(id) => onChange({ clusterId: id })}
          >
            <SelectTrigger className="h-8 w-full text-[12.5px]" aria-label="Choose a cluster">
              <SelectValue placeholder="Choose a cluster…" />
            </SelectTrigger>
            <SelectContent>
              {clusters.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name} <span className="text-fg-subtle">· {c.usableCount}/{c.deviceCount}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ))}

      {mode === 'tags' &&
        (allTags.length === 0 ? (
          <p className="text-[12px] text-fg-muted">No tags exist yet.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {allTags.map((tag) => {
              const current = target && 'tags' in target ? target.tags : []
              const active = current.includes(tag)
              return (
                <button
                  key={tag}
                  type="button"
                  aria-pressed={active}
                  onClick={() => {
                    const next = active ? current.filter((t) => t !== tag) : [...current, tag]
                    onChange(next.length > 0 ? { tags: next } : null)
                  }}
                  className={cn(
                    'rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none transition-colors',
                    active ? 'border-accent bg-accent/15 text-accent-strong' : 'border-line text-fg-muted hover:border-line-strong',
                  )}
                >
                  {tag}
                </button>
              )
            })}
          </div>
        ))}

      {target && <TargetPreviewSummary preview={preview} />}
    </div>
  )
}

function TargetPreviewSummary({ preview }: { preview: ReturnType<typeof computeTargetPreview> }) {
  if (preview.matched.length === 0) {
    return <p className="text-[12px] text-fg-muted">No device matches this target yet.</p>
  }
  return (
    <div className="space-y-1.5 rounded-lg border bg-surface p-2.5 text-[12px]" data-testid="target-preview">
      <p className="font-medium">
        {preview.willAttempt.length} device{preview.willAttempt.length === 1 ? '' : 's'} will be targeted
        {preview.excluded.length > 0 && (
          <span className="text-fg-muted">
            {' '}
            · {preview.excluded.length} excluded
          </span>
        )}
      </p>
      {preview.caution.length > 0 && (
        <p className="text-led-warn">
          {preview.caution.length} may be skipped — {preview.caution.map((c) => c.device.label).join(', ')}
        </p>
      )}
      {preview.excluded.length > 0 && (
        <ul className="space-y-0.5 text-fg-subtle">
          {preview.excluded.map((e) => (
            <li key={e.device.id}>
              {e.device.label} — {e.reason}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
