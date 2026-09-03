'use client'

import { useMemo, useState, type ReactNode } from 'react'
import { CheckIcon, MagnifyingGlassIcon } from '../icons'
import type { DeviceStatus } from '@enkaku/protocol'
import { DeviceName } from './device-name'
import { Input } from './input'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip'
import { cn } from '../lib/utils'
import { matchesDeviceQuery } from '../lib/device-name'

/**
 * The shared device picker — moved here from `packages/studio` on 2026-08-26,
 * after a field report.
 *
 * Its own rule has always been "every place that chooses a device uses this
 * component, not a bare `Select`" (plan 19 §4.4), and the MikroTik routing
 * plugin was breaking it: its group editor offered a one-at-a-time
 * `<Combobox>` instead. Not out of carelessness — a plugin UI may only import
 * `@enkaku/ui`, and this component lived in `packages/studio`, so the rule was
 * literally impossible for a plugin to follow. Moving it is what makes the
 * rule true rather than aspirational.
 *
 * The three things that kept it in Studio are now INJECTED rather than
 * imported: the status badge, the holder badges and the unavailable-reason
 * text all reach in through render props. Studio passes its own (see
 * `studio/src/components/DevicePicker.tsx`, now a thin wrapper) and loses
 * nothing; a plugin passes none and gets the same search, the same tag chips,
 * the same cluster grouping and the same multi-select. One component, two
 * levels of richness — never two components drifting apart.
 */
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
function cannotTakeJob(status: DeviceStatus | undefined): boolean {
  return status === 'quarantined'
}

/**
 * What this picker actually needs from a device — a STRUCTURAL shape, not
 * `DeviceInfo` (plan 124 §4.1's "why the shapes are structural", the same
 * reasoning `SearchableDevice` in `../lib/device-name` already follows).
 *
 * `DeviceInfo` satisfies it, so Studio passes its devices unchanged. A
 * caller that genuinely has less — the MikroTik plugin's `FleetDeviceRow`
 * knows a device's id, name and number but nothing about its status, tags or
 * cluster — passes what it has and the picker simply does not draw what it
 * was not given.
 *
 * The alternative was to make such a caller synthesise `status: 'idle'`,
 * `tags: []`, `cluster: null` to satisfy `DeviceInfo`. That is not a type
 * workaround, it is a lie rendered on screen: every row would carry an
 * "idle" badge that nobody had checked. Optional fields say "unknown"
 * honestly; invented ones say something false confidently.
 */
interface PickableDevice {
  id: string
  /** `string`, not `string | null` — this is what `SearchableDevice` already requires, and `DeviceInfo` satisfies it. */
  label: string
  stableId: string
  number?: number | null
  /** Absent = unknown. A device whose status is unknown is never treated as unavailable. */
  status?: DeviceStatus
  /** Absent = none known; the tag chips row then does not render at all. */
  tags?: readonly string[]
  cluster?: { id: string; name: string } | null
}

/**
 * What a host may add to each row. Every one is optional: omitted, the row
 * renders exactly what a plugin needs and nothing it cannot supply.
 */
export interface DevicePickerSlots<D extends PickableDevice = PickableDevice> {
  /** A status badge beside the device name — Studio's `DeviceStatusBadge`. */
  renderStatus?: (device: D) => ReactNode
  /** Who holds or is assisting the device — Studio's `HolderBadge`, once per holder. */
  renderHolders?: (device: D) => ReactNode
  /**
   * Why a disabled row is disabled. Defaults to a plain sentence rather than
   * silence: a row that cannot be picked must always say why (plan 19 §4.4).
   */
  unavailableReason?: (device: D) => string
}

type DevicePickerProps<D extends PickableDevice = PickableDevice> = DevicePickerSlots<D> &
  (
    | {
        devices: readonly D[]
        value: string
        onChange: (id: string) => void
        multiple?: false
      }
    | {
        devices: readonly D[]
        value: string[]
        onChange: (ids: string[]) => void
        multiple: true
      }
  )

/**
 * The shared device picker (plan 19 §4.4): every place that chooses a device
 * uses this component, not a bare `Select`. Two identically labelled phones
 * are told apart by their `stableId`; devices that cannot take the job stay
 * visible, disabled, with the reason — never silently removed from the list.
 */
