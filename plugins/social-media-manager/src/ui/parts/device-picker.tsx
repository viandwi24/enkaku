import { useMemo, useState, type ReactElement } from 'react'
import {
  Button,
  Checkbox,
  ErrorState,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
  cn,
} from '@enkaku/ui'
import { deviceName, type Device } from '../shared'

/**
 * The ONE phone chooser this plugin has (0.39.0).
 *
 * The owner's verdict (2026-09-16), translated: *"why does SMM only offer a
 * label choice? It should be All devices, Only devices I choose, Labels and
 * Groups — the same four everywhere: in New session, in Accounts sync,
 * everywhere. Make it one device selector."*
 *
 * They were right about the symptom and about the cause. Three panels asked
 * the same question — New session, Cleanup, Accounts sync — and each had
 * written its own answer: compose offered label-driven, labels and phones;
 * Cleanup and Accounts offered label-driven and phones only. Nowhere could an
 * operator say "every phone" or "this group", and the two lists of modes
 * disagreed in wording as well as in content, so the same sentence meant
 * different things one tab apart.
 *
 * ## Four options, and what every one of them costs
 *
 * 0.39.0 kept a fifth — *Any phone carrying the platform's label* — as the
 * default, because it is the only shape that stores NO ids, and an empty
 * `deviceIds` is exactly what `add-group` reads as "any phone carrying that
 * platform's label" (`posts.ts` `planDispatch`: an empty list keeps the label
 * check, a non-empty one SKIPS it). The owner dropped it (2026-09-16): four
 * options, the four they asked for, and no fifth thing to explain.
 *
 * So every pick this control can make now resolves to an EXPLICIT list of
 * phones, and the platform's label decides nothing about what a new session
 * sends. That is a real widening, and the control states it under itself every
 * time rather than leaving an operator to meet it as a post that failed on a
 * phone nobody was signed in on.
 *
 * The default is **Phones with the labels I choose**, because ticking a
 * platform's own label (`tiktok`, `youtube`, `instagram`) reaches exactly the
 * phones the old default reached: the behaviour that went away is one tick
 * away rather than gone, and the consequence line under the control says so.
 *
 * Sessions created BEFORE this change still carry an empty `deviceIds` and
 * still route by label. Nothing here rewrites a stored row and the member is
 * untouched — this is a change to what the SCREEN offers, not to what the farm
 * already agreed to do.
 *
 * ## What it reports
 *
 * `resolvePick` turns a pick and the fleet into the phones it means — the
 * final list, in every mode. Callers pass those ids and count them; none of
 * them branches on the mode any more.
 */

/** The four ways to say which phones. Every one of them resolves to an explicit list. */
export type DeviceMode = 'all' | 'devices' | 'labels' | 'groups'

export interface DevicePick {
  mode: DeviceMode
  /** Ticked phone ids — `devices`. */
  deviceIds: ReadonlySet<string>
  /** Ticked label names as the farm spells them — `labels`. Compared normalised. */
  labelNames: ReadonlySet<string>
  /** Ticked group ids plus `NO_GROUP` for the phones in none — `groups`. */
  groupIds: ReadonlySet<string>
}

/**
 * The "No group" chip's own id.
 *
 * A phone with no group is still a phone somebody has to be able to reach, and
 * leaving it out of a group-shaped choice would hide part of the fleet behind
 * a control that looks complete. A farm group id is a farm-issued id, never
 * this literal.
 */
export const NO_GROUP = '__ungrouped__'

export function newPick(mode: DeviceMode = 'labels'): DevicePick {
  return { mode, deviceIds: new Set<string>(), labelNames: new Set<string>(), groupIds: new Set<string>() }
}

/** `deviceCarriesPlatform`'s own normalisation (`platforms.ts`): a label is typed by a human onto a chip. */
export function normaliseLabel(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '')
}

/** A phone matches when the query is its number (`7` or `#7`), or appears in its name, a label or its group. Empty matches all. */
export function deviceMatches(d: Device, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (q === '') return true
  const bare = q.startsWith('#') ? q.slice(1) : q
  if (d.number !== null && String(d.number) === bare) return true
  const haystack = [deviceName(d), d.label ?? '', d.group?.name ?? '', ...d.labels.map((l) => l.name)]
  return haystack.some((h) => h.toLowerCase().includes(q))
}

