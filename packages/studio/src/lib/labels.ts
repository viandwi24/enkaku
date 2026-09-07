'use client'

import { useCallback, useEffect, useState } from 'react'
import { LabelResponseSchema, LabelsResponseSchema, type LabelColor, type LabelInfo } from '@enkaku/protocol'
import { api, z } from '@enkaku/ui'

/**
 * The Studio-side client for the labels API (plan 225 §4.4), plus the one
 * hook every label surface reads from.
 *
 * Membership is deliberately NOT here: putting a label on a device is the
 * `set-labels` actions verb (`runAction`, `lib/actions.ts`), so a bulk
 * assignment across a selection goes through the same target-shaped door
 * every other bulk action does.
 */

export function fetchLabels(): Promise<LabelInfo[]> {
  return api('/api/labels', LabelsResponseSchema).then((b) => b.labels)
}

export function createLabel(input: { name: string; color?: LabelColor }): Promise<LabelInfo> {
  return api('/api/labels', LabelResponseSchema, { method: 'POST', json: input }).then((b) => b.label)
}

export function updateLabel(id: string, patch: { name?: string; color?: LabelColor }): Promise<LabelInfo> {
  return api(`/api/labels/${encodeURIComponent(id)}`, LabelResponseSchema, { method: 'PATCH', json: patch }).then((b) => b.label)
}

export function deleteLabel(id: string): Promise<void> {
  return api(`/api/labels/${encodeURIComponent(id)}`, z.void(), { method: 'DELETE' })
}

export interface LabelsState {
  labels: LabelInfo[]
  /** Null until the first read settles — so a picker can say "loading" rather than "no labels yet". */
  loaded: boolean
  reload: () => void
}

/**
 * Every label in the farm, with its device count.
 *
 * Refetched on demand rather than pushed over the WS: unlike a device row,
 * a label changes only when an operator changes it, and the count it carries
 * is already derivable from the device list every screen holds. A failed read
 * leaves the last known list standing rather than blanking the picker — the
 * same rule `useDevices`'s own group read follows.
 */
export function useLabels(): LabelsState {
  const [labels, setLabels] = useState<LabelInfo[]>([])
  const [loaded, setLoaded] = useState(false)

  const reload = useCallback(() => {
    fetchLabels()
      .then(setLabels)
      .catch(() => {})
      .finally(() => setLoaded(true))
  }, [])

  useEffect(reload, [reload])

  return { labels, loaded, reload }
}
