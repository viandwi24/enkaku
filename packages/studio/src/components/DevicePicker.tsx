'use client'

import { useMemo, useState } from 'react'
import { Check, Search } from 'lucide-react'
import type { DeviceInfo, DeviceStatus } from '@enkaku/protocol'
import { DeviceStatusBadge } from '@/components/StatusBadge'
import { HolderBadge } from '@/components/HolderBadge'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { UNAVAILABLE_REASON } from '@/components/device-popup/ControlState'

/**
 * Why a device cannot take control or a job right now (plan 19 §4.4) — the
 * text itself now lives in `./device-popup/ControlState.tsx` (plan 105 §5
 * step 105.1's own `free` state reads it too, for the identical reason: one
 * place, not three drifting apart the way each screen's own copy used to).
 * Re-exported here because `DeviceHeader.tsx`/`app/device/page.tsx` already
 * import it from this module, and moving THEIR import instead of leaving one
 * re-export would touch two more files for no behavioural change.
 */
export { UNAVAILABLE_REASON }

/**
 * Only `quarantined` truly cannot accept a new job.
 *
 * `busy` and `manual` already queued one — and so does `offline`, which used
 * to be listed here and should not have been. The core is the authority and
 * it disagrees with the old reading in two places: `createJobStore.enqueue`
 * (`packages/core/src/queue/job-store.ts`) rejects ONLY `quarantined`, and
 * `claimNext`'s SQL predicate holds a job until `d.status = 'idle'`, which an
 * offline device reaches by itself the moment it reconnects. Nothing expires
 * the job while it waits: no default `expiresAt` is set on the enqueue path.
 *
 * So a job aimed at an offline phone was never "certain to be rejected" — it
 * was a job the server would have queued and run, that this picker refused to
 * let anyone create. Note this is about taking a JOB; taking CONTROL of an
 * offline device is genuinely impossible, which is why `UNAVAILABLE_REASON`
 * above still carries an `offline` entry for the device page and header.
 */
function cannotTakeJob(status: DeviceStatus): boolean {
  return status === 'quarantined'
}

type DevicePickerProps =
  | {
      devices: DeviceInfo[]
      value: string
      onChange: (id: string) => void
      multiple?: false
    }
  | {
      devices: DeviceInfo[]
      value: string[]
      onChange: (ids: string[]) => void
      multiple: true
    }

/**
 * The shared device picker (plan 19 §4.4): every place that chooses a device
 * uses this component, not a bare `Select`. Two identically labelled phones
 * are told apart by their `stableId`; devices that cannot take the job stay
 * visible, disabled, with the reason — never silently removed from the list.
 */
