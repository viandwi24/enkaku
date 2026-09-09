'use client'

import { useEffect, useState } from 'react'
import type { DeviceInfo } from '@enkaku/protocol'
import { DevicePicker } from '@/components/DevicePicker'
import { fetchDevices } from '@/lib/api'
import { FieldRow } from './shell'
import type { BaseControlProps } from './types'

/**
 * `kind: 'deviceIds'` — an array of device ids, drawn with the fleet in front
 * of the operator instead of a text box they paste UUIDs into.
 *
 * It wraps Studio's own `DevicePicker` (`multiple`), which is the component
 * every screen that chooses a phone already uses — its rule is "never a bare
 * `Select`", and a plugin form was the last place that could not obey it.
 *
 * ## Failure is stated, never rendered as an empty fleet
 *
 * If `GET /api/devices` cannot be reached, an empty picker and a farm with no
 * phones look identical, and the operator would reasonably conclude they had
 * nothing to pick. So the error is said in words and the picker is not drawn
 * at all — the same posture `ArtifactPicker` takes when its own list is
 * unavailable.
 */
export function DevicesControl({ id, path, label, help, error, value, onChange, bare }: BaseControlProps) {
  const [devices, setDevices] = useState<DeviceInfo[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    fetchDevices()
      .then((list) => {
        if (alive) setDevices(list)
      })
      .catch((err: unknown) => {
        if (alive) setLoadError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      alive = false
    }
  }, [])

  // Anything that is not an array of strings is treated as "nothing chosen".
  // A stored value from an older shape must not crash the form it appears in.
  const selected = Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []

  const picker =
    loadError !== null ? (
      <p className="text-meta text-warn">Could not read the device list ({loadError}), so there is nothing to choose from here.</p>
    ) : devices === null ? (
      <p className="text-meta text-faint">Reading the fleet…</p>
    ) : (
      <DevicePicker multiple devices={devices} value={selected} onChange={(ids) => onChange(path, ids)} />
    )

  if (bare) return picker

  return (
    <FieldRow
      id={id}
      label={label}
      {...(help === undefined ? {} : { help })}
      {...(error === undefined ? {} : { error })}
      readout={selected.length === 0 ? 'Any' : `${selected.length} chosen`}
    >
      {picker}
    </FieldRow>
  )
}