/** The phones a pick means, out of the fleet as it was read — the final list, in every mode. */
export function resolvePick(pick: DevicePick, fleet: readonly Device[]): Device[] {
  switch (pick.mode) {
    case 'all':
      return [...fleet]
    case 'devices':
      return fleet.filter((d) => pick.deviceIds.has(d.id))
    case 'labels': {
      const want = new Set([...pick.labelNames].map(normaliseLabel))
      return fleet.filter((d) => d.labels.some((l) => want.has(normaliseLabel(l.name))))
    }
    case 'groups':
      return fleet.filter((d) => (d.group === null ? pick.groupIds.has(NO_GROUP) : pick.groupIds.has(d.group.id)))
  }
}

/**
 * Why this pick cannot be used yet, in the operator's own terms — or `null`.
 *
 * A mode with nothing ticked resolves to NO phone. Since every mode is an
 * explicit list, that is not a harmless empty choice that falls back to
 * something sensible — it is a session, a cleaning or a sync that would be
 * created and could never reach anybody. The panels refuse it here rather than
 * letting it be discovered as a batch that sits and sends nothing.
 */
export function pickRefusal(pick: DevicePick): string | null {
  if (pick.mode === 'devices' && pick.deviceIds.size === 0) {
    return '“Only the phones I choose” is chosen and no phone is ticked — this would reach no phone at all.'
  }
  if (pick.mode === 'labels' && pick.labelNames.size === 0) {
    return '“Phones with the labels I choose” is chosen and no label is ticked — this would reach no phone at all.'
  }
  if (pick.mode === 'groups' && pick.groupIds.size === 0) {
    return '“Phones in the groups I choose” is chosen and no group is ticked — this would reach no phone at all.'
  }
  return null
}

/** What each mode does to the platform's own label, said once, under the control that does it. */
const CONSEQUENCE: Record<DeviceMode, string> = {
  all: 'Every phone in the farm, and the platform’s label is no longer checked: a phone not signed in to that platform fails its own job by name rather than being skipped.',
  devices: 'Exactly the phones ticked, and the platform’s label is no longer checked — a phone not signed in to it fails its own job by name.',
  labels:
    'Every phone carrying one of these labels. Tick a platform’s own label — “tiktok”, “youtube”, “instagram” — to reach exactly the phones that platform used to reach on its own; nothing checks the label a second time.',
  groups: 'Every phone in these groups, and the platform’s label is no longer checked on top of them.',
}

