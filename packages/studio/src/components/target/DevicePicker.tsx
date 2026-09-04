'use client'

import { useMemo, useState } from 'react'
import type { DeviceInfo } from '@enkaku/protocol'
import {
  Badge,
  CaretDownIcon,
  CheckIcon,
  DeviceName,
  Input,
  MagnifyingGlassIcon,
  StatusDot,
  Tabs,
  TabsList,
  TabsTrigger,
  XIcon,
  cn,
  matchesDeviceQuery,
} from '@enkaku/ui'
import { dotStateOf } from '@/components/devices/device-state'
import type { TargetState } from './useTarget'

/**
 * The device picker (MVP 07 §2.1). One component, one hook, one place.
 *
 * The visual contract, quoted from `docs/mvp/07-actions-api.md` §2.1 because
 * every class below exists to satisfy one of its clauses:
 *
 *   "The picker is its OWN container, visually distinct from the form: its
 *    own surface colour and border, full width, flush under the modal title,
 *    with nothing between the title and the picker. No helper text, no
 *    description, no section heading above it."
 *   "The form for the verb starts BELOW a clear divider in a separate
 *    container. The two never share a background or a border."
 *   "The picker's collapsed state is a single line ('3 devices', 'Group A ·
 *    12 devices'); expanding it grows the picker container, never the form."
 *   "The same container, at the same position, with the same height when
 *    collapsed, in every action modal and popup."
 *
 * So: `bg-panel-2` (the form is `bg-panel`), `border-b border-line` and no
 * other border, `w-full`, `px-[14px] py-[10px]`, and a collapsed row that is
 * exactly `h-[34px]` tall, giving every dialog the identical 54px collapsed
 * band. This component renders NO label and NO helper text of its own: the
 * contract forbids anything above it, and a heading inside it would be the
 * same defect one level down.
 *
 * It never opens a dialog. Editing the target happens in place, and the
 * verb's fields below keep their values while it happens (that is why the
 * state lives in `useTarget`, held by `ActionDialog`, not here).
 */
export function DevicePicker({
  state,
  className,
  forceExpanded,
}: {
  state: TargetState
  className?: string
  /** `DevicePickerDialog` (`components/host`, §4.10): the whole dialog IS the picker, so it never collapses. */
  forceExpanded?: boolean
}) {
  const [expandedState, setExpanded] = useState(false)
  const expanded = forceExpanded || expandedState
  const [query, setQuery] = useState('')

  return (
    <div data-slot="device-picker" className={cn('w-full border-b border-line bg-panel-2 px-[14px] py-[10px]', className)}>
      <button
        type="button"
        onClick={() => !forceExpanded && setExpanded((v) => !v)}
        aria-expanded={expanded}
        disabled={forceExpanded}
        className="flex h-[34px] w-full items-center gap-2 rounded-button text-left text-body text-text disabled:cursor-default"
      >
        <span className="min-w-0 flex-1 truncate">{state.summary}</span>
        {state.warnedIds.length > 0 && <Badge variant="warn">{state.warnedIds.length} warned</Badge>}
        {state.forbiddenIds.length > 0 && <Badge variant="destructive">{state.forbiddenIds.length} blocked</Badge>}
        {!forceExpanded && <CaretDownIcon className={cn('size-3.5 shrink-0 text-faint transition-transform', expanded && 'rotate-180')} aria-hidden />}
      </button>

      {expanded && (
        <div className="mt-2 space-y-2">
          <Tabs value={state.mode} onValueChange={(v) => state.setMode(v as TargetState['mode'])}>
            <TabsList variant="compact">
              <TabsTrigger value="devices">Devices</TabsTrigger>
              <TabsTrigger value="group">Group</TabsTrigger>
              <TabsTrigger value="tags">Tags</TabsTrigger>
            </TabsList>
          </Tabs>

          {state.mode === 'devices' && <DeviceMode state={state} query={query} setQuery={setQuery} />}
          {state.mode === 'group' && <GroupMode state={state} />}
          {state.mode === 'tags' && <TagMode state={state} />}
        </div>
      )}

      {/* The chips are OUTSIDE the expanded block on purpose: a warned or
          forbidden sentence must stay readable after the request came back
          and the operator collapsed the picker again (MVP 07 §2.1, "After
          the first request, `warned` and `forbidden` sentences render inline
          on the same chips"). */}
      {(expanded || state.warnedIds.length > 0 || state.forbiddenIds.length > 0) && state.chips.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {state.chips.map((chip) => (
            <Chip key={chip.device.id} chip={chip} state={state} />
          ))}
        </div>
      )}
    </div>
  )
}

function Chip({ chip, state }: { chip: TargetState['chips'][number]; state: TargetState }) {
  const { device, result } = chip
  const tone =
    result?.status === 'forbidden'
      ? 'border-danger/40 bg-danger-soft'
      : result?.status === 'warned'
        ? 'border-warn/40 bg-warn-soft'
        : 'border-border-2 bg-panel'
  return (
    <span className={cn('inline-flex max-w-full flex-col gap-0.5 rounded-chip border px-2 py-1', tone)}>
      <span className="flex items-center gap-1.5">
        <StatusDot state={dotStateOf(device)} title={activitySentence(device)} />
        <DeviceName number={device.number} label={device.label} className="text-meta" />
        {device.activities.length > 0 && <span className="truncate text-tip text-faint">{device.activities[0]?.label}</span>}
        {state.mode === 'devices' && !state.locked && (
          <button type="button" onClick={() => state.toggleDevice(device.id)} aria-label={`Remove ${device.label}`} className="text-faint hover:text-text">
            <XIcon className="size-3" aria-hidden />
          </button>
        )}
      </span>
      {result?.message && (
        <span className={cn('text-tip', result.status === 'forbidden' ? 'text-danger' : 'text-warn')}>{result.message}</span>
      )}
    </span>
  )
}

