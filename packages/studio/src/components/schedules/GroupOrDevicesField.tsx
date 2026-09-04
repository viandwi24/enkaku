'use client'

import { useState } from 'react'
import type { DeviceInfo, GroupInfo } from '@enkaku/protocol'
import { CaretDownIcon, formatDeviceName, cn } from '@enkaku/ui'

export interface GroupOrDevicesValue {
  mode: 'group' | 'devices'
  groupId: string | null
  deviceIds: string[]
}

/**
 * A schedule's persistent target (plan 217 §3.6 item 1) — NOT an action's
 * in-flight target (plan 216's `TargetState` carries per-device
 * `accepted`/`warned`/`forbidden` results from a request that has not
 * happened yet; this field only writes configuration, read later by the
 * scheduler). Same container grammar MVP 07 §2.1 establishes for the action
 * dialogs' own picker (a bordered container, full width, a collapsed
 * one-line summary, a search box) without that state machine — this is why
 * it does not reuse `components/target/DevicePicker.tsx`/`useTarget`.
 */
export function GroupOrDevicesField({
  value,
  onChange,
  devices,
  groups,
}: {
  value: GroupOrDevicesValue
  onChange: (v: GroupOrDevicesValue) => void
  devices: DeviceInfo[]
  groups: GroupInfo[]
}) {
  const [expanded, setExpanded] = useState(false)
  const selectedGroup = value.mode === 'group' ? (groups.find((g) => g.id === value.groupId) ?? null) : null
  const summary =
    value.mode === 'group'
      ? selectedGroup
        ? `${selectedGroup.name} · ${selectedGroup.usableCount} device(s)`
        : 'No group chosen'
      : value.deviceIds.length > 0
        ? `${value.deviceIds.length} device(s)`
        : 'No devices chosen'

  return (
    <div data-slot="group-or-devices-field" className="w-full border-b border-line bg-panel-2 px-[14px] py-[10px]">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex h-[34px] w-full items-center gap-2 text-left text-body text-text"
      >
        <span className="min-w-0 flex-1 truncate">{summary}</span>
        <CaretDownIcon className={cn('size-3.5 shrink-0 text-faint transition-transform', expanded && 'rotate-180')} aria-hidden />
      </button>
      {expanded && (
        <div className="mt-2 space-y-2">
          <div className="flex gap-1 rounded-input bg-muted p-0.5 text-meta">
            <button
              type="button"
              onClick={() => onChange({ ...value, mode: 'group' })}
              className={cn('flex-1 rounded-[7px] py-1', value.mode === 'group' ? 'bg-panel font-medium' : 'text-dim')}
            >
              Group
            </button>
            <button
              type="button"
              onClick={() => onChange({ ...value, mode: 'devices' })}
              className={cn('flex-1 rounded-[7px] py-1', value.mode === 'devices' ? 'bg-panel font-medium' : 'text-dim')}
            >
              Explicit devices
            </button>
          </div>
          {value.mode === 'group' ? (
            groups.length === 0 ? (
              <p className="rounded-input border border-warn/30 bg-warn-soft px-2.5 py-2 text-meta text-warn">
                No group is saved yet — create one from the Groups page, or pick "Explicit devices".
              </p>
            ) : (
              <select
                value={value.groupId ?? ''}
                onChange={(e) => onChange({ ...value, groupId: e.target.value || null })}
                className="h-8 w-full rounded-input border border-border-2 bg-panel px-2 text-body"
              >
                <option value="">Pick a group</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name} · {g.usableCount} now
                  </option>
                ))}
              </select>
            )
          ) : (
            <div className="max-h-40 space-y-1 overflow-y-auto">
              {devices.map((d) => (
                <label key={d.id} className="flex items-center gap-2 rounded-button px-2 py-1 text-body hover:bg-muted">
                  <input
                    type="checkbox"
                    checked={value.deviceIds.includes(d.id)}
                    onChange={(e) =>
                      onChange({
                        ...value,
                        deviceIds: e.target.checked ? [...value.deviceIds, d.id] : value.deviceIds.filter((id) => id !== d.id),
                      })
                    }
                  />
                  {formatDeviceName(d.number, d.label)}
                </label>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