export function DevicePicker<D extends PickableDevice>(props: DevicePickerProps<D>) {
  const { devices } = props
  const [query, setQuery] = useState('')
  const [activeTag, setActiveTag] = useState<string | null>(null)

  const allTags = useMemo(() => {
    const set = new Set<string>()
    for (const d of devices) for (const t of d.tags ?? []) set.add(t)
    return [...set].sort()
  }, [devices])

  const filtered = useMemo(() => {
    return devices.filter((d) => {
      // The tag CHIP is a different control from the search box and stays
      // here: it is an exact, single-tag toggle driven by `toggleTag` below
      // (which also bulk-selects in `multiple` mode), not a text match, so
      // `matchesDeviceQuery`'s substring tag matching would be the wrong
      // predicate for it.
      if (activeTag && !(d.tags ?? []).includes(activeTag)) return false
      // Plan 124 §4.1, step 124.2 — the four-way match (number both bare and
      // `#`-prefixed, label, stableId, tag) used to be written out right
      // here, and this file was the ONLY place in the product that had it.
      // Every other device list grew its own near-miss or none at all, which
      // is the gap plan 124 exists to close: the predicate now lives in
      // `@enkaku/ui` so the Mikrotik assignments table, the Proxy Manager
      // table, the agent device-grant list and the cluster members dialog
      // all behave identically to this picker instead of approximating it.
      // Behaviour here is unchanged but for one strict widening documented
      // in `matchesDeviceQuery` itself: a tag now matches case-insensitively.
      return matchesDeviceQuery(d, query)
    })
  }, [devices, query, activeTag])

  // Grouped by cluster (plan 22.0 §4.5) — but only once a cluster is actually
  // in play; a farm with none yet keeps the plain flat list rather than a
  // single "Unclustered" header that says nothing. "Unclustered" sorts last,
  // same as the untagged bucket on the devices list.
  const hasAnyCluster = devices.some((d) => (d.cluster ?? null) !== null)
  const groups = useMemo(() => {
    if (!hasAnyCluster) return null
    const byCluster = new Map<string, { label: string; items: D[] }>()
    const unclustered: D[] = []
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
      const matches = devices.filter((d) => (d.tags ?? []).includes(next) && !cannotTakeJob(d.status)).map((d) => d.id)
      props.onChange([...new Set([...props.value, ...matches])])
    }
  }

  function toggleDevice(d: D) {
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
        <MagnifyingGlassIcon className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-subtle" aria-hidden />
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

  function renderDeviceRow(d: D) {
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
            {selected && <CheckIcon className="size-3" />}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {/* The number leads, composed beside the label — never baked
                into it (plan 89 §3.3). `null` only for a device whose
                reservation was explicitly released.
                Plan 124 §4.2, step 124.2 — this pair of spans was the
                REFERENCE the shared `<DeviceName>` was lifted from, so it
                now uses it rather than remaining a fourth private copy of
                the same markup. `gap-2` keeps this row's own slightly wider
                spacing (the component defaults to `gap-1.5`), and the
                number is no longer `aria-hidden`: §4.2 is explicit that the
                number IS the identity here — it is the only thing telling
                three rows a screen reader would otherwise announce as
                "SM-F721U1" apart. */}
            <DeviceName number={d.number} label={d.label} className="gap-2 text-[13px] font-medium" />
            {props.renderStatus?.(d)}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="readout text-[11px] text-fg-subtle">{d.stableId}</span>
            {(d.tags ?? []).map((t: string) => (
              <span key={t} className="text-[10.5px] text-fg-subtle">
                <TagLabel tag={t} />
              </span>
            ))}
            {/* A `manual`/`busy` device is still pickable — a job just waits
                for it to go quiet (plan 71 §3.7) — so who holds it now is
                worth showing here rather than only a status word. */}
            {props.renderHolders?.(d)}
            {/* An offline device is pickable (see `cannotTakeJob`), but the
                status word alone reads as "this will not run". Say what
                actually happens instead: the job is created now and sits in
                the queue until the phone reconnects. Without this line the
                operator has to already know `claimNext`'s predicate to trust
                the choice they are being offered. */}
            {d.status === 'offline' && (
              <span className="text-[10.5px] text-fg-subtle">Queues until this device reconnects</span>
            )}
          </div>
        </div>
      </button>
    )
    if (!unavailable) return <div key={d.id}>{row}</div>
    return (
      // Its OWN provider, not the host's (found while moving this component
      // out of `packages/studio`, 2026-08-26). Studio mounts a
      // `TooltipProvider` at the app shell, so this worked there by
      // accident of context; a plugin screen has no such guarantee, and
      // without one Radix throws "`Tooltip` must be used within
      // `TooltipProvider`" — crashing the whole editor the first time a
      // quarantined device appears in the list. Nesting providers is
      // supported and costs nothing, so the component carries its own
      // rather than making every caller remember.
      <TooltipProvider key={d.id}>
        <Tooltip>
          <TooltipTrigger asChild>{row}</TooltipTrigger>
          <TooltipContent>{props.unavailableReason?.(d) ?? 'This device is unavailable'}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
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