/** The list of every device, with the search box the handoff gives the toolbar (`Input variant="search"`). */
function DeviceMode({ state, query, setQuery }: { state: TargetState; query: string; setQuery: (q: string) => void }) {
  const filtered = useMemo(() => state.devices.filter((d) => matchesDeviceQuery(d, query)), [state.devices, query])
  return (
    <>
      <div className="relative">
        <MagnifyingGlassIcon className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-faint" aria-hidden />
        <Input
          variant="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search number, label, stable id, or tag"
          aria-label="Search devices"
          className="pl-8"
        />
      </div>
      <div role="listbox" aria-multiselectable={!state.locked} className="max-h-[240px] space-y-0.5 overflow-y-auto">
        {filtered.length === 0 ? (
          <p className="px-2 py-3 text-center text-meta text-faint">No device matches.</p>
        ) : (
          filtered.map((d) => {
            const selected = state.deviceIds.includes(d.id)
            return (
              <button
                key={d.id}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => state.toggleDevice(d.id)}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-button px-[10px] py-[9px] text-row transition-colors',
                  selected ? 'bg-accent-soft text-accent' : 'text-text hover:bg-muted',
                )}
              >
                <span
                  className={cn(
                    'flex size-4 shrink-0 items-center justify-center rounded-check border-[1.5px]',
                    selected ? 'border-accent bg-accent text-on-accent' : 'border-border-3',
                  )}
                  aria-hidden
                >
                  {selected && <CheckIcon weight="bold" className="size-3" />}
                </span>
                <StatusDot state={dotStateOf(d)} />
                <DeviceName number={d.number} label={d.label} className="min-w-0 flex-1" />
                {d.activities.length > 0 && <span className="truncate text-meta text-faint">{d.activities[0]?.label}</span>}
              </button>
            )
          })
        )}
      </div>
    </>
  )
}

/** One row per group, single choice, with its resolved usable count (§3.11). */
function GroupMode({ state }: { state: TargetState }) {
  return (
    <div role="listbox" aria-multiselectable={false} className="max-h-[240px] space-y-0.5 overflow-y-auto">
      <button
        type="button"
        role="option"
        aria-selected={state.groupId === null}
        onClick={() => state.setGroupId(null)}
        className={cn(
          'flex w-full items-center gap-2.5 rounded-button px-[10px] py-[9px] text-row transition-colors',
          state.groupId === null ? 'bg-accent-soft text-accent' : 'text-text hover:bg-muted',
        )}
      >
        <span className="min-w-0 flex-1 truncate">No group</span>
      </button>
      {state.groups.length === 0 ? (
        <p className="px-2 py-3 text-center text-meta text-faint">No group exists yet.</p>
      ) : (
        state.groups.map((g) => {
          const selected = state.groupId === g.id
          return (
            <button
              key={g.id}
              type="button"
              role="option"
              aria-selected={selected}
              onClick={() => state.setGroupId(g.id)}
              className={cn(
                'flex w-full items-center gap-2.5 rounded-button px-[10px] py-[9px] text-row transition-colors',
                selected ? 'bg-accent-soft text-accent' : 'text-text hover:bg-muted',
              )}
            >
              <span className="min-w-0 flex-1 truncate">{g.name}</span>
              <span className="shrink-0 text-meta text-faint">{g.usableCount} now</span>
            </button>
          )
        })
      )}
    </div>
  )
}

/** Every tag on the farm as a toggle chip; AND semantics, stated in the copy (§3.11). */
function TagMode({ state }: { state: TargetState }) {
  const allTags = useMemo(() => {
    const set = new Set<string>()
    for (const d of state.devices) for (const t of d.tags) set.add(t)
    return [...set].sort()
  }, [state.devices])

  return (
    <div className="space-y-1.5">
      <p className="text-tip text-faint">A device must carry every tag chosen below.</p>
      <div className="flex flex-wrap gap-1.5">
        {allTags.length === 0 ? (
          <p className="px-2 py-3 text-center text-meta text-faint">No tag exists yet.</p>
        ) : (
          allTags.map((tag) => {
            const active = state.tags.includes(tag)
            return (
              <button
                key={tag}
                type="button"
                onClick={() => state.toggleTag(tag)}
                aria-pressed={active}
                className={cn(
                  'rounded-pill border px-2 py-0.5 text-label transition-colors',
                  active ? 'border-accent bg-accent-soft text-accent' : 'border-border-2 bg-panel text-text hover:bg-muted',
                )}
              >
                {tag}
              </button>
            )
          })
        )}
      </div>
    </div>
  )
}

/** The first activity's label, or the state word, for the dot's tooltip. */
function activitySentence(d: DeviceInfo): string {
  return d.activities[0]?.label ?? d.status
}