export function DevicePicker(props: DevicePickerProps) {
  const { devices } = props
  const [query, setQuery] = useState('')
  const [activeTag, setActiveTag] = useState<string | null>(null)

  const allTags = useMemo(() => {
    const set = new Set<string>()
    for (const d of devices) for (const t of d.tags) set.add(t)
    return [...set].sort()
  }, [devices])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return devices.filter((d) => {
      if (activeTag && !d.tags.includes(activeTag)) return false
      if (!q) return true
      // A bare digit or a `#`-prefixed one both match the number (plan 89
      // §3.3: "typing `7` matches `#7`") — an operator standing in front of
      // a phone reads the number off it, not off the label. `?? null`
      // guards a hand-built test fixture that omits the field (undefined).
      const number = d.number ?? null
      const numberMatch = number !== null && (String(number) === q.replace(/^#/, '') || `#${number}` === q)
      return (
        numberMatch ||
        d.label.toLowerCase().includes(q) ||
        d.stableId.toLowerCase().includes(q) ||
        d.tags.some((t) => t.includes(q))
      )
    })
  }, [devices, query, activeTag])

  // Grouped by cluster (plan 22.0 §4.5) — but only once a cluster is actually
  // in play; a farm with none yet keeps the plain flat list rather than a
  // single "Unclustered" header that says nothing. "Unclustered" sorts last,
  // same as the untagged bucket on the devices list.
  const hasAnyCluster = devices.some((d) => d.cluster !== null)
  const groups = useMemo(() => {
    if (!hasAnyCluster) return null
    const byCluster = new Map<string, { label: string; items: DeviceInfo[] }>()
    const unclustered: DeviceInfo[] = []
    for (const d of filtered) {
      if (!d.cluster) {
        unclustered.push(d)
        continue
      }
      const g = byCluster.get(d.cluster.id)
      if (g) g.items.push(d)
      else byCluster.set(d.cluster.id, { label: d.cluster.name, items: [d] })
    }
    const sorted = [...byCluster.values()].sort((a, b) => a.label.localeCompare(b.label))
    if (unclustered.length > 0) sorted.push({ label: 'Unclustered', items: unclustered })
    return sorted
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, hasAnyCluster])

  const selectedIds = props.multiple ? props.value : props.value ? [props.value] : []

  function toggleTag(tag: string) {
    const next = activeTag === tag ? null : tag
    setActiveTag(next)
    // Clicking a chip filters the list; in multiple mode it also selects
    // every device the filter reveals, in one motion (plan 19 §4.4).
    if (props.multiple && next) {
      const matches = devices.filter((d) => d.tags.includes(next) && !cannotTakeJob(d.status)).map((d) => d.id)
      props.onChange([...new Set([...props.value, ...matches])])
    }
  }

  function toggleDevice(d: DeviceInfo) {
    if (cannotTakeJob(d.status)) return
    if (props.multiple) {
      const has = props.value.includes(d.id)
      props.onChange(has ? props.value.filter((id) => id !== d.id) : [...props.value, d.id])
    } else {
      props.onChange(d.id)
    }
  }

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-subtle" aria-hidden />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search number, label, stable id, or tag…"
          aria-label="Search devices"
          className="h-8 pl-8 text-[12.5px]"
        />
      </div>

      {allTags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {allTags.map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() => toggleTag(tag)}
              aria-pressed={activeTag === tag}
              className={cn(
                'rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none transition-colors',
                activeTag === tag
                  ? 'border-accent bg-accent/15 text-accent-strong'
                  : 'border-line text-fg-muted hover:border-line-strong',
              )}
            >
              <TagLabel tag={tag} />
            </button>
          ))}
        </div>
      )}

      <div role="listbox" aria-multiselectable={props.multiple} className="max-h-72 space-y-1 overflow-y-auto rounded-lg border p-1">
        {filtered.length === 0 ? (
          <p className="px-2 py-3 text-center text-[12px] text-fg-muted">No device matches.</p>
        ) : groups ? (
          groups.map((g) => (
            <div key={g.label}>
              <p className="rack-label px-2 pb-1 pt-1.5 first:pt-0.5">
                {g.label} <span className="text-fg-subtle">· {g.items.length}</span>
              </p>
              {g.items.map((d) => renderDeviceRow(d))}
            </div>
          ))
        ) : (
          filtered.map((d) => renderDeviceRow(d))
        )}
      </div>
    </div>
  )

  function renderDeviceRow(d: DeviceInfo) {
    const unavailable = cannotTakeJob(d.status)
    const selected = selectedIds.includes(d.id)
    const row = (
      <button
        type="button"
        role="option"
        aria-selected={selected}
        disabled={unavailable}
        onClick={() => toggleDevice(d)}
        className={cn(
          'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors',
          unavailable ? 'cursor-not-allowed opacity-50' : selected ? 'bg-accent/10' : 'hover:bg-surface-2',
        )}
      >
        {props.multiple && (
          <span
            aria-hidden
            className={cn(
              'flex size-4 shrink-0 items-center justify-center rounded border',
              selected ? 'border-accent bg-accent text-accent-fg' : 'border-line',
            )}
          >
            {selected && <Check className="size-3" />}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {/* The number leads, composed beside the label — never baked
                into it (plan 89 §3.3). `null` only for a device whose
                reservation was explicitly released. */}
            {d.number !== null && d.number !== undefined && (
              <span className="readout shrink-0 text-[11px] text-fg-subtle" aria-hidden="true">
                #{d.number}
              </span>
            )}
            <span className="truncate text-[13px] font-medium">{d.label}</span>
            <DeviceStatusBadge status={d.status} />
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="readout text-[11px] text-fg-subtle">{d.stableId}</span>
            {d.tags.map((t) => (
              <span key={t} className="text-[10.5px] text-fg-subtle">
                <TagLabel tag={t} />
              </span>
            ))}
            {/* A `manual`/`busy` device is still pickable — a job just waits
                for it to go quiet (plan 71 §3.7) — so who holds it now is
                worth showing here rather than only a status word. */}
            {d.heldBy && <HolderBadge holder={d.heldBy} />}
            {/* An offline device is pickable (see `cannotTakeJob`), but the
                status word alone reads as "this will not run". Say what
                actually happens instead: the job is created now and sits in
                the queue until the phone reconnects. Without this line the
                operator has to already know `claimNext`'s predicate to trust
                the choice they are being offered. */}
            {d.status === 'offline' && (
              <span className="text-[10.5px] text-fg-subtle">Queues until this device reconnects</span>
            )}
            {/* Who is ASSISTING this device (plan 91 §3.4 item 4, §4.4, F25)
                — a narrow, subordinate grant beside `heldBy` above, never a
                takeover. `?? []` covers a caller that predates the field,
                the same guard `DeviceCard`/`WallTile` use. Plan 105 §3.2/§4
                — the "assisting" vs "may assist" split lives in
                `HolderBadge` (`deriveAssistActivity`), shared with every
                other caller of this component; the picker has no reason to
                call the full `useControlState` hook, for the same reason
                `DeviceCard`'s own note gives. */}
            {(d.assistedBy ?? []).map((a) => (
              <HolderBadge key={a.id} holder={a} variant="assists" />
            ))}
          </div>
        </div>
      </button>
    )
    if (!unavailable) return <div key={d.id}>{row}</div>
    return (
      <Tooltip key={d.id}>
        <TooltipTrigger asChild>{row}</TooltipTrigger>
        <TooltipContent>{UNAVAILABLE_REASON[d.status] ?? 'This device is unavailable'}</TooltipContent>
      </Tooltip>
    )
  }
}

/** Renders `pool:smoke` with the part up to and including the first colon dimmed (plan 19 §3.1). */
function TagLabel({ tag }: { tag: string }) {
  const i = tag.indexOf(':')
  if (i === -1) return <>{tag}</>
  return (
    <>
      <span className="text-fg-subtle">{tag.slice(0, i + 1)}</span>
      {tag.slice(i + 1)}
    </>
  )
}