export function DevicePicker({
  fleet,
  loading,
  error,
  onRetry,
  value,
  onChange,
}: {
  fleet: readonly Device[]
  /** The fleet read is still out. With rows already on screen it is a refresh, not a blank. */
  loading: boolean
  error: string | null
  onRetry: () => void
  value: DevicePick
  onChange: (next: DevicePick) => void
}): ReactElement {
  /* The search box is about finding a row, not about the choice — the caller has no use for it. */
  const [query, setQuery] = useState('')
  const shown = useMemo(() => fleet.filter((d) => deviceMatches(d, query)), [fleet, query])

  /** Every label the fleet actually wears — chips built from the farm, never a typed-in list. */
  const fleetLabels = useMemo(() => {
    const seen = new Map<string, string>()
    for (const device of fleet) {
      for (const label of device.labels) {
        const key = normaliseLabel(label.name)
        if (!seen.has(key)) seen.set(key, label.name)
      }
    }
    return [...seen.values()].sort((a, b) => a.localeCompare(b))
  }, [fleet])

  /** Every group the fleet is in, and how many phones are in none. */
  const fleetGroups = useMemo(() => {
    const seen = new Map<string, { id: string; name: string; count: number }>()
    let ungrouped = 0
    for (const device of fleet) {
      if (device.group === null) {
        ungrouped++
        continue
      }
      const row = seen.get(device.group.id) ?? { id: device.group.id, name: device.group.name, count: 0 }
      row.count++
      seen.set(device.group.id, row)
    }
    return { groups: [...seen.values()].sort((a, b) => a.name.localeCompare(b.name)), ungrouped }
  }, [fleet])

  const toggle = (set: ReadonlySet<string>, key: string): Set<string> => {
    const copy = new Set(set)
    if (copy.has(key)) copy.delete(key)
    else copy.add(key)
    return copy
  }

  const emptyFleet = !loading && fleet.length === 0
  const reading = loading && fleet.length === 0

  return (
    <div className="space-y-1.5">
      <Select value={value.mode} onValueChange={(next) => onChange({ ...value, mode: next as DeviceMode })}>
        <SelectTrigger className="w-full @md:w-80">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All phones in the farm</SelectItem>
          <SelectItem value="devices">Only the phones I choose</SelectItem>
          <SelectItem value="labels">Phones with the labels I choose</SelectItem>
          <SelectItem value="groups">Phones in the groups I choose</SelectItem>
        </SelectContent>
      </Select>

      {/* While the fleet is still being read, say so — "no label" and "no group" are claims about a list that has not arrived. */}
      {error !== null && fleet.length === 0 ? (
        <ErrorState message={error} onRetry={onRetry} />
      ) : reading ? (
        <p className="flex items-center gap-2 text-[12px] text-dim">
          <Spinner className="size-3" /> Reading the farm’s phones…
        </p>
      ) : value.mode === 'devices' ? (
        emptyFleet ? (
          <p className="text-[11.5px] text-dim">The farm listed no phone at all.</p>
        ) : (
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <Input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by #, name, label or group…"
                aria-label="Search phones"
                className="h-7 max-w-xs grow text-[12px]"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={shown.length === 0}
                onClick={() => onChange({ ...value, deviceIds: new Set([...value.deviceIds, ...shown.map((d) => d.id)]) })}
              >
                Select {query.trim() === '' ? 'all' : 'shown'} ({shown.length})
              </Button>
              <Button type="button" variant="ghost" size="sm" disabled={value.deviceIds.size === 0} onClick={() => onChange({ ...value, deviceIds: new Set<string>() })}>
                Clear
              </Button>
              <span className="text-[11px] text-faint">{value.deviceIds.size} chosen</span>
            </div>
            {shown.length === 0 ? (
              <p className="text-[11.5px] text-dim">No phone matches “{query}”. Phones already chosen stay chosen.</p>
            ) : (
              <ul className="max-h-72 space-y-1 overflow-y-auto rounded-inner border border-border p-1">
                {shown.map((device) => (
                  <li key={device.id}>
                    <label className="flex cursor-pointer items-center gap-2 rounded-small px-2 py-1.5 text-[12px] hover:bg-hover">
                      <Checkbox
                        checked={value.deviceIds.has(device.id)}
                        onCheckedChange={(next) => {
                          const copy = new Set(value.deviceIds)
                          if (next === true) copy.add(device.id)
                          else copy.delete(device.id)
                          onChange({ ...value, deviceIds: copy })
                        }}
                      />
                      <span className="min-w-0 grow wrap-anywhere">{deviceName(device)}</span>
                      <span className={cn('flex-none text-[11px]', device.status === 'online' ? 'text-faint' : 'text-danger')}>{device.status}</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )
      ) : value.mode === 'labels' ? (
        fleetLabels.length === 0 ? (
          <p className="text-[11.5px] text-dim">No phone in this farm carries a label yet, so there is nothing to narrow by.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {fleetLabels.map((name) => {
              const on = value.labelNames.has(name)
              return (
                <Button key={name} type="button" size="sm" variant={on ? 'default' : 'outline'} aria-pressed={on} onClick={() => onChange({ ...value, labelNames: toggle(value.labelNames, name) })}>
                  {name}
                </Button>
              )
            })}
          </div>
        )
      ) : value.mode === 'groups' ? (
        fleetGroups.groups.length === 0 && fleetGroups.ungrouped === 0 ? (
          <p className="text-[11.5px] text-dim">The farm listed no phone at all.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {fleetGroups.groups.map((group) => {
              const on = value.groupIds.has(group.id)
              return (
                <Button
                  key={group.id}
                  type="button"
                  size="sm"
                  variant={on ? 'default' : 'outline'}
                  aria-pressed={on}
                  onClick={() => onChange({ ...value, groupIds: toggle(value.groupIds, group.id) })}
                >
                  {group.name} ({group.count})
                </Button>
              )
            })}
            {/* A phone in no group is reachable by name here, rather than silently outside every chip. */}
            {fleetGroups.ungrouped > 0 ? (
              <Button
                type="button"
                size="sm"
                variant={value.groupIds.has(NO_GROUP) ? 'default' : 'outline'}
                aria-pressed={value.groupIds.has(NO_GROUP)}
                onClick={() => onChange({ ...value, groupIds: toggle(value.groupIds, NO_GROUP) })}
              >
                No group ({fleetGroups.ungrouped})
              </Button>
            ) : null}
          </div>
        )
      ) : value.mode === 'all' && emptyFleet ? (
        <p className="text-[11.5px] text-dim">The farm listed no phone at all.</p>
      ) : null}

      {/*
        The widening, written down. Every mode but the default sends an explicit
        list of phones, and an explicit list is exactly what makes the service
        side stop checking the platform's label (`posts.ts` `planDispatch`).
        That is a thing an operator should read here, not infer from a post that
        failed on a phone nobody signed in.
      */}
      <p className={cn('text-[11.5px]', value.mode === 'all' ? 'text-warn' : 'text-dim')}>{CONSEQUENCE[value.mode]}</p>
    </div>
  )
}
